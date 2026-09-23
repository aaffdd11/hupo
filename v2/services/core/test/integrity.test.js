// **P1：助手不能改自己** —— 开机完整性清单。
//
// 手册依据：`05-DECISIONS.md` **P1.2 / P1.4** · `06-OPERATIONS.md` §3.2 第 4 条 ·
// `04-ROADMAP.md` 批 6「P1 能力收回」· 判据 `08-SPEC.md` §13.3。
//
// ⚠️ 这一份钉的三条，一条比一条重要：
//
//   1. **strict 对不上 ⇒ 拒绝启动**（P1.4 明写：拒绝启动 + 报警）
//   2. **清单"不在"不许等于"没事"**。它必须**大声**说出来 ——
//      悄悄过去就是"看起来有闸、其实没有"，那比不设闸更坏
//      （这个项目已经栽过三次"页面在说假话"，这是同一类）
//   3. **`mode` 住在清单文件里**（root 所有），不在代码里 ——
//      所以助手**改不了自己那一档**。这一条要用测试证明它成立。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/** test → core → services → v2 → 仓库根 */
const REPO = nodePath.resolve(import.meta.dirname, '../../../..');

import {
  buildBaseline,
  checkAgainstDisk,
  coverageGaps,
  filesUnder,
  hashFile,
  homeFromPasswd,
  integrityReport,
  protectedPaths,
  rebuildCommand,
  repoRootFor,
  resolveServiceHome,
  verifyBaseline,
} from '../src/integrity.js';

/** 造一棵"像这个仓库"的最小树 + 一个假的 home。 */
function fixture() {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-intg-'));
  const repo = nodePath.join(root, 'repo');
  const home = nodePath.join(root, 'home');
  const write = (rel, body) => {
    const f = nodePath.join(repo, rel);
    nodeFs.mkdirSync(nodePath.dirname(f), { recursive: true });
    nodeFs.writeFileSync(f, body);
    return f;
  };
  write('AGENTS.md', '说明书\n');
  write('v2/services/core/hupo-persona.yml', 'persona: 琥珀\n');
  write('v2/services/core/src/serve.js', '// 调度器\n');
  write('v2/services/core/src/config.js', '// 配置\n');
  write('scripts/restart-core.sh', '#!/bin/bash\n');
  write('docs/handbook/08-SPEC.md', '判据\n');
  write('v2/services/core/data/auth.json', '{"hash":"x"}\n');

  const w = (rel, body) => {
    const f = nodePath.join(home, '.dsh', rel);
    nodeFs.mkdirSync(nodePath.dirname(f), { recursive: true });
    nodeFs.writeFileSync(f, body);
    return f;
  };
  w('settings.yaml', 'agent-default-model: x\n');
  w('.credentials.yaml', 'key: sk-test\n');
  w('profiles/sdk/cordis.patch.yml', 'patch: 1\n');
  w('storages/kv.json', '{"a":1}\n');
  // ⚠️ 运行时数据不算清单：sessions 永远不进
  w('sessions/s1/log.jsonl', '{}\n');

  const cleanup = () => nodeFs.rmSync(root, { recursive: true, force: true });
  return { root, repo, home, write, w, cleanup, baselinePath: nodePath.join(root, 'baseline.json') };
}

test('对上了 ⇒ ok，而且一条问题都没有', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    const r = verifyBaseline({ baseline });
    assert.equal(r.state, 'ok');
    assert.equal(r.blocked.length, 0);
    assert.ok(r.count > 5, `清单太小了：${r.count}`);
  } finally {
    f.cleanup();
  }
});

// ── ★ P1-15：清单**按谁的 home** 建的（2026-09-24）────────────
//
// 这一组守的是**同一个静默失效的另一半**：清单里存的是**绝对路径**，
// 所以"换一个 home"之后**逐条 hash 照样全绿** —— 变的只是
// `coverageGaps()` 问的那句"盘上有没有东西"：新 home 底下空空 ⇒ 一条漏都不报。
// ⇒ 那就是"横幅写对上了、而 P1 那几条根本没在核"。

test('清单里**记着**它是按谁的 home 建的（不记就查不出"换了 home"）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    assert.equal(baseline.home, f.home, '★ 建清单时要把 home 记下来');
  } finally {
    f.cleanup();
  }
});

