'use strict';

/* AIWorkKit Idle Tuner - dashboard front end (no framework, no build step) */

const ROLE_ZH = {
  main: '主进程',
  renderer: '渲染进程',
  gpu: 'GPU 进程',
  'node-service': '扩展宿主',
  'extension-host': '扩展宿主',
  helper: '脚本子进程',
  utility: '工具进程',
  tsserver: 'TS 服务',
  crashpad: '崩溃收集',
};

const ROLE_COLOR = {
  main: 'var(--amber)',
  renderer: 'var(--blue)',
  gpu: 'var(--rose)',
  'node-service': 'var(--mint)',
  'extension-host': 'var(--mint)',
  helper: 'var(--ice)',
  utility: 'var(--violet)',
  tsserver: 'var(--violet)',
  crashpad: 'var(--muted)',
};

const $ = (id) => document.getElementById(id);
const history = [];
const POLL_MS = 3000;

let lastStatus = null;
let polling = false;
let toastTimer = null;

function mb(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function pct(n) {
  if (n === null || n === undefined) return '—';
  return `${Number(n).toFixed(1)}%`;
}

function timeText(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', !!isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

function overlay(show, text) {
  const el = $('overlay');
  if (text) $('overlayText').textContent = text;
  el.hidden = !show;
}

function setBusy(busy) {
  document.querySelectorAll('.act').forEach((btn) => {
    btn.disabled = busy;
  });
  $('autoMode').disabled = busy;
}

/* ---------------- data ---------------- */

async function fetchStatus(force) {
  const res = await fetch(`/api/status${force ? '?force=1' : ''}`, { cache: 'no-store' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'status failed');
  return data;
}

/* ---------------- rendering ---------------- */

function drawSpark() {
  const line = $('sparkLine');
  const area = $('sparkArea');
  const points = history.slice(-90);
  if (points.length < 2) {
    line.setAttribute('points', '');
    area.setAttribute('d', '');
    return;
  }

  const values = points.map((p) => p.mb);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);

  const coords = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 100;
    const y = 26 - ((v - min) / span) * 22;
    return [x, y];
  });

  line.setAttribute('points', coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '));
  const first = coords[0];
  const last = coords[coords.length - 1];
  area.setAttribute(
    'd',
    `M${first[0].toFixed(2)},28 L` +
      coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L') +
      ` L${last[0].toFixed(2)},28 Z`
  );
}

function renderRoles(roles) {
  const box = $('roleList');
  const total = roles.reduce((sum, r) => sum + r.mb, 0) || 1;
  box.innerHTML = '';
  roles.forEach((r) => {
    const share = Math.max(2, (r.mb / total) * 100);
    const el = document.createElement('div');
    el.className = 'role';
    el.innerHTML = `
      <div class="role-top">
        <span class="role-name">${ROLE_ZH[r.role] || r.role}</span>
        <span class="role-meta">${r.count} 个 · ${mb(r.mb)} MB</span>
      </div>
      <div class="bar"><i style="width:${share.toFixed(1)}%;background:${ROLE_COLOR[r.role] || 'var(--blue)'}"></i></div>`;
    box.appendChild(el);
  });
}

function renderTable(processes) {
  const body = $('procBody');
  const rows = (processes || []).slice().sort((a, b) => b.wsMB - a.wsMB);
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">AIWorkKit 没有在运行</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((p) => {
      const role = ROLE_ZH[p.role] || p.role;
      const state = p.suspended ? '<span class="badge-susp">已挂起</span>' : '—';
      return `<tr>
        <td>${p.pid}</td>
        <td><span class="role-tag ${p.role}">${role}</span></td>
        <td class="r">${mb(p.wsMB)} MB</td>
        <td class="r">${pct(p.cpuPct)}</td>
        <td>${p.priority}</td>
        <td>${state}</td>
      </tr>`;
    })
    .join('');
}

