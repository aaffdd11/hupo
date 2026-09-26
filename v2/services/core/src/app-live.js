// **"活的工作区"那一套**（契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）。
//
// ── 主人 2026-09-26 定的产品形状（原话）────────────────────
//   *"小程序做好了，发布到桌面，这个对于用户自己用的应该是不需要这样的。
//     因为他自己开发过程原则上就是对**当前这个版本**进行内容修改、功能修改等等……
//     只不过它跟原来的那个版本不一样的话呢，对于市场来说它可能是有更新，
//     用户可以重新去更新，否则的话用户不需要走这条发布的通道。"*
// ⇒ **他自己那一份**（桌面图标）打开的必须是**他正在改的那一间工作区**（活文件），
//   不是某一版制品快照；**"发布 / 版本快照"只留给"市场 / 别人"那一侧**
//   （`app_publish` / 血缘 / 回滚 / 「发现」照旧，一个字都没动）。
//
// ── 这一份装什么（**只有这一处**）──────────────────────────
//   ① 活地址的形状：`/w/<id>/<rel>`（与制品的 `/a/<id>/<version>/<rel>` **平行**）；
//   ② **白名单**：工作区里哪些文件能露给那个沙箱页面（下一条）；
//   ③ **"内容变了"那一帧**的形状（瞬态事件 `app/workspace-changed`）；
//   ④ **看着工作区**的那个人（`createLiveWatcher`：`fs.watch` 递归 ⇒ 归到哪一间）。
//
// ── 白名单（写清单：允许什么、拒绝什么）────────────────────
//   ✅ **允许**：工作区里（含子目录）**不以 `.` 开头**、且不在下面拒绝表里的文件。
//      入口只有一个：那一间清单里的 `entry`（默认 `index.html`）。
//   ❌ **拒绝**（一条都不许放行）：
//      · `..` / 绝对路径 / 反斜杠 / 空段 / 控制字符 / 超长 ⇒ `checkRelPath` 那道；
//      · **任何一段以 `.` 开头** ⇒ `.hupo.json`（工作区自己的账）· `.data/`（他的数据）
//        · `.exp/`（经验）· `.removed/`（回收处）· `.tmp-*`（原子写的中间文件）；
//      · `build/` 等**保留目录**（下面 `LIVE_DENIED_SEGMENTS` —— 那不是页面的东西）。
//   🔴 为什么白名单要在**这一层**、而且两道都要（`app-serve.js` 验签后先过一道、
//      `workspace.readLive` 再一道）：漏一次的后果是**把用户自己的账本/数据
//      递进一个跑第三方代码的沙箱**——那正是 N1/N2 要挡的形状。
//
// ⚠️ **它不认识令牌**（和 `app-serve.js` 一样）："这是谁"由签名 URL 带进来。
// ⚠️ **它不写任何东西**：读在 `workspace.readLive`，通知是瞬态事件。

import nodeFs from 'node:fs';

import { AppsError, checkRelPath } from './apps.js';

/** 活地址的前缀：`/w/<id>/<rel>`。**与制品的 `/a/` 平行**（不是它的子路径）。 */
export const LIVE_PREFIX = '/w/';

/**
 * 签名 payload 里"取的是哪一份"那一格，活地址用**哨兵** `live`。
 *
 * 🔴 为什么用哨兵而不是"没有这一格"：`app-serve.js` 的 `signPayload` /
 *    `signEntry` / `verifyEntry` **一个字都不许改**（签名照旧：同一把键、同一个
 *    TTL、同样四道验）。把版本号那一格换成常量 `live` ⇒
 *    ① 复用的还是同一套函数；② 那条**域分离**：制品 URL 的签名拿到活地址上
 *    过不了（反之亦然）—— 一份签名只对"它当初签的那条路"有用。
 */
export const LIVE_VERSION = 'live';

/** 入口的默认名（那一间清单里没写 `entry` 时就是它）。 */
export const LIVE_ENTRY = 'index.html';

/**
 * **工作区里不对外**的那几段名字（除了 `.` 开头那条规则之外）。
 *
 * `build` 是"造它的时候中间产出的东西"，不是页面的那一份 ⇒ 不进沙箱。
 */
export const LIVE_DENIED_SEGMENTS = Object.freeze(['build']);

