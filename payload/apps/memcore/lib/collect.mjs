/**
 * memcore 多源采集层。
 *
 * 原来只有三处来源，而且全部写死在某一个平台的目录上：
 *   vscdb（会话标题）、message-queue（用户指令）、projects.json（项目名）。
 * 平台一换、版本一升级，记忆库就空了。
 *
 * 现在改成「源列表」：每个源独立运行、独立容错，任一源失败只降级不阻塞。
 * 采集结果统一成 { id, at, text, source, cwd } —— 交给 classify.mjs 归类。
 *
 * 源分四类：
 *   platform  平台本地状态（projects / traces / rules / skills / logs / local_storage）
 *   cli       平台命令行（codebuddy ps 等，能拿一点是一点）
 *   vault     套件自己的索引（CodeVault 的项目清单）
 *   chat      对话正文（vscdb + message-queue，来自 sources.mjs）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

import { KIT_ROOT } from './paths.mjs';
import { loadMessages, loadSessions, loadProjects, labelForCwd } from './sources.mjs';

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

/** 各平台的本机数据根（info = 应用数据目录，home = 用户主目录下的点目录） */
const PLATFORMS = [
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    info: process.env.CODEBUDDY_INFO || path.join(APPDATA, 'CodeBuddy CN'),
    home: path.join(HOME, '.codebuddy')
  },
  { id: 'codex', label: 'Codex', info: path.join(HOME, '.codex'), home: path.join(HOME, '.codex') },
  { id: 'claude', label: 'Claude Code', info: path.join(HOME, '.claude'), home: path.join(HOME, '.claude') },
  { id: 'deepseek', label: 'DeepSeek', info: path.join(HOME, '.deepseek'), home: path.join(HOME, '.deepseek') },
  { id: 'vibe', label: 'Vibe', info: path.join(HOME, '.vibe'), home: path.join(HOME, '.vibe') },
  { id: 'aiworkkit', label: 'AIWorkKit', info: path.join(HOME, '.aiworkkit'), home: path.join(HOME, '.aiworkkit') }
];

const LIMITS = { maxItemsPerSource: 300, maxChars: 300, maxFileBytes: 2 * 1024 * 1024 };

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
};

const listFiles = (dir, filter) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && (!filter || filter(d.name)))
      .map((d) => path.join(dir, d.name));
  } catch (_) {
    return [];
  }
};

const listDirs = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (_) {
    return [];
  }
};

/**
 * 递归找文件。
 * 这几个目录都不是平铺的：
 *   projects/<项目slug>/<会话id>.jsonl
 *   traces/<pid>/trace_<hash>.jsonl
 *   logs/<日期>/<项目>__<hash>.log
 * 只扫一层会全部落空（第一版就是这样，三个源都是 0 条）。
 */
const walkFiles = (dir, filter, maxDepth = 3, depth = 0) => {
  if (depth > maxDepth) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkFiles(full, filter, maxDepth, depth + 1));
    } else if (e.isFile() && (!filter || filter(e.name))) {
      out.push(full);
    }
    if (out.length > 4000) break; // 防御：极端目录不至于把采集拖死
  }
  return out;
};

/** 从一行 JSONL 里挖出正文：兼容 {type:'user'|'assistant', message:{content:[{text}]}} 等几种形态 */
const pickText = (node, acc, depth = 0) => {
  if (!node || depth > 4) return;
  if (typeof node === 'string') {
    const s = node.replace(/\s+/g, ' ').trim();
    if (s.length >= 12 && s.length <= 400) acc.push(s);
    return;
  }
  if (Array.isArray(node)) {
    node.slice(0, 30).forEach((v) => pickText(v, acc, depth + 1));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/^(id|uuid|parentUuid|sessionId|cwd|timestamp|version|gitBranch|requestId)$/i.test(k)) continue;
      if (typeof v === 'string' || Array.isArray(v) || (v && typeof v === 'object')) {
        pickText(v, acc, depth + 1);
      }
    }
  }
};

