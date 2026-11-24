'use strict';

/**
 * AIWorkKit Eco - local monitoring daemon.
 *
 * Responsibilities
 *  1. ingest hook events (agent turn + tool lifecycle) sent by hooks/eco-hook.js
 *  2. ingest cooperative progress reports from scripts (HTTP or CLI)
 *  3. sample running processes and installed plugins
 *  4. expose /api/state + /api/stream (SSE) for the dashboard window
 *  5. keep structured file logs + a live ring buffer
 *
 * Binds 127.0.0.1 only, zero external dependencies.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { Logger, ensureDir } = require('./lib/logger');
const { Store } = require('./lib/store');
const { ProcessScanner } = require('./lib/procscan');
const { PluginScanner, settingsFile } = require('./lib/pluginscan');
const { parseLine, clean } = require('./lib/parser');
const { extractTodos, summarize: summarizeTodos } = require('./lib/todos');
const { JobLogStore } = require('./lib/joblog');
const { DecisionStore } = require('./lib/decisions');
const { DuplicateGuard } = require('./lib/dupguard');
const { extractScriptPath, readScript } = require('./lib/scripts');

const VERSION = '1.0.0';
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.eco');
const LOG_DIR = path.join(ROOT, 'logs');
const WEB_DIR = path.join(ROOT, 'web');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const PID_FILE = path.join(STATE_DIR, 'server.pid');
const QUEUE_FILE = path.join(STATE_DIR, 'hook-queue.jsonl');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

/* ------------------------------------------------------------------ 运行配置 */
/*
 * 和 config.json 分开存：config.json 在进程退出时会被 {port,pid,startedAt}
 * 整体重写，把用户配置放进去会被清掉。settings.json 只存可调项，改完立即落盘。
 */
const KIT_ROOT = path.resolve(ROOT, '..', '..');
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
const PLATFORMS_FILE = path.join(KIT_ROOT, 'config', 'platforms.json');

const DEFAULT_SETTINGS = {
  scanIntervalMs: 6000, // 进程采样间隔
  cpuThreshold: 60, // 单进程 CPU 超过它才考虑降耗
  memThresholdMB: 2048, // 工作集超过它才考虑降耗
  autoTrim: true, // 是否允许自动回收
  trimCooldownMs: 120000, // 两次自动回收的最小间隔
  ingestToken: '' // 可选接入令牌，留空表示不校验
};

/** 可接入的 AI 编程平台，来自 config/platforms.json（新增平台只改那个文件） */
function readPlatforms() {
  try {
    const raw = JSON.parse(fs.readFileSync(PLATFORMS_FILE, 'utf8'));
    const list = raw && raw.platforms ? Object.keys(raw.platforms) : [];
    return list.length ? list : ['generic'];
  } catch (_) {
    return ['generic'];
  }
}

function readSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch (_) {
    saved = {};
  }
  return { ...DEFAULT_SETTINGS, ...saved };
}

/** 只接受已知字段并做范围钳制，避免脏值写进文件 */
function applySettings(patch) {
  const next = { ...settings };
  const num = (v, lo, hi, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.round(n), lo), hi);
  };
  if (patch.scanIntervalMs !== undefined) {
    next.scanIntervalMs = num(patch.scanIntervalMs, 1000, 60000, next.scanIntervalMs);
  }
  if (patch.cpuThreshold !== undefined) {
    next.cpuThreshold = num(patch.cpuThreshold, 5, 100, next.cpuThreshold);
  }
  if (patch.memThresholdMB !== undefined) {
    next.memThresholdMB = num(patch.memThresholdMB, 256, 65536, next.memThresholdMB);
  }
  if (patch.trimCooldownMs !== undefined) {
    next.trimCooldownMs = num(patch.trimCooldownMs, 10000, 3600000, next.trimCooldownMs);
  }
  if (patch.autoTrim !== undefined) next.autoTrim = patch.autoTrim === true || patch.autoTrim === 'true';
  if (patch.ingestToken !== undefined) next.ingestToken = String(patch.ingestToken).slice(0, 128);

  settings = next;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  } catch (_) {
    /* 只读目录：内存生效即可 */
  }
  return settings;
}

let settings = readSettings();

function parseArgs(argv) {
  const out = { port: 0, procInterval: 0, noProc: false, cwd: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a === '--interval' && argv[i + 1]) out.procInterval = Number(argv[++i]);
    else if (a === '--cwd' && argv[i + 1]) out.cwd = argv[++i];
    else if (a === '--no-proc') out.noProc = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cfg = readConfig();
const PORT = Number(process.env.AIWORKKIT_ECO_PORT || args.port || cfg.port || 57821);
// Bind address is configurable so a deployed copy can serve the LAN when needed.
const HOST = process.env.AIWORKKIT_ECO_HOST || '127.0.0.1';

/**
 * 用量统计（模块级累计，全进程唯一）。
 *
 * AIWorkKit 没有把 token 用量写进任何可读文件：projects/*.jsonl 里没有 usage
 * 字段，local_storage/*.info 是 gzip+base64。所以这里统计真实可采集的量 ——
 * 经 hook 上报的事件条数与序列化字节数，再按 3.8 字符/token 折算成量级参考。
 *
 * 用途是判断「这个任务大概跑了多少东西」，不是精确账单。要精确值必须由 CLI
 * 侧把 usage 写进事件；estTokens 这个前缀就是在标明「估算」。
 */
const usageStats = { events: 0, chars: 0, since: Date.now() };
const START_AT = Date.now();

/* CSRF hardening ------------------------------------------------------ */
/* A cross-site page can only issue a "simple" request (text/plain, no
 * preflight) against this daemon. Write endpoints therefore require either a
 * JSON content-type or the local API token, and reject foreign origins. */
/* Origin / sec-fetch-site 的判定已收进共享守卫，这里只留方法集合 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TOKEN_FILE = path.join(STATE_DIR, 'api-token');

ensureDir(STATE_DIR);
ensureDir(LOG_DIR);

function loadApiToken() {
  try {
    const existing = String(fs.readFileSync(TOKEN_FILE, 'utf8')).trim();
    if (existing) return existing;
  } catch (_) {
    /* first run */
  }
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  } catch (_) {
    /* read-only disk: keep the token in memory only */
  }
  return token;
}