test('🔴 换了 home ⇒ **大声说**那几条没在核（而且不许写成"对上了"）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    nodeFs.writeFileSync(f.baselinePath, JSON.stringify(baseline));
    // 现在按**另一个** home 算（管理员用 sudo 起服务、或者换了账号跑）
    const other = nodePath.join(f.root, 'root-home');
    nodeFs.mkdirSync(nodePath.join(other, '.dsh'), { recursive: true });
    const ig = integrityReport({ repo: f.repo, home: other, baselinePath: f.baselinePath });

    assert.equal(ig.state, 'ok', '逐条 hash 是过的 —— 这恰恰是危险的地方');
    assert.equal(ig.identity.mismatch, true);
    const said = ig.notes.join('\n');
    assert.match(said, /没在核对/, `要说清"那几条没在核"：${said}`);
    assert.ok(said.includes(f.home), '要点名清单是按哪个 home 建的');
    assert.ok(said.includes(other), '要点名现在按哪个 home 算');
  } finally {
    f.cleanup();
  }
});

test('同一个 home ⇒ **不许多那句**（负向对照：不然那句话永远是响的）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    nodeFs.writeFileSync(f.baselinePath, JSON.stringify(baseline));
    const ig = integrityReport({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    assert.equal(ig.identity.mismatch, false);
    assert.doesNotMatch(ig.notes.join('\n'), /没在核对/, '同一个 home 不许报这一条');
  } finally {
    f.cleanup();
  }
});

test('老清单（里面**没有** home 这个字段）⇒ 不算不一致（不许拿"没记"当"不一样"）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    delete baseline.home;
    nodeFs.writeFileSync(f.baselinePath, JSON.stringify(baseline));
    const ig = integrityReport({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    assert.equal(ig.identity.mismatch, false);
    assert.equal(ig.identity.builtWith, null);
    // ⚠️ 措辞也不许吹：没记 ⇒ 只能说"按谁算"，**不能说**"清单就是按它建的"
    assert.match(ig.notes.join('\n'), /没记.*按谁的 home 建/);
    assert.doesNotMatch(ig.notes.join('\n'), /清单也是按它建的/);
  } finally {
    f.cleanup();
  }
});

test('🔴 `serve.js` 里**不许**再出现 `os.homedir()`（身份只住 `resolveServiceHome` 一处）', () => {
  // 变异验证过的那一类：把 `home: serviceHome` 换回 `nodeOs.homedir()` ⇒
  // `sudo` 起服务时算的是 `/root`，而那几条 `~/.dsh/**` 是**按仓库属主**建的 ⇒ 静默不核。
  const src = nodeFs.readFileSync(REPO + '/v2/services/core/src/serve.js', 'utf8');
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /homedir\(\)/, '★ serve.js 里不许自己算 home'); 
  assert.match(code, /resolveServiceHome\(/, '要用那一处身份');
});

// ── ★ P1-15 的另一半：**明说"接受的风险"**（2026-09-24）──────────
//
// 有两类东西**故意不在清单里**（运行时数据 / 天天在长的用户数据）。
// 那是一个**取舍**，不是"漏了" —— 而取舍**必须写下来**，否则下一个人
// 会当成漏项去"修"（把它加进去 ⇒ 服务天天拒绝启动）。
// ⇒ 这一组判据两头都盯：**清单里确实没有这些路径** ＋ **两边文档都写着这件事**。

test('🔴 运行时数据与账本**确实不在清单里**（负向对照：别哪天被人"顺手补上"）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    const files = Object.keys(baseline.entries);
    assert.equal(files.some((x) => x.includes('/.dsh/storages/')), false,
      '★ `~/.dsh/storages/**` 不许进清单（agent 每轮都在写它）');
    assert.equal(files.some((x) => x.endsWith('data/ledger.jsonl')), false,
      '★ 账本不许进清单（每一笔都在写它）');
    // 负向对照：同一个 fixture 里**该在的**确实在（证明上面两条不是因为"清单是空的"）
    assert.equal(files.some((x) => x.endsWith('data/auth.json')), true);
    assert.equal(files.some((x) => x.includes('/.dsh/profiles/')), true);
  } finally {
    f.cleanup();
  }
});