/**
 * 解析 JSONL：只取用户侧内容，助手输出不入记忆。
 *
 * 行结构是 { type:'message', role:'user', content:[{type:'input_text',text}], timestamp, cwd }。
 * 注意 type 恒为 'message'，角色在 role 上 —— 第一版用 type 判角色，结果一条都取不到。
 */
function parseJsonl(file, roleFilter) {
  const raw = readText(file, 1024 * 1024);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j = null;
    try {
      j = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const role = String(j.role || (j.message && j.message.role) || '');
    if (roleFilter && !roleFilter.test(role)) continue;

    const acc = [];
    pickText(j.content || j.message || j, acc);
    for (const t of acc.slice(0, 3)) {
      out.push({ text: t, at: Number(j.timestamp) || 0, cwd: String(j.cwd || '') });
    }
    if (out.length >= 120) break;
  }
  return out;
}

const readText = (file, maxBytes) => {
  try {
    const st = fs.statSync(file);
    if (st.size > (maxBytes || LIMITS.maxFileBytes)) return '';
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (_) {
    return '';
  }
};

const readJson = (file) => {
  const raw = readText(file, 4 * 1024 * 1024);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
};

const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxChars);

/* ------------------------------------------------------------ 单个源的实现 */

/**
 * 会话正文：projects/<项目slug>/<会话id>.jsonl
 * slug 是工作目录把 / 换成 - 的结果，反推回去可当项目标签。
 */
function sourceProjects(p) {
  const dir = path.join(p.home, 'projects');
  const files = walkFiles(dir, (n) => n.endsWith('.jsonl') || n.endsWith('.json'), 2);
  const items = [];

  for (const file of files) {
    const slug = path.basename(path.dirname(file));
    const cwd = slug.replace(/^([a-zA-Z])-/, '$1:/').replace(/-/g, '/');
    const at = (() => {
      try {
        return fs.statSync(file).mtimeMs;
      } catch (_) {
        return 0;
      }
    })();

    const rows = file.endsWith('.jsonl')
      ? parseJsonl(file, /^user$/i)
      : (() => {
          const j = readJson(file);
          const acc = [];
          pickText(j, acc);
          return acc.slice(0, 20).map((t) => ({ text: t, at, cwd: '' }));
        })();

    for (const r of rows) {
      items.push({
        id: 'proj:' + slug + ':' + items.length,
        at: r.at || at,
        text: clip(r.text),
        source: 'projects',
        // 行内有 cwd 就用它，比从 slug 反推更准
        cwd: r.cwd || cwd
      });
      if (items.length >= LIMITS.maxItemsPerSource) return items;
    }
  }
  return items;
}

/** 工具轨迹：traces/<pid>/trace_*.jsonl —— 平时都在用什么工具、失败率如何 */
function sourceTraces(p) {
  const dir = path.join(p.home, 'traces');
  const files = walkFiles(dir, (n) => n.endsWith('.jsonl') || n.endsWith('.json'), 2);
  const items = [];

  for (const file of files) {
    const raw = readText(file, 512 * 1024);
    if (!raw) continue;

    if (file.endsWith('.jsonl')) {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let j = null;
        try {
          j = JSON.parse(line);
        } catch (_) {
          continue;
        }
        const tool = j.tool || j.name || j.event || (j.data && j.data.tool) || j.type;
        if (!tool || typeof tool !== 'string') continue;
        items.push({
          id: 'trace:' + path.basename(file) + ':' + items.length,
          at: Number(j.at || j.ts || j.timestamp || 0) || 0,
          text: clip('工具 ' + tool + (j.ok === false || j.error ? ' 失败' : '')),
          source: 'traces',
          cwd: String(j.cwd || '')
        });
        if (items.length >= LIMITS.maxItemsPerSource) return items;
      }
    } else {
      const j = readJson(file);
      if (!j) continue;
      const acc = [];
      pickText(j, acc);
      for (const t of acc.slice(0, 20)) {
        items.push({
          id: 'trace:' + path.basename(file) + ':' + items.length,
          at: 0,
          text: clip(t),
          source: 'traces',
          cwd: ''
        });
      }
    }
  }
  return items;
}

