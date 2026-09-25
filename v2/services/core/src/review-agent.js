// **评审 agent：真把 DSH 起来，让它读整份源码给总结／风险点／评级** ——
// 契约 `docs/dev/93-OUTBOUND-USAGE.md` §三／§六 · 主人 2026-09-25 第 1／3／3b／4 条
// （`docs/dev/96-OWNER-DECISIONS.md`）。
//
// ── 这一篇补的是哪一条缺口 ────────────────────────────────
// `review.js` 那一套（规则／申报／扫描／放行裁决／`review.jsonl`）已经在树上，
// 但 `cfg.reviewAgent` 是 `null` ⇒ **预审没有真模型调用** ⇒ 一律 `escalate`
// （fail-closed 是对的，可"审核等于没跑"）。这里把**真的那一次调用**接上：
// 用盒里那台 DSH（`cfg.dshBin` ＋ `--profile sdk`），把**源码与申报**喂给它。
//
// ── 三条不许破（对着主人拍的四条）─────────────────────────
//   ① 🔴 **`--patch` 是全局选项，必须写在 `--profile` 之后**（照 `harness-session.mjs`
//      的 `harnessArgs()`）。挂的**只有模型那条 patch** —— **不挂人格、不挂能力层**：
//      评审要的是"一个中立的读者"，不是琥珀，更不能带着小程序那几条能写盘的工具。
//   ② 🔴 **评审是看，不是写**（本批点名要钉住的那一条）：
//      · 进程的 cwd 是一个**一次性的临时目录**（`mkdtemp`），**不是**这个 app 的工作区；
//      · 源码是**当正文喂进去的**（不是"让它自己去读那个目录"）；
//      · 跑完再把工作区**逐文件 sha 核一遍** —— 变了一个字节就 `unavailable`
//        ⇒ `preReview` 转成 **escalate**（不许"审着审着把东西改了"还当审过了）。
//   ③ 🔴 **算力记到这个 app 头上**（主人第 3 条：预审吃的是用户自己的算力）：
//      它接 `UsageLedger`，把这一轮上游回来的 `usage` 记进 `<id>/usage.jsonl`
//      （`kind:'agent-turn'`，三格 token 照 `usage.js` 的口径拆）。
//      ⚠️ **运营方那一侧的复评不记到用户头上**（那是平台的账）⇒ `who:'operator'` 的
//      调用点传 `usage:null`（`worlds.js` 就是这么接的）。
//
// ── 认不出 ⇒ `{unavailable}` ⇒ escalate（fail-closed）────────
// 起不来 / 超时 / 回的正文不是一份 JSON / 结论字段认不出 / 动了工作区 ——
// **每一种都**回一个 `{unavailable: 人话}`，`review.js` 把它变成 `escalate`。
// **绝不许**因为"审不了"就当审过了。

import { spawn as nodeSpawn } from 'node:child_process';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

// ⚠️ 只借 `childEnv()` 那个**纯函数**（摘密钥 ＋ 给 `DSH_HOME`）——
//    同 `harness-session.mjs` 的理由：密钥绝不进这个进程的环境。
import { childEnv } from './agent-runtime.js';
import { USAGE_KINDS } from './usage.js';

/** 一次评审的兜底上限。⚠️ `cfg.reviewTimeoutMs` 给了就按给的（判据要能把它调小）。 */
export const REVIEW_AGENT_TIMEOUT_MS = 120_000;

/** 评审那次调用的计费口径（主人第 8 条：对外一个数；这里只是标记它算哪一类）。 */
export const REVIEW_AGENT_USAGE_KIND = USAGE_KINDS.agentTurn;

/** 一次性工作目录的前缀（判据拿它验证"cwd 不是工作区、而且跑完就清"）。 */
export const REVIEW_WORKDIR_PREFIX = 'hupo-review-';

/** 一个文件喂进去的正文上限（防呆：评审不是"把整个仓库塞进上下文"）。 */
export const REVIEW_MAX_FILE_CHARS = 200_000;

