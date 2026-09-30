// **小程序定时任务**（注册制 · 主人 2026-09-30：*「这些功能都要有」* · 契约 `docs/dev/148-APP-FULL-SET.md` §四）。
//
// ── 它是什么 ──────────────────────────────────────────────
//   制品在清单里**声明**"我每天/每半小时想让助手替我做一件事"（`tasks`）：
//   ⇒ **声明了就能用**（傻瓜式，跟别的一样；他能关掉）· 跑在**他自己的盒子里** ·
//   **串行 ＋ 限额**（一次只跑一件、每天有个上限）· 结果**回到那一间的对话**（他看得见）。
//
// ── 🔴 四条不许破 ──────────────────────────────────────────
//   ① **注册制**：没声明 `tasks`（或他关掉了）⇒ **一次都不跑**（判据 T3/T4）；
//   ② **先记再跑**：**先把这一笔记在账上**（`apps.recordTask`）再去干活 —— 宁可少跑一次，
//      也不许"跑了没记"（那会变成"重来一遍"或"一天跑十次"）；
//   ③ **串行**：一个人那一圈里**一次只起一件**（盒子只有那么点内存；也免得两件同时改一个文件）；
//   ④ **结果回对话**：交给那一间的助手去做 ⇒ 他怎么答就落在那一条对话里（**不是**暗线）。
//
// ⚠️ **数字只住这一处**（手册纪律 1）：间隔、每天几次、最多几件、多久看一次，全在下面。
// ⚠️ **它不做**：不做 cron 那种秒级调度（盒子不是那种机器）；不保证"到点一定跑"
//    （服务没起来就跳过 —— 起来之后按"下一次"排，**不补跑**）。这两条**如实说**在契约里。

/** 一个 app 最多声明几件定时任务。 */
export const MAX_TASKS_PER_APP = 3;

/** 两次之间最少隔多久（比这更频的声明**直接拒**：那不是"定时"，那是轮询）。 */
export const MIN_TASK_EVERY_MS = 30 * 60_000;

/** 一件任务的"让它干什么"最多多少字。 */
export const MAX_TASK_PROMPT_CHARS = 500;

/** 一件任务的名字最多多少字。 */
export const MAX_TASK_TITLE_CHARS = 40;

/** 一个 app 每天最多跑几次（**所有任务合起来**算）。 */
export const TASKS_PER_DAY = 6;

/** 调度器多久看一次（约数；看一次很便宜 —— 没声明任务的 app 直接跳过）。 */
export const TASK_TICK_MS = 60_000;

/** 交给助手那一句开头的标记（他**看得见**这是小程序的任务，不是他自己说的）。 */
export const TASK_MARK = '来自小程序定时任务';

/** 任务 id 的形状（它只住在这份清单里，不上屏）。 */
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * **一份任务清单过一遍**（纯函数 · **只有这一处**）。
 *
 * @param {unknown} raw
 * @returns {{ok:true, tasks:Array<{id:string,title:string,everyMs:number,prompt:string}>}
 *          | {ok:false, text:string}}
 */
