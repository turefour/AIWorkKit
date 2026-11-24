'use strict';

/**
 * AIWorkKit Eco - incremental renderers.
 *
 * Every entity (job / process / plugin) owns one DOM node for its lifetime and
 * the renderers only patch changed text, class names and widths. This is what
 * keeps the dashboard steady: no innerHTML sweep, no replayed entry animation,
 * no scroll jump while a log is open.
 */

const RING_R = 24;
const RING_C = 2 * Math.PI * RING_R;

/* ================= KPI strip ================= */

const KPI_DEFS = [
  { key: 'running', label: '运行中任务' },
  { key: 'overall', label: '整体进度' },
  { key: 'scripts', label: '脚本进程' },
  { key: 'cpu', label: 'CPU 占用' },
  { key: 'mem', label: '内存合计' },
  { key: 'plugins', label: '已加载插件' }
];

function ensureKpis() {
  const box = $('kpis');
  if (box.childElementCount === KPI_DEFS.length) return;
  box.innerHTML = KPI_DEFS.map(
    (def) => `<div class="kpi" data-kpi="${def.key}">
      <div class="kpi-label">${def.label}</div>
      <div class="kpi-value"><b data-k="v">—</b><small data-k="u"></small></div>
      <div class="kpi-sub" data-k="sub"> </div>
      <div class="kpi-bar"><i data-k="bar"></i></div>
    </div>`
  ).join('');
  ui.dom.kpi = {};
  for (const card of box.children) {
    ui.dom.kpi[card.getAttribute('data-kpi')] = {
      value: card.querySelector('[data-k="v"]'),
      unit: card.querySelector('[data-k="u"]'),
      sub: card.querySelector('[data-k="sub"]'),
      bar: card.querySelector('[data-k="bar"]'),
      barWrap: card.querySelector('.kpi-bar')
    };
  }
}

function patchKpi(key, value, unit, sub, bar) {
  const slot = ui.dom.kpi && ui.dom.kpi[key];
  if (!slot) return;
  setText(slot.value, value);
  setText(slot.unit, unit || '');
  setText(slot.sub, sub || ' ');
  if (bar == null) {
    if (slot.barWrap.style.display !== 'none') slot.barWrap.style.display = 'none';
  } else {
    if (slot.barWrap.style.display === 'none') slot.barWrap.style.display = '';
    setWidth(slot.bar, bar);
  }
}

function renderKpis(state) {
  ensureKpis();
  const s = state.summary || {};
  const overall = s.overallPercent;
  const cpuCores = state.server.cpuCount || 1;

  patchKpi('running', s.running || 0, '个',
    (s.stalled ? s.stalled + ' 个停滞' : '') + (s.failed ? (s.stalled ? ' · ' : '') + s.failed + ' 失败' : ''), null);
  patchKpi('overall', overall == null ? '—' : overall, overall == null ? '' : '%',
    (s.quantified || 0) + ' 个可量化流程', overall == null ? 0 : overall);
  patchKpi('scripts', s.scripts || 0, '个', 'agent ' + (s.agents || 0) + ' 个', null);
  patchKpi('cpu', s.cpuPercent == null ? 0 : s.cpuPercent, '%',
    cpuCores + ' 核 · load ' + (state.server.load || 0), Math.min(100, (s.cpuPercent || 0) / cpuCores));
  patchKpi('mem', fmtMem(s.memMB), '', '监控进程集合', null);
  const enabledPlugins =
    s.pluginsEnabled != null ? s.pluginsEnabled : (state.plugins || []).filter((p) => p.enabled !== false).length;
  patchKpi(
    'plugins',
    enabledPlugins,
    '个',
    '启用 / 共 ' + (s.plugins || 0) + ' 个 · hook ' + (state.plugins || []).filter((p) => p.armed && p.enabled !== false).length,
    null
  );
}

/* ================= source chips ================= */

const SOURCE_DEFS = [
  ['hook', 'Hook 采集'],
  ['wrapper', '脚本包装'],
  ['manual', '进度上报'],
  ['scan', '进程扫描']
];

