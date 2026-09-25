// 92 §③ **阶段 2**：出界收成一条独木桥 ＋ 让声明带上锚
// （契约 `docs/dev/92-TRIPLE-PLAN.md` §② 第三条硬规矩 · §③ 阶段 2 · §④ 离线那一栏）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
// 92 §⑤·4 记着今天的病：`.exp/notes.json` 放一份"受版权记录" ＋ `share:true`
// ⇒ **今天全绿**（上架路从不读申报、也从不核锚）。这一份就是"补上了没有"的判据，
// **每条都带反例**：
//
//   §2-1  🔴 反例：`.exp/` 里 `share:true` 而**没有锚** ⇒ 上架**必须红**（盘上零残留）
//   §2-2  ★  正对照：补上来源 `rootHash` ⇒ **过**（证明闸不是空转、也不是"有 .exp 就拒"）
//   §2-3  🔴 删锚 ⇒ **又拒**（同一条声明：加锚过、删锚拒）
//   §2-4  🔴 `share:false` 不必带锚 ⇒ 照旧过（闸只拦"声明了可分享"的）
//   §2-5  🔴 锚的形状对、但**核不出来** ⇒ 拒
//   §2-6  🔴 锚指回上游那一版、而**血缘里没有那条边** ⇒ 拒；补上边 ⇒ 过
//   §2-7  🔴 fail-closed：声明**读不到 / 看不懂 / schema 认不出 / 没有条目表** ⇒ 拒
//   §2-8  `.exp/` 下的散文件（未归类）⇒ 不拦（按 §② 第 2 步是"永不出"）
//   §2-9  🔴 **旁路逐条打**：直调 / 本地那条口 / MCP 工具 —— 一条都绕不过
//   §2-10 🔴 **第二出口**：写共享库的文件只许一个，而且它必须过闸（扫源码）
//
// ⚠️ 风格照仓库现有测试：不起 HTTP；§2-9 的第三路**起真进程**
//    （MCP 工具 → 域套接字 → 服务端），与 `apps-chain.test.js` 同一形状。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeChildProcess from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Apps } from '../src/apps.js';
import { AppsSocket, appsSocketPath, handleAppsOp } from '../src/apps-socket.js';
import {
  OUTBOUND_ROUTES,
  OutboundError,
  adjudicate,
  assertOutboundAllowed,
  readPacks,
} from '../src/outbound.js';
import { Published } from '../src/published.js';
import { buildReviewPolicy } from '../src/review.js';
import { AppWorkspaces } from '../src/workspace.js';

const HERE = nodePath.dirname(new URL(import.meta.url).pathname);
const SRC = nodePath.resolve(HERE, '..', 'src');
const MCP_SERVER = nodePath.join(SRC, 'mcp-apps-server.mjs');

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-outbound-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/**
 * 一套：一个人（制品库 ＋ 工作区）＋ 共享库。
 * ⚠️ 共享库的 `dir` 与那个人的 `dir` **同一层**（`<dir>/published-apps/`）——
 *    与单测里既有的摆法一致（`apps-chain.test.js`）。
 */
function world() {
  const dir = tmp();
  const apps = new Apps({ dir, sub: 'u1' });
  const workspaces = new AppWorkspaces({ dir, log: () => {} });
  const published = new Published({ dir });
  return { dir, apps, workspaces, published };
}

const APP = { title: '新闻', icon: 'dice', entry: 'index.html' };

// ★ **A16：外联申报是制品里的一个固定名文件**（93 §2.2 · 主人第 5 条）。
//   这一批起，制品没有它 ⇒ **上架拒**（fail-closed）⇒ 这一组夹具要带上它。
//   ⚠️ 它**不是** `manifest.json` 的字段：改它 ⇒ `rootHash` 变（判据 2.3.1）。
const DECLARATION = JSON.stringify({
  schema: 1,
  outbound: [],
  declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '还没人用过，先按 0 报' },
});

/**
 * ★ **预审那两样是注入的**（96 第 3b／4 条 · 93 §八 的"真模型调用可以先留成可注入的"）：
 *   规则本来住**产品层**（只读挂载＋指纹），评审 agent 是一个真模型调用。
 *   这一组验的是**出界闸**，所以给一份最小的规则 ＋ 一个说"没风险"的评审，
 *   让"预审"这一关不挡住它们 —— 预审自己的判据在 `app-review.test.js`。
 */
const TEST_POLICY = buildReviewPolicy({ fingerprint: 'test' });
const TEST_REVIEWER = async () => ({ summary: '没看到外联风险', risks: [], rating: 0, verdict: 'pass' });

