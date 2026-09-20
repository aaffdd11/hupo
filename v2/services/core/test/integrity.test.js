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
  filesUnder,
  hashFile,
  integrityReport,
  protectedPaths,
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
    assert.equal(rep.notes.length, 1);
    assert.match(rep.notes[0], /只报不拦/);
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
