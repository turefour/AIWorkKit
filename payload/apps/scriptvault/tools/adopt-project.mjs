#!/usr/bin/env node
/**
 * @name adopt-project
 * @category scaffold
 * @purpose Onboard a project directory in one shot: generate .gitignore, init the
 *          repository, make the first commit, register it in the shared repo list
 *          and add an entry to the CodeVault index.
 * @input  <dir> [--name slug] [--label 显示名] [--kind 类型] [--note 说明]
 *          [--stack node|python|static|none] [--message "提交说明"]
 *          [--dry] [--no-commit] [--no-register] [--force-ignore]
 * @usage  node tools/adopt-project.mjs "C:\Users\GH\Desktop\my-project" --name my-project
 *         node tools/adopt-project.mjs . --dry
 * @reuse  yes
 *
 * Safe by default:
 *  - never rewrites an existing whitelist .gitignore (`/*` + `!` rules)
 *  - --dry prints the plan and touches nothing
 *  - registering twice updates the entry instead of duplicating it
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs, arg, usage } from '../lib/cli.mjs';
import { findGit, loadRepoConfig, upsertRepo, saveRepoConfig } from '../lib/repo.mjs';

const VAULT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CODEVAULT = 'C:\\Users\\GH\\Desktop\\CodeVault';
const PROJECTS_FILE = path.join(CODEVAULT, 'data', 'projects.json');
const SCAN = path.join(CODEVAULT, 'tools', 'scan.mjs');

const SPEC = {
  name: 'adopt-project',
  purpose: 'init git + first commit + register in repo list and CodeVault index',
  options: [
    ['<dir>', 'project directory (required)'],
    ['--name <slug>', 'repository slug (default: folder name)'],
    ['--label <text>', 'display name in the index (default: folder name)'],
    ['--kind <text>', 'project kind, e.g. "全栈应用"'],
    ['--note <text>', 'one-line summary shown in the index'],
    ['--stack <s>', 'ignore template: node | python | static | none (auto-detected)'],
    ['--message <text>', 'first commit message'],
    ['--dry', 'print the plan, change nothing'],
    ['--no-commit', 'init and register, but do not commit'],
    ['--no-register', 'only touch git, skip repo list and index'],
    ['--force-ignore', 'append template even when a whitelist .gitignore exists']
  ],
  examples: [
    'node tools/adopt-project.mjs ..\\my-app --name my-app --stack node',
    'node tools/adopt-project.mjs "C:\\work\\legacy" --dry'
  ]
};

const IGNORE_TEMPLATES = {
  node: [
    'node_modules/',
    'dist/',
    'build/',
    'coverage/',
    '.cache/',
    '*.log',
    '.env',
    '.env.*',
    '*.tsbuildinfo'
  ],
  python: [
    '__pycache__/',
    '*.py[cod]',
    '.venv/',
    'venv/',
    '.pytest_cache/',
    '.mypy_cache/',
    '*.log',
    '.env'
  ],
  static: ['*.log', '.DS_Store', 'Thumbs.db', '~$*'],
  none: ['*.log', '.DS_Store', 'Thumbs.db']
};

/* ---------------------------------------------------------------- git */

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      findGit(),
      args,
      { cwd, timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: String(stdout || '').trim(),
          err: String(stderr || (err && err.message) || '').trim()
        });
      }
    );
  });
}

async function commitIdentity(dir) {
  const name = await git(['config', 'user.name'], dir);
  const email = await git(['config', 'user.email'], dir);
  return name.out && email.out
    ? []
    : ['-c', 'user.name=CodeVault', '-c', 'user.email=codevault@local'];
}

/* ---------------------------------------------------------------- ignore */

function detectStack(dir) {
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'node';
  try {
    const entries = fs.readdirSync(dir);
    if (entries.some((n) => n.endsWith('.py'))) return 'python';
    if (fs.existsSync(path.join(dir, 'dist')) || fs.existsSync(path.join(dir, 'index.html'))) return 'static';
  } catch {
    /* unreadable -> none */
  }
  return 'none';
}

/**
 * Decide what to append to .gitignore.
 * A whitelist file (`/*` + `!pattern`) is authoritative: appending blacklist rules
 * to it would silently start ignoring files the author meant to track.
 */
