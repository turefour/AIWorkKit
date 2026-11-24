#!/usr/bin/env node
/**
 * @name scaffold
 * @category scaffold
 * @purpose Create a new tool with the standard header, argv parsing and logger wired up.
 * @input  <name> --purpose "..." [--category browser] [--python]
 * @usage  node tools/scaffold.mjs fetch-docs --purpose "Download release notes" --category web
 * @reuse  yes
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, usage, exitWithUsage } from '../lib/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SPEC = {
  name: 'scaffold',
  purpose: 'generate a new tool skeleton with the standard metadata header',
  options: [
    ['--purpose <text>', 'one-line purpose (required)'],
    ['--category <id>', 'browser | cad | doc | data | system | web | test | scaffold'],
    ['--python', 'emit a Python skeleton instead of Node']
  ],
  examples: ['node tools/scaffold.mjs fetch-docs --purpose "Download release notes" --category web']
};

const parsed = parseArgs(process.argv.slice(2), { booleans: ['python'] });
const name = parsed.positional[0];
const purpose = parsed.values.purpose || '';

if (parsed.help || !name || !purpose) {
  console.log(usage(SPEC));
  if (!parsed.help) process.exitCode = 2;
  process.exit();
}

if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  exitWithUsage(SPEC);
}

const category = parsed.values.category || 'system';
const nodeFile = path.join(ROOT, 'tools', `${name}.mjs`);
const pyFile = path.join(ROOT, 'tools', `${name}.py`);

if (fs.existsSync(nodeFile) || fs.existsSync(pyFile)) {
  console.error('refusing to overwrite an existing tool: ' + name);
  process.exit(1);
}

if (parsed.flags.python) {
  const body = `#!/usr/bin/env python
"""
@name ${name}
@category ${category}
@purpose ${purpose}
@input  --arg <value>
@usage  python tools/${name}.py --arg value
@reuse  yes
"""

import argparse
import sys


def main():
    parser = argparse.ArgumentParser(description=${JSON.stringify(purpose)})
    parser.add_argument("--arg", default="", help="input value")
    args = parser.parse_args()

    print("[${name}] arg=" + args.arg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
  fs.writeFileSync(pyFile, body, 'utf8');
  console.log('created ' + pyFile);
} else {
  const body = `#!/usr/bin/env node
/**
 * @name ${name}
 * @category ${category}
 * @purpose ${purpose}
 * @input  --input <value>
 * @usage  node tools/${name}.mjs --input value
 * @reuse  yes
 */

import { parseArgs, arg, usage, exitWithUsage } from '../lib/cli.mjs';
import { createLogger } from '../lib/log.mjs';

const SPEC = {
  name: '${name}',
  purpose: ${JSON.stringify(purpose)},
  options: [['--input <value>', 'input value']],
  examples: ['node tools/${name}.mjs --input value']
};

const parsed = parseArgs(process.argv.slice(2), { booleans: ['json'] });
if (parsed.help) {
  console.log(usage(SPEC));
  process.exit(0);
}

const input = arg(parsed, 'input', '');
if (!input) exitWithUsage(SPEC);

const log = createLogger({ name: '${name}' });
log.info('start', { input });
// TODO: implement
log.info('done');
`;
  fs.writeFileSync(nodeFile, body, 'utf8');
  console.log('created ' + nodeFile);
}

console.log('next: node build-index.mjs   # refresh the category index');
