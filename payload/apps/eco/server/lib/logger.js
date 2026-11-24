'use strict';

/**
 * AIWorkKit Eco - logger with file sink + in-memory ring buffer.
 *
 * Contract (matches the project logging baseline):
 *  - logs/server.log : append-only runtime timeline
 *  - logs/error.log  : error channel with stack traces
 *  - live(since)     : incremental read from the ring buffer, monotonic `seq`
 *  - writing never blocks or crashes the business flow (EPIPE safe)
 */

const fs = require('fs');
const path = require('path');

const RING_LIMIT = 500;
/* File rotation: the daemon may run for weeks, so logs must not grow forever. */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 3;
const CHECK_EVERY = 200;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* directory may already exist */
  }
}

function stamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    d.getFullYear() +
    '-' +
    p(d.getMonth() + 1) +
    '-' +
    p(d.getDate()) +
    ' ' +
    p(d.getHours()) +
    ':' +
    p(d.getMinutes()) +
    ':' +
    p(d.getSeconds()) +
    '.' +
    p(d.getMilliseconds(), 3)
  );
}

// Mask obvious secrets before they ever hit disk or the UI.
function redact(text) {
  return String(text)
    .replace(/(sk-[A-Za-z0-9]{6})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/((?:token|secret|password|passwd|apikey|api_key|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***');
}

class Logger {
  constructor(options) {
    const opts = options || {};
    this.dir = opts.dir || path.join(__dirname, '..', '..', 'logs');
    this.name = opts.name || 'server';
    ensureDir(this.dir);
    this.serverFile = path.join(this.dir, this.name + '.log');
    this.errorFile = path.join(this.dir, 'error.log');
    this.ring = [];
    this.seq = 0;
    this.streams = {};
    this.guardStreams();
  }

  guardStreams() {
    // A closed stdout pipe (EPIPE) must never take the daemon down.
    const swallow = (err) => {
      if (err && err.code !== 'EPIPE') return;
    };
    try {
      process.stdout.on('error', swallow);
      process.stderr.on('error', swallow);
    } catch (_) {
      /* streams may be detached */
    }
  }

  /** Shift `file` -> `.1` -> `.2` ... once it grows past MAX_BYTES. */
  rotateIfNeeded(file) {
    this.writeCount = (this.writeCount || 0) + 1;
    if (this.writeCount % CHECK_EVERY !== 0) return;
    try {
      if (fs.statSync(file).size < MAX_BYTES) return;
    } catch (_) {
      return;
    }

    const current = this.streams[file];
    if (current) {
      try {
        current.end();
      } catch (_) {
        /* already closed */
      }
      delete this.streams[file];
    }
    for (let i = MAX_FILES - 1; i >= 1; i -= 1) {
      const from = file + '.' + i;
      const to = file + '.' + (i + 1);
      if (fs.existsSync(from)) {
        try {
          fs.renameSync(from, to);
        } catch (_) {
          /* keep going: a locked segment must not stop the rotation */
        }
      }
    }
    try {
      fs.renameSync(file, file + '.1');
    } catch (_) {
      /* next check will retry */
    }
  }

  stream(file) {
    if (!this.streams[file]) {
      this.streams[file] = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
      this.streams[file].on('error', () => {
        /* disk problems must not break the runtime */
      });
    }
    return this.streams[file];
  }

  push(level, scene, message, rawMeta) {
    this.seq += 1;

    // Reserved keys describe the event lifecycle: phase (start/done/error/info),
    // how long it took, and the entity it applies to (tool name, command, id).
    let phase = '';
    let durationMs = null;
    let target = '';
    let meta = rawMeta;
    if (rawMeta && typeof rawMeta === 'object') {
      const copy = { ...rawMeta };
      if (copy.__phase) phase = String(copy.__phase);
      if (copy.__durationMs != null) durationMs = Number(copy.__durationMs);
      if (copy.__target) target = String(copy.__target);
      delete copy.__phase;
      delete copy.__durationMs;
      delete copy.__target;
      meta = Object.keys(copy).length ? copy : null;
    }

    const entry = {
      seq: this.seq,
      ts: Date.now(),
      time: stamp(new Date()),
      level,
      scene,
      phase: phase || (level === 'error' ? 'error' : 'info'),
      message: redact(message == null ? '' : message)
    };
    if (durationMs != null && Number.isFinite(durationMs)) entry.durationMs = Math.round(durationMs);
    if (target) entry.target = redact(target).slice(0, 160);
    if (meta !== undefined && meta !== null) {
      try {
        entry.meta = JSON.parse(redact(JSON.stringify(meta)));
      } catch (_) {
        entry.meta = { raw: redact(String(meta)) };
      }
    }
    this.ring.push(entry);
    if (this.ring.length > RING_LIMIT) this.ring.splice(0, this.ring.length - RING_LIMIT);

    const line =
      entry.time +
      ' [' +
      level.toUpperCase() +
      '] [' +
      scene +
      '] ' +
      entry.message +
      (entry.meta ? ' ' + JSON.stringify(entry.meta) : '') +
      '\n';
    try {
      this.rotateIfNeeded(this.serverFile);
      this.stream(this.serverFile).write(line);
      if (level === 'error') {
        this.rotateIfNeeded(this.errorFile);
        this.stream(this.errorFile).write(line);
      }
    } catch (_) {
      /* never throw from logging */
    }
    return entry;
  }

  info(scene, message, meta) {
    return this.push('info', scene, message, meta);
  }

  /** An event started (tool call, turn, flow). */
  start(scene, message, meta) {
    return this.push('info', scene, message, { ...(meta || {}), __phase: 'start' });
  }

  /** An event finished successfully. */
  done(scene, message, meta) {
    return this.push('success', scene, message, { ...(meta || {}), __phase: 'done' });
  }

  /** An event finished with an error. */
  fail(scene, message, err, meta) {
    const detail = err && err.stack ? err.stack : err;
    const payload = { ...(meta || {}), __phase: 'error' };
    if (detail) payload.detail = String(detail);
    return this.push('error', scene, message, payload);
  }

  success(scene, message, meta) {
    return this.push('success', scene, message, meta);
  }

  warn(scene, message, meta) {
    return this.push('warn', scene, message, meta);
  }

  error(scene, message, err) {
    const detail = err && err.stack ? err.stack : err;
    return this.push('error', scene, message, detail ? { detail: String(detail) } : undefined);
  }

  live(since) {
    const from = Number(since) || 0;
    return {
      seq: this.seq,
      entries: this.ring.filter((e) => e.seq > from)
    };
  }
}

module.exports = { Logger, ensureDir, redact };
