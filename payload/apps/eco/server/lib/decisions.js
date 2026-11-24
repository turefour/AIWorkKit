'use strict';

/**
 * AIWorkKit Eco - manual intervention log.
 *
 * The dashboard lets a human flag a flow as stuck, or skip it in favour of a
 * different execution mode. Those decisions must survive a daemon restart, so
 * they are persisted to .eco/decisions.json:
 *
 *   {
 *     overrides: { process: { "1234": {...} }, plugin: { "name": {...} } },
 *     history:   [ { at, kind, key, action, mode, note, target } ]
 *   }
 *
 * A process override is keyed by pid and validated against the command line so
 * a recycled pid never inherits someone else's decision.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_LIMIT = 200;

const MODES = {
  background: '后台静默运行',
  wrapped: '改用 eco run 包装',
  retry: '限时重试',
  manual: '人工接管'
};

function now() {
  return Date.now();
}

class DecisionStore {
  constructor(file) {
    this.file = file;
    this.overrides = { process: {}, plugin: {} };
    this.history = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.overrides.process = raw.overrides && raw.overrides.process ? raw.overrides.process : {};
        this.overrides.plugin = raw.overrides && raw.overrides.plugin ? raw.overrides.plugin : {};
        this.history = Array.isArray(raw.history) ? raw.history.slice(-HISTORY_LIMIT) : [];
      }
    } catch (_) {
      /* first run */
    }
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = JSON.stringify(
        { savedAt: now(), overrides: this.overrides, history: this.history.slice(-HISTORY_LIMIT) },
        null,
        2
      );
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (_) {
      /* decisions are best effort */
    }
  }

  get(kind, key) {
    const bucket = this.overrides[kind];
    return bucket ? bucket[String(key)] : undefined;
  }

  /** Record an intervention and return the stored record. */
  set(kind, key, record) {
    const entry = {
      at: now(),
      kind,
      key: String(key),
      action: record.action,
      mode: record.mode || '',
      note: String(record.note || '').slice(0, 300),
      target: record.target || {}
    };
    if (kind === 'process' || kind === 'plugin') {
      this.overrides[kind][String(key)] = entry;
    }
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.persist();
    return entry;
  }

  clear(kind, key) {
    if (!this.overrides[kind]) return false;
    const existed = !!this.overrides[kind][String(key)];
    delete this.overrides[kind][String(key)];
    if (existed) {
      this.history.push({ at: now(), kind: kind + ':clear', key: String(key), action: 'clear' });
      this.persist();
    }
    return existed;
  }

  /** Process override, ignored when the pid now belongs to another command. */
  processOverride(pid, command) {
    const hit = this.get('process', pid);
    if (!hit) return null;
    const expected = hit.target && hit.target.command ? String(hit.target.command).slice(0, 120) : '';
    const actual = String(command || '').slice(0, 120);
    if (expected && actual && expected !== actual) return null;
    return hit;
  }

  list(limit) {
    const n = limit || 20;
    return this.history.slice(-n).reverse();
  }

  counts() {
    const values = Object.values(this.overrides.process).concat(Object.values(this.overrides.plugin));
    return {
      flaggedStalled: values.filter((v) => v.action === 'stall').length,
      flaggedSkipped: values.filter((v) => v.action === 'skip').length,
      flaggedKilled: values.filter((v) => v.action === 'kill').length
    };
  }
}

module.exports = { DecisionStore, MODES };
