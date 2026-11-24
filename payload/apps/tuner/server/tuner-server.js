#!/usr/bin/env node
'use strict';

/**
 * AIWorkKit Idle Tuner - local dashboard server.
 *
 * Backend for the standalone (chromeless) window: serves web/ and exposes a tiny
 * JSON API that shells out to core/tuner.ps1. Every mutation goes through the
 * same PowerShell core the CLI and tray use, so behaviour cannot diverge.
 *
 * Binds 127.0.0.1 only, zero external dependencies.
 *
 * Routes
 *   GET  /api/health            liveness probe
 *   GET  /api/status            cached process snapshot (2s TTL)
 *   POST /api/action            {action: trim|apply|suspend|restore|auto, ...}
 *   GET  /                      dashboard (web/index.html)
 *
 * HTTP 骨架复用 apps/_shared/httpserver.mjs（路由 / JSON / 静态文件 / 写请求守卫）。
 * 本文件只保留业务：PowerShell 桥、状态缓存、动作锁。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

// Node 22.12+ 支持 require() 加载 ESM。本套件固定用自带 runtime（Node 24），
// 所以这里可以直接 require 共享库，不必把整个服务改成 .mjs。
const { createApp } = require('../../_shared/httpserver.mjs');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'core', 'tuner.ps1');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AIWorkKitIdleTuner');
const LOG_FILE = path.join(DATA_DIR, 'server.log');
// Bind address is configurable so a deployed copy can serve the LAN when needed.
const HOST = process.env.AIWORKKIT_TUNER_HOST || '127.0.0.1';

const VERSION = '1.0.0';
const START_AT = Date.now();
const STATUS_TTL_MS = 2000;
const FORCE_MIN_INTERVAL_MS = 5000;
let lastForceAt = 0;

/* 本机 API token：给脚本 / 托盘这类「非浏览器」调用方一个显式通行证。
 * 写请求的通用守卫（本机来源 + Origin + JSON）在共享库里，
 * 这里只负责「带了正确 token 就跳过那套校验」。 */
const TOKEN_FILE = path.join(DATA_DIR, 'api-token');

function loadApiToken() {
  try {
    const existing = String(fs.readFileSync(TOKEN_FILE, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  } catch {
    /* read-only profile: keep the token in memory only */
  }
  return token;
}

const API_TOKEN = loadApiToken();

let PORT = Number(process.env.AIWORKKIT_TUNER_PORT || 47822);

function parseArgs(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) {
      PORT = Number(argv[++i]);
    }
  }
}

// Apply CLI overrides at load time. This call was missing, so `--port` was
// silently ignored and a deployed copy always fought over the default 47822.
parseArgs(process.argv.slice(2));

