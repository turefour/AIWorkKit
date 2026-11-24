---
description: 查看 AIWorkKit 各进程的内存 / CPU 占用，并给出降温（回收内存、降优先级、挂起后台）的可执行选项
allowed-tools: ["Bash", "Read"]
---

# AIWorkKit 空闲降温器 · 占用总览

## 执行步骤

1. 读取当前占用：

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" status
```

2. 把输出整理成简洁摘要回复用户，必须包含：
   - 进程总数、工作集合计、私有提交、CPU 合计
   - 角色分布（渲染进程 / 扩展宿主 / TS 服务 / 主进程）
   - 占用前 5 的进程（PID、角色、工作集、优先级）
   - 当前是否已降温（优先级是否已降到 BelowNormal / Idle）、是否自动降温

3. 根据状态给用户 1~2 句建议：
   - 工作集 > 2 GB 且 CPU < 5%：建议「一键降温」（回收内存 + 降优先级）
   - 需要长时间挂着不做事：建议挂起后台子进程（提醒必须靠托盘恢复）
   - 优先级已经是 BelowNormal/Idle：说明已经降过，无需重复

## 可选动作（用户确认后再执行）

- 一键降温：`node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" apply --mode lite`
- 深度降温：`node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" apply --mode deep`
- 恢复：`node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" restore`
- 托盘：`node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" tray`

## 说明

- 所有动作只调整资源占用，**不会关闭 AIWorkKit**。
- 回收内存是把工作集还给系统，页面在下次访问时自动换回，不会丢数据。
- 已挂起进程的唤醒请走托盘（`/tuner-tray`），因为挂起的进程无法执行命令。
