#!/usr/bin/env node
/**
 * @name memcore
 * @category system
 * @purpose 工作套件的统一任务记忆：摄入对话痕迹、抽取习惯、生成 MEMORY.md 与常驻规则、
 *          写入/检索长期条目。不依赖服务进程是否在跑。
 * @input  <all|sync|build|show|rule|stats|search|note|install|uninstall|prune> [选项]
 * @usage  node tools/memcore.mjs                 # sync + build
 *         node tools/memcore.mjs show
 *         node tools/memcore.mjs search 塔防
 *         node tools/memcore.mjs note add --type constraint --scope machine --text "..."
 * @reuse  yes
 *
 * 退出码：0 成功 / 1 失败 / 2 检索未命中（与 errvault 的约定一致，便于脚本判断）
 */

import {
  addNote,
  build,
  formatOverview,
  installRule,
  prune,
  readMemory,
  readRule,
  removeNote,
  searchAll,
  sync,
  uninstallRule
} from '../apps/memcore/lib/api.mjs';
import { cfg, readStore, statsOf, searchNotes, ENTRY_TYPES } from '../apps/memcore/lib/store.mjs';
import { fmtDate, fmtShort } from '../apps/memcore/lib/render.mjs';

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'all').toLowerCase();

function flag(name, dflt = '') {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}

function has(name) {
  return argv.includes('--' + name);
}

function say(msg) {
  console.log(msg);
}

function usage() {
  say(`memcore — 工作套件统一任务记忆

用法: node tools/memcore.mjs <命令> [选项]

  all                  sync + build（默认）
  sync                 增量摄入会话与用户指令
  build                重建 memory\\MEMORY.md 与 memory\\memcore.mdc
  show                 打印完整记忆
  rule                 打印常驻规则（自动注入的那份）
  stats                统计 / 预算 / 数据源
  search <关键词>       统一检索（条目 / 指令 / 会话标题）
  note add             新增或合并条目：
      --type <${Object.keys(ENTRY_TYPES).join('|')}>
      --scope <machine|suite|project|session|task>
      --text "<一句话事实，<=${cfg.noteChars} 字>"
      [--tags a,b] [--confidence confirmed|inferred|stale]
      [--weight 1-5] [--ttl never|180d|30d] [--id <已有条目>]
  note list            列出条目（--type / --scope / --limit）
  note del <id>        删除条目
  install              把 memcore.mdc 写入各 AI 平台规则目录
  uninstall            移除已安装的规则
  prune                按保留策略裁剪

归档根：${statsOf(readStore()).home}
预算：MEMORY ${cfg.memoryBudget}B / 规则 ${cfg.tier1Budget}B；可在 config\\memcore.json 覆盖
`);
}

function printNote(n) {
  const tags = (n.tags || []).length ? '  #' + n.tags.join(' #') : '';
  say(`${n.id}  [${n.type}/${n.scope}]${n.count > 1 ? ' ×' + n.count : ''}  ${n.text}${tags}`);
}

