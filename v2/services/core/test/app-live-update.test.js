// **制品换了一版 ⇒ 正开着它的那个界面自己换上**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）。
//
// ── 这一份钉什么（一句话）──────────────────────────────────
//   ① 🔴 **发成了才有那一帧**（`app/update-available`：字段齐、版本对、**持久**、
//      只属于**那个 app 那一间**）—— 没发成 / 第一版 ⇒ **没有**；
//   ② 🔴 **帧里不许有签名**（`entryUrl` 是短时效的，落盘就是一句迟早变假的话）；
//   ③ 🔴 **没做成要有一条主人看得见的话**（主人 2026-09-26 真机现场：
//      助手撞上单文件上限、说了句"我试几种压法"就没了 —— 他那边**一点提示都没有**）；
//      而"要回头问他一句"的那种拒绝（`needs-ask` / `needs-choice`）**不喊**
//      （喊了就是假话：那两件事**助手会回来问他**）。
//
// ⚠️ **走真链路**：真 `Worlds`（真调度器/真通知/真那条日志）＋ **真域套接字**
//    （`world.appsSocket` —— 就是 MCP 工具那条口）⇒ `ctx` 那一套接线（`onVersion` /
//    `onAppFailed`）**是被验的那一份**，不是测试里另接一遍。
//    ⚠️ **不起 agent、不花一个 token**。
//
// ⚠️ 形状照 `test/app-menu.test.js` / `test/app-reclaim.test.js`。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { AgentRuntime } from '../src/agent-runtime.js';
import { APP_UPDATE_AVAILABLE, appUpdateOf } from '../src/app-events.js';
import { APP_FAIL_QUIET_REFUSALS, appFailText, shouldTellAppFail } from '../src/app-fail-words.js';
import { MAX_FILE_BYTES } from '../src/apps.js';
import { ScopeView } from '../src/timeline.js';
import { Worlds } from '../src/worlds.js';

const NOW = 1_800_000_000_000;
const SUB = 'u1';

// ── 起过的东西（`after()` 兜底收掉：红了也要能退出）────────────
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

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-111-'));

/** 那一份的 cfg（照 `app-menu.test.js`；⚠️ 评审 agent 给桩 ⇒ 不起真进程）。 */
function cfgFor(dataDir) {
  return {
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
    turnDeadlineMs: 5000,
    // ★ 上架那条路上要不要复评由 `operatorReview` 定（缺省 = 不接）⇒ 这一份不起第二台
    operatorReview: false,
  };
}

/** 起一个人那一份**真**世界。⚠️ 不起真 agent（`spawnFn` 直接抛）。 */
async function bootWorlds(t) {
  const dataDir = tmp();
  const cfg = cfgFor(dataDir);
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
  const world = worlds.worldFor(SUB);
  await world.appsSocket?.ready?.();
  return { dataDir, worlds, world };
}

/** 经**真域套接字**递一条请求（MCP 工具那条口就是它）。 */
function sendOp(socketPath, req) {
  return new Promise((resolve, reject) => {
    const conn = nodeNet.connect(socketPath, () => conn.write(`${JSON.stringify(req)}\n`));
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      conn.end();
      try {
        resolve(JSON.parse(buf.slice(0, i)));
      } catch (err) {
        reject(err);
      }
    });
    conn.on('error', reject);
  });
}

/** 一份最小制品（`outbound.json` 是上架那条申报闸要的）。 */
function filesOf(mark = '第一版') {
  return {
    'index.html': `<!doctype html><meta charset="utf-8"><p>${mark}</p>`,
    'outbound.json': JSON.stringify({
      schema: 1,
      outbound: [],
      declaredUsage: { dailyTokensBand: 0, dailyCallsBand: 0, basis: '判据' },
    }),
  };
}

/** 那条日志上所有这一帧（**不过滤房间** —— 主线视图看不到它才说明盖了标签）。 */
function framesOf(world, type = APP_UPDATE_AVAILABLE) {
  return world.timeline.base.readAll().filter((e) => e.type === type);
}