/** 同一间连着写好几下（原子写会 `rename` 两次）时，把通知合成一下。 */
export const LIVE_WATCH_DEBOUNCE_MS = 120;

/**
 * 解析 `/w/<id>/<rel>`。**解析不出来一律 `null`**（不猜）。
 *
 * ⚠️ 这里只做"形状"（和 `parseArtifactPath` 同一条纪律）：
 *    **真正的白名单在 `checkLiveRel`**，两道都要 —— 而 `app-serve.js` 里那道
 *    在**碰工作区之前**（反例钉在判据里）。
 */
export function parseLivePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(LIVE_PREFIX)) return null;
  const rest = pathname.slice(LIVE_PREFIX.length);
  const parts = rest.split('/');
  if (parts.length < 2) return null;
  const [id, ...tail] = parts;
  const rel = tail.join('/');
  if (!id || !rel) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  return { id, rel };
}

/**
 * **活文件的白名单**。不合法 ⇒ **抛**（人话）。
 *
 * 顺序刻意：先走 `checkRelPath`（越界/形状），再逐段查 `.` 与保留名 ——
 * 于是"这是一个越界路径"和"这是工作区自己的账"两句话分得开（排障时看得懂）。
 */
export function checkLiveRel(rel) {
  checkRelPath(rel); // 非空 / 长度 / 绝对 / 反斜杠 / 控制字符 / 字符集 / 空段 / . / ..
  for (const seg of String(rel).split('/')) {
    if (seg.startsWith('.')) {
      throw new AppsError(`工作区里以 "." 开头的文件不对外（那是它自己的账或数据）：${rel}`);
    }
    if (LIVE_DENIED_SEGMENTS.includes(seg)) {
      throw new AppsError(`工作区里 "${seg}/" 不对外（那不是页面的一部分）：${rel}`);
    }
  }
  return rel;
}

/** 白名单那一句的**布尔版**（调用方只想问"行不行"时用它，规则仍只有上面一处）。 */
export function liveRelOk(rel) {
  try {
    checkLiveRel(rel);
    return true;
  } catch {
    return false;
  }
}

/**
 * **入口只有一个**：那一间清单里那个（默认 `index.html`）。
 *
 * ⚠️ 认不出来（空 / 白名单不过 / 老的制品里那个 entry 是怪东西）⇒ **退回
 *    `index.html`**，绝不把那条 URL 拼成一条取不到的路（"点了没反应"最忌）。
 */
export function liveEntryOf(entry) {
  const e = typeof entry === 'string' && entry !== '' ? entry : LIVE_ENTRY;
  return liveRelOk(e) ? e : LIVE_ENTRY;
}

/** **"这一间的内容变了"那一帧**（瞬态事件：不占号、不落盘 —— 见 `app-events.js` 那条纪律）。 */
export const APP_WORKSPACE_CHANGED = 'app/workspace-changed';

/**
 * 那一帧的形状（**只有这一处**：推送与判据都用它）。
 *
 * 🔴 **帧里只有 id**：没有签名 URL（短时效）、没有内容、没有版本号 ——
 *    它只是"**你现在开着的那一页该重取一次**"这个信号。
 * 🔴 **瞬态**（`emitTransient`）：不占号、不落盘 ⇒ 重连/补发**不会**把它再送一遍
 *    （它不是"盘上的事实"，是"现在这一刻"）。
 * 🔴 **`scopeId` 由调用方盖**（`ScopeView`）⇒ 实时那一侧按焦点路由
 *    （`server.js` 那行 `eventInScope(event, focus)`）：**只有正开着这一间的那条连接收得到**。
 */
export function appWorkspaceChangedEvent({ id, at = Date.now() } = {}) {
  return { type: APP_WORKSPACE_CHANGED, id: String(id), at };
}

/** 认一帧是不是它。认不出 ⇒ `null`（**安静忽略**，协议只加不改）。 */
export function appWorkspaceChangeOf(event) {
  if (!event || event.type !== APP_WORKSPACE_CHANGED) return null;
  const id = event.id;
  if (typeof id !== 'string' || id === '') return null;
  return { id };
}

