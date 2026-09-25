// **`103` §七：从桌面上删掉一个图标 ＝ 真回收**（判据 **S6–S9** · 决策 **D3.11**）。
//
// ── 这一份钉什么（一句话）──────────────────────────────────
// 第一轮只动制品那一格（软删进 `.removed/`）；这一轮要**四样一起走**，而
// **留下的两样必须留**（审计多一行 · 用量还在），并且那条日志抽走那一间的行之后
// **别的号一个都不许动** —— 留下的号洞**必须有留痕**（`reclaimed.json`），
// 校验器按留痕判：解释得了 ⇒ 过；解释不了 ⇒ 红（**反向也咬得动**）。
//
// ⚠️ 形状照 `test/app-remove.test.js`，但这一份要**真 `Worlds`**（回收要用
//    工作区 / 那条日志 / `DSH_HOME` 那几本账 —— 假的 `{dir, apps}` 走不到那里），
//    外加**真 HTTP**、租户那一条走**真 `net.connect` 隧道**（S9）。
//    不 mock 业务。
//
// ⚠️ 每条都带**反例的正身**；变异读数写进 `docs/dev/00-PROGRESS.md` 那一批的账。

import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Apps } from '../src/apps.js';
import { createBoxApps } from '../src/apps-box.js';
import { Auth } from '../src/auth.js';
import { groupSlugFor } from '../src/prune.js';
import { RECLAIMED_FILE, readReclaimedSeqs } from '../src/reclaim.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { USAGE_KINDS } from '../src/usage.js';
import { Worlds } from '../src/worlds.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('c'.repeat(64), 'hex');

// ── 起过的东西（`after()` 兜底收掉：红了也要能退出）──────────
const open = new Set();
after(async () => {
  for (const close of open) {
    try {
      await close();
    } catch {
      /* 关不干净不影响结论 */
    }
  }
  open.clear();
});

function guard(fn) {
  const g = async () => {
    open.delete(g);
    await fn();
  };
  open.add(g);
  return g;
}

const tmp = (tag = 'hupo-103b-') => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));
const sha256 = (buf) => nodeCrypto.createHash('sha256').update(buf).digest('hex');

/** 这个 tag 那一份服务的 cfg（照 `scope-single-log.test.js` 那条形状）。 */
function cfgFor(dataDir, tag) {
  return {
    dataDir,
    dshHome: nodePath.join(dataDir, `__${tag}_dsh__`),
    agentCwd: nodePath.join(dataDir, `__${tag}_cwd__`),
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
    turnDeadlineMs: 5000,
  };
}

/**
 * 起一个人那一份**真**世界（真 `Worlds` ＋ 真磁盘布局）。
 * ⚠️ 不起真 agent：这几条判据一条轮都不打（`spawnFn` 一叫就说明接线错了）。
 */
async function bootWorlds(t, { tag = 'host', dataDir = tmp() } = {}) {
  const cfg = cfgFor(dataDir, tag);
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });
  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
    spawnFn: () => {
      throw new Error('这一份判据不许起 agent');
    },
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });
  t.after(
    guard(async () => {
      await worlds.shutdownDispatchers();
      await runtime.shutdown();
      worlds.closeSockets();
    }),
  );
  return { dataDir, cfg, worlds, runtime };
}

/** 起一台**真** HTTP 服务（宿主那条 / 盒子里那条都走它）。 */
async function bootServer(t, opts) {
  const auth = new Auth({ dataDir: tmp('hupo-103b-auth-'), now: () => NOW });
  auth.setPassword('这一份判据只用令牌');
  const s = createServer({
    apps: { base: 'http://127.0.0.1:9', key: KEY },
    now: () => NOW,
    webRoot: null,
    log: () => {},
    ...opts,
    auth,
  });
  t.after(guard(s.close));
  return { ...s, auth };
}

