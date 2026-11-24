/**
 * 系统资源与全量进程（零依赖）。
 *
 * 与 procscan.js 的区别：
 *   procscan 只盯「脚本类运行时」（node/python/java…），服务于重复测试进程守护；
 *   这里要看整机 —— 谁在吃 CPU、谁占内存、某个进程归哪个工具。
 *
 * 采样方式沿用通用做法：**两次采样求差**。
 *   - CPU 占用率：拿 os.cpus() 的累计时间做差（任务管理器、psutil、
 *     bottom 都是这个原理，直接读瞬时值是算不出来的）
 *   - 每个进程的 CPU：Get-Process 的 CPU 是「累计秒数」，两次之差 / 墙钟时间
 *   单进程数值按「单核口径」展示（与 psutil 默认一致，多线程可超过 100%），
 *   整机数值按「全核平均」展示。
 */
const os = require('os');
const { execFile } = require('child_process');

/* ------------------------------------------------------------------ CPU / 内存 */

let lastCpuSample = null;

function cpuSnapshot() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, cores: cpus.length || 1 };
}

/** 整机 CPU / 内存占用。第一次调用时 CPU 为 null（没有前一次采样可比较） */
function systemUsage() {
  const now = cpuSnapshot();
  let usagePercent = null;
  if (lastCpuSample) {
    const dIdle = now.idle - lastCpuSample.idle;
    const dTotal = now.total - lastCpuSample.total;
    if (dTotal > 0) usagePercent = round1((1 - dIdle / dTotal) * 100);
  }
  lastCpuSample = now;

  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;

  return {
    platform: process.platform,
    cpu: {
      usagePercent,
      cores: now.cores,
      loadavg: (os.loadavg() || []).map((n) => round1(n))
    },
    memory: {
      totalMB: Math.round(totalBytes / 1048576),
      usedMB: Math.round(usedBytes / 1048576),
      usedPercent: round1((usedBytes / totalBytes) * 100)
    },
    uptimeSec: Math.round(os.uptime()),
    hostname: os.hostname()
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------------ 进程归属 */

/**
 * 进程名 -> 归属描述。
 *
 * 用 \b 而不是 $：真实进程名常带后缀（"CodeBuddy CN"、"Code - Insiders"、
 * "Weixin"、"node"），要求全名相等会全部落到「其他」。
 * 命中不了就老实标「其他」，不猜。
 */
const OWNER_RULES = [
  [/^(codebuddy|code - insiders|code|cursor|windsurf|trae|zed)\b/, 'AI 编辑器'],
  [/^(idea64|pycharm64|webstorm|goland|clion|rider64|studio64|jetbrains)\b/, 'JetBrains IDE'],
  [/^(devenv|msbuild|vbcscompiler)\b/, 'Visual Studio'],
  [/^(sublime_text|notepad\+\+|notepad)\b/, '文本编辑器'],
  [/^(msedge|chrome|firefox|liebao|brave|opera|360se|360chrome|chromium)\b/, '浏览器'],
  [/^(node|nodejs|deno|bun)\b/, 'Node 运行时'],
  [/^(python|pythonw|py)\b/, 'Python 运行时'],
  [/^(java|javaw|dotnet)\b/, '托管运行时'],
  [/^(pwsh|powershell|cmd|conhost|windowsterminal|wt)\b/, '命令行'],
  [/^(git|git-remote-https|ssh)\b/, 'Git'],
  [/^(docker|dockerd|com\.docker\.backend|wsl|vmmem|vmmemwsl)\b/, '容器 / WSL'],
  [/^(excel|winword|powerpnt|wps|et|wpp)\b/, 'Office'],
  [/^(weixin|wechat|qq|dingtalk|feishu|telegram|slack)\b/, '通讯'],
  [/^(msedgewebview2|webviewhost)\b/, '内嵌浏览器'],
  [/^(explorer)\b/, '系统外壳'],
  [/^(svchost|lsass|csrss|wininit|winlogon|services|smss|dwm|fontdrvhost|system)\b/, '系统']
];

function ownerOf(name) {
  const n = String(name || '').toLowerCase();
  for (const [re, label] of OWNER_RULES) {
    if (re.test(n)) return label;
  }
  return '其他';
}

/**
 * 受保护进程：不允许从这个面板直接结束。
 * 名单按 Windows 的关键系统进程 + 我们自己来定，宁可少杀不可错杀。
 */
const PROTECTED_NAMES = new Set([
  'system', 'system idle process', 'registry', 'memory compression',
  'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsm',
  'svchost', 'dwm', 'fontdrvhost', 'sihost', 'ctfmon', 'taskhostw',
  'explorer', 'audiodg', 'spoolsv', 'searchindexer', 'securityhealthservice'
]);

function isProtected(proc, selfPid) {
  if (!proc) return { protected: true, reason: '进程不存在' };
  if (proc.pid === selfPid) return { protected: true, reason: '本服务自身' };
  if (proc.pid <= 4) return { protected: true, reason: '系统内核进程' };
  if (PROTECTED_NAMES.has(String(proc.name || '').toLowerCase())) {
    return { protected: true, reason: '系统关键进程' };
  }
  return { protected: false, reason: '' };
}

/* ------------------------------------------------------------------ 进程列表 */

let lastProcSample = { at: 0, cpu: new Map() };

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
    execFile('powershell.exe', args, { timeout: timeoutMs || 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message });
        resolve({ ok: true, out: String(stdout || '') });
      });
  });
}

