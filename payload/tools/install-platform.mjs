#!/usr/bin/env node
/**
 * 把使用规则装到各个 AI 编程平台。
 *
 * 旧做法只认 ~/.codebuddy/rules，等于把产品绑死在一个平台上。
 * 现在目录来自 config/platforms.json，新增平台只改那个 JSON。
 *
 * 用法：
 *   node tools/install-platform.mjs                    # 装到所有已登记平台
 *   node tools/install-platform.mjs --platform codex   # 只装一个
 *   node tools/install-platform.mjs --dry              # 只打印将写哪，不落盘
 *   node tools/install-platform.mjs --list             # 看平台清单
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(HERE, '..');
const PLATFORMS_FILE = path.join(KIT_ROOT, 'config', 'platforms.json');
const RULE_FILE = path.join(KIT_ROOT, 'rules', 'deploy-target.mdc');
const TARGET_NAME = 'aiworkkit.mdc';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 展开 ~ 和 %VAR%，并统一成绝对路径 */
function expand(p) {
  let out = String(p);
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1));
  out = out.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
  return path.resolve(out);
}

function parseArgs(argv) {
  const out = { platform: 'all', dry: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--platform' && argv[i + 1]) out.platform = argv[++i];
    else if (a === '--dry') out.dry = true;
    else if (a === '--list') out.list = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const pf = readJson(PLATFORMS_FILE);
if (!pf || !pf.platforms) {
  console.error('[install] 找不到 config/platforms.json');
  process.exit(2);
}

const ids = Object.keys(pf.platforms);

if (args.list) {
  console.log('已登记平台：');
  for (const id of ids) {
    const p = pf.platforms[id];
    console.log('  ' + id.padEnd(12) + (p.label || '') + '  →  ' + p.rulesDir);
    if (p.note) console.log('    ' + p.note);
  }
  process.exit(0);
}

const targets = args.platform === 'all' ? ids : [args.platform];
for (const id of targets) {
  if (!pf.platforms[id]) {
    console.error('[install] 未知平台：' + id + '（可选 ' + ids.join(' / ') + '）');
    process.exit(2);
  }
}

let ruleText = '';
try {
  ruleText = fs.readFileSync(RULE_FILE, 'utf8');
} catch (err) {
  console.error('[install] 读不到规则模板：' + err.message);
  process.exit(2);
}

// 占位符替换：端口取 deploy.json，路径取本套件实际位置
const cfg = readJson(path.join(KIT_ROOT, 'config', 'deploy.json')) || {};
const ports = cfg.ports || {};
const fill = (text) =>
  text
    .replace(/__TARGET__/g, KIT_ROOT)
    .replace(/__HOST__/g, cfg.host || '127.0.0.1')
    .replace(/__PORT_CODEVAULT__/g, String(ports.codevault || 57910))
    .replace(/__PORT_ECO__/g, String(ports.eco || 57821))
    .replace(/__PORT_TUNER__/g, String(ports.tuner || 57822))
    .replace(/__PORT_ERRVAULT__/g, String(ports.errvault || 57911));

const body = fill(ruleText);
let written = 0;

for (const id of targets) {
  const p = pf.platforms[id];
  if (!p.rulesDir) {
    console.log('  [skip] ' + id + '：未配置 rulesDir');
    continue;
  }
  const dir = expand(p.rulesDir);
  const dest = path.join(dir, TARGET_NAME);

  if (args.dry) {
    console.log('  [dry]  ' + id.padEnd(12) + dest);
    continue;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
    written += 1;
    console.log('  [ok]   ' + id.padEnd(12) + dest);
  } catch (err) {
    console.log('  [fail] ' + id.padEnd(12) + err.message);
  }
}

if (!args.dry) {
  console.log('\n已写入 ' + written + ' 个平台。规则文件：' + TARGET_NAME);
  console.log('说明：不同平台读取规则的位置不同，具体见 docs/平台接入.md');
}
