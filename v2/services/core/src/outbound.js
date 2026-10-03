// **出界那一条独木桥**（92 §③ 阶段 2／阶段 3 · 契约 `docs/dev/92-TRIPLE-PLAN.md`
// ＋ 阶段 3 那一篇 `docs/dev/98-STAGE3-DEFAULTS.md`）。
//
// ── 它解决什么 ────────────────────────────────────────────
// 92 §② 的第三条硬规矩：**可分享必须带锚** ——
//   `share:true` 而缺来源 `rootHash`／输入账／同意记录 ⇒ **不出去**。
// 理由（安全席 R2）：声明不可核 ＝ 把上架闸降级成**作者自证**。
// 92 §③ 阶段 2 把这件事收成**一条路**：上架／交付／制品口**共用一个出口检查**，
// 一处逻辑、一处裁决 —— **不许两处各判一次**。
//
// ── 阶段 3 把默认值翻过来了（98 §②）──────────────────────
//   ① **两格都读，按声明判**：`<scope>/.exp/<pack>/` 与 `<scope>/.data/<pack>/`
//      走**同一条裁决** —— 目录名**不承重**，`pack.json` 说了算。
//      ⇒ `mv .exp/x .data/x`（内容与声明一个字节不动）之后，上架结论逐条不变。
//   ② **默认最严**：包目录在、而声明**读不到／认不出** ⇒ **未归类 = 永不出**（拒），
//      **不是**"当没有这一格"。⚠️ 但**两格都不存在**仍然不拦 —— 他给自己做的 app
//      照旧能上架（出界闸管的是"带出去"，不是"能不能用"）。
//   ③ 🔴 **没有自动生效路**：每轮输入那一侧（`dispatcher.js`／`session-translate.js`／
//      `worlds.js`）**不许**出现 `.exp`／`.data` 这两个名字 —— 读它们的字节只许发生在
//      **这里**（声明读取）。今天这条**天然成立**，是因为**根本没有注入**：这两格里的字节
//      没有任何一条路进每轮输入。注入一旦落地（94 的注入落点），**必须**同时带应用点与
//      回退点 —— 那是阶段 5 的方法边（`docs/dev/98-STAGE3-DEFAULTS.md` §二③ · §四·1）。
//      判据 S3-5（`test/outbound-defaults.test.js`）用源码扫描把这句话钉死：
//      往那三个文件里塞一行读 `.exp/x/pack.json` ⇒ 当场红。
//
// ── 阶段 6 把"出界那一刻"变成**常驻断言**（92 §③ 阶段 6）──────
// 阶段 1 那条真机闸（`scripts/check-scope-boundary.sh --live`）能绿，靠的是**机制**：
// `.data/`／`.exp/` 的字节**根本不进** `manifest.files` ⇒ 上架那一刻**没有任何断言**在核。
// 阶段 6 要的正是那一条：**准备出界的字节，必须与那一版清单逐条对得上** ——
// 见下面的 `assertOutboundBytes()`，它是**发布路径自带**的（不是闸脚本里的技巧）。
// 🔴 **它压的是"声明 ↔ 字节"，不是内容正则**：多了什么／少了什么／有没有 `.` 开头的段／
//    字节与声明的 sha 是否一致 —— 一条内容黑名单（`sk-` 那种）既会误伤正经内容，
//    又永远追不上"下一个没想到的形态"。**结构上对得上 ⇒ 那些字节出不去。**
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
// 🔴 **fail-closed**：包目录在、而声明**读不到 / 认不出** ⇒ **拒**（不是"当没有"，两格一视同仁）。
// ⚠️ **两格都不在** ⇒ 一份申报都没有 ⇒ 不拦（他给自己做的 app 照旧能上架，98 §②②）。
//
// ⚠️ 它**只裁决**，不搬运：这一版不建任何"把这两格字节带出去"的路
//    （那是阶段 4／5 的事）。今天它保证的是「**说不清来路的东西，一份都不许出去**」。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import {
  MAX_VERSIONS,
  checkRelPath,
  refuseHiddenRelPath,
  rootHashOf,
  sha256hex,
} from './apps.js';

