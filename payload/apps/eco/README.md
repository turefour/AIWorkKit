# AIWorkKit Eco

AIWorkKit 运行时监控插件：实时采集**当前运行的插件、脚本、工具调用与可量化流程进度**，并通过一个独立的可视化窗口（本地仪表盘）呈现。

- 零第三方依赖，纯 Node 内置模块（Node ≥ 18）
- 只监听 `127.0.0.1`，不上报任何外部网络
- 采集与展示解耦：hook 与守护进程全部 fire-and-forget，故障不会阻塞工具执行

---

## 1. 架构

```
                      ┌──────────────────────────── AIWorkKit 运行时 ────────────────────────────┐
                      │                                                                          │
  Agent 轮次 / 工具调用 │  UserPromptSubmit · PreToolUse · PostToolUse · Stop                       │
                      │              │                                                           │
                      │              ▼                                                           │
                      │   hooks/eco-hook.js  ── HTTP（800ms 超时，失败落盘队列）──┐             │
                      └───────────────────────────────────────────────────────────┼─────────────┘
                                                                                  │
  脚本 / 构建 / 批处理 ── eco run -- <cmd>（自动解析 %、n/m、step i of n）───────┤
  任意程序 ──────────── POST /api/progress（ECO_JOB_ID 环境变量）───────────────┤
                                                                                  ▼
                                              ┌───────────────────────────────────────────┐
                                              │  server/eco-server.js  (127.0.0.1:57821) │
                                              │                                           │
                                              │  Store  ← 任务 / 进度 / 样本窗口            │
                                              │  procscan   进程采样（CPU / 内存 / 命令行） │
                                              │  pluginscan 插件清单（hooks/skills/cmds）  │
                                              │  Logger     文件日志 + 环形缓冲(seq 增量)   │
                                              └───────────────┬───────────────────────────┘
                                                              │ SSE /api/stream + REST
                                                              ▼
                                              ┌───────────────────────────────────────────┐
                                              │  web/  可视化窗口（仪表盘）                │
                                              │  KPI · 进度环/条 · ETA · 进程 · 插件 · 日志 │
                                              └───────────────────────────────────────────┘
```

四层采集：

| 层 | 采集对象 | 机制 | 量化能力 |
| --- | --- | --- | --- |
| Hook 层 | 会话启动、Agent 轮次、每次工具调用（Bash/Read/Edit…） | `hooks/hooks.json` → `eco-hook.js` | 时长、命令行、工具输出日志；**SessionStart 自动拉起守护进程** |
| 任务清单层 | Agent 自己的 todo / plan 工具负载 | 自动识别任意含 status 的清单数组 | **自动 current/total + 每步状态**（无需人工上报） |
| Wrapper 层 | 被 `eco run` 包装的脚本 | stdout 解析（`%`、`n/m`、`step i of n`、`@eco n/m`、ASCII 进度条） | 百分比、速率、ETA |
| 上报层 | 任意程序（Python / Node / Shell / 服务） | `POST /api/progress` 或 `eco report` | 精确 current/total/unit |
| 扫描层 | 运行中的进程、已安装插件 | PowerShell `Win32_Process` / `ps`；插件目录扫描 | CPU%、内存、插件能力、**项目归属**；短命脚本（≥2 秒）以 `script start` / `script exit` 事件留痕 |

### 1.1 归属与人工干预

- **进程归属**：从命令行里提取绝对路径，向上查找 `.git / package.json / pyproject.toml / go.mod /
  Cargo.toml / composer.json / .aiplugin`，命中的目录即项目根；`node_modules / _npx /
  .venv / site-packages / AppData` 等依赖缓存目录不算项目。没有清单文件时退回“脚本所在目录”
  （虚线标签，口径更软）。
- **插件归属**：`项目级`（位于当前工作区下）/ `市场·<marketplace>` / `用户级` / `本地`。
- **人工干预**：进程与插件行都带「卡住」「跳过」两个入口，点开后填写备注并选择替代运行方式
  （`后台静默运行 / 改用 eco run 包装 / 限时重试 / 人工接管`）；进程额外提供「终止进程」
  （必须二次确认）。决定写入 `.eco/decisions.json`，重启后仍在；每条决定同时进事件流与
  对应流程的日志，可随时「撤销标记」。

---

## 2. 安装与启动

### 2.1 作为 AIWorkKit 插件安装

```bash
aiworkkit plugin validate ./eco      # 清单校验（已通过）
aiworkkit plugin add ./eco           # 安装到本机 AIWorkKit
```

