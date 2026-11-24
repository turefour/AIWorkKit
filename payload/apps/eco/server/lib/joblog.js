'use strict';

/**
 * AIWorkKit Eco - per job log files.
 *
 * The in-memory job log keeps only a short tail for the dashboard cards, while
 * the full output of wrapped scripts and tool responses is appended here so any
 * flow can be inspected later:
 *
 *   .eco/jobs/<safe-id>.log
 *
 * Files are capped to avoid unbounded growth; truncation keeps the newest half.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_BYTES = 4 * 1024 * 1024;

function safeName(jobId) {
  const raw = String(jobId || 'job');
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'job';
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 6);
  return slug + '-' + hash + '.log';
}

class JobLogStore {
  constructor(dir) {
    this.dir = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {
      /* directory may exist */
    }
  }

  file(jobId) {
    return path.join(this.dir, safeName(jobId));
  }

  append(jobId, text, level) {
    const body = String(text == null ? '' : text);
    if (!body) return;
    const file = this.file(jobId);
    const line = '[' + new Date().toISOString() + '] [' + (level || 'info') + '] ' + body + (body.endsWith('\n') ? '' : '\n');
    try {
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES) {
          const tail = fs.readFileSync(file, 'utf8').slice(-Math.floor(MAX_FILE_BYTES / 2));
          fs.writeFileSync(file, '--- truncated ---\n' + tail, 'utf8');
        }
      } catch (_) {
        /* first write */
      }
      fs.appendFileSync(file, line, 'utf8');
    } catch (_) {
      /* logging must never break the runtime */
    }
  }

  /** Read the last `tail` lines, or everything when tail is 0. */
  read(jobId, tail) {
    const file = this.file(jobId);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      return { exists: false, lines: [], bytes: 0 };
    }
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    const sliced = tail > 0 ? lines.slice(-tail) : lines;
    return { exists: true, lines: sliced, totalLines: lines.length, bytes: Buffer.byteLength(text, 'utf8') };
  }

  /**
   * Incremental read from a byte offset.
   * Following a live log used to re-read the whole file every second (O(n^2) over
   * the run); this only reads what was appended since the last poll.
   *
   * @param {string} jobId
   * @param {number} byteOffset  last offset returned by a previous call
   */
  readFrom(jobId, byteOffset) {
    const file = this.file(jobId);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch (_) {
      return { exists: false, lines: [], bytes: 0, offset: 0 };
    }
    try {
      const stat = fs.fstatSync(fd);
      // A truncated file (4MB cap) invalidates the cursor: restart from zero.
      const start = byteOffset > stat.size ? 0 : byteOffset;
      const length = stat.size - start;
      if (length <= 0) {
        return { exists: true, lines: [], bytes: stat.size, offset: stat.size };
      }
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const lines = buffer.toString('utf8').split(/\r?\n/).filter((l) => l.length);
      return { exists: true, lines, bytes: stat.size, offset: stat.size };
    } finally {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* already closed */
      }
    }
  }

  remove(jobId) {
    try {
      fs.rmSync(this.file(jobId), { force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { JobLogStore, safeName };
