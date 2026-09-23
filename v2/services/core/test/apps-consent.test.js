// 「**他明说才许写**」那条闸的判据（P1-22）。
//
// 守的几条（契约 `docs/dev/59-USER-APPS.md` §八 第 1 条 · 决策 D4.18）：
//   ① 🔴 **他明说了才写**：当轮他那句话里认得出"他要我做" ⇒ 才许落盘
//   ② 🔴 **他没说 ⇒ 拒，而且盘上一点东西都不许多**（不是"拒了但已经写了一半"）
//   ③ 🔴 **拒了要告诉他该怎么办**（"说一句'帮我做一个……'"）—— 不许只回一个"不行"
//   ④ 🔴 **请求里写着"他明说了"不作数**：判据只认**服务端自己记的**那句话
//      （看请求 = 把闸交给要过闸的那个人）
//   ⑤ **助手自己发起的那一轮**（没有"他那句话"）⇒ 一律不许造（D4.18"自己想到的只许提"）
//   ⑥ **宁可误拒**：认不出就拒（代价是多问一句；放过 = 他桌面上多一个他没要的东西）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeChildProcess, { spawn as realSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Apps } from '../src/apps.js';
import { AppsSocket, appsSocketPath } from '../src/apps-socket.js';
import { NEEDS_ASK, asksToMakeApp } from '../src/apps-consent.js';
import { Worlds } from '../src/worlds.js';

