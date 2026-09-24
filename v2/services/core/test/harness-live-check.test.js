// **`scripts/check-harness.mjs` 自己也要有判据**（判据 H9 / H10 的那条脚本）。
//
// 为什么值得：那条脚本是"部署之后唯一会去连真系统"的东西。
// 它自己没验过的话，最坏的情况是**它永远绿**或**它永远红**——
// 而两种都会让人以为"那条路验过了"（本仓库最忌的那种：闸给人错觉）。
//
// 这一份**不部署、不碰线上**：在测试进程里摆一对**真的**宿主 + 真的容器，
// 用现成的那条 `proxyUpgrade` 把两边接起来，然后用**真的子进程**去跑那条脚本：
//
//   浏览器/脚本 ──WS(令牌)──▶ 宿主公开口 ──proxyUpgrade(原样字节)──▶ 容器可信口(UDS)
//                                                                    └─▶ 真 relay ─▶ 假 DSH
//
// ⇒ 脚本里那三段（H9 主连接 / H10a 没令牌 / H10b 公网口）都会被真的走一遍。
// 唯一"假"的是最后那个 DSH 进程（`test/fake-harness-dsh.mjs`）——那是对的：
// 判据不该为了自己跑得起来而在线上花主人的钱。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

import { Auth } from '../src/auth.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { createServer } from '../src/server.js';
import { createHarnessRelay } from '../src/harness-session.mjs';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, '../../../..');
const SCRIPT = nodePath.join(REPO, 'scripts/check-harness.mjs');
const FAKE_DSH = nodePath.join(HERE, 'fake-harness-dsh.mjs');
const MODEL_PATCH = nodePath.resolve(HERE, '../hupo-model-proxy.yml');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const closers = new Set();
const kids = new Set();
after(async () => {
  for (const c of closers) {
    try {
      await c();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  for (const c of kids) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
  await sleep(50);
});

/** 一对"宿主 + 容器"（真进程结构：容器只从那条 UDS 被够到）。 */
async function pair() {
  const hostData = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-check-host-'));
  const boxDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-check-box-'));
  const sock = nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-check-sock-')), 'api.sock');

  const timelineOf = (dataDir) => {
    const store = new Store({ dataDir, fsync: false });
    return { store, timeline: new Timeline({ id: 'main', store }) };
  };

  // ── 容器那一台：**没有口令**（身份由宿主验），harness 真跑起来 ──
  const boxTL = timelineOf(boxDir);
  const boxAuth = new Auth({ dataDir: boxDir });
  const relay = createHarnessRelay({
    cfg: {
      dshBin: 'unused',
      agentProfile: 'sdk',
      agentCwd: boxDir,
      dshHome: boxDir,
      agentProvider: 'deepseek-official',
      agentModel: 'deepseek-flash',
      agentEffort: 'low',
      agentMaxTokens: 16000,
      agentBootTimeoutMs: 20000,
      agentUid: null,
      agentGid: null,
      modelPatchPath: MODEL_PATCH,
    },
    spawnFn: (bin, args, opts) => {
      const child = realSpawn(process.execPath, [FAKE_DSH, ...args], opts);
      kids.add(child);
      child.on('exit', () => kids.delete(child));
      return child;
    },
    killGraceMs: 300,
  });
  const box = createServer({
    timeline: boxTL.timeline,
    store: boxTL.store,
    auth: boxAuth,
    say: new SayService({ timeline: boxTL.timeline, store: boxTL.store, timelineId: 'main' }),
    webRoot: null,
    buildId: 'check-harness-box',
    harness: relay,
  });
  await box.listen(0);
  await box.listenTrusted(sock);
  closers.add(() => box.close());

  // ── 宿主那一台：有口令、有租户、**没有**那台 DSH（它只转发）──
  const hostTL = timelineOf(hostData);
  const hostAuth = new Auth({ dataDir: hostData });
  hostAuth.setPassword('这一份判据用的口令');
  const host = createServer({
    timeline: hostTL.timeline,
    store: hostTL.store,
    auth: hostAuth,
    say: new SayService({ timeline: hostTL.timeline, store: hostTL.store, timelineId: 'main' }),
    webRoot: null,
    buildId: 'check-harness-host',
    harness: null, // ★ 宿主上**没有**这条路（走到它一律拒）
    tenantOf: (sub) => (sub === 'u2' ? 'hupo-b' : null),
    proxyFor: () => nodeNet.connect(sock),
    isLocalUser: (sub) => sub === 'owner',
  });
  const addr = await host.listen(0);
  closers.add(() => host.close());

  return {
    origin: `http://127.0.0.1:${addr.port}/`,
    dataDir: hostData,
    token: hostAuth.issue({ sub: 'u2' }).token,
  };
}

test('🔴 前面那层**不转发 Upgrade**（nginx 那条 location 的坑）⇒ 脚本要认出来、并指到对的地方', async () => {
  // 一个"假 nginx + 假 app"：
  //   · `/api/stream` 照常升级（那条路径真的能通 —— 这是判据的"负向对照"）；
  //   · 别的路径一律按**普通 GET**回 401（= nginx 把 Upgrade 头丢了之后 app 的答复）。
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-check-nginx-'));
  const auth = new Auth({ dataDir });
  auth.setPassword('这一份判据用的口令');
  const srv = nodeHttp.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  const streamWss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, sock, head) => {
    if (String(req.url).startsWith('/api/stream')) {
      streamWss.handleUpgrade(req, sock, head, (ws) => ws.on('error', () => {}));
      return;
    }
    sock.write(
      'HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json; charset=utf-8\r\n' +
        'content-length: 24\r\nconnection: close\r\n\r\n{"error":"unauthorized"}',
    );
    sock.destroy();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}/`;
  closers.add(
    () =>
      new Promise((r) => {
        for (const ws of streamWss.clients) {
          try {
            ws.terminate();
          } catch {
            /* 已经没了 */
          }
        }
        streamWss.close(() => srv.close(() => r()));
      }),
  );

  const token = 'not-a-real-token-but-shaped-like-one-000';
  const child = realSpawn(process.execPath, [SCRIPT, '--url', origin, '--wait', '3000', '--data', dataDir], {
    env: { ...process.env, HUPO_TOKEN: token, HUPO_OWNER_TOKEN: '' },
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += String(d);
  });
  child.stderr.on('data', (d) => {
    out += String(d);
  });
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  assert.equal(code, 2, `H9 该没通（别的该通）—— 实际 ${code}：\n${out}`);
  // 🔴 要**指到那一层**（不然下一个人会一直去查令牌/盒子，而问题在 nginx）
  assert.match(out, /`\/api\/stream` 上是\*\*通的\*\*/u);
  assert.match(out, /Upgrade/u);
  assert.match(out, /nginx/u);
  assert.ok(!out.includes(token), '输出里出现了令牌');
});
test('★ `scripts/check-harness.mjs` 对一对**真的**宿主+容器跑：H9/H10a/H10b 全通，而且不打印令牌', async () => {
  const p = await pair();
  // ⚠️ 必须**异步** spawn：`spawnSync` 会把测试进程的事件循环堵死，
  //    而这一对服务就活在这个进程里 ⇒ 子进程永远等不到握手（第一次就是这么挂的）。
  const child = realSpawn(process.execPath, [SCRIPT, '--url', p.origin, '--wait', '20000', '--data', p.dataDir], {
    env: { ...process.env, HUPO_TOKEN: p.token, HUPO_OWNER_TOKEN: '' },
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += String(d);
  });
  child.stderr.on('data', (d) => {
    out += String(d);
  });
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  assert.equal(code, 0, `脚本该全通（退出码 ${code}）：\n${out}`);
  // 三段都要真的走到（不是"没验到"）
  assert.match(out, /H9 收到 `assistant\/message`/u);
  assert.match(out, /H9 流里没有琥珀人格/u);
  assert.match(out, /H10a 不带令牌 ⇒ 拒/u);
  assert.match(out, /H10b 公网口 ⇒ 拒/u);
  assert.match(out, /0 没通/u);
  // 🔴 **令牌一个字都不许出现**（哪怕脚本是被判据跑的）
  assert.ok(!out.includes(p.token), '输出里出现了令牌');
  // 证据行里要有它自己那句人话（真模型会变，但假 DSH 这句是固定的）
  assert.match(out, /我是 DeepSeek Harness 驱动的 AI 编码助手/u);
});