function main() {
  if (cmd === 'help' || has('help') || cmd === '--help') {
    usage();
    return 0;
  }

  if (cmd === 'sync') {
    const r = sync();
    say(`[memcore] 同步完成 · 新增指令 ${r.added} · 会话 ${r.before.sessions}→${r.after.sessions} · 指令 ${r.before.messages}→${r.after.messages}`);
    return 0;
  }

  if (cmd === 'build') {
    const b = build();
    if (b.ok === false) {
      say('[memcore] ' + b.error);
      return 1;
    }
    say(`[memcore] 已生成 MEMORY.md ${(b.memoryBytes / 1024).toFixed(1)}KB（≈${b.memoryTokens} tokens）/ 规则 ${(b.ruleBytes / 1024).toFixed(1)}KB（≈${b.ruleTokens} tokens）· 条目 ${b.notes}`);
    return 0;
  }

  if (cmd === 'all') {
    const s = sync();
    const b = build();
    say(`[memcore] 同步 + 生成完成 · 新增指令 ${s.added} · 会话 ${s.after.sessions} · 指令 ${s.after.messages} · 条目 ${b.notes || 0}`);
    if (b.ok !== false) say(`[memcore] MEMORY ${(b.memoryBytes / 1024).toFixed(1)}KB · 规则 ${(b.ruleBytes / 1024).toFixed(1)}KB`);
    return b.ok === false ? 1 : 0;
  }

  if (cmd === 'show') {
    const body = readMemory();
    say(body || '[memcore] 还没有记忆：先运行 node tools/memcore.mjs');
    return body ? 0 : 1;
  }

  if (cmd === 'rule') {
    const body = readRule();
    say(body || '[memcore] 规则尚未生成：先运行 build');
    return body ? 0 : 1;
  }

  if (cmd === 'stats') {
    say(formatOverview());
    return 0;
  }

  if (cmd === 'search') {
    const q = argv[1] && !argv[1].startsWith('--') ? argv[1] : flag('q');
    if (!q) {
      say('用法: node tools/memcore.mjs search <关键词>');
      return 1;
    }
    const r = searchAll(q, Number(flag('limit', '40')) || 40);
    if (!r.rows.length) {
      say(`[memcore] 未命中：${q}`);
      return 2;
    }
    const tag = { note: '条目', message: '指令', session: '会话' };
    for (const row of r.rows) {
      say(`${fmtDate(row.t)} [${tag[row.kind] || row.kind}/${row.label}] ${row.text}`);
    }
    say(`\n[memcore] 命中 ${r.count} 条（最多显示 ${r.rows.length}）`);
    return 0;
  }

  if (cmd === 'note') {
    const sub = (argv[1] || '').toLowerCase();

    if (sub === 'add') {
      const text = flag('text');
      if (!text) {
        say('用法: note add --type <类型> --text "..." [--scope ...]');
        return 1;
      }
      try {
        const r = addNote(
          {
            id: flag('id') || undefined,
            type: flag('type', 'constraint'),
            scope: flag('scope') || undefined,
            text,
            tags: flag('tags') ? flag('tags').split(',').map((s) => s.trim()).filter(Boolean) : undefined,
            confidence: flag('confidence') || undefined,
            weight: flag('weight') ? Number(flag('weight')) : undefined,
            ttl: flag('ttl') || undefined
          },
          'cli'
        );
        say(`[memcore] ${r.isNew ? '新增' : '已合并'} ${r.entry.id} · ${r.entry.type}/${r.entry.scope}${r.entry.count > 1 ? ' ×' + r.entry.count : ''}`);
        say('          ' + r.entry.text);
        if (r.rebuilt) say('[memcore] 记忆与规则已重新生成');
        return 0;
      } catch (e) {
        say('[memcore] 写入失败：' + e.message);
        return 1;
      }
    }

    if (sub === 'list') {
      const store = readStore();
      const rows = searchNotes(store, {
        q: flag('q'),
        type: flag('type'),
        scope: flag('scope'),
        limit: Number(flag('limit', '20')) || 20
      });
      if (!rows.length) {
        say('[memcore] 暂无条目');
        return 0;
      }
      for (const { note } of rows) printNote(note);
      say(`\n[memcore] 共 ${rows.length} 条`);
      return 0;
    }

    if (sub === 'del') {
      const id = argv[2] || flag('id');
      if (!id) {
        say('用法: note del <id>');
        return 1;
      }
      const r = removeNote(id);
      say(r.ok ? `[memcore] 已删除 ${id}` : `[memcore] ${r.error}`);
      return r.ok ? 0 : 1;
    }

    say('用法: note <add|list|del> [选项]（详细见 node tools/memcore.mjs help）');
    return 1;
  }

  if (cmd === 'install') {
    const r = installRule();
    if (!r.ok) {
      say('[memcore] ' + r.error);
      return 1;
    }
    for (const w of r.written) say(`[memcore] ${w.error ? '失败' : '已写入'} ${w.platform}: ${w.file || ''}${w.error ? ' ' + w.error : ''}`);
    say(`[memcore] 规则 ${(r.ruleBytes / 1024).toFixed(1)}KB`);
    return 0;
  }

  if (cmd === 'uninstall') {
    const r = uninstallRule();
    say(r.removed.length ? '[memcore] 已移除：' + r.removed.join(', ') : '[memcore] 没有已安装的规则');
    return 0;
  }

  if (cmd === 'prune') {
    const r = prune();
    say(`[memcore] 裁剪完成 · 指令 ${r.before.messages}→${r.after.messages} · 条目 ${r.before.notes}→${r.after.notes}（保留 ${cfg.keepDays} 天 / ${cfg.keepMessages} 条）`);
    return 0;
  }

  usage();
  return 1;
}

process.exit(main());
