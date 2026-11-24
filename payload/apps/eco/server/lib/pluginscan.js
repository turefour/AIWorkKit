'use strict';

/**
 * AIWorkKit Eco - installed plugin inventory.
 *
 * Scans the AIWorkKit plugin marketplaces plus the project-level plugin folder
 * and reports, per plugin: identity, capabilities (hooks/skills/commands/agents)
 * and recent on-disk activity, which is the cheapest reliable signal that a
 * plugin is currently participating in a session.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { pluginScope } = require('./projects');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch (_) {
    return null;
  }
}

function countFiles(dir, depth) {
  const st = safeStat(dir);
  if (!st || !st.isDirectory()) return 0;
  let n = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) n += 1;
      else if (entry.isDirectory() && depth > 1) n += countFiles(path.join(dir, entry.name), depth - 1);
    }
  } catch (_) {
    /* permission issues are non fatal */
  }
  return n;
}

function describe(root, meta, ctx) {
  const context = ctx || {};
  const pluginJson = path.join(root, '.codebuddy-plugin', 'plugin.json');
  const info = meta || readJson(pluginJson) || {};
  const hooksFile = path.join(root, 'hooks', 'hooks.json');
  const hooks = readJson(hooksFile);
  const hookEvents = hooks && hooks.hooks ? Object.keys(hooks.hooks) : [];

  let touched = 0;
  for (const probe of [pluginJson, hooksFile, path.join(root, 'SKILL.md')]) {
    const st = safeStat(probe);
    if (st && st.mtimeMs > touched) touched = st.mtimeMs;
  }
  const dirStat = safeStat(root);

  const scope = pluginScope(root, context.cwd, context.marketplace);

  return {
    name: info.name || path.basename(root),
    version: info.version || '',
    description: String(info.description || '').slice(0, 220),
    root,
    hooks: hookEvents,
    skills: countFiles(path.join(root, 'skills'), 2),
    commands: countFiles(path.join(root, 'commands'), 1),
    agents: countFiles(path.join(root, 'agents'), 1),
    scope: scope.scope,
    project: scope.project,
    marketplace: scope.marketplace,
    lastTouched: Math.max(touched, dirStat ? dirStat.mtimeMs : 0)
  };
}

/**
 * 平台档案（config/platforms.json）。
 *
 * 旧版把插件目录和 settings 路径写死成某个平台的 ~/.xxx，
 * 换平台就等于这个面板全空。现在有几个平台就扫几个。
 */
function loadPlatformProfiles() {
  try {
    const file = path.resolve(__dirname, '../../../../config/platforms.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const home = os.homedir();
    const expand = (p) => {
      if (!p) return '';
      const s = String(p).replace(/^~/, home).replace(/%([^%]+)%/g, (m, n) => process.env[n] || m);
      return path.resolve(s);
    };
    return Object.keys(raw.platforms || {})
      .map((k) => {
        const p = raw.platforms[k] || {};
        return { id: k, label: p.label || k, settings: expand(p.settingsFile), plugins: expand(p.pluginsDir) };
      })
      .filter((p) => p.settings || p.plugins);
  } catch (_) {
    return [];
  }
}

/** 所有平台的插件目录；配置缺失时退回默认位置，保证老机器仍可用 */
function pluginRoots(home) {
  const fromCfg = loadPlatformProfiles()
    .map((p) => p.plugins)
    .filter(Boolean);
  const roots = fromCfg.length ? fromCfg.slice() : [path.join(home, '.aiworkkit', 'plugins')];
  // 兼容：这个目录历史最久，即使没写进配置也扫一遍
  const legacy = path.join(home, '.codebuddy', 'plugins');
  if (!roots.includes(legacy)) roots.push(legacy);
  return roots;
}

/** 插件开关写回哪个 settings：优先已存在的那个平台 */
function settingsFile() {
  const profiles = loadPlatformProfiles().filter((p) => p.settings);
  for (const p of profiles) {
    if (safeStat(p.settings)) return p.settings;
  }
  if (profiles.length) return profiles[0].settings;
  return path.join(os.homedir(), '.aiworkkit', 'settings.json');
}

function loadEnabledNames() {
  const names = new Set();
  const files = loadPlatformProfiles()
    .map((p) => p.settings)
    .filter(Boolean);
  if (!files.length) files.push(settingsFile());

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const map = (raw && raw.enabledPlugins) || {};
      for (const [key, value] of Object.entries(map)) {
        if (value) names.add(String(key).split('@')[0]);
      }
    } catch (_) {
      /* 该平台没装或没启用插件 */
    }
  }
  return names;
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name))
      // statSync follows directory junctions, which Dirent reports as symlinks;
      // the eco plugin itself is installed as a junction.
      .filter((full) => {
        try {
          return fs.statSync(full).isDirectory();
        } catch (_) {
          return false;
        }
      });
  } catch (_) {
    return [];
  }
}

function collect(cwd) {
  const home = os.homedir();
  const roots = pluginRoots(home);
  const found = new Map();

  for (const pluginsRoot of roots) {
    // 市场安装的插件
    for (const market of listDirs(path.join(pluginsRoot, 'marketplaces'))) {
      const marketName = path.basename(market);
      for (const bucket of ['plugins', 'external_plugins']) {
        for (const dir of listDirs(path.join(market, bucket))) {
          const entry = describe(dir, null, { cwd, marketplace: marketName });
          found.set(entry.root.toLowerCase(), entry);
        }
      }
    }

    // 本地直接安装（非市场）
    for (const dir of listDirs(pluginsRoot)) {
      if (path.basename(dir) === 'marketplaces') continue;
      if (safeStat(path.join(dir, '.codebuddy-plugin', 'plugin.json'))) {
        const entry = describe(dir, null, { cwd });
        found.set(entry.root.toLowerCase(), entry);
      }
    }
  }

  // 项目内插件：各平台的目录约定都看一遍
  if (cwd) {
    const platformDirs = ['.aiworkkit', '.codebuddy', '.codex', '.deepseek', '.vibe'];
    const bases = [];
    for (const dir of platformDirs) bases.push(path.join(cwd, dir, 'plugins'));
    bases.push(path.join(cwd, 'plugins'));

    for (const base of bases) {
      for (const dir of listDirs(base)) {
        if (safeStat(path.join(dir, '.codebuddy-plugin', 'plugin.json'))) {
          const entry = describe(dir, null, { cwd });
          found.set(entry.root.toLowerCase(), entry);
        }
      }
    }
  }

  return Array.from(found.values()).sort((a, b) => (b.lastTouched || 0) - (a.lastTouched || 0));
}

class PluginScanner {
  constructor(options) {
    const opts = options || {};
    this.cwd = opts.cwd || process.cwd();
    this.intervalMs = opts.intervalMs || 30000;
    this.logger = opts.logger || null;
    this.plugins = [];
    this.timer = null;
    this.lastError = '';
    this.scanAt = 0;
  }

  scan() {
    try {
      const enabled = loadEnabledNames();
      this.plugins = collect(this.cwd).map((p) => ({ ...p, enabled: enabled.has(p.name) }));
      this.scanAt = Date.now();
      this.lastError = '';
    } catch (e) {
      this.lastError = e.message;
      if (this.logger) this.logger.error('pluginscan', 'plugin inventory scan failed', e);
    }
    return this.plugins;
  }

  start() {
    this.scan();
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { PluginScanner, collect, loadEnabledNames, settingsFile };
