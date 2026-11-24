#!/usr/bin/env node
/**
 * 通用事件上报器 —— 任何 AI 编程平台都能用。
 *
 * 用法：
 *   echo '{"event":"tool.end","job":{"id":"r1","status":"done"}}' | node generic.mjs
 *   node generic.mjs event.json
 *
 * 做的事：读 JSON（stdin 或文件）→ 补齐 platform/时间戳 → POST 到 Eco 的 /api/ingest。
 * 失败不阻塞调用方：退出码恒为 0，错误打到 stderr。
 */

import fs from 'node:fs';
import http from 'node:http';

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

/**
 * 上报一个事件。
 *
 * 走 /api/ingest 而不是 /api/events：前者会校验事件名、补齐默认值，
 * 并在「只给了结束事件」时自动补一条开始。适配器因此不需要自己维护
 * started 集合 —— 那套逻辑放服务端只需要写一遍，放各适配器里就会各写一份。
 */
export function postEvent(event, options = {}) {
  const port = options.port || PORT;
  const host = options.host || HOST;
  const body = Buffer.from(JSON.stringify(event), 'utf8');

  /*
   * 用 node:http + agent:false，不用 fetch。
   *
   * fetch（undici）会保留 keep-alive 连接，适配器是短命进程，直接
   * process.exit() 时 libuv 会在关闭这些 handle 时报
   * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，
   * 进程被 abort，退出码变成 0xC0000409 —— 于是「命令成功」也会被判成失败，
   * && 链路和 CI 全部误判。短连接在响应结束即关闭，退出就干净了。
   */
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = http.request(
      {
        host,
        port,
        path: '/api/ingest',
        method: 'POST',
        agent: false,
        timeout: 4000,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length
        }
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            done({ ok: true, status: res.statusCode });
            return;
          }
          let detail = '';
          try {
            detail = (JSON.parse(raw) || {}).error || '';
          } catch (_) {
            /* 响应不是 JSON 就只报状态码 */
          }
          done({ ok: false, status: res.statusCode, error: detail });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      done({ ok: false, error: err.message });
    });
    req.end(body);
  });
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
    const r = await postEvent(normalize(item));
    if (!r.ok) console.error('[generic] 上报失败：' + (r.error || r.status));
  }
  process.exit(0);
}

// 作为脚本直接运行时才执行 main，被 import 时只导出函数
if (process.argv[1] && process.argv[1].endsWith('generic.mjs')) {
  main();
}
