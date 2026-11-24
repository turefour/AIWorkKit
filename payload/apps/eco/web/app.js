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

boot();
