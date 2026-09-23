// 续传与补发。手册 `08-SPEC.md` §2.2 / §2.3，决策 **P-h**。
//
// 协议这边最容易搞错的两件事：
//
//   1. **`catchUp` 只在"续传游标 > 0"时才标。**
//      首次打开时客户端报 `sinceSeq = 0`，服务端会把**全量历史**补给它——
//      那不是"你不在的时候"，那是"历史本身"。标错了，
//      界面会把整段历史渲染成"断线补发"，而且**每次新装都会这样**。
//
//   2. **客户端的号可能比我们大**（日志被换过、或者它连的是另一条线）。
//      这时不能"什么都不发"——那会让界面**永远停在一个已经不存在的世界上**。
//      要明确告诉它"**从头来**"。
//
// 这两条都是纯函数，故意不碰 IO：好测，也容易进硬闸。

/**
 * @param {object} o
 * @param {Array<{seq?: number, type: string}>} o.events  已落盘的事件（顺序：seq 升序）
 * @param {number} o.sinceSeq  客户端上次收到的号（0 = 第一次打开）
 * @returns {{frames: Array<object>, catchUp: boolean, reset: boolean, maxSeq: number}}
 */
export function planResume({ events, sinceSeq = 0 }) {
  if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
    throw new Error(`sinceSeq 必须是非负整数，收到 ${sinceSeq}`);
  }
  const persisted = events.filter((e) => typeof e.seq === 'number');
  const maxSeq = persisted.length === 0 ? 0 : persisted[persisted.length - 1].seq;

  // 客户端的号跑到我们前面去了 ⇒ 它的世界和我们的不是同一个。
  // 明确要求它重置，**不能**当作"没有新东西"。
  if (sinceSeq > maxSeq) {
    return { frames: [], catchUp: false, reset: true, maxSeq };
  }

  const frames = persisted.filter((e) => e.seq > sinceSeq);

  // ⚠️ P-h：只有"曾经连过、断线后重连"才算补发。
  //    sinceSeq === 0 表示"第一次打开"——那是历史，不是"你不在的时候"。
  const catchUp = sinceSeq > 0;

  return { frames, catchUp, reset: false, maxSeq };
}

/**
 * **往前取一页**（主人 2026-09-23 · 批 C：老消息要能往上翻着加载）。
 *
 * 与 `planResume` 同族、同样是**纯函数**（不碰 IO ⇒ 好测、进硬闸）。
 *
 * ⚠️ 三条口径：
 *   ① 返回的是**原始带号事件**（和流里那些一模一样，含墓碑）——
 *      客户端那一侧本来就要按同样的规则去重/隐藏，这里**不许替它筛**
 *      （筛两遍 = 两处口径，迟早会漂）；
 *   ② 取的是"**比 `before` 更早**的最后 `limit` 条"，按 seq **升序**给
 *      （客户端拿到就能直接接在前面）；
 *   ③ `hasMore` 说的是"**这一页之前还有**"，客户端据此决定还要不要继续取
 *      （**不许猜**：没有更多就该停，而不是一遍遍问）。
 *
 * @param {object} o
 * @param {Array<{seq?: number, type: string}>} o.events 已落盘事件（seq 升序）
 * @param {number} o.before 客户端的"最老那一号"（取严格早于它的）
 * @param {number} o.limit  一页最多几条（上限住代码里，调用方给）
 * @returns {{frames: Array<object>, oldestSeq: number|null, hasMore: boolean}}
 */
export function planBackfill({ events, before, limit }) {
  if (!Number.isInteger(before) || before < 0) {
    throw new Error(`before 必须是非负整数，收到 ${before}`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`limit 必须是正整数，收到 ${limit}`);
  }
  const persisted = events.filter((e) => typeof e.seq === 'number' && e.seq < before);
  // 最后 limit 条（离客户端最近的那一页），再按升序给出去
  const page = persisted.slice(Math.max(0, persisted.length - limit));
  return {
    frames: page,
    oldestSeq: page.length > 0 ? page[0].seq : null,
    hasMore: persisted.length > page.length,
  };
}

/**
 * 给一帧打上补发标记。
 *
 * ⚠️ **必须浅拷贝**：事件对象是从日志里读出来的，
 * 直接改它会把"补发"这个**线上标记**写进磁盘。
 * （手册 §2.2 专门点了这一条。）
 */
export function markCatchUp(frame, catchUp) {
  if (!catchUp) return frame;
  return { ...frame, catchUp: true };
}

/**
 * 补发段的渲染规则（**客户端**守它，不是服务端）。
 *
 * 手册 §2.3 的 P-2 说得很清楚：这不是服务端规则——
 * 补发只是重放日志，服务端**没有"条数"概念**。
 * 所以这里导出的是一个**约定**，给客户端与测试共用：
 * 补发段只用"历史"长相渲染，**不参与"谁还没收口"的排队**。
 */
export const CATCHUP_RENDER = Object.freeze({
  style: 'history', // 不闪、不动画、不装作"刚发生"
  participatesInQueue: false, // 不参与"同一时刻最多一条未收口"
});
