#!/usr/bin/env node
/**
 * @name git-report
 * @category system
 * @purpose Snapshot every tracked repository: last commit, branch, uncommitted count.
 * @input  [--repo <path>]... [--json] [--md <file>] [--strict]
 * @usage  node tools/git-report.mjs --json
 *         node tools/git-report.mjs --md report.md --strict
 * @reuse  yes
 *
 * --strict makes the process exit non-zero when any repository is dirty, which is
 * what a "backup finished" check needs.
 */

import { parseArgs, arg, usage } from '../lib/cli.mjs';
import { inspectAll, findGit, loadRepoConfig } from '../lib/repo.mjs';
import { writeText } from '../lib/fsx.mjs';

/* Fallback only: the real list lives in config/repos.json (shared with CodeVault). */
const DEFAULT_REPOS = [
  { name: 'workspace', path: 'C:\\Users\\GH\\AIWorkKit\\20261029081733' },
  { name: 'pdf-library', path: 'C:\\Users\\GH\\AIWorkKit\\20260807162637' },
  { name: 'tarot-bot', path: 'C:\\Users\\GH\\AIWorkKit\\20261012151723' },
  { name: 'fire-emblem', path: 'C:\\Users\\GH\\AIWorkKit\\20261030084211' },
  { name: 'mine-console', path: 'C:\\Users\\GH\\AIWorkKit\\20261030104849' },
  { name: 'codevault', path: 'C:\\Users\\GH\\Desktop\\CodeVault' },
  { name: 'script-archive', path: 'C:\\Users\\GH\\Desktop\\handdelete' },
  { name: 'script-vault', path: 'C:\\Users\\GH\\Desktop\\ScriptVault' }
];

const repoConfig = loadRepoConfig(DEFAULT_REPOS);

const SPEC = {
  name: 'git-report',
  purpose: 'report the snapshot state of every tracked repository',
  options: [
    ['--repo <path>', 'extra repository path (repeatable)'],
    ['--json', 'print JSON instead of a table'],
    ['--md <file>', 'also write a markdown table to this file'],
    ['--strict', 'exit 1 when any repository has uncommitted changes']
  ],
  examples: ['node tools/git-report.mjs', 'node tools/git-report.mjs --json --strict']
};

const parsed = parseArgs(process.argv.slice(2), { booleans: ['json', 'strict'] });
if (parsed.help) {
  console.log(usage(SPEC));
  process.exit(0);
}

const extra = parsed.positional.concat(parsed.values.repo ? [parsed.values.repo] : []);
const repos = repoConfig.repos.concat(
  extra.map((p) => ({ name: 'custom', path: p }))
);

const rows = await inspectAll(repos);

if (parsed.flags.json) {
  console.log(
    JSON.stringify({ git: findGit(), source: repoConfig.source, config: repoConfig.file, repos: rows }, null, 2)
  );
} else {
  const width = Math.max(...rows.map((r) => r.name.length), 6);
  console.log('repo'.padEnd(width + 2) + 'branch'.padEnd(10) + 'commit'.padEnd(10) + 'dirty');
  for (const row of rows) {
    if (!row.tracked) {
      console.log(row.name.padEnd(width + 2) + '(no git)');
      continue;
    }
    console.log(
      row.name.padEnd(width + 2) + String(row.branch || '-').padEnd(10) +
      String(row.hash || '-').padEnd(10) + row.dirty
    );
  }
}

if (parsed.values.md) {
  const lines = ['| 仓库 | 分支 | 最近提交 | 日期 | 未提交 |', '|---|---|---|---|---|'];
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${row.tracked ? row.branch : '—'} | ${row.tracked ? row.hash + ' ' + row.subject : '未初始化'} | ` +
        `${row.tracked ? row.date : '—'} | ${row.tracked ? row.dirty : '—'} |`
    );
  }
  writeText(arg(parsed, 'md', ''), lines.join('\n') + '\n');
}

if (parsed.flags.strict && rows.some((r) => r.tracked && r.dirty > 0)) {
  process.exitCode = 1;
}
