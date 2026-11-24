/* CodeVault - static index viewer. No dependencies, no build step. */
'use strict';

const $ = (sel) => document.querySelector(sel);
const state = { data: null, current: null, query: '', filter: 'all', live: false };

const STATUS_TEXT = {
  active: '在用',
  usable: '可用',
  prototype: '原型',
  delivered: '已交付',
  archived: '归档',
  empty: '空目录'
};

/* Live dashboards served by the plugins; embedded as full-height frames. */
const EMBEDS = {
  __eco__: {
    app: 'eco',
    name: '实时看板 · Eco',
    sub: '任务进度 · 工具调用',
    url: 'http://127.0.0.1:57821/',
    desc: '运行中的任务、工具调用、进度百分比与人工处置（跳过 / 重试 / 终止）。',
    hint: 'node apps/eco/cli/eco.js server --daemon'
  },
  __tuner__: {
    app: 'tuner',
    name: '降温面板 · Tuner',
    sub: '内存回收 · 进程挂起',
    url: 'http://127.0.0.1:57822/',
    desc: 'IDE 内存占用、工作集回收、进程优先级与挂起/恢复控制。',
    hint: 'node tuner/server/tuner-server.js --port 57822'
  },
  __errvault__: {
    app: 'errvault',
    name: '报错库 · errvault',
    sub: '报错 / 卡死 / 拦截的解法索引',
    url: 'http://127.0.0.1:57911/',
    desc: '任务中遇到的报错、卡死、被系统拦截事件，连同根因与正确做法一起留档；下次遇到同类问题先在这里检索，不要从头试错。',
    hint: 'node apps/errvault/server.mjs --port 57911'
  }
};

/* Data views backed by the local server (script library, git snapshots). */
const VIEWS = {
  __settings__: {
    name: '设置',
    sub: '降耗配置 · 接口目录',
    api: null,
    desc: '降耗模块的可调参数，以及全部对外接口的写入 / 输出格式。'
  },
  __scripts__: {
    name: '工具脚本库',
    sub: '可复用脚本 · handdelete',
    api: '/api/scripts',
    desc: '所有测试与自动化脚本集中在此，按头部注释识别用途，随索引库一起做版本备份。'
  },
  __repos__: {
    name: '仓库与备份',
    sub: '本地快照 · git 状态',
    api: '/api/repos',
    desc: '各代码库的最近提交与未提交改动。改完代码后按下方命令提交，页面即可看到新快照。'
  }
};

const KIND_LABEL = { lib: '模块', tools: '工具', py: 'Python', tests: '测试' };

/* ------------------------------------------------------------------ utils */

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const KEYWORDS = new Set([
  'function', 'const', 'let', 'var', 'if', 'else', 'return', 'for', 'while', 'try', 'catch',
  'finally', 'new', 'class', 'case', 'break', 'switch', 'async', 'await', 'import', 'from',
  'export', 'require', 'throw', 'typeof', 'of', 'in', 'default', 'delete', 'continue', 'do',
  'instanceof', 'this', 'null', 'undefined', 'true', 'false', 'def', 'elif', 'pass', 'with', 'as'
]);

/** Minimal tokenizer: comments, strings and keywords only. */
function highlight(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += '<span class="c">' + esc(src.slice(i, stop)) + '</span>';
      i = stop;
      continue;
    }
    if (ch === '#') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += '<span class="c">' + esc(src.slice(i, stop)) + '</span>';
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) { j += 1; break; }
        if (src[j] === '\n' && ch !== '`') break;
        j += 1;
      }
      out += '<span class="s">' + esc(src.slice(i, j)) + '</span>';
      i = j;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
    if (word) {
      out += KEYWORDS.has(word[0]) ? '<span class="k">' + word[0] + '</span>' : word[0];
      i += word[0].length;
      continue;
    }
    out += esc(ch);
    i += 1;
  }
  return out;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ render */

