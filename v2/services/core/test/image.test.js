// **图片生成那条路**的判据（P1-27 · 契约 `docs/dev/79-CREDS-TABS.md` §九）。
//
// 主人 2026-09-24：*"图片用seedream，volcengine的。"*
//
// 守的几条：
//   ① 🔴 **钥匙不进回执、不进日志**（这条路上唯一的秘密）
//   ② **认不出就是没成**（上游回话里没有图 ⇒ 不许当成"画好了"）
//   ③ **每一种"不行"说清是哪一种**（没填钥匙 / 那句话是空的 / 上游说钥匙不灵 / 连不上…）
//   ④ 端点与模型名**可配**（它们会过期）—— 不写死在逻辑里
//   ⑤ 测试**不联网、不花钱**：`fetch` 是注入的

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Auth } from '../src/auth.js';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_URL,
  MAX_PROMPT_CHARS,
  buildImageRequest,
  generateImage,
  imageErrorWords,
  parseImageResponse,
} from '../src/image.js';
import { createServer } from '../src/server.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-img-'));

// ── ① 纯函数：请求 ──────────────────────────────────────────
test('建请求：空话不发；首尾空格去掉；模型名/尺寸可覆盖（默认那两样只住一处）', () => {
  assert.equal(buildImageRequest({ prompt: '   ' }).ok, false);
  assert.equal(buildImageRequest({ prompt: '   ' }).why, 'blank-prompt');
  assert.equal(buildImageRequest({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }).why, 'prompt-too-long');

  const r = buildImageRequest({ prompt: '  一只在窗台上的猫  ' });
  assert.equal(r.ok, true);
  assert.equal(r.body.prompt, '一只在窗台上的猫');
  assert.equal(r.body.model, DEFAULT_IMAGE_MODEL);
  assert.equal(r.body.size, '2K');
  assert.equal(r.body.response_format, 'url', '要 URL（能直接画在界面上）');
  assert.equal(r.body.watermark, false);
  assert.equal(JSON.stringify(r.body).includes('key'), false, '载荷里不许出现任何钥匙字段');

  const custom = buildImageRequest({ prompt: '猫', model: '  my-model-1  ', size: '4K' });
  assert.equal(custom.body.model, 'my-model-1', '模型名会过期 ⇒ 必须能换');
  assert.equal(custom.body.size, '4K');
  assert.equal(DEFAULT_IMAGE_URL.startsWith('https://'), true, '端点必须是 https');
});

// ── ② 纯函数：响应 ──────────────────────────────────────────
test('解响应：有图才算成；上游说错就把它的原话带出来；认不出**明说认不出**', () => {
  const ok = parseImageResponse({ created: 1, data: [{ url: 'https://x.example/a.png' }], usage: { n: 1 } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.urls, ['https://x.example/a.png']);
  assert.deepEqual(ok.usage, { n: 1 });

  // 上游明说错了 ⇒ 把**它的话**带出来（不是我们的请求）
  const bad = parseImageResponse({ error: { message: 'invalid api key', code: 'X' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.why, 'upstream-error');
  assert.match(bad.upstream, /invalid api key/);

  // 认不出 ⇒ 明说（连"回了几条"一起报），**不许**当成成了
  assert.equal(parseImageResponse({ data: [] }).why, 'no-image');
  assert.equal(parseImageResponse({ data: [{ url: 'ftp://x/y' }] }).why, 'no-image', '不是 http(s) 的不算图');
  assert.match(parseImageResponse({ data: [] }).upstream, /0 条/);
  assert.equal(parseImageResponse('不是对象').why, 'not-json');
  // 上游回 b64 也算"有图"（我们没要，但别把有图当没图）
  assert.equal(parseImageResponse({ data: [{ b64_json: 'AAAA' }] }).ok, true);
});

// ── ③ 调用：注入 fetch（不联网）───────────────────────────────
const fakeFetch = (handler) => async (url, init) => handler(url, init);

test('🔴 成了：地址拿回来，而且**回执里没有任何钥匙**', async () => {
  const KEY = 'ark-key-do-not-leak-1';
  let seen = null;
  const r = await generateImage({
    key: KEY,
    prompt: '一只猫',
    fetch: fakeFetch(async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: 'https://x.example/a.png' }] }) };
    }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.urls, ['https://x.example/a.png']);
  assert.equal(seen.url, DEFAULT_IMAGE_URL);
  assert.equal(seen.init.headers.authorization, `Bearer ${KEY}`, '钥匙只该出现在请求头那一行');
  assert.equal(JSON.stringify(r).includes(KEY), false, '★ 回执里不许有钥匙');
});

