/**
 * 本机能力清单（记忆库首层）。
 *
 * 记忆库原来只记「说过什么」，不记「这台机器能做什么」。
 * 这一层把本机已经具备的能力探测出来放在表层：装了什么软件、有哪些命令行工具、
 * 具备哪些开发库、跑着什么服务、装了哪些浏览器扩展，再映射成**可读的能力块**
 * （如「CAD 建模与出图」「PDF 文本提取」「本地网页发布」）。
 *
 * 设计取舍：
 *   1. 全部零依赖，只用系统自带命令（reg / netstat / tasklist）+ 读目录
 *   2. 每项探测独立容错、单独计时，任一失败只少一条，不影响整体
 *   3. 结果落盘缓存（默认 10 分钟），避免每次打开页面都扫一遍
 *   4. 只报「检测到什么」，不猜没检测到的
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { KIT_ROOT } from './paths.mjs';

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

/** 缓存有效期：10 分钟。装完软件手动点「重新扫描」即可刷新 */
const TTL_MS = 10 * 60 * 1000;

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
};

/** 跑一条系统命令，返回 stdout（失败返回空串），永不抛错 */
function run(cmd, args, timeout = 2500) {
  try {
    const r = spawnSync(cmd, args, {
      timeout,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    });
    if (!r || r.error) return '';
    return String(r.stdout || '');
  } catch (_) {
    return '';
  }
}

/**
 * PATH 解析：把命令名解析成真实可执行文件。
 *
 * 直接 spawnSync('git') 在 Windows 上解析不到（不带 .exe），
 * 而 shell:true 每个命令都要起一次 cmd.exe —— 实测 16 个工具耗 7.5 秒且仍漏掉 git。
 * 自己扫 PATH 目录只要一次目录遍历，快且可靠。
 */
const PATH_DIRS = String(process.env.PATH || '')
  .split(path.delimiter)
  .filter(Boolean);
const EXEC_EXTS = ['.exe', '.cmd', '.bat', '.com'];

/** 展开 %VAR% 与 ~ */
function expandPath(p) {
  let s = String(p || '').replace(/^~/, HOME);
  s = s.replace(/%([^%]+)%/g, (m, n) => process.env[n] || m);
  return s;
}

/** 支持一段通配（如 Python\Python*\python.exe）的路径解析 */
function resolveGlob(pattern) {
  const abs = expandPath(pattern);
  const parts = abs.split(path.sep).filter(Boolean);
  let current = parts[0] + path.sep; // 盘符
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i];
    if (!seg.includes('*')) {
      current = path.join(current, seg);
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return '';
    }
    const re = new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
    const hit = entries
      .filter((e) => re.test(e.name))
      .map((e) => path.join(current, e.name))
      .sort()
      .pop();
    if (!hit) return '';
    current = hit;
  }
  return exists(current) ? current : '';
}

/**
 * 解析命令：先查 PATH，再查常见安装位置。
 *
 * 为什么需要 fallback：套件服务由启动器拉起，PATH 往往是精简过的
 * （实测这台机器 PATH 里没有 Git 目录，但 C:\Program Files\Git\cmd\git.exe 确实存在），
 * 只看 PATH 会漏掉真正装了的工具。
 */
function resolveCommand(name, fallbacks) {
  for (const dir of PATH_DIRS) {
    for (const ext of EXEC_EXTS) {
      const p = path.join(dir, name + ext);
      if (exists(p)) return p;
    }
  }
  for (const pattern of fallbacks || []) {
    const hit = pattern.includes('*') ? resolveGlob(pattern) : expandPath(pattern);
    if (hit && exists(hit)) return hit;
  }
  return '';
}

/** 解析后执行；.cmd/.bat 需要经 cmd.exe 才能跑。返回 { text, exe } */
function runTool(name, args, timeout = 1200, fallbacks) {
  const exe = resolveCommand(name, fallbacks);
  if (!exe) return { text: '', exe: '' };
  const isScript = /\.(cmd|bat)$/i.test(exe);
  try {
    const r = isScript
      ? spawnSync('cmd', ['/c', exe].concat(args || []), {
          timeout,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024
        })
      : spawnSync(exe, args || [], {
          timeout,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024
        });
    if (!r || r.error) return { text: '', exe };
    // 有的工具把版本打到 stderr（如 java -version），两处都收
    return { text: String(r.stdout || '') + String(r.stderr || ''), exe };
  } catch (_) {
    return { text: '', exe };
  }
}

