// **`104`：改个名字 / 复制一个 —— 服务端这两条口**（契约 `docs/dev/104-APP-MENU.md` §三/§四）。
//
// ── 这一份钉什么（一句话）──────────────────────────────────
// 两条口都要**以盒子为准**（照 `103` 那条已有的做法）：租户这一下必须在**他盒子里**落
// （宿主那份是空的），**盒子不通 ⇒ 如实 503**，绝不退回宿主那份；而"改个名字"与
// "复制一个"的落点**只有一处**（`Apps.setTitle()` / `Apps.copy()`）。
//
// ⚠️ 形状照 `test/app-reclaim.test.js`：**真 `Worlds`**（改名要读那一版 manifest、
//    复制要看新那一间空不空 —— 假的 `{dir, apps}` 走不到那里）＋ **真 HTTP** ＋
//    租户那一条走**真 `net.connect` 隧道**。**不 mock 业务**。
//
// ⚠️ 每条都带**反例的正身**；变异读数写进 `docs/dev/104-APP-MENU.md` / `00-PROGRESS.md` 的账。

import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { AgentRuntime } from '../src/agent-runtime.js';
import { MAX_COPY_TRIES, MAX_TITLE_CHARS } from '../src/apps.js';
import { createBoxApps } from '../src/apps-box.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
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

const tmp = (tag = 'hupo-104-') => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));
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

/** 起一个人那一份**真**世界（真 `Worlds` ＋ 真磁盘布局）。⚠️ 不起真 agent。 */
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
  const auth = new Auth({ dataDir: tmp('hupo-104-auth-'), now: () => NOW });
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

/**
 * 宿主：租户 `u2` 经**真隧道**去他的盒子；`state.down = true` ⇒ 那条隧道断开
 * （判据用它造"盒子不通"，而不是换一份代码）。
 */
async function bootTenantHost(t, { worlds, boxUds = null, sub = 'u2', tenant = 'hupo-b' }) {
  const state = { down: false, dials: 0 };
  const s = await bootServer(t, {
    worlds,
    tenantOf: (x) => (x === sub ? tenant : null),
    appsOf: (x) =>
      x === sub
        ? createBoxApps({
          sub: x,
          dial: () => {
            if (state.down || !boxUds) return null;
            state.dials += 1;
            return nodeNet.connect(boxUds);
          },
          log: () => {},
        })
        : worlds.worldFor(x)?.apps ?? null,
    proxyFor: () => (state.down || !boxUds ? null : nodeNet.connect(boxUds)),
    buildId: 'menu-host',
  });
  const addr = await s.listen(0);
  return { origin: `http://127.0.0.1:${addr.port}`, token: s.auth.issue({ sub }).token, state };
}

