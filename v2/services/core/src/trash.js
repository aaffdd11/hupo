// 回收站：**删掉 → 30 天 → 真删**（批 3 第二件 · 契约 `docs/dev/28-DELETE.md`）。
//
// 三条不许破（都能在契约里找到出处）：
//   ① **删掉 = 落一条墓碑**，不是从日志里挖洞 —— N22：编号只增不减；
//   ② **真删 = 压实**：把那一轮的事件**换成最小占位、保留各自的 seq**
//      （只追加是删不掉字节的，所以只能重写；`Store.rewrite` 是 append-only 的唯一例外）；
//   ③ **那份清单是从状态清单推出来的**（`03-DEVELOPMENT.md` §4.7），**不是手写的几句话**
//      —— 手写的一定漏，漏一项就是"屏幕上说删了、其实还在"（**说假话**）。
//
// ⚠️ 键是 **`messageIds`**（不是 `turn`）：实测真日志里**没有轮号**
//    （`message/status` / `step/*` 上的 `turn` 是瞬态的，盘上留不下）。
//    一轮 = 一条用户的话 + 它的回答，**这两个 id 由客户端给**（它本来就知道怎么配的对）。

/** X3：进回收站之后默认留多久。 */
export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** X3：到期前多久要"告"一声。⚠️ 这一件只记账，**那句话留给系统通知**（契约 §七）。 */
export const TRASH_WARN_MS = 7 * 24 * 60 * 60 * 1000;

export const TOMB_DELETED = 'turn/deleted';
export const TOMB_RESTORED = 'turn/restored';
export const TOMB_PURGED = 'turn/purged';

const isId = (v) => typeof v === 'string' && v !== '';

/** 一组 id 的稳定键（顺序无关：同一轮传成两种顺序要认成同一件事）。 */
const keyOf = (ids) => [...ids].sort().join('\u0000');

/** 规整：去重、去空、排序。**认不出来的直接丢掉**（不许把畸形输入带进日志）。 */
export function normIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isId))].sort();
}

/**
 * **状态清单一览**（`03-DEVELOPMENT.md` §4.7）——"删掉"要逐条覆盖的就是它。
 *
 * ⚠️ 为什么把它摆成一张表、而不是在 `plan()` 里手写几句话：
 *    **手写的一定漏**，而漏一项 = 屏幕上说"删掉了"、其实还在（**说假话**）。
 *    摆成表之后，`test/trash.test.js` 有一条闸断言"§4.7 的每一行都有对应的一条"
 *    —— 少一行就红。手册将来加了新的一行，那条闸会提醒回来补这里。
 *
 * `verdict`：`delete` = 我们会删掉它；`cannot` = **删不掉，必须如实说出来**；
 *            `skip` = 它**不是用户的内容**（列进清单反而是噪音，所以不进清单）。
 */
export const STATE_SURFACES = Object.freeze([
  {
    stateRow: '/data/main/',
    what: '你选的那一轮（你说的话 + 它的回答）',
    where: '这条对话',
    verdict: 'delete',
    note: '立刻从屏幕上消失。',
  },
  {
    stateRow: '$DSH_HOME/sessions/',
    what: '它记在记忆里的那一段',
    where: '它的记忆',
    verdict: 'cannot',
    note: '记忆是按整段对话存的，抽不掉单独一轮 —— 要等这段对话的记忆被重建，那一段才会消失。',
  },
  {
    stateRow: '$DSH_HOME/storages/',
    what: '记忆的投影与检查点里那一段',
    where: '它的记忆',
    verdict: 'cannot',
    note: '同上：它跟着整段对话走，抽不掉单独一轮。',
  },
  {
    stateRow: '/data/workspaces/*/',
    what: '（这条对话之外的东西）',
    where: '——',
    verdict: 'skip',
    note: '不在这条对话里，不会被这一下碰到。',
  },
  {
    stateRow: '/data/hupo/memory/',
    what: '——',
    where: '——',
    verdict: 'skip',
    note: '这一处还没建。',
  },
  {
    stateRow: '/data/hupo/audit/',
    what: '——',
    where: '——',
    verdict: 'skip',
    note: '这一处还没建。',
  },
  {
    stateRow: '$DSH_HOME/.credentials.yaml',
    what: '——',
    where: '——',
    verdict: 'skip',
    note: '那是钥匙，不是你说的话。',
  },
]);

/** 这台设备上留的那一份 —— **服务端删不掉它，客户端要跟着清**（契约 §四 🔴）。 */
const DEVICE_SURFACE = {
  stateRow: '（本机那一屏）',
  what: '你正在用的这台设备上留的那一屏',
  where: '这台设备',
  verdict: 'delete',
  note: '跟着清掉 —— 刷新之后也不会再冒出来。',
};

