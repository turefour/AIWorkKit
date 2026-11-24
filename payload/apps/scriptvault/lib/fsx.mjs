/**
 * @module fsx
 * @category core
 * @purpose File helpers repeated across scripts: atomic JSON, safe walk, path guards.
 * @usage  import { readJson, writeJson, walk, insideRoot } from '../lib/fsx.mjs';
 */

import fs from 'node:fs';
import path from 'node:path';

/** Directories that never belong to a source tree scan. */
export const DEFAULT_SKIP = new Set([
  'node_modules',
  '.git',
  '.eco',
  'dist',
  'dist-installer',
  'logs',
  '__pycache__',
  '.tools',
  '.playwright-cli',
  'window-profile'
]);

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read JSON or return the fallback; never throws on missing/corrupt files. */
export function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Write JSON atomically (tmp + rename) so a crash cannot leave half a file. */
export function writeJson(file, value, indent = 2) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, indent) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

/**
 * Depth-first file walk with a skip list.
 * @param {string} dir
 * @param {{ skip?: Set<string>, filter?: (file: string) => boolean, maxDepth?: number }} [options]
 * @returns {string[]} absolute paths
 */
export function walk(dir, options = {}) {
  const skip = options.skip || DEFAULT_SKIP;
  const maxDepth = options.maxDepth === undefined ? 12 : options.maxDepth;
  const out = [];

  const visit = (current, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        visit(full, depth + 1);
      } else if (entry.isFile()) {
        if (!options.filter || options.filter(full)) out.push(full);
      }
    }
  };

  visit(dir, 0);
  return out;
}

/** True when `file` stays inside `root` (blocks sibling-prefix tricks on Windows). */
export function insideRoot(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Human readable byte size. */
export function fmtBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