const postRename = (origin, token, body) =>
  fetch(`${origin}/api/app-rename`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const postCopy = (origin, token, body) =>
  fetch(`${origin}/api/app-copy`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ── 盘上的几个读数（判据直接读它们，不读函数返回值）──────────
const appsRoot = (root) => nodePath.join(root, 'hupo', 'apps');
const appDirOf = (root, id) => nodePath.join(appsRoot(root), id);
const versionDirOf = (root, id, v) => nodePath.join(appDirOf(root, id), 'versions', String(v));
const manifestOf = (root, id, v) =>
  JSON.parse(nodeFs.readFileSync(nodePath.join(versionDirOf(root, id, v), 'manifest.json'), 'utf8'));
const auditLines = (root) => {
  try {
    return nodeFs
      .readFileSync(nodePath.join(appsRoot(root), 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const auditHas = (root, what, needle) =>
  auditLines(root).some((e) => e.what === what && JSON.stringify(e).includes(needle));

/** 一个 app **所有版本、所有文件**的 sha256（S11："逐文件 hash 对得上"）。 */
function fileHashes(root, id) {
  const base = appDirOf(root, id);
  const out = {};
  for (const v of nodeFs.readdirSync(nodePath.join(base, 'versions'))) {
    const m = manifestOf(root, id, Number(v));
    for (const f of m.files ?? []) {
      out[`${v}/${f.path}`] = sha256(nodeFs.readFileSync(nodePath.join(base, 'versions', v, f.path)));
    }
  }
  return out;
}

/** 一棵树的**字节指纹**（"一个字节不动"要的是这个，不是"清单没变"）。 */
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

/** 造一个有**两版**的 app（复制那条要证明"所有版本照搬"，一版证明不了）。 */
function seedApp(worlds, sub, id, title) {
  const apps = worlds.worldFor(sub).apps;
  apps.create({
    id,
    title,
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': `<p>${id} v1</p>`, 'app.js': `console.log('${id}')` },
  });
  apps.create({
    id,
    title,
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': `<p>${id} v2</p>`, 'app.js': `console.log('${id}')`, 'style.css': '#a{}' },
  });
  return apps;
}

// ════════════════════════════════════════════════════════════
// S10 —— 改名：那一版 manifest 的 title 变了（`list()` 跟着变）＋ 审计一行；宿主那份不动
// ════════════════════════════════════════════════════════════
test('S10 改名 ⇒ **盒里那一版 manifest 的 title 真变了**（`list()` 跟着变）＋ 审计一行；宿主那份不动', async (t) => {
  // ── 盒子：真世界 ＋ 真服务（内部口只在一条 0600 UDS 上）──────────
  const boxRoot = tmp('hupo-104-box-');
  const box = await bootWorlds(t, { tag: 'box', dataDir: boxRoot });
  const boxSrv = await bootServer(t, { worlds: box.worlds, trustedSub: 'owner', buildId: 's10-box' });
  await boxSrv.listen(0);
  const uds = nodePath.join(tmp('hupo-104-uds-'), 'local-api.sock');
  await boxSrv.listenTrusted(uds);

  const id = 'aoshu';
  const boxApps = seedApp(box.worlds, 'owner', id, '奥数练一练');
  assert.equal(manifestOf(boxRoot, id, 2).title, '奥数练一练', '正身：改之前盘上是老名字');

  // ── 宿主：租户那份**故意**放一个同名旧副本（证明"没动宿主"不是空话）────
  const hostRoot = tmp('hupo-104-host-');
  const host = await bootWorlds(t, { tag: 'host', dataDir: hostRoot });
  const hostUser = host.worlds.worldFor('u2');
  hostUser.apps.create({
    id,
    title: '宿主那份旧副本',
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': '<p>host</p>' },
  });
  const hostUserDir = nodePath.join(hostRoot, 'users', 'u2');
  const before = treeDigest(hostUserDir);

  const hostSrv = await bootTenantHost(t, { worlds: host.worlds, boxUds: uds });

  const r = await postRename(hostSrv.origin, hostSrv.token, { id, title: '奥数练一练（改）' });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  assert.deepEqual(JSON.parse(raw), { ok: true, title: '奥数练一练（改）' }, '回执形状 `{ok:true,title}`');

  assert.ok(hostSrv.state.dials > 0, '🔴 必须**真过隧道**（否则"动的是盒里那份"这一条什么都没证明）');
  // 盒里：那一版 manifest 真改了，而且 `list()` 跟着变
  assert.equal(manifestOf(boxRoot, id, 2).title, '奥数练一练（改）', '🔴 改的必须是**盘上那一版 manifest**');
  assert.equal(
    boxApps.list().find((a) => a.id === id)?.title,
    '奥数练一练（改）',
    '🔴 桌面上显示的就是 `list()` 的 title，它必须跟着变',
  );
  // 只动**指针指着的那一版**（契约原话："改的是那一版 manifest 里的名字"）
  assert.equal(manifestOf(boxRoot, id, 1).title, '奥数练一练', '别把不指向的那一版也改了');
  // 审计一行（谁、什么时候、改了哪一个、新名字）
  const line = auditLines(boxRoot).find((e) => e.what === 'rename');
  assert.ok(line, '🔴 改名要留审计一行');
  assert.equal(line.id, id);
  assert.equal(line.title, '奥数练一练（改）');
  assert.equal(line.sub, 'owner');
  assert.equal(typeof line.at, 'number', '审计那一行要有时间');

  // 宿主那份：**一个字节都不许动**
  assert.equal(treeDigest(hostUserDir), before, '🔴 宿主那一格被动了（"两处库"那句假话的形状）');
  assert.equal(
    hostUser.apps.list().find((a) => a.id === id)?.title,
    '宿主那份旧副本',
    '🔴 宿主那份的名字必须一个字都不变',
  );
});

// ════════════════════════════════════════════════════════════
// S11 —— 复制：新 id ＋ 逐文件 hash 对得上 ＋ 标题 X 副本 ＋ 新那一间是空的 ＋ 原来那份不动
// ════════════════════════════════════════════════════════════
test('S11 复制 ⇒ 新 id ＋ **逐文件 hash 对得上**（所有版本）＋ 标题「X 副本」＋ 新那一间空着；原来那份不动', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 's11' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;

  const id = 'dice';
  const w = h.worlds.worldFor('owner');
  seedApp(h.worlds, 'owner', id, '番茄钟');
  const before = treeDigest(appDirOf(h.dataDir, id));

  const r = await postCopy(origin, token, { id });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  assert.deepEqual(
    JSON.parse(raw),
    { ok: true, id: 'dice-copy', title: '番茄钟 副本' },
    '回执形状 `{ok:true,id,title}`，而且新 id 就是 `<原id>-copy`',
  );

  // ★ 字节一模一样：**所有版本、每一个文件**的 hash 都对得上
  assert.deepEqual(fileHashes(h.dataDir, 'dice-copy'), fileHashes(h.dataDir, id), '🔴 复制的字节必须一模一样');
  assert.equal(manifestOf(h.dataDir, 'dice-copy', 1).rootHash, manifestOf(h.dataDir, id, 1).rootHash);
  assert.equal(manifestOf(h.dataDir, 'dice-copy', 2).rootHash, manifestOf(h.dataDir, id, 2).rootHash);
  // 新那一格的清单里 id 必须换掉（不换 ⇒ `manifest()` 认不出它，`list()` 里根本不出现）
  assert.equal(manifestOf(h.dataDir, 'dice-copy', 1).id, 'dice-copy');
  assert.equal(manifestOf(h.dataDir, 'dice-copy', 2).id, 'dice-copy');
  assert.equal(manifestOf(h.dataDir, 'dice-copy', 2).title, '番茄钟 副本');
  assert.equal(
    w.apps.list().find((a) => a.id === 'dice-copy')?.title,
    '番茄钟 副本',
    '🔴 标题必须叫「X 副本」',
  );
  // 🔴 **新那一间是空的**：对话 / 工作区一个字都不复制
  assert.equal(
    w.store.readAll('main').filter((e) => String(e.scopeId ?? '') === 'dice-copy').length,
    0,
    '🔴 新那一间不许有对话',
  );
  assert.equal(
    nodeFs.existsSync(w.workspaces.dirFor('dice-copy')),
    false,
    '🔴 新那一间不许有工作区',
  );
  // 原来那一格：一个字节不动
  assert.equal(treeDigest(appDirOf(h.dataDir, id)), before, '🔴 原来那一格一个字节都不许动');
  // 审计一行
  assert.ok(auditHas(h.dataDir, 'copy', 'dice-copy'), '🔴 复制要留审计一行（含新 id）');
  assert.ok(
    auditLines(h.dataDir).some((e) => e.what === 'copy' && e.id === id && e.newId === 'dice-copy'),
    '审计那一行要说清"从谁复制出来的"',
  );
});

// ════════════════════════════════════════════════════════════
// S12 —— 盒里权威：真过隧道（两条口）＋ 盒子不通 ⇒ 503 ＋ 宿主那份一个字节不动
// ════════════════════════════════════════════════════════════
test('S12 两条都**以盒子为准**：真过隧道、盒里落；盒子不通 ⇒ **503**；宿主那份一个字节不动', async (t) => {
  const boxRoot = tmp('hupo-104-box-');
  const box = await bootWorlds(t, { tag: 'box', dataDir: boxRoot });
  const boxSrv = await bootServer(t, { worlds: box.worlds, trustedSub: 'owner', buildId: 's12-box' });
  await boxSrv.listen(0);
  const uds = nodePath.join(tmp('hupo-104-uds-'), 'local-api.sock');
  await boxSrv.listenTrusted(uds);

  const id = 'aoshu';
  const boxApps = seedApp(box.worlds, 'owner', id, '奥数练一练');

  const hostRoot = tmp('hupo-104-host-');
  const host = await bootWorlds(t, { tag: 'host', dataDir: hostRoot });
  const hostUser = host.worlds.worldFor('u2');
  hostUser.apps.create({
    id,
    title: '宿主那份旧副本',
    icon: 'dice',
    entry: 'index.html',
    files: { 'index.html': '<p>host</p>' },
  });
  const hostUserDir = nodePath.join(hostRoot, 'users', 'u2');
  const before = treeDigest(hostUserDir);

  const hostSrv = await bootTenantHost(t, { worlds: host.worlds, boxUds: uds });

  // ① 改名：盒里落，宿主不动
  const r1 = await postRename(hostSrv.origin, hostSrv.token, { id, title: '奥数（盒子那份）' });
  assert.equal(r1.status, 200, await r1.text());
  assert.ok(hostSrv.state.dials > 0, '🔴 必须**真过隧道**（别让宿主顶替盒子）');
  assert.equal(boxApps.list().find((a) => a.id === id)?.title, '奥数（盒子那份）');
  assert.equal(treeDigest(hostUserDir), before, '🔴 宿主那一格被动了');

  // ② 复制：盒里多出一格，宿主还是不动
  const r2 = await postCopy(hostSrv.origin, hostSrv.token, { id });
  const raw2 = await r2.text();
  assert.equal(r2.status, 200, raw2);
  assert.deepEqual(JSON.parse(raw2), { ok: true, id: 'aoshu-copy', title: '奥数（盒子那份） 副本' });
  assert.deepEqual(fileHashes(boxRoot, 'aoshu-copy'), fileHashes(boxRoot, id), '盒里复制出来的字节要对得上');
  assert.deepEqual(
    boxApps.list().map((a) => a.id),
    ['aoshu', 'aoshu-copy'],
    '🔴 新那一格必须长在**盒子**里',
  );
  assert.equal(treeDigest(hostUserDir), before, '🔴 宿主那一格被动了（复制也不许碰它）');

  // ③ 盒子不通 ⇒ **503**，而且宿主那份一个字节都不许动
  hostSrv.state.down = true;
  const r3 = await postRename(hostSrv.origin, hostSrv.token, { id, title: '这条不该成' });
  assert.equal(r3.status, 503, `盒子不通必须 503，实际 ${r3.status}：${await r3.text()}`);
  const r4 = await postCopy(hostSrv.origin, hostSrv.token, { id });
  assert.equal(r4.status, 503, `盒子不通必须 503，实际 ${r4.status}：${await r4.text()}`);
  assert.equal(boxApps.list().find((a) => a.id === id)?.title, '奥数（盒子那份）', '盒里那份不许被"退回宿主"的那条路改掉');
  assert.equal(treeDigest(hostUserDir), before, '🔴 盒子不通时宿主那份被动了 —— 正是"两处库"那句假话的形状');
  assert.equal(hostUser.apps.list().find((a) => a.id === id)?.title, '宿主那份旧副本');
});

// ════════════════════════════════════════════════════════════
// S12·补 —— 盒里那两条内部口**只在可信 UDS 上**（公网口 ⇒ 404 且一次都不碰库）
// ════════════════════════════════════════════════════════════
test('S12·补 内部口**只在可信 UDS 上**：公网口 ⇒ 404 且一次都不碰库；可信口 ⇒ 真答得上来', async (t) => {
  const boxRoot = tmp('hupo-104-box-');
  const box = await bootWorlds(t, { tag: 'box', dataDir: boxRoot });
  const boxSrv = await bootServer(t, { worlds: box.worlds, trustedSub: 'owner', buildId: 's12c' });
  const pub = await boxSrv.listen(0);
  const uds = nodePath.join(tmp('hupo-104-uds-'), 'local-api.sock');
  await boxSrv.listenTrusted(uds);

  const id = 'aoshu';
  const boxApps = seedApp(box.worlds, 'owner', id, '奥数练一练');
  const before = treeDigest(appDirOf(boxRoot, id));

  // 公网口：普通请求打那两条内部路径 ⇒ 404（它不是 UDS，不受信）
  for (const [p, body] of [
    ['/internal/app-rename', { id, title: '公网口不许改' }],
    ['/internal/app-copy', { id }],
  ]) {
    const r = await fetch(`http://127.0.0.1:${pub.port}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 404, `公网口 ${p} 必须 404，实际 ${r.status}`);
  }
  assert.equal(treeDigest(appDirOf(boxRoot, id)), before, '🔴 公网口那两下**一次都不许碰库**');
  assert.deepEqual(boxApps.list().map((a) => a.id), [id], '公网口不许复制出新的一格');

  // 正对照：可信 UDS 上那条口真答得上来（否则上面那个 404 什么都证明不了）
  const reply = await new Promise((resolve, reject) => {
    const conn = nodeNet.connect(uds);
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('connect', () => {
      const body = JSON.stringify({ id, title: '奥数（可信口改的）' });
      conn.write(
        `POST /internal/app-rename HTTP/1.1\r\nhost: box\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
    conn.on('data', (c) => {
      buf += c;
    });
    conn.on('end', () => resolve(buf));
    conn.on('error', reject);
  });
  assert.match(reply, /200/, reply.slice(0, 120));
  assert.match(reply, /"ok":true/, reply.slice(-200));
  assert.equal(boxApps.list().find((a) => a.id === id)?.title, '奥数（可信口改的）', '可信口上要真改掉');
});

// ════════════════════════════════════════════════════════════
// S13 —— 边界：空名字 / 太长 ⇒ 400；认不出 / 不在他这儿 ⇒ 404；id 撞了往后加数字（有上限）
// ════════════════════════════════════════════════════════════
test('S13 边界：空名字 / 太长 ⇒ **400 ＋ 人话**；认不出 / 不在他这儿 ⇒ **404 ＋ 人话**', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 's13a' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;

  seedApp(h.worlds, 'owner', 'dice', '番茄钟');
  const good = JSON.stringify(manifestOf(h.dataDir, 'dice', 2));

  const bad = [
    { body: { id: 'dice', title: '' }, why: '空名字' },
    { body: { id: 'dice', title: '   ' }, why: '只有空格的名字' },
    { body: { id: 'dice', title: 'x'.repeat(MAX_TITLE_CHARS + 1) }, why: '太长' },
    { body: { id: 'dice', title: 123 }, why: '名字不是字符串' },
  ];
  for (const c of bad) {
    const r = await postRename(origin, token, c.body);
    const raw = await r.text();
    assert.equal(r.status, 400, `${c.why} 必须 400，实际 ${r.status}：${raw}`);
    const j = JSON.parse(raw);
    assert.ok(typeof j.text === 'string' && j.text !== '', `🔴 ${c.why} 要带一句人话（N11）`);
  }
  // 正身：上面那几下**盘上一个字节都没动**
  assert.equal(JSON.stringify(manifestOf(h.dataDir, 'dice', 2)), good, '校验不过 ⇒ 盘上不许动');

  for (const id of ['根本没有这个', 'NO/../P', '']) {
    const r = await postRename(origin, token, { id, title: '随便' });
    assert.equal(r.status, 404, `认不出 / 不在他这儿（${JSON.stringify(id)}）必须 404，实际 ${r.status}`);
    const j = JSON.parse(await r.text());
    assert.ok(typeof j.text === 'string' && j.text !== '', '🔴 404 也要带一句人话');
    const rc = await postCopy(origin, token, { id });
    assert.equal(rc.status, 404, `复制那条：认不出 / 不在他这儿（${JSON.stringify(id)}）必须 404`);
  }
  assert.equal(JSON.stringify(manifestOf(h.dataDir, 'dice', 2)), good);
  assert.deepEqual(h.worlds.worldFor('owner').apps.list().map((a) => a.id), ['dice'], '失败的请求不许留下东西');
});

test('S13·补 复制撞名：新 id 往后加数字（`-copy2`）、新标题也往后加；试不出来 ⇒ **如实 409 ＋ 人话**', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 's13b' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;
  const w = h.worlds.worldFor('owner');

  seedApp(h.worlds, 'owner', 'dice', '番茄钟');
  // ★ 故意先占掉 `-copy` **而且标题也叫「番茄钟 副本」**
  seedApp(h.worlds, 'owner', 'dice-copy', '番茄钟 副本');

  const r = await postCopy(origin, token, { id: 'dice' });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  assert.deepEqual(
    JSON.parse(raw),
    { ok: true, id: 'dice-copy2', title: '番茄钟 副本2' },
    '🔴 撞了就要往后加数字（id 与标题都是）',
  );
  assert.deepEqual(fileHashes(h.dataDir, 'dice-copy2'), fileHashes(h.dataDir, 'dice'));

  // ★ 上限：把 `-copy` 到 `-copy{MAX_COPY_TRIES}` 全占掉 ⇒ **如实 409 ＋ 人话**（不是无限试）
  seedApp(h.worlds, 'owner', 'cap', '占位');
  for (let n = 1; n <= MAX_COPY_TRIES; n += 1) {
    const cid = n === 1 ? 'cap-copy' : `cap-copy${n}`;
    w.apps.create({ id: cid, title: `占位 ${n}`, icon: 'dice', entry: 'index.html', files: { 'index.html': '<p>x</p>' } });
  }
  // 先证明"真占满了"（否则下面那条 409 是空转）
  assert.equal(w.apps.current('cap-copy'), 1);
  assert.equal(w.apps.current(`cap-copy${MAX_COPY_TRIES}`), 1);
  const rCap = await postCopy(origin, token, { id: 'cap' });
  const rawCap = await rCap.text();
  assert.notEqual(rCap.status, 200, `试不出来不许回 200：${rawCap}`);
  assert.equal(rCap.status, 409, `如实 409，实际 ${rCap.status}：${rawCap}`);
  assert.ok(JSON.parse(rawCap).text, '🔴 要带一句人话');
  assert.equal(
    nodeFs.existsSync(appDirOf(h.dataDir, `cap-copy${MAX_COPY_TRIES + 1}`)),
    false,
    '试不出来就不许留下半格',
  );
});

// ════════════════════════════════════════════════════════════
// X1 —— 自己想的反例①：**复制顺手把"那一段经历"带过去了** ⇒ 红
// ════════════════════════════════════════════════════════════
test('X1 复制**不许**顺手带走对话 / 工作区 / 用量（复制的是东西，不是那一段经历）', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 'x1' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;

  const id = 'dice';
  const w = h.worlds.worldFor('owner');
  seedApp(h.worlds, 'owner', id, '番茄钟');
  // 那一间的"经历"：说过的话 ＋ 工作区里存下来的东西 ＋ 用量
  const room = h.worlds.roomFor('owner', id);
  w.timeline.emit({ type: 'user/echo', messageId: 'main-1', text: '主线一句' });
  room.timeline.emit({ type: 'user/echo', messageId: 'mine-1', text: '这一间一句' });
  room.timeline.emit({ type: 'user/echo', messageId: 'mine-2', text: '这一间两句' });
  const wsDir = w.workspaces.dirFor(id);
  nodeFs.mkdirSync(wsDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(wsDir, 'note.txt'), '这一间存下来的');
  w.usage.note(id, { kind: USAGE_KINDS.agentTurn, usage: { prompt_tokens: 7, completion_tokens: 1 } });

  const r = await postCopy(origin, token, { id });
  assert.equal(r.status, 200, await r.text());

  const newId = 'dice-copy';
  // 🔴 新那一间：**一个字都不许有**
  assert.equal(
    w.store.readAll('main').filter((e) => String(e.scopeId ?? '') === newId).length,
    0,
    '🔴 复制把对话带过去了 —— "复制的是东西，不是那一段经历"当场破',
  );
  assert.equal(nodeFs.existsSync(w.workspaces.dirFor(newId)), false, '🔴 复制把工作区带过去了');
  for (const f of ['usage.jsonl', 'grant.json', 'ask.json', 'lineage.json']) {
    assert.equal(nodeFs.existsSync(nodePath.join(appDirOf(h.dataDir, newId), f)), false, `🔴 ${f} 不许跟着复制`);
  }
  // 正身：原来那一间的"经历"一样都没少（不然上面那些断言可能只是"本来就没有"）
  assert.equal(
    w.store.readAll('main').filter((e) => String(e.scopeId ?? '') === id).length,
    2,
    '原来那一间的对话要原样在',
  );
  assert.equal(nodeFs.readFileSync(nodePath.join(wsDir, 'note.txt'), 'utf8'), '这一间存下来的');
  assert.equal(nodeFs.existsSync(nodePath.join(appDirOf(h.dataDir, id), 'usage.jsonl')), true);
});

// ════════════════════════════════════════════════════════════
// X2 —— 自己想的反例②：**改名的回执说"成了"、盘上却没改** ⇒ 红
// ════════════════════════════════════════════════════════════
test('X2 改名的回执**必须与盘上一致**：回执说成了 ⇒ 那一版 manifest 真的改了（失败的 ⇒ 盘上不动）', async (t) => {
  const h = await bootWorlds(t, { tag: 'host' });
  const s = await bootServer(t, { worlds: h.worlds, buildId: 'x2' });
  const addr = await s.listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const token = s.auth.issue({ sub: 'owner' }).token;

  const id = 'dice';
  const w = h.worlds.worldFor('owner');
  seedApp(h.worlds, 'owner', id, '番茄钟');

  const r = await postRename(origin, token, { id, title: '番茄钟（新）' });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  const j = JSON.parse(raw);
  assert.deepEqual(j, { ok: true, title: '番茄钟（新）' });

  // 🔴 不信回执，**直接读盘上那一份**（回执说成了、盘上没改 ⇒ 当场红）
  const diskRaw = nodeFs.readFileSync(nodePath.join(versionDirOf(h.dataDir, id, 2), 'manifest.json'), 'utf8');
  assert.equal(JSON.parse(diskRaw).title, j.title, '🔴 回执说成了，可盘上那一版的名字没改');
  assert.ok(diskRaw.includes('番茄钟（新）'), '🔴 盘上的 manifest.json 里找不到新名字');
  assert.equal(w.apps.list().find((a) => a.id === id)?.title, j.title, '`list()` 要与回执一致');
  const line = auditLines(h.dataDir).find((e) => e.what === 'rename');
  assert.equal(line?.title, j.title, '审计那一行写的新名字要与回执一致');
  assert.equal(Number(line?.version), 2, '审计要说清改的是哪一版');

  // 反向：**不合法 ⇒ 400，而且盘上一个字节都不动**（不许"改一半"）
  const snap = nodeFs.readFileSync(nodePath.join(versionDirOf(h.dataDir, id, 2), 'manifest.json'));
  const r2 = await postRename(origin, token, { id, title: '' });
  assert.equal(r2.status, 400, await r2.text());
  assert.deepEqual(
    nodeFs.readFileSync(nodePath.join(versionDirOf(h.dataDir, id, 2), 'manifest.json')),
    snap,
    '🔴 失败的改名把盘上动了',
  );
});