function planIgnore(dir, stack, force) {
  const file = path.join(dir, '.gitignore');
  let current = '';
  let exists = false;
  try {
    current = fs.readFileSync(file, 'utf8');
    exists = true;
  } catch {
    /* no file yet */
  }

  if (exists && /^\s*\/\*\s*$/m.test(current) && !force) {
    return { mode: 'whitelist', file, exists, lines: [], reason: '检测到白名单规则（/* + !...），保持原样' };
  }

  const wanted = IGNORE_TEMPLATES[stack] || IGNORE_TEMPLATES.none;
  const have = new Set(current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = wanted.filter((line) => !have.has(line));

  if (!missing.length) {
    return { mode: 'noop', file, exists, lines: [], reason: '规则已齐全' };
  }
  return { mode: exists ? 'append' : 'create', file, exists, lines: missing, reason: '' };
}

function applyIgnore(plan) {
  if (plan.mode === 'whitelist' || plan.mode === 'noop') return;
  const header = plan.mode === 'create' ? '' : '\n# added by adopt-project\n';
  const body = plan.lines.join('\n') + '\n';
  fs.writeFileSync(plan.file, (plan.current == null ? '' : plan.current.replace(/\s*$/, '')) + header + body, 'utf8');
}

/* ---------------------------------------------------------------- index */

function registerProject({ id, dir, label, kind, note }) {
  if (!fs.existsSync(PROJECTS_FILE)) {
    return { ok: false, action: 'skipped', reason: '未找到 CodeVault 索引文件' };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
  } catch (err) {
    return { ok: false, action: 'skipped', reason: '索引文件无法解析：' + err.message };
  }

  const today = new Date().toISOString().slice(0, 10);
  const at = (data.projects || []).findIndex((p) => p.id === id);

  if (at >= 0) {
    const project = data.projects[at];
    project.path = dir;
    if (label) project.name = label;
    if (kind) project.kind = kind;
    if (note) project.summary = note;
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return { ok: true, action: 'updated', id };
  }

  data.projects = data.projects || [];
  data.projects.push({
    id,
    path: dir,
    name: label || id,
    kind: kind || '待补充',
    status: 'active',
    session: '自动接入',
    summary: note || '（待补充说明：这个项目解决什么问题）',
    stack: [],
    scale: { files: 0, loc: 0, main: '' },
    build: [],
    sections: [],
    issues: [],
    changelog: [
      {
        version: '0.1.0',
        date: today,
        items: ['通过 tools/adopt-project.mjs 接入版本控制与索引库']
      }
    ]
  });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ok: true, action: 'added', id };
}

