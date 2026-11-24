---
description: 恢复 AIWorkKit 的正常占用：唤醒所有被挂起的子进程、把 CPU 优先级还原为 Normal、关闭 EcoQoS
allowed-tools: ["Bash"]
---

# 恢复占用

## 执行

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" restore
```

## 回复要求

- 唤醒的进程数量与 PID
- 是否有恢复失败（失败通常是进程已退出，属正常）
- 当前工作集合计

## 若命令无响应

说明本次请求所在的进程树已被挂起：请让用户点任务栏托盘图标 →「恢复全部」，
或在任意外部 PowerShell 里执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>\core\tuner.ps1" -Action restore
```