function render(data) {
  const s = data.status;
  lastStatus = s;

  $('serverInfo').textContent = `127.0.0.1:${data.server.port}`;
  $('dataDir').textContent = s.dataDir || '—';
  $('clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  const runState = $('runState');
  if (!s.running) {
    runState.textContent = 'AIWorkKit 未运行';
    runState.className = 'pill off';
    $('totalMB').textContent = '—';
    $('procBody').innerHTML = '<tr><td colspan="6" class="empty">AIWorkKit 没有在运行</td></tr>';
    $('roleList').innerHTML = '';
    return;
  }

  runState.textContent = s.suspended && s.suspended.length ? `已挂起 ${s.suspended.length} 个进程` : '运行中';
  runState.className = `pill ${s.suspended && s.suspended.length ? 'off' : 'on'}`;

  $('totalMB').textContent = mb(s.totalMB);
  $('privateMB').textContent = `${mb(s.privateMB)} MB`;
  $('cpuPercent').textContent = pct(s.cpuPercent);
  $('procCount').textContent = String(s.count);
  $('suspendedCount').textContent = String((s.suspended || []).length);
  $('chipSuspended').classList.toggle('alert', (s.suspended || []).length > 0);

  const prev = history.length ? history[history.length - 1].mb : null;
  history.push({ t: Date.now(), mb: s.totalMB });
  if (history.length > 200) history.shift();

  const trend = $('trend');
  if (prev !== null) {
    const delta = s.totalMB - prev;
    trend.textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} MB / 3s`;
    trend.className = `trend ${delta > 0 ? 'up' : ''}`;
  }
  drawSpark();

  renderRoles(s.roles || []);
  renderTable(s.processes);

  const auto = $('autoMode');
  if (document.activeElement !== auto) auto.checked = !!s.autoMode;

  $('lastApply').textContent = s.lastApplyAt
    ? `最近降温：${timeText(s.lastApplyAt)}${s.lastMode ? ` · ${s.lastMode}` : ''}${s.lastFreedMB != null ? ` · 省 ${mb(s.lastFreedMB)} MB` : ''}`
    : '最近降温：—';
}

/* ---------------- actions ---------------- */

async function postAction(payload, attempt = 0) {
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // The server serialises mutations and answers 429 while one is running.
  // Back off and retry instead of surfacing a silent failure to the user.
  if (res.status === 429 && attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    return postAction(payload, attempt + 1);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '操作失败');
  return data.result;
}

function summarize(action, result) {
  switch (action) {
    case 'trim':
      return `已回收内存：${mb(result.beforeMB)} → ${mb(result.settledMB)} MB（省 ${mb(result.settledFreedMB)} MB）`;
    case 'apply':
      return `${result.mode === 'deep' ? '深度降温' : '一键降温'}完成：工作集 ${mb(result.beforeMB)} → ${mb(result.settledMB)} MB，优先级别 ${result.priority}`;
    case 'suspend':
      return `已挂起 ${(result.suspended || []).length} 个后台进程，恢复请点「恢复全部」`;
    case 'restore':
      return `已恢复：唤醒 ${(result.resumed || []).length} 个进程，优先级还原`;

    default:
      return '完成';
  }
}

async function runAction(btn) {
  const action = btn.dataset.act;
  const mode = btn.dataset.mode;

  const payload = { action };
  if (mode) payload.mode = mode;

  if (action === 'suspend') {
    const ok = window.confirm(
      '将挂起扩展宿主 / TS 服务 / 脚本子进程。\n挂起后这些服务停止响应，需要点「恢复全部」或托盘唤醒。\n\n继续吗？'
    );
    if (!ok) return;
    payload.level = 'background';
    payload.autoResume = 30;
  }

  const labels = {
    trim: '正在回收工作集…',
    apply: mode === 'deep' ? '正在深度降温…' : '正在一键降温…',
    suspend: '正在挂起后台进程…',
    restore: '正在恢复…',
  };

  setBusy(true);
  overlay(true, labels[action] || '执行中…');
  try {
    const result = await postAction(payload);
    toast(summarize(action, result));
    const data = await fetchStatus(true);
    render(data);
  } catch (err) {
    toast(err.message, true);
  } finally {
    overlay(false);
    setBusy(false);
  }
}

async function toggleAuto(enabled) {
  setBusy(true);
  try {
    await postAction({ action: 'auto', enabled });
    toast(`空闲自动降温：${enabled ? '已开启（延迟 120 秒触发）' : '已关闭'}`);
    const data = await fetchStatus(true);
    render(data);
  } catch (err) {
    toast(err.message, true);
    $('autoMode').checked = !enabled;
  } finally {
    setBusy(false);
  }
}

async function openTray() {
  try {
    await postAction({ action: 'tray' });
    toast('托盘已启动，见任务栏通知区域');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- loop ---------------- */

async function poll(force) {
  if (polling) return;
  polling = true;
  try {
    render(await fetchStatus(force));
  } catch (err) {
    const runState = $('runState');
    runState.textContent = '服务未连接';
    runState.className = 'pill off';
  } finally {
    polling = false;
  }
}

document.querySelectorAll('.act').forEach((btn) => {
  btn.addEventListener('click', () => runAction(btn));
});

$('autoMode').addEventListener('change', (e) => toggleAuto(e.target.checked));
$('btnRefresh').addEventListener('click', () => poll(true));
$('btnTray').addEventListener('click', openTray);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll(true);
});

setInterval(() => {
  if (!document.hidden) poll(false);
}, POLL_MS);

poll(true);
