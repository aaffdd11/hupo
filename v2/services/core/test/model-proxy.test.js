// **盒内 root 小代理**：它持有 key，agent 读不到明文（多租户 ②-3）。
//
// 契约依据：`docs/dev/37-MULTITENANT.md` §12.2 右边那一列 · `39-PERMISSIONS.md` §5.2/§7.1。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   1. **key 从哪来**：`/run/hupo/creds.yaml`（那份文件 agent 读不到 —— 判据在容器里，
//      见 `34-CONTAINER.md` §5.6 判据 1；这里钉的是**解析**不吞错、不猜半个 key）；
//   2. 🔴 **换头**：agent 发出去的是**占位符**，而上游收到的**必须是真 key**
//      —— 这一条就是"持有与使用分开"的全部意义；
//   3. **没有 key ⇒ 如实 503**，而且**不许去打扰上游**（拿占位符试上游 = 让用户
//      看到"模型鉴权失败"，而真正的原因在我们这边 —— 那是假话）；
//   4. **流式**：代理**不许把响应缓冲下来**（缓冲了用户就看到"憋半天然后一次全出来"）；
//   5. 🔴 **日志里不许出现 key**（这一条是拿真日志扫的）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { parseKey, readKeyFile, startModelProxy } from '../src/model-proxy.mjs';

/**
 * 这一轮起过的代理与假上游（`after()` 兜底关掉）。
 *
 * ⚠️ **为什么必须有这个**（2026-09-21 实测）：断言在 `await p.close()` **之前**失败时，
 *    那些监听会一直挂着 ⇒ 测试进程**永不退出** ⇒ 表现是"**红**"变成"**挂到超时**"。
 *    `server.test.js` 顶上记过同一件事；**变异验证**正好会大量制造"断言提前失败"。
 */
const openClose = new Set();
after(async () => {
  for (const close of openClose) {
    try {
      await close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  openClose.clear();
});

const REAL_KEY = 'upstream-must-see-this-REAL-KEY';
const DUMMY = 'agent-side-placeholder';

function tmpKeyFile(contents) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-proxy-'));
  const f = nodePath.join(dir, 'creds.yaml');
  if (contents !== null) nodeFs.writeFileSync(f, contents, { mode: 0o600 });
  return f;
}

/** 一个假上游：把收到的 Authorization 记下来，然后按剧本回。 */
function fakeUpstream({ stream = false } = {}) {
  const seen = [];
  const server = nodeHttp.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({
      url: req.url,
      auth: req.headers.authorization ?? null,
      method: req.method,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 第一段\n\n');
      // ⚠️ 故意留一段时间：**缓冲的代理**会把两段一起送来
      setTimeout(() => {
        res.write('data: 第二段\n\n');
        res.end();
      }, 250);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const close = () => new Promise((r) => server.close(() => r()));
  openClose.add(close);
  return {
    seen,
    listen: () =>
      new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close,
  };
}

const startProxy = async (opts) => {
  const lines = [];
  // ⚠️ **端口用 0（临时端口）**：每个用例都绑默认的 8787 的话，
  //    前一个用例**断言提前失败**（代理没被关掉）会让后面全部 `EADDRINUSE`
  //    —— 于是一条真问题被放大成七条，根因反而看不见了。
  const p = startModelProxy({ port: 0, log: (m) => lines.push(m), ...opts });
  const { port } = await p.listen();
  openClose.add(() => p.close());
  return { p, port, lines };
};

// ── ① 解析（纯函数）──────────────────────────────────────────

test('★ `parseKey`：单行 / YAML 那种 / 引号 / 注释 / 空', () => {
  assert.equal(parseKey('sk-abc\n'), 'sk-abc', '单行就是整把 key');
  assert.equal(parseKey('DEEPSEEK_API_KEY: sk-abc\n'), 'sk-abc', '名字: 值');
  assert.equal(parseKey('  "sk-abc"  \n'), 'sk-abc', '去引号与空白');
  assert.equal(parseKey('# 注释\n\nsk-abc\n'), 'sk-abc', '注释与空行跳过');
  assert.equal(parseKey('OTHER: x\nSOME_API_KEY: sk-abc\n'), 'sk-abc', '优先取名字带 KEY 的那条');
  assert.equal(parseKey(''), null);
  assert.equal(parseKey('   \n# 只有注释\n'), null);
  assert.equal(parseKey('NAME:\n'), null, '值是空的 ⇒ 不算有 key（不许拿空串去请求）');
});

test('★ `readKeyFile`：文件不在 ⇒ null（**不抛**，让调用方回 503）', () => {
  assert.equal(readKeyFile('/definitely/not/here'), null);
  const f = tmpKeyFile('sk-abc\n');
  assert.equal(readKeyFile(f), 'sk-abc');
});

// ── ② 🔴 换头：上游看到的必须是**真 key**（这一条是全部意义）────

test('🔴 agent 发占位符 ⇒ 上游收到的是**真 key**（带负向对照）', async () => {
  const up = fakeUpstream();
  const upPort = await up.listen();
  const keyFile = tmpKeyFile(`HUPO_MODEL_KEY: ${REAL_KEY}\n`);
  const { p, port } = await startProxy({
    keyFile,
    upstream: `http://127.0.0.1:${upPort}`,
  });

  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DUMMY}` },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [] }),
  });
  assert.equal(r.status, 200);
  assert.equal(up.seen.length, 1, '上游应当被请求一次');
  // ★ 要的那一条
  assert.equal(up.seen[0].auth, `Bearer ${REAL_KEY}`, '★ 上游必须收到真 key');
  // 🔴 负向对照：**绝不能**是 agent 那边那个占位符
  assert.notEqual(up.seen[0].auth, `Bearer ${DUMMY}`, '🔴 上游收到占位符 = 这条路根本没接上');
  // 路径与 body 原样带过去（代理不是"改写请求"，只换那一件）
  assert.equal(up.seen[0].url, '/v1/chat/completions');
  assert.match(up.seen[0].body, /deepseek-flash/);

  await p.close();
  await up.close();
});

test('★ 占位符**不出现在**转出去的头上（真 key 与占位符不会同时出现）', async () => {
  const up = fakeUpstream();
  const upPort = await up.listen();
  const keyFile = tmpKeyFile(REAL_KEY);
  const { p, port } = await startProxy({ keyFile, upstream: `http://127.0.0.1:${upPort}` });
  await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: `Bearer ${DUMMY}` },
  });
  const auth = up.seen[0].auth;
  assert.ok(!auth.includes(DUMMY), `🔴 占位符不许漏到上游：${auth}`);
  await p.close();
  await up.close();
});

