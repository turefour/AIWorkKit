# AIWorkKit Idle Tuner · 内存降温

回收工作集、挂起空闲进程、提供托盘与面板。

---

## 目录地图

```
core/tuner-core.ps1     全部业务逻辑（进程枚举、trim、挂起、状态）
core/tuner.ps1          入口（被 cli 与 hook 调用）
server/tuner-server.js  面板 HTTP 服务（默认 57822）
cli/tuner.js            命令行：status / trim / apply / quiet / restore / auto / tray
hooks/tuner-hook.js     IDE hook 入口
tray/tray.ps1           托盘
web/                    面板前端
package/                插件分发包模板
```

## 三条命令

```powershell
node cli\tuner.js status              # 看内存与进程
node cli\tuner.js trim                # 只清工作集
powershell -File core\tuner.ps1 -Action trim -SystemCache   # 连带清系统缓存（需管理员）
```

## 两层清理的区别（重要）

| 层级 | API | 回收什么 | 权限 |
|---|---|---|---|
| 工作集 | `EmptyWorkingSet` / `SetProcessWorkingSetSize` | 各进程正在用的页 | 普通用户 |
| **系统缓存** | `NtSetSystemInformation`(0x50) | 待机页表 / 低优先待机 / 已修改页表 | **管理员** |

实测差距：只清工作集回收几百 MB；带 `-SystemCache` 时待机页可从 428 MB 降到 41 MB。

命令值（`winnt.h` 的 `MEMORY_LIST_COMMAND`）：`3=FlushModifiedList`、`4=PurgeStandbyList`、`5=PurgeLowPriorityStandbyList`。

无管理员权限时这些调用静默失败，只退化为工作集清理 —— 这是设计如此，不是 bug。

## 陷阱

1. **`--port` 必须真的被应用**。`parseArgs()` 曾定义了却从未调用，导致部署后死抢默认 57822 端口。改参数解析时确认它在加载时被调用了。
2. **`TOKEN_PRIVILEGES` 的 LUID 不能用 `long`**。CLR 会按 8 字节对齐插入填充，`AdjustTokenPrivileges` 返回 True 但 `GetLastError=1300`，权限实际没启用。必须拆成 `LuidLow` / `LuidHigh` 两个 int，并检查 last error。
3. **trim 后立刻读数会失真**。工作集被清空后进程马上又会缺页调入，所以 `Invoke-TunerTrim` 里等了 2 秒再取 `settledMB`。不要去掉这个等待。
4. **`core/*.ps1` 必须 UTF-8 BOM**，否则 PS 5.1 按 GBK 解析报语法错。

## 与部署包的关系

`AIWorkKit/payload/apps/tuner` 是复制品。改这里，然后重新打包。