function renderSources(state) {
  const box = $('sources');
  const src = state.sources || {};
  if (box.childElementCount !== SOURCE_DEFS.length) {
    box.innerHTML = SOURCE_DEFS.map(
      ([key, label]) => `<span class="src-chip" data-src="${key}"><i></i><span data-f="txt"></span></span>`
    ).join('');
    ui.dom.sources = {};
    for (const chip of box.children) {
      ui.dom.sources[chip.getAttribute('data-src')] = {
        root: chip,
        txt: chip.querySelector('[data-f="txt"]')
      };
    }
  }
  for (const [key, label] of SOURCE_DEFS) {
    const item = src[key] || {};
    const slot = ui.dom.sources[key];
    const on = !!item.alive;
    setClass(slot.root, 'src-chip' + (on ? ' on' : ''));
    setText(slot.txt, label + ' ' + (item.lastAt ? fmtAgo(item.lastAt) : '未接入'));
    const title = label + ' · 事件 ' + (item.events || 0);
    if (slot.root.title !== title) slot.root.title = title;
  }

  // Without hooks the dashboard cannot see in-agent tasks; say so instead of
  // leaving the user wondering why a running task never appears.
  const bar = $('hintBar');
  if (bar) {
    const hookOn = !!(src.hook && src.hook.alive);
    bar.hidden = hookOn;
    if (!hookOn) {
      setText(
        bar,
        'Agent 任务采集未接入：重载窗口后自动生效（Ctrl+Shift+P → Developer: Reload Window）；期间可用 eco task 上报任务清单。'
      );
    }
  }
}

/* ================= jobs ================= */

function ringHTML(job) {
  if (job.percent == null) {
    return `<svg viewBox="0 0 54 54" width="54" height="54">
        <circle class="track" cx="27" cy="27" r="${RING_R}"></circle>
        <circle class="value indeterminate" cx="27" cy="27" r="${RING_R}"></circle>
      </svg>
      <div class="ring-label dim">运行</div>`;
  }
  const offset = RING_C * (1 - job.percent / 100);
  const text = job.percent >= 10 ? Math.round(job.percent) + '%' : job.percent.toFixed(1) + '%';
  return `<svg viewBox="0 0 54 54" width="54" height="54">
      <circle class="track" cx="27" cy="27" r="${RING_R}"></circle>
      <circle class="value" cx="27" cy="27" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
    </svg>
    <div class="ring-label">${text}</div>`;
}

function stepsHTML(job) {
  if (!Array.isArray(job.steps) || !job.steps.length) return '';
  const done = job.steps.filter((s) => s.status === 'completed').length;
  const rows = job.steps
    .map(
      (s) => `<div class="step ${esc(s.status)}">
        <span class="step-icon">${STEP_ICON[s.status] || '○'}</span>
        <span class="step-text">${esc(s.text)}</span>
        <span class="step-state">${STEP_TEXT[s.status] || esc(s.status)}</span>
      </div>`
    )
    .join('');
  return `<div class="steps"><div class="steps-head">任务清单 · ${done}/${job.steps.length}</div>${rows}</div>`;
}

function expandedHTML(job) {
  const cells = [];
  const push = (k, v) => cells.push(`<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>`);
  push('会话', (job.sessionId || 'local').slice(0, 16));
  push('来源', job.source || job.kind);
  if (job.pid) push('PID', job.pid);
  if (job.pid) cells.push('<div class="kv"><span>CPU</span><b data-kv="cpu">—</b></div>');
  if (job.pid) cells.push('<div class="kv"><span>内存</span><b data-kv="mem">—</b></div>');
  push('开始', fmtClock(job.startedAt));
  if (job.endedAt) push('结束', fmtClock(job.endedAt));

  return `<div class="kv-grid">${cells.join('')}</div>
    ${stepsHTML(job)}
    <div class="job-log">
      <div class="job-log-head">
        <span>运行日志</span>
        <span class="muted" data-log-meta="${esc(job.id)}">—</span>
        <button class="mini" type="button" data-log-refresh="${esc(job.id)}">刷新</button>
      </div>
      <pre class="job-log-body" data-log="${esc(job.id)}">加载中…</pre>
    </div>`;
}

