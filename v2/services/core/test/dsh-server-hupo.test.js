// **一个房间一条会话** —— 判据 S2–S6（契约 `docs/dev/110-ONE-SESSION-PER-ROOM.md`）。
//
// 这一份**不花钱、不碰真 DSH**：假 ctx ＋ 假 fs ＋ 两条真内存流。
// 打的是三件最容易做错的事：
//   · **create 还是 resume**（S2）—— 走的是 `sdk-server-hupo.mjs` 自己那条判据；
//   · **id 稳不稳 / 会不会串**（S1/S3）—— 纯函数 ＋ 那份映射；
//   · **映射坏掉时猜不猜**（S5）—— 坏内容必须**当场报错**，绝不许"当成没有"
//     （当成没有就会**悄悄多出一条对话**，而那正是这个契约要修的毛病）。
//
// ⚠️ 每一条判据都要能**反着验**（变异读数见契约 §五）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DSH_SESSIONS_FILE,
  dshSessionIdFor,
  mappingPathFor,
  readSessions,
  scopeOfAgentKey,
  sessionIdFor,
  writeSessions,
} from '../src/dsh-sessions.mjs';
import {
  HupoSdkServer,
  LineTransport,
  assertSessionId as pluginAssertSessionId,
  isSessionIdShape as pluginIsSessionIdShape,
  inject as pluginInject,
  name as pluginName,
  successStatus,
} from '../src/sdk-server-hupo.mjs';
// ★ 形状判据的**一处出处**（`session-id.mjs`）。这里从它自己 import，
//   并断言插件那一侧 re-export 的**就是同一个函数**（否则又成了两套口径）。
import { SESSION_ID_MAX, assertSessionId, isSessionIdShape } from '../src/session-id.mjs';
import { agentPatchArgs, agentArgs } from '../src/agent-runtime.js';
import { devWebArgs } from '../src/dev-mode.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const CORE = nodePath.resolve(HERE, '..');

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-s110-'));

// ── 脚手架：假 ctx（真判据走它）＋ 两条真内存流 ─────────────────

/**
 * 假 ctx：只实现 server 真正用到的那几样。
 *
 * ⚠️ **`sessionPersistence` 是仿真出来的"跨进程还活着"**（一个共享的 Map）——
 *    这正是 DSH 的真实行为（会话记录落在 `$DSH_HOME/sessions/` 里）。
 *    "第二个进程要 resume"那条判据全靠它。
 */
function fakeCtx({ persisted = new Map(), sessions = new Map(), onHandlers = null } = {}) {
  const calls = { create: [], resume: [], resolveCallConfig: [] };
  const live = sessions; // sessionId → { header }
  const agents = new Map(); // agentId → agent
  const subscribers = new Map();
  const makeAgent = (id) => ({
    id,
    messages: [],
    followup(message) {
      this.messages.push(message);
    },
  });
  const ctx = {
    calls,
    persisted,
    live,
    root: { fiber: { dispose: async () => {} } },
    effect(fn) {
      const cleanup = fn();
      return () => cleanup?.();
    },
    on(event, handler) {
      if (!subscribers.has(event)) subscribers.set(event, []);
      subscribers.get(event).push(handler);
      return () => {
        const list = subscribers.get(event) ?? [];
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
      };
    },
    emit(event, ...args) {
      for (const h of subscribers.get(event) ?? []) h(...args);
    },
    get(name) {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'deepseek-official' }],
          resolveCallConfig: async (opts) => {
            calls.resolveCallConfig.push(opts);
            return {};
          },
        };
      }
      if (name === 'loader') return { await: async () => {} };
      if (name === 'sessionPersistence') {
        return {
          open: async (id) => {
            if (!persisted.has(id)) {
              const err = new Error(`session "${id}" not found`);
              err.name = 'SessionPersistenceNotFoundError';
              throw err;
            }
            return { header: persisted.get(id), close: async () => {} };
          },
        };
      }
      return undefined;
    },
    sessions: { get: (id) => live.get(id) },
    agents: {
      get: (id) => agents.get(id),
      create: async (options) => {
        calls.create.push(options);
        const agent = makeAgent(options.sessionId);
        agents.set(options.sessionId, agent);
        live.set(options.sessionId, { header: { cwd: options.meta.cwd } });
        persisted.set(options.sessionId, { cwd: options.meta.cwd });
        return {
          agent,
          dispose: async () => {
            agents.delete(options.sessionId);
            live.delete(options.sessionId);
          },
        };
      },
      resume: async (options) => {
        calls.resume.push(options);
        const id = options.resumeSessionId;
        const agent = makeAgent(id);
        agents.set(id, agent);
        if (!live.has(id)) live.set(id, { header: persisted.get(id) ?? {} });
        return {
          agent,
          dispose: async () => {
            agents.delete(id);
            live.delete(id);
          },
        };
      },
    },
  };
  if (onHandlers) {
    for (const [event, handler] of Object.entries(onHandlers)) ctx.on(event, handler);
  }
  return ctx;
}