test('🔴 这两条**接受的风险**两边都得写着（代码里 ＋ `19-P1-P2.md` §七）', () => {
  // 为什么非要这条：取舍写在代码注释里、而文档表里没有（2026-09-24 实测就是这样），
  // 下一个读文档的人会以为它是漏项。⇒ 两边都写着，谁删了一边这里就红。
  const code = nodeFs.readFileSync(REPO + '/v2/services/core/src/integrity.js', 'utf8');
  assert.match(code, /storages[\s\S]{0,400}?故意不在清单里/, '代码里要写清"storages 是故意不进的"');
  assert.match(code, /ledger\.jsonl[\s\S]{0,400}?故意不在清单里/, '代码里要写清"账本也是故意不进的"');

  const doc = nodeFs.readFileSync(REPO + '/docs/dev/19-P1-P2.md', 'utf8');
  const seven = doc.slice(doc.indexOf('## 七、'));
  assert.match(seven, /storages/, '`19-P1-P2.md` §七 要有 storages 那条');
  assert.match(seven, /ledger\.jsonl/, '`19-P1-P2.md` §七 要有账本那条');
});

// ── ★ 2026-09-21 那个**静默失效**（清单漏了一整类路径）──────────
//
// 实测踩到的形状：清单是主人用 `sudo` 建的，而 `sudo` 下 `os.homedir()` = `/root`
// ⇒ `~/.dsh/profiles` 那三条算成了 `/root/.dsh/**`，那里一个文件都没有
// ⇒ 被**静静跳过** ⇒ **P1 最核心的那条保护从来没进过清单**，而横幅写"对上了"。
// ⇒ 这一组闸守的就是"**不许再静默**"。

test('`homeFromPasswd`：按 uid 取 home（纯函数）', () => {
  const text = 'root:x:0:0:root:/root:/bin/bash\ndeploy:x:1001:1001::/home/deploy:/bin/bash\n';
  assert.equal(homeFromPasswd(text, 0), '/root');
  assert.equal(homeFromPasswd(text, 1001), '/home/deploy');
  assert.equal(homeFromPasswd(text, 4242), null);
  assert.equal(homeFromPasswd('', 1001), null);
  assert.equal(homeFromPasswd('坏行\n', 1001), null);
});

test('🔴 清单按**仓库属主**的 home 算，不按"现在跑命令的人"（sudo 下是 /root）', () => {
  const f = fixture();
  try {
    // fixture 的仓库属主就是当前用户 ⇒ 解析出来必须是**当前用户的 home**
    assert.equal(resolveServiceHome({ repo: f.repo }), nodeOs.homedir());
    // 兜底：仓库不存在时不许抛，退给调用方给的值
    assert.equal(resolveServiceHome({ repo: '/definitely/not/here', fallback: '/x' }), '/x');
  } finally {
    f.cleanup();
  }
});

test('🔴 声明要保护、盘上有东西、清单里却一条都没有 ⇒ **算漏**（这就是那个坑）', () => {
  const f = fixture();
  try {
    // 造一份**漏掉 home 那一类**的清单（正是 sudo 建出来的那种）
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    for (const k of Object.keys(baseline.entries)) {
      if (k.startsWith(f.home)) delete baseline.entries[k];
    }
    const gaps = coverageGaps({ repo: f.repo, home: f.home, baseline });
    const paths = gaps.map((g) => g.path);
    assert.ok(paths.includes(nodePath.join(f.home, '.dsh', 'profiles')), `没查出 profile 那一类：${paths}`);
    assert.ok(paths.includes(nodePath.join(f.home, '.dsh', 'settings.yaml')));
    assert.equal(paths.some((p) => p.includes('storages')), false, '运行时数据本来就不该在清单里，别误报');
  } finally {
    f.cleanup();
  }
});

test('清单**完整**时 ⇒ 一条漏都没有（负向对照：不然上面那条永远绿）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    assert.deepEqual(coverageGaps({ repo: f.repo, home: f.home, baseline }), []);
  } finally {
    f.cleanup();
  }
});

