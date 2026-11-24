#!/usr/bin/env node
/**
 * 通用事件上报器 —— 任何 AI 编程平台都能用。
 *
 * 用法：
 *   echo '{"event":"tool.end","job":{"id":"r1","status":"done"}}' | node generic.mjs
 *   node generic.mjs event.json
 *
 * 做的事：读 JSON（stdin 或文件）→ 补齐 platform/时间戳 → POST 到 Eco 的 /api/events。
 * 失败不阻塞调用方：退出码恒为 0，错误打到 stderr。
 */

import fs from 'node:fs';

const PORT = Number(process.env.AIWORKKIT_ECO_PORT || 57821);
const HOST = process.env.AIWORKKIT_ECO_HOST || '127.0.0.1';

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      raw += c;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

/** 补默认值：平台名、事件名、任务 id */
export function normalize(input, platform = 'generic') {
  const ev = input && typeof input === 'object' ? { ...input } : {};
  ev.platform = ev.platform || platform;
  ev.event = ev.event || 'tool.end';
  ev.at = ev.at || new Date().toISOString();

  if (!ev.job) {
    ev.job = { id: ev.sessionId || 'session-' + process.pid, status: 'running' };
  }
  if (!ev.job.id) ev.job.id = ev.sessionId || 'session-' + process.pid;
  if (!ev.job.status) ev.job.status = ev.event.startsWith('turn.end') ? 'done' : 'running';
  return ev;
}

export async function postEvent(event, options = {}) {
  const port = options.port || PORT;
  const host = options.host || HOST;
  const url = 'http://' + host + ':' + port + '/api/events';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(4000)
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 上报一个事件；如果是「结束类」事件而调用方没发过开始，
 * 先补一条 tool.start。
 *
 * 内部按「先 start 再 end」成对处理，只有 end 的事件会被当成孤立事件丢掉。
 * 很多平台只会告诉你「这一步做完了」，所以在这里补齐比要求每个平台都改容易。
 */
export async function postWithStart(input) {
  const ev = normalize(input);
  // 共用同一个 ts：内部任务 id 是 tool:<sid>:<ts>:<tool>，
  // 两条事件用不同 ts 会各建一条任务（看板上出现「running + done」重复项）
  const sharedTs = ev.ts || Date.now();
  ev.ts = sharedTs;

  const isEnd = ev.event === 'tool.end' || ev.event === 'tool.fail' || ev.event === 'turn.end';
  if (isEnd) {
    await postEvent({
      ...ev,
      ts: sharedTs,
      event: 'tool.start',
      job: { ...(ev.job || {}), status: 'running' }
    });
    await new Promise((r) => setTimeout(r, 30)); // 保证先后顺序
  }
  return postEvent(ev);
}

async function main() {
  const file = process.argv[2];
  let raw = '';
  if (file) {
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      console.error('[generic] 读取失败：' + err.message);
      process.exit(0);
    }
  } else {
    raw = await readStdin();
  }

  raw = raw.trim();
  if (!raw) {
    console.error('[generic] 没有输入。用法：echo \'{...}\' | node generic.mjs');
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('[generic] 不是合法 JSON：' + err.message);
    process.exit(0);
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) {
    const r = await postWithStart(item);
    if (!r.ok) console.error('[generic] 上报失败：' + (r.error || r.status));
  }
  process.exit(0);
}

// 作为脚本直接运行时才执行 main，被 import 时只导出函数
if (process.argv[1] && process.argv[1].endsWith('generic.mjs')) {
  main();
}
