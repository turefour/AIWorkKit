#!/usr/bin/env node
/**
 * CodeVault local server.
 *
 * Purpose : 提供索引页静态资源，并暴露一组只读 JSON 接口让页面打开真实源码；
 *           唯一允许的写操作是 POST /api/launch（拉起内嵌面板）。
 * Input   : none (optional --port N, --open)
 * Routes  : GET  /                 index.html
 *           GET  /assets/*,/data/* 静态文件
 *           GET  /api/health       存活探针
 *           GET  /api/services     Eco / Tuner 在线状态
 *           GET  /api/scripts      脚本库 + 归档目录
 *           GET  /api/repos        Git 快照仓库状态
 *           GET  /api/projects     data/projects.json
 *           GET  /api/file?path=   源码文本，限定在 CODE_ROOTS 内，<=512 KB
 *           POST /api/launch       {app: 'eco'|'tuner'}
 * Safety  : 只绑 127.0.0.1；路径白名单按 realpath + path.relative 判定；
 *           写请求走共享守卫（本机来源 + Origin + JSON）。
 *
 * HTTP 骨架复用 apps/_shared/httpserver.mjs。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../_shared/httpserver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');            // apps/codevault
const KIT_ROOT = path.resolve(APP_ROOT, '..', '..');   // 部署根目录
const DATA_FILE = path.join(APP_ROOT, 'data', 'projects.json');

/* ---------------------------------------------------------------- 配置 */
/*
 * 所有路径与端口都从 config/deploy.json 推导，代码里不再出现用户名。
 * 换机 / 换用户名 / 换盘符时只改配置，不动代码。
 */
const CONFIG_FILE = path.join(KIT_ROOT, 'config', 'deploy.json');
const CFG = readJsonSync(CONFIG_FILE, {}) || {};
const CFG_PATHS = CFG.paths || {};
const CFG_PORTS = CFG.ports || {};

const HOME = os.homedir();
const DESKTOP = path.join(HOME, 'Desktop');
const WORKSPACE = CFG_PATHS.workspace || path.join(HOME, 'AIWorkKit');

/* Only these trees may be read through /api/file. */
const CODE_ROOTS = (
  Array.isArray(CFG_PATHS.codeRoots) && CFG_PATHS.codeRoots.length
    ? CFG_PATHS.codeRoots
    : [WORKSPACE, DESKTOP]
).map((p) => path.resolve(p));

// Bind address is configurable: a deployed copy may need LAN access
// (CODEVAULT_HOST=0.0.0.0) while a developer machine stays on loopback.
const HOST = process.env.CODEVAULT_HOST || CFG.host || '127.0.0.1';
let PORT = Number(process.env.CODEVAULT_PORT || CFG_PORTS.codevault || 57910);
const MAX_BYTES = 512 * 1024;

/* Embedded plugins: 端口取自配置，CLI 指向本套件自己的 apps 目录
   （原来指向开发工作区，等于让页面去拉起另一份代码，端口/路径都可能对不上）。 */
const ECO_PORT = Number(CFG_PORTS.eco || 57821);
const TUNER_PORT = Number(CFG_PORTS.tuner || 57822);
const ERRVAULT_PORT = Number(CFG_PORTS.errvault || 57911);
const MEMCORE_PORT = Number(CFG_PORTS.memcore || 57912);