/**
 * **造那份给评审的正文**（纯函数 —— 判据可以直接钉它）。
 *
 * 它把**规则里要审的东西**（`checks` / `categories` / `rating`）＋ **整份源码** ＋
 * **制品里的 `outbound.json`** ＋ 代码扫描命中的出网点，一次性摆给模型；
 * 并**钉死输出形状**（一个 JSON：`summary` / `risks` / `rating` / `verdict`）。
 *
 * 🔴 源码是**正文**（不是路径）：评审进程因此**不需要**去碰工作区。
 *
 * @param {object} o
 * @param {string} o.id
 * @param {number|null} [o.version]
 * @param {string|null} [o.rootHash]
 * @param {Record<string, Buffer|string>} [o.files]
 * @param {object|null} [o.decl]     `parseOutboundDeclaration()` 的结果
 * @param {Array<object>} [o.points] `scanOutboundPoints()` 的结果
 * @param {object|null} [o.policy]   产品层那份规则（`loadReviewPolicy()` 的结果）
 * @returns {string}
 */
export function buildReviewPrompt({ id, version = null, rootHash = null, files = {}, decl = null, points = [], policy = null } = {}) {
  const rules = policy?.rules ?? {};
  const cats = Array.isArray(rules.categories) ? rules.categories : [];
  const checks = Array.isArray(rules.checks) ? rules.checks : [];
  const rating = rules.rating ?? {};
  const lines = [];

  lines.push('你是**只读的代码评审**。把下面这一版小程序的**全部源码**读一遍，');
  lines.push('按给定的检查项与评级口径，给出**总结、风险点、评级**。');
  lines.push('');
  lines.push('🔴 三条硬规矩：');
  lines.push('1. **你只能看**：不许改任何文件、不许执行命令、不许联网 —— 你的回答里只有结论。');
  lines.push('2. **只输出一个 JSON 对象**：不要解释、不要前后缀、不要多余的话。');
  lines.push('3. **说不清就如实说**（把评级给高一点），**不许猜**。');
  lines.push('');
  lines.push('## 要评的这一版');
  lines.push(`- id：${String(id ?? '').slice(0, 80)}`);
  lines.push(`- version：${version === null || version === undefined ? '（读不出）' : version}`);
  lines.push(`- rootHash：${rootHash === null || rootHash === undefined ? '（读不出）' : rootHash}`);
  lines.push(`- 规则版本：${typeof rules.version === 'string' ? rules.version : '（规则里没写）'}`);
  lines.push('');
  lines.push('## 检查项（逐项过；有一条说不清就把评级给高）');
  if (cats.length > 0) {
    for (const c of cats) {
      lines.push(`- 【${String(c?.id ?? '?')}】${String(c?.title ?? '')}：${String(c?.ask ?? '')}`);
    }
  } else {
    lines.push(`- ${checks.join(' / ') || '（规则里没给检查项 —— 这一条本身就是问题）'}`);
  }
  lines.push('');
  lines.push('## 评级口径');
  lines.push(`- 0–${Number.isFinite(rating?.scale?.max) ? rating.scale.max : 5} 的整数：${String(rating?.meaning ?? '0 = 没看到风险；5 = 必须拦下来')}`);
  lines.push(`- ${String(rating?.autoPass ?? '评级低 ⇒ 可以自动放行')}`);
  lines.push(`- ${String(rating?.escalate ?? '评级高 ⇒ 找主人')}`);
  lines.push(`- ${String(rating?.reject ?? '申报不可核 / 扫到未申报的出网点 ⇒ 拒')}`);
  lines.push(`- 读不出东西时：${String(rules.onUnreadable ?? 'escalate')}`);
  lines.push('');
  lines.push('## 外联申报（制品里的 outbound.json —— 作者自己写的，**不是**事实）');
  lines.push(decl ? JSON.stringify(decl, null, 2) : '（读不到申报 —— 这本身就是一个大风险）');
  lines.push('');
  lines.push('## 代码扫描命中的出网点（字符串层面，不看语义）');
  if (Array.isArray(points) && points.length > 0) {
    for (const p of points) lines.push(`- ${String(p?.kind ?? '?')} · ${String(p?.path ?? '?')} · ${String(p?.what ?? '?')}`);
  } else {
    lines.push('（零命中）');
  }
  lines.push('');
  lines.push('## 整份源码');
  const entries = Object.entries(files ?? {});
  if (entries.length === 0) {
    lines.push('（这一版一个文件都没有 —— 这本身就是一个风险）');
  }
  for (const [rel, content] of entries) {
    lines.push('');
    lines.push(`### 文件：${rel}`);
    lines.push('```');
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');
    lines.push(text.length > REVIEW_MAX_FILE_CHARS ? `${text.slice(0, REVIEW_MAX_FILE_CHARS)}\n…（这个文件太长，后面截掉了）` : text);
    lines.push('```');
  }
  lines.push('');
  lines.push('## 你要回的那一个 JSON（**只有它**）');
  lines.push('{"summary":"一句话总结","risks":["一条风险点"],"rating":0,"verdict":"pass"}');
  lines.push('· `verdict` 只许是 "pass"（可以放行）或 "reject"（必须拦下来）；');
  lines.push('· `rating` 是上面那个量程里的整数；`risks` 是字符串数组（没有就给空数组）。');
  return lines.join('\n');
}