export function checkTaskList(raw) {
  if (raw === undefined || raw === null) return { ok: true, tasks: [] };
  if (!Array.isArray(raw)) return { ok: false, text: '定时任务得列一个清单。' };
  if (raw.length > MAX_TASKS_PER_APP) return { ok: false, text: `最多 ${MAX_TASKS_PER_APP} 件定时任务。` };
  const out = [];
  const seen = new Set();
  for (const one of raw) {
    if (!one || typeof one !== 'object') return { ok: false, text: '清单里有一件看不懂。' };
    const id = typeof one.id === 'string' ? one.id.trim() : '';
    if (!TASK_ID_RE.test(id)) return { ok: false, text: '每一件要有自己的短名（小写字母/数字/短横）。' };
    if (seen.has(id)) return { ok: false, text: `有两件重名了：${id}` };
    seen.add(id);
    const title = typeof one.title === 'string' ? one.title.trim() : '';
    if (title === '' || title.length > MAX_TASK_TITLE_CHARS) {
      return { ok: false, text: `每一件都要有个名字（不超过 ${MAX_TASK_TITLE_CHARS} 个字）。` };
    }
    const prompt = typeof one.prompt === 'string' ? one.prompt.trim() : '';
    if (prompt === '' || prompt.length > MAX_TASK_PROMPT_CHARS) {
      return { ok: false, text: `每一件都要写清"让它干什么"（不超过 ${MAX_TASK_PROMPT_CHARS} 个字）。` };
    }
    /**
     * 间隔：只认整数分钟，而且**不许比下限更频**（更频的声明是**拒**，不是"夹到下限"：
     * 偷偷夹住会让他以为"我设的每 5 分钟生效了"，那是页面在说假话）。
     *
     * ⚠️ **也认已经归一过的 `everyMs`**：`meta()` 交回来的就是那个形状 ——
     *    "装上来 / 复制一份 / 迁移"会把**读出来那一份**再喂进 `register`/`create`，
     *    只认 `everyMinutes` 的话那条路会**当场被拒**（装了带任务的小程序就报错）。
     */
    const everyMin = Number(one.everyMinutes);
    const everyMsRaw = Number(one.everyMs);
    const everyMs = Number.isInteger(everyMin)
      ? everyMin * 60_000
      : (Number.isInteger(everyMsRaw) ? everyMsRaw : NaN);
    if (!Number.isFinite(everyMs) || everyMs < MIN_TASK_EVERY_MS) {
      return { ok: false, text: `每件事之间至少要隔 ${Math.round(MIN_TASK_EVERY_MS / 60_000)} 分钟。` };
    }
    out.push({ id, title, everyMs, prompt });
  }
  return { ok: true, tasks: out };
}