/** 规则文件：rules/*.md(c) —— 长期约束的主要来源 */
function sourceRules(p) {
  const dir = path.join(p.home, 'rules');
  const items = [];
  for (const file of listFiles(dir, (n) => /\.(md|mdc|txt)$/i.test(n))) {
    const raw = readText(file, 256 * 1024);
    if (!raw) continue;
    const at = fs.statSync(file).mtimeMs;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.replace(/^[-*#>\s]+/, '').trim();
      if (t.length < 10 || t.length > 200) continue;
      if (/^[（(]?<!--/.test(t)) continue;
      // 表格行与代码围栏不是「一句话约束」，在源头就丢掉，免得占满 300 条上限
      if (t.startsWith('|') || t.startsWith('```') || /^[-=]{3,}/.test(t)) continue;
      items.push({
        id: 'rule:' + path.basename(file) + ':' + items.length,
        at,
        text: clip(t),
        source: 'rules',
        cwd: ''
      });
      if (items.length >= LIMITS.maxItemsPerSource) return items;
    }
  }
  return items;
}

/** 技能库：skills/<name> —— 代表当前具备的能力方向 */
function sourceSkills(p) {
  const dir = path.join(p.home, 'skills');
  const names = listDirs(dir);
  return names.slice(0, LIMITS.maxItemsPerSource).map((n, i) => ({
    id: 'skill:' + i,
    at: 0,
    text: clip('技能 ' + n),
    source: 'skills',
    cwd: ''
  }));
}

/** 日志：只取带失败特征的尾行，正常日志不进记忆 */
function sourceLogs(p) {
  const dir = path.join(p.home, 'logs');
  const items = [];
  const BAD = /error|failed|exception|报错|失败|异常|timeout|超时|denied|拒绝/i;
  // logs/<日期>/<项目>__<hash>.log：同样在子目录里，必须递归
  for (const file of walkFiles(dir, (n) => /\.(log|txt)$/i.test(n), 2)) {
    const raw = readText(file, 512 * 1024);
    if (!raw) continue;
    const at = fs.statSync(file).mtimeMs;
    const lines = raw.split(/\r?\n/).filter((l) => BAD.test(l));
    for (const line of lines.slice(-30)) {
      items.push({
        id: 'log:' + path.basename(file) + ':' + items.length,
        at,
        text: clip(line),
        source: 'logs',
        cwd: ''
      });
    }
  }
  return items.slice(0, LIMITS.maxItemsPerSource);
}

/** local_storage：gzip+base64 的状态块，尽力解码，解不开就只记统计 */
function sourceStorage(p) {
  const dir = path.join(p.home, 'local_storage');
  const items = [];
  for (const file of listFiles(dir)) {
    if (items.length >= 60) break;
    let text = '';
    try {
      const buf = fs.readFileSync(file);
      const maybeB64 = buf.toString('utf8');
      let data = buf;
      if (/^[A-Za-z0-9+/=\s]+$/.test(maybeB64.slice(0, 200))) {
        data = Buffer.from(maybeB64.replace(/\s+/g, ''), 'base64');
      }
      try {
        data = zlib.gunzipSync(data);
      } catch (_) {
        /* 不是 gzip 就按原文处理 */
      }
      text = data.toString('utf8');
    } catch (_) {
      continue;
    }
    const j = (() => {
      try {
        return JSON.parse(text);
      } catch (_) {
        return null;
      }
    })();
    const collected = [];
    const walk = (node, depth) => {
      if (depth > 3 || !node) return;
      if (typeof node === 'string') {
        if (node.length >= 12 && node.length <= 300) collected.push(node);
        return;
      }
      if (Array.isArray(node)) {
        node.slice(0, 50).forEach((v) => walk(v, depth + 1));
        return;
      }
      if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (/title|name|summary|message|text|note|desc/i.test(k)) walk(v, depth + 1);
          else if (v && typeof v === 'object') walk(v, depth + 1);
        }
      }
    };
    if (j) walk(j, 0);
    for (const t of collected.slice(0, 20)) {
      items.push({
        id: 'store:' + path.basename(file) + ':' + items.length,
        at: fs.statSync(file).mtimeMs,
        text: clip(t),
        source: 'local_storage',
        cwd: ''
      });
    }
  }
  return items;
}

