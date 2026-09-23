// **它是不是被"挤掉"的**（账 #33 的后半 · 2026-09-23）。
//
// ── 为什么要这个文件 ──────────────────────────────────────────
// 失败五类（`notice.js` 的 `FAILED_LINES`）里，**OOM 这一档一直没有判据**：
// 进程没了只说明"没了"——`SIGKILL` 可能是内存挤掉的，也可能是 `kill -9`、
// 也可能是别的。**拿 `SIGKILL` 当 OOM 就是在猜**，而 N10 说"宁可少说，不许猜"。
//
// ⇒ 这里用**内核自己的计数**当证据：cgroup v2 的 `memory.events` 里有
//   `oom` 与 `oom_kill` 两个数（本机实测那份文件里就是这两个名字）。
//   在**这个进程活着的那段时间里**它们**涨过** ⇒ 那个 cgroup 真的 OOM 过 ⇒ 说"被挤掉了"有据。
//
// ── 三条纪律 ─────────────────────────────────────────────────
//   ① **读不到就不许说**：文件不在 / 读不出 / 解析不了 ⇒ 一律 `false`（兜底回那句含糊的话）。
//   ② **只能证明"这个 cgroup 里 OOM 过"**，不能证明"就是这一轮" —— 所以只在
//      "起这一轮前后涨了"这个窗口里说（窗口由调用方 `markStart()` 划）；
//   ③ **本机上它永远不会响**：这条 `dsh-subprocess-*.scope` 每一层 `memory.max` 都是 `max`
//      （见 `AGENTS.md` §1.1）⇒ 内核没有理由在这里 OOM。带上租户容器（`--memory=768m`）
//      才会有真实的 OOM —— 那正是它要覆盖的地方。

import nodeFs from 'node:fs';

const defaultRead = (p) => nodeFs.readFileSync(p, 'utf8');

/**
 * **我们这个 cgroup 的 `memory.events` 在哪**。
 *
 * ⚠️ 不能写死 `/sys/fs/cgroup/memory.events`：本机实测**那个路径不存在** ——
 *    `/sys/fs/cgroup` 那一层是空目录，真正的那份在**我们自己 scope 的目录里**
 *    （`/proc/self/cgroup` 里那条 `0::/user.slice/.../xxx.scope`）。
 * @returns {string|null} 路径；认不出来 ⇒ `null`
 */
export function ownMemoryEventsPath({ readFile = defaultRead } = {}) {
  try {
    const line = String(readFile('/proc/self/cgroup'))
      .split('\n')
      .find((l) => l.startsWith('0::'));
    if (!line) return null;
    const rel = line.slice(3).trim().replace(/\/+$/, '');
    // `0::/` ⇒ 我们就在挂载根上：那份文件是 `/sys/fs/cgroup/memory.events`。
    // ⚠️ 本机**那个路径不存在**（实测）⇒ `readOomEvents` 会返回 `null` ⇒ 上层闭嘴。
    //    路径算得对、文件不在，也要走到"读不到"那一条，而不是猜一个数出来。
    return rel === '' ? '/sys/fs/cgroup/memory.events' : `/sys/fs/cgroup${rel}/memory.events`;
  } catch {
    return null;
  }
}

/**
 * 读两个计数。**认不出就返回 `null`**（调用方据此闭嘴）。
 * @returns {{oom:number, oomKill:number}|null}
 */
export function readOomEvents(path, { readFile = defaultRead } = {}) {
  if (!path) return null;
  try {
    const text = String(readFile(path));
    const num = (key) => {
      const m = new RegExp(`^${key}\\s+(\\d+)\\s*$`, 'm').exec(text);
      return m ? Number(m[1]) : 0;
    };
    // ⚠️ 两个名字都认：实测这份文件里叫 `oom`，而 cgroup v2 文档里常见的是 `oom_kill`
    //    ⇒ 哪个在就用哪个，两个都不在也算 0（那就永远判不出 OOM，**这是保守的那一边**）。
    return { oom: num('oom'), oomKill: num('oom_kill') };
  } catch {
    return null;
  }
}

/**
 * **一次"起它 / 它没了"的窗口**。
 *
 * ```js
 * const w = createOomWatcher();
 * w.markStart();       // 起这一轮之前
 * ...                  // 它跑
 * w.changed();         // 它没了 ⇒ true 表示**这段时间里这个 cgroup 真的 OOM 过**
 * ```
 */
export function createOomWatcher(deps = {}) {
  const path = ownMemoryEventsPath(deps);
  let before = null;
  let started = false;
  return {
    markStart() {
      before = readOomEvents(path, deps);
      started = true;
    },
    /** ⚠️ 只在**两次都读得到**、而且涨了的时候才 `true`（读不到 ⇒ `false`）。 */
    changed() {
      if (!started || !before) return false;
      const after = readOomEvents(path, deps);
      if (!after) return false;
      return after.oom > before.oom || after.oomKill > before.oomKill;
    },
    /** 给判据看：这个窗口有没有可用的证据来源。 */
    get available() {
      return before != null;
    },
  };
}
