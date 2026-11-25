/**
 * memcore 存储层：单一 JSON 索引 + 原子写 + 运行日志 + 记忆条目 CRUD。
 *
 * 被三处共用：
 *   server.mjs            HTTP 服务
 *   tools/memcore.mjs     命令行（不依赖服务是否在跑）
 *   lib/api.mjs           同步 / 构建 / 检索的编排
 *
 * 存储只有一份：<套件根>\memory\store.json。体积靠三条硬约束兜住：
 *   消息保留 keepDays 天、最多 keepMessages 条、单条截断 messageChars 字。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  ARCHIVE_DIR,
  CONFIG_FILE,
  LOG_DIR,
  MEMORY_HOME,
  STORE_FILE,
  ensureHome
} from './paths.mjs';

export const STORE_VERSION = 2;

export const DEFAULTS = {
  memoryBudget: 6000, // MEMORY.md 字节上限
  tier1Budget: 1200, // 自动注入规则字节上限
  keepDays: 365,
  keepMessages: 3000,
  messageChars: 240,
  noteChars: 200, // 单条记忆正文上限
  maxNotes: 2000
};

/** 记忆条目类型 → 允许的 scope 与判定提示（CLI / 文档共用一份）。 */
export const ENTRY_TYPES = {
  habit: { scope: ['machine', 'suite'], hint: '重复出现的做事方式（≥2 个项目或明确“以后/每次/不要”）' },
  preference: { scope: ['machine', 'suite', 'project'], hint: '风格/语言/格式类长期偏好' },
  constraint: { scope: ['machine', 'suite', 'project'], hint: '红线或必须遵守的约束，必须可执行' },
  direction: { scope: ['suite', 'project', 'session'], hint: '一条任务线的目标（来自会话标题或首条指令）' },
  decision: { scope: ['project', 'task'], hint: '选型/方案定稿，含理由与被否方案' },
  lesson: { scope: ['machine', 'project'], hint: '踩坑与解法，正文只留结论，细节指向 errvault' },
  'task-end': { scope: ['task', 'session'], hint: '任务收尾：目标/产出/验证/未完成' },
  pointer: { scope: ['suite', 'project'], hint: '指向外部库的索引（CodeVault / errvault / ScriptVault）' }
};

export const SCOPES = ['machine', 'suite', 'project', 'session', 'task'];
export const CONFIDENCE = ['confirmed', 'inferred', 'stale'];

export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const cfg = loadConfig();

/* ---------------------------------------------------------------- 日志 */

function pad(s, n) {
  return (String(s) + ' '.repeat(n)).slice(0, n);
}

/** 追加一行运行日志。按月分文件，超 1 MB 轮转为 .1.log；失败绝不影响调用方。 */
export function logLine(level, action, detail) {
  try {
    ensureHome();
    const d = new Date();
    const ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
    const file = path.join(LOG_DIR, 'memcore-' + ym + '.log');
    try {
      if (fs.statSync(file).size > 1024 * 1024) {
        const old = path.join(LOG_DIR, 'memcore-' + ym + '.1.log');
        try {
          fs.unlinkSync(old);
        } catch {
          /* no previous rotation */
        }
        fs.renameSync(file, old);
      }
    } catch {
      /* first write of the month */
    }
    const p2 = (n) => String(n).padStart(2, '0');
    const ts =
      d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    fs.appendFileSync(
      file,
      ts + '  ' + pad(String(level).toUpperCase(), 5) + '  ' + pad(String(action), 9) + '  ' + text + '\n',
      'utf8'
    );
  } catch {
    /* never break the caller */
  }
}

/* ---------------------------------------------------------------- 基础 IO */

export function nowIso() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const om = String(Math.abs(off) % 60).padStart(2, '0');
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return local + sign + oh + ':' + om;
}

export function newEntryId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  return 'MEM-' + stamp + '-' + Math.random().toString(36).slice(2, 6);
}

/** 原子写：先写 .tmp 再 rename，避免半截文件。 */
export function writeJsonAtomic(file, obj, pretty) {
  ensureHome();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, pretty ? 1 : 0), 'utf8');
  fs.renameSync(tmp, file);
}

