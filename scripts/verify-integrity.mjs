#!/usr/bin/env node
// 开机完整性清单的**唯一工具**（手册 `03-DEVELOPMENT.md` 批 6 点名要它）。
//
// 两种用法：
//
//   node scripts/verify-integrity.mjs                  # 核对（谁都能跑）
//   sudo <node 的绝对路径> scripts/verify-integrity.mjs --build   # 重建清单（**只有主人能跑**）
//
// ⚠️ **路径写死、不看环境变量**：服务是助手自己重启的，闸要是能靠环境变量关掉，
//    那就等于给助手一个关闸开关（理由写在 `integrity.js` 的文件头）。
//    下面那两个 `--baseline` / `--repo` 是给**这个工具**用的（别的机器、测试），
//    **服务本体不认它们** —— 所以拿它们骗不了服务。
//
// 退出码（**分清楚**，"只报"和"会拒绝启动"不是一回事）：
//   `0` 对上（或刚建好）· `1` 只有"只报不拦"的条目动过（服务照起）
//   `2` strict 对不上（**会拒绝启动**）· `3` 清单还没建

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeProcess from 'node:process';

import {
  BASELINE_PATH,
  buildBaseline,
  checkAgainstDisk,
  coverageGaps,
  filesUnder,
  protectedPaths,
  resolveServiceHome,
  writeBaselineFile,
} from '../v2/services/core/src/integrity.js';

const argv = nodeProcess.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const repo = nodePath.resolve(valueOf('--repo', nodePath.resolve(import.meta.dirname, '..')));
/**
 * ⚠️⚠️ **home 按"仓库属主"算，不按"现在跑这条命令的人"算。**
 *
 * 这是 2026-09-21 实测踩出来的一个**静默失效**：清单是主人用 `sudo` 建的，
 * 而 `sudo` 下 `os.homedir()` = **`/root`** ⇒ `~/.dsh/profiles` 那三条
 * 被算成 `/root/.dsh/**`，而那里一个文件都没有 ⇒ 被 `buildBaseline` **静静跳过**
 * ⇒ **P1 最核心的那条保护从来没进过清单**，而横幅照样写"对上了"。
 *
 * ⇒ 服务跑在仓库属主名下，所以清单也该按他的 home 算（`sudo` 不改变仓库属主）。
 */
const resolvedHome = resolveServiceHome({ repo });
const home = valueOf('--home', undefined) ?? resolvedHome;
const baselinePath = nodePath.resolve(valueOf('--baseline', BASELINE_PATH));

if (has('--help') || has('-h')) {
  console.log(
    [
      '用法：',
      '  node scripts/verify-integrity.mjs                    # 核对，对不上退出码 2',
      '  node scripts/verify-integrity.mjs --list             # **不用 root**：先看要钉住哪些东西',
      '  sudo <node 的绝对路径> scripts/verify-integrity.mjs --build   # 重建清单（写 /etc/hupo/integrity.json）',
      '',
      '可选（只给这个工具用，服务本体不认）：',
      '  --repo <路径>  --home <路径>  --baseline <文件>',
    ].join('\n'),
  );
  nodeProcess.exit(0);
}

const list = protectedPaths({ repo, home });

if (has('--list')) {
  // ⚠️ 这是给主人"**看一眼再签**"用的（P2 甲的安全性 = 主人真的看一眼）：
  //    不用 root、不写任何东西，只把"按下 --build 之后会被钉住的东西"列出来。
  console.log(`仓库：${repo}`);
  console.log(`按谁的 home 算：${home}${home === resolvedHome ? '（仓库属主的）' : '（--home 指定的）'}`);
  let files = 0;
  for (const e of list) {
    const under = e.kind === 'dir' ? filesUnder(e) : [e.path];
    files += under.length;
    // ⚠️ **0 个文件**的那几条要显眼：那种路径**钉了等于没钉**
    //    （2026-09-21 那个 `/root` 的坑就是它们静默跳过的）。
    const mark = under.length === 0 ? '  ⚠️ 盘上一个文件都没有 ⇒ 这条钉不住' : '';
    console.log(`[${e.mode === 'strict' ? '拦' : '报'}] ${e.path}  （${under.length} 个文件）${mark}`);
    console.log(`      ${e.why}`);
  }
  console.log(`\n合计 ${list.length} 条、${files} 个文件。`);
  console.log('拦 = 对不上就**拒绝启动**；报 = 只记一笔，服务照起。');
  console.log(`看清楚了再建：sudo ${nodeProcess.execPath} ${nodeProcess.argv[1]} --build`);
  nodeProcess.exit(0);
}


