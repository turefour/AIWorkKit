/**
 * memcore 渲染层：把「原始事件 + 人工条目」压成两份可读产物。
 *
 *   MEMORY.md    完整记忆（按需读取，预算 memoryBudget）
 *   memcore.mdc  自动注入规则（每会话都进上下文，预算 tier1Budget）
 *
 * 两级分层的理由：全量塞进系统提示要几百 token × 每个会话，
 * 所以常驻层只放「不变的习惯 + 当前方向」，细节靠 show / search 现场取。
 */

import { estTokens } from './extract.mjs';

const pad2 = (n) => String(n).padStart(2, '0');

export function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

export function fmtShort(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

const MAX_PER_TYPE = 6;

/** 长期条目：constraint > habit > preference，同权重看新鲜度。 */
function longTermNotes(notes) {
  const rank = { constraint: 3, habit: 2, preference: 1 };
  return notes
    .filter((n) => rank[n.type])
    .slice()
    .sort(
      (a, b) =>
        (rank[b.type] - rank[a.type]) ||
        (b.weight || 3) - (a.weight || 3) ||
        String(b.updatedAt).localeCompare(String(a.updatedAt))
    )
    .slice(0, MAX_PER_TYPE);
}

function byType(notes, type, limit) {
  return notes
    .filter((n) => n.type === type)
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
}

/** 按「## 」切块，便于按预算整段丢弃。 */
function trimSections(lines, budget, dropOrder) {
  let text = lines.join('\n') + '\n';
  if (text.length <= budget) return text;

  const work = lines.slice();
  for (const header of dropOrder) {
    const i = work.indexOf(header);
    if (i < 0) continue;
    let j = i + 1;
    while (j < work.length && !work[j].startsWith('## ')) j += 1;
    work.splice(i, j - i);
    text = work.join('\n') + '\n';
    if (text.length <= budget) return text;
  }
  return text.slice(0, budget).replace(/\n[^\n]*$/, '\n');
}

/**
 * 生成 MEMORY.md。
 * ctx: { store, habits, directions, keywords, actions, prefixes, cfg, home, cliHint }
 */
export function renderMemory(ctx) {
  const { store, habits, directions, keywords, actions, prefixes, cfg, home, cliHint } = ctx;
  const notes = store.notes || [];
  const sessions = store.sessions || {};
  const messages = store.messages || [];
  const now = Date.now();

  const totalChars = messages.reduce((a, m) => a + m.x.length, 0);
  const cjkRatio = totalChars ? ctx.cjkRatio : 0;

  const lines = [];
  const push = (...xs) => lines.push(...xs);

  push(
    '# 全局任务记忆（memcore）',
    '',
    '> 统一归档：`' + home + '` ｜ 生成 ' + fmtDate(now) + ' ｜ 会话 ' + Object.keys(sessions).length +
      ' ／指令 ' + messages.length + ' ／条目 ' + notes.length,
    '> 读取 `' + cliHint + ' show` ｜ 检索 `' + cliHint + ' search <词>` ｜ 写入 `' + cliHint + ' note add ...`',
    '',
    '## 长期约束与习惯',
    ''
  );

  const lt = longTermNotes(notes);
  if (lt.length) {
    for (const n of lt) push('- [' + n.type + '] ' + n.text + (n.count > 1 ? '（×' + n.count + '）' : ''));
  } else if (habits.length) {
    for (const h of habits.slice(0, 6)) push('- [inferred] ' + h.text + (h.hits > 1 ? '（×' + h.hits + '）' : ''));
  } else {
    push('- （待积累：`note add --type constraint ...` 或继续对话后自动抽取）');
  }
  push('');

  push('## 任务方向', '');
  const dirNotes = byType(notes, 'direction', 5);
  for (const n of dirNotes) push('- [direction] ' + n.text);
  const titles = directions.items.slice(0, dirNotes.length ? 5 : 8);
  for (const it of titles) push('- ' + fmtShort(it.ts) + ' ' + (it.title.length > 40 ? it.title.slice(0, 40) + '…' : it.title));
  if (!dirNotes.length && !titles.length) push('- 暂无');
  if (directions.topics.length) push('- 主题词：' + directions.topics.map((t) => t.k + '(' + t.n + ')').join(' · '));
  push('');

  push('## 近期任务收尾', '');
  const ends = byType(notes, 'task-end', 3);
  if (ends.length) {
    for (const n of ends) push('- ' + String(n.at).slice(5, 10) + ' ' + n.text);
  } else {
    push('- 暂无（收尾时追加：`note add --type task-end --text "目标/产出/验证/未完成"`）');
  }
  push('');

  push('## 决策与经验', '');
  const de = [...byType(notes, 'decision', 3), ...byType(notes, 'lesson', 3)];
  if (de.length) {
    for (const n of de) push('- [' + n.type + '] ' + n.text);
  } else {
    push('- 暂无（踩坑结论请先记 errvault，这里只留一句可用结论）');
  }
  push('');

  push('## 用户画像', '');
  push(
    '- ' +
      (cjkRatio >= 0.5 ? '中文为主交流（' + (cjkRatio * 100).toFixed(0) + '%）' : '中英混用（' + (cjkRatio * 100).toFixed(0) + '%）') +
      (prefixes.length ? '；前缀分流：' + prefixes.join(' / ') : '')
  );
  push('- 平均单条指令 ' + (messages.length ? Math.round(totalChars / messages.length) : 0) + ' 字，倾向一次给全上下文');
  push('- 高频诉求：' + (actions.length ? actions.map(([a, n]) => a + '×' + n).join(' · ') : '暂无'));
  push('');

  push('## 关键词', '');
  push(keywords.length ? '- ' + keywords.map(([k, n]) => k + '(' + n + ')').join(' · ') : '- 暂无');
  push('');

  push('## 归档约定', '');
  push('- 原始事件：`store.json`（只含用户侧指令与会话元数据，保留 ' + cfg.keepDays + ' 天 / ' + cfg.keepMessages + ' 条）');
  push('- 人工条目：`store.json→notes` + 追加式镜像 `archive/notes-YYYYMM.jsonl`');
  push('- 运行日志：`logs/memcore-YYYYMM.log`');
  push('- 本文件与 `memcore.mdc` 都是产物，重新 `build` 会覆盖；要长期保留的事实请写成 note');

  const dropOrder = ['## 关键词', '## 决策与经验', '## 近期任务收尾', '## 用户画像', '## 归档约定'];
  return trimSections(lines, cfg.memoryBudget, dropOrder);
}

/** 生成 memcore.mdc：常驻层，只放最稳的内容。 */
export function renderRule(ctx) {
  const { store, habits, directions, cfg, home, cliHint } = ctx;
  const notes = store.notes || [];
  const now = Date.now();

  const head = [
    '---',
    'description: 全局任务记忆（memcore 自动生成）：用户的长期习惯、约束与当前任务方向；跨项目任务开始前先参考本文件',
    'alwaysApply: true',
    '---',
    '',
    '# 全局任务记忆 · ' + fmtDate(now),
    ''
  ];
  const habitLines = longTermNotes(notes)
    .slice(0, 6)
    .map((n) => '- ' + n.text + (n.count > 1 ? '（×' + n.count + '）' : ''));
  // 人工条目优先，空出来的位置用自动抽取的习惯补满：两者不是二选一
  for (const h of habits.slice(0, Math.max(0, 6 - habitLines.length))) {
    habitLines.push('- ' + h.text + (h.hits > 1 ? '（×' + h.hits + '）' : ''));
  }
  if (!habitLines.length) habitLines.push('- （待积累）');

  const dirLines = byType(notes, 'direction', 3).map((n) => '- ' + n.text);
  for (const it of directions.items.slice(0, dirLines.length ? 2 : 5)) {
    const t = it.title.length > 24 ? it.title.slice(0, 24) + '…' : it.title;
    dirLines.push('- ' + fmtShort(it.ts) + ' ' + t);
  }
  if (!dirLines.length) dirLines.push('- （待积累）');

  // 常驻层每会话都要付 token，命令只写一次入口 + 子命令名，完整用法在 deploy-target.mdc §2.2
  const foot = '> 归档 `' + home + '` ｜ `' + cliHint + '`（show / search <词> / note add --type …）';

  const compose = (hs, ds) =>
    head
      .concat(['## 长期约束与习惯', ...hs, '', '## 当前任务方向', ...ds, '', foot])
      .join('\n') + '\n';

  let out = compose(habitLines, dirLines);
  while (out.length > cfg.tier1Budget && habitLines.length + dirLines.length > 2) {
    if (habitLines.length >= dirLines.length && habitLines.length > 1) habitLines.pop();
    else if (dirLines.length > 1) dirLines.pop();
    else habitLines.pop();
    out = compose(habitLines, dirLines);
  }
  return out;
}

export const estimate = estTokens;
