#!/usr/bin/env node
/**
 * @name shot
 * @category browser
 * @purpose Capture a local page over CDP: screenshot, console errors, node counts.
 * @input  --url <url> [--out png] [--width 1440] [--height 1000] [--wait 3000]
 *         [--port 9333] [--launch] [--close] [--json]
 * @usage  node tools/shot.mjs --url http://127.0.0.1:57910/ --launch --out shot.png --close
 * @reuse  yes
 */

import { parseArgs, arg, usage, exitWithUsage } from '../lib/cli.mjs';
import { launchBrowser, waitForDebugger, capturePage, closeBrowser } from '../lib/cdp.mjs';
import { createLogger } from '../lib/log.mjs';

const SPEC = {
  name: 'shot',
  purpose: 'capture a page over the DevTools protocol (screenshot + console errors)',
  options: [
    ['--url <url>', 'page to open (required)'],
    ['--out <png>', 'write a screenshot to this path'],
    ['--width <n>', 'viewport width (default 1440)'],
    ['--height <n>', 'viewport height (default 1000)'],
    ['--wait <ms>', 'settle time before capturing (default 3000)'],
    ['--port <n>', 'debugging port (default 9333)'],
    ['--launch', 'start a headless browser first'],
    ['--close', 'close the browsers bound to this port when done'],
    ['--json', 'print only the JSON result (machine readable)']
  ],
  examples: [
    'node tools/shot.mjs --url http://127.0.0.1:57910/ --launch --out shot.png --close',
    'node tools/shot.mjs --url http://127.0.0.1:57910/#__repos__ --json'
  ]
};

const parsed = parseArgs(process.argv.slice(2), { booleans: ['launch', 'close', 'json'] });
if (parsed.help) {
  console.log(usage(SPEC));
  process.exit(0);
}

const url = arg(parsed, 'url', '');
if (!url) exitWithUsage(SPEC);

const port = arg(parsed, 'port', 9333);
const log = createLogger({ name: 'shot', level: parsed.flags.json ? 'error' : 'info' });

if (parsed.flags.launch) {
  const started = launchBrowser({ port });
  log.info('browser launched', { pid: started.pid, port });
  await waitForDebugger(port);
}

try {
  const result = await capturePage({
    url,
    out: arg(parsed, 'out', ''),
    width: arg(parsed, 'width', 1440),
    height: arg(parsed, 'height', 1000),
    waitMs: arg(parsed, 'wait', 3000),
    port,
    evalScript: arg(parsed, 'eval', '')
  });

  if (parsed.flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    log.info('title', { title: result.meta.title });
    log.info('nodes', result.meta);
    log.info('errors', { count: result.errors.length });
    for (const error of result.errors) log.error(error);
    if (result.screenshot) log.info('screenshot', { file: result.screenshot });
  }
  process.exitCode = result.errors.length ? 1 : 0;
} catch (err) {
  log.error(err.message);
  process.exitCode = 2;
} finally {
  if (parsed.flags.close) await closeBrowser(port);
}