test('🔴 **新加的文件**也要算漏（第二次实测踩到的那一类）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    // 建完清单之后**又加了一个脚本** —— 这正是 2026-09-21 那次"横幅照样对上了"的形状
    const extra = f.write('scripts/check-something.sh', '#!/bin/bash\n');
    const gaps = coverageGaps({ repo: f.repo, home: f.home, baseline });
    const scripts = gaps.find((g) => g.path === nodePath.join(f.repo, 'scripts'));
    assert.ok(scripts, `没查出 scripts 下多了一个文件：${JSON.stringify(gaps.map((g) => g.path))}`);
    assert.equal(scripts.kind, 'files', '是"落了单"不是"整条没有"');
    assert.deepEqual(scripts.missing, [extra]);
    assert.equal(scripts.mode, 'report', 'scripts/ 是只报不拦');

    // ★ 重建之后就不该再有漏（负向对照）
    const again = buildBaseline({ repo: f.repo, home: f.home });
    assert.deepEqual(coverageGaps({ repo: f.repo, home: f.home, baseline: again }), []);
  } finally {
    f.cleanup();
  }
});

test('🔴 受保护目录里**新加的文件**算"落单"；单文件那类没有"新增"这回事', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    // 往 strict 的目录里新加一个文件
    const extra = f.write('docs/handbook/09-NEW.md', '新判据\n');
    const gaps = coverageGaps({ repo: f.repo, home: f.home, baseline });
    const hb = gaps.find((g) => g.path === nodePath.join(f.repo, 'docs', 'handbook'));
    assert.ok(hb, 'handbook 下多了文件要报');
    assert.equal(hb.mode, 'strict', '它是拦的那一档');
    assert.equal(hb.kind, 'files');
    assert.deepEqual(hb.missing, [extra]);

    // 单文件那几条：改内容会被 hash 抓到，但**没有"新增"**这回事 ⇒ 不出现在 gaps 里
    for (const g of gaps) {
      assert.ok(!g.path.endsWith('AGENTS.md'), 'AGENTS.md 是单文件，不该出在"漏"里');
    }
  } finally {
    f.cleanup();
  }
});

test('🔴 落单的是 strict ⇒ 开机**拒绝启动**；report ⇒ 只提醒', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    f.write('docs/handbook/09-NEW.md', '新判据\n');   // strict 目录
    f.write('scripts/check-new.sh', '#!/bin/bash\n'); // report 目录
    nodeFs.writeFileSync(f.baselinePath, `${JSON.stringify(baseline)}\n`);
    const rep = integrityReport({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    assert.ok(rep.problems.some((p) => p.includes('docs/handbook')), `strict 的漏要拦：${rep.problems.join('\n')}`);
    assert.ok(rep.notes.some((n) => n.includes('scripts')), `report 的漏只提醒：${rep.notes.join('\n')}`);
  } finally {
    f.cleanup();
  }
});

test('🔴 漏掉的是 strict ⇒ 开机**拒绝启动**（"写着有闸、其实没核对"比不设更坏）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    for (const k of Object.keys(baseline.entries)) {
      if (k.startsWith(f.home)) delete baseline.entries[k];
    }
    nodeFs.writeFileSync(f.baselinePath, `${JSON.stringify(baseline)}\n`);
    const rep = integrityReport({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    assert.ok(rep.problems.some((p) => p.includes('漏了')), rep.problems.join('\n'));
    assert.ok(rep.problems.some((p) => p.includes('.dsh')), '要点名是哪一条路径');
  } finally {
    f.cleanup();
  }
});

