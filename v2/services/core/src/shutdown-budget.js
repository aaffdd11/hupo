// 收工的**预算**：每一步都有上限，整条也有（**B38** · 主人 2026-09-26 原话「90秒窗口关闭不对吧？」）。
//
// ── 它解决什么问题（都是真机读数，不是推测）────────────────────────
//
// 收工原来是一串**没有上限的 `await`**（`serve.js` 尾部那十一句）。
// 2026-09-26 在**临时实例**上量出来的两条读数：
//   · 空载收工：**16 毫秒**（快得没问题）；
//   · 只要**挂着一条没发完的 HTTP 请求**（半开的连接 ⇒ 不算 idle）：
//     `close()` 里的 `server.close()` **永远不返回** —— 探针等了 **40 秒**还没退
//     （线上那两次是 **90 秒**被 systemd `SIGKILL`）。
// ⇒ 卡住时的两个后果，正是 B38 记的那两条：
//   ① 进程不走 ⇒ systemd `State 'stop-sigterm' timed out. Killing.` ⇒ 那段窗口线上不可用；
//   ② 日志里 `收到 SIGTERM，收工。` 之后**一个字都没有**（那两次逐字取证见 B38）
//      ⇒ 事后谁也说不清卡在哪一步 —— 因为那几段代码**本来就不打点**。
//
// ── 两条纪律（改这段代码的时候不许破）──────────────────────────────
//
// 1. 🔴 **不许为了快就把正在跑的活砍了**（手册 N19 同族：说出去的话要有终态）。
//    ⇒ 上限到了**不是**"把它掐掉"，而是**如实记一句"这一步没等完"**，然后继续往下收。
//    ⇒ 也**不**去 `server.closeAllConnections()` 那种"强拆"：那会让在飞的请求
//      **静默消失**——而"静默丢弃"正是这一条要防的那件事。
// 2. 🔴 **每一步都要点名**（人话，不是对象）：卡在哪一步要写进**日志一行**，
//    下一次谁看日志都能一眼说出来。
//
// ⚠️ 数值只住在这里（手册纪律 1：文档里不写数值）。

/** 单步上限。 */
// ⚠️ 为什么是它：`runtime.shutdown()` 每卸一个 agent 最多等 2 秒
//    （`DshAgent.dispose()` 那个 SIGTERM→SIGKILL 兜底），最多 4 个 agent
//    ⇒ **合法的收口本来就可能要 8 秒** ⇒ 上限必须**比它宽**。
//    卡得太紧 = 把正常收口判成"没等完" —— 那正是纪律 1 不许的事。
export const STEP_CAP_MS = 12_000;

/** **整条**收工的总上限。 */
// ⚠️ systemd 那边是 `TimeoutStopUSec`（**住在单元文件里，不在这儿**）——
//    总上限必须**明显小于它**，否则又回到"被 SIGKILL"那条路。
//    三步各自卡满 = 36 秒 ⇒ 总上限要低于它才有意义。
export const TOTAL_CAP_MS = 30_000;

/**
 * 收工的**顺序表**。
 *
 * 🔴 **顺序就是契约**（判据 Z3）：它与 `serve.js` 原来那一段**逐字对应**
 *    （`for (const sig of ['SIGTERM','SIGINT'])` 里那十一句）——
 *    `id` 是顺序、`label` 是给日志看的人话。**加一个上限不许顺手换个顺序**：
 *    "先把话说圆、再放 agent 走"是有理由的（见 `serve.js` 那段原来的注释）。
 *
 * @type {{id: string, label: string, awaited: boolean, claim?: boolean}[]}
 */