function jobMetaHTML(job) {
  const parts = [];
  if (job.current != null) {
    parts.push(
      `<span><b>${fmtNum(job.current)}</b>${job.total != null ? ' / ' + fmtNum(job.total) : ''} ${esc(job.unit || '')}</span>`
    );
  }
  if (job.rate != null && job.rate !== 0) parts.push(`<span>${job.rate > 0 ? '▲' : '▼'} ${Math.abs(job.rate)}/s</span>`);
  if (job.etaMs != null && job.status === 'running') parts.push(`<span>剩余 ${fmtEta(job.etaMs)}</span>`);
  parts.push(`<span>已用 ${fmtDuration(job.elapsedMs)}</span>`);
  if (job.pid) parts.push(`<span>pid ${job.pid}</span>`);
  if (job.steps && job.steps.length) {
    parts.push(`<span>步骤 ${job.steps.filter((s) => s.status === 'completed').length}/${job.steps.length}</span>`);
  }
  return parts.join('');
}

function createJobNode(job) {
  const root = document.createElement('div');
  root.className = 'job is-new ' + job.status;
  root.dataset.id = job.id;
  root.innerHTML = `<div class="job-row">
      <div class="job-ring" data-f="ring"></div>
      <div class="job-main">
        <div class="job-head">
          <span class="kind" data-f="kind"></span>
          <strong data-f="label"></strong>
          <span class="status-tag" data-f="status"></span>
          <button class="mini job-code" type="button" data-code="1" data-f="code" title="查看源码与进度">源码</button>
          <span class="job-caret" data-f="caret">▸</span>
        </div>
        <div class="job-detail" data-f="detail"></div>
        <div class="bar"><i data-f="bar"></i></div>
        <div class="job-meta" data-f="meta"></div>
        <div class="job-note" data-f="note"></div>
        <div class="job-logs" data-f="logs"></div>
      </div>
    </div>
    <div class="job-expanded" data-f="expanded" hidden></div>`;

  const refs = { root, last: {} };
  for (const el of root.querySelectorAll('[data-f]')) refs[el.getAttribute('data-f')] = el;

  root.addEventListener('click', (event) => {
    const codeBtn = event.target.closest('[data-code]');
    if (codeBtn) {
      event.stopPropagation();
      openDetail({ jobId: root.dataset.id });
      return;
    }
    const refresh = event.target.closest('[data-log-refresh]');
    if (refresh) {
      event.stopPropagation();
      refreshLog(refresh.getAttribute('data-log-refresh'));
      return;
    }
    if (event.target.closest('[data-f="expanded"]')) return;
    if (event.target.closest('.job-row')) toggleJob(root.dataset.id);
  });

  requestAnimationFrame(() => root.classList.remove('is-new'));
  return refs;
}

