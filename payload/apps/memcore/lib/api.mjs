/**
 * memcore 编排层：同步 → 抽取 → 渲染 → 检索 / 写入。
 *
 * CLI（tools/memcore.mjs）和 HTTP（server.mjs）都只调这里，
 * 保证「命令行写进去的」和「页面看到的」是同一份数据。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  KIT_ROOT,
  MEMORY_FILE,
  MEMORY_HOME,
  RULE_FILE,
  ensureHome
} from './paths.mjs';
import {
  cfg,
  deleteNote,
  logLine,
  pruneStore,
  readStore,
  searchNotes,
  statsOf,
  upsertNote,
  writeStore,
  writeTextAtomic
} from './store.mjs';
import {
  cjkCount,
  harvestActions,
  harvestDirections,
  harvestHabits,
  harvestKeywords,
  harvestPrefixes
} from './extract.mjs';
import { renderMemory, renderRule, estimate, fmtDate, fmtShort } from './render.mjs';
import { loadMessages, loadProjects, loadSessions, sourceStatus, labelForCwd } from './sources.mjs';
import { collect, sourceReport } from './collect.mjs';
import { classifyItems } from './classify.mjs';

export const CLI_PATH = path.join(KIT_ROOT, 'tools', 'memcore.mjs');
export const CLI_HINT = 'node "' + CLI_PATH + '"';

/* ---------------------------------------------------------------- 同步 */

/** 增量摄入：只新增未见过的会话/指令，幂等可重复跑。 */
export function sync() {
  ensureHome();
  const store = readStore();
  const before = { sessions: Object.keys(store.sessions).length, messages: store.messages.length };

  const sessions = loadSessions();
  let sessionsTouched = 0;
  for (const [id, s] of Object.entries(sessions)) {
    const prev = store.sessions[id];
    if (!prev || prev.updatedAt !== s.updatedAt || prev.title !== s.title) {
      store.sessions[id] = s;
      sessionsTouched += 1;
    }
  }

  const known = new Set(store.messages.map((m) => m.i));
  let added = 0;
  for (const m of loadMessages(cfg.messageChars)) {
    if (known.has(m.i)) continue;
    store.messages.push(m);
    known.add(m.i);
    added += 1;
  }

  /*
   * 多源采集 + 归类。
   *
   * 除了对话正文，还有项目状态、规则、轨迹、技能、日志、本地状态、CLI —— 这些
   * 才是「更多可用信息」。每个源独立容错，采集结果统一交给 classifyItems 归类，
   * 只有达到阈值（constraint/decision 强特征）才成为记忆条目。
   */
  let collected = { sources: [], items: [] };
  let factsAdded = 0;
  try {
    collected = collect();
    const incoming = classifyItems(collected.items);

    /*
     * facts 是**派生数据**：每次 sync 全量重建，而不是增量追加。
     *
     * 增量会让判据调整前的旧条目一直留着（第一版留下的表格行噪声就是这样）。
     * 采集本身只要 200 ms 左右，重算比维护差量更可靠。
     * 人工录入的 notes 不受影响 —— 那是用户输入的原始事实，不做推导。
     */
    const sorted = incoming.slice().sort((a, b) => b.score - a.score || b.at - a.at);
    store.facts = sorted.slice(0, cfg.maxNotes || 2000);
    factsAdded = store.facts.length;
    store.sourceReport = collected.sources;
  } catch (err) {
    logLine('warn', 'sync.collect', String((err && err.message) || err));
  }

  pruneStore(store);
  writeStore(store);

  const after = {
    sessions: Object.keys(store.sessions).length,
    messages: store.messages.length,
    facts: (store.facts || []).length
  };
  logLine(
    'info',
    'sync',
    'messages+' + added + '  sessions+' + sessionsTouched + '  facts+' + factsAdded +
      '  sources=' + collected.sources.length + '/' + collected.items.length +
      '  total=' + after.sessions + '/' + after.messages + '/' + after.facts
  );
  return { ok: true, added, sessionsTouched, factsAdded, before, after, sources: collected.sources };
}

/** 数据源健康快照：页面「数据源」区块与排查用 */
export function sources() {
  return sourceReport();
}