const postRemove = (origin, token, body) =>
  fetch(`${origin}/api/app-remove`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ── 盘上的几个读数（判据直接读它们，不读函数返回值）──────────
const appsRoot = (root) => nodePath.join(root, 'hupo', 'apps');
const removedDirsUnder = (root) => {
  try {
    return nodeFs.readdirSync(nodePath.join(appsRoot(root), '.removed'));
  } catch {
    return [];
  }
};
const auditLines = (root) => {
  try {
    return nodeFs.readFileSync(nodePath.join(appsRoot(root), 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const auditHas = (root, id) => auditLines(root).some((l) => l.includes('"remove"') && l.includes(id));
const reclaimDirOf = (root, id) => {
  const hit = removedDirsUnder(root).filter((n) => n.startsWith(`${id}-`));
  assert.equal(hit.length, 1, `要在 .removed/ 里找到**正好一格** ${id} 的回收处，实际 ${JSON.stringify(hit)}`);
  return nodePath.join(appsRoot(root), '.removed', hit[0]);
};
const readJson = (p) => JSON.parse(nodeFs.readFileSync(p, 'utf8'));
const lines = (p) =>
  nodeFs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** 一棵树的**字节指纹**（S9："宿主那份一个字节不动"要的是这个，不是"清单没变"）。 */
function treeDigest(root) {
  const parts = [];
  const walk = (dir, rel) => {
    let kids;
    try {
      kids = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    kids.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of kids) {
      const p = nodePath.join(dir, d.name);
      const r = rel === '' ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) {
        parts.push(`d ${r}`);
        walk(p, r);
      } else if (d.isFile()) {
        parts.push(`f ${r} ${sha256(nodeFs.readFileSync(p))}`);
      } else {
        parts.push(`o ${r}`);
      }
    }
  };
  walk(root, '');
  return parts.join('\n');
}

/**
 * **种出一整间**：制品 ＋ 用量 ＋ 工作区 ＋ 那条日志里属于它的行 ＋ 助手那边的会话目录。
 * 顺序刻意：中间那两行属于这一间，**后面还有一条主线的行** ⇒ 抽走之后留的是**中间的洞**
 * （尾巴上的洞外面没有更晚的号作参照）。
 */
function seedScope({ worlds, sub, id }) {
  const w = worlds.worldFor(sub);
  // ① 制品 ＋ 用量
  w.apps.create({
    id,
    title: '番茄钟',
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': '<p>x</p>' },
  });
  w.usage.note(id, { kind: USAGE_KINDS.agentTurn, usage: { prompt_tokens: 20, completion_tokens: 2 } });
  // ② 那一间的工作区
  const wsDir = w.workspaces.dirFor(id);
  nodeFs.mkdirSync(wsDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(wsDir, 'note.txt'), '这一间的东西');
  // ③ 那一间的话（走它自己的视图 ⇒ 事件带 `scopeId`）
  const room = worlds.roomFor(sub, id);
  w.timeline.emit({ type: 'user/echo', messageId: `main1-${id}`, text: '主线一' });
  room.timeline.emit({ type: 'user/echo', messageId: `mine1-${id}`, text: '这一间一' });
  room.timeline.emit({ type: 'user/echo', messageId: `mine2-${id}`, text: '这一间二' });
  w.timeline.emit({ type: 'user/echo', messageId: `main2-${id}`, text: '主线二' });
  // ④ 助手那一侧的原件（会话目录名 = cwd 的路径 slug）
  const sessionDir = nodePath.join(w.cfg.dshHome, 'sessions', groupSlugFor(wsDir), 'record-1');
  nodeFs.mkdirSync(sessionDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(sessionDir, 'session.v3.jsonl.zstd'), 'x');
  return { w, wsDir, sessionDir, room };
}

// ════════════════════════════════════════════════════════════
// S6 —— 四样一起走（宿主那条路 · 本机那份）
// ════════════════════════════════════════════════════════════
test('S6 删掉 ⇒ **四样一起走**：制品 · 工作区 · 那一间的对话 · 助手那边的会话目录', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 's6' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;

  const id = 'dice';
  const { w, wsDir, sessionDir } = seedScope({ worlds: h.worlds, sub: 'owner', id });

  const r = await postRemove(origin, token, { id });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  const j = JSON.parse(raw);
  assert.deepEqual(j, { ok: true }, '🔴 回执只有 {ok:true} 这一种成功形状（协议一个字不改）');

  const into = reclaimDirOf(h.dataDir, id);
  // ① 制品（含 usage）真进了回收处
  assert.equal(
    nodeFs.existsSync(nodePath.join(into, 'versions', '1', 'index.html')),
    true,
    '🔴 制品那一格要进回收处',
  );
  assert.equal(nodeFs.existsSync(nodePath.join(appsRoot(h.dataDir), id)), false, '原位不许还留着它');
  // ② 工作区：目录没了，而且**搬进了同一个回收处**（不是 rm）
  assert.equal(nodeFs.existsSync(wsDir), false, '🔴 那一间的工作区目录要没了');
  assert.equal(
    nodeFs.readFileSync(nodePath.join(into, 'workspace', 'note.txt'), 'utf8'),
    '这一间的东西',
    '🔴 工作区必须是**搬走**（回收处里读得回来），不是删掉',
  );
  // ③ 那一间的对话：日志里没了、搬进了 conversation.jsonl
  const evs = w.store.readAll('main');
  assert.equal(evs.some((e) => String(e.scopeId ?? '') === id), false, '🔴 那条日志里不许还有这一间的行');
  const conv = lines(nodePath.join(into, 'conversation.jsonl'));
  assert.deepEqual(conv.map((e) => e.text), ['这一间一', '这一间二'], '🔴 抽走的那两行要原样搬进回收处');
  assert.deepEqual(conv.map((e) => e.seq), [2, 3], '被拿走的是这两个号');
  // 🔴 **别的行的号一个都不许动**（不重编号）
  assert.deepEqual(evs.map((e) => e.seq), [1, 4], '🔴 只抽那一间的行：别的号一个都不许动');
  assert.deepEqual(evs.filter((e) => e.type === 'user/echo').map((e) => e.text), ['主线一', '主线二']);
  // ④ 助手那边那个会话目录：没了、搬进了回收处
  assert.equal(nodeFs.existsSync(sessionDir), false, '🔴 助手那边的会话目录要没了');
  assert.equal(
    nodeFs.existsSync(nodePath.join(into, 'session', 'record-1', 'session.v3.jsonl.zstd')),
    true,
    '🔴 会话目录要**搬进**回收处（不是 rm）',
  );
});

// ════════════════════════════════════════════════════════════
// S7 —— 留下的两样：审计多一行 · 用量还在
// ════════════════════════════════════════════════════════════
test('S7 **留下的两样**：审计多一行（不许跟着没）＋ 用量还在（在回收处，不是消失）', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 's7' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;

  const id = 'news';
  seedScope({ worlds: h.worlds, sub: 'owner', id });
  const before = auditLines(h.dataDir).length;

  assert.equal((await postRemove(origin, token, { id })).status, 200);

  const after = auditLines(h.dataDir);
  assert.equal(after.length, before + 1, '🔴 审计要**多一行**（不是"还在"，是"多一行"）');
  assert.ok(auditHas(h.dataDir, id), '多出来那一行要写着删了哪一个');

  const into = reclaimDirOf(h.dataDir, id);
  const usage = nodePath.join(into, 'usage.jsonl');
  assert.equal(nodeFs.existsSync(usage), true, '🔴 用量记录要还在（在回收处，**不是消失**）');
  assert.ok(
    nodeFs.readFileSync(usage, 'utf8').trim().split('\n').some((l) => l.includes(`"${USAGE_KINDS.agentTurn}"`)),
    '用量里那一条要读得回来',
  );
  assert.equal(nodeFs.existsSync(nodePath.join(appsRoot(h.dataDir), id)), false);
});

// ════════════════════════════════════════════════════════════
// S8 —— 号洞有留痕；校验器按它判；删掉留痕一条 ⇒ 当场红
// ════════════════════════════════════════════════════════════
test('S8 号洞**有留痕**：`reclaimed.json` 记着被拿走的号；删掉留痕里一条 ⇒ 当场红', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 's8' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;

  const id = 'clock';
  const { w } = seedScope({ worlds: h.worlds, sub: 'owner', id });
  assert.equal((await postRemove(origin, token, { id })).status, 200);

  const into = reclaimDirOf(h.dataDir, id);
  const rec = readJson(nodePath.join(into, RECLAIMED_FILE));
  assert.equal(rec.scopeId, id, '留痕要说清是哪一间');
  assert.deepEqual(rec.takenSeqs, [2, 3], '🔴 留痕要记着**被拿走的号**');
  assert.equal(typeof rec.at, 'number', '留痕要有时间');
  assert.equal(rec.by, 'owner', '留痕要有"谁删的"');

  const removedRoot = nodePath.join(appsRoot(h.dataDir), '.removed');
  // 正：洞在留痕里 ⇒ **过**（这是 N22 的唯一例外）
  assert.deepEqual(
    new Store({ dataDir: h.dataDir, fsync: false }).verifyMonotonic('main', {
      reclaimed: readReclaimedSeqs({ removedRoot }),
    }),
    { count: 2, maxSeq: 4 },
    '★ 带着留痕判 ⇒ 那两个洞解释得了，过',
  );
  // 反：**不带留痕** ⇒ 洞没人解释 ⇒ 当场红（老那条判据在这儿仍然咬得住）
  assert.throws(
    () => new Store({ dataDir: h.dataDir, fsync: false }).verifyMonotonic('main'),
    /编号不连续[\s\S]*没有回收留痕能解释/,
    '🔴 洞没人解释却判过 ⇒ 这就是要抓的那件事',
  );
  // 反（反向）：**把留痕删掉一条** ⇒ 那个洞又没人解释了 ⇒ 当场红
  const recPath = nodePath.join(into, RECLAIMED_FILE);
  const original = nodeFs.readFileSync(recPath);
  nodeFs.writeFileSync(recPath, `${JSON.stringify({ ...rec, takenSeqs: [2] })}\n`);
  assert.throws(
    () =>
      new Store({ dataDir: h.dataDir, fsync: false }).verifyMonotonic('main', {
        reclaimed: readReclaimedSeqs({ removedRoot }),
      }),
    /第 3 号没有回收留痕能解释/,
    '🔴 留痕被删掉一条、却还判过 ⇒ 红',
  );
  // 还原（后面的判据还要读这份留痕）
  nodeFs.writeFileSync(recPath, original);
  new Store({ dataDir: h.dataDir, fsync: false }).verifyMonotonic('main', {
    reclaimed: readReclaimedSeqs({ removedRoot }),
  });
  // 正身：那个洞是真在盘上的（不是"日志里本来就没有 2、3"）
  assert.deepEqual(w.store.readAll('main').map((e) => e.seq), [1, 4]);
});

// ════════════════════════════════════════════════════════════
// S9 —— 盒里那份是权威（真隧道）：盒里四样走了，宿主那份**一个字节不动**
// ════════════════════════════════════════════════════════════
test('S9 租户：动的是**盒里那四样**；宿主那份一个字节不动（照第一轮 S2）', async (t) => {
  // ── 盒子：真世界 ＋ 真服务（内部口只在一条 0600 UDS 上）──────────
  const boxRoot = tmp('hupo-103b-box-');
  const box = await bootWorlds(t, { tag: 'box', dataDir: boxRoot });
  const boxSrv = await bootServer(t, { worlds: box.worlds, trustedSub: 'owner', buildId: 's9-box' });
  const boxPub = await boxSrv.listen(0);
  const uds = nodePath.join(tmp('hupo-103b-uds-'), 'local-api.sock');
  await boxSrv.listenTrusted(uds);

  const id = 'aoshu';
  const boxSeed = seedScope({ worlds: box.worlds, sub: 'owner', id });

  // ── 宿主：真世界 ＋ 真服务；租户那份**故意**放一份同名旧副本 ─────
  const hostRoot = tmp('hupo-103b-host-');
  const host = await bootWorlds(t, { tag: 'host', dataDir: hostRoot });
  const hostUser = host.worlds.worldFor('u2'); // 先热一遍（判据只比"这一下"动没动它）
  hostUser.apps.create({
    id,
    title: '宿主那份旧副本',
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': '<p>host</p>' },
  });
  const hostUserDir = nodePath.join(hostRoot, 'users', 'u2');
  const before = treeDigest(hostUserDir);

  let dials = 0;
  const hostSrv = await bootServer(t, {
    worlds: host.worlds,
    tenantOf: (sub) => (sub === 'u2' ? 'hupo-b' : null),
    appsOf: (sub) =>
      sub === 'u2'
        ? createBoxApps({
            sub,
            dial: () => {
              dials += 1;
              return nodeNet.connect(uds);
            },
            log: () => {},
          })
        : host.worlds.worldFor(sub)?.apps ?? null,
    proxyFor: (tenant) => (tenant === 'hupo-b' ? nodeNet.connect(uds) : null),
    buildId: 's9-host',
  });
  const hostAddr = await hostSrv.listen(0);
  const hostOrigin = `http://127.0.0.1:${hostAddr.port}`;
  const token = hostSrv.auth.issue({ sub: 'u2' }).token;

  const r = await postRemove(hostOrigin, token, { id });
  assert.equal(r.status, 200, await r.text());
  assert.ok(dials > 0, '🔴 必须**真过隧道**（否则这一条什么都没证明）');

  // 盒里那四样：一起走了
  const into = reclaimDirOf(boxRoot, id);
  assert.equal(nodeFs.existsSync(boxSeed.wsDir), false, '盒里的工作区要没了');
  assert.equal(nodeFs.existsSync(boxSeed.sessionDir), false, '盒里那个会话目录要没了');
  assert.equal(
    box.worlds.worldFor('owner').store.readAll('main').some((e) => String(e.scopeId ?? '') === id),
    false,
    '盒里那条日志里不许还有这一间的行',
  );
  assert.equal(nodeFs.existsSync(nodePath.join(into, 'workspace', 'note.txt')), true);
  assert.equal(auditHas(boxRoot, id), true, '盒里要留审计一行');

  // 宿主那份：**一个字节都不许动**
  assert.equal(treeDigest(hostUserDir), before, '🔴 宿主那一格被动了（那正是"两处库"那句假话的形状）');
  assert.deepEqual(hostUser.apps.list().map((a) => a.id), [id], '🔴 宿主那份的清单里它必须还在');
  assert.equal(removedDirsUnder(hostRoot).length, 0, '🔴 宿主那个 .removed/ 不许被动');
  assert.equal(boxPub.port > 0, true, '盒子那台真在听（正对照）');
});

// ════════════════════════════════════════════════════════════
// X1 —— 自己想的反例①：**别的间的行被顺手带走一条** ⇒ 红
// ════════════════════════════════════════════════════════════
test('X1 只抽**那一间**的行：别的间的行 / 工作区 / 会话目录一个都不许被顺手带走', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 'x1' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;

  const keepA = seedScope({ worlds: h.worlds, sub: 'owner', id: 'alpha' });
  const goneB = seedScope({ worlds: h.worlds, sub: 'owner', id: 'beta' });
  // 甲那间在工作区里放一份自己的东西（判据要盯住它**没被搬**）
  nodeFs.writeFileSync(nodePath.join(keepA.wsDir, 'alpha.txt'), '甲的东西');

  assert.equal((await postRemove(origin, token, { id: 'beta' })).status, 200);

  const evs = keepA.w.store.readAll('main');
  assert.deepEqual(
    evs.filter((e) => String(e.scopeId ?? '') === 'alpha').map((e) => e.text),
    ['这一间一', '这一间二'],
    '🔴 别的间（alpha）的行一条都不许被带走',
  );
  assert.deepEqual(
    evs.filter((e) => String(e.scopeId ?? '') === 'beta').length,
    0,
    '要删的那一间（beta）的行必须没了',
  );
  assert.equal(nodeFs.existsSync(nodePath.join(keepA.wsDir, 'alpha.txt')), true, '🔴 别的间的工作区不许被搬');
  assert.equal(nodeFs.existsSync(keepA.sessionDir), true, '🔴 别的间的会话目录不许被搬');
  const into = reclaimDirOf(h.dataDir, 'beta');
  assert.deepEqual(lines(nodePath.join(into, 'conversation.jsonl')).map((e) => e.text), ['这一间一', '这一间二']);
});

