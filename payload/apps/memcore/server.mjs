#!/usr/bin/env node
/**
 * memcore — 工作套件统一任务记忆（HTTP 层）
 *
 * @name memcore
 * @category system
 * @purpose 把「用户习惯 / 任务方向 / 决策 / 收尾摘要」收敛到套件根目录 memory\，
 *          自动生成 MEMORY.md 与可注入规则 memcore.mdc，供后续所有任务读取与追加。
 * @input  --port N（默认 57912）
 * @usage  node apps/memcore/server.mjs --port 57912
 * @reuse  yes
 *
 * 路由
 *   GET    /                     记忆浏览器（单文件页面）
 *   GET    /api/health           存活探针（app=memcore，launch/stop 靠它认身份）
 *   GET    /api/overview         统计 + 数据源 + 记忆正文
 *   GET    /api/stats            仅统计
 *   GET    /api/memory           完整 MEMORY.md（text/markdown）
 *   GET    /api/rule             常驻规则 memcore.mdc（text/markdown）
 *   GET    /api/search?q=&limit= 统一检索（条目 / 指令 / 会话标题）
 *   GET    /api/logs?tail=N      运行日志尾部
 *   POST   /api/sync             增量摄入对话痕迹
 *   POST   /api/build            重建 MEMORY.md 与规则
 *   POST   /api/note             新增或更新记忆条目（id 存在则合并）
 *   DELETE /api/note?id=         删除条目
 *   POST   /api/prune            按保留策略裁剪
 *
 * 数据目录不在 apps\ 下（见 lib/paths.mjs），重新部署不会冲掉记忆。
 * 写请求由 apps/_shared/httpserver.mjs 的守卫拦截：仅本机 + 同源 + JSON。
 */

import fs from 'node:fs';
import path from 'node:path';

import { createApp } from '../_shared/httpserver.mjs';
import { LOG_DIR, WEB_DIR } from './lib/paths.mjs';
import { logLine, readStore, statsOf, cfg } from './lib/store.mjs';
import {
  addNote,
  build,
  graph,
  installRule,
  overview,
  prune,
  readMemory,
  readRule,
  removeNote,
  searchAll,
  sync,
  sources
} from './lib/api.mjs';

const HOST = process.env.MEMCORE_HOST || '127.0.0.1';
let PORT = Number(process.env.MEMCORE_PORT || 57912);

const MAX_BODY = 256 * 1024;

const app = createApp({ root: WEB_DIR });

app.get('/api/health', (ctx) => {
  const store = readStore();
  ctx.json(200, {
    ok: true,
    app: 'memcore',
    pid: process.pid,
    port: PORT,
    notes: store.notes.length,
    sessions: Object.keys(store.sessions).length,
    messages: store.messages.length
  });
});

app.get('/api/sources', (ctx) => {
  // 数据源健康：每个源读到多少条、耗时、失败原因
  ctx.json(200, sources());
});
app.get('/api/stats', (ctx) => {
  ctx.json(200, { ok: true, ...statsOf(readStore()) });
});

app.get('/api/overview', (ctx) => {
  const o = overview();
  ctx.json(200, { ...o, budget: cfg });
});

app.get('/api/graph', (ctx) => {
  const g = graph();
  ctx.json(200, g);
});

app.get('/api/memory', (ctx) => {
  const body = readMemory();
  if (!body) return ctx.json(404, { ok: false, error: '尚未生成，请先 sync + build' });
  return ctx.text(200, body, 'text/markdown; charset=utf-8');
});

app.get('/api/rule', (ctx) => {
  const body = readRule();
  if (!body) return ctx.json(404, { ok: false, error: '尚未生成，请先 build' });
  return ctx.text(200, body, 'text/markdown; charset=utf-8');
});

app.get('/api/search', (ctx) => {
  const q = ctx.query.get('q') || '';
  const limit = Number(ctx.query.get('limit')) || 40;
  const r = searchAll(q, Math.min(Math.max(limit, 1), 100));
  logLine('info', 'search', 'q=' + JSON.stringify(q).slice(0, 80) + '  hits=' + r.rows.length);
  ctx.json(200, r);
});

app.get('/api/logs', (ctx) => {
  const tail = Math.min(Math.max(Number(ctx.query.get('tail')) || 200, 1), 2000);
  const d = new Date();
  const ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
  const file = path.join(LOG_DIR, 'memcore-' + ym + '.log');
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    raw = '';
  }
  const lines = raw ? raw.replace(/\r/g, '').trimEnd().split('\n') : [];
  ctx.json(200, { ok: true, file: path.basename(file), total: lines.length, lines: lines.slice(-tail) });
});

app.post('/api/sync', (ctx) => {
  const r = sync();
  const b = build();
  ctx.json(200, { ok: true, sync: r, build: { ok: b.ok, memoryBytes: b.memoryBytes, ruleBytes: b.ruleBytes } });
});

app.post('/api/build', (ctx) => {
  const b = build();
  ctx.json(b.ok ? 200 : 409, b);
});

app.post('/api/note', async (ctx) => {
  const body = await ctx.body(MAX_BODY);
  if (!body || typeof body !== 'object') return ctx.json(400, { ok: false, error: 'bad json' });
  try {
    const r = addNote(body, 'http');
    return ctx.json(200, { ok: true, ...r });
  } catch (e) {
    return ctx.json(400, { ok: false, error: String(e.message) });
  }
});

app.delete('/api/note', (ctx) => {
  const r = removeNote(ctx.query.get('id') || '');
  return ctx.json(r.ok ? 200 : 404, r);
});

// 页面脚本报错回传：只落日志，不存库，避免把调试信息写进记忆
app.post('/api/client-error', async (ctx) => {
  const body = await ctx.body(64 * 1024);
  if (body && typeof body === 'object') {
    const msg = String(body.message || '').slice(0, 300);
    if (msg) {
      const where = String(body.source || '').slice(0, 120) + ':' + (Number(body.line) || 0);
      const stack = String(body.stack || '').replace(/\s+/g, ' ').slice(0, 400);
      logLine('error', 'client', msg + '  @' + where + (stack ? '  stack=' + stack : ''));
    }
  }
  ctx.json(200, { ok: true });
});

app.post('/api/prune', (ctx) => {
  ctx.json(200, prune());
});

app.post('/api/install-rule', (ctx) => {
  const r = installRule();
  ctx.json(r.ok ? 200 : 500, r);
});

/* ---------------------------------------------------------------- 启动 */

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--port' && argv[i + 1]) PORT = Number(argv[++i]);
  else if (/^\d+$/.test(argv[i])) PORT = Number(argv[i]);
}

const server = app.listen(PORT, HOST);

server.on('listening', () => {
  const s = statsOf(readStore());
  console.log(
    '[memcore] http://' + HOST + ':' + PORT + '/  (pid ' + process.pid +
      ', notes ' + s.notes + ', messages ' + s.messages + ')'
  );
  logLine('info', 'boot', 'listen ' + HOST + ':' + PORT + '  home=' + s.home);
});

server.on('error', (err) => {
  console.error('[memcore] ' + err.message);
  logLine('error', 'boot', 'listen failed: ' + err.message);
  process.exit(1);
});

function shutdown(sig) {
  console.log('[memcore] shutting down (' + sig + ')');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
