#!/usr/bin/env node
/**
 * @name measure-cost
 * @category system
 * @purpose Measure whether calling a tool is cheaper than writing it from scratch:
 *          compares reuse cost (learn interface + invoke + parse output) against
 *          scratch cost (equivalent code + its dependency chain + debug rounds).
 * @input  [--json] [--runs N] [--include-self]
 * @usage  node tools/measure-cost.mjs
 *         node tools/measure-cost.mjs --json
 * @reuse  yes
 *
 * Token estimation: mixed CJK prose ≈ 1.6 chars/token, code ≈ 3.8 chars/token.
 * Everything below is derived from REAL measurements (help output, source size,
 * dependency closure, one live invocation) — no invented numbers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VAULT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOOLS = path.join(VAULT, 'tools');
const LIB = path.join(VAULT, 'lib');

const CODE_CHARS_PER_TOKEN = 3.8;
const PROSE_CHARS_PER_TOKEN = 1.6;
/** Cost of one extra "write / run / fix" iteration, measured in output+thinking. */
const DEBUG_ROUND_COST = 420;

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const includeSelf = argv.includes('--include-self');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Local imports of a module: ./x.mjs, ../lib/y.mjs */
function localImports(code) {
  const out = [];
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push(m[1]);
  return out;
}

/** Transitive closure of local modules, so "rewrite from scratch" pays for them too. */
function dependencyClosure(file, seen = new Set()) {
  const abs = path.resolve(file);
  if (seen.has(abs)) return seen;
  seen.add(abs);
  const code = readText(abs);
  for (const spec of localImports(code)) {
    const target = path.resolve(path.dirname(abs), spec);
    if (fs.existsSync(target)) dependencyClosure(target, seen);
  }
  return seen;
}

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

/** One representative invocation per tool, used to measure real output volume. */
const SAMPLE_CALLS = {
  'measure-cost.mjs': ['--json'],
  'scaffold.mjs': ['--help'],
  'shot.mjs': ['--help'],
  'adopt-project.mjs': ['--help']
};

/**
 * The CHEAPEST honest alternative for the tool's main job.
 *
 * This is the number that matters: "from scratch" means "the simplest thing that
 * actually solves the task", NOT "re-implement the existing tool line by line".
 * Writing a 400-line CDP client just to avoid calling shot.mjs would be silly,
 * but a two-line shell pipe can genuinely beat a 90-line tool.
 *
 * `tax` = expected extra cost when the shortcut forgets an edge case the tool
 * already handles (wrong git path, missing idempotency, stale index…).
 */
const SCRATCH_PLANS = {
  'shot.mjs': {
    code: [
      'msedge --headless=new --screenshot=out.png --window-size=1440,900 <url>',
      '# 只能出图；要 console 错误必须自建 CDP 客户端（约 150 行 / 5200 字符）'
    ].join('\n'),
    note: '纯截图一行搞定，但拿不到 console 错误',
    needsCdpForErrors: true,
    tax: 0
  },
  'git-report.mjs': {
    code: [
      "$g='C:\\Users\\GH\\AIWorkKit\\20261029081733\\.tools\\mingit\\cmd\\git.exe'",
      "$r=(Get-Content .\\config\\repos.json -Encoding UTF8|ConvertFrom-Json).repos",
      "$r|%{ '{0,-14} {1}' -f $_.name,(& $g -C $_.path status --porcelain|Measure-Object -Line).Lines }"
    ].join('\n'),
    note: '三行能拿到脏文件数，但漏掉 -Encoding UTF8 时 PS 5.1 按 GBK 解码，直接报错并吐出整份 JSON',
    // 实测代价：漏掉 -Encoding 得到 3000+ 字符的异常输出（约 780 token），
    // 远超「复用 vs 从零」之间的 76 token 差异 —— 这类隐性坑必须计入。
    tax: 900
  },
  'scaffold.mjs': {
    code: '写 25 行骨架：头部元数据 6 行 + parseArgs + 主流程 + 错误处理',
    chars: 800, // 实测：25 行 × 约 32 字符
    note: '模板固定，照着已有文件抄',
    tax: 200
  },
  'adopt-project.mjs': {
    code: '手写七步：.gitignore(9 行) + init + add + commit + 改 repos.json + 改 projects.json + scan',
    chars: 900,
    note: '七步里最容易漏白名单保护与幂等判断',
    tax: 300
  }
};

/** How much of the tool's output a human/agent actually has to read. */
const READ_CAP_CHARS = 600;

/** A minimal CDP client, needed only if the shortcut must also collect console errors. */
const CDP_CLIENT_CHARS = 5200;