const API_TOKEN = loadApiToken();

const logger = new Logger({ dir: LOG_DIR, name: 'server' });
const store = new Store({ stateFile: STATE_FILE, ttlDoneMs: 20 * 60 * 1000 });
const procScanner = new ProcessScanner({
  logger,
  // 命令行 --interval 优先，其次设置页存的 scanIntervalMs，最后兜底 6000
  intervalMs: args.procInterval || settings.scanIntervalMs
});
const pluginScanner = new PluginScanner({ logger, cwd: args.cwd || process.cwd() });

const jobLogs = new JobLogStore(path.join(STATE_DIR, 'jobs'));
const decisions = new DecisionStore(path.join(STATE_DIR, 'decisions.json'));

/**
 * Duplicate test-process guard.
 * A task that re-spawns its test runner on every failure piles up identical
 * processes until the machine stalls: warn at 4, lock and clean up when it keeps
 * growing. See lib/dupguard.js for the state machine.
 */
const guard = new DuplicateGuard({
  onAlert: (alert) => {
    logger.warn('guard', 'duplicate test processes detected', {
      group: alert.key,
      count: alert.count,
      peak: alert.peak
    });
    scheduleBroadcast();
  },
  onLock: (alert) => {
    // logger.error's third argument is an Error; extra context goes in the message.
    logger.error(
      'guard',
      'duplicate group locked, cleaning extras: ' + alert.key + ' count=' + alert.count + ' peak=' + alert.peak
    );
    scheduleBroadcast();
  }
});

let guardKilled = 0;

/** Kill the surplus processes of a locked group, verifying identity first. */
async function cleanUpDuplicates(list) {
  let killed = 0;
  for (const proc of list) {
    const live = await readProcessCommand(proc.pid);
    if (!live) continue;
    // PID may have been recycled since the sample: never kill a stranger.
    if (proc.command && live !== String(proc.command).trim()) continue;
    try {
      process.kill(proc.pid);
      killed += 1;
      guardKilled += 1;
    } catch (err) {
      logger.warn('guard', 'cleanup kill failed', { pid: proc.pid, error: err.message });
    }
  }
  if (killed) logger.warn('guard', 'duplicate processes cleaned', { killed, total: guardKilled });
  return killed;
}

/** Alternative execution modes offered when a flow is skipped. */
const SKIP_MODES = {
  background: '后台静默运行',
  wrapped: '改用 eco run 包装',
  retry: '限时重试',
  manual: '人工接管'
};

// Ingestion source health: the dashboard shows these so "no data" is never
// confused with "nothing is running".
const sources = {
  hook: { lastAt: 0, events: 0 },
  wrapper: { lastAt: 0, events: 0 },
  manual: { lastAt: 0, events: 0 },
  scan: { lastAt: 0, events: 0 }
};

function touchSource(name) {
  const key = sources[name] ? name : 'manual';
  sources[key].lastAt = Date.now();
  sources[key].events += 1;
}

const sseClients = new Set();
const pendingTools = new Map(); // sessionId -> [{ id, tool, toolUseId }]
const activeTurn = new Map(); // sessionId -> jobId
const toolCount = new Map(); // sessionId -> number of tool calls in this turn
let broadcastTimer = null;
let lastBroadcast = 0;

/* ------------------------------------------------------------------ */
/* payload helpers                                                     */
/* ------------------------------------------------------------------ */

const TOOL_HINTS = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern',
  WebFetch: 'url',
  Task: 'description'
};

function toolTarget(tool, input) {
  const data = input || {};
  const key = TOOL_HINTS[tool] || 'command';
  const value = data[key] || data.command || data.file_path || data.path || data.pattern || data.url || '';
  return String(value || '').slice(0, 260);
}

function trimText(value, max) {
  const text = String(value == null ? '' : value);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/* ------------------------------------------------------------------ */
/* state assembly                                                      */
/* ------------------------------------------------------------------ */

function buildSessions(jobs) {
  const map = new Map();
  for (const job of jobs) {
    const key = job.sessionId || 'local';
    if (!map.has(key)) {
      map.set(key, { id: key, jobs: 0, running: 0, lastAt: 0, kinds: {} });
    }
    const s = map.get(key);
    s.jobs += 1;
    if (job.status === 'running') s.running += 1;
    s.lastAt = Math.max(s.lastAt, job.updatedAt || 0);
    s.kinds[job.kind] = (s.kinds[job.kind] || 0) + 1;
  }
  return Array.from(map.values()).sort((a, b) => b.lastAt - a.lastAt).slice(0, 8);
}

function snapshot() {
  const jobs = store.list();
  const base = store.summary();
  const procSummary = procScanner.summary();
  return {
    now: Date.now(),
    version: VERSION,
    usage: {
      events: usageStats.events,
      chars: usageStats.chars,
      estTokens: Math.round(usageStats.chars / 3.8),
      since: usageStats.since
    },
    server: {
      host: HOST,
      port: PORT,
      pid: process.pid,
      startedAt: START_AT,
      uptimeMs: Date.now() - START_AT,
      stateDir: STATE_DIR,
      logDir: LOG_DIR,
      platform: process.platform,
      cpuCount: os.cpus().length,
      load: Math.round((os.loadavg()[0] || 0) * 100) / 100
    },
    summary: {
      ...base,
      ...decisions.counts(),
      scripts: procSummary.scripts,
      agents: procSummary.agents,
      cpuPercent: procSummary.cpuPercent,
      memMB: procSummary.memMB,
      plugins: pluginScanner.plugins.length,
      pluginsEnabled: pluginScanner.plugins.filter((p) => p.enabled !== false).length,
      pluginErrors: procSummary.error || pluginScanner.lastError || ''
    },
    jobs,
    guard: {
      ...guard.state(),
      killed: guardKilled
    },
    processes: procScanner.processes.map((p) => ({
      ...p,
      override: decisions.processOverride(p.pid, p.command)
    })),
    plugins: pluginScanner.plugins.map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
      root: p.root,
      hooks: p.hooks,
      armed: p.hooks.length > 0,
      enabled: p.enabled !== false,
      skills: p.skills,
      commands: p.commands,
      agents: p.agents,
      scope: p.scope,
      project: p.project,
      marketplace: p.marketplace,
      lastTouched: p.lastTouched,
      override: decisions.get('plugin', p.name) || null
    })),
    decisions: decisions.list(20),
    skipModes: SKIP_MODES,
    sessions: buildSessions(jobs),
    sources: {
      hook: { ...sources.hook, alive: Date.now() - sources.hook.lastAt < 60000 },
      wrapper: { ...sources.wrapper, alive: Date.now() - sources.wrapper.lastAt < 60000 },
      manual: { ...sources.manual, alive: Date.now() - sources.manual.lastAt < 300000 },
      scan: { ...sources.scan, alive: Date.now() - sources.scan.lastAt < 15000 }
    }
  };
}

