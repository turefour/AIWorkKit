# memcore · 工作套件统一任务记忆

把所有任务的记忆（用户习惯 / 任务方向 / 决策 / 约束 / 收尾摘要）收敛到
`<套件根>\memory\`，并生成两份产物：

| 产物 | 用途 | 预算 |
|---|---|---|
| `memory\MEMORY.md` | 完整记忆，按需读取 | 6 KB |
| `memory\memcore.mdc` | 常驻规则，每会话自动注入 | 1.2 KB |

## 为什么不在 apps\ 里存数据

`payload\tools\deploy.ps1` 会整体覆盖 `apps\*`（errvault 曾因此丢过索引）。
`memory\` 位于目标目录根部，升级只换代码、不动记忆。

## 快速使用

```powershell
node tools\memcore.mjs                 # 同步对话 + 重建记忆
node tools\memcore.mjs show            # 完整记忆
node tools\memcore.mjs search 关键词    # 条目 / 指令 / 会话标题一起搜
node tools\memcore.mjs note add --type constraint --scope machine --text "..."
node tools\memcore.mjs install         # 写 ~\.codebuddy\rules\memcore.mdc
node tools\memcore.mjs stats           # 体积、条数、数据源状态
```

页面：`http://127.0.0.1:57912/`（索引库侧栏「记忆库 · memcore」内嵌同一页）。

完整规范见 `docs\记忆库说明.md`：条目字段、类型判定、读写流程、验证清单。

## 端口与启动

- 端口：`57912`（`config\deploy.json` 的 `ports.memcore`，缺键时兜底 57912）
- 启动：`node tools\launch.mjs memcore`，停止：`node tools\stop.mjs memcore`
- 健康：`GET /api/health` → `{ ok: true, app: "memcore", port: 57912 }`

## 依赖

零第三方依赖。会话索引读取用 Node 24 内置的 `node:sqlite`；
平台数据目录可用 `CODEBUDDY_INFO` 覆盖，读不到只降级（不抛错）。