test('开机核对时**也会**做那一次反向检查（不只 `--build` 时查）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    nodeFs.writeFileSync(f.baselinePath, `${JSON.stringify(baseline)}\n`);
    const r = checkAgainstDisk({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    assert.deepEqual(r.gaps, [], '完整清单 ⇒ 没有漏');
    for (const k of Object.keys(baseline.entries)) {
      if (k.startsWith(f.home)) delete baseline.entries[k];
    }
    nodeFs.writeFileSync(f.baselinePath, `${JSON.stringify(baseline)}\n`);
    const r2 = checkAgainstDisk({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    assert.ok(r2.gaps.length > 0, '漏了就要看得见');
  } finally {
    f.cleanup();
  }
});

test('🔴 strict 条目被改过 ⇒ **拒绝启动**，并点名是哪个文件', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    const persona = nodePath.join(f.repo, 'v2/services/core/hupo-persona.yml');
    nodeFs.writeFileSync(persona, 'persona: 换个性格\n');

    const rep = integrityReport({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    // 走磁盘那条路：先把清单写下来
    nodeFs.writeFileSync(f.baselinePath, JSON.stringify(baseline));
    const rep2 = integrityReport({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    assert.equal(rep2.state, 'tampered');
    assert.equal(rep2.problems.length, 1);
    assert.match(rep2.problems[0], /hupo-persona\.yml/, '必须点名是哪个文件');
    assert.match(rep2.problems[0], /内容变了/);
    // ⚠️ 话说清楚"怎么收拾"：一条 rebuild、一条 revert
    assert.match(rep2.problems[0], /verify-integrity\.mjs --build/);
    assert.match(rep2.problems[0], /git revert/);
    assert.equal(rep.state, 'absent', '清单还没写下去的时候应当是"还没建"');
  } finally {
    f.cleanup();
  }
});

test('🔴 文件被删了 ⇒ 也算对不上（"不在了"和"变了"都要报）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    // 用一个 strict 条目（手册判据）：删了它必须**拦**
    nodeFs.rmSync(nodePath.join(f.repo, 'docs/handbook/08-SPEC.md'));
    const r = verifyBaseline({ baseline });
    assert.equal(r.state, 'tampered');
    assert.equal(r.blocked.length, 1);
    assert.match(r.blocked[0].what, /不在了/);
  } finally {
    f.cleanup();
  }
});

test('🔴 清单**不在** ⇒ 服务能起，但必须**大声说**它没启用（不许悄悄过去）', () => {
  const f = fixture();
  try {
    const rep = integrityReport({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    assert.equal(rep.state, 'absent');
    assert.deepEqual(rep.problems, [], '清单没建不该拦住服务 —— 那是"还没启用"，不是"对不上"');
    assert.equal(rep.notes.length, 1, '**必须**有一条提醒；悄悄过去就等于看起来有闸');
    assert.match(rep.notes[0], /还没启用|还没建/);
    assert.match(rep.notes[0], /verify-integrity\.mjs --build/, '要给出那一条命令');
  } finally {
    f.cleanup();
  }
});

test('🔴 清单自己坏了（不是合法 JSON）⇒ **当成对不上**，不许当成"没有"', () => {
  const f = fixture();
  try {
    nodeFs.writeFileSync(f.baselinePath, '这不是 JSON');
    const r = checkAgainstDisk({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    assert.equal(r.state, 'tampered');
    assert.equal(r.blocked.length, 1);
    assert.match(r.blocked[0].what, /读不出|不是合法/);
  } finally {
    f.cleanup();
  }
});

test('🔴 空清单不是"全都对"，是"什么都没查"', () => {
  const r = verifyBaseline({ baseline: { version: 1, entries: {} } });
  assert.equal(r.state, 'tampered');
  assert.match(r.blocked[0].what, /一个条目都没有/);
});

test('report 条目被动过 ⇒ 只报，**不拦**（换口令不该让服务起不来）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    nodeFs.writeFileSync(nodePath.join(f.repo, 'v2/services/core/data/auth.json'), '{"hash":"y"}');
    nodeFs.writeFileSync(f.baselinePath, JSON.stringify(baseline));
    const rep = integrityReport({ repo: f.repo, home: f.home, baselinePath: f.baselinePath });
    assert.deepEqual(rep.problems, [], '换口令是主人的正常动作');
    assert.equal(rep.warnings.length, 1);
    // ⚠️ 盯的是"**恰好一条**说它"，不盯"总共几条"：启动横幅还会说别的
    //    （比如 P1-15 那条"清单按谁的 home 算"）—— 写死总数 ⇒ 加一条提示就假红。
    const said = rep.notes.filter((n) => /只报不拦/.test(n));
    assert.equal(said.length, 1, `要**恰好一条**"只报不拦"：${rep.notes.join(' | ')}`);
  } finally {
    f.cleanup();
  }
});

test('目录是**递归**进去的：src/ 下每个文件都要在清单里（不是只 hash 目录）', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    const keys = Object.keys(baseline.entries);
    assert.ok(keys.includes(nodePath.join(f.repo, 'v2/services/core/src/serve.js')));
    assert.ok(keys.includes(nodePath.join(f.repo, 'v2/services/core/src/config.js')));
    assert.ok(keys.includes(nodePath.join(f.home, '.dsh/profiles/sdk/cordis.patch.yml')));
    // ⚠️ 运行时数据不进清单（40M 的 sessions 每次开机 hash 一遍是自找麻烦）
    assert.ok(
      !keys.some((k) => k.includes('/sessions/')),
      'sessions 是运行时数据，不该进清单',
    );
  } finally {
    f.cleanup();
  }
});

test('清单要**完整**：三类"开机自动读"的东西一个都不能漏', () => {
  // 判据（手册 P1.2）：只要还有一条路径能让助手的写入变成"下次开机自动读"，就没摘够。
  const list = protectedPaths({ repo: '/repo', home: '/home/u' });
  const paths = list.map((e) => e.path);
  const must = [
    '/repo/v2/services/core/src', // ① 会被执行的
    '/repo/scripts',
    '/repo/v2/services/core/hupo-persona.yml', // ② 开机喂给 agent 的
    '/repo/v2/services/core/hupo-capabilities.yml', // ② 同上：它决定模型手里有哪些工具
    '/repo/AGENTS.md',
    '/home/u/.dsh/profiles',
    '/home/u/.dsh/settings.yaml',
    '/home/u/.dsh/.credentials.yaml',
    '/repo/docs/handbook', // ③ 判据本身
  ];
  for (const m of must) {
    assert.ok(paths.includes(m), `清单漏了：${m}（P1.2 的判据是"一条路径都不许剩"）`);
  }
  // 每条都要写清为什么（不然下一个人会把它删掉）
  for (const e of list) {
    assert.ok(e.why && e.why.length > 4, `${e.path} 没写"为什么"`);
    assert.ok(['strict', 'report'].includes(e.mode), `${e.path} 的 mode 不合法：${e.mode}`);
  }
});

test('🔴 `mode` 住在**清单文件**里 ⇒ 助手改不了自己那一档', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    const persona = nodePath.join(f.repo, 'v2/services/core/hupo-persona.yml');
    nodeFs.writeFileSync(persona, 'persona: 换个性格\n');

    // 同一份磁盘状态，把那条的 mode 改成 report ⇒ 从"拦"变成"只报"
    const relaxed = JSON.parse(JSON.stringify(baseline));
    relaxed.entries[persona].mode = 'report';
    const r1 = verifyBaseline({ baseline: relaxed });
    assert.deepEqual(r1.blocked, [], 'mode 改成 report 之后就不该拦');
    assert.equal(r1.warnings.length, 1);

    // 而**代码里**没有地方能把 strict 降级 —— 它只认清单里写的那个值
    const r2 = verifyBaseline({ baseline });
    assert.equal(r2.blocked.length, 1, '原清单（strict）必须仍然拦得住');
  } finally {
    f.cleanup();
  }
});

