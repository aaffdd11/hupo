#!/usr/bin/env node
// 清理 DSH 的会话记录目录（欠账第 9 条，`docs/dev/07-TIMEOUT.md` §6.6）。
//
//   node scripts/prune-sessions.mjs                 # **只看**（默认就是安全的那一侧）
//   node scripts/prune-sessions.mjs --json          # 机器可读的同一份计划
//   node scripts/prune-sessions.mjs --apply         # 真删（要显式加）
//
// ⚠️ **为什么默认不删**：这是在**删数据**，而且删掉就没了。
//    默认必须是安全的那一侧——"跑错一次命令"和"跑错一次命令还少了 40MB 记录"
//    是两件事。想真删，得自己把 `--apply` 打上去。
//
// ⚠️ 盘上的真实形状是**两层**（实测，和"每个会话一个目录"的说法略有出入）：
//    `$DSH_HOME/sessions/<项目>-<slug>--/<一条记录>/{session.lock, session.v3.jsonl.zstd}`
//    顶层是按项目分的**组**。组目录本身**永远不是**候选（那是别人的目录），
//    所以默认只动 `HUPO_AGENT_CWD` 对应的那一组；别的项目要一起清，
//    得自己加 `--all-groups`。见 `src/prune.js` 的 `scanEntries`。
//
// 退出码：`0` 正常（含"没有东西可清"）· `1` 真删的时候有失败 · `2` 用法/参数不对

import nodeOs from 'node:os';
import nodePath from 'node:path';
import nodeProcess from 'node:process';
import { spawnSync } from 'node:child_process';

import { applyPrune, defaultRm, formatBytes, groupSlugFor, planPrune, probeLock, scanEntries, summarize } from '../v2/services/core/src/prune.js';

const USAGE = `用法：node scripts/prune-sessions.mjs [选项]

  --dir <路径>     要清的根目录（默认 $DSH_HOME/sessions）
  --group <名字>   只动这一组（就是那个目录名，如 --home-deploy-hupo-workspace--）
  --all-groups     ⚠️ 连别的项目的记录一起清（默认只动自己那一组）
  --apply          真删。**不加就只列出来**
  --json           机器可读输出
  -h, --help       这一段

默认只列出来。要真删请显式加 --apply。`;

