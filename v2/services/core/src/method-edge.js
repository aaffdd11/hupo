// **三条登记边分开建**（92 §③ 阶段 5 · 契约 `docs/dev/92-TRIPLE-PLAN.md`）。
//
// ── 它解决什么 ────────────────────────────────────────────
// 92 §③ 阶段 5 的原话：**能力体版本边**（`rootHash` → 上游，**只增**）／
// **经验方法边**（**唯一有回流方向**的那条 ⇒ 必须有**应用点**＋**回退点**）／
// **数据交付边**（**成对、永不回流**）；**各带来源**。
//
// ⇒ 这一篇把"哪条边是什么形状、来源住哪、往哪个方向走"收成**一处常量表**
//    （[`EDGE_KINDS`]），三家的实现各回各的模块：
//
// | 边 | 住哪（登记） | 谁写 | 方向 | 来源住哪 |
// |---|---|---|---|---|
// | **能力体版本边** `capability` | `hupo/apps/<id>/lineage.json` | `apps.noteLineage` | **只增**（没有删的路） | 边上的 `baseRootHash`（64 位十六进制） |
// | **经验方法边** `method` | `<scope>/.exp/edges.jsonl` | [`MethodEdges.apply`] | **唯一有回流方向**（上游 → 我） | 边上的 `source`（`app`＋`rootHash`＋`role`） |
// | **数据交付边** `data` | 这条人自己的可见日志（`delivery/*`，`src/delivery.js`） | `Delivery.request/consent/deliver/revoke` | **成对、永不回流** | 边上的 `from`／`to`（人格 key） |
//
// ── 🔴 为什么"来源"不许放进 app 血缘 ────────────────────────
// `lineage.json` 记的是**能力体从哪一版长出来的**（90 Q4.6／Q4.9）。
// 把经验的来源、数据的来源塞进去 ⇒ 那条边同时背着三样东西：
//   · 删血缘就不再是"零影响"（可检查性不再是 0）；
//   · "这个 app 是从哪一版 fork 的"不再说得清；
//   · 而经验／数据各有自己的登记处，塞一遍就是**两处记同一个事实**（迟早漂）。
// ⇒ `apps.noteLineage` 有白名单，多一个键**当场拒**；
//    [`capabilityEdgeOf`] 是"正式那条路"：它**当场核**那个起点在我们这儿立不立得住。
//
// ── 🔴 为什么方法边必须带应用点 ＋ 回退点 ─────────────────────
// 它是**唯一**有一条"回流方向"的边（收到的经验 → 进我这一份）。
// 有回流方向而没有应用点 ⇒ "回流"是一句没有落点的话；
// 有应用点而没有回退点 ⇒ 应用一次就**回不去**（N5：回退点不需要 agent）。
// ⇒ [`MethodEdges.apply`] 的顺序刻意：**先拍快照（应用前那一份），再动任何字节**；
//    [`MethodEdges.rollback`] 把快照那一版镜像回工作区，并**逐字节核**等于应用前。
//
// ⚠️ **它一条字节都不带出界**：这里只写**本地登记**与**本地工作区**；
//    "出去"那一条路仍然只有 `published.publish`（`outbound.js` 那条独木桥）。
// ⚠️ **它不自动生效**：`apply()` 只由**人／工具明确叫一次**才会跑
//    （98 §②③ 的"没有自动生效路"照旧成立；每轮输入那一侧不认识这条边）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { rootHashOf, sha256hex } from './apps.js';
import { isRootHash } from './outbound.js';
import { mirrorArtifactIntoWorkspace, snapshotWorkspace } from './workspace.js';

/**
 * **三条登记边**（92 §③ 阶段 5）。这是全仓**写这三条边的形状**的那一处 ——
 * 别处只许引用它，不许另抄一份。
 *
 * `reflow` 那一栏就是"出去律是路，不是格"在**边**上的落点：
 *   · `capability` `'never'`   —— 只增，没有任何回头的路；
 *   · `method`     `'back'`    —— **唯一**有回流方向 ⇒ 必须有应用点＋回退点；
 *   · `data`       `'never'`   —— 成对（一取一给），但**永不回流**（撤回也只管未来）。
 */
export const EDGE_KINDS = Object.freeze({
  capability: Object.freeze({
    kind: 'capability',
    cell: 'hupo/apps/<id>/lineage.json',
    reflow: 'never',
    monotonic: true,
    what: '能力体版本边：这一版从哪一个上游起点（rootHash）长出来',
  }),
  method: Object.freeze({
    kind: 'method',
    cell: '<scope>/.exp/edges.jsonl',
    reflow: 'back',
    monotonic: false,
    what: '经验方法边：这一份收到（应用）了谁的哪一版经验',
  }),
  data: Object.freeze({
    kind: 'data',
    cell: '可见日志（delivery/* 四条记录）',
    reflow: 'never',
    monotonic: false,
    what: '数据交付边：这一份一对一给了谁（成对，永不回流）',
  }),
});

