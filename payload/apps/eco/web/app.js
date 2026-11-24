'use strict';

/**
 * AIWorkKit Eco - networking and shell.
 *
 * Rendering lives in render.js (incremental, node-reusing). This file only owns
 * the SSE stream, the incremental event console, the connection indicator and
 * the top-level controls.
 */

/* ---------------- event console (append only) ---------------- */

function appendLogs(entries) {
  if (!entries.length) return;
  const box = $('logs');
  const frag = document.createDocumentFragment();
  let added = 0;
  for (const e of entries) {
    ui.logSeq = Math.max(ui.logSeq, e.seq);
    if (ui.filter === 'error' && e.level !== 'error') continue;
    if (ui.filter === 'warn' && e.level !== 'error' && e.level !== 'warn') continue;
    const phase = e.phase || (e.level === 'error' ? 'error' : 'info');
    const row = document.createElement('div');
    row.className = 'log-row ' + e.level + ' phase-' + phase;
    row.innerHTML =
      `<span class="seq">${e.seq}</span>` +
      `<span class="ts">${esc(e.time.slice(11))}</span>` +
      `<span class="ph ph-${phase}">${PHASE_TEXT[phase] || PHASE_TEXT.info}</span>` +
      `<span class="scene">${esc(e.scene)}</span>` +
      `<span class="msg">${esc(e.message)}` +
      (e.target ? `<span class="tgt" title="${esc(e.target)}">${esc(e.target)}</span>` : '') +
      (e.level === 'warn' ? '<span class="lvltag warn">WARN</span>' : '') +
      '</span>' +
      `<span class="dur">${e.durationMs != null ? fmtDuration(e.durationMs) : ''}</span>`;
    if (e.meta && e.meta.detail) row.title = String(e.meta.detail).slice(0, 800);
    frag.appendChild(row);
    added += 1;
  }
  if (!added) return;
  box.appendChild(frag);
  ui.logRows += added;
  while (box.childElementCount > MAX_LOG_ROWS) box.removeChild(box.firstElementChild);
  if ($('autoScroll').checked) box.scrollTop = box.scrollHeight;
  $('logSeq').textContent = 'seq ' + ui.logSeq;
}

async function pollLogs() {
  try {
    const res = await fetch('/api/logs/live?since=' + ui.logSeq, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    appendLogs(data.entries || []);
  } catch (_) {
    /* offline: the SSE watchdog handles reconnection */
  }
}

/* ---------------- state plumbing ---------------- */

/**
 * Desktop notification for duplicate-process alerts.
 *
 * The tray shell can only colour its icon reliably: a popup window it draws
 * itself gets covered by the embedded Edge window (a separate HWND), and
 * NotifyIcon balloons are dropped by Windows when no AppUserModelID is
 * registered. The page itself can use the Notification API, which lands in the
 * real Windows notification centre — so the browser side owns the popup and the
 * shell owns the tray icon.
 */
let _lastNotifiedAlertAt = 0;

function notifyGuard(guard) {
  if (!guard || !Array.isArray(guard.alerts) || !guard.alerts.length) return;
  const latest = guard.alerts[0]; // server returns newest first
  if (!latest || (latest.level !== 'warn' && latest.level !== 'lock')) return;
  if (!latest.at || latest.at <= _lastNotifiedAlertAt) return;
  _lastNotifiedAlertAt = latest.at;
  if (typeof Notification === 'undefined') return;

  const title = latest.level === 'lock' ? '重复进程已锁死并清理' : '检测到重复测试进程';
  const group = String(latest.key || '').split('|').pop() || '未知分组';
  const body = group + ' · ' + latest.count + ' 个' +
    (latest.level === 'lock' ? '，已保留最早一个' : '，继续增加会自动锁死');

  const fire = () => {
    try {
      const note = new Notification(title, { body, tag: 'eco-guard', renotify: true });
      note.onclick = () => {
        window.focus();
        note.close();
      };
    } catch (_) {
      /* permission revoked mid-flight: the banner still shows */
    }
  };

  if (Notification.permission === 'granted') fire();
  else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') fire();
    }).catch(() => {});
  }
}

function applyState(state) {
  ui.snap = state;
  ui.lastStateAt = Date.now();
  renderKpis(state);
  renderSources(state);
  renderJobs(state);
  notifyGuard(state.guard);
  renderGuard(state);
  renderProcs(state);
  renderPlugins(state);
  $('serverInfo').textContent =
    ':' + state.server.port + ' · pid ' + state.server.pid + ' · up ' + fmtDuration(state.server.uptimeMs);
  $('footState').textContent = 'v' + state.version + ' · 最近更新 ' + fmtClock(state.now);
  setConn('live');
}

