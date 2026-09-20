// **"手上还有没有没说完的话"** —— 重启前要问的那一件事。
//
// 手册依据：`06-OPERATIONS.md` **§8.3**（"重启自己的正确姿势"）：
//   ⚠️ 不要直接重启服务——那会把**正在说话的助手**连同这一轮回答一起杀掉，
//      用户会看到话说一半没了。要**延迟重启**，先把话说完。
//   ⚠️ **本机没有那个服务**，那一节只在生产机适用。（这里说的是"服务"这个进程，
//      本机起的是同一个东西，所以这条规矩在这儿一样成立。）
//
// 为什么做成"心跳 + 落一个文件"而不是"某个事件类型"：
//   * "一轮在跑"有三个来源（没说完的气泡 / 还没变成轮的话 / 挂着的超时计时器），
//     哪天再多一个来源，事件驱动那种写法就得回去改一遍；
//   * 心跳只回答一个问题：**现在**手上有没有话。来源变了它也不用改。
//   * 而且那个文件**主人自己也能 `cat`** —— 排查时不用来问助手。
//
// ⚠️ 两个刻意的设计：
//   1. **只在变了的时候写盘**（一秒一次心跳，但绝大多数时候什么都不写）。
//   2. 重启脚本要看 `updatedAt` 是不是**陈的**：服务已经死了的话，没人再更新它，
//      这时候"busy:true"是**旧话**，不能拿它永远等下去（见 `readStatus`）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 心跳间隔。比它更密的轮询没有意义（一轮的边界本来就在秒级）。 */
export const HEARTBEAT_MS = 1000;

/** 超过这个时间没更新 ⇒ 这条状态**不可信**（服务可能已经不在了）。 */
export const STALE_MS = 5000;

/**
 * 现在手上有没有话。**纯函数**。
 *
 * ⚠️ **三个来源缺一不可**（第一版只写了前两个，实测漏掉一整段）：
 *   * `openMessageId`：已经开始说了（有没收口的气泡）；
 *   * `pending`：话还没变成轮（`deliver` 收下了、还没轮到它）；
 *   * `turns`：**轮已经宣布、但它还一个字都没说** ——
 *     这一段实测有 3 秒以上（spawn agent + 建会话 + 喂背景），
 *     而前两个信号那时**都是空的** ⇒ 只写前两个的话，重启会正好切在这段空窗里，
 *     也就是**这条功能最该防的那种情况**。
 *
 * @param {{openMessageId?: string|null, pending?: number, turns?: number}} s
 */
export function computeBusy({ openMessageId = null, pending = 0, turns = 0 } = {}) {
  if (openMessageId) return true; // 它正在说
  if (Number(turns) > 0) return true; // 轮在飞（哪怕它还没开口）
  return Number(pending) > 0; // 有还没变成轮的话
}

/** 那个文件叫什么。 */
export function statusPath(dataDir) {
  return nodePath.join(dataDir, 'status.json');
}

/**
 * 读回来。**读不懂就当"不知道"**（`null`），不要猜成"不忙"——
 * 猜错的方向是"重启把话切了"，那是这条功能唯一要防的事。
 */
export function readStatus(text, { now = Date.now(), staleMs = STALE_MS } = {}) {
  let j;
  try {
    j = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const updatedAt = Number(j.updatedAt);
  const busy = j.busy === true;
  if (!Number.isFinite(updatedAt)) return null;
  const ageMs = now - updatedAt;
  return { busy, updatedAt, ageMs, stale: ageMs > staleMs };
}

/**
 * 该不该继续等它。
 *
 * ⚠️ **只认"明确在忙、而且这条状态是新的"**。三种情况都**不等**：
 *   读不懂 / 已经不在忙 / **这条状态是陈的**（服务可能已经死了）。
 *   理由：等一个死掉的服务 = 重启脚本永远卡在那里，那比切一轮话更坏。
 */
export function shouldWait({ status }) {
  if (!status) return false;
  if (!status.busy) return false;
  if (status.stale) return false;
  return true;
}

/** 心跳：盯着一份状态，变了才落盘。`now`/`fs` 可注入（测试用）。 */
export function createTurnStatus({ file, snapshot, now = Date.now, fs = nodeFs }) {
  let last = null;
  let timer = null;

  const write = (busy, openMessageId, pending, turns) => {
    const body = {
      busy,
      openMessageId: openMessageId ?? null,
      pending: Number(pending) || 0,
      turns: Number(turns) || 0,
      updatedAt: now(),
    };
    try {
      fs.mkdirSync(nodePath.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(body)}\n`);
    } catch {
      // 写不进去也不许影响服务（这是维护用的旁路信息）
    }
    return body;
  };

  const tick = () => {
    const s = snapshot() ?? {};
    const busy = computeBusy(s);
    const key = `${busy}|${s.openMessageId ?? ''}|${Number(s.pending) || 0}|${Number(s.turns) || 0}`;
    const changed = key !== last;
    last = key;
    // ⚠️ 写盘的时机是这条功能最容易做错的地方，两头都要顾：
    //    · **闲着的时候一条都不写**（一秒一次心跳不等于一秒一次写盘）；
    //    · **忙着的时候必须每秒刷新 `updatedAt`** —— 否则重启脚本会把这行
    //      当成"陈的"（以为服务已经死了），然后照样重启、照样把话切了。
    //    ⇒ 规则：**变了就写，忙就一直写。**
    if (!changed && !busy) return;
    write(busy, s.openMessageId, s.pending, s.turns);
  };

  return {
    file,
    tick,
    start() {
      tick();
      if (timer) return;
      timer = setInterval(tick, HEARTBEAT_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