// ── ③ 没有 key ⇒ 如实 503，而且**不打扰上游** ────────────────

test('🔴 没有 key ⇒ 503 `no-key`，而且**一次都没去请求上游**', async () => {
  const up = fakeUpstream();
  const upPort = await up.listen();
  const { p, port } = await startProxy({
    keyFile: tmpKeyFile(null), // 文件不存在
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST' });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, 'no-key');
  assert.match(j.text, /凭据|key/, '要说清是"还没有凭据"，不是"模型鉴权失败"');
  assert.equal(up.seen.length, 0, '🔴 没 key 时不许去试上游（那会让用户看到假的原因）');

  await p.close();
  await up.close();
});

test('★ 负向对照：key 就位之后同一个请求**不再是 503**', async () => {
  const up = fakeUpstream();
  const upPort = await up.listen();
  const keyFile = tmpKeyFile(REAL_KEY);
  const { p, port } = await startProxy({ keyFile, upstream: `http://127.0.0.1:${upPort}` });
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST' });
  assert.notEqual(r.status, 503);
  await p.close();
  await up.close();
});

// ── ④ 流式（不许缓冲）────────────────────────────────────────

test('🔴 流式透传：**第一段在第二段发出之前**就到了客户端（没缓冲）', async () => {
  const up = fakeUpstream({ stream: true });
  const upPort = await up.listen();
  const keyFile = tmpKeyFile(REAL_KEY);
  const { p, port } = await startProxy({ keyFile, upstream: `http://127.0.0.1:${upPort}` });

  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST' });
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const t0 = Date.now();
  const first = await reader.read();
  const tFirst = Date.now() - t0;
  const firstText = dec.decode(first.value);
  assert.match(firstText, /第一段/, '先到的应该是第一段');

  const second = await reader.read();
  const secondText = dec.decode(second.value);
  assert.match(secondText, /第二段/);

  // ⚠️ 上游是 250ms 之后才发第二段的；如果代理**缓冲**了，第一段也会在 250ms 后才到
  assert.ok(
    tFirst < 200,
    `🔴 第一段用了 ${tFirst}ms 才到 —— 像是被缓冲了（上游 250ms 后才发第二段）`,
  );

  await p.close();
  await up.close();
});

// ── ⑤ 🔴 日志里不许出现 key ─────────────────────────────────

test('🔴 代理的日志里**一个字节的 key 都没有**（拿真日志扫）', async () => {
  const up = fakeUpstream();
  const upPort = await up.listen();
  const keyFile = tmpKeyFile(REAL_KEY);
  const { p, port, lines } = await startProxy({ keyFile, upstream: `http://127.0.0.1:${upPort}` });
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST' });
  const all = lines.join('\n');
  assert.ok(lines.length > 0, '至少该有"起来了"那一行');
  assert.ok(!all.includes(REAL_KEY), `🔴 日志里出现了 key：${all}`);
  assert.ok(!all.includes('Bearer'), '连 Authorization 那种形状都不该出现');
  // 负向对照：日志**确实**在报东西（不是"什么都没打"所以扫不到）
  assert.match(all, /模型代理/);
  await p.close();
  await up.close();
});

// ── ⑥ 只监听回环（生产形态）─────────────────────────────────

test('★ 默认只绑回环：拿"本机非回环地址"连不上', async () => {
  const up = fakeUpstream();
  const upPort = await up.listen();
  const { p, port } = await startProxy({
    keyFile: tmpKeyFile(REAL_KEY),
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const addr = p.server.address();
  assert.equal(addr.address, '127.0.0.1', '⚠️ 默认必须是回环：绑 0.0.0.0 等于把这把 key 递出去');
  await p.close();
  await up.close();
});