/* ------------------------------------------------------------ 1. 已安装软件 */

/** 注册表三处：64 位、32 位（WOW6432Node）、当前用户 */
const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
];

function scanApps() {
  const seen = new Map();
  for (const key of UNINSTALL_KEYS) {
    const out = run('reg', ['query', key, '/s', '/v', 'DisplayName'], 8000);
    if (!out) continue;
    for (const line of out.split(/\r?\n/)) {
      // 形如：    DisplayName    REG_SZ    FreeCAD 1.1.4
      const m = /\s+DisplayName\s+REG_[A-Z_]+\s+(.+)$/.exec(line);
      if (!m) continue;
      const name = m[1].trim();
      if (!name || name.length < 2) continue;
      // 系统补丁与运行库对「能力」没意义，滤掉降噪
      if (/^(Update for|Security Update|Hotfix|KB\d{6})/i.test(name)) continue;
      if (/^(Microsoft Visual C\+\+ \d+|Windows SDK|Microsoft \.NET)/i.test(name)) continue;
      if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'zh'));
}

/** 软件名 → 类别（只做粗分类，用于分组展示） */
function appCategory(name) {
  if (/CAD|AutoCAD|中望|浩辰|CAXA|SolidWorks|Revit|SketchUp|FreeCAD|看图/i.test(name)) return 'CAD / 建模';
  if (/Acrobat|PDF|Foxit|福昕|阅读器/i.test(name)) return 'PDF / 文档阅读';
  if (/Office|WPS|Word|Excel|PowerPoint|PageOffice/i.test(name)) return 'Office / 文档';
  if (/Chrome|Edge|Firefox|浏览器|Browser/i.test(name)) return '浏览器';
  if (/Python|Node|Java|Git|Visual Studio|JDK|\.NET/i.test(name)) return '开发环境';
  if (/钉钉|DingTalk|微信|WeChat|QQ|飞书/i.test(name)) return '通讯';
  if (/7-Zip|WinRAR|压缩/i.test(name)) return '压缩工具';
  return '其他';
}

/* ------------------------------------------------------------ 2. 命令行工具 */

/**
 * 常见工具与版本参数。
 * fallbacks 是「装了但不在 PATH」的兜底位置 —— 套件服务由启动器拉起，
 * PATH 常被精简（实测连 Git 都找不到），只查 PATH 会漏报。
 */
const CLI_TOOLS = [
  { cmd: 'git', args: ['--version'], label: 'Git', undo: '版本控制', fallbacks: [path.join(KIT_ROOT, 'runtime', 'git', 'cmd', 'git.exe'), '%ProgramFiles%\\Git\\cmd\\git.exe', '%ProgramFiles(x86)%\\Git\\cmd\\git.exe', '%LOCALAPPDATA%\\Programs\\Git\\cmd\\git.exe', '%LOCALAPPDATA%\\CodeBuddyWorkKit\\runtime\\git\\cmd\\git.exe'] },
  { cmd: 'node', args: ['--version'], label: 'Node.js', undo: '运行时', fallbacks: ['%ProgramFiles%\\nodejs\\node.exe'] },
  { cmd: 'npm', args: ['--version'], label: 'npm', undo: '包管理', fallbacks: ['%ProgramFiles%\\nodejs\\npm.cmd'] },
  { cmd: 'pnpm', args: ['--version'], label: 'pnpm', undo: '包管理', fallbacks: ['%LOCALAPPDATA%\\pnpm\\pnpm.exe'] },
  { cmd: 'python', args: ['--version'], label: 'Python', undo: '运行时', fallbacks: ['%LOCALAPPDATA%\\Programs\\Python\\Python*\\python.exe', '%ProgramFiles%\\Python*\\python.exe'] },
  { cmd: 'pip', args: ['--version'], label: 'pip', undo: '包管理', fallbacks: [] },
  { cmd: 'ffmpeg', args: ['-version'], label: 'FFmpeg', undo: '音视频处理', fallbacks: ['%ProgramFiles%\\ffmpeg\\bin\\ffmpeg.exe', '%LOCALAPPDATA%\\ffmpeg\\bin\\ffmpeg.exe'] },
  { cmd: 'magick', args: ['-version'], label: 'ImageMagick', undo: '图像处理', fallbacks: ['%ProgramFiles%\\ImageMagick*\\magick.exe'] },
  { cmd: 'gs', args: ['--version'], label: 'Ghostscript', undo: 'PDF 渲染', fallbacks: ['%ProgramFiles%\\gs\\gs*\\bin\\gswin64c.exe'] },
  { cmd: 'pdftotext', args: ['-v'], label: 'poppler pdftotext', undo: 'PDF 提取', fallbacks: ['%ProgramFiles%\\poppler*\\bin\\pdftotext.exe'] },
  { cmd: 'soffice', args: ['--version'], label: 'LibreOffice', undo: '文档转换', fallbacks: ['%ProgramFiles%\\LibreOffice\\program\\soffice.exe'] },
  { cmd: '7z', args: [], label: '7-Zip', undo: '压缩解压', fallbacks: ['%ProgramFiles%\\7-Zip\\7z.exe'] },
  { cmd: 'codebuddy', args: ['--version'], label: 'CodeBuddy CLI', undo: 'AI 编程', fallbacks: ['%APPDATA%\\npm\\codebuddy.cmd'] },
  { cmd: 'gh', args: ['--version'], label: 'GitHub CLI', undo: '仓库操作', fallbacks: ['%ProgramFiles%\\GitHub CLI\\gh.exe'] }
];

