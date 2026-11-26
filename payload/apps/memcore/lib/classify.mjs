/**
 * 记忆条目分类器（纯规则，零依赖）。
 *
 * 目标：把「一大段对话 / 规则 / 日志」按语义归到 ENTRY_TYPES 里的类型，
 * 每一条都能给出命中依据，便于人工复核 —— 记忆是长期资产，
 * 判错一条会一直错，所以宁可判不出来（unknown），也不要硬套。
 *
 * 类型与 store.mjs 的 ENTRY_TYPES 对齐：
 *   decision    选型/方案定稿
 *   constraint  红线、必须遵守
 *   habit       重复出现的做事方式
 *   lesson      踩坑与解法
 *   preference  风格/语言/格式偏好
 *   direction   任务方向（一般来自会话标题，不在这里判）
 */

/** 判据表：权重越高越可信；同一句命中多条时取总分最高者 */
const RULES = [
  {
    type: 'constraint',
    weight: 3,
    // 出现这些词基本可以确定是「必须遵守」，不是这次要做的事
    strong: /必须|务必|禁止|不允许|不得|只能|仅限|一律|统一使用|不得使用|红线|强制|绝不/,
    weak: /不要|无需|不用|默认|固定/,
    // 反例：说「不要」也可能是这次让我别做，配合任务动词时降权
    veto: /^(?:请|帮我|麻烦)?(?:不要|别)(?:再)?(?:改|动|删|提交|运行)/
  },
  {
    type: 'decision',
    weight: 3,
    strong: /决定|定为|定为方案|采用|选型|最终方案|确认为|改用|换成|方案是|结论是|敲定/,
    weak: /改为|使用|选择|优先|倾向/,
    veto: null
  },
  {
    type: 'lesson',
    weight: 3,
    strong: /踩坑|坑点|根因|根本原因|原因在于|导致|教训|下次注意|注意：|注意:|排查|定位到|已修复|修好了/,
    weak: /报错|失败|异常|不生效|无效|没有反应|卡住|崩溃/,
    veto: null
  },
  {
    type: 'habit',
    weight: 2,
    strong: /以后|之后|后续|每次|一律|始终|保持|统一|习惯|默认都|总是/,
    weak: /不要|必须|记得|记得要|先.*再/,
    veto: null
  },
  {
    type: 'preference',
    weight: 2,
    strong: /偏好|更喜欢|喜欢用|风格|口味|习惯用|倾向|不要花哨|简洁|统一风格/,
    weak: /中文|英文|字体|颜色|排版|注释|命名/,
    veto: null
  }
];

/** 明显是「这次要做什么」的动词：出现时大幅降低 habit/constraint 的可信度 */
const TASK_VERB =
  /增加|新增|加入|删除|改成|换成|调整|插入|填写|录入|点击|显示|补充|实现|合并|更换|保存|打开|启动|导出|导入|同步|调用|安装|升级|新建|创建|生成|上传|下载|移动|修复|重做/;

const QUESTION = /^(?:为(?:什么|啥)|怎么|如何|能否|是否|哪(?:个|些)|有没有)/;

