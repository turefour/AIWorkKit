# CodeVault · 本地工程索引库

把本机 `C:\Users\GH\AIWorkKit` 下的全部会话项目整理成可浏览的索引：
任务列表 → 分区与功能 → 真实源码 → 构建逻辑 → 修改记录 → 问题清单。

## 打开方式

双击 `start.cmd`（推荐，会启动本地服务并打开浏览器），或：

```powershell
node tools/serve.mjs --open
```

服务只监听 `127.0.0.1:47910`，仅接受 GET。直接双击 `index.html` 会因为
`file://` 的同源策略读不到 `data/projects.json`。

## 目录结构

```
CodeVault/
  index.html            单页应用外壳
  assets/style.css      暗色主题样式
  assets/app.js         列表 / 详情渲染、代码高亮、搜索筛选
  data/projects.json    索引数据（人工维护字段 + 扫描字段）
  tools/serve.mjs       本地只读服务：静态资源 + /api/file 读源码
  tools/scan.mjs        重新测量各项目规模并回写 projects.json
  start.cmd             一键启动
```

## 数据模型（data/projects.json）

| 字段 | 来源 | 说明 |
|---|---|---|
| `summary` / `kind` / `stack` | 人工 | 项目定位与技术栈 |
| `build[]` | 人工 | 构建逻辑，按执行顺序排列 |
| `sections[]` | 人工 | 分区（模块）与其文件职责 |
| `code[]` | 人工 | 关键代码片段 + 说明，可点开看完整文件 |
| `changelog[]` | 人工 | 版本 / 日期 / 改动条目 |
| `issues[]` | 人工 | P0–P3 问题与修复状态 |
| `scale.files` / `scale.bytes` | 扫描 | 由 `scan.mjs` 覆盖 |
| `lastModified` | 扫描 | 由 `scan.mjs` 覆盖 |

人工字段不会被 `scan.mjs` 改动，只更新 `scale` / `lastModified` / `generatedAt`。

## 后续任务如何调用（写入全局规则）

改完任何项目后，追加一条记录并刷新索引：

```powershell
# 1. 追加修改记录到对应项目的 changelog（人工或脚本）
# 2. 刷新规模数据
node "C:\Users\GH\Desktop\CodeVault\tools\scan.mjs"

# 3. 提交代码库快照（工作区根已 git init）
cd C:\Users\GH\AIWorkKit\20261029081733
git add -A
git commit -m "chore: 描述"
```

预览模式（只看不写）：`node tools/scan.mjs --dry`

## 安全边界

- `/api/file` 只允许读取 `C:\Users\GH\AIWorkKit` 与 `C:\Users\GH\Desktop` 下的真实路径
- 单文件上限 512 KB，只允许文本类扩展名
- 服务仅监听回环地址，且拒绝非 GET 请求

## 内嵌实时面板

侧栏固定两个入口，直接在同一页面内嵌插件自带看板（整高 iframe）：

| 入口 | 对应插件 | 端口 | 内容 |
|---|---|---|---|
| 实时看板 · Eco | `eco` | 47821 | 运行中任务、工具调用、进度、人工处置 |
| 降温面板 · Tuner | `tuner` | 47822 | 内存占用、工作集回收、优先级、挂起/恢复 |

- 服务离线时显示「启动服务」按钮，由 `POST /api/launch` 拉起本地进程
- 该接口只接受同源 JSON 请求，且仅有 `eco` / `tuner` 两个白名单应用
- 探测接口：`GET /api/services` 返回两者的 `ok / pid / port`
- 新增插件面板需同时登记 `tools/serve.mjs` 的 `APPS` 与 `assets/app.js` 的 `EMBEDS`

## 版本库分布

| 仓库根 | 覆盖范围 |
|---|---|
| `C:\Users\GH\AIWorkKit\20261029081733` | 6 个可运行子工程（eco / tuner / bridge / iso-td / attendance / cal_hood） |
| `C:\Users\GH\AIWorkKit\20260807162637` | 规程 PDF 库治理脚本 |
| `C:\Users\GH\AIWorkKit\20261012151723` | QQ 塔罗机器人 |
| `C:\Users\GH\Desktop\CodeVault` | 索引站点与工具 |
| `C:\Users\GH\Desktop\ScriptVault` | 脚本主库（lib / tools / tests + 分类索引） |
| `C:\Users\GH\Desktop\handdelete` | 历史脚本归档（约 1021 个，只做快照） |

git 为便携版：`C:\Users\GH\AIWorkKit\20261029081733\.tools\mingit\cmd\git.exe`（不在系统 PATH）。

## 脚本库（分类索引）

侧栏「工具脚本库」读取 `C:\Users\GH\Desktop\ScriptVault\index.json`：

| 分区 | 内容 | 数量 |
|---|---|---|
| `lib/` | 公共模块（cli / fsx / log / cdp / repo） | 5 |
| `tools/` | 可复用工具（shot / git-report / scaffold） | 3 |
| `tests/` | `node --test` 用例 | 2 |
| 归档 | `handdelete` 历史脚本 | 1021 |

- 分类来自脚本头部 `@category`，页面用 chips 按分类筛选，可再叠加文本搜索
- 刷新索引：`node C:\Users\GH\Desktop\ScriptVault\build-index.mjs`
- 新增工具：`node tools/scaffold.mjs <name> --purpose "..." --category web`

## 已知限制

- 代码高亮是内置的极简 tokenizer，只处理注释 / 字符串 / 关键字
- `projects.json` 的叙述性内容需要人工维护，扫描器不生成