test('filesUnder：目录里的东西按名字排好、可重复（核对结果才可比）', () => {
  const f = fixture();
  try {
    const entry = { path: nodePath.join(f.repo, 'v2/services/core/src'), kind: 'dir' };
    const a = filesUnder(entry);
    const b = filesUnder(entry);
    assert.deepEqual(a, b, '两次遍历必须一致');
    assert.deepEqual(a, [...a].sort(), a, '要排过序');
  } finally {
    f.cleanup();
  }
});

test('hashFile：改一个字节，摘要就该变（不然那道闸就是摆设）', () => {
  const f = fixture();
  try {
    const p = nodePath.join(f.repo, 'AGENTS.md');
    const h1 = hashFile(p);
    nodeFs.writeFileSync(p, '说明书。\n');
    const h2 = hashFile(p);
    assert.notEqual(h1, h2);
    assert.equal(h2.length, 64, 'sha256 十六进制 64 位');
  } finally {
    f.cleanup();
  }
});

test('🔴 写下去的那份清单是**只读**的，而且能直接核（写盘这段必须能测）', async () => {
  const f = fixture();
  try {
    const { writeBaselineFile } = await import('../src/integrity.js');
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    const out = writeBaselineFile(f.baselinePath, baseline);
    assert.equal(out, f.baselinePath);
    const mode = nodeFs.statSync(f.baselinePath).mode & 0o777;
    assert.equal(mode, 0o444, `清单必须是只读的（现在 ${mode.toString(8)}）—— 否则谁都能改它`);
    const back = JSON.parse(nodeFs.readFileSync(f.baselinePath, 'utf8'));
    assert.equal(verifyBaseline({ baseline: back }).state, 'ok', '写下去再读回来必须仍然对得上');
    // 目录是现造出来的（第一次跑时 /etc/hupo 还不存在）
    assert.ok(nodeFs.existsSync(nodePath.dirname(f.baselinePath)));
  } finally {
    f.cleanup();
  }
});

