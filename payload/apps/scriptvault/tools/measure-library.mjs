#!/usr/bin/env node
/**
 * @name measure-library
 * @category system
 * @purpose Measure the whole-library cost: discovering a tool inside the library
 *          (reading index.json), learning its interface, invoking it, reading the
 *          result — versus writing the same capability from scratch.
 * @input  [--json] [--cold]   --cold counts reading the ENTIRE index to discover
 * @usage  node tools/measure-library.mjs
 *         node tools/measure-library.mjs --cold
 * @reuse  yes
 *
 * Difference from measure-cost.mjs:
 *   measure-cost 假设「已经知道该用哪个脚本」。
 *   measure-library 加上「从脚本库里找到它」的成本 —— 这才是新会话/新机器的真实开销。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VAULT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INDEX = path.join(VAULT, 'index.json');

const CODE_CPT = 3.8; // chars per token, code
const PROSE_CPT = 1.6; // chars per token, prose (CJK-heavy)

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const cold = argv.includes('--cold');

/**
 * For each reusable unit: what a caller actually writes to use it, and what
 * writing the equivalent from scratch costs (measured from the real files).
 */
const PLANS = {
  'excel_report.py': {
    invoke: [
      'import excel_report as xl',
      'wb = xl.new_workbook()',
      'ws = xl.build_table(wb, "比价表", headers, rows,',
      '                    subtitle_text="…", widths_map={"A": 6, "C": 34})',
      'wb.save("out.xlsx")'
    ].join('\n'),
    scratchChars: 2200,
    scratchNote: '重写 title/subtitle/head/body/widths 五件套 + 颜色/边框/冻结常量',
    taxChars: 400,
    steps: 1,
    inRule: false
  },
  'dxf_draw.py': {
    invoke: [
      'import dxf_draw as dd',
      'doc, msp = dd.new_drawing()',
      'dd.frame_a3(msp, meta={"名称": "标定罩", "图号": "GH-2026-001"})',
      'dd.rect(msp, 120, 150, 160, 60)',
      'dd.dim_h(msp, 120, 280, y_ref=150, y=132)',
      'doc.saveas("part.dxf")'
    ].join('\n'),
    scratchChars: 3200,
    scratchNote: '重写图元 + 尺寸标注几何（箭头三角形、界线交点）+ A3 图框与标题栏',
    taxChars: 700,
    steps: 2,
    inRule: false
  },
  'shot.mjs': {
    invoke: 'node tools/shot.mjs --url <url> --launch --out x.png --json --close',
    scratchChars: 80 + 5200,
    scratchNote: 'msedge --headless 一行 + 想拿 console 错误就得自带 CDP 客户端（150 行）',
    taxChars: 0,
    steps: 1,
    inRule: true // project-onboarding.mdc §3 已列出
  },
  'git-report.mjs': {
    invoke: 'node tools/git-report.mjs --strict',
    scratchChars: 250,
    scratchNote: '三行 PowerShell 遍历 repos.json',
    taxChars: 900, // 实测：漏 -Encoding UTF8 会被 GBK 解码坑一次
    steps: 2,
    inRule: true
  },
  'scaffold.mjs': {
    invoke: 'node tools/scaffold.mjs my-tool --purpose "…" --category web',
    scratchChars: 800,
    scratchNote: '手写 25 行标准头部骨架',
    taxChars: 200,
    steps: 1,
    inRule: true
  },
  'adopt-project.mjs': {
    invoke: 'node tools/adopt-project.mjs "<dir>" --name <slug> --dry',
    scratchChars: 900,
    scratchNote: '手写七步：gitignore / init / commit / repos.json / projects.json / scan',
    taxChars: 300,
    steps: 7, // gitignore / init / add / commit / repos.json / projects.json / scan
    inRule: true
  }
};

/** Length of the leading doc-comment block — what you actually read to learn the API. */
function headerChars(text) {
  const head = text.slice(0, 2600);
  const block = /\/\*\*([\s\S]*?)\*\//.exec(head);
  const doc = /"""([\s\S]*?)"""/.exec(head);
  const body = (block && block[1]) || (doc && doc[1]) || '';
  return body.length;
}

/**
 * Fixed overhead of ONE tool call (argument JSON + result wrapper + your decision
 * to make it). Measured from this session: a no-op call costs roughly 120 tokens.
 * Writing something from scratch in 7 steps pays this 7 times; calling a finished
 * tool pays it once.
 */
const STEP_OVERHEAD_TOKENS = 120;
const STEP_OVERHEAD_CHARS = Math.round(STEP_OVERHEAD_TOKENS * CODE_CPT);

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Whole-index size = the cost of browsing the library when you do not know what exists. */
function indexCosts(index) {
  const raw = JSON.stringify(index);
  const perEntry = {};
  let sum = 0;
  for (const entry of index.entries || []) {
    const slice = JSON.stringify({
      name: entry.name,
      kind: entry.kind,
      category: entry.category,
      purpose: entry.purpose,
      usage: entry.usage
    });
    perEntry[entry.name] = slice.length;
    sum += slice.length;
  }
  return { whole: raw.length, perEntry, sumOfEntries: sum };
}

