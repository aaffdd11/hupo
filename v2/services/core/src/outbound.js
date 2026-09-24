// **出界那一条独木桥**（92 §③ 阶段 2 · 契约 `docs/dev/92-TRIPLE-PLAN.md`）。
//
// ── 它解决什么 ────────────────────────────────────────────
// 92 §② 的第三条硬规矩：**可分享必须带锚** ——
//   `share:true` 而缺来源 `rootHash`／输入账／同意记录 ⇒ **不出去**。
// 理由（安全席 R2）：声明不可核 ＝ 把上架闸降级成**作者自证**。
// 92 §③ 阶段 2 把这件事收成**一条路**：上架／交付／制品口**共用一个出口检查**，
// 一处逻辑、一处裁决 —— **不许两处各判一次**。
//
// ── 这条独木桥架在哪 ──────────────────────────────────────
// 往共享库／发现页出去，全仓**只有一个写入者**：`published.js` 的 `publish()`。
// 它的第一件事（在**碰任何盘之前**）就是调这里的 `assertOutboundAllowed()`。
// `test/outbound-gate.test.js` 的「第二出口」那条判据会**扫源码**：提到共享库那两个
// 目录名（`published-apps` / `PUBLISHED_DIR`）的文件只许是 `published.js`，
// 而且它必须真的调了这道闸 —— 谁另开一条出去的路，那条判据就红。
//
// ── 锚是什么 ──────────────────────────────────────────────
// 「锚」＝ **可核起点**（一条 64 位十六进制 sha256，形状与 `apps.rootHashOf` 逐字一致）
// ＋ **血缘**：
//   · 锚 ＝ **这一版自己的 `rootHash`** ⇒ 起点就是它自己（清单里的逐文件 sha 可复算）；
//   · 锚 ＝ **制品库里另一版的 `rootHash`**（分叉／快照那一版）⇒ 必须有一条
//     `lineage.json` 的边指回它，否则报「**血缘对不上**」——
//     自称的来源不算来源（90 Q4.6／§5.2）。
//
// 🔴 **fail-closed**：`.exp/` 在、而声明**读不到 / 认不出** ⇒ **拒**（不是"当没有"）。
// ⚠️ **没有 `.exp/`** ⇒ 一份"可分享"的申报都没有 ⇒ 不拦 ——
//    这是**阶段 2** 的范围（只拦"声明了可分享却无锚"）；**阶段 3** 才把默认值翻过来。
//
// ⚠️ 它**只裁决**，不搬运：这一版不建任何"把 `.exp/` 字节带出去"的路
//    （那是阶段 4／5 的事）。今天它保证的是「**说不清来路的东西，一份都不许出去**」。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { MAX_VERSIONS } from './apps.js';

/** 经验包那一格（`<scope>/.exp/<pack>/`）。**只有这一处**写这个名字。 */
export const EXP_DIRNAME = '.exp';

/** 数据包那一格（`<scope>/.data/<pack>/`）。阶段 4 才用；这里只登记名字。 */
export const DATA_DIRNAME = '.data';

/** 一个包自己的声明文件名（91 §3.2）。 */
export const PACK_FILENAME = 'pack.json';

/** 出界声明的形状版本。**认不出的 `schema` ⇒ 拒**（fail-closed，照 `apps.SCHEMA` 同款做法）。 */
export const OUTBOUND_SCHEMA = 1;

/**
 * **出去律的三个取值**（92 §② 第 2 步）。
 *
 * ⚠️ 今天只有 `share`（带锚才出）在这一版里承重；`one-to-one`（数据包，阶段 4）
 *    与 `never`（缓存／记忆／账）先在这里登记名字，**不实现搬运**。
 */
export const OUTBOUND_SHARE = 'share';
export const OUTBOUND_ONE_TO_ONE = 'one-to-one';
export const OUTBOUND_NEVER = 'never';

/** 三条口：它们**共用**下面那一个裁决（92 §③ 阶段 2）。 */
export const OUTBOUND_ROUTES = Object.freeze({
  publish: '上架',
  artifact: '制品口',
  deliver: '一对一交付',
});

/** 可核起点的形状：`apps.rootHashOf` 的输出就是它（排序后拼 `path\nhash\n` 再 sha256）。 */
export const ROOT_HASH_RE = /^[0-9a-f]{64}$/;

export class OutboundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutboundError';
  }
}

/** 一条 anchor 里的 `rootHash` 认不认得出（不是"猜一个"）。 */
export function isRootHash(h) {
  return typeof h === 'string' && ROOT_HASH_RE.test(h);
}