/** CLI：能拿一点是一点（不同平台命令不同，失败即降级） */
function sourceCli(platform) {
  const cmds = [];
  if (platform.id === 'codebuddy') {
    cmds.push({ args: ['ps'], label: 'codebuddy ps' });
  }
  const items = [];
  for (const c of cmds) {
    const r = spawnSync(c.label.split(' ')[0], c.args, {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8'
    });
    if (r.status !== 0 || !r.stdout) continue;
    for (const line of String(r.stdout).split(/\r?\n/)) {
      const t = line.trim();
      if (t.length < 10 || /^Note:|^Usage:|^Options:/i.test(t)) continue;
      items.push({
        id: 'cli:' + c.label + ':' + items.length,
        at: Date.now(),
        text: clip(t),
        source: 'cli',
        cwd: ''
      });
      if (items.length >= 40) break;
    }
  }
  return items;
}

/* ------------------------------------------------------------ 采集入口 */

/**
 * 跑所有源。每个源单独计时与容错。
 * @returns {{ok:boolean, tookMs:number, sources:Array, items:Array, labels:Function}}
 */
export function collect() {
  const started = Date.now();
  const sources = [];
  const items = [];

  const run = (id, label, kind, fn) => {
    const t0 = Date.now();
    try {
      const got = fn() || [];
      items.push(...got);
      sources.push({
        id,
        label,
        kind,
        ok: true,
        ms: Date.now() - t0,
        count: got.length,
        note: got.length ? '' : '目录存在但没有可采集内容'
      });
    } catch (err) {
      sources.push({
        id,
        label,
        kind,
        ok: false,
        ms: Date.now() - t0,
        count: 0,
        error: String((err && err.message) || err)
      });
    }
  };

  // 对话正文（原有能力，迁到这里统一计量）
  run('chat.messages', '对话指令', 'chat', () => {
    const max = 240;
    return loadMessages(max).map((m) => ({
      id: 'msg:' + m.i,
      at: m.t,
      text: clip(m.x),
      source: 'messages',
      cwd: ''
    }));
  });

  run('chat.sessions', '会话标题', 'chat', () => {
    const sessions = loadSessions();
    return Object.entries(sessions)
      .filter(([, s]) => s.title)
      .map(([id, s]) => ({
        id: 'sess:' + id,
        at: s.updatedAt || s.ts || 0,
        text: clip(s.title),
        source: 'sessions',
        cwd: s.cwd || ''
      }));
  });

  // 平台本地状态
  for (const p of PLATFORMS) {
    if (!exists(p.home)) continue;
    run(p.id + '.projects', p.label + ' · 项目状态', 'platform', () => sourceProjects(p));
    run(p.id + '.rules', p.label + ' · 规则', 'platform', () => sourceRules(p));
    run(p.id + '.traces', p.label + ' · 轨迹', 'platform', () => sourceTraces(p));
    run(p.id + '.skills', p.label + ' · 技能', 'platform', () => sourceSkills(p));
    run(p.id + '.logs', p.label + ' · 日志', 'platform', () => sourceLogs(p));
    run(p.id + '.storage', p.label + ' · 本地状态', 'platform', () => sourceStorage(p));
    run(p.id + '.cli', p.label + ' · CLI', 'cli', () => sourceCli(p));
  }

  // 套件索引
  run('vault.projects', 'CodeVault 索引', 'vault', () => {
    const projects = loadProjects();
    return projects.map((p, i) => ({
      id: 'cv:' + i,
      at: 0,
      text: clip(p.name + (p.session ? ' · ' + p.session : '')),
      source: 'codevault',
      cwd: p.path
    }));
  });

  return {
    ok: true,
    tookMs: Date.now() - started,
    sources,
    items,
    labels: (cwd) => labelForCwd(cwd, loadProjects())
  };
}

/** 数据源健康快照（给 /api/sources 与页面用） */
export function sourceReport() {
  const r = collect();
  return {
    ok: true,
    tookMs: r.tookMs,
    total: r.items.length,
    sources: r.sources
  };
}

export { PLATFORMS, KIT_ROOT };
