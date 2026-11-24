# CodeVault · 本地工程索引库

把本机所有项目的「构建逻辑 / 分区职责 / 已知问题」做成一个可浏览的页面。

---

## 目录地图

```
tools/serve.mjs     HTTP 服务（默认 47910）：路由 + 静态资源 + JSON 接口
tools/scan.mjs      项目扫描器：写 data/projects.json
assets/app.js       前端（无构建、无框架，原生 DOM）
assets/styles.css   样式
index.html          单页外壳
data/projects.json  ⚠️ 项目数据的唯一真相源（手工编辑要谨慎，通常由 scan + adopt-project 维护）
start.cmd           启动入口
```

## 三条命令

```powershell
node tools\serve.mjs        # 起服务（默认 127.0.0.1:47910）
node tools\scan.mjs         # 重新扫描项目，刷新 data/projects.json
node tools\git-report.mjs   # 仓库状态（实际脚本在 ScriptVault）
```

## 数据来源（改之前先搞清）

| 数据 | 来源 |
|---|---|
| 项目卡片（名称/类型/概要/构建逻辑/分区/问题） | `data/projects.json` |
| 仓库状态（分支/提交/未提交数） | `ScriptVault/config/repos.json` + 实时 git 查询 |
| 脚本库（模块/工具/Python/测试） | `ScriptVault/index.json` |

**新增项目不要手改两个文件** —— 用 `node ScriptVault/tools/adopt-project.mjs "<目录>" --name <简称>`，
它会同时更新 `projects.json`、`repos.json` 和 `.gitignore`。

## 接口

| 接口 | 返回 |
|---|---|
| `GET /api/health` | 存活 |
| `GET /api/projects` | `{ ok, data: { generatedAt, projects } }` |
| `GET /api/repos` | `{ ok, git, repos }` |
| `GET /api/scripts` | `{ ok, vault: { summary, categories, entries }, archive }` |

## 陷阱

1. **`data/projects.json` 是 UTF-8 无 BOM**。用 PowerShell 写会带 BOM，前端 `fetch().json()` 直接失败。
2. **别把本机私有数据打进分发包**。`AIWorkKit` 打包时会把这个文件清空成 `{ projects: [] }`，
   否则目标机上的索引页会显示一堆打不开的项目，还泄露目录结构。
3. **`assets/app.js` 没有构建步骤**，改完直接刷新页面即可；不要引入打包工具。
4. **端口由 `CODEVAULT_PORT` / `CODEVAULT_HOST` 环境变量控制**，部署包里由 `config/deploy.json` 注入。

## 与部署包的关系

`AIWorkKit/payload/apps/codevault` 是复制品。改这里，然后重新打包。