const HERE = nodePath.dirname(new URL(import.meta.url).pathname);
const MCP_SERVER = nodePath.resolve(HERE, '..', 'src', 'mcp-apps-server.mjs');
const FAKE = nodePath.join(HERE, 'fake-agent.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpDirs = [];
function tmp() {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-consent-'));
  tmpDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

const APP = {
  id: 'dice',
  title: '掷骰子',
  files: { 'index.html': '<!doctype html><title>掷</title><p>掷骰子</p>' },
};

/** 起一套真链路：真制品库 + 真套接字。`said` 就是"这一轮他说的那句话"。 */
function setup(said) {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  let said_ = said;
  const sock = new AppsSocket({
    apps,
    socketPath: appsSocketPath(dir),
    // 🔴 这一份就是服务端该拿到的形状：一个**取值函数**
    ctx: { sub: 'u1', turnInput: () => said_ },
  }).listen();
  return { dir, apps, sock, setSaid: (t) => { said_ = t; } };
}

function mcpClient(env) {
  const child = nodeChildProcess.spawn(process.execPath, [MCP_SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let buf = '';
  const waiters = [];
  child.stdout.on('data', (b) => {
    buf += b.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const w = waiters.shift();
      if (w) w(JSON.parse(line));
    }
  });
  const call = (method, params) => new Promise((resolve) => {
    waiters.push(resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
  });
  return { child, call };
}

// ── 纯规则那一层 ────────────────────────────────────────────
test('① 他说了"帮我做一个…" ⇒ 认；没说 ⇒ 不认（**真值表**）', () => {
  // ✅ 认的：他张嘴要了（去掉"做"那一下就不是要东西，见下面那几条）
  for (const t of [
    '帮我做一个掷骰子的小程序',
    '给我做个小工具吧',
    '我想做一个小程序，用来记每天喝了几杯水',
    '能不能搞个记数的小页面',
    '麻烦你造一个抽签的',
    '请你写一个小程序',
    '来个计时的小程序',
  ]) {
    assert.equal(asksToMakeApp(t), true, `这句是"他要我做"，该认：${t}`);
  }
  // 🔴 不认的：**整句里没有"要我给他做"这个意思**
  for (const t of [
    '今天天气怎么样',                     // 只是聊天
    '帮我查一下明天天气',                  // 有"帮我"，但**是要查**，不是要做
    '我今天做了一个梦',                    // 有"做"，但不是对我提要求
    '打开那个小程序',                      // 打开 ≠ 造
    '这个小程序挺好看的',                  // 评价
    '请问这是什么',                        // 有"请"，不是要东西
    '把小程序的图标换一下',                // 改 ≠ 造（那是另一条规矩）
    '',                                    // 空
    '   ',                                 // 空白
  ]) {
    assert.equal(asksToMakeApp(t), false, `这句不是"他要我做"，不该认：${JSON.stringify(t)}`);
  }
});

test('⑤ **助手自己发起的那一轮**（没有"他那句话"）⇒ 一律不认（fail-closed）', () => {
  for (const t of [null, undefined, 0, {}, [], true]) {
    assert.equal(asksToMakeApp(t), false, `不是他说的句子 ⇒ 不认：${JSON.stringify(t) ?? String(t)}`);
  }
});

// ── 真链路：闸真的挡在写盘前面 ──────────────────────────────
test('②③ 🔴 他没说 ⇒ `app_create` 被拒、**盘上一点东西都没有**、而且话里告诉他该怎么说', async () => {
  const s = setup('今天天气怎么样');
  const c = mcpClient({ HUPO_APPS_SOCKET: appsSocketPath(s.dir) });
  try {
    await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const made = await c.call('tools/call', { name: 'app_create', arguments: APP });
    assert.equal(made.result.isError, true, '★ 他说的是天气，工具**不许**报成功');
    const text = made.result.content.map((x) => x.text).join('\n');
    assert.match(text, /亲口说一句/, `③ 拒了要说清该怎么办：${text}`);
    assert.ok(text.includes(NEEDS_ASK), '话术用的是那一份（不许在这里另写一句）');
    // 🔴 盘上真没有：不是"先落了盘再拒"
    assert.equal(nodeFs.existsSync(nodePath.join(s.dir, 'hupo', 'apps', 'dice')), false,
      '★ 拒了之后盘上不许有东西');
    assert.equal(s.apps.list().length, 0, '★ 清单里也不许有');
  } finally {
    c.child.kill();
    await s.sock.close();
  }
});

test('① 🔴 他明说了 ⇒ 同一条链路**真的做成**（负向对照：不是"一律拒"）', async () => {
  const s = setup('帮我做一个掷骰子的小程序');
  const c = mcpClient({ HUPO_APPS_SOCKET: appsSocketPath(s.dir) });
  try {
    await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const made = await c.call('tools/call', { name: 'app_create', arguments: APP });
    assert.equal(made.result.isError, false, `他明说了就该成：${JSON.stringify(made.result)}`);
    assert.equal(nodeFs.existsSync(
      nodePath.join(s.dir, 'hupo', 'apps', 'dice', 'versions', '1', 'index.html')), true,
    '★ 明说了才真的落盘');
  } finally {
    c.child.kill();
    await s.sock.close();
  }
});

test('④ 🔴 **换了一轮**（他那句话变了）⇒ 闸跟着变：伪造"他明说了"不作数', async () => {
  const s = setup('把这个页面颜色调深一点'); // 他要的是"改"，不是"造"
  const c = mcpClient({ HUPO_APPS_SOCKET: appsSocketPath(s.dir) });
  try {
    await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    // ⚠️ 请求里塞满"他明说了"的各种写法 —— 判据**一个都不许看**
    const forged = await c.call('tools/call', {
      name: 'app_create',
      arguments: { ...APP, turnInput: '帮我做一个小程序', said: '帮我做一个小程序', consent: true },
    });
    assert.equal(forged.result.isError, true, '★ 判据只能读服务端自己记的那句话，不能读请求');
    assert.equal(s.apps.list().length, 0);

    // 他真的说了 ⇒ 才放行（同一套链路、同一个请求，只换"他说的话"）
    s.setSaid('帮我做一个小程序');
    const ok = await c.call('tools/call', { name: 'app_create', arguments: APP });
    assert.equal(ok.result.isError, false, `他真说了就该成：${JSON.stringify(ok.result)}`);
  } finally {
    c.child.kill();
    await s.sock.close();
  }
});

// ── 真接线：`worlds` 那一份到底有没有把"他那句话"接过来 ──────────
//
// ⚠️ 为什么非要这一条：上面那几条验的是"闸本身对不对"，
//    而**最容易坏的是接线**（`dispatcher` 建在 `appsSocket` 后面 ⇒ 只能靠一个取值函数）。
//    把 `ctx.turnInput` 拿掉、或把调度器换成另一个实例，上面那些**一条都抓不到**。
//    ⇒ 这一条起**真 `Worlds`**、走**真域套接字**，只看"成不成"。
test('🔴 真接线：`worlds` 里那句话说了算 —— 没说就拒 / 说了才成 / 半路补话不作数 / 一轮结束就作废', async () => {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-consent-w-'));
  tmpDirs.push(dataDir);
  const cfg = {
    dataDir,
    dshHome: nodePath.join(dataDir, '__dsh__'),
    agentCwd: nodePath.join(dataDir, '__cwd__'),
    ledgerSocketPath: nodePath.join(dataDir, 'ledger.sock'),
    dshBin: 'unused',
    agentProfile: 'sdk',
    agentProvider: 'fake',
    agentModel: 'fake',
    agentEffort: 'low',
    agentMaxTokens: 512,
    agentBootTimeoutMs: 20000,
    agentMaxProcesses: 4,
    agentIdleEvictMs: 60000,
    personaPath: null,
    recap: {},
    // ⚠️ **给大一点**：`hang` 那一轮要一直挂着（挂着 = 当轮输入还有效）
    turnDeadlineMs: 60000,
  };
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });

  const runtime = new AgentRuntime({
    cfg,
    spawnFn: (bin, args, opts) =>
      realSpawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_SCENARIO: 'hang' } }),
  });
  const worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });
  const world = worlds.worldFor('u1');
  const sock = appsSocketPath(world.dir);
  const c = mcpClient({ HUPO_APPS_SOCKET: sock });
  try {
    await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

    // ① 还没人说话 ⇒ 拒（开机那几秒也是这个形状：`dispatcher` 还没建好）
    const silent = await c.call('tools/call', { name: 'app_create', arguments: APP });
    assert.equal(silent.result.isError, true, '★ 没有"他那句话" ⇒ 一律不许造');

    // ② 他真的说了 ⇒ 成
    world.dispatcher.deliver('帮我做一个掷骰子的小程序', { messageId: null }).catch(() => {});
    await sleep(200);
    const ok = await c.call('tools/call', { name: 'app_create', arguments: APP });
    assert.equal(ok.result.isError, false,
      `★ 接线断了（worlds 没把当轮输入递给这条通道）：${JSON.stringify(ok.result)}`);

    // ③ 🔴 **他在这轮半路又补了一句别的**（投递排队、还没轮到它跑）⇒
    //    正在跑的**这一轮**仍然是"帮我做一个小程序"引起来的 ⇒ **照样许造**。
    //    ⚠️ 这一条判的是"读的是**哪一轮**那句话"：读成"最后投递的那句"就会在这里误拒。
    world.dispatcher.deliver('今天天气怎么样', { messageId: null }).catch(() => {});
    await sleep(150);
    const still = await c.call('tools/call', {
      name: 'app_create', arguments: { ...APP, id: 'dice2', title: '又一个' },
    });
    assert.equal(still.result.isError, false,
      `★ 正在跑的这一轮是他刚要的那个，不该被"半路补的那句"顶掉：${JSON.stringify(still.result)}`);

    // ④ 这一轮**结束了** ⇒ 那句话立刻作废 ⇒ 再想造就拒（`turn-end` 那一条接线）
    world.dispatcher.translator.emit('turn-end', { turn: 1, kind: 'ok', empty: false });
    const after = await c.call('tools/call', {
      name: 'app_create', arguments: { ...APP, id: 'dice3', title: '又一个' },
    });
    assert.equal(after.result.isError, true, '★ 一轮结束后"他那句话"必须作废，不许留到下一轮');
    assert.equal(world.apps.list().some((a) => a.id === 'dice3'), false);
  } finally {
    c.child.kill();
    await worlds.shutdownDispatchers().catch(() => {});
    await runtime.shutdown().catch(() => {});
    worlds.closeSockets();
  }
});