/** 方法边那条只追加的登记（住在经验那一格里，与 `pack.json` 同族）。 */
export const METHOD_EDGE_LOG = 'edges.jsonl';

/** 经验那一格（与 `outbound.EXP_DIRNAME` 同一个名字；这里只用来拼登记路径）。 */
const EXP_DIRNAME = '.exp';

/** 方法边上的"来源"认哪几种角色。**认不出 ⇒ 拒**（fail-closed）。 */
const SOURCE_ROLES = Object.freeze(['author', 'one-to-one', 'upstream']);

export class MethodEdgeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MethodEdgeError';
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());

/**
 * **能力体版本边的形状**（三条边里的第一条）—— 造一条并**当场核**那个起点。
 *
 * 🔴 它**只收能力体那一族的参数**：多的东西一件都不收（另两条边各有各的登记处）。
 * 🔴 "来源可核"落在这一句：`baseRootHash` 要么是**这一版自己**
 *    （那就是"起点就是它"，与 `outbound` 的锚同款），要么**在我们这儿立得住**
 *    （`apps.manifest(baseVersion).rootHash` 逐字相等 —— 自称的来源不算来源）。
 *
 * @param {object} o
 * @param {object} o.apps
 * @param {string} o.id          我这一版属于哪个 app
 * @param {string} o.baseRootHash 上游那一版的起点（64 位十六进制）
 * @param {number} o.baseVersion 上游那一版在我们这儿的版本号（核它用）
 * @param {number} o.myVersion   我这一版
 * @param {string} [o.kind]      `fork`（今天只有这一种能力体版本边的由来）
 * @returns {{kind:string, baseRootHash:string, baseVersion:number, myVersion:number}}
 */
export function capabilityEdgeOf({
  apps,
  id,
  baseRootHash,
  baseVersion,
  myVersion,
  kind = 'fork',
} = {}) {
  if (!apps || typeof apps.manifest !== 'function') {
    throw new MethodEdgeError('能力体版本边要一个制品库（核来源要用它）');
  }
  if (!isRootHash(baseRootHash)) {
    throw new MethodEdgeError('能力体版本边的来源必须是一条 rootHash（64 位十六进制）—— 认不出就不记');
  }
  const bv = Number.parseInt(baseVersion, 10);
  const mv = Number.parseInt(myVersion, 10);
  if (!Number.isInteger(bv) || bv < 1 || !Number.isInteger(mv) || mv < 1) {
    throw new MethodEdgeError('能力体版本边要两个版本号（上游那一版、我这一版）');
  }
  const mine = apps.manifest(id, mv);
  if (!mine) throw new MethodEdgeError('我这一版不在，这条边记不了');
  if (!isRootHash(mine.rootHash)) throw new MethodEdgeError('我这一版没有可核起点 —— 边记不了');
  // 🔴 **来源可核**：这一版自己 ⇒ 认；上游 ⇒ 它得真的在我们这儿立得住
  if (baseRootHash !== mine.rootHash) {
    const up = apps.manifest(id, bv);
    if (!up || up.rootHash !== baseRootHash) {
      throw new MethodEdgeError(
        `这条边的来源（${String(baseRootHash).slice(0, 12)}…）在我们这儿核不出来 —— 自称的来源不算来源`,
      );
    }
  }
  return { kind, baseRootHash, baseVersion: bv, myVersion: mv };
}

/** 方法边的登记文件路径（`<scope>/.exp/edges.jsonl`）。 */
export function methodEdgePath(scopeDir) {
  return nodePath.join(scopeDir, EXP_DIRNAME, METHOD_EDGE_LOG);
}

/** 盘上那串方法边（没有 / 坏了 ⇒ 空数组，**不猜**）。 */
export function readMethodEdges({ fs = nodeFs, scopeDir } = {}) {
  const p = methodEdgePath(scopeDir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const j = JSON.parse(t);
      if (j && typeof j === 'object' && !Array.isArray(j) && j.kind === 'method') out.push(j);
    } catch {
      /* 认不出的行跳过（宁可少一条，也不凭猜塞一条进来 —— 同 `delivery.list()`） */
    }
  }
  return out;
}

