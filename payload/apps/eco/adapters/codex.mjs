#!/usr/bin/env node
/**
 * Codex CLI 适配器 —— 包一层命令，把每一次执行变成 Eco 的一条任务事件。
 *
 * 用法：
 *   node codex.mjs -- npm test
 *   node codex.mjs --label "跑测试" -- npm run build
 *
 * 做法：spawn 真实命令（不经 shell 拼接，参数原样传递）→ 记录开始/结束/耗时/退出码
 *       → 上报 tool.start / tool.end。命令的 stdout/stderr 原样透传，不影响原流程。
 *
 * 为什么用包装而不是 hook：Codex 没有通用的插件注入点，
 * 但任何命令行调用都可以被包一层，这是最少侵入的做法。
 */

import { spawn } from 'node:child_process';
import { postEvent, normalize } from './generic.mjs';

function parseArgs(argv) {
  const out = { label: '', kind: 'build', cwd: process.cwd(), cmd: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      out.cmd = argv.slice(i + 1);
      break;
    }
    if (a === '--label' && argv[i + 1]) {
      out.label = argv[++i];
      i += 1;
      continue;
    }
    if (a === '--kind' && argv[i + 1]) {
      out.kind = argv[++i];
      i += 1;
      continue;
    }
    if (a === '--cwd' && argv[i + 1]) {
      out.cwd = argv[++i];
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.cmd.length) {
  console.error('[codex] 用法：node codex.mjs --label "跑测试" -- npm test');
  process.exit(2);
}

const jobId = 'codex-' + Date.now().toString(36);
const startedAt = Date.now();
const label = args.label || args.cmd.join(' ');

await postEvent(
  normalize(
    {
      platform: 'codex',
      event: 'tool.start',
      sessionId: jobId,
      job: { id: jobId, kind: args.kind, label, status: 'running', startedAt },
      payload: { tool: 'Bash', command: args.cmd.join(' ') }
    },
    'codex'
  )
);

const child = spawn(args.cmd[0], args.cmd.slice(1), {
  cwd: args.cwd,
  stdio: 'inherit',
  windowsHide: true
});

const [code, signal] = await new Promise((resolve) => {
  child.on('error', (err) => {
    console.error('[codex] 启动失败：' + err.message);
    resolve([127, null]);
  });
  child.on('exit', (c, s) => resolve([c == null ? 1 : c, s]));
});

const durationMs = Date.now() - startedAt;
await postEvent(
  normalize(
    {
      platform: 'codex',
      event: 'tool.end',
      sessionId: jobId,
      job: {
        id: jobId,
        kind: args.kind,
        label,
        status: code === 0 ? 'done' : 'failed',
        endedAt: Date.now()
      },
      payload: { tool: 'Bash', command: args.cmd.join(' '), exitCode: code, signal, durationMs }
    },
    'codex'
  )
);

// 保持原命令的退出码，脚本链 / CI 行为不变
process.exit(code);