function noticesOf(world) {
  return world.timeline.readAll().filter((e) => e.type === 'notice');
}

// ══ ① 发成了才有那一帧 ════════════════════════════════════

test('🔴 U1a：第一版**不喊**（那不是"更新"，而且那一刻还没有界面开着它）', async (t) => {
  const { world } = await bootWorlds(t);
  world.apps.create({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: filesOf() });
  assert.deepEqual(framesOf(world), [], '第一版就喊 ⇒ 红（那不是"有新版了"）');
});

test('🔴 U1b：真"装上一版"⇒ 那条日志上**有**那一帧（字段齐、版本对、带房间标签、有号）', async (t) => {
  const { world } = await bootWorlds(t);
  // 他自己这儿先有一版（**夹具**：这一条判据验的是"更新"那一刀，不是"造"那一刀）
  world.apps.create({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: filesOf('v1') });
  // 共享库里有它（上架一次）⇒ 下面"装上"才有得装
  world.published.publish(world.apps, { id: 'dice', authorSub: SUB, authorName: '用户 小1' });
  const before = framesOf(world).length;

  // ★ **真那条口**（MCP 工具走的就是它）
  const r = await sendOp(world.appsSocket.path, { op: 'install', id: 'dice' });
  assert.equal(r.ok, true, `装上该成：${JSON.stringify(r)}`);
  assert.equal(r.version, 2, '这一装就是新的一版（版本号 +1）');

  const frames = framesOf(world);
  assert.equal(frames.length, before + 1, '★ 发成了就该有那一帧');
  const f = frames[frames.length - 1];
  assert.equal(f.type, APP_UPDATE_AVAILABLE);
  assert.equal(f.id, 'dice', '要说是哪一个');
  assert.equal(f.version, 2, '版本号要对得上 `/api/apps` 里那个');
  assert.equal(typeof f.at, 'number');
  assert.equal(typeof f.seq, 'number', '★ 它是**持久**事件（有号 ⇒ 重连补得上）');
  assert.equal(f.scopeId, 'dice', '★ 盖了房间标签 ⇒ 只有正开着它的那条连接实时收得到');

  // 🔴 **它不属于主线**（`/api/apps` 之外的人读主线历史读不到它）
  assert.deepEqual(
    world.timeline.readAll().filter((e) => e.type === APP_UPDATE_AVAILABLE),
    [],
    '主线那一层不该看到它（它属于那一间）',
  );
  // 而那一间的视图看得到
  const room = new ScopeView({ timeline: world.timeline.base, scope: 'dice' });
  assert.equal(room.readAll().filter((e) => e.type === APP_UPDATE_AVAILABLE).length, before + 1);

  // ★ **持久 = 重连/重开补得上**：新开一把 `Timeline` 读同一份盘
  const { Timeline } = await import('../src/timeline.js');
  const again = new Timeline({ id: 'main', store: world.store });
  assert.equal(
    again.readAll().filter((e) => e.type === APP_UPDATE_AVAILABLE).length,
    before + 1,
    '★ 落盘了 ⇒ 换一条连接（或重启）照样补得上',
  );
});

