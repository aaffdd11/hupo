// **视频生成那一条路（Seedance）** —— 契约 `docs/dev/151-APP-VIDEO.md`。
//
// ── 这一份钉什么（都是真链路，不是"读常量"）────────────────────
//   ① 🔴 **任务号只认规规矩矩的形状**（它会拼进查任务那条 URL）——
//      带 `/`、空格、太长的**连请求都不发**；
//   ② 🔴 **"还没登记好" ≠ "做坏了"**：只有 id 的回执是 `unknown`（再等等），不是 `failed`；
//   ③ 🔴 **他明说才许生成**（`asksToMakeVideo`）：视频比图片贵，这一条更要硬；
//   ④ **钥匙不上屏、不进回执**（每一个失败档都只回一句人话）；
//   ⑤ **建任务/查任务**两趟的真形状（`fetch` 注入 ⇒ 不联网、不花钱）。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_VIDEO_BASE,
  DEFAULT_VIDEO_DURATION,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_RATIO,
  MAX_VIDEO_PROMPT_CHARS,
  NEEDS_ASK_VIDEO,
  asksToMakeVideo,
  buildVideoRequest,
  createVideoTask,
  parseVideoTask,
  queryVideoTask,
  safeVideoTaskId,
  videoErrorWords,
  videoUrlOf,
} from '../src/video.js';

const JSON_RES = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// ── ① 形状那一层（纯函数）──────────────────────────────────────

test('V1 任务号只认规规矩矩的形状（带 `/` / 空格 / 太长的一律不认）', () => {
  assert.equal(safeVideoTaskId('cgt-20250611100000-xxxxx'), 'cgt-20250611100000-xxxxx');
  assert.equal(safeVideoTaskId('  cgt-abc123  '), 'cgt-abc123', '两头空白要去掉');
  assert.equal(safeVideoTaskId('cgt/../../etc'), null, '★ 带 `/` 的会把 URL 带到别处去');
  assert.equal(safeVideoTaskId('cgt abc'), null);
  assert.equal(safeVideoTaskId('a?b=1'), null);
  assert.equal(safeVideoTaskId('short'), null, '太短的一律不认');
  assert.equal(safeVideoTaskId('x'.repeat(81)), null, '太长的也不认');
  assert.equal(safeVideoTaskId(null), null);
  assert.equal(safeVideoTaskId(123), null);
});

test('V2 视频地址只认 http(s)（别的协议不许当"视频地址"）', () => {
  assert.equal(videoUrlOf('https://ark.example/v.mp4'), 'https://ark.example/v.mp4');
  assert.equal(videoUrlOf('javascript:alert(1)'), null);
  assert.equal(videoUrlOf('data:video/mp4;base64,AAAA'), null);
  assert.equal(videoUrlOf('file:///etc/passwd'), null);
  assert.equal(videoUrlOf(''), null);
  assert.equal(videoUrlOf(null), null);
});

test('V3 载荷：一句人话 ＋ 几个文本后缀（比例/时长/水印）', () => {
  const r = buildVideoRequest({ prompt: '一只橘猫从窗台上跳下来' });
  assert.equal(r.ok, true);
  assert.equal(r.body.model, DEFAULT_VIDEO_MODEL);
  assert.equal(r.body.content.length, 1);
  assert.equal(r.body.content[0].type, 'text');
  assert.match(r.body.content[0].text, /一只橘猫从窗台上跳下来/);
  assert.match(r.body.content[0].text, new RegExp(`--ratio ${DEFAULT_VIDEO_RATIO}`));
  assert.match(r.body.content[0].text, new RegExp(`--duration ${DEFAULT_VIDEO_DURATION}`));
  assert.match(r.body.content[0].text, /--watermark false/);
  // 空话 / 太长 ⇒ 明着拒（不猜）
  assert.equal(buildVideoRequest({ prompt: '   ' }).ok, false);
  assert.equal(buildVideoRequest({ prompt: 'x'.repeat(MAX_VIDEO_PROMPT_CHARS + 1) }).why, 'prompt-too-long');
  // 坏比例 ⇒ 退回默认（不许把一句奇怪的东西拼进去）
  assert.match(buildVideoRequest({ prompt: 'x', ratio: '16:9; rm -rf /' }).body.content[0].text, /--ratio 16:9/);
});

test('V4 🔴 回执：只有 id 的那种是 `unknown`（再等等），**不是** failed', () => {
  assert.deepEqual(parseVideoTask({ id: 'cgt-1' }), {
    ok: true,
    status: 'unknown',
    videoUrl: null,
    lastFrameUrl: null,
    error: null,
    raw: { id: 'cgt-1' },
  });
  const done = parseVideoTask({ status: 'succeeded', content: { video_url: 'https://x/v.mp4' } });
  assert.equal(done.status, 'succeeded');
  assert.equal(done.videoUrl, 'https://x/v.mp4');
  const bad = parseVideoTask({ status: 'failed', error: { code: 'x', message: '内容不合规' } });
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error.message, '内容不合规');
  assert.equal(parseVideoTask(null).ok, false);
  assert.equal(parseVideoTask([]).ok, false);
});

