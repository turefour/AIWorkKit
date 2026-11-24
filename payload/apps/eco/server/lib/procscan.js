'use strict';

/**
 * AIWorkKit Eco - process sampler.
 *
 * Windows: one Win32_Process CIM probe filtered by an allow-list of runtimes.
 * POSIX  : `ps` with a portable column set.
 * CPU percent is derived from kernel+user tick deltas between two samples.
 */

const { spawn } = require('child_process');
const os = require('os');

const { resolveProject } = require('./projects');

const ALLOW =
  'node|nodejs|python|pythonw|py|pwsh|powershell|cmd|bash|sh|deno|bun|dotnet|java|javaw|ffmpeg|tsc|esbuild|vite|webpack|rollup|go|cargo|rustc|git|aiworkkit' +
  // document / pdf / image toolchains, so conversion jobs are never invisible
  '|soffice|soffice.bin|qpdf|pdftotext|pdftoppm|pdfinfo|pdfimages|mutool|tesseract|magick|convert|gswin64c|gswin32c|acrord32|winword|excel|powerpnt|wps';

// Only interpreters running a script file are announced as flows; inline
// `-e` / `-c` invocations and long-lived MCP helpers would just be noise.
const SCRIPT_HOST_RE = /^(node|nodejs|python|pythonw|py|pwsh|dotnet|java|javaw|ruby|lua|php|deno|bun)$/i;
const SCRIPT_FILE_RE = /\.(js|mjs|cjs|ts|py|ps1|sh|rb|lua|php|go|java|jar)\b/i;

function isScriptProcess(name, command) {
  if (!SCRIPT_HOST_RE.test(String(name || ''))) return false;
  return SCRIPT_FILE_RE.test(String(command || ''));
}

const AGENT_RE = /^(aiworkkit)/i;
const BUILD_RE = /^(tsc|esbuild|vite|webpack|rollup|webpack|go|cargo|rustc|dotnet|java)/i;

// WMI 层先按进程名过滤。
// 不这么做的话，会先把全部 268 个进程（含最贵的 CommandLine 字段）拉进 PowerShell，
// 再用 Where-Object 丢掉 95%，每 3.5 秒白白烧掉约 0.9 秒 CPU。
function winFilter() {
  const names = ALLOW.split('|')
    .map((n) => n.trim())
    .filter(Boolean);
  return names
    .map((n) => "Name='" + (n.indexOf('.') >= 0 ? n : n + '.exe') + "'")
    .join(' OR ');
}

function windowsScript() {
  return (
    "$ErrorActionPreference='SilentlyContinue';" +
    '$rows = Get-CimInstance Win32_Process -Filter "' +
    winFilter() +
    '" | Select-Object ProcessId,ParentProcessId,Name,UserModeTime,KernelModeTime,WorkingSetSize,CommandLine,CreationDate;' +
    'if ($rows -eq $null) { "[]" } else { ConvertTo-Json -InputObject @($rows) -Compress }'
  );
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* already gone */
      }
    }, timeoutMs || 8000);
    child.stdout.on('data', (d) => {
      if (out.length < 4 * 1024 * 1024) out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (err.length < 4096) err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ ok: true, stdout: out, stderr: err });
    });
  });
}

