---
description: 一键降低 AIWorkKit 资源占用（回收内存工作集 + 降低 CPU 优先级 + EcoQoS），不关闭软件
allowed-tools: ["Bash"]
---

# 一键降温

## 执行步骤

1. 执行轻度降温（默认，推荐）：

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" apply --mode lite
```

用户明确要求「更省 / 深度降温」时改用：

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" apply --mode deep
```

2. 回复用户必须包含：
   - 释放内存（立即值 + 2 秒稳定后的实际值）
   - 工作集 before → after
   - 优先级结果与设置成功的进程数
   - 一句提醒：接下来第一次操作会略慢，属正常换页

## 说明

- `lite` = 工作集回收 + BelowNormal 优先级 + EcoQoS
- `deep` = 工作集回收 + Idle 优先级 + EcoQoS（空闲时几乎不抢 CPU）
- 只调整占用，不会结束任何进程；随时可用 `/tuner-restore` 还原。