function runScan() {
  return new Promise((resolve) => {
    if (!fs.existsSync(SCAN)) return resolve({ ok: false, reason: '未找到 scan.mjs' });
    const child = spawn(process.execPath, [SCAN], {
      cwd: CODEVAULT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('exit', (code) => resolve({ ok: code === 0, out: out.trim().slice(-200) }));
    child.on('error', (err) => resolve({ ok: false, reason: err.message }));
  });
}

/* ---------------------------------------------------------------- main */

const parsed = parseArgs(process.argv.slice(2), {
  booleans: ['dry', 'help', 'no-commit', 'no-register', 'force-ignore']
});

if (parsed.help || !parsed.positional.length) {
  console.log(usage(SPEC));
  process.exit(parsed.help ? 0 : 1);
}

const target = path.resolve(parsed.positional[0]);
const flag = (name) => Boolean(parsed.flags[name]);
const dry = flag('dry');
const doCommit = !flag('no-commit');
const doRegister = !flag('no-register');

if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error('目录不存在或不是文件夹：' + target);
  process.exit(1);
}

const folder = path.basename(target);
const name = String(arg(parsed, 'name', '') || folder).trim();
const label = String(arg(parsed, 'label', '') || folder).trim();
const kind = String(arg(parsed, 'kind', '')).trim();
const note = String(arg(parsed, 'note', '')).trim();
const stack = String(arg(parsed, 'stack', '') || detectStack(target)).trim();
const message = String(arg(parsed, 'message', '') || `chore: adopt ${name} into version control`);

console.log('=== adopt-project ' + (dry ? '(dry run)' : '') + ' ===');
console.log('目录      : ' + target);
console.log('仓库名    : ' + name);
console.log('技术栈    : ' + stack + (arg(parsed, 'stack', '') ? ' (指定)' : ' (自动识别)'));

const ignorePlan = planIgnore(target, stack, flag('force-ignore'));
console.log(
  '.gitignore: ' +
    (ignorePlan.mode === 'create'
      ? '新建，写入 ' + ignorePlan.lines.length + ' 条'
      : ignorePlan.mode === 'append'
        ? '追加 ' + ignorePlan.lines.length + ' 条'
        : ignorePlan.mode === 'whitelist'
          ? '保持原样（白名单）'
          : '已齐全，不改动')
);

const hasRepo = fs.existsSync(path.join(target, '.git'));
console.log('git 仓库  : ' + (hasRepo ? '已存在' : '将初始化 (main)'));

if (dry) {
  if (ignorePlan.lines.length) {
    console.log('\n将写入的规则：');
    for (const line of ignorePlan.lines) console.log('  + ' + line);
  }
  console.log('\n[dry] 未做任何改动。去掉 --dry 执行。');
  process.exit(0);
}

// ---------- 1. .gitignore
ignorePlan.current = ignorePlan.exists ? fs.readFileSync(ignorePlan.file, 'utf8') : '';
applyIgnore(ignorePlan);

// ---------- 2. git init
if (!hasRepo) {
  const init = await git(['init', '-b', 'main'], target);
  if (!init.ok) {
    console.error('git init 失败：' + init.err);
    process.exit(1);
  }
}

// ---------- 3. first commit
let commitInfo = { action: 'skipped', hash: '' };
if (doCommit) {
  const head = await git(['rev-parse', '--verify', 'HEAD'], target);
  const pending = await git(['status', '--porcelain'], target);
  const changes = pending.out ? pending.out.split('\n').filter(Boolean).length : 0;

  if (!head.ok && !changes) {
    commitInfo = { action: 'empty', hash: '', reason: '没有任何文件，跳过提交' };
  } else if (head.ok && !changes) {
    commitInfo = { action: 'clean', hash: (await git(['rev-parse', '--short', 'HEAD'], target)).out };
  } else {
    await git(['add', '-A'], target);
    const ident = await commitIdentity(target);
    const finalMessage = head.ok ? `chore: adopt ${name} (snapshot)` : message;
    const commit = await git([...ident, 'commit', '-m', finalMessage], target);
    if (!commit.ok) {
      commitInfo = { action: 'failed', hash: '', reason: commit.err };
    } else {
      const short = await git(['rev-parse', '--short', 'HEAD'], target);
      commitInfo = { action: head.ok ? 'snapshot' : 'initial', hash: short.out };
    }
  }
}

// ---------- 4. repo list
let repoInfo = { action: 'skipped' };
if (doRegister) {
  const config = loadRepoConfig([]);
  const { repos, added } = upsertRepo({ name, path: target, note: note || label }, config.repos);
  saveRepoConfig(repos);
  repoInfo = { action: added ? 'added' : 'updated', count: repos.length, file: config.file };
}

// ---------- 5. CodeVault index
let indexInfo = { action: 'skipped' };
let scanInfo = { ok: false };
if (doRegister) {
  indexInfo = registerProject({ id: name, dir: target, label, kind, note });
  if (indexInfo.ok) scanInfo = await runScan();
}

// ---------- report
console.log('');
console.log('gitignore : ' + (ignorePlan.mode === 'noop' ? '未改动' : ignorePlan.mode));
console.log(
  '提交      : ' +
    ({
      initial: '首次提交 ' + commitInfo.hash,
      snapshot: '已提交快照 ' + commitInfo.hash,
      clean: '无变更，HEAD ' + commitInfo.hash,
      empty: '空目录，未提交',
      failed: '失败：' + commitInfo.reason,
      skipped: '已跳过 (--no-commit)'
    }[commitInfo.action] || commitInfo.action)
);
console.log(
  '仓库清单  : ' +
    (repoInfo.action === 'skipped'
      ? '已跳过 (--no-register)'
      : (repoInfo.action === 'added' ? '已新增' : '已更新') + ' / 共 ' + repoInfo.count + ' 个')
);
console.log(
  '索引库    : ' +
    (indexInfo.action === 'skipped'
      ? '已跳过 (--no-register)'
      : indexInfo.action === 'added'
        ? '已登记条目 ' + indexInfo.id
        : '已更新条目 ' + indexInfo.id)
);
if (indexInfo.ok) console.log('索引刷新  : ' + (scanInfo.ok ? '已完成' : '失败（可手动跑 scan.mjs）'));
console.log('');
console.log('打开 http://127.0.0.1:47910/#__repos__ 可看到该仓库状态。');

if (commitInfo.action === 'failed') process.exitCode = 1;
