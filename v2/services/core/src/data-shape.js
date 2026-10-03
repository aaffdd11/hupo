// **形状声明：随 fork 走、值永不随**（`D4.24` · **A1** · 2026-10-03 定；
//   出处 `docs/dev/161-OWNER-DECISIONS-11.md` A1 · `docs/dev/90-APP-CONTRACT.md` §3.2／§3.3 Q3.1／Q3.2 ·
//   `docs/dev/91-TRIPLE-CONTRACT.md` §3.2／§6.6／§8.1 · `docs/dev/92-TRIPLE-PLAN.md` §②）。
//
// ── 主人拍的那句话，逐字 ────────────────────────────────────
//   **A1 = 乙**：**制品先上架；数据随 fork 只走一份「形状声明」—— 形状随版本冻结、值永不随。**
//   理由（原文）：选甲（契约与数据打包上架）会让"每次上架都要现场判断这坨数据进不进快照"，
//   **错一次就是私密数据发布事故**。
//
// ── 这一份落在哪（盘上）────────────────────────────────────
//   形状声明 = **制品内一份固定名文件**（`data-shape.json`）。理由照 `90` Q2.7／Q4.9：
//     · 它与 `outbound.json` **同一种形状**（制品内固定名文件、`schema` 版本化、fail-closed）；
//     · 它是制品里的一个**普通文件** ⇒ 进 `manifest.files[]` ⇒ **被 `rootHash` 盖住**
//       ⇒ **随版本冻结**；装上／分叉只复制 `manifest.files[]` ⇒ **随 fork 走**；
//     · 🔴 **不许**做成 `manifest.json` 的字段（那一份会被下一版覆盖 ⇒ 形状会漂）。
//
//   值住在**它自己那一格**：`<scope>/.data/<pack>/`（`92` §①，任一段以 `.` 开头 ⇒ 不进制品）。
//   ⇒ 这一份**一个值都不装**：它只描述"这份数据长什么样"（键名／类型／空值口径／去重键）。
//
// ── 四条不许破 ────────────────────────────────────────────
//   ① **值一个字节都不许进这份文件**：下面 `parseDataShape()` 用**封闭的键集合**判
//      —— 顶层只许 `schema`／`packs`，每一包只许 `pack`／`shapeVersion`／`keys`，
//      每一列只许 `name`／`type`／`null`／`dedup`。多一个词就是"想塞值" ⇒ **拒**。
//      ⚠️ 这是**结构**判定（92 §② 不读内容），不是字符串黑名单 —— 黑名单既误伤又追不上。
//   ② **形状随版本冻结**：`shapeVersion` 是**形状自己的内容地址**
//      （`sha256(canonical({pack, keys}))` 的前若干位）—— 改一个键名／类型／空值口径／去重键
//      ⇒ 号必变；而"只改数据的值"动的根本是另一格（`.data/` 里的字节），
//      **这份文件逐字不变 ⇒ 号逐字不变**。
//      ⇒ **改形状却不改号**（或号对不上形状）⇒ **拒**：不许偷偷改形状。
//   ③ **默认最严**：一份数据格（`.data/<pack>/`）在盘上，而这一版**没有**为它声明形状
//      ⇒ `assertShapeDeclared()` **拒**（人话、点名哪一格），**不是**安静放过。
//   ④ **规则只住一处**：形状的定义／判据**全在这个文件里**。
//      `apps.js`（写侧）、`workspace.js`（打包侧）、`published.js`（上架侧）都**只调这里**，
//      不许谁另抄一套（判据见 `scripts/check-data-shape.sh` 的 D1／D2）。
//
// ── 它与别的"形状"不是一回事（别读混）──────────────────────
//   · `apps.shapeVersion()` = **能力体那一族的号**（`manifest.schema`：入口形态／目录形态／清单字段形态）；
//   · 这一份 = **数据那一族的号**（91 §8.1「三个号互不代管」）。
//     只改 `.exp/` ⇒ 两个号都不动；只改 `.data/` 的值 ⇒ 两个号也都不动；改数据形状 ⇒ **只有这个号动**。

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

