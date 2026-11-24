'use strict';

/**
 * AIWorkKit Eco - locate and read the script behind a process.
 *
 * The command line of a running process usually contains the entry script, e.g.
 *   node "C:\proj\cli\eco.js" server --daemon
 *   python C:\proj\etl\main.py --date 2026-10-29
 *
 * Only whitelisted source extensions are read, and only up to a size/line cap,
 * so the detail window can never pull a huge binary or a secret file.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;
const MAX_LINES = 2000;

const LANGUAGE = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.sh': 'shell',
  '.bash': 'shell',
  '.bat': 'batch',
  '.cmd': 'batch',
  '.rb': 'ruby',
  '.go': 'go',
  '.java': 'java',
  '.lua': 'lua',
  '.php': 'php',
  '.rs': 'rust',
  '.pl': 'perl'
};

const EXTENSIONS = new Set(Object.keys(LANGUAGE));

function tokenize(command) {
  const matches = String(command || '').match(/"[^"]*"|'[^']*'|[^\s]+/g);
  return matches ? matches.map((t) => t.replace(/^["']|["']$/g, '')) : [];
}

/**
 * @returns {string|null} absolute path of the most likely entry script
 */
function extractScriptPath(command) {
  const tokens = tokenize(command);
  const candidates = [];

  for (const token of tokens) {
    if (!token || token.startsWith('-')) continue;
    // skip env assignments and bare flags
    if (token.indexOf('=') >= 0 && !/[\\/]/.test(token)) continue;
    const ext = path.extname(token).toLowerCase();
    if (!EXTENSIONS.has(ext)) continue;
    candidates.push(token);
  }

  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
    try {
      if (fs.statSync(absolute).isFile()) return absolute;
    } catch (_) {
      /* try the next candidate */
    }
  }
  return null;
}

/** Read a source file for display, with line numbering done by the client. */
function readScript(file) {
  if (!file) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return { path: file, exists: false, language: '', lines: [], totalLines: 0, truncated: false, reason: '文件不存在或无权访问' };
  }
  if (!stat.isFile()) return null;

  const ext = path.extname(file).toLowerCase();
  let text = '';
  let truncated = false;
  try {
    if (stat.size > MAX_BYTES) {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(MAX_BYTES);
      const read = fs.readSync(fd, buffer, 0, MAX_BYTES, 0);
      fs.closeSync(fd);
      text = buffer.slice(0, read).toString('utf8');
      truncated = true;
    } else {
      text = fs.readFileSync(file, 'utf8');
    }
  } catch (e) {
    return { path: file, exists: true, language: LANGUAGE[ext] || '', lines: [], totalLines: 0, truncated: false, reason: '读取失败：' + e.message };
  }

  const all = text.split(/\r?\n/);
  if (all.length > MAX_LINES) {
    all.length = MAX_LINES;
    truncated = true;
  }

  return {
    path: file,
    exists: true,
    language: LANGUAGE[ext] || 'text',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    totalLines: text.split(/\r?\n/).length,
    lines: all,
    truncated
  };
}

module.exports = { extractScriptPath, readScript, MAX_LINES };
