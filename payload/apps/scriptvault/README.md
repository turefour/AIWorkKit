# ScriptVault · 可复用脚本库

把一次性脚本重构成「公共模块 + 薄工具 + 测试」，每个文件带机器可读头部元数据，
由 `index.json` 分类索引，并被 CodeVault 索引页直接读取。

## 结构

```
ScriptVault/
  lib/            公共模块（无副作用，可被任意工具 import）
    cli.mjs       argv 解析 + --help 渲染
    fsx.mjs       原子写 JSON、安全遍历、路径越界判定
    log.mjs       分级日志、密钥脱敏、按大小轮转
    cdp.mjs       Chromium DevTools 客户端（启动 / 连接 / 求值 / 截图 / 错误采集）
    repo.mjs      Git 快照只读查询（便携版 git 优先）
  tools/          可执行工具（薄壳：解析参数 → 调 lib → 输出）
    shot.mjs      页面截图 + console 错误采集
    git-report.mjs  各仓库提交与脏文件汇总（保留理由见下节）
    scaffold.mjs  生成新工具骨架（含标准头）
    adopt-project.mjs  一条命令完成项目接入（git + 索引）
    measure-cost.mjs  度量「复用脚本 vs 从零构建」的 token 成本
  py/             Python 模块（从 handdelete 的历史脚本里提炼）
    excel_report.py  Excel 报表排版原语（标题/表头/数据行/列宽/冻结/斑马纹）
    dxf_draw.py      DXF 绘图原语 + A3/A4 图框 + 尺寸标注
    selftest.py      两个模块的回归测试（生成 → 回读校验）
  config/
    repos.json    仓库清单的单一真相源（CodeVault 与 adopt-project 共读）
  tests/          node:test 回归测试（零依赖）
  build-index.mjs 扫描头部元数据 → index.json
  index.json      分类索引（生成物，勿手改）
```

## 头部元数据约定

每个脚本/模块的首个注释块必须包含：

```js
/**
 * @name shot
 * @category browser
 * @purpose Capture a local page over CDP...
 * @input  --url <url> [--out png]
 * @usage  node tools/shot.mjs --url http://127.0.0.1:57910/
 * @reuse  yes
 */
```

`@category` 取值：`core` `browser` `cad` `doc` `data` `system` `web` `test` `scaffold`
（中文标签见 `build-index.mjs` 的 `CATEGORY_LABELS`，CodeVault 页面同源）。

`@reuse: yes` 表示可被其它脚本直接复用；否则视为一次性脚本，应留在归档目录。

## 常用命令

```powershell
node build-index.mjs                   # 重建 index.json
node build-index.mjs --check           # CI 式校验索引是否过期
node --test tests/                     # 跑回归测试
node tools/shot.mjs --url http://127.0.0.1:57910/ --launch --out shot.png --close
node tools/measure-cost.mjs            # 度量复用 vs 从零构建的 token 成本
node tools/scaffold.mjs my-tool --purpose "..." --category web
```

## Python 模块（py/）

从 `handdelete` 里 885 个历史脚本中提炼，依据是「同一能力被重复实现了多少次」：

| 模块 | 来源 | 替代了什么 |
|---|---|---|
| `excel_report.py` | 96 个脚本 import openpyxl | 每个报表脚本都重写的 5 个排版函数（title/subtitle/head/body/widths） |
| `dxf_draw.py` | 35 个脚本 import ezdxf | 每个图纸脚本都重写的 L/PL/RECT/C/text/hatch/arrow/dim_h/dim_v，外加 A3/A4 图框与标题栏 |

```powershell
python py/excel_report.py --demo out.xlsx    # 验证 Excel 排版
python py/dxf_draw.py --demo out.dxf         # 验证 DXF 图框
python py/selftest.py                        # 22 项回归断言
```

设计取舍：

- 图层用**语义名**（`outline` / `dim` / `text` / `frame`）而不是具体层名 ——
  历史脚本里分别叫 `OUTLINE`、`1_VIS_HARD`、`VIS`，语义是一样的
- 尺寸标注用图元手绘（线 + SOLID 箭头 + TEXT），不依赖 ezdxf 的 dim render，
  避免不同查看器渲染差异

## 工具成本评估（measure-cost）

`node tools/measure-cost.mjs` 会实测每个工具的「接口学习量 / 输出量」，与「最简替代方案」对比，
判断复用是否真的划算。2026-11-13 结论：

| 工具 | 复用(热) | 从零 | 倍数 | 结论 |
|---|---|---|---|---|
| shot.mjs | 174 | 1401 | 8.05x | 保留（CDP 客户端自己写要 150 行） |
| git-report.mjs | 126 | 300 | 2.38x | 保留（见下方说明） |
| scaffold.mjs | 122 | 263 | 2.16x | 保留 |
| adopt-project.mjs | 174 | 316 | 1.82x | 保留（七步手写易漏白名单/幂等） |

**git-report 的曲折**：第一版度量判定「从零更省」（174 vs 98），已删除；随后实测内联方案发现
PowerShell 5.1 读 UTF-8 JSON 不加 `-Encoding UTF8` 会按 GBK 解码、`ConvertFrom-Json` 直接报错
并吐出整份 JSON（≈780 token），把这次返工计入后从零 300 > 复用 126 —— 结论反转，脚本恢复。

教训：`SCRATCH_PLANS.tax` 就是给这类隐性返工留的余量，评估时不能只看"代码行数"。

## 接入一个新项目

一条命令完成「生成 .gitignore → git init → 首次提交 → 登记仓库清单 → 登记索引库 → 刷新扫描」：

```powershell
node tools/adopt-project.mjs "C:\path\to\project" --name my-proj --label "我的项目" --kind "全栈应用" --note "一句话说明"
```

先演练不改动：`--dry`。参数一览：

| 参数 | 说明 |
|---|---|
| `--stack node\|python\|static\|none` | .gitignore 模板，缺省按目录内容自动识别 |
| `--dry` | 只打印计划，不做任何改动 |
| `--no-commit` | 只 init + 登记，不提交 |
| `--no-register` | 只碰 git，不动仓库清单与索引库 |
| `--force-ignore` | 已有白名单 `.gitignore` 时也追加模板（默认跳过，避免误伤） |

安全约定：

- 检测到 `/*` + `!pattern` 白名单格式时**不追加黑名单规则**，只提示保持原样
- 重复执行只更新条目，不会产生两条记录
- 提交身份优先用 `git config`，未配置时用 `CodeVault / codevault@local` 兜底

接入后打开 `http://127.0.0.1:57910/#__repos__` 即可看到该仓库的提交与未提交数。

## 设计原则

1. **薄工具**：工具只做参数解析、调用、格式化；逻辑放 `lib/`，便于测试与复用。
2. **零依赖**：只用 Node 内置模块，不引入 npm 包，任何机器 `node` 直接跑。
3. **失败要显性**：不吞异常；需要"静默跳过"时必须记日志并给出原因。
4. **不杀无关进程**：涉及浏览器/进程操作时按命令行精确匹配，禁止 `taskkill /IM` 一刀切。
5. **可索引**：没有头部元数据的脚本不算合格工具，`build-index` 会把它标为「无说明」。

## 与旧目录的关系

`[归档目录]`（约 1000 个历史一次性脚本）保留为归档，
只做版本快照，不再新增。新脚本一律进本库：

- 需长期复用 → `tools/`（带 `@reuse yes`）
- 只是临时验证 → 仍可放 `handdelete`，但不进 `tools/`