/** 造一版并返回那份 manifest（`rootHash` 就是"可核起点"）。 */
function makeApp(w, id = 'news', body = '<p>第一版</p>') {
  w.apps.create({ id, ...APP, files: { 'index.html': body, 'outbound.json': DECLARATION } });
  return w.apps.manifest(id, w.apps.current(id));
}

const sharedAppDir = (w, id) => nodePath.join(w.dir, 'published-apps', id);

/** 往 `.exp/<pack>/pack.json` 写一份声明（`json` 给字符串就原样写 —— 用来造坏声明）。 */
function writePack(w, id, pack, json) {
  const dir = nodePath.join(w.workspaces.dirFor(id), '.exp', pack);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(dir, 'pack.json'),
    typeof json === 'string' ? json : `${JSON.stringify(json, null, 2)}\n`,
  );
}

const withAnchor = (rootHash) => ({
  schema: 1,
  expVersion: 1,
  title: '攒下来的门道',
  items: [{ path: 'rank.md', kind: 'prompt', share: true, anchor: { rootHash } }],
});

const noAnchor = () => ({
  schema: 1,
  expVersion: 1,
  title: '攒下来的门道',
  items: [{ path: 'rank.md', kind: 'prompt', share: true }],
});

/** 抓一次抛（`assert.throws` 不给看 message 之外的东西）。 */
function caught(fn) {
  try { fn(); return null; } catch (err) { return err; }
}

// ════════════════════════════════════════════════════════════════
// §2-1 🔴 反例：无锚的 `share:true` ⇒ 上架红
// ════════════════════════════════════════════════════════════════

test('🔴 §2-1 反例：`.exp/` 里标了可分享却**没有锚** ⇒ 上架必须红（盘上零残留）', () => {
  const w = world();
  makeApp(w);
  writePack(w, 'news', 'notes', noAnchor());

  const err = caught(() => w.published.publish(w.apps, { id: 'news', authorSub: 'u1', authorName: '甲' }));
  assert.ok(err, '🔴 无锚的 share:true 必须被拒（今天它全绿 —— 92 §⑤·4 那条病）');
  assert.equal(err.name, 'OutboundError', String(err));
  assert.match(err.message, /可核起点|声明不可核/, `拒的话要是人话（N11）：${err.message}`);

  // 🔴 拒的时候**共享库一个字节都不动**（不许"写一半再回滚"）
  assert.equal(nodeFs.existsSync(sharedAppDir(w, 'news')), false, '盘上零残留');
  assert.deepEqual(w.published.discover(), [], '发现页里不许出现它');
});

// ════════════════════════════════════════════════════════════════
// §2-2 ★ 正对照：带锚 ⇒ 过（闸不是空转）
// ════════════════════════════════════════════════════════════════

test('★ §2-2 正对照：补上来源 `rootHash` ⇒ 过（闸不是空转）', () => {
  const w = world();
  const man = makeApp(w);
  writePack(w, 'news', 'notes', withAnchor(man.rootHash));

  const idx = w.published.publish(w.apps, { id: 'news', authorSub: 'u1', authorName: '甲' });
  assert.equal(idx.rootHash, man.rootHash, '可核起点逐字带出去');
  assert.equal(
    nodeFs.existsSync(nodePath.join(sharedAppDir(w, 'news'), 'versions', '1', 'index.html')),
    true,
    '★ 真的复制进共享库了（正对照不许是空跑）',
  );
  assert.deepEqual(w.published.discover().map((a) => a.id), ['news']);
});

// ════════════════════════════════════════════════════════════════
// §2-3 🔴 删锚 ⇒ 又拒（同一条声明）
// ════════════════════════════════════════════════════════════════

test('🔴 §2-3 同一条声明：加锚 ⇒ 过；**删锚 ⇒ 又拒**', () => {
  const w = world();
  const man = makeApp(w);
  writePack(w, 'news', 'notes', withAnchor(man.rootHash));
  w.published.publish(w.apps, { id: 'news', authorSub: 'u1', authorName: '甲' });

  // 只把锚摘掉（别的字节不动）⇒ 必须又红
  writePack(w, 'news', 'notes', noAnchor());
  const err = caught(() => w.published.publish(w.apps, { id: 'news', authorSub: 'u1', authorName: '甲' }));
  assert.ok(err, '🔴 删掉锚之后必须又拒');
  assert.equal(err.name, 'OutboundError', String(err));
});

