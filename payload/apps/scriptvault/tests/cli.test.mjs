/**
 * @name cli.test
 * @category test
 * @purpose Regression tests for the shared argv parser and help renderer.
 * @input  none
 * @usage  node --test tests/
 * @reuse  yes
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, arg, usage } from '../lib/cli.mjs';

test('long flags with values are collected', () => {
  const parsed = parseArgs(['--url', 'http://x', '--out', 'a.png']);
  assert.equal(parsed.values.url, 'http://x');
  assert.equal(parsed.values.out, 'a.png');
  assert.deepEqual(parsed.positional, []);
  assert.equal(parsed.help, false);
});

test('--key=value form is supported', () => {
  const parsed = parseArgs(['--width=800', '--height=600']);
  assert.equal(parsed.values.width, '800');
  assert.equal(parsed.values.height, '600');
});

test('declared booleans consume no value', () => {
  const parsed = parseArgs(['--json', '--url', 'http://y'], { booleans: ['json'] });
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.values.url, 'http://y');
});

test('undeclared flag without a value becomes a boolean', () => {
  const parsed = parseArgs(['--strict']);
  assert.equal(parsed.flags.strict, true);
});

test('bare words keep their order as positionals', () => {
  const parsed = parseArgs(['first', '--x', '1', 'second']);
  assert.deepEqual(parsed.positional, ['first', 'second']);
  assert.equal(parsed.values.x, '1');
});

test('--help and -h are detected', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('arg coerces using the fallback type', () => {
  const parsed = parseArgs(['--n', '42', '--b', 'false', '--s', 'text']);
  assert.equal(arg(parsed, 'n', 1), 42);
  assert.equal(arg(parsed, 'b', true), false);
  assert.equal(arg(parsed, 's', ''), 'text');
  assert.equal(arg(parsed, 'missing', 7), 7);
});

test('arg falls back when a number is invalid', () => {
  const parsed = parseArgs(['--n', 'abc']);
  assert.equal(arg(parsed, 'n', 5), 5);
});

test('usage lists every option plus --help', () => {
  const text = usage({
    name: 'demo',
    purpose: 'do a thing',
    options: [['--url <url>', 'target']],
    examples: ['node demo.mjs --url x']
  });
  assert.match(text, /demo — do a thing/);
  assert.match(text, /--url <url>/);
  assert.match(text, /--help/);
  assert.match(text, /Examples:/);
});