function renderStats() {
  const list = state.data.projects;
  const live = list.filter((p) => p.status === 'active').length;
  const issues = list.reduce((n, p) => n + (p.issues || []).length, 0);
  const openIssues = list.reduce(
    (n, p) => n + (p.issues || []).filter((x) => x.status !== 'fixed').length,
    0
  );
  const fixed = issues - openIssues;

  $('#stats').innerHTML = [
    ['项目', list.length],
    ['在用', live],
    ['问题', issues],
    ['已修', fixed]
  ]
    .map(([k, v]) => '<div class="stat"><b>' + v + '</b><span>' + k + '</span></div>')
    .join('');
  $('#subtitle').textContent = state.data.subtitle || '';
  $('#footNote').textContent = '数据源 data/projects.json · 生成于 ' + (state.data.generatedAt || '-');
}

function matchProject(p) {
  if (state.filter !== 'all' && p.status !== state.filter) return false;
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    p.name, p.id, p.session, p.summary, p.kind, p.path,
    (p.stack || []).join(' '),
    (p.sections || []).map((s) => s.name + ' ' + s.desc + ' ' + (s.files || []).map((f) => f.p).join(' ')).join(' ')
  ].join(' ').toLowerCase();
  return hay.indexOf(q) >= 0;
}

/** 侧边栏分组标题（内联样式，免得为一个标题去改 style.css） */
function groupTitle(text) {
  const d = el('div');
  d.textContent = text;
  d.style.cssText =
    'padding:10px 12px 4px;font-size:11px;letter-spacing:.08em;' +
    'color:#7d8b9c;text-transform:uppercase;user-select:none;';
  return d;
}

function renderList() {
  const box = $('#list');
  box.innerHTML = '';
  const list = state.data.projects.filter(matchProject);

  // 面板与视图固定在最上面。
  // 它们不是「项目」，以前挂在 20 个项目后面，加了第三个面板后基本点不到。
  box.appendChild(groupTitle('面板 · 视图'));

  [...Object.keys(EMBEDS), ...Object.keys(VIEWS)].forEach((key) => {
    const cfg = EMBEDS[key] || VIEWS[key];
    const node = el('div', 'item' + (state.current === key ? ' on' : ''));
    const top = el('div', 'item-top');
    top.appendChild(el('span', 'dot live'));
    top.appendChild(el('span', 'item-name', cfg.name));
    node.appendChild(top);
    node.appendChild(el('div', 'item-sub', cfg.sub || '内嵌实时面板 · ' + cfg.app));
    node.addEventListener('click', () => select(key));
    box.appendChild(node);
  });

  const road = el('div', 'item' + (state.current === '__roadmap__' ? ' on' : ''));
  road.appendChild(el('div', 'item-name', '全局路线图'));
  road.appendChild(el('div', 'item-sub', '第 1 / 2 / 3 梯队修复计划'));
  road.addEventListener('click', () => select('__roadmap__'));
  box.appendChild(road);

  const head = groupTitle('项目 · ' + list.length);
  head.style.paddingTop = '16px';
  box.appendChild(head);

  if (!list.length) {
    box.appendChild(el('div', 'empty-state', '没有匹配的项目'));
    return;
  }

  list.forEach((p) => {
    const node = el('div', 'item' + (state.current === p.id ? ' on' : ''));
    const top = el('div', 'item-top');
    top.appendChild(el('span', 'dot ' + p.status));
    top.appendChild(el('span', 'item-name', p.name));
    node.appendChild(top);
    node.appendChild(el('div', 'item-sub', p.kind + ' · ' + (p.summary || '').slice(0, 34)));
    node.appendChild(el('div', 'item-sess', p.session));
    node.addEventListener('click', () => select(p.id));
    box.appendChild(node);
  });
}

