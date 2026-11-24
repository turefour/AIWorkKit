#!/usr/bin/env node
/**
 * @name snippet
 * @category scaffold
 * @purpose 按关键词检索脚本库并直接执行，替代「打开网页→翻列表→复制命令」的三步走
 * @input
 *   node tools/snippet.mjs search <关键词>        模糊搜索（名称/用途/用法/分类）
 *   node tools/snippet.mjs list [--kind tools]    按类型列出
 *   node tools/snippet.mjs show <名称>            显示用法与依赖
 *   node tools/snippet.mjs run <名称> [参数...]   执行该脚本（自动选 node / python）
 * @usage node tools/snippet.mjs search 截图
 * @reuse 需要找「哪个脚本能干这件事」时先 search，再 run，不要先打开浏览器
 *
 * 为什么需要它：库里已有 19+ 个脚本，但靠记忆想不起名字时只能翻索引页。
 * search 把「发现成本」从一次页面浏览压到一行命令的输出。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_FILE = path.join(ROOT, 'index.json');

function readIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    console.error('[fail] 索引不存在：' + INDEX_FILE + '\n       先跑 node build-index.mjs');
    process.exit(2);
  }
  // 索引可能是 PS 脚本写入的，去掉可能的 BOM 再解析
  const raw = fs.readFileSync(INDEX_FILE, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

/** 简单模糊匹配：关键词全部命中才返回，按命中位置排序。 */
function score(entry, keywords) {
  const haystack = [
    entry.name,
    entry.purpose,
    entry.usage,
    entry.category,
    entry.kind
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let total = 0;
  for (const word of keywords) {
    const at = haystack.indexOf(word.toLowerCase());
    if (at < 0) return -1;
    // 出现在开头附近给更高分，方便「名字里就有」的结果排在前面
    total += 1000 - Math.min(at, 900);
  }
  return total;
}

function kindLabel(kind) {
  return { lib: '模块', tools: '工具', py: 'Python', tests: '测试' }[kind] || kind;
}

function cmdSearch(args) {
  const keywords = args.filter((a) => !a.startsWith('--'));
  if (!keywords.length) {
    console.error('用法：node tools/snippet.mjs search <关键词> [更多关键词]');
    process.exit(2);
  }

  const data = readIndex();
  const hits = data.entries
    .map((entry) => ({ entry, score: score(entry, keywords) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);

  if (!hits.length) {
    console.log(`没有匹配 "${keywords.join(' ')}" 的脚本。`);
    console.log('试试更短的关键词，或 node tools/snippet.mjs list 看全部。');
    return 0;
  }

  console.log(`匹配 ${hits.length} 项（关键词：${keywords.join(' ')}）`);
  console.log('');
  for (const { entry } of hits.slice(0, 12)) {
    console.log(`  ${entry.name.padEnd(18)} ${kindLabel(entry.kind).padEnd(8)} ${entry.category || '-'}`);
    console.log(`    ${(entry.purpose || '(无说明)').slice(0, 72)}`);
    if (entry.usage) console.log(`    ${entry.usage.slice(0, 76)}`);
    console.log(`    → node tools/snippet.mjs run ${entry.name} --help`);
    console.log('');
  }
  return 0;
}

function cmdList(args) {
  const kindFilter = args.includes('--kind') ? args[args.indexOf('--kind') + 1] : '';
  const data = readIndex();
  const entries = data.entries.filter((e) => !kindFilter || e.kind === kindFilter);

  const byKind = {};
  for (const entry of entries) {
    (byKind[entry.kind] = byKind[entry.kind] || []).push(entry);
  }

  for (const kind of Object.keys(byKind)) {
    console.log(`${kindLabel(kind)}（${byKind[kind].length}）`);
    for (const entry of byKind[kind]) {
      console.log(`  ${entry.name.padEnd(18)} ${(entry.purpose || '').slice(0, 60)}`);
    }
    console.log('');
  }
  console.log(`共 ${entries.length} 项`);
  return 0;
}

function findByName(data, name) {
  return data.entries.find((e) => e.name === name) || null;
}

function cmdShow(args) {
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('用法：node tools/snippet.mjs show <名称>');
    process.exit(2);
  }

  const entry = findByName(readIndex(), name);
  if (!entry) {
    console.error(`[fail] 没有名为 "${name}" 的条目`);
    return 2;
  }

  console.log(`${entry.name}  (${kindLabel(entry.kind)} / ${entry.category || '-'})`);
  console.log('─'.repeat(52));
  console.log('文件  ' + entry.path);
  console.log('用途  ' + (entry.purpose || '(无说明)'));
  if (entry.input) console.log('输入  ' + entry.input);
  if (entry.usage) console.log('用法  ' + entry.usage);
  if (entry.reuse) console.log('复用  ' + entry.reuse);
  return 0;
}

function cmdRun(args) {
  const name = args[0];
  if (!name) {
    console.error('用法：node tools/snippet.mjs run <名称> [参数...]');
    process.exit(2);
  }

  const entry = findByName(readIndex(), name);
  if (!entry) {
    console.error(`[fail] 没有名为 "${name}" 的条目`);
    return 2;
  }

  const file = path.join(ROOT, entry.path);
  if (!fs.existsSync(file)) {
    console.error('[fail] 文件不存在：' + file);
    return 2;
  }

  // Python 模块用 python 跑，其余用当前 node
  const isPython = entry.path.endsWith('.py');
  const runner = isPython ? 'python' : process.execPath;
  const passthrough = args.slice(1);

  console.log(`[run] ${isPython ? 'python' : 'node'} ${entry.path} ${passthrough.join(' ')}`.trim());
  const result = spawnSync(runner, [file, ...passthrough], {
    cwd: ROOT,
    stdio: 'inherit'
  });

  if (result.error) {
    console.error('[fail] ' + result.error.message);
    return 2;
  }
  return result.status === null ? 2 : result.status;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'search':
    case 's':
      return cmdSearch(rest);
    case 'list':
    case 'ls':
      return cmdList(rest);
    case 'show':
      return cmdShow(rest);
    case 'run':
    case 'r':
      return cmdRun(rest);
    default:
      console.log('脚本库检索（snippet）');
      console.log('');
      console.log('  node tools/snippet.mjs search <关键词>      模糊搜索');
      console.log('  node tools/snippet.mjs list [--kind tools]  按类型列出');
      console.log('  node tools/snippet.mjs show <名称>          查看用法');
      console.log('  node tools/snippet.mjs run <名称> [参数]    执行');
      console.log('');
      console.log('示例：');
      console.log('  node tools/snippet.mjs search 截图');
      console.log('  node tools/snippet.mjs run shot --url http://127.0.0.1:57910 --out x.png');
      return command ? 2 : 0;
  }
}

process.exit(main());
