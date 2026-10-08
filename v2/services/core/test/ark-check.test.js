// **「验一下钥匙」那条路**（`src/ark-check.js` ＋ `src/ark-check-use.js`）——
// v3.0 · 主人 2026-10-07 选的**那一档：只验钥匙和路，不花钱**（`docs/dev/219` §一）。
//
// ── 这份钉什么（真链路 ＋ 注入的 `fetch` ⇒ 不联网、不花钱）──────
//   ① 🔴 **一个生成都不发、一分钱都不花**：正文里那个名字是**编的**，而且两趟都打到真那两条路径上；
//   ② 🔴 **"没连上"与"钥匙不行"必须分得开**（混成一句 = 页面在说假话）；
//   ③ **两条路各问一趟**，哪条没通就说哪条（不许含糊成"整把钥匙不行"）；
//   ④ 🔴 **钥匙一个字符都不出现在返回值里**（纪律：只进请求头）；
//   ⑤ **视频那栏空着、图片那栏有 ⇒ 照样验得了**（与真那两条路**同一个借用规则**）。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import {
  ARK_CHECK_TIMEOUT_MS,
  PREFLIGHT_MODEL,
  arkCheckWords,
  authClassOf,
  checkArkKey,
} from '../src/ark-check.js';
import { makeCheckKey } from '../src/ark-check-use.js';
import { writeUserCreds } from '../src/creds-store.js';
import { DEFAULT_IMAGE_URL } from '../src/image.js';
import { DEFAULT_VIDEO_BASE, videoTasksUrl } from '../src/video.js';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-ark-check-'));
const JSON_RES = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/** 收下每一次请求（**看得到真发出去的头与正文**；判据打在它们上面）。 */
function spyFetch(reply) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push({
      url: String(url),
      auth: init?.headers?.authorization ?? null,
      body: init?.body ?? null,
    });
    return reply(String(url), init, seen.length);
  };
  return { fetch, seen };
}

/** 上游**业务层**的拒（名字是编的 ⇒ 它当然不认）—— 注意：**不是**鉴权类。 */
const MODEL_ERROR = () => JSON_RES(400, { error: { code: 'InvalidParameter', message: 'the model does not exist' } });
/** 上游**鉴权层**的拒（原话与 `79-CREDS-TABS.md` §9.6 记的那三句同一套）。 */
const AUTH_ERROR = (msg = "The API key doesn't exist. Request id: 0217") =>
  JSON_RES(401, { error: { code: 'AuthenticationError', message: msg } });

test('K0 鉴权那三句认得出来，别的**不许**当成鉴权（这是"共用一套针"的落点）', () => {
  assert.equal(authClassOf('{"error":{"message":"The API key doesn\'t exist. x"}}'), 'not-exist');
  assert.equal(authClassOf('The API key format is incorrect. x'), 'bad-shape');
  assert.equal(authClassOf('the API key or AK/SK in the request is missing or invalid. x'), 'missing');
  // 业务层的话**不许**被当成鉴权类（否则会把"名字不对"说成"钥匙不行"）
  assert.equal(authClassOf('{"error":{"code":"InvalidParameter","message":"the model does not exist"}}'), null);
  assert.equal(authClassOf(''), null);
});

test('K1 🔴 两趟都发、名字是编的、打的就是真那两条路径（一个生成都没发出去）', async () => {
  const { fetch, seen } = spyFetch(MODEL_ERROR);
  const r = await checkArkKey({ key: 'k-1', fetch, log: () => {} });
  assert.equal(seen.length, 2, `应当问两趟（画图那条 ＋ 做视频那条），实际 ${seen.length}`);
  const urls = seen.map((s) => s.url).sort();
  assert.deepEqual(urls, [DEFAULT_IMAGE_URL, videoTasksUrl(DEFAULT_VIDEO_BASE)].sort());
  for (const s of seen) {
    assert.ok(String(s.body).includes(PREFLIGHT_MODEL), `正文里应当是那个编的名字：${s.body}`);
  }
  assert.equal(r.ok, true, `非鉴权类 ⇒ 钥匙认了：${JSON.stringify(r)}`);
});

test('K2 401 ＋ 鉴权原话 ⇒ 说"用不了"，而且两格都否', async () => {
  const { fetch } = spyFetch(AUTH_ERROR);
  const r = await checkArkKey({ key: 'k-2', fetch });
  assert.equal(r.ok, false);
  assert.equal(r.image, 'no');
  assert.equal(r.video, 'no');
  assert.equal(r.why, 'bad-key');
  assert.match(r.text, /用不了/);
});

test('K3 🔴 连不上 ⇒ `unreachable`，**不许**说成"钥匙不行"（两句必须分得开）', async () => {
  const boom = async () => {
    const e = new Error('nope');
    e.code = 'ENOTFOUND';
    throw e;
  };
  const r = await checkArkKey({ key: 'k-3', fetch: boom });
  assert.equal(r.why, 'unreachable');
  assert.notEqual(r.why, 'bad-key');
  assert.match(r.text, /连不上/);
  // 负向对照：同一个"两格都不通"的形状，但回的是鉴权类 ⇒ 必须是 bad-key
  const { fetch } = spyFetch(AUTH_ERROR);
  const r2 = await checkArkKey({ key: 'k-3', fetch });
  assert.equal(r2.why, 'bad-key');
});