function sectionBlock(sec) {
  const wrap = el('div', 'sec');
  const head = el('div', 'sec-head');
  head.appendChild(el('span', 'sec-name', sec.name));
  head.appendChild(el('span', 'sec-desc', sec.desc || ''));
  head.appendChild(el('span', 'sec-count', String((sec.files || []).length)));
  const body = el('div', 'sec-body');

  (sec.files || []).forEach((f) => {
    const row = el('div', 'file');
    row.appendChild(el('code', null, f.p));
    row.appendChild(el('span', null, f.note || ''));
    body.appendChild(row);
  });

  head.addEventListener('click', () => wrap.classList.toggle('open'));
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

function codeBlock(item) {
  const wrap = el('div', 'codewrap');
  const head = el('div', 'codehead');
  head.appendChild(el('span', null, item.p));
  head.appendChild(el('span', 'note', item.note || ''));

  if (state.live) {
    const btn = el('button', null, '查看完整文件');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '读取中…';
      try {
        const res = await fetch('/api/file?path=' + encodeURIComponent(item.p));
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'read failed');
        pre.innerHTML = highlight(data.text);
        btn.textContent = '已加载 ' + data.lines + ' 行';
      } catch (err) {
        btn.textContent = '读取失败';
        btn.title = String(err.message || err);
      }
    });
    head.appendChild(btn);
  }

  const pre = el('pre');
  pre.innerHTML = highlight(item.snippet || '');
  wrap.appendChild(head);
  wrap.appendChild(pre);
  return wrap;
}

function issueRows(issues) {
  const box = el('div');
  issues.forEach((it) => {
    const row = el('div', 'issue');
    row.appendChild(el('span', 'lv ' + it.level, it.level));
    row.appendChild(el('span', null, it.title));
    row.appendChild(el('span', 'st ' + (it.status === 'fixed' ? 'fixed' : 'open'),
      it.status === 'fixed' ? '已修' : '待办'));
    box.appendChild(row);
  });
  return box;
}

function renderDetail() {
  const box = $('#detail');
  box.innerHTML = '';
  box.classList.remove('embed');

  if (state.current === '__roadmap__') {
    renderRoadmap(box);
    return;
  }
  if (state.current === '__settings__') {
    renderSettings(box);
    return;
  }
  if (EMBEDS[state.current]) {
    renderEmbed(box, state.current);
    return;
  }
  if (VIEWS[state.current]) {
    renderStaticView(box, state.current);
    return;
  }
  const p = state.data.projects.find((x) => x.id === state.current);
  if (!p) {
    box.appendChild(el('div', 'empty-state', '从左侧选择一个项目'));
    return;
  }

  const hero = el('div', 'hero');
  hero.appendChild(el('h1', null, p.name));

  const badges = el('div', 'badges');
  badges.appendChild(el('span', 'badge kind', p.kind));
  badges.appendChild(el('span', 'badge', STATUS_TEXT[p.status] || p.status));
  (p.stack || []).forEach((s) => badges.appendChild(el('span', 'badge', s)));
  if (p.embed && EMBEDS['__' + p.embed + '__']) {
    const live = el('button', 'embed-btn', '打开实时面板');
    live.addEventListener('click', () => select('__' + p.embed + '__'));
    badges.appendChild(live);
  }
  hero.appendChild(badges);

  const desc = el('p', null, p.summary || '');
  desc.style.marginTop = '10px';
  hero.appendChild(desc);

  const kv = el('div', 'kv');
  kv.style.marginTop = '10px';
  const scale = p.scale || {};
  kv.innerHTML =
    '<span>文件 <b>' + (scale.files != null ? scale.files : '—') + '</b></span>' +
    '<span>规模 <b>' + (scale.loc ? scale.loc + ' 行' : '—') + '</b></span>' +
    '<span>主文件 <b>' + esc(scale.main || '—') + '</b></span>';
  hero.appendChild(kv);

  hero.appendChild(el('div', 'pathline', p.path));
  box.appendChild(hero);

  if ((p.build || []).length) {
    const card = el('div', 'card');
    card.appendChild(el('h2', null, '构建逻辑'));
    const ol = el('ol', 'steps');
    p.build.forEach((s) => ol.appendChild(el('li', null, s)));
    card.appendChild(ol);
    box.appendChild(card);
  }

  if ((p.sections || []).length) {
    const card = el('div', 'card');
    card.appendChild(el('h2', null, '分区与功能'));
    p.sections.forEach((s) => card.appendChild(sectionBlock(s)));
    box.appendChild(card);
  }

  if ((p.code || []).length) {
    const card = el('div', 'card');
    card.appendChild(el('h2', null, '功能代码'));
    p.code.forEach((c) => card.appendChild(codeBlock(c)));
    box.appendChild(card);
  }

  const issues = p.issues || [];
  if (issues.length) {
    const card = el('div', 'card');
    card.appendChild(el('h2', null, '问题清单'));
    card.appendChild(issueRows(issues));
    box.appendChild(card);
  }

  if ((p.changelog || []).length) {
    const card = el('div', 'card');
    card.appendChild(el('h2', null, '修改记录'));
    const log = el('div', 'log');
    p.changelog.forEach((c) => {
      const entry = el('div', 'log-entry');
      const meta = el('div', 'log-meta');
      meta.appendChild(el('span', 'log-ver', 'v' + c.version));
      meta.appendChild(el('span', 'log-date', c.date || ''));
      entry.appendChild(meta);
      const ul = el('ul');
      (c.items || []).forEach((i) => ul.appendChild(el('li', null, i)));
      entry.appendChild(ul);
      log.appendChild(entry);
    });
    card.appendChild(log);
    box.appendChild(card);
  }

  if (sectionsEmpty(p)) {
    const card = el('div', 'card');
    card.appendChild(el('h2', null, '说明'));
    card.appendChild(el('div', 'muted', '该项目无源码目录，仅有文档或成品交付物。'));
    box.appendChild(card);
  }
}

