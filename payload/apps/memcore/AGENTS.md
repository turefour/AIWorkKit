# 改 memcore 前必读

## 数据位置（改错了会丢记忆）

- 记忆归档在 `<套件根>\memory\`，**不在本目录**。`lib\paths.mjs` 是唯一解析点，
  不要在别处拼 `data\` 路径，也不要把 `store.json` 挪进 `apps\`（重新部署会覆盖）。
- `store.json` 是唯一真相源；`MEMORY.md`、`memcore.mdc` 都是产物，可随时重建。
- 条目写入必须走 `lib\store.mjs` 的 `upsertNote`（它负责校验、去重、计数、审计镜像），
  不要直接 push 数组。

## 条目纪律

- `text` ≤200 字；超了用 `pointer` 指向文件，不要放宽上限（会撑爆常驻预算）。
- 助手输出不入库；密钥、token、个人隐私不入库。
- 报错与解法归 errvault，memcore 只留一句结论 + 指针。

## 兼容性约束

- 端口从 `--port` / env / 57912 三级解析；`launch.mjs` / `stop.mjs` / `health-check.ps1`
  都有 `|| 57912` 兜底，改动时三处一起对齐。
- `/api/health` 必须返回 `{ ok: true, app: 'memcore', port }`：
  启停脚本靠 `app` 字段判断端口上跑的是不是本套件的服务。
- 写请求一律走 `_shared\httpserver.mjs` 的守卫（回环 + 同源 + `application/json`），
  不要绕过。
- 运行时是随包 Node 24：可用 `node:sqlite`、`fetch`、`AbortSignal.timeout`，不要引第三方包。

## 版本与文档

- 新增能力 → `build\bump-version.ps1 -Kind minor` + CHANGELOG（目标机可见的变化）。
- 改协议 / 路径 / 端口 → 同步更新 `payload\docs\记忆库说明.md`、
  `payload\rules\deploy-target.mdc` §2.2、`apps\codevault\assets\app.js` 的 `EMBEDS`。
