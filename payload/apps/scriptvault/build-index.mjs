#!/usr/bin/env node
/**
 * @name build-index
 * @category scaffold
 * @purpose Scan lib/, tools/ and tests/ for metadata headers and write index.json.
 * @input  [--check]  exit 1 when index.json is stale
 * @usage  node build-index.mjs
 * @reuse  yes
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/cli.mjs';
import { writeJson, readJson, fmtBytes } from './lib/fsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.join(HERE, 'index.json');
const SCAN_DIRS = ['lib', 'tools', 'py', 'tests'];

export const CATEGORY_LABELS = {
  core: '核心模块',
  browser: '浏览器 / CDP',
  cad: '制图 / DXF',
  doc: '文档 / PDF / 表格',
  data: '数据处理',
  system: '系统 / 进程',
  web: '抓取 / 接口',
  test: '回归测试',
  scaffold: '脚手架 / 索引'
};

/** Read @name/@category/@purpose/@input/@usage/@reuse out of a file header. */
export function parseMeta(text, fallbackName) {
  const head = text.slice(0, 2600);
  const block = /\/\*\*([\s\S]*?)\*\//.exec(head);
  const docstring = /"""([\s\S]*?)"""/.exec(head);
  const body = (block && block[1]) || (docstring && docstring[1]) || '';
  const get = (key) => {
    const match = new RegExp('@' + key + '\\s+([^\\n*]+)').exec(body);
    return match ? match[1].trim() : '';
  };
  return {
    name: get('name') || fallbackName,
    category: get('category') || 'system',
    purpose: get('purpose') || '',
    input: get('input') || '',
    usage: get('usage') || '',
    reuse: (get('reuse') || '').toLowerCase() === 'yes'
  };
}

function describe(file, kind) {
  let stat;
  let text = '';
  try {
    stat = fs.statSync(file);
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const meta = parseMeta(text, path.basename(file, path.extname(file)));
  return {
    kind,
    file: path.basename(file),
    path: path.relative(HERE, file).replace(/\\/g, '/'),
    bytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString().slice(0, 10),
    ...meta
  };
}

const parsed = parseArgs(process.argv.slice(2), { booleans: ['check'] });

const entries = [];
for (const dir of SCAN_DIRS) {
  const full = path.join(HERE, dir);
  if (!fs.existsSync(full)) continue;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(mjs|js|py)$/.test(entry.name)) continue;
    const described = describe(path.join(full, entry.name), dir);
    if (described) entries.push(described);
  }
}

entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));

const counts = {};
for (const entry of entries) counts[entry.category] = (counts[entry.category] || 0) + 1;

const index = {
  schema: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  root: HERE,
  summary: {
    total: entries.length,
    modules: entries.filter((e) => e.kind === 'lib').length,
    tools: entries.filter((e) => e.kind === 'tools').length,
    python: entries.filter((e) => e.kind === 'py').length,
    tests: entries.filter((e) => e.kind === 'tests').length,
    documented: entries.filter((e) => e.purpose).length
  },
  categories: Object.keys(counts)
    .sort()
    .map((id) => ({ id, label: CATEGORY_LABELS[id] || id, count: counts[id] })),
  entries
};

if (parsed.flags.check) {
  const current = readJson(INDEX_FILE, null);
  const same = current && JSON.stringify(current.entries) === JSON.stringify(index.entries);
  if (!same) {
    console.error('[index] stale: run node build-index.mjs');
    process.exitCode = 1;
  } else {
    console.log('[index] up to date (' + entries.length + ' entries)');
  }
} else {
  writeJson(INDEX_FILE, index);
  console.log(
    `[index] ${entries.length} entries (${index.summary.modules} modules, ` +
      `${index.summary.tools} tools, ${index.summary.tests} tests) -> index.json`
  );
  for (const category of index.categories) {
    console.log('  ' + category.id.padEnd(10) + String(category.count).padStart(3) + '  ' + category.label);
  }
}

export { fmtBytes };
