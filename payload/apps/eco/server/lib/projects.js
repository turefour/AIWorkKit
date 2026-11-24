'use strict';

/**
 * AIWorkKit Eco - project attribution for processes and plugins.
 *
 * A running script belongs to whichever project root contains it. Roots are
 * detected by climbing from the path found in the command line until a project
 * marker appears (.git / package.json / pyproject.toml / go.mod / ...).
 *
 * Results are cached per directory with a TTL so the 3.5s sampler stays cheap.
 */

const fs = require('fs');
const path = require('path');

const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'composer.json', '.codebuddy-plugin'];
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ASCEND = 8;

const dirCache = new Map(); // dir -> { root, at }

// Dependency / cache directories are package roots, not user projects: an npx
// package.json must not turn every MCP helper into a fake "project".
const DEPENDENCY_RE = /(^|[\\/])(node_modules|_npx|npm-cache|\.npm|site-packages|\.cache|vendor)([\\/]|$)/i;

// System / scratch directories never make a useful project label.
const NOISE_RE = /(^|[\\/])(windows|system32|temp|tmp|node_modules|_npx|npm-cache|\.npm|site-packages|\.cache|vendor|appdata|\.venv|venv|envs|scripts)([\\/]|$)/i;

const PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'<>|]+|\/(?:[\w.@-]+\/)*[\w.@-]+)/g;

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch (_) {
    return false;
  }
}

function hasMarker(dir) {
  for (const marker of MARKERS) {
    try {
      fs.statSync(path.join(dir, marker));
      return true;
    } catch (_) {
      /* keep probing */
    }
  }
  return false;
}

function ascendRoot(startDir) {
  if (!startDir || !isDir(startDir)) return '';
  const key = startDir.toLowerCase();
  const hit = dirCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.root;

  let dir = startDir;
  let root = '';
  for (let i = 0; i < MAX_ASCEND; i += 1) {
    if (hasMarker(dir)) {
      root = DEPENDENCY_RE.test(dir) ? '' : dir;
      break;
    }
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  dirCache.set(key, { root, at: Date.now() });
  return root;
}

function extractPaths(command) {
  const text = String(command || '');
  const matches = text.match(PATH_RE);
  if (!matches) return [];
  const out = [];
  for (const raw of matches.slice(0, 8)) {
    const cleaned = raw.replace(/[),;:'"]+$/, '');
    if (cleaned.length < 4) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/**
 * @returns {{name:string,path:string}}
 *   name is '' when the process does not live inside a detectable project.
 */
/**
 * When no project manifest exists, attribute the script to its own folder so the
 * label is still useful - flagged as `folder` so the UI can render it softly.
 */
function looseFolder(candidate) {
  let dir = candidate;
  if (!isDir(dir)) dir = path.dirname(dir);
  if (!isDir(dir)) return null;
  if (NOISE_RE.test(dir)) return null;
  const name = path.basename(dir);
  if (!name || name.length < 2 || /^[A-Za-z]:$/.test(name)) return null;
  return { name, path: dir, kind: 'folder' };
}

function resolveProject(command, fallbackCwd) {
  const candidates = extractPaths(command);
  let best = '';
  for (const candidate of candidates) {
    let dir = candidate;
    if (!isDir(dir)) dir = path.dirname(dir);
    if (!isDir(dir)) continue;
    const root = ascendRoot(dir);
    if (root && root.length > best.length) best = root;
  }
  if (best) return { name: path.basename(best), path: best, kind: 'project' };

  for (const candidate of candidates) {
    const loose = looseFolder(candidate);
    if (loose) return loose;
  }
  if (fallbackCwd) {
    const root = ascendRoot(fallbackCwd);
    if (root) return { name: path.basename(root), path: root, kind: 'project' };
  }
  return { name: '', path: '', kind: '' };
}

/** Marketplace / scope attribution for an installed plugin. */
function pluginScope(root, cwd, marketplace) {
  const lower = String(root || '').toLowerCase();
  const cwdLower = String(cwd || '').toLowerCase();
  if (cwdLower && lower.indexOf(cwdLower) === 0) {
    return { scope: 'project', project: path.basename(cwd), marketplace: '' };
  }
  if (marketplace) return { scope: 'marketplace', project: marketplace, marketplace };
  if (lower.indexOf('.codebuddy') >= 0) return { scope: 'user', project: '用户级', marketplace: '' };
  return { scope: 'local', project: '', marketplace: '' };
}

module.exports = { resolveProject, pluginScope, extractPaths, ascendRoot };
