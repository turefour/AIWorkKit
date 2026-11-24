#!/usr/bin/env node
'use strict';

/**
 * AIWorkKit Eco - command line client.
 *
 *   node cli/eco.js server [--port N] [--open] [--no-proc] [--cwd DIR]
 *   node cli/eco.js open            ensure daemon, open dashboard window
 *   node cli/eco.js status          print daemon + job summary
 *   node cli/eco.js report --id ID --current N --total N [--label L] [--unit U]
 *   node cli/eco.js log --id ID --message "..."
 *   node cli/eco.js done --id ID [--failed] [--note "..."]
 *   node cli/eco.js clear           drop closed jobs from the dashboard
 *   node cli/eco.js stop            stop the daemon
 *   node cli/eco.js run -- <cmd...> wrap a script, auto-detect its progress
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.eco');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const SERVER = path.join(ROOT, 'server', 'eco-server.js');
const { parseLine, clean } = require(path.join(ROOT, 'server', 'lib', 'parser.js'));
const { JobLogStore } = require(path.join(ROOT, 'server', 'lib', 'joblog.js'));

const jobLogs = new JobLogStore(path.join(ROOT, '.eco', 'jobs'));

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

let PORT = Number(process.env.AIWORKKIT_ECO_PORT || readConfig().port || 57821);
const HOST = '127.0.0.1';

function request(method, urlPath, body, timeout) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: urlPath,
        method,
        timeout: timeout || 2000,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': data.length }
          : {}
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch (_) {
            json = null;
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
        });
      }
    );
    req.on('error', () => resolve({ ok: false, status: 0, json: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, json: null });
    });
    if (data) req.write(data);
    req.end();
  });
}

async function healthy() {
  const res = await request('GET', '/api/health', null, 800);
  return res.ok;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureServer(options) {
  const opts = options || {};
  if (await healthy()) return true;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const args = [SERVER, '--port', String(PORT)];
  if (opts.noProc) args.push('--no-proc');
  if (opts.cwd) args.push('--cwd', opts.cwd);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: ROOT
  });
  child.unref();
  for (let i = 0; i < 30; i += 1) {
    await sleep(200);
    if (await healthy()) return true;
  }
  return false;
}

function openWindow(url) {
  const platform = process.platform;
  const target = String(url);
  // 只接受 http(s)。空白、" < > | ^ 这些无论加不加引号都会破坏命令行结构，
  // 直接拒绝；& 是合法查询串字符，靠下面的整体加引号处理。
  if (!/^https?:\/\/[^\s"<>|^`]+$/.test(target)) {
    return false;
  }
  try {
    if (platform === 'win32') {
      // cmd /c start "" "<url>"：URL 必须整段带引号，
      // 否则 cmd 会把 & 当成命令分隔符（?a=1&calc 就能跑到任意命令）。
      // 用 windowsVerbatimArguments 自己控制命令行，避免 Node 再加一层转义。
      spawn('cmd', ['/c', 'start', '""', '"' + target + '"'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true
      }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch (_) {
    return false;
  }
}

function dashboardUrl() {
  return 'http://' + HOST + ':' + PORT + '/';
}

/* ------------------------------------------------------------------ */
/* standalone window (Chromium --app mode)                             */
/* ------------------------------------------------------------------ */

const WINDOW_PROFILE = path.join(ROOT, '.eco', 'window-profile');
const WINDOW_TITLE = 'AIWorkKit Eco';

function findChromium() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* keep looking */
    }
  }
  return '';
}

/** PIDs of already running app windows pointing at this dashboard. */
function appWindowPids() {
  const marker = '--app=' + dashboardUrl();
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*" +
          marker.replace(/'/g, "''") +
          "*' } | Select-Object -ExpandProperty ProcessId"
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    );
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function focusAppWindow() {
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "(New-Object -ComObject WScript.Shell).AppActivate('" + WINDOW_TITLE + "') | Out-Null"],
      { windowsHide: true, timeout: 5000 }
    );
    return true;
  } catch (_) {
    return false;
  }
}

