// **派活：主进程说"做一个 X 的 app" ⇒ 先问他一句 ⇒ 他说另开一处 ⇒ 交给一个子进程
// ⇒ 子进程做完把总结扔回主进程**
// （契约 `docs/dev/102-APP-BIRTH-SCOPE.md` ＋ `docs/dev/108-JOB-ASK-FLOW.md`）。
//
// ── 这一份钉什么（P1–P7，每条带反例）──────────────────────────
//   ⚠️ **108 起时序变了**：`job_start` **不再同步建** —— 先问一句，**答了之后才建**。
//      P1–P7 **一条都没删**，只是把"那一间被建出来"那一步改成"他答了【另开一处做】之后"。
//   P1 **派活**：他答了 ⇒ 那一间**被建出来**（工作区目录 ＋ 会话），任务与由来**真交到它手上**；
//   P2 **活算子进程**：`app_create` 那一段在**那一间**，主进程里**没有**那段过程；
//   P3 🔴 **总结扔回主进程**：一条**人话**（做了什么 · 叫什么 · 在哪儿看），
//      用**它自己的名字**（B20：不许依赖宿主的 `whereTitle`），**不许**把全文倒进来；
//   P4 **主进程知道**：回报之后主进程那条会话**查得到**；
//   P5 **简登记**：列得出有哪些小程序／工作区 ＋ 各自最后一条总结，**且能从日志重建**；
//   P6 **反例的正身**：没派活的一轮**一个字都不动**；派活失败 ⇒ **如实说**、活留在主进程；
//   P7 **不破 P-l**：仍然**一条日志、一套号**。
//
// ── ★ 108 那一批（S1–S6 ＋ B39）──────────────────────────────
//   S1 `job_start` 之后**盘上没有新工作区**（待确认只记一笔，在内存里）；
//   S2 答【是】⇒ **这时才建**（工作区＋会话＋登记）＋ 推 `scope/open` ＋ 回给 agent 一句；
//   S3 答【否】⇒ **什么都不建**，且 agent 收到"就在这儿做"；
//   S4 **不答**（超时）⇒ 不建、如实说一句、那一笔记 `expired`；
//   S5 那帧问话是**瞬态**（不落盘、不占号、不重放）；
//   S6 别的用户收不到这一帧（一人一份世界）；
//   B39-a 派活那段任务里**必须**含"自己做、别问"的意思；
//   B39-b 子进程收了口却没 `job_done` ⇒ **自动替它接一句**（有上限）；接满 ⇒ 如实报"没做完"；
//   B39-c 留痕：主进程那一侧看得见"它停过、我替它接了几次"（人话，不带内部词）。
//
// ── 形状（照 `handoff.test.js` / `app-workspace.test.js`）──────
// **真 `Worlds` ＋ 真 `Dispatcher` ＋ 真 HTTP ＋ 真 spawn（假 agent）＋ 真域套接字**：
// 派活那一帧、`app_create` 那一帧、交回总结那一帧**全都真的问过去**。
// ⚠️ 每条判据都带**反例的正身**（假的那一半当场红）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { AgentRuntime } from '../src/agent-runtime.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { ScopeView } from '../src/timeline.js';
import { Worlds, scopeTimelineId } from '../src/worlds.js';
import { handleLedgerOp } from '../src/ledger-socket.js';
import { APP_OPEN, JOB_ASK, JOB_ASK_EXPIRED, JOB_LINES, JOB_NUDGE_LINE, JOB_NUDGE_MAX, JobBook, SCOPE_OPEN, decideJobStart, jobAskEvent, jobAskText, jobPacketText, jobSummaryText, jobRowsFromEvents, scopeOpenEvent } from '../src/job.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const FAKE = nodePath.join(HERE, 'fake-agent.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const open = new Set();
const tmpDirs = [];
after(async () => {
  for (const h of open) {
    try { await h.close(); } catch { /* 关不干净不影响结论 */ }
  }
  open.clear();
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});

function tmp(prefix = 'hupo-job-') {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function cfgFor(dataDir, over = {}) {
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
    turnDeadlineMs: 30000,
    ...over,
  };
}

/**
 * 起一套（形状照 `handoff.test.js`）。
 * @param {object} [o]
 * @param {string} [o.scenario] 假 agent 跑哪个场景
 * @param {object} [o.job]      `job` 场景那几个值（短名／原话／它起的名字／总结／拖多久）
 */
async function boot({ scenario = 'job', job = {}, cfg: over = {} } = {}) {
  const dataDir = tmp();
  const cfg = cfgFor(dataDir, over);
  nodeFs.mkdirSync(cfg.dshHome, { recursive: true });
  nodeFs.mkdirSync(cfg.agentCwd, { recursive: true });

  let worlds = null;
  const runtime = new AgentRuntime({
    cfg,
    cfgFor: (key) => worlds.cfgForAgentKey(key),
    onEvict: (id) => worlds.onEvict(id),
    spawnFn: (bin, args, opts) =>
      realSpawn(process.execPath, [FAKE], {
        ...opts,
        env: {
          ...opts.env,
          FAKE_SCENARIO: scenario,
          // ⚠️ 账本那条口**不照 `cfg` 猜**：多租户下它是按人派生的
          //    （`<data>/users/<id>/ledger.sock`）⇒ 从世界那份拿（`pathsFor`）。
          FAKE_LEDGER_SOCKET: worlds.pathsFor('u1').ledgerSocketPath,
          FAKE_JOB_WHERE: job.where ?? 'math-drill',
          FAKE_JOB_WHY: job.why ?? '帮我做一个练算数的小程序',
          FAKE_JOB_NAME: job.name ?? '算数小练',
          FAKE_JOB_TITLE: job.title ?? '',
          FAKE_JOB_SUMMARY: job.summary ?? '做成了一个能出题的算数小程序，打开就能练加减法',
          FAKE_JOB_DELAY: String(job.delay ?? 0),
        },
      }),
  });
  worlds = new Worlds({ cfg, runtime, log: () => {}, warn: () => {} });

  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('test-pass');
  const { listen, close } = createServer({ worlds, auth, buildId: 'job-test' });
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;

  const h = {
    dataDir,
    cfg,
    worlds,
    runtime,
    auth,
    origin,
    close: async () => {
      open.delete(h);
      await worlds.shutdownDispatchers();
      await runtime.shutdown();
      await close();
      worlds.closeSockets();
      nodeFs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  open.add(h);
  return h;
}

const tokenFor = (h, sub = 'u1') => h.auth.issue({ sub }).token;
const post = (h, path, body, sub = 'u1') =>
  fetch(`${h.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(h, sub)}` },
    body: JSON.stringify(body),
  });

async function waitFor(pred, why, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error(`等不到：${why}（等了 ${ms}ms）`);
}

