# AIWorkKit 空闲降温器（tuner）

在**不关闭 AIWorkKit** 的前提下，手动把它的资源占用降下来，并随时一键恢复。

三种手段可叠加使用：

| 手段 | 效果 | 可逆性 |
| --- | --- | --- |
| 回收工作集 `EmptyWorkingSet` | 把已用内存还给系统，页面下次访问时自动换回 | 完全可逆，不丢数据 |
| 降低 CPU 优先级（BelowNormal / Idle）+ EcoQoS | 空闲时几乎不抢 CPU，前台其他程序更流畅 | 一条命令还原 |
| 挂起后台子进程 `NtSuspendProcess` | 扩展宿主 / TS 服务 / 脚本子进程的 CPU 与内存压到接近 0 | 需唤醒（托盘 / 命令） |

---

## 1. 结构

```
tuner/
├─ core/tuner-core.ps1     核心引擎（进程识别、回收、优先级、挂起/唤醒、状态持久化）
├─ core/tuner.ps1          CLI 入口（-Action status|trim|apply|restore|auto|resume-watch）
├─ cli/tuner.js            Node 前端（中文输出、托盘/窗口启动），插件命令都调用它
├─ server/tuner-server.js  本地仪表盘服务（127.0.0.1:47822，供独立窗口使用）
├─ web/                    独立窗口前端（index.html / style.css / app.js，无构建步骤）
├─ tray/tray.ps1           任务栏托盘（独立进程，挂起后唯一的可靠唤醒通道）
├─ tray/labels.json        托盘中文文案（独立文件，避免 PS 5.1 编码问题）
├─ hooks/                  SessionStart / UserPromptSubmit / Stop 空闲判定 + 随启动拉起
├─ commands/               /tuner /tuner-quiet /tuner-suspend /tuner-restore /tuner-window
└─ package/                build.ps1（打包）/ install.ps1 / install.cmd / uninstall.ps1 / 安装说明
```

**一份核心四处复用**：插件命令、Hook、托盘、独立窗口全部调用 `core/tuner-core.ps1`，不存在两套实现。

## 1.1 随 AIWorkKit 启动

插件装上后，`SessionStart` hook 会执行 `cli/tuner.js autostart`：

| 配置项 | 默认 | 作用 |
| --- | --- | --- |
| `trayOnStart` | `true` | 每次启动 AIWorkKit 自动拉起任务栏托盘（已运行则跳过） |
| `windowOnStart` | `false` | 同时弹出独立仪表盘窗口 |
| `port` | `47822` | 本地仪表盘端口（也可用环境变量 `AIWORKKIT_TUNER_PORT`） |

托盘与窗口都是**独立进程**：AIWorkKit 关闭后仍在，重开时只会复用、不重复开。
配置写在 `%LOCALAPPDATA%\AIWorkKitIdleTuner\config.json`，例如：

```json
{ "trayOnStart": true, "windowOnStart": true }
```

## 1.2 独立窗口（占用仪表盘）

```bash
node cli/tuner.js open
```

- 自动拉起本地服务（`127.0.0.1:47822`），再用 Edge / Chrome 的 `--app` 模式打开
  **无地址栏独立窗口**，独立 `user-data-dir`、任务栏独立图标；已开则只前置
- 界面内容：工作集大数字 + 近 3 分钟曲线、私有提交 / CPU / 进程数 / 已挂起、
  角色分布条、全进程明细表；右侧动作区：一键降温 / 深度降温 / 只回收内存 /
  挂起后台（二次确认）/ 恢复全部 / 空闲自动开关
- 每 3 秒轮询一次（窗口不可见时暂停），所有动作走同一套 PowerShell 核心
- 托盘双击图标也会打开这个窗口

## 2. 安装

```powershell
# 仓库内直接装（建议加 -TrayAtLogin 让托盘常驻，保证随时能唤醒）
powershell -ExecutionPolicy Bypass -File package\install.ps1 -TrayAtLogin
```