export class TrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrashError';
  }
}

export class Trash {
  #timeline;
  #store;
  #timelineId;
  #now;
  #ttlMs;
  /** key → `{messageIds, at, seq}`（**在回收站里的**；恢复了就没了） */
  #bin = new Map();
  /** 已经真删掉的 id（内容不在盘上了） */
  #purged = new Set();

  /**
   * @param {object} o
   * @param {import('./timeline.js').Timeline} o.timeline 墓碑要经它落盘（取号 + 推订阅者）
   * @param {import('./store.js').Store} o.store
   * @param {string} [o.timelineId] 一条可见时间线 = 一条日志
   * @param {() => number} [o.now]
   * @param {number} [o.ttlMs]
   */
  constructor({ timeline, store, timelineId = 'main', now = Date.now, ttlMs = TRASH_TTL_MS }) {
    this.#timeline = timeline;
    this.#store = store;
    this.#timelineId = timelineId;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  get ttlMs() {
    return this.#ttlMs;
  }

  get ttlDays() {
    return Math.round(this.#ttlMs / (24 * 60 * 60 * 1000));
  }

  /**
   * **从盘上重建**：谁被删过、谁已经真删了。
   *
   * ⚠️ 它是"重启还记得"的一部分：不 sync 的话，重启之后回收站是空的
   *    —— 而屏幕上那些话还藏着，用户会以为永远拿不回来了。
   */
  sync() {
    this.#bin.clear();
    this.#purged.clear();
    for (const e of this.#store.readAll(this.#timelineId)) {
      const ids = normIds(e?.messageIds);
      if (ids.length === 0) continue;
      if (e.type === TOMB_DELETED) {
        this.#bin.set(keyOf(ids), { messageIds: ids, at: e.at ?? this.#now(), seq: e.seq });
      } else if (e.type === TOMB_RESTORED) {
        this.#bin.delete(keyOf(ids));
      } else if (e.type === TOMB_PURGED) {
        this.#bin.delete(keyOf(ids));
        for (const id of ids) this.#purged.add(id);
      }
    }
    return this;
  }

  /** 这个 id 的内容**已经不在盘上**了（真删过）。 */
  isPurged(messageId) {
    return this.#purged.has(messageId);
  }

  /** 这个 id 现在**藏起来**（在回收站里）。 */
  isHidden(messageId) {
    for (const t of this.#bin.values()) if (t.messageIds.includes(messageId)) return true;
    return false;
  }

  /** 回收站里有什么。`purgeAt` 是"到这一刻会真删"。 */
  list() {
    const items = [];
    for (const t of this.#bin.values()) {
      items.push({
        messageIds: t.messageIds,
        at: t.at,
        purgeAt: t.at + this.#ttlMs,
        // ⚠️ 只给 id 和预览位置，**不在这条路上读内容**：回收站列表不需要把
        //    被删的话再抄一遍（那反而让它多出现在一个地方）。
        preview: `${t.messageIds.length} 条`,
        warnAt: t.at + this.#ttlMs - TRASH_WARN_MS,
      });
    }
    items.sort((a, b) => a.at - b.at);
    return items;
  }

  /**
   * **删前那份清单**（契约 §四）。⚠️ 从状态清单推，不手写。
   *
   * ⚠️ 里面**必须有一条 `verdict:"cannot"`** —— 记忆那一层**按轮抽不掉**（契约 §五）。
   *    把它藏起来、或者写成"已全部删除"，就是**说假话**。
   */
  plan(messageIds, { now = this.#now() } = {}) {
    const ids = normIds(messageIds);
    const ttlDays = this.ttlDays;
    if (ids.length === 0) {
      return {
        messageIds: [],
        items: [{
          what: '没有指明要删哪一条',
          where: '——',
          verdict: 'cannot',
          note: '所以什么都没删。',
        }],
        purgeAt: null,
        ttlDays,
      };
    }
    const onDisk = new Set();
    for (const e of this.#store.readAll(this.#timelineId)) {
      if (isId(e?.messageId)) onDisk.add(e.messageId);
    }
    const gone = ids.filter((id) => !onDisk.has(id));

    const items = [
      // ⚠️ 先摆"会真的删掉的"（服务端这一处 + **这台设备那一处**）……
      ...STATE_SURFACES.filter((s) => s.verdict === 'delete'),
      DEVICE_SURFACE,
      // ……再摆"删不掉的"。**这一条不许省**（契约 §五）：藏起来就是**说假话**。
      ...STATE_SURFACES.filter((s) => s.verdict === 'cannot'),
      {
        stateRow: '（回收站）',
        what: `留在回收站里的这一份（${ttlDays} 天）`,
        where: '回收站',
        verdict: 'delete',
        note: '这段时间里随时能拿回来；到点会自动彻底删掉。',
      },
    ].map(({ stateRow, ...rest }) => rest);
    if (gone.length > 0) {
      items.push({
        what: `有 ${gone.length} 条已经不在对话里了`,
        where: '——',
        verdict: 'cannot',
        note: '它们没被算进去。',
      });
    }
    return { messageIds: ids, items, purgeAt: now + this.#ttlMs, ttlDays };
  }

  /** **删掉**：进回收站（落墓碑）。 */
  remove(messageIds, { now = this.#now() } = {}) {
    const ids = normIds(messageIds);
    if (ids.length === 0) throw new TrashError('没说删哪一条');
    const k = keyOf(ids);
    const already = this.#bin.get(k);
    if (already) return already; // 幂等：删两次不会产生两条墓碑
    for (const id of ids) {
      if (this.#purged.has(id)) throw new TrashError('这一条已经彻底删掉了');
    }
    const full = this.#timeline.emit({ type: TOMB_DELETED, messageIds: ids, at: now });
    const rec = { messageIds: ids, at: now, seq: full.seq };
    this.#bin.set(k, rec);
    return rec;
  }

  /** **恢复**：从回收站拿回来（落一条撤销墓碑）。 */
  restore(messageIds) {
    const ids = normIds(messageIds);
    if (ids.length === 0) throw new TrashError('没说恢复哪一条');
    const k = keyOf(ids);
    if (!this.#bin.has(k)) return false;
    this.#timeline.emit({ type: TOMB_RESTORED, messageIds: ids });
    this.#bin.delete(k);
    return true;
  }

  /**
   * **真删**（立刻彻底删）：把这一轮的事件**压实掉**。
   *
   * 顺序有意如此（断电也不会留下"以为删了其实没删"的状态）：
   *   ① 先把盘上的**内容**换掉（`Store.rewrite`，原子）
   *   ② 再落一条 `turn/purged` 墓碑（让活着的连接把它从内存里丢掉、也让重启记得）
   *
   * ⚠️⚠️ **这个方法必须从头到尾是同步的**（`readAll` → 压实 → `emit` 中间**不许有 `await`**）。
   *    理由：`Store.rewrite` 是"按 t0 读到的那份重写整条日志"——
   *    中间要是让出过事件循环，别人在这期间 `emit` 的那条事件就会**被这次重写抹掉**
   *    （那是**永久丢数据**，本仓库最贵的那一类）。
   *    Node 单线程 + 这里全是同步调用 ⇒ **构上不可能被插队**。
   *    **以后谁要把它改成 async，就必须同时把日志写入串成一条队列**，别只加个 await。
   */
  purge(messageIds, { now = this.#now() } = {}) {
    const ids = normIds(messageIds);
    if (ids.length === 0) throw new TrashError('没说彻底删哪一条');
    const gone = new Set(ids);
    const before = this.#store.readAll(this.#timelineId);

    let freed = 0;
    const after = [];
    for (const e of before) {
      const mine = isId(e?.messageId) && gone.has(e.messageId);
      const tomb = [TOMB_DELETED, TOMB_RESTORED, TOMB_PURGED].includes(e?.type)
        && normIds(e.messageIds).some((id) => gone.has(id));
      if (!mine && !tomb) {
        after.push(e);
        continue;
      }
      // ⚠️ **保留 seq**：号一个都不许跳（N22 + `verifyMonotonic`）
      const placeholder = { type: TOMB_PURGED, seq: e.seq, at: e.at };
      freed += JSON.stringify(e).length - JSON.stringify(placeholder).length;
      after.push(placeholder);
    }

    this.#store.rewrite(this.#timelineId, after);
    const full = this.#timeline.emit({ type: TOMB_PURGED, messageIds: ids, at: now });
    this.#bin.delete(keyOf(ids));
    for (const id of ids) this.#purged.add(id);
    return { freedBytes: Math.max(0, freed), seq: full.seq };
  }

  /** 到点就真删（回收站里的 `at + ttl` 过了）。给定时扫描用。 */
  purgeExpired({ now = this.#now() } = {}) {
    const due = [];
    for (const t of this.#bin.values()) {
      if (t.at + this.#ttlMs <= now) due.push(t.messageIds);
    }
    const done = [];
    for (const ids of due) done.push({ messageIds: ids, ...this.purge(ids, { now }) });
    return done;
  }

  /** 到期前一周内的（给"告一声"用 —— 这一件只算出来，**那句话留给系统通知**）。 */
  expiringSoon({ now = this.#now() } = {}) {
    return this.list().filter((it) => it.purgeAt - now <= TRASH_WARN_MS);
  }
}