function main() {
  if (!fs.existsSync(INDEX)) {
    console.error('[measure-library] index.json missing: run node build-index.mjs');
    process.exit(2);
  }
  const index = JSON.parse(readText(INDEX));
  const costs = indexCosts(index);
  const browsing = cold ? costs.sumOfEntries : 0;

  const rows = [];

  for (const entry of index.entries || []) {
    const plan = PLANS[entry.file];
    if (!plan) continue;

    const file = path.join(VAULT, entry.path);
    const source = readText(file);
    // Learning the interface means reading the header block, not the whole file.
    const interfaceChars = headerChars(source);

    // Discovery cost, three tiers:
    //   --cold      browse every entry summary (new machine, nothing memorised)
    //   inRule      the rule file already lists the command -> nothing to discover
    //   otherwise   read just this one index entry
    let discoverChars;
    if (cold) discoverChars = costs.sumOfEntries;
    else if (plan.inRule) discoverChars = 0;
    else discoverChars = costs.perEntry[entry.name] || 0;

    const reuseChars = discoverChars + interfaceChars + plan.invoke.length + 600; // 600 = 读结果
    const reuseTokens = Math.round(discoverChars / PROSE_CPT + (interfaceChars + plan.invoke.length + 600) / CODE_CPT);

    // From-scratch cost = code + one tool call per step + the extra round when a
    // detail the tool already handles gets missed.
    const steps = plan.steps || 1;
    const scratchChars = plan.scratchChars + steps * STEP_OVERHEAD_CHARS + (plan.taxChars || 0);
    const scratchTokens = Math.round(scratchChars / CODE_CPT);

    rows.push({
      name: entry.name,
      kind: entry.kind,
      category: entry.category,
      discoverChars,
      interfaceChars,
      invokeChars: plan.invoke.length,
      reuseChars,
      reuseTokens,
      scratchChars,
      scratchTokens,
      ratio: reuseTokens ? scratchTokens / reuseTokens : 999,
      scratchNote: plan.scratchNote
    });
  }

  rows.sort((a, b) => b.ratio - a.ratio);

  if (asJson) {
    console.log(JSON.stringify({ cold, indexChars: costs.whole, rows }, null, 2));
    return;
  }

  console.log('');
  console.log(
    '  库级成本：找到脚本 + 学接口 + 调用 + 读结果  vs  从零构建' + (cold ? '（冷启动：读全部索引）' : '（热：只读该条目）')
  );
  console.log('  ' + '='.repeat(100));
  console.log(
    '  ' +
      'unit'.padEnd(20) +
      '发现'.padStart(7) +
      '接口'.padStart(7) +
      '调用'.padStart(7) +
      '复用'.padStart(7) +
      '从零'.padStart(7) +
      '倍数'.padStart(8) +
      '  结论'
  );
  console.log('  ' + '-'.repeat(100));

  for (const r of rows) {
    const verdict = r.ratio > 1.25 ? '保留' : r.ratio < 0.9 ? '删除' : '持平';
    console.log(
      '  ' +
        r.name.padEnd(20) +
        String(Math.round(r.discoverChars / PROSE_CPT)).padStart(7) +
        String(Math.round(r.interfaceChars / CODE_CPT)).padStart(7) +
        String(Math.round(r.invokeChars / CODE_CPT)).padStart(7) +
        String(r.reuseTokens).padStart(7) +
        String(r.scratchTokens).padStart(7) +
        (r.ratio.toFixed(2) + 'x').padStart(8) +
        '  ' + verdict
    );
  }

  console.log('  ' + '-'.repeat(100));
  console.log(`  索引总大小 ${costs.whole} 字符（约 ${Math.round(costs.whole / PROSE_CPT)} token）`);
  console.log(`  条目摘要合计 ${costs.sumOfEntries} 字符（约 ${Math.round(costs.sumOfEntries / PROSE_CPT)} token）`);
  console.log('');
  console.log('  发现成本口径：');
  if (cold) {
    console.log(`    冷启动 = 读全部条目摘要（${costs.sumOfEntries} 字符）`);
  } else {
    console.log('    已在规则里列出 → 0（rules 是 alwaysApply，命令就在上下文里）');
    console.log('    只在索引里   → 读该条目摘要');
  }
  console.log('');

  for (const r of rows) {
    console.log(`  · ${r.name}（${r.kind} / ${r.category}）`);
    console.log(`      从零等价实现：${r.scratchChars} 字符 — ${r.scratchNote}`);
  }
  console.log('');

  const drop = rows.filter((r) => r.ratio < 0.9);
  console.log(`  共 ${rows.length} 个可复用单元：保留 ${rows.length - drop.length}，建议删除 ${drop.length}`);
  if (drop.length) console.log('  建议删除：' + drop.map((r) => r.name).join(', '));
  console.log('');
}

main();
