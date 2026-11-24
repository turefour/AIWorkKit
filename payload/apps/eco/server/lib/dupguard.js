'use strict';

/**
 * AIWorkKit Eco - duplicate process guard.
 *
 * Purpose: catch the classic "test runner started in a loop" accident. A task
 * that re-spawns `node --test` (or pytest / vitest / playwright) on every failure
 * will pile up identical processes until the machine crawls.
 *
 * Escalation:
 *   count >= warnAt (4)  -> warn          (two consecutive samples, to ignore spikes)
 *   count >= lockAt (6)  -> locked        (the group is frozen; extras are killed)
 *   locked + count > 1   -> kill extras   (keep the oldest one, drop the duplicates)
 *
 * The guard is a pure state machine over a process list: no timers, no child
 * processes. The server decides what to do with `result.kill`.
 */

const WARN_AT = 4;
const LOCK_AT = 6;
const CONFIRM_SAMPLES = 2;
const ALERT_KEEP = 50;

// Commands that mean "this is a test run". Deliberately narrow: matching the
// word "test" anywhere would also catch `--test-timeout` on unrelated scripts.
const TEST_RE = new RegExp(
  [
    '\\bnode\\b[^|]*\\s--test\\b',
    '\\b(jest|vitest|mocha|ava|tap|playwright|cypress)\\b',
    '\\bpytest\\b',
    '\\bpython[\\w.]*\\s+-m\\s+(pytest|unittest)\\b',
    '\\bgo\\s+test\\b',
    '\\bcargo\\s+test\\b',
    '\\.test\\.(js|mjs|cjs|ts|tsx|jsx)\\b',
    '\\.spec\\.(js|mjs|cjs|ts|tsx|jsx)\\b',
    '(^|[\\\\/])test_[\\w-]+\\.py\\b',
    '[\\\\/][\\w-]+_test\\.py\\b',
    '\\.test\\.mjs\\b'
  ].join('|'),
  'i'
);

/** Is this row a test-run process? */
function isTestProcess(proc) {
  const command = String((proc && proc.command) || '');
  if (!command) return false;
  return TEST_RE.test(command);
}

/**
 * Group key: project + the script being run.
 * Two parallel `node --test` runs in the same project collapse into one group;
 * the same command in a different project stays separate.
 */
function groupKeyOf(proc) {
  const project = (proc.project && proc.project.name) || '-';
  return project + '|' + scriptKeyOf(String(proc.command || ''));
}