/**
 * 轻量帧：只有随时间变化的字段（已用时间 / 速率 / ETA / 卡住标记）。
 *
 * 服务端每秒推这个，完整 state 只在真正变更时推 —— 否则每秒要把 133 KB
 * 序列化 + 传输一遍。这里只就地改值，不重建对象；万一漏了字段，
 * 下一次全量 state 会整体纠正，所以失败也不会有残留错值。
 */
function applyTick(tick) {
  const snap = ui.snap;
  if (!snap || !snap.server || !tick) return;

  snap.now = tick.now;
  snap.server.uptimeMs = tick.uptimeMs;

  const patchById = new Map();
  for (const patch of tick.jobs || []) patchById.set(patch.id, patch);
  for (const job of snap.jobs || []) {
    const patch = patchById.get(job.id);
    if (!patch) continue;
    job.status = patch.status;
    job.current = patch.current;
    job.percent = patch.percent;
    job.elapsedMs = patch.elapsedMs;
    job.rate = patch.rate;
    job.etaMs = patch.etaMs;
    job.stalled = patch.stalled;
    job.staleRunning = patch.staleRunning;
  }

  for (const key of Object.keys(snap.sources || {})) {
    if (tick.sources && typeof tick.sources[key] !== 'undefined') {
      snap.sources[key].alive = tick.sources[key];
    }
  }

  renderJobs(snap);
  renderSources(snap);
  $('serverInfo').textContent =
    ':' + snap.server.port + ' · pid ' + snap.server.pid + ' · up ' + fmtDuration(snap.server.uptimeMs);
  $('footState').textContent = 'v' + snap.version + ' · 最近更新 ' + fmtClock(snap.now);
}

async function refreshSnapshot() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (res.ok) applyState(await res.json());
  } catch (_) {
    /* the next SSE tick will catch up */
  }
}

function setConn(kind) {
  const el = $('conn');
  if (kind === 'live') {
    el.className = 'chip chip-live';
    el.textContent = '● 实时连接';
  } else if (kind === 'down') {
    el.className = 'chip chip-down';
    el.textContent = '● 已断开 · 重连中';
  } else {
    el.className = 'chip chip-warn';
    el.textContent = '● 连接中…';
  }
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => setConn('live'));
  es.addEventListener('state', (event) => {
    try {
      applyState(JSON.parse(event.data));
    } catch (_) {
      /* malformed frame */
    }
  });
  es.addEventListener('tick', (event) => {
    try {
      applyTick(JSON.parse(event.data));
    } catch (_) {
      /* 下一帧全量 state 会纠正 */
    }
  });
  es.addEventListener('error', () => setConn('down'));
}

/* ---------------- controls ---------------- */

function bindControls() {
  $('btnCompact').addEventListener('click', () => {
    ui.compact = !ui.compact;
    document.body.classList.toggle('compact', ui.compact);
    $('btnCompact').textContent = ui.compact ? '标准视图' : '紧凑视图';
  });

  $('btnClear').addEventListener('click', async () => {
    try {
      await fetch('/api/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      await refreshSnapshot();
    } catch (_) {
      /* ignore */
    }
  });

  $('logLevel').addEventListener('change', (event) => {
    ui.filter = event.target.value;
    $('logs').innerHTML = '';
    ui.logRows = 0;
    ui.logSeq = 0;
    pollLogs();
  });
}

/** Surface client-side failures in the daemon log instead of only DevTools. */
function reportClientError(payload) {
  try {
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(payload)
    });
  } catch (_) {
    /* reporting must never throw */
  }
}

function watchClientErrors() {
  window.addEventListener('error', (event) => {
    reportClientError({
      message: event.message || 'window error',
      source: (event.filename || '') + ':' + (event.lineno || 0) + ':' + (event.colno || 0),
      stack: event.error && event.error.stack
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason || {};
    reportClientError({
      message: 'unhandled rejection: ' + (reason.message || String(reason)),
      source: 'promise',
      stack: reason.stack
    });
  });
}

function boot() {
  watchClientErrors();
  injectGradient();
  bindControls();
  bindIntervention();
  connect();
  pollLogs();
  setInterval(pollLogs, 1200);

  // Keep every expanded flow log tailing while it is open.
  setInterval(() => {
    for (const id of ui.expanded) refreshLog(id);
  }, 1800);

  // Watchdog: if the SSE stream stalls, fall back to plain polling.
  setInterval(async () => {
    if (Date.now() - ui.lastStateAt < 6000) return;
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (res.ok) applyState(await res.json());
    } catch (_) {
      setConn('down');
    }
  }, 3000);
}

function injectGradient() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML =
    '<defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#35e6c4"/><stop offset="100%" stop-color="#6aa8ff"/>' +
    '</linearGradient></defs>';
  document.body.appendChild(svg);
}

