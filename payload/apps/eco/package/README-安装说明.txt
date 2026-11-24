AIWorkKit Eco —— 一键安装说明
================================

这是什么
--------
AIWorkKit 插件 + 本地监控守护进程：实时显示正在运行的插件、脚本、可量化流程进度，
每个流程都能看步骤清单与完整日志，并支持手动标记卡住 / 跳过 / 终止进程。


前置条件
--------
1. Windows（与 AIWorkKit CN 同一台机器）
2. Node.js 18 或更高版本（https://nodejs.org ，安装后 node -v 能输出版本）
3. AIWorkKit 已安装并至少启动过一次


一键安装
--------
双击本目录下的 install.cmd（或在 PowerShell 里执行 install.ps1）即可，它会：

  1. 校验 node
  2. 把插件装到 %USERPROFILE%\.codebuddy\plugins\marketplaces\eco-market
  3. 注册插件市场（known_marketplaces / installed_plugins / settings.enabledPlugins）
  4. 写入规则 %USERPROFILE%\.codebuddy\rules\eco-first.mdc（路径按本机实际位置生成）
  5. 启动守护进程（后台，端口 57821）

被修改的 json 与规则文件都会先备份成 *.bak_eco_<时间戳>，可随时回滚。

常用参数（install.cmd 后面加）：
  -DryRun    只打印将要执行的动作，不改任何文件
  -Link      用目录联接指向包内插件，便于随包更新（默认复制）
  -NoStart   装完不启动守护进程

示例：
  install.cmd -DryRun
  install.cmd -Link


安装之后
--------
1. 在 AIWorkKit 里按 Ctrl+Shift+P -> Developer: Reload Window（只需一次）
2. 重载后每次启动 AIWorkKit 都会由 SessionStart hook 自动拉起监控
3. 需要看窗口时执行：
     node "%USERPROFILE%\.codebuddy\plugins\marketplaces\eco-market\plugins\eco\cli\eco.js" open
   打开的是独立窗口（无地址栏/标签栏），重复执行只会前置已有窗口


验证是否正常
------------
  node "<安装路径>\cli\eco.js" status
     期望输出：http://127.0.0.1:57821/  pid ...  up ...s / jobs: ... / scripts: ... / plugins: ...

  node "<安装路径>\cli\eco.js" open
     应弹出独立窗口；顶部「Hook 采集」为绿色说明 hook 已接入

若「Hook 采集」为灰：说明插件 hooks 尚未被 IDE 加载，重载窗口即可。


卸载
----
  powershell -ExecutionPolicy Bypass -File uninstall.ps1
  powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge   （同时删除安装目录）


常见问题
--------
- 提示"未检测到 node"：先安装 Node.js 18+，重开终端再运行
- 端口被占用：设环境变量 AIWORKKIT_ECO_PORT=57822 后再装，命令与看板需一致
- 双击 install.cmd 闪退：改为在 PowerShell 里执行
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
- 想确认没装错：先跑 install.cmd -DryRun 看计划动作


目录内容
--------
  eco\   插件本体（hooks / server / cli / web / skills / commands）
  install.ps1        一键安装（install.cmd 为其双击入口）
  uninstall.ps1      一键卸载
  rules\             规则模板，安装时按本机路径替换后写入 ~/.codebuddy/rules
