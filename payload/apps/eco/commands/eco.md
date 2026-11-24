---
description: 打开 AIWorkKit Eco 运行时监控窗口，展示当前运行的插件、脚本与可量化流程进度
allowed-tools: ["Bash", "Read"]
---

# AIWorkKit Eco · 运行时监控

## 执行步骤

1. 确认守护进程可用（不存在则自动拉起）：

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/eco.js" status
```

2. 若返回 `daemon not running`，先启动：

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/eco.js" server --daemon
```

3. 打开独立监控窗口（`--app` 模式，无地址栏；已在运行时只会前置，不重复开窗）：

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/eco.js" open
```

4. 把 `status` 的文本输出整理成简洁摘要回复用户，包含：
   - 运行中任务数与整体进度
   - 当前脚本进程数、CPU / 内存
   - 已加载插件数（含注入 hook 的插件数）
   - 仪表盘访问地址

## 说明

- 端口默认 `47821`，可用环境变量 `AIWORKKIT_ECO_PORT` 覆盖。
- 该命令只读展示，不会终止任何正在运行的任务。
- 需要为某条流程补充进度时使用：`eco report --id <id> --current N --total M`。
