// **升级：分级派（`C1`）＋ 升级粒度（`C3`）**（`D4.24` · 2026-10-03 主人定）。
//
// ── 口径（签字页 `docs/dev/161-OWNER-DECISIONS-11.md` 原文摘要）──────────
//   **C1** 升级=**分级派**：**契约版本变了才请 AI 重写**。判据最硬的一条：
//         **契约版未变 ⇒ AI 重写计数 = 0**（能反着验）。
//   **C3** 升级粒度=**默认按用户整体跟，允许按 app 留旧版**。
//
// ── 这一份是什么 ────────────────────────────────────────────────
//   ① **那一处判定**：`decideUpgrade()` —— 只有它说"要不要请 AI 重写"。
//      输入是**两侧的契约版本**（`apps.shapeVersion()` = 清单里的 `schema`，能力体那一族的号）；
//      契约版**逐字相同** ⇒ `byte-swap`（整版换字节 ＋ 保数据，**不请 AI**）；
//      变了 ⇒ `ai-rewrite`（请 AI 在那个实例自己的房间走出来，不是 mapping）。
//      ⚠️ **读不出契约版本 ⇒ 抛**（`不可算`）—— **不许猜一个号**（猜了就等于把判据废掉）。
//   ② **粒度默认值**：`UpgradePolicy` —— `mode` 默认 `'user'`（**按用户整体跟**）；
//      某一个 app 显式**留旧版**（`pin`）⇒ 它**不跟**，而且 `state()` 里**看得出来**。
//   ③ **可反着验的计数**：`UpgradeBook` —— 每一次升级决定落一行 `upgrade-ledger.jsonl`；
//      `rewriteCount()` = 判成"请 AI 重写"的条数。⇒ 契约版没变的一次升级之后，它**必须是 0**。
//
// ── 三条纪律 ────────────────────────────────────────────────────
//   · **判定只有一处**：那条比较与"请 AI"这个结论都只在本文件里出现一次（判据 C1-⑥ 源码级钉它）。
//   · **不过度**：没有升级需求（上游没出新版 / 就是这一版）⇒ `kind='none'`，**一个字节都不写**。
//   · **不做静默**：升级这件事必须留痕（账本），而且"留旧版"是**显式**的一条记录，不是默认。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 升级决定的几类（判据按这几类读）。 */
export const UPGRADE_KINDS = Object.freeze({
  /** 没有升级需求（没有新版 / 就是这一版）⇒ **什么都不做**。 */
  NONE: 'none',
  /** 这个 app 被显式**留旧版** ⇒ **不跟**（粒度那一半）。 */
  HELD: 'held',
  /** 契约版未变 ⇒ **整版换字节 ＋ 保数据**，**不请 AI**。 */
  BYTE_SWAP: 'byte-swap',
  /** 契约版变了 ⇒ **请 AI 重写**。 */
  AI_REWRITE: 'ai-rewrite',
});

/** 升级粒度的默认值（🔴 **C3：按用户整体跟**）。 */
export const DEFAULT_UPGRADE_MODE = 'user';

/** 粒度文件叫什么（住在用户那一格）。 */
export const UPGRADE_POLICY_FILENAME = 'upgrade-policy.json';

/** 升级决定那本账叫什么（一行一条 JSON；住用户那一格）。 */
export const UPGRADE_LEDGER_FILENAME = 'upgrade-ledger.jsonl';

export class UpgradeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpgradeError';
  }
}

/** app 短名的形状（与 `apps.checkAppId` 同一套 —— **不另抄规则，只对齐形状**）。 */
const APP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function checkId(id) {
  const s = String(id ?? '');
  if (!APP_ID_RE.test(s)) throw new UpgradeError(`短名不合法：${s.slice(0, 24)}`);
  return s;
}

function intOrNull(v) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * 🔴 **升级的唯一判定**（`D4.24` · **C1**）：**契约版本变了才请 AI 重写**。
 *
 * ⚠️ 这一条比较**全仓只有这一处**（判据 C1-⑥ 源码级 ＋ 变异钉它）。
 * ⚠️ 任一侧读不出 ⇒ **抛**（`不可算`）：宁可说"算不出来"，**不许**默认请一次 AI、
 *    也不许默认不请 —— 两种默认都是在替主人拍一件没拍的事。
 *
 * @param {{contractFrom:number, contractTo:number}} o 两侧的契约版本（`apps.shapeVersion()`）
 * @returns {'byte-swap'|'ai-rewrite'}
 */
export function decideUpgrade({ contractFrom, contractTo } = {}) {
  if (intOrNull(contractFrom) === null || intOrNull(contractTo) === null) {
    throw new UpgradeError('契约版本读不出来（这一版不在 / 清单坏了）⇒ 算不出要不要重写，不猜');
  }
  return contractFrom === contractTo ? UPGRADE_KINDS.BYTE_SWAP : UPGRADE_KINDS.AI_REWRITE;
}

