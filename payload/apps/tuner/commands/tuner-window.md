---
description: 打开 AIWorkKit 空闲降温器的独立窗口（占用仪表盘，可一键降温 / 降优先级 / 挂起 / 恢复）
allowed-tools: ["Bash"]
---

# 打开独立窗口

## 执行

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/tuner.js" open
```

该命令会：

1. 若本地仪表盘服务未运行，先以隐藏进程拉起（`127.0.0.1:47822`，端口可用
   `AIWORKKIT_TUNER_PORT` 覆盖）
2. 用 Chromium `--app` 模式打开无地址栏独立窗口（Edge / Chrome，自带独立
   user-data-dir，任务栏独立图标）
3. 窗口已存在时只前置，不重复开窗

## 回复要求

- 告知窗口已打开与访问地址
- 若回落到默认浏览器，说明未找到 Edge / Chrome 的 `--app` 支持

## 关闭方式

直接关闭窗口即可；本地服务会在后台保留（下次秒开），不影响 AIWorkKit。