function patchJob(refs, job, state) {
  const last = refs.last;
  const status = STATUS_TEXT[job.status] || job.status;

  const cls = 'job' + (job.status ? ' ' + job.status : '') + (ui.expanded.has(job.id) ? ' expanded' : '') + (refs.root.classList.contains('is-new') ? ' is-new' : '');
  setClass(refs.root, cls);

  setClass(refs.kind, 'kind kind-' + job.kind);
  if (last.kind !== job.kind) {
    setText(refs.kind, KIND_TEXT[job.kind] || job.kind);
    last.kind = job.kind;
  }
  setText(refs.label, job.label);
  if (refs.label.title !== job.label) refs.label.title = job.label;

  if (last.status !== job.status) {
    setClass(refs.status, 'status-tag status-' + job.status);
    setText(refs.status, status);
    last.status = job.status;
  }

  // The "源码" entry only makes sense when a script file can be located.
  if (refs.code) {
    const canCode = !!(job.pid || /\.(js|mjs|cjs|ts|py|ps1|sh|bat|cmd|rb|go|java|lua|php)\b/i.test(job.command || ''));
    if (last.canCode !== canCode) {
      refs.code.style.display = canCode ? '' : 'none';
      last.canCode = canCode;
    }
  }

  const detail = job.command || job.detail || '';
  setText(refs.detail, detail);
  if (refs.detail.title !== detail) refs.detail.title = detail;

  if (last.barMode !== (job.percent == null ? 'ind' : 'det')) {
    setClass(refs.bar, job.percent == null ? 'indeterminate' : '');
    last.barMode = job.percent == null ? 'ind' : 'det';
  }
  if (job.percent != null) setWidth(refs.bar, job.percent);

  const meta = jobMetaHTML(job);
  if (last.meta !== meta) {
    refs.meta.innerHTML = meta;
    last.meta = meta;
  }

  setText(refs.note, job.note || '');
  if (refs.note.textContent && refs.note.style.display === 'none') refs.note.style.display = '';
  if (!job.note && refs.note.style.display !== 'none') refs.note.style.display = 'none';

  // ring
  const ringMode = job.percent == null ? 'ind' : 'det';
  if (last.ringMode !== ringMode) {
    refs.ring.innerHTML = ringHTML(job);
    refs.ringValue = refs.ring.querySelector('.value');
    refs.ringLabel = refs.ring.querySelector('.ring-label');
    last.ringMode = ringMode;
    last.ringPct = job.percent;
  } else if (job.percent != null && last.ringPct !== job.percent) {
    const offset = RING_C * (1 - job.percent / 100);
    if (refs.ringValue) refs.ringValue.setAttribute('stroke-dashoffset', offset.toFixed(1));
    setText(refs.ringLabel, job.percent >= 10 ? Math.round(job.percent) + '%' : job.percent.toFixed(1) + '%');
    last.ringPct = job.percent;
  }

  // tail logs
  const tail = (job.logs || []).slice(-2);
  const tailHTML = tail
    .map((l) => `<div class="${l.level === 'error' ? 'err' : ''}">${esc(l.message)}</div>`)
    .join('');
  if (last.tailHTML !== tailHTML) {
    setHTML(refs.logs, tailHTML);
    last.tailHTML = tailHTML;
  }

  // expanded panel: rebuild only when structure-relevant fields change
  const wantExpanded = ui.expanded.has(job.id);
  if (!wantExpanded) {
    if (!refs.expanded.hidden) refs.expanded.hidden = true;
    last.expandedSig = '';
    return;
  }
  const sig =
    (job.steps || []).map((s) => s.status).join(',') +
    '|' + (job.pid || '') +
    '|' + (job.endedAt ? 1 : 0) +
    '|' + (job.sessionId || '');
  if (refs.expanded.hidden || last.expandedSig !== sig) {
    refs.expanded.innerHTML = expandedHTML(job);
    refs.expanded.hidden = false;
    last.expandedSig = sig;
    paintLog(job.id);
  }

  // CPU / memory of the linked process
  const proc = job.pid ? (state.processes || []).find((p) => p.pid === job.pid) : null;
  const cpuEl = refs.expanded.querySelector('[data-kv="cpu"]');
  const memEl = refs.expanded.querySelector('[data-kv="mem"]');
  if (cpuEl) setText(cpuEl, proc && proc.cpuPercent != null ? proc.cpuPercent + '%' : '—');
  if (memEl) setText(memEl, proc ? fmtMem(proc.memMB) : '—');
}

function renderJobs(state) {
  const jobs = state.jobs || [];
  $('jobCount').textContent = jobs.length + ' 项';
  $('jobsEmpty').style.display = jobs.length ? 'none' : 'block';

  for (const job of jobs) {
    if (job.kind === 'task' && !ui.autoExpanded.has(job.id)) {
      ui.autoExpanded.add(job.id);
      ui.expanded.add(job.id);
      refreshLog(job.id);
    }
  }

  const box = $('jobs');
  const seen = new Set();
  for (const job of jobs) {
    seen.add(job.id);
    let refs = ui.dom.jobs.get(job.id);
    if (!refs) {
      refs = createJobNode(job);
      ui.dom.jobs.set(job.id, refs);
    }
    patchJob(refs, job, state);
    box.appendChild(refs.root); // moves existing nodes, never recreates them
  }
  for (const [id, refs] of ui.dom.jobs) {
    if (seen.has(id)) continue;
    // Flow finished and was auto-cleared by the server: fade the card out
    // instead of dropping it instantly.
    ui.dom.jobs.delete(id);
    ui.logCache.delete(id);
    ui.expanded.delete(id);
    ui.autoExpanded.delete(id);
    if (refs.root.classList.contains('is-leaving')) continue;
    refs.root.classList.add('is-leaving');
    refs.root.style.pointerEvents = 'none';
    setTimeout(() => refs.root.remove(), 240);
  }
}

/* ================= processes ================= */