/** 经验包那一格（`<scope>/.exp/<pack>/`）。**只有这一处**写这个名字。 */
export const EXP_DIRNAME = '.exp';

/** 数据包那一格（`<scope>/.data/<pack>/`）。阶段 4 才建搬运；这里两格**一起读**。 */
export const DATA_DIRNAME = '.data';

/**
 * 出界闸**同时**读的两格载体（98 §②①：「目录名不承重，声明承重」）。
 *
 * ⚠️ 顺序只决定**先报哪一条**，不决定谁能出去 —— 两格各自按自己的 `pack.json` 判。
 */
export const PACK_DIRNAMES = Object.freeze([EXP_DIRNAME, DATA_DIRNAME]);

/** 一个包自己的声明文件名（91 §3.2）。 */
export const PACK_FILENAME = 'pack.json';

/** 出界声明的形状版本。**认不出的 `schema` ⇒ 拒**（fail-closed，照 `apps.SCHEMA` 同款做法）。 */
export const OUTBOUND_SCHEMA = 1;

/**
 * **出去律的三个取值**（92 §② 第 2 步 · 98 §②①）。
 *
 * ⚠️ 今天只有 `share`（带锚才出）在这一版里承重；`one-to-one`（数据包，阶段 4）
 *    与 `never`（缓存／记忆／账）先在这里登记名字，**不实现搬运**。
 *    🔴 它们**永不出**：包级那个 `outbound` 说了算，里面的条目就算写着 `share:true` 也不出。
 */
export const OUTBOUND_SHARE = 'share';
export const OUTBOUND_ONE_TO_ONE = 'one-to-one';
export const OUTBOUND_NEVER = 'never';

/** 认得出的出去律。**有值而不在这张表里 ⇒ 拒**（98 §③ S3-6：认不出就拒）。 */
const KNOWN_OUTBOUND = Object.freeze([OUTBOUND_SHARE, OUTBOUND_ONE_TO_ONE, OUTBOUND_NEVER]);

/** 这一包声明了"永不出"吗（`one-to-one`／`never` 都不出，只是理由不同）。 */
function isNeverOut(outbound) {
  return outbound === OUTBOUND_ONE_TO_ONE || outbound === OUTBOUND_NEVER;
}

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
 * **盘上那些包自己的声明**（`<scope>/.exp/<pack>/pack.json` 与 `<scope>/.data/<pack>/pack.json`）。
 *
 * 🔴 **两格都读、一视同仁**（98 §②①）：目录名**不承重** —— 同一份内容 ＋ 同一份声明，
 *    放哪一格结论都一样。每个包**各按自己的 `pack.json`** 判，两格同名也各算各的。
 *
 * 🔴 **fail-closed，几处都拒**（不是"读不到就当没有"）：
 *    · 包目录在、`pack.json` **读不到** ⇒ 拒；
 *    · `pack.json` **不是 JSON** ⇒ 拒；
 *    · `schema` **认不出** ⇒ 拒；
 *    · `outbound` **有值但认不出** ⇒ 拒；
 *    · `items` **不是数组** ⇒ 拒。
 * ⚠️ 两格下**不是目录**的散文件 ⇒ 按 92 §② 第 2 步是**未归类 = 永不出**，所以**不拦**。
 * ⚠️ **两格都不在** ⇒ 返回空数组 ⇒ 不拦（他给自己做的 app 照旧能上架，98 §②②）。
 * ⚠️ 拒绝文案**不写是哪一格**：写了，目录名就又回到承重位上（S3-1 要的是逐字相同的裁决）。
 *
 * @param {object} o
 * @param {object} [o.fs]
 * @param {string} o.scopeDir  这一间房（`<dir>/workspaces/<scope>`）
 * @returns {Array<{cell:string, pack:string, outbound:string|null, items:Array<object>}>}
 */