/** Launch a chromeless app window (own profile, own taskbar entry). */
function launchAppWindow() {
  const exe = findChromium();
  if (!exe) return false;
  const args = [
    '--app=' + dashboardUrl(),
    '--user-data-dir=' + WINDOW_PROFILE,
    '--window-size=1360,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,msEdgeSidebarV2'
  ];
  try {
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (_) {
    return false;
  }
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      flags._ = flags._.concat(argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

function fmtDuration(ms) {
  if (ms == null) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + String(s % 60).padStart(2, '0') + 's';
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdServer(argv) {
  const flags = parseFlags(argv);
  if (flags.port) PORT = Number(flags.port);
  if (await healthy()) {
    console.log('[eco] already running at ' + dashboardUrl());
    if (flags.open) openWindow(dashboardUrl());
    return 0;
  }
  if (flags.daemon) {
    const ok = await ensureServer({ noProc: flags['no-proc'], cwd: flags.cwd });
    console.log(ok ? '[eco] daemon started ' + dashboardUrl() : '[eco] failed to start daemon');
    if (ok && flags.open) openWindow(dashboardUrl());
    return ok ? 0 : 1;
  }
  const args = [SERVER, '--port', String(PORT)];
  if (flags['no-proc']) args.push('--no-proc');
  if (flags.cwd) args.push('--cwd', String(flags.cwd));
  const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
  if (flags.open) setTimeout(() => { openDashboard(false); }, 1200);
  return new Promise((resolve) => child.on('exit', (code) => resolve(code || 0)));
}

/** Standalone window first, browser only as an explicit or fallback path. */
async function openDashboard(forceBrowser) {
  if (!forceBrowser) {
    const running = appWindowPids();
    if (running.length) {
      focusAppWindow();
      return 'focused';
    }
    if (launchAppWindow()) return 'app';
  }
  openWindow(dashboardUrl());
  return 'browser';
}

async function cmdOpen(argv) {
  const flags = parseFlags(argv);
  if (flags.port) PORT = Number(flags.port);
  const ok = await ensureServer({ noProc: flags['no-proc'], cwd: flags.cwd });
  if (!ok) {
    console.error('[eco] daemon unavailable');
    return 1;
  }
  const mode = await openDashboard(!!flags.browser);
  const text = {
    focused: '独立窗口已在前台',
    app: '已启动独立窗口',
    browser: '未找到 Chromium，已在默认浏览器打开'
  }[mode];
  console.log('[eco] ' + text + ' · ' + dashboardUrl());
  return 0;
}

async function cmdStatus() {
  const res = await request('GET', '/api/state', null, 3000);
  if (!res.ok || !res.json) {
    console.log('[eco] daemon not running (port ' + PORT + ')');
    return 1;
  }
  const state = res.json;
  const s = state.summary || {};
  console.log('[eco] ' + dashboardUrl() + '  pid ' + state.server.pid + '  up ' + fmtDuration(state.server.uptimeMs));
  console.log(
    '  jobs: ' +
      (s.total || 0) +
      ' | running ' +
      (s.running || 0) +
      ' | done ' +
      (s.done || 0) +
      ' | failed ' +
      (s.failed || 0) +
      ' | overall ' +
      (s.overallPercent == null ? '-' : s.overallPercent + '%')
  );
  console.log('  scripts: ' + (s.scripts || 0) + ' | plugins: ' + (s.plugins || 0) + ' | cpu ' + (s.cpuPercent || 0) + '%');
  for (const job of (state.jobs || []).filter((j) => j.status === 'running' || j.status === 'stalled').slice(0, 12)) {
    const pct = job.percent == null ? '  --  ' : String(job.percent).padStart(5) + '%';
    console.log('   ' + pct + '  ' + job.kind.padEnd(7) + ' ' + job.label + '  ' + (job.current != null ? job.current + '/' + (job.total || '?') : ''));
  }
  return 0;
}

async function cmdReport(argv) {
  const flags = parseFlags(argv);
  if (!flags.id) {
    console.error('[eco] --id is required');
    return 2;
  }
  if (!(await ensureServer())) {
    console.error('[eco] daemon unavailable');
    return 1;
  }
  const payload = {
    id: String(flags.id),
    label: flags.label ? String(flags.label) : undefined,
    current: flags.current != null && flags.current !== true ? Number(flags.current) : undefined,
    total: flags.total != null && flags.total !== true ? Number(flags.total) : undefined,
    percent: flags.percent != null && flags.percent !== true ? Number(flags.percent) : undefined,
    unit: flags.unit ? String(flags.unit) : undefined,
    note: flags.note != null ? String(flags.note) : undefined,
    kind: flags.kind ? String(flags.kind) : 'manual',
    status: flags.status ? String(flags.status) : undefined
  };
  const res = await request('POST', '/api/progress', payload, 2500);
  if (!res.ok) {
    console.error('[eco] report failed (status ' + res.status + ')');
    return 1;
  }
  const job = res.json && res.json.job;
  console.log('[eco] ' + payload.id + ' ' + (job && job.percent != null ? job.percent + '%' : 'updated'));
  return 0;
}

async function cmdLog(argv) {
  const flags = parseFlags(argv);
  if (!flags.id || !flags.message) {
    console.error('[eco] --id and --message are required');
    return 2;
  }
  const res = await request('POST', '/api/jobs/' + encodeURIComponent(flags.id) + '/log', {
    level: flags.level || 'info',
    message: String(flags.message)
  });
  console.log(res.ok ? '[eco] logged' : '[eco] log failed');
  return res.ok ? 0 : 1;
}

async function cmdDone(argv) {
  const flags = parseFlags(argv);
  if (!flags.id) {
    console.error('[eco] --id is required');
    return 2;
  }
  const status = flags.failed ? 'failed' : flags.cancelled ? 'cancelled' : 'done';
  const res = await request('POST', '/api/jobs/' + encodeURIComponent(flags.id) + '/finish', {
    status,
    note: flags.note != null ? String(flags.note) : undefined
  });
  console.log(res.ok ? '[eco] ' + flags.id + ' → ' + status : '[eco] job not found');
  return res.ok ? 0 : 1;
}

async function cmdClear() {
  const res = await request('POST', '/api/clear', {});
  console.log(res.ok && res.json ? '[eco] cleared ' + res.json.removed + ' jobs' : '[eco] clear failed');
  return 0;
}

async function cmdStop() {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(path.join(STATE_DIR, 'server.pid'), 'utf8'));
  } catch (_) {
    pid = 0;
  }
  if (!pid) {
    console.log('[eco] no daemon pid file');
    return 1;
  }
  try {
    process.kill(pid);
    console.log('[eco] stopped pid ' + pid);
    return 0;
  } catch (e) {
    console.error('[eco] stop failed: ' + e.message);
    return 1;
  }
}

/** Decide how to spawn: direct exec for real files, shell only for shims. */
function buildCommandSpec(command) {
  const exe = command[0];
  // 需要加引号的字符：空白、cmd 的元字符，外加 % 和 !
  // % 会被 cmd 展开成变量、! 在延迟展开下会被解析 —— 不加引号时它们能改变参数边界。
  const quote = (arg) => (/[\s"&|<>^%!]/.test(arg) ? '"' + arg.replace(/"/g, '""') + '"' : arg);
  const pathLike = exe.includes('/') || exe.includes('\\');
  let exists = false;
  try {
    exists = fs.existsSync(exe) && fs.statSync(exe).isFile();
  } catch (_) {
    exists = false;
  }

  // .ps1 不必经过 cmd：直接交给 powershell.exe，参数由 CreateProcess 传，
  // 完全绕开 cmd 的那一层解析，也省掉一次 cmd 启动。
  if (/\.ps1$/i.test(exe)) {
    return {
      cmd: 'powershell.exe',
      argv: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', exe].concat(
        command.slice(1)
      ),
      shell: false
    };
  }

  const isShim = /\.(cmd|bat)$/i.test(exe);
  const needsShell = isShim || (!exists && !pathLike);
  if (needsShell) {
    return { cmd: command.map(quote).join(' '), argv: [], shell: true };
  }
  return { cmd: exe, argv: command.slice(1), shell: false };
}

/** Wrap a command, forwarding output and turning it into live progress. */
async function cmdRun(argv) {
  const flags = parseFlags(argv);
  const command = flags._;
  if (!command.length) {
    console.error('[eco] usage: eco run -- <command ...>');
    return 2;
  }
  const jobId = flags.id ? String(flags.id) : 'run-' + Date.now().toString(36);
  const label = flags.label ? String(flags.label) : command.join(' ');
  const cmdline = buildCommandSpec(command);
  const online = await ensureServer();
  const report = async (payload) => {
    if (!online) return;
    await request('POST', '/api/progress', { id: jobId, ...payload }, 1200);
  };

  await report({
    label,
    kind: 'script',
    status: 'running',
    command: command.join(' ').slice(0, 300),
    total: flags.total ? Number(flags.total) : undefined,
    unit: flags.unit ? String(flags.unit) : '',
    source: 'wrapper'
  });

  const child = spawn(cmdline.cmd, cmdline.argv, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: cmdline.shell,
    windowsHide: true,
    cwd: process.cwd(),
    env: { ...process.env, ECO_JOB_ID: jobId, AIWORKKIT_ECO_PORT: String(PORT) }
  });

  await report({ pid: child.pid, note: 'pid ' + child.pid });

  let current = null;
  let total = flags.total ? Number(flags.total) : null;
  let lastPost = 0;
  const pendingLogs = [];

  const handleChunk = (stream, isError) => {
    let buffer = '';
    return (chunk) => {
      const text = chunk.toString('utf8');
      stream.write(text);
      buffer += text;
      const parts = buffer.split(/\r|\n/);
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = clean(part);
        if (!line) continue;
        jobLogs.append(jobId, line, isError ? 'error' : 'info');
        const parsed = parseLine(line);
        if (parsed) {
          if (parsed.current != null) current = parsed.current;
          if (parsed.total != null) total = parsed.total;
          const now = Date.now();
          if (now - lastPost > 300) {
            lastPost = now;
            report({
              current,
              total,
              percent: parsed.percent != null && total == null ? Math.round(parsed.percent * 10) / 10 : undefined,
              note: line.slice(0, 200)
            });
          }
        } else if (isError || pendingLogs.length < 20) {
          pendingLogs.push({ level: isError ? 'error' : 'info', message: line.slice(0, 300) });
        }
      }
      if (pendingLogs.length >= 5) flushLogs();
    };
  };

  const flushLogs = () => {
    if (!online) return;
    const batch = pendingLogs.splice(0, pendingLogs.length);
    for (const item of batch) {
      request('POST', '/api/jobs/' + encodeURIComponent(jobId) + '/log', item, 1000);
    }
  };

  child.stdout.on('data', handleChunk(process.stdout, false));
  child.stderr.on('data', handleChunk(process.stderr, true));

  return new Promise((resolve) => {
    child.on('close', async (code) => {
      flushLogs();
      const status = code === 0 ? 'done' : 'failed';
      await report({ status, note: 'exit code ' + code });
      await request('POST', '/api/jobs/' + encodeURIComponent(jobId) + '/finish', {
        status,
        note: 'exit code ' + code
      }, 1500);
      resolve(code || 0);
    });
  });
}

/** Print the persisted log of any flow, optionally following it. */
async function cmdLogs(argv) {
  const flags = parseFlags(argv);
  const id = flags.id || flags._[0];
  if (!id) {
    console.error('[eco] --id is required');
    return 2;
  }
  const tail = flags.tail ? Number(flags.tail) : 200;
  const res = await request('GET', '/api/jobs/' + encodeURIComponent(id) + '/logs?tail=' + tail, null, 3000);
  if (!res.ok || !res.json) {
    console.error('[eco] job not found: ' + id);
    return 1;
  }
  const lines = res.json.lines || [];
  if (lines.length) console.log(lines.join('\n'));
  else if ((res.json.memoryTail || []).length) {
    for (const item of res.json.memoryTail) console.log('[' + item.level + '] ' + item.message);
  } else {
    console.log('[eco] no log output yet');
  }

  if (!flags.follow) return 0;

  // Byte cursor: the daemon only returns what was appended since the last poll,
  // so following a long run no longer re-reads the whole 4MB file every second.
  let offset = Number(res.json.offset || res.json.bytes || 0);
  const timer = setInterval(async () => {
    const r = await request('GET', '/api/jobs/' + encodeURIComponent(id) + '/logs?sinceOffset=' + offset, null, 3000);
    if (!r.ok || !r.json) return;
    const fresh = r.json.lines || [];
    if (fresh.length) console.log(fresh.join('\n'));
    if (typeof r.json.offset === 'number') offset = r.json.offset;
  }, 1000);
  if (timer.unref) timer.unref();
  return new Promise(() => {
    process.on('SIGINT', () => {
      clearInterval(timer);
      process.exit(0);
    });
  });
}

function usage() {
  console.log(
    [
      'AIWorkKit Eco CLI',
      '  server [--port N] [--open] [--daemon] [--no-proc]',
      '  open [--browser] | status | stop | clear',
      '  report --id ID [--current N] [--total N] [--percent P] [--label L] [--unit U] [--note T]',
      '  log --id ID --message TEXT [--level info|warn|error]',
      '  logs --id ID [--tail 200] [--follow]   view the full log of a flow',
      '  task --id ID --label L --steps "A|B|C" [--current N] [--done]',
      '  done --id ID [--failed] [--note T]',
      '  run -- <command ...>   wrap a script and auto-detect progress',
      '',
      'Dashboard: ' + dashboardUrl()
    ].join('\n')
  );
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'server':
      return cmdServer(rest);
    case 'open':
      return cmdOpen(rest);
    case 'status':
      return cmdStatus();
    case 'report':
      return cmdReport(rest);
    case 'log':
      return cmdLog(rest);
    case 'logs':
      return cmdLogs(rest);
    case 'task':
      return cmdTask(rest);
    case 'done':
      return cmdDone(rest);
    case 'clear':
      return cmdClear();
    case 'stop':
      return cmdStop();
    case 'run':
      return cmdRun(rest);
    default:
      usage();
      return cmd ? 2 : 0;
  }
}

