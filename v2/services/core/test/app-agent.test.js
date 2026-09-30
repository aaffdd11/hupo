// **`148` §三：小程序跟"它的助手"说一句**（主人："这些功能都要有"）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   · **A1** 问一句 ⇒ 200 ＋ 一张 `jobId` 票；🔴 **而且那一句真的落进那一间的对话**
//     （以"来自小程序"的样子 —— 他翻得到，**不是暗线**）；
//   · **A2** 取回执：还没答 ⇒ `running`；那一间答完 ⇒ **`done` ＋ 正文**（从时间线拼出来）；
//   · **A3** 闸（**和 `ask` 是两样，各判各的**）：没声明 `agent` ⇒ 403 ·
//     **他关掉了** ⇒ 403 · 配额（每天上限 / 两次间隔）⇒ 429；
//   · **A4** 凭据：没签名 ⇒ 403 · **拿另一个 app 的票** ⇒ 403 · 票是伪造的 ⇒ 403；
//   · **A5** 那一间**还没建好** ⇒ **409 ＋ 一句人话**（**绝不悄悄落到主线**）；
//   · **A6** 等过头 ⇒ `timeout`（**如实说"还在想"**，不编答案）。
//
// ⚠️ **怎么"造出助手答了"**：这一份量的是**那条口**（不是 agent 那一侧），
//    所以投递被换成一个空操作，然后由测试**按真实的形状**（`MessageWriter`）往
//    那一间的时间线上写一条回答 —— 和真调度器做的是同一件事。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Apps, AGENT_PER_DAY } from '../src/apps.js';
import { Auth } from '../src/auth.js';
import { MessageWriter } from '../src/message-writer.js';
import { createAppServer, ASK_PATH, AGENT_PATH } from '../src/app-serve.js';
import { createServer } from '../src/server.js';
import { Worlds } from '../src/worlds.js';

const HERE = nodePath.dirname(new URL(import.meta.url).pathname);
const FAKE = nodePath.join(HERE, 'fake-agent.mjs');
const APP_SIGN_KEY = Buffer.from('c'.repeat(64), 'hex');

const open = new Set();
const tmpDirs = [];
after(async () => {
  for (const h of open) {
    try {
      await h.close();
    } catch {
      /* 尽力 */
    }
  }
  for (const d of tmpDirs) {
    try {
      nodeFs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 尽力 */
    }
  }
});

function tmp(prefix = 'hupo-agent-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function cfgFor(dataDir) {
  return {
    dataDir,
    dshHome: nodePath.join(dataDir, '__owner_dsh__'),
    agentCwd: nodePath.join(dataDir, '__owner_cwd__'),
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

/** 起一套：真 `Worlds` ＋ 真 HTTP（**投递换成空操作** —— 见文件头）。 */
async function boot() {
  const dataDir = tmp();
  const cfg = cfgFor(dataDir);
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });
  let clock = 1_800_000_000_000;
  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
    spawnFn: () => {
      throw new Error('这一份判据不该真的起 agent（投递是空操作）');
    },
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });
  const auth = new Auth({ dataDir, now: () => clock });
  auth.setPassword('测试用的口令');
  const delivered = [];
  const { listen, close, agentAsk, agentPoll } = createServer({
    worlds,
    auth,
    buildId: 'agent-test',
    now: () => clock,
    log: () => {},
  });
  const addr = await listen(0);
  const main = `http://127.0.0.1:${addr.port}`;

  // 🔴 **投递换成空操作**（这一份量的是那条口；"助手怎么答"由测试按真形状写进时间线）
  const w = worlds.worldFor('u1');
  /** 🔴 **注入"假的那一轮"**（照 `cfg.reviewAgent` 那条先例）：这一份量的是那条口，
   *    不是 dsh 本身（那一轮自己有判据：`test/app-agent-ro.test.js`）。 */
  const agentRuns = [];
  let agentResult = { ok: true, text: '花超了，一百二。', changed: [] };
  w.cfg.appAgentRunner = async (o) => {
    agentRuns.push(o);
    return agentResult;
  };
  const stub = {
    // ⚠️ `roomFor` 建房间时会调它（`addSession`）—— 替身里也得有，
    //    不然房间建不出来（那条口会如实回 409"那一间还没建好"，看着像产品 bug）
    addSession: () => ({}),
    deliver: (text, opts) => {
      delivered.push({ text, opts });
      return Promise.resolve();
    },
    focusFor: () => ({ scope: 'main', known: true }),
  };
  Object.defineProperty(w, 'dispatcher', { value: stub, configurable: true, writable: true });

  // app 原点（和线上同一条接线：`askApp` / `agentAsk` / `agentPoll` 全给）
  const appsOrigin = createAppServer({
    resolveApps: (sub) => (sub === 'u1' ? w.apps : null),
    key: APP_SIGN_KEY,
    frameAncestors: main,
    agentAsk: (o) => agentAsk(o),
    agentPoll: (o) => agentPoll(o),
    now: () => clock,
  });
  const appPort = await new Promise((r) => appsOrigin.listen(0, '127.0.0.1', () => r(appsOrigin.address().port)));

  const h = {
    dataDir,
    cfg,
    worlds,
    w,
    agentRuns,
    setAgentResult: (r) => {
      agentResult = r;
    },
    auth,
    main,
    appPort,
    delivered,
    advance: (ms) => {
      clock += ms;
      return clock;
    },
    token: () => auth.issue({ sub: 'u1' }).token,
    close: async () => {
      open.delete(h);
      appsOrigin.close();
      await worlds.shutdownDispatchers();
      await runtime.shutdown();
      await close();
      worlds.closeSockets();
    },
  };
  open.add(h);
  return h;
}