function broadcast() {
  const payload = 'event: state\ndata: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
  lastBroadcast = Date.now();
}

/**
 * 轻量帧：只带「每秒真的会变」的标量。
 *
 * 原来 tickTimer 每秒调一次 broadcast()，等于每秒把整棵状态树
 * JSON.stringify 一遍（实测 /api/state 约 133 KB）。而一秒内真正会变的
 * 只有 now / uptimeMs，以及每个 job 的已用时间、速率、ETA、卡住标记。
 * 把这几项单独打成小包，完整 state 只在真实变更时发 —— 所有变更点都已经
 * 走 scheduleBroadcast()（含 store.onChange），所以不会漏。
 */
function tickPayload() {
  const now = Date.now();
  return {
    now,
    uptimeMs: now - START_AT,
    jobs: store.list().map((j) => ({
      id: j.id,
      status: j.status,
      current: j.current,
      percent: j.percent,
      elapsedMs: j.elapsedMs,
      rate: j.rate,
      etaMs: j.etaMs,
      stalled: j.stalled,
      staleRunning: j.staleRunning
    })),
    sources: {
      hook: now - sources.hook.lastAt < 60000,
      wrapper: now - sources.wrapper.lastAt < 60000,
      manual: now - sources.manual.lastAt < 300000,
      scan: now - sources.scan.lastAt < 15000
    }
  };
}

function broadcastTick() {
  if (!sseClients.size) return;
  const payload = 'event: tick\ndata: ' + JSON.stringify(tickPayload()) + '\n\n';
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

function scheduleBroadcast() {
  if (broadcastTimer) return;
  const wait = Math.max(0, 180 - (Date.now() - lastBroadcast));
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcast();
  }, wait);
  if (broadcastTimer.unref) broadcastTimer.unref();
}

/* ------------------------------------------------------------------ */
/* hook event handling                                                 */
/* ------------------------------------------------------------------ */

/**
 * Turn the agent's own checklist into a quantified task plus per-step detail.
 * This is what makes "current task progress" automatic: no cooperation needed
 * beyond the agent using its normal todo/plan tool.
 */
function syncTodos(sid, toolName, input, ts) {
  const todos = extractTodos(input, toolName);
  if (!todos || !todos.length) return false;

  const info = summarizeTodos(todos);
  const taskId = 'task:' + sid;
  const activeText = info.active ? info.active.text : '全部步骤已完成';
  const status = info.done === info.total ? 'done' : 'running';

  store.upsert({
    id: taskId,
    kind: 'task',
    label: '当前任务 · ' + trimText(activeText, 60),
    detail: info.done + ' / ' + info.total + ' 步骤完成',
    current: info.done,
    total: info.total,
    unit: '步骤',
    status,
    sessionId: sid,
    source: 'todos',
    steps: todos.map((t) => ({ index: t.index, text: t.text, status: t.status })),
    note: info.active && info.active.status === 'in_progress' ? '进行中：' + info.active.text : ''
  });

  const task = store.jobs.get(taskId);
  const signature = todos.map((t) => t.status).join(',');
  if (task && task.__todoSig !== signature) {
    task.__todoSig = signature;
    const doneNames = todos.filter((t) => t.status === 'completed').map((t) => t.text);
    const running = todos.filter((t) => t.status === 'in_progress');
    store.appendLog(
      taskId,
      'info',
      '清单更新 ' + info.done + '/' + info.total + (running.length ? ' · 进行中：' + running.map((t) => t.text).join('、') : '') +
        (doneNames.length ? ' · 已完成：' + doneNames.slice(-3).join('、') : '')
    );
    jobLogs.append(taskId, 'checklist ' + info.done + '/' + info.total + ' :: ' + signature, 'info');
  }
  logger.info('todos', 'task checklist synced', {
    sessionId: sid,
    done: info.done,
    total: info.total,
    active: activeText.slice(0, 80)
  });
  return true;
}

/**
 * 通用事件协议 → 内部事件名。
 *
 * UserPromptSubmit / PreToolUse / PostToolUse / Stop 是某一个平台特有的命名，
 * 别的平台不会长这样。这里做一层归一化：任何平台只要发
 * tool.start / tool.end / turn.start / turn.end，就能被正确识别。
 * 新增平台不需要改这里的 switch，只要遵守通用协议即可。
 */
const GENERIC_EVENT_MAP = {
  'turn.start': 'UserPromptSubmit',
  'session.start': 'UserPromptSubmit',
  'tool.start': 'PreToolUse',
  'tool.end': 'PostToolUse',
  'tool.fail': 'PostToolUse',
  'turn.end': 'Stop',
  'session.end': 'Stop'
};

function normalizeEvent(payload) {
  if (!payload || !payload.event) return payload;
  const mapped = GENERIC_EVENT_MAP[payload.event];
  if (!mapped) return payload;

  const out = { ...payload, event: mapped };
  // 通用体把命令放在 payload.command；内部按 toolInput 提取目标
  if (!out.toolInput) {
    const input = {};
    if (payload.command) input.command = payload.command;
    if (payload.filePath) input.file_path = payload.filePath;
    if (payload.pattern) input.pattern = payload.pattern;
    if (Object.keys(input).length) out.toolInput = input;
  }
  if (!out.tool && payload.tool) out.tool = payload.tool;
  return out;
}