// ════════════════════════════════════════════════════════════════
// §2-4 🔴 只有 `share:true` 才要锚
// ════════════════════════════════════════════════════════════════

test('🔴 §2-4 `share:false`／没写 share 的条目**不必带锚** ⇒ 照旧过', () => {
  const w = world();
  makeApp(w);
  writePack(w, 'news', 'notes', {
    schema: 1,
    expVersion: 1,
    items: [
      { path: 'private.md', kind: 'note', share: false },
      { path: 'draft.md', kind: 'note' }, // 没写 share ⇒ 默认最严：不带出去（也不需要锚）
    ],
  });
  const idx = w.published.publish(w.apps, { id: 'news', authorSub: 'u1', authorName: '甲' });
  assert.equal(idx.id, 'news');
});

// ════════════════════════════════════════════════════════════════
// §2-5 🔴 锚核不出来 ⇒ 拒
// ════════════════════════════════════════════════════════════════

test('🔴 §2-5 锚的形状对、但在我们这儿**核不出来** ⇒ 拒', () => {
  const w = world();
  makeApp(w);
  writePack(w, 'news', 'notes', withAnchor('a'.repeat(64)));
  const err = caught(() => w.published.publish(w.apps, { id: 'news', authorSub: 'u1' }));
  assert.ok(err, '🔴 核不出来的锚必须被拒');
  assert.match(err.message, /核不出来/, String(err.message));
  assert.equal(nodeFs.existsSync(sharedAppDir(w, 'news')), false);
});

test('🔴 §2-5b 锚根本不是一条 `rootHash`（自由文本）⇒ 拒', () => {
  const w = world();
  makeApp(w);
  writePack(w, 'news', 'notes', withAnchor('这是我自己的一个版本'));
  const err = caught(() => w.published.publish(w.apps, { id: 'news', authorSub: 'u1' }));
  assert.ok(err);
  assert.match(err.message, /锚认不出|可核起点/, String(err.message));
});

// ════════════════════════════════════════════════════════════════
// §2-6 🔴 血缘：锚指回上游，必须有边
// ════════════════════════════════════════════════════════════════

test('🔴 §2-6 锚指回上游那一版、而**血缘里没有那条边** ⇒ 拒；`noteLineage` 补上 ⇒ 过', () => {
  const w = world();
  const v1 = makeApp(w, 'news', '<p>第一版</p>');
  const v2 = makeApp(w, 'news', '<p>第二版（我改的）</p>');
  assert.notEqual(v1.rootHash, v2.rootHash, '起点：两版内容不同');
  // 申报说"这些门道长在第一版上"—— 但**没有一条边**说它是从第一版分出来的
  writePack(w, 'news', 'notes', withAnchor(v1.rootHash));

  const bad = caught(() => w.published.publish(w.apps, { id: 'news', authorSub: 'u1' }));
  assert.ok(bad, '🔴 没有边指回那个起点 ⇒ 血缘对不上 ⇒ 拒');
  assert.match(bad.message, /血缘对不上/, String(bad.message));
  assert.equal(nodeFs.existsSync(sharedAppDir(w, 'news')), false);

  // 补上边（分叉＝记上游那一版）⇒ 同一条声明就核得动了
  w.apps.noteLineage('news', { kind: 'fork', baseRootHash: v1.rootHash, baseVersion: 1, myVersion: 2 });
  const idx = w.published.publish(w.apps, { id: 'news', authorSub: 'u1' });
  assert.equal(idx.rootHash, v2.rootHash);
});

// ════════════════════════════════════════════════════════════════
// §2-7 🔴 fail-closed：声明读不到 / 认不出 ⇒ 拒
// ════════════════════════════════════════════════════════════════

test('🔴 §2-7 `.exp/<pack>/` 在、而声明**读不到 / 看不懂 / schema 认不出 / 没有条目表** ⇒ 一律拒', () => {
  const cases = [
    { name: '没有 pack.json', json: null, want: /没有可读的/ },
    { name: '不是 JSON', json: '{这不是 json', want: /看不懂/ },
    { name: 'schema 认不出', json: { schema: 99, items: [] }, want: /声明版本认不出/ },
    { name: '没有条目表', json: { schema: 1 }, want: /没有条目表/ },
    { name: 'items 不是数组', json: { schema: 1, items: 'later' }, want: /没有条目表/ },
  ];
  for (const c of cases) {
    const w = world();
    makeApp(w);
    const dir = nodePath.join(w.workspaces.dirFor('news'), '.exp', 'notes');
    nodeFs.mkdirSync(dir, { recursive: true });
    if (c.json !== null) {
      nodeFs.writeFileSync(nodePath.join(dir, 'pack.json'), typeof c.json === 'string' ? c.json : JSON.stringify(c.json));
    }
    const err = caught(() => w.published.publish(w.apps, { id: 'news', authorSub: 'u1' }));
    assert.ok(err, `🔴 ${c.name} ⇒ 必须拒（fail-closed，不是"当没有"）`);
    assert.match(err.message, c.want, `${c.name}：${err.message}`);
    assert.equal(nodeFs.existsSync(sharedAppDir(w, 'news')), false, `${c.name}：盘上零残留`);
  }
});