/* ============================================================
 * 页签：看板 / 进程与资源
 *
 * 两个面板互不影响：看板继续走原来的 SSE，进程页按需轮询。
 * 切到进程页才开始拉数据，切走就停 —— 免得后台一直 spawn PowerShell。
 * ============================================================ */

// 采样一次真实耗时约 3 秒（PowerShell 起进程 + 遍历 280 个进程），
// 服务端有 2.5 秒缓存，这里 5 秒一轮，既不重叠也不会明显滞后。
const PROC_POLL_MS = 5000;

const procState = {
  timer: null,
  busy: false,
  sort: 'cpu',
  rows: []
};

function switchPane(name) {
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.pane === name);
  });
  document.querySelectorAll('.tab-pane').forEach((p) => {
    p.classList.toggle('on', p.dataset.paneBody === name);
  });

  if (name === 'proc') {
    startProcPolling();
  } else {
    stopProcPolling();
  }
}

function startProcPolling() {
  if (procState.timer) return;
  refreshProcPane();
  procState.timer = setInterval(refreshProcPane, PROC_POLL_MS);
}

function stopProcPolling() {
  if (procState.timer) {
    clearInterval(procState.timer);
    procState.timer = null;
  }
}

function fmtNum(n, digits) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toFixed(digits == null ? 1 : digits);
}

function setBar(el, percent) {
  if (!el) return;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  el.style.width = p + '%';
  // 高负载变色：60% 起提醒，85% 起告警
  el.className = p >= 85 ? 'bar-danger' : p >= 60 ? 'bar-warn' : '';
}

async function refreshProcPane() {
  if (procState.busy) return;
  procState.busy = true;
  try {
    const [sys, procs, hist] = await Promise.all([
      fetch('/api/system', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch('/api/procs?limit=40', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch('/api/procs/history', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    ]);

    if (hist && hist.ok) renderTrend(hist);


    if (sys && sys.ok) {
      const cpu = sys.cpu || {};
      const mem = sys.memory || {};
      const cpuEl = $('cpuVal');
      const memEl = $('memVal');
      if (cpuEl) cpuEl.textContent = cpu.usagePercent == null ? '采样中' : fmtNum(cpu.usagePercent) + '%';
      if (memEl) memEl.textContent = fmtNum(mem.usedPercent) + '%';
      setBar($('cpuBar'), cpu.usagePercent);
      setBar($('memBar'), mem.usedPercent);
      const cpuSub = $('cpuSub');
      if (cpuSub) cpuSub.textContent = (cpu.cores || 0) + ' 核 · 负载 ' + ((cpu.loadavg || []).join(' / ') || '—');
      const memSub = $('memSub');
      if (memSub) memSub.textContent = (mem.usedMB || 0) + ' / ' + (mem.totalMB || 0) + ' MB';
    }

    if (procs && procs.ok) {
      procState.rows = procs.procs || [];
      const total = $('procTotal');
      if (total) total.textContent = procState.rows.length + ' / ' + (procs.total || 0) + ' 个进程';
      const meta = $('procMeta');
      if (meta) {
        meta.textContent =
          '采样 ' + (procs.tookMs || 0) + ' ms' +
          (procs.cached ? '（缓存）' : '') +
          ' · ' + (procs.at || '').slice(11, 19);
      }
      const note = $('procNote');
      if (note) note.textContent = procs.note || '';

      renderGroups(procs.groups || []);
      renderProcTable();
    } else if (procs) {
      const note = $('procNote');
      if (note) note.textContent = '读取失败：' + (procs.error || '未知错误');
    }
  } finally {
    procState.busy = false;
  }
}

function renderProcTable() {
  const box = $('procTable');
  if (!box) return;

  const rows = procState.rows.slice().sort((a, b) => {
    if (procState.sort === 'mem') return (b.memMB || 0) - (a.memMB || 0);
    return (b.cpuPercent || 0) - (a.cpuPercent || 0) || (b.memMB || 0) - (a.memMB || 0);
  });

  box.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'proc-row proc-head';
  ['进程', '归属', 'PID', 'CPU', '内存', ''].forEach((t) => {
    const c = document.createElement('div');
    c.className = 'proc-cell';
    c.textContent = t;
    head.appendChild(c);
  });
  box.appendChild(head);

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '暂无数据';
    box.appendChild(empty);
    return;
  }

  rows.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'proc-row';

    const nameCell = document.createElement('div');
    nameCell.className = 'proc-cell proc-name';
    nameCell.textContent = p.name || '?';
    if (p.title) nameCell.title = p.title;
    row.appendChild(nameCell);

    const ownerCell = document.createElement('div');
    ownerCell.className = 'proc-cell proc-owner';
    ownerCell.textContent = p.owner || '其他';
    row.appendChild(ownerCell);

    const pidCell = document.createElement('div');
    pidCell.className = 'proc-cell proc-num';
    pidCell.textContent = p.pid;
    row.appendChild(pidCell);

    const cpuCell = document.createElement('div');
    cpuCell.className = 'proc-cell proc-num';
    cpuCell.textContent = p.cpuPercent == null ? '—' : fmtNum(p.cpuPercent) + '%';
    row.appendChild(cpuCell);

    const memCell = document.createElement('div');
    memCell.className = 'proc-cell proc-num';
    memCell.textContent = (p.memMB || 0) + ' MB';
    row.appendChild(memCell);

    const actCell = document.createElement('div');
    actCell.className = 'proc-cell proc-act';
    if (p.protected) {
      const tag = document.createElement('span');
      tag.className = 'proc-tag';
      tag.textContent = p.protectedReason || '受保护';
      actCell.appendChild(tag);
    } else {
      const btn = document.createElement('button');
      btn.className = 'ghost proc-kill';
      btn.type = 'button';
      btn.textContent = '清理';
      btn.addEventListener('click', () => killProc(p, btn));
      actCell.appendChild(btn);
    }
    row.appendChild(actCell);

    box.appendChild(row);
  });
}

