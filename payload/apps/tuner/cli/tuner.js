#!/usr/bin/env node
'use strict';

/**
 * AIWorkKit Idle Tuner - CLI front end.
 *
 * Thin wrapper around core/tuner.ps1: it only formats output and launches the
 * tray app. All real work (process discovery, working-set trim, priority,
 * suspend/resume) lives in the PowerShell core so the tray app and the plugin
 * commands cannot drift apart.
 *
 * Actions: status | trim | apply | quiet | restore | auto | tray | open | autostart | serve | config
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'core', 'tuner.ps1');
const TRAY = path.join(ROOT, 'tray', 'tray.ps1');
const SERVER = path.join(ROOT, 'server', 'tuner-server.js');
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AIWorkKitIdleTuner');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const WINDOW_PROFILE = path.join(DATA_DIR, 'window-profile');
const HOST = '127.0.0.1';
const WINDOW_TITLE = 'AIWorkKit 空闲降温器';

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function serverPort() {
  return Number(process.env.AIWORKKIT_TUNER_PORT || 57822);
}

function dashboardUrl() {
  return `http://${HOST}:${serverPort()}/`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------- local dashboard server ---------------- */

async function serverHealth() {
  try {
    const res = await fetch(`http://${HOST}:${serverPort()}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function ensureServer() {
  const healthy = await serverHealth();
  if (healthy) return { started: false, pid: healthy.pid };

  const child = spawn(process.execPath, [SERVER, '--port', String(serverPort())], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: ROOT,
  });
  child.unref();

  for (let i = 0; i < 40; i += 1) {
    await sleep(150);
    const probe = await serverHealth();
    if (probe) return { started: true, pid: probe.pid };
  }
  throw new Error(`本地服务启动失败（端口 ${serverPort()} 被占用？）`);
}

/* ---------------- standalone window (Chromium --app) ---------------- */

function findChromium() {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

function appWindowPids() {
  const marker = `--app=${dashboardUrl()}`;
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${marker.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function focusWindow() {
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate('${WINDOW_TITLE}') | Out-Null`],
      { windowsHide: true, timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
}

function launchAppWindow() {
  const exe = findChromium();
  if (!exe) return false;
  const args = [
    `--app=${dashboardUrl()}`,
    `--user-data-dir=${WINDOW_PROFILE}`,
    '--window-size=1280,860',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,msEdgeSidebarV2',
  ];
  try {
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

function openInBrowser() {
  try {
    spawn('cmd', ['/c', 'start', '', dashboardUrl()], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

async function openDashboard(quiet) {
  const { started } = await ensureServer();

  if (!started && appWindowPids().length > 0) {
    focusWindow();
    if (!quiet) console.log('独立窗口已在前台。');
    return 'focused';
  }

  const launched = launchAppWindow();
  if (!launched) openInBrowser();
  if (!quiet) {
    console.log(`独立窗口已打开：${dashboardUrl()}${launched ? '（Chromium app 模式）' : '（默认浏览器）'}`);
  }
  return launched ? 'app' : 'browser';
}

const ROLE_ZH = {
  main: '主进程',
  renderer: '渲染进程',
  gpu: 'GPU 进程',
  'node-service': '扩展宿主',
  tsserver: 'TS 服务',
  'extension-host': '扩展宿主',
  helper: '脚本子进程',
  utility: '工具进程',
  crashpad: '崩溃收集',
};

function runCore(args, timeout = 30000) {
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', CORE, ...args, '-Json'],
    { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  );

  if (res.error) {
    throw new Error(`无法启动 PowerShell: ${res.error.message}`);
  }

  const raw = (res.stdout || '').replace(/^\uFEFF/, '').trim();
  const start = raw.indexOf('{');
  if (start === -1) {
    const detail = (res.stderr || raw || '').trim() || `exit ${res.status}`;
    throw new Error(`核心引擎没有返回数据: ${detail}`);
  }

  let data;
  try {
    data = JSON.parse(raw.slice(start));
  } catch (err) {
    throw new Error(`核心引擎返回无法解析: ${raw.slice(0, 200)}`);
  }
  if (data && data.ok === false && data.error) throw new Error(data.error);
  return data;
}

function mb(n) {
  if (n === null || n === undefined) return '-';
  return `${Number(n).toFixed(1)} MB`;
}

function pct(n) {
  if (n === null || n === undefined) return '-';
  return `${Number(n).toFixed(1)}%`;
}

function timeText(iso) {
  if (!iso) return '从未';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function padRight(text, width) {
  const s = String(text);
  const shown = s.replace(/[\u4e00-\u9fa5]/g, 'xx').length;
  return s + ' '.repeat(Math.max(0, width - shown));
}

function printStatus(d) {
  const lines = [];
  if (!d.running) {
    console.log('AIWorkKit 没有在运行，无需降温。');
    return;
  }

  lines.push(`AIWorkKit 占用总览 · ${d.count} 个进程`);
  lines.push(`  工作集合计 : ${mb(d.totalMB)}`);
  lines.push(`  私有提交   : ${mb(d.privateMB)}`);
  lines.push(`  CPU        : ${pct(d.cpuPercent)}（${d.machineCores} 核合计口径）`);
  lines.push(`  自动降温   : ${d.autoMode ? `已开启（${d.autoLevel}）` : '关闭'}`);
  lines.push(`  已挂起进程 : ${d.suspended && d.suspended.length ? d.suspended.join(', ') : '无'}`);
  lines.push(
    `  最近降温   : ${timeText(d.lastApplyAt || d.lastTrimAt)}` +
      (d.lastMode ? `（${d.lastMode}）` : '') +
      (d.lastFreedMB !== null && d.lastFreedMB !== undefined ? `，释放 ${mb(d.lastFreedMB)}` : '')
  );
  if (d.resumeAt) {
    const left = Math.max(0, Math.round((new Date(d.resumeAt) - Date.now()) / 60000));
    lines.push(`  定时恢复   : ${timeText(d.resumeAt)} 后自动恢复（约 ${left} 分钟）`);
  }

  lines.push('');
  lines.push('  角色分布');
  (d.roles || []).forEach((r) => {
    const name = ROLE_ZH[r.role] || r.role;
    lines.push(`    ${padRight(name, 12)} ${String(r.count).padStart(3)} 个   ${mb(r.mb)}`);
  });

  lines.push('');
  lines.push('  占用前 8');
  lines.push('    PID      角色          工作集        CPU     优先级       状态');
  (d.top || []).forEach((p) => {
    const name = ROLE_ZH[p.role] || p.role;
    lines.push(
      `    ${String(p.pid).padEnd(8)} ${padRight(name, 12)} ${padRight(mb(p.wsMB), 11)} ${padRight(pct(p.cpuPct), 7)} ${padRight(p.priority, 12)} ${p.suspended ? '已挂起' : '-'}`
    );
  });

  console.log(lines.join('\n'));
}

function printApply(d) {
  const modeZh = { lite: '轻度降温', deep: '深度降温', suspend: '挂起后台' }[d.mode] || d.mode;
  const out = [];
  out.push(`已执行${modeZh}（不关闭软件）`);
  out.push(`  进程      : ${d.processes} 个，工作集回收 ${d.trimmed}/${d.processes}`);
  out.push(`  释放      : ${mb(d.freedMB)}（2 秒稳定后仍省 ${mb(d.settledFreedMB)}）`);
  out.push(`  工作集    : ${mb(d.beforeMB)} → ${mb(d.settledMB)}`);
  out.push(`  优先级    : ${d.priority}（设置成功 ${d.prioritySet} 个，EcoQoS ${d.ecoSet} 个）`);
  if (d.suspended && d.suspended.length) {
    out.push(`  已挂起    : ${d.suspended.join(', ')}`);
    out.push(`  恢复方式  : node cli/tuner.js restore / 托盘菜单「恢复全部」`);
    if (d.autoResume > 0) out.push(`  定时恢复  : ${d.autoResume} 分钟后自动恢复`);
  } else if (d.mode === 'suspend') {
    out.push('  已挂起    : 无可挂起目标（后台进程可能已全部挂起或被保护）');
  }
  console.log(out.join('\n'));
}

function printTrim(d) {
  console.log(
    [
      `已回收工作集（${d.scope === 'background' ? '仅后台进程' : '全部进程'}）`,
      `  目标      : ${d.trimmed}/${d.targets}`,
      `  工作集    : ${mb(d.beforeMB)} → 立即 ${mb(d.afterMB)} → 稳定 ${mb(d.settledMB)}`,
      `  实际节省  : ${mb(d.settledFreedMB)}`,
    ].join('\n')
  );
}

function printRestore(d) {
  console.log(
    [
      '已恢复空闲降温',
      `  恢复进程  : ${d.resumed && d.resumed.length ? d.resumed.join(', ') : '无需恢复'}`,
      `  失败      : ${d.failed && d.failed.length ? d.failed.join(', ') : '无'}`,
      `  当前工作集: ${mb(d.totalMB)}`,
    ].join('\n')
  );
}

function detectTray() {
  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*tray.ps1*' } | Select-Object -First 1 -ExpandProperty ProcessId",
    ],
    { encoding: 'utf8', windowsHide: true }
  );
  const pid = (res.stdout || '').trim();
  return pid || null;
}

function launchTray(quiet) {
  if (!fs.existsSync(TRAY)) throw new Error(`找不到托盘程序: ${TRAY}`);
  const running = detectTray();
  if (running) {
    if (!quiet) console.log(`托盘已在运行（PID ${running}），无需重复启动。`);
    return false;
  }
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', TRAY],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();
  if (!quiet) console.log('托盘已启动（任务栏通知区域）。右键图标即可一键降温 / 恢复。');
  return true;
}

/**
 * Called by the SessionStart hook so the plugin rides along with AIWorkKit.
 * config.trayOnStart  (default true)  -> tray icon appears with every session
 * config.windowOnStart (default false) -> also pop the standalone window
 */
async function autostart() {
  const cfg = readConfig();
  const wantTray = cfg.trayOnStart !== false;
  const wantWindow = cfg.windowOnStart === true;
  let tray = false;
  let window = '';

  if (wantTray) {
    try {
      tray = launchTray(true);
    } catch {
      tray = false;
    }
  }
  if (wantWindow) {
    try {
      window = await openDashboard(true);
    } catch {
      window = 'failed';
    }
  }
  console.log(JSON.stringify({ ok: true, tray, window }));
}

function usage() {
  console.log(
    [
      'AIWorkKit Idle Tuner',
      '',
      '  node cli/tuner.js status                 查看当前占用',
      '  node cli/tuner.js trim [--scope all|background]',
      '                                          只回收工作集',
      '  node cli/tuner.js apply --mode lite|deep|suspend [--level background|aggressive] [--auto-resume MIN]',
      '  node cli/tuner.js quiet                  等价 apply --mode lite',
      '  node cli/tuner.js restore                恢复优先级 / 唤醒挂起进程',
      '  node cli/tuner.js auto on|off [--mode lite|deep]',
      '  node cli/tuner.js tray                   启动任务栏托盘',
      '  node cli/tuner.js open                   打开独立窗口（Chromium app 模式）',
      '  node cli/tuner.js autostart              随 AIWorkKit 启动托盘/窗口（SessionStart 调用）',
      '  node cli/tuner.js serve                  前台运行本地服务（调试用）',
    ].join('\n')
  );
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

async function main() {
  const argv = process.argv.slice(2);
  const action = (argv.shift() || 'status').toLowerCase();
  const flags = parseFlags(argv);

  try {
    switch (action) {
      case 'status':
      case 'st': {
        printStatus(runCore(['-Action', 'status']));
        break;
      }
      case 'trim': {
        printTrim(runCore(['-Action', 'trim', '-Scope', flags.scope || 'all']));
        break;
      }
      case 'apply':
      case 'quiet':
      case 'suspend': {
        const mode = action === 'suspend' ? 'suspend' : flags.mode || (action === 'quiet' ? 'lite' : 'lite');
        const args = ['-Action', 'apply', '-Mode', mode];
        if (flags.level) args.push('-Level', flags.level);
        if (flags['auto-resume']) args.push('-AutoResume', String(flags['auto-resume']));
        printApply(runCore(args, 60000));
        break;
      }
      case 'restore':
      case 'resume': {
        printRestore(runCore(['-Action', 'restore'], 60000));
        break;
      }
      case 'auto': {
        const on = String(flags.on || argv[0] || '').toLowerCase();
        const explicit = ['on', 'off', '1', '0', 'true', 'false'].includes(on);
        const args = ['-Action', 'auto'];
        if (explicit) args.push('-Enabled', ['on', '1', 'true'].includes(on) ? '1' : '0');
        if (flags.mode) args.push('-Mode', flags.mode);
        const d = runCore(args);
        console.log(`自动空闲降温：${d.autoMode ? `已开启（${d.level}）` : '已关闭'}`);
        break;
      }
      case 'idle-watch': {
        // Delayed auto apply: wait, then re-check whether the user really is idle.
        const seconds = Math.max(1, Number(flags.seconds || 120));
        const mode = flags.mode === 'deep' ? 'deep' : 'lite';
        // Failsafe keeps the event loop alive even if the main timer is cleared.
        setTimeout(() => process.exit(0), (seconds + 180) * 1000);
        setTimeout(() => {
          try {
            const st = readState();
            if (st.busy) {
              console.log(`仍有任务在进行，跳过自动降温（${seconds}s 后复检）`);
              return;
            }
            const last = st.lastApplyAt ? Date.parse(st.lastApplyAt) : 0;
            if (Number.isFinite(last) && Date.now() - last < 120000) {
              console.log('刚刚降过温，跳过本次自动降温');
              return;
            }
            printApply(runCore(['-Action', 'apply', '-Mode', mode], 60000));
          } catch (err) {
            console.error(`自动降温失败: ${err.message}`);
          }
        }, seconds * 1000);
        break;
      }
      case 'tray': {
        launchTray(false);
        break;
      }
      case 'open':
      case 'window':
      case 'dashboard': {
        await openDashboard(false);
        break;
      }
      case 'autostart': {
        await autostart();
        break;
      }
      case 'serve': {
        const child = spawn(process.execPath, [SERVER, '--port', String(serverPort())], { stdio: 'inherit', cwd: ROOT });
        await new Promise((resolve) => child.on('exit', resolve));
        break;
      }
      case 'config': {
        console.log(JSON.stringify(runCore(['-Action', 'config']), null, 2));
        break;
      }
      case 'help':
      case '--help':
      case '-h': {
        usage();
        break;
      }
      default: {
        usage();
        process.exitCode = 2;
      }
    }
  } catch (err) {
    console.error(`执行失败: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