if (has('--build')) {
  // ⚠️ 拒绝非 root：清单**必须** root 所有（`root:root 0444`），
  //    否则助手自己就能改它 —— 那这道闸就没有意义（手册 P1.4）。
  if (typeof nodeProcess.getuid === 'function' && nodeProcess.getuid() !== 0) {
    console.error(
      '✗ 要 root 才能写这份清单（清单必须 root 所有，助手碰不到才作数）。\n' +
        `   请这样跑：sudo ${nodeProcess.execPath} ${nodeProcess.argv[1]} --build`,
    );
    nodeProcess.exit(2);
  }
  const baseline = buildBaseline({ repo, home, builtBy: 'root' });
  const count = Object.keys(baseline.entries).length;
  if (count === 0) {
    console.error('✗ 一个文件都没扫到 —— 路径不对？先确认 --repo 指的是这个仓库的根。');
    nodeProcess.exit(2);
  }
  // ★ **建完先反着查一遍**：有没有"声明要保护、盘上有东西、却一个条目都没进清单"的路径。
  //   ⚠️ 这几条必须**当场喊出来**：它们正是 2026-09-21 那个 `/root` 的坑的形状
  //      ——建完横幅写"建好了"，而其中几条**根本没被钉住**。
  const gaps = coverageGaps({ repo, home, baseline });
  nodeFs.mkdirSync(nodePath.dirname(baselinePath), { recursive: true, mode: 0o755 });
  writeBaselineFile(baselinePath, baseline);
  console.log(`✅ 清单建好了：${baselinePath}`);
  console.log(`   按谁的 home 算：${home}${home === resolvedHome ? '（仓库属主的）' : '（--home 指定的）'}`);
  console.log(`   ${count} 个文件 · 只读 ${(0o444).toString(8)} · ${new Date(baseline.builtAt).toISOString()}`);
  console.log('   覆盖：');
  for (const e of list) console.log(`     · ${e.path}  [${e.mode}]  ${e.why}`);
  if (gaps.length > 0) {
    console.error(`\n✗ **有 ${gaps.length} 条声明要保护、却一个条目都没进清单**：`);
    for (const g of gaps) console.error(`   [${g.mode}] ${g.path}（盘上 ${g.onDisk} 个文件）—— ${g.why}`);
    console.error('   ⇒ 这几条**等于没有闸**。多半是 home 算错了（见 resolveServiceHome 的说明）。');
    nodeProcess.exit(2);
  }
  console.log('\n▶ 现在重启服务，让它按这份清单核对：');
  console.log('     scripts/restart-core.sh');
  nodeProcess.exit(0);
}

const r = checkAgainstDisk({ repo, home, baselinePath });

if (r.state === 'absent') {
  console.log(`⚠️ 清单还没建：${baselinePath}`);
  console.log('   ⇒ **P1 那条保护现在是没有的**（服务照跑，但没人核对开机读的东西）。');
  console.log('   ⇒ 建一次（要 root）：');
  console.log(`        sudo ${nodeProcess.execPath} ${nodeProcess.argv[1]} --build`);
  nodeProcess.exit(3);
}

const total = Object.keys(r.changed).length;
const gaps = r.gaps ?? [];
if (r.state === 'ok' && gaps.length === 0) {
  console.log(`✅ 对上了：${baselinePath}`);
  console.log(`   按谁的 home 算：${home}${home === resolvedHome ? '（仓库属主的）' : '（--home 指定的）'}`);
  console.log('   开机自动读的那些东西，一个都没被动过；声明要保护的路径也**一条都没漏**。');
  nodeProcess.exit(0);
}

if (gaps.length > 0) {
  console.error(`✗ **清单漏了 ${gaps.length} 条**（声明要保护、盘上有东西、清单里却没有）：`);
  for (const g of gaps) {
    console.error(`   [${g.mode === 'strict' ? '拦' : '报'}] ${g.path}（盘上 ${g.onDisk} 个文件）—— ${g.why}`);
  }
  console.error('   ⇒ 这几条**等于没有闸**（"写着有、其实没在核对"，比不设更坏）。');
  console.error(`   ⇒ 重建：sudo ${nodeProcess.execPath} ${nodeProcess.argv[1]} --build`);
}

if (r.state === 'ok') {
  // 只有"漏"（没有"变了"）：strict 的那几条照样算会拒绝启动
  nodeProcess.exit(gaps.some((g) => g.mode === 'strict') ? 2 : 1);
}

console.log(`✗ 对不上：${baselinePath}`);
console.log(`   ${total} 处：${r.blocked.length} 处会**拒绝启动**，${r.warnings.length} 处只报。`);
for (const c of r.blocked) console.log(`   [拦] ${c.file} —— ${c.what}（${c.why}）`);
for (const c of r.warnings) console.log(`   [报] ${c.file} —— ${c.what}（${c.why}）`);
console.log('\n▶ 怎么收拾：');
console.log(`   · 是你自己（或主人）刚改的  ⇒ sudo ${nodeProcess.execPath} ${nodeProcess.argv[1]} --build`);
console.log('   · 不是你改的                ⇒ git revert 那一次改动，或把文件改回去');
if (r.blocked.length === 0 && !gaps.some((g) => g.mode === 'strict')) {
  console.log('   （只有"只报不拦"的条目动过 ⇒ **服务照常起**，但要知道这件事）');
  nodeProcess.exit(1);
}
nodeProcess.exit(2);