export const SHUTDOWN_STEPS = [
  // ①②③ 是**会被 await 的**那三步 —— 只有它们能"挂住"，所以只有它们打进度点。
  { id: 'dispatchers', label: '把每个人手上那些话收圆（派发器）', awaited: true },
  { id: 'runtime', label: '把 agent 放走（运行时）', awaited: true },
  { id: 'server', label: '停止接新连接（HTTP/WS 那个口）', awaited: true },
  // ④–⑧ 都是同步的（关计时器 / 关本地口）—— 它们不会挂住，但也**照走不误**。
  { id: 'turn-status', label: '停掉"忙不忙"那支心跳', awaited: false },
  { id: 'trash-sweep', label: '停掉回收站那个定时器', awaited: false },
  { id: 'disk-watch', label: '停掉磁盘巡检', awaited: false },
  { id: 'sockets', label: '关掉账本那些本地口', awaited: false },
  { id: 'channel', label: '关掉租户通道', awaited: false },
  { id: 'migrate', label: '关掉迁移那条维护口', awaited: true },
  // ⑨ ★ `claim: true` = **这是一句"我说出去了的话"**（"这次是好好走的"）。
  //    只要前面有一步没等完 / 抛了 ⇒ **不许说这句话**（下次开机的横幅会如实写"没善终"）。
  { id: 'clean-exit', label: '留"这次是好好走的"标记', awaited: false, claim: true },
  // ⑩ 锁**照样要撤**：不撤的话迁移脚本会一直以为这个数据目录热着（那与"有没有善终"无关）。
  { id: 'serve-lock', label: '撤掉那把锁（免得迁移以为这里还热着）', awaited: false },
];

const sec = (ms) => (ms % 1000 === 0 ? `${ms / 1000} 秒` : `${(ms / 1000).toFixed(1)} 秒`);
const describe = (err) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '不知道'));

/**
 * 跑一遍收工。
 *
 * ⚠️ 它**自己不会抛**：每一步的抛出都被记一笔（`failed`）然后继续 ——
 *    收工这条路上"某一步炸了"不该把后面那些收尾一起带走。
 *
 * @param {object} o
 * @param {Record<string, () => any>} o.hooks  `id` → 那一步真正要做的事（顺序由 `SHUTDOWN_STEPS` 定）
 * @param {(...a: any[]) => void} [o.log]
 * @param {(code: number) => void} [o.exit]  最后那一下（默认 `process.exit`；测试注入假的）
 * @param {number} [o.stepCapMs]
 * @param {number} [o.totalCapMs]
 * @param {{setTimeout: Function, clearTimeout: Function}} [o.timers]
 * @param {() => number} [o.now]
 * @returns {Promise<{clean: boolean, totalHit: boolean, order: string[], ran: string[], stalled: string[], failed: {id: string, why: string}[], skipped: string[], elapsedMs: number}>}
 */