/*
 * 字段只取必要的四个：
 * MainWindowTitle 要逐个窗口去查，实测比其它字段贵得多，而面板并不需要窗口标题。
 * 采样一次约 3 秒（PowerShell 启动 0.4s + 280 个进程的 WMI/CIM 取值），
 * 所以下面再加一层短缓存，避免连续刷新时把机器压住。
 */
const PS_LIST = [
  'Get-Process -ErrorAction SilentlyContinue |',
  'Where-Object { $_.Id -gt 0 } |',
  'Select-Object Id,ProcessName,CPU,WorkingSet64 |',
  'ConvertTo-Json -Compress'
].join(' ');

const CACHE_TTL_MS = 2500;
let cache = { at: 0, payload: null };

/**
 * 取进程列表。
 * 返回的 cpuPercent 是「本次采样 - 上次采样」的差值，因此第一次调用为 null，
 * 前端稍后刷新一次就正常了（面板本来就是定时刷新）。
 */
async function listProcesses(options = {}) {
  const selfPid = options.selfPid || process.pid;

  // 短缓存：面板刷新、多个页签同时打开时都只真正采样一次
  if (cache.payload && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ...cache.payload, cached: true };
  }

  const started = Date.now();
  const res = await runPowerShell(PS_LIST);
  if (!res.ok) return { ok: false, error: res.error };

  let rows = [];
  try {
    const parsed = JSON.parse(res.out || '[]');
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return { ok: false, error: '解析失败: ' + e.message };
  }

  const now = Date.now();
  const prev = lastProcSample;
  const wall = prev.at ? (now - prev.at) / 1000 : 0; // 秒
  const nextCpu = new Map();

  const procs = rows.map((r) => {
    const pid = Number(r.Id) || 0;
    const name = String(r.ProcessName || '');
    const cpuSec = typeof r.CPU === 'number' ? r.CPU : null;
    const memMB = Math.round((Number(r.WorkingSet64) || 0) / 1048576);

    if (cpuSec != null) nextCpu.set(pid, cpuSec);

    let cpuPercent = null;
    if (cpuSec != null && wall > 0 && prev.cpu.has(pid)) {
      const delta = cpuSec - prev.cpu.get(pid);
      if (delta >= 0) cpuPercent = round1((delta / wall) * 100);
    }

    const guard = isProtected({ pid, name }, selfPid);

    return {
      pid,
      name,
      cpuPercent,
      memMB,
      owner: ownerOf(name),
      protected: guard.protected,
      protectedReason: guard.reason
    };
  });

  lastProcSample = { at: now, cpu: nextCpu };

  const sorted = procs
    .filter((p) => p.pid > 4)
    .sort((a, b) => (b.cpuPercent || 0) - (a.cpuPercent || 0) || b.memMB - a.memMB)
    .slice(0, options.limit || 40);

  const payload = {
    ok: true,
    at: new Date(now).toISOString(),
    tookMs: now - started,
    total: procs.length,
    procs: sorted,
    // 首次采样时把「差值还没建立」说清楚，免得界面显示一排空值让人误会
    note: wall === 0 ? '首次采样，CPU 百分比需要下一次刷新才有值' : ''
  };
  cache = { at: Date.now(), payload };
  return payload;
}

/* ------------------------------------------------------------------ 结束进程 */

/** 结束进程：先确认身份，再拒绝受保护进程 */
function killProcess(pid, options = {}) {
  const selfPid = options.selfPid || process.pid;
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'pid 不合法' };

  let alive = true;
  try {
    process.kill(id, 0); // 只探测，不发信号
  } catch (e) {
    alive = e.code === 'EPERM';
  }
  if (!alive) return { ok: false, error: '进程不存在或已退出' };

  const guard = isProtected({ pid: id, name: String(options.name || '') }, selfPid);
  if (guard.protected) return { ok: false, error: '拒绝结束：' + guard.reason };

  try {
    process.kill(id); // Windows 上等价于 TerminateProcess
    return { ok: true, pid: id, killedAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: '取消失败：' + e.message };
  }
}

module.exports = { systemUsage, listProcesses, killProcess, ownerOf, isProtected };