- 安装到 `%USERPROFILE%\.codebuddy\plugins\marketplaces\tuner-market`
- 注册 `known_marketplaces.json` / `installed_plugins.json` / `settings.json`（均先备份 `*.bak_tuner_*`）
- 安装后 `Ctrl+Shift+P → Developer: Reload Window` 让命令与 Hook 生效
- 开发期可用 `-Link` 建目录联接，改完仓库即生效

## 3. 用法

### 3.1 命令（AIWorkKit 内）

| 命令 | 作用 |
| --- | --- |
| `/tuner` | 查看占用总览与建议 |
| `/tuner-quiet` | 一键降温（回收内存 + 降优先级） |
| `/tuner-suspend` | 挂起后台子进程（需托盘的恢复通道） |
| `/tuner-restore` | 唤醒 + 还原优先级 |
| `/tuner-window` | 打开独立仪表盘窗口 |

### 3.2 CLI

```bash
node cli/tuner.js status                      # 占用总览
node cli/tuner.js trim --scope all            # 只回收工作集
node cli/tuner.js apply --mode lite           # 回收 + BelowNormal + EcoQoS
node cli/tuner.js apply --mode deep           # 回收 + Idle + EcoQoS
node cli/tuner.js apply --mode suspend --level background --auto-resume 30
node cli/tuner.js restore                     # 唤醒 + 还原
node cli/tuner.js auto on|off --mode lite     # 空闲自动降温开关
node cli/tuner.js tray                        # 启动托盘
node cli/tuner.js open                        # 打开独立仪表盘窗口
node cli/tuner.js autostart                   # 随 AIWorkKit 启动（SessionStart 自动调用）
```

### 3.3 托盘

右键任务栏图标：状态 / 一键降温 / 深度降温 / 挂起后台（含确认框）/ 挂起后台+渲染进程 / **恢复全部** / 自动降温开关 / 打开数据目录 / 退出。

双击图标用气泡显示当前工作集。

### 3.4 自动模式（默认关闭）

`auto on` 后，`Stop` hook 会在每轮对话结束后安排一次延迟降温（`cli/tuner.js idle-watch`）：

- 延迟 `minIdleSeconds`（默认 120 秒）后才真正执行 `lite`/`deep`
- 期间用户再次提问（`UserPromptSubmit` 写入 `busy=true`）→ 本次延迟任务自动取消，
  避免来回对话时反复付换页代价
- 120 秒内已降过温则跳过，不重复刷
- **自动模式永不挂起进程**——Hook 自身运行在扩展宿主的 Node 服务里，挂起它会让下一轮
  的 `UserPromptSubmit` 永远不触发（死锁）。挂起是纯手动动作。

## 4. 进程识别

按命令行把 70+ 个 Electron 进程分成：

`main`（主进程）、`renderer`（窗口 / webview）、`gpu`、`node-service`（扩展宿主 / Node 服务）、
`tsserver`、`extension-host`、`helper`（脚本子进程）、`utility`、`crashpad`。

挂起保护规则（硬性）：

1. 永不挂起 `main`、`gpu`
2. 永不挂起调用者自身的祖先进程链（否则命令回传不回来）
3. `--level background`（默认）只挂 `node-service / tsserver / helper / extension-host / utility`
4. `--level aggressive` 额外挂 `renderer`——窗口会假死，仅托盘可恢复（有二次确认）

## 5. 安全与恢复

- 状态落盘 `%LOCALAPPDATA%\AIWorkKitIdleTuner\state.json`，记录被挂起的 PID 与角色，恢复即按此清单执行
- `UserPromptSubmit` hook 有兜底：检测到仍有挂起进程时立刻自动 `restore`，避免用户看到「IDE 卡死」
- `--auto-resume N`：挂起时同时拉起一个隐藏的看守进程，N 分钟后自动唤醒
- 任何动作都不结束进程、不改注册表、不动 AIWorkKit 安装目录