function log(message) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\r\n`, 'utf8');
  } catch {
    /* logging must never break the server */
  }
}

/* ------------------------------------------------------------------ */
/* core bridge                                                        */
/* ------------------------------------------------------------------ */

function runCore(action, extra, timeout) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', CORE, '-Action', action, ...extra, '-Json'];
    execFile(
      'powershell.exe',
      args,
      { encoding: 'utf8', timeout: timeout || 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error((stderr || err.message || '').trim().slice(0, 400)));
          return;
        }
        const raw = (stdout || '').replace(/^\uFEFF/, '').trim();
        const start = raw.indexOf('{');
        if (start === -1) {
          reject(new Error((stderr || raw || 'core returned no data').trim().slice(0, 400)));
          return;
        }
        try {
          const data = JSON.parse(raw.slice(start));
          if (data && data.ok === false && data.error) reject(new Error(data.error));
          else resolve(data);
        } catch (parseErr) {
          reject(new Error(`core output not parseable: ${raw.slice(0, 160)}`));
        }
      }
    );
  });
}

/**
 * A PowerShell child can die with OutOfMemoryException when the page file is
 * exhausted (very common on machines that need this plugin in the first place).
 * One retry hides that transient failure from the UI.
 */
async function runCoreRetry(action, extra, timeout) {
  try {
    return await runCore(action, extra, timeout);
  } catch (err) {
    log(`core ${action} failed (${err.message.slice(0, 120)}), retrying once`);
    await new Promise((resolve) => setTimeout(resolve, 700));
    return runCore(action, extra, timeout);
  }
}

let cache = { at: 0, data: null, pending: null };

function getStatus(force) {
  const fresh = cache.data && Date.now() - cache.at < STATUS_TTL_MS;
  if (!force && fresh) return Promise.resolve(cache.data);
  if (cache.pending) return cache.pending;

  cache.pending = runCoreRetry('status', [], 25000)
    .then((data) => {
      cache.data = data;
      cache.at = Date.now();
      cache.pending = null;
      return data;
    })
    .catch((err) => {
      cache.pending = null;
      throw err;
    });
  return cache.pending;
}

let actionLock = false;

function buildActionArgs(body) {
  const action = String(body.action || '').toLowerCase();
  switch (action) {
    case 'trim':
      return { args: ['-Action', 'trim', '-Scope', body.scope === 'background' ? 'background' : 'all'], timeout: 60000 };
    case 'apply':
      return { args: ['-Action', 'apply', '-Mode', body.mode === 'deep' ? 'deep' : 'lite'], timeout: 90000 };
    case 'suspend': {
      const args = ['-Action', 'suspend', '-Level', body.level === 'aggressive' ? 'aggressive' : 'background'];
      const resume = Number(body.autoResume || 0);
      if (resume > 0) args.push('-AutoResume', String(Math.round(resume)));
      return { args, timeout: 90000 };
    }
    case 'restore':
      return { args: ['-Action', 'restore'], timeout: 90000 };
    case 'auto':
      return { args: ['-Action', 'auto', '-Enabled', body.enabled ? '1' : '0'], timeout: 30000 };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* routes                                                             */
/* ------------------------------------------------------------------ */

const app = createApp({
  root: WEB_DIR,
  log: (line) => log(line),
  // 带正确 token 的请求跳过通用写守卫（脚本 / 托盘用）
  guardAllow: (req) => {
    const given = String(req.headers['x-tuner-token'] || '');
    return Boolean(given) && given === API_TOKEN;
  }
});

app.get('/api/health', (ctx) => {
  ctx.json(200, {
    ok: true,
    version: VERSION,
    port: PORT,
    pid: process.pid,
    uptimeMs: Date.now() - START_AT
  });
});

app.get('/api/status', async (ctx) => {
  try {
    // Each force bypasses the 2s cache and forks a PowerShell (with a 400ms CPU
    // sample). Throttle it so a fast-polling client cannot burn the CPU it is
    // trying to save.
    const wantsForce = ctx.query.get('force') === '1';
    const now = Date.now();
    let force = false;
    if (wantsForce && now - lastForceAt >= FORCE_MIN_INTERVAL_MS) {
      force = true;
      lastForceAt = now;
    } else if (wantsForce) {
      log(`status force throttled (${now - lastForceAt} ms since last)`);
    }
    const data = await getStatus(force);
    ctx.json(200, { ok: true, status: data, server: { port: PORT, version: VERSION } });
  } catch (err) {
    ctx.json(500, { ok: false, error: err.message });
  }
});

app.post('/api/action', async (ctx) => {
  const body = await ctx.body(64 * 1024);
  if (!body) return ctx.json(400, { ok: false, error: 'invalid json body' });

  if (String(body.action || '').toLowerCase() === 'tray') {
    try {
      const child = spawn(process.execPath, [path.join(ROOT, 'cli', 'tuner.js'), 'tray'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: ROOT
      });
      child.unref();
      return ctx.json(200, { ok: true, result: { action: 'tray' } });
    } catch (err) {
      return ctx.json(500, { ok: false, error: err.message });
    }
  }

  const plan = buildActionArgs(body);
  if (!plan) return ctx.json(400, { ok: false, error: 'unknown action' });
  if (actionLock) return ctx.json(429, { ok: false, error: '另一个操作正在执行，请稍候' });

  actionLock = true;
  const started = Date.now();
  try {
    const result = await runCoreRetry(plan.args[1], plan.args.slice(2), plan.timeout);
    cache.at = 0; // force a fresh snapshot on the next poll
    log(`action ${body.action} mode=${body.mode || body.level || ''} ${Date.now() - started}ms`);
    return ctx.json(200, { ok: true, result });
  } catch (err) {
    log(`action ${body.action} failed: ${err.message}`);
    return ctx.json(500, { ok: false, error: err.message });
  } finally {
    actionLock = false;
  }
});

/* ------------------------------------------------------------------ */
/* start                                                              */
/* ------------------------------------------------------------------ */

const server = app.listen(PORT, HOST);

server.on('error', (err) => {
  log(`listen failed: ${err.message}`);
  process.exit(1);
});

server.on('listening', () => {
  log(`server listening on http://${HOST}:${PORT}`);
  console.log(`[tuner] dashboard http://${HOST}:${PORT}/`);
});