export async function runShutdown({
  hooks = {},
  log = (...a) => console.log(...a),
  exit = (code) => process.exit(code),
  stepCapMs = STEP_CAP_MS,
  totalCapMs = TOTAL_CAP_MS,
  timers = { setTimeout, clearTimeout },
  now = Date.now,
} = {}) {
  const t0 = now();
  const order = SHUTDOWN_STEPS.map((s) => s.id);
  const ran = [];
  const stalled = [];
  const failed = [];
  const skipped = [];
  let totalHit = false;

  // ★ **总上限**：一个单独的承诺 —— 它一到，就算某一步还挂在那儿，这一轮也要收场。
  let onTotal;
  const totalFired = new Promise((r) => {
    onTotal = () => {
      totalHit = true;
      r('total');
    };
  });
  const totalTimer = timers.setTimeout(onTotal, totalCapMs);

  for (const step of SHUTDOWN_STEPS) {
    if (totalHit) break; // 总上限到了 ⇒ 剩下的交给下面那段"善后"
    // 🔴 **这一步没等完时不许说"我好好走了"**（`claim` 那一句）。
    if (step.claim && (stalled.length > 0 || failed.length > 0)) {
      skipped.push(step.id);
      log(
        `⚠️ 收工：「${step.label}」这一步不打 —— 前面有 ${stalled.length + failed.length} 步没等完，` +
          `那句"我好好走了"就**不许说**（下次开机横幅会如实写"没善终"）。`,
      );
      continue;
    }
    // 只有会被 await 的那几步打进度点：它们是**唯一能挂住**的几步，
    // 也正是"卡在哪一步"这个问题要回答的那几步。
    if (step.awaited) log(`  收工 ▸ ${step.label}…`);

    const r = await raceStep(step, hooks[step.id], { stepCapMs, timers, totalFired });
    if (r.kind === 'ok') {
      ran.push(step.id);
      continue;
    }
    if (r.kind === 'stalled') {
      stalled.push(step.id);
      log(
        `⏱ 收工卡在「${step.label}」：${sec(stepCapMs)} 还没收完（可能还有连接／还有活挂着没收口）` +
          ` —— 记一笔，接着往下收（**没有**把它掐掉，上限不是用来砍活的）。`,
      );
      continue;
    }
    if (r.kind === 'failed') {
      failed.push({ id: step.id, why: describe(r.err) });
      log(`⚠️ 收工：${step.label} 这一步抛了：${describe(r.err)} —— 记一笔，接着往下收。`);
      continue;
    }
    if (r.kind === 'total') {
      // 总上限到了：当前这一步**不再等**，剩下的交给下面那段"善后"。
      skipped.push(step.id);
      log(
        `🛑 收工到了总上限（${sec(totalCapMs)}）：现在卡在「${step.label}」。` +
          `剩下的收尾我照样做完，但**这次不算善终**（下次开机横幅会如实写"没善终"）。`,
      );
      break;
    }
    // 'missing'：hooks 表里压根没有这一步 ⇒ 接线漏了（大声说，别静默跳过）
    failed.push({ id: step.id, why: 'hooks 里没有这一步' });
    log(`⚠️ 收工：没有「${step.label}」这一步（hooks 里缺 \`${step.id}\`）—— 记一笔。`);
  }

  // 总上限到了之后，**只剩同步的那几步**能走：会被 await 的一律不再碰
  // （再 await 一次就可能再挂一次 —— 那就永远收不了场了）。
  if (totalHit) {
    for (const step of SHUTDOWN_STEPS) {
      if (skipped.includes(step.id) || ran.includes(step.id)) continue;
      if (step.awaited) {
        skipped.push(step.id);
        continue;
      }
      if (step.claim) {
        skipped.push(step.id);
        continue;
      }
      const fn = hooks[step.id];
      if (typeof fn !== 'function') {
        failed.push({ id: step.id, why: 'hooks 里没有这一步' });
        continue;
      }
      try {
        fn();
        ran.push(step.id);
      } catch (err) {
        failed.push({ id: step.id, why: describe(err) });
        log(`⚠️ 收工：${step.label} 这一步抛了：${describe(err)} —— 记一笔。`);
      }
    }
  }

  timers.clearTimeout(totalTimer);

  const clean = stalled.length === 0 && failed.length === 0 && skipped.length === 0;
  const unrun = [...new Set([...skipped, ...stalled, ...failed.map((f) => f.id)])];
  log(
    `  收工 ${clean ? '✓ 走完了' : '⚠️ 收了，但**没善终**'}：` +
      `走了 ${ran.length}/${SHUTDOWN_STEPS.length} 步，共 ${sec(now() - t0)}` +
      (unrun.length > 0 ? `（没走完的：${unrun.join('、')}）` : ''),
  );

  exit(0);
  return {
    clean,
    totalHit,
    order,
    ran,
    stalled,
    failed,
    skipped,
    elapsedMs: now() - t0,
  };
}

/**
 * 跑一步，并给它一个上限（同时听总上限）。
 *
 * ⚠️ 挂住的那个承诺**不会被掐掉**（JS 里也掐不掉）——我们只是**不再等它**。
 *    它手里的资源会跟着 `exit` 一起没；而"它没等完"这件事**已经写进日志了**。
 */
function raceStep(step, run, { stepCapMs, timers, totalFired }) {
  if (typeof run !== 'function') return Promise.resolve({ kind: 'missing' });
  if (!step.awaited) {
    try {
      run();
      return Promise.resolve({ kind: 'ok' });
    } catch (err) {
      return Promise.resolve({ kind: 'failed', err });
    }
  }
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) timers.clearTimeout(timer);
      resolve(r);
    };
    timer = timers.setTimeout(() => finish({ kind: 'stalled' }), stepCapMs);
    totalFired.then(() => finish({ kind: 'total' }));
    Promise.resolve()
      .then(run)
      .then(
        () => finish({ kind: 'ok' }),
        (err) => finish({ kind: 'failed', err }),
      );
  });
}
