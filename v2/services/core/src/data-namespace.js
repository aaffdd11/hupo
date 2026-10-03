// **数据契约：命名空间取用的唯一定义处**（`D4.24` · **D1** · 2026-10-03 主人定）。
//
// ── 主人拍的那句话，逐字 ────────────────────────────────────
//   **D1 = 框架 = 代码 ＋ 数据契约** —— *每个 app 在它工作区里有一份**声明过边界的数据**，
//   平台按**命名空间**隔离*（出处 `docs/dev/85-FRAMEWORK.md` §四·1 · 签字页 `161` D1）。
//   理由（原文）：选甲（只管代码与清单）⇒ **数据边界没人管，"分层"是假的**。
//
// ── A1 已经铺好的那一半（`docs/dev/165-DATA-SHAPE-FORK.md`）──
//   载体已经有了：制品内固定名文件 `data-shape.json`（**只描述形状、值一字节不装**，
//   随 `rootHash` 冻结、随 fork／装上复制）；值住 `<scope>/.data/<pack>/`。
//   上一批把**出去那一侧**（打包／上架）钉死了：盘上有数据格却没声明 ⇒ 拒。
//
// ── 这一批补的是哪一半（**取用那一侧**）──────────────────────
//   上一批之后，"数据契约"只回答了"**能不能出去**"，没有回答"**谁能取到哪一格**"。
//   这一份就回答后面这一问，而且**只回答一次**：
//
//     一次取用 = 「**谁**（caller：哪个 app · 哪个包）」要「**谁**（target：哪个 app · 哪个包）」的数据。
//     允许**当且仅当** `callerApp === targetApp` **且** `callerPack === targetPack`。
//
//   ⇒ 三个后果（每一条都有判据，见 `scripts/check-data-contract.sh`）：
//     ② **同 app 跨 pack 取不到**（一个包只许取自己那一格）；
//     ③ **跨 app 取不到**（`<scope>/.data/` 只归那一个 app）；
//     ⑥ **不过度拒**：自己取自己那一格照旧通、没有数据格的 app 照旧打包（这一侧不碰它）。
//
// ── 四条不许破 ────────────────────────────────────────────
//   ① **契约＝声明**（判据①）：要取的那一格，必须在 `data-shape.json` 里**被声明过**；
//      没声明 ⇒ **拒**（fail-closed），而且**理由看得见**（点名哪一格、缺哪个文件）。
//      🔴 这**不是**另写一套声明判据 —— 调的是 `data-shape.shapeCarrierOf()`（**同一处规则**）。
//   ② **越界在动盘之前就拒**（判据④）：三条路都在**读第一个字节 / 建第一个目录之前**
//      先过闸 ⇒ 越界尝试**盘上零残留**（跑完逐文件 sha256 复原）。
//   ③ **规则只住一处**（判据⑤）：命名空间／边界的判定**全在这个文件里**。
//      · `.data` 那一格的名字**只从 `outbound.DATA_DIRNAME` 取**（不在这里抄第二遍）；
//      · 包名的形状**只从 `data-shape.checkPackName` 取**（不再写一个正则）；
//      · 路径形状（越界 / `..` / 反斜杠 / 控制字符）**只从 `apps.checkRelPath` 取**。
//   ④ **三条路走同一个 guard**：`dataNamespaceRead` / `dataNamespaceWrite` /
//      `dataNamespaceList` 各自只**调** `resolveDataNamespace()`，里面那**一次**
//      `adjudicateDataAccess()` 说了算 —— 谁都不许另抄一段比较。
//
// ── 它与谁不是一回事（别读混）──────────────────────────────
//   · `outbound.js` 判的是"**能不能出去**"（上架／交付／制品口）；
//   · `data-shape.js` 判的是"**那份声明是不是一份能核的声明**"；
//   · 这一份判的是"**这一格归谁**"（取用时的命名空间边界）。
//   ⚠️ 它**不搬运**任何东西出工作区：三条路的落点**永远**是
//      `<那个 app 自己的工作区>/.data/<它自己那一包>/`，一个字都出不了那一间房。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { checkAppId, checkRelPath } from './apps.js';
import { DATA_DIRNAME } from './outbound.js';
import {
  DATA_SHAPE_FILENAME,
  checkPackName,
  shapeCarrierOf,
} from './data-shape.js';

