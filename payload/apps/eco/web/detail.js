'use strict';

/**
 * AIWorkKit Eco - process / flow detail window.
 *
 * Clicking a process row (or the "源码" button on a flow card) opens a modal with:
 *   - the entry script source with line numbers
 *   - below it: progress, status, CPU / memory, command line and the flow log
 *
 * Only one window exists; it refreshes metrics + log every 2s and reloads the
 * source only when the file's mtime changes.
 */

const detailState = {
  target: null,
  timer: null,
  meta: null,
  mtime: 0
};

function detailEls() {
  return detailState.els || null;
}

function ensureDetail() {
  if (detailState.els) return detailState.els;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.hidden = true;
  mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <header class="m-head">
        <div class="m-title">
          <b data-f="title">—</b>
          <span class="tag-proj" data-f="proj"></span>
          <span class="status-tag" data-f="status"></span>
        </div>
        <div class="m-head-right">
          <span class="muted" data-f="sub"></span>
          <button class="mini" type="button" data-close="1">关闭 ✕</button>
        </div>
      </header>
      <div class="m-code">
        <div class="m-code-head">
          <span data-f="path">—</span>
          <span class="muted" data-f="codeMeta"></span>
        </div>
        <pre class="m-pre" data-f="code">（未找到脚本文件）</pre>
      </div>
      <div class="m-info">
        <div class="m-progress">
          <div class="m-bar"><i data-f="bar"></i></div>
          <div class="m-progress-meta" data-f="progress"></div>
        </div>
        <div class="kv-grid" data-f="kv"></div>
        <div class="m-command" data-f="cmd"></div>
        <div class="m-log-wrap">
          <div class="m-log-head">运行日志 <span class="muted" data-f="logMeta"></span></div>
          <pre class="m-log" data-f="logs">（暂无输出）</pre>
        </div>
      </div>
    </div>`;

  document.body.appendChild(mask);
  const els = { mask };
  for (const el of mask.querySelectorAll('[data-f]')) els[el.getAttribute('data-f')] = el;
  els.modal = mask.querySelector('.modal');

  mask.addEventListener('click', (event) => {
    if (event.target === mask || event.target.closest('[data-close]')) closeDetail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !mask.hidden) closeDetail();
  });

  detailState.els = els;
  return els;
}

function renderCode(els, script, force) {
  if (!script) {
    if (force) {
      els.path.textContent = '未能定位脚本文件';
      els.codeMeta.textContent = '';
      els.code.textContent = '命令由内联代码（-e / -c）启动，或脚本路径为相对路径且不在工作目录下。';
      els.code.className = 'm-pre m-pre-empty';
    }
    return;
  }
  if (!force && script.mtimeMs && script.mtimeMs === detailState.mtime) return;
  detailState.mtime = script.mtimeMs || 0;

  els.path.textContent = script.path;
  els.path.title = script.path;
  const meta = [];
  if (script.language) meta.push(script.language);
  if (script.totalLines) meta.push(script.totalLines + ' 行');
  if (script.size) meta.push(Math.round(script.size / 102.4) / 10 + ' KB');
  if (script.truncated) meta.push('已截断（仅显示前 ' + script.lines.length + ' 行）');
  if (script.reason) meta.push(script.reason);
  els.codeMeta.textContent = meta.join(' · ');

  els.code.className = 'm-pre';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < script.lines.length; i += 1) {
    const row = document.createElement('div');
    row.className = 'm-line';
    const ln = document.createElement('span');
    ln.className = 'm-ln';
    ln.textContent = String(i + 1);
    const src = document.createElement('span');
    src.className = 'm-src';
    src.textContent = script.lines[i] || ' ';
    row.append(ln, src);
    frag.appendChild(row);
  }
  els.code.textContent = '';
  els.code.appendChild(frag);
}

function renderInfo(els, data) {
  const job = data.job;
  const proc = data.process;
  const els2 = els;

  els2.title.textContent = (proc && proc.name ? proc.name : job ? job.label : '流程') + (proc ? ' · pid ' + proc.pid : '');
  const projName = (data.project && data.project.name) || '';
  els2.proj.textContent = projName || '外部进程';
  els2.proj.title = (data.project && data.project.path) || '';

  const status = job ? job.status : proc && proc.override ? proc.override.action : 'running';
  els2.status.className = 'status-tag status-' + (STATUS_TEXT[status] ? status : 'running');
  els2.status.textContent = job
    ? STATUS_TEXT[job.status] || job.status
    : proc && proc.override
    ? OVERRIDE_TEXT[proc.override.action] || '已标记'
    : '运行中';

  const sub = [];
  if (proc) sub.push('pid ' + proc.pid);
  if (job && job.source) sub.push(job.source);
  els2.sub.textContent = sub.join(' · ');

  // progress
  const pct = job && job.percent != null ? job.percent : null;
  els2.bar.style.width = (pct == null ? 0 : Math.max(0, Math.min(100, pct))) + '%';
  els2.bar.parentElement.classList.toggle('indeterminate', pct == null);
  const parts = [];
  if (pct != null) parts.push('<b>' + pct + '%</b>');
  if (job && job.current != null) parts.push(job.current + ' / ' + (job.total != null ? job.total : '?') + ' ' + (job.unit || ''));
  if (job && job.rate != null) parts.push((job.rate > 0 ? '▲ ' : '▼ ') + Math.abs(job.rate) + '/s');
  if (job && job.etaMs != null) parts.push('剩余 ' + fmtEta(job.etaMs));
  if (job && job.elapsedMs != null) parts.push('已用 ' + fmtDuration(job.elapsedMs));
  if (!parts.length) parts.push('该进程未关联可量化流程');
  els2.progress.innerHTML = parts.map((p) => '<span>' + p + '</span>').join('');

  // metrics grid
  const cells = [];
  const push = (k, v) => cells.push('<div class="kv"><span>' + k + '</span><b>' + esc(v) + '</b></div>');
  if (proc) {
    push('CPU', proc.cpuPercent == null ? '—' : proc.cpuPercent + '%');
    push('内存', fmtMem(proc.memMB));
    push('已运行', fmtDuration(proc.uptimeMs));
    push('角色', proc.role);
  }
  if (job) {
    push('会话', (job.sessionId || 'local').slice(0, 16));
    push('开始', fmtClock(job.startedAt));
    if (job.endedAt) push('结束', fmtClock(job.endedAt));
    if (job.steps && job.steps.length) {
      push('步骤', job.steps.filter((s) => s.status === 'completed').length + ' / ' + job.steps.length);
    }
  }
  if (!cells.length) push('状态', '无运行数据');
  els2.kv.innerHTML = cells.join('');

  els2.cmd.innerHTML = data.command ? '<span>命令</span><code>' + esc(data.command) + '</code>' : '';
  els2.cmd.style.display = data.command ? '' : 'none';

  const logs = data.logs && data.logs.lines ? data.logs.lines : [];
  els2.logMeta.textContent = logs.length + ' 行' + (data.logs && data.logs.exists ? '' : '（无日志文件）');
  const tail = logs.slice(-200);
  const text = tail.length ? tail.join('\n') : '（暂无输出）';
  if (els2.logs.textContent !== text) {
    const atBottom = els2.logs.scrollHeight - els2.logs.scrollTop - els2.logs.clientHeight < 24;
    els2.logs.textContent = text;
    if (atBottom) els2.logs.scrollTop = els2.logs.scrollHeight;
  }
}

async function fetchDetail(target) {
  const url = target.pid
    ? '/api/processes/' + encodeURIComponent(target.pid) + '/detail'
    : '/api/jobs/' + encodeURIComponent(target.jobId) + '/detail';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function refreshDetail(forceCode) {
  if (!detailState.target) return;
  try {
    const data = await fetchDetail(detailState.target);
    renderInfo(detailState.els, data);
    renderCode(detailState.els, data.script, forceCode);
    // keep following the resolved pid when opened from a flow card
    if (!detailState.target.pid && data.process) detailState.target.pid = data.process.pid;
  } catch (err) {
    detailState.els.sub.textContent = '刷新失败：' + err.message;
  }
}

async function openDetail(target) {
  const els = ensureDetail();
  detailState.target = { pid: target.pid || 0, jobId: target.jobId || '' };
  detailState.mtime = 0;
  els.mask.hidden = false;
  els.title.textContent = '加载中…';
  els.sub.textContent = '';
  if (detailState.timer) clearInterval(detailState.timer);
  await refreshDetail(true);
  detailState.timer = setInterval(() => refreshDetail(false), 2000);
}

function closeDetail() {
  if (!detailState.els) return;
  detailState.els.mask.hidden = true;
  detailState.target = null;
  if (detailState.timer) {
    clearInterval(detailState.timer);
    detailState.timer = null;
  }
}