/** CIM returns CreationDate either as "\/Date(1698...)\/" or as ISO text. */
function parseCimDate(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const text = String(value);
  const wrapped = /\/Date\((-?\d+)\)\//.exec(text);
  if (wrapped) return Number(wrapped[1]);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roleOf(name) {
  if (AGENT_RE.test(name)) return 'agent';
  if (BUILD_RE.test(name)) return 'build';
  return 'script';
}

class ProcessScanner {
  constructor(options) {
    const opts = options || {};
    // 每次采样都要 spawn 一个 PowerShell 做 WMI 查询，冷启动 + 查询实测约 1.2s CPU。
    // 3.5s 间隔 = 33% 单核常驻；6s 降到 19%，看板刷新慢 2.5 秒但肉眼无感。
    this.intervalMs = opts.intervalMs || 6000;
    this.logger = opts.logger || null;
    this.cwd = opts.cwd || process.cwd();
    this.projectCache = new Map();
    this.selfPid = process.pid;
    this.timer = null;
    this.busy = false;
    this.prev = new Map();
    this.firstSeen = new Map();
    this.known = new Map();
    this.primed = false;
    this.processes = [];
    this.lastError = '';
    this.onSample = opts.onSample || (() => {});
    this.onSpawn = opts.onSpawn || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.cpuCount = os.cpus().length || 1;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = process.platform === 'win32' ? await this.readWindows() : await this.readPosix();
      this.apply(rows);
      this.onSample(this.processes);
    } catch (e) {
      this.lastError = e.message;
      if (this.logger) this.logger.error('procscan', 'process sampling failed', e);
    } finally {
      this.busy = false;
    }
  }

  async readWindows() {
    const res = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsScript()],
      Math.max(6000, this.intervalMs * 3)
    );
    if (!res.ok) throw new Error(res.error || 'powershell failed');
    const text = (res.stdout || '').trim();
    if (!text) return [];
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return [];
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const now = Date.now();
    return list.map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      name: String(p.Name || '').replace(/\.exe$/i, ''),
      cpuTicks: (Number(p.UserModeTime) || 0) + (Number(p.KernelModeTime) || 0),
      memBytes: Number(p.WorkingSetSize) || 0,
      command: String(p.CommandLine || '').slice(0, 400),
      createdMs: parseCimDate(p.CreationDate),
      seenAt: now
    }));
  }

  async readPosix() {
    const res = await run('ps', ['-eo', 'pid=,ppid=,pcpu=,rss=,comm=,args='], 6000);
    if (!res.ok) throw new Error(res.error || 'ps failed');
    const now = Date.now();
    const rows = [];
    for (const line of String(res.stdout || '').split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (!m) continue;
      const name = m[5].split('/').pop().replace(/\.exe$/i, '');
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        name,
        cpuTicks: null,
        cpuPercentHint: Number(m[3]),
        memBytes: Number(m[4]) * 1024,
        command: (m[6] || '').slice(0, 400),
        seenAt: now
      });
    }
    return rows;
  }

  apply(rows) {
    const now = Date.now();
    const prev = this.prev;
    const next = new Map();
    const firstSeen = this.firstSeen;
    const out = [];

    for (const row of rows) {
      if (!row || !row.pid) continue;
      if (row.pid === this.selfPid) continue;
      if (row.ppid === this.selfPid && /Win32_Process|Get-CimInstance|Get-Process|ConvertTo-Json/i.test(row.command || '')) {
        continue;
      }
      // Skip our own hook shims: they are one-shot and only add noise.
      if (/eco-hook\.js/.test(row.command || '')) continue;

      const before = prev.get(row.pid);
      let cpuPercent = null;
      if (row.cpuTicks != null && before && before.cpuTicks != null) {
        const dTicks = row.cpuTicks - before.cpuTicks;
        const dMs = now - before.seenAt;
        if (dMs > 0) cpuPercent = (dTicks / 10000 / dMs) * 100;
      } else if (row.cpuPercentHint != null) {
        cpuPercent = row.cpuPercentHint;
      }
      if (cpuPercent != null) cpuPercent = Math.round(Math.min(cpuPercent, 999) * 10) / 10;

      if (!firstSeen.has(row.pid)) firstSeen.set(row.pid, now);
      const alive = firstSeen.get(row.pid);
      const project = this.projectFor(row.command);
      const startedMs = row.createdMs || alive;
      this.noteSpawn(row, project);

      out.push({
        pid: row.pid,
        ppid: row.ppid,
        name: row.name,
        role: roleOf(row.name),
        project,
        cpuPercent,
        memMB: Math.round((row.memBytes / (1024 * 1024)) * 10) / 10,
        command: row.command,
        uptimeMs: now - startedMs
      });
      next.set(row.pid, { cpuTicks: row.cpuTicks, seenAt: now });
    }

    // Drop bookkeeping for dead pids.
    for (const pid of Array.from(firstSeen.keys())) {
      if (!next.has(pid)) firstSeen.delete(pid);
    }
    this.prev = next;
    this.noteExits(next);
    this.processes = out.sort((a, b) => (b.cpuPercent || 0) - (a.cpuPercent || 0)).slice(0, 60);
  }

  /** Project attribution with a short-lived cache keyed by command line. */
  projectFor(command) {
    const key = String(command || '').slice(0, 300);
    if (!key) return { name: '', path: '' };
    const hit = this.projectCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.value;
    const value = resolveProject(key, '');
    this.projectCache.set(key, { value, at: Date.now() });
    if (this.projectCache.size > 300) {
      const oldest = this.projectCache.keys().next().value;
      this.projectCache.delete(oldest);
    }
    return value;
  }

  /** Remember a live pid and announce newly seen script hosts. */
  noteSpawn(row, project) {
    const existing = this.known.get(row.pid);
    const flow = isScriptProcess(row.name, row.command);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.command = row.command;
      existing.project = project;
      existing.scriptFlow = flow;
      return;
    }
    this.known.set(row.pid, {
      pid: row.pid,
      name: row.name,
      command: row.command,
      project,
      firstSeen: row.createdMs || this.firstSeen.get(row.pid) || Date.now(),
      lastSeen: Date.now(),
      scriptFlow: flow
    });
    // The first sample only primes the baseline; nothing has "started" yet.
    if (this.primed && flow) {
      try {
        this.onSpawn({ pid: row.pid, name: row.name, command: row.command, project });
      } catch (_) {
        /* listeners must not break sampling */
      }
    }
  }

  /** Report script hosts that vanished between two samples. */
  noteExits(next) {
    for (const [pid, info] of Array.from(this.known.entries())) {
      if (next.has(pid)) continue;
      this.known.delete(pid);
      if (this.primed && info.scriptFlow) {
        const span = info.lastSeen - info.firstSeen;
        try {
          // A process caught only in its final sample has no measurable lifetime.
          this.onExit({ ...info, durationMs: span >= 1000 ? span : null });
        } catch (_) {
          /* ignore listener failures */
        }
      }
    }
    this.primed = true;
  }

  summary() {
    const scripts = this.processes.filter((p) => p.role === 'script');
    const agents = this.processes.filter((p) => p.role === 'agent');
    const totalCpu = this.processes.reduce((acc, p) => acc + (p.cpuPercent || 0), 0);
    const totalMem = this.processes.reduce((acc, p) => acc + (p.memMB || 0), 0);
    return {
      scripts: scripts.length,
      agents: agents.length,
      cpuPercent: Math.round(Math.min(totalCpu, 100 * this.cpuCount) * 10) / 10,
      memMB: Math.round(totalMem),
      error: this.lastError
    };
  }
}

module.exports = { ProcessScanner, windowsScript, run, isScriptProcess };
