// **准入闸**接起来对不对（手册 `08-SPEC.md` §9.1）。
//
// ⚠️ 这一份钉的是那三件里最难验、也最容易糊弄过去的一件：
//     **拒了之后，一个字都不许落盘**（§9.1："不建空 jsonl 文件"）。
//     为什么难：拒了当然可以不写——但"拒之前先落盘再拒"在日志里**长得一模一样**，
//     而下一个人分不清 **"没收下"** 和 **"收下了但没答"**。
//     ⇒ 所以这里直接看**那个 jsonl 文件在不在**，而不是看返回值。
//
// 另外钉住第二条：**重发（duplicate）永远不许被拒** —— 那一句早就落盘了，
// 拿"忙"拒它会让界面显示"没发出去"而服务端其实收下了。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { Auth } from '../src/auth.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { createServer } from '../src/server.js';

const PASSWORD = '正确的密码啦';

/** 起一个真监听；`mode` 可以中途改（`ok` / `busy`）。 */
async function boot() {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-busy-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword(PASSWORD);
  const say = new SayService({ timeline, store, timelineId: 'main' });

  const state = { mode: 'ok' };
  const { listen, close } = createServer({
    timeline,
    store,
    auth,
    say,
    webRoot: null,
    buildId: 'test-busy',
    admit: () =>
      state.mode === 'busy'
        ? { ok: false, code: 'busy', ratio: 0.9, limitBytes: 100, usedBytes: 90 }
        : { ok: true, code: 'ok', ratio: 0.1, limitBytes: 100, usedBytes: 10 },
  });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const { token } = await (
    await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
  ).json();

  const say1 = (messageId, text = '帮我看一下') =>
    fetch(`${origin}/api/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messageId, text, clientAt: Date.now() }),
    });

  const logFile = nodePath.join(dataDir, 'main.jsonl');
  return { dataDir, store, timeline, state, origin, say1, logFile, close };
}

test('🔴 忙的时候拒新句子 ⇒ 429 busy，而且**那个 jsonl 一个字都没写**', async () => {
  const s = await boot();
  try {
    s.state.mode = 'busy';
    const r = await s.say1('u_1');
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'busy' });

    // ★ 这一条才是重点：**没建文件**。
    //   "先落盘再拒"在日志里和"没落盘"长得一样，只有看文件才分得清。
    assert.equal(nodeFs.existsSync(s.logFile), false, `不该建这个文件：${s.logFile}`);
    assert.equal(s.timeline.seq, 0, '时间线也不该动过');
  } finally {
    await s.close();
  }
});

test('正对照：不忙的时候同一个入口照常收下（证明这道闸没把路堵死）', async () => {
  const s = await boot();
  try {
    const r = await s.say1('u_1');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(nodeFs.existsSync(s.logFile), true, '收下了就该落盘');
    assert.ok(s.timeline.seq > 0);
  } finally {
    await s.close();
  }
});

test('🔴 重发（同一个 messageId）**永远不许被拒**——那一句早就收下了', async () => {
  const s = await boot();
  try {
    // 先正常收下一句
    assert.equal((await s.say1('u_1')).status, 200);
    const before = s.timeline.seq;

    // 然后服务端忙起来，客户端又把它重发一遍（没收到回执）
    s.state.mode = 'busy';
    const again = await s.say1('u_1');
    assert.equal(again.status, 200, '拒了它，界面就会显示"没发出去"，可服务端明明收下了');
    assert.equal((await again.json()).duplicate, true);
    assert.equal(s.timeline.seq, before, '重发不许再落一遍（幂等）');
  } finally {
    await s.close();
  }
});

test('忙的时候，新句子被拒、但**已经收下的那些不受影响**', async () => {
  const s = await boot();
  try {
    assert.equal((await s.say1('u_1')).status, 200);
    s.state.mode = 'busy';
    assert.equal((await s.say1('u_2')).status, 429);
    // u_1 还在盘上（拒 u_2 不该碰 u_1）
    const lines = nodeFs.readFileSync(s.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].messageId, 'u_1');
  } finally {
    await s.close();
  }
});

test('⚠️ 429 在两处含义不同，各管各的（别顺手把登录那条改坏）', async () => {
  const s = await boot();
  try {
    // `/api/say` 的 429 = 忙
    s.state.mode = 'busy';
    assert.equal((await s.say1('u_1')).status, 429);
    // `/api/login` 的 429 = 试太多次锁住了，而且要给剩余秒数
    for (let i = 0; i < 3; i += 1) {
      await fetch(`${s.origin}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: '错的' }),
      });
    }
    const locked = await fetch(`${s.origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const j = await locked.json();
    assert.equal(locked.status, 429);
    assert.ok(j.retryAfterSec > 0, '登录那个 429 必须仍然带剩余时间（D2）');
  } finally {
    await s.close();
  }
});