function sectionsEmpty(p) {
  return !(p.build || []).length && !(p.sections || []).length &&
    !(p.code || []).length && !(p.issues || []).length;
}

/** Full-height frame for a running plugin dashboard, with a one-click launcher. */
async function renderEmbed(box, key) {
  const cfg = EMBEDS[key];

  const hero = el('div', 'hero');
  hero.appendChild(el('h1', null, cfg.name));
  hero.appendChild(el('p', null, cfg.desc));

  const bar = el('div', 'embed-bar');
  const tag = el('span', 'badge', '检测中…');
  bar.appendChild(tag);
  const btn = el('button', 'embed-btn', '启动服务');
  btn.style.display = 'none';
  bar.appendChild(btn);
  const link = el('a', 'embed-link', '在新窗口打开');
  link.href = cfg.url;
  link.target = '_blank';
  link.rel = 'noopener';
  bar.appendChild(link);
  hero.appendChild(bar);
  box.appendChild(hero);

  const holder = el('div', 'embed-holder');
  box.appendChild(holder);

  const show = (online) => {
    holder.innerHTML = '';
    if (online) {
      box.classList.add('embed');
      tag.textContent = '在线';
      tag.className = 'badge ok';
      btn.style.display = 'none';
      const frame = document.createElement('iframe');
      frame.className = 'embed-frame';
      frame.src = cfg.url;
      frame.title = cfg.name;
      holder.appendChild(frame);
      return;
    }
    box.classList.remove('embed');
    tag.textContent = '离线';
    tag.className = 'badge';
    btn.style.display = '';
    btn.disabled = false;
    btn.textContent = '启动服务';
    const empty = el('div', 'embed-offline');
    empty.appendChild(el('div', 'offline-title', cfg.name + ' 未运行'));
    empty.appendChild(el('div', 'muted', '点击「启动服务」由 CodeVault 拉起本地进程，等价于手动执行：'));
    empty.appendChild(el('pre', null, cfg.hint || ('node ' + cfg.app)));
    holder.appendChild(empty);
  };

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '启动中…';
    try {
      const res = await fetch('/api/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: cfg.app })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'launch failed');
      show(true);
    } catch (err) {
      tag.textContent = '启动失败';
      btn.disabled = false;
      btn.textContent = '重试启动';
      btn.title = String(err.message || err);
    }
  });

  try {
    const res = await fetch('/api/services', { cache: 'no-store' });
    const data = await res.json();
    const info = data.apps && data.apps[cfg.app];
    // 端口以服务端返回为准：改 deploy.json 后这里自动跟随，前端不再硬编码
    if (info && info.url) {
      cfg.url = info.url;
      link.href = info.url;
    }
    show(Boolean(info && info.ok));
  } catch {
    show(false);
  }
}

