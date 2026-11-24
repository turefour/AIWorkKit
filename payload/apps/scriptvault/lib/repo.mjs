/**
 * @module repo
 * @category system
 * @purpose Read-only Git snapshot inspection for a list of repositories (portable git aware).
 * @usage  import { findGit, inspectRepo, inspectAll } from '../lib/repo.mjs';
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORTABLE_GIT = 'C:\\Users\\GH\\AIWorkKit\\20261029081733\\.tools\\mingit\\cmd\\git.exe';
const VAULT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_FILE = path.join(VAULT_ROOT, 'config', 'repos.json');

/** Prefer the portable MinGit bundled with the workspace, fall back to PATH. */
export function findGit() {
  return fs.existsSync(PORTABLE_GIT) ? PORTABLE_GIT : 'git';
}

/**
 * Load the repository list from config/repos.json.
 * The JSON file is the single source of truth: the CodeVault server reads it for
 * the dashboard, and adopt-project reads/writes it when onboarding a repository.
 *
 * @param {Array<{name:string,path:string}>} fallback used when the file is missing
 */
export function loadRepoConfig(fallback = []) {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (Array.isArray(data.repos) && data.repos.length) {
      return { repos: data.repos, file: CONFIG_FILE, source: 'config' };
    }
  } catch {
    /* missing or broken file -> fall through */
  }
  return { repos: fallback, file: CONFIG_FILE, source: 'fallback' };
}

/** Persist the repository list (atomic write). */
export function saveRepoConfig(repos) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const payload = {
    $comment:
      '仓库清单的单一真相源：CodeVault 页面与 adopt-project 都读这里。新增项目跑 tools/adopt-project.mjs，不要手改多份数组。',
    updatedAt: new Date().toISOString().slice(0, 10),
    repos
  };
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return CONFIG_FILE;
}

/**
 * Insert or update one repository entry (matched by path, case-insensitive).
 * @returns {{repos:Array, added:boolean}}
 */
export function upsertRepo(entry, repos = loadRepoConfig().repos) {
  const key = path.resolve(entry.path).toLowerCase();
  const at = repos.findIndex((repo) => path.resolve(repo.path).toLowerCase() === key);
  if (at >= 0) {
    repos[at] = { ...repos[at], ...entry };
    return { repos, added: false };
  }
  repos.push(entry);
  return { repos, added: true };
}

function run(git, args, cwd, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(git, args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

/**
 * Inspect one repository.
 * @returns {Promise<{path:string, tracked:boolean, hash?:string, date?:string, subject?:string, dirty?:number, branch?:string}>}
 */
export async function inspectRepo(repoPath, git = findGit()) {
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    return { path: repoPath, tracked: false };
  }
  const log = await run(git, ['log', '-1', '--format=%h%x09%ad%x09%s', '--date=short'], repoPath);
  const status = await run(git, ['status', '--porcelain'], repoPath);
  const branch = await run(git, ['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  const [hash, date, subject] = (log || '').split('\t');
  return {
    path: repoPath,
    tracked: true,
    hash: hash || '',
    date: date || '',
    subject: subject || '',
    branch: branch || '',
    dirty: status ? status.split('\n').filter(Boolean).length : 0
  };
}

/** Inspect a list of { name, path } entries in parallel. */
export async function inspectAll(repos, git = findGit()) {
  return Promise.all(
    repos.map(async (repo) => ({ ...repo, ...(await inspectRepo(repo.path, git)) }))
  );
}

/** Commit count for a repository (used as a cheap activity signal). */
export async function commitCount(repoPath, git = findGit()) {
  const out = await run(git, ['rev-list', '--count', 'HEAD'], repoPath);
  return Number(out) || 0;
}
