// 出事时谁接。
//
// 手册 `08-SPEC.md` §5.2 把"落盘上抛"分成三层，**缺一层都不算做完**：
//
//   1. 调用点 —— **不逐处 try**（旧实现有 18 个 `emit` 调用点，逐处 try 必漏）
//   2. `emit` —— 落盘失败就**抛**，订阅者一条都不推          （在 timeline.js）
//   3. **进程级** —— 接住它，说一句话，然后**有序退出**       ← 本模块
//
// 为什么第 3 层必须存在：没有它，`emit` 抛出的错在 Node 里是
// **未捕获异常** ⇒ 进程直接死 ⇒ systemd 拉起 ⇒ 又死。
// 盘还是满的，于是变成**重启风暴**——而每一步都没有人知道发生了什么。
//
// ⚠️ 这里能说上话，靠的是**瞬态通道**：它不写盘，所以**盘满时它仍然能发出去**。
//    如果用普通通道报"盘满了"，那条消息自己就写不进去。

import { isWriteFailure } from './notice.js';

const HUMAN_LINE_DISK = '刚才出了点问题，我先停一下再起来。你最后那句话可能没记下来。';
const HUMAN_LINE_GENERIC = '刚才出了点问题，我先停一下再起来。';

/** 把任意抛出物转成一句能看的诊断（不进用户视野，只进日志）。 */
function describe(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * 装上进程级兜底。返回卸载函数（测试用）。
 *
 * @param {object} o
 * @param {import('./timeline.js').Timeline} [o.timeline] 用来发人话（瞬态）
 * @param {import('./notice.js').Notice} [o.notice]
 *        写盘失败时那条**用户看得见的**瞬态通知（`notice/urgent`，批 3 第三件）。
 *        ⚠️ 只有写盘失败才走它（契约 `29-NOTICE.md` §三①）——`noticeUrgent()`
 *        自己会把"不是写盘失败的 cause"顶回去，这里不用再判一遍。
 * @param {(code: number) => void} [o.exit]  默认 process.exit
 * @param {(...a: any[]) => void} [o.log]    默认 console.error
 * @param {boolean} [o.throwAfter] 测试用：不真退出，而是把错误再抛出去
 */
export function installProcessGuard({ timeline, notice, exit, log, throwAfter = false } = {}) {
  const doExit = exit ?? ((code) => process.exit(code));
  const doLog = log ?? ((...a) => console.error(...a));

  const onFatal = (kind) => (err) => {
    const detail = describe(err);
    // 盘满和别的错要分开说——用户能做的事不一样
    const isDisk = isWriteFailure(err);
    const text = isDisk ? HUMAN_LINE_DISK : HUMAN_LINE_GENERIC;

    try {
      // ⚠️ 瞬态：不落盘。盘满时它是唯一还能出去的路。
      timeline?.emitTransient({ type: 'error', kind, text, detail });
    } catch (e) {
      // 连说都说不出去——那也只能记日志，但**不许因此不退出**
      doLog('[guard] 连通知都发不出去：', describe(e));
    }
    if (isDisk) {
      // ★ **写盘失败那一条用户看得见的话**（批 3 第三件 · 契约 §三①）。
      //   上层那帧 `error` 是**既有的诊断帧**（客户端不渲染，探针与日志在用），
      //   而契约给的那条通道是 `notice/urgent` —— 客户端照它显示，
      //   而且那句话**自己说清**了"我没能记下来"（例外不许伪装成正常）。
      //   ⚠️ 只有写盘失败才有这一条：别的情形**不许**走瞬态（契约 §三①）。
      try {
        notice?.noticeUrgent({ cause: err });
      } catch (e) {
        doLog('[guard] 那条瞬态通知没发出去：', describe(e));
      }
    }
    doLog(`[guard] ${kind}：${detail}`);
    if (throwAfter) throw err;
    doExit(1);
  };

  const uncaught = onFatal('uncaughtException');
  const unhandled = onFatal('unhandledRejection');
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', unhandled);
  return () => {
    process.off('uncaughtException', uncaught);
    process.off('unhandledRejection', unhandled);
  };
}

/**
 * 崩溃环判定（手册 `08-SPEC.md` §11.1）。
 *
 * 判据：**窗口内启动次数 ≥ 阈值 且 上次日志里有 oom-kill**
 * ⇒ 降级启动：**不续做、不预热，只服务对话**；连续 N 分钟无崩溃才恢复。
 *
 * ⚠️ 降级**必须对用户说一句话**（"先把手上这件事放一放，你现在说什么我都接"）——
 *    静默降级等于骗人：用户以为活还在做。
 */
export class CrashLoopGuard {
  #windowMs;
  #threshold;
  #now;
  #starts = [];
  #degraded = false;

  constructor({ windowMs = 5 * 60_000, threshold = 3, now = Date.now } = {}) {
    this.#windowMs = windowMs;
    this.#threshold = threshold;
    this.#now = now;
  }

  get degraded() {
    return this.#degraded;
  }

  /** 记一次启动。返回是否应进入降级。 */
  recordStart({ oomKilledLastRun = false } = {}) {
    const t = this.#now();
    this.#starts = this.#starts.filter((s) => t - s < this.#windowMs);
    this.#starts.push(t);
    this.#degraded = this.#starts.length >= this.#threshold && oomKilledLastRun;
    return this.#degraded;
  }

  /** 连续无崩溃够久 ⇒ 恢复。 */
  recordHealthy(quietMs = 10 * 60_000) {
    const t = this.#now();
    const last = this.#starts.at(-1);
    if (last !== undefined && t - last >= quietMs) {
      this.#starts = [];
      this.#degraded = false;
    }
    return this.#degraded;
  }
}

export const HUMAN_LINES = {
  disk: HUMAN_LINE_DISK,
  generic: HUMAN_LINE_GENERIC,
  degraded: '刚才我连着重启了几次，先把手上这件事放一放，你现在说什么我都接。',
};
