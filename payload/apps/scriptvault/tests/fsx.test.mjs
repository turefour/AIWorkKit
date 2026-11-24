/**
 * @name fsx.test
 * @category test
 * @purpose Regression tests for atomic JSON writes, safe walk and path guards.
 * @input  none
 * @usage  node --test tests/
 * @reuse  yes
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  writeJson,
  readJson,
  writeText,
  walk,
  insideRoot,
  fmtBytes
} from '../lib/fsx.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
}

test('writeJson then readJson round-trips and leaves no temp file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'data.json');
  writeJson(file, { a: 1, z: [1, 2] });

  assert.deepEqual(readJson(file), { a: 1, z: [1, 2] });
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJson overwrites previous content completely', () => {
  const dir = tempDir();
  const file = path.join(dir, 'data.json');
  writeJson(file, { long: 'x'.repeat(500) });
  writeJson(file, { short: 1 });
  assert.deepEqual(readJson(file), { short: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJson returns the fallback for missing or corrupt files', () => {
  const dir = tempDir();
  assert.equal(readJson(path.join(dir, 'nope.json'), 'fallback'), 'fallback');
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ not json', 'utf8');
  assert.deepEqual(readJson(broken, { ok: false }), { ok: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('walk skips node_modules and respects the filter', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), '', 'utf8');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'b.txt'), '', 'utf8');

  const all = walk(dir);
  assert.equal(all.length, 2, 'node_modules must be skipped');

  const onlyMjs = walk(dir, { filter: (file) => file.endsWith('.mjs') });
  assert.equal(onlyMjs.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('insideRoot rejects sibling directories sharing a prefix', () => {
  const root = 'C:\\Users\\GH\\Desktop\\CodeVault';
  assert.equal(insideRoot(root, path.join(root, 'assets', 'app.js')), true);
  assert.equal(insideRoot(root, 'C:\\Users\\GH\\Desktop\\CodeVault-evil\\x.js'), false);
  assert.equal(insideRoot(root, 'C:\\Windows\\win.ini'), false);
  assert.equal(insideRoot(root, root), false, 'the root itself is not a file');
});

test('fmtBytes formats the three size ranges', () => {
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2048), '2 KB');
  assert.match(fmtBytes(3 * 1024 * 1024), /3\.0 MB/);
  assert.equal(fmtBytes(null), '—');
});

test('writeText creates parent directories', () => {
  const dir = tempDir();
  const file = path.join(dir, 'deep', 'nested', 'note.md');
  writeText(file, '# hi');
  assert.equal(fs.readFileSync(file, 'utf8'), '# hi');
  fs.rmSync(dir, { recursive: true, force: true });
});