test('钥匙不对 / 上游 5xx / 连不上 / 超时：**四种分开说**（混成一句会让人一直重试）', async () => {
  const mk = (status, text) => fakeFetch(async () => ({ ok: status < 400, status, text: async () => text }));
  assert.equal((await generateImage({ key: 'k', prompt: 'x', fetch: mk(401, 'nope') })).why, 'bad-key');
  assert.equal((await generateImage({ key: 'k', prompt: 'x', fetch: mk(403, 'nope') })).why, 'bad-key');
  assert.equal((await generateImage({ key: 'k', prompt: 'x', fetch: mk(500, 'boom') })).why, 'upstream-error');
  const thrown = () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; };
  assert.equal((await generateImage({ key: 'k', prompt: 'x', fetch: fakeFetch(thrown) })).why, 'unreachable');
  const aborted = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  assert.equal((await generateImage({ key: 'k', prompt: 'x', fetch: fakeFetch(aborted) })).why, 'timeout');
  // 没钥匙 / 空话：**根本不许发出去**（不浪费一次请求）
  let called = 0;
  const counting = fakeFetch(async () => { called += 1; return { ok: true, status: 200, text: async () => '{}' }; });
  assert.equal((await generateImage({ key: '   ', prompt: 'x', fetch: counting })).why, 'no-key');
  assert.equal((await generateImage({ key: 'k', prompt: '  ', fetch: counting })).why, 'blank-prompt');
  assert.equal(called, 0, '这两种情况一次都不该发出去');
  // 上游回的不是 JSON ⇒ 说清"看不懂"（不是"没图"）
  assert.equal((await generateImage({ key: 'k', prompt: 'x', fetch: mk(200, '<html>') })).why, 'bad-json');
});

test('每一句人话都**不一样**，而且一个内部词都没有', () => {
  // ⚠️ **已知的**那几种各自一句；认不出的**兜底**故意与"上游说画不了"同话
  //    （没有信息就别编一个更具体的说法 —— 编了就是假话）。
  const known = ['no-key', 'blank-prompt', 'prompt-too-long', 'bad-key', 'timeout', 'unreachable', 'no-image', 'bad-json', 'upstream-error'];
  const said = known.map((w) => imageErrorWords({ why: w }));
  assert.equal(new Set(said).size, said.length, `每一种"不行"要有自己的话：${JSON.stringify(said)}`);
  assert.equal(imageErrorWords({ why: '别的' }), imageErrorWords({ why: 'upstream-error' }), '认不出的走兜底');
  assert.equal(imageErrorWords({}), imageErrorWords({ why: 'upstream-error' }), '连 why 都没有也要有话说');
  for (const line of [...said, imageErrorWords({ why: '别的' })]) {
    assert.equal(line.length > 4, true);
    for (const w of ['模型', '客户端', '服务器', '云端', '工作区', 'key']) {
      assert.equal(line.includes(w), false, `「${line}」里出现了内部词「${w}」`);
    }
  }
});