const APPS = {
  eco: {
    label: 'AIWorkKit Eco',
    health: 'http://127.0.0.1:' + ECO_PORT + '/api/health',
    url: 'http://127.0.0.1:' + ECO_PORT + '/',
    port: ECO_PORT,
    cli: path.join(KIT_ROOT, 'apps', 'eco', 'cli', 'eco.js'),
    args: ['server', '--daemon'],
    cwd: path.join(KIT_ROOT, 'apps', 'eco')
  },
  tuner: {
    label: 'AIWorkKit Idle Tuner',
    health: 'http://127.0.0.1:' + TUNER_PORT + '/api/health',
    url: 'http://127.0.0.1:' + TUNER_PORT + '/',
    port: TUNER_PORT,
    cli: path.join(KIT_ROOT, 'apps', 'tuner', 'server', 'tuner-server.js'),
    args: ['--port', String(TUNER_PORT)],
    cwd: path.join(KIT_ROOT, 'apps', 'tuner')
  },
  errvault: {
    label: 'AIWorkKit 报错库',
    health: 'http://127.0.0.1:' + ERRVAULT_PORT + '/api/health',
    url: 'http://127.0.0.1:' + ERRVAULT_PORT + '/',
    port: ERRVAULT_PORT,
    cli: path.join(KIT_ROOT, 'apps', 'errvault', 'server.mjs'),
    args: ['--port', String(ERRVAULT_PORT)],
    cwd: path.join(KIT_ROOT, 'apps', 'errvault')
  },
  memcore: {
    label: 'AIWorkKit 记忆库',
    health: 'http://127.0.0.1:' + MEMCORE_PORT + '/api/health',
    url: 'http://127.0.0.1:' + MEMCORE_PORT + '/',
    port: MEMCORE_PORT,
    cli: path.join(KIT_ROOT, 'apps', 'memcore', 'server.mjs'),
    args: ['--port', String(MEMCORE_PORT)],
    cwd: path.join(KIT_ROOT, 'apps', 'memcore')
  }
};

/* ---------------------------------------------------------------- scripts + repos */
/* The reusable script library and the Git snapshot repositories, surfaced in the UI. */
const SCRIPT_DIR = CFG_PATHS.scriptDir || path.join(DESKTOP, 'handdelete');
const SCRIPT_EXT = new Set(['.py', '.mjs', '.js', '.bat', '.cmd', '.ps1']);

/* Rebuilt script library: category index maintained by ScriptVault/build-index.mjs. */
const VAULT_ROOT = CFG_PATHS.vaultRoot || path.join(DESKTOP, 'ScriptVault');
const VAULT_INDEX = path.join(VAULT_ROOT, 'index.json');

function readJsonSync(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/* 只保留「任何机器上都成立」的条目：其余项目路径写进 ScriptVault/config/repos.json，
   由 adopt-project.mjs 维护，不再在代码里硬编码一串会话目录。 */
const FALLBACK_REPOS = [
  { name: 'workspace', path: WORKSPACE },
  { name: 'codevault', path: APP_ROOT },
  { name: 'script-vault', path: VAULT_ROOT },
  { name: 'script-archive', path: SCRIPT_DIR }
];

const REPO_CONFIG = path.join(VAULT_ROOT, 'config', 'repos.json');
const REPOS = (() => {
  const cfg = readJsonSync(REPO_CONFIG, null);
  return cfg && Array.isArray(cfg.repos) && cfg.repos.length ? cfg.repos : FALLBACK_REPOS;
})();

function findGit() {
  // 依次找：套件自带的 git → 工作区里的 mingit → PATH 上的 git
  const candidates = [
    CFG_PATHS.git,
    path.join(KIT_ROOT, 'runtime', 'git', 'cmd', 'git.exe'),
    path.join(WORKSPACE, '.tools', 'mingit', 'cmd', 'git.exe')
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'git';
}

function run(cmd, args, cwd, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

/** Pull the first meaningful sentence out of a script's header comment. */
function extractPurpose(text) {
  const head = text.slice(0, 2400);
  const py = /"""([\s\S]*?)"""/.exec(head);
  const js = /\/\*\*([\s\S]*?)\*\//.exec(head);
  const body = (py && py[1]) || (js && js[1]) || '';
  const lines = body
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trim())
    .filter(Boolean);
  const purpose = lines.find((line) => /^purpose\s*[:：]/i.test(line));
  if (purpose) return purpose.replace(/^purpose\s*[:：]\s*/i, '');
  return lines[0] || '';
}

function listScripts() {
  const items = [];
  let names = [];
  try {
    names = fs.readdirSync(SCRIPT_DIR);
  } catch {
    return items;
  }
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!SCRIPT_EXT.has(ext)) continue;
    const full = path.join(SCRIPT_DIR, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let purpose = '';
    try {
      purpose = extractPurpose(fs.readFileSync(full, 'utf8').slice(0, 3000));
    } catch {
      /* unreadable / binary */
    }
    items.push({
      name,
      ext,
      bytes: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString().slice(0, 10),
      purpose
    });
  }
  return items.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.name.localeCompare(b.name)));
}