function createProcNode(p) {
  const root = document.createElement('div');
  root.className = 'proc';
  root.innerHTML = `<div class="proc-name">
      <div class="proc-title">
        <b data-f="name"></b>
        <span class="tag-proj" data-f="proj"></span>
        <span data-f="flag"></span>
      </div>
      <div class="proc-cmd" data-f="cmd"></div>
    </div>
    <div class="proc-cpu" data-f="cpu"></div>
    <div class="proc-mem" data-f="mem"></div>
    <div class="proc-actions">
      <button type="button" class="mini" data-act="stall" data-kind="process">卡住</button>
      <button type="button" class="mini" data-act="skip" data-kind="process">跳过</button>
    </div>
    <div class="mini-bar"><i data-f="bar"></i></div>
    <div class="proc-panel" data-f="panel"></div>`;
  root.setAttribute('data-pid', p.pid);
  for (const btn of root.querySelectorAll('[data-act]')) btn.setAttribute('data-key', String(p.pid));

  const refs = { root, last: {} };
  for (const el of root.querySelectorAll('[data-f]')) refs[el.getAttribute('data-f')] = el;
  return refs;
}

function patchProc(refs, p, state) {
  const last = refs.last;
  const projName = p.project && p.project.name ? p.project.name : '';
  const projKind = p.project && p.project.kind ? p.project.kind : '';
  const projPath =
    projKind === 'folder'
      ? '未找到项目清单，按脚本目录归属'
      : p.project && p.project.path
      ? p.project.path
      : '未检测到项目根';

  setClass(refs.root, 'proc' + (p.override ? ' flagged' : ''));
  setText(refs.name, p.name);

  const projClass = 'tag-proj ' + (projName ? (projKind === 'folder' ? 'soft' : '') : 'dim');
  if (last.projClass !== projClass) {
    setClass(refs.proj, projClass);
    last.projClass = projClass;
  }
  setText(refs.proj, projName || '外部进程');
  if (refs.proj.title !== projPath) refs.proj.title = projPath;

  const flagHTML = p.override
    ? `<span class="flag flag-${esc(p.override.action)}" title="${esc(p.override.note || '')}">${esc(
        OVERRIDE_TEXT[p.override.action] || p.override.action
      )}</span>`
    : '';
  if (last.flag !== flagHTML) {
    setHTML(refs.flag, flagHTML);
    last.flag = flagHTML;
  }

  setText(refs.cmd, p.command || 'pid ' + p.pid);
  if (refs.cmd.title !== (p.command || '')) refs.cmd.title = p.command || '';

  setText(refs.cpu, p.cpuPercent == null ? '—' : p.cpuPercent + '%');
  setText(refs.mem, fmtMem(p.memMB));
  setWidth(refs.bar, Math.max(2, Math.min(100, p.cpuPercent || 0)));

  const open = !!ui.actionTarget && ui.actionTarget.kind === 'process' && String(ui.actionTarget.key) === String(p.pid);
  const panelKey = open ? 'open:' + (p.override ? p.override.at : 0) : 'closed';
  if (last.panel !== panelKey) {
    refs.panel.innerHTML = open
      ? actionPanel('process', p.pid, p.name + ' · pid ' + p.pid, projName, p.override, state.skipModes)
      : '';
    last.panel = panelKey;
  }
}

/* ================= duplicate test-process guard ================= */

function guardLabel(status) {
  if (status === 'locked') return '已锁死';
  if (status === 'warn') return '重复告警';
  return '正常';
}

/**
 * Render the duplicate-runner banner above the process list.
 * Only groups that are actually duplicated are shown, so the panel stays hidden
 * during normal work.
 */
