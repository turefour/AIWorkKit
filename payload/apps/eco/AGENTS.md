# AIWorkKit Eco · 运行时看板

把 AIWorkKit 的工具调用与任务进度变成可观测数据：hook 采集 → 本地 HTTP/SSE 服务 → 仪表盘。

---

## 目录地图

```
hooks/eco-hook.js      IDE hook 入口。读 stdin 的 JSON，POST 到 /api/events（800ms 超时，失败落 hook-queue.jsonl）
server/eco-server.js   唯一进程：路由 + SSE + 静态资源 + 写接口守卫
server/lib/
  dupguard.js            重复测试进程守护（阈值 4 告警 / 6 锁死 / 自动清理）
  processscan.js         进程表扫描（3.5s 一轮），识别测试进程
  store.js               任务状态存储
  joblog.js              任务日志
  decisions.js           决策记录
web/                     看板前端（无构建、无框架、原生 DOM）
cli/eco.js             命令行：server / status / run / report / done / task / open
scripts/                 运维脚本（smoke.js 等，**不要放 test/**）
test/                    单元测试（node --test 自动发现）
package/                 插件分发包模板
```

## 三条命令

```powershell
node cli\eco.js server --daemon    # 起服务（默认 57821）
node --test                           # 跑单元测试
node cli\eco.js status              # 看当前状态
```

## 关键接口

| 接口 | 用途 |
|---|---|
| `GET /api/state` | 全量快照（jobs / processes / guard / usage / sources） |
| `GET /api/stream` | SSE 增量推送 |
| `GET /api/guard` | 重复进程状态与告警列表 |
| `POST /api/guard/action` | `{action:"clean"\|"unlock", key?}` |
| `POST /api/events` | hook 事件入口（同时累计用量统计） |
| `GET /api/health` | 存活探测 |

## 重复进程守护（本项目的独有能力）

判定逻辑（`server/lib/dupguard.js`）：

| 条件 | 动作 |
|---|---|
| 同项目同脚本 ≥4 个，且**连续两轮采样** | 告警（warn） |
| 告警后又多一个，或一次到 6 个 | 锁死（lock）+ 清理，保留最早启动的 1 个 |
| 锁死期间仍有新增 | 每轮继续清理 |
| 数量降到 4 以下 | 自动解除告警 |

清理前必须核对命令行（`readProcessCommand`），PID 可能被系统复用 —— **不要**去掉这层校验。

`--test` 和别的东西的区别靠正则识别，不要用 `command.includes('test')`，会把 `--test-timeout` 也算进去。

## 用量统计的边界

AIWorkKit **没有**把 token 用量写进任何可读文件（`projects/*.jsonl` 无 usage，`local_storage` 是 gzip+base64）。

所以 `usage.estTokens` 是**估算**：`事件序列化字节数 / 3.8`。字段名前缀 `est` 就是标记。
要精确值必须让 CLI 侧把 `usage` 写进 hook 事件 —— 在 `usageStats` 累加处加一个分支即可。

## 陷阱

1. **`scripts/` 与 `test/` 要分开放**。`node --test` 会跑 `test/` 下所有文件，需要真实 daemon 的冒烟脚本放进去会让 `npm test` 永远红。
2. **`usageStats` 必须定义在模块顶层**。放在 `snapshot()` 附近会因为 TDZ 或作用域问题取不到，表现为统计恒为 0。
3. **改 `eco-server.js` 用锚点替换，不要按行号删**。删行很容易连函数边界一起删掉，`node --check` 查不出这种作用域错误。
4. **hook 必须永远 exit 0**。它跑在 IDE 的调用链上，抛错会拖慢甚至中断会话。
5. **进程扫描是 3.5s 一轮**，守护逻辑挂在 `onSample` 上，所以判定有延迟 —— 这是刻意的防抖，不要改成逐事件判定。

## 与部署包的关系

`AIWorkKit/payload/apps/eco` 是**复制品**。改这里，然后重新打包。
