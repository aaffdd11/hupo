// **视频任务的账 ＋ 那个"盯着它做完"的巡场**（`148` §四 的形状，视频这一样）。
//
// 为什么视频要单有一套（而图片不用）：**图片是同步的**（要一张、几十秒、当场回地址），
// 而**视频是异步的**（建任务 ⇒ 几十秒到几分钟）⇒ 一次工具调用**等不起**。
// ⇒ 形状是：**工具只负责"交出去"**（建任务 ＋ 记账 ⇒ 回一个任务号），
//    由**巡场**（`serve.js` 里起的那一个）每隔一阵去看一眼：
//      · 好了 ⇒ **往他问的那一间说一句**（带视频地址 —— 界面上就是能点的那个框）；
//      · 做坏了/过期了 ⇒ **如实说一句**（不许静默，也不许说成好了）；
//      · 等太久了 ⇒ 如实说"还在做"，并且**把这一条放下**（不无限等）。
//
// 🔴 **钱在这几处**（视频比图片贵得多，所以限额要硬）：
//   · **一次只许一条在飞**（同一个人）—— 免得他一句话没看清就排了十条；
//   · **等的时间有上限**（`MAX_WAIT_MS`，到点不再查，如实说一句）；
//   · **账在盘上**（`data/video-tasks.json`）：重启之后还认得那几条在飞的。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 同一个人**同时**最多几条在飞。 */
export const MAX_PENDING_PER_USER = 1;

/** 从**建任务那一刻**算起，最多盯多久（毫秒）。到点就放下（如实说一句）。 */
export const MAX_WAIT_MS = 15 * 60 * 1000;

/** 巡场多久看一眼（毫秒）。 */
export const TICK_MS = 10 * 1000;

/** 一次 tick 里最多查几条（免得一次 tick 打爆上游）。 */
export const MAX_CHECKS_PER_TICK = 4;

/** 任务号的形状（与 `video.js` 那一处**同一个**判据；这里再收一道防手改盘上的文件）。 */
const ID_OK = /^[A-Za-z0-9._-]{6,80}$/;

/**
 * **在飞的那些任务**（一个人一条）。
 *
 * ⚠️ 落盘一份（`data/video-tasks.json`）是**刻意的**：服务重启之后，
 *    已经在跑的那几条**还认得**（不然他花了钱、我们却忘了去收结果）。
 * 🔴 盘上那份**只存"还欠着的"**（做完/放弃就删）—— 它不是历史账，
 *    历史账在那个用量账本里（`usage.note`）。
 */
export class VideoBook {
  /**
   * @param {{dataDir: string, now?: () => number, log?: (m: string) => void}} o
   */
  constructor({ dataDir, now = Date.now, log = () => {} }) {
    this.path = nodePath.join(dataDir, 'video-tasks.json');
    this.now = now;
    this.log = log;
  }

  /**
   * 🔴 **每次都现读盘**（不缓存）——刻意：
   *    · 建任务那一侧（小程序通道的 ctx）与巡场那一侧（`serve.js`）
   *      是**两个实例**（各自 `new`）⇒ 缓存一份的话，"他刚交出去的那一条"
   *      巡场永远看不见；
   *    · 盘上那份很小（等于在飞的任务数，最多几个人各一条）。
   * ⚠️ 代价：两个进程/两个实例**同时**改这份文件理论上会丢一次更新
   *    （读-改-写）。实际频率是"一分钟几次"，而且最坏是**丢一条在飞的任务**
   *    （他再问一句就能重来）—— 这个取舍写在这儿，别当它是 bug。
   */
  get items() {
    return this.#read();
  }