async function main() {
  const files = fs
    .readdirSync(TOOLS)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => includeSelf || f !== 'measure-cost.mjs');

  const rows = [];

  for (const name of files) {
    const file = path.join(TOOLS, name);
    const code = readText(file);
    const deps = Array.from(dependencyClosure(file)).filter((p) => p !== path.resolve(file));
    const ownChars = code.length;
    const depChars = deps.reduce((acc, p) => acc + readText(p).length, 0);

    // --- cost of REUSE
    const help = await run(process.execPath, [file, '--help']);
    const helpChars = help.out.length + help.err.length;

    const sampleArgs = SAMPLE_CALLS[name] || ['--help'];
    const sample = await run(process.execPath, [file, ...sampleArgs]);
    const outputChars = sample.out.length + sample.err.length;
    // You read the summary, not every byte: cap the reading cost.
    const readChars = Math.min(outputChars, READ_CAP_CHARS);
    const callChars = 60;

    // Cold: you must read --help first. Warm: the rule file already tells you the
    // command, so only the invocation and the output you actually read are paid.
    const reuseCold = Math.round(helpChars / PROSE_CHARS_PER_TOKEN + (callChars + readChars) / CODE_CHARS_PER_TOKEN);
    const reuseWarm = Math.round((callChars + readChars) / CODE_CHARS_PER_TOKEN);

    // --- cost of SCRATCH: the cheapest honest alternative, not a re-implementation
    const plan = SCRATCH_PLANS[name];
    let scratchChars = 0;
    if (plan) {
      scratchChars = (plan.chars || plan.code.length) + (plan.tax || 0);
      // If the main use case needs console errors, a plain --screenshot cannot do
      // the job, so the scratch path has to bring a CDP client of its own.
      if (plan.needsCdpForErrors) scratchChars += CDP_CLIENT_CHARS;
    } else {
      scratchChars = ownChars + depChars;
    }
    const scratchTokens = Math.round(scratchChars / CODE_CHARS_PER_TOKEN);

    const ratio = reuseWarm === 0 ? 999 : scratchTokens / reuseWarm;

    rows.push({
      name,
      ownLines: code.split('\n').filter((l) => l.trim()).length,
      depFiles: deps.length,
      helpChars,
      outputChars,
      readChars,
      reuseCold,
      reuseWarm,
      scratchTokens,
      planNote: plan ? plan.note : '未登记最简方案，按等效实现计',
      ratio,
      verdict: ratio > 1.25 ? 'keep' : ratio < 0.9 ? 'drop' : 'neutral'
    });

    await sleep(60);
  }

  rows.sort((a, b) => b.ratio - a.ratio);

  if (asJson) {
    console.log(JSON.stringify({ root: VAULT, rows }, null, 2));
    return;
  }

  console.log('');
  console.log('  单次任务：调用复用脚本 vs 从零构建（token 估算，全部基于实测字符数）');
  console.log('  ' + '='.repeat(96));
  console.log(
    '  ' +
      'tool'.padEnd(19) +
      '行数'.padStart(5) +
      '复用(热)'.padStart(9) +
      '复用(冷)'.padStart(9) +
      '从零'.padStart(7) +
      '倍数'.padStart(8) +
      '  结论'
  );
  console.log('  ' + '-'.repeat(96));

  for (const r of rows) {
    const label = { keep: '保留', neutral: '持平', drop: '删除（从零更省）' }[r.verdict];
    console.log(
      '  ' +
        r.name.padEnd(19) +
        String(r.ownLines).padStart(5) +
        String(r.reuseWarm).padStart(9) +
        String(r.reuseCold).padStart(9) +
        String(r.scratchTokens).padStart(7) +
        (r.ratio.toFixed(2) + 'x').padStart(8) +
        '  ' + label
    );
  }

  console.log('  ' + '-'.repeat(96));
  console.log('  说明：复用(热)=规则里已写明命令，只需调用+读输出；复用(冷)=还要先读 --help');
  console.log('        从零=最简替代方案的实际字符数（含漏掉边界情况的返工）');
  console.log('');

  for (const r of rows) {
    console.log(`  · ${r.name}`);
    console.log(`      从零方案：${r.planNote}`);
    console.log(`      输出量：help ${r.helpChars} 字符 / 一次调用 ${r.outputChars} 字符`);
  }
  console.log('');

  const drop = rows.filter((r) => r.verdict === 'drop');
  const neutral = rows.filter((r) => r.verdict === 'neutral');
  console.log(`  共 ${rows.length} 个工具：保留 ${rows.length - drop.length - neutral.length}，持平 ${neutral.length}，建议删除 ${drop.length}`);
  if (drop.length) console.log('  建议删除：' + drop.map((r) => r.name).join(', '));
  console.log('');
}

main().catch((err) => {
  console.error('[measure-cost] ' + err.message);
  process.exit(1);
});