function scanCli() {
  const out = [];
  for (const t of CLI_TOOLS) {
    const r = runTool(t.cmd, t.args || [], 1200, t.fallbacks);
    const raw = String(r.text || '').trim();
    if (!raw) continue; // 命令不存在或超时，视为未安装
    const first = raw.split(/\r?\n/)[0].trim();
    const ver = (first.match(/\d+\.\d+(\.\d+)?/) || [])[0] || '';
    // bundled：来自套件自带的便携运行时（这台机器没有独立安装 Git，只有便携版）
    const bundled = /[\\/]runtime[\\/]/i.test(String(r.exe || ''));
    out.push({ name: t.label, cmd: t.cmd, version: ver, use: t.undo, bundled, path: r.exe });
  }
  return out;
}

/* ------------------------------------------------------------ 3. 开发库 */

/** Python 库：一次进程全部查完，避免 10 次启动开销 */
const PY_MODULES = [
  { mod: 'fitz', cap: 'PDF 文本与图像提取' },
  { mod: 'pdfplumber', cap: 'PDF 表格提取' },
  { mod: 'docx', cap: 'Word 文档生成' },
  { mod: 'pptx', cap: 'PPT 生成' },
  { mod: 'openpyxl', cap: 'Excel 读写' },
  { mod: 'ezdxf', cap: 'DXF 读写' },
  { mod: 'PIL', cap: '图像处理' },
  { mod: 'numpy', cap: '数值计算' },
  { mod: 'pandas', cap: '表格分析' },
  { mod: 'matplotlib', cap: '图表绘制' },
  { mod: 'requests', cap: 'HTTP 请求' }
];

function scanPythonLibs() {
  const mods = PY_MODULES.map((m) => m.mod);
  const code =
    'import importlib.util,json,sys\n' +
    'mods=' + JSON.stringify(mods) + '\n' +
    'r={}\n' +
    'for m in mods:\n' +
    '    try:\n' +
    '        r[m]=importlib.util.find_spec(m) is not None\n' +
    '    except Exception:\n' +
    '        r[m]=False\n' +
    'print(json.dumps(r))\n';
  const raw = run('python', ['-c', code], 6000).trim();
  if (!raw) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw.split(/\r?\n/).pop());
  } catch (_) {
    return [];
  }
  return PY_MODULES.filter((m) => parsed[m.mod]).map((m) => ({
    name: m.mod,
    ecosystem: 'python',
    use: m.cap
  }));
}