export function writeTextAtomic(file, text) {
  ensureHome();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function emptyStore() {
  return { version: STORE_VERSION, updatedAt: 0, sessions: {}, messages: [], notes: [] };
}

export function readStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return emptyStore();
    if (!j.sessions || typeof j.sessions !== 'object') j.sessions = {};
    if (!Array.isArray(j.messages)) j.messages = [];
    if (!Array.isArray(j.notes)) j.notes = [];
    if (j.version !== STORE_VERSION) j.version = STORE_VERSION;
    return j;
  } catch {
    return emptyStore();
  }
}

export function writeStore(store) {
  store.version = STORE_VERSION;
  store.updatedAt = Date.now();
  writeJsonAtomic(STORE_FILE, store, false);
  return store;
}

/** 保留策略：按天数 + 条数双上限裁剪，会话只在仍被引用或足够新时保留。 */
export function pruneStore(store, now = Date.now()) {
  const cutoff = now - cfg.keepDays * 86400000;
  store.messages = store.messages
    .filter((m) => m && m.t >= cutoff)
    .sort((a, b) => a.t - b.t)
    .slice(-cfg.keepMessages);

  const alive = new Set(store.messages.map((m) => m.c));
  const sessions = {};
  for (const [id, s] of Object.entries(store.sessions)) {
    if (alive.has(id) || (s.updatedAt || s.ts || 0) >= cutoff) sessions[id] = s;
  }
  store.sessions = sessions;

  store.notes = store.notes
    .filter((n) => n && n.text)
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .slice(-cfg.maxNotes);
  return store;
}

/* ---------------------------------------------------------------- 记忆条目 */

const bad = (msg) => {
  const e = new Error(msg);
  e.code = 'BAD_ENTRY';
  return e;
};

function normalizeType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (ENTRY_TYPES[t]) return t;
  throw bad('未知类型: ' + type + '（可选 ' + Object.keys(ENTRY_TYPES).join(' / ') + '）');
}

function normalizeScope(scope, type) {
  const s = String(scope || ENTRY_TYPES[type].scope[0]).trim().toLowerCase();
  if (!SCOPES.includes(s)) throw bad('未知 scope: ' + scope);
  return s;
}

/** 归一化文本：折叠空白、去首尾标点，超过 noteChars 直接拒绝（防止把日志堆进来）。 */
export function normalizeText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/^[-—·]\s*/, '');
  if (t.length < 4) throw bad('正文过短（至少 4 字）');
  if (t.length > cfg.noteChars) throw bad('正文超过 ' + cfg.noteChars + ' 字，请压缩或改用 pointer 指向文件');
  return t;
}

function bigrams(s) {
  const out = [];
  const text = String(s).toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ');
  for (const chunk of text.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[\u4e00-\u9fa5]+$/.test(chunk)) {
      for (let i = 0; i + 1 < chunk.length; i += 1) out.push(chunk.slice(i, i + 2));
    } else if (chunk.length >= 3) out.push(chunk);
  }
  return out;
}