安装后，`UserPromptSubmit / PreToolUse / PostToolUse / Stop` 四个 hook 会在会话中自动上报事件，
`/eco` 命令与 `runtime-monitor` 技能同时生效。

### 2.2 不安装插件也能用

```bash
node cli/eco.js server --daemon   # 后台启动守护进程
node cli/eco.js open              # 打开独立监控窗口（无地址栏/标签栏）
node cli/eco.js open --browser    # 需要时回退到默认浏览器
node cli/eco.js status            # 终端查看概要
```

此时只有 wrapper / 上报层与扫描层工作，Hook 层需要插件安装后才生效。

### 2.3 CLI 速查

```bash
node cli/eco.js server [--port 57821] [--daemon] [--open] [--no-proc] [--cwd DIR]
node cli/eco.js open | status | stop | clear
node cli/eco.js report --id build --label "构建" --current 35 --total 120 --unit 文件
node cli/eco.js log    --id build --message "cache hit" --level info
node cli/eco.js done   --id build [--failed] [--note "原因"]
node cli/eco.js run    --label "pytest" -- <command ...>
```

---

## 3. 数据契约

### 3.1 任务对象

```json
{
  "id": "build-2026",
  "kind": "manual | script | tool | agent",
  "label": "向量库重建",
  "status": "running | done | failed | stalled | cancelled",
  "current": 68,
  "total": 120,
  "unit": "分片",
  "percent": 56.7,
  "rate": 2.31,
  "etaMs": 22511,
  "elapsedMs": 18240,
  "note": "处理 68 / 120 分片",
  "pid": null,
  "command": "",
  "sessionId": "…",
  "logs": [{ "ts": 0, "level": "info", "message": "…" }]
}
```

`percent` / `rate` / `etaMs` / `elapsedMs` / `stalled` 均由服务端派生，客户端只负责渲染。

### 3.2 HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 存活探针 |
| GET | `/api/state` | 全量快照（任务 + 进程 + 插件 + 汇总） |
| GET | `/api/stream` | SSE 实时推送（`state` 事件，1s 心跳刷新） |
| GET | `/api/logs/live?since=N` | 增量日志（自增 `seq`） |
| POST | `/api/progress` | 上报 / 更新进度（`id` 必填） |
| POST | `/api/jobs` | 创建或全量覆盖任务 |
| GET | `/api/jobs/{id}` | 单任务详情（含步骤、关联进程） |
| GET | `/api/jobs/{id}/logs?tail=N` | 该流程的完整日志（`tail=0` 取全部） |
| GET | `/api/processes/{pid}/detail` | 进程详情：源码 + 关联流程进度 + 指标 + 日志 |
| GET | `/api/jobs/{id}/detail` | 流程详情：同上（按 pid / 命令行反查脚本） |
| POST | `/api/jobs/{id}/log` | 追加任务日志 |
| POST | `/api/jobs/{id}/finish` | 结束任务（`status` / `failed`） |
| DELETE | `/api/jobs/{id}` | 移除任务 |
| POST | `/api/clear` | 清理已结束任务 |
| POST | `/api/client-error` | 前端异常上报（message / source / stack），落到 `logs/error.log` |
| POST | `/api/processes/{pid}/action` | `{action: stall\|skip\|kill, mode, note, confirm}` 处置进程 |
| DELETE | `/api/processes/{pid}/action` | 撤销该进程的标记 |
| POST | `/api/plugins/{name}/enabled` | `{enabled: true\|false}` 启用/关闭插件（写 `<平台目录>/settings.json`，自动备份） |
| POST | `/api/plugins/{name}/action` | `{action: stall\|skip, mode, note}` 处置插件（旧接口，UI 已不再使用） |
| DELETE | `/api/plugins/{name}/action` | 撤销该插件的标记 |
| POST | `/api/events` | Hook 事件入口（`eco-hook.js` 使用） |

示例：

```bash
curl -X POST http://127.0.0.1:57821/api/progress \
  -H "content-type: application/json" \
  -d '{"id":"etl","label":"订单 ETL","current":3200,"total":10000,"unit":"行"}'
```

### 3.3 自动任务进度（无需上报）

Agent 使用清单类工具（todo / plan / task list）时，其负载里天然带着任务结构。插件会自动识别并生成
一条 `kind=task` 的任务流：

- `total` = 清单条目数，`current` = 已完成条目数，`percent` 自动派生
- `label` = 当前 `in_progress`（或首个 `pending`）条目
- `steps[]` = 每条目的文本与状态，仪表盘展开即可看到勾选清单
- 清单每次变化都会在任务日志里留一行「清单更新 n/m」记录