/* ---------------------------------------------------------------- 构建 */

/** 重新生成 MEMORY.md 与 memcore.mdc（纯函数式，不改原始事件）。 */
export function build() {
  ensureHome();
  const store = readStore();
  const messages = store.messages;

  if (!messages.length && !Object.keys(store.sessions).length && !store.notes.length) {
    return { ok: false, error: '还没有可用的对话数据：先运行 sync，或直接 note add 写入条目' };
  }

  const totalChars = messages.reduce((a, m) => a + m.x.length, 0);
  const cjkRatio = totalChars ? cjkCount(messages.map((m) => m.x).join('')) / totalChars : 0;

  const ctx = {
    store,
    cfg,
    home: MEMORY_HOME,
    cliHint: CLI_HINT,
    cjkRatio,
    habits: harvestHabits(messages),
    directions: harvestDirections(store.sessions),
    keywords: harvestKeywords(messages),
    actions: harvestActions(messages),
    prefixes: harvestPrefixes(messages)
  };

  const memory = renderMemory(ctx);
  const rule = renderRule(ctx);
  writeTextAtomic(MEMORY_FILE, memory);
  writeTextAtomic(RULE_FILE, rule);

  logLine(
    'info',
    'build',
    'memory=' + Buffer.byteLength(memory) + 'B  rule=' + Buffer.byteLength(rule) + 'B' +
      '  notes=' + store.notes.length
  );
  return {
    ok: true,
    memory,
    rule,
    memoryBytes: Buffer.byteLength(memory),
    ruleBytes: Buffer.byteLength(rule),
    memoryTokens: estimate(memory),
    ruleTokens: estimate(rule),
    notes: store.notes.length
  };
}

/** 日常入口：先增量同步再重建。 */
export function refresh() {
  const s = sync();
  const b = build();
  return { ok: b.ok !== false, sync: s, build: b };
}

/* ---------------------------------------------------------------- 读取 */

export function readMemory() {
  try {
    return fs.readFileSync(MEMORY_FILE, 'utf8');
  } catch {
    return '';
  }
}

export function readRule() {
  try {
    return fs.readFileSync(RULE_FILE, 'utf8');
  } catch {
    return '';
  }
}

export function overview() {
  const store = readStore();
  const facts = store.facts || [];

  // 按类型汇总：页面上要能一眼看出「约束有几条、教训有几条」
  const byType = {};
  for (const f of facts) byType[f.type] = (byType[f.type] || 0) + 1;

  // 按来源汇总：哪个数据源真正贡献了有效条目
  const bySource = {};
  for (const f of facts) bySource[f.source] = (bySource[f.source] || 0) + 1;

  return {
    ok: true,
    home: MEMORY_HOME,
    updatedAt: store.updatedAt,
    stats: statsOf(store),
    sources: sourceStatus(),
    // 多源采集的健康与贡献（sync 时写入，未同步过则为空）
    sourceReport: store.sourceReport || [],
    facts: {
      total: facts.length,
      byType,
      bySource,
      top: facts
        .slice()
        .sort((a, b) => b.score - a.score || b.at - a.at)
        .slice(0, 20)
    },
    memory: readMemory(),
    rule: readRule()
  };
}