/**
 * **从模型回的那段正文里把这一个 JSON 抠出来**（纯函数）。
 *
 * 认得三种摆法（不猜）：整段就是 JSON ／ 包在 ``` 里 ／ 夹在别的话中间。
 * 认不出 ⇒ `null`（调用方转 `unavailable` ⇒ escalate）。
 */
export function extractReviewAnswer(text) {
  const s = typeof text === 'string' ? text : '';
  if (s.trim() === '') return null;
  const candidates = [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fence?.[1]) candidates.push(fence[1]);
  candidates.push(s);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const j = JSON.parse(c.trim());
      if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    } catch {
      /* 换下一种摆法 */
    }
  }
  return null;
}

/** 一个目录的**逐文件 sha256**（相对路径 → 摘要）。读不到 ⇒ 空表（不猜）。 */
export function snapshotTree(dir, { fs = nodeFs } = {}) {
  const out = new Map();
  if (typeof dir !== 'string' || dir === '') return out;
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(nodePath.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(next);
        continue;
      }
      try {
        const buf = fs.readFileSync(nodePath.join(dir, next));
        out.set(next, nodeCrypto.createHash('sha256').update(buf).digest('hex'));
      } catch {
        out.set(next, '（读不出来）');
      }
    }
  };
  walk('');
  return out;
}

/** 两份快照比一比：变了哪些相对路径（增 / 删 / 改都算）。一样 ⇒ 空数组。 */
export function changedFiles(before, after) {
  const out = [];
  const keys = new Set([...(before?.keys?.() ?? []), ...(after?.keys?.() ?? [])]);
  for (const k of keys) {
    if (before?.get?.(k) !== after?.get?.(k)) out.push(k);
  }
  return out.sort();
}

/** 一次临时目录（0700）——评审进程的 cwd。 */
function makeWorkDir(base) {
  const root = typeof base === 'string' && base !== '' ? base : nodeOs.tmpdir();
  return nodeFs.mkdtempSync(nodePath.join(root, REVIEW_WORKDIR_PREFIX));
}

/**
 * 🔴 **盒内新建的目录要交给 agent 的 uid**（`81-HARNESS-ENTRY.md` §9.3 的同一条纪律）。
 *
 * 为什么非做不可：盒里的服务是 root，`mkdtemp` 建出来的目录是 `root:root 0700`；
 * 而评审那个 DSH 是**换了手**起的（`uid: cfg.agentUid`）⇒ 它**进不去自己的 cwd**
 * （EACCES / 说成"工作目录不存在"），现象只是"评审没跑起来"，极难查。
 *
 * @returns {string|null} 出错时一句人话（调用方转 `unavailable` ⇒ escalate）
 */
function handWorkDirToAgent(dir, cfg) {
  const uid = cfg?.agentUid;
  if (uid === null || uid === undefined) return null; // 宿主上不换手 ⇒ 不用交
  try {
    nodeFs.chownSync(dir, uid, cfg?.agentGid ?? uid);
    nodeFs.chmodSync(dir, 0o700);
    return null;
  } catch (err) {
    return `评审的临时目录交不给它该有的身份（uid ${uid}）：${err?.message ?? err}`;
  }
}

function cleanupWorkDir(dir, log) {
  if (typeof dir !== 'string' || dir === '') return;
  try {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log(`评审的临时目录没清掉（${dir}）：${err?.message ?? err}`);
  }
}

/**
 * **和那台 DSH 说一轮**（起进程 → `initialize` → `session/prompt` → 收正文与 usage → 收进程）。
 *
 * ⚠️ 形状照 `harness-session.mjs`：`--profile` 在前、`--patch` 在后；
 *    `session/event` 用**点**、`session/prompt` 用**斜杠**（两边都认，免得再踩）。
 */