/**
 * 三条取用路各自的名字（**只进拒绝文案** —— N11：拒的时候说清是哪一步拒的）。
 * ⚠️ 它不是"出去律"那三条（`outbound.OUTBOUND_ROUTES`）：那三条是**出界**，
 *    这三条是**在自己家里取用**。两回事，别混。
 */
export const NAMESPACE_ROUTES = Object.freeze({
  read: '取',
  write: '写',
  list: '列',
});

/** 命名空间取用被拒时的错（人话，N11）。**与 `DataShapeError` / `OutboundError` 各是一种。** */
export class DataNamespaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataNamespaceError';
  }
}

function routeName(route) {
  return NAMESPACE_ROUTES[route] ?? String(route ?? '取');
}

/**
 * 🔴 **唯一那一次边界判定**：一次取用许不许。
 *
 * 它只问两件（都不读内容、只看身份与名字）：
 *   ① `callerApp === targetApp`？ —— 不 ⇒ **跨 app 取不到**（③）；
 *   ② `callerPack === targetPack`？ —— 不 ⇒ **跨命名空间取不到**（②，同 app 内也算）。
 *
 * ⚠️ **顺序刻意**：先 app 后 pack —— 于是"这是跨 app"与"这是同 app 跨包"两句话分得开
 *    （排障时看得懂；也不会把一件跨 app 的事说成"跨包"）。
 * ⚠️ 认不出身份（缺 app / 缺包名）⇒ **也拒**（fail-closed：说不清是谁要的就不给）。
 *
 * @param {object} o
 * @param {string} [o.route]       `read` / `write` / `list` —— 只进拒绝文案
 * @param {string} o.callerApp     要东西的那一个 app
 * @param {string} o.callerPack    要东西的那一个包
 * @param {string} o.targetApp     被要的那一个 app
 * @param {string} o.targetPack    被要的那一包
 * @returns {{app:string, pack:string, route:string, callerApp:string, callerPack:string}}
 */
export function adjudicateDataAccess({
  route = 'read',
  callerApp,
  callerPack,
  targetApp,
  targetPack,
} = {}) {
  const where = routeName(route);
  if (typeof callerApp !== 'string' || callerApp === '' || typeof targetApp !== 'string' || targetApp === '') {
    throw new DataNamespaceError(
      `${where}数据：说不清是哪一个 app 要的（缺 app 名字）—— 不认`,
    );
  }
  if (typeof callerPack !== 'string' || callerPack === '' || typeof targetPack !== 'string' || targetPack === '') {
    throw new DataNamespaceError(
      `${where}数据：说不清是哪一个包要的（缺包名）—— 不认`,
    );
  }
  if (callerApp !== targetApp) {
    throw new DataNamespaceError(
      `${where}数据：「${callerApp}」在要「${targetApp}」的数据 —— 跨 app 取不到`
      + '（每一格数据只归它自己那一个 app）',
    );
  }
  if (callerPack !== targetPack) {
    throw new DataNamespaceError(
      `${where}数据：「${callerPack}」在要「${targetPack}」那一包 —— 跨命名空间取不到`
      + '（一个包只许取自己那一格）',
    );
  }
  return { app: targetApp, pack: targetPack, route, callerApp, callerPack };
}

/**
 * 那一间房里那份**形状声明**的字节（**唯一读取处**）。
 *
 * ⚠️ 读不到（文件不在）⇒ `null` —— 这是一句**如实的"没有声明"**，
 *    由 `resolveDataNamespace()` 按最严办（拒），**不是**"当没有这一格"。
 * ⚠️ 读不动（权限 / 坏盘）⇒ **抛**（读不到也拒）—— 与 `outbound.readPacks` 同一条纪律。
 *
 * @param {object} o
 * @param {string} o.scopeDir
 * @param {object} [o.fs]
 * @returns {Buffer|null}
 */