// ════════════════════════════════════════════════════════════
// X2 —— 自己想的反例②：**洞没人解释却判过** ⇒ 红（纯校验器，不靠 HTTP）
// ════════════════════════════════════════════════════════════
test('X2 洞没人解释却判过 ⇒ 红；留痕**多报**一个还在盘上的号 ⇒ 也红', () => {
  const dataDir = tmp('hupo-103b-mono-');
  const store = new Store({ dataDir, fsync: false });
  store.append('main', { type: 'x', seq: 1 });
  store.append('main', { type: 'x', seq: 3 }); // 少了 2（没有任何留痕）

  // 没有留痕 ⇒ 那个洞没人解释 ⇒ 红
  assert.throws(() => store.verifyMonotonic('main'), /第 2 号没有回收留痕能解释/);
  // 空留痕也不能"当成解释得了"
  assert.throws(() => store.verifyMonotonic('main', { reclaimed: [] }), /没有回收留痕能解释/);
  // 认不出的留痕形状也不能解释它
  assert.throws(() => store.verifyMonotonic('main', { reclaimed: [{ scopeId: 'x' }] }), /没有回收留痕能解释/);
  // 正：留痕里真有那个号 ⇒ 过
  assert.deepEqual(store.verifyMonotonic('main', { reclaimed: [2] }), { count: 2, maxSeq: 3 });

  // 反向：留痕说拿走了一个**盘上还在**的号 ⇒ 留痕跟盘对不上 ⇒ 红
  assert.throws(
    () => store.verifyMonotonic('main', { reclaimed: [2, 1] }),
    /留痕说第 1 号被拿走了，可它还在盘上/,
  );
});