test('🔴 U1c（反着验）：没发成 ⇒ **没有**那一帧，号也不许动', async (t) => {
  const { world } = await bootWorlds(t);
  world.apps.create({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: filesOf() });
  const seqBefore = world.timeline.seq;
  const framesBefore = framesOf(world).length;

  // 一次注定失败的"更新"（空制品 ⇒ `apps.create` 在**动盘之前**就抛）
  assert.throws(
    () => world.apps.create({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: {} }),
    /一个文件都没有/,
  );
  assert.equal(framesOf(world).length, framesBefore, '★ 没发成还喊了一声 ⇒ 红');
  assert.equal(world.timeline.seq, seqBefore, '没发成不该占号');

  // 🔴 第二刀（**更靠近那一刀**）：这一次它已经算完版本号、**正要动盘**才失败 ——
  //    "先喊再写"那种写法在这一刀上会露出来（`versions/2` 先被占成一个文件 ⇒
  //    `apps.create` 在那个文件上抛）。号与帧**都得不动**。
  nodeFs.writeFileSync(nodePath.join(world.apps.versionsDir('dice'), '2'), 'x');
  assert.throws(
    () => world.apps.create({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: filesOf('v2') }),
    /这一版的目录已经存在了/,
  );
  assert.equal(framesOf(world).length, framesBefore, '★ 写盘失败也喊了一声 ⇒ 红（先喊再写就是这个形状）');
  assert.equal(world.timeline.seq, seqBefore);
  nodeFs.rmSync(nodePath.join(world.apps.versionsDir('dice'), '2'), { force: true });
});

test('🔴 U1d：那一帧里**不许有签名**（`entryUrl` 是短时效的，落盘就是假话）', async (t) => {
  const { world } = await bootWorlds(t);
  world.apps.create({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: filesOf('v1') });
  world.published.publish(world.apps, { id: 'dice', authorSub: SUB, authorName: '用户 小1' });
  await sendOp(world.appsSocket.path, { op: 'install', id: 'dice' });

  const raw = JSON.stringify(framesOf(world));
  for (const bad of ['entryUrl', 'sig', 's=', 'token', '/a/dice/']) {
    assert.ok(!raw.includes(bad), `帧里出现了「${bad}」—— 签名 / 地址一个都不许落盘：${raw}`);
  }
  // 反例的正身：这把尺不是恒真
  assert.ok(JSON.stringify({ entryUrl: 'http://x/a/dice/1/index.html?s=ab' }).includes('entryUrl'));
});

// ══ ② 没做成要有一条主人看得见的话 ══════════════════════════

test('🔴 没做成 ⇒ **有一条人话**（点名那个小程序 ＋ 为什么，一个内部词都没有）', async (t) => {
  const { world } = await bootWorlds(t);
  // ⚠️ 造东西那条闸（P1-22）要看"**他这一轮说了什么**"；这一条判据验的是
  //    **尺寸那道闸之后**的事 ⇒ 把"他明说了"这一格喂上（真跑起来是调度器记的）。
  world.dispatcher.turnInputOf = () => '帮我做一个小程序，把题库放进去';

  const before = noticesOf(world).length;
  const r = await sendOp(world.appsSocket.path, {
    op: 'create',
    app: {
      id: 'tiku',
      title: '题库小站',
      icon: 'book',
      entry: 'index.html',
      // 🔴 真机现场那一下：**单文件上限**（压完再转文本，反而涨 33%）
      files: { 'index.html': 'x'.repeat(MAX_FILE_BYTES + 1) },
    },
  });
  assert.equal(r.ok, false, '这么大的一份就该被拒');

  const after_ = noticesOf(world);
  assert.equal(after_.length, before + 1, '★ 没做成必须有一条他看得见的话');
  const line = after_[after_.length - 1].text;
  assert.match(line, /题库小站/, `要点名是哪一个：${line}`);
  assert.match(line, /大/, `要说清"为什么没成"（这一条是尺寸）：${line}`);
  for (const w of ['工作区', '客户端', '云端', '服务器', '调度器', '时间线', '作用域',
    '会话', '工具', '模型', '连接', 'web_search', 'bash']) {
    assert.ok(!line.includes(w), `内部词不许上屏（${w}）：${line}`);
  }
  // 而且**工具那句原文**（有内部短名）没被端上去
  assert.ok(!line.includes('index.html'), `不要把工具那句原文端上屏：${line}`);
});