/** 统一检索：记忆条目 + 历史指令 + 会话标题，按时间升序返回。 */
export function searchAll(q, limit = 40) {
  const query = String(q || '').trim();
  if (!query) return { ok: false, error: '缺少关键词', rows: [] };

  const store = readStore();
  const projects = loadProjects();
  const rows = [];

  for (const { note, score } of searchNotes(store, { q: query, limit: 20 })) {
    rows.push({
      kind: 'note',
      id: note.id,
      type: note.type,
      t: Date.parse(note.updatedAt) || 0,
      text: note.text,
      label: note.scope,
      score
    });
  }
  for (const m of store.messages) {
    if (m.x.toLowerCase().includes(query.toLowerCase())) {
      rows.push({
        kind: 'message',
        t: m.t,
        text: m.x,
        label: labelForCwd(store.sessions[m.c]?.cwd, projects),
        conv: m.c
      });
    }
  }
  for (const [id, s] of Object.entries(store.sessions)) {
    if ((s.title || '').toLowerCase().includes(query.toLowerCase())) {
      rows.push({
        kind: 'session',
        t: s.updatedAt || s.ts || 0,
        text: s.title,
        label: labelForCwd(s.cwd, projects),
        conv: id
      });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return { ok: true, query, count: rows.length, rows: rows.slice(-limit) };
}

/* ---------------------------------------------------------------- 写入 */

export function addNote(input, origin) {
  const r = upsertNote(input, origin || 'cli');
  const b = build();
  return { ok: true, ...r, rebuilt: b.ok !== false };
}

export function removeNote(id) {
  const r = deleteNote(id);
  if (r.ok) build();
  return r;
}

export function prune() {
  const store = readStore();
  const before = { messages: store.messages.length, notes: store.notes.length };
  pruneStore(store);
  writeStore(store);
  logLine('info', 'prune', JSON.stringify(before) + ' -> messages=' + store.messages.length + ' notes=' + store.notes.length);
  return { ok: true, before, after: { messages: store.messages.length, notes: store.notes.length } };
}

/* ---------------------------------------------------------------- 规则安装 */

/** 各 AI 平台的规则目录（只写已存在的平台，不凭空建目录）。 */
export function ruleTargets() {
  const home = os.homedir();
  const candidates = [
    { id: 'codebuddy', dir: path.join(home, '.codebuddy', 'rules'), file: 'memcore.mdc', required: true },
    { id: 'cursor', dir: path.join(home, '.cursor', 'rules'), file: 'memcore.mdc' },
    { id: 'windsurf', dir: path.join(home, '.windsurf', 'rules'), file: 'memcore.mdc' }
  ];
  return candidates.filter((c) => c.required || fs.existsSync(c.dir));
}

/** 把 memcore.mdc 复制到各平台规则目录；返回写入清单。 */
export function installRule() {
  const body = readRule();
  if (!body) return { ok: false, error: '缺少 memcore.mdc，请先 build' };
  ensureHome();
  const written = [];
  for (const t of ruleTargets()) {
    try {
      fs.mkdirSync(t.dir, { recursive: true });
      const file = path.join(t.dir, t.file);
      fs.writeFileSync(file, body, 'utf8');
      written.push({ platform: t.id, file, bytes: Buffer.byteLength(body) });
    } catch (e) {
      written.push({ platform: t.id, error: String(e.message) });
    }
  }
  logLine('info', 'install', written.map((w) => w.platform + '=' + (w.error ? 'fail' : 'ok')).join(' '));
  return { ok: true, written, ruleBytes: Buffer.byteLength(body) };
}

export function uninstallRule() {
  const removed = [];
  for (const t of ruleTargets()) {
    const file = path.join(t.dir, t.file);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    } catch (e) {
      removed.push(file + ' (' + e.message + ')');
    }
  }
  return { ok: true, removed };
}

/* ---------------------------------------------------------------- 可视化数据 */

/**
 * 图谱与热力图数据。
 *
 * 节点三类：keyword（主题词）、session（会话标题）、note（记忆条目）。
 * 边两类：session→keyword（标题命中）、note→keyword（标签命中）。
 * 只做「可解释的连接」：不猜语义、不算相似度，避免图上出现看不懂的边。
 */
export function graph() {
  const store = readStore();
  const keywords = harvestKeywords(store.messages, 14);
  const nodes = [];
  const links = [];
  const index = new Map();

  const push = (node) => {
    if (index.has(node.id)) return index.get(node.id);
    index.set(node.id, node);
    nodes.push(node);
    return node;
  };

  for (const [k, n] of keywords) {
    push({ id: 'k:' + k, kind: 'keyword', label: k, size: 9 + n * 2, n });
  }

  const perConv = new Map();
  for (const m of store.messages) perConv.set(m.c, (perConv.get(m.c) || 0) + 1);

  // 项目枢纽（按会话工作目录归类）：保证每个会话都有归属，图不会散成一团
  const projects = loadProjects();
  const hubs = new Map();
  const hubOf = (cwd) => {
    const label = labelForCwd(cwd, projects);
    if (!hubs.has(label)) {
      hubs.set(label, push({
        id: 'h:' + label,
        kind: 'hub',
        label: label.length > 12 ? label.slice(0, 12) + '…' : label,
        size: 10,
        text: label
      }));
    }
    return hubs.get(label);
  };

  for (const [id, s] of Object.entries(store.sessions)) {
    const title = String(s.title || '').trim();
    if (!title) continue;
    const node = push({
      id: 's:' + id,
      kind: 'session',
      label: title.length > 18 ? title.slice(0, 18) + '…' : title,
      size: 5 + Math.sqrt(perConv.get(id) || 0) * 2,
      at: s.updatedAt || s.ts || 0,
      text: title
    });
    links.push({ s: node.id, t: hubOf(s.cwd).id, kind: 'hub' });
    const low = title.toLowerCase();
    for (const [k] of keywords) {
      if (low.includes(k)) links.push({ s: node.id, t: 'k:' + k, kind: 'hit' });
    }
  }

  // 枢纽大小随挂载的会话数增长
  const hubCount = new Map();
  for (const l of links) {
    if (l.kind === 'hub') hubCount.set(l.t, (hubCount.get(l.t) || 0) + 1);
  }
  for (const [hid, n] of hubCount) {
    const node = index.get(hid);
    if (node) node.size = 8 + Math.min(n, 12);
  }

  for (const n of store.notes) {
    const node = push({
      id: 'n:' + n.id,
      kind: 'note',
      label: n.text.length > 16 ? n.text.slice(0, 16) + '…' : n.text,
      size: 7 + (n.weight || 3),
      type: n.type,
      at: Date.parse(n.updatedAt) || 0,
      text: n.text,
      scope: n.scope,
      count: n.count || 1
    });
    for (const tag of n.tags || []) {
      const key = 'k:' + String(tag).toLowerCase();
      if (index.has(key)) links.push({ s: node.id, t: key, kind: 'tag' });
    }
  }

  // 去重：同一个 (s,t) 只保留一条
  const seen = new Set();
  const unique = [];
  for (const l of links) {
    const key = l.s + '>' + l.t;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(l);
  }

  // 近 180 天活跃度：GitHub 贡献图式的按天计数
  const DAY = 86400000;
  const days = 182;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today - i * DAY);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    buckets.set(key, { d: key, messages: 0, notes: 0 });
  }
  for (const m of store.messages) {
    const d = new Date(m.t);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const b = buckets.get(key);
    if (b) b.messages += 1;
  }
  for (const n of store.notes) {
    const t = Date.parse(n.at) || 0;
    if (!t) continue;
    const d = new Date(t);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const b = buckets.get(key);
    if (b) b.notes += 1;
  }

  return {
    ok: true,
    nodes,
    links: unique,
    timeline: [...buckets.values()],
    legend: {
      keyword: keywords.map(([k, n]) => ({ k, n })),
      types: store.notes.reduce((acc, n) => {
        acc[n.type] = (acc[n.type] || 0) + 1;
        return acc;
      }, {})
    }
  };
}

/* ---------------------------------------------------------------- 展示辅助 */

export function formatOverview() {
  const o = overview();
  const s = o.stats;
  const lines = [];
  lines.push('归档目录：' + o.home);
  lines.push(
    '会话 ' + s.sessions + ' · 指令 ' + s.messages + ' · 条目 ' + s.notes +
      (s.messages ? ' · 时间 ' + fmtDate(s.oldest) + ' ~ ' + fmtDate(s.newest) : '')
  );
  lines.push(
    '体积：store ' + (s.storeBytes / 1024).toFixed(1) + 'KB · MEMORY ' + (s.memoryBytes / 1024).toFixed(1) +
      'KB · 规则 ' + (s.ruleBytes / 1024).toFixed(1) + 'KB'
  );
  lines.push(
    '条类型：' + (Object.entries(s.byType).map(([k, v]) => k + '×' + v).join(' · ') || '无')
  );
  lines.push(
    '数据源：' +
      Object.entries(o.sources)
        .map(([k, v]) => k + (v.ok ? '✓' : '✗'))
        .join(' ')
  );
  return lines.join('\n');
}

export { fmtDate, fmtShort };
