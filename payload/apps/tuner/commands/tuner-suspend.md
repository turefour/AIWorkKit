---
description: 挂起 AIWorkKit 的后台子进程（扩展宿主 / TS 服务 / 脚本子进程），把 CPU 与内存压到接近 0，随时可从托盘唤醒
allowed-tools: ["Bash"]
---

# 挂起后台子进程

> 高风险动作。挂起后这些子进程无法响应，**必须通过托盘或外部终端恢复**，
> 因为挂起的进程不再执行任何命令。

## 执行前

1. 先确认当前没有任务在跑（用户是空闲状态）。
2. 先启动托盘，保证有恢复通道：

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" tray
```

## 执行

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" apply --mode suspend --level background --auto-resume 30
```

- `--level background`（默认）：挂起扩展宿主、TS 服务、脚本子进程；主进程 / 渲染进程 / GPU 进程不动，窗口仍可正常显示
- `--level aggressive`：连渲染进程一起挂起，**窗口会假死**，只能在托盘里恢复
- `--auto-resume 30`：30 分钟后自动唤醒，防止忘记恢复（可省略）

## 恢复

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" restore
```

若本次会话已无响应，请用任务栏托盘图标 →「恢复全部」。

## 回复要求

- 说明挂起了多少个进程、哪些角色
- 明确告诉用户恢复方式（托盘 / `restore` 命令）与定时恢复时间
