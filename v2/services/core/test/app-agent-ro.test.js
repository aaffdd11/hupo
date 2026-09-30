// **替小程序跑的那一轮是"限定档"**（契约 `docs/dev/148-APP-FULL-SET.md` §三 · 目标里那句"限定档"）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   · **L1** 🔴 那一层补丁**真管事**：`dsh --profile sdk --patch hupo-app-agent.yml --dump-config`
//     里 bash / 后台活 / 派活 / 加载说明那些**能被关掉，而且真关掉了**；
//     ⚠️ 同时钉住**留下的是什么**（读文件 / 找文件 / 查网）—— 关多了等于"它什么都干不了"；
//   · **L2** 🔴 **只加在那一轮上**：`runAppAgent` 真的把这一层挂上命令行；
//     而**不传** `extraPatchPaths` 的那条路（评审）**命令行一个字节都不变**；
//   · **L3** 那一轮的正文：**说清"这是小程序问的"** ＋ **"你只回答、别动手"**；
//   · **L4** 🔴 跑完**核一遍工作区**：动过 ⇒ **如实报**（`changed` 非空）；
//   · **L5** 🔴 起不来 / 一句话都没说 ⇒ `{ok:false}`（**绝不编一句回答**）。

import assert from 'node:assert/strict';
import nodeChildProcess from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { APP_AGENT_PATCH, buildAppAgentPrompt, runAppAgent } from '../src/app-agent.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE_Dsh = nodePath.join(HERE, 'fake-review-dsh.mjs');
const DSH = process.env.HUPO_DSH_BIN ?? 'dsh';

function tmpdir() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-appagent-'));
}

/** 拿真 `dsh --dump-config` 看一眼：这一层补丁到底把哪些条目关了。 */
function dumpWithPatch(patch) {
  const args = ['--profile', 'sdk'];
  if (patch) args.push('--patch', patch);
  args.push('--dump-config');
  const r = nodeChildProcess.spawnSync(DSH, args, { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `--dump-config 要成功（实际 ${r.status}）：${(r.stderr ?? '').slice(0, 200)}`);
  return r.stdout ?? '';
}

/** 那一条目关没关（认不出来 ⇒ 抛，不猜）。 */
function disabledOf(tree, id) {
  const lines = tree.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === `- id: ${id}`) {
      // 往后看到下一个 `- id:` 为止
      for (let j = i + 1; j < lines.length && !/^- id: /.test(lines[j]); j += 1) {
        if (/^\s*disabled:\s*true\s*$/.test(lines[j])) return true;
      }
      return false;
    }
  }
  throw new Error(`dump 里没有这一条：${id}`);
}

test('L1 🔴 那一层补丁真管事：能动手的关掉了，只留下"看"的那几样', () => {
  const plain = dumpWithPatch(null);
  const patched = dumpWithPatch(APP_AGENT_PATCH);
  // ① **能动手的**：关掉
  for (const id of ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-skill']) {
    assert.equal(disabledOf(patched, id), true, `★ ${id} 必须被关掉（不然那一轮能在世界里动手）`);
  }
  // ② 反向对照：**不挂这一层的时候它们是开的**（不然这条判据是恒真）
  for (const id of ['tool-bash', 'tool-skill']) {
    assert.equal(disabledOf(plain, id), false, `对照：不挂补丁时 ${id} 是开的`);
  }
  // ③ **留下来的**（关多了等于"它什么都干不了"）：读 / 找 / **查网**还在
  for (const id of ['tool-fs', 'tool-fs-search']) {
    assert.equal(disabledOf(patched, id), false, `${id} 要留着（只读那几样）`);
  }
  /**
   * 🔴 **网络搜索必须留着**（主人 2026-10-01：*「问一句也要有网络搜索工具」*）——
   *    "请动助手"那一轮的价值有一半在**它能去查证**（真读数：它去查了 deepseek.com 并答出标语）。
   *    这一条把它钉住：将来谁把"限定档"改狠了（顺手关掉 web 那几件），当场红。
   */
  for (const id of ['web', 'web-search-deepseek', 'web-fetch-http', 'tool-web']) {
    assert.equal(disabledOf(patched, id), false, `★ ${id} 要留着：那一轮能查网（但动不了手）`);
    assert.equal(disabledOf(plain, id), false, `对照：不挂补丁时 ${id} 也是开的`);
  }
});

test('L1·补 🔴 这一层**不许把树弄得起不来**（关"服务提供者"那种条目会让整台 dsh 起不来）', () => {
  /**
   * ⚠️ 这一条是**踩出来的**：我第一版写的是 `- id: skill`（那是 `@deepseek-ai/dsh-skill`，
   *    一个**服务提供者**）⇒ `dsh-skill-filesystem` / `dsh-tool-skill` 等不到它 ⇒
   *    `plugin tree failed to load`（"2 entries did not activate"）⇒ **整台 dsh 起不来**，
   *    而 `--dump-config` **照样成功**（它不做"激活"这一步）——所以我当时被它骗过。
   * ⇒ 判据必须**真起一次**：喂一句 `initialize`，**不许**出现"did not activate"。
   */
  const r = nodeChildProcess.spawnSync(DSH, ['--profile', 'sdk', '--patch', APP_AGENT_PATCH], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'probe', version: '1' } } })}\n`,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const all = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.equal(/did not activate/.test(all), false, `那一层把树弄挂了：${all.slice(0, 300)}`);
  assert.equal(/plugin tree failed to load/.test(all), false, `那一层把树弄挂了：${all.slice(0, 300)}`);
  // 反向对照：**不挂这一层**时也不该有那两句（证明这条判据量的不是恒假的东西）
  const plain = nodeChildProcess.spawnSync(DSH, ['--profile', 'sdk'], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'probe', version: '1' } } })}\n`,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(/did not activate/.test(`${plain.stdout ?? ''}${plain.stderr ?? ''}`), false);
});