/**
 * **升级粒度**（`D4.24` · **C3**）：默认**按用户整体跟**，允许**按 app 留旧版**。
 *
 * 盘上就一份小文件（`upgrade-policy.json`）：
 * ```
 * { "schema": 1, "mode": "user", "pinned": { "coin": 3 } }
 * ```
 * · **文件不在** ⇒ 默认（跟）；**文件在而读不出／认不出** ⇒ **抛**（不可算，不许猜）。
 * · `pinned[<id>] = <他手里那一版>` ⇒ 只对**那一个** app 说"不跟"。
 */
export class UpgradePolicy {
  /**
   * @param {object} o
   * @param {string} [o.dir]  用户那一格（策略文件住 `<dir>/upgrade-policy.json`）
   * @param {string} [o.file] 直接给文件路径（优先）
   * @param {object} [o.fs]
   * @param {()=>number} [o.now]
   */
  constructor({ dir = null, file = null, fs = nodeFs, now = Date.now } = {}) {
    if (!file && !dir) throw new UpgradeError('dir 或 file 必填');
    this.fs = fs;
    this.now = now;
    this.file = file ?? nodePath.join(dir, UPGRADE_POLICY_FILENAME);
  }

  /** 盘上那一份（**文件不在 ⇒ 默认**；在而认不出 ⇒ **抛**）。 */
  read() {
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { schema: 1, mode: DEFAULT_UPGRADE_MODE, pinned: {} };
      throw new UpgradeError(`粒度那份读不出来（${err?.code ?? err?.message ?? err}）`);
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new UpgradeError('粒度那份不是一份能认的记录 ⇒ 算不出跟不跟，不猜');
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new UpgradeError('粒度那份形状不对');
    const mode = j.mode === undefined ? DEFAULT_UPGRADE_MODE : String(j.mode);
    if (mode !== DEFAULT_UPGRADE_MODE) throw new UpgradeError(`认不出这种粒度：${mode.slice(0, 24)}`);
    const pinned = j.pinned && typeof j.pinned === 'object' && !Array.isArray(j.pinned) ? j.pinned : {};
    const clean = {};
    for (const [id, v] of Object.entries(pinned)) {
      const n = intOrNull(v);
      if (n === null) throw new UpgradeError(`留旧版那一格里 ${String(id).slice(0, 24)} 的版本号不合法`);
      clean[checkId(id)] = n;
    }
    return { schema: 1, mode, pinned: clean };
  }

  #write(next) {
    this.fs.mkdirSync(nodePath.dirname(this.file), { recursive: true, mode: 0o755 });
    const tmp = `${this.file}.tmp-${process.pid}-${this.now()}`;
    this.fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
    this.fs.renameSync(tmp, this.file);
    return next;
  }

  /** 某一个 app 跟不跟（**默认跟**；只有显式留旧版的那一个不跟）。 */
  follows(id) {
    const s = this.read();
    return s.pinned[checkId(id)] === undefined;
  }

  /** 他手里被留旧版的那一版（没留 ⇒ `null`）。 */
  pinnedVersion(id) {
    const s = this.read();
    return s.pinned[checkId(id)] ?? null;
  }

  /** 可观察的状态（"跟不跟"与"留的是哪一版"都看得见）。 */
  state(id) {
    const s = this.read();
    const key = checkId(id);
    return {
      id: key,
      mode: s.mode,
      follows: s.pinned[key] === undefined,
      pinnedVersion: s.pinned[key] ?? null,
    };
  }

  /** 盘上全部（`{mode, pinned}`）。 */
  snapshot() {
    const s = this.read();
    return { mode: s.mode, pinned: { ...s.pinned } };
  }

  /** **留旧版**：显式让这一个 app 不跟（`version` 是他要留住的那一版）。 */
  pin(id, version) {
    const key = checkId(id);
    const n = intOrNull(version);
    if (n === null) throw new UpgradeError('留旧版要给一个版本号');
    const s = this.read();
    return this.#write({ schema: 1, mode: s.mode, pinned: { ...s.pinned, [key]: n } });
  }

  /** **跟上**：把"留旧版"这条撤掉 ⇒ 它回到默认（跟）。 */
  unpin(id) {
    const key = checkId(id);
    const s = this.read();
    if (s.pinned[key] === undefined) return { schema: 1, mode: s.mode, pinned: { ...s.pinned } };
    const next = { ...s.pinned };
    delete next[key];
    return this.#write({ schema: 1, mode: s.mode, pinned: next });
  }
}

/**
 * **一次升级的计划**（`C1` ＋ `C3` 合起来的那一次判定）。**纯读**：不写盘。
 *
 * 顺序刻意（前三步都是"不请 AI"的短路）：
 *   ① 没有新版 / 就是这一版 ⇒ `none`（**不过度**：什么都不做）；
 *   ② 这一个 app 被留旧版 ⇒ `held`（**默认跟、显式留**）；
 *   ③ 否则按**契约版本**决定：未变 ⇒ `byte-swap`，变了 ⇒ `ai-rewrite`。
 *
 * @param {object} o
 * @param {import('./apps.js').Apps} o.apps
 * @param {string} o.id
 * @param {number} [o.fromVersion] 他现在这一版（不给 ⇒ `apps.current(id)`）
 * @param {number} [o.toVersion]   要升到哪一版（不给 ⇒ 同 `from` ⇒ `none`）
 * @param {UpgradePolicy|null} [o.policy] 粒度（不给 ⇒ 默认：跟）
 * @returns {object} JSON 可序列化的一份计划
 */