function renderGuard(state) {
  const box = $('guard');
  if (!box) return;
  if (box.dataset.bound !== '1') bindGuard();

  const g = state.guard || {};
  const groups = (g.groups || []).filter((x) => x.status !== 'ok' || x.count > 1);
  const worst = groups.some((x) => x.status === 'locked')
    ? 'locked'
    : groups.some((x) => x.status === 'warn')
      ? 'warn'
      : 'ok';

  box.className = 'guard ' + worst;
  box.innerHTML = '';
  box.hidden = groups.length === 0;
  if (!groups.length) return;

  const head = document.createElement('div');
  head.className = 'guard-head';

  const title = document.createElement('b');
  title.textContent = worst === 'locked' ? '重复进程已锁死并清理' : '检测到重复测试进程';
  head.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent =
    groups.length + ' 组 · 累计清理 ' + (g.killed || 0) + ' 个 · 阈值 ' + (g.warnAt || 4) + ' / ' + (g.lockAt || 6);
  head.appendChild(meta);

  if (worst === 'locked') {
    const all = document.createElement('button');
    all.className = 'guard-btn';
    all.textContent = '全部解锁';
    all.setAttribute('data-guard', 'unlock');
    all.setAttribute('data-key', '');
    head.appendChild(all);
  }
  box.appendChild(head);

  for (const group of groups) {
    const row = document.createElement('div');
    row.className = 'guard-row';

    const badge = document.createElement('span');
    badge.className = 'guard-status ' + group.status;
    badge.textContent = guardLabel(group.status);
    row.appendChild(badge);

    const key = document.createElement('span');
    key.className = 'guard-key';
    key.textContent = group.key;
    key.title = group.key;
    row.appendChild(key);

    const count = document.createElement('span');
    count.className = 'guard-count';
    count.textContent = group.count + ' 个 · 峰值 ' + group.peak;
    row.appendChild(count);

    const clean = document.createElement('button');
    clean.className = 'guard-btn';
    clean.textContent = '清理';
    clean.setAttribute('data-guard', 'clean');
    clean.setAttribute('data-key', group.key);
    row.appendChild(clean);

    const unlock = document.createElement('button');
    unlock.className = 'guard-btn';
    unlock.textContent = '解锁';
    unlock.setAttribute('data-guard', 'unlock');
    unlock.setAttribute('data-key', group.key);
    row.appendChild(unlock);

    box.appendChild(row);
  }
}

function bindGuard() {
  const box = $('guard');
  if (!box || box.dataset.bound === '1') return;
  box.dataset.bound = '1';
  box.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-guard]');
    if (!btn) return;
    const action = btn.getAttribute('data-guard');
    const key = btn.getAttribute('data-key') || '';
    btn.disabled = true;
    try {
      await fetch('/api/guard/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, key })
      });
    } catch (_) {
      /* offline: the next tick renders whatever the server thinks */
    }
    btn.disabled = false;
    await refreshSnapshot();
  });
}

function renderProcs(state) {
  const list = (state.processes || []).slice(0, 24);
  $('procCount').textContent = (state.summary.scripts || 0) + ' 运行中';
  const box = $('procs');
  const seen = new Set();
  for (const p of list) {
    seen.add(p.pid);
    let refs = ui.dom.procs.get(p.pid);
    if (!refs) {
      refs = createProcNode(p);
      ui.dom.procs.set(p.pid, refs);
    }
    patchProc(refs, p, state);
    box.appendChild(refs.root);
  }
  for (const [pid, refs] of ui.dom.procs) {
    if (!seen.has(pid)) {
      refs.root.remove();
      ui.dom.procs.delete(pid);
    }
  }
  if (!list.length && !box.querySelector('.empty')) {
    box.innerHTML = '<div class="empty">未发现运行中的脚本进程</div>';
  } else if (list.length) {
    const empty = box.querySelector('.empty');
    if (empty) empty.remove();
  }
}

/* ================= plugins ================= */

function createPluginNode(p) {
  const root = document.createElement('div');
  root.className = 'plugin';
  root.innerHTML = `<span class="plugin-dot" data-f="dot"></span>
    <div class="plugin-body">
      <div class="plugin-title">
        <b data-f="name"></b><em data-f="ver"></em>
        <span class="tag-proj" data-f="proj"></span>
        <span data-f="flag"></span>
      </div>
      <p data-f="desc"></p>
      <div class="plugin-caps" data-f="caps"></div>
    </div>
    <div class="plugin-actions">
      <button type="button" class="mini plugin-toggle" data-toggle-plugin="1" data-f="toggle"></button>
    </div>`;
  root.setAttribute('data-name', p.name);
  const toggle = root.querySelector('[data-toggle-plugin]');
  if (toggle) toggle.setAttribute('data-key', p.name);

  const refs = { root, last: {} };
  for (const el of root.querySelectorAll('[data-f]')) refs[el.getAttribute('data-f')] = el;
  return refs;
}