test('K4 一条通、一条不通 ⇒ 说清**是哪一条**，而且整把不装作能用', async () => {
  // 画图那条：业务层拒（⇒ 通了）；做视频那条：鉴权拒（⇒ 没通）
  const { fetch } = spyFetch((url) => (url === DEFAULT_IMAGE_URL ? MODEL_ERROR() : AUTH_ERROR()));
  const r = await checkArkKey({ key: 'k-4', fetch });
  assert.equal(r.image, 'ok');
  assert.equal(r.video, 'no');
  assert.equal(r.ok, false, '一条没通就不算"能用"');
  assert.equal(r.why, null, '这不是"整把钥匙不行"，也不是"连不上"');
  assert.match(r.text, /画图那条通了/);
  assert.match(r.text, /做视频那条它没认/);
});

test('K5 成了的那句话**只承诺验到的事**（说"认了"，不说"能出片"，并且说清没花钱）', async () => {
  const { fetch } = spyFetch(MODEL_ERROR);
  const r = await checkArkKey({ key: 'k-5', fetch });
  assert.match(r.text, /钥匙/);
  assert.match(r.text, /没花钱/);
  assert.ok(!/能出片|做好了|画好了/.test(r.text), `不许承诺没验到的事：${r.text}`);
});

test('K6 没钥匙 ⇒ `no-key`，而且**一次请求都不发**', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return MODEL_ERROR();
  };
  for (const k of ['', '   ', null, undefined]) {
    const r = await checkArkKey({ key: k, fetch });
    assert.equal(r.why, 'no-key');
    assert.equal(r.ok, false);
  }
  assert.equal(calls, 0, '没钥匙还发请求 = 白跑一趟');
});

test('K7 🔴 只填了「图片」那一栏 ⇒ 视频那一屏照样验得了（借同一把）', async () => {
  const dataDir = tmp();
  writeUserCreds(dataDir, 'u1', { image: 'ark-shared-key-0001' });
  const { fetch, seen } = spyFetch(MODEL_ERROR);
  const check = makeCheckKey({ dataDir, env: {}, fetch, log: () => {} });
  const r = await check('u1');
  assert.equal(r.ok, true, `没借到图片那把：${JSON.stringify(r)}`);
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.equal(s.auth, 'Bearer ark-shared-key-0001', '用的不是他自己那栏（或借错了）');
  }
});

test('K8 🔴 别人的钥匙借不到；没填就是"没填"（多租户那条不许松）', async () => {
  const dataDir = tmp();
  writeUserCreds(dataDir, 'u1', { image: 'ark-u1-only-key' });
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return MODEL_ERROR();
  };
  const check = makeCheckKey({ dataDir, env: {}, fetch, log: () => {} });
  const r = await check('u2');
  assert.equal(r.why, 'no-key', `u2 没填，不该拿到 u1 的钥匙：${JSON.stringify(r)}`);
  assert.equal(calls, 0);
});

test('K9 🔴 钥匙**一个字符都不出现在返回值里**（只进请求头）', async () => {
  const SECRET = 'ark-SECRET-0123456789abcdef';
  const dataDir = tmp();
  writeUserCreds(dataDir, 'u1', { image: SECRET });
  const logs = [];
  const { fetch } = spyFetch(MODEL_ERROR);
  const check = makeCheckKey({ dataDir, env: {}, fetch, log: (m) => logs.push(String(m)) });
  const r = await check('u1');
  const dump = JSON.stringify(r) + logs.join('\n');
  assert.ok(!dump.includes(SECRET), '钥匙漏进返回值/日志了');
  assert.ok(!dump.includes('0123456789abcdef'), '连一段都不许漏');
});

test('K10 自检有上限（一个挂住的上游不许把它吊死）', () => {
  assert.ok(Number.isFinite(ARK_CHECK_TIMEOUT_MS) && ARK_CHECK_TIMEOUT_MS > 0);
  assert.ok(ARK_CHECK_TIMEOUT_MS <= 60_000, '自检不该比一次生成还慢');
});

test('K11 那几句人话**没有内部词**（词表那道硬闸的同一条规矩）', () => {
  const cases = [
    { why: 'no-key' },
    { why: 'unreachable' },
    { why: 'bad-key' },
    { image: 'ok', video: 'ok' },
    { image: 'ok', video: 'no' },
    { image: 'no', video: 'ok' },
    { image: 'no', video: 'no' },
  ];
  for (const c of cases) {
    const t = arkCheckWords(c);
    for (const w of ['工作区', '口令', '客户端', '云端', '服务器', '模型', '工具', '调度器', '时间线', '会话']) {
      assert.ok(!t.includes(w), `「${w}」不该上屏：${t}`);
    }
  }
});