/** 盘上那条日志（**真日志**，不是内存里那份）。 */
const logEvents = (dir) => {
  const f = nodePath.join(dir, 'main.jsonl');
  if (!nodeFs.existsSync(f)) return [];
  return nodeFs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const noticesOf = (dir) => logEvents(dir).filter((e) => e.type === 'notice');
const textOf = (events) => events.filter((e) => e.type === 'message/text').map((e) => e.text ?? '').join('\n');

/** 派活那个动作走**真那条工具口**（与 MCP 同一条 `op:'job'`）。 */
const opJob = (w, req) => handleLedgerOp(w.ledger, { op: 'job', ...req }, { dispatcher: () => w.dispatcher });

/**
 * ★ **他答那一句问话**（契约 108 §一 第②/③步）。
 *
 * 🔴 **与客户端同一条路**：那条流上发一帧 `{"t":"job-answer",…}`，
 *    然后等那一帧回执（`job/answer-ack`）——**不是**"调个函数看看"。
 */
async function answerJob(h, { id, yes }, sub = 'u1') {
  const c = await wsConnect(h, { sub, scope: 'main' });
  try {
    await waitFor(() => c.frames.some((f) => f.type === 'client/hello'), '答话那条流没连上');
    c.ws.send(JSON.stringify({ t: 'job-answer', id, yes }));
    await waitFor(
      () => c.frames.some((f) => f.type === 'job/answer-ack' && f.id === id),
      '答话没等到回执',
    );
    const ack = c.frames.find((f) => f.type === 'job/answer-ack' && f.id === id);
    return { ok: ack.ok === true, yes: ack.yes ?? null, error: ack.error ?? null, text: ack.text ?? null };
  } finally {
    c.ws.close();
  }
}

/** ★ 等那一帧问话落进调度器（判据要从这里拿号）。 */
async function waitAsk(w, why = '那一帧问话没出来') {
  await waitFor(() => w.dispatcher.pendingJobAsk !== null, why);
  return w.dispatcher.pendingJobAsk;
}

/** 连一条流（真 `ws`）—— ⑤ 那三条判据要用它。 */
function wsConnect(h, { sub = 'u1', scope = null, sinceSeq = null } = {}) {
  const protocols = ['bearer', tokenFor(h, sub)];
  const qs = new URLSearchParams();
  if (sinceSeq !== null) qs.set('sinceSeq', String(sinceSeq));
  if (scope) qs.set('scope', scope);
  const url = `${h.origin.replace(/^http/, 'ws')}/api/stream${qs.toString() ? `?${qs}` : ''}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    const frames = [];
    ws.on('message', (d) => {
      try {
        frames.push(JSON.parse(d.toString()));
      } catch {
        /* 不是 JSON 的帧不算 */
      }
    });
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', (err) => reject(err));
  });
}

/** 登记与日志两份**同形的投影**（P5 比的就是它）。 */
const normRows = (rows) =>
  rows.map((r) => `${r.where}|${r.status}|${r.name}|${r.summary}|${r.at}`).sort();

/**
 * 一处跑完的完整派活（P2/P3/P4/P5/P7 共用这一段前置）。
 *
 * ★ **108 起是两步**：① 他说那句话 ⇒ 服务端**只问一句**（什么都不建）；
 *   ② 他点【另开一处做】⇒ **这时才建** ＋ 推 `scope/open` ⇒ 子进程干活 ⇒ 交回总结。
 */
async function runOneJob(h, { where = 'math-drill', text = '帮我做一个练算数的小程序' } = {}) {
  const w = h.worlds.worldFor('u1');
  assert.equal((await post(h, '/api/say', { messageId: 'u_job', text })).status, 200);
  const ask = await waitAsk(w);
  assert.equal(ask.where, where, `那一帧问话里的短名不对：${JSON.stringify(ask)}`);
  assert.equal((await answerJob(h, { id: ask.id, yes: true })).ok, true, '答【另开一处做】没被收下');
  await waitFor(() => w.jobs.forScope(where)?.status === 'reported', '子进程没把总结交回来');
  await waitFor(
    () => logEvents(w.dir).some((e) => e.type === 'message/end' && e.scopeId === where),
    '那一间那一轮要收口',
  );
  await sleep(150); // 让收口后的那几帧（提醒）落稳
  return w;
}

// ════════════════════════════════════════════════════════════════
// P1 · 派活：那一间被**建出来** ＋ 任务与由来**真交到它手上**
// ════════════════════════════════════════════════════════════════

test('🔴 P1：他说"做一个 X 的 app" ⇒ 他答了之后那一间**被建出来**（不是等他点开）＋ 任务与由来交到它手上', async () => {
  const h = await boot({ scenario: 'job', job: { where: 'math-drill', why: '帮我做一个练算数的小程序' } });
  const w = h.worlds.worldFor('u1');
  try {
    // ★ 起点：那一间**还不存在**（否则这条判据恒真）
    assert.equal(w.workspaces.has('math-drill'), false, '起点就该没有');
    assert.equal(w.dispatcher.sessionFor('math-drill'), null, '起点就该没有会话');

    assert.equal(
      (await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status,
      200,
    );

    // ★ **108：先问一句，这时什么都还没建**（S1 那半；详见下面 S1 那条）
    const ask = await waitAsk(w, '他没被问一句');
    assert.equal(w.workspaces.has('math-drill'), false, '🔴 还没答就建了（那就是"先做了再问"）');

    // ★ **他点【另开一处做】** ⇒ **这时才建**
    assert.equal((await answerJob(h, { id: ask.id, yes: true })).ok, true);

    // 🔴 **判据本体**：那一间**被派活建出来**——测试这边**从没调过** `roomFor`
    //    （"等他点开才建"那条反例就落在这儿）。
    await waitFor(() => w.workspaces.has('math-drill'), '派活没把那一间建出来');
    await waitFor(() => w.dispatcher.sessionFor('math-drill') !== null, '那一间的会话没挂上来');
    assert.equal(
      nodeFs.existsSync(nodePath.join(w.workspaces.root, 'math-drill')),
      true,
      '工作区目录要真的在盘上',
    );

    // 🔴 **任务与由来**交到它手上：它那边看得到"他让我做 X"＋**他说的那句原话**。
    await waitFor(
      () => typeof w.dispatcher.sessionFor('math-drill').lastJobPacket === 'string',
      '任务书没交过去',
    );
    const packet = w.dispatcher.sessionFor('math-drill').lastJobPacket;
    assert.match(packet, /主人让你在这里做一件东西/, `🔴 由来丢了（它不知道自己为什么在做这个）：${packet}`);
    assert.match(packet, /帮我做一个练算数的小程序/, `🔴 他说的那句原话丢了：${packet}`);
    // ★ 而且它是**真收到**的：子进程照着那份任务书把东西做出来了（真 spawn ＋ 真投递）
    // ★ `114`：他那一份是**活的**（登记 ＋ 工作区），不再要求“落了一版包”
    await waitFor(() => w.apps.has('math-drill'), '🔴 子进程没真收到那条任务');
    assert.equal(w.jobs.forScope('math-drill').why, '帮我做一个练算数的小程序', '★ 由来也要落进登记');

    // ★ **负向对照**：换个**已经有一处**的名字 ⇒ 拒（P1 不是"什么名字都建"）
    const r = opJob(w, { where: 'math-drill', why: '再来一个', scope: 'main' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'exists', `🔴 已经有一处了还建第二个：${JSON.stringify(r)}`);
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════════
// P2 · 活算子进程：创建过程在**那一间**，主进程里**没有**
// ════════════════════════════════════════════════════════════════

test('🔴 P2：`app_create` 那一段在**那一间**；主进程里**没有**那段过程', async () => {
  const h = await boot({ scenario: 'job' });
  try {
    const w = await runOneJob(h);
    const childView = new ScopeView({ timeline: w.timeline.base, scope: 'math-drill' });
    const childSeen = childView.readAll();
    const mainSeen = w.timeline.readAll();

    // ① **正身**：那一间里**有**那段过程（子进程自己说的话）
    assert.equal(
      childSeen.some((e) => e.type === 'message/text' && String(e.text ?? '').includes('我先把页面写出来')),
      true,
      `🔴 那一间里没有它自己的过程：${textOf(childSeen)}`,
    );
    // ② **活真在那一间干的**：制品是它在**那间**里造出来的（真那条口）
    assert.equal(w.apps.has('math-drill'), true, 'app_create 没登记上（`114`：用户端是登记 ＋ 工作区）');
    assert.equal(
      nodeFs.existsSync(nodePath.join(w.workspaces.root, 'math-drill', 'index.html')),
      true,
      '产物要在工作区里',
    );

    // ③ 🔴 **主进程里没有这段过程**（P2 的反例正身：过程仍在主进程 ⇒ 红）
    assert.equal(
      mainSeen.some((e) => String(e.text ?? '').includes('我先把页面写出来')),
      false,
      '🔴 子进程那段过程出现在主进程里了',
    );
    assert.equal(
      mainSeen.some((e) => e.scopeId === 'math-drill'),
      false,
      '🔴 那一间的对话事件漏进主进程（可见视图被污染）',
    );
    // ★ 主进程里只有**派活那两帧**（`job/start` / `job/report`）——不是那段过程
    const jobFrames = mainSeen.filter((e) => String(e.type).startsWith('job/'));
    assert.equal(jobFrames.length >= 2, true, `★ 派活那两帧要在主进程那条日志上：${JSON.stringify(jobFrames)}`);
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════════
// P3 · 🔴 总结扔回主进程（人话：做了什么 · 叫什么 · 在哪儿看）
// ════════════════════════════════════════════════════════════════

test('🔴 P3：做完 ⇒ 主进程里一条**人话总结**（它的名字）——不许把那段全文倒进来', async () => {
  // ⚠️ 阈值调小 ＋ 让子进程干久一点：这样"那一轮是不是**多说了**一条完成提醒"
  //    也在这一条判据里（同一件事两条通道 = R1.2 的通知疲劳）。
  // ⚠️ **制品那个标题故意与它交回的名字不同**（B20）：租户那份 app 的名字在**他盒子里**，
  //    宿主查不到 ⇒ "叫什么"只许用它自己交回来的 `name`。
  const h = await boot({
    scenario: 'job',
    job: {
      delay: 700,
      name: '算数小练',
      title: '盒子里那个标题',
      summary: '做成了一个能出题的算数小程序，打开就能练加减法',
    },
    cfg: { backgroundAfterMs: 300 },
  });
  try {
    const w = await runOneJob(h);

    // ① **那一帧**：主进程那条日志上有 `job/report`，名字与总结都是**它交的**
    const report = logEvents(w.dir).find((e) => e.type === 'job/report' && e.where === 'math-drill');
    assert.ok(report, '🔴 主进程里什么都没有');
    assert.equal(report.name, '算数小练', '🔴 "叫什么"必须用它自己交的名字');
    assert.match(report.summary, /算数小程序/);

    // ② **那条人话**：主进程里出现一条总结（走 P1 那本 `work-*` 出口 —— 复用，不另造通道）
    const done = noticesOf(w.dir).filter((e) => e.kind === 'work-done');
    assert.equal(done.length, 1, `🔴 同一件事说了 ${done.length} 遍（R1.2）：${JSON.stringify(done.map((d) => d.text))}`);
    const said = done[0].text;
    // ★ 三样都要在：做了什么 · 叫什么 · 在哪儿看
    assert.match(said, /做完了/, said);
    assert.match(said, /算数小练/, `★ "叫什么"要由**它自己的总结**带出来：${said}`);
    assert.match(said, /在「算数小练」里看/, `★ "在哪儿看"要说得出来：${said}`);
    // 🔴 **不许拿宿主侧那个标题顶替**（B20：租户那份 app 的名字在**他盒子里**）
    assert.doesNotMatch(said, /盒子里那个标题/, `🔴 "叫什么"是从宿主侧取的，不是它自己说的：${said}`);
    assert.equal(said, jobSummaryText({ name: '算数小练', summary: '做成了一个能出题的算数小程序，打开就能练加减法' }));
    // 🔴 **不许出现内部短名**（`06` 禁用词那条）
    assert.doesNotMatch(said, /math-drill/, `🔴 内部 id 上屏了：${said}`);

    // ③ 🔴 **不许把子进程那段全文倒进主进程**（那是复制，不是回报）
    const mainSeen = w.timeline.readAll();
    assert.equal(
      mainSeen.some((e) => String(e.text ?? '').includes('我先把页面写出来')),
      false,
      '🔴 子进程那段全文被倒进主进程了',
    );
    assert.equal(
      textOf(mainSeen).includes('做好了，我把它交回去了'),
      false,
      '🔴 子进程的收尾那句也被抄进主进程了',
    );
    // ★ 反例的正身：那段**确实存在**（在它自己那一间）——上面那条不是"恒真"
    const childView = new ScopeView({ timeline: w.timeline.base, scope: 'math-drill' });
    assert.equal(
      childView.readAll().some((e) => String(e.text ?? '').includes('做好了，我把它交回去了')),
      true,
      '★ 它自己那一间里必须有那段（否则上面那条是空判）',
    );
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════════
// P4 · 主进程知道（回报之后那条会话查得到）
// ════════════════════════════════════════════════════════════════

test('🔴 P4：回报之后**主进程那条会话查得到**（"我有哪些小程序"答得出）', async () => {
  const h = await boot({ scenario: 'job' });
  try {
    const w = await runOneJob(h);

    // ① **走向模型的那条口**（与 MCP 同一条 `op:'job'`）：问得出它叫什么、做了什么
    const r = opJob(w, { action: 'list', scope: 'main' });
    assert.equal(r.ok, true, `🔴 主进程查不到：${JSON.stringify(r)}`);
    assert.match(r.text, /算数小练/, `★ "有哪些小程序"要答得出名字：${r.text}`);
    assert.match(r.text, /加减法/, `★ "各做了些什么"要答得出（那一句总结）：${r.text}`);
    // 🔴 内部短名**不许**上屏（模型会照着说出来）
    assert.doesNotMatch(r.text, /math-drill/, `🔴 内部 id 混进给人看的话里了：${r.text}`);

    // ② **权威在事件流上**（N6）：主进程那条视图里就有那一帧
    const seen = w.timeline.readAll().filter((e) => e.type === 'job/report');
    assert.equal(seen.length, 1, '🔴 主进程那条会话的日志上查不到这件事');
    assert.equal(seen[0].name, '算数小练');

    // ③ 小程序那条既有的口照旧答得出"有哪些小程序"（协议只加不改）
    assert.equal(w.apps.list().some((a) => a.id === 'math-drill' && a.title === '算数小练'), true);
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════════
// P5 · 简登记：列得出 ＋ **能从日志重建**
// ════════════════════════════════════════════════════════════════

test('🔴 P5：登记列得出（哪些小程序／工作区 ＋ 各自最后一条总结），而且**删掉它 ⇒ 重扫又对得上**', async () => {
  const h = await boot({ scenario: 'job' });
  try {
    const w = await runOneJob(h);

    // ① **列得出**
    const rows = w.jobs.list();
    const row = rows.find((x) => x.where === 'math-drill');
    assert.ok(row, `🔴 登记里没有那一处：${JSON.stringify(rows)}`);
    assert.equal(row.name, '算数小练', '★ 各自最后一条总结里的"叫什么"');
    assert.match(row.summary, /算数小程序/, '★ 各自最后一条总结');
    // 盘上真有一个工作区 ＋ 一个小程序 ⇒ 它也得列出来（"有哪些工作区"那半）
    assert.equal(rows.some((x) => x.where === 'math-drill'), true);
    assert.equal(w.workspaces.has('math-drill'), true);
    assert.equal(nodeFs.existsSync(w.jobs.path), true, '登记要**落在文件里**（主进程那边有一些文件记录）');
    // ④ **它不是日志副本**：登记那几行里**一个字**的对话内容都没有
    const raw = nodeFs.readFileSync(w.jobs.path, 'utf8');
    assert.doesNotMatch(raw, /我先把页面写出来/, '🔴 登记成了第二份日志');
    assert.doesNotMatch(raw, /message\/text/, '🔴 登记里抄了对话事件');

    // ② **能从日志重建**（同形的两份，逐字段对得上）
    const fromLog = w.jobs.rebuild();
    assert.deepEqual(normRows(fromLog), normRows(rows), '🔴 登记与日志两份互相漂');

    // ③ 🔴 **删掉登记 ⇒ 重扫一遍又对得上**（它是**索引**，不是唯一真相）
    nodeFs.rmSync(w.jobs.path, { force: true });
    assert.equal(nodeFs.existsSync(w.jobs.path), false);
    const fresh = new JobBook({
      dir: w.dir,
      store: w.store,
      listScopes: () => ({ apps: w.apps.list(), workspaces: w.workspaces.list() }),
    });
    assert.deepEqual(normRows(fresh.list()), normRows(rows), '🔴 删掉登记之后重扫对不上（登记成了唯一真相）');
    assert.deepEqual(
      normRows(fresh.rebuild(w.store.readAll('main'))),
      normRows(rows),
      '🔴 从日志重扫不出同一份登记',
    );
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════════
// P6 · 反例的正身：没派活的一轮**一个字都不动**；派活失败**如实说**
// ════════════════════════════════════════════════════════════════

test('🔴 P6a：**没派活**的一轮 ⇒ 登记／工作区／那一帧**一个字都不许动**（老行为逐字不变）', async () => {
  // `normal`：假 agent 只会说话，**一个工具都不调**。
  const h = await boot({ scenario: 'normal' });
  const w = h.worlds.worldFor('u1');
  try {
    const before = w.workspaces.list();
    assert.equal((await post(h, '/api/say', { messageId: 'u_plain', text: '你好' })).status, 200);
    await waitFor(() => logEvents(w.dir).some((e) => e.type === 'message/end'), '这一轮要收口');
    await sleep(150);

    assert.equal(w.jobs.all().length, 0, '🔴 普通一轮被记进派活登记了');
    assert.equal(nodeFs.existsSync(w.jobs.path), false, '★ 连那个文件都不该被建出来');
    assert.deepEqual(w.workspaces.list(), before, '🔴 普通一轮顺手建了工作区');
    assert.equal(
      logEvents(w.dir).some((e) => String(e.type).startsWith('job/')),
      false,
      '🔴 普通一轮里冒出了派活那两帧',
    );
    // ★ 老行为逐字不变：他说的那句 ＋ 它答的那句都在**主进程**里
    const evs = logEvents(w.dir);
    assert.equal(evs.some((e) => e.type === 'user/echo' && e.text === '你好'), true);
    assert.equal(evs.some((e) => e.type === 'message/text' && String(e.text).includes('你好')), true);
    assert.equal(evs.some((e) => e.type === 'message/end'), true);
  } finally {
    await h.close();
  }
});

test('🔴 P6b：派活失败（建工作区那一下真失败）⇒ **如实说一句**、活留在主进程做完', async () => {
  const h = await boot({ scenario: 'job' });
  const w = h.worlds.worldFor('u1');
  try {
    // ★ 让"建那一间"**真失败**：用一个文件占住 `<dir>/workspaces`。
    // ⚠️ **108 起建那一刀发生在"他答了【另开一处做】"之后** ⇒ 先把这一刀摆好，
    //    再说话（说话那一步只问一句、不建，所以不受影响）。
    nodeFs.writeFileSync(nodePath.join(w.dir, 'workspaces'), '这里不该是个文件\n');

    assert.equal(
      (await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status,
      200,
    );
    const ask = await waitAsk(w, '他没被问一句');
    // ① 🔴 **如实说**：那条 HTTP 口（与客户端同一条）回的是"没成 ＋ 我在这儿接着做"
    const ans = await answerJob(h, { id: ask.id, yes: true });
    assert.equal(ans.ok, false, `🔴 建不成还回"派成了"：${JSON.stringify(ans)}`);
    assert.equal(ans.error, 'create-failed');
    assert.match(String(ans.text), /没成/, `🔴 拒了却不说清：${JSON.stringify(ans)}`);
    assert.match(String(ans.text), /在这儿接着做|接着做/, `★ 要说清"活留在主进程"：${ans.text}`);

    // ② 🔴 **活留在主进程**：那句话被**回给了主进程那位** ⇒ 主对话里看得到
    //    （真 spawn ＋ 真 prompt：假 agent 会把服务端给的那句话原样说出来）
    await waitFor(
      () => logEvents(w.dir).some((e) => e.type === 'message/text' && String(e.text ?? '').includes('没成')),
      '🔴 派活失败之后主进程里什么都没有（把话吞掉了）',
    );
    // ③ 那一边**没被建出来**、登记一点没动
    assert.equal(w.dispatcher.sessionFor('math-drill'), null, '🔴 失败了还给它挂了会话');
    assert.equal(w.jobs.all().length, 0, '🔴 失败了还记了一行');
    assert.equal(nodeFs.existsSync(w.jobs.path), false);
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════════
// P7 · 不破 P-l：仍然**一条日志、一套号**
// ════════════════════════════════════════════════════════════════

test('🔴 P7：派活之后仍然**一条日志、一套号**（不是一个 scope 一套号）', async () => {
  const h = await boot({ scenario: 'job' });
  try {
    const w = await runOneJob(h);
    const evs = logEvents(w.dir);

    // ① **一条日志**：没有"每间一份"
    assert.equal(fsJsonl(w.dir).filter((f) => /^scope-/.test(f)).length, 0, '🔴 冒出按 scope 分的日志了');
    assert.equal(fsJsonl(w.dir).includes('main.jsonl'), true);
    assert.equal(scopeTimelineId('math-drill'), 'main', '★ "日志叫什么"只有一处出处，且永远是 main');

    // ② **子进程那些事件就在这一条日志上**（靠 `scopeId` 标签分家，不是靠文件）
    assert.equal(evs.some((e) => e.scopeId === 'math-drill' && e.type === 'message/text'), true);
    assert.equal(evs.some((e) => e.scopeId === 'math-drill' && e.type === 'message/end'), true);
    // ★ 主进程那两帧也在同一条上（标签是"没有"）
    assert.equal(evs.some((e) => e.type === 'job/start'), true);
    assert.equal(evs.some((e) => e.type === 'job/report'), true);

    // ③ 🔴 **一套号**：全日志的 `seq` 严格递增、不重号（"每间从 1 重新起号" ⇒ 当场红）
    const seqs = evs.map((e) => e.seq);
    assert.equal(new Set(seqs).size, seqs.length, '🔴 重号了（新那一间从 1 重新起号就会这样）');
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '🔴 号不是只增的');
    // ★ 反例的正身：**真的要横跨两间**（否则"一套号"这条是空的）
    assert.equal(seqs.some((s) => s > 1), true);
    const mainFrames = evs.filter((e) => e.scopeId === undefined || e.scopeId === 'main');
    const childFrames = evs.filter((e) => e.scopeId === 'math-drill');
    assert.ok(mainFrames.length > 0 && childFrames.length > 0, '★ 两间都要有事件，这条判据才不是空的');
    assert.ok(
      Math.max(...mainFrames.map((e) => e.seq)) > Math.min(...childFrames.map((e) => e.seq)),
      '★ 两间的号**交错在同一套**里（各起各的号会在同一个数上撞车）',
    );
  } finally {
    await h.close();
  }
});

function fsJsonl(dir) {
  try {
    return nodeFs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════════════════
// ⑤ · 派活成功 ⇒ 推一帧"现在该看哪一间"（**只在实时**）
// ════════════════════════════════════════════════════════════════

test('🔴 ⑤：他答【另开一处做】⇒ 推一帧 `scope/open`（实时收到 · 补发里没有 · 别的人收不到）', async () => {
  const h = await boot({ scenario: 'job' });
  const w = h.worlds.worldFor('u1');
  try {
    // ① **连接 A**（焦点就是主线 —— 他刚在主对话里说要做一个 X）⇒ 收到那一帧
    const a = await wsConnect(h, { scope: 'main' });
    await waitFor(() => a.frames.some((f) => f.type === 'client/hello'), 'A 那条流没连上');
    assert.equal(
      (await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status,
      200,
    );
    // ★ **108**：说话那一步只推一帧**问话**（还没有 `scope/open`）
    await waitFor(() => a.frames.some((f) => f.type === JOB_ASK), '🔴 没推那帧问话');
    assert.equal(
      a.frames.some((f) => f.type === SCOPE_OPEN),
      false,
      '🔴 还没答就把窗口切过去了（"先做了再问"）',
    );
    const ask = await waitAsk(w);
    assert.equal((await answerJob(h, { id: ask.id, yes: true })).ok, true);
    await waitFor(() => a.frames.some((f) => f.type === SCOPE_OPEN), '🔴 没推"现在该看哪一间"那一帧');
    const frame = a.frames.find((f) => f.type === SCOPE_OPEN);
    assert.equal(frame.scope, 'math-drill', `🔴 那一帧没说是哪一间：${JSON.stringify(frame)}`);
    assert.equal(typeof frame.at, 'number');
    // ★ **它只在实时**：瞬态**不占号**，而且盘上**没有**它（P-l 那条日志一个字都没多）
    assert.equal(frame.seq, undefined, '🔴 瞬态帧带了号（那就不是"不占号"那一档）');
    assert.equal(
      logEvents(w.dir).some((e) => e.type === SCOPE_OPEN),
      false,
      '🔴 那一帧落盘了 —— 补发就会重放它',
    );

    // ② 🔴 **补发里没有它**：之后新开一条 `sinceSeq=0` 的连接（他会重连）
    const b = await wsConnect(h, { scope: 'main', sinceSeq: 0 });
    await waitFor(() => b.frames.some((f) => f.type === 'client/hello'), 'B 那条流没连上');
    await sleep(250);
    assert.equal(
      b.frames.some((f) => f.type === 'scope/open'),
      false,
      '🔴 重连补发里带了它 ⇒ 每次重连都会乱切房间',
    );
    // ★ 反例的正身：B **确实**拿到了补发（不是"什么都没发"那种假绿）
    assert.equal(b.frames.some((f) => f.type === 'user/echo'), true, '★ B 该拿到盘上那段补发');

    // ③ 🔴 **不是这个用户的人收不到**（瞬态也只推给"这个人"那条流）
    const c = await wsConnect(h, { sub: 'u2', scope: 'main' });
    await waitFor(() => c.frames.some((f) => f.type === 'client/hello'), 'u2 那条流没连上');
    await sleep(250);
    assert.equal(
      c.frames.some((f) => f.type === 'scope/open'),
      false,
      '🔴 别的用户收到了这一帧',
    );

    a.ws.close();
    b.ws.close();
    c.ws.close();
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════════
// ★ 108 · S1–S6：**先问一句 · 答了才建 · 不答不猜**
// ════════════════════════════════════════════════════════════════

const noticesOfKind = (dir, kind) => noticesOf(dir).filter((e) => e.kind === kind);

test('🔴 S1：`job_start` 之后**盘上没有新工作区**（待确认只记一笔，在内存里）', async () => {
  const h = await boot({ scenario: 'job' });
  const w = h.worlds.worldFor('u1');
  try {
    const beforeWs = w.workspaces.list();
    assert.equal((await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status, 200);
    await waitAsk(w, '他没被问一句');

    // 🔴 **判据本体**：问了，但**一个东西都没建**
    assert.equal(w.workspaces.has('math-drill'), false, '🔴 还没答就建了工作区（"先做了再问"）');
    assert.deepEqual(w.workspaces.list(), beforeWs, '🔴 盘上多了工作区');
    assert.equal(w.dispatcher.sessionFor('math-drill'), null, '🔴 还没答就把会话挂上来了');
    // 登记一行都不许有，连那个文件都不该被建出来
    assert.equal(w.jobs.all().length, 0, '🔴 还没答就记了一笔');
    assert.equal(nodeFs.existsSync(w.jobs.path), false, '🔴 连登记文件都被建出来了');
    // 那两帧是"建了"才有的事实 ⇒ 盘上不许有
    assert.equal(
      logEvents(w.dir).some((e) => String(e.type).startsWith('job/')),
      false,
      '🔴 还没答就落了派活那两帧',
    );
    // ★ **反例的正身**：那一笔待确认**真的在**（证明上面不是"什么都没发生"那种假绿）
    const ask = w.dispatcher.pendingJobAsk;
    assert.equal(ask.where, 'math-drill');
    assert.equal(ask.why, '帮我做一个练算数的小程序', '★ 由来要记在这一笔上（答了之后要交给它）');
    assert.equal(w.dispatcher.lastJobAsk.status, 'pending');
  } finally {
    await h.close();
  }
});

test('🔴 S2：答【另开一处做】⇒ **这时才建**（工作区＋会话＋登记）＋ 推 `scope/open` ＋ 回给 agent 一句', async () => {
  const h = await boot({ scenario: 'job' });
  const w = h.worlds.worldFor('u1');
  try {
    const a = await wsConnect(h, { scope: 'main' });
    await waitFor(() => a.frames.some((f) => f.type === 'client/hello'), '那条流没连上');
    assert.equal((await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status, 200);
    const ask = await waitAsk(w);
    assert.equal((await answerJob(h, { id: ask.id, yes: true })).ok, true);

    // ① **建**：工作区目录 ＋ 会话 ＋ 登记一行 ＋ `job/start` 那一帧
    await waitFor(() => w.workspaces.has('math-drill'), '答了还不建');
    await waitFor(() => w.dispatcher.sessionFor('math-drill') !== null, '会话没挂上来');
    await waitFor(() => w.jobs.forScope('math-drill') !== null, '登记那一行没写');
    await waitFor(
      () => logEvents(w.dir).some((e) => e.type === 'job/start' && e.where === 'math-drill'),
      '`job/start` 那一帧没落盘',
    );
    // ② **那一帧"该看哪一间"**（瞬态，实时收得到）
    await waitFor(() => a.frames.some((f) => f.type === SCOPE_OPEN && f.scope === 'math-drill'), '没推 scope/open');
    // ③ 🔴 **回给 agent 一句**："他说另开一处做"（真投递：它那边会照着说一句 —— 见假 agent）
    await waitFor(
      () => logEvents(w.dir).some((e) => e.type === 'message/text' && String(e.text ?? '').includes('另开一处做')),
      '🔴 他答了"是"，agent 一个字都没收到',
    );
    a.ws.close();
  } finally {
    await h.close();
  }
});

test('🔴 S3：答【否】⇒ **什么都不建**，且 agent 收到"就在这儿做"', async () => {
  const h = await boot({ scenario: 'job' });
  const w = h.worlds.worldFor('u1');
  try {
    assert.equal((await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status, 200);
    const ask = await waitAsk(w);
    const ans = await answerJob(h, { id: ask.id, yes: false });
    assert.equal(ans.ok, true);
    assert.equal(ans.yes, false);

    // ① 🔴 **什么都不建**（工作区 / 会话 / 登记 / 那两帧，一样都不许有）
    //   ⚠️ 用 `assert.ok` 而不是 `assert.equal(x, false, …)`：后者在 node 上
    //      **只打 `true !== false`，不打那句人话** —— 变异验证要读的就是那句人话。
    await sleep(200);
    assert.ok(w.workspaces.has('math-drill') === false, '🔴 答"否"也把那一间建了');
    assert.ok(w.dispatcher.sessionFor('math-drill') === null, '🔴 答"否"也挂了会话');
    assert.ok(w.jobs.all().length === 0, '🔴 答"否"也记了一笔');
    assert.ok(nodeFs.existsSync(w.jobs.path) === false, '🔴 答"否"也把登记文件建出来了');
    assert.ok(
      logEvents(w.dir).some((e) => String(e.type).startsWith('job/')) === false,
      '🔴 答"否"也落了派活那两帧',
    );
    // ② 🔴 **agent 收到"就在这儿做"**（真投递 ⇒ 它那边会照着说一句）
    await waitFor(
      () => logEvents(w.dir).some((e) => e.type === 'message/text' && String(e.text ?? '').includes('就在这儿做')),
      '🔴 答"否"之后 agent 不知道——那件事就悬在半空',
    );
    // ★ 那一笔的下场记的是 `no`（不是"还在等"）
    assert.equal(w.dispatcher.lastJobAsk.status, 'no');
    assert.equal(w.dispatcher.pendingJobAsk, null);
  } finally {
    await h.close();
  }
});

test('🔴 S4：**不答**（超时）⇒ 不建、如实说一句、那一笔记 `expired`', async () => {
  // ⚠️ 阈值住代码（`JOB_ASK_TIMEOUT_MS`）；判据把它调小 —— 不是把那个数抄一份。
  const h = await boot({ scenario: 'job', cfg: { jobAskTimeoutMs: 250 } });
  const w = h.worlds.worldFor('u1');
  try {
    const a = await wsConnect(h, { scope: 'main' });
    await waitFor(() => a.frames.some((f) => f.type === 'client/hello'), '那条流没连上');
    assert.equal((await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status, 200);
    const ask = await waitAsk(w);

    // 🔴 **不替他选**：到点 ⇒ 记 `expired`、推一帧"作废了"、**一个东西都不建**
    await waitFor(() => w.dispatcher.lastJobAsk?.status === 'expired', '超时没把那一笔收成 expired');
    assert.equal(w.dispatcher.pendingJobAsk, null, '超时之后还在等他答');
    assert.equal(w.workspaces.has('math-drill'), false, '🔴 超时替他默认建了');
    assert.equal(w.dispatcher.sessionFor('math-drill'), null);
    assert.equal(w.jobs.all().length, 0);
    assert.equal(nodeFs.existsSync(w.jobs.path), false);
    // **如实说一句**：那帧作废的瞬态帧（带服务端给的那句人话）真的推到了他屏幕上
    await waitFor(() => a.frames.some((f) => f.type === JOB_ASK_EXPIRED), '没推"那一笔作废了"那一帧');
    const gone = a.frames.find((f) => f.type === JOB_ASK_EXPIRED);
    assert.equal(gone.text, JOB_LINES.notYet, `🔴 那句人话不是服务端给的那句：${JSON.stringify(gone)}`);
    assert.equal(gone.seq, undefined, '★ 它也是瞬态（不占号）');

    // ★ 迟到的答话 ⇒ **如实说"那件事我还没动手"**（不许补建）
    const late = await answerJob(h, { id: ask.id, yes: true });
    assert.equal(late.ok, false, '🔴 作废之后还接受答话');
    assert.equal(late.error, 'ask-gone');
    assert.match(String(late.text), /还没动手/, `🔴 不许猜：${JSON.stringify(late)}`);
    assert.equal(w.workspaces.has('math-drill'), false, '🔴 迟到的"是"把它建出来了');
    a.ws.close();
  } finally {
    await h.close();
  }
});

test('🔴 S5：那帧问话是**瞬态**（不落盘、不占号、不重放）', async () => {
  const h = await boot({ scenario: 'job' });
  const w = h.worlds.worldFor('u1');
  try {
    const a = await wsConnect(h, { scope: 'main' });
    await waitFor(() => a.frames.some((f) => f.type === 'client/hello'), '那条流没连上');
    assert.equal((await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status, 200);
    await waitFor(() => a.frames.some((f) => f.type === JOB_ASK), '没推那帧问话');
    const frame = a.frames.find((f) => f.type === JOB_ASK);
    assert.equal(frame.seq, undefined, '🔴 那帧问话带了号（那就不是"瞬态"那一档）');
    assert.equal(frame.where, 'math-drill');
    assert.equal(frame.why, '帮我做一个练算数的小程序', '★ 他说的那句原话要在帧上（那层确认里要看得见）');
    assert.equal(frame.text, jobAskText(), '★ 那句问话由服务端给（客户端照抄，不许自己拼）');
    assert.equal('scopeId' in frame, false, '🔴 叫成 scopeId 就会被焦点路由丢掉（最该收到的人收不到）');
    // 🔴 **盘上没有它**（补发就不可能重放它）
    assert.equal(
      logEvents(w.dir).some((e) => e.type === JOB_ASK),
      false,
      '🔴 那帧问话落盘了 —— 每次重连都会再问一遍',
    );
    // ★ **补发里没有它**：新开一条 `sinceSeq=0` 的连接
    const b = await wsConnect(h, { scope: 'main', sinceSeq: 0 });
    await waitFor(() => b.frames.some((f) => f.type === 'client/hello'), 'B 那条流没连上');
    await sleep(250);
    assert.equal(b.frames.some((f) => f.type === JOB_ASK), false, '🔴 重连补发里带了它（每次开机都被再问一遍）');
    assert.equal(b.frames.some((f) => f.type === 'user/echo'), true, '★ 反例的正身：B 确实拿到了盘上那段补发');
    a.ws.close();
    b.ws.close();
  } finally {
    await h.close();
  }
});

test('🔴 S6：别的用户收不到那一帧（一人一份世界）', async () => {
  const h = await boot({ scenario: 'job' });
  const w = h.worlds.worldFor('u1');
  try {
    // ★ 先让 u2 有一条自己的流（否则"收不到"是空的）
    const other = await wsConnect(h, { sub: 'u2', scope: 'main' });
    await waitFor(() => other.frames.some((f) => f.type === 'client/hello'), 'u2 那条流没连上');
    const mine = await wsConnect(h, { sub: 'u1', scope: 'main' });
    await waitFor(() => mine.frames.some((f) => f.type === 'client/hello'), 'u1 那条流没连上');

    assert.equal((await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status, 200);
    await waitFor(() => mine.frames.some((f) => f.type === JOB_ASK), 'u1 没收到那帧问话');
    await sleep(250);
    assert.equal(
      other.frames.some((f) => f.type === JOB_ASK),
      false,
      '🔴 别的用户收到了这一帧（"他做不做新东西"跟别人没关系）',
    );
    // ★ 负向对照：u2 那条流**是活的**（不是"什么都没发"那种假绿）
    assert.equal(other.frames.some((f) => f.type === 'client/hello'), true);
    assert.equal(w.dispatcher.pendingJobAsk?.where, 'math-drill', '★ u1 那一笔确实在（上面那条不是空判）');
    other.ws.close();
    mine.ws.close();
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════════
// ★ B39：子进程停下来等回话 ⇒ 自己任务里先说清 · 停住了就替它接（有上限）
// ════════════════════════════════════════════════════════════════

test('🔴 B39-a：派活那段任务里**必须**含"自己做、别问"的意思（去掉那句 ⇒ 红）', () => {
  const packet = jobPacketText({ where: 'math-drill', why: '帮我做一个练算数的小程序' });
  // 🔴 真机实证：它收尾时留下一句"你回一句「接着说」…" ⇒ 而这一间里**没有真人**
  assert.match(packet, /自己一次做完/, `🔴 没交代"自己做"：${packet}`);
  assert.match(packet, /不要问任何人/, `🔴 没交代"别问人"：${packet}`);
  assert.match(packet, /不要等谁回话/, `🔴 没交代"别等回话"：${packet}`);
  // ★ 反例的正身：**去掉那一句** ⇒ 上面三条当场假（判据不是恒真）
  const without = jobPacketText({ where: 'math-drill', why: '帮我做一个练算数的小程序' })
    .split('\n')
    .filter((l) => !l.includes('自己一次做完'))
    .join('\n');
  assert.equal(/自己一次做完/.test(without), false, '★ 反例的正身：这一句真的能被去掉');
  assert.doesNotMatch(without, /不要问任何人/, '★ 去掉之后那三条就该假');
  // 而且任务书里**不许**留下"等他回话"那种话
  assert.doesNotMatch(packet, /回一句|接着说/, `🔴 任务书里留着"等他回话"的口子：${packet}`);
});

test('🔴 B39-b/c：它停下不交回 ⇒ **自动替它接**（有上限）＋ 主进程那边一步一步留痕', async () => {
  // `job-stall`：子进程每一轮都说"这条我说太长了…你回一句「接着说」"就收口，
  // **从不调 `job_done`**（真机就是这么停住的）。
  const h = await boot({ scenario: 'job-stall' });
  const w = h.worlds.worldFor('u1');
  try {
    assert.equal((await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status, 200);
    const ask = await waitAsk(w);
    assert.equal((await answerJob(h, { id: ask.id, yes: true })).ok, true);

    // 🔴 **有上限**：接满 `JOB_NUDGE_MAX` 次就收手（无限接 ⇒ 这条等不到"没做完"那句）
    await waitFor(
      () => noticesOfKind(w.dir, 'work-nudge').some((e) => /没做完/.test(String(e.text ?? ''))),
      '🔴 接满上限也没如实报"没做完"',
      20000,
    );
    // ① **接的次数正好是上限**（留痕那几句人话各一句）
    const nudges = noticesOfKind(w.dir, 'work-nudge');
    const givenUp = nudges.filter((e) => /没做完/.test(String(e.text ?? '')));
    const handed = nudges.filter((e) => !/没做完/.test(String(e.text ?? '')));
    assert.equal(handed.length, JOB_NUDGE_MAX, `🔴 替它接的次数不是上限那个数：${handed.length}`);
    assert.equal(givenUp.length, 1, `🔴 "没做完"那句说漏了 / 说重了：${JSON.stringify(givenUp.map((g) => g.text))}`);
    // ② 🔴 **不许无限接**：接满之后**它就不再接了**（停在那儿不动）
    //   （它每停一次都说同一句"太长了…" ⇒ 数那一句就是数它停了几轮）
    const stallCount = () =>
      logEvents(w.dir).filter(
        (e) => e.scopeId === 'math-drill' && e.type === 'message/text' && String(e.text ?? '').includes('太长了'),
      ).length;
    const stallsAtGiveUp = stallCount();
    assert.equal(stallsAtGiveUp > 0, true, '★ 反例的正身：它确实停过（上面那几条不是空判）');
    await sleep(700);
    assert.equal(
      stallCount(),
      stallsAtGiveUp,
      `🔴 接满上限之后还在替它接（无限接就是这个形状）：${stallsAtGiveUp} → ${stallCount()}`,
    );
    // ③ **接满还是没交回 ⇒ 登记仍挂在"还在做"**（不许假报做完了）
    assert.equal(w.jobs.forScope('math-drill').status, 'started', '🔴 没交回却记成做完了');
    assert.equal(logEvents(w.dir).some((e) => e.type === 'job/report'), false, '🔴 没交回却落了回报那一帧');
    // ④ 🔴 **留痕是给主进程看的**（那几句 notice 落在主进程那条日志上，不带房间标签）
    for (const e of nudges) {
      assert.equal(e.scopeId, undefined, '🔴 留痕跑到子进程那一间去了（主进程那边看不见）');
      // 🔴 **不许出现内部词**（`06` 禁用词那条：内部短名 / 工作区 / 客户端…）
      assert.doesNotMatch(String(e.text ?? ''), /math-drill/, `🔴 内部短名上了屏：${e.text}`);
      assert.doesNotMatch(String(e.text ?? ''), /工作区|客户端|云端|口令/, `🔴 内部词上了屏：${e.text}`);
    }
    // ⑤ **一条事实一个家**：那一间里**没有**第二份总结（留痕只在主进程）
    const childView = new ScopeView({ timeline: w.timeline.base, scope: 'math-drill' });
    assert.equal(
      childView.readAll().some((e) => e.type === 'notice'),
      false,
      '🔴 主进程那份留痕被抄进了那一间（一条事实两个家）',
    );
  } finally {
    await h.close();
  }
});

test('★ B39-b 的正身：接一句之后它**真的接着做完了**（不是"接了个寂寞"）', async () => {
  const h = await boot({ scenario: 'job-stall-then-done' });
  const w = h.worlds.worldFor('u1');
  try {
    assert.equal((await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status, 200);
    const ask = await waitAsk(w);
    assert.equal((await answerJob(h, { id: ask.id, yes: true })).ok, true);
    // 头一轮它停住了 ⇒ 接一句 ⇒ 第二轮做完了（`job/report` 真落盘）
    await waitFor(() => w.jobs.forScope('math-drill')?.status === 'reported', '接了之后它没接着做完', 20000);
    assert.equal(noticesOfKind(w.dir, 'work-nudge').filter((e) => /没做完/.test(String(e.text ?? ''))).length, 0);
    const said = noticesOf(w.dir).filter((e) => e.kind === 'work-done');
    assert.equal(said.length, 1, `🔴 同一件事说了 ${said.length} 遍（R1.2）`);
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════════
// ★ 108 第④步：**做完自动给他看**（他正开着那一间才打开 · 不在就不抢屏）
// ════════════════════════════════════════════════════════════════

test('🔴 ⑥：做完 ⇒ **他正开着那一间**才推"打开它"（服务端那一半；不在那一间一帧都不推）', async () => {
  const h = await boot({ scenario: 'job' });
  const w = h.worlds.worldFor('u1');
  try {
    // ⚠️ 两条流都先连**主线**（那一间这时还不存在 —— 不存在的房间握手就拒了）。
    //   "他正开着那一间"是**切焦点那一帧**说出来的（客户端收到 `scope/open` 之后做的事）。
    const away = await wsConnect(h, { scope: 'main' }); // 他看别处的那条
    await waitFor(() => away.frames.some((f) => f.type === 'client/hello'), '主线那条流没连上');
    const at = await wsConnect(h, { scope: 'main' }); // 待会儿切到那一间的那条
    await waitFor(() => at.frames.some((f) => f.type === 'client/hello'), '第二条流没连上');

    assert.equal((await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status, 200);
    const ask = await waitAsk(w);
    assert.equal((await answerJob(h, { id: ask.id, yes: true })).ok, true);
    await waitFor(() => w.workspaces.has('math-drill'), '那一间没建出来');
    // ★ **他切到那一间**（与客户端收到 `scope/open` 之后走的是同一条路）
    at.ws.send(JSON.stringify({ t: 'focus', scope: 'math-drill', sinceSeq: 0 }));
    await waitFor(() => w.dispatcher.focusFor(null).scope === 'math-drill', '焦点没切过去');

    await waitFor(() => w.jobs.forScope('math-drill')?.status === 'reported', '子进程没交回总结', 20000);

    // 🔴 **判据本体**：正开着那一间的那条流收到了"打开它"那一帧
    await waitFor(() => at.frames.some((f) => f.type === APP_OPEN), '🔴 他正开着那一间，却没自动打开');
    const frame = at.frames.find((f) => f.type === APP_OPEN);
    assert.equal(frame.app, 'math-drill', `🔴 打开的是哪一个没说清：${JSON.stringify(frame)}`);
    assert.equal(typeof frame.text, 'string', '★ 旁边那句总结要在帧上（客户端照抄服务端给的原话）');
    assert.match(String(frame.text), /做完了/);
    assert.equal(frame.seq, undefined, '★ 瞬态：不占号（那一间里**不会多出第二份总结**）');
    // 🔴 **不落盘**：总结的家只有主进程那一条 `job/report`（一条事实一个家）
    assert.equal(
      logEvents(w.dir).some((e) => e.type === APP_OPEN),
      false,
      '🔴 "打开它"那一帧落盘了 —— 补发时就会乱开一次',
    );
    // ★ 负向对照：主进程那条日志上**确实**有那句总结（不是"什么都没说"那种假绿）
    assert.equal(noticesOf(w.dir).some((e) => e.kind === 'work-done' && /做完了/.test(String(e.text ?? ''))), true);
    at.ws.close();
    away.ws.close();
  } finally {
    await h.close();
  }
});

test('🔴 ⑥b：他**不在**那一间 ⇒ 一帧都不推（连"正巧也开着那一间"的那条连接也不许收到）', async () => {
  // ⚠️ **为什么非要单来一条**：光看"主线那条连接没收到"是**空的** ——
  //    那一帧带 `scopeId = 那一间`，实时路由（`eventInScope`）本来就会把它筛掉，
  //    所以"没收到"证明不了服务端判过"他在不在那一间"。
  //    ⇒ 这里摆一条**焦点就在那一间**的连接：服务端只要推了，它一定收得到。
  //      （第一版就是这么写的，变异验证时它没红 —— 判据是假的。）
  // ⚠️ 让子进程慢一点交回（阈值住假 agent；这里只是把"报告"挪到焦点摆好之后），
  //    否则"报告先到、焦点后摆"那种竞态会让这条判据偶尔空转。
  const h = await boot({ scenario: 'job', job: { delay: 1200 } });
  const w = h.worlds.worldFor('u1');
  try {
    const watcher = await wsConnect(h, { scope: 'main' });
    await waitFor(() => watcher.frames.some((f) => f.type === 'client/hello'), '探针那条流没连上');

    assert.equal((await post(h, '/api/say', { messageId: 'u_job', text: '帮我做一个练算数的小程序' })).status, 200);
    const ask = await waitAsk(w);
    assert.equal((await answerJob(h, { id: ask.id, yes: true })).ok, true);
    await waitFor(() => w.workspaces.has('math-drill'), '那一间没建出来');
    // ★ 探针**切到那一间**（它会收到推到那一间的任何一帧）……
    watcher.ws.send(JSON.stringify({ t: 'focus', scope: 'math-drill', sinceSeq: 0 }));
    await waitFor(() => w.dispatcher.focusFor(null).scope === 'math-drill', '探针焦点没切过去');
    // ……而**他最后被告知在看的是主线**（另一条连接刚说的）⇒ "他不在那一间"。
    const elsewhere = await wsConnect(h, { scope: 'main' });
    await waitFor(() => elsewhere.frames.some((f) => f.type === 'client/hello'), '第二条流没连上');
    await waitFor(() => w.dispatcher.focusFor(null).scope === 'main', '焦点没回到主线');

    // ★ 现在才等"报告"（子进程慢着，见上面那个 delay）——这一下焦点**确定**是主线
    assert.equal(w.jobs.forScope('math-drill')?.status, 'started', '子进程太快了：这条判据要它在焦点摆好之后才交回');
    await waitFor(() => w.jobs.forScope('math-drill')?.status === 'reported', '子进程没交回总结', 20000);
    await sleep(300); // 让它该推的那一下推完（没有的话就是没有）

    // 🔴 **判据本体**：他不在那一间 ⇒ **一个字节都没推**（推了的话探针当场收到）
    assert.equal(
      watcher.frames.some((f) => f.type === APP_OPEN),
      false,
      `🔴 他不在那一间，服务端还是把"打开它"推了（抢屏）：${JSON.stringify(watcher.frames.map((f) => f.type))}`,
    );
    // ★ 负向对照：探针那条连接**是活的**（不是"什么都没连上"那种假绿）
    assert.equal(
      watcher.frames.some((f) => f.type === 'client/focus' && f.ok === true),
      true,
      '★ 探针那条连接根本没被服务端认下来（上面那条就是空判）',
    );
    // ★ 而"报告"这件事**真的发生了**（不是"活还没干完"那种假绿）
    assert.equal(logEvents(w.dir).some((e) => e.type === 'job/report'), true);
    // ⚠️ 报告那一刻**已经过去了** ⇒ 事后切回去不许凭空补一次（那不是"正开着"）
    watcher.ws.send(JSON.stringify({ t: 'focus', scope: 'main', sinceSeq: 0 }));
    await waitFor(() => w.dispatcher.focusFor(null).scope === 'main', '焦点没回主线');
    watcher.ws.send(JSON.stringify({ t: 'focus', scope: 'math-drill', sinceSeq: 0 }));
    await waitFor(() => w.dispatcher.focusFor(null).scope === 'math-drill', '焦点没回那一间');
    await sleep(200);
    assert.equal(
      watcher.frames.filter((f) => f.type === APP_OPEN).length,
      0,
      '🔴 事后切回去还补了一次"打开它"（那不是"正开着"，是回头补抢）',
    );
    watcher.ws.close();
    elsewhere.ws.close();
  } finally {
    await h.close();
  }
});

// ════════════════════════════════════════════════════════════════
// 反例的正身集合（纯判据：把这些闸"改成错的形状" ⇒ 当场假）
// ════════════════════════════════════════════════════════════════

test('★ 反例的正身：裁决／总结／重建这三处的形状（改回错的形状 ⇒ 当场假）', () => {
  // ── 派活裁决（`decideJobStart`）──────────────────────────────
  assert.deepEqual(
    decideJobStart({ by: 'main', where: 'math-drill', targetExists: false }),
    { ok: true, where: 'math-drill' },
    '★ 负向对照：干净的名字、主进程发起 ⇒ 放行（证明下面几条不是恒假）',
  );
  // 已经有一处了 ⇒ 拒（"派活"是新建；交给已有那一间是**转交**那件事）
  assert.equal(decideJobStart({ by: 'main', where: 'math-drill', targetExists: true }).reason, 'exists');
  // 子进程里不许再派一层
  assert.equal(decideJobStart({ by: 'math-drill', where: 'other', targetExists: false }).reason, 'nested');
  assert.equal(JOB_LINES.nested, decideJobStart({ by: 'math-drill', where: 'other' }).text);
  // 中文名字 / 大写 / 空 ⇒ 认不出（**不猜**）
  for (const bad of ['算数小练', 'MathDrill', '', '  ', '-x', 'a b']) {
    assert.equal(
      decideJobStart({ by: 'main', where: bad, targetExists: false }).reason,
      'badName',
      `🔴 "${bad}" 被当成合法短名了`,
    );
  }
  // 保留名（桌面上那几格）不许拿去当新的一处
  assert.equal(decideJobStart({ by: 'main', where: 'settings', targetExists: false }).reason, 'reserved');
  assert.equal(decideJobStart({ by: 'main', where: 'main', targetExists: false }).reason, 'badName');

  // ── 那条总结（`jobSummaryText`）────────────────────────────
  const said = jobSummaryText({ name: '算数小练', summary: '能出题' });
  assert.match(said, /能出题/);
  assert.match(said, /算数小练/);
  // 🔴 名字**只从它交上来的那个字段**来：换个名字，那句话跟着换（证明它不是从别处取的）
  assert.match(jobSummaryText({ name: '另一个名字', summary: '能出题' }), /另一个名字/);
  // ⚠️ 没依据的时间词不重复（P1 那条纪律），但"叫什么／在哪看"照旧留着
  const timed = jobSummaryText({ name: '算数小练', summary: '大概三分钟就能做完' }, { hasTimeClaim: (t) => /三分钟/.test(t) });
  assert.doesNotMatch(timed, /三分钟/, `🔴 没依据的时间话被重复了：${timed}`);
  assert.match(timed, /算数小练/);

  // ── 从日志重建（`jobRowsFromEvents`）────────────────────────
  const events = [
    { type: 'job/start', id: 'j1', where: 'a', at: 1, why: '帮我做一个' },
    { type: 'job/report', id: 'j1', where: 'a', at: 2, name: '甲', summary: '做成了' },
    { type: 'message/text', text: '这段对话不该进登记' },
  ];
  const rows = jobRowsFromEvents(events);
  assert.equal(rows.get('a').status, 'reported');
  assert.equal(rows.get('a').name, '甲');
  assert.equal(rows.get('a').summary, '做成了');
  assert.equal(rows.get('a').why, '帮我做一个', '★ 由来也要能从日志里重扫出来');
  // 🔴 反例的正身：**只把总结写进登记、不落日志** ⇒ 重扫就是空的（判据当场假）
  assert.equal(jobRowsFromEvents(events.filter((e) => e.type !== 'job/report')).get('a').name, null);

  // ── 那份任务书（`jobPacketText`）──────────────────────────
  const packet = jobPacketText({ where: 'math-drill', why: '帮我做一个练算数的小程序' });
  assert.match(packet, /帮我做一个练算数的小程序/, '🔴 原话丢了');
  assert.match(packet, /别把过程抄一遍/, '★ 要交代"只交总结"（P3 那半）');

  // ── ⑤"现在该看哪一间"那一帧 ────────────────────────────────
  const open = scopeOpenEvent({ scope: 'math-drill', at: 7 });
  assert.deepEqual(open, { type: 'scope/open', scope: 'math-drill', at: 7 });
  // 🔴 **字段不许叫 `scopeId`**：那条流的实时路由按 `scopeId` 筛房间
  //    （`timeline.js` 的 `eventInScope`）⇒ 叫 `scopeId` 就会被"焦点在主线"的连接丢掉。
  assert.equal('scopeId' in open, false, '🔴 叫成 scopeId 就会被焦点路由丢掉（最该收到的人收不到）');
  assert.equal(SCOPE_OPEN, 'scope/open');
});
