'use strict';

/**
 * AIWorkKit Eco - self contained smoke test.
 *
 * Requires a running daemon (`node cli/eco.js server --daemon`).
 * Verifies: health, static assets, progress math, hook pairing, wrapper
 * parsing, incremental logs and the clear endpoint.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:' + (process.env.AIWORKKIT_ECO_PORT || 47821);
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -> ' + detail : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init) {
  const res = await fetch(BASE + pathname, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: res.status, json, text };
}

function postProgress(body) {
  return api('/api/progress', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function buildDemoWorkload() {
  const file = path.join(ROOT, '.eco', 'smoke-workload.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      'const steps = Number(process.argv[2] || 5);',
      'let i = 0;',
      'const t = setInterval(() => {',
      '  i += 1;',
      "  console.log('@eco ' + i + '/' + steps + ' smoke step');",
      '  if (i >= steps) { clearInterval(t); }',
      '}, 200);'
    ].join('\n'),
    'utf8'
  );
  return file;
}

async function main() {
  const health = await api('/api/health');
  check('health endpoint', health.status === 200 && !!health.json && health.json.ok === true, 'v' + (health.json && health.json.version));

  const page = await api('/');
  check('dashboard html', page.status === 200 && page.text.indexOf('AIWorkKit') >= 0, page.text.length + 'B');

  const assets = await Promise.all([api('/styles.css'), api('/app.js'), api('/favicon.svg')]);
  check('static assets', assets.every((a) => a.status === 200), assets.map((a) => a.text.length + 'B').join(' / '));

  await postProgress({ id: 'smoke-build', label: 'smoke build', kind: 'manual', total: 10, current: 1, unit: 'file' });
  await sleep(600);
  await postProgress({ id: 'smoke-build', current: 5, note: 'halfway' });
  await sleep(600);
  const last = await postProgress({ id: 'smoke-build', current: 9 });
  check('progress accepted', last.status === 200 && last.json.ok === true, 'percent ' + (last.json && last.json.job.percent));

  const snap1 = (await api('/api/state')).json;
  const job = (snap1.jobs || []).filter((j) => j.id === 'smoke-build')[0];
  check('percent derived', !!job && Math.abs(job.percent - 90) < 0.001, job ? job.percent + '%' : 'missing');
  check('rate/eta derived', !!job && job.rate > 0 && job.etaMs > 0, job ? job.rate + '/s eta ' + job.etaMs : 'missing');

  const hookPayload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'npm run build' },
    session_id: 'smoke-session',
    cwd: ROOT
  });
  const hook = path.join(ROOT, 'hooks', 'eco-hook.js');
  execFileSync(process.execPath, [hook, 'PreToolUse'], { input: hookPayload });
  await sleep(400);
  let snap = (await api('/api/state')).json;
  const running = (snap.jobs || []).filter((j) => j.sessionId === 'smoke-session')[0];
  check('hook PreToolUse', !!running && running.status === 'running', running ? running.command : 'missing');

  execFileSync(process.execPath, [hook, 'PostToolUse'], { input: hookPayload });
  await sleep(400);
  snap = (await api('/api/state')).json;
  const closed = (snap.jobs || []).filter((j) => j.sessionId === 'smoke-session')[0];
  check('hook PostToolUse closes job', !!closed && closed.status === 'done', closed ? closed.status : 'missing');

  const workload = buildDemoWorkload();
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'cli', 'eco.js'), 'run', '--id', 'smoke-wrapper', '--label', 'smoke wrapper', '--', process.execPath, workload, '5'],
    { stdio: 'pipe' }
  );
  await sleep(300);
  const after = (await api('/api/state')).json;
  const wrapped = (after.jobs || []).filter((j) => j.id === 'smoke-wrapper')[0];
  check('wrapper finished', !!wrapped && wrapped.status === 'done', wrapped ? wrapped.status + ' ' + wrapped.percent + '%' : 'missing');
  check('wrapper quantified', !!wrapped && wrapped.current === 5 && wrapped.total === 5, wrapped ? wrapped.current + '/' + wrapped.total : 'missing');

  // --- automatic task progress from the agent checklist ---------------------
  const todoPayload = JSON.stringify({
    session_id: 'smoke-todos',
    tool_name: 'TodoWrite',
    tool_input: {
      todos: [
        { content: 'step one', status: 'completed' },
        { content: 'step two', status: 'in_progress' },
        { content: 'step three', status: 'pending' }
      ]
    }
  });
  execFileSync(process.execPath, [hook, 'PreToolUse'], { input: todoPayload });
  await sleep(500);
  let snapTodos = (await api('/api/state')).json;
  const task = (snapTodos.jobs || []).filter((j) => j.kind === 'task' && j.sessionId === 'smoke-todos')[0];
  check('auto task progress', !!task && task.current === 1 && task.total === 3, task ? task.current + '/' + task.total + ' · ' + task.label : 'missing');
  check('auto task steps', !!task && (task.steps || []).length === 3, task ? (task.steps || []).length + ' steps' : 'missing');

  // --- per flow logs --------------------------------------------------------
  const bashPre = JSON.stringify({ session_id: 'smoke-logs', tool_name: 'Bash', tool_input: { command: 'echo hi' } });
  execFileSync(process.execPath, [hook, 'PreToolUse'], { input: bashPre });
  execFileSync(process.execPath, [hook, 'PostToolUse'], {
    input: JSON.stringify({
      session_id: 'smoke-logs',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: { stdout: 'hello from tool' }
    })
  });
  await sleep(500);
  const snapLogs = (await api('/api/state')).json;
  const flow = (snapLogs.jobs || []).filter((j) => j.sessionId === 'smoke-logs')[0];
  let flowLog = { status: 0, json: null };
  if (flow) flowLog = await api('/api/jobs/' + encodeURIComponent(flow.id) + '/logs?tail=20');
  check(
    'per flow log endpoint',
    flowLog.status === 200 && (flowLog.json.lines || []).some((l) => l.indexOf('hello from tool') >= 0),
    flowLog.json ? (flowLog.json.lines || []).length + ' lines' : 'missing'
  );

  // cleanup the flows created above
  for (const job of [task, flow]) {
    if (job) await fetch(BASE + '/api/jobs/' + encodeURIComponent(job.id), { method: 'DELETE' });
  }

  const logs = (await api('/api/logs/live?since=0')).json;
  check('log ring buffer', !!logs && logs.seq > 0, 'seq ' + (logs && logs.seq));
  const tail = (await api('/api/logs/live?since=' + logs.seq)).json;
  check('incremental cursor', !!tail && tail.entries.length === 0, 'entries ' + (tail && tail.entries.length));

  const cleared = await api('/api/clear', { method: 'POST' });
  check('clear finished', cleared.status === 200, 'removed ' + (cleared.json && cleared.json.removed));

  try {
    fs.unlinkSync(workload);
  } catch (_) {
    /* temp file already gone */
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('SMOKE ERROR: ' + err.stack);
  process.exit(1);
});
