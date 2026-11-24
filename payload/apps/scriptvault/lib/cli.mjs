/**
 * @module cli
 * @category core
 * @purpose Minimal argv parser shared by every tool: long flags, values, positionals, --help.
 * @usage  import { parseArgs, usage } from '../lib/cli.mjs';
 */

/**
 * Parse argv into { values, flags, positional, help }.
 *
 * Supports:
 *   --key value        value flag
 *   --key=value        value flag
 *   --flag             boolean
 *   -h / --help        help request
 *   bare words         collected in positional (order preserved)
 *
 * @param {string[]} argv          process.argv.slice(2)
 * @param {{ booleans?: string[] }} [options]
 */
export function parseArgs(argv, options = {}) {
  const booleans = new Set(options.booleans || []);
  const values = {};
  const flags = {};
  const positional = [];
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--help' || token === '-h' || token === 'help') {
      help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq > -1) {
        values[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (booleans.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        values[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    positional.push(token);
  }

  return { values, flags, positional, help };
}

/** Read a value flag with a default and optional coercion. */
export function arg(parsed, name, fallback) {
  const raw = parsed.values[name];
  if (raw === undefined) return fallback;
  if (typeof fallback === 'number') {
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
  }
  if (typeof fallback === 'boolean') return raw !== 'false' && raw !== '0';
  return raw;
}

/**
 * Build a --help screen from a declarative spec.
 *
 * @param {{ name: string, purpose: string, options?: Array<[string, string]>, examples?: string[] }} spec
 */
export function usage(spec) {
  const lines = [`${spec.name} — ${spec.purpose}`, '', 'Options:'];
  const width = Math.max(...(spec.options || []).map(([flag]) => flag.length), 12);
  for (const [flag, desc] of spec.options || []) {
    lines.push('  ' + flag.padEnd(width + 2) + desc);
  }
  lines.push('  ' + '--help'.padEnd(width + 2) + 'show this help');
  if (spec.examples && spec.examples.length) {
    lines.push('', 'Examples:');
    for (const example of spec.examples) lines.push('  ' + example);
  }
  return lines.join('\n');
}

/**
 * Print usage and exit. Used as the single exit path for bad input.
 * @param {object} spec  see usage()
 * @param {number} [code]
 */
export function exitWithUsage(spec, code = 2) {
  console.error(usage(spec));
  process.exit(code);
}