/* ---------------------------------------------------- script library / repos */

function fmtBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function dataTable(headers, rows) {
  const table = el('table', 'grid');
  const thead = el('thead');
  const headRow = el('tr');
  headers.forEach((h) => headRow.appendChild(el('th', null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  rows.forEach((cells) => {
    const row = el('tr');
    cells.forEach((value, index) => {
      const td = el('td');
      if (index === 0 && typeof value === 'string') td.appendChild(el('code', null, value));
      else td.textContent = value == null ? '' : String(value);
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  return table;
}

function cmdHint(lines) {
  const wrap = el('div', 'cmd-hint');
  const pre = el('pre');
  pre.textContent = lines.join('\n');
  wrap.appendChild(pre);
  return wrap;
}

async function renderStaticView(box, key) {
  const cfg = VIEWS[key];
  const hero = el('div', 'hero');
  hero.appendChild(el('h1', null, cfg.name));
  hero.appendChild(el('p', null, cfg.desc));
  box.appendChild(hero);

  const holder = el('div');
  box.appendChild(holder);
  holder.appendChild(el('div', 'muted', '读取中…'));

  let data;
  try {
    const res = await fetch(cfg.api, { cache: 'no-store' });
    data = await res.json();
    if (!data.ok) throw new Error(data.error || 'load failed');
  } catch (err) {
    holder.innerHTML = '';
    holder.appendChild(el('div', 'muted', '读取失败：' + err.message + '（请用 start.cmd 启动本地服务）'));
    return;
  }

  holder.innerHTML = '';

  if (key === '__scripts__') {
    const vault = data.vault;
    const archive = data.archive || {};

    if (!vault) {
      holder.appendChild(
        el('div', 'muted',
          '未找到 ScriptVault 索引，先运行：node C:\\Users\\GH\\Desktop\\ScriptVault\\build-index.mjs')
      );
      return;
    }

    const summary = vault.summary || {};
    const overview = el('div', 'card');
    overview.appendChild(el('h2', null, '脚本库概览'));
    overview.appendChild(
      el('div', 'pathline', (vault.root || '') + ' · 索引生成于 ' + (vault.generatedAt || '—'))
    );
    const kv = el('div', 'kv');
    kv.innerHTML =
      '<span>模块 <b>' + (summary.modules || 0) + '</b></span>' +
      '<span>工具 <b>' + (summary.tools || 0) + '</b></span>' +
      '<span>测试 <b>' + (summary.tests || 0) + '</b></span>' +
      '<span>归档 <b>' + (archive.count || 0) + '</b></span>' +
      '<span>有说明 <b>' + (summary.documented || 0) + ' / ' + (summary.total || 0) + '</b></span>';
    overview.appendChild(kv);
    holder.appendChild(overview);

    const entries = vault.entries || [];
    const card = el('div', 'card');
    card.appendChild(el('h2', null, '分类索引 (' + entries.length + ')'));

    const chips = el('div', 'chips');
    card.appendChild(chips);

    const filter = document.createElement('input');
    filter.className = 'table-filter';
    filter.type = 'search';
    filter.placeholder = '按名称、分类或用途过滤…';
    card.appendChild(filter);

    const table = dataTable(
      ['名称', '分区', '分类', '用途', '更新'],
      entries.map((entry) => [
        entry.name,
        KIND_LABEL[entry.kind] || entry.kind,
        entry.category,
        entry.purpose || '（无说明）',
        entry.mtime
      ])
    );
    const wrap = el('div', 'table-wrap');
    wrap.appendChild(table);
    card.appendChild(wrap);

    let activeCategory = 'all';
    const rowsMeta = entries.map((entry) => entry.category);

    const applyFilter = () => {
      const query = filter.value.trim().toLowerCase();
      const body = table.querySelector('tbody');
      Array.from(body.rows).forEach((row, index) => {
        const categoryOk = activeCategory === 'all' || rowsMeta[index] === activeCategory;
        const textOk = !query || row.textContent.toLowerCase().indexOf(query) >= 0;
        row.style.display = categoryOk && textOk ? '' : 'none';
      });
    };

    const chipList = [{ id: 'all', label: '全部', count: entries.length }].concat(vault.categories || []);
    chipList.forEach((item) => {
      const chip = el('button', 'chip' + (item.id === 'all' ? ' on' : ''), item.label + ' ' + item.count);
      chip.addEventListener('click', () => {
        activeCategory = item.id;
        for (const node of chips.querySelectorAll('.chip')) node.classList.remove('on');
        chip.classList.add('on');
        applyFilter();
      });
      chips.appendChild(chip);
    });

    filter.addEventListener('input', applyFilter);
    holder.appendChild(card);

    const note = el('div', 'card');
    note.appendChild(el('h2', null, '归档与约定'));
    note.appendChild(
      el('div', 'muted',
        '新脚本一律进 ScriptVault（lib / tools / tests）；旧目录 handdelete 保留 ' + (archive.count || 0) +
        ' 个历史脚本（有头部说明 ' + (archive.documented || 0) + '），只做快照不再新增。')
    );
    note.appendChild(cmdHint([
      '# 新增工具（自动带标准头部）',
      'cd C:\\Users\\GH\\Desktop\\ScriptVault',
      'node tools/scaffold.mjs my-tool --purpose "..." --category web',
      'node build-index.mjs && git add -A && git commit -m "feat: my-tool"'
    ]));
    holder.appendChild(note);
    return;
  }

  const card = el('div', 'card');
  card.appendChild(el('h2', null, '仓库 (' + (data.repos || []).length + ')'));
  const rows = (data.repos || []).map((r) => [
    r.name,
    r.path,
    r.tracked ? r.hash + ' ' + (r.subject || '') : '（未初始化）',
    r.tracked ? r.date : '—',
    r.tracked ? String(r.dirty) : '—'
  ]);
  card.appendChild(dataTable(['仓库', '路径', '最近提交', '日期', '未提交'], rows));
  holder.appendChild(card);

  const note = el('div', 'card');
  note.appendChild(el('h2', null, '备份流程'));
  note.appendChild(el('div', 'muted', '改完代码 → 刷新索引 → 提交对应仓库。规则已写入全局 rules，任务收尾会自动执行。'));
  note.appendChild(cmdHint([
    'node C:\\Users\\GH\\Desktop\\CodeVault\\tools\\scan.mjs',
    'cd <仓库根>',
    'git add -A && git commit -m "chore: <说明>"'
  ]));
  holder.appendChild(note);
}

function renderRoadmap(box) {
  box.appendChild(el('h1', 'hero-title', '全局路线图'));
  const card = el('div', 'card');
  card.appendChild(el('h2', null, '全局路线图'));
  (state.data.roadmap || []).forEach((tier) => {
    const wrap = el('div', 'tier');
    const done = /已完成/.test(tier.tier);
    wrap.appendChild(el('h3', done ? 'done' : '', tier.tier));
    const ul = el('ul');
    tier.items.forEach((i) => ul.appendChild(el('li', null, i)));
    wrap.appendChild(ul);
    card.appendChild(wrap);
  });
  box.appendChild(card);
}

/* ------------------------------------------------------------------ actions */

function select(id) {
  state.current = id;
  location.hash = id;
  renderList();
  renderDetail();
  if (id) $('#detail').scrollTop = 0;
}

function bindTools() {
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
  });
  $('#filter').addEventListener('change', (e) => {
    state.filter = e.target.value;
    renderList();
  });
  window.addEventListener('hashchange', () => {
    const id = location.hash.replace(/^#/, '');
    if (id && id !== state.current) {
      state.current = id;
      renderList();
      renderDetail();
    }
  });
}

async function probeLive() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    state.live = res.ok;
  } catch {
    state.live = false;
  }
}

async function boot() {
  bindTools();
  await probeLive();
  try {
    const res = await fetch('data/projects.json', { cache: 'no-store' });
    state.data = await res.json();
  } catch (err) {
    $('#detail').innerHTML =
      '<div class="empty-state">无法读取 data/projects.json。<br>' +
      '浏览器直接打开 file:// 页面会因同源策略失败，请运行 <b>start.cmd</b> 用本地服务打开。</div>';
    return;
  }
  renderStats();
  const hash = location.hash.replace(/^#/, '');
  const known =
    hash &&
    (state.data.projects.some((p) => p.id === hash) ||
      EMBEDS[hash] ||
      VIEWS[hash] ||
      hash === '__roadmap__');
  const first = known ? hash : state.data.projects[0].id;
  state.current = first;
  renderList();
  renderDetail();
}

/* ---------------------------------------------------- 设置：降耗配置 + 接口目录 */

/** 弹窗展示某个接口的请求 / 响应格式 */
function showApiFormat(group, ep) {
  const mask = el('div', 'api-mask');
  const dlg = el('div', 'api-dlg');

  const head = el('div', 'api-dlg-head');
  head.appendChild(el('strong', null, ep.method + ' ' + ep.path));
  const close = el('button', 'btn btn-ghost', '关闭');
  head.appendChild(close);
  dlg.appendChild(head);

  const sub = el('div', 'muted');
  sub.textContent = (group.title || '') + ' · ' + (ep.name || '');
  dlg.appendChild(sub);

  const block = (title, value) => {
    dlg.appendChild(el('div', 'api-sec-title', title));
    const pre = document.createElement('pre');
    pre.className = 'api-pre';
    pre.textContent = value == null ? '（无）' : JSON.stringify(value, null, 2);
    dlg.appendChild(pre);
  };
  block('请求体', ep.request);
  block('响应体', ep.response);
  if (ep.curl) {
    dlg.appendChild(el('div', 'api-sec-title', '命令行示例'));
    const pre = document.createElement('pre');
    pre.className = 'api-pre';
    // 目录里的 {port} 在渲染时换成该分组的真实端口：
    // 用户改过端口后示例仍然可用，不会指着一个不存在的地址
    pre.textContent = String(ep.curl).replace(/\{port\}/g, group.resolvedPort || '');
    dlg.appendChild(pre);
  }

  mask.appendChild(dlg);
  mask.addEventListener('click', (ev) => {
    if (ev.target === mask) mask.remove();
  });
  close.addEventListener('click', () => mask.remove());
  document.body.appendChild(mask);
}

async function renderSettings(box) {
  box.innerHTML = '';

  /* ---- 降耗模块配置 ---- */
  const card = el('div', 'set-card');
  card.appendChild(el('h2', 'set-title', '降耗模块 · Eco'));
  card.appendChild(
    el('div', 'muted', '采样间隔与降耗阈值。保存后立即生效（写入 apps/eco/.eco/settings.json）。')
  );

  let cfg = {};
  let platforms = [];
  try {
    const j = await (await fetch('/api/config', { cache: 'no-store' })).json();
    cfg = j.config || {};
    platforms = j.platforms || [];
  } catch (_) {
    card.appendChild(el('div', 'warn-line', '读取配置失败：Eco 可能未运行。'));
  }

  const fields = [
    { k: 'scanIntervalMs', label: '采样间隔 (ms)', min: 1000, max: 60000, step: 500 },
    { k: 'cpuThreshold', label: 'CPU 阈值 (%)', min: 5, max: 100, step: 1 },
    { k: 'memThresholdMB', label: '内存阈值 (MB)', min: 256, max: 65536, step: 128 },
    { k: 'trimCooldownMs', label: '降耗冷却 (ms)', min: 10000, max: 3600000, step: 5000 }
  ];

  const form = el('div', 'set-form');
  const inputs = {};
  fields.forEach((f) => {
    const row = el('label', 'set-row');
    row.appendChild(el('span', 'set-label', f.label));
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'set-input';
    inp.min = String(f.min);
    inp.max = String(f.max);
    inp.step = String(f.step);
    inp.value = cfg[f.k] == null ? '' : String(cfg[f.k]);
    inputs[f.k] = inp;
    row.appendChild(inp);
    form.appendChild(row);
  });

  const rowT = el('label', 'set-row');
  rowT.appendChild(el('span', 'set-label', '允许自动降耗'));
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.checked = cfg.autoTrim !== false;
  inputs.autoTrim = chk;
  rowT.appendChild(chk);
  form.appendChild(rowT);

  if (platforms.length) {
    const rowP = el('div', 'set-row');
    rowP.appendChild(el('span', 'set-label', '已登记平台'));
    const chips = el('div', 'chips');
    platforms.forEach((p) => chips.appendChild(el('span', 'chip', p.label || p)));
    rowP.appendChild(chips);
    form.appendChild(rowP);
  }
  card.appendChild(form);

  const bar = el('div', 'set-actions');
  const btnSave = el('button', 'btn', '保存配置');
  const status = el('span', 'muted');
  bar.appendChild(btnSave);
  bar.appendChild(status);
  card.appendChild(bar);
  box.appendChild(card);

  btnSave.addEventListener('click', async () => {
    const payload = {};
    fields.forEach((f) => {
      payload[f.k] = Number(inputs[f.k].value);
    });
    payload.autoTrim = inputs.autoTrim.checked;
    btnSave.disabled = true;
    status.textContent = '保存中…';
    try {
      const j = await (
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        })
      ).json();
      status.textContent = j.ok ? '已保存并生效' : '失败：' + (j.error || '未知错误');
    } catch (e) {
      status.textContent = '失败：' + e.message;
    } finally {
      btnSave.disabled = false;
    }
  });

  /* ---- 接口目录 ---- */
  const apiCard = el('div', 'set-card');
  apiCard.appendChild(el('h2', 'set-title', '接口目录 · 写入与输出格式'));
  apiCard.appendChild(
    el('div', 'muted', '每个接口标注方法、路径与请求/响应格式；点右侧「查看格式」看完整示例。')
  );

  let catalog = null;
  try {
    catalog = await (await fetch('/api/catalog', { cache: 'no-store' })).json();
  } catch (_) {
    apiCard.appendChild(el('div', 'warn-line', '读取接口目录失败。'));
  }

  ((catalog && catalog.groups) || []).forEach((g) => {
    const grp = el('div', 'set-group');
    grp.appendChild(el('div', 'set-group-title', g.title + (g.resolvedPort ? '  :' + g.resolvedPort : '')));
    if (g.desc) grp.appendChild(el('div', 'muted', g.desc));

    (g.endpoints || []).forEach((ep) => {
      const row = el('div', 'api-row');
      const left = el('div', 'api-left');
      const line = el('div', 'api-line');
      line.appendChild(el('span', 'api-method ' + String(ep.method).toLowerCase(), ep.method));
      line.appendChild(el('code', 'api-path', ep.path));
      line.appendChild(el('span', 'api-name', ep.name || ''));
      left.appendChild(line);
      if (ep.desc) left.appendChild(el('div', 'muted', ep.desc));
      row.appendChild(left);

      const btn = el('button', 'btn btn-ghost', '查看格式');
      btn.addEventListener('click', () => showApiFormat(g, ep));
      row.appendChild(btn);
      grp.appendChild(row);
    });

    apiCard.appendChild(grp);
  });
  box.appendChild(apiCard);
}

boot();
