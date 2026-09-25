// **B28：按房间回收**一间**没有制品**的工作区（`/api/room-remove`）。
//
// ── 这一份钉什么（一句话）──────────────────────────────────
// `/api/app-remove` 是按 **app id** 走的 ⇒ 一间**还没做出东西**的工作区
// （没有制品，或者制品早被删了）**删不掉**，只能永远躺在盘上（B28）。
// 这一条按 **scope** 走：拿走**那三样**（工作区 / 那一间的对话 / 助手那边的原件），
// **不动制品库**，留痕照 `reclaimed.json`（N22 的唯一例外），审计多一行。
//
// ⚠️ **四道闸**是这一份的重点 —— 少一道就有"按错名字把别人的房间删了"的形状：
//     `main` 拒 · **内置那几间**拒 · **制品库里还有它** ⇒ 拒（要走那条 app 的路）·
//     **认不出** ⇒ 404。
// ⚠️ 另有一条**以盒子为准**（真 `net.connect` 隧道）：租户这一下必须在**他盒子里**落，
//     宿主那份**一个字节都不许动**；盒子不通 ⇒ **如实 503**（绝不退回宿主）。
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
import { createBoxApps } from '../src/apps-box.js';
import { Auth } from '../src/auth.js';
import { auditPath } from '../src/audit.js';
import { groupSlugFor } from '../src/prune.js';
import { RECLAIMED_FILE, readReclaimedSeqs } from '../src/reclaim.js';
import { createServer } from '../src/server.js';
import { ROOM_RECLAIM_WHAT, Worlds } from '../src/worlds.js';

const NOW = 1_800_000_000_000;
const KEY = Buffer.from('c'.repeat(64), 'hex');

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

const tmp = (tag = 'hupo-b28-') => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));
const sha256 = (buf) => nodeCrypto.createHash('sha256').update(buf).digest('hex');

/** 这个 tag 那一份服务的 cfg（照 `app-reclaim.test.js` 那条形状）。 */
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

/** 起一个人那一份**真**世界（真 `Worlds` ＋ 真磁盘布局）。**不起 agent**。 */
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

