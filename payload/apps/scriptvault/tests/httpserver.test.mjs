/**
 * @name httpserver.test
 * @category test
 * @purpose End-to-end tests for the shared HTTP layer: routing, params, static, CSRF guard, token, 405.
 * @input  none
 * @usage  node --test
 * @reuse  yes
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, guardWrite } from '../lib/httpserver.mjs';

function withServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1');
    server.on('listening', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'httpd-test-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>', 'utf8');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)', 'utf8');
  return dir;
}

test('GET routes and :params resolve', async () => {
  const app = createApp({ root: tempRoot() });
  app.get('/api/health', (ctx) => ctx.json(200, { ok: true }));
  app.get('/api/jobs/:id/logs', (ctx) => ctx.json(200, { id: ctx.params.id }));

  const { server, base } = await withServer(app);
  try {
    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const job = await fetch(base + '/api/jobs/abc-123/logs');
    assert.deepEqual(await job.json(), { id: 'abc-123' });
  } finally {
    server.close();
  }
});

test('static files are served and traversal is blocked', async () => {
  const root = tempRoot();
  const app = createApp({ root });
  const { server, base } = await withServer(app);
  try {
    const index = await fetch(base + '/');
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<title>t<\/title>/);

    const asset = await fetch(base + '/assets/app.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);

    // "../" must not escape the root
    const escape = await fetch(base + '/..%2F..%2FWindows%2Fwin.ini');
    assert.ok([403, 404].includes(escape.status), 'traversal returned ' + escape.status);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('write routes reject text/plain and cross-site origins', async () => {
  const app = createApp({ root: tempRoot() });
  app.post('/api/punch', (ctx) => ctx.json(200, { ok: true }));

  const { server, base } = await withServer(app);
  try {
    const plain = await fetch(base + '/api/punch', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"user":"x"}'
    });
    assert.equal(plain.status, 403);

    const cross = await fetch(base + '/api/punch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: '{"user":"x"}'
    });
    assert.equal(cross.status, 403);

    const ok = await fetch(base + '/api/punch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"user":"x"}'
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
  } finally {
    server.close();
  }
});

test('a configured token protects everything except GET /api/health', async () => {
  const app = createApp({ root: tempRoot(), token: 'secret-token' });
  app.get('/api/health', (ctx) => ctx.json(200, { ok: true }));
  app.post('/api/action', (ctx) => ctx.json(200, { ok: true }));
  app.get('/api/state', (ctx) => ctx.json(200, { ok: true }));

  const { server, base } = await withServer(app);
  try {
    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200, 'health stays public');

    const noToken = await fetch(base + '/api/state');
    assert.equal(noToken.status, 401);

    const withToken = await fetch(base + '/api/state', { headers: { 'x-app-token': 'secret-token' } });
    assert.equal(withToken.status, 200);

    const wrongToken = await fetch(base + '/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-token': 'nope' },
      body: '{}'
    });
    assert.equal(wrongToken.status, 401);
  } finally {
    server.close();
  }
});

test('a known path with the wrong method returns 405, unknown paths 404', async () => {
  const app = createApp({ root: tempRoot() });
  app.get('/api/only-get', (ctx) => ctx.json(200, { ok: true }));

  const { server, base } = await withServer(app);
  try {
    const wrong = await fetch(base + '/api/only-get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(wrong.status, 405);

    const missing = await fetch(base + '/api/nothing-here');
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('guardWrite accepts a matching host origin and rejects a sibling port', () => {
  const json = 'application/json';
  assert.equal(guardWrite({ method: 'POST', headers: { 'content-type': json } }, { allowHost: '127.0.0.1:47900' }), '');
  assert.equal(
    guardWrite(
      { method: 'POST', headers: { 'content-type': json, origin: 'http://127.0.0.1:47900' } },
      { allowHost: '127.0.0.1:47900' }
    ),
    ''
  );
  assert.match(
    guardWrite(
      { method: 'POST', headers: { 'content-type': json, origin: 'http://127.0.0.1:5000' } },
      { allowHost: '127.0.0.1:47900' }
    ),
    /cross-origin/
  );
});
