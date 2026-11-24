/**
 * @module log
 * @category core
 * @purpose Tiny logger with levels, ISO timestamps, secret redaction and optional file sink.
 * @usage  import { createLogger } from '../lib/log.mjs';
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fsx.mjs';

/** Mask tokens and bearer headers before they reach stdout or a log file. */
export function redact(text) {
  return String(text)
    .replace(/(access_token=)[^&\s"']+/gi, '$1***')
    .replace(/("?(?:token|secret|password|apikey|api_key)"?\s*[:=]\s*)"?[^",\s}]+"?/gi, '$1***')
    .replace(/(Bearer\s+)[\w.-]+/gi, '$1***');
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @param {{ name?: string, file?: string, level?: keyof LEVELS, quiet?: boolean }} [options]
 */
export function createLogger(options = {}) {
  const name = options.name || 'script';
  const minLevel = LEVELS[options.level || 'info'] || LEVELS.info;
  const file = options.file || '';
  const fileMaxBytes = 8 * 1024 * 1024;

  if (file) ensureDir(path.dirname(file));

  const sink = (line) => {
    if (options.quiet) return;
    process.stdout.write(line + '\n');
  };

  const write = (level, message, meta) => {
    if ((LEVELS[level] || 0) < minLevel) return;
    const time = new Date().toISOString();
    const tail = meta === undefined ? '' : ' ' + JSON.stringify(meta);
    const line = `[${time}] [${level.toUpperCase()}] [${name}] ${redact(message)}${redact(tail)}`;
    sink(line);
    if (!file) return;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > fileMaxBytes) {
        fs.renameSync(file, file + '.1');
      }
      fs.appendFileSync(file, line + '\r\n', 'utf8');
    } catch {
      /* logging must never break the run */
    }
  };

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    redact
  };
}
