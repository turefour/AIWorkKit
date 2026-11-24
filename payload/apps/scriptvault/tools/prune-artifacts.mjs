#!/usr/bin/env node
/**
 * @name prune-artifacts
 * @category system
 * @purpose 按扩展名清理目录里的产物文件（截图、日志、临时输出），默认先演练，
 *          只删顶层文件、不动子目录与业务数据。
 * @input  <dir> [--ext png,out,log] [--dry] [--recursive] [--limit N]
 * @usage  node tools/prune-artifacts.mjs "C:\path" --ext png,out,log --dry
 *         node tools/prune-artifacts.mjs "C:\path" --ext png,out,log
 * @reuse  yes
 *
 * 为什么单独成工具：handdelete 里清理一次要写四五行 node -e，而且每次都得
 * 重新确认「哪些扩展名算产物、哪些是业务数据」。把这些判断固化下来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, arg } from '../lib/cli.mjs';

/** 明确视为「业务数据」的扩展名，防止手滑传成 --ext 时被一起删掉。 */
const BUSINESS_EXT = new Set(['.xls', '.xlsx', '.doc', '.docx', '.pdf', '.csv', '.dxf', '.dwg', '.sql', '.db']);

const PROTECTED_NAMES = new Set(['.gitignore', '.gitattributes', 'README.md', 'package.json', 'index.json']);

const parsed = parseArgs(process.argv.slice(2), { booleans: ['dry', 'recursive'] });
const target = parsed.positional[0];
const dry = Boolean(parsed.flags.dry);
const recursive = Boolean(parsed.flags.recursive);
const limit = Number(arg(parsed, 'limit', '0')) || 0;

if (!target) {
  console.error('用法: node tools/prune-artifacts.mjs <dir> --ext png,out,log [--dry] [--recursive] [--limit N]');
  process.exit(2);
}

const root = path.resolve(target);
if (!fs.existsSync(root)) {
  console.error('目录不存在: ' + root);
  process.exit(2);
}

const extArg = arg(parsed, 'ext', 'png,out,log');
const exts = extArg
  .split(',')
  .map((e) => (e.trim().startsWith('.') ? e.trim().toLowerCase() : '.' + e.trim().toLowerCase()))
  .filter(Boolean);

const refused = exts.filter((e) => BUSINESS_EXT.has(e));
if (refused.length) {
  console.error('[拒绝] 这些扩展名属于业务数据，不参与清理：' + refused.join(', '));
  console.error('       如确有需要，请手工确认后删除。');
  process.exit(2);
}

/** 收集待删文件（只顶层，除非 --recursive）。 */
function collect() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (PROTECTED_NAMES.has(entry.name)) continue;
      if (exts.includes(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  walk(root);
  return out;
}

const files = collect();
const totalBytes = files.reduce((sum, f) => {
  try {
    return sum + fs.statSync(f).size;
  } catch {
    return sum;
  }
}, 0);

console.log('');
console.log('  目录: ' + root);
console.log('  扩展名: ' + exts.join(', ') + (recursive ? '（含子目录）' : '（仅顶层）'));
console.log('  命中: ' + files.length + ' 个文件, ' + (totalBytes / 1048576).toFixed(1) + ' MB');

if (!files.length) {
  console.log('  没有可清理的文件。');
  console.log('');
  process.exit(0);
}

if (dry) {
  console.log('  [演练] 前 10 个：');
  for (const f of files.slice(0, 10)) {
    console.log('    ' + path.basename(f));
  }
  console.log('  加 --dry 只是演练，去掉即执行删除。');
  console.log('');
  process.exit(0);
}

const batch = limit > 0 ? Math.min(limit, files.length) : files.length;
let deleted = 0;
let bytes = 0;
let failed = 0;

/**
 * 每 BATCH_SIZE 个操作后停一下。
 * 实测：本机安全软件的过滤驱动在连续删除约 500 个文件后会开始拒绝操作
 * （返回 EPERM/EBUSY），间隔几百毫秒即可恢复，否则剩下的一次性全失败。
 */
const BATCH_SIZE = 300;
const BATCH_PAUSE_MS = 350;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (let index = 0; index < batch; index += 1) {
  const file = files[index];
  try {
    bytes += fs.statSync(file).size;
    fs.unlinkSync(file);
    deleted += 1;
  } catch {
    failed += 1;
  }
  if ((deleted + failed) % BATCH_SIZE === 0) {
    console.log('    ...已处理 ' + (deleted + failed) + ' 个');
    await sleep(BATCH_PAUSE_MS);
  }
}

console.log(
  '  已删除 ' + deleted + ' 个, ' + (bytes / 1048576).toFixed(1) + ' MB' + (failed ? '，失败 ' + failed + ' 个' : '')
);
if (limit > 0 && files.length > limit) {
  console.log('  剩余 ' + (files.length - limit) + ' 个（--limit 限制批量，可重复执行）');
}
console.log('');
