// **视频那本账 ＋ 那个巡场 ＋ 通道上那条口**（契约 `docs/dev/151-APP-VIDEO.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **一次只许一条在飞**（同一个人）—— 视频贵，不许一句话排十条；
//   ② 🔴 **账在盘上**（重启之后还认得那几条在飞的）；换个实例也读得到（现读盘）；
//   ③ 🔴 **静默是错的两种**都在里头：做好了要**说一句**（带地址）、
//      做坏了/等太久也要**说一句**；而"还在跑"**一句都不许说**（别每 10 秒喊一次）；
//   ④ 🔴 **查一次抛了 / 查不动 ⇒ 那一条不许弄没**（下一趟再查）；
//   ⑤ 🔴 **通道上那条口**：他没明说 ⇒ **一个字节都不许花**（`startVideo` 都不许被叫到）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { handleAppsOp } from '../src/apps-socket.js';
import { NEEDS_ASK_VIDEO } from '../src/video.js';
import {
  MAX_PENDING_PER_USER,
  MAX_WAIT_MS,
  VideoBook,
  createVideoRunner,
  videoDoneLine,
  videoFailedLine,
  videoLateLine,
} from '../src/video-tasks.js';

function tmp() {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-video-'));
  return d;
}

test('W1 账本：交一条 / 看一眼 / 拿掉；**换个实例也读得到**（现读盘）', () => {
  const dir = tmp();
  try {
    const a = new VideoBook({ dataDir: dir, now: () => 1000 });
    assert.deepEqual(a.pendingOf('u1'), []);
    assert.equal(a.add({ sub: 'u1', taskId: 'cgt-abc123', scope: 'main', prompt: '一只猫' }).ok, true);
    assert.equal(a.pendingOf('u1').length, 1);
    // ★ 另一个实例（= 通道那一侧）**看得到同一条** —— 这条是"现读盘"那个设计的判据
    const b = new VideoBook({ dataDir: dir });
    assert.equal(b.pendingOf('u1').length, 1);
    assert.equal(b.pendingOf('u1')[0].taskId, 'cgt-abc123');
    assert.equal(b.pendingOf('u1')[0].scope, 'main');
    // 拿掉
    assert.equal(b.drop({ sub: 'u1', taskId: 'cgt-abc123' }), true);
    assert.equal(a.pendingOf('u1').length, 0, '★ 另一个实例拿掉之后这个实例也该看到没了');
    assert.equal(a.drop({ sub: 'u1', taskId: 'cgt-abc123' }), false, '幂等');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W2 🔴 一次只许一条在飞（视频贵）；坏任务号 / 坏身份一律不收', () => {
  const dir = tmp();
  try {
    const book = new VideoBook({ dataDir: dir });
    assert.equal(book.add({ sub: 'u1', taskId: 'cgt-abc123' }).ok, true);
    const again = book.add({ sub: 'u1', taskId: 'cgt-def456' });
    assert.equal(again.ok, false);
    assert.equal(again.why, 'too-many');
    assert.equal(book.pendingOf('u1').length, MAX_PENDING_PER_USER);
    // 别人不受影响
    assert.equal(book.add({ sub: 'u2', taskId: 'cgt-xyz789' }).ok, true);
    // 坏任务号（会拼进 URL 的那种）⇒ 不收
    assert.equal(book.add({ sub: 'u3', taskId: 'cgt/../x' }).why, 'bad-task-id');
    assert.equal(book.add({ sub: '', taskId: 'cgt-ok1234' }).why, 'no-sub');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W3 盘上那份手改坏了 ⇒ 当作空（不许把服务带走）', () => {
  const dir = tmp();
  try {
    nodeFs.writeFileSync(nodePath.join(dir, 'video-tasks.json'), '{这不是 JSON');
    const book = new VideoBook({ dataDir: dir });
    assert.deepEqual(book.all(), []);
    // 半好半坏：认不出的那几条丢掉，认得出的留着
    nodeFs.writeFileSync(
      nodePath.join(dir, 'video-tasks.json'),
      `${JSON.stringify({ items: [
        { sub: 'u1', taskId: 'cgt-good123', scope: 'main', prompt: 'x', at: 1 },
        { sub: 'u2', taskId: 'cgt/../bad', scope: 'main', prompt: 'x', at: 2 },
        { sub: '', taskId: 'cgt-none123', at: 3 },
        'not-an-object',
      ] })}\n`,
    );
    const b2 = new VideoBook({ dataDir: dir });
    assert.deepEqual(b2.all().map((i) => i.taskId), ['cgt-good123']);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W4 🔴 巡场：做好了 ⇒ **说一句带地址** ＋ 拿掉；还在跑 ⇒ **一句都不说**', async () => {
  const dir = tmp();
  try {
    const book = new VideoBook({ dataDir: dir, now: () => 1000 });
    book.add({ sub: 'u1', taskId: 'cgt-run001', scope: 'main', prompt: '一只猫' });
    const said = [];
    const runner = createVideoRunner({
      worlds: { ids: () => ['u1'] },
      bookFor: () => book,
      check: async () => ({ ok: true, status: 'running' }),
      deliver: (o) => said.push(o),
      now: () => 2000,
      log: () => {},
    });
    let r = await runner.tick();
    assert.equal(r.ran[0].action, 'waiting');
    assert.equal(said.length, 0, '★ 还在跑就不许喊（别每 10 秒喊一次）');
    assert.equal(book.pendingOf('u1').length, 1, '还在跑的那一条不许弄没');

    // 好了：说一句（带地址）＋ 拿掉
    const runner2 = createVideoRunner({
      worlds: { ids: () => ['u1'] },
      bookFor: () => book,
      check: async () => ({ ok: true, status: 'succeeded', videoUrl: 'https://x/v.mp4' }),
      deliver: (o) => said.push(o),
      now: () => 3000,
      log: () => {},
    });
    r = await runner2.tick();
    assert.equal(r.ran[0].action, 'done');
    assert.equal(said.length, 1);
    assert.equal(said[0].sub, 'u1');
    assert.equal(said[0].scope, 'main');
    assert.match(said[0].text, /https:\/\/x\/v\.mp4/);
    assert.match(said[0].text, /视频做好了/);
    assert.equal(book.pendingOf('u1').length, 0, '做完了要从"在飞"里拿掉');
    // 负向对照：**再说一遍就是假话**（第二趟不该再喊）
    await runner2.tick();
    assert.equal(said.length, 1);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W5 做坏了 / 等太久了 / 上游说成了却没地址 ⇒ 都**如实说一句**', async () => {
  const dir = tmp();
  try {
    const said = [];
    const mk = (check, nowMs, book) =>
      createVideoRunner({
        worlds: { ids: () => ['u1'] },
        bookFor: () => book,
        check,
        deliver: (o) => said.push(o),
        now: () => nowMs,
        log: () => {},
      });

    // ① 失败
    const b1 = new VideoBook({ dataDir: dir, now: () => 1000 });
    b1.add({ sub: 'u1', taskId: 'cgt-fail01', scope: 'app-x' });
    let r = await mk(async () => ({ ok: true, status: 'failed', text: '内容不合规' }), 2000, b1).tick();
    assert.equal(r.ran[0].action, 'failed');
    assert.match(said.at(-1).text, /没做成/);
    assert.match(said.at(-1).text, /内容不合规/);
    assert.equal(said.at(-1).scope, 'app-x', '要回他问的那一间');
    assert.equal(b1.pendingOf('u1').length, 0);

    // ② 上游说成了、但**没有地址** ⇒ 不许说成"做好了"（那是编）
    const b2 = new VideoBook({ dataDir: dir, now: () => 1000 });
    b2.add({ sub: 'u1', taskId: 'cgt-nourl1', scope: 'main' });
    r = await mk(async () => ({ ok: true, status: 'succeeded', videoUrl: null }), 2000, b2).tick();
    assert.equal(r.ran[0].action, 'done');
    assert.match(said.at(-1).text, /没做成/);
    assert.equal(/https:/.test(said.at(-1).text), false);

    // ③ 等太久了 ⇒ 放下 ＋ 如实说"还在做"
    const b3 = new VideoBook({ dataDir: dir, now: () => 1000 });
    b3.add({ sub: 'u1', taskId: 'cgt-late01', scope: 'main' });
    r = await mk(async () => ({ ok: true, status: 'running' }), 1000 + MAX_WAIT_MS + 1, b3).tick();
    assert.equal(r.ran[0].action, 'late');
    assert.match(said.at(-1).text, /还在做/);
    assert.equal(b3.pendingOf('u1').length, 0);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W6 🔴 查一次抛了 / 查不动 ⇒ **那一条不许弄没**，也不许喊', async () => {
  const dir = tmp();
  try {
    const said = [];
    const b = new VideoBook({ dataDir: dir, now: () => 1000 });
    b.add({ sub: 'u1', taskId: 'cgt-throw1', scope: 'main' });
    let r = await createVideoRunner({
      worlds: { ids: () => ['u1'] },
      bookFor: () => b,
      check: async () => {
        throw new Error('网络抽了');
      },
      deliver: (o) => said.push(o),
      now: () => 2000,
      log: () => {},
    }).tick();
    assert.equal(r.ran[0].action, 'check-threw');
    assert.equal(b.pendingOf('u1').length, 1, '★ 抛一次就把那一条弄没 = 他花了钱却没人收');
    assert.equal(said.length, 0);

    r = await createVideoRunner({
      worlds: { ids: () => ['u1'] },
      bookFor: () => b,
      check: async () => ({ ok: false, why: 'no-key' }),
      deliver: (o) => said.push(o),
      now: () => 3000,
      log: () => {},
    }).tick();
    assert.equal(r.ran[0].action, 'check-failed');
    assert.equal(b.pendingOf('u1').length, 1);
    assert.equal(said.length, 0);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W7 巡场不许重入（上一遍没走完就不开第二遍）', async () => {
  const dir = tmp();
  try {
    const b = new VideoBook({ dataDir: dir, now: () => 1000 });
    b.add({ sub: 'u1', taskId: 'cgt-slow01', scope: 'main' });
    let resolveCheck = null;
    const runner = createVideoRunner({
      worlds: { ids: () => ['u1'] },
      bookFor: () => b,
      check: () => new Promise((r) => { resolveCheck = r; }),
      deliver: () => {},
      now: () => 2000,
      log: () => {},
    });
    const p1 = runner.tick();
    const p2 = await runner.tick();
    assert.deepEqual(p2, { skipped: 'busy' });
    resolveCheck({ ok: true, status: 'running' });
    await p1;
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W8 🔴 通道上那条口：他没明说 ⇒ **一个字节都不许花**（`startVideo` 都不许被叫）', async () => {
  let called = 0;
  const ctx = {
    sub: 'u1',
    turnInputFor: () => '帮我查一下这个视频是什么格式',
    startVideo: async () => {
      called += 1;
      return { ok: true, taskId: 'cgt-should-not' };
    },
    usage: { note: () => {} },
  };
  const r = await handleAppsOp({}, { op: 'video', prompt: '一只猫', scope: 'main' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'needs-ask');
  assert.equal(r.error, NEEDS_ASK_VIDEO);
  assert.equal(called, 0, '★ 闸没过却还是去花钱了');

  // 明说了 ⇒ 交出去，并把这一笔记进用量账本（kind=video）
  const noted = [];
  const ctx2 = {
    sub: 'u1',
    turnInputFor: () => '帮我做一段猫跳下来的视频',
    startVideo: async (prompt, scope) => {
      called += 1;
      assert.equal(prompt, '一只猫从窗台上跳下来');
      assert.equal(scope, 'app-x');
      return { ok: true, taskId: 'cgt-ok12345' };
    },
    usage: { note: (scope, patch) => noted.push({ scope, patch }) },
  };
  const r2 = await handleAppsOp({}, { op: 'video', prompt: '  一只猫从窗台上跳下来  ', scope: 'app-x' }, ctx2);
  assert.equal(r2.ok, true);
  assert.equal(r2.taskId, 'cgt-ok12345');
  assert.equal(called, 1);
  assert.equal(noted.length, 1);
  assert.equal(noted[0].scope, 'app-x');
  assert.equal(noted[0].patch.kind, 'video');
  assert.equal(noted[0].patch.videos, 1);

  // 这台部署没接上那条路 ⇒ 明确失败（不许假装交出去了）
  const r3 = await handleAppsOp({}, { op: 'video', prompt: 'x' }, { sub: 'u1', turnInputFor: () => '帮我做一段视频' });
  assert.equal(r3.ok, false);
  assert.match(String(r3.error), /还没接上/);

  // 空话 ⇒ 拒
  const r4 = await handleAppsOp({}, { op: 'video', prompt: '   ' }, ctx2);
  assert.equal(r4.ok, false);
});

test('W9 那三句话本身：做好了带地址、没做成说清、等太久说"还在做"', () => {
  assert.match(videoDoneLine({ taskId: 'cgt-1', videoUrl: 'https://x/v.mp4', prompt: '一只猫' }), /https:\/\/x\/v\.mp4/);
  assert.match(videoFailedLine({ reason: 'expired', detail: '' }), /过期/);
  assert.match(videoLateLine({ taskId: 'cgt-1234567890' }), /还在做/);
  // ⚠️ 一句里不许出现内部词那种形状（这里只钉"是人话、有信息"）
  for (const s of [
    videoDoneLine({ taskId: 'cgt-1', videoUrl: 'https://x/v.mp4' }),
    videoFailedLine({ reason: 'failed', detail: '' }),
    videoLateLine({ taskId: 'cgt-1' }),
  ]) {
    assert.ok(s.length > 6 && !s.includes('Bearer'));
  }
});