/**
 * **经验方法边那条登记面**（92 §③ 阶段 5 第二条边 · 唯一有回流方向）。
 *
 * 四件事，一步不多：
 *   · [`apply`]     —— **应用点**：**先拍快照**，再把这一包的字节落进目标那一间；
 *   · [`rollback`]  —— **回退点**：把快照那一版镜像回去，**逐字节等于应用前**；
 *   · [`list`]      —— 读盘上那串边（**读盘**，不是读内存）；
 *   · [`isApplied`] —— 问"这一份的来源在当前这一版上立得住吗"。
 *
 * @param {object} o
 * @param {object} o.apps        制品库（快照与回退都落在它那儿：`versions/<n>/`）
 * @param {object} o.workspaces  工作区（`AppWorkspaces`）
 * @param {string} o.scope       这一间房（也是默认的应用目标）
 * @param {object} [o.fs]
 * @param {()=>number} [o.now]
 */
export class MethodEdges {
  #apps;
  #workspaces;
  #scope;
  #fs;
  #now;

  constructor({ apps, workspaces, scope, fs = nodeFs, now = Date.now } = {}) {
    if (!apps) throw new MethodEdgeError('方法边要一个制品库');
    if (!workspaces) throw new MethodEdgeError('方法边要一间工作区');
    const s = str(scope);
    if (s === '') throw new MethodEdgeError('方法边要说清是哪一间房');
    this.#apps = apps;
    this.#workspaces = workspaces;
    this.#scope = s;
    this.#fs = fs;
    this.#now = now;
  }

  get scopeDir() {
    return this.#workspaces.dirFor(this.#scope);
  }

  /** 盘上那串边（**读盘**）。 */
  list() {
    return readMethodEdges({ fs: this.#fs, scopeDir: this.scopeDir });
  }

  /** 一条边追加落盘（**只追加**；写失败上抛 —— 不许"记了一半"）。 */
  #append(edge) {
    const p = methodEdgePath(this.scopeDir);
    this.#fs.mkdirSync(nodePath.dirname(p), { recursive: true, mode: 0o700 });
    this.#fs.appendFileSync(p, `${JSON.stringify(edge)}\n`, { mode: 0o644 });
    return edge;
  }

  /** 边的来源那一半：**谁的经验**（app ＋ 起点 ＋ 角色）。认不出 ⇒ 拒。 */
  #source({ app, rootHash, role = 'one-to-one' }) {
    const a = str(app);
    if (a === '') throw new MethodEdgeError('方法边要说清这份经验是谁的（app）');
    if (!isRootHash(rootHash)) {
      throw new MethodEdgeError('方法边的来源必须是一条 rootHash —— 认不出就不应用');
    }
    if (!SOURCE_ROLES.includes(role)) {
      throw new MethodEdgeError(`方法边的来源角色认不出（${String(role).slice(0, 20)}）—— 不记`);
    }
    return { app: a, rootHash, role };
  }