export function planUpgrade({ apps, id, fromVersion = null, toVersion = null, policy = null } = {}) {
  const key = checkId(id);
  const from = intOrNull(fromVersion ?? apps?.current?.(key));
  const to = intOrNull(toVersion ?? from);
  const base = { id: key, fromVersion: from, toVersion: to };
  if (from === null) {
    return { ...base, kind: UPGRADE_KINDS.NONE, rewrite: false, follows: true, pinnedVersion: null, why: '他现在还没有这一版 ⇒ 没有升级这回事' };
  }
  if (to === null || to === from) {
    return { ...base, kind: UPGRADE_KINDS.NONE, rewrite: false, follows: true, pinnedVersion: null, why: '上游没有新的一版 ⇒ 不动' };
  }
  const follows = policy ? policy.follows(key) : true;
  if (!follows) {
    return {
      ...base,
      kind: UPGRADE_KINDS.HELD,
      rewrite: false,
      follows: false,
      pinnedVersion: policy.pinnedVersion(key),
      why: `这一个被显式留旧版（第 ${policy.pinnedVersion(key)} 版）⇒ 不跟`,
    };
  }
  const contractFrom = apps?.shapeVersion?.(key, from) ?? null;
  const contractTo = apps?.shapeVersion?.(key, to) ?? null;
  const kind = decideUpgrade({ contractFrom, contractTo });
  return {
    ...base,
    kind,
    rewrite: kind === UPGRADE_KINDS.AI_REWRITE,
    follows: true,
    pinnedVersion: null,
    contractFrom,
    contractTo,
    why: kind === UPGRADE_KINDS.AI_REWRITE
      ? `契约版本 ${contractFrom} → ${contractTo} 变了 ⇒ 请 AI 重写`
      : `契约版本还是 ${contractFrom} ⇒ 整版换字节、保数据，不请 AI`,
  };
}

/**
 * **升级那本账**（`C1` 的"重写计数"住在它上面）：粒度 ＋ 每一次决定的留痕。
 *
 * 🔴 **计数是行为读数、不是承诺**：`rewriteCount()` 数的是账本里判成 `ai-rewrite` 的条数。
 *    契约版没变的一次升级，走完 `plan()` 之后它**必须是 0**（判据 C1-⑤ 反着验）。
 * ⚠️ **没有升级需求 ⇒ 一个字都不写**（判据 C3-⑧：不过度）。
 */
export class UpgradeBook {
  /**
   * @param {object} o
   * @param {string} [o.dir]  用户那一格
   * @param {string} [o.file] 账本文件路径（优先）
   * @param {object} [o.fs]
   * @param {()=>number} [o.now]
   * @param {UpgradePolicy} [o.policy]
   */
  constructor({ dir = null, file = null, fs = nodeFs, now = Date.now, policy = null } = {}) {
    if (!file && !dir) throw new UpgradeError('dir 或 file 必填');
    this.fs = fs;
    this.now = now;
    this.file = file ?? nodePath.join(dir, UPGRADE_LEDGER_FILENAME);
    this.policy = policy ?? new UpgradePolicy({ dir, file: file ? `${file}.policy` : null, fs, now });
  }

  /** 一次决定：算 ＋ 留痕（**只在真有决定可做时**写）。 */
  plan(opts) {
    const p = planUpgrade({ ...opts, policy: opts?.policy ?? this.policy });
    // 没有升级需求 ⇒ **不动盘**（不过度）
    if (p.kind === UPGRADE_KINDS.NONE) return p;
    this.#append({ at: this.now(), ...p });
    return p;
  }

  #append(rec) {
    this.fs.mkdirSync(nodePath.dirname(this.file), { recursive: true, mode: 0o755 });
    this.fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`, { mode: 0o644 });
  }

  /** 账本里那几条（没有 / 坏了 ⇒ 空数组，**不猜**）。 */
  entries() {
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 坏行跳过那一条（账本只增，坏行不该让整本读不出来） */
      }
    }
    return out;
  }

  /** 🔴 **AI 重写计数**（`C1` 那条最硬的判据读它）。 */
  rewriteCount() {
    return this.entries().filter((e) => e.rewrite === true).length;
  }

  /** 按 app 数（给报告用）。 */
  counts() {
    const all = this.entries();
    const by = (k) => all.filter((e) => e.kind === k).length;
    return {
      total: all.length,
      rewrite: this.rewriteCount(),
      byteSwap: by(UPGRADE_KINDS.BYTE_SWAP),
      held: by(UPGRADE_KINDS.HELD),
    };
  }
}
