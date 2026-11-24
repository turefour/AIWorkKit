#!/usr/bin/env node
/**
 * DeepSeek Harness 适配器 —— 从标准输入读「一行一个 JSON」的事件流。
 *
 * 用法：
 *   node harness.mjs --emit-events | node deepseek.mjs
 *   type events.ndjson | node deepseek.mjs
 *
 * 约定：
 *   - 每行一个 JSON，空行与 # 开头的行忽略
 *   - 字段可直接使用 Eco 的标准事件（event/job/payload），
 *     也支持简写 {tool, ok, ms}，会自动映射成 tool.end
 *
 * 设计成「流式」而不是「文件」：Harness 类工具通常边跑边输出，
 * 逐行处理可以做到任务没结束就在看板上看到进度。
 */

import { postEvent, normalize } from './generic.mjs';

/** 把 Harness 的简写映射成标准事件 */
export function translate(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  // 已经是标准事件（有 event 或 job）就只补默认值
  if (obj.event || obj.job) {
    return normalize(obj, 'deepseek');
  }

  // 简写：{tool, command, ok, ms, id}
  const id = obj.id || obj.sessionId || 'harness-' + process.pid;
  const ok = obj.ok !== false;
  return normalize(
    {
      platform: 'deepseek',
      event: 'tool.end',
      sessionId: id,
      job: {
        id,
        kind: obj.kind || 'build',
        label: obj.label || obj.command || obj.tool || 'harness step',
        status: ok ? 'done' : 'failed'
      },
      payload: {
        tool: obj.tool || 'Bash',
        command: obj.command || '',
        exitCode: ok ? 0 : 1,
        durationMs: Number(obj.ms) || 0
      }
    },
    'deepseek'
  );
}

let pending = 0;
let failed = 0;
let buffer = '';

/*
 * 逐行转换后直接上报。
 *
 * 不用再自己维护「这个会话有没有发过 start」—— 服务端 /api/ingest 已经会
 * 在收到孤立的结束事件时补一条开始。适配器只管翻译，逻辑留在服务端一处。
 */
function flush(line) {
  const text = line.trim();
  if (!text || text.startsWith('#')) return;
  const ev = translate(text);
  if (!ev) {
    console.error('[deepseek] 跳过无法解析的行');
    return;
  }

  pending += 1;
  postEvent(ev).then((r) => {
    if (!r.ok) {
      failed += 1;
      if (r.error) console.error('[deepseek] 上报失败：' + r.error);
    }
    pending -= 1;
  });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    flush(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 1);
  }
});

process.stdin.on('end', () => {
  if (buffer.trim()) flush(buffer);
  // 等所有上报落定再退出，避免事件丢失
  const timer = setInterval(() => {
    if (pending === 0) {
      clearInterval(timer);
      if (failed) console.error('[deepseek] ' + failed + ' 条上报失败');
      process.exit(0);
    }
  }, 50);
  if (timer.unref) timer.unref();
});