test('🔴 §2-7b 裁决没接上"核得出来吗"那一半 ⇒ 拒（不许安静地绿）', () => {
  const err = caught(() => adjudicate({ rootHash: 'b'.repeat(64), packs: [] }));
  assert.ok(err);
  assert.match(err.message, /没接上/);
});

// ════════════════════════════════════════════════════════════════
// §2-8 `.exp/` 下的散文件 = 未归类 = 永不出（不拦）
// ════════════════════════════════════════════════════════════════

test('§2-8 `.exp/` 下的散文件（未归类）⇒ 不拦；也没有任何 `.exp/` ⇒ 不拦', () => {
  const w = world();
  makeApp(w);
  const exp = nodePath.join(w.workspaces.dirFor('news'), '.exp');
  nodeFs.mkdirSync(exp, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(exp, 'notes.json'), JSON.stringify({ note: '未归类的东西' }));
  assert.deepEqual(readPacks({ scopeDir: w.workspaces.dirFor('news') }), [], '散文件连"可分享"都申报不了');
  const idx = w.published.publish(w.apps, { id: 'news', authorSub: 'u1' });
  assert.equal(idx.id, 'news');

  const w2 = world();
  makeApp(w2);
  assert.equal(w2.published.publish(w2.apps, { id: 'news', authorSub: 'u1' }).id, 'news', '根本没有 .exp/ ⇒ 照旧发');
});

// ════════════════════════════════════════════════════════════════
// §2-9 🔴 旁路逐条打：一条都绕不过
// ════════════════════════════════════════════════════════════════

test('🔴 §2-9a 旁路①：直调 `Published.publish`（老路）也拒', () => {
  const w = world();
  makeApp(w);
  writePack(w, 'news', 'notes', noAnchor());
  assert.throws(
    () => w.published.publish(w.apps, { id: 'news', authorSub: 'u1' }),
    (err) => err instanceof OutboundError,
  );
});

test('🔴 §2-9b 旁路②：本地那条口（`apps.sock` 的 `publish`，新路）也拒 —— 而且拒了不许写', async () => {
  const w = world();
  makeApp(w);
  writePack(w, 'news', 'notes', noAnchor());
  const ctx = {
    published: w.published, sub: 'u1', authorName: '甲', workspace: w.workspaces,
    // ★ 这一组验的是出界闸 ⇒ 预审给一份最小规则 ＋ 一个"没风险"的评审（见上面那段）
    reviewPolicy: TEST_POLICY, reviewAgent: TEST_REVIEWER,
  };

  const r = await handleAppsOp(w.apps, { op: 'publish', id: 'news' }, ctx);
  assert.equal(r.ok, false, `🔴 新路也必须拒：${JSON.stringify(r)}`);
  assert.match(String(r.error), /可核起点|声明不可核/, '拒的话要是人话');
  assert.equal(nodeFs.existsSync(sharedAppDir(w, 'news')), false, '盘上零残留');

  // 负向对照：补上锚 ⇒ 同一条新路就过（证明那条口的闸是"判"，不是"关"）
  writePack(w, 'news', 'notes', withAnchor(w.apps.manifest('news', 1).rootHash));
  const ok = await handleAppsOp(w.apps, { op: 'publish', id: 'news' }, ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(w.published.discover().map((a) => a.id), ['news']);
});

/** 把 MCP 那个进程拉起来（与 `apps-chain.test.js` 同一形状）。 */
function mcpClient(env) {
  const child = nodeChildProcess.spawn(process.execPath, [MCP_SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const stdoutLines = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() !== '') stdoutLines.push(line);
    }
  });
  child.stderr.resume();
  let id = 0;
  const waiters = new Map();
  const pump = setInterval(() => {
    while (stdoutLines.length > 0) {
      let msg;
      try { msg = JSON.parse(stdoutLines.shift()); } catch { continue; }
      const waiter = waiters.get(msg.id);
      if (waiter) { waiters.delete(msg.id); waiter(msg); }
    }
  }, 2);
  pump.unref?.();
  const call = (method, params, ms = 8000) => new Promise((resolve) => {
    const myId = ++id;
    const timer = setTimeout(() => { waiters.delete(myId); resolve({ timeout: true }); }, ms);
    waiters.set(myId, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  });
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  return { child, call, notify };
}

