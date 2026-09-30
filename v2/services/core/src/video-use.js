// **"用他自己那把钥匙去生成一段视频"** —— 只住这一处（主人 2026-10-01）。
//
// 与 `image-use.js` 同一条形状、同三条纪律：
//   ① 钥匙**只往上游去**（返回值里没有它，日志里也没有）；
//   ② **他自己那把优先**（`data/creds/<他>.yaml` 的 `HUPO_VIDEO_KEY`）——
//      没有就是"没填"，**不许**偷偷用别人那份；
//      ⚠️ ★ **2026-10-01 主人选的"甲"**：图片与视频是**同一把钥匙**（火山方舟那一个）
//         ⇒ 他自己那份里**视频那一栏空着、图片那栏有**时，**明着借图片那把**（`sharedKeyOf`）——
//         界面上写着"跟图片同一把钥匙"。**不借别人那份**这条一个字没松。
//   ③ 失败**说人话**（`videoErrorWords`），认不出就如实说认不出。
//
// ⚠️ **视频是异步的**（与图片那一条最大的不同）：所以这里**两个动作分开**
//    —— `start`（建任务 ＋ 记账，回一个任务号）与 `check`（查一次）。
//    谁去定时查？`video-tasks.js` 的那个巡场（`serve.js` 起它）。

import { VideoBook } from './video-tasks.js';
import {
  DEFAULT_VIDEO_BASE,
  DEFAULT_VIDEO_DURATION,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_RATIO,
  createVideoTask,
  queryVideoTask,
  videoErrorWords,
} from './video.js';
import { credsFor } from './creds-store.js';
import { sharedKeyOf } from './creds.mjs';

/**
 * 造那两个动作（`start` / `check`）。
 *
 * @param {object} o
 * @param {object} [o.env]   进程环境（端点/模型名在那上面可配）
 * @param {Function} [o.fetch]  注入用（判据里换掉它 ⇒ 不联网、不花钱）
 * @param {(m:string)=>void} [o.log]  **只收"谁、成没成、多久"** —— 绝不含钥匙
 * @returns {{start: Function, check: Function}}
 */
export function makeVideo({ env = process.env, fetch = globalThis.fetch, log = () => {} } = {}) {
  /**
   * 这个人那把钥匙（读不出来就是空串 ⇒ 调用方如实说"没填"）。
   *
   * ★ **视频那一栏空着时借图片那把**（同一把火山方舟钥匙，见文件头那段）——
   *   自己那一栏有就用自己的（他要分开算钱也照他的来）。
   */
  function keyOf(dataDir, sub) {
    try {
      const mine = credsFor({ dataDir, sub, env }).values;
      return sharedKeyOf(mine, 'video');
    } catch {
      return '';
    }
  }

  /**
   * **交一段视频出去**（建任务 ＋ 记进那本账）。
   *
   * ⚠️ 顺序刻意：**先问上游拿到任务号，再落账**（反过来的话，落了一条永远查不到的任务）。
   * 🔴 **一次只许一条在飞**（`VideoBook.add` 里那道闸）—— 免得他一句话就排了十条。
   *
   * @returns {Promise<{ok:true, taskId:string, ms?:number} | {ok:false, why:string, text:string}>}
   */
  async function start({ dataDir, sub, prompt, scope = 'main' }) {
    const key = keyOf(dataDir, sub);
    if (key === '') return { ok: false, why: 'no-key', text: videoErrorWords({ why: 'no-key' }) };
    const book = new VideoBook({ dataDir, log });
    if (book.pendingOf(sub).length > 0) {
      return {
        ok: false,
        why: 'too-many',
        text: '上一段视频还在做 —— 等它回来了再要下一段（一次只做一段）。',
      };
    }
    const r = await createVideoTask({
      key,
      prompt,
      model: env.HUPO_VIDEO_MODEL || DEFAULT_VIDEO_MODEL,
      base: env.HUPO_VIDEO_BASE || DEFAULT_VIDEO_BASE,
      ratio: env.HUPO_VIDEO_RATIO || DEFAULT_VIDEO_RATIO,
      duration: env.HUPO_VIDEO_DURATION || DEFAULT_VIDEO_DURATION,
      fetch,
    });
    if (!r.ok) {
      log(`🎬 ${sub} 视频没交出去（${r.why}${r.ms ? ` · ${r.ms}ms` : ''}）`);
      return { ok: false, why: r.why, text: videoErrorWords(r) };
    }
    const put = book.add({ sub, taskId: r.taskId, scope, prompt });
    if (!put.ok) {
      // ⚠️ 账记不上：**任务已经在上游跑着了**（钱已经花了）⇒ 如实说，并把它查一遍
      //    （不静默丢：最坏是这一次结果没人替他收，得他自己再问一句）
      log(`🎬 ${sub} 视频任务记不上账（${put.why}）—— 任务已经在跑：${r.taskId}`);
      return { ok: true, taskId: r.taskId, ms: r.ms, unrecorded: true };
    }
    log(`🎬 ${sub} 交了一段视频出去（${r.taskId}${r.ms ? ` · ${r.ms}ms` : ''}）`);
    return { ok: true, taskId: r.taskId, ms: r.ms };
  }

  /**
   * **查一次**（巡场用；也可以给"那条怎么样了"用）。
   *
   * @returns {Promise<{ok:true, status:string, videoUrl:string|null, ms:number} | {ok:false, why:string, text?:string}>}
   */
  async function check({ dataDir, sub, taskId }) {
    const key = keyOf(dataDir, sub);
    if (key === '') return { ok: false, why: 'no-key' };
    const r = await queryVideoTask({
      key,
      taskId,
      base: env.HUPO_VIDEO_BASE || DEFAULT_VIDEO_BASE,
      fetch,
    });
    if (!r.ok) {
      log(`🎬 ${sub} 查视频任务没成（${r.why}）`);
      return { ok: false, why: r.why, text: r.text };
    }
    return { ok: true, status: r.status, videoUrl: r.videoUrl, ms: r.ms };
  }

  return { start, check };
}