/** 人话里的"哪一条口"（拒绝文案要说清是哪一步拒的 —— N11）。 */
function routeName(route) {
  return OUTBOUND_ROUTES[route] ?? String(route ?? '出界');
}

/** `rootHash` 的前 12 位（只进文案与日志；**它不是身份**，只是让人对得上盘上那一条）。 */
function short(h) {
  return String(h ?? '').slice(0, 12);
}

/**
 * **盘上那些"可分享"的申报**（`<scope>/.exp/<pack>/pack.json`）。
 *
 * 🔴 **fail-closed，四处都拒**（不是"读不到就当没有"）：
 *    · `.exp/<pack>/` 在、`pack.json` **读不到** ⇒ 拒；
 *    · `pack.json` **不是 JSON** ⇒ 拒；
 *    · `schema` **认不出** ⇒ 拒；
 *    · `items` **不是数组** ⇒ 拒。
 * ⚠️ `.exp/` 下**不是目录**的散文件 ⇒ 按 92 §② 第 2 步是**未归类 = 永不出**，
 *    所以**不拦**（它连"可分享"都申报不了）。
 * ⚠️ 没有 `.exp/` 这一格 ⇒ 返回空数组（**阶段 3** 才翻这个默认值）。
 *
 * @param {object} o
 * @param {object} [o.fs]
 * @param {string} o.scopeDir  这一间房（`<dir>/workspaces/<scope>`）
 * @returns {Array<{pack:string, items:Array<object>}>}
 */
export function readExpPacks({ fs = nodeFs, scopeDir } = {}) {
  if (typeof scopeDir !== 'string' || scopeDir === '') return [];
  const root = nodePath.join(scopeDir, EXP_DIRNAME);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    // 读不动（权限、坏盘…）⇒ **声明不可核 ⇒ 不出去**（读不到也拒）
    throw new OutboundError(`经验包那一格（${EXP_DIRNAME}/）读不出来 —— 声明不可核，不出去`);
  }
  const packs = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    if (!e.isDirectory()) continue; // 散文件 = 未归类 = 永不出（不拦）
    const pack = e.name;
    let raw;
    try {
      raw = fs.readFileSync(nodePath.join(root, pack, PACK_FILENAME), 'utf8');
    } catch {
      throw new OutboundError(`经验包「${pack}」没有可读的 ${PACK_FILENAME} —— 读不到声明就不许出去`);
    }
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      throw new OutboundError(`经验包「${pack}」的声明看不懂（不是 JSON）—— 声明不可核，不出去`);
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      throw new OutboundError(`经验包「${pack}」的声明不是一份对象 —— 声明不可核，不出去`);
    }
    if (j.schema !== OUTBOUND_SCHEMA) {
      throw new OutboundError(
        `经验包「${pack}」的声明版本认不出（schema=${String(j.schema).slice(0, 20)}）—— 认不出就不出去`,
      );
    }
    if (!Array.isArray(j.items)) {
      throw new OutboundError(`经验包「${pack}」的声明里没有条目表（items）—— 声明不可核，不出去`);
    }
    packs.push({ pack, items: j.items });
  }
  return packs;
}

/**
 * 🔴 **唯一的裁决**（92 §③ 阶段 2）：一样东西要出去之前，这里说了算。
 *
 * 它只问三件（都不读内容、只看申报与登记）：
 *   ① 这一版有**可核起点**吗（`rootHash` 的形状对不对）；
 *   ② 每一条 `share:true` 都带**锚**吗（不带 ⇒ 拒）；
 *   ③ 那个锚**核得出来**、而且**血缘指得回它**吗（核不出／指不回 ⇒ 拒）。
 *
 * @param {object} o
 * @param {string} [o.route]        哪条口（`publish` / `artifact` / `deliver`）—— 只进拒绝文案
 * @param {string} [o.id]
 * @param {string} o.rootHash       这一版的 `manifest.rootHash`
 * @param {Array}  [o.packs]        `readExpPacks()` 的结果
 * @param {Array}  [o.lineage]      `apps.lineage(id)` 那串边
 * @param {(h:string)=>boolean} o.resolves  这个 `rootHash` 在我们这儿核得出来吗
 * @returns {{route:string, id:string, rootHash:string, share:Array<{pack:string,path:string,anchor:string}>}}
 */
