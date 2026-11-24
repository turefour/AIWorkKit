'use strict';

/**
 * AIWorkKit Eco - in-memory job/progress store.
 *
 * A "job" is any observable unit of work: an agent turn, a tool call, a wrapped
 * script, or a manually reported pipeline. Jobs carry optional quantifiable
 * progress (current/total/unit) plus a sample window used to derive throughput
 * and ETA.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_STALL_MS = 90 * 1000;
const MAX_SAMPLES = 80;
const MAX_JOB_LOGS = 80;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

class Store {
  constructor(options) {
    const opts = options || {};
    // Finished flows clear themselves quickly so the board only shows live work.
    this.doneTtlMs = opts.doneTtlMs != null ? opts.doneTtlMs : 30 * 1000;
    this.failedTtlMs = opts.failedTtlMs != null ? opts.failedTtlMs : 90 * 1000;
    this.ttlDoneMs = opts.ttlDoneMs != null ? opts.ttlDoneMs : 15 * 60 * 1000;
    this.maxJobs = opts.maxJobs || 300;
    this.stallMs = opts.stallMs || DEFAULT_STALL_MS;
    this.stateFile = opts.stateFile || null;
    this.jobs = new Map();
    this.listeners = new Set();
    this.startedAt = Date.now();
    this.saveTimer = null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, job) {
    for (const fn of this.listeners) {
      try {
        fn(type, job);
      } catch (_) {
        /* listeners must never break the store */
      }
    }
    this.scheduleSave();
  }

  scheduleSave() {
    if (!this.stateFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, 2000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  persist() {
    if (!this.stateFile) return;
    try {
      const jobs = Array.from(this.jobs.values()).map((job) => ({
        ...job,
        logs: job.logs.slice(-20),
        samples: job.samples.slice(-20)
      }));
      const payload = JSON.stringify({ savedAt: Date.now(), jobs });
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (_) {
      /* persistence is best effort */
    }
  }

  restore() {
    if (!this.stateFile) return 0;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const list = Array.isArray(raw.jobs) ? raw.jobs : [];
      for (const job of list) {
        if (!job || !job.id) continue;
        if (job.status === 'running') {
          job.status = 'stalled';
          job.note = 'daemon restarted';
        }
        // Samples across a restart would produce a bogus throughput/ETA, so the
        // rate window always starts empty.
        this.jobs.set(job.id, { logs: [], ...job, samples: [] });
      }
      return list.length;
    } catch (_) {
      return 0;
    }
  }

  /** Create or patch a job. */
  upsert(patch) {
    if (!patch || !patch.id) return null;
    const now = Date.now();
    const existing = this.jobs.get(patch.id);
    let job;
    if (existing) {
      job = existing;
      Object.assign(job, patch, { id: existing.id });
      job.updatedAt = now;
    } else {
      job = {
        id: patch.id,
        kind: 'manual',
        label: patch.id,
        detail: '',
        status: 'running',
        current: null,
        total: null,
        unit: '',
        percent: null,
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        pid: null,
        command: '',
        cwd: '',
        sessionId: '',
        source: '',
        note: '',
        logs: [],
        samples: [],
        ...patch
      };
      this.jobs.set(job.id, job);
    }

    if (job.current != null) {
      const last = job.samples[job.samples.length - 1];
      if (!last || last.c !== job.current || now - last.t > 1000) {
        job.samples.push({ t: now, c: job.current });
        if (job.samples.length > MAX_SAMPLES) job.samples.splice(0, job.samples.length - MAX_SAMPLES);
      }
    }
    if (job.status !== 'running' && !job.endedAt) job.endedAt = now;
    if (job.status === 'running') job.endedAt = null;

    this.enforceLimits();
    this.emit(existing ? 'update' : 'create', job);
    return job;
  }

  /** High-frequency numeric update path used by wrapped scripts. */
  progress(input) {
    if (!input || !input.id) return null;
    const patch = { id: input.id };
    if (input.label) patch.label = input.label;
    if (input.detail != null) patch.detail = String(input.detail).slice(0, 400);
    if (input.unit) patch.unit = input.unit;
    if (input.kind) patch.kind = input.kind;
    if (input.current != null) patch.current = num(input.current);
    if (input.total != null) patch.total = num(input.total);
    if (input.percent != null && input.current == null && input.total == null) {
      patch.percent = clamp(Number(input.percent) || 0, 0, 100);
    }
    if (input.status) patch.status = input.status;
    if (input.note != null) patch.note = String(input.note).slice(0, 400);
    if (input.sessionId) patch.sessionId = input.sessionId;
    if (input.command) patch.command = String(input.command).slice(0, 400);
    if (input.source) patch.source = input.source;
    if (input.pid != null) patch.pid = num(input.pid);
    // A fresh report is proof of life: revive a stalled job automatically.
    const known = this.jobs.get(input.id);
    if (known && known.status === 'stalled' && !patch.status) patch.status = 'running';
    const job = this.upsert(patch);
    if (job && input.log) this.appendLog(job.id, input.logLevel || 'info', input.log);
    return job;
  }

  appendLog(id, level, message) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const text = String(message == null ? '' : message).slice(0, 500);
    if (!text) return job;
    job.logs.push({ ts: Date.now(), level: level || 'info', message: text });
    if (job.logs.length > MAX_JOB_LOGS) job.logs.splice(0, job.logs.length - MAX_JOB_LOGS);
    job.updatedAt = Date.now();
    this.emit('log', job);
    return job;
  }

  finish(id, status, note) {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.status = status || 'done';
    job.endedAt = Date.now();
    job.updatedAt = job.endedAt;
    if (note != null) job.note = String(note).slice(0, 400);
    // A job that ends successfully is complete: fill the counter and close any
    // step that was still open, so the card never shows "完成 3/5".
    if (job.status === 'done' && job.total != null) {
      job.current = job.total;
      if (Array.isArray(job.steps)) {
        job.steps = job.steps.map((step) =>
          step.status === 'pending' || step.status === 'in_progress' ? { ...step, status: 'completed' } : step
        );
      }
    }
    this.emit('finish', job);
    return job;
  }

  remove(id) {
    const ok = this.jobs.delete(id);
    if (ok) this.emit('remove', { id });
    return ok;
  }

  clearFinished() {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' && job.status !== 'stalled') {
        this.jobs.delete(id);
        removed += 1;
      }
    }
    if (removed) this.emit('clear', null);
    return removed;
  }

  enforceLimits() {
    if (this.jobs.size <= this.maxJobs) return;
    const removable = Array.from(this.jobs.values())
      .filter((j) => j.status !== 'running' && j.status !== 'stalled')
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    while (this.jobs.size > this.maxJobs && removable.length) {
      this.jobs.delete(removable.shift().id);
    }
  }

  prune(now) {
    const t = now || Date.now();
    let removed = 0;
    for (const [id, job] of this.jobs) {
      const updated = job.updatedAt || 0;
      let ttl = null;
      if (job.status === 'failed') {
        ttl = this.failedTtlMs;
      } else if (job.status !== 'running' && job.status !== 'stalled') {
        ttl = this.doneTtlMs;
      } else if (job.status === 'stalled' && t - updated > this.stallMs * 10) {
        ttl = 0; // a stalled flow whose reporter never came back is abandoned
      }
      if (ttl == null) continue;
      if (t - updated >= ttl) {
        this.jobs.delete(id);
        removed += 1;
      }
    }
    if (removed) this.emit('prune', null);
    return removed;
  }

  /** Derive display fields: percent, throughput, ETA, stall flag. */
  decorate(job, now) {
    const t = now || Date.now();
    const out = { ...job, logs: job.logs.slice(-40), samples: job.samples.slice(-40) };
    out.elapsedMs = (job.endedAt || t) - (job.startedAt || t);

    let percent = null;
    if (job.total != null && job.total > 0 && job.current != null) {
      percent = clamp((job.current / job.total) * 100, 0, 100);
    } else if (job.percent != null) {
      percent = clamp(Number(job.percent) || 0, 0, 100);
    }
    if (percent != null && job.status === 'done') percent = Math.max(percent, 100);
    out.percent = percent == null ? null : Math.round(percent * 10) / 10;

    let rate = null;
    const s = job.samples;
    if (s.length >= 2 && job.current != null) {
      const first = s[0];
      const last = s[s.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt >= 1) rate = (last.c - first.c) / dt;
    }
    out.rate = rate != null && Number.isFinite(rate) ? Math.round(rate * 100) / 100 : null;
    out.etaMs =
      out.rate && out.rate > 0 && job.total != null && job.current != null && job.total > job.current
        ? Math.round(((job.total - job.current) / out.rate) * 1000)
        : job.status === 'done'
        ? 0
        : null;

    out.stalled =
      job.status === 'running' && t - (job.updatedAt || t) > this.stallMs && job.total == null;
    out.staleRunning = job.status === 'running' && t - (job.updatedAt || t) > this.stallMs * 4;
    return out;
  }

  list() {
    const now = Date.now();
    const order = { running: 0, stalled: 1, failed: 2, done: 3, cancelled: 4 };
    return Array.from(this.jobs.values())
      .map((job) => this.decorate(job, now))
      .sort((a, b) => {
        const oa = order[a.status] == null ? 5 : order[a.status];
        const ob = order[b.status] == null ? 5 : order[b.status];
        if (oa !== ob) return oa - ob;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
  }

  summary() {
    const jobs = Array.from(this.jobs.values());
    const count = (status) => jobs.filter((j) => j.status === status).length;
    const weighted = jobs.filter((j) => j.status === 'running' && j.total != null && j.current != null);
    let overall = null;
    if (weighted.length) {
      overall =
        weighted.reduce((acc, j) => acc + clamp(j.current / j.total, 0, 1), 0) / weighted.length;
      overall = Math.round(overall * 1000) / 10;
    }
    return {
      total: jobs.length,
      running: count('running'),
      stalled: count('stalled'),
      done: count('done'),
      failed: count('failed'),
      quantified: jobs.filter((j) => j.total != null).length,
      overallPercent: overall,
      uptimeMs: Date.now() - this.startedAt
    };
  }
}

module.exports = { Store };
