# ScriptVault · 脚本库

可复用脚本的**主库**。新脚本一律放这里，不再往 `handdelete` 归档目录加。

---

## 目录地图

```
lib/        可复用模块（被 tools 和别的项目 import）
tools/      命令行工具（有标准头部，可独立执行）
py/         Python 模块（Excel 排版 / DXF 绘图）
tests/      node:test 回归测试（零依赖）
config/     repos.json —— 仓库清单的唯一真相源
index.json  自动生成的索引，桌面端和网页端都读它
build-index.mjs  重建 index.json
```

## 只记三条命令

```powershell
node tools/snippet.mjs search <关键词>     # 找工具（最常用，别先翻网页）
node tools/snippet.mjs run <名称> [参数]   # 直接执行
node build-index.mjs                        # 改完脚本必须重建索引
node --test                                 # 跑测试
```

## 现有工具

| 工具 | 用途 |
|---|---|
| `snippet.mjs` | 按关键词检索 + 执行（`search` / `list` / `show` / `run`） |
| `shot.mjs` | 页面截图 + console 错误采集（走 CDP） |
| `git-report.mjs` | 多仓库提交/分支/未提交汇总（`--strict` 有未提交时退出码 1） |
| `adopt-project.mjs` | 一条命令接入新项目（.gitignore + git init + 索引登记） |
| `scaffold.mjs` | 生成符合规范的新工具骨架 |
| `measure-cost.mjs` | 单个工具：调用 vs 重写谁省 token |
| `measure-library.mjs` | 整库：加上「从库里找到它」的成本后还省不省 |
| `prune-artifacts.mjs` | 清理目录里的产物（截图/日志），业务扩展名会被拒绝 |

Python 模块：`py/excel_report.py`（96 个历史脚本的排版代码）、`py/dxf_draw.py`（35 个图纸脚本的图元 + 图框）。

## 新增脚本的硬性格式

`tools/` 下的每个文件，首个注释块必须包含六个字段，否则 `build-index` 索引不到：

```javascript
/**
 * @name tool-name
 * @category web | data | system | cad | scaffold | test
 * @purpose 一句话说明它解决什么问题
 * @input 参数形式
 * @usage node tools/tool-name.mjs --xx
 * @reuse 什么时候该用它（这句最重要，Agent 靠它判断要不要调用）
 */
```

用 `node tools/scaffold.mjs 新名字 --purpose "…" --category web` 生成骨架，别手抄。

## 成本判断（别凭感觉删脚本）

`measure-library.mjs` 会算「发现成本 + 接口学习 + 调用」总和对比「从零构建」。

**发现成本是关键变量**：

| 口径 | 发现成本 | 结论 |
|---|---|---|
| 冷启动（读全库索引） | ~2091 token | 全部不划算 |
| 热检索（只读该条） | ~92-152 token | 部分划算 |
| 已写进项目规则 | **0** | 全部划算（1.5~5.5x） |

所以：**新增可复用工具后，必须同时把它写进项目规则的对照表**（`~/.codebuddy/rules/project-onboarding.mdc` §3），
否则它自己的发现成本会让它显得不划算。

## 陷阱

1. **`-Encoding UTF8` 不能省**。PS 5.1 的 `Get-Content` 默认按 GBK 读，不写编码会把 `repos.json` 解析成乱码并吐整份文件（≈780 token 的返工）。
2. **`node --test` 会扫 `test/` 下所有 `.js`**。需要真实 daemon 的冒烟脚本要放 `scripts/`，否则 `npm test` 会红。
3. **`index.json` 是产物**，改完脚本记得 rebuild，否则 `snippet search` 搜到的是旧说明。
4. **批量删除有上限**。本机安全软件的过滤驱动连续删约 500 个文件后会开始拒绝（`EPERM`），`prune-artifacts` 已做分批 + 间隔。

## 相关仓库

| 仓库 | 关系 |
|---|---|
| `CodeVault`（`Desktop\CodeVault`） | 读 `config/repos.json` 和 `index.json` 渲染网页 |
| `handdelete`（`Desktop\handdelete`） | 历史归档，**不再新增**；只读 |
| `AIWorkKit` | 把本库打进部署包（`payload/apps/scriptvault`） |