function patchPlugin(refs, p, state) {
  const last = refs.last;
  const enabled = p.enabled !== false;
  setClass(refs.root, 'plugin' + (enabled ? '' : ' disabled'));
  setClass(refs.dot, 'plugin-dot' + (p.armed && enabled ? ' armed' : ''));
  setText(refs.name, p.name);
  setText(refs.ver, p.version || '');

  const projectLabel = p.project || SCOPE_TEXT[p.scope] || '本地';
  const projClass = 'tag-proj' + (p.scope === 'project' ? ' own' : '');
  if (last.projClass !== projClass) {
    setClass(refs.proj, projClass);
    last.projClass = projClass;
  }
  setText(refs.proj, projectLabel);
  if (refs.proj.title !== (p.root || '')) refs.proj.title = p.root || '';

  const flagHTML = enabled ? '' : '<span class="flag flag-off">已关闭</span>';
  if (last.flag !== flagHTML) {
    setHTML(refs.flag, flagHTML);
    last.flag = flagHTML;
  }

  if (refs.toggle) {
    const label = enabled ? '关闭' : '启用';
    if (last.toggleLabel !== label) {
      setText(refs.toggle, label);
      last.toggleLabel = label;
    }
    setClass(refs.toggle, 'mini plugin-toggle' + (enabled ? '' : ' on'));
    const hint = enabled ? '关闭该插件（写入 settings.json，重载窗口后生效）' : '启用该插件（写入 settings.json，重载窗口后生效）';
    if (refs.toggle.title !== hint) refs.toggle.title = hint;
  }

  setText(refs.desc, p.description || '无描述');

  const caps = [];
  if (p.hooks && p.hooks.length) caps.push('hooks: ' + p.hooks.length);
  if (p.skills) caps.push('skills ' + p.skills);
  if (p.commands) caps.push('cmds ' + p.commands);
  if (p.agents) caps.push('agents ' + p.agents);
  const capsHTML = caps.map((c) => `<span class="cap">${esc(c)}</span>`).join('');
  if (last.caps !== capsHTML) {
    setHTML(refs.caps, capsHTML);
    last.caps = capsHTML;
  }

}

function renderPlugins(state) {
  const list = (state.plugins || []).slice(0, 40);
  $('pluginCount').textContent = list.length + ' 个';
  const box = $('plugins');
  const seen = new Set();
  for (const p of list) {
    seen.add(p.name);
    let refs = ui.dom.plugins.get(p.name);
    if (!refs) {
      refs = createPluginNode(p);
      ui.dom.plugins.set(p.name, refs);
    }
    patchPlugin(refs, p, state);
    box.appendChild(refs.root);
  }
  for (const [name, refs] of ui.dom.plugins) {
    if (!seen.has(name)) {
      refs.root.remove();
      ui.dom.plugins.delete(name);
    }
  }
  if (!list.length && !box.querySelector('.empty')) {
    box.innerHTML = '<div class="empty">未发现已安装插件</div>';
  } else if (list.length) {
    const empty = box.querySelector('.empty');
    if (empty) empty.remove();
  }
}

/* ================= per job logs ================= */

function nodesFor(attr, id) {
  return Array.from(document.querySelectorAll('[' + attr + ']')).filter((n) => n.getAttribute(attr) === id);
}

function paintLog(id) {
  const entry = ui.logCache.get(id);
  const bodies = nodesFor('data-log', id);
  if (!bodies.length) return;
  for (const body of bodies) {
    if (!entry) {
      if (body.textContent !== '加载中…') body.textContent = '加载中…';
      continue;
    }
    const text = entry.lines.length ? entry.lines.join('\n') : '(暂无输出)';
    if (body.textContent !== text) {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
      body.textContent = text;
      if ($('autoScroll').checked && atBottom) body.scrollTop = body.scrollHeight;
    }
  }
  const metas = nodesFor('data-log-meta', id);
  for (const meta of metas) {
    setText(meta, entry ? entry.lines.length + ' 行 · ' + fmtClock(entry.at) : '—');
  }
}