/** 分句：记忆条目应该是短句，长段落先切开 */
export function splitClauses(text) {
  return String(text || '')
    .split(/[。；;！!？?\n]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * 归一化：去礼貌语、去 Markdown 标记、压空白。
 *
 * 规则文件里大量 `**加粗**`、`` `代码` ``、`| 表格 |` —— 不清理的话会原样进记忆，
 * 既难读也会干扰判据（`|` 与 `*` 会稀释主题词）。
 */
export function normalize(text) {
  return String(text || '')
    .replace(/^\s*(?:请|麻烦|帮我|帮忙|另外|还有|然后)[，,、\s]*/, '')
    .replace(/^\s*(?:[-*>]+|\d+[.)])\s*/, '') // 列表/引用/编号前缀
    .replace(/\*\*|__|`{1,3}/g, '') // 加粗、行内代码
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Markdown 链接只留文字
    .replace(/[|]+/g, ' ')
    .replace(/[\s，。；;,、!！?？~～"'“”‘’]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 明显不是「一句话记忆」的形态：表格行、纯符号、字段清单 */
export function isNoise(text) {
  const t = String(text || '');
  if (!t) return true;
  if (/^\|/.test(t)) return true;
  if ((t.match(/[|]/g) || []).length >= 2) return true;
  if (/^```/.test(t)) return true;
  if (/^[-=]{3,}$/.test(t)) return true;
  // 英文小写单词打头再接中文：多半是文档里的字段名/标题碎片（如 cause 根因 不是尝试过程）
  if (/^[a-z]{2,10}\s+[\u4e00-\u9fa5]/.test(t)) return true;
  // 符号占比过高的（JSON 片段、路径表、命令行）
  const symbols = (t.match(/[^\u4e00-\u9fa5a-zA-Z0-9]/g) || []).length;
  if (t.length >= 12 && symbols / t.length > 0.35) return true;
  return false;
}

/**
 * 给单句打分。
 * @returns {{type:string, score:number, hits:string[]}}
 */
export function classify(text) {
  const t = normalize(text);
  if (t.length < 6) return { type: 'unknown', score: 0, hits: ['太短'] };
  if (isNoise(t)) return { type: 'unknown', score: 0, hits: ['噪声'] };
  if (QUESTION.test(t)) return { type: 'unknown', score: 0, hits: ['疑问句'] };

  const hits = [];
  let best = { type: 'unknown', score: 0, hits: [] };

  for (const rule of RULES) {
    let score = 0;
    const local = [];

    if (rule.strong.test(t)) {
      score += rule.weight;
      local.push('强特征');
    }
    if (rule.weak.test(t)) {
      score += 1;
      local.push('弱特征');
    }
    if (!score) continue;

    // 否决：明显在描述「这次做什么」时压到 1 分以下
    if (rule.veto && rule.veto.test(t)) {
      score -= 2;
      local.push('否决');
    }
    if (TASK_VERB.test(t) && rule.type !== 'lesson') {
      score -= 1;
      local.push('任务动词降权');
    }
    // 太长的句子多半是叙述而不是约束
    if (t.length > 60) {
      score -= 1;
      local.push('过长降权');
    }

    if (score > best.score) best = { type: rule.type, score, hits: local };
    if (local.length) hits.push(rule.type + ':' + score);
  }

  return { type: best.type, score: best.score, hits: best.hits.length ? best.hits : hits };
}

/** 低于这个分数不产出条目，宁缺勿滥 */
export const MIN_SCORE = 2;

/**
 * 批量归类 + 去重。
 * @param {Array<{id,text,at,source,cwd}>} items
 * @returns {Array<{id,type,text,score,hits,at,source,cwd}>}
 */
export function classifyItems(items, options = {}) {
  const minScore = options.minScore == null ? MIN_SCORE : options.minScore;
  const out = [];
  const seen = new Set();

  for (const it of items || []) {
    const text = String(it.text || '');
    for (const clause of splitClauses(text)) {
      const norm = normalize(clause);
      if (norm.length < 8 || norm.length > 120) continue;

      if (isNoise(norm)) continue;
      const r = classify(clause);
      if (r.type === 'unknown' || r.score < minScore) continue;

      // 同类型下文本相同即视为同一条，保留最早出现的时间
      const key = r.type + '|' + norm;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        id: it.id ? it.id + '#' + norm.slice(0, 12) : 'c-' + (out.length + 1),
        type: r.type,
        text: norm,
        score: r.score,
        hits: r.hits,
        at: it.at || 0,
        source: it.source || 'unknown',
        cwd: it.cwd || ''
      });
    }
  }

  out.sort((a, b) => b.score - a.score || b.at - a.at);
  return out;
}