test('🔴 不是 root 就不许建清单（清单必须 root 所有，助手碰不到才作数）', (t) => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) {
    t.skip('以 root 跑测试时这条测不了（它会真的建起来）');
    return;
  }
  const r = spawnSync('node', [nodePath.join(REPO, 'scripts/verify-integrity.mjs'), '--build'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 2, '非 root 建清单必须被拒绝');
  assert.match(r.stderr + r.stdout, /root/);
  assert.match(r.stderr + r.stdout, /sudo/, '要给出那一条命令');
});

test('真跑一次核对（清单不在时）：退出码 3，并说清"保护还没启用"', () => {
  const r = spawnSync(
    'node',
    [
      nodePath.join(REPO, 'scripts/verify-integrity.mjs'),
      '--baseline',
      nodePath.join(nodeOs.tmpdir(), 'hupo-definitely-not-here.json'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 3, '"还没建"要和"对不上"分开报（3 vs 2）');
  assert.match(r.stdout, /还没建/);
  // ⚠️ 必须是**能直接粘**的形式：node 用绝对路径（本机没有系统 node，sudo 的 PATH 里没有 nvm）
  assert.match(
    r.stdout,
    /sudo \/\S*node \S*verify-integrity\.mjs --build/,
    '给主人的命令必须是绝对路径，否则他会撞上「sudo: node：找不到命令」',
  );
});

test('🔴 主人定的那一档（2026-09-21）：**人格 / 说明书 / DSH 配置 / 手册才拦，代码与脚本只报**', () => {
  // ⚠️ 这条不是"描述现状"，是把**主人的取舍**钉住：
  //    改它 = 改这道护栏的强度 ⇒ 必须是有意为之，不能是顺手。
  const list = protectedPaths({ repo: '/repo', home: '/home/u' });
  const modeOf = (p) => list.find((e) => e.path === p)?.mode;
  const strict = [
    '/repo/v2/services/core/hupo-persona.yml', // 它是谁
    '/repo/AGENTS.md', // 它给自己的说明书
    '/home/u/.dsh/profiles', // 每轮开机读到的 profile / 补丁
    '/repo/docs/handbook', // 判据本身
  ];
  for (const p of strict) assert.equal(modeOf(p), 'strict', `${p} 必须是 strict`);
  // ⚠️ 这两条**刻意**只报：它们会被正常运行改写（记住"提示看过了" / 令牌续期），
  //    拿它们当 strict ⇒ 某天开机无故拒绝启动，而主人不在跟前。
  assert.equal(modeOf('/home/u/.dsh/settings.yaml'), 'report');
  assert.equal(modeOf('/home/u/.dsh/.credentials.yaml'), 'report');
  // 目录里只认"就是那条指令本身"的文件
  assert.deepEqual(list.find((e) => e.path === '/home/u/.dsh/profiles').only, [
    'cordis.yml',
    'cordis.patch.yml',
  ]);
  // 开发期刻意只报的那两条
  assert.equal(modeOf('/repo/v2/services/core/src'), 'report');
  assert.equal(modeOf('/repo/scripts'), 'report');
});

test('🔴 `profiles/` 只认"就是那条指令"的那两个文件（安装产物不算）', () => {
  const f = fixture();
  try {
    // 那个"就是指令本身"的文件（fixture 里默认只有补丁）
    f.w('profiles/sdk/cordis.yml', 'profile: 1\n');
    // 安装产物：`pnpm install` 会正常改写它们 ⇒ 算进来就会**无故拒绝启动**
    f.w('profiles/sdk/package.json', '{"name":"sdk"}\n');
    f.w('profiles/sdk/pnpm-workspace.yaml', 'packages: []\n');
    const baseline = buildBaseline({ repo: f.repo, home: f.home });
    const keys = Object.keys(baseline.entries);
    assert.ok(
      keys.includes(nodePath.join(f.home, '.dsh/profiles/sdk/cordis.patch.yml')),
      '补丁必须进清单（它是喂给 agent 的东西）',
    );
    assert.ok(
      keys.includes(nodePath.join(f.home, '.dsh/profiles/sdk/cordis.yml')),
      'profile 定义必须进清单',
    );
    assert.ok(
      !keys.some((k) => k.endsWith('package.json') || k.endsWith('pnpm-workspace.yaml')),
      '安装产物不该进清单',
    );
  } finally {
    f.cleanup();
  }
});

test('🔴 受保护目录里的东西**不许被静默跳过**（哪怕它叫 sessions）', () => {
  // ⚠️ 这是一次实测踩坑的回归条：`ALWAYS_SKIP` 里曾经有 `sessions` 这个名字，
  //    于是 `~/.dsh/storages/session_projcache/sessions/*.json`（1.7M）
  //    被整层静默跳过 —— 那一条在清单里"看着有"，其实只算到 1 个文件。
  const f = fixture();
  try {
    f.w('storages/session_projcache/sessions/a.json', '{"a":1}\n');
    f.w('storages/session_projcache/sessions/b.json', '{"b":2}\n');
    const list = protectedPaths({ repo: f.repo, home: f.home });
    // 直接对一个"受保护的目录"验遍历（用一个只认 json 的目录条目）
    const under = filesUnder({ path: nodePath.join(f.home, '.dsh/storages'), kind: 'dir' });
    const rel = under.map((x) => nodePath.relative(f.home, x));
    assert.ok(
      rel.some((r) => r.endsWith('sessions/a.json')) && rel.some((r) => r.endsWith('sessions/b.json')),
      `嵌套 sessions/ 下的文件被跳过了：${JSON.stringify(rel)}`,
    );
    // 而依赖目录仍然要跳过（那是真该跳的）
    f.w('storages/node_modules/x/y.json', '{}\n');
    const under2 = filesUnder({ path: nodePath.join(f.home, '.dsh/storages'), kind: 'dir' });
    assert.ok(
      !under2.some((x) => x.includes('node_modules')),
      'node_modules 该跳',
    );
    assert.ok(list.length > 0);
  } finally {
    f.cleanup();
  }
});

// ══════════════════════════════════════════════════════════════════
// 🔴 **"往上几级"只许有一处说法**（2026-09-22 栽过）
// ══════════════════════════════════════════════════════════════════
// 现象：`serve.js` 里手写成 `'../../..'` ⇒ 只到 `v2/` ⇒
//   ① **10 条受保护路径里 7 条不存在** ⇒ 开机那条"落了单的文件"闸**空转**；
//   ② 服务拒绝启动时打的那条补救命令指向**不存在的文件**。
// ⇒ 这一条钉两件事：那个 repo 底下每条受保护路径**都存在**，
//   而且**补救命令里的那个脚本真的在**。

test('🔴 `repoRootFor(src)` 指的必须是真的仓库根（每条受保护路径都在）', () => {
  const srcDir = nodePath.resolve(import.meta.dirname, '../src');
  const repo = repoRootFor(srcDir);
  // ① 仓库根的标志物
  assert.ok(
    nodeFs.existsSync(nodePath.join(repo, 'scripts/verify-integrity.mjs')),
    `repoRootFor 指错地方了：${repo}（那底下没有 scripts/verify-integrity.mjs）`,
  );
  // ② 每一条受保护路径都要真的在（**这正是那个 7/10 的毛病**）
  const ps = protectedPaths({ repo, home: nodeOs.homedir() });
  const miss = ps.filter((e) => !nodeFs.existsSync(e.path));
  assert.deepEqual(
    miss.map((e) => e.path),
    [],
    '有受保护路径在这个 repo 底下不存在 ⇒ 那条闸在**空转**',
  );
  // ③ 补救命令里那个脚本要真的在（**服务起不来时它是要被人照着跑的**）
  const cmd = rebuildCommand({ repo });
  const m = /\/\S+verify-integrity\.mjs/.exec(cmd);
  assert.ok(m, `补救命令里没有脚本路径：${cmd}`);
  assert.ok(nodeFs.existsSync(m[0]), `补救命令指向的脚本不存在：${m[0]}`);
});