async function refreshLog(id) {
  try {
    const res = await fetch('/api/jobs/' + encodeURIComponent(id) + '/logs?tail=200', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const lines =
      data.lines && data.lines.length
        ? data.lines
        : (data.memoryTail || []).map((l) => '[' + l.level + '] ' + l.message);
    ui.logCache.set(id, { lines, at: Date.now() });
    paintLog(id);
  } catch (_) {
    /* keep the previous content */
  }
}

function toggleJob(id) {
  if (ui.expanded.has(id)) ui.expanded.delete(id);
  else {
    ui.expanded.add(id);
    refreshLog(id);
  }
  if (ui.snap) renderJobs(ui.snap);
}

/* ================= manual intervention ================= */

function overrideBadge(record) {
  if (!record) return '';
  const text = OVERRIDE_TEXT[record.action] || record.action;
  return `<span class="flag flag-${esc(record.action)}" title="${esc(record.note || '')}">${esc(text)}</span>`;
}

function actionPanel(kind, key, label, project, record, modes) {
  const options = Object.keys(modes || {})
    .map((m) => `<option value="${esc(m)}">${esc(modes[m])}</option>`)
    .join('');
  return `<div class="action-panel" data-panel="${esc(kind)}:${esc(key)}">
    <div class="ap-head">处置 <b>${esc(label)}</b>${project ? `<span class="tag-proj">${esc(project)}</span>` : ''}</div>
    <div class="ap-row">
      <label class="ap-label">替代方式</label>
      <select class="select" data-mode>${options}</select>
      <input class="ap-input" data-note placeholder="备注（可选）" maxlength="120" />
    </div>
    <div class="ap-row">
      <button class="ap-btn warn" type="button" data-submit="stall">标记卡住</button>
      <button class="ap-btn primary" type="button" data-submit="skip">跳过并改用上述方式</button>
      ${kind === 'process' ? '<button class="ap-btn danger" type="button" data-submit="kill">终止进程</button>' : ''}
      <button class="ap-btn ghost" type="button" data-cancel="1">取消</button>
      ${record ? '<button class="ap-btn ghost" type="button" data-undo="1">撤销标记</button>' : ''}
    </div>
  </div>`;
}

function actionUrl(kind, key) {
  return kind === 'process'
    ? '/api/processes/' + encodeURIComponent(key) + '/action'
    : '/api/plugins/' + encodeURIComponent(key) + '/action';
}

async function submitAction(panel, action) {
  if (!panel) return;
  const raw = panel.getAttribute('data-panel') || '';
  const sep = raw.indexOf(':');
  if (sep < 0) return;
  const kind = raw.slice(0, sep);
  const key = raw.slice(sep + 1);
  const modeEl = panel.querySelector('[data-mode]');
  const noteEl = panel.querySelector('[data-note]');
  const payload = {
    action,
    mode: modeEl ? modeEl.value : '',
    note: noteEl ? noteEl.value.trim() : ''
  };

  if (action === 'kill' && !window.confirm('确定终止进程 ' + key + '？该操作不可恢复。')) return;
  if (action === 'kill') payload.confirm = true;

  try {
    await fetch(actionUrl(kind, key), {
      method: action === 'undo' ? 'DELETE' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: action === 'undo' ? undefined : JSON.stringify(payload)
    });
  } catch (_) {
    /* offline: decision is simply not recorded */
  }

  ui.actionTarget = null;
  await refreshSnapshot();
}

/** Toggle a plugin in ~/.codebuddy/settings.json (takes effect on reload). */
async function togglePlugin(name) {
  const current = (ui.snap && (ui.snap.plugins || []).find((p) => p.name === name)) || null;
  const next = !(current && current.enabled !== false);
  try {
    await fetch('/api/plugins/' + encodeURIComponent(name) + '/enabled', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next })
    });
  } catch (_) {
    /* offline: state simply stays as it was */
  }
  await refreshSnapshot();
}

function bindIntervention() {
  for (const containerId of ['procs', 'plugins']) {
    const box = $(containerId);
    if (!box) continue;
    box.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-toggle-plugin]');
      if (toggle) {
        togglePlugin(toggle.getAttribute('data-key'));
        return;
      }
      const act = event.target.closest('[data-act]');
      if (act) {
        const kind = act.getAttribute('data-kind');
        const key = act.getAttribute('data-key');
        const same = !!ui.actionTarget && ui.actionTarget.kind === kind && String(ui.actionTarget.key) === String(key);
        ui.actionTarget = same ? null : { kind, key };
        if (ui.snap) {
          renderProcs(ui.snap);
          renderPlugins(ui.snap);
        }
        return;
      }
      if (event.target.closest('[data-cancel]')) {
        ui.actionTarget = null;
        if (ui.snap) {
          renderProcs(ui.snap);
          renderPlugins(ui.snap);
        }
        return;
      }
      const undo = event.target.closest('[data-undo]');
      if (undo) {
        submitAction(undo.closest('[data-panel]'), 'undo');
        return;
      }
      const submit = event.target.closest('[data-submit]');
      if (submit) submitAction(submit.closest('[data-panel]'), submit.getAttribute('data-submit'));
    });
  }
}
