// **"用他自己那把钥匙交一段视频出去"**（`src/video-use.js`）—— 契约 `docs/dev/151-APP-VIDEO.md`
// ＋ 主人 2026-10-01 选的**甲**（`creds.mjs` 的 `sharedKeyOf`：图片与视频是**同一把钥匙**）。
//
// ── 这份钉什么（都是真链路：真 `makeVideo` ＋ 注入的 `fetch` ⇒ 不联网、不花钱）────
//   ① 🔴 **只填了「图片」那一栏 ⇒ 视频也能跑**（借同一把 —— 主人选"甲"的理由：
//      贴一处就行，不然会出现"画得出图、做不了片子"这种没人猜得到原因的状态）；
//   ② 🔴 **对称**：只填了「视频」那一栏 ⇒ 图片那条也照用（同一把钥匙，两个方向都算数）；
//   ③ 🔴 **自己那一栏永远优先**（他要真给视频单独一把、为了分开算钱，照他自己的来）——
//      判据打在**真发出去的那个 `Authorization` 头上**（不是读常量）；
//   ④ 🔴 **两栏都空 ⇒ 一个字节都不发**（不联网、不记账，如实说"没填"）；
//   ⑤ 交出去之后**真落账**（`VideoBook` 里能查到那条任务号）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import { makeDrawImage } from '../src/image-use.js';
import { VideoBook } from '../src/video-tasks.js';
import { makeVideo } from '../src/video-use.js';
import { writeUserCreds } from '../src/creds-store.js';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-video-use-'));
const JSON_RES = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/** 收下每一次请求：**看得到真发出去的那个 `Authorization`**（判据就打在它上面）。 */
function spyFetch(reply) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push({ url: String(url), auth: init?.headers?.authorization ?? init?.headers?.Authorization ?? null, body: init?.body ?? null });
    return reply(url, init, seen.length);
  };
  return { fetch, seen };
}

const OK_TASK = () => JSON_RES(200, { id: 'cgt-20261001120000-abcdef' });
const OK_IMAGE = () => JSON_RES(200, { data: [{ url: 'https://ark.example/a.png' }] });

test('S1 🔴 只填了「图片」那一栏 ⇒ 视频照样交得出去（借同一把）', async () => {
  const dataDir = tmp();
  writeUserCreds(dataDir, 'u1', { image: 'ark-shared-key-0001' });
  const { fetch, seen } = spyFetch(OK_TASK);
  const r = await makeVideo({ env: {}, fetch, log: () => {} }).start({ dataDir, sub: 'u1', prompt: '一只橘猫' });
  assert.equal(r.ok, true, `没借到图片那把：${JSON.stringify(r)}`);
  assert.equal(seen.length, 1, '应当只发一次建任务');
  assert.equal(seen[0].auth, 'Bearer ark-shared-key-0001', '用的不是图片那一栏那把');
  // 真落账
  const book = new VideoBook({ dataDir, log: () => {} });
  assert.equal(book.pendingOf('u1').length, 1, '交出去了却没落账');
});

test('S2 🔴 对称：只填了「视频」那一栏 ⇒ 图片那条也照用', async () => {
  const dataDir = tmp();
  writeUserCreds(dataDir, 'u1', { video: 'ark-shared-key-0002' });
  const { fetch, seen } = spyFetch(OK_IMAGE);
  const draw = makeDrawImage({ dataDir, env: {}, fetch, log: () => {} });
  const r = await draw('u1', '画一只猫');
  assert.equal(r.ok, true, `没借到视频那把：${JSON.stringify(r)}`);
  assert.equal(seen[0].auth, 'Bearer ark-shared-key-0002', '用的不是视频那一栏那把');
});

test('S3 🔴 两栏都在、而且不一样 ⇒ **自己那一栏优先**（视频用自己的）', async () => {
  const dataDir = tmp();
  writeUserCreds(dataDir, 'u1', { image: 'ark-for-images', video: 'ark-for-videos' });
  const v = spyFetch(OK_TASK);
  await makeVideo({ env: {}, fetch: v.fetch, log: () => {} }).start({ dataDir, sub: 'u1', prompt: '一只橘猫' });
  assert.equal(v.seen[0].auth, 'Bearer ark-for-videos', '视频那一栏有，却用了图片那把');
  const i = spyFetch(OK_IMAGE);
  await makeDrawImage({ dataDir, env: {}, fetch: i.fetch, log: () => {} })('u1', '画一只猫');
  assert.equal(i.seen[0].auth, 'Bearer ark-for-images', '图片那一栏有，却用了视频那把');
});

test('🔴 S4 两栏都空 ⇒ **一个字节都不发**，如实说"没填"', async () => {
  const dataDir = tmp();
  const { fetch, seen } = spyFetch(OK_TASK);
  const r = await makeVideo({ env: {}, fetch, log: () => {} }).start({ dataDir, sub: 'u1', prompt: '一只橘猫' });
  assert.equal(r.ok, false);
  assert.equal(r.why, 'no-key');
  assert.equal(seen.length, 0, '没钥匙却发了请求（那是花钱的）');
  assert.equal(typeof r.text, 'string');
  assert.ok(r.text.length > 0, '没填要有一句人话');
  // 查那条路也一样：没钥匙 ⇒ 不发、如实说
  const q = await makeVideo({ env: {}, fetch, log: () => {} }).check({ dataDir, sub: 'u1', taskId: 'cgt-20261001120000-abcdef' });
  assert.equal(q.ok, false);
  assert.equal(q.why, 'no-key');
});

test('S5 🔴 没别的意思：**别人那一份**借不到（多租户那条底线没松）', async () => {
  const dataDir = tmp();
  writeUserCreds(dataDir, 'u1', { image: 'ark-u1-only' });
  const { fetch, seen } = spyFetch(OK_TASK);
  const r = await makeVideo({ env: {}, fetch, log: () => {} }).start({ dataDir, sub: 'u2', prompt: '一只橘猫' });
  assert.equal(r.ok, false, 'u2 没有钥匙，却借到了 u1 的');
  assert.equal(r.why, 'no-key');
  assert.equal(seen.length, 0);
  assert.equal(new VideoBook({ dataDir, log: () => {} }).pendingOf('u2').length, 0);
});