export function readDeclarationBytes({ scopeDir, fs = nodeFs } = {}) {
  if (typeof scopeDir !== 'string' || scopeDir === '') return null;
  try {
    return fs.readFileSync(nodePath.join(scopeDir, DATA_SHAPE_FILENAME));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new DataNamespaceError(
      `形状声明（${DATA_SHAPE_FILENAME}）读不出来 —— 声明不可核，取不到`,
    );
  }
}

/**
 * 原子写（先写临时文件再 rename）—— 与 `workspace.js` 的 `writeAtomic` 同款做法。
 * ⚠️ 它**不是**边界规则，是搬字节；所以这里自己一份不算"规则两处"。
 */
function writeAtomic(fs, file, data, mode = 0o644) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

/**
 * 🔴 **命名空间的唯一解析口**：三条路都只调它。
 *
 * 它按顺序做四件（**任何一件不过 ⇒ 抛，且一件事都还没动盘**）：
 *   ① **名字的形状**：app 走 `apps.checkAppId`、包名走 `data-shape.checkPackName`
 *      （都是**复用**，这里不抄第二份形状）；
 *   ② **边界**：`adjudicateDataAccess()`（上面那一次判定）—— 跨 app / 跨包当场拒；
 *   ③ **契约＝声明**：这一格必须在那一版的 `data-shape.json` 里被声明过
 *      （调 `data-shape.shapeCarrierOf()`，**同一处规则**）；没声明 ⇒ 拒，理由看得见；
 *   ④ **落点**：`<它自己的工作区>/.data/<它自己那一包>/`
 *      （工作区目录走 `workspaces.dirFor`，格名走 `outbound.DATA_DIRNAME`）。
 *
 * @param {object} o
 * @param {object} o.workspaces     `AppWorkspaces`（只用到 `dirFor`）
 * @param {string} o.id             被取用的那个 app
 * @param {string} o.pack           被取用的那一包
 * @param {string|null} [o.callerId]   谁在要（默认 = `id`，即"自己取自己"）
 * @param {string|null} [o.callerPack] 哪个包在要（默认 = `pack`）
 * @param {string} [o.route]
 * @param {object} [o.fs]
 * @param {Buffer|string|null} [o.declarationBytes] 给了就不去盘上读（判据造对照用）
 * @returns {{app:string, pack:string, route:string, dir:string, scopeDir:string,
 *            shapeVersion:string, shapeDigest:string|null, declared:true}}
 */
export function resolveDataNamespace({
  workspaces,
  id,
  pack,
  callerId = null,
  callerPack = null,
  route = 'read',
  fs = nodeFs,
  declarationBytes = undefined,
} = {}) {
  // ① 名字的形状 —— 复用那两处，不另抄
  const app = checkAppId(id);
  const who = checkAppId(callerId === null || callerId === undefined ? id : callerId);
  const target = checkPackName(pack);
  const mine = checkPackName(callerPack === null || callerPack === undefined ? pack : callerPack);

  // ② 🔴 那一次边界判定（唯一一处）
  const verdict = adjudicateDataAccess({
    route,
    callerApp: who,
    callerPack: mine,
    targetApp: app,
    targetPack: target,
  });

  if (!workspaces || typeof workspaces.dirFor !== 'function') {
    throw new DataNamespaceError('取数据要一个工作区（说不清是哪一间房）—— 取不到');
  }
  const scopeDir = workspaces.dirFor(app);

  // ③ 契约＝声明（复用 data-shape 那一处规则）
  const bytes = declarationBytes === undefined
    ? readDeclarationBytes({ scopeDir, fs })
    : declarationBytes;
  const plan = shapeCarrierOf({ packs: [target], declarationBytes: bytes ?? null });
  const carried = plan.carried.find((c) => c.pack === target) ?? null;
  if (!carried) {
    const reason = plan.refused[0]?.reason
      ?? `形状声明里没有「${target}」这一格 —— 按最严办，取不到`;
    throw new DataNamespaceError(`${routeName(route)}数据：${reason}`);
  }

  // ④ 落点（永远在**它自己**那一间房里）
  return {
    app,
    pack: target,
    route: verdict.route,
    dir: nodePath.join(scopeDir, DATA_DIRNAME, target),
    scopeDir,
    shapeVersion: carried?.shapeVersion ?? null,
    shapeDigest: plan.digest,
    declared: true,
  };
}