/**
 * 制品内那份固定名文件。**只有这一处**写这个名字
 * （判据 D4／S4a 会扫源码：别处不许再写一遍这个字面）。
 */
export const DATA_SHAPE_FILENAME = 'data-shape.json';

/** 声明的形状版本。**认不出 ⇒ 拒**（fail-closed，照 `apps.SCHEMA`／`outbound.OUTBOUND_SCHEMA` 同款做法）。 */
export const DATA_SHAPE_SCHEMA = 1;

/**
 * 一列数据能声明的**类型**。有值而不在这张表里 ⇒ **拒**（认不出就不认）。
 * ⚠️ 表里只有"形状"，没有语义：它不说这一列是"标题"还是"价格"。
 */
export const SHAPE_TYPES = Object.freeze([
  'string', 'number', 'boolean', 'timestamp', 'object', 'array',
]);

/**
 * 一列的**空值口径**：缺了这一格算不算同一条记录。
 * 🔴 `90` §3.2 的原话：删掉"空值口径"⇒ 两条本该同形的记录**算不算同一条**变成不可判。
 */
export const NULL_POLICIES = Object.freeze(['never', 'allowed']);

/** 一份声明里最多几包、每包最多几列（有界，防"把值当键名塞一长串"）。 */
export const MAX_SHAPE_PACKS = 64;
export const MAX_SHAPE_KEYS = 256;
export const MAX_PACK_NAME_CHARS = 32;
export const MAX_KEY_NAME_CHARS = 64;

/** `shapeVersion` 的形状：形状内容地址的前若干位。 */
export const SHAPE_VERSION_CHARS = 12;
export const SHAPE_VERSION_RE = new RegExp(`^[0-9a-f]{${SHAPE_VERSION_CHARS}}$`);

/**
 * 包名走**与 app id 同一条形状**（`91` §3.3.5："复用同一处规则，不新造形状"）。
 * ⚠️ 这里**没有 import `apps.js` 的 `checkAppId`**：`apps.js` 反过来要 import 这个模块
 *    （写侧那道闸），两边互相 import 会成环。形状**逐字相同**，判据 D4 会核这两处同一个正则与同一个上限。
 */
const PACK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 形状声明读不出／认不出／想塞值时的错。**人话**（N11），并说清是**哪一种**读不出。 */
export class DataShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataShapeError';
  }
}

/**
 * **包名的形状**（`D4.24` · **D1** · 唯一出处）：`91` §3.3.5「包名走与 app id 同一条形状」。
 *
 * 🔴 为什么把它拎出来当函数：命名空间那道闸（`data-namespace.js`）要判"哪个包"，
 *    而**包名的形状只许有一处** —— 它 `import` 这一个，**不许**另抄一个正则
 *    （正则与上限就在上面那两个常量里，判据 S5 会扫源码核这一条）。
 *
 * ⚠️ 认不出 ⇒ **抛**（人话，N11），**不返回 null**：调用它的都是"要动手"的路，
 *    猜一个名字出去比拒绝更坏。
 *
 * @param {unknown} raw
 * @returns {string} 校验过的包名
 */
