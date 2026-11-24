---
name: Runtime Progress Reporting
description: This skill should be used when a task has multiple verifiable steps and the user wants live, quantifiable progress (build / migration / batch jobs / long agent workflows) shown in the AIWorkKit Eco dashboard. Trigger phrases "上报进度", "可视化进度", "监控这个流程", "progress bar", "eco report".
version: 1.0.0
---

# Runtime Progress Reporting

## Overview

AIWorkKit Eco has two roles:

1. **Passive observation** — hooks capture every agent turn and tool call, and a daemon samples
   running processes and installed plugins. Nothing to do from the agent side.
2. **Active reporting** — when a task has a countable unit of work, the agent reports progress so
   the dashboard can show a real percentage, throughput and ETA instead of a spinner.

This skill covers role 2.

## Automatic coverage (do nothing)

The plugin already derives progress without cooperation:

- **task progress** — when you use a todo / plan / task-list tool, its payload is parsed into a
  `kind=task` flow with `current/total`, the active step as the label, and a per-step checklist
- **tool flows** — every tool call becomes a flow with duration, command line and its output log
- **script flows** — every process matched by the scanner shows up with CPU / memory

So only use the reporting protocol below when the work is countable **and** no checklist tool covers it.

## When to report

Report only when progress is genuinely quantifiable:

- batch processing with a known item count
- build / test / migration runs with steps
- long agent workflows with numbered phases

Do **not** report for single-shot answers, one-line edits, or ambiguous work — a fake percentage
is worse than an honest spinner.

## Protocol

Use the plugin CLI (preferred, no HTTP plumbing needed):

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/eco.js" report \
  --id "<stable-task-id>" \
  --label "<中文任务名>" \
  --kind manual \
  --current 3 --total 12 --unit "<单位>" \
  --note "<当前在做什么>"
```

- `--id` must be stable for the whole task; reuse it on every update so the caller sees one bar.
- Report **once at the start** (`--current 0`) and **once per completed unit**, not per token.
- Finish explicitly:

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/eco.js" done --id "<stable-task-id>"
node "${AIWORKKIT_PLUGIN_ROOT}/cli/eco.js" done --id "<stable-task-id>" --failed --note "3 个用例失败"
```

## Wrapping an external script

If the work is already a command, wrap it instead of hand-reporting — the wrapper parses
percentages, `n/m`, `step i of n` and `@eco i/n` markers from stdout automatically:

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/eco.js" run --label "构建" -- <command ...>
```

Inside a wrapped child process these env vars are available for exact reporting:

- `ECO_JOB_ID` — the job id the wrapper created
- `AIWORKKIT_ECO_PORT` — daemon port

Emit markers from any language on stdout:

```text
@eco 12/50 解析源文件
@eco 25/50 写入索引
```

## Rules

- Keep overhead low: no more than one report per completed unit, and never inside a tight loop
  without a throttle (>= 200 ms between reports).
- Never report a percentage that is not derived from a real count; leave `current/total` empty
  when the work is not measurable.
- Numbers must be monotonic within a job id.
- Always send the terminal `done` / `--failed`, otherwise the dashboard keeps it in "运行中".

## Verification

```bash
node "${AIWORKKIT_PLUGIN_ROOT}/cli/eco.js" status
```

A correctly reported job appears with its percentage, throughput (`n/s`) and remaining time.