/**
 * **看着一间工作区**：里面**能被页面用到的文件**被写过 ⇒ 叫一声 `onChange(scope)`。
 *
 * ── 为什么必须是"看着盘"而不是"挂在某个写入函数上"────────────
 * 🔴 他改那一份的**主要方式**是让助手在**那个目录里干活**（工作区就是 agent 的 cwd）——
 *    那是**直接的 `write` 系统调用**，根本不经过我们的任何函数。挂在
 *    `AppWorkspaces.write()` 上的话，"助手改完你屏幕上就变了"这件事**只对
 *    `app_create` 那条路成立**（真机一改就露）。
 *
 * ── 三条边界 ──────────────────────────────────────────────
 *   · 只认**白名单里的路径**（`scopeOf` 的回话）：`.hupo.json` / `build/` / 临时文件
 *     被写 ⇒ **不叫**（那些东西页面看不见，叫了就是白发一次重载）；
 *   · **合一合**（`debounceMs`）：原子写一次会来好几个事件，别让客户端连着换几帧；
 *   · **看不住就说出来**（`log`），绝不静默 —— 那意味着"他改了屏幕上不会变"。
 *
 * ⚠️ `watch` / `fs` / `now` 都是注入的：判据在 VM 上直接驱动（不必真有 inotify）。
 */
export function createLiveWatcher({
  root,
  scopeOf,
  onChange,
  watch = nodeFs.watch,
  fs = nodeFs,
  debounceMs = LIVE_WATCH_DEBOUNCE_MS,
  now = Date.now,
  log = () => {},
} = {}) {
  if (typeof root !== 'string' || root === '') throw new AppsError('工作区根必填');
  if (typeof scopeOf !== 'function') throw new AppsError('scopeOf 必填（哪条路径算哪一间）');
  if (typeof onChange !== 'function') throw new AppsError('onChange 必填');
  let watcher = null;
  const timers = new Map(); // scope → 定时器
  const lastFired = new Map(); // scope → 上一次叫的时间（排障/判据看）

  function fire(scope) {
    timers.delete(scope);
    lastFired.set(scope, now());
    try {
      onChange(scope);
    } catch (err) {
      log(`活的工作区：通知没发出去（${scope}）：${err?.message ?? err}`);
    }
  }

  /** 记一笔"这一间刚被写过"。**同一间连着来 ⇒ 合成一下**（后一下为准）。 */
  function note(scope) {
    if (typeof scope !== 'string' || scope === '') return false;
    const had = timers.get(scope);
    if (had) clearTimeout(had);
    const timer = setTimeout(() => fire(scope), debounceMs);
    timer.unref?.();
    timers.set(scope, timer);
    return true;
  }

  function handle(_event, filename) {
    let scope = null;
    try {
      scope = scopeOf(filename);
    } catch {
      scope = null; // 认不出就当没看见（看不住东西不该把服务带走）
    }
    note(scope);
  }

  function start() {
    if (watcher) return true;
    // ⚠️ 根不在就先建出来（`workspace.js` 自己那条 `ensure` 也是这么建的）：
    //    不建的话"他第一次造一个小程序"时这个 watcher **还没看上** ⇒ 那一次改了不通知。
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch {
      /* 建不出来下面那一句会说 */
    }
    try {
      watcher = watch(root, { recursive: true }, handle);
      // ⚠️ **不许让它把进程留着**：`fs.watch` 的句柄默认会撑住事件循环
      //    ⇒ 收工那一路（`shutdown-budget.js`）走完了进程还站着，就只能等 SIGKILL。
      //    `unref()` 之后它照样看着盘，但**不拦着退出**（收工那几步一个字都不用改）。
      watcher?.unref?.();
      watcher?.on?.('error', (err) => {
        log(`活的工作区：${root} 看不住了（${err?.message ?? err}）—— 那边改了不会自己换`);
      });
      return true;
    } catch (err) {
      watcher = null;
      log(`活的工作区：${root} 看不住（${err?.message ?? err}）—— 那边改了不会自己换`);
      return false;
    }
  }

  function stop() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    const w = watcher;
    watcher = null;
    try {
      w?.close();
    } catch {
      /* 已经没了 */
    }
  }

  return {
    start,
    stop,
    /** 判据用：把"某一间刚被写过"直接喂进来（不必真有 inotify）。 */
    note,
    /** 判据用：走 `fs.watch` 那个回调的同一条路（含 `scopeOf` 的过滤）。 */
    handle,
    get watching() {
      return watcher !== null;
    },
    get lastFired() {
      return new Map(lastFired);
    },
  };
}