// ── ④ 路由 ─────────────────────────────────────────────────
async function boot({ drawImage = null } = {}) {
  const dataDir = tmp();
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('pw-12345');
  const say = new SayService({ timeline, store, timelineId: 'main' });
  const { listen, close } = createServer({
    timeline, store, auth, say, webRoot: null, buildId: 'img-test',
    tenantStatusOf: () => ({ kind: 'local', state: 'ready' }),
    drawImage,
  });
  const addr = await listen(0);
  const token = auth.issue({ sub: 'owner' }).token;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    h: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    close: async () => { await close(); nodeFs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('🔴 `/api/image`：没开⇒404 · 空话⇒400 · 没钥匙⇒409 · 成了⇒200（回执只有地址）', async () => {
  const s = await boot({
    drawImage: async (sub, prompt) => (sub === 'owner' && prompt === '没事'
      ? { ok: false, why: 'no-key', text: imageErrorWords({ why: 'no-key' }) }
      : { ok: true, urls: ['https://x.example/a.png'], ms: 1234 }),
  });
  try {
    const post = (body) => fetch(`${s.origin}/api/image`, { method: 'POST', headers: s.h, body: JSON.stringify(body) });
    assert.equal((await post({ prompt: '   ' })).status, 400, '空话要 400');
    const nokey = await post({ prompt: '没事' });
    assert.equal(nokey.status, 409);
    assert.match((await nokey.json()).text, /还没填/, '要把"没填钥匙"这句话说给他听');

    const ok = await post({ prompt: '一只猫' });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.urls, ['https://x.example/a.png']);
    assert.equal(JSON.stringify(body).includes('ark-key'), false, '★ 回执里不许有钥匙');
  } finally {
    await s.close();
  }
  // 没开这条路 ⇒ 404（不许假装能画）
  const s2 = await boot();
  try {
    const r = await fetch(`${s2.origin}/api/image`, { method: 'POST', headers: s2.h, body: JSON.stringify({ prompt: 'x' }) });
    assert.equal(r.status, 404);
  } finally {
    await s2.close();
  }
});

test('上游说钥匙不灵 ⇒ 502，而且**把原因如实带出来**（不是"失败了"）', async () => {
  const s = await boot({
    drawImage: async () => ({ ok: false, why: 'bad-key', text: imageErrorWords({ why: 'bad-key' }) }),
  });
  try {
    const r = await fetch(`${s.origin}/api/image`, {
      method: 'POST', headers: s.h, body: JSON.stringify({ prompt: '一只猫' }),
    });
    assert.equal(r.status, 502);
    const j = await r.json();
    assert.equal(j.error, 'bad-key');
    assert.match(j.text, /换一串/, '要告诉他"换一串就好"');
  } finally {
    await s.close();
  }
});

// ── ⑤ 通道那一层（助手走的就是这条：`draw` op）────────────────────
test('🔴 通道：**他明说才许生成**（没说 ⇒ 拒，而且一次都不花）；说了才真画', async () => {
  const dir = tmp();
  try {
    const { Apps } = await import('../src/apps.js');
    let drawn = 0;
    const ctx = {
      sub: 'u1',
      turnInput: () => said,
      drawImage: async (sub, prompt) => { drawn += 1; return { ok: true, urls: ['https://x.example/a.png'] }; },
    };
    const apps = new Apps({ dir, sub: 'u1' });
    const { handleAppsOp } = await import('../src/apps-socket.js');
    let said = '这个图是什么意思';

    // ① 他只是"问一句那个图" ⇒ 拒（而且**一次都没画**）
    const no = await handleAppsOp(apps, { op: 'draw', prompt: '一只猫' }, ctx);
    assert.equal(no.ok, false);
    assert.equal(no.refused, 'needs-ask');
    assert.match(no.error, /亲口说一句/, '要告诉他该怎么说');
    assert.equal(drawn, 0, '★ 拒了就不许花他的钱');

    // ② 他明说了 ⇒ 真画
    said = '帮我画一只在窗台上的猫';
    const yes = await handleAppsOp(apps, { op: 'draw', prompt: '一只在窗台上的猫' }, ctx);
    assert.equal(yes.ok, true);
    assert.deepEqual(yes.urls, ['https://x.example/a.png']);
    assert.equal(drawn, 1);

    // ③ 没有"他那句话"（助手自己发起的）⇒ 拒
    said = '';
    assert.equal((await handleAppsOp(apps, { op: 'draw', prompt: 'x' }, ctx)).refused, 'needs-ask');
    // ④ 空话 ⇒ 拒（在"明说"之后）
    said = '帮我画一张';
    assert.equal((await handleAppsOp(apps, { op: 'draw', prompt: '   ' }, ctx)).ok, false);
    // ⑤ 没接线 ⇒ 如实说（不是假装画了）
    const off = await handleAppsOp(apps, { op: 'draw', prompt: 'x' }, { sub: 'u1', turnInput: () => '帮我画一张' });
    assert.equal(off.ok, false);
    assert.match(off.error, /还没接上/);
    // ⑥ 服务端那句"没填钥匙"要**原样传上去**
    const noKey = await handleAppsOp(apps, { op: 'draw', prompt: 'x' }, {
      sub: 'u1', turnInput: () => '帮我画一张',
      drawImage: async () => ({ ok: false, why: 'no-key', text: imageErrorWords({ why: 'no-key' }) }),
    });
    assert.equal(noKey.ok, false);
    assert.match(noKey.error, /还没填画图那一把钥匙/);
    assert.equal(JSON.stringify(noKey).includes('ark-key'), false, '★ 回执里不许有钥匙');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 那条闸的真值表：认得出"他要我画"才放（保守：认不出就拒）', async () => {
  const { asksToDrawImage } = await import('../src/image.js');
  for (const t of ['帮我画一只猫', '画一张日落', '给我画个头像', '生成一张海报', '来一张风景图', '做一张封面']) {
    assert.equal(asksToDrawImage(t), true, `这句是"他要我画"，该认：${t}`);
  }
  for (const t of ['这个图是什么意思', '我画了个图给你看', '图片怎么这么大', '别看那个', '', '  ', null, undefined]) {
    assert.equal(asksToDrawImage(t), false, `这句不是"他要我画"，不该认：${JSON.stringify(t)}`);
  }
});
