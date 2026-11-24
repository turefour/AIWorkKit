#!/usr/bin/env node
/**
 * CodeVault index refresher.
 *
 * Purpose : re-measure every project listed in data/projects.json and write the
 *           fresh numbers back, so the site always reflects the real disk state.
 * Input   : data/projects.json (hand-maintained narrative fields are preserved)
 * Output  : data/projects.json (scale.files / scale.bytes / scannedAt updated)
 * Usage   : node tools/scan.mjs           measure and write
 *           node tools/scan.mjs --dry     measure only, print a table
 *
 * Rules   : never invents content; missing paths are marked instead of removed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const DATA_FILE = path.join(APP_ROOT, 'data', 'projects.json');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.eco', 'dist', 'dist-installer', 'logs',
  '__pycache__', '.playwright-cli', 'window-profile', '.tools'
]);

const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.ps1', '.psm1', '.py',
  '.html', '.css', '.json', '.md', '.cmd', '.bat'
]);

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      const full = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      acc.files += 1;
      acc.bytes += stat.size;
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXT.has(ext)) {
        acc.code += 1;
        acc.byExt[ext] = (acc.byExt[ext] || 0) + 1;
      }
      if (!acc.latest || stat.mtimeMs > acc.latest) acc.latest = stat.mtimeMs;
    }
  }
  return acc;
}

function measure(target) {
  const acc = { files: 0, code: 0, bytes: 0, byExt: {}, latest: 0 };
  if (!target || !fs.existsSync(target)) return null;
  return walk(target, acc);
}

function fmtMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function main() {
  const dry = process.argv.includes('--dry');
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const rows = [];

  for (const project of data.projects) {
    const result = measure(project.path);
    if (!result) {
      project.scale = { ...(project.scale || {}), missing: true };
      rows.push([project.id, 'MISSING', '-', '-']);
      continue;
    }
    project.scale = {
      ...(project.scale || {}),
      files: result.code || result.files,
      bytes: result.bytes,
      scannedAt: new Date().toISOString().slice(0, 10),
      missing: false
    };
    if (result.latest > 0) {
      project.lastModified = new Date(result.latest).toISOString().slice(0, 10);
    } else {
      delete project.lastModified;
    }
    rows.push([project.id, result.files, fmtMb(result.bytes), project.lastModified || '—']);
  }

  data.generatedAt = new Date().toISOString().slice(0, 10);

  if (dry) {
    console.log('project'.padEnd(24) + 'files'.padStart(8) + 'size'.padStart(12) + 'modified'.padStart(14));
    for (const [id, files, size, modified] of rows) {
      console.log(String(id).padEnd(24) + String(files).padStart(8) + String(size).padStart(12) + String(modified).padStart(14));
    }
    return;
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('[codevault] refreshed ' + rows.length + ' projects -> data/projects.json');
  for (const [id, files, size, modified] of rows) {
    console.log('  ' + String(id).padEnd(24) + String(files).padStart(7) + '  ' + String(size).padStart(9) + '  ' + modified);
  }
}

main();