function handleEvent(rawPayload) {
  const payload = normalizeEvent(rawPayload);
  if (!payload || !payload.event) return;

  // A plugin the user explicitly skipped stops contributing events.
  const pluginRootName = payload.pluginRoot ? path.basename(String(payload.pluginRoot)) : '';
  if (pluginRootName) {
    const flag = decisions.get('plugin', pluginRootName);
    if (flag && flag.action === 'skip') return;
  }

  touchSource('hook');
  const sid = payload.sessionId || 'local';
  const ts = payload.ts || Date.now();

  switch (payload.event) {
    case 'UserPromptSubmit': {
      const id = 'turn:' + sid + ':' + ts;
      activeTurn.set(sid, id);
      toolCount.set(sid, 0);
      store.upsert({
        id,
        kind: 'agent',
        label: 'Agent 轮次',
        detail: trimText(payload.summary || '用户输入', 160),
        sessionId: sid,
        source: 'hook',
        startedAt: ts,
        note: '等待任务清单…'
      });
      logger.start('hook', 'turn start', { sessionId: sid, __target: trimText(payload.summary, 90) || 'user prompt' });
      break;
    }
    case 'PreToolUse': {
      const tool = payload.tool || 'Tool';
      const id = 'tool:' + sid + ':' + ts + ':' + tool;
      const target = toolTarget(tool, payload.toolInput);
      store.upsert({
        id,
        kind: 'tool',
        label: '工具 · ' + tool,
        detail: target,
        command: trimText(target, 300),
        sessionId: sid,
        source: 'hook',
        startedAt: ts
      });
      if (!pendingTools.has(sid)) pendingTools.set(sid, []);
      pendingTools.get(sid).push({ id, tool, toolUseId: payload.toolUseId || '' });
      jobLogs.append(id, '▶ ' + tool + ' ' + target, 'info');

      // Auto task breakdown from the agent's checklist tool (if any).
      const synced = syncTodos(sid, tool, payload.toolInput, ts);

      const count = (toolCount.get(sid) || 0) + 1;
      toolCount.set(sid, count);
      const turn = activeTurn.get(sid);
      if (turn) {
        store.upsert({
          id: turn,
          detail: count + ' 次工具调用 · 当前 ' + tool + (synced ? ' · 清单已同步' : ''),
          lastTool: tool
        });
      }
      logger.start('hook', 'tool start', {
        tool,
        sessionId: sid,
        todos: synced,
        __target: tool + (target ? ' · ' + trimText(target, 110) : '')
      });
      break;
    }
    case 'PostToolUse': {
      const tool = payload.tool || '';
      const list = pendingTools.get(sid) || [];
      let index = -1;
      if (payload.toolUseId) {
        index = list.findIndex((item) => item.toolUseId === payload.toolUseId);
      }
      if (index < 0) {
        // No id from the hook: prefer the OLDEST pending call with the same tool
        // name (FIFO). Scanning backwards attached the completion to the newest
        // call, which mis-attributes concurrent same-name tools.
        for (let i = 0; i < list.length; i += 1) {
          if (!tool || list[i].tool === tool) {
            index = i;
            break;
          }
        }
        const sameName = list.filter((item) => !tool || item.tool === tool).length;
        if (sameName > 1) {
          logger.warn('hook', 'ambiguous tool completion without toolUseId', {
            sessionId: sid,
            tool,
            pending: sameName
          });
        }
      }
      const hit = index >= 0 ? list.splice(index, 1)[0] : null;
      const failed = !!payload.toolResponseError;
      if (hit) {
        const output = payload.toolResponse || '';
        if (output) {
          jobLogs.append(hit.id, output, failed ? 'error' : 'info');
          const lines = output.split(/\r?\n/).filter((l) => l.trim());
          for (const line of lines.slice(-12)) {
            store.appendLog(hit.id, failed ? 'error' : 'info', line.slice(0, 300));
          }
          const parsed = parseLastProgress(lines);
          if (parsed) {
            store.upsert({ id: hit.id, current: parsed.current, total: parsed.total, note: parsed.line.slice(0, 160) });
          }
        }
        const linked = store.jobs.get(hit.id);
        const duration = linked && linked.startedAt ? Date.now() - linked.startedAt : null;
        store.finish(hit.id, failed ? 'failed' : 'done', failed ? '工具返回错误' : '');

        const eventMeta = {
          tool: hit.tool,
          sessionId: sid,
          outputBytes: output.length,
          __durationMs: duration,
          __target: hit.tool + (linked && linked.command ? ' · ' + trimText(linked.command, 110) : '')
        };
        if (failed) {
          const firstLine = (output.split(/\r?\n/).find((l) => l.trim()) || '工具返回错误').slice(0, 200);
          logger.fail('hook', 'tool failed', firstLine, eventMeta);
        } else {
          logger.done('hook', 'tool done', eventMeta);
        }
      }
      // A checklist tool may also carry the final state in its response.
      if (!hit) syncTodos(sid, tool, payload.toolInput, ts);
      break;
    }
    case 'SessionStart': {
      // Fired by the hook when AIWorkKit opens; proves the capture chain is live.
      logger.success('hook', 'session start', {
        sessionId: sid,
        client: payload.client || '',
        cwd: trimText(payload.cwd || '', 120)
      });
      break;
    }
    case 'SessionEnd': {
      // Release per-session bookkeeping so a long-running daemon does not leak
      // one map entry per closed window.
      const leakedTools = (pendingTools.get(sid) || []).length;
      pendingTools.delete(sid);
      activeTurn.delete(sid);
      toolCount.delete(sid);
      logger.info('hook', 'session end', { sessionId: sid, openTools: leakedTools });
      break;
    }
    case 'Stop': {
      const turn = activeTurn.get(sid);
      const tools = toolCount.get(sid) || 0;
      let duration = null;
      if (turn) {
        const turnJob = store.jobs.get(turn);
        duration = turnJob && turnJob.startedAt ? Date.now() - turnJob.startedAt : null;
        store.finish(turn, 'done');
        activeTurn.delete(sid);
      }
      const list = pendingTools.get(sid) || [];
      for (const item of list) store.finish(item.id, 'done');
      pendingTools.set(sid, []);
      logger.done('hook', 'turn done', { sessionId: sid, tools, __durationMs: duration });
      break;
    }
    default: {
      logger.info('hook', 'unhandled event: ' + payload.event, { sessionId: sid });
    }
  }
  scheduleBroadcast();
}