test('🔴 §2-9c 旁路③：**真 MCP 工具** `app_publish` ⇒ 也拒（上游那一层没有第二道判）', async () => {
  const w = world();
  const socketPath = appsSocketPath(w.dir);
  const sock = new AppsSocket({
    apps: w.apps,
    socketPath,
    ctx: {
      published: w.published,
      sub: 'u1',
      authorName: '用户 1111',
      workspace: w.workspaces,
      turnInput: () => '帮我做一个小程序',
      // ★ 预审那两样（见 `TEST_POLICY` 那段）
      reviewPolicy: TEST_POLICY,
      reviewAgent: TEST_REVIEWER,
    },
  }).listen();
  const c = mcpClient({ HUPO_APPS_SOCKET: socketPath });
  try {
    await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    c.notify('notifications/initialized', {});
    const made = await c.call('tools/call', {
      name: 'app_create',
      arguments: {
        id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html',
        files: { 'index.html': '<p>掷</p>', 'outbound.json': DECLARATION },
      },
    });
    assert.equal(made.result.isError, false, JSON.stringify(made.result));

    // 这一版上长出来的门道：标了可分享，却没有锚
    writePack(w, 'dice', 'notes', noAnchor());
    const pub = await c.call('tools/call', { name: 'app_publish', arguments: { id: 'dice' } });
    assert.equal(pub.result.isError, true, `🔴 MCP 那条路也必须拒：${JSON.stringify(pub.result)}`);
    assert.match(pub.result.content[0].text, /可核起点|声明不可核/);
    assert.equal(nodeFs.existsSync(nodePath.join(w.dir, 'published-apps', 'dice')), false, '盘上零残留');

    // 负向对照：补上锚 ⇒ 真工具那条路就过
    const man = w.apps.manifest('dice', w.apps.current('dice'));
    writePack(w, 'dice', 'notes', withAnchor(man.rootHash));
    const ok = await c.call('tools/call', { name: 'app_publish', arguments: { id: 'dice' } });
    assert.equal(ok.result.isError, false, JSON.stringify(ok.result));
    assert.deepEqual(w.published.discover().map((a) => a.id), ['dice']);
  } finally {
    c.child.kill();
    await sock.close();
  }
});

// ════════════════════════════════════════════════════════════════
// §2-10 🔴 第二出口：写共享库的只许一个，而且它必须过闸
// ════════════════════════════════════════════════════════════════

/** 去掉注释（判据只认**代码**里的字，不认解释里的）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function walkSrc(dir, out = []) {
  for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('🔴 §2-10 冒出第二个绕过它的出口 ⇒ 红（写共享库的代码只许一处，且必须过闸）', () => {
  const files = walkSrc(SRC).map((f) => ({ rel: nodePath.relative(SRC, f), code: stripComments(nodeFs.readFileSync(f, 'utf8')) }));
  // ① 认得出"往共享库写"这个动作的只有 `published.js` 一个文件
  const writers = files.filter((f) => /published-apps|PUBLISHED_DIR/.test(f.code)).map((f) => f.rel).sort();
  assert.deepEqual(
    writers,
    ['published.js'],
    `🔴 共享库只能有一个写入者；多出来的那个就是"第二个出口"：${JSON.stringify(writers)}`,
  );
  // ② 那一个写入者必须真的调了这道闸（不许"有 outbound.js 但没人用"）
  const published = files.find((f) => f.rel === 'published.js');
  assert.match(published.code, /assertOutboundAllowed\s*\(/, '🔴 唯一的写入者必须过 outbound 那一个裁决');
  assert.match(published.code, /from '\.\/outbound\.js'/, '🔴 它得真的引那道闸');
  // ③ 闸自己不许写共享库（裁决与搬运分开：这一版只裁决）
  const gate = files.find((f) => f.rel === 'outbound.js');
  assert.doesNotMatch(gate.code, /published-apps|PUBLISHED_DIR/, '🔴 闸只裁决，不写盘到共享库');
  // ④ 三条口共用同一个裁决（92 §③ 阶段 2 的原话）
  assert.deepEqual(Object.keys(OUTBOUND_ROUTES).sort(), ['artifact', 'deliver', 'publish']);
});