  /**
   * **应用点**（92 §③ 阶段 5：方法边必须有的那两个点之一）。
   *
   * 🔴 **顺序是这一条的全部**：**先拍快照（应用前那一份），再动任何字节**。
   *    拍不下来 ⇒ **什么都不写**（抛，盘上零改动）。
   * 🔴 **来源可核**：`source.rootHash` 要在这边立得住 —— 或者
   *    就是**目标自己当前那一版的起点**（"我自己的这一份"，与出界闸的锚同款），
   *    或者目标制品库里**有某一版**的起点逐字等于它（"收别人的那一版"）。
   *    核不出 ⇒ 拒（自称的来源不算来源）。
   * ⚠️ **经验包**（`packId`）只进登记：这一版把经验当"方法文"记下来，
   *    **不把它编译进能力体**（编译进制品就是能力体，那是 `source.role='upstream'` 那一路的事）。
   *
   * @returns {{edge:object, snapshot:object, applied:boolean}}
   *   `applied=false` ⇔ 工作区本来就没有可应用的字节（**如实说**，不假装应用过）
   */
  apply({
    packId,
    shapeVersion,
    source,
    bytes = null,
    target = null,
    why = '',
  } = {}) {
    const p = str(packId);
    if (p === '') throw new MethodEdgeError('没说清应用哪一份经验（packId）—— 不记');
    const sv = str(shapeVersion);
    if (sv === '') {
      throw new MethodEdgeError('没说清是哪一版形状（shapeVersion）—— 不应用（对不上就不许算）');
    }
    const src = this.#source(source ?? {});
    const to = str(target) || this.#scope;
    const say = str(why);
    // 🔴 **来源可核**（两条路，都不是"猜"）
    const own = this.#apps.current(to);
    const ownMan = own === null ? null : this.#apps.manifest(to, own);
    let resolved = null;
    if (ownMan && ownMan.rootHash === src.rootHash) {
      resolved = own; // 来源就是这一版自己（同一份字节）
    } else {
      for (let v = 1; v <= 64; v += 1) {
        const m = this.#apps.manifest(to, v);
        if (m && m.rootHash === src.rootHash) { resolved = v; break; }
      }
    }
    if (resolved === null) {
      throw new MethodEdgeError(
        `这份经验的来源（${src.rootHash.slice(0, 12)}…）在我们这儿核不出来 —— 自称的来源不算来源`,
      );
    }

    // ── 🔴 **先拍快照**（应用前那一份）；拍不下来就什么都不写 ──────────────
    const snap = snapshotWorkspace({
      apps: this.#apps,
      workspaces: this.#workspaces,
      id: to,
      title: this.#apps.meta(to)?.title ?? null,
      icon: this.#apps.meta(to)?.icon,
      createdBy: 'user',
    });

    // ── 这一步真的"应用"了什么：把这一包的字节落进工作区（有字节才做）────
    let applied = false;
    let wrote = [];
    if (bytes && typeof bytes === 'object' && !Array.isArray(bytes) && Object.keys(bytes).length > 0) {
      const r = this.#workspaces.write(to, bytes);
      wrote = r.wrote;
      applied = true;
    }

    const edge = {
      kind: 'method',
      at: this.#now(),
      packId: p,
      shapeVersion: sv,
      source: src,
      target: to,
      // 🔴 **应用点**：快照落在制品库里哪一版（回退点就是它）
      appliedVersion: snap.manifest.version,
      appliedRootHash: snap.manifest.rootHash,
      wrote,
      why: say,
    };
    this.#append(edge);
    return { edge, snapshot: snap, applied };
  }
  /**
   * **回退点**（92 §③ 阶段 5：方法边必须有的另一个点）。
   *
   * 🔴 它把**快照那一版**（`appliedVersion`）镜像回工作区，然后
   *    **逐字节核**工作区指纹等于应用前那一个 —— 对不上 ⇒ 抛（不许说"退回去了"）。
   * ⚠️ 它**不是**"退回到上一个提交"那种做法：镜像的是**当时拍下的那一份**，
   *    与其他改动无关。
   *
   * @returns {{scope:string, version:number, rootHash:string, restored:boolean}}
   */
  rollback({ edge, scope = null } = {}) {
    if (!edge || typeof edge !== 'object' || edge.kind !== 'method') {
      throw new MethodEdgeError('回退要一条方法边（`apply()` 返回的那一条）');
    }
    const to = str(scope) || str(edge.target);
    if (to === '') throw new MethodEdgeError('回退要说清退哪一间房');
    const v = Number.parseInt(edge.appliedVersion, 10);
    if (!Number.isInteger(v) || v < 1) {
      throw new MethodEdgeError('这条边上没有应用点（appliedVersion）—— 没有可退的地方');
    }
    const m = this.#apps.manifest(to, v);
    if (!m) throw new MethodEdgeError('应用点那一版不在了 —— 退不回去，如实说');
    mirrorArtifactIntoWorkspace({ apps: this.#apps, workspaces: this.#workspaces, id: to, version: v });
    // 🔴 **逐字节核**：退回去之后，工作区指纹必须等于应用前那一条
    const ws = this.#workspaces.read(to);
    const now = rootHashOf(
      Object.entries(ws.files).map(([path, buf]) => ({ path, sha256: sha256hex(buf) })),
    );
    if (now !== edge.appliedRootHash) {
      throw new MethodEdgeError('退回去之后工作区与快照对不上 —— 这一步没退干净，不报成功');
    }
    return { scope: to, version: v, rootHash: now, restored: true };
  }

  /**
   * **"这一份的来源在当前这一版上立得住吗"**（读盘核对，不是记着的）。
   *
   * ⚠️ 它只回答**方法边自己**那一半：经验**不承重** —— app 删掉 `.exp/` 照样能装能跑
   *    （92 §③ 阶段 5 第三条判据：**可检查性 0**）。
   */
  isApplied({ edge } = {}) {
    if (!edge || typeof edge !== 'object') return false;
    const to = str(edge.target);
    if (to === '') return false;
    const cur = this.#apps.current(to);
    if (cur === null) return false;
    const m = this.#apps.manifest(to, cur);
    return Boolean(m) && m.rootHash === str(edge.source?.rootHash);
  }
}