/**
 * **路①：取**（读这一格里一个文件的字节）。
 *
 * 🔴 出界 ⇒ 在**读第一个字节之前**抛（`resolveDataNamespace` 在前）⇒ 零残留。
 * ⚠️ 路径形状复用 `apps.checkRelPath`（`..` / 绝对路径 / 反斜杠 / 控制字符都拒）。
 *
 * @returns {{app:string, pack:string, rel:string, content:Buffer, bytes:number}}
 */
export function dataNamespaceRead({
  workspaces, id, pack, rel, callerId = null, callerPack = null, fs = nodeFs, declarationBytes,
} = {}) {
  const ns = resolveDataNamespace({ workspaces, id, pack, callerId, callerPack, route: 'read', fs, declarationBytes });
  const r = checkRelPath(rel);
  let buf;
  try {
    buf = fs.readFileSync(nodePath.join(ns.dir, r));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new DataNamespaceError(`取数据：「${ns.pack}」这一格里还没有「${r}」`);
    }
    throw new DataNamespaceError(`取数据：「${ns.pack}／${r}」读不出来`);
  }
  return {
    app: ns.app, pack: ns.pack, rel: r, content: buf, bytes: buf.length,
    dir: ns.dir, scopeDir: ns.scopeDir,
    shapeVersion: ns.shapeVersion, shapeDigest: ns.shapeDigest,
  };
}

/**
 * **路②：写**（把一份字节放进这一格）。
 *
 * 🔴 出界 ⇒ 在**建第一个目录之前**抛 ⇒ 越界尝试**盘上零残留**（判据④就钉这一条）。
 * ⚠️ 只落在 `<scope>/.data/<pack>/` 里面：`checkRelPath` 在前，`..` 出不去。
 *
 * @returns {{app:string, pack:string, rel:string, bytes:number, dir:string}}
 */
export function dataNamespaceWrite({
  workspaces, id, pack, rel, content, callerId = null, callerPack = null, fs = nodeFs, declarationBytes,
} = {}) {
  const ns = resolveDataNamespace({ workspaces, id, pack, callerId, callerPack, route: 'write', fs, declarationBytes });
  const r = checkRelPath(rel);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  if (buf.length === 0) throw new DataNamespaceError('写数据：内容不能是空的');
  const file = nodePath.join(ns.dir, r);
  fs.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(fs, file, buf);
  return { app: ns.app, pack: ns.pack, rel: r, bytes: buf.length, dir: ns.dir };
}

/**
 * **路③：列**（这一格里有哪几个文件，相对路径、排序）。
 *
 * ⚠️ 这一格还没有（声明了但一个字节都没放）⇒ **空数组**：那是一句如实的
 *    "还没有东西"，**不是**"没声明"（没声明在 `resolveDataNamespace` 就拒了）。
 *
 * @returns {{app:string, pack:string, dir:string, files:string[]}}
 */
export function dataNamespaceList({
  workspaces, id, pack, callerId = null, callerPack = null, fs = nodeFs, declarationBytes,
} = {}) {
  const ns = resolveDataNamespace({ workspaces, id, pack, callerId, callerPack, route: 'list', fs, declarationBytes });
  const files = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(rel === '' ? ns.dir : nodePath.join(ns.dir, rel), { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT' && rel === '') return; // 还没有东西
      throw new DataNamespaceError(`列数据：「${ns.pack}」这一格读不出来`);
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else if (e.isFile()) files.push(next);
    }
  };
  walk('');
  return { app: ns.app, pack: ns.pack, dir: ns.dir, files: files.sort() };
}

/**
 * 认不认得出这是"命名空间那道闸拒的"（给读侧／工具侧分岔用，照 `apps.isHiddenPathRefusal` 同款）。
 * ⚠️ **只认本模块抛的那一种**（`DataNamespaceError`）—— `DataShapeError` 是"声明不可核"，
 *    两句话分得开（排障时看得懂）。
 */
export function isDataNamespaceRefusal(err) {
  return err instanceof DataNamespaceError;
}
