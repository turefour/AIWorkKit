/**
 * memcore 数据源：只读读取宿主平台留下的对话痕迹。
 *
 * 三处来源，缺一不可但不强依赖（任一缺失只降级，不阻塞）：
 *   1. CodeBuddy 会话索引  %APPDATA%\CodeBuddy CN\codebuddy-sessions.vscdb
 *      —— 会话标题 / 工作目录 / 时间，标题本身就是用户写的任务标签
 *   2. 消息队列            %APPDATA%\CodeBuddy CN\User\globalStorage\...\message-queue
 *      —— 用户真实发出的指令（助手输出不入库）
 *   3. 索引库项目清单      <套件根>\apps\codevault\data\projects.json
 *      —— 会话目录 → 项目名的映射
 *
 * 平台目录可用 CODEBUDDY_INFO 覆盖；读不到就返回空，不抛错。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

import { KIT_ROOT } from './paths.mjs';

const require = createRequire(import.meta.url);

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
export const INFO_ROOT = process.env.CODEBUDDY_INFO || path.join(APPDATA, 'CodeBuddy CN');
export const SESSIONS_DB = path.join(INFO_ROOT, 'codebuddy-sessions.vscdb');
export const MQ_DIR = path.join(
  INFO_ROOT,
  'User',
  'globalStorage',
  'tencent-cloud.coding-copilot',
  'message-queue'
);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

/** 会话元数据：conversationId -> { cwd, title, status, ts, updatedAt }。 */
export function loadSessions() {
  const out = {};
  if (!fs.existsSync(SESSIONS_DB)) return out;
  let db = null;
  try {
    // node:sqlite 是内置模块；只有 ingest 才需要，读到没装就降级
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(SESSIONS_DB, { readOnly: true });
    const rows = db.prepare("select value from ItemTable where key like 'session:%'").all();
    for (const row of rows) {
      let v = null;
      try {
        v = JSON.parse(String(row.value));
      } catch {
        continue;
      }
      if (!v || !v.conversationId) continue;
      out[v.conversationId] = {
        cwd: String(v.cwd || ''),
        title: String(v.title || '').trim(),
        status: String(v.status || ''),
        ts: Number(v.createdAt) || 0,
        updatedAt: Number(v.updatedAt) || Number(v.createdAt) || 0
      };
    }
  } catch {
    /* 平台升级换了 schema：本次不摄入会话，已有记忆不受影响 */
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 用户指令：只取 text 块，跳过 displayAsContext（那是平台自动附加的上下文）。 */
export function loadMessages(maxChars) {
  const out = [];
  const seen = new Set();
  if (!fs.existsSync(MQ_DIR)) return out;
  for (const f of fs.readdirSync(MQ_DIR)) {
    if (!f.endsWith('.json')) continue;
    const doc = readJson(path.join(MQ_DIR, f));
    if (!doc || !doc.conversations) continue;
    for (const conv of Object.values(doc.conversations)) {
      const convId = conv?.conversationId || '';
      for (const item of conv?.items || []) {
        if (!item?.id || seen.has(item.id)) continue;
        const blocks = (item.contentBlocks || []).filter(
          (b) => b?.type === 'text' && !b._meta?.displayAsContext
        );
        const text = blocks
          .map((b) => String(b.text || ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length < 4) continue;
        seen.add(item.id);
        out.push({
          i: item.id,
          c: convId,
          t: Number(item.createdAt) || 0,
          x: text.slice(0, maxChars)
        });
      }
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** 项目清单：优先用套件自带的索引库数据，其次用户桌面的 CodeVault。 */
export function loadProjects() {
  const candidates = [
    path.join(KIT_ROOT, 'apps', 'codevault', 'data', 'projects.json'),
    path.join(HOME, 'Desktop', 'CodeVault', 'data', 'projects.json')
  ];
  for (const file of candidates) {
    const j = readJson(file);
    // 打包时会把套件内 projects.json 清空，空清单要继续往下一个候选找
    if (j && Array.isArray(j.projects) && j.projects.length) {
      return j.projects.map((p) => ({
        name: String(p.name || ''),
        session: String(p.session || ''),
        path: String(p.path || '').replace(/\\/g, '/').toLowerCase()
      }));
    }
  }
  return [];
}

/** 会话目录 → 可读名字：精确命中项目路径用项目名，否则取目录名。 */
export function labelForCwd(cwd, projects) {
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!c) return '未登记目录';
  const exact = projects.find((p) => p.path && (c === p.path || c.startsWith(p.path + '/')));
  if (exact?.name) return exact.name;
  const base = c.split('/').pop() || c;
  const members = projects.filter((p) => p.session && p.session === base);
  if (members.length === 1) return members[0].name;
  if (members.length > 1) return members[0].name + ' 等' + members.length + '项';
  return base;
}

/** 数据源健康状况：给 stats / 页面「数据源」区块用。 */
export function sourceStatus() {
  const q = (p) => fs.existsSync(p);
  return {
    sessionsDb: { path: SESSIONS_DB, ok: q(SESSIONS_DB) },
    messageQueue: { path: MQ_DIR, ok: q(MQ_DIR) },
    projects: {
      ok: loadProjects().length > 0,
      path: path.join(KIT_ROOT, 'apps', 'codevault', 'data', 'projects.json')
    }
  };
}
