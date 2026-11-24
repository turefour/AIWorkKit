AIWorkKit 空闲降温器 · 便携安装包
==================================

适用环境
  Windows 10 / 11（x64）
  AIWorkKit CN（VS Code 内核）任意近期版本
  PowerShell 5.1（系统自带）、Edge 或 Chrome（系统自带 Edge 即可）
  无需另外安装 Node.js —— 本包已内置运行时 runtime\node.exe

目录结构
  tuner\   插件本体（不要单独改名或移动）
  runtime\node.exe        内置 Node 运行时
  install.cmd             一键安装
  uninstall.cmd           一键卸载
  VERSION.txt             构建信息


一、安装
  1. 把整个文件夹解压到任意位置（建议 %USERPROFILE%\tools\，路径不要含特殊符号）
  2. 双击 install.cmd
  3. 看到“安装完成”后，打开 AIWorkKit，按 Ctrl+Shift+P -> Developer: Reload Window
  4. 重载后任务栏通知区域出现托盘图标；右键图标可一键降温 / 恢复，双击打开独立窗口

  说明：安装脚本会自动把 hooks.json 与命令文档里的 node 命令改写成
  “<安装目录>\runtime\node.exe” 的绝对路径，因此目标机器没装 Node.js 也能工作。


二、使用
  独立窗口（占用仪表盘）
    - 托盘图标双击
    - 或在 AIWorkKit 里执行 /tuner-window
    - 或命令行：node cli\tuner.js open

  斜杠命令
    /tuner          查看占用总览与建议
    /tuner-quiet    一键降温（回收内存 + 降优先级）
    /tuner-suspend  挂起后台子进程（需托盘恢复）
    /tuner-restore  唤醒并还原优先级
    /tuner-window   打开独立仪表盘窗口

  托盘菜单
    打开独立窗口 / 一键降温 / 深度降温 / 挂起后台子进程 / 恢复全部 /
    空闲自动降温开关 / 打开数据目录 / 退出托盘


三、随 AIWorkKit 启动
  插件通过 SessionStart Hook 在每次启动 AIWorkKit 时自动拉起托盘（已运行则跳过）。
  若希望同时自动弹出独立窗口，编辑：
    %LOCALAPPDATA%\AIWorkKitIdleTuner\config.json
  把 windowOnStart 改为 true，例如：
    { "trayOnStart": true, "windowOnStart": true }
  若希望连 AIWorkKit 都没启动也常驻托盘：
    powershell -ExecutionPolicy Bypass -File install.ps1 -TrayAtLogin


四、卸载
  双击 uninstall.cmd
  卸载会先“恢复全部”（唤醒所有被挂起的进程）再清除插件注册与安装目录。
  加 -Purge 可同时删除运行数据与日志：
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge


五、安全边界
  - 永不挂起 AIWorkKit 主进程与 GPU 进程
  - 永不挂起调用链上的祖先进程（否则命令无法回传结果）
  - 默认“挂起后台”只针对扩展宿主 / TS 服务 / 脚本子进程；渲染进程需额外确认（界面会假死）
  - 自动降温永不挂起任何进程，只做内存回收与降优先级
  - 所有动作都不结束进程、不改 AIWorkKit 安装目录
  - 被修改的注册文件都会先备份为 *.bak_tuner_<时间戳>


六、常见问题
  1) 托盘图标看不到
     多半被收进了任务栏溢出区（^ 箭头里）。也可以在 AIWorkKit 里执行 /tuner-window。

  2) 独立窗口打不开
     确认本机有 Edge 或 Chrome；没有则回落到默认浏览器打开 http://127.0.0.1:57822/
     端口被占用时可用环境变量 AIWORKKIT_TUNER_PORT 换端口。

  3) 某项动作偶发失败，重试就好
     系统页面文件（虚拟内存）不足时，PowerShell 子进程可能以 OutOfMemoryException 崩溃，
     服务端会自动重试一次（server.log 里可见 retrying once）。
     注意：回收工作集只降低物理内存占用，不减少“已提交”内存；
     若任务管理器“已提交”接近上限，需要扩大页面文件或重启 AIWorkKit。

  4) 回收后 AIWorkKit 有几秒变慢
     正常现象：页面正在从磁盘换回内存，随后恢复原速。

  5) 挂起后 AIWorkKit 没反应
     点托盘「恢复全部」，或在外部 PowerShell 执行：
       core\tuner.ps1 -Action restore
     挂起时若指定了 --auto-resume 30，则 30 分钟后会自动唤醒。
