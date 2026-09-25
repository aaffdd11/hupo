// **把"那一间"整个回收掉**（契约 `docs/dev/103-APP-DELETE.md` §七 · 决策 **D3.11**）。
//
// ── 它替掉的是什么 ────────────────────────────────────────
// 第一轮（`103` §一/§三/§四）的 `Apps.remove(id)` **只动制品库那一格**
// （软删进 `.removed/` ＋ 审计）。而主人 2026-09-25 拍的是**真回收**：
// 从桌面上删掉一个图标 = 把**那一间**也一起拿走。
//
// ── 一起拿走的四样 ＋ 留下来的两样（§7.1）──────────────────
//   ① 制品那一格（含 `usage.jsonl`）→ `into/`（**`Apps.remove()` 已经搬好了**）
//   ② 那一间的工作区 `<dir>/workspaces/<id>/`        → `into/workspace/`
//   ③ 那一间的对话（`main.jsonl` 里 `scopeId==id` 的行）→ `into/conversation.jsonl`
//   ④ 助手那一侧的原件（`<DSH_HOME>/sessions/<slug>/`）→ `into/session/`
//   ✅ 审计：`apps/audit.jsonl` 多一行（`Apps.remove()` 写）
//   ✅ 用量：随 ① 一起进 `into/`（**不是消失** · U-8）
//
// ── 三条不许破 ────────────────────────────────────────────
//   ① 🔴 **号一个都不许重编**：③ 只把那一间的行**抽走**，`main.jsonl` 里别的行
//      原样保留（`store.rewrite()` 要求每条带它原来的 `seq`）。抽走留下的号洞
//      **必须留痕**（`reclaimed.json` 的 `takenSeqs`）—— 这就是 N22 的**唯一例外**，
//      校验器 `store.verifyMonotonic(id, { reclaimed })` 按它解释洞（§7.3）。
//   ② 🔴 **一处实现**：宿主那条路与盒里那条路都落在这里（落点是 `Apps.remove()`，
//      见 `apps.js`）—— 不许两处各抄一遍。
//   ③ 🔴 **失败不许留"删了一半"**：任一步做不成 ⇒ 把这一步之前搬走的**搬回去**、
//      把那条日志**原样写回**，再**抛**。⇒ 调用方只有两条路：全成（`{ok:true}`）
//      或者如实 503/500（回执里**没有**第二种成功形状）。
//
// ⚠️ 它**不**做（§7.6 / 契约）：不给回收处加定时清理；**不动** `jobs.jsonl`
//    （那是主进程"我干过什么"的账，不是那一间的东西）。
// ⚠️ ③ 的"号洞"只在**中间**（后面还有别的行）时容得下反向校验；要是被拿走的
//    正好是**尾巴**上那几条，外面没有"更晚的号"作参照 ⇒ 那种截断本来就无从分辨
//    （见 `test/app-reclaim.test.js` S8 的说明）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

// ⚠️ **只借这个纯函数**（会话目录名 = cwd 的路径 slug）。它住 `prune.js`，
//    与本模块没有环；抄一份到这里就会漂（`serve.js` 清会话那一处用的是同一个）。
import { groupSlugFor } from './prune.js';

/**
 * ★ **"按房间回收"那条路上的错**（B28：一间**没有制品**的工作区怎么拿走）。
 *
 * 🔴 它带 `status`：调用方（宿主那条 HTTP 口 / 盒里那条内部口）据此**如实回同一个码**，
 *    而不是把"没有这一间"说成 500、"内置那几间不许动"说成 404。
 * ⚠️ `message` 本身就是**人话**（照 `AppsError` 那条既有规矩）。
 */
export class RoomReclaimError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RoomReclaimError';
    this.status = status;
  }
}

/**
 * 留痕那个文件名（**只有这一处**：写它的、扫它的、判据读的都是这一个常量）。
 */
export const RECLAIMED_FILE = 'reclaimed.json';

