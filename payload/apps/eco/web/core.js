'use strict';

/**
 * AIWorkKit Eco - shared state and formatting helpers.
 *
 * Loaded before render.js and app.js. Rendering is fully incremental: DOM nodes
 * are created once per entity and only their text / class / width is patched, so
 * a 1s state tick never rebuilds a list and never restarts an animation.
 */

const $ = (id) => document.getElementById(id);

const ui = {
  snap: null,
  logSeq: 0,
  filter: 'all',
  compact: false,
  lastStateAt: 0,
  logRows: 0,
  expanded: new Set(),
  autoExpanded: new Set(),
  logCache: new Map(),
  actionTarget: null,
  dom: {
    jobs: new Map(),
    procs: new Map(),
    plugins: new Map()
  }
};

const MAX_LOG_ROWS = 400;

const STATUS_TEXT = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  stalled: '停滞',
  cancelled: '取消'
};

const STEP_ICON = { completed: '✓', in_progress: '◐', pending: '○', failed: '✕', cancelled: '–' };
const STEP_TEXT = { completed: '已完成', in_progress: '进行中', pending: '待开始', failed: '失败', cancelled: '跳过' };
const OVERRIDE_TEXT = { stall: '已标记卡住', skip: '已跳过', kill: '已终止' };
const SCOPE_TEXT = { project: '项目级', user: '用户级', marketplace: '市场', local: '本地' };
const KIND_TEXT = { task: '任务', tool: '工具', agent: 'Agent', script: '脚本', manual: '上报' };
const PHASE_TEXT = { start: '▶ 开始', done: '✓ 完成', error: '✕ 报错', info: '• 信息' };

/* ---------------- escaping / patching helpers ---------------- */

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

/** Write text only when it actually changed (avoids re-layout / flicker). */
function setText(el, value) {
  if (!el) return;
  const next = value == null ? '' : String(value);
  if (el.textContent !== next) el.textContent = next;
}

function setHTML(el, html) {
  if (!el) return;
  if (el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
}

function setClass(el, className) {
  if (!el) return;
  if (el.className !== className) el.className = className;
}

function setWidth(el, percent) {
  if (!el) return;
  const next = 'width:' + Math.max(0, Math.min(100, percent || 0)) + '%';
  if (el.style.cssText !== next) el.style.cssText = next;
}

/* ---------------- formatting ---------------- */

function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  const h = Math.floor(m / 60);
  return h + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

function fmtEta(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  if (ms <= 0) return '已完成';
  return '~' + fmtDuration(ms);
}

function fmtNum(n) {
  if (n == null || !isFinite(n)) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtClock(ts) {
  const d = new Date(ts || Date.now());
  const p = (x) => String(x).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function fmtMem(mb) {
  if (mb == null) return '—';
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}

function fmtAgo(ts) {
  const d = Date.now() - ts;
  if (d < 5000) return '刚刚';
  if (d < 60000) return Math.round(d / 1000) + 's 前';
  if (d < 3600000) return Math.round(d / 60000) + 'm 前';
  return Math.round(d / 3600000) + 'h 前';
}