/** 2-gram Dice 相似度：用于同义条目去重（不引第三方库）。 */
export function similarity(a, b) {
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

function appendArchive(entry) {
  try {
    ensureHome();
    const d = new Date();
    const ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
    fs.appendFileSync(path.join(ARCHIVE_DIR, 'notes-' + ym + '.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* archive is a safety net, not a dependency */
  }
}

/**
 * 新增或更新一条记忆。
 *   - 指定 id：按 id 更新（rev+1，未提供的字段保留）
 *   - 未指定：先按正文相似度找同义条目，命中则合并（count+1），否则新建
 *   - 同一 id 的正文变更会同步写一份到 archive/*.jsonl（追加式，便于审计/回滚）
 */
export function upsertNote(input, origin) {
  if (!input || typeof input !== 'object') throw bad('缺少条目内容');
  const type = normalizeType(input.type);
  const scope = normalizeScope(input.scope, type);
  const text = normalizeText(input.text);

  const store = readStore();
  let existing = null;
  if (input.id) {
    existing = store.notes.find((n) => n.id === input.id) || null;
    if (!existing) throw bad('条目不存在: ' + input.id);
  } else {
    existing =
      store.notes.find((n) => n.type === type && n.text === text) ||
      store.notes.find((n) => n.type === type && similarity(n.text, text) >= 0.82) ||
      null;
  }

  const confidence = CONFIDENCE.includes(String(input.confidence))
    ? String(input.confidence)
    : existing?.confidence || 'confirmed';
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
    : existing?.tags || [];
  const source = input.source || existing?.source || { kind: origin || 'cli', at: nowIso() };

  const entry = {
    id: existing?.id || input.id || newEntryId(),
    type,
    scope,
    text,
    tags,
    confidence,
    ttl: String(input.ttl || existing?.ttl || 'never'),
    weight: Math.min(Math.max(Number(input.weight) || existing?.weight || 3, 1), 5),
    source,
    count: existing ? (existing.count || 1) + (input.id ? 0 : 1) : 1,
    at: existing?.at || input.at || nowIso(),
    updatedAt: nowIso(),
    rev: existing ? (existing.rev || 0) + 1 : 1
  };

  if (existing) {
    const i = store.notes.findIndex((n) => n.id === existing.id);
    store.notes[i] = entry;
  } else {
    store.notes.push(entry);
  }
  writeStore(store);
  appendArchive(entry);
  logLine('info', existing ? 'update' : 'add', entry.id + '  type=' + entry.type + '  scope=' + entry.scope + (input.id ? '' : '  count=' + entry.count));
  return { ok: true, isNew: !existing, entry };
}

export function deleteNote(id) {
  const store = readStore();
  const i = store.notes.findIndex((n) => n.id === id);
  if (i < 0) return { ok: false, error: '条目不存在: ' + id };
  const [entry] = store.notes.splice(i, 1);
  writeStore(store);
  logLine('info', 'delete', id + '  type=' + entry.type);
  return { ok: true, entry };
}

/**
 * 检索：正文命中优先，其次标签；同分按权重、更新时间排。
 * 返回 [{ note, score }]，limit 默认 20。
 */
export function searchNotes(store, opts = {}) {
  const q = String(opts.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
  let pool = store.notes;
  if (opts.type) pool = pool.filter((n) => n.type === String(opts.type).toLowerCase());
  if (opts.scope) pool = pool.filter((n) => n.scope === String(opts.scope).toLowerCase());

  if (!q) {
    return pool
      .slice()
      .sort((a, b) => (b.weight || 3) - (a.weight || 3) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit)
      .map((note) => ({ note, score: 0 }));
  }

  const qt = new Set(bigrams(q));
  const rows = [];
  for (const n of pool) {
    let score = 0;
    const lower = n.text.toLowerCase();
    if (lower.includes(q)) score += 8;
    const nt = new Set(bigrams(n.text));
    for (const t of qt) if (nt.has(t)) score += 1;
    for (const tag of n.tags || []) {
      const tg = String(tag).toLowerCase();
      if (tg.includes(q) || q.includes(tg)) score += 4;
    }
    // 高权重条目在打分接近时优先，但不足以盖过命中强度
    if (score > 0) rows.push({ note: n, score: score + (n.weight || 3) * 0.1 });
  }
  rows.sort((a, b) => b.score - a.score || String(b.note.updatedAt).localeCompare(String(a.note.updatedAt)));
  return rows.slice(0, limit);
}

export function statsOf(store) {
  const byType = {};
  const byScope = {};
  const byConfidence = {};
  for (const n of store.notes) {
    byType[n.type] = (byType[n.type] || 0) + 1;
    byScope[n.scope] = (byScope[n.scope] || 0) + 1;
    byConfidence[n.confidence || 'confirmed'] = (byConfidence[n.confidence || 'confirmed'] || 0) + 1;
  }
  const size = (file) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  return {
    home: MEMORY_HOME,
    sessions: Object.keys(store.sessions).length,
    messages: store.messages.length,
    notes: store.notes.length,
    byType,
    byScope,
    byConfidence,
    oldest: store.messages[0]?.t || 0,
    newest: store.messages.at(-1)?.t || Date.now(),
    storeBytes: size(path.join(MEMORY_HOME, 'store.json')),
    memoryBytes: size(path.join(MEMORY_HOME, 'MEMORY.md')),
    ruleBytes: size(path.join(MEMORY_HOME, 'memcore.mdc')),
    updatedAt: store.updatedAt
  };
}