/** 那一天（按 `at` 算）。 */
function dayOf(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * **现在该跑哪几件**（纯函数：不碰盘、不花钱、不认识人）。
 *
 * 规则（逐条都有判据）：
 *   · 没声明过 / 他关掉了（`allowed !== true`）⇒ **一件都不跑**；
 *   · 这一本账里**没跑过**（新声明的）⇒ **这次就该跑**（他当场看得到它真的会动）；
 *   · 跑过 ⇒ 到 `lastAt + everyMs` 才算到期；
 *   · 今天已经跑满 `maxPerDay` ⇒ 不跑（**明天再看**）；
 *   · 一次只给一件（`limit`）—— **串行**那条闸在这儿。
 *
 * @param {object} o
 * @param {Array<{id:string, everyMs:number}>} o.tasks
 * @param {Record<string, {lastAt?:number, nextAt?:number, day?:string, n?:number}>} o.state
 * @param {number} o.now
 * @param {boolean} o.allowed
 * @param {number} [o.maxPerDay]
 * @param {number} [o.limit]
 * @returns {Array<object>} 该跑的那几件（最多 `limit` 件）
 */
export function dueTasks({ tasks, state, now, allowed, maxPerDay = TASKS_PER_DAY, limit = 1 }) {
  if (allowed !== true) return [];
  const list = Array.isArray(tasks) ? tasks : [];
  const st = state && typeof state === 'object' ? state : {};
  const day = dayOf(now);
  // 今天这个 app 一共跑了几次（所有任务合起来）
  let ranToday = 0;
  for (const t of list) {
    const s = st[t.id];
    if (s && s.day === day) ranToday += Number(s.n) || 0;
  }
  const out = [];
  for (const t of list) {
    if (out.length >= limit) break;
    if (ranToday + out.length >= maxPerDay) break;
    const s = st[t.id];
    const lastAt = Number(s?.lastAt) || 0;
    // 没跑过 ⇒ 到期；跑过 ⇒ 看间隔
    const gap = Number.isFinite(Number(t.everyMs)) && Number(t.everyMs) >= MIN_TASK_EVERY_MS
      ? Number(t.everyMs)
      : MIN_TASK_EVERY_MS;
    const nextAt = Number.isFinite(s?.nextAt) && s.nextAt > 0 ? s.nextAt : lastAt + gap;
    if (lastAt === 0 || now >= nextAt) out.push(t);
  }
  return out;
}

/**
 * **记下这一趟之后，那一本账该长什么样**（纯函数；由 `Apps.recordTask` 落盘）。
 *
 * ⚠️ **跨天要重新数**（`day` 一变，`n` 从 1 开始）——不然"每天几次"会变成"永远几次"。
 */
export function nextTaskState({ entry, at, everyMs, day = dayOf(at) }) {
  const prev = entry && typeof entry === 'object' ? entry : {};
  const n = prev.day === day ? (Number(prev.n) || 0) + 1 : 1;
  /**
   * 🔴 **间隔兜底到下限**：传进来一个 0 / 垃圾 / 负数 ⇒ 按 `MIN_TASK_EVERY_MS` 算。
   *    ⚠️ 这一条是**防止"每个 tick 都跑一遍"**那道闸 —— 少传一个参数不该变成
   *    每分钟替主人干一件事（盒子会被它拖住，而且他会收到一串莫名其妙的回答）。
   */
  const gap = Number.isFinite(Number(everyMs)) && Number(everyMs) >= MIN_TASK_EVERY_MS
    ? Number(everyMs)
    : MIN_TASK_EVERY_MS;
  return { lastAt: at, nextAt: at + gap, day, n };
}

/**
 * **调度器**：隔一阵看一遍，把到期的交给 `deliver` 去干。
 *
 * ⚠️ 依赖都是**注进来的**（`worlds` / `appsFor` / `deliver` / `now`）——
 *    这样判据不用起定时器、也不用真起盒子。
 *
 * @param {object} o
 * @param {{ids:()=>string[]}} o.worlds
 * @param {(sub:string)=>any} o.appsFor
 * @param {(o:{sub:string, appId:string, task:object})=>Promise<any>} o.deliver
 * @param {()=>number} [o.now]
 * @param {(m:string)=>void} [o.log]
 */
export function createTaskRunner({ worlds, appsFor, deliver, now = Date.now, log = () => {} }) {
  let timer = null;
  let inFlight = false;

  /** 看一遍（**可重入保护**：上一遍还没走完就不开第二遍）。 */
  async function tick() {
    if (inFlight) return { skipped: 'busy' };
    inFlight = true;
    const ran = [];
    try {
      for (const sub of worlds.ids()) {
        let apps = null;
        try {
          apps = appsFor(sub);
        } catch (err) {
          log(`定时任务：取不到 ${sub} 的小程序库：${err?.message ?? err}`);
          continue;
        }
        if (!apps || typeof apps.list !== 'function') continue;
        let items = [];
        try {
          items = await apps.list();
        } catch (err) {
          log(`定时任务：${sub} 的清单读不出来：${err?.message ?? err}`);
          continue;
        }
        for (const a of Array.isArray(items) ? items : []) {
          const tasks = Array.isArray(a?.tasks) ? a.tasks : [];
          if (tasks.length === 0) continue;
          const allowed = (() => {
            try {
              return apps.grants(a.id).includes('tasks');
            } catch {
              return false; // 读不出来 ⇒ 当作"他没允许"（fail-closed）
            }
          })();
          const state = (() => {
            try {
              return apps.taskState(a.id);
            } catch {
              return {};
            }
          })();
          const due = dueTasks({ tasks, state, now: now(), allowed, limit: 1 });
          if (due.length === 0) continue;
          const t = due[0];
          // 🔴 **先记再跑**：记不上 ⇒ 这一趟不跑（宁可少跑，不许"跑了没记"）
          try {
            apps.recordTask(a.id, t.id, now(), t.everyMs);
          } catch (err) {
            log(`定时任务：${a.id}/${t.id} 这一笔记不上，先不跑：${err?.message ?? err}`);
            continue;
          }
          try {
            await deliver({ sub, appId: a.id, task: t });
            ran.push({ sub, appId: a.id, taskId: t.id });
          } catch (err) {
            log(`定时任务：${a.id}/${t.id} 交出去没成：${err?.message ?? err}`);
          }
        }
      }
    } finally {
      inFlight = false;
    }
    return { ran };
  }

  return {
    tick,
    /** 起定时器（`.unref()`：**不许**让它拖着进程不退出）。 */
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => log(`定时任务：这一遍抛了：${err?.message ?? err}`));
      }, TASK_TICK_MS);
      timer.unref?.();
      // 起服务那一下也看一遍（不然要等到下一个 tick 才动）
      setTimeout(() => {
        tick().catch((err) => log(`定时任务：开机那一遍抛了：${err?.message ?? err}`));
      }, 5_000).unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