async function bootServer(t, opts) {
  const auth = new Auth({ dataDir: tmp('hupo-b28-auth-'), now: () => NOW });
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

const postRoom = (origin, token, body) =>
  fetch(`${origin}/api/room-remove`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ── 盘上的几个读数 ─────────────────────────────────────────
const appsRoot = (root) => nodePath.join(root, 'hupo', 'apps');
const removedDirsUnder = (root) => {
  try {
    return nodeFs.readdirSync(nodePath.join(appsRoot(root), '.removed'));
  } catch {
    return [];
  }
};
const reclaimDirOf = (root, scope) => {
  const hit = removedDirsUnder(root).filter((n) => n.startsWith(`ws-${scope}-`));
  assert.equal(hit.length, 1, `要在 .removed/ 里找到**正好一格** ws-${scope} 的回收处，实际 ${JSON.stringify(hit)}`);
  return nodePath.join(appsRoot(root), '.removed', hit[0]);
};
const readJson = (p) => JSON.parse(nodeFs.readFileSync(p, 'utf8'));
const lines = (p) =>
  nodeFs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const auditLines = (root) => {
  try {
    return nodeFs.readFileSync(auditPath(root), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/** 一棵树的字节指纹。 */
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
 * **种出一间"没有制品"的工作区**：工作区 ＋ 那一间的两行话（夹在主线两行中间）
 * ＋ 助手那边那个会话目录。**不建制品** —— 那正是这一条要处理的东西。
 */
function seedRoomOnly({ worlds, sub, scope }) {
  const w = worlds.worldFor(sub);
  const wsDir = w.workspaces.dirFor(scope);
  nodeFs.mkdirSync(wsDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(wsDir, 'note.txt'), '这一间的草稿');
  const room = worlds.roomFor(sub, scope);
  w.timeline.emit({ type: 'user/echo', messageId: `m1-${scope}`, text: '主线一' });
  room.timeline.emit({ type: 'user/echo', messageId: `r1-${scope}`, text: '这一间一' });
  room.timeline.emit({ type: 'user/echo', messageId: `r2-${scope}`, text: '这一间二' });
  w.timeline.emit({ type: 'user/echo', messageId: `m2-${scope}`, text: '主线二' });
  const sessionDir = nodePath.join(w.cfg.dshHome, 'sessions', groupSlugFor(wsDir), 'record-1');
  nodeFs.mkdirSync(sessionDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(sessionDir, 'session.v3.jsonl.zstd'), 'x');
  return { w, wsDir, sessionDir, room };
}

// ════════════════════════════════════════════════════════════
// R1 —— 主判据：一间没有制品的工作区 ⇒ 那三样一起走 ＋ 留痕 ＋ 审计
// ════════════════════════════════════════════════════════════
test('R1 按房间回收 ⇒ 工作区 / 那一间的对话 / 助手那边那份**一起搬走**，制品库一个字节不动', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 'r1' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;

  const scope = 'count-one-two-three';
  const { w, wsDir, sessionDir } = seedRoomOnly({ worlds: h.worlds, sub: 'owner', scope });
  const appsBefore = treeDigest(appsRoot(h.dataDir));
  const auditBefore = auditLines(h.dataDir).length;

  const r = await postRoom(origin, token, { scope });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  const j = JSON.parse(raw);
  assert.equal(j.ok, true, '回执要 `ok:true`');
  assert.equal(j.record.scopeId, scope);
  assert.deepEqual(j.record.takenSeqs, [2, 3], '被拿走的就是那一间的两个号');
  assert.deepEqual(j.record.items, { app: false, workspace: true, conversation: 2, session: true }, '四样各自如实');

  // ① 工作区：**搬走**（回收处里读得回来），不是删掉
  assert.equal(nodeFs.existsSync(wsDir), false, '🔴 那一间的工作区目录要没了');
  const into = reclaimDirOf(h.dataDir, scope);
  assert.equal(
    nodeFs.readFileSync(nodePath.join(into, 'workspace', 'note.txt'), 'utf8'),
    '这一间的草稿',
    '🔴 工作区要**搬进**回收处（不是 rm）',
  );
  // ② 那一间的对话：从日志里抽走、别的号一个都不动
  const evs = w.store.readAll('main');
  assert.equal(evs.some((e) => String(e.scopeId ?? '') === scope), false, '🔴 日志里不许还有这一间的行');
  assert.deepEqual(evs.map((e) => e.seq), [1, 4], '🔴 只抽那一间的行：别的号一个都不许动');
  assert.deepEqual(
    lines(nodePath.join(into, 'conversation.jsonl')).map((e) => e.text),
    ['这一间一', '这一间二'],
    '抽走的那两行要原样搬进回收处',
  );
  // ③ 助手那边那份原件：搬走
  assert.equal(nodeFs.existsSync(sessionDir), false, '🔴 助手那边那个会话目录要没了');
  assert.equal(
    nodeFs.existsSync(nodePath.join(into, 'session', 'record-1', 'session.v3.jsonl.zstd')),
    true,
    '🔴 会话目录要**搬进**回收处',
  );
  // ④ 留痕（N22 的唯一例外）
  const rec = readJson(nodePath.join(into, RECLAIMED_FILE));
  assert.equal(rec.scopeId, scope);
  assert.deepEqual(rec.takenSeqs, [2, 3]);
  assert.equal(rec.items.app, false, '🔴 **没有制品**就要如实写 `false`（不许记成"拿走了一个制品"）');
  assert.ok(
    readReclaimedSeqs({ removedRoot: nodePath.join(appsRoot(h.dataDir), '.removed') }).includes(2),
    '留痕要**扫得到**（校验器按它解释号洞）',
  );
  // ⑤ 审计多一行（在**那一个**审计文件里）
  const audit = auditLines(h.dataDir);
  assert.equal(audit.length, auditBefore + 1, '🔴 审计要**多一行**');
  assert.ok(audit.some((l) => l.includes(ROOM_RECLAIM_WHAT) && l.includes(scope)), '多出来那行要写着清了哪一间');
  // ⑥ 🔴 **制品库那一格没被碰过**：这一间本来就没有制品 ⇒ 回收处里**不许**
  //    出现 `versions/` / `manifest` / `usage.jsonl`（那三样是"有制品"那条路的形状）
  assert.equal(nodeFs.existsSync(nodePath.join(appsRoot(h.dataDir), scope)), false, '这一间本来就没有制品');
  assert.deepEqual(
    nodeFs.readdirSync(into).sort(),
    ['conversation.jsonl', 'reclaimed.json', 'session', 'workspace'],
    '🔴 回收处里只许有那三样 ＋ 留痕（**没有**制品那一格）',
  );
  // 正对照：动手之前制品库里确实没有它（不然上面那条"没被碰过"是空的）
  assert.equal(appsBefore.includes(`d ${scope}`), false);
});

// ════════════════════════════════════════════════════════════
// R2 —— 四道闸
// ════════════════════════════════════════════════════════════
test('R2 四道闸：`main` / 内置那几间 / 还有制品的那一间 / 认不出的 —— 各自如实拒，一个字节都不动', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 'r2' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;
  const w = h.worlds.worldFor('owner');

  // ⚠️ **先把"还有制品"那一间种好**，再拍快照 —— 不然下面那条"一个字节都没动"比的是
  //    我自己的播种动作（那会永远红）。
  const withApp = seedRoomOnly({ worlds: h.worlds, sub: 'owner', scope: 'dice' });
  w.apps.create({
    id: 'dice',
    title: '骰子',
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': '<p>x</p>' },
  });
  const before = treeDigest(h.dataDir);

  // ① `main`
  const mainR = await postRoom(origin, token, { scope: 'main' });
  const mainBody = await mainR.text();
  assert.equal(mainR.status, 409, mainBody);
  assert.match(mainBody, /主线/u, '要有一句人话（不许说"没有这一间"）');

  // ② 内置那几间（桌面上就有图标）
  for (const builtin of ['settings', 'discover', 'harness']) {
    const rr = await postRoom(origin, token, { scope: builtin });
    assert.equal(rr.status, 409, `${builtin} 必须拒：${await rr.text()}`);
  }

  // ③ **还有制品**的那一间 ⇒ 拒（要走 `/api/app-remove` 那条路）
  const appR = await postRoom(origin, token, { scope: 'dice' });
  const appBody = await appR.text();
  assert.equal(appR.status, 409, appBody);
  assert.match(appBody, /桌面/u, '要有一句人话，指他去走那条"从桌面上删掉"');
  assert.equal(nodeFs.existsSync(withApp.wsDir), true, '🔴 被拒 ⇒ 那一间的工作区一个字节都不许动');
  assert.deepEqual(w.apps.list().map((a) => a.id), ['dice'], '🔴 被拒 ⇒ 制品还在');

  // ④ 认不出的那一间 ⇒ 404（不猜）
  const missR = await postRoom(origin, token, { scope: 'never-existed' });
  const missBody = await missR.text();
  assert.equal(missR.status, 404, missBody);
  assert.match(missBody, /没有这一间/u, '要有一句人话');

  // ⑤ 名字不合法（防穿越）⇒ 400，而且**不许**把那个名字拿去拼路径
  for (const bad of ['../etc', 'a/b', 'A-B', '..']) {
    const br = await postRoom(origin, token, { scope: bad });
    assert.equal(br.status, 400, `${JSON.stringify(bad)} 必须拒：${await br.text()}`);
  }
  // ⑤b **没说清是哪一间** ⇒ 404 ＋ 人话（照 `/api/app-remove` 那条同一条规矩：
  //     缺东西是"没这个东西"，不是"名字坏"）
  const emptyR = await postRoom(origin, token, { scope: '' });
  const emptyBody = await emptyR.text();
  assert.equal(emptyR.status, 404, emptyBody);
  assert.match(emptyBody, /没说清/u, '要有一句人话');
  assert.equal(removedDirsUnder(h.dataDir).length, 0, '🔴 上面每一下都是"拒"，回收处一格都不许出现');
  assert.equal(treeDigest(h.dataDir), before, '🔴 被拒的那几下：盘上一个字节都不许动');
});

// ════════════════════════════════════════════════════════════
// R3 —— 以盒子为准（真隧道）：盒里落，宿主那份一个字节不动
// ════════════════════════════════════════════════════════════
test('R3 租户：动的是**盒里那一间**；宿主那份一个字节不动（盒子不通 ⇒ 如实 503）', async (t) => {
  // ── 盒子：真世界 ＋ 真服务 ＋ 一条 0600 UDS（内部口只在那儿）──────
  const boxRoot = tmp('hupo-b28-box-');
  const box = await bootWorlds(t, { tag: 'box', dataDir: boxRoot });
  const boxSrv = await bootServer(t, { worlds: box.worlds, trustedSub: 'owner', buildId: 'r3-box' });
  await boxSrv.listen(0);
  const uds = nodePath.join(tmp('hupo-b28-uds-'), 'local-api.sock');
  await boxSrv.listenTrusted(uds);

  const scope = 'count-four-five-six';
  const boxSeed = seedRoomOnly({ worlds: box.worlds, sub: 'owner', scope });

  // ── 宿主：真世界；租户那一格**故意**种一份同名的工作区（判据要盯住它没被动）──
  const hostRoot = tmp('hupo-b28-host-');
  const host = await bootWorlds(t, { tag: 'host', dataDir: hostRoot });
  const hostUser = host.worlds.worldFor('u2');
  const hostWsDir = hostUser.workspaces.dirFor(scope);
  nodeFs.mkdirSync(hostWsDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(hostWsDir, 'host-only.txt'), '宿主那份');
  const hostBefore = treeDigest(nodePath.join(hostRoot, 'users', 'u2'));

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
    buildId: 'r3-host',
  });
  const hostAddr = await hostSrv.listen(0);
  const hostOrigin = `http://127.0.0.1:${hostAddr.port}`;
  const token = hostSrv.auth.issue({ sub: 'u2' }).token;

  const r = await postRoom(hostOrigin, token, { scope });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  assert.ok(dials > 0, '🔴 必须**真过隧道**（否则这一条什么都没证明）');

  // 盒里那一间：三样一起走了
  assert.equal(nodeFs.existsSync(boxSeed.wsDir), false, '盒里那一间的工作区要没了');
  assert.equal(nodeFs.existsSync(boxSeed.sessionDir), false, '盒里那个会话目录要没了');
  assert.equal(
    box.worlds.worldFor('owner').store.readAll('main').some((e) => String(e.scopeId ?? '') === scope),
    false,
    '盒里那条日志里不许还有这一间的行',
  );
  const into = reclaimDirOf(boxRoot, scope);
  assert.equal(nodeFs.existsSync(nodePath.join(into, 'workspace', 'note.txt')), true, '盒里的东西要搬进盒里的回收处');
  assert.equal(readJson(nodePath.join(into, RECLAIMED_FILE)).items.app, false);

  // 宿主那份：**一个字节都不许动**
  assert.equal(treeDigest(nodePath.join(hostRoot, 'users', 'u2')), hostBefore, '🔴 宿主那一格被动了');
  assert.equal(nodeFs.existsSync(hostWsDir), true, '🔴 宿主那份同名工作区不许被搬');
  assert.equal(removedDirsUnder(hostRoot).length, 0, '🔴 宿主那个 .removed/ 不许出现东西');
});

// ════════════════════════════════════════════════════════════
// R4 —— 盒子不通 ⇒ **如实 503**（绝不悄悄退回宿主那份）
// ════════════════════════════════════════════════════════════
test('R4 租户 · 盒子不通 ⇒ 503 + 人话（绝不退回宿主那份）', async (t) => {
  const hostRoot = tmp('hupo-b28-down-');
  const host = await bootWorlds(t, { tag: 'host', dataDir: hostRoot });
  const scope = 'count-eight-nine';
  const hostUser = host.worlds.worldFor('u2');
  const hostWsDir = hostUser.workspaces.dirFor(scope);
  nodeFs.mkdirSync(hostWsDir, { recursive: true });
  const before = treeDigest(nodePath.join(hostRoot, 'users', 'u2'));

  const hostSrv = await bootServer(t, {
    worlds: host.worlds,
    tenantOf: (sub) => (sub === 'u2' ? 'hupo-b' : null),
    appsOf: (sub) =>
      sub === 'u2'
        ? createBoxApps({
            sub,
            // 隧道连不上（这一条要的是"如实说失败"）
            dial: () => nodeNet.connect(nodePath.join(tmp('hupo-b28-gone-'), 'nope.sock')),
            log: () => {},
          })
        : host.worlds.worldFor(sub)?.apps ?? null,
    buildId: 'r4',
  });
  const addr = await hostSrv.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = hostSrv.auth.issue({ sub: 'u2' }).token;

  const r = await postRoom(origin, token, { scope });
  const raw = await r.text();
  assert.equal(r.status, 503, raw);
  assert.match(raw, /没应/u, '要有一句人话（不是 200，也不是空话）');
  assert.equal(treeDigest(nodePath.join(hostRoot, 'users', 'u2')), before, '🔴 盒子不通时宿主那份一个字节都不许动');
  assert.equal(removedDirsUnder(hostRoot).length, 0);
});