async function killProc(p, btn) {
  const ok = window.confirm(
    '结束进程？\n\n' +
      '名称：' + p.name + '\n' +
      'PID：' + p.pid + '\n' +
      '归属：' + p.owner + '\n' +
      '内存：' + p.memMB + ' MB\n\n' +
      '未保存的数据会丢失。'
  );
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    const res = await fetch('/api/procs/kill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: p.pid, name: p.name })
    });
    const j = await res.json();
    if (!j.ok) {
      btn.textContent = '失败';
      const note = $('procNote');
      if (note) note.textContent = '清理失败：' + (j.error || '未知错误');
    } else {
      btn.textContent = '已清理';
    }
  } catch (e) {
    btn.textContent = '失败';
    const note = $('procNote');
    if (note) note.textContent = '清理失败：' + e.message;
  }
  setTimeout(refreshProcPane, 600);
}

/* ---------------------------------------------- 最近 5 分钟趋势（纯 SVG，无依赖） */

function renderTrend(hist) {
  const box = $('trendBox');
  if (!box) return;
  const points = (hist.points || []).filter((p) => p && p.t);
  const meta = $('trendMeta');

  if (points.length < 2) {
    box.innerHTML =
      '<div class="empty">正在采集… 每 ' +
      Math.round((hist.intervalMs || 5000) / 1000) +
      ' 秒一个点，约 10 秒后出曲线</div>';
    if (meta) meta.textContent = '—';
    return;
  }

  const W = 720;
  const H = 150;
  const PAD_X = 34;
  const PAD_Y = 14;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_Y * 2;
  const xs = (i) => PAD_X + (innerW * i) / (points.length - 1);
  const ys = (v) => PAD_Y + innerH * (1 - Math.max(0, Math.min(100, v)) / 100);

  // 断点要断开而不是连直线：CPU 第一次采样是 null，直接连会画出一条假线
  const lineOf = (key) => {
    const segs = [];
    let cur = [];
    points.forEach((p, i) => {
      const v = p[key];
      if (v == null || Number.isNaN(v)) {
        if (cur.length) {
          segs.push(cur);
          cur = [];
        }
        return;
      }
      cur.push(xs(i).toFixed(1) + ',' + ys(v).toFixed(1));
    });
    if (cur.length) segs.push(cur);
    return segs.map((s) => s.join(' ')).join(' ');
  };

  let grid = '';
  [25, 50, 75].forEach((v) => {
    const y = ys(v).toFixed(1);
    grid +=
      '<line x1="' + PAD_X + '" y1="' + y + '" x2="' + (W - PAD_X) + '" y2="' + y + '" class="trend-grid"/>' +
      '<text x="' + (PAD_X - 6) + '" y="' + (Number(y) + 3) + '" class="trend-axis" text-anchor="end">' + v + '</text>';
  });

  const cpuLine = lineOf('cpu');
  const memLine = lineOf('mem');
  const last = points[points.length - 1];

  box.innerHTML =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" class="trend-svg" preserveAspectRatio="none">' +
    grid +
    (memLine ? '<polyline points="' + memLine + '" class="trend-line trend-mem"/>' : '') +
    (cpuLine ? '<polyline points="' + cpuLine + '" class="trend-line trend-cpu"/>' : '') +
    '</svg>';

  if (meta) {
    meta.textContent =
      Math.round((hist.windowSec || 300) / 60) + ' 分钟 · ' + points.length + ' 点 · 当前 ' +
      (last.cpu == null ? '—' : last.cpu + '%') + ' / ' + last.mem + '%';
  }
}

