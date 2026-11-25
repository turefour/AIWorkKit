/**
 * memcore 抽取规则（纯规则、零依赖）。
 *
 * 设计取舍：不训练模型、不引分词库，只做「可解释的规则抽取」——
 * 记忆是长期资产，错一条会一直错，宁可少抽也不能乱抽。
 * 每条抽取结果都能回溯到原文，便于人工复核。
 */

const CJK = /[\u4e00-\u9fa5]/g;

export const cjkCount = (s) => (String(s).match(CJK) || []).length;

/** 粗估 token：中文 1 字≈0.6 token，其余按 4 字符 1 token。 */
export const estTokens = (s) => Math.round(cjkCount(s) * 0.6 + String(s).replace(CJK, '').length / 4);

export function bigrams(s) {
  const out = [];
  const text = String(s).toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ');
  for (const chunk of text.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[\u4e00-\u9fa5]+$/.test(chunk)) {
      for (let i = 0; i + 1 < chunk.length; i += 1) out.push(chunk.slice(i, i + 2));
    } else if (/^[a-z][a-z0-9.+#-]{2,}$/.test(chunk)) {
      out.push(chunk);
    }
  }
  return out;
}

export function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return String(a) === String(b) ? 1 : 0;
  const bag = new Map();
  for (const x of A) bag.set(x, (bag.get(x) || 0) + 1);
  let hit = 0;
  for (const x of B) {
    const n = bag.get(x) || 0;
    if (n > 0) {
      hit += 1;
      bag.set(x, n - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

/* ---------------------------------------------------------------- 停用词 */

const STOP = new Set(
  (
    '的 了 是 我 你 他 在 和 也 就 都 要 把 这 那 个 上 下 里 有 没有 不 一个 可以 现在 然后 还是 但 但是 如果 因为 所以 需要 进行 已经 一些 这样 那样 什么 怎么 如何 目前 当前 这个 那个 以及 并且 或者 之后 之前 同时 直接 全部 所有 文件 代码 程序 功能 问题 情况 时候 地方 东西 一下 一点 应该 可能 是否 通过 使用 查看 出现 存在 增加 修改 生成 处理 完成 支持 包括 相关 主要 具体 ' +
    '点击 窗口 列表 信息 范围 继续 后续 显示 页面 网页 按钮 操作 结果 记录 数据 用户 系统 服务 接口 版本 内容 部分 时间 位置 方式 数量 大小 颜色 文字 图片 间隔 难度 检查 任务 需求 效果 样式 选择 改为 减少 逻辑 错误 运行 新增 ' +
    'the a an and or of to in for on is are be it this that with from as at by not but if then else when while can will would should could do does did has have had was were you your we our they their i me my'
  ).split(/\s+/)
);

const FUNC_CHARS = new Set(
  '的了是我你他她它在和也就都要把这那个上下里有没不一个可以现在然后还是但因所需进已些这样什么怎么如何目前当前与及或而且却又再更很太过着呢吗啊吧被让给从对于以之其此该等能会想做用来去'.split('')
);

/** 主题词判定：排除功能字 2-gram 与裸动词。 */
export function isTopic(k) {
  if (!k || k.length < 2 || STOP.has(k)) return false;
  if (/^[a-z0-9]+$/.test(k)) return k.length >= 3;
  for (const ch of k) if (FUNC_CHARS.has(ch)) return false;
  return true;
}

/* ---------------------------------------------------------------- 习惯抽取 */

const PREFIX = /^\s*(?:[（(]?\s*)(?:OPA1|OPA2|STEP1|STEP2)\s*[:：]?\s*/i;
const FILLER = /^(?:请|麻烦|帮我|帮忙|现在|然后|另外|还有|这个|那个|就)[，,、\s]*/;

function clause(s) {
  return s
    .replace(PREFIX, '')
    .replace(FILLER, '')
    .replace(/[\s，。；;,.!！?？~～"'“”‘’]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 持久约束的表达特征；不含这些词的句子一律不当习惯。 */
const HABIT_STRONG =
  /不要|不需要|无需|不用|禁止|必须|务必|只能|仅限|一律|统一|默认|以后|之后|后续|每次|记住|始终|保持|只改|不要改|不要问|不用确认|零依赖|离线|不联网/;

/** 一次性任务动词：命中说明这是“这次要做什么”，不是“以后都怎么做”。 */
const TASK_NOISE =
  /增加|新增|加入|删除|改成|换成|调整|插入|填写|录入|点进|点击|显示|消失|出现|报错|补充|实现|合并|更换|击败|保存|打开|启动|导出|导入|同步|调用|安装|升级|新建|创建|生成|上传|下载|移动|修改/;

const SHAPE_NOISE = /[\\/:]|\d{2,}/;

/**
 * 从用户指令里抽「习惯/约束」候选。
 * 返回 [{ text, hits, last }]，按重复次数与新鲜度排序。
 */
export function harvestHabits(messages, limit = 10) {
  const map = new Map();
  for (const m of messages) {
    for (const raw of String(m.x).split(/[。；;！!？?\n，,]/)) {
      const t = clause(raw);
      if (t.length < 8 || t.length > 32) continue;
      if (/^[为什么怎么如何能否是否什么哪]/.test(t)) continue;
      if (/[？?]/.test(raw)) continue;
      if (!HABIT_STRONG.test(t)) continue;
      if (TASK_NOISE.test(t) || SHAPE_NOISE.test(t)) continue;
      let hit = null;
      for (const [key, val] of map) {
        if (key === t || dice(key, t) >= 0.72) {
          hit = val;
          break;
        }
      }
      if (hit) {
        hit.hits += 1;
        hit.last = Math.max(hit.last, m.t);
      } else {
        map.set(t, { text: t, hits: 1, last: m.t });
      }
    }
  }
  const kept = [...map.values()].filter(
    (r) => r.hits >= 2 || /(以后|之后|后续|每次|默认|一律|记住|始终|保持|不要|禁止|必须)/.test(r.text)
  );
  kept.sort((a, b) => b.hits - a.hits || b.last - a.last);
  return kept.slice(0, limit);
}

/* ---------------------------------------------------------------- 其它统计 */

export const ACTIONS = [
  '审查', '继续', '修改', '新增', '修复', '优化', '打包', '上传', '部署',
  '生成', '整理', '检查', '总结', '重构', '设计', '录入'
];

export function harvestActions(messages) {
  const counts = new Map();
  for (const m of messages) {
    for (const a of ACTIONS) {
      const n = String(m.x).split(a).length - 1;
      if (n > 0) counts.set(a, (counts.get(a) || 0) + n);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
}

const PREFIXES = ['OPA1', 'OPA2', 'STEP1', 'STEP2'];

export function harvestPrefixes(messages) {
  const out = [];
  for (const p of PREFIXES) {
    const n = messages.filter((m) => new RegExp('^\\s*[（(]?\\s*' + p, 'i').test(m.x)).length;
    if (n >= 1) out.push(p + '×' + n);
  }
  return out;
}

export function harvestKeywords(messages, limit = 12) {
  const df = new Map();
  for (const m of messages) {
    for (const k of new Set(bigrams(m.x))) {
      if (!isTopic(k)) continue;
      df.set(k, (df.get(k) || 0) + 1);
    }
  }
  return [...df.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function tidyTitle(title) {
  return String(title)
    .replace(/\s+/g, ' ')
    .replace(/[\\/:]\S*$/, '')
    .replace(/[\s-—…]+$/, '')
    .trim();
}

/** 任务方向：最近会话标题（用户自己写的任务标签），相似标题去重。 */
export function harvestDirections(sessions, limit = 10) {
  const items = Object.values(sessions)
    .filter((s) => s.title)
    .map((s) => ({ title: tidyTitle(s.title), ts: s.updatedAt || s.ts || 0 }))
    .filter((it) => it.title.length >= 4)
    .sort((a, b) => b.ts - a.ts);

  const picked = [];
  for (const it of items) {
    if (picked.length >= limit) break;
    if (picked.some((p) => p.title === it.title || dice(p.title, it.title) >= 0.6)) continue;
    picked.push(it);
  }

  const df = new Map();
  for (const it of items.slice(0, 40)) {
    for (const k of new Set(bigrams(it.title))) {
      if (!isTopic(k)) continue;
      df.set(k, (df.get(k) || 0) + 1);
    }
  }
  const topics = [...df.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 8)
    .map(([k, n]) => ({ k: /^[a-z0-9]+$/.test(k) ? k.toUpperCase() : k, n }));

  return { items: picked, topics, total: items.length };
}