/** Best-effort percentage picked from the tail of a tool response. */
function parseLastProgress(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = parseLine(lines[i]);
    if (parsed && (parsed.current != null || parsed.percent != null)) {
      return { current: parsed.current, total: parsed.total, line: lines[i] };
    }
  }
  return null;
}

function replayQueue() {
  let text = '';
  try {
    text = fs.readFileSync(QUEUE_FILE, 'utf8');
  } catch (_) {
    return 0;
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  let replayed = 0;
  for (const line of lines) {
    try {
      handleEvent(JSON.parse(line));
      replayed += 1;
    } catch (_) {
      /* skip corrupt queue rows */
    }
  }
  try {
    fs.writeFileSync(QUEUE_FILE, '', 'utf8');
  } catch (_) {
    /* ignore */
  }
  if (replayed) logger.info('boot', 'replayed queued hook events', { count: replayed });
  return replayed;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

/*
 * JSON 响应 / 请求体 / 写守卫 / 静态文件都来自 apps/_shared/httpserver.mjs。
 *
 * 这四样原来四个服务各写一份，改一次要改四处 —— 「远程写必须带 token」
 * 那一轮就漏过 CodeVault 和 errvault，正是这种重复导致的。
 *
 * 路由和 SSE 仍留在本文件：它们和 Eco 的业务强耦合（/api/stream 直接接管
 * 响应、/api/events 回 204、19 条路由带业务分支），抽出去反而更难维护。
 */
const shared = require('../../_shared/httpserver.mjs');

const sendJson = shared.sendJson;

/** 请求体：上限 2 MB；空体返回 null（保持原有语义，调用方都按 falsy 处理）。 */
async function readBody(req) {
  const body = await shared.readBody(req, 2 * 1024 * 1024);
  if (body && typeof body === 'object' && !Array.isArray(body) && !Object.keys(body).length) {
    return null;
  }
  return body;
}

/**
 * 写请求守卫：先看本机 API token（脚本 / hook 用），
 * 否则交给共享守卫（本机来源 + Origin + sec-fetch-site）。
 *
 * 额外保留 Eco 原有的严格度：写请求必须带 JSON content-type，
 * 哪怕没有请求体 —— 共享层只对「有体」的请求要求 JSON。
 */
function guardWrite(req) {
  const token = String(req.headers['x-eco-token'] || '');
  if (token && token === API_TOKEN) return '';

  const blocked = shared.guardWrite(req);
  if (blocked) return blocked;

  const method = String(req.method || 'GET').toUpperCase();
  if (!WRITE_METHODS.has(method)) return '';

  const ctype = String(req.headers['content-type'] || '').toLowerCase();
  if (ctype.indexOf('application/json') !== 0) {
    return 'content-type must be application/json';
  }
  return '';
}

/**
 * Read the live command line of a PID.
 * Used before killing: the process list snapshot may be seconds old and Windows
 * recycles PIDs, so signalling the raw snapshot could hit an unrelated process.
 */
function readProcessCommand(pid) {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CommandLine'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout).trim())
    );
  });
}

/** 静态文件：交给共享实现（MIME 表、HEAD、路径穿越校验统一）。 */
function serveStatic(req, res, pathname) {
  if (!shared.serveStaticFile({ root: WEB_DIR, pathname, req, res })) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

function openSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(': eco stream ready\n\n');
  res.write('event: state\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
  sseClients.add(res);
  logger.info('http', 'sse client connected', { total: sseClients.size });
  const keepAlive = setInterval(() => {
    try {
      res.write('event: ping\ndata: {}\n\n');
    } catch (_) {
      clearInterval(keepAlive);
    }
  }, 15000);
  if (keepAlive.unref) keepAlive.unref();
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    logger.info('http', 'sse client disconnected', { total: sseClients.size });
  });
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Everything the detail window needs for one process or one flow:
 * process metrics, linked job (+progress), project, source code and log tail.
 */