  #read() {
    try {
      const raw = nodeFs.readFileSync(this.path, 'utf8');
      const j = JSON.parse(raw);
      const out = [];
      for (const it of Array.isArray(j?.items) ? j.items : []) {
        // ⚠️ 盘上那份**可能是手改过的 / 上一版写的** ⇒ 逐条校验，认不出的丢掉
        if (typeof it?.sub !== 'string' || it.sub === '') continue;
        if (!ID_OK.test(String(it.taskId ?? ''))) continue;
        out.push({
          sub: it.sub,
          taskId: String(it.taskId),
          scope: typeof it.scope === 'string' && it.scope !== '' ? it.scope : 'main',
          prompt: typeof it.prompt === 'string' ? it.prompt.slice(0, 200) : '',
          at: Number.isFinite(it.at) ? it.at : this.now(),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  #write(items) {
    try {
      nodeFs.mkdirSync(nodePath.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      nodeFs.writeFileSync(tmp, `${JSON.stringify({ items })}\n`, { mode: 0o600 });
      nodeFs.renameSync(tmp, this.path);
    } catch (err) {
      // ⚠️ 落盘没成**不许**把这一次弄挂（最坏是"重启之后不认得那一条"）
      this.log(`视频任务：盘上那份没写下去（${err?.message ?? err}）`);
    }
  }

  /** 这人手上还有几条在飞。 */
  pendingOf(sub) {
    return this.items.filter((i) => i.sub === sub);
  }

  /**
   * 交一条出去（**先记再问上游**？不 —— 这一步是"上游已经给了任务号才记"）。
   * ⚠️ 顺序刻意：**先建任务、拿到号、再落盘**。反过来的话，落盘了但上游没接上
   *    就会留一条永远查不到的任务（巡场一直查、一直 404）。
   */
  add({ sub, taskId, scope = 'main', prompt = '' }) {
    if (typeof sub !== 'string' || sub === '') return { ok: false, why: 'no-sub' };
    if (!ID_OK.test(String(taskId ?? ''))) return { ok: false, why: 'bad-task-id' };
    const now = this.items;
    if (now.filter((i) => i.sub === sub).length >= MAX_PENDING_PER_USER) return { ok: false, why: 'too-many' };
    now.push({ sub, taskId: String(taskId), scope, prompt: String(prompt).slice(0, 200), at: this.now() });
    this.#write(now);
    return { ok: true };
  }

  /** 拿掉一条（做完了 / 放弃了 / 查不到了）。 */
  drop({ sub, taskId }) {
    const now = this.items;
    const kept = now.filter((i) => !(i.sub === sub && i.taskId === taskId));
    if (kept.length !== now.length) this.#write(kept);
    return kept.length !== now.length;
  }

  /** 全部在飞的（巡场用；**照交出去的先后**）。 */
  all() {
    return [...this.items].sort((a, b) => a.at - b.at);
  }
}

/** 给他看的那句话：做好了（**带地址** —— 界面上那个框就靠它）。 */
export function videoDoneLine({ taskId, videoUrl, prompt }) {
  const what = typeof prompt === 'string' && prompt.trim() !== '' ? `（${prompt.trim().slice(0, 40)}）` : '';
  return `视频做好了${what}：${videoUrl}`;
}

/** 给他看的那句话：没做成（**如实说**，不编）。 */
export function videoFailedLine({ reason, detail }) {
  const why =
    reason === 'expired'
      ? '它说这个任务过期了'
      : reason === 'cancelled'
        ? '它说这个任务被取消了'
        : '它说这次没做成';
  const more = typeof detail === 'string' && detail.trim() !== '' ? `（${detail.trim().slice(0, 120)}）` : '';
  return `${why}${more}。要不要换一句话再试一次？`;
}

/** 给他看的那句话：等太久了（**还在做**，但我们不再盯着了）。 */
export function videoLateLine({ taskId }) {
  return `那段视频还在做（任务号 ${String(taskId).slice(0, 24)}）—— 我不再一直盯着它了，过一会儿你再问一句。`;
}

/**
 * **巡场**：隔一阵把在飞的那几条查一遍，该说的说、该放的放。
 *
 * ⚠️ 它是**一个 tick 一个 tick** 的（`tick()`），不自己持有定时器 ——
 *    定时器由 `serve.js` 起（与定时任务那条**同一个形状**：可判据、可停）。
 *
 * @param {object} o
 * @param {VideoBook} o.book
 * @param {(o:{sub:string, taskId:string}) => Promise<{ok:boolean, status?:string, videoUrl?:string|null, why?:string, text?:string}>} o.check
 * @param {(o:{sub:string, scope:string, text:string}) => Promise<unknown>|unknown} o.deliver
 * @param {() => number} [o.now]
 * @param {(m:string)=>void} [o.log]
 * @param {number} [o.maxWaitMs]
 */
export function createVideoRunner({
  worlds,
  bookFor,
  check,
  deliver,
  now = Date.now,
  log = () => {},
  maxWaitMs = MAX_WAIT_MS,
  maxChecks = MAX_CHECKS_PER_TICK,
  tickMs = TICK_MS,
} = {}) {
  let timer = null;
  let inFlight = false;

  /** 看一遍（**可重入保护**：上一遍还没走完就不开第二遍）。 */
  async function tick() {
    if (inFlight) return { skipped: 'busy' };
    inFlight = true;
    const out = [];
    try {
      const subs = typeof worlds?.ids === 'function' ? worlds.ids() : [];
      for (const sub of subs) {
        const book = bookFor(sub);
        if (!book) continue;
        for (const it of book.all().slice(0, maxChecks)) {
          // ① 等太久了 ⇒ 放下（**如实说一句**，不无限等）
          if (now() - it.at > maxWaitMs) {
            book.drop({ sub: it.sub, taskId: it.taskId });
            out.push({ sub: it.sub, taskId: it.taskId, action: 'late' });
            try {
              await deliver({ sub: it.sub, scope: it.scope, text: videoLateLine({ taskId: it.taskId }) });
            } catch (err) {
              log(`视频巡场：那句话没送出去（${err?.message ?? err}）`);
            }
            continue;
          }
          let r;
          try {
            r = await check({ sub: it.sub, taskId: it.taskId });
          } catch (err) {
            // ⚠️ 查一次抛了**不许**把这一条弄没（下一趟再查）—— 只记一笔
            log(`视频巡场：查任务抛了（${it.taskId}）${err?.message ?? err}`);
            out.push({ sub: it.sub, taskId: it.taskId, action: 'check-threw' });
            continue;
          }
          if (!r?.ok) {
            // 查不动（没钥匙 / 连不上 / 网络不好）⇒ **这一次什么也不做**，下一趟再来
            out.push({ sub: it.sub, taskId: it.taskId, action: 'check-failed', why: r?.why ?? 'unknown' });
            continue;
          }
          const st = String(r.status ?? '');
          if (st === 'succeeded') {
            book.drop({ sub: it.sub, taskId: it.taskId });
            out.push({ sub: it.sub, taskId: it.taskId, action: 'done', videoUrl: r.videoUrl ?? null });
            // ⚠️ 上游说成了但**没有地址** ⇒ 那是"认不出"，如实说一句，不许编
            const text = r.videoUrl
              ? videoDoneLine({ taskId: it.taskId, videoUrl: r.videoUrl, prompt: it.prompt })
              : videoFailedLine({ reason: 'no-url', detail: '' });
            try {
              await deliver({ sub: it.sub, scope: it.scope, text });
            } catch (err) {
              log(`视频巡场：那句话没送出去（${err?.message ?? err}）`);
            }
            continue;
          }
          if (st === 'failed' || st === 'cancelled' || st === 'expired') {
            book.drop({ sub: it.sub, taskId: it.taskId });
            out.push({ sub: it.sub, taskId: it.taskId, action: st });
            try {
              await deliver({
                sub: it.sub,
                scope: it.scope,
                text: videoFailedLine({ reason: st, detail: r.text ?? '' }),
              });
            } catch (err) {
              log(`视频巡场：那句话没送出去（${err?.message ?? err}）`);
            }
            continue;
          }
          // queued / running / unknown ⇒ 什么都不说（**不许**每 10 秒喊一次）
          out.push({ sub: it.sub, taskId: it.taskId, action: 'waiting', status: st });
        }
      }
    } finally {
      inFlight = false;
    }
    return { ran: out };
  }

  return {
    tick,
    /** 起定时器（`.unref()`：**不许**让它拖着进程不退出）。 */
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => log(`视频巡场：这一遍抛了：${err?.message ?? err}`));
      }, tickMs);
      timer.unref?.();
      setTimeout(() => {
        tick().catch((err) => log(`视频巡场：开机那一遍抛了：${err?.message ?? err}`));
      }, 5_000).unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