// ════════════════════════════════════════════════════════════
// X3 —— 自己想的反例③：**回收没做完不许报成功**，而且要**搬回原位**
// ════════════════════════════════════════════════════════════
test('X3 回收中途失败 ⇒ `remove()` 抛出，而且制品那一格**搬回原位**（不留"删了一半"）', () => {
  const dir = tmp('hupo-103b-fail-');
  const store = new Store({ dataDir: dir, fsync: false });
  const apps = new Apps({
    dir,
    sub: 'owner',
    // 故意给一个**做不到**的回收上下文：工作目录取不到 ⇒ 第一步就抛
    reclaim: () => ({
      store,
      dshHome: nodePath.join(dir, 'dsh'),
      cwdFor: () => {
        throw new Error('这一间的工作目录取不到（判据故意）');
      },
    }),
  });
  apps.create({ id: 'dice', title: '番茄钟', icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>x</p>' } });

  assert.throws(() => apps.remove('dice'), /工作目录取不到/);
  // 制品那一格**回到原位**，清单里还在，`.removed/` 里没有它
  assert.deepEqual(apps.list().map((a) => a.id), ['dice'], '🔴 没删成 ⇒ 清单里必须还在');
  assert.deepEqual(removedDirsUnder(dir).filter((n) => n.startsWith('dice-')), [], '🔴 不许在 .removed/ 里留半格');
  assert.equal(auditHas(dir, 'dice'), false, '🔴 没删成就不许留"删了"的审计一行');
});

// ════════════════════════════════════════════════════════════
// X4 —— 自己想的反例④：**那一间的未读 / 待发的活**不许留成"指向空房间的账"
// ════════════════════════════════════════════════════════════
test('X4 那一间没了 ⇒ 未读记数清掉、`pending.jsonl` 里开着的活收成"已停"（别的间不动）', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 'x4' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;

  const id = 'dice';
  const { w } = seedScope({ worlds: h.worlds, sub: 'owner', id });
  w.unread.markRead(id, 2); // 他看到过第 2 号
  w.work.declare({ scopeId: id, ref: 'ticket-1' }); // 那一间挂着一件活（"待发的话"）
  // 别的间也各来一份（判据要盯住"别的间一个都不许动"）
  const other = seedScope({ worlds: h.worlds, sub: 'owner', id: 'alpha' });
  other.w.unread.markRead('alpha', 2);
  other.w.work.declare({ scopeId: 'alpha', ref: 'ticket-a' });

  assert.equal((await postRemove(origin, token, { id })).status, 200);

  // 未读：那一间的记数没了；别的间还在
  assert.equal(
    Object.prototype.hasOwnProperty.call(w.unread.raw().lastRead, id),
    false,
    '🔴 那一间的未读记数要清掉（事实已经不在日志上了）',
  );
  assert.equal(w.unread.raw().lastRead.alpha, 2, '别的间的记数不许动');
  // 待发的活：那一间开着的都收成"已停"；别的间那个还开着
  assert.deepEqual(w.work.live().filter((r) => r.scopeId === id), [], '🔴 那一间不许还开着"发不出去的话"');
  const rec = readJson(nodePath.join(reclaimDirOf(h.dataDir, id), RECLAIMED_FILE));
  assert.deepEqual(rec.settledWork, ['t:dice:ticket-1'], '留痕里要记着刚收掉的是哪几件');
  assert.deepEqual(
    w.work.live().filter((r) => r.scopeId === 'alpha').map((r) => r.id),
    ['t:alpha:ticket-a'],
    '别的间的那件活不许被收',
  );
});

// ════════════════════════════════════════════════════════════
// X5 —— 自己想的反例⑤：**尾巴被抽走**之后重启，**不许复用**那些号
// ════════════════════════════════════════════════════════════
test('X5 被拿走的号**一个都不许复用**：尾巴被抽走 ⇒ 重启取号按留痕的地板往前', async (t) => {
  // 预置成"回收过、而且被拿走的正好是尾巴"：盘上只剩 1，留痕说 2／3 被拿走过。
  const dataDir = tmp('hupo-103b-restart-');
  nodeFs.mkdirSync(nodePath.join(dataDir, 'hupo', 'apps', '.removed', 'old-1'), { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(dataDir, 'main.jsonl'),
    `${JSON.stringify({ type: 'user/echo', messageId: 'm1', text: '一', seq: 1, at: NOW })}\n`,
  );
  const removedRoot = nodePath.join(dataDir, 'hupo', 'apps', '.removed');
  nodeFs.writeFileSync(
    nodePath.join(removedRoot, 'old-1', RECLAIMED_FILE),
    `${JSON.stringify({ v: 1, scopeId: 'old', at: NOW, by: 'owner', takenSeqs: [2, 3] })}\n`,
  );

  const h = await bootWorlds(t, { tag: 'host', dataDir });
  const w = h.worlds.worldFor('owner');
  assert.ok(w.timeline.seq >= 3, `🔴 重启取号要把留痕里的号当**地板**，实际 ${w.timeline.seq}`);
  const next = w.timeline.emit({ type: 'user/echo', messageId: 'm2', text: '二' });
  assert.ok(next.seq >= 4, `🔴 下一条必须在 4 之后（复用 2／3 就是把已经发出去的号再发一遍），实际 ${next.seq}`);
  // 正身：盘上真的没有 2／3（那段洞解释得了），而且从没被复用
  const disk = new Store({ dataDir, fsync: false }).readAll('main').map((x) => x.seq);
  assert.equal(disk.includes(2), false, '🔴 2 被拿走过 ⇒ 不许再发一次');
  assert.equal(disk.includes(3), false, '🔴 3 被拿走过 ⇒ 不许再发一次');
  new Store({ dataDir, fsync: false }).verifyMonotonic('main', {
    reclaimed: readReclaimedSeqs({ removedRoot }),
  });
});