export function converseWithReviewDsh({
  cfg = {},
  cwd,
  prompt,
  spawnFn = nodeSpawn,
  uuid = () => nodeCrypto.randomUUID(),
  timeoutMs = REVIEW_AGENT_TIMEOUT_MS,
  killGraceMs = 1000,
  log = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--profile', String(cfg.agentProfile || 'sdk')];
    // 🔴 `--patch` 是**全局选项**，必须写在 `--profile` 之后（照 `harness-session.mjs`）。
    //    ⚠️ **只挂模型那条** —— 人格 / 能力层一律不挂（评审是中立读者、且不带写盘工具）。
    if (cfg.modelPatchPath) args.push('--patch', cfg.modelPatchPath);

    let child;
    try {
      child = spawnFn(cfg.dshBin, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // ★ **换手**（盒里服务是 root ⇒ 不换手等于边界不在；宿主上 `null` = 不换）
        ...(cfg.agentUid !== null && cfg.agentUid !== undefined ? { uid: cfg.agentUid } : {}),
        ...(cfg.agentGid !== null && cfg.agentGid !== undefined ? { gid: cfg.agentGid } : {}),
        env: childEnv({ home: cfg.dshHome }),
      });
    } catch (err) {
      reject(err);
      return;
    }

    const sessionId = uuid();
    const pending = new Map();
    let nextId = 0;
    let buf = '';
    let text = '';
    let usage = null;
    let stderrTail = '';
    let settled = false;

    const timer = setTimeout(() => finish(new Error(`评审超时（${timeoutMs}ms）`)), timeoutMs);
    timer.unref?.();

    /** 收干净：先请它自己走，到点还在就 SIGKILL（同 `harness-session.mjs` 的取舍）。 */
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method: 'shutdown' })}\n`);
      } catch {
        /* 已经死了 */
      }
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经没了 */
        }
      }, killGraceMs);
      t.unref?.();
      child.once('exit', () => clearTimeout(t));
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(t);
      }
      if (err) reject(err);
      else resolve(value);
    }

    child.on('error', (err) => {
      finish(
        err?.code === 'ENOENT'
          ? new Error(
            `起不来：可能是【找不到 dsh 程序】(${cfg.dshBin ?? 'dsh'})或【工作目录不存在】(${cwd})——`
              + '这两件事在 spawn 里报的是同一句话',
          )
          : err,
      );
    });
    child.stdin?.on?.('error', () => {});
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (d) => {
      stderrTail = `${stderrTail}${d}`.slice(-600);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // 不是 JSON-RPC 消息（stderr 才该有这种东西）
        }
        if (!msg || typeof msg !== 'object') continue;
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
          else p.resolve(msg.result);
          continue;
        }
        // ⚠️ 通知的方法名用「点」（同 `agent-runtime.js` 那段踩过的坑）
        if (msg.method === 'session.event' || msg.method === 'session/event') {
          const ev = msg.params?.event;
          if (ev?.type === 'assistant/message') {
            const content = ev.data?.message?.content;
            if (Array.isArray(content)) {
              for (const b of content) {
                if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
              }
            }
            if (usage === null && ev.data?.usage) usage = ev.data.usage;
          }
          if (ev?.type === 'turn/end') {
            if (text.trim() !== '') finish(null, { text, usage });
            else {
              finish(
                new Error(
                  `评审一句话都没说${stderrTail ? `（它最后说的话：${stderrTail.trim().slice(-200)}）` : ''}`,
                ),
              );
            }
            return;
          }
        }
      }
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      finish(
        new Error(
          `评审那个进程退出了（code=${code ?? '—'}${signal ? `，signal=${signal}` : ''}）`
            + `${stderrTail ? `；它最后说的话：${stderrTail.trim().slice(-200)}` : ''}`,
        ),
      );
    });

    const request = (method, params) => new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { resolve: res, reject: rej });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        pending.delete(id);
        rej(err);
      }
    });

    (async () => {
      await request('initialize', {
        cwd,
        provider: cfg.agentProvider,
        model: cfg.agentModel,
        reasoningEffort: cfg.agentEffort,
        maxTokens: cfg.agentMaxTokens,
      });
      await request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: prompt }] });
    })().catch((err) => finish(err));
  });
}

/**
 * **造一个评审 agent**（`review.js` 要的那个形状：`async ({id, files, decl, points, policy}) => verdict`）。
 *
 * @param {object} o
 * @param {object} o.cfg        `config.js` 那份（`dshBin` / `agentProfile` / `modelPatchPath` /
 *   `dshHome` / `agentUid` / `agentGid` / `agentProvider` / `agentModel` / `agentEffort` /
 *   `agentMaxTokens`；`reviewTimeoutMs` 可选）
 * @param {object|null} [o.usage]  `UsageLedger`（**给了就记到这个 app 头上** —— 主人第 3 条）
 * @param {'pre'|'operator'} [o.who] 预审（用户的算力）／运营方复评（平台的账）
 * @param {string|((id:string)=>string)|null} [o.guardDir] **不许被动的那一格**
 *   （预审给这个 app 的工作区；跑完逐文件核 sha）
 * @param {Function} [o.spawnFn]  注入用（判据里跑假 DSH）
 * @returns {(args: object) => Promise<object>} 结论对象，或者 `{unavailable: 人话}`
 */
export function createDshReviewAgent({
  cfg = {},
  usage = null,
  who = 'pre',
  guardDir = null,
  spawnFn = nodeSpawn,
  uuid = () => nodeCrypto.randomUUID(),
  log = () => {},
  timeoutMs = null,
} = {}) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : (Number.isFinite(cfg.reviewTimeoutMs) && cfg.reviewTimeoutMs > 0 ? cfg.reviewTimeoutMs : REVIEW_AGENT_TIMEOUT_MS);
  const dirFor = typeof guardDir === 'function' ? guardDir : () => guardDir;

  return async function reviewAgent({
    id,
    version = null,
    rootHash = null,
    files = {},
    decl = null,
    points = [],
    policy = null,
    turn = null,
  } = {}) {
    const guard = dirFor(id);
    const before = guard ? snapshotTree(guard) : null;
    let workDir = null;
    try {
      workDir = makeWorkDir(cfg.reviewWorkDir);
    } catch (err) {
      return { unavailable: `评审起不来：临时目录建不出（${err?.message ?? err}）` };
    }
    // 🔴 盒里服务是 root ⇒ 建出来的目录要先**交给 agent 的 uid**，否则换了手的评审进不去
    const handErr = handWorkDirToAgent(workDir, cfg);
    if (handErr) {
      cleanupWorkDir(workDir, log);
      return { unavailable: `${handErr} —— 这次不自动放行` };
    }

    let got = null;
    let err = null;
    try {
      got = await converseWithReviewDsh({
        cfg,
        cwd: workDir,
        prompt: buildReviewPrompt({ id, version, rootHash, files, decl, points, policy }),
        spawnFn,
        uuid,
        timeoutMs: ms,
        log,
      });
    } catch (e) {
      err = e;
    }

    // 🔴 **算力记到这个 app 头上**（主人第 3 条）：只要真起了模型就记一笔 ——
    //    **成没成都记**（调用发生了就是花了）；记账自己出错**不许挡评审**（93 §4.5.5）。
    if (usage && typeof usage.note === 'function') {
      try {
        usage.note(id, {
          kind: REVIEW_AGENT_USAGE_KIND,
          usage: got?.usage ?? null,
          calls: 1,
          source: who === 'operator' ? 'operator' : 'box',
          turn,
        });
      } catch {
        /* 记账失败不挡评审 */
      }
    }

    cleanupWorkDir(workDir, log);

    // 🔴 **评审是看，不是写**：跑完核一遍 —— 变了就**不自动放行**（点名是哪几个文件）。
    if (guard) {
      const changed = changedFiles(before, snapshotTree(guard));
      if (changed.length > 0) {
        return {
          unavailable: `评审动了不该动的东西（${changed.slice(0, 5).join('、')}${changed.length > 5 ? ` 等 ${changed.length} 个文件` : ''}）—— 这次不自动放行，请主人看一眼`,
        };
      }
    }

    if (err) return { unavailable: `评审没跑起来（${err?.message ?? err}）` };
    const parsed = extractReviewAnswer(got?.text);
    if (!parsed) return { unavailable: '评审回的结论认不出（不是一份 JSON）—— 这次不自动放行' };
    return parsed;
  };
}