export function checkPackName(raw) {
  const pack = typeof raw === 'string' ? raw.trim() : '';
  if (pack === '') {
    throw new DataShapeError('数据包没写名字（pack）—— 说不清是哪一格，不认');
  }
  if (pack.length > MAX_PACK_NAME_CHARS || !PACK_NAME_RE.test(pack)) {
    throw new DataShapeError(
      `包名不合形状（${String(raw).slice(0, 40)}）—— 只许小写字母、数字、短横`,
    );
  }
  return pack;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * **规范 JSON**（键排序、递归）—— 让"同一份形状"永远得到同一串字节。
 *
 * 🔴 为什么要它：`shapeVersion` 是**内容地址**，而 JSON 的键序在规范里不承重。
 *    不排序 ⇒ 同一个人把 `{type,name}` 写成 `{name,type}` 就得到另一个号 ⇒
 *    "号变了"不再等于"形状变了"（判据②就假了）。
 * ⚠️ **数组的顺序保留**：列的顺序是形状的一部分（显示顺序），换了就换号。
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * **一个包的形状自己的号**（内容地址）：`sha256(canonical({pack, keys}))` 的前若干位。
 *
 * 🔴 它是"形状随版本冻结"的落点：**号由形状算出来，不由人填**。
 *    ⇒ 只改数据的值 ⇒ 这份声明的字节没动 ⇒ 号逐字不变；
 *      改形状（键名／类型／空值口径／去重键／列序／包名）⇒ 号必变；
 *      改了形状而号没跟着改 ⇒ `parseDataShape()` **拒**。
 *
 * @param {{pack:string, keys:Array<object>}} o
 * @returns {string} `SHAPE_VERSION_CHARS` 位十六进制
 */
export function shapeVersionOf({ pack, keys } = {}) {
  const canonical = canonicalJson({ pack, keys });
  return nodeCrypto.createHash('sha256').update(canonical).digest('hex').slice(0, SHAPE_VERSION_CHARS);
}

/**
 * **整份声明的指纹**（所有包合起来算一次）—— 记在留痕里，用来回答
 * "装上那一份的形状与上游逐字相同吗"。
 */
export function dataShapeDigest(decl) {
  return nodeCrypto.createHash('sha256').update(canonicalJson(decl)).digest('hex');
}

/** 多出来的那些词（想塞值的常见形态）—— 拒绝文案里要点名。 */
function extraKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

function asText(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  return null;
}

/**
 * **解析并逐条校验**一份形状声明（纯函数）。认不出／想塞值 ⇒ **抛**（fail-closed）。
 *
 * 判据（每一条都能反着验）：
 *   · 不是 JSON／不是对象 ⇒ 拒；
 *   · 顶层键**封闭**（只许 `schema`／`packs`）⇒ 多一个词 ⇒ 拒（**值就是从这里进来的**）；
 *   · `schema` 认不出 ⇒ 拒；
 *   · 每一包键**封闭**（`pack`／`shapeVersion`／`keys`）⇒ 多一个词 ⇒ 拒；
 *   · 包名不合形状／重名 ⇒ 拒；
 *   · 每一列键**封闭**（`name`／`type`／`null`／`dedup`）⇒ 多一个词 ⇒ 拒；
 *   · 列名空／太长／重名 ⇒ 拒；`type`／`null` 认不出 ⇒ 拒；`dedup` 不是布尔 ⇒ 拒；
 *   · 🔴 `shapeVersion` 与**形状自己算出来的号**对不上 ⇒ 拒（改形状不改号 / 改号不改形状）。
 *
 * @param {string|Buffer|object} raw 文件原文，或者已经解析好的对象
 * @returns {{schema:number, packs:Array<{pack:string, shapeVersion:string,
 *            keys:Array<{name:string,type:string,null:string,dedup:boolean}>}>}}
 */
export function parseDataShape(raw) {
  let j = raw;
  const text = asText(raw);
  if (text !== null) {
    try {
      j = JSON.parse(text);
    } catch {
      throw new DataShapeError(`形状声明（${DATA_SHAPE_FILENAME}）看不懂（不是 JSON）—— 声明不可核，不认`);
    }
  }
  if (!isPlainObject(j)) {
    throw new DataShapeError(`形状声明（${DATA_SHAPE_FILENAME}）不是一份对象 —— 声明不可核，不认`);
  }
  // ① 顶层：封闭键集合。多一个词 = 想塞值（`values`／`rows`／`sample`…）。
  const topExtra = extraKeys(j, ['schema', 'packs']);
  if (topExtra.length > 0) {
    throw new DataShapeError(
      `形状声明里多了一个词「${topExtra.join('／').slice(0, 60)}」—— 这份文件只许写形状`
      + '（键名／类型／空值口径／去重键），**值一个字节都不许进来**',
    );
  }
  if (j.schema !== DATA_SHAPE_SCHEMA) {
    throw new DataShapeError(
      `形状声明的版本认不出（schema=${String(j.schema).slice(0, 20)}）—— 认不出就不认`,
    );
  }
  if (!Array.isArray(j.packs)) {
    throw new DataShapeError(`形状声明里没有包表（packs）—— 声明不可核，不认`);
  }
  if (j.packs.length > MAX_SHAPE_PACKS) {
    throw new DataShapeError(`形状声明里的包太多（上限 ${MAX_SHAPE_PACKS} 个）—— 不认`);
  }

  const seenPacks = new Set();
  const packs = [];
  for (const p of j.packs) {
    if (!isPlainObject(p)) {
      throw new DataShapeError('形状声明里有一包不是对象 —— 声明不可核，不认');
    }
    const packExtra = extraKeys(p, ['pack', 'shapeVersion', 'keys']);
    if (packExtra.length > 0) {
      throw new DataShapeError(
        `形状声明里有一包多了「${packExtra.join('／').slice(0, 60)}」—— 这一层只许写`
        + '`pack`／`shapeVersion`／`keys`，**值一个字节都不许进来**',
      );
    }
    const pack = typeof p.pack === 'string' ? p.pack.trim() : '';
    if (pack === '') {
      throw new DataShapeError('形状声明里有一包没写名字（pack）—— 说不清是哪一格，不认');
    }
    if (pack.length > MAX_PACK_NAME_CHARS || !PACK_NAME_RE.test(pack)) {
      throw new DataShapeError(
        `形状声明里的包名不合形状（${pack.slice(0, 40)}）—— 只许小写字母、数字、短横`,
      );
    }
    if (seenPacks.has(pack)) {
      throw new DataShapeError(`形状声明里「${pack}」这一包出现了不止一次 —— 声明不可核，不认`);
    }
    seenPacks.add(pack);

    if (!Array.isArray(p.keys)) {
      throw new DataShapeError(`形状声明里「${pack}」没有列表（keys）—— 声明不可核，不认`);
    }
    if (p.keys.length === 0) {
      throw new DataShapeError(`形状声明里「${pack}」的列表是空的 —— 描述不了任何东西，不认`);
    }
    if (p.keys.length > MAX_SHAPE_KEYS) {
      throw new DataShapeError(`形状声明里「${pack}」的列太多（上限 ${MAX_SHAPE_KEYS} 列）—— 不认`);
    }

    const seenKeys = new Set();
    const keys = [];
    for (const k of p.keys) {
      if (!isPlainObject(k)) {
        throw new DataShapeError(`形状声明里「${pack}」有一列不是对象 —— 声明不可核，不认`);
      }
      const keyExtra = extraKeys(k, ['name', 'type', 'null', 'dedup']);
      if (keyExtra.length > 0) {
        throw new DataShapeError(
          `形状声明里「${pack}」有一列多了「${keyExtra.join('／').slice(0, 60)}」—— 一列只许写`
          + '`name`／`type`／`null`／`dedup`，**值一个字节都不许进来**',
        );
      }
      const name = typeof k.name === 'string' ? k.name.trim() : '';
      if (name === '') {
        throw new DataShapeError(`形状声明里「${pack}」有一列没写名字（name）—— 说不清是哪一列，不认`);
      }
      if (name.length > MAX_KEY_NAME_CHARS || /[\u0000-\u001f]/.test(name)) {
        throw new DataShapeError(`形状声明里「${pack}」有一列的名字太长或含控制字符 —— 不认`);
      }
      if (seenKeys.has(name)) {
        throw new DataShapeError(`形状声明里「${pack}」的列「${name}」出现了不止一次 —— 不认`);
      }
      seenKeys.add(name);
      if (!SHAPE_TYPES.includes(k.type)) {
        throw new DataShapeError(
          `形状声明里「${pack}.${name}」的类型认不出（type=${String(k.type).slice(0, 20)}）—— 认不出就不认`,
        );
      }
      if (!NULL_POLICIES.includes(k.null)) {
        throw new DataShapeError(
          `形状声明里「${pack}.${name}」没说清空值口径（null=${String(k.null).slice(0, 20)}）`
          + ' —— 少了它，"两条记录算不算同一条"就不可判，不认',
        );
      }
      if (typeof k.dedup !== 'boolean') {
        throw new DataShapeError(`形状声明里「${pack}.${name}」没说清它算不算去重键（dedup）—— 不认`);
      }
      keys.push({ name, type: k.type, null: k.null, dedup: k.dedup });
    }

    const want = shapeVersionOf({ pack, keys });
    if (typeof p.shapeVersion !== 'string' || p.shapeVersion !== want) {
      throw new DataShapeError(
        `形状声明里「${pack}」的号与它自己的形状对不上`
        + `（写的是 ${String(p.shapeVersion).slice(0, 24)}，按形状算出来是 ${want}）`
        + ' —— 形状变了号没变（或者号变了形状没变），不认',
      );
    }
    packs.push({ pack, shapeVersion: want, keys });
  }
  return { schema: DATA_SHAPE_SCHEMA, packs };
}

/**
 * **把一份形状声明拼出来**（写法只有一处；`shapeVersion` 自动算，不让人填）。
 *
 * 它服务两侧：模型／助手写这份文件时用它；判据造对照时也用它。
 * @param {Array<{pack:string, keys:Array<object>}>} packs
 */
export function buildDataShape(packs) {
  return parseDataShape({
    schema: DATA_SHAPE_SCHEMA,
    packs: (Array.isArray(packs) ? packs : []).map((p) => ({
      pack: p?.pack,
      keys: p?.keys,
      shapeVersion: shapeVersionOf({ pack: p?.pack, keys: p?.keys }),
    })),
  });
}

/** 一份声明里的包名（给人看／给留痕用）。 */
export function packsOf(decl) {
  return (decl?.packs ?? []).map((p) => p.pack);
}

/**
 * **读制品里那份形状声明**（唯一入口）。
 *
 * 🔴 fail-closed：
 *   · 这一版不在／清单坏了 ⇒ **抛**（不猜"没有形状"）；
 *   · 文件在、读不出／认不出 ⇒ **抛**（不是"当没有"）；
 *   · 文件**不在** ⇒ `{declared:false}` —— 这是一句**如实的"没有声明"**，
 *     由调用方按最严处理（见 `assertShapeDeclared`）。
 *
 * @param {object} o
 * @param {object} o.apps
 * @param {string} o.id
 * @param {number|null} [o.version] 默认 = 当前指针那一版
 * @returns {{declared:boolean, decl:object|null, digest:string|null, version:number}}
 */
export function readDataShape({ apps, id, version = null } = {}) {
  if (!apps || typeof apps.manifest !== 'function' || typeof apps.read !== 'function') {
    throw new DataShapeError('读形状声明要一个制品库');
  }
  const v = version === null || version === undefined ? apps.current(id) : Number.parseInt(version, 10);
  if (!Number.isInteger(v) || v < 1) {
    throw new DataShapeError(`这一版不在（${String(id).slice(0, 40)}）—— 形状声明不可核`);
  }
  const man = apps.manifest(id, v);
  if (!man || !Array.isArray(man.files)) {
    throw new DataShapeError('这一版的清单读不出来 —— 形状声明不可核');
  }
  const has = man.files.some((f) => f?.path === DATA_SHAPE_FILENAME);
  if (!has) return { declared: false, decl: null, digest: null, version: v };
  const decl = parseDataShape(apps.read(id, v, DATA_SHAPE_FILENAME).content);
  return { declared: true, decl, digest: dataShapeDigest(decl), version: v };
}

/**
 * 🔴 **最严那一条**（`D4.24` A1 的第 4 点 / 判据⑤）：**没声明 ⇒ 拒**，而且拒得**看得见**。
 *
 * ── 它问什么 ──────────────────────────────────────────────
 *   盘上那几格数据（`packs`：`<scope>/.data/` 下的目录名）里，
 *   **每一格**在这一版制品的形状声明里都得有一条**对得上**的声明。
 *   对不上（或整份声明都不在）⇒ 按最严办：**这一格不进快照、也不随 fork/装上走**，
 *   而且**当场说清是哪一格、缺什么**（不是安静地跳过）。
 *
 * ── 为什么不是"当没有" ────────────────────────────────────
 *   安静跳过 = 他以为形状跟着走了，实际没有 ⇒ 装上的人拿到一份"不知道自己该补什么"的能力体。
 *   而"错一次就是私密数据发布事故"那条理由要的正是**在出去之前拦住**（A1 的理由原文）。
 *
 * ⚠️ **两格都不在盘上** ⇒ `packs` 为空 ⇒ 不拦（他给自己做的 app 照旧能上架／打包 —— 与 `outbound` 那条同款）。
 *
 * @param {object} o
 * @param {string[]} o.packs          盘上真有哪几格数据（目录名；空数组 = 没有数据格）
 * @param {string|Buffer|object|null} [o.declarationBytes] 这一版制品里那份文件（没有 ⇒ `null`）
 * @returns {{declared:boolean, digest:string|null, carried:Array<{pack:string,shapeVersion:string}>,
 *            refused:Array<{pack:string,reason:string}>, valuesTravel:false, valuesReason:string}}
 */
export function shapeCarrierOf({ packs = [], declarationBytes = null } = {}) {
  const list = [...new Set((Array.isArray(packs) ? packs : []).filter((p) => typeof p === 'string' && p !== ''))].sort();
  const plan = {
    declared: false,
    digest: null,
    carried: [],
    refused: [],
    valuesTravel: false,
    valuesReason: '值永不随：数据格（`.data/`）里的字节根本不进制品、也不随装上／分叉复制',
  };
  if (declarationBytes === null || declarationBytes === undefined || declarationBytes === '') {
    // 🔴 没有声明：每一格都按最严办（看得见地拒），**不是**"当没有"。
    for (const pack of list) {
      plan.refused.push({
        pack,
        reason: `这一版制品里没有形状声明（${DATA_SHAPE_FILENAME}）—— 按最严办：`
          + `「${pack}」这一格不进快照、也不跟着走。要它跟着走，先在制品里补一份只写形状、不写值的声明`,
      });
    }
    return plan;
  }
  const decl = parseDataShape(declarationBytes);
  plan.declared = true;
  plan.digest = dataShapeDigest(decl);
  for (const pack of list) {
    const hit = decl.packs.find((p) => p.pack === pack);
    if (hit) plan.carried.push({ pack, shapeVersion: hit.shapeVersion });
    else {
      plan.refused.push({
        pack,
        reason: `形状声明里没有「${pack}」这一格 —— 按最严办：它不进快照、也不跟着走`
          + `（声明里有的是：${decl.packs.map((p) => p.pack).join('／') || '（一包都没有）'}）`,
      });
    }
  }
  return plan;
}

/**
 * `shapeCarrierOf()` 的**硬闸**版：只要有**一格**没声明 ⇒ **抛**（fail-closed）。
 *
 * 它是打包侧（`workspace.snapshotWorkspace`）拦在**动盘之前**的那一下 ——
 * 所以在它抛的时候，制品库里**一个版本目录都还没建出来**（盘上零残留）。
 *
 * @returns {ReturnType<typeof shapeCarrierOf>} 过了 ⇒ 那份留痕
 */
export function assertShapeDeclared(o = {}) {
  const plan = shapeCarrierOf(o);
  if (plan.refused.length > 0) {
    throw new DataShapeError(
      `${plan.refused[0].reason}${plan.refused.length > 1 ? `（还有 ${plan.refused.length - 1} 格同样没声明）` : ''}`,
    );
  }
  return plan;
}

/**
 * **盘上这一间房有哪几格数据**（`<scope>/.data/` 下的**目录**）。
 *
 * ⚠️ 只认**目录**：`.data/rows.jsonl` 这种散文件按 `92` §② 是**未归类**（不拦）。
 * ⚠️ 这一格不在／读不动 ⇒ 空数组（"没有数据格"是一个如实的答案，不是"没有声明"）。
 *
 * @param {object} o
 * @param {string} o.scopeDir
 * @param {string} o.cell      数据那一格的目录名（**名字从 `outbound.DATA_DIRNAME` 传进来**，不在这里抄）
 * @param {object} [o.fs]
 */
export function dataNamespacesOnDisk({ scopeDir, cell, fs = nodeFs } = {}) {
  if (typeof scopeDir !== 'string' || scopeDir === '' || typeof cell !== 'string' || cell === '') return [];
  const root = nodePath.join(scopeDir, cell);
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
