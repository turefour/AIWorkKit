/**
 * Duplicate process guard - regression tests.
 *
 * Covers the escalation the dashboard promises:
 *   3 个重复 -> 正常
 *   4 个重复持续两轮 -> 报警
 *   报警后又多一个 -> 锁死 + 清理多余进程（保留最早那个）
 *   直接 ≥6 个 -> 锁死
 *   进程消失 -> 解除
 *
 * Run: node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DuplicateGuard, isTestProcess, groupKeyOf } from '../server/lib/dupguard.js';

let nextPid = 1000;

/** Build a fake process row the way ProcessScanner would emit it. */
function proc(command, project, uptimeMs) {
  nextPid += 1;
  return {
    pid: nextPid,
    command,
    uptimeMs: uptimeMs == null ? 5000 : uptimeMs,
    project: { name: project || 'demo' }
  };
}

const TEST_CMD = 'node --test "C:\\work\\demo\\test\\engine.test.mjs"';

function guard() {
  return new DuplicateGuard();
}

/* ------------------------------------------------------------ detection */

test('识别测试进程，不误伤普通脚本', () => {
  assert.equal(isTestProcess(proc(TEST_CMD)), true);
  assert.equal(isTestProcess(proc('python -m pytest tests/ -q')), true);
  assert.equal(isTestProcess(proc('npx vitest run')), true);
  assert.equal(isTestProcess(proc('node server/eco-server.js')), false);
  assert.equal(isTestProcess(proc('node cli/eco.js status')), false);
  assert.equal(isTestProcess(proc('python fetch_std_online.js')), false);
});

test('同项目同脚本归为一组，不同项目分开', () => {
  const a1 = proc(TEST_CMD, 'demo');
  const a2 = proc(TEST_CMD, 'demo');
  const b1 = proc(TEST_CMD, 'other');
  assert.equal(groupKeyOf(a1), groupKeyOf(a2));
  assert.notEqual(groupKeyOf(a1), groupKeyOf(b1));
});

/* ------------------------------------------------------------ escalation */

test('3 个重复进程不报警', () => {
  const g = guard();
  const list = [proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD)];
  const r1 = g.inspect(list);
  const r2 = g.inspect(list);
  assert.equal(r1.alerts.length, 0);
  assert.equal(r2.alerts.length, 0);
  assert.equal(r2.groups[0].status, 'ok');
});

test('4 个重复持续两轮才报警（防抖）', () => {
  const g = guard();
  const list = [proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD)];

  const first = g.inspect(list);
  assert.equal(first.alerts.length, 0, '第一轮只是计数，不报警');

  const second = g.inspect(list);
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].level, 'warn');
  assert.equal(second.alerts[0].count, 4);
  assert.equal(second.groups[0].status, 'warn');
});

test('报警后再多一个 -> 锁死并清理多余进程', () => {
  const g = guard();
  const four = [proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD)];
  g.inspect(four);
  g.inspect(four);

  const five = four.concat([proc(TEST_CMD)]);
  const r = g.inspect(five);

  assert.equal(r.groups[0].status, 'locked');
  assert.equal(r.locked.length, 1);
  assert.equal(r.alerts.filter((a) => a.level === 'lock').length >= 1, true);

  // 保留最早那个（uptime 最大），其余 4 个进 kill 列表
  assert.equal(r.kill.length, 4);
  const survivor = five.slice().sort((a, b) => b.uptimeMs - a.uptimeMs)[0];
  assert.equal(r.kill.some((p) => p.pid === survivor.pid), false);
});

test('直接 6 个 -> 一次采样即锁死', () => {
  const g = guard();
  const six = [];
  for (let i = 0; i < 6; i += 1) six.push(proc(TEST_CMD));

  g.inspect(six); // 第一轮 hits=1，仍 ok
  const second = g.inspect(six);
  assert.equal(second.groups[0].status, 'locked');
  assert.equal(second.kill.length, 5);
});

test('锁死状态下持续清理，保持只剩一个', () => {
  const g = guard();
  const six = [];
  for (let i = 0; i < 6; i += 1) six.push(proc(TEST_CMD));
  g.inspect(six);
  g.inspect(six);

  const third = g.inspect(six.slice(0, 5));
  assert.equal(third.groups[0].status, 'locked');
  assert.equal(third.kill.length, 4, '5 个里杀 4 个');
});

/* ------------------------------------------------------------ clearing */

test('进程降到阈值以下 -> 解除告警', () => {
  const g = guard();
  const four = [proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD)];
  g.inspect(four);
  g.inspect(four);

  const calm = g.inspect([proc(TEST_CMD)]);
  assert.equal(calm.groups[0].status, 'ok');
});

test('组消失后状态清空', () => {
  const g = guard();
  g.inspect([proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD)]);
  g.inspect([proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD)]);
  assert.equal(g.tracks.size, 1);

  g.inspect([]);
  assert.equal(g.tracks.size, 0);
});

test('手动解锁后回到 ok', () => {
  const g = guard();
  const six = [];
  for (let i = 0; i < 6; i += 1) six.push(proc(TEST_CMD));
  g.inspect(six);
  const r = g.inspect(six);
  assert.equal(r.groups[0].status, 'locked');

  const key = r.groups[0].key;
  assert.equal(g.unlock(key), true);
  assert.equal(g.tracks.get(key).status, 'ok');

  const after = g.inspect([proc(TEST_CMD)]);
  assert.equal(after.groups[0].status, 'ok');
  assert.equal(after.kill.length, 0);
});

/* ------------------------------------------------------------ isolation */

test('两个项目各自的重复进程互不影响', () => {
  const g = guard();
  const list = [
    proc(TEST_CMD, 'a'),
    proc(TEST_CMD, 'a'),
    proc(TEST_CMD, 'b'),
    proc(TEST_CMD, 'b')
  ];
  g.inspect(list);
  const r = g.inspect(list);
  assert.equal(r.groups.length, 2);
  for (const group of r.groups) {
    assert.equal(group.count, 2);
    assert.equal(group.status, 'ok');
  }
});

test('state() 输出可供看板直接使用', () => {
  const g = guard();
  g.inspect([proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD)]);
  g.inspect([proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD), proc(TEST_CMD)]);

  const state = g.state();
  assert.equal(state.warnAt, 4);
  assert.equal(state.lockAt, 6);
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].status, 'warn');
  assert.equal(state.alerts.length >= 1, true);
  assert.equal(typeof state.alerts[0].at, 'number');
});