function buildDetail(pid, jobId) {
  const proc = pid ? procScanner.processes.find((p) => p.pid === pid) || null : null;
  let job = jobId ? store.jobs.get(jobId) : null;
  if (!job && proc) {
    job = Array.from(store.jobs.values()).find((j) => j.pid === proc.pid) || null;
  }
  if (!proc && job && job.pid) {
    // allow a job id to resolve its process as well
    const linked = procScanner.processes.find((p) => p.pid === job.pid) || null;
    if (linked) {
      return buildDetail(linked.pid, jobId);
    }
  }

  const command = (proc && proc.command) || (job && job.command) || '';
  const scriptPath = extractScriptPath(command);
  const script = scriptPath ? readScript(scriptPath) : null;
  const decorated = job ? store.decorate(job) : null;

  return {
    ok: true,
    process: proc,
    job: decorated,
    project: (proc && proc.project) || null,
    command,
    script,
    logs: job ? jobLogs.read(job.id, 200) : { exists: false, lines: [], totalLines: 0 }
  };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  const blocked = guardWrite(req);
  if (blocked) {
    logger.warn('http', 'write request blocked: ' + blocked, { path: pathname, origin: String(req.headers.origin || '') });
    return sendJson(res, 403, { ok: false, error: blocked });
  }

  if (method === 'GET' && pathname === '/api/guard') {
    return sendJson(res, 200, { ok: true, killed: guardKilled, ...guard.state() });
  }

  if (method === 'POST' && pathname === '/api/guard/action') {
    const body = (await readBody(req)) || {};
    const action = String(body.action || '');

    if (action === 'unlock') {
      const ok = guard.unlock(body.key ? String(body.key) : '');
      logger.info('guard', 'manual unlock', { key: body.key || '*', ok });
      scheduleBroadcast();
      return sendJson(res, 200, { ok, killed: guardKilled, ...guard.state() });
    }

    if (action === 'clean') {
      // Force a re-check so the cleanup acts on the current snapshot, not on the
      // verdict of the previous sampling round.
      const verdict = guard.inspect(procScanner.processes);
      const killed = await cleanUpDuplicates(verdict.kill);
      scheduleBroadcast();
      return sendJson(res, 200, { ok: true, killed, cleaned: killed, ...guard.state() });
    }

    return sendJson(res, 400, { ok: false, error: 'unknown action: ' + action });
  }

  if (method === 'GET' && pathname === '/api/health') {
    // app 字段供 launch/stop 的身份校验使用（端口可能被别的程序占用）
    return sendJson(res, 200, {
      ok: true,
      app: 'eco',
      version: VERSION,
      port: PORT,
      pid: process.pid,
      uptimeMs: Date.now() - START_AT
    });
  }

  /* ---- 降耗配置（设置页读写） ---- */
  if (method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, {
      ok: true,
      config: settings,
      platforms: readPlatforms(),
      defaults: DEFAULT_SETTINGS
    });
  }
  if (method === 'POST' && pathname === '/api/config') {
    const patch = (await readBody(req)) || {};
    // 只认自己的字段，其余忽略；空体视为查询，不写盘
    if (!Object.keys(patch).length) {
      return sendJson(res, 400, { ok: false, error: 'empty body' });
    }
    const beforeInterval = settings.scanIntervalMs;
    const saved = applySettings(patch);

    // 采样间隔改了就立即换掉定时器，不用重启服务
    if (saved.scanIntervalMs !== beforeInterval && !args.noProc) {
      procScanner.stop();
      procScanner.intervalMs = saved.scanIntervalMs;
      procScanner.start();
    }

    logger.info('config', 'settings updated', { keys: Object.keys(patch).join(',') });
    scheduleBroadcast();
    return sendJson(res, 200, { ok: true, config: saved });
  }

  if (method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, snapshot());
  }
  if (method === 'GET' && pathname === '/api/stream') {
    return openSse(req, res);
  }
  if (method === 'GET' && pathname === '/api/logs/live') {
    const since = Number(url.searchParams.get('since') || 0);
    return sendJson(res, 200, logger.live(since));
  }
  if (method === 'GET' && pathname === '/api/jobs') {
    return sendJson(res, 200, { jobs: store.list() });
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && jobMatch) {
    const job = store.jobs.get(jobMatch[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'job not found' });
    const decorated = store.decorate(job);
    const proc = decorated.pid ? procScanner.processes.find((p) => p.pid === decorated.pid) : null;
    return sendJson(res, 200, { ok: true, job: decorated, process: proc || null });
  }

  const logsMatch = /^\/api\/jobs\/([^/]+)\/logs$/.exec(pathname);
  if (method === 'GET' && logsMatch) {
    const id = logsMatch[1];
    const tail = Number(url.searchParams.get('tail') || 200);
    const sinceOffset = url.searchParams.get('sinceOffset');
    const job = store.jobs.get(id);

    if (sinceOffset !== null) {
      const chunk = jobLogs.readFrom(id, Math.max(0, Number(sinceOffset) || 0));
      return sendJson(res, 200, {
        ok: true,
        id,
        exists: chunk.exists,
        totalLines: 0,
        bytes: chunk.bytes,
        offset: chunk.offset,
        lines: chunk.lines,
        memoryTail: job ? job.logs.slice(-20) : []
      });
    }

    const file = jobLogs.read(id, tail > 0 ? Math.min(tail, 2000) : 0);
    return sendJson(res, 200, {
      ok: true,
      id,
      exists: file.exists,
      totalLines: file.totalLines || 0,
      bytes: file.bytes || 0,
      offset: file.bytes || 0,
      lines: file.lines,
      memoryTail: job ? job.logs.slice(-20) : []
    });
  }

  const procDetail = /^\/api\/processes\/(\d+)\/detail$/.exec(pathname);
  if (method === 'GET' && procDetail) {
    return sendJson(res, 200, buildDetail(Number(procDetail[1]), ''));
  }

  const jobDetail = /^\/api\/jobs\/([^/]+)\/detail$/.exec(pathname);
  if (method === 'GET' && jobDetail) {
    return sendJson(res, 200, buildDetail(0, jobDetail[1]));
  }

  if (method === 'POST' && pathname === '/api/client-error') {
    const body = (await readBody(req)) || {};
    const message = String(body.message || 'unknown client error').slice(0, 500);
    const source = String(body.source || '').slice(0, 300);
    const stack = String(body.stack || '').slice(0, 2000);
    logger.error('client', message + (source ? ' @ ' + source : ''), stack || undefined);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/events') {
    const body = await readBody(req);
    if (body) {
      // 用量累计：统计真实到达的事件量与字节量（说明见 usageStats 定义处）
      try {
        usageStats.events += 1;
        usageStats.chars += JSON.stringify(body).length;
      } catch (_) {
        /* 统计失败绝不能影响事件入库 */
      }
      handleEvent(body);
    }
    res.writeHead(204).end();
    return undefined;
  }

  if (method === 'POST' && (pathname === '/api/jobs' || pathname === '/api/report' || pathname === '/api/progress')) {
    const body = (await readBody(req)) || {};
    const input = body.job || body;
    if (!input.id) {
      return sendJson(res, 400, { ok: false, error: 'id is required' });
    }
    touchSource(input.source === 'wrapper' ? 'wrapper' : 'manual');
    if (pathname === '/api/jobs') {
      const existed = store.jobs.has(input.id);
      const job = store.upsert(input);
      if (!existed && job) {
        logger.start('progress', 'flow start', {
          kind: job.kind,
          __target: (job.label || job.id) + ' · ' + job.id
        });
      }
      return sendJson(res, 200, { ok: true, job: job ? store.decorate(job) : null });
    }
    const job = store.progress(input);
    if (!job) return sendJson(res, 400, { ok: false, error: 'invalid payload' });
    return sendJson(res, 200, { ok: true, job: store.decorate(job) });
  }

  const logMatch = /^\/api\/jobs\/([^/]+)\/log$/.exec(pathname);
  if (method === 'POST' && logMatch) {
    const body = (await readBody(req)) || {};
    const text = body.message || body.msg || '';
    const job = store.appendLog(logMatch[1], body.level, text);
    if (!job) return sendJson(res, 404, { ok: false, error: 'job not found' });
    jobLogs.append(logMatch[1], text, body.level);
    return sendJson(res, 200, { ok: true });
  }

  const finishMatch = /^\/api\/jobs\/([^/]+)\/finish$/.exec(pathname);
  if (method === 'POST' && finishMatch) {
    const body = (await readBody(req)) || {};
    const status = body.status || (body.failed ? 'failed' : 'done');
    const job = store.finish(finishMatch[1], status, body.note);
    if (!job) return sendJson(res, 404, { ok: false, error: 'job not found' });
    const finishDuration = job.startedAt ? Date.now() - job.startedAt : null;
    const finishMeta = {
      id: job.id,
      status,
      __durationMs: finishDuration,
      __target: job.label || job.id
    };
    if (status === 'failed') logger.fail('progress', 'flow failed', body.note || '', finishMeta);
    else logger.done('progress', 'flow ' + status, finishMeta);
    return sendJson(res, 200, { ok: true });
  }

  const delMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
  if (method === 'DELETE' && delMatch) {
    return sendJson(res, 200, { ok: store.remove(delMatch[1]) });
  }

  if (method === 'POST' && pathname === '/api/clear') {
    const removed = store.clearFinished();
    logger.info('ui', 'cleared finished jobs', { removed });
    return sendJson(res, 200, { ok: true, removed });
  }

  /* ---- manual intervention: processes ---------------------------------- */

  const procAction = /^\/api\/processes\/(\d+)\/action$/.exec(pathname);
  if (procAction && (method === 'POST' || method === 'DELETE')) {
    const pid = Number(procAction[1]);

    if (method === 'DELETE') {
      const cleared = decisions.clear('process', pid);
      logger.info('decision', 'process flag cleared', { pid, cleared });
      return sendJson(res, 200, { ok: cleared });
    }

    const body = (await readBody(req)) || {};
    const action = String(body.action || '');
    if (['stall', 'skip', 'kill'].indexOf(action) < 0) {
      return sendJson(res, 400, { ok: false, error: 'action must be stall | skip | kill' });
    }
    const mode = action === 'skip' ? String(body.mode || 'manual') : '';
    if (action === 'skip' && !SKIP_MODES[mode]) {
      return sendJson(res, 400, { ok: false, error: 'unknown mode: ' + mode });
    }
    if (action === 'kill' && body.confirm !== true) {
      return sendJson(res, 400, { ok: false, error: 'kill requires confirm:true' });
    }

    const proc = procScanner.processes.find((p) => p.pid === pid);
    if (!proc) return sendJson(res, 404, { ok: false, error: 'process not found' });

    if (action === 'kill') {
      const liveCommand = await readProcessCommand(pid);
      if (!liveCommand) {
        return sendJson(res, 409, { ok: false, error: 'process already exited' });
      }
      const expected = String(proc.command || '').trim();
      if (expected && liveCommand !== expected) {
        logger.warn('decision', 'pid identity mismatch, kill refused', {
          pid,
          expected: trimText(expected, 120),
          actual: trimText(liveCommand, 120)
        });
        return sendJson(res, 409, {
          ok: false,
          error: 'process identity changed (pid reused); refresh the list and retry'
        });
      }
      try {
        process.kill(pid);
      } catch (e) {
        logger.error('decision', 'kill failed for pid ' + pid, e);
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    const record = decisions.set('process', pid, {
      action,
      mode,
      note: body.note,
      target: {
        pid,
        name: proc.name,
        command: proc.command,
        project: proc.project ? proc.project.name : ''
      }
    });

    // Keep the linked flows consistent with the human decision.
    const linked = [];
    for (const job of store.jobs.values()) {
      if (job.pid !== pid) continue;
      linked.push(job.id);
      if (action === 'skip') {
        store.finish(job.id, 'cancelled', '已跳过 · 改用「' + SKIP_MODES[mode] + '」');
      } else if (action === 'kill') {
        store.finish(job.id, 'cancelled', '已终止（pid ' + pid + '）');
      } else {
        store.appendLog(job.id, 'warn', '已标记卡住（pid ' + pid + '），等待人工处置');
      }
    }
    jobLogs.append(
      'process-' + pid,
      '[decision] ' + action + (mode ? ' → ' + SKIP_MODES[mode] : '') + (body.note ? ' · ' + body.note : '') + ' · ' + proc.command,
      action === 'stall' ? 'warn' : 'info'
    );

    if (action === 'stall') {
      logger.warn('decision', 'process flagged as stuck', { pid, name: proc.name, project: record.target.project, linked: linked.length });
    } else if (action === 'skip') {
      logger.success('decision', 'process skipped, alternative mode chosen', { pid, mode, name: proc.name, linked: linked.length });
    } else {
      logger.success('decision', 'process terminated by user', { pid, name: proc.name, linked: linked.length });
    }
    scheduleBroadcast();
    return sendJson(res, 200, { ok: true, decision: record, linked });
  }

  /* ---- plugin enable / disable ----------------------------------------- */

  const pluginEnabledRoute = /^\/api\/plugins\/([^/]+)\/enabled$/.exec(pathname);
  if (method === 'POST' && pluginEnabledRoute) {
    const name = decodeURIComponent(pluginEnabledRoute[1]);
    const body = (await readBody(req)) || {};
    const enabled = body.enabled !== false;
    const plugin = pluginScanner.plugins.find((p) => p.name === name);
    if (!plugin) return sendJson(res, 404, { ok: false, error: 'plugin not found' });

    const key = name + (plugin.marketplace ? '@' + plugin.marketplace : '');
    const file = settingsFile();
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: 'settings.json 不可读：' + err.message });
    }

    settings.enabledPlugins = settings.enabledPlugins || {};
    if (enabled) settings.enabledPlugins[key] = true;
    else delete settings.enabledPlugins[key];

    try {
      fs.copyFileSync(file, file + '.bak_eco_' + Date.now());
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    } catch (err) {
      logger.error('plugin', 'failed to update settings.json', err);
      return sendJson(res, 500, { ok: false, error: err.message });
    }

    pluginScanner.scan();
    if (enabled) logger.success('plugin', 'plugin enabled', { name, key });
    else logger.warn('plugin', 'plugin disabled', { name, key });
    scheduleBroadcast();
    return sendJson(res, 200, { ok: true, key, enabled, reloadRequired: true });
  }

  /* ---- manual intervention: plugins ------------------------------------ */

  const pluginAction = /^\/api\/plugins\/([^/]+)\/action$/.exec(pathname);
  if (pluginAction && (method === 'POST' || method === 'DELETE')) {
    const name = decodeURIComponent(pluginAction[1]);

    if (method === 'DELETE') {
      const cleared = decisions.clear('plugin', name);
      logger.info('decision', 'plugin flag cleared', { name, cleared });
      return sendJson(res, 200, { ok: cleared });
    }

    const body = (await readBody(req)) || {};
    const action = String(body.action || '');
    if (['stall', 'skip'].indexOf(action) < 0) {
      return sendJson(res, 400, { ok: false, error: 'action must be stall | skip' });
    }
    const mode = action === 'skip' ? String(body.mode || 'manual') : '';
    if (action === 'skip' && !SKIP_MODES[mode]) {
      return sendJson(res, 400, { ok: false, error: 'unknown mode: ' + mode });
    }
    const plugin = pluginScanner.plugins.find((p) => p.name === name);
    if (!plugin) return sendJson(res, 404, { ok: false, error: 'plugin not found' });

    const record = decisions.set('plugin', name, {
      action,
      mode,
      note: body.note,
      target: { name, root: plugin.root, project: plugin.project, marketplace: plugin.marketplace }
    });

    if (action === 'stall') {
      logger.warn('decision', 'plugin flagged as stuck', { name, project: plugin.project });
    } else {
      // Further hook events carrying this plugin root are dropped in handleEvent.
      logger.success('decision', 'plugin skipped, alternative mode chosen', { name, mode, project: plugin.project });
    }
    scheduleBroadcast();
    return sendJson(res, 200, { ok: true, decision: record });
  }

  if (method === 'GET') return serveStatic(req, res, pathname);
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