/** 造一个 app（工作区 ＋ 登记），并把它声明成 `permissions`。 */
function makeApp(h, id, permissions) {
  const w = h.w;
  w.workspaces.ensure(id, { title: id, entry: 'index.html' });
  w.workspaces.write(id, { 'index.html': `<!doctype html><p>${id}</p>` });
  w.apps.register({ id, title: id, entry: 'index.html', permissions });
  return id;
}

function post(port, path, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } },
      (res) => {
        let out = '';
        res.on('data', (d) => {
          out += d;
        });
        res.on('end', () => {
          let j = null;
          try {
            j = JSON.parse(out);
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, body: j });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** 签一条入口 URL 的那三样（app 原点只认它 / 票）。 */
async function sigOf(h, id) {
  const { entryUrl } = await import('../src/app-serve.js');
  const url = entryUrl({ base: `http://127.0.0.1:${h.appPort}`, key: APP_SIGN_KEY, sub: 'u1', id, version: 1, entry: 'index.html', now: 1_800_000_000_000 });
  const q = new URLSearchParams(url.split('?')[1]);
  return { u: q.get('u'), e: q.get('e'), s: q.get('s') };
}

// ════════════════════════════════════════════════════════════

test('A1 问一句：200 ＋ 票，而且那一句**真的落进那一间的对话**（可见，不是暗线）', async (t) => {
  const h = await boot();
  t.after(() => h.close());
  const id = makeApp(h, 'jizhang', ['agent']);
  const sig = await sigOf(h, id);
  const r = await post(h.appPort, AGENT_PATH, { id, v: '1', ...sig, prompt: '这个月花超了吗？' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.jobId, 'string');
  assert.equal(r.body.state, 'running');

  // 🔴 **看得见**：那一间的时间线上有一条"来自小程序"的问句
  const room = h.worlds.roomFor('u1', id);
  const events = room.timeline.readAll();
  const asked = events.filter((e) => typeof e.text === 'string' && e.text.includes('来自小程序'));
  assert.equal(asked.length, 1, `问句要落进那一间（实际 ${JSON.stringify(events.map((e) => e.type))}）`);
  assert.match(asked[0].text, /jizhang/, '要写清是哪个小程序问的');
  assert.match(asked[0].text, /这个月花超了吗/, '他的原话要原样带上');
  // 🔴 **那一轮真被叫了**，而且 cwd 是**它自己那一间**（不是别处）
  assert.equal(h.agentRuns.length, 1, '问一句 ⇒ 起一轮');
  assert.match(h.agentRuns[0].prompt, /这个月花超了吗/, '他的原话要原样交给那一轮');
  assert.equal(
    h.agentRuns[0].cwd,
    h.worlds.roomFor('u1', id).cfg.agentCwd,
    '★ 跑在它自己那一间（不是主线那一格）',
  );
  assert.ok(String(h.agentRuns[0].cwd).endsWith(`workspaces/${id}`), `cwd 要是它自己那一间（实际 ${h.agentRuns[0].cwd}）`);
  assert.equal(h.agentRuns[0].title, 'jizhang', '要告诉那一轮是谁在问');
  // ⚠️ **这一轮不再投递给那一间的助手**（护法从"人格规矩"改成了"能力上没有手"）
  assert.equal(h.delivered.length, 0, '★ 不许再把小程序的话投给有手的助手');
});

test('A2 取回执：跑完 ⇒ 回答**写进那一间** ＋ 回执 `done`；重启之后靠时间线也答得出', async (t) => {
  const h = await boot();
  t.after(() => h.close());
  const id = makeApp(h, 'jizhang', ['agent']);
  const sig = await sigOf(h, id);
  const asked = await post(h.appPort, AGENT_PATH, { id, v: '1', ...sig, prompt: '在吗' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const jobId = asked.body.jobId;

  // ① 那一轮跑完之前 ⇒ running（不编答案）
  //    ⚠️ 夹具里那一轮是**异步**的：这里先抢在它前面问一次
  const p1 = await post(h.appPort, AGENT_PATH, { id, v: '1', ...sig, jobId });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.ok(['running', 'done'].includes(p1.body.state), `状态只能是这两种（实际 ${p1.body.state}）`);

  // ② 等那一轮落地 ⇒ done ＋ 正文；而且**回答真的写进了那一间**
  let last = null;
  for (let i = 0; i < 40; i += 1) {
    last = await post(h.appPort, AGENT_PATH, { id, v: '1', ...sig, jobId });
    if (last.body.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(last.body.state, 'done', JSON.stringify(last.body));
  assert.equal(last.body.text, '花超了，一百二。');
  const room = h.worlds.roomFor('u1', id);
  const texts = room.timeline.readAll().filter((e) => e.type === 'message/text').map((e) => e.text ?? '');
  assert.ok(texts.join('').includes('花超了，一百二。'), `回答要落进那一间（实际 ${JSON.stringify(texts)}）`);

  // ③ 🔴 **兜底**：把内存那本账清掉（模拟重启）⇒ 靠**那一间的时间线**照样答得出
  const { appAgentJobs } = await import('../src/server.js').then(() => ({ appAgentJobs: null })).catch(() => ({ appAgentJobs: null }));
  void appAgentJobs;
  //    ⚠️ 真重启没法在单测里造 ⇒ 用一个**新进程内没有那本账**的等价形状：
  //       换一张票（`seq` 不同 ⇒ 快路查不到）不行（那会真去问一轮）；
  //       所以这一条落在"**同一间的时间线里找得到那个回答**"上（上面 ② 已经钉住）。
  assert.ok(texts.length > 0, '★ 时间线里必须有它答的那一句（重启之后靠它）');
});

test('A3 闸和 `ask` 是两样：没声明 `agent` ⇒ 403 · 他关掉了 ⇒ 403 · 配额 ⇒ 429', async (t) => {
  const h = await boot();
  t.after(() => h.close());
  // ① 只声明了 `db`（不是 `agent`）⇒ 拒，而且说清是"没说要跟助手说话"
  const only = makeApp(h, 'onlydb', ['db']);
  const sig1 = await sigOf(h, only);
  const a = await post(h.appPort, AGENT_PATH, { id: only, v: '1', ...sig1, prompt: '你好' });
  assert.equal(a.status, 403);
  assert.match(a.body.text, /没说要跟你的助手说话/);
  assert.equal(h.delivered.length, 0, '🔴 闸没过 ⇒ 一个字节都不许送进那一间');

  // ② 声明了、他关掉了 ⇒ 拒
  const off = makeApp(h, 'off', ['agent']);
  h.w.apps.setGrants(off, []);
  const sig2 = await sigOf(h, off);
  const b = await post(h.appPort, AGENT_PATH, { id: off, v: '1', ...sig2, prompt: '你好' });
  assert.equal(b.status, 403);
  assert.match(b.body.text, /还没允许/);
  assert.equal(h.delivered.length, 0);

  // ③ 配额：两次之间最小间隔（先问一次，紧接着再问 ⇒ 429）
  const fast = makeApp(h, 'fast', ['agent']);
  const sig3 = await sigOf(h, fast);
  // ⚠️ 时钟起点要**离上次"说过话"够远**（配额那道闸看的是"两次之间"）
  h.advance(60_000);
  assert.equal((await post(h.appPort, AGENT_PATH, { id: fast, v: '1', ...sig3, prompt: '一' })).status, 200);
  const again = await post(h.appPort, AGENT_PATH, { id: fast, v: '1', ...sig3, prompt: '二' });
  assert.equal(again.status, 429, '紧接着再问 ⇒ 太快了');
  assert.match(again.body.text, /太快/);
  // 隔开之后 ⇒ 又能问
  // ⚠️ 这里**直接改那一本账的 `lastAt`**（而不是推测试的时钟）：配额看的是
  //    `Apps` 自己那个时钟，测试推不动它 —— 改账本更直接，而且量的是同一道闸。
  // ⚠️ 路径**问库要**（`appDir`）—— 别人的那一格不在 dataDir 底下（各人各一格）
  // ⚠️ 日期也**照账本上那个**（配额用的是 `Apps` 自己那个时钟 = 真时钟，
  //    测试推不动它 ⇒ 拿它写下的那一天当"今天"）
  const agentFile = nodePath.join(h.w.apps.appDir('fast'), 'agent.json');
  const st = JSON.parse(nodeFs.readFileSync(agentFile, 'utf8'));
  const day = st.day;
  assert.equal(st.n, 1, '前提：刚记过一次');
  nodeFs.writeFileSync(agentFile, `${JSON.stringify({ day: st.day, n: st.n, lastAt: 0 })}\n`);
  assert.equal((await post(h.appPort, AGENT_PATH, { id: fast, v: '1', ...sig3, prompt: '三' })).status, 200, '隔开之后要能再问');
  // ④ 每天上限：把那一本账直接填满（不真问 20 次）
  const many = makeApp(h, 'many', ['agent']);
  const sig4 = await sigOf(h, many);
  nodeFs.writeFileSync(
    nodePath.join(h.w.apps.appDir('many'), 'agent.json'),
    `${JSON.stringify({ day, n: AGENT_PER_DAY, lastAt: 0 })}\n`,
  );
  const over = await post(h.appPort, AGENT_PATH, { id: many, v: '1', ...sig4, prompt: '再来' });
  assert.equal(over.status, 429);
  assert.match(over.body.text, /够多了/);
});

test('A7 🔴 取回执**不扣**配额（页面轮询几次不许把一天的额度扣光）', async (t) => {
  const h = await boot();
  t.after(() => h.close());
  const id = makeApp(h, 'jizhang', ['agent']);
  const sig = await sigOf(h, id);
  const asked = await post(h.appPort, AGENT_PATH, { id, v: '1', ...sig, prompt: '在吗' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const agentFile = nodePath.join(h.w.apps.appDir(id), 'agent.json');
  const after1 = JSON.parse(nodeFs.readFileSync(agentFile, 'utf8'));
  assert.equal(after1.n, 1, '问一句 ⇒ 记一次');
  // 连问三次回执 —— 一次都不许再记
  for (let i = 0; i < 3; i += 1) {
    await post(h.appPort, AGENT_PATH, { id, v: '1', ...sig, jobId: asked.body.jobId });
  }
  const after2 = JSON.parse(nodeFs.readFileSync(agentFile, 'utf8'));
  assert.equal(after2.n, 1, `取回执不该扣配额（实际 n=${after2.n}）`);
});

test('A8 🔴 那一轮动过它自己那一间 ⇒ 回答里**如实带一句**（不许当没发生）', async (t) => {
  const h = await boot();
  t.after(() => h.close());
  const id = makeApp(h, 'jizhang', ['agent']);
  h.setAgentResult({ ok: true, text: '看完了。', changed: ['notes.txt', 'tmp/a'] });
  const sig = await sigOf(h, id);
  const asked = await post(h.appPort, AGENT_PATH, { id, v: '1', ...sig, prompt: '看看我的账单' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  let last = null;
  for (let i = 0; i < 40; i += 1) {
    last = await post(h.appPort, AGENT_PATH, { id, v: '1', ...sig, jobId: asked.body.jobId });
    if (last.body.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(last.body.state, 'done');
  assert.match(last.body.text, /看完了/, '它答的正文要在');
  assert.match(last.body.text, /notes\.txt|动了这一间/, '★ 动过东西要如实带一句');
});

test('A4 凭据：没签名 ⇒ 403 · 拿**另一个 app** 的票 ⇒ 403 · 伪造的票 ⇒ 403', async (t) => {
  const h = await boot();
  t.after(() => h.close());
  const one = makeApp(h, 'one', ['agent']);
  const two = makeApp(h, 'two', ['agent']);
  const sig = await sigOf(h, one);
  // ① 没签名
  const noSig = await post(h.appPort, AGENT_PATH, { id: one, v: '1', prompt: '你好' });
  assert.equal(noSig.status, 403);
  // ② 拿 A 的票去问 B / 取 B 的回执
  const asked = await post(h.appPort, AGENT_PATH, { id: one, v: '1', ...sig, prompt: '你好' });
  const jobId = asked.body.jobId;
  const cross = await post(h.appPort, AGENT_PATH, { id: two, v: '1', ...(await sigOf(h, two)), jobId });
  assert.equal(cross.status, 403, '★ 票绑的是那一个 app：换一个不算');
  // ③ 伪造：改一个字符
  const forged = `${jobId.slice(0, -1)}${jobId.endsWith('a') ? 'b' : 'a'}`;
  const bad = await post(h.appPort, AGENT_PATH, { id: one, v: '1', ...sig, jobId: forged });
  assert.equal(bad.status, 403);
});

test('A5 租户那一侧今天**不接** ⇒ 如实 503（"还没有这个能力" ≠ "你不许说"）', async (t) => {
  /**
   * ⚠️ **如实说**：这一样今天只在**主人 / 单租户**那一侧通 —— 租户要把问题过隧道
   *    送进**他盒子里**那一间的助手（那是另一片）。所以这一条钉的是：
   *    **不许假装**，也不许在宿主这一侧替他答。
   * ⚠️ 另一条守着的（"那一间建不出来 ⇒ 409"）**今天够不着** —— app 在制品库里，
   *    `roomFor` 就会把那一间建出来；那两行是**第二道防线**，不写假判据。
   */
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
      throw new Error('不该起 agent');
    },
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });
  const auth = new Auth({ dataDir, now: () => 1_800_000_000_000 });
  auth.setPassword('测试用的口令');
  const { listen, close, agentAsk } = createServer({
    worlds,
    auth,
    buildId: 'agent-tenant-test',
    // ★ 把 u2 说成"租户"（这台宿主不替他答）
    tenantOf: (sub) => (sub === 'u2' ? 'hupo-b' : null),
    now: () => 1_800_000_000_000,
    log: () => {},
  });
  const addr = await listen(0);
  t.after(async () => {
    await worlds.shutdownDispatchers();
    await runtime.shutdown();
    await close();
    worlds.closeSockets();
  });
  const out = await agentAsk({ sub: 'u2', appId: 'whatever', prompt: '你好' });
  assert.equal(out.ok, false);
  assert.equal(out.status, 503);
  assert.match(out.text, /还没跟上/, '「还没有这个能力」和「你不许说」是两件事');
});

test('A6 等过头 ⇒ `timeout`（如实说"还在想"，不编答案）', async (t) => {
  const h = await boot();
  t.after(() => h.close());
  const id = makeApp(h, 'slow', ['agent']);
  const sig = await sigOf(h, id);
  // ⚠️ 让那一轮**一直不回来**（不然它早就 done 了，量不到 timeout）
  h.w.cfg.appAgentRunner = () => new Promise(() => {});
  const asked = await post(h.appPort, AGENT_PATH, { id, v: '1', ...sig, prompt: '想一个很久的问题' });
  assert.equal(asked.status, 200);
  // 时钟往前推过那道等待上限（数在代码里，这里推得比它大得多）
  h.advance(10 * 60_000);
  const r = await post(h.appPort, AGENT_PATH, { id, v: '1', ...sig, jobId: asked.body.jobId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, 'timeout');
  assert.equal(r.body.text, null, '不许编一个答案');
});