/**
 * 那个 scope 名字能不能当目录名。
 *
 * ⚠️ 形状与 `apps.checkAppId` 相同，但这里**不 import 它**：`apps.js` 反过来
 *    import 本模块（`remove()` 调 `reclaimScope()`）—— 成环不划算。
 *    调用方（`Apps.remove`）**已经**过了那道闸，这里只是"别拿一个带 `/` 的名字
 *    去拼路径"的最后一道防呆。
 */
const SAFE_SCOPE = /^[a-z0-9][a-z0-9-]*$/;

function assertScopeName(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!SAFE_SCOPE.test(s) || s.length > 64) {
    throw new Error(`要回收的那一间名字不合法：${String(raw).slice(0, 60)}`);
  }
  return s;
}

function exists(fs, p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 原子写（先写 `.tmp` 再 rename）—— 同 `store` / `apps` 的既有做法。 */
function writeAtomic(fs, file, text, mode = 0o644) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

/**
 * **搬一格**（`rename`；跨设备时退化成"拷过去再删源"）。
 *
 * ⚠️ 为什么留着 `EXDEV` 那条退路：工作区 / `DSH_HOME` / 制品库**不一定在同一个
 *    挂载点**上（盒子里它们都在 `/data` 下，主人那一份的 `DSH_HOME` 在别处）。
 *    `rename` 跨设备会 `EXDEV`，那时"删了源却没拷成"是**唯一不可接受**的结果 ⇒
 *    顺序必须是**先拷全、再删源**（`cpSync` 成功之后才 `rmSync`）。
 */
function relocate(from, to, fs) {
  try {
    fs.renameSync(from, to);
    return 'rename';
  } catch (err) {
    if (err?.code !== 'EXDEV' || typeof fs.cpSync !== 'function') throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
    return 'copy';
  }
}

/**
 * **把那一间整个回收进 `into`**（一处实现 · §7.2）。
 *
 * 🔴 调用方**必须**已经先做完 `Apps.remove(id)`（制品那一格已经进了 `into`）。
 *    本函数只负责另外三样 ＋ 留痕 ＋ 自检；任一步失败会把已经做的**全部退掉**
 *    并抛出（**不留"删了一半"**）。
 *
 * @param {object} o
 * @param {string} o.id                 哪一间（= 那个小程序的 id / scope）
 * @param {string} o.into               回收处（`<appsRoot>/.removed/<id>-<at>`）
 * @param {(scope:string)=>string} o.cwdFor 那一间的工作目录（工作区 ＝ agent 的 cwd）
 * @param {string} o.dshHome            助手那一侧的 `DSH_HOME`（会话记录在它下面）
 * @param {import('./store.js').Store} o.store 那条日志（③ 从它抽行）
 * @param {string} [o.timelineId]       那条日志的 id（默认 `main`）
 * @param {object} [o.unread]           `UnreadBook`（有就清掉那一间的记数）
 * @param {object} [o.work]             `WorkLog`（有就把那一间开着的活收成"已停"）
 * @param {boolean} [o.hasApp]          **制品那一格是不是已经搬走了**（默认 `true`）。
 *    `false` = **这一间根本没有制品**（"按房间回收"那条路 · B28）：这条路
 *    **不动制品库**，只搬工作区 / 那一间的对话 / 助手那边的原件 —— 留痕里
 *    `items.app` 如实写 `false`（不许把它记成"有个制品被拿走了"）。
 * @param {string} [o.sub]              谁（写进留痕的"谁删的"）
 * @param {number} [o.at]               什么时候
 * @param {object} [o.fs]               注入文件系统（测试用）
 * @param {(m:string)=>void} [o.log]
 * @returns {object} 写进 `reclaimed.json` 的那份记录
 */
export function reclaimScope({
  id,
  into,
  cwdFor,
  dshHome,
  store,
  timelineId = 'main',
  unread = null,
  work = null,
  sub = null,
  hasApp = true,
  at = Date.now(),
  fs = nodeFs,
  log = () => {},
} = {}) {
  const scope = assertScopeName(id);
  if (typeof into !== 'string' || into === '') throw new Error('回收处（into）必填');
  if (typeof cwdFor !== 'function') throw new Error('回收要知道那一间的工作目录（cwdFor 必填）');
  if (typeof dshHome !== 'string' || dshHome === '') {
    throw new Error('回收要知道 DSH_HOME（助手那边的会话记录在那儿）');
  }
  if (!store) throw new Error('回收要 store（那一间的对话在那条日志上）');

  const cwd = cwdFor(scope);
  if (typeof cwd !== 'string' || cwd === '') throw new Error('那一间的工作目录取不到');

  /** 已经做过的事（失败时**后进先出**地退回去）。 */
  const undo = [];
  let committed = false;
  try {
    fs.mkdirSync(into, { recursive: true, mode: 0o755 });

    const items = { app: hasApp === true, workspace: false, conversation: 0, session: false };

    // ② 那一间的工作区
    if (exists(fs, cwd)) {
      const dest = nodePath.join(into, 'workspace');
      relocate(cwd, dest, fs);
      undo.push(() => relocate(dest, cwd, fs));
      items.workspace = true;
    }

    // ④ 助手那一侧的原件（会话目录名 = cwd 的路径 slug）
    const group = nodePath.join(dshHome, 'sessions', groupSlugFor(cwd));
    if (exists(fs, group)) {
      const dest = nodePath.join(into, 'session');
      relocate(group, dest, fs);
      undo.push(() => relocate(dest, group, fs));
      items.session = true;
    }

    // ③ 那一间的对话：**抽走**（别的行的号一个都不动），抽出来的落 `conversation.jsonl`
    const all = store.readAll(timelineId);
    const taken = [];
    const kept = [];
    const takenSeqs = [];
    for (const e of all) {
      const tag = e?.scopeId;
      // ⚠️ 认法**只这一处**：`scopeId` 等于这一间就是它的行。主线（没有这个字段）
      //    与别的间一律**原样留**。
      if (tag !== undefined && tag !== null && tag !== '' && String(tag) === scope) {
        taken.push(e);
        if (Number.isInteger(e.seq)) takenSeqs.push(e.seq);
      } else {
        kept.push(e);
      }
    }
    const convPath = nodePath.join(into, 'conversation.jsonl');
    fs.writeFileSync(convPath, taken.map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o644 });
    undo.push(() => {
      try {
        fs.rmSync(convPath, { force: true });
      } catch {
        /* 尽力 */
      }
    });
    if (taken.length > 0) {
      store.rewrite(timelineId, kept);
      // 失败就把整条日志**原样写回**（一个字节都不带走）
      undo.push(() => store.rewrite(timelineId, all));
    }
    items.conversation = taken.length;

    // **自检（放在最前面那两样"退不回来"的事之前）**：回收之后那条日志必须自洽 ——
    // 洞要么在留痕里解释得了，要么当场红。把**这一批新号**并进现有留痕一起判。
    // ⚠️ 这一步把"号洞有留痕"从"写文档的纪律"变成**回收自己过不去就退回**的闸。
    const merged = [...new Set([
      ...readReclaimedSeqs({ removedRoot: nodePath.dirname(into), fs, log }),
      ...takenSeqs,
    ])].sort((a, b) => a - b);
    store.verifyMonotonic(timelineId, { reclaimed: merged });

    // 那一间的**未读记数**：事实已经不在日志上了，留着就是一条指向空房间的账。
    // ⚠️ 它**不是**"留下来的两样"之一（那两样是审计与用量）—— 清掉只是不许留脏账。
    let unreadWas = null;
    if (unread && typeof unread.forget === 'function') {
      unreadWas = unread.forget(scope);
      if (unreadWas !== null && unreadWas !== undefined && typeof unread.markRead === 'function') {
        undo.push(() => {
          try {
            unread.markRead(scope, unreadWas);
          } catch {
            /* 尽力 */
          }
        });
      }
    }

    // 那一间**开着的活**（`pending.jsonl`）：房间都没了，那些活永远不会有下一句。
    // ⇒ 逐件**诚实收成"已停"**（`stopped`）—— 留着开着的记录就是"发不出去的话"，
    //   而"没有消失"那条不变量要的是**有收口**，不是留着开口。
    // ⚠️ 这一步是**只追加**的（`work/close` 落进 `pending.jsonl`）：万一它之后的某一步
    //    失败，已经收掉的活**退不回来**（本账没有"复活一条收了口的活"这条路）。
    //    ⇒ 所以校验（上面那一步）被放到它**之前**；这里之后只剩写留痕那一次原子写。
    let settledWork = [];
    if (work && typeof work.settleScope === 'function') {
      settledWork = work.settleScope(scope, { reason: '这一间被回收了' }) ?? [];
    }

    // **留痕**（N22 的唯一例外）：哪一间、被拿走的号、什么时候、谁删的
    const record = {
      v: 1,
      scopeId: scope,
      at,
      by: sub ?? null,
      takenSeqs: [...takenSeqs].sort((a, b) => a - b),
      items,
      unreadWas: unreadWas ?? null,
      settledWork,
    };
    const recPath = nodePath.join(into, RECLAIMED_FILE);
    writeAtomic(fs, recPath, `${JSON.stringify(record, null, 2)}\n`);
    undo.push(() => {
      try {
        fs.rmSync(recPath, { force: true });
      } catch {
        /* 尽力 */
      }
    });

    // 落痕之后再核一次（这一次是**从盘上**把留痕读回来 —— 上面那次是内存里并的）。
    store.verifyMonotonic(timelineId, {
      reclaimed: readReclaimedSeqs({ removedRoot: nodePath.dirname(into), fs, log }),
    });

    committed = true;
    return record;
  } finally {
    if (!committed) {
      // 后进先出地退回去：任一步没做成 ⇒ 现场**不许**是"删了一半"
      for (const step of undo.reverse()) {
        try {
          step();
        } catch (err) {
          log(`回收回滚有一处没退干净：${err?.message ?? err}`);
        }
      }
    }
  }
}