/* ---------------------------------------------- 按归属汇总 + 整组清理 */

function renderGroups(groups) {
  const box = $('groupTable');
  if (!box) return;

  const meta = $('groupMeta');
  const totalMem = groups.reduce((a, g) => a + (g.memMB || 0), 0);
  const totalCpu = Math.round(groups.reduce((a, g) => a + (g.cpu || 0), 0) * 10) / 10;
  if (meta) {
    meta.textContent = groups.length + ' 组 · CPU ' + totalCpu + '% · 内存 ' + totalMem + ' MB';
  }

  box.innerHTML = '';
  if (!groups.length) {
    box.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }

  const head = document.createElement('div');
  head.className = 'proc-row proc-head group-row';
  ['归属', '进程数', 'CPU 合计', '内存合计', ''].forEach((t) => {
    const c = document.createElement('div');
    c.className = 'proc-cell';
    c.textContent = t;
    head.appendChild(c);
  });
  box.appendChild(head);

  groups.forEach((g) => {
    const row = document.createElement('div');
    row.className = 'proc-row group-row';

    const owner = document.createElement('div');
    owner.className = 'proc-cell group-owner';
    owner.textContent = g.owner;

    const count = document.createElement('div');
    count.className = 'proc-cell proc-num';
    count.textContent = g.count + ' 个';

    const cpu = document.createElement('div');
    cpu.className = 'proc-cell proc-num';
    cpu.textContent = fmtNum(g.cpu) + '%';

    const mem = document.createElement('div');
    mem.className = 'proc-cell proc-num';
    mem.textContent = g.memMB + ' MB';

    const act = document.createElement('div');
    act.className = 'proc-cell proc-act';
    const btn = document.createElement('button');
    btn.className = 'ghost proc-kill';
    btn.type = 'button';
    btn.textContent = '清理该组';
    if (!g.unprotected) {
      btn.disabled = true;
      btn.title = '该组全部受保护';
    } else {
      btn.addEventListener('click', () => killGroup(g, btn));
    }
    act.appendChild(btn);

    row.appendChild(owner);
    row.appendChild(count);
    row.appendChild(cpu);
    row.appendChild(mem);
    row.appendChild(act);
    box.appendChild(row);
  });
}

async function killGroup(g, btn) {
  const ok = window.confirm(
    '结束「' + g.owner + '」下的全部进程？\n\n' +
      '进程数：' + g.count + '（其中 ' + g.unprotected + ' 个可结束）\n' +
      'CPU 合计：' + g.cpu + '%\n' +
      '内存合计：' + g.memMB + ' MB\n\n' +
      '系统关键进程会自动跳过。未保存的数据会丢失。'
  );
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    const res = await fetch('/api/procs/kill-group', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: g.owner, confirm: true })
    });
    const j = await res.json();
    const note = $('procNote');
    if (j.ok) {
      btn.textContent = '已清理 ' + (j.killed || []).length;
      if (note) note.textContent = '已结束 ' + (j.killed || []).length + ' 个，跳过 ' + (j.skipped || []).length + ' 个';
    } else {
      btn.textContent = '失败';
      if (note) note.textContent = '整组清理失败：' + (j.error || '未知错误');
    }
  } catch (e) {
    btn.textContent = '失败';
    const note = $('procNote');
    if (note) note.textContent = '整组清理失败：' + e.message;
  }
  setTimeout(refreshProcPane, 800);
}

(function initTabs() {
  const tabs = $('tabs');
  if (!tabs) return;

  tabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (btn) switchPane(btn.dataset.pane);
  });

  const sortSel = $('procSort');
  if (sortSel) {
    sortSel.addEventListener('change', () => {
      procState.sort = sortSel.value;
      renderProcTable();
    });
  }

  const refreshBtn = $('btnProcRefresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refreshProcPane());
  }

  // 页面隐藏时停轮询，回来再继续（切页签 / 最小化都适用）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopProcPolling();
    else if (document.querySelector('.tab.on')?.dataset.pane === 'proc') startProcPolling();
  });
})();

boot();