test('V5 🔴 他明说才许生成（正反两侧都对表）', () => {
  for (const t of [
    '帮我做一段猫跳下来的视频',
    '给我生成一段视频，夕阳下的海',
    '来一段视频看看',
    '我想做个小视频',
    '生成一段动图',
  ]) {
    assert.equal(asksToMakeVideo(t), true, `「${t}」该放行`);
  }
  for (const t of [
    '我今天做了个视频梦', // 有"做"有"视频"，但不是说"给我做一段"
    '帮我查一下这个视频是什么格式',
    '视频那个网站打不开了',
    '',
    null,
    123,
  ]) {
    assert.equal(asksToMakeVideo(t), false, `「${String(t)}」该拒（宁可多问一句）`);
  }
  assert.match(NEEDS_ASK_VIDEO, /花你的钱/);
});

test('V6 那几句人话：每一档都有，而且**没有钥匙**', () => {
  for (const why of ['no-key', 'blank-prompt', 'prompt-too-long', 'bad-key', 'timeout', 'unreachable', 'no-task-id', 'bad-task-id', 'gone', 'bad-json', 'upstream-error']) {
    const t = videoErrorWords({ why });
    assert.equal(typeof t, 'string');
    assert.ok(t.length > 0, `${why} 没说人话`);
    assert.ok(!t.includes('Bearer'), `${why} 那句里有钥匙的形状`);
  }
});

// ── ② 两趟真形状（fetch 注入）──────────────────────────────────

test('V7 建任务：真发的是那一条（端点/头/正文），回来的是任务号', async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init });
    return JSON_RES(200, { id: 'cgt-abc123' });
  };
  const r = await createVideoTask({ key: 'sk-secret-xyz', prompt: '一只猫', fetch: fake });
  assert.equal(r.ok, true);
  assert.equal(r.taskId, 'cgt-abc123');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${DEFAULT_VIDEO_BASE}/contents/generations/tasks`);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-secret-xyz');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, DEFAULT_VIDEO_MODEL);
  // ⚠️ 回执里**没有**钥匙
  assert.equal(JSON.stringify(r).includes('sk-secret-xyz'), false);
});

test('V8 建任务那几档"没成"：每一档说清是哪一档', async () => {
  const noKey = await createVideoTask({ key: '  ', prompt: 'x', fetch: async () => JSON_RES(200, { id: 'cgt-abc123' }) });
  assert.equal(noKey.why, 'no-key');
  const blank = await createVideoTask({ key: 'k', prompt: '  ', fetch: async () => JSON_RES(200, {}) });
  assert.equal(blank.why, 'blank-prompt');
  const bad = await createVideoTask({ key: 'k', prompt: 'x', fetch: async () => JSON_RES(401, { error: { message: 'no' } }) });
  assert.equal(bad.why, 'bad-key');
  const noId = await createVideoTask({ key: 'k', prompt: 'x', fetch: async () => JSON_RES(200, { foo: 1 }) });
  assert.equal(noId.why, 'no-task-id');
  const notJson = await createVideoTask({ key: 'k', prompt: 'x', fetch: async () => new Response('<html>', { status: 200 }) });
  assert.equal(notJson.why, 'bad-json');
  const boom = await createVideoTask({
    key: 'k',
    prompt: 'x',
    fetch: async () => {
      const e = new Error('hangup');
      e.code = 'ECONNRESET';
      throw e;
    },
  });
  assert.equal(boom.why, 'unreachable');
  const to = await createVideoTask({
    key: 'k',
    prompt: 'x',
    fetch: async () => {
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      throw e;
    },
  });
  assert.equal(to.why, 'timeout');
});

test('V9 🔴 查任务：任务号不认 ⇒ **连请求都不发**（别把怪 id 拼进 URL）', async () => {
  let called = 0;
  const fake = async () => {
    called += 1;
    return JSON_RES(200, { status: 'running' });
  };
  const r = await queryVideoTask({ key: 'k', taskId: 'cgt/../../x', fetch: fake });
  assert.equal(r.ok, false);
  assert.equal(r.why, 'bad-task-id');
  assert.equal(called, 0, '★ 形状不认却还是发了请求');
  // 正常那条：真发的是 GET ＋ 正确地址
  const seen = [];
  const ok = await queryVideoTask({
    key: 'k',
    taskId: 'cgt-abc123',
    fetch: async (url, init) => {
      seen.push({ url, init });
      return JSON_RES(200, { status: 'succeeded', content: { video_url: 'https://x/v.mp4' } });
    },
  });
  assert.equal(ok.status, 'succeeded');
  assert.equal(ok.videoUrl, 'https://x/v.mp4');
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].url, `${DEFAULT_VIDEO_BASE}/contents/generations/tasks/cgt-abc123`);
  // 404 ⇒ 那一档是"它那边已经没有了"（任务号只留几天）
  const gone = await queryVideoTask({ key: 'k', taskId: 'cgt-abc123', fetch: async () => JSON_RES(404, {}) });
  assert.equal(gone.why, 'gone');
});