store.restore();
store.onChange(() => scheduleBroadcast());
// `onSample` is a plain property, not a setter: assign it, do not call it.
procScanner.onSample = () => {
  sources.scan.lastAt = Date.now();
  sources.scan.events += 1;

  // Guard runs on every sample: it is in-memory and cheap, and it keeps the
  // duplicate view consistent with the process table on the same tick.
  const verdict = guard.inspect(procScanner.processes);
  if (verdict.kill.length) {
    void cleanUpDuplicates(verdict.kill);
  }

  scheduleBroadcast();
};

// Short-lived script hosts are announced in the event stream, so a 2s python
// conversion still leaves a start/exit trace even though it never shows up as a
// long-running process row.
/** "python · pdf_to_images.py" reads far better than the full command line. */
function scriptTarget(p) {
  const match = /"?([^"\s]+\.(?:js|mjs|cjs|ts|py|ps1|sh|rb|lua|php|jar))"?/i.exec(p.command || '');
  const file = match ? match[1].split(/[\\/]/).pop() : '';
  return p.name + (file ? ' · ' + file : '');
}

procScanner.onSpawn = (p) => {
  logger.start('proc', 'script start', {
    pid: p.pid,
    project: p.project && p.project.name,
    __target: scriptTarget(p)
  });
};