识别规则是格式无关的：数组键名支持 `todos / todo_list / items / plan / steps / tasks / checklist / list`，
状态字段支持 `status / state / completed / done`，状态值大小写、连字符、中文别名均可；
条目若既无状态也无文本则整组丢弃，避免把普通数组误判成任务清单。

### 3.4 每个流程的完整日志

每条流程（工具调用、被包装脚本、任务、手工上报）都有独立日志：

- 磁盘：`.eco/jobs/<safe-id>.log`（按 4MB 上限滚动，保留后一半）
- 接口：`GET /api/jobs/{id}/logs?tail=200`（`tail=0` 取全部）
- 终端：`node cli/eco.js logs --id <id> --tail 100 --follow`
- 仪表盘：点击任务卡片展开 → 步骤清单 + 完整日志（1.8s 自动跟随）

### 3.5 进度标记（stdout）

`eco run` 会从子进程输出中识别：

| 形式 | 示例 |
| --- | --- |
| 显式标记 | `@eco 12/50 解析源文件` |
| 百分比 | `Downloading 45.3%` |
| 分数 | `3/10 tasks` |
| 步骤措辞 | `step 4 of 12`、`第 4 步/共 12 步` |
| ASCII 进度条 | `[#####-------]` |

---

## 4. 可视化窗口