export function readPacks({ fs = nodeFs, scopeDir } = {}) {
  if (typeof scopeDir !== 'string' || scopeDir === '') return [];
  const packs = [];
  for (const cell of PACK_DIRNAMES) {
    const root = nodePath.join(scopeDir, cell);
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      // 这一格不在 ⇒ 它没有申报（另一格照样读）
      if (err?.code === 'ENOENT') continue;
      // 读不动（权限、坏盘…）⇒ **声明不可核 ⇒ 不出去**（读不到也拒）。
      // ⚠️ 这一句**必须**点名是哪一格 —— 此时承重的是"哪一格读不动"，不是包的内容。
      throw new OutboundError(`申报那一格（${cell}/）读不出来 —— 声明不可核，不出去`);
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of sorted) {
      if (!e.isDirectory()) continue; // 散文件 = 未归类 = 永不出（不拦）
      const pack = e.name;
      let raw;
      try {
        raw = fs.readFileSync(nodePath.join(root, pack, PACK_FILENAME), 'utf8');
      } catch {
        throw new OutboundError(`包「${pack}」没有可读的 ${PACK_FILENAME} —— 读不到声明就不许出去`);
      }
      let j;
      try {
        j = JSON.parse(raw);
      } catch {
        throw new OutboundError(`包「${pack}」的声明看不懂（不是 JSON）—— 声明不可核，不出去`);
      }
      if (!j || typeof j !== 'object' || Array.isArray(j)) {
        throw new OutboundError(`包「${pack}」的声明不是一份对象 —— 声明不可核，不出去`);
      }
      if (j.schema !== OUTBOUND_SCHEMA) {
        throw new OutboundError(
          `包「${pack}」的声明版本认不出（schema=${String(j.schema).slice(0, 20)}）—— 认不出就不出去`,
        );
      }
      // 🔴 **声明承重**（98 §②①）：包的出去律先看包级那一个 `outbound`。
      //    ⚠️ **有值而不认识** ⇒ 拒（S3-6），**不许**当"没写"。
      //    ⚠️ **没写** ⇒ 退回 `items[]` 逐条 `share`（阶段 2 的机制，字段语义一个字不动）——
      //       那不是"默认宽松"：逐条 `share:true` 照样要锚，少了就拒。
      if (j.outbound !== undefined && !KNOWN_OUTBOUND.includes(j.outbound)) {
        throw new OutboundError(
          `包「${pack}」的出去律认不出（outbound=${String(j.outbound).slice(0, 20)}）—— 认不出就不出去`,
        );
      }
      if (!Array.isArray(j.items)) {
        throw new OutboundError(`包「${pack}」的声明里没有条目表（items）—— 声明不可核，不出去`);
      }
      packs.push({ cell, pack, outbound: j.outbound ?? null, items: j.items });
    }
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
 * @param {Array}  [o.packs]        `readPacks()` 的结果
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
    // 🔴 **包级那一个 `outbound` 说了算**（98 §②①）：`one-to-one`（数据包）与
    //    `never`（缓存／记忆／账）**永不出** —— 里面的条目就算写着 `share:true` 也不出。
    //    ⚠️ **没写** `outbound` ⇒ 退回逐条 `share`（阶段 2 的机制，字段语义不动）。
    if (isNeverOut(p.outbound)) continue;
    for (const it of p.items) {
      if (it?.share !== true) continue; // 没明说可分享 ⇒ 默认最严：不带出去（不需要锚）
      const path = typeof it?.path === 'string' ? it.path : '';
      const where = `${p.pack}${path ? `／${path}` : ''}`;
      const anchor = it?.anchor;
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
        throw new OutboundError(
          `包「${where}」标了可分享，却没有可核起点（来源 rootHash）—— 说不清来路的东西不出去`,
        );
      }
      const h = anchor.rootHash;
      if (!isRootHash(h)) {
        throw new OutboundError(
          `包「${where}」的来源不是一条 rootHash —— 锚认不出，不出去`,
        );
      }
      // 🔴 两问，分先后（拒绝文案要说得准 —— 是"核不出来"还是"血缘对不上"）：
      //    ① 这个起点在我们的登记里**核得出来**吗（核不出 ⇒ 声明不可核）；
      //    ② 它不是"这一版自己"时，**血缘里有一条边指回它**吗（自称的来源不算来源）。
      if (!resolves(h)) {
        throw new OutboundError(
          `包「${where}」的可核起点（${short(h)}…）在我们这儿核不出来 —— 声明不可核，不出去`,
        );
      }
      if (h !== rootHash && !bases.has(h)) {
        throw new OutboundError(
          `包「${where}」的来源（${short(h)}…）在血缘里找不到一条指回它的边 —— 血缘对不上，不出去`,
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
 * ⚠️ 申报住**两格**（`<scope>/.exp/` 与 `<scope>/.data/`，98 §②①）—— 没接 `workspaces`
 *    时按默认布局 `<apps.dir>/workspaces/<id>/` 找（**默认也要读**：不读就等于开了个旁路）。
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
  // 🔴 两格都读（98 §②①）—— 目录名不承重，按每个包自己的声明判
  const packs = readPacks({ fs, scopeDir });
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

/**
 * 🔴 **出界那一刻的常驻断言**（92 §③ 阶段 6）：**准备出界的字节，必须与那一版清单逐条对得上**。
 *
 * ── 为什么是这个形状（**不是"扫字符串黑名单"**）──────────────
 * 92 §② 的判层规则**不读内容**，只看**路径**与**声明**。所以"不该出界的字节一律拒"
 * 这件事，**只有在"声明 ↔ 字节"这一层才判得准**：
 *
 *   · **多了什么**：`files` 里有一份**清单没申报**的 ⇒ 拒；
 *   · **少了什么**：清单声明了、字节里没有 ⇒ 拒；
 *   · **换过什么**：某一份的 `sha256` 与清单里那一条对不上 ⇒ 拒（清单说 A、字节是 B）；
 *   · **有没有 `.` 开头的段**：路径**任一段**以 `.` 开头 ⇒ 拒（`.data/`／`.exp/`／任何散文件，
 *     判的是**每一段**，与 `apps.refuseHiddenRelPath` **同一处规则**、不另抄一份）；
 *   · **越界路径**：绝对路径 / `..` / 反斜杠 / 控制字符 ⇒ 拒（`apps.checkRelPath`，同一处规则）；
 *   · **清单自己**：重复路径、空路径、`rootHash` 与清单算出来的对不上 ⇒ 拒（声明不可核）。
 *
 * 🔴 **为什么不扫内容**：一份 `sk-` 之类的字符串黑名单**既会误伤正经内容**（一个讲 API key
 *    的教程页面就被它拦下），又**永远追不上**"下一个没想到的形态"。而上面这几条是
 *    **结构**：对得上 ⇒ 那份字节**就是**那份清单声明的能力体，**没有**两格的字节在里面。
 *    ⚠️ 所以 92 §④ 那条"全库搜哨兵"**不是**被这一条取代 —— 它是**抽样的事后核对**，
 *    住 `scripts/check-scope-boundary.sh`；这里这一条是**发布自己带的**、每次上架都跑的。
 *
 * ── 它在哪跑 ────────────────────────────────────────────
 * 唯一写入者 `published.publish()`，在**读字节之后、碰任何盘之前**。给 `files` 就核字节那一半；
 * 不给（只给 `manifest`）就只核"声明"那一半（形状），返回同一份留痕。
 * 🔴 **fail-closed**：读不出／对不上一律**拒**（不是"当没有"）。
 *
 * @param {object} o
 * @param {string} [o.route]  哪条口（`publish` / `artifact` / `deliver`）—— 只进拒绝文案
 * @param {string} [o.id]
 * @param {object} o.manifest  这一版的清单（`apps.manifest()` 那一份）
 * @param {Record<string, Buffer|string>|null} [o.files]  准备出界的字节（path → 内容）
 * @returns {{route:string, id:string, version:number|null, rootHash:string|null,
 *            files:Array<{path:string,sha256:string,bytes:number}>, count:number,
 *            bytes:number, digest:string|null}}  **留痕用的那一份**（`digest` 就是登记的起点）
 */
export function assertOutboundBytes({ route = 'publish', id = '', manifest, files = null } = {}) {
  const where = routeName(route);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new OutboundError(`${where}的清单读不出来 —— 声明不可核，不出去`);
  }
  if (!Array.isArray(manifest.files)) {
    throw new OutboundError(`${where}的清单里没有文件表（files）—— 声明不可核，不出去`);
  }
  const declared = manifest.files;

  // ── ① 清单里**声明**的每一条路径（这一半不读字节）────────────────
  const seen = new Set();
  for (const rec of declared) {
    const rel = typeof rec?.path === 'string' ? rec.path : '';
    if (rel === '') {
      throw new OutboundError(`${where}的清单里有一条路径是空的 —— 声明不可核，不出去`);
    }
    if (seen.has(rel)) {
      throw new OutboundError(`${where}的清单里「${rel}」出现了不止一次 —— 声明不可核，不出去`);
    }
    seen.add(rel);
    try {
      // 🔴 两条规则**复用** `apps.js` 那一处（不另抄一份；不然迟早会漂）
      checkRelPath(rel);
      refuseHiddenRelPath(rel);
    } catch (err) {
      throw new OutboundError(
        `${where}的清单里有一条不该出界的路径：「${rel}」—— ${err?.message ?? String(err)}`,
      );
    }
  }

  // ── ② 字节那一半（给了才判）────────────────────────────────
  const sealed = [];
  let bytes = 0;
  if (files !== null && files !== undefined) {
    if (typeof files !== 'object' || Array.isArray(files)) {
      throw new OutboundError(`${where}的字节表读不出来 —— 声明不可核，不出去`);
    }
    // **多了什么**：没申报的一律不许出去
    for (const rel of Object.keys(files)) {
      if (!seen.has(rel)) {
        throw new OutboundError(
          `${where}要带出去的字节里有一份没有申报：「${rel}」—— 多出来的东西一份都不许出去`,
        );
      }
    }
    for (const rec of declared) {
      const rel = rec.path;
      if (!Object.prototype.hasOwnProperty.call(files, rel)) {
        throw new OutboundError(
          `${where}的清单声明了「${rel}」，字节里却没有它 —— 清单与实际对不上，不出去`,
        );
      }
      const raw = files[rel];
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
      const h = sha256hex(buf);
      if (h !== rec.sha256) {
        throw new OutboundError(
          `${where}的字节与清单对不上（「${rel}」不是清单里那一条）—— 声明不可核，不出去`,
        );
      }
      bytes += buf.length;
      sealed.push({ path: rel, sha256: h, bytes: buf.length });
    }
    // **清单自己**：它算出来的起点必须与登记的那一条逐字一致
    const want = rootHashOf(declared.map((r) => ({ path: r.path, sha256: r.sha256 })));
    if (want !== manifest.rootHash) {
      throw new OutboundError(`${where}的清单与它登记的可核起点对不上 —— 声明不可核，不出去`);
    }
  }

  return {
    route,
    id,
    version: Number.isInteger(manifest.version) ? manifest.version : null,
    rootHash: typeof manifest.rootHash === 'string' ? manifest.rootHash : null,
    files: sealed,
    count: declared.length,
    bytes,
    // 🔴 留痕那一把：清单自己算出来的起点（正常就是登记的那个 `rootHash`）
    digest: typeof manifest.rootHash === 'string' ? manifest.rootHash : null,
  };
}