main()
  .then((code) => process.exit(typeof code === 'number' ? code : 0))
  .catch((err) => {
    console.error('[eco] ' + err.message);
    process.exit(1);
  });

/**
 * Publish the current task with its checklist.
 * Used when agent hooks are not loaded yet: the dashboard still shows the task
 * with per-step status instead of nothing.
 */
async function cmdTask(argv) {
  const flags = parseFlags(argv);
  const id = flags.id ? String(flags.id) : 'task-' + Date.now().toString(36);
  const label = flags.label ? String(flags.label) : '当前任务';
  const steps = String(flags.steps || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!(await ensureServer())) {
    console.error('[eco] daemon unavailable');
    return 1;
  }

  if (flags.done || flags.failed) {
    const status = flags.failed ? 'failed' : 'done';
    const res = await request('POST', '/api/jobs/' + encodeURIComponent(id) + '/finish', { status, note: flags.note || '' }, 2000);
    console.log(res.ok ? '[eco] task ' + id + ' -> ' + status : '[eco] task not found');
    return res.ok ? 0 : 1;
  }

  const total = steps.length;
  let current = flags.current != null && flags.current !== true ? Number(flags.current) : 0;
  current = Math.max(0, Math.min(total, current));
  const active = total && current < total ? steps[current] : '';
  const status = total && current >= total ? 'done' : 'running';

  const payload = {
    id,
    kind: 'task',
    label: '当前任务 · ' + (active || label),
    detail: current + ' / ' + total + ' 步骤完成',
    current,
    total,
    unit: '步骤',
    status,
    source: 'manual',
    steps: steps.map((text, index) => ({
      index,
      text,
      status: index < current ? 'completed' : index === current ? 'in_progress' : 'pending'
    })),
    note: active ? '进行中：' + active : '全部步骤完成'
  };

  const res = await request('POST', '/api/jobs', payload, 2500);
  if (!res.ok) {
    console.error('[eco] task publish failed (status ' + res.status + ')');
    return 1;
  }
  console.log('[eco] task ' + id + ' · ' + current + '/' + total + (active ? ' · 进行中：' + active : ' · 完成'));
  return 0;
}