`eco open` 打开的是**独立窗口**：Chromium 的 `--app` 模式 + 专属 profile（`.eco/window-profile`），
没有地址栏、标签栏、书签栏，任务栏独立成组；再次 `open` 只会把已有窗口前置，不会重复开窗。
页面地址仍是 `http://127.0.0.1:57821/`，UI 与浏览器模式完全一致（同一份前端资源）。
想固定到桌面/开始菜单：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
```

窗口内包含：

- **数据源状态**：`Hook 采集 / 脚本包装 / 进度上报 / 进程扫描` 四个指示灯 + 最近事件时间，
  让“确实没有任务”和“采集通道没接上”一眼可分；Hook 未接入时顶部会出现提示条，
  直接给出重载窗口与 `eco task` 两条出路
- **KPI 条**：运行中任务、整体进度、脚本进程数、CPU、内存、插件数
- **活动流程**：进度环 + 进度条 + 当前/总量 + 速率 + 剩余时间 + 已用时间 + 任务日志尾行；无总量时显示流动条（不确定进度）；
  **点击卡片展开**：步骤清单（✓/◐/○）、会话/PID/CPU/内存/起止时间、完整运行日志（自动跟随、可手动刷新）
- **运行中的脚本**：进程名 + **所属项目标签**（悬停显示项目根）、命令行、CPU%、内存，按 CPU 排序；
  悬停出现「卡住 / 跳过」，点开处置面板填写备注并选择替代运行方式，已处置的行带徽标与撤销入口
- **点击进程行 / 流程卡的「源码」按钮 → 详情窗口**：上半部是该进程入口脚本的源码（带行号、可滚动，
  自动识别 js/ts/py/ps1/sh/bat… 语言），下半部是进度条与百分比、current/total、速率、ETA、已用时间、
  CPU/内存/运行时长/会话/命令行，以及该流程的日志尾（每 2s 刷新；源码仅在文件 mtime 变化时重载）
- **插件**：名称/版本/**归属标签**（项目级 / 市场 / 用户级）/能力标签（hooks、skills、commands、agents），
  绿点表示注入了 hook；右侧按钮为**「启用 / 关闭」**——直接改写 `<平台目录>/settings.json`
  的 `enabledPlugins`（写入前自动备份 `*.bak_eco_<ts>`），已关闭的插件整行变暗并显示「已关闭」，
  重载窗口后真正生效。KPI 显示「启用数 / 已安装总数」
- **实时事件流**：每条事件都带**生命周期阶段徽标**（`▶ 开始` / `✓ 完成` / `✕ 报错` / `• 信息`）、
  场景、目标（工具名 · 命令）与耗时；`seq` 增量、级别过滤、自动滚动、EPIPE 安全。
  阶段与耗时来自 `/api/logs/live` 的 `phase` / `durationMs` / `target` 字段，
  失败事件额外携带 `meta.detail`（悬停可看完整错误）
- **紧凑视图**：一键切换密度，适合侧边常驻小窗

---

## 5. 配置

| 项 | 方式 | 默认 |
| --- | --- | --- |
| 端口 | `AIWORKKIT_ECO_PORT` / `--port` / `.eco/config.json` | `57821` |
| 监听地址 | 固定 | `127.0.0.1`（不对外） |
| 进程采样间隔 | `--interval <ms>` | `3000` |
| 关闭进程采样 | `--no-proc` | 开启 |
| 已完成流程自动清除 | `ECO_DONE_TTL_MS` | `30000`（30 秒；`0` 表示下一个清理周期即清，≤4 秒） |
| 失败流程自动清除 | `ECO_FAILED_TTL_MS` | `90000`（90 秒） |
| 内存日志环形缓冲 | `logger.RING_LIMIT` | 500 条 |

运行时文件：

```
.eco/config.json      端口与 pid（供 CLI / hook 发现）
.eco/state.json       任务快照（重启后恢复，运行中任务标记为 stalled）
.eco/hook-queue.jsonl 守护进程未启动时缓存的 hook 事件（下次启动回放）
.eco/jobs/<id>.log     每条流程的完整输出日志（4MB 滚动）
.eco/decisions.json    人工干预记录（卡住/跳过/终止 + 替代方式 + 备注），重启后保留
logs/server.log         运行时间线
logs/error.log          错误 + 堆栈
```

---

## 6. 故障排查（先读日志）

```powershell
Get-Content .\logs\error.log -Tail 40
Get-Content .\logs\server.log -Tail 40
Invoke-RestMethod http://127.0.0.1:57821/api/health
Get-Content .\.eco\hook-queue.jsonl -Tail 5   # hook 是否在排队
```

| 现象 | 排查顺序 |
| --- | --- |
| 仪表盘空白/连接中 | `/api/health` → `logs/server.log` 是否有 `listening` → 端口占用 |
| 任务不出现 | `eco-hook.js` 是否可执行（`node -v`）→ `.eco/hook-queue.jsonl` 是否堆积 → 插件是否 enabled |
| 脚本进程列为空 | `--no-proc` 是否误开 → `logs/error.log` 的 `procscan` → PowerShell 执行策略 |
| 进度不动 | 任务是否被标记 `stalled`（>90s 无更新）→ 是否漏发 `done` |

---

## 7. 设计取舍与限制

- **窗口用独立应用窗口而非 IDE 面板**：AIWorkKit 插件（hooks/skills/commands）没有 UI 扩展点。
  实现采用系统自带 Chromium 的 `--app` 模式 + 专属 profile：零依赖、无地址栏/标签栏、
  任务栏独立，页面仍是同一份 `web/` 资源，因此与浏览器模式内容完全一致。
  它复用系统浏览器内核（不是自绘 UI 框架），换取"免安装、免下载、不占额外内存"。
  若后续要内嵌到 IDE，可直接复用 `web/` 与 `/api/stream`，服务端无需改动。
- **hook 绝不阻塞**：800ms 硬超时 + 磁盘队列回放；hook 永远 `exit 0`、stdout 为空。
- **进度只信真实计数**：服务端不做推测，缺少 `total` 时显示不确定进度条而不是假百分比。
- **进程采样的平台差异**：Windows 用 `Win32_Process`（含命令行、PPID、内核/用户态 tick），
  其他平台回退 `ps`；CPU% 由两次采样的 tick 差推导，因此首次采样的一轮显示为空属正常。
- **插件“活跃”的判定**：以插件目录/清单文件的最近修改时间与 hook 注入能力作为近似信号
  （插件运行在 AIWorkKit 进程内，无法从外部直接读取其调用计数）。

---

## 8. 已验证

`node test/smoke.js` 覆盖 16 项并全部通过：健康探针、静态资源、进度上报与派生字段（percent / rate / ETA）、
SSE 快照、Hook 前置/后置事件配对、wrapper 自动量化、**自动任务进度（1/3 + 3 条步骤）**、
**单流程日志端点**、日志增量游标、清理接口。

`Desktop/handdelete/eco_intervention_test.js` 覆盖 19 项并全部通过：项目归属（项目清单命中 / 目录级兜底）、
卡住与撤销、跳过并记录替代方式、非法 mode 拒绝、kill 缺少 confirm 拒绝、kill 后进程确实消失、
插件卡住/跳过/撤销。另有 `Desktop/handdelete/eco_auto_task_test.js` 做更细的自动进度链路验证：
清单 1/4 → 2/4 → 4/4、label 跟随 `in_progress` 项、工具 stdout 落盘可查、任务日志留痕。
`aiworkkit plugin validate` 与 `aiworkkit plugin add --yes` 均通过（插件已安装并启用）。

## 9. 正式接入（IDE）

### 9.1 启动 AIWorkKit 即自动启动监控

`hooks/hooks.json` 注册了 `SessionStart`，每次会话启动都会执行：

```
node "${AIWORKKIT_PLUGIN_ROOT}/hooks/eco-hook.js" SessionStart
```

- 守护进程在跑 → 事件直接入库，日志出现 `session start`
- 守护进程没跑 → hook 以 `detached` 方式拉起 `cli/eco.js server --daemon`，
  每 300ms 重试投递（最多 4 次），成功或超时后一律 `exit 0`；
  仍失败则写入 `.eco/hook-queue.jsonl`，守护进程下次启动时回放
- 该事件只记一条 `session start` 日志（含 sessionId / client / cwd），不生成任务卡

配套规则（始终生效）：`<平台目录>/rules/eco-first.mdc` —— 第 0 步说明"启动即自动"，
第 1 步保留任务开始时的幂等兜底（`server --daemon` 已运行会跳过），
第 3 步要求用 `eco task` 上报步骤清单。

> `SessionStart` 属于插件 hooks 配置，**新增后需重载窗口**才会被重新加载；
> 重载后的每一次 AIWorkKit 启动都会自动拉起监控，无需再手动执行任何命令。

### 9.2 插件加载时机

IDE 的插件与 hooks 在**扩展宿主激活时**聚合加载一次（日志 `[plugin-manager] Loaded N hooks ... from M plugin(s)`），
因此安装/注册插件后需要重载窗口才会接管新的 hook：

1. 注册本地市场（已执行，产物在 `<平台目录>/plugins/marketplaces/eco-market`，
   `plugins/eco` 是指向本仓库的目录联接，`settings.json` 里
   `enabledPlugins["eco@eco-market"] = true`，三份注册文件均已备份为 `*.bak_eco_*`）
2. 重载窗口：`Ctrl+Shift+P` → `Developer: Reload Window`
3. 重载后顶部 `Hook 采集` 指示灯变绿，随后每次工具调用都会出现在「活动流程」里

一键重启守护进程 + 打开窗口：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\activate.ps1
```