/** Node 全局包：读目录，不跑 npm（npm ls -g 要 2.6 秒） */
function scanNodeGlobals() {
  const dir = path.join(APPDATA, 'npm', 'node_modules');
  if (!exists(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({
        name: d.name,
        ecosystem: 'node',
        use: /playwright|puppeteer|agent-browser/i.test(d.name) ? '浏览器自动化' : ''
      }));
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------ 4. 运行中的服务 */

/** netstat -ano 解析监听端口；tasklist 映射 PID → 进程名（0.19s + 0.42s） */
function scanServices() {
  const ns = run('netstat', ['-ano'], 4000);
  if (!ns) return [];

  const ports = [];
  for (const line of ns.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    // Proto  Local Address  Foreign Address  State  PID
    const pid = Number(parts[parts.length - 1]);
    const local = parts[1] || '';
    const port = Number((local.match(/:(\d+)$/) || [])[1]);
    if (!pid || !port) continue;
    ports.push({ port, pid });
  }
  if (!ports.length) return [];

  // PID → 进程名
  const names = new Map();
  const tl = run('tasklist', ['/fo', 'csv', '/nh'], 4000);
  for (const line of tl.split(/\r?\n/)) {
    const cells = line.split('","').map((s) => s.replace(/^"|"$/g, ''));
    if (cells.length < 2) continue;
    const p = Number(cells[1]);
    if (p) names.set(p, cells[0]);
  }

  const seen = new Set();
  const out = [];
  for (const { port, pid } of ports) {
    const name = names.get(pid) || '';
    // 系统保留端口（135/139/445/496xx 等）对能力判断没意义
    if (port < 1000 || port >= 49000) continue;
    // tasklist 给的是 svchost.exe 这种带后缀的名字，锚点要允许 .exe
    if (/^(svchost|system|lsass|spoolsv|services|dwm|wininit|winlogon|smss|csrss)(\.exe)?$/i.test(name)) continue;
    const key = port + ':' + pid;
    if (seen.has(key)) continue;
    seen.add(key);
    // web：能对外发页面的端口，与 QQ/微信那种本地 RPC 端口区分开
    const isWeb =
      /node|python|nginx|httpd|apache|java|dotnet/i.test(name) ||
      [57910, 57821, 57822, 57911, 57912, 3000, 5173, 8080].includes(port);

    out.push({
      port,
      pid,
      name: name || '未知进程',
      web: isWeb,
      use: /node/i.test(name) ? '本地服务 / 网页发布'
        : /python/i.test(name) ? '本地服务'
        : /nginx|httpd|apache/i.test(name) ? 'Web 服务器'
        : ''
    });
  }
  // 网页服务排前面，其余按端口升序
  return out.sort((a, b) => Number(b.web) - Number(a.web) || a.port - b.port);
}

/* ------------------------------------------------------------ 5. 浏览器扩展 */

function scanExtensions() {
  const roots = [
    { browser: 'Chrome', dir: path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data') },
    { browser: 'Edge', dir: path.join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data') }
  ];
  const out = [];
  for (const { browser, dir } of roots) {
    if (!exists(dir)) continue;
    let profiles = [];
    try {
      profiles = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^(Default|Profile)/.test(d.name))
        .map((d) => path.join(dir, d.name, 'Extensions'));
    } catch (_) {
      continue;
    }
    for (const extRoot of profiles) {
      if (!exists(extRoot)) continue;
      let ids = [];
      try {
        ids = fs.readdirSync(extRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch (_) {
        continue;
      }
      for (const id of ids) {
        const verDir = path.join(extRoot, id.name);
        let versions = [];
        try {
          versions = fs.readdirSync(verDir, { withFileTypes: true }).filter((d) => d.isDirectory());
        } catch (_) {
          continue;
        }
        const last = versions[versions.length - 1];
        if (!last) continue;
        const mf = path.join(verDir, last.name, 'manifest.json');
        if (!exists(mf)) continue;
        let m = null;
        try {
          m = JSON.parse(fs.readFileSync(mf, 'utf8'));
        } catch (_) {
          continue;
        }
        let name = String(m.name || id.name);
        // 部分扩展用 __MSG_xxx__ 走本地化，读 _locales 太啰嗦，直接显示 ID
        if (/^__MSG_/.test(name)) name = id.name.slice(0, 8) + '…';
        out.push({
          name,
          browser,
          version: String(m.version || ''),
          use: m.description ? String(m.description).slice(0, 60) : ''
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ 6. 本套件模块 */

function scanSuite() {
  const out = [];
  let deploy = null;
  let catalog = null;
  try {
    deploy = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'config', 'deploy.json'), 'utf8'));
  } catch (_) {
    /* 配置缺失就只报目录 */
  }
  try {
    catalog = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'config', 'api-catalog.json'), 'utf8'));
  } catch (_) {
    /* 接口目录缺失不影响模块清单 */
  }

  const ports = (deploy && deploy.ports) || {};
  const apps = (deploy && deploy.apps) || ['codevault', 'eco', 'tuner', 'errvault', 'memcore'];
  const LABELS = {
    codevault: '项目索引库',
    eco: '进度与降耗看板',
    tuner: '进程降温',
    errvault: '报错库',
    memcore: '记忆库'
  };
  const catById = {};
  for (const g of (catalog && catalog.groups) || []) catById[g.id] = g;

  for (const app of apps) {
    const g = catById[app];
    out.push({
      app,
      name: LABELS[app] || app,
      port: Number(ports[app]) || null,
      apis: g ? (g.endpoints || []).length : 0,
      installed: exists(path.join(KIT_ROOT, 'apps', app))
    });
  }
  return out;
}

/* ------------------------------------------------------------ 能力映射 */

/**
 * 探测结果 → 能力块。
 *
 * 用户要的是「我会做什么」，不是「装了什么」。所以每条能力都要给出证据
 * （由哪些软件/库/服务支撑），没证据的能力不列。
 */
function buildCapabilities(probe) {
  const apps = probe.apps.join(' ');
  const cliNames = probe.cli.map((c) => c.name).join(' ');
  const pyLibs = probe.pylibs.map((p) => p.name).join(' ');
  const nodeLibs = probe.nodelibs.map((p) => p.name).join(' ');
  const ports = probe.services;

  const has = (re, hay) => re.test(hay);
  // 精确判断：/Git/ 会把 GitHub CLI 也算成 Git，导致没装 Git 也显示「版本控制」
  const cliHas = (label) => probe.cli.some((c) => c.name === label);
  const list = [];

  const add = (id, name, evidence, hint) => {
    const ev = evidence.filter(Boolean);
    if (!ev.length) return;
    list.push({ id, name, evidence: ev, hint: hint || '' });
  };

  add(
    'cad',
    'CAD 建模与出图',
    [
      has(/FreeCAD|AutoCAD|中望|浩辰|CAXA|SolidWorks|Revit|CAD快速看图|看图/i, apps) ? '已装 CAD 软件' : '',
      has(/ezdxf/i, pyLibs) ? 'ezdxf（DXF 读写）' : ''
    ],
    '可做二维图元生成、DXF 读写、批量出图'
  );

  add(
    'pdf',
    'PDF 文本与表格提取',
    [
      has(/fitz/i, pyLibs) ? 'PyMuPDF（fitz）' : '',
      has(/pdfplumber/i, pyLibs) ? 'pdfplumber（表格）' : '',
      has(/Acrobat|Foxit|福昕/i, apps) ? 'PDF 阅读器/编辑器' : '',
      has(/Ghostscript/i, cliNames) ? 'Ghostscript' : ''
    ],
    '可提取正文、表格，必要时渲染成图片再识别'
  );

  add(
    'office',
    'Office 文档生成',
    [
      has(/Office|WPS/i, apps) ? 'Office / WPS' : '',
      has(/openpyxl/i, pyLibs) ? 'openpyxl（Excel）' : '',
      has(/docx/i, pyLibs) || has(/docx/i, nodeLibs) ? 'docx（Word）' : '',
      has(/pptx/i, pyLibs) ? 'pptx（PPT）' : ''
    ],
    '可直接生成 Excel / Word / PPT，不依赖打开应用'
  );

  add(
    'web-publish',
    '本地网页发布',
    [
      ports.some((p) => /node|python/i.test(p.name)) ? '有 Node/Python 服务在监听' : '',
      Number(probe.suite.filter((s) => s.installed).length) >= 3 ? '本套件自带多个本地服务' : '',
      has(/nginx|httpd/i, probe.services.map((p) => p.name).join(' ')) ? '已装 Web 服务器' : ''
    ],
    '局域网内可直接访问，接口走 127.0.0.1'
  );

  add(
    'browser-auto',
    '浏览器自动化',
    [
      has(/playwright|agent-browser|puppeteer/i, nodeLibs) ? 'Playwright / agent-browser' : '',
      probe.extensions.length ? '已装浏览器扩展（可注入页面）' : ''
    ],
    '可做页面抓取、表单填写、截图'
  );

  add(
    'image',
    '图像与视频处理',
    [
      has(/PIL/i, pyLibs) ? 'Pillow' : '',
      has(/ImageMagick/i, cliNames) ? 'ImageMagick' : '',
      has(/FFmpeg/i, cliNames) ? 'FFmpeg' : ''
    ],
    '缩放/裁剪/格式转换/抽帧'
  );

  add(
    'data',
    '数据分析与图表',
    [
      has(/numpy/i, pyLibs) ? 'NumPy' : '',
      has(/pandas/i, pyLibs) ? 'Pandas' : '',
      has(/matplotlib/i, pyLibs) ? 'Matplotlib' : ''
    ],
    '统计汇总与可视化'
  );

  add(
    'vcs',
    '版本控制与备份',
    [
      cliHas('Git') ? 'Git' : '',
      cliHas('GitHub CLI') ? 'GitHub CLI' : ''
    ],
    '提交、打标签、发布 Release'
  );

  add(
    'pageoffice',
    'PageOffice 在线文档',
    [has(/PageOffice/i, apps) ? 'PageOffice 客户端' : ''],
    '检定系统里的证书模板依赖它'
  );

  add(
    'ai-coding',
    'AI 编程接入',
    [
      cliHas('CodeBuddy CLI') ? 'CodeBuddy CLI' : '',
      probe.suite.some((s) => s.app === 'eco' && s.installed) ? 'Eco 事件接入（/api/ingest）' : ''
    ],
    '把各平台的工具调用汇总到看板'
  );

  return list;
}

/** 汇总：一句话说明这台机器能干什么 */
function summarize(caps, probe) {
  const groups = {
    文档: ['pdf', 'office', 'pageoffice'],
    图形: ['cad', 'image'],
    开发: ['web-publish', 'browser-auto', 'data', 'vcs', 'ai-coding']
  };
  const out = {};
  for (const [label, ids] of Object.entries(groups)) {
    const got = caps.filter((c) => ids.includes(c.id)).map((c) => c.name);
    if (got.length) out[label] = got;
  }
  return {
    capabilities: caps.length,
    apps: probe.apps.length,
    cli: probe.cli.length,
    pylibs: probe.pylibs.length,
    nodelibs: probe.nodelibs.length,
    services: probe.services.length,
    extensions: probe.extensions.length,
    byArea: out
  };
}

/* ------------------------------------------------------------ 入口 */

function cacheFile() {
  return path.join(KIT_ROOT, 'memory', 'capabilities.json');
}

function readCache() {
  try {
    const raw = fs.readFileSync(cacheFile(), 'utf8');
    const j = JSON.parse(raw);
    if (!j || !j.scannedAt) return null;
    return j;
  } catch (_) {
    return null;
  }
}

function writeCache(payload) {
  try {
    const dir = path.join(KIT_ROOT, 'memory');
    if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (_) {
    /* 缓存写失败不影响返回 */
  }
}

/**
 * 扫描本机能力。
 * @param {{force?:boolean}} options force=true 时忽略缓存
 */
export function scanCapabilities(options = {}) {
  const cached = readCache();
  if (!options.force && cached && Date.now() - (cached.scannedAt || 0) < TTL_MS) {
    return { ...cached, cached: true };
  }

  const started = Date.now();
  const timings = {};

  const step = (key, fn, fallback) => {
    const t0 = Date.now();
    let v = fallback;
    try {
      v = fn();
    } catch (_) {
      v = fallback;
    }
    timings[key] = Date.now() - t0;
    return v;
  };

  const probe = {
    apps: step('apps', scanApps, []),
    cli: step('cli', scanCli, []),
    pylibs: step('pylibs', scanPythonLibs, []),
    nodelibs: step('nodelibs', scanNodeGlobals, []),
    services: step('services', scanServices, []),
    extensions: step('extensions', scanExtensions, []),
    suite: step('suite', scanSuite, [])
  };

  const caps = buildCapabilities(probe);

  // 软件按类别分组，界面上按类别折叠
  const appGroups = {};
  for (const name of probe.apps) {
    const cat = appCategory(name);
    (appGroups[cat] = appGroups[cat] || []).push(name);
  }

  const payload = {
    ok: true,
    scannedAt: Date.now(),
    tookMs: Date.now() - started,
    timings,
    summary: summarize(caps, probe),
    capabilities: caps,
    apps: appGroups,
    cli: probe.cli,
    libs: { python: probe.pylibs, node: probe.nodelibs },
    services: probe.services,
    extensions: probe.extensions,
    suite: probe.suite
  };

  writeCache(payload);
  return payload;
}

export { TTL_MS };