test('🔴 反例：**要回头问他一句**的那种拒绝 ⇒ 一个字都不喊（喊了就是假话）', async (t) => {
  const { world } = await bootWorlds(t);
  // 他没说要做 ⇒ `needs-ask`
  world.dispatcher.turnInputOf = () => null;
  const before = noticesOf(world).length;
  const r = await sendOp(world.appsSocket.path, {
    op: 'create',
    app: { id: 'tiku', title: '题库小站', icon: 'book', entry: 'index.html', files: filesOf() },
  });
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'needs-ask');
  assert.equal(noticesOf(world).length, before, '★ 这不是失败，是"要问他一句" ⇒ 不许喊');
});

test('🔴 反例：**成了**的那种 ⇒ 也不喊（不许"狼来了"）', async (t) => {
  const { world } = await bootWorlds(t);
  world.dispatcher.turnInputOf = () => '帮我做一个小程序，叫掷骰子';
  const before = noticesOf(world).length;
  const r = await sendOp(world.appsSocket.path, {
    op: 'create',
    app: { id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: filesOf() },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(noticesOf(world).length, before, '成了还说"没做成" ⇒ 红');
});

test('🔴 上架被拒（评审没过）⇒ 也有一条人话', async (t) => {
  const { world } = await bootWorlds(t);
  world.apps.create({ id: 'dice', title: '掷骰子', icon: 'dice', entry: 'index.html', files: filesOf() });
  const before = noticesOf(world).length;
  // 上架这条路上"评审"是**服务端**那一步（产品层规则读不到 ⇒ 不放行）；
  // 这一条判据只要"被拒 ⇒ 有话说"，所以给一份读得懂的规则也照样会被拒。
  const r = await sendOp(world.appsSocket.path, { op: 'publish', id: 'dice' });
  assert.equal(r.ok, false, `这一版不该上架成功：${JSON.stringify(r)}`);
  const after_ = noticesOf(world);
  assert.equal(after_.length, before + 1, '★ 上架被拒也要说一句（不许静默）');
  assert.match(after_[after_.length - 1].text, /掷骰子/);
});

test('🔴 判据打在真那一刀上：`shouldTellAppFail` 的两档（不然这条闸是空的）', () => {
  for (const op of ['create', 'install', 'publish']) {
    assert.equal(shouldTellAppFail({ op }), true, `${op} 没做成该说`);
  }
  for (const refused of APP_FAIL_QUIET_REFUSALS) {
    assert.equal(shouldTellAppFail({ op: 'install', refused }), false, `${refused} 是"要问他一句"，不喊`);
  }
  // `draw` / 认不出的动作不归这一条管
  assert.equal(shouldTellAppFail({ op: 'draw' }), false);
  assert.equal(shouldTellAppFail({}), false);
  // 而那两句人话**真的是一句人话**（不是空串、也不是工具原文）
  const line = appFailText({ op: 'create', title: '题库小站', error: '单个文件太大：index.html' });
  assert.match(line, /题库小站/);
  assert.match(line, /太大/);
});

test('🔴 `appUpdateOf` 认得出 / 认不出都安静（协议只加不改）', () => {
  assert.deepEqual(appUpdateOf({ type: APP_UPDATE_AVAILABLE, id: 'dice', version: 2 }), { id: 'dice', version: 2 });
  for (const bad of [
    null,
    {},
    { type: APP_UPDATE_AVAILABLE },
    { type: APP_UPDATE_AVAILABLE, id: '', version: 2 },
    { type: APP_UPDATE_AVAILABLE, id: 'dice', version: 0 },
    { type: APP_UPDATE_AVAILABLE, id: 'dice', version: '2' },
    { type: 'message/start', id: 'dice', version: 2 },
  ]) {
    assert.equal(appUpdateOf(bad), null, `认不出的该安静忽略：${JSON.stringify(bad)}`);
  }
});

// ⚠️ `NOW` 只是把时间钉住（本份判据不依赖墙上时间）；显式用一下，免得 lint 说它没用
assert.equal(typeof NOW, 'number');