function parseArgs(argv) {
  const out = { dir: null, group: null, allGroups: false, apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--all-groups') out.allGroups = true;
    else if (a === '--dir' || a === '--group') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 后面要给一个值`);
      out[a === '--dir' ? 'dir' : 'group'] = v;
      i += 1;
    } else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

/** DSH 把工作目录编成组名的规则（实测：`/home/deploy/hupo-workspace` ⇒ `--home-deploy-hupo-workspace--`）。 */
function fmtTime(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 跳过的理由说成人话（"为什么跳过"必须说出来，不许只报个数）。 */
const SKIP_TEXT = {
  locked: '正在用着（锁着）',
  changed: '刚刚又在写（比刚才新）',
  gone: '已经不在了',
  unreadable: '读不动，不敢删',
  outside: '不在允许清的目录里',
  'no-path': '没给能核对的路径',
  'not-absolute': '路径不是绝对路径',
  error: '删失败',
};

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    nodeProcess.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const home = process.env.DSH_HOME ?? nodePath.join(nodeOs.homedir(), '.dsh');
  const root = nodePath.resolve(args.dir ?? nodePath.join(home, 'sessions'));
  const agentCwd = process.env.HUPO_AGENT_CWD ?? nodePath.join(nodeOs.homedir(), 'hupo-workspace');
  const defaultGroup = groupSlugFor(agentCwd);

  const notes = [];
  const scan = scanEntries({ root });
  const grouped = scan.entries.some((e) => e.name.includes('/'));

  // ── 选范围 ───────────────────────────────────────────────
  let entries = scan.entries;
  let scope = { mode: 'all', group: null };
  if (scan.missing) {
    notes.push(`这个目录不存在：${root}（没有东西可清，不是错）`);
    entries = [];
    scope = { mode: 'missing', group: null };
  } else if (!grouped) {
    // 根目录底下直接就是记录 ⇒ 已经指到一组里了，不再过滤
    scope = { mode: 'leaf', group: null };
  } else if (args.group) {
    entries = scan.entries.filter((e) => e.name.startsWith(`${args.group}/`));
    scope = { mode: 'group', group: args.group };
    if (entries.length === 0) {
      const groups = [...new Set(scan.entries.map((e) => e.name.split('/')[0]))].sort();
      notes.push(`没有「${args.group}」这一组。这台机器上有：${groups.join('、')}`);
      nodeProcess.stderr.write(`${notes.join('\n')}\n`);
      return 2;
    }
  } else if (args.allGroups) {
    scope = { mode: 'all-groups', group: null };
  } else {
    entries = scan.entries.filter((e) => e.name.startsWith(`${defaultGroup}/`));
    scope = { mode: 'group', group: defaultGroup };
    if (entries.length === 0) {
      const groups = [...new Set(scan.entries.map((e) => e.name.split('/')[0]))].sort();
      notes.push(
        `没有找到自己这一组「${defaultGroup}」（按 HUPO_AGENT_CWD=${agentCwd} 推出来的）⇒ 什么都不动。`,
      );
      if (groups.length) notes.push(`这台机器上有的组：${groups.join('、')}`);
      notes.push('要动别的组：--group <名字>；要一起动：--all-groups；也可以直接把 --dir 指到某一组。');
      entries = [];
    }
  }
  // 别的东西的目录**永远不是候选**（组目录本身不删）——由 `scanEntries` 保证
  for (const u of scan.unreadable) notes.push(`读不动，跳过了：${u.name}（${u.reason}）`);

  // ── 计划 + "真删会怎样"的预演 ─────────────────────────────
  const now = Date.now();
  const plan = planPrune({ entries, now });

  const haveFlock = spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!haveFlock && plan.remove.some((e) => e.lockPath)) {
    notes.push('这台机器上没有 flock ⇒ 没法问"这一份现在有人在用吗"，只按 mtime 判断。');
  }
  const isLocked = (lockPath) => probeLock(lockPath);
  // 预演：用**不真删**的 rm 走一遍同样的三道闸，这样"会跳过几份、为什么"在 dry-run 里也看得见
  const outcome = applyPrune(plan.remove, {
    rm: args.apply ? defaultRm : () => {},
    root,
    isLocked,
  });

  const freedBytes = outcome.removed.reduce((n, e) => n + (Number(e.sizeBytes) || 0), 0);
  // "还在用着"被跳过几份 —— 给主人那句话要说得准（真删完还说"没动它们"就是假话）
  const liveSkipped = outcome.skipped.filter((s) => s.reason === 'locked' || s.reason === 'changed').length;
  // ⚠️ "计划清几份"和"真动了几份"是**两个数**（被跳过的那些就差在这儿）。
  //    把它们混着印，屏幕上就会出现"说清 3 份、其实只动了 2 份"。
  const line = summarize(plan, {
    applied: Boolean(args.apply),
    done: { removed: outcome.removed.length, freedBytes, liveSkipped },
  });

  // ── 出结果 ───────────────────────────────────────────────
  if (args.json) {
    nodeProcess.stdout.write(
      `${JSON.stringify(
        {
          dir: root,
          scope,
          applied: Boolean(args.apply),
          scanned: plan.scanned,
          counts: {
            keep: plan.keep.length,
            remove: plan.remove.length,
            protectedRecent: plan.protectedRecent,
            protectedFloor: plan.protectedFloor,
            protectedUnknown: plan.protectedUnknown,
            unreadable: scan.unreadable.length,
          },
          bytes: { total: plan.totalBytes, freed: freedBytes },
          summary: line,
          skippedLive: liveSkipped,
          wouldRemove: outcome.removed.map((e) => ({
            name: e.name,
            path: e.path,
            sizeBytes: e.sizeBytes,
            mtime: new Date(e.mtimeMs).toISOString(),
          })),
          skipped: outcome.skipped.map((s) => ({ ...s, text: SKIP_TEXT[s.reason] ?? s.reason })),
          notes,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const lines = [];
    lines.push(`要清的根：${root}`);
    if (scope.mode === 'group') {
      lines.push(
        `范围：只动「${scope.group}」这一组` +
          (args.group ? '' : '（自己那一组；别的项目不动——要一起清加 --all-groups）'),
      );
    } else if (scope.mode === 'all-groups') {
      lines.push('范围：⚠️ 所有组（含别的项目）');
    } else if (scope.mode === 'leaf') {
      lines.push('范围：这个目录底下直接就是记录');
    }
    lines.push(`扫到 ${plan.scanned} 份记录，共 ${formatBytes(plan.totalBytes)}`);
    lines.push('');
    if (outcome.removed.length === plan.remove.length) {
      lines.push(
        args.apply
          ? `✔ 真删了 ${outcome.removed.length} 份，腾出 ${formatBytes(freedBytes)}`
          : `可以清掉 ${outcome.removed.length} 份，能腾出 ${formatBytes(freedBytes)}`,
      );
    } else {
      lines.push(`计划清掉 ${plan.remove.length} 份（能腾出 ${formatBytes(plan.freedBytes)}）`);
      lines.push(
        args.apply
          ? `✔ 真删了 ${outcome.removed.length} 份，腾出 ${formatBytes(freedBytes)}`
          : `预演：真删的话会动 ${outcome.removed.length} 份，腾出 ${formatBytes(freedBytes)}`,
      );
    }
    lines.push(
      `计划留着：${plan.keep.length} 份` +
        `（${plan.protectedRecent} 份太新、${plan.protectedFloor} 份是保底` +
        (plan.protectedUnknown ? `、${plan.protectedUnknown} 份不知道多新` : '') +
        '）',
    );
    if (outcome.skipped.length) {
      lines.push('');
      lines.push(`会跳过的：${outcome.skipped.length} 份（说了原因就别猜）`);
      for (const s of outcome.skipped) {
        lines.push(`  · ${s.name} —— ${SKIP_TEXT[s.reason] ?? s.reason}${s.detail ? `：${s.detail}` : ''}`);
      }
    }
    if (args.apply) {
      // ⚠️ 用**知道多新**的那些算最旧；"不知道多新"的（mtime 读不出来）会被留在最后，
      //    直接看 `keep.at(-1)` 会印出 1970。
      const known = plan.keep.filter((e) => Number.isFinite(e.mtimeMs));
      if (known.length) {
        const oldest = known.reduce((a, b) => (a.mtimeMs <= b.mtimeMs ? a : b));
        lines.push('');
        lines.push(`留下的最旧一份是 ${fmtTime(oldest.mtimeMs)} 的。`);
      }
    } else {
      lines.push('');
      lines.push('⚠️ 现在**没有**真删（这是默认）。要真删：再加一个 --apply');
      if (outcome.removed.length) {
        lines.push(`   真要删的话，从最旧开始，最先走的是：`);
        for (const e of outcome.removed.slice(0, 10)) {
          lines.push(`   · ${e.name}  ${formatBytes(e.sizeBytes)}  ${fmtTime(e.mtimeMs)}`);
        }
        if (outcome.removed.length > 10) {
          lines.push(`   …还有 ${outcome.removed.length - 10} 份（--json 能看全）`);
        }
      }
    }
    if (notes.length) {
      lines.push('');
      lines.push('说明：');
      for (const n of notes) lines.push(`  · ${n}`);
    }
    nodeProcess.stdout.write(`${lines.join('\n')}\n`);
    nodeProcess.stdout.write(`\n${line}\n`);
  }

  if (args.apply && outcome.skipped.some((s) => s.reason === 'error')) return 1;
  return 0;
}

// 只有直接跑才进 main（被 import 时不跑）——`groupSlugFor` 要能被复用。
if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(new URL(import.meta.url).pathname)) {
  try {
    nodeProcess.exit(main(process.argv.slice(2)));
  } catch (err) {
    nodeProcess.stderr.write(`✖ ${err?.message ?? err}\n\n${USAGE}\n`);
    nodeProcess.exit(2);
  }
}