procScanner.onExit = (p) => {
  const meta = {
    pid: p.pid,
    project: p.project && p.project.name,
    __target: scriptTarget(p)
  };
  if (p.durationMs != null) meta.__durationMs = p.durationMs;
  logger.done('proc', 'script exit', meta);
};
pluginScanner.start();
if (!args.noProc) procScanner.start();

const server = http.createServer((req, res) => {
  const started = Date.now();
  route(req, res)
    .catch((err) => {
      logger.error('http', 'request failed: ' + req.method + ' ' + req.url, err);
      try {
        sendJson(res, 500, { ok: false, error: err.message });
      } catch (_) {
        /* response already sent */
      }
    })
    .finally(() => {
      const cost = Date.now() - started;
      if (cost > 1500) logger.warn('http', 'slow request', { url: req.url, cost });
    });
});

server.on('error', (err) => {
  logger.error('boot', 'server error on port ' + PORT, err);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ port: PORT, pid: process.pid, startedAt: START_AT }, null, 2), 'utf8');
  } catch (_) {
    /* discovery files are optional */
  }
  logger.success('boot', 'eco daemon listening', {
    url: 'http://' + HOST + ':' + PORT,
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    cwd: args.cwd || process.cwd()
  });
  replayQueue();
  broadcast();
  // eslint-disable-next-line no-console
  console.log('[eco] dashboard: http://' + HOST + ':' + PORT + '  (pid ' + process.pid + ')');
});

// Finished flows disappear on their own (30s, failed 90s by default) so the
// board never accumulates history it cannot use.
const pruneTimer = setInterval(() => {
  const removed = store.prune();
  if (removed) {
    logger.info('maintenance', 'auto-cleared finished flows', {
      removed,
      doneTtlMs: store.doneTtlMs,
      failedTtlMs: store.failedTtlMs
    });
  }
}, 4000);
if (pruneTimer.unref) pruneTimer.unref();

// Tick the UI once per second so elapsed time, ETA and stall flags stay live
// even when no job changed.
//
// 这里发的是轻量 tick（几百字节），不是完整 state（约 133 KB）：
// 实测每秒全量序列化要占 3.1% 单核 / 200 KB/s（每个客户端）。
// 另外每 15 秒兜一次全量，防止有变更没走到 scheduleBroadcast 导致界面停更。
const tickTimer = setInterval(() => {
  if (!sseClients.size) return;
  broadcastTick();
  if (Date.now() - lastBroadcast > 15000) broadcast();
}, 1000);
if (tickTimer.unref) tickTimer.unref();

function shutdown(signal) {
  logger.info('boot', 'shutting down', { signal });
  store.persist();
  procScanner.stop();
  pluginScanner.stop();
  for (const res of sseClients) {
    try {
      res.end();
    } catch (_) {
      /* ignore */
    }
  }
  sseClients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => logger.error('process', 'uncaught exception', err));
process.on('unhandledRejection', (err) => logger.error('process', 'unhandled rejection', err));
process.on('exit', () => {
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch (_) {
    /* ignore */
  }
});

module.exports = { server, snapshot, handleEvent, parseLine, clean };