/** 一台"进程"：`apply()` 装上插件，写 NDJSON 进去、收 NDJSON 出来。 */
function harness({ persisted = new Map(), config = {} } = {}) {
  const ctx = fakeCtx({ persisted });
  const input = new PassThrough();
  const output = { writes: [], write(s, cb) { this.writes.push(String(s)); cb?.(); return true; } };
  const server = { ctxRef: ctx };
  // 用 apply 那一层（真 transport、真帧），所以这里不能直接 new HupoSdkServer ——
  // 走 `apply` 才是"客户端看到的那个形状"。
  const mod = { apply: null };
  const applyMod = { ...config };
  // 动态 import 一次，拿 apply（静态 import 也可以，这里为了把 argv 传清）
  return import('../src/sdk-server-hupo.mjs').then((m) => {
    mod.apply = m.apply;
    m.apply(ctx, { input, output, exit: () => {}, ...applyMod });
    const frames = () => output.writes
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
    const send = (obj) => new Promise((resolve) => {
      input.write(`${JSON.stringify(obj)}\n`);
      // 帧是异步处理的：让出一轮事件循环再读
      setTimeout(resolve, 5);
    });
    return { ctx, input, output, frames, send, server };
  });
}

const frameWithId = (frames, id) => frames.find((f) => f.id === id);

// ── S2：不在 ⇒ create；在 ⇒ resume ─────────────────────────────