排查接入是否成功，看 IDE 扩展日志（`%APPDATA%\AIWorkKit CN\logs\<ts>\window*\exthost\...\*.log`）
里的 `Loaded N hooks`：`N` 从 0 变为 4 即接入成功。

**实测结论（2026-10-29）**：运行期修改 `enabledPlugins`（包括写入用户级 `settings.json` 的 `hooks`
字段）都不会改变 IDE 的插件聚合数量，日志始终是 `Loaded 0 hooks ... from 9 plugin(s)`。
即插件集合在扩展宿主激活时确定，重载窗口是唯一生效路径；重载一次后长期有效（注册已持久化）。

未重载期间的兜底：`eco task` 上报任务清单 + `eco run` 包装脚本，两者都不依赖 hook。

## 10. 分发（便携安装包）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-package.ps1
```

产物落在桌面：

```
Desktop\AIWorkKit-Eco-portable\        可直接运行
  eco\     插件本体（已剔除 .eco / logs / *.bak_*）
  install.cmd          双击安装（内部走 -ExecutionPolicy Bypass）
  install.ps1          一键安装：复制插件 → 注册市场 → 写 rule → 起守护进程
  uninstall.ps1        一键卸载（-Purge 连目录一起删）
  rules\eco-first.mdc.template   安装时替换 {{PLUGIN_ROOT}} 为本机真实路径
  README-安装说明.txt
  SHA256SUMS.txt
Desktop\AIWorkKit-Eco-portable.zip     同内容压缩包（约 100 KB）
```

安装脚本要点：

- 所有被改写的 `settings.json / known_marketplaces.json / installed_plugins.json` 与规则文件
  都会先备份为 `*.bak_eco_<时间戳>`，可回滚
- 自动清理旧的 `eco@local-*` 注册，避免重复 hook
- JSON 与规则文件统一用 **无 BOM UTF-8** 写入（BOM 会让 `JSON.parse` 直接失败）
- `-DryRun` 只打印动作；`-Link` 用目录联接指向包内目录，便于随包更新；`-NoStart` 跳过启动
- 安装器同时适配"包根"与"插件仓库内 `package/`"两种位置

## 11. 生效范围说明

- **Hook 自动采集**在应用插件后对**新会话**生效（插件在会话启动时注册 hooks）。当前已开启的会话里，
  仪表盘的数据源指示器会显示 `Hook 采集 未接入`，此时自动能力来自进程扫描 + 脚本包装 + 进度上报。
- 因此长任务推荐用 `eco run -- <cmd>` 包装，或在流程内发一次 `POST /api/progress`；
  两者都会立即出现在窗口中，不依赖会话重启。
