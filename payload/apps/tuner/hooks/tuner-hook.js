#!/usr/bin/env node
'use strict';

/**
 * AIWorkKit Idle Tuner - lifecycle hook.
 *
 * Tracks whether the agent is busy (prompt submitted) or idle (turn stopped) and
 * drives the optional auto mode. Rules that matter:
 *
 *   1. Never block: no stdout, always exit 0, stdin is drained synchronously.
 *   2. Auto mode may only trim + lower priority. It never suspends, because the
 *      hook itself runs inside a node service; suspending it would make the next
 *      UserPromptSubmit hook impossible to run (deadlock until the tray wakes it).
 *   3. If processes are still suspended when a new prompt arrives, restore them
 *      first so the IDE cannot look frozen to the user.
 *
 * Usage: node tuner-hook.js <SessionStart|UserPromptSubmit|Stop>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'tuner.js');
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AIWorkKitIdleTuner');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_FILE = path.join(DATA_DIR, 'hook.log');

const DEFAULT_CONFIG = {
  autoMode: false,
  autoLevel: 'lite',
  processNames: ['AIWorkKit CN', 'AIWorkKit', 'Code'],
  minIdleSeconds: 120,
  suspendLevel: 'background',
  autoResumeMinutes: 0,
};

function log(message) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\r\n`, 'utf8');
  } catch {
    /* logging must never break the hook */
  }
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  } catch (err) {
    log(`write ${path.basename(file)} failed: ${err.message}`);
  }
}

function runDetached(args) {
  try {
    const child = spawn(process.execPath, [CLI, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    log(`spawned: ${args.join(' ')}`);
  } catch (err) {
    log(`spawn failed: ${err.message}`);
  }
}

function main() {
  // Drain stdin so the hook runner never gets EPIPE when it writes its payload.
  try {
    fs.readFileSync(0, 'utf8');
  } catch {
    /* no stdin payload */
  }

  const event = (process.argv[2] || '').trim();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const config = Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_FILE, {}));
  if (!fs.existsSync(CONFIG_FILE)) writeJson(CONFIG_FILE, DEFAULT_CONFIG);

  const state = readJson(STATE_FILE, {});
  const now = new Date().toISOString();

  if (event === 'UserPromptSubmit') {
    state.busy = true;
    state.lastPromptAt = now;
    writeJson(STATE_FILE, state);

    const suspended = Array.isArray(state.suspended) ? state.suspended.filter(Boolean) : [];
    // Auto-apply lowers the whole process tree to BelowNormal + EcoQoS but keeps
    // no "suspended" record, so the suspended list alone cannot tell whether a
    // restore is needed. Restore on every prompt instead: restore is idempotent
    // and guarantees the IDE never stays throttled while the user is typing.
    const throttled = Boolean(state.lastApplyAt) || suspended.length > 0;
    if (throttled) {
      log(`prompt detected, restoring (suspended=${suspended.length}, lastApplyAt=${state.lastApplyAt || '-'})`);
      runDetached(['restore']);
    }
    return;
  }

  if (event === 'Stop') {
    state.busy = false;
    state.lastIdleAt = now;
    writeJson(STATE_FILE, state);

    if (!config.autoMode) return;

    // Delayed apply: a new prompt within minIdleSeconds cancels it, so short
    // back-and-forth conversations do not pay the page-fault cost repeatedly.
    const delay = Number(config.minIdleSeconds) > 0 ? Number(config.minIdleSeconds) : 120;
    runDetached(['idle-watch', '--seconds', String(delay), '--mode', config.autoLevel === 'deep' ? 'deep' : 'lite']);
    return;
  }

  if (event === 'SessionStart') {
    state.busy = false;
    state.lastSessionAt = now;
    writeJson(STATE_FILE, state);
    log('session start');

    // Bind to AIWorkKit startup: the tray (and optionally the standalone
    // window) come up together with the IDE. Both are detached so they keep
    // running when this session ends, which is what makes suspend recoverable.
    runDetached(['autostart']);
    return;
  }

  log(`ignored event: ${event || '(none)'}`);
}

try {
  main();
} catch (err) {
  log(`hook error: ${err && err.message}`);
}

process.exit(0);