test('🔴 S2：同一间第一次 ⇒ create；**换一个进程再来** ⇒ resume（这是这个契约的机关）', async () => {
  const persisted = new Map(); // 跨"进程"共享：DSH 的会话记录就是跨进程活着的
  const dir = tmp();

  // ── 第一台（第一次说话）──
  const one = await harness({ persisted });
  await one.send({
    id: 1,
    method: 'initialize',
    params: { cwd: dir, provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  await one.send({
    id: 2,
    method: 'session/prompt',
    params: { sessionId: 'room-one', contentBlocks: [{ type: 'text', text: '第一句' }] },
  });
  assert.equal(one.ctx.calls.create.length, 1, '★ 会话不在 ⇒ 必须走 create');
  assert.equal(one.ctx.calls.resume.length, 0, '★ 第一台不许 resume 一条还不存在的会话');
  assert.equal(one.ctx.calls.create[0].sessionId, 'room-one', 'create 用的就是我们给的那个 id');
  assert.equal(one.ctx.calls.create[0].meta.cwd, dir, 'cwd 必须是 initialize 里那个');

  // ── 第二台（**另一个进程**，同一个 DSH_HOME）──
  const two = await harness({ persisted });
  await two.send({
    id: 1,
    method: 'initialize',
    params: { cwd: dir, provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  await two.send({
    id: 2,
    method: 'session/prompt',
    params: { sessionId: 'room-one', contentBlocks: [{ type: 'text', text: '第二句' }] },
  });
  assert.equal(two.ctx.calls.resume.length, 1, '★ 会话在（持久化里那条）⇒ 必须走 resume');
  assert.equal(two.ctx.calls.create.length, 0, '★ 在的那条**不许**再 create —— 那会报 already exists');
  assert.equal(two.ctx.calls.resume[0].resumeSessionId, 'room-one', 'resume 用的是同一个 id');
  // 两句话都真的喂给了 agent（不是只回了话）
  const fed = two.ctx.agents.get('room-one').messages;
  assert.equal(fed.length, 1);
  assert.equal(fed[0].content[0].text, '第二句');
  assert.equal(fed[0].role, 'user', '喂进去的是一条 user 消息（照官方那份的 createUserMessage）');
});

test('★ S2·补：同一台里连着两轮 ⇒ 只有第一次开，第二次直接用（不重复 create/resume）', async () => {
  const dir = tmp();
  const h = await harness();
  await h.send({ id: 1, method: 'initialize', params: { cwd: dir, provider: 'deepseek-official', model: 'deepseek-flash' } });
  for (const text of ['一', '二', '三']) {
    await h.send({ id: 2, method: 'session/prompt', params: { sessionId: 'room-one', contentBlocks: [{ type: 'text', text }] } });
  }
  assert.equal(h.ctx.calls.create.length, 1, '★ 三句话只许开一次会话');
  assert.equal(h.ctx.calls.resume.length, 0);
  assert.equal(h.ctx.agents.get('room-one').messages.length, 3, '三句都进了同一条会话');
});

test('🔴 S2·判据可注入：`exists` 说"在" ⇒ resume，说"不在" ⇒ create（两边都咬）', async () => {
  const dir = tmp();
  const mk = async (answer) => {
    const ctx = fakeCtx();
    const output = { write() { return true; } };
    const server = new HupoSdkServer(ctx, { notify() {} }, { exists: async () => answer });
    await server.initialize({ cwd: dir, provider: 'deepseek-official', model: 'deepseek-flash' });
    return { ctx, server };
  };
  const yes = await mk(true);
  await yes.server.prompt({ sessionId: 'r', contentBlocks: [{ type: 'text', text: 'x' }] });
  assert.equal(yes.ctx.calls.resume.length, 1);
  assert.equal(yes.ctx.calls.create.length, 0);

  const no = await mk(false);
  await no.server.prompt({ sessionId: 'r', contentBlocks: [{ type: 'text', text: 'x' }] });
  assert.equal(no.ctx.calls.create.length, 1);
  assert.equal(no.ctx.calls.resume.length, 0);
});

// ── session/resume：只 resume，不 create；cwd 对不上不硬来 ────────

test('🔴 S2·resume 那条显式口：不在 ⇒ **如实报"这条会话不在"**（不许顺手建一条）', async () => {
  const dir = tmp();
  const h = await harness();
  await h.send({ id: 1, method: 'initialize', params: { cwd: dir, provider: 'deepseek-official', model: 'deepseek-flash' } });
  await h.send({ id: 2, method: 'session/resume', params: { sessionId: 'probe-room-one', cwd: dir } });
  const res = frameWithId(h.frames(), 2);
  assert.ok(res?.error, '★ 不在的会话必须回错误帧（真机读数要的就是这句话）');
  assert.match(res.error.message, /这条会话不在：probe-room-one/u);
  assert.equal(h.ctx.calls.create.length, 0, '★ resume 那条路**永远不许** create');
  assert.equal(h.ctx.calls.resume.length, 0);
});

test('🔴 S2·cwd 与持久化里那条不一致 ⇒ 如实报错，**不硬来**', async () => {
  const dirA = tmp();
  const dirB = tmp();
  const persisted = new Map([['room-x', { cwd: dirA }]]);
  const h = await harness({ persisted });
  await h.send({ id: 1, method: 'initialize', params: { cwd: dirB, provider: 'deepseek-official', model: 'deepseek-flash' } });
  await h.send({ id: 2, method: 'session/resume', params: { sessionId: 'room-x', cwd: dirB } });
  const res = frameWithId(h.frames(), 2);
  assert.ok(res?.error, '★ cwd 对不上必须报错');
  assert.match(res.error.message, /对不上/u);
  assert.equal(h.ctx.calls.resume.length, 0, '★ 校验在 resume **之前** ⇒ 一个字节都没动');
});

// ── S3：两个 scope 两个 id，不许串 ──────────────────────────────

test('🔴 S3：两个不同的 scope ⇒ 两个不同的会话 id（而且映射里各占一行）', () => {
  const dir = tmp();
  const file = nodePath.join(dir, DSH_SESSIONS_FILE);
  const cfg = { sessionMapPath: file };
  const a = dshSessionIdFor({ agentKey: 'u1/main', cfg });
  const b = dshSessionIdFor({ agentKey: 'u1/aoshu-bank', cfg });
  assert.notEqual(a, b, '★ 两间不许共用一个会话');
  assert.equal(a, 'main');
  assert.equal(b, 'aoshu-bank');
  // 同一个 agentKey 再来一次 ⇒ 一模一样（**读的是映射**，不是重算）
  assert.equal(dshSessionIdFor({ agentKey: 'u1/main', cfg }), a);
  assert.deepEqual(readSessions({ file }), { main: 'main', 'aoshu-bank': 'aoshu-bank' });
});

test('🔴 S3·补：难看的 scope 名也不许撞（单射，照 DSH 自己的转义表）', () => {
  assert.notEqual(sessionIdFor('a b'), sessionIdFor('a-b'), '空格与横杠不是同一条会话');
  assert.notEqual(sessionIdFor('a b'), sessionIdFor('a~0020b'), '转义过的不许与原文撞');
  assert.equal(sessionIdFor('a b'), 'a~0020b');
  assert.equal(sessionIdFor('.'), '~002E', '`.` 不许变成相对路径');
  assert.equal(sessionIdFor('..'), '~002E~002E');
  assert.ok(isSessionIdShape(sessionIdFor('中文/名字 带空格')), '转义完必须落在合法形状里');
  // 长名字：截断 + 哈希 ⇒ 两串长的也不许撞
  const long1 = 'x'.repeat(300);
  const long2 = `${'x'.repeat(299)}y`;
  assert.notEqual(sessionIdFor(long1), sessionIdFor(long2), '太长的那两条也要分得开');
  assert.ok(sessionIdFor(long1).length <= 200);
});

test('★ S3·补：空 scope / 不是字符串 ⇒ 抛（不猜一个默认 id）', () => {
  assert.throws(() => sessionIdFor(''), /非空字符串/u);
  assert.throws(() => sessionIdFor(undefined), /非空字符串/u);
  assert.throws(() => sessionIdFor(42), /非空字符串/u);
});

test('★ S1：`<userId>/<scope>` 那把键 ⇒ 取到的一定是**scope 那一半**', () => {
  assert.equal(scopeOfAgentKey('u1/main'), 'main');
  assert.equal(scopeOfAgentKey('u1/aoshu-bank'), 'aoshu-bank');
  assert.equal(scopeOfAgentKey('main'), 'main', '没有 `/` 时整串就是 scope（判据里常这么用）');
});

// ── S5：映射文件：原子写 · 坏掉不猜 · 原文留着 ────────────────────

test('★ S5：写是**先 tmp 再 rename**，而且是 0600', () => {
  const dir = tmp();
  const file = nodePath.join(dir, DSH_SESSIONS_FILE);
  const calls = [];
  const fs = {
    mkdirSync: (...a) => calls.push(['mkdirSync', ...a]),
    writeFileSync: (...a) => { calls.push(['writeFileSync', ...a]); nodeFs.writeFileSync(...a); },
    chmodSync: (...a) => { calls.push(['chmodSync', ...a]); nodeFs.chmodSync(...a); },
    renameSync: (...a) => { calls.push(['renameSync', ...a]); nodeFs.renameSync(...a); },
    readFileSync: (...a) => nodeFs.readFileSync(...a),
  };
  writeSessions({ file, entries: { main: 'main' }, fs });
  const names = calls.map((c) => c[0]);
  assert.deepEqual(names, ['mkdirSync', 'writeFileSync', 'chmodSync', 'renameSync'], '顺序：建目录 → 写 tmp → 定权限 → rename');
  const tmpPath = calls.find((c) => c[0] === 'writeFileSync')[1];
  assert.equal(tmpPath, `${file}.tmp`, '★ 必须写在那份 `.tmp` 上（半截文件不会被读到）');
  assert.equal(calls.find((c) => c[0] === 'writeFileSync')[2], `${JSON.stringify({ main: 'main' }, null, 2)}\n`);
  assert.equal(calls.find((c) => c[0] === 'writeFileSync')[3].mode, 0o600);
  assert.equal(calls.find((c) => c[0] === 'chmodSync')[2], 0o600);
  assert.equal(calls.find((c) => c[0] === 'renameSync')[2], file, 'rename 盖到真文件上');
  // 真落盘的那一份也在、权限也对
  assert.equal(nodeFs.readFileSync(file, 'utf8'), `${JSON.stringify({ main: 'main' }, null, 2)}\n`);
  assert.equal(nodeFs.statSync(file).mode & 0o777, 0o600);
});

test('🔴 S5：映射坏掉 ⇒ **抛**，而且**一个字节都不改**（不猜、不盖）', () => {
  const dir = tmp();
  const file = nodePath.join(dir, DSH_SESSIONS_FILE);
  const broken = '{ "main": "main",, }';
  nodeFs.writeFileSync(file, broken, { mode: 0o600 });
  const before = nodeFs.readFileSync(file, 'utf8');
  const writes = [];
  const fs = {
    readFileSync: (...a) => nodeFs.readFileSync(...a),
    writeFileSync: (...a) => writes.push(a),
    renameSync: (...a) => writes.push(a),
    mkdirSync: () => {},
    chmodSync: () => {},
  };
  assert.throws(() => readSessions({ file, fs }), /不是一份能读的 JSON/u);
  assert.throws(() => dshSessionIdFor({ agentKey: 'u1/main', cfg: { sessionMapPath: file }, fs }), /不是一份能读的 JSON/u);
  assert.equal(writes.length, 0, '★ 坏内容**不许被盖掉**（一个写调用都不许有）');
  assert.equal(nodeFs.readFileSync(file, 'utf8'), before, '★ 原文一个字都没变');
});

test('🔴 S5·补：形状不对 / 值不是字符串 ⇒ 也抛（三种坏法都咬）', () => {
  const dir = tmp();
  const file = nodePath.join(dir, DSH_SESSIONS_FILE);
  const cases = [
    ['["main"]', /形状不对/u],
    ['"main"', /形状不对/u],
    ['{"main": 42}', /不是非空字符串/u],
    ['{"main": ""}', /不是非空字符串/u],
  ];
  for (const [body, re] of cases) {
    nodeFs.writeFileSync(file, body);
    assert.throws(() => readSessions({ file }), re, `这份必须被拒：${body}`);
  }
});

test('★ S5·补：没有那份文件 = 第一次用（正常，不是"坏掉"）', () => {
  const dir = tmp();
  assert.deepEqual(readSessions({ file: nodePath.join(dir, '没有这个文件.json') }), {});
  assert.deepEqual(readSessions({ file: null }), {});
});

test('🔴 S5·补：映射里两间指同一个 id ⇒ 抛（那会把两间的话并成一条对话）', () => {
  const dir = tmp();
  const file = nodePath.join(dir, DSH_SESSIONS_FILE);
  writeSessions({ file, entries: { 'aoshu-bank': 'main' } });
  assert.throws(
    () => dshSessionIdFor({ agentKey: 'u1/main', cfg: { sessionMapPath: file } }),
    /已经占着会话 id/u,
  );
});

test('★ S5·补：映射里钉住的那个 id **优先于**按名字算出来的（父 agent 那一手要用它）', () => {
  const dir = tmp();
  const file = nodePath.join(dir, DSH_SESSIONS_FILE);
  writeSessions({ file, entries: { main: 'main.a1b2c3.4' } });
  assert.equal(
    dshSessionIdFor({ agentKey: 'u1/main', cfg: { sessionMapPath: file } }),
    'main.a1b2c3.4',
    '★ 映射里钉的是什么就用什么 —— 这条就是"把旧那条当正本"的落点',
  );
  assert.deepEqual(readSessions({ file }), { main: 'main.a1b2c3.4' }, '用已有的那一份，不许覆盖');
});

test('★ S5·补：没有落点（手搭的 cfg）⇒ 按 scope 名算，**不写盘**', () => {
  assert.equal(mappingPathFor({}), null);
  const dir = tmp();
  assert.equal(mappingPathFor({ dataDir: dir }), nodePath.join(dir, DSH_SESSIONS_FILE));
  assert.equal(dshSessionIdFor({ agentKey: 'u1/main', cfg: {} }), 'main');
});

test('🔴 S5·补：`preflight` 在**开机**就把坏掉的映射拦下来（不让它拖到用户等着答话那一刻）', async () => {
  const { preflight } = await import('../src/config.js');
  const dir = tmp();
  const file = nodePath.join(dir, DSH_SESSIONS_FILE);
  const cfg = {
    agentCwd: dir,
    personaPath: null, // 这一条判据不管人格/能力层（它们各有自己的判据）
    capabilitiesPath: null,
    sdkServerPatchPath: null,
    sdkServerPath: null,
    ledgerServerPath: null,
    dshHome: dir,
    sessionMapPath: file,
    turnDeadlineMs: 1000,
    recap: { maxEntries: 1, maxChars: 1, maxEntryChars: 1 },
  };
  // ① 没有那份文件 / 是一份好的 ⇒ 不因为它报错
  assert.ok(!preflight(cfg).problems.some((p) => /会话映射读不了/u.test(p)));
  writeSessions({ file, entries: { main: 'main' } });
  assert.ok(!preflight(cfg).problems.some((p) => /会话映射读不了/u.test(p)));
  // ② 坏掉 ⇒ 开机就红
  nodeFs.writeFileSync(file, '{ "main": ,, }');
  const problems = preflight(cfg).problems.filter((p) => /会话映射读不了/u.test(p));
  assert.equal(problems.length, 1, '★ 坏映射必须在开机时说，不是等到某一轮说不出话');
  assert.match(problems[0], /不是一份能读的 JSON/u);
});

// ── S4：那一层 patch 里，官方那个**真的被关了** ──────────────────

test('🔴 S4：`hupo-sdk-server.yml` 必须①关掉官方那个 ②挂上我们那份', () => {
  const ymlRaw = nodeFs.readFileSync(nodePath.join(CORE, 'hupo-sdk-server.yml'), 'utf8');
  // ⚠️ 断言只看**真条目**那一部分（注释里会引用那些错的写法当反面教材）
  const yml = ymlRaw.split('\n').filter((l) => !/^\s*#/u.test(l)).join('\n');
  // ① 官方那条 + disabled: true（**同一个条目里**，不许只在注释里说）
  const official = yml.match(/- id: sdk-jsonrpc-server\n([\s\S]*?)(?=\n- |\n- insert:)/u);
  assert.ok(official, '★ 必须点名 `sdk-jsonrpc-server`（两个 server 抢 stdin，不关就抢帧）');
  assert.match(official[1], /^\s*disabled: true\s*$/mu, '★ 官方那一条必须是 `disabled: true`');
  // ② insert 我们那份
  assert.match(yml, /- insert:/u, '★ insert 那一层必须还在（形状不许写成 `- id: <新 id>`）');
  assert.match(yml, /id: hupo-sdk-server/u);
  // 🔴 插件本体按**相对这份 patch**写（别写绝对路径：本机与盒里是两个 checkout）。
  //    DSH 那条规矩见 `dsh-app-boot` 的 `anchorInsertedPluginNames()`。
  assert.match(yml, /name: \.\/src\/sdk-server-hupo\.mjs\s*$/mu);
  // 🔴 也**不许**写成 `!!js process.env.HUPO_SDK_SERVER`：loader 只对 `config` 做
  //    `!!js` 求值，`name` 会留一个对象 ⇒ 真机当场
  //    `name.startsWith is not a function`（读数见 patch 顶上那段）。
  assert.doesNotMatch(yml, /name: !!js/u, '★ `name` 不能走 `!!js`（loader 不求值它）');
  assert.match(yml, /inject:\n(\s+)- sdkAppStartup\n\s+- loader/u);
  assert.match(yml, /maxTokensAsSuccess: true/u);

  // ★ 那条相对路径**指的就是** `preflight` 看着的那个文件（两处不许漂）
  const rel = yml.match(/name: (\.\/src\/sdk-server-hupo\.mjs)\s*$/mu)[1];
  assert.equal(
    nodePath.resolve(CORE, rel),
    nodePath.resolve(CORE, 'src/sdk-server-hupo.mjs'),
    '★ patch 里那条相对路径（按 patch 所在目录锚）必须落在插件本体上',
  );
});

// ── S6：那一层 patch 只有**一处出处**（与开发者入口同源）────────

test('🔴 S6：`agentPatchArgs()` 里含 SDK server 那一层，而且开发者入口跟着一起拿到', () => {
  const cfg = {
    // ⚠️ **两条路径**：`sdkServerPatchPath` 是那份 patch（走 `--patch`），
    //    `sdkServerPath` 是插件本体（走 env 的 `HUPO_SDK_SERVER`）——
    //    合成一个就会把 `.mjs` 当 patch 挂上去（实测会直接起不来）。
    sdkServerPatchPath: '/repo/hupo-sdk-server.yml',
    sdkServerPath: '/repo/src/sdk-server-hupo.mjs',
    personaPath: '/repo/hupo-persona.yml',
    capabilitiesPath: '/repo/hupo-capabilities.yml',
    modelPatchPath: '/repo/hupo-model-proxy.yml',
  };
  const patches = (args) => args.filter((_a, i, all) => all[i - 1] === '--patch');
  assert.deepEqual(
    patches(agentPatchArgs(cfg)),
    [cfg.sdkServerPatchPath, cfg.personaPath, cfg.capabilitiesPath, cfg.modelPatchPath],
  );
  assert.ok(
    !patches(agentPatchArgs(cfg)).includes(cfg.sdkServerPath),
    '★ 插件本体（`.mjs`）**不许**当 patch 挂上去 —— 它是给 `HUPO_SDK_SERVER` 的',
  );
  assert.deepEqual(patches(agentArgs(cfg)), patches(agentPatchArgs(cfg)), 'agentArgs 不许自己再拼一份');
  // ★ 开发者入口那台**同一处出处**（契约 109 D7′）：
  const dev = devWebArgs({ ...cfg, agentProfile: 'sdk' });
  assert.deepEqual(patches(dev), patches(agentPatchArgs(cfg)), '★ devWebArgs 必须与 agentPatchArgs 同源');
  assert.equal(dev.filter((a) => a === cfg.sdkServerPatchPath).length, 1, '★ 只许出现一次（两处拼就会漂）');
  // 缺了这一层（判据里手搭的 cfg）⇒ 不挂、也不许编一个路径出来
  assert.deepEqual(patches(agentPatchArgs({ personaPath: 'p' })), ['p']);
  // 源码里那条路**只有一处**（多了就是第二个出处）
  const runtimeSrc = nodeFs.readFileSync(nodePath.join(CORE, 'src/agent-runtime.js'), 'utf8');
  assert.equal(
    (runtimeSrc.match(/'--patch', cfg\.sdkServerPatchPath/gu) ?? []).length,
    1,
    '★ `--patch` 只有一处出处（`agentPatchArgs`）',
  );
  assert.doesNotMatch(runtimeSrc, /HUPO_SDK_SERVER/u, '★ 那条 env 已经去掉（插件本体走 patch 里的相对路径）');
  const devSrc = nodeFs.readFileSync(nodePath.join(CORE, 'src/dev-mode.js'), 'utf8');
  assert.ok(!devSrc.includes('hupo-sdk-server.yml'), '★ 开发者入口不许自己再写一遍那份 patch 的路径');
});

test('🔴 S6·补：盒里那份入口把 patch 那条路径指到产品层（cwd 是 `/app`，不是 `/app/code`）', () => {
  // ⚠️ 这一行少了，盒里的 `preflight` 就会把整个服务拦下来
  //    （`hupo-sdk-server.yml` 默认按 `cwd` 算 ⇒ 盒里会算成 `/app/hupo-sdk-server.yml`，
  //     而那一份**不在**产品层里）。这是"本机跑得好好的、盒里起不来"的典型形状。
  //
  // ⚠️ **插件本体那一条不用指**：那份 patch 里写的是**相对它自己**的
  //    `./src/sdk-server-hupo.mjs`（DSH 按 patch 文件所在目录锚）。
  const src = nodeFs.readFileSync(nodePath.join(CORE, 'src/entry.mjs'), 'utf8');
  assert.match(
    src,
    /process\.env\.HUPO_SDK_PATCH \?\?= inCode\('hupo-sdk-server\.yml'\)/u,
    '★ 盒里那份 entry 必须把 patch 那条路径指到产品层',
  );
  // 🔴 原来这里有一条 `HUPO_SDK_SERVER`（env 递插件本体）—— **实测那条路走不通**
  //    （loader 不对 `name` 求值 `!!js`）⇒ 现在**不许**再有那条 env（死线不许留）。
  assert.doesNotMatch(src, /HUPO_SDK_SERVER/u, '★ 插件本体不走 env（patch 用相对路径）');
});

test('★ S6·补：产品层那份名单带上新的 patch（盒里少了它 agent 起不来）', () => {
  const sh = nodeFs.readFileSync(nodePath.resolve(CORE, '..', '..', '..', 'scripts/build-tenant-code.sh'), 'utf8');
  const line = sh.split('\n').find((l) => l.startsWith('INPUTS='));
  assert.ok(line, '找不到产品层那份名单');
  assert.ok(line.includes('hupo-sdk-server.yml'), '★ 产品层名单里要有那一层 patch');
  assert.ok(line.includes('src'), '`src/` 是整目录搬的 ⇒ 插件本体跟着走');
});

// ── 帧那一层：形状 · 拒法 · maxTokensAsSuccess ──────────────────

test('★ 认不出的方法 / 不合法的 id ⇒ 安静拒（错误帧）＋ 如实说，不许猜', async () => {
  const dir = tmp();
  const h = await harness();
  await h.send({ id: 1, method: 'initialize', params: { cwd: dir, provider: 'deepseek-official', model: 'deepseek-flash' } });
  await h.send({ id: 2, method: 'session/frobnicate', params: {} });
  await h.send({ id: 3, method: 'session/prompt', params: { sessionId: '../跑出去', contentBlocks: [{ type: 'text', text: 'x' }] } });
  await h.send({ id: 4, method: 'session/prompt', params: { sessionId: '', contentBlocks: [{ type: 'text', text: 'x' }] } });
  const f2 = frameWithId(h.frames(), 2);
  const f3 = frameWithId(h.frames(), 3);
  const f4 = frameWithId(h.frames(), 4);
  assert.match(f2?.error?.message ?? '', /unknown DeepSeek Harness SDK runtime method/u);
  assert.match(f3?.error?.message ?? '', /形状不认/u);
  assert.match(f4?.error?.message ?? '', /非空字符串/u);
  assert.equal(h.ctx.calls.create.length, 0, '★ 认不出的一律不许落地成会话');
  // 协议帧仍然活着（拒了之后还能说话）
  await h.send({ id: 5, method: 'session/prompt', params: { sessionId: 'ok-one', contentBlocks: [{ type: 'text', text: '你好' }] } });
  assert.ok(frameWithId(h.frames(), 5)?.result?.messageId, '拒一帧不许把 server 弄死');
});

test('★ 未 initialize 就 prompt ⇒ 如实拒（照官方那句）', async () => {
  const ctx = fakeCtx();
  const server = new HupoSdkServer(ctx, { notify() {} });
  await assert.rejects(
    () => server.prompt({ sessionId: 'x', contentBlocks: [{ type: 'text', text: 'y' }] }),
    /not initialized/u,
  );
});

test('★ `maxTokensAsSuccess`：只有 completed / max-tokens 算 ok（照官方 successStatus）', () => {
  assert.equal(successStatus('completed'), 'ok');
  assert.equal(successStatus('max-tokens', { maxTokensAsSuccess: true }), 'ok');
  assert.equal(successStatus('max-tokens', { maxTokensAsSuccess: false }), 'error');
  assert.equal(successStatus('max-tokens', {}), 'error');
  assert.equal(successStatus('error'), 'error');
  assert.equal(successStatus('aborted'), 'error');
});

test('★ 那四条通知的形状 = 官方那一份（`session.event` · `session.status` · `subagent.*`）', () => {
  const frames = [];
  const transport = { notify: (method, params) => frames.push({ method, params }) };
  const handlers = {};
  const ctx = fakeCtx();
  ctx.on = (event, handler) => {
    handlers[event] = handler;
    return () => {};
  };
  const server = new HupoSdkServer(ctx, transport, { maxTokensAsSuccess: true });
  assert.ok(server);
  // `session/event`
  handlers['session/event']({ id: 'room-one' }, { type: 'assistant/message', seq: 1 });
  assert.deepEqual(frames.at(-1), {
    method: 'session.event',
    params: { sessionId: 'room-one', event: { type: 'assistant/message', seq: 1 } },
  });
  // `agent/status`
  handlers['agent/status']({ agent: { session: { id: 'room-one' } }, status: 'running' });
  assert.deepEqual(frames.at(-1), { method: 'session.status', params: { sessionId: 'room-one', status: 'running' } });
  // `session/created`：没有 parentSession ⇒ **不发**（照官方）
  handlers['session/created']({ id: 'room-one', header: {} });
  assert.equal(frames.length, 2, '父会话没有的，不是子会话 ⇒ 不转发');
  handlers['session/created']({ id: 'kid', header: { parentSession: 'room-one' } });
  assert.deepEqual(frames.at(-1), {
    method: 'subagent.started',
    params: { parentSessionId: 'room-one', childSessionId: 'kid' },
  });
  // `subagent/end` ⇒ 靠 session/created 记下的父子关系
  handlers['subagent/end']({ id: 'kid', local: true, provider: 'in-process', stopReason: 'max-tokens', lastAssistantMessage: '半句' });
  assert.deepEqual(frames.at(-1), {
    method: 'subagent.finished',
    params: {
      provider: 'in-process',
      agentId: 'kid',
      parentSessionId: 'room-one',
      childSessionId: 'kid',
      status: 'ok',
      stopReason: 'max-tokens',
      lastAssistantMessage: '半句',
    },
  });
  // 认不出父会话的 ⇒ 不发（宁可少一条，也不许编一个父会话 id）
  const before = frames.length;
  handlers['subagent/end']({ id: '野孩子', local: true, provider: 'x', stopReason: 'completed' });
  assert.equal(frames.length, before, '★ 认不出父会话就不转发（不许猜）');
  // 非 local 的一律不发（照官方 `if (!info.local) return`）
  handlers['subagent/end']({ id: 'kid', local: false, provider: 'x', stopReason: 'completed' });
  assert.equal(frames.length, before);
});

test('🔴 插件的形状：`name` ＋ inject 里**必须有 `sessions`**（真机读数咬出来的）', () => {
  assert.equal(pluginName, 'hupo-sdk-server');
  assert.ok(pluginInject.includes('agents'), '会话/agent 那两条服务要 inject');
  // 🔴 真机（2026-09-26，临时 DSH_HOME）：只 inject `agents` 时
  //    `initialize` 成功、然后**每一条 `session/prompt` / `session/resume`** 都回
  //    `cannot get property "sessions" without inject`（`ctx.sessions` 是服务访问器）。
  //    官方那支没这个问题 —— 它只用 `ctx.agents`，我们比它多用一个。
  assert.ok(pluginInject.includes('sessions'), '★ 少 `sessions` ⇒ 每条 prompt/resume 都失败');
});

test('★ 传输层：坏行忽略、请求回帧、通知不外抛', async () => {
  const input = new PassThrough();
  const writes = [];
  const output = { write(s, cb) { writes.push(String(s)); cb?.(); return true; } };
  const transport = new LineTransport(input, output);
  const notifications = [];
  transport.onRequest(async (method) => ({ ok: method }));
  transport.onNotification((method, params) => notifications.push([method, params]));
  transport.start();
  input.write('这不是 JSON\n');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { a: 1 } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} })}\n`);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(notifications, [['note', { a: 1 }]]);
  const frames = writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(frames[0], { jsonrpc: '2.0', id: 7, result: { ok: 'ping' } });
  assert.deepEqual(transport.buffer, '', '坏行被丢掉之后缓冲区不该卡住后半截');
  transport.close();
});

test('🔴 T1：`assertSessionId` 收 **DSH 自己那种 id**（带 `/`），只拒 空/超长/控制字符/`..` 段', () => {
  // ── 为什么这条是这一批的头号判据 ────────────────────────────────
  // 2026-09-26 真机（产品层发布之后）：映射里钉的是 **DSH 自己的 id**
  // `owner/aoshu-bank.muh709vsibnh.1`（**带一个 `/`**），而上一版只收 `[A-Za-z0-9._~-]`
  // ⇒ 服务端如实回 `sessionId 形状不认…` ⇒ **任何一句话都没有答复** ⇒ 回滚。
  // 事实：**注册表 / 会话头里的 `id` 是原始形式**，目录名才是转义形式（`/` ⇒ `~002F`）。
  //
  // ⚠️ 一处出处：插件那一侧 re-export 的**必须就是** `session-id.mjs` 里那个函数。
  assert.equal(pluginAssertSessionId, assertSessionId, '★ 形状函数只有一处出处（不许两套）');
  assert.equal(pluginIsSessionIdShape, isSessionIdShape, '★ 形状函数只有一处出处（不许两套）');

  const good = [
    'owner/aoshu-bank.muh709vsibnh.1', // ★ 真机那条原话
    'owner/main.muh709vsibnh.1',
    'main',
    'aoshu-bank',
    'main.a1b2.3', // 旧格式（迁移钉正本时）也要能过
    'a b', // 空格不是控制字符：DSH 自己会转义它（`a~0020b`）⇒ 不该由我们拒
    'owner/a~002Fb', // 我们自己 `sessionIdFor` 转义出来的形状照旧要过
  ];
  for (const id of good) {
    assert.equal(assertSessionId(id), id, `这个必须收：${JSON.stringify(id)}`);
    assert.equal(isSessionIdShape(id), true, `形状函数也要收：${JSON.stringify(id)}`);
  }

  const bad = [
    ['', '空串'],
    ['x'.repeat(SESSION_ID_MAX + 1), '超长'],
    [`${'x'.repeat(SESSION_ID_MAX)}y`, '超长（边界 +1）'],
    ['a\u0000b', 'NUL'],
    ['a\u0007b', '控制字符'],
    ['a\u007Fb', 'DEL'],
    ['..', '`..` 整段'],
    ['../跑出去', '`..` 段（路径穿越的形状）'],
    ['a/../b', '中间的 `..` 段'],
    ['owner/..', '尾部的 `..` 段'],
    ['.', '`.` 整段'],
    [42, '不是字符串'],
    [null, 'null'],
  ];
  for (const [id, why] of bad) {
    assert.throws(() => assertSessionId(id), /sessionId|形状/u, `这个必须被拒（${why}）：${JSON.stringify(id)}`);
    assert.equal(isSessionIdShape(id), false, `形状函数也要说不（${why}）：${JSON.stringify(id)}`);
  }
  // ★ 边界：正好 `SESSION_ID_MAX` 个字符（合法）—— `..` 那几个字不许误伤。
  assert.equal(assertSessionId('x'.repeat(SESSION_ID_MAX)), 'x'.repeat(SESSION_ID_MAX));
  // ★ 反例的正身：`a.b` 里的 `.` **不是** `.` 整段，不许误拒。
  assert.equal(assertSessionId('a.b'), 'a.b');
  assert.equal(assertSessionId('owner/main.1'), 'owner/main.1');
});

test('🔴 T2：映射里钉的是 **DSH 自己的 id**（`owner/…`）⇒ `readSessions` 与 `preflight` 都收', async () => {
  const { preflight } = await import('../src/config.js');
  const dir = tmp();
  const file = nodePath.join(dir, DSH_SESSIONS_FILE);
  const pinned = 'owner/aoshu-bank.muh709vsibnh.1';
  writeSessions({ file, entries: { 'aoshu-bank': pinned } });

  // ① `readSessions` **原样**读出来（不许把映射里的值再转义一次 —— 那会去找一条不存在的会话）
  assert.deepEqual(readSessions({ file }), { 'aoshu-bank': pinned });
  // ② `dshSessionIdFor` 用的就是映射里那个**原值**
  assert.equal(
    dshSessionIdFor({ agentKey: 'u1/aoshu-bank', cfg: { sessionMapPath: file } }),
    pinned,
    '★ 映射里钉的是什么就用什么（**别转义**）',
  );

  const cfg = {
    agentCwd: dir,
    personaPath: null,
    capabilitiesPath: null,
    sdkServerPatchPath: null,
    sdkServerPath: null,
    ledgerServerPath: null,
    dshHome: dir,
    sessionMapPath: file,
    turnDeadlineMs: 1000,
    recap: { maxEntries: 1, maxChars: 1, maxEntryChars: 1 },
  };
  // ③ `preflight` 不因为它报错（真机那条 `owner/…` 必须过）
  assert.ok(
    !preflight(cfg).problems.some((p) => /会话映射|DSH 收不了/u.test(p)),
    '★ 真机那条 DSH 原生 id 必须开机过',
  );

  // ④ 反例：形状坏的钉值 ⇒ `readSessions` 抛、`preflight` 开机就红
  writeSessions({ file, entries: { 'aoshu-bank': '../跑出去' } });
  assert.throws(() => readSessions({ file }), /DSH 收不了/u, '★ 形状坏的钉值必须当场抛');
  assert.throws(
    () => dshSessionIdFor({ agentKey: 'u1/aoshu-bank', cfg: { sessionMapPath: file } }),
    /DSH 收不了/u,
    '★ 运行时那条路也不许把坏 id 发出去',
  );
  const problems = preflight(cfg).problems.filter((p) => /会话映射读不了/u.test(p));
  assert.equal(problems.length, 1, '★ 坏 id 必须在**开机**就拦（不许拖到某一轮说不出话）');
  assert.match(problems[0], /DSH 收不了/u);
});