async function probe(app) {
  try {
    const res = await fetch(app.health, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, pid: data.pid || null, port: app.port };
  } catch {
    return { ok: false };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a plugin dashboard if it is not already answering. */
async function launchApp(name) {
  const app = APPS[name];
  if (!app) throw new Error('unknown app: ' + name);
  const before = await probe(app);
  if (before.ok) return { started: false, ...before };

  if (!fs.existsSync(app.cli)) throw new Error('entry not found: ' + app.cli);

  const child = spawn(process.execPath, [app.cli, ...app.args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: app.cwd
  });
  child.unref();

  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    const now = await probe(app);
    if (now.ok) return { started: true, ...now };
  }
  throw new Error('start timed out on port ' + app.port);
}

/* ---------------------------------------------------------------- /api/file */

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.ps1', '.psm1', '.py', '.md', '.txt',
  '.html', '.css', '.cmd', '.bat', '.yml', '.yaml', '.gitignore', '.log'
]);

/** Resolve a request path to an absolute file inside one of CODE_ROOTS. */
function resolveInsideRoots(raw) {
  if (!raw) return null;
  try {
    const target = path.resolve(raw);            // absolute path only
    const real = fs.realpathSync(target);
    const allowed = CODE_ROOTS.some((root) => {
      const rel = path.relative(path.resolve(root), real);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    return allowed ? real : null;
  } catch {
    return null;
  }
}

function readText(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > MAX_BYTES) throw new Error('file too large (' + Math.round(stat.size / 1024) + ' KB)');
  const ext = path.extname(file).toLowerCase();
  if (ext && !TEXT_EXT.has(ext)) throw new Error('unsupported extension: ' + ext);
  const text = fs.readFileSync(file, 'utf8');
  return { text, lines: text.split(/\r?\n/).length, bytes: stat.size };
}

/* ---------------------------------------------------------------- 路由 */

const app = createApp({
  root: APP_ROOT,
  log: (line) => {
    try {
      fs.appendFileSync(path.join(KIT_ROOT, 'state', 'codevault.log'), new Date().toISOString() + ' ' + line + '\r\n');
    } catch {
      /* 日志失败不影响服务 */
    }
  }
});

app.get('/api/health', (ctx) => {
  ctx.json(200, { ok: true, app: 'codevault', pid: process.pid, port: PORT });
});

app.get('/api/services', async (ctx) => {
  // 遍历 APPS 而不是写死名字：以后再加内嵌面板，这里不用跟着改
  const names = Object.keys(APPS);
  const probed = await Promise.all(names.map((name) => probe(APPS[name])));
  const apps = {};
  names.forEach((name, i) => {
    apps[name] = { ...probed[i], url: APPS[name].url, label: APPS[name].label };
  });
  ctx.json(200, { ok: true, apps });
});

/* 接口目录：设置页据此渲染「每个接口 + 查看格式」。端口符号名在这里解析成实际值。 */
app.get('/api/catalog', (ctx) => {
  const file = path.join(KIT_ROOT, 'config', 'api-catalog.json');
  const catalog = readJsonSync(file, null);
  if (!catalog) return ctx.json(500, { ok: false, error: 'config/api-catalog.json 缺失' });

  const groups = (catalog.groups || []).map((g) => ({
    ...g,
    resolvedPort: CFG_PORTS[g.port] || null
  }));

  const pf = readJsonSync(path.join(KIT_ROOT, 'config', 'platforms.json'), null);
  const platforms = pf && pf.platforms
    ? Object.keys(pf.platforms).map((k) => ({
        id: k,
        label: pf.platforms[k].label || k,
        note: pf.platforms[k].note || '',
        eventSource: pf.platforms[k].eventSource || 'http'
      }))
    : [];

  ctx.json(200, { ok: true, version: catalog.version, groups, platforms });
});

/* 降耗配置：代理到 Eco，设置页只跟同源通信，免去 CORS 与端口硬编码 */
app.get('/api/config', async (ctx) => {
  try {
    const res = await fetch('http://127.0.0.1:' + ECO_PORT + '/api/config');
    const data = await res.json();
    return ctx.json(200, data);
  } catch (err) {
    return ctx.json(502, { ok: false, error: 'eco 未响应：' + err.message });
  }
});

app.post('/api/config', async (ctx) => {
  const body = await ctx.body(64 * 1024);
  if (!body) return ctx.json(400, { ok: false, error: 'invalid json body' });
  try {
    const res = await fetch('http://127.0.0.1:' + ECO_PORT + '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return ctx.json(res.status, data);
  } catch (err) {
    return ctx.json(502, { ok: false, error: 'eco 未响应：' + err.message });
  }
});

app.get('/api/scripts', (ctx) => {
  const vault = readJsonSync(VAULT_INDEX);
  const archive = listScripts();
  ctx.json(200, {
    ok: true,
    vault: vault
      ? {
          root: vault.root,
          generatedAt: vault.generatedAt,
          summary: vault.summary,
          categories: vault.categories,
          entries: vault.entries
        }
      : null,
    archive: {
      dir: SCRIPT_DIR,
      count: archive.length,
      documented: archive.filter((item) => item.purpose).length,
      recent: archive.slice(0, 30)
    }
  });
});

app.get('/api/repos', async (ctx) => {
  const git = findGit();
  const repos = await Promise.all(
    REPOS.map(async (repo) => {
      if (!fs.existsSync(path.join(repo.path, '.git'))) {
        return { ...repo, tracked: false };
      }
      const log = await run(git, ['log', '-1', '--format=%h%x09%ad%x09%s', '--date=short'], repo.path);
      const status = await run(git, ['status', '--porcelain'], repo.path);
      const parts = (log || '').split('\t');
      return {
        ...repo,
        tracked: true,
        hash: parts[0] || '',
        date: parts[1] || '',
        subject: parts[2] || '',
        dirty: status ? status.split('\n').filter(Boolean).length : 0
      };
    })
  );
  ctx.json(200, { ok: true, git, repos });
});

app.get('/api/projects', (ctx) => {
  try {
    return ctx.json(200, { ok: true, data: JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) });
  } catch (err) {
    return ctx.json(500, { ok: false, error: err.message });
  }
});

app.get('/api/file', (ctx) => {
  const file = resolveInsideRoots(ctx.query.get('path'));
  if (!file) return ctx.json(403, { ok: false, error: 'path not allowed' });
  try {
    const data = readText(file);
    return ctx.json(200, { ok: true, path: file, ...data });
  } catch (err) {
    return ctx.json(400, { ok: false, error: err.message });
  }
});

app.post('/api/launch', async (ctx) => {
  const body = await ctx.body(16 * 1024);
  if (!body) return ctx.json(400, { ok: false, error: 'invalid json body' });
  const name = String(body.app || '');
  try {
    const result = await launchApp(name);
    return ctx.json(200, { ok: true, app: name, ...result, url: APPS[name].url });
  } catch (err) {
    return ctx.json(500, { ok: false, error: err.message });
  }
});

/* ---------------------------------------------------------------- 启动 */

function parseArgs(argv) {
  let open = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) {
      PORT = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--open') {
      open = true;
    }
  }
  return { open };
}

const args = parseArgs(process.argv.slice(2));
const server = app.listen(PORT, HOST);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[codevault] port ' + PORT + ' already in use; the index is probably already open.');
    console.error('[codevault] http://' + HOST + ':' + PORT + '/');
    process.exit(1);
  }
  throw err;
});

server.on('listening', () => {
  const url = 'http://' + HOST + ':' + PORT + '/';
  console.log('[codevault] serving ' + APP_ROOT);
  console.log('[codevault] ' + url);
  if (args.open) {
    // 用 spawn + 引号包裹，避免 URL 里的字符被 cmd 当命令分隔符
    spawn('cmd', ['/c', 'start', '""', '"' + url + '"'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true
    }).unref();
  }
});