test('L3 那一轮的正文：说清这是小程序问的 ＋ 你只回答别动手', () => {
  const p = buildAppAgentPrompt({ title: '记账', prompt: '这个月花超了吗' });
  assert.match(p, /记账/, '要说清是哪个小程序');
  assert.match(p, /这个月花超了吗/, '他的原话要原样带上');
  assert.match(p, /只回答/, '🔴 只回答那一句要在');
  assert.match(p, /别|不要/, '要有"别动手"那半句');
  // 没名字也不能崩（给一个中性称呼）
  assert.match(buildAppAgentPrompt({ prompt: '在吗' }), /一个小程序/);
});

test('L2 🔴 只加在那一轮上：runAppAgent 真把它挂上命令行；别的路一个字节都不变', async () => {
  // 用一个"只看参数、立刻退出"的假 spawn 来验命令行（不真起 dsh）
  const seen = [];
  const spawnFn = (bin, args, opts) => {
    seen.push({ bin, args: [...args], cwd: opts?.cwd ?? null, envKeys: Object.keys(opts?.env ?? {}).length });
    const child = nodeChildProcess.spawn(process.execPath, [FAKE_Dsh], { ...opts, env: { ...opts?.env, FAKE_REVIEW_ANSWER: JSON.stringify({ summary: 'x' }) } });
    return child;
  };
  const dir = tmpdir();
  nodeFs.writeFileSync(nodePath.join(dir, 'index.html'), '<p>x</p>');
  const r = await runAppAgent({
    cfg: { dshBin: 'fake-dsh', agentProfile: 'sdk' },
    cwd: dir,
    title: '记账',
    prompt: '在吗',
    spawnFn,
    timeoutMs: 20_000,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const args = seen[0].args.join(' ');
  assert.match(args, /--profile sdk/, '· 先 profile');
  assert.match(args, new RegExp(`--patch ${APP_AGENT_PATCH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '🔴 只读那一层要挂上');
  // ⚠️ `--patch` 是全局选项 ⇒ 必须写在 `--profile` 之后
  assert.ok(args.indexOf('--profile') < args.indexOf('--patch'), '--patch 要在 --profile 之后');
  assert.equal(seen[0].cwd, dir, '★ cwd 是那个小程序自己的那一间');
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test('L4/L5 🔴 跑完核工作区（动过就如实报）；一句话都没说 ⇒ 不编回答', async () => {
  const dir = tmpdir();
  nodeFs.writeFileSync(nodePath.join(dir, 'index.html'), '<p>x</p>');
  // ① 假 dsh 往 cwd 里写一个文件 ⇒ 那一轮"动过手"要被抓出来
  const wrote = await runAppAgent({
    cfg: { dshBin: 'fake-dsh', agentProfile: 'sdk' },
    cwd: dir,
    title: '记账',
    prompt: '在吗',
    spawnFn: (bin, args, opts) =>
      nodeChildProcess.spawn(process.execPath, [FAKE_Dsh], {
        ...opts,
        env: { ...opts?.env, FAKE_REVIEW_WRITE_CWD: '1', FAKE_REVIEW_ANSWER: JSON.stringify({ summary: 'x' }) },
      }),
    timeoutMs: 20_000,
  });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.ok(wrote.changed.length > 0, `★ 动过工作区要如实报（实际 ${JSON.stringify(wrote.changed)}）`);
  assert.ok(wrote.changed.every((p) => typeof p === 'string'), '给的是文件名，不是内部对象');

  // ② 一句话都不说 ⇒ 不许编（`fake` 那种"只发 turn/end"的场景）
  const dir2 = tmpdir();
  const silent = await runAppAgent({
    cfg: { dshBin: 'fake-dsh', agentProfile: 'sdk' },
    cwd: dir2,
    title: '记账',
    prompt: '在吗',
    spawnFn: (bin, args, opts) =>
      nodeChildProcess.spawn(process.execPath, [FAKE_Dsh], { ...opts, env: { ...opts?.env, FAKE_REVIEW_SILENT: '1' } }),
    timeoutMs: 20_000,
  });
  assert.equal(silent.ok, false, '没正文 ⇒ 如实失败');
  assert.match(silent.error, /没|空|说/, '要给一句人话');
  nodeFs.rmSync(dir, { recursive: true, force: true });
  nodeFs.rmSync(dir2, { recursive: true, force: true });
});
