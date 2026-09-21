// **换手**：agent 的手以哪个身份跑（多租户 ②-2 · `docs/dev/39-PERMISSIONS.md` §5.2/§7.1）。
//
// ── 为什么这一条是决策 ① 的落点 ────────────────────────────
// 主人拍的 ①是"**agent 读不到自己的 key**"。而 userns 的容器 root 带着
// `CAP_DAC_OVERRIDE` ⇒ **agent 只要是 root，任何权限位都拦不住它**。
// ⇒ 所以"盒子里的服务是 root、**agent 的手是 uid 1000**"不是讲究，是那条决策的唯一实现。
//
// ── 这一份钉三件事 ────────────────────────────────────────
//   1. **不设 = 不换手**（宿主上就该这样：服务跑在 `deploy` 下，没有特权也不该有）
//      ⚠️ 负向对照：不设时 spawn 的 opts 里**一个 uid/gid 键都不许有**
//      （塞进去一个 `undefined` 或 `0` 都会悄悄改变行为）；
//   2. **设了就必须真传下去**（`1000/1000`）；
//   3. 🔴 **换不过去要大声失败**，**不许静默退回 root**
//      —— 静默退回 = 边界不在而一切看起来正常，那是本项目最忌的那种失败。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { spawn as realSpawn } from 'node:child_process';

import { DshAgent } from '../src/agent-runtime.js';
import { describeAgentIdentity, loadConfig } from '../src/config.js';

function cfg(over = {}) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-swap-'));
  return {
    dshBin: '/bin/true',
    agentProfile: 'sdk',
    agentCwd: dir,
    dshHome: dir,
    personaPath: null,
    capabilitiesPath: null,
    ledgerServerPath: null,
    ledgerSocketPath: null,
    agentUid: null,
    agentGid: null,
    ...over,
  };
}

/** 起一个假 agent，把 spawn 的 opts 记下来。 */
function spawnSpy() {
  const seen = [];
  return {
    seen,
    spawnFn: (bin, args, opts) => {
      seen.push(opts);
      // 起一个**一定不会真干活**的子进程，只为让 DshAgent 走完它那套握手
      return realSpawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
        ...opts,
        // ⚠️ 真的去换 uid 会 EPERM（deploy 没有特权）⇒ 这里**只记录，不真换**
        uid: undefined,
        gid: undefined,
      });
    },
  };
}

// ── ① 横幅那一行（如实报"手是谁"）────────────────────────────

test('★ 横幅如实报"手是谁"：没换手 / 换到 1000 / 写成了 root', () => {
  assert.match(describeAgentIdentity({ agentUid: null, agentGid: null }), /没换手/);
  assert.match(describeAgentIdentity({ agentUid: 1000, agentGid: 1000 }), /uid 1000 \/ gid 1000/);
  // 🔴 写成 0 必须**显眼**：那正是决策 ① 说的"边界不在"
  const root = describeAgentIdentity({ agentUid: 0, agentGid: 0 });
  assert.match(root, /root/);
  assert.match(root, /⚠️/, '不许把"agent 是 root"报成一句平淡的话');
});

test('★ 配置解析：没设/写错 ⇒ 不换手；`0` **是** root（不许被当成"没设"）', () => {
  const base = { ...process.env };
  delete base.HUPO_AGENT_UID;
  delete base.HUPO_AGENT_GID;
  const cwd = process.cwd();

  assert.equal(loadConfig(base, cwd).agentUid, null, '没设 ⇒ null');
  assert.equal(loadConfig({ ...base, HUPO_AGENT_UID: '' }, cwd).agentUid, null, '空串 ⇒ null');
  assert.equal(loadConfig({ ...base, HUPO_AGENT_UID: 'abc' }, cwd).agentUid, null, '写错 ⇒ null');
  assert.equal(loadConfig({ ...base, HUPO_AGENT_UID: '-1' }, cwd).agentUid, null, '负数 ⇒ null');
  assert.equal(loadConfig({ ...base, HUPO_AGENT_UID: '1000' }, cwd).agentUid, 1000);
  // ⚠️ `0` 要**原样读出来**：它是最危险的那个值，把它悄悄变成 null
  //    （= 不换手）反而会让"我明明设了 0"变成"我什么都没设"，更难查
  assert.equal(loadConfig({ ...base, HUPO_AGENT_UID: '0' }, cwd).agentUid, 0);
});

// ── ② spawn 的 opts（正 / 负两个方向）────────────────────────

test('🔴 不设 uid ⇒ spawn 的 opts 里**一个 uid/gid 键都没有**（负向对照）', async () => {
  const spy = spawnSpy();
  const agent = new DshAgent({ sessionId: 's', cfg: cfg(), spawnFn: spy.spawnFn });
  agent.start().catch(() => {});
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(spy.seen.length, 1, '应该只 spawn 一次');
  assert.equal('uid' in spy.seen[0], false, '没设就不许有这个键（宿主上必须逐字不变）');
  assert.equal('gid' in spy.seen[0], false, '没设就不许有这个键');
  await agent.dispose().catch(() => {});
});

test('★ 设了 1000/1000 ⇒ 真的传下去（换手的落点）', async () => {
  const spy = spawnSpy();
  const agent = new DshAgent({
    sessionId: 's',
    cfg: cfg({ agentUid: 1000, agentGid: 1000 }),
    spawnFn: spy.spawnFn,
  });
  agent.start().catch(() => {});
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(spy.seen[0].uid, 1000, '★ 必须真传给 spawn');
  assert.equal(spy.seen[0].gid, 1000);
  await agent.dispose().catch(() => {});
});

// ── ③ 换不过去要**大声失败**（不许静默退回 root）──────────────

test('🔴 换不过去（不存在的 uid）⇒ **报错**，不许悄悄以原身份跑起来', async () => {
  // ⚠️ 这一条**真的**让 node 去换一个不存在的 uid：
  //    `deploy` 没有特权 ⇒ `spawn` 会 EPERM。
  //    判据是"**这个失败必须冒出来**"，而不是"它被当成没配"。
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-swap-'));
  const agent = new DshAgent({
    sessionId: 's',
    cfg: {
      ...cfg({ agentCwd: dir, dshHome: dir }),
      dshBin: process.execPath,
      agentUid: 999999,
      agentGid: 999999,
    },
    // 走真 spawn（不换 opts）：EPERM 由内核给
    spawnFn: (bin, args, opts) => realSpawn(bin, args, opts),
  });

  const exits = [];
  agent.on('exit', (i) => exits.push(i));
  await assert.rejects(
    () => agent.start(),
    (err) => {
      assert.ok(err, '换不过去必须抛出来');
      return true;
    },
    '换不过去时 start() 必须失败（静默退回原身份 = 边界不在而看着正常）',
  );
  await agent.dispose().catch(() => {});
});