## 6. 实测（本机 8 核 / 75 个 AIWorkKit 进程）

| 动作 | 工作集 |
| --- | --- |
| 初始 | 2683.2 MB |
| `trim` 后立即 | 322.6 MB |
| `trim` 后 2 秒 | 稳定值约 958 MB（页面陆续换回） |
| `apply --mode lite` 稳定后 | 仍省约 1.88 GB |

> 说明：工作集回收后的「立即值」很好看但并不持久，页面会按需换回。因此所有输出同时给出
> 「立即」与「2 秒稳定」两个数字，不粉饰。

## 7. 数据与日志

```
%LOCALAPPDATA%\AIWorkKitIdleTuner\
├─ state.json   运行状态（busy / suspended / 最近一次降温）
├─ config.json  配置（autoMode / autoLevel / processNames / suspendLevel）
├─ tuner.log    核心动作日志
├─ hook.log     Hook 事件日志
├─ server.log   仪表盘服务日志（含失败重试记录）
└─ window-profile\  独立窗口的浏览器配置目录
```

## 8. 卸载

```powershell
powershell -ExecutionPolicy Bypass -File package\uninstall.ps1          # 保留运行数据
powershell -ExecutionPolicy Bypass -File package\uninstall.ps1 -Purge   # 连数据一起删
```

卸载会先 `restore`（唤醒所有被挂起进程）再清注册、开机启动项与插件目录。

## 9. 打包分发给其他设备

```powershell
powershell -ExecutionPolicy Bypass -File package\build.ps1
# 可选：-Version 1.0.1 / -NoNode（不内置运行时）/ -NoZip / -OutDir D:\dist
```

产物：

```
dist\tuner-portable\            （88 MB）
├─ tuner\   插件本体
├─ runtime\node.exe        内置 Node 运行时（88 MB，来自构建机的 node）
├─ install.cmd / install.ps1
├─ uninstall.cmd / uninstall.ps1
├─ README-安装说明.txt      目标机器照着做即可
└─ VERSION.txt             版本 / 构建时间 / 运行时来源
dist\tuner-portable-1.0.0.zip   （33 MB，直接拷走）
```

**目标设备只需 Windows 10/11 + 自带 PowerShell 5.1 + Edge**，不需要预装 Node.js：

1. 解压 → 双击 `install.cmd`
2. 安装器把 `runtime\node.exe` 装到插件目录 `<插件>\runtime\node.exe`
3. 安装器把 `hooks\hooks.json` 与 `commands\*.md` 里的 `node` 命令**改写成该绝对路径**，
   因此 Hook、斜杠命令、托盘都不依赖 PATH
4. AIWorkKit 里 `Ctrl+Shift+P → Developer: Reload Window` 生效

重复安装到同一台机器时会自动把旧的绝对路径规范化成新路径；`-Link` 开发模式则保持
`node` 关键字、要求系统已装 Node 18+。

## 10. 常见问题

- **回收后 AIWorkKit 变慢几秒**：正常，页面正在换回内存，之后恢复原速。
- **`/tuner-restore` 没反应**：当前请求所在进程树已被挂起，用托盘「恢复全部」或外部 PowerShell 执行
  `core\tuner.ps1 -Action restore`。
- **某些进程回收失败**：以管理员身份运行的进程需要同等权限，属正常，状态输出会显示成功数/总数。
- **看不到托盘图标**：可能被收进了任务栏溢出区；`node cli/tuner.js tray` 会提示是否已在运行。
- **动作偶发失败，重试就好**：本机页面文件（虚拟内存）不足时，PowerShell 子进程会以
  `OutOfMemoryException` 崩溃（`server.log` 会记录 `retrying once`）。服务端已自动重试一次。
  注意：**回收工作集只降物理内存占用，不减少提交量（commit）**；若任务管理器显示
  「已提交」接近上限，需要扩大页面文件或重启 AIWorkKit 才能真正缓解。