/**
 * **扫那份回收留痕**：`<removedRoot>/<每一格>/reclaimed.json` 里 `takenSeqs` 的并集。
 *
 * 🔴 校验器只认它：洞在这个集合里 ⇒ 过；不在 ⇒ 红。
 * ⚠️ 读不懂的那一份**跳过**（不是"当它没洞"）—— 跳过的代价是它解释不了自己的洞，
 *    于是校验器**如实红**（fail-closed 的那一侧）。
 *
 * @param {object} o
 * @param {string} o.removedRoot `<...>/.removed`（**调用方给**，本模块不猜那个目录名）
 * @param {object} [o.fs]
 * @param {(m:string)=>void} [o.log]
 * @returns {number[]} 升序的号
 */
export function readReclaimedSeqs({ removedRoot, fs = nodeFs, log = () => {} } = {}) {
  const out = new Set();
  if (!removedRoot) return [];
  let kids;
  try {
    kids = fs.readdirSync(removedRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') log(`回收留痕没扫动：${err?.message ?? err}`);
    return [];
  }
  for (const d of kids) {
    if (!d.isDirectory()) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(nodePath.join(removedRoot, d.name, RECLAIMED_FILE), 'utf8'));
    } catch {
      continue; // 没有 / 坏的那一份跳过（它解释不了洞 ⇒ 校验器会红）
    }
    for (const s of j?.takenSeqs ?? []) if (Number.isInteger(s)) out.add(s);
  }
  return [...out].sort((a, b) => a - b);
}