export function adjudicate({ route = 'publish', id = '', rootHash, packs = [], lineage = [], resolves }) {
  if (!isRootHash(rootHash)) {
    throw new OutboundError(
      `这一版没有可核起点（rootHash）—— ${routeName(route)}的东西必须追得到起点，出不去`,
    );
  }
  if (typeof resolves !== 'function') {
    // 核不动 ⇒ 声明不可核 ⇒ **不出去**（fail-closed；不许"看着差不多"放过）
    throw new OutboundError(`出界检查没接上"核得出来吗"那一半 —— 声明不可核，不出去`);
  }
  // 血缘里记着的那些起点（`baseRootHash`）：锚要能指回其中一条，或者就是它自己
  const bases = new Set(
    lineage.map((e) => e?.baseRootHash).filter((h) => isRootHash(h)),
  );
  const share = [];
  for (const p of packs) {
    for (const it of p.items) {
      if (it?.share !== true) continue; // 没明说可分享 ⇒ 默认最严：不带出去（不需要锚）
      const path = typeof it?.path === 'string' ? it.path : '';
      const where = `${p.pack}${path ? `／${path}` : ''}`;
      const anchor = it?.anchor;
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
        throw new OutboundError(
          `经验包「${where}」标了可分享，却没有可核起点（来源 rootHash）—— 说不清来路的东西不出去`,
        );
      }
      const h = anchor.rootHash;
      if (!isRootHash(h)) {
        throw new OutboundError(
          `经验包「${where}」的来源不是一条 rootHash —— 锚认不出，不出去`,
        );
      }
      // 🔴 两问，分先后（拒绝文案要说得准 —— 是"核不出来"还是"血缘对不上"）：
      //    ① 这个起点在我们的登记里**核得出来**吗（核不出 ⇒ 声明不可核）；
      //    ② 它不是"这一版自己"时，**血缘里有一条边指回它**吗（自称的来源不算来源）。
      if (!resolves(h)) {
        throw new OutboundError(
          `经验包「${where}」的可核起点（${short(h)}…）在我们这儿核不出来 —— 声明不可核，不出去`,
        );
      }
      if (h !== rootHash && !bases.has(h)) {
        throw new OutboundError(
          `经验包「${where}」的来源（${short(h)}…）在血缘里找不到一条指回它的边 —— 血缘对不上，不出去`,
        );
      }
      share.push({ pack: p.pack, path, anchor: h });
    }
  }
  return { route, id, rootHash, share };
}

/**
 * **上架／交付／制品口那条口的接线**：把这一间房里的申报读出来，交给上面那一个裁决。
 *
 * 🔴 它跑在**任何一次写盘之前**（拒的时候，共享库一个字节都不动）。
 * ⚠️ 申报住 **`<scope>/.exp/`**（工作区那一格）—— 没接 `workspaces` 时按默认布局
 *    `<apps.dir>/workspaces/<id>/` 找（**默认也要读**：不读就等于开了个旁路）。
 *
 * @param {object} o
 * @param {string} [o.route]
 * @param {object} o.apps
 * @param {object|null} [o.workspaces]  `AppWorkspaces`（只用到 `dirFor`）
 * @param {string} o.id
 * @param {number|null} [o.version]     默认 = 当前指针那一版
 * @returns {{route:string,id:string,rootHash:string,share:Array<object>}}
 */
export function assertOutboundAllowed({
  route = 'publish',
  apps,
  workspaces = null,
  id,
  version = null,
}) {
  if (!apps || typeof apps.manifest !== 'function') {
    throw new OutboundError('出界检查要一个制品库');
  }
  const v = version === null || version === undefined ? apps.current(id) : Number.parseInt(version, 10);
  if (!Number.isInteger(v) || v < 1) {
    throw new OutboundError(`这一版不在（${String(id).slice(0, 40)}）—— 出不去`);
  }
  const man = apps.manifest(id, v);
  if (!man) {
    throw new OutboundError('这一版的清单读不出来 —— 没有可核起点，出不去');
  }
  const fs = apps.fs ?? nodeFs;
  const scopeDir = workspaces && typeof workspaces.dirFor === 'function'
    ? workspaces.dirFor(id)
    : nodePath.join(apps.dir, 'workspaces', String(id));
  const packs = readExpPacks({ fs, scopeDir });
  const lineage = typeof apps.lineage === 'function' ? apps.lineage(id) : [];
  const own = new Set();
  for (let n = 1; n <= MAX_VERSIONS; n += 1) {
    const m = n === v ? man : apps.manifest(id, n);
    if (m && isRootHash(m.rootHash)) own.add(m.rootHash);
  }
  const bases = new Set(lineage.map((e) => e?.baseRootHash).filter((h) => isRootHash(h)));
  const resolves = (h) => own.has(h) || bases.has(h);
  return adjudicate({ route, id, rootHash: man.rootHash, packs, lineage, resolves });
}