/** The script file name is the most stable identity across repeated spawns. */
function scriptKeyOf(command) {
  const file = /([\w.\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|ps1|sh|rb|jar))\b/i.exec(command);
  if (file) return file[1].toLowerCase();
  return command
    .replace(/[A-Za-z]:\\[^"\s]*\\/g, '')
    .replace(/\b\d{2,}\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .toLowerCase();
}

/** Oldest first: the survivor of a cleanup is the run that started earliest. */
function byAgeDesc(a, b) {
  return (Number(b.uptimeMs) || 0) - (Number(a.uptimeMs) || 0);
}

class DuplicateGuard {
  constructor(options) {
    const opts = options || {};
    this.warnAt = opts.warnAt != null ? opts.warnAt : WARN_AT;
    this.lockAt = opts.lockAt != null ? opts.lockAt : LOCK_AT;
    this.confirmSamples = opts.confirmSamples != null ? opts.confirmSamples : CONFIRM_SAMPLES;
    this.onAlert = opts.onAlert || function () {};
    this.onLock = opts.onLock || function () {};
    this.reset();
  }

  reset() {
    /** key -> { count, peak, hits, status, lockedAt, killed, lastSeen } */
    this.tracks = new Map();
    this.alerts = [];
  }

  pushAlert(level, payload) {
    const entry = Object.assign({ at: Date.now(), level }, payload);
    this.alerts.push(entry);
    if (this.alerts.length > ALERT_KEEP) this.alerts.splice(0, this.alerts.length - ALERT_KEEP);
    return entry;
  }

  /**
   * Feed one sampling round.
   *
   * @param {Array<{pid:number, command:string, uptimeMs?:number, project?:{name:string}}>} processes
   * @returns {{groups:Array, kill:Array, locked:Array, alerts:Array}}
   */
  inspect(processes, now) {
    const at = now || Date.now();
    const groups = new Map();

    for (const proc of processes || []) {
      if (!proc || !proc.pid) continue;
      if (!isTestProcess(proc)) continue;
      const key = groupKeyOf(proc);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(proc);
    }

    const kill = [];
    const locked = [];
    const alerts = [];
    const summary = [];

    for (const [key, list] of groups.entries()) {
      const count = list.length;
      const track = this.tracks.get(key) || {
        count: 0,
        peak: 0,
        hits: 0,
        status: 'ok',
        lockedAt: 0,
        killed: 0,
        warnCount: 0,
        lastSeen: 0
      };

      if (count > track.peak) track.peak = count;

      // Down again: forget the warning (an existing lock is only released by the
      // process finishing or by an explicit unlock).
      if (count < this.warnAt) {
        track.hits = 0;
        if (track.status === 'warn') {
          track.status = 'ok';
          track.warnCount = 0;
        }
      } else {
        track.hits += 1;
      }

      let status = track.status;
      if (status === 'ok' && track.hits >= this.confirmSamples) {
        status = 'warn';
        track.warnCount = count;
        const alert = this.pushAlert('warn', { key, count, peak: track.peak, pids: list.map((p) => p.pid) });
        alerts.push(alert);
        try {
          this.onAlert(alert);
        } catch (_) {
          /* listeners must not break sampling */
        }
      }

      // "Keeps growing" is what turns a warning into a lock: either it crosses the
      // hard ceiling, or one more instance appears after the warning was raised.
      const grewAfterWarn = track.warnCount > 0 && count > track.warnCount;
      if (status === 'warn' && (count >= this.lockAt || grewAfterWarn)) {
        status = 'locked';
        track.lockedAt = at;
        const alert = this.pushAlert('lock', { key, count, peak: track.peak, pids: list.map((p) => p.pid) });
        alerts.push(alert);
        locked.push({ key, count, pids: list.map((p) => p.pid) });
        try {
          this.onLock(alert);
        } catch (_) {
          /* ignore */
        }
      }

      // While locked the group stays clamped: keep the oldest run, drop the rest.
      if (status === 'locked' && count > 1) {
        const ordered = list.slice().sort(byAgeDesc);
        const extras = ordered.slice(1);
        for (const extra of extras) kill.push(extra);
        track.killed += extras.length;
      }

      track.count = count;
      track.status = status;
      track.lastSeen = at;
      this.tracks.set(key, track);

      summary.push({
        key,
        count,
        peak: track.peak,
        status,
        hits: track.hits,
        lockedAt: track.lockedAt,
        killed: track.killed,
        pids: list.map((p) => p.pid),
        sample: list[0] ? String(list[0].command || '').slice(0, 160) : ''
      });
    }

    // Groups that disappeared: clear their warning state.
    for (const [key, track] of Array.from(this.tracks.entries())) {
      if (groups.has(key)) continue;
      if (track.status !== 'ok') {
        const alert = this.pushAlert(track.status === 'locked' ? 'unlock' : 'clear', { key, count: 0 });
        alerts.push(alert);
      }
      this.tracks.delete(key);
    }

    return { groups: summary, kill, locked, alerts };
  }

  /** Manual unlock: one key, or everything when called without a key. */
  unlock(key) {
    if (key) {
      const track = this.tracks.get(key);
      if (!track) return false;
      track.status = 'ok';
      track.hits = 0;
      track.peak = 0;
      track.lockedAt = 0;
      this.pushAlert('unlock', { key, count: track.count });
      return true;
    }
    for (const track of this.tracks.values()) {
      track.status = 'ok';
      track.hits = 0;
      track.peak = 0;
      track.lockedAt = 0;
    }
    this.pushAlert('unlock', { key: '*', count: 0 });
    return true;
  }

  /** Snapshot for the dashboard / API. */
  state() {
    return {
      warnAt: this.warnAt,
      lockAt: this.lockAt,
      groups: Array.from(this.tracks.entries()).map(([key, t]) => ({
        key,
        count: t.count,
        peak: t.peak,
        status: t.status,
        lockedAt: t.lockedAt,
        killed: t.killed
      })),
      alerts: this.alerts.slice(-20).reverse()
    };
  }
}

module.exports = { DuplicateGuard, isTestProcess, groupKeyOf, scriptKeyOf, WARN_AT, LOCK_AT, CONFIRM_SAMPLES };
