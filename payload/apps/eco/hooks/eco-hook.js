#!/usr/bin/env node
'use strict';

/**
 * AIWorkKit Eco - hook dispatcher.
 *
 * Usage:  node eco-hook.js <EventName>
 *
 * Reads the hook payload JSON from stdin, normalizes it, then forwards it to the
 * local eco daemon over HTTP. The call is fire-and-forget with a hard timeout,
 * so a slow or missing daemon can never block tool execution. When the daemon is
 * unreachable the event is queued on disk and replayed on next daemon start.
 *
 * Exit code is always 0 and stdout stays empty (no decision is ever returned).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PLUGIN_ROOT, '.eco');
const QUEUE_FILE = path.join(STATE_DIR, 'hook-queue.jsonl');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

const EVENT = process.argv[2] || 'Unknown';
const HOST = '127.0.0.1';
const POST_TIMEOUT_MS = 800;
const STDIN_TIMEOUT_MS = 1200;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;

function resolvePort() {
  if (process.env.AIWORKKIT_ECO_PORT) {
    return Number(process.env.AIWORKKIT_ECO_PORT);
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg && Number(cfg.port)) return Number(cfg.port);
  } catch (_) {
    /* config is optional */
  }
  return 47821;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(buf);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        if (buf.length < 512 * 1024) buf += chunk;
      });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch (_) {
      finish();
    }
    setTimeout(finish, STDIN_TIMEOUT_MS).unref();
  });
}

function clip(value, max) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Reduce a tool response of unknown shape to plain text. */
function responseText(res) {
  if (res === undefined || res === null) return '';
  if (typeof res === 'string') return clip(res, 12000);
  const parts = [];
  const content = res.content !== undefined ? res.content : res.output;
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block.text === 'string') parts.push(block.text);
    }
  }
  for (const key of ['stdout', 'stderr', 'output', 'text', 'result']) {
    if (typeof res[key] === 'string' && res[key]) parts.push(res[key]);
  }
  if (!parts.length) parts.push(JSON.stringify(res));
  return clip(parts.join('\n'), 12000);
}

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const toolInput = data.tool_input || data.toolInput || {};
  const response =
    data.tool_response !== undefined
      ? data.tool_response
      : data.toolResponse !== undefined
      ? data.toolResponse
      : data.tool_result;
  return {
    event: EVENT,
    ts: Date.now(),
    sessionId: data.session_id || data.sessionId || '',
    cwd: data.cwd || process.cwd(),
    client: data.client || '',
    model: data.model || '',
    tool: data.tool_name || data.toolName || '',
    toolUseId: data.tool_use_id || data.toolUseId || '',
    toolInput,
    toolResponse: responseText(response),
    toolResponseError: !!(response && (response.is_error || response.error)),
    transcript: data.transcript_path || data.transcriptPath || '',
    hookPid: process.ppid,
    pluginRoot: PLUGIN_ROOT,
    summary: clip(
      toolInput.command ||
        toolInput.file_path ||
        toolInput.path ||
        toolInput.pattern ||
        data.prompt ||
        '',
      240
    )
  };
}

/** Opt-in raw payload dump, used to verify hook schemas on a new client build. */
function dumpRaw(payload) {
  if (process.env.ECO_DEBUG_HOOK !== '1') return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'hook-last.json'), JSON.stringify(payload, null, 2), 'utf8');
    fs.appendFileSync(path.join(STATE_DIR, 'hook-raw.jsonl'), JSON.stringify(payload) + os.EOL, 'utf8');
  } catch (_) {
    /* debug dump is best effort */
  }
}

function post(payload) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        host: HOST,
        port: resolvePort(),
        path: '/api/events',
        method: 'POST',
        timeout: POST_TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'x-eco-source': 'hook'
        }
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end(body);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start the monitor daemon detached. Only SessionStart does this, so opening
 * AIWorkKit is enough to bring the dashboard up - no manual step.
 */
function ensureDaemon() {
  try {
    const cli = path.join(PLUGIN_ROOT, 'cli', 'eco.js');
    if (!fs.existsSync(cli)) return false;
    // ECO_AUTO_OPEN=1 also brings the standalone window up on session start.
    const args = process.env.ECO_AUTO_OPEN === '1' ? [cli, 'open'] : [cli, 'server', '--daemon'];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: PLUGIN_ROOT
    });
    child.unref();
    return true;
  } catch (_) {
    /* the daemon is a convenience, never a blocker */
    return false;
  }
}

function enqueue(payload) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try {
      const stat = fs.statSync(QUEUE_FILE);
      if (stat.size > MAX_QUEUE_BYTES) fs.truncateSync(QUEUE_FILE, 0);
    } catch (_) {
      /* queue does not exist yet */
    }
    fs.appendFileSync(QUEUE_FILE, JSON.stringify(payload) + os.EOL, 'utf8');
  } catch (_) {
    /* disk queue is best effort */
  }
}

async function main() {
  const text = await readStdin();
  let raw = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch (_) {
      raw = { raw: clip(text, 2000) };
    }
  }
  const payload = normalize(raw);
  dumpRaw(payload);

  let delivered = await post(payload);

  // Opening AIWorkKit fires SessionStart: bring the monitor up automatically and
  // give it a moment to listen before giving up on this first event.
  if (!delivered && EVENT === 'SessionStart') {
    ensureDaemon();
    for (let attempt = 0; attempt < 4 && !delivered; attempt += 1) {
      await sleep(300);
      delivered = await post(payload);
    }
  }

  if (!delivered) enqueue(payload);
}

// SessionStart waits for a cold daemon, other events must stay instant.
const guard = setTimeout(() => process.exit(0), EVENT === 'SessionStart' ? 6000 : 2500);
guard.unref();

main()
  .catch(() => {
    /* never propagate hook failures */
  })
  .finally(() => process.exit(0));
