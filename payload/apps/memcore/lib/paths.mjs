/**
 * memcore 路径解析：统一归档根 + 产物文件名。
 *
 * 归档根默认是「套件根\memory」，刻意放在 apps\ 之外：
 *   deploy.ps1 按目录整体覆盖 apps\*，若把记忆放在 apps\memcore\data 下，
 *   一次重新部署就会把历史全部冲掉（errvault 就吃过这个亏）。
 *   memory\ 位于目标机根目录，升级只改代码，不动数据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(HERE, '..');
/** apps/memcore/lib -> apps/memcore -> apps -> <套件根> */
export const KIT_ROOT = path.resolve(APP_ROOT, '..', '..');

export const MEMORY_HOME = process.env.MEMCORE_HOME
  ? path.resolve(process.env.MEMCORE_HOME)
  : path.join(KIT_ROOT, 'memory');

export const STORE_FILE = path.join(MEMORY_HOME, 'store.json');
export const MEMORY_FILE = path.join(MEMORY_HOME, 'MEMORY.md');
export const RULE_FILE = path.join(MEMORY_HOME, 'memcore.mdc');
export const LOG_DIR = path.join(MEMORY_HOME, 'logs');
export const ARCHIVE_DIR = path.join(MEMORY_HOME, 'archive');
export const WEB_DIR = path.join(APP_ROOT, 'web');

/** 配置覆盖点：<套件根>\config\memcore.json（可选，缺省即默认值）。 */
export const CONFIG_FILE = path.join(KIT_ROOT, 'config', 'memcore.json');

export function ensureHome() {
  for (const d of [MEMORY_HOME, LOG_DIR, ARCHIVE_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  return MEMORY_HOME;
}
