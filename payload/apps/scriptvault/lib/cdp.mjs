/**
 * @module cdp
 * @category browser
 * @purpose Chromium DevTools Protocol client: launch Edge, connect, evaluate, screenshot, collect console errors.
 * @usage  import { capturePage } from '../lib/cdp.mjs';
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ensureDir } from './fsx.mjs';

const CHROMIUM_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Locate an installed Chromium browser. Throws when none is found. */
export function findBrowser() {
  for (const candidate of CHROMIUM_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no Edge/Chrome found; install one or pass --browser <exe>');
}

export function defaultProfileDir(port) {
  return path.join(os.tmpdir(), `cdp-profile-${port}`);
}

/** Start a headless browser with the debugging port open. Returns the child pid. */
export function launchBrowser(options = {}) {
  const exe = options.exe || findBrowser();
  const port = options.port || 9333;
  const profile = options.profileDir || defaultProfileDir(port);
  ensureDir(profile);

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank'
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { pid: child.pid, port, profile };
}

/** Poll /json/version until the debugger answers. */
export async function waitForDebugger(port = 9333, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`debugger on port ${port} did not answer in ${timeoutMs} ms`);
}

/**
 * Open a WebSocket session to the first page target.
 * Returns { send, events, close, evaluate }.
 */
export async function connect(port = 9333) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((target) => target.type === 'page');
  if (!page) throw new Error('no page target; is the debugger port correct?');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  let seq = 0;

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const slot = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message));
      else slot.resolve(msg.result);
      return;
    }
    if (msg.method) events.push(msg);
  });

  const send = (method, params) => {
    seq += 1;
    const id = seq;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  return {
    send,
    events,
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
    /** Evaluate an expression in the page and return the JSON value. */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true });
      return result.result ? result.result.value : undefined;
    }
  };
}

/** Console errors and uncaught exceptions captured so far. */
export function collectErrors(events) {
  return events
    .filter(
      (event) =>
        event.method === 'Runtime.exceptionThrown' ||
        (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
    )
    .map((event) => {
      if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params.exceptionDetails;
        return details.exception ? details.exception.description : details.text;
      }
      return event.params.args.map((a) => a.value || a.description || '').join(' ');
    });
}

/**
 * One-shot page capture: navigate, wait, snapshot meta/text/errors/screenshot.
 *
 * @param {{ url: string, out?: string, width?: number, height?: number, waitMs?: number, port?: number }} options
 */
export async function capturePage(options) {
  const port = options.port || 9333;
  const width = options.width || 1440;
  const height = options.height || 1000;
  const waitMs = options.waitMs == null ? 3000 : options.waitMs;

  const cdp = await connect(port);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: options.url });
  await sleep(1200);

  // Optional interaction before the screenshot: log in, click a tab, scroll, etc.
  let evalResult = null;
  if (options.evalScript) {
    evalResult = await cdp.evaluate(options.evalScript);
    await sleep(600);
  }

  await sleep(waitMs);

  const meta = await cdp.evaluate(
    'JSON.stringify({ title: document.title, nodes: document.querySelectorAll("*").length, ' +
      'items: document.querySelectorAll(".item").length, cards: document.querySelectorAll(".card").length })'
  );
  const text = await cdp.evaluate('document.body ? document.body.innerText.slice(0, 600) : "(no body)"');
  const errors = collectErrors(cdp.events);

  let screenshot = null;
  if (options.out) {
    const png = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(options.out, Buffer.from(png.data, 'base64'));
    screenshot = options.out;
  }

  cdp.close();
  return {
    url: options.url,
    meta: JSON.parse(meta || '{}'),
    errors,
    text: String(text || '').replace(/\n+/g, ' | ').slice(0, 400),
    screenshot,
    evalResult
  };
}

/**
 * Close only the browser instances started for this debugging port.
 * A blanket `taskkill /IM msedge.exe` would also kill the user's own windows,
 * so the command line is matched explicitly.
 */
export function closeBrowser(port = 9333) {
  return new Promise((resolve) => {
    const script =
      'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\' or Name=\'chrome.exe\'" | ' +
      `Where-Object { $_.CommandLine -match 'remote-debugging-port=${port}' } | ` +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    const killer = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true });
    killer.on('exit', () => resolve(true));
    killer.on('error', () => resolve(false));
  });
}
