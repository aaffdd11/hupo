// **外联申报（A16）** —— 契约 `docs/dev/93-OUTBOUND-USAGE.md` §二／§三 ·
// 主人 2026-09-25 第 5 条（`docs/dev/96-OWNER-DECISIONS.md`：**写在制品里，随 `rootHash` 冻结**）。
//
// ── 它解决什么 ────────────────────────────────────────────
// 主人（93 §〇 逐字）：*"所有访问外网的这些内容这些功能都要做一次审核"* —— 审核要有依据，
// 而依据就是这一份**制品内固定名文件**：它说清"会往哪儿出去、带哪些字段、走不走我们的中转"。
//
// 🔴 **三条不许破**：
//   ① **随 `rootHash` 冻结**（主人第 5 条）：它是制品里的一个普通文件 ⇒ 进 `manifest.files`
//      ⇒ 改一个字节 `rootHash` 就变（判据 2.3.1）。⚠️ **不许**做成 `manifest.json` 的字段
//      （那一份会被下一版覆盖，93 §2.3 已论证）。
//   ② **申报不构成授权**（判据 2.3.2）：写 `kind:'ask'` 而清单里没有 `permissions:['ask']`
//      ⇒ `ask` **照旧不通**（白名单在 `apps.js` 的 `PERMISSIONS`）。
//   ③ 🔴 **fail-closed**（93 §2.4）：读不到 / 认不出 / 枚举外的值 ⇒ **拒上架**，
//      **不是**"当没有外联"。
//
// ── 它做两件（93 §三 R1／R2）──────────────────────────────
//   R1 **逐个出网点对照申报**：把代码里扫得到的出网点与申报的 `outbound[]` 比 ——
//      扫出来的集合必须 **⊆** 申报的集合；
//   R2 🔴 **反向那一半**：申报"不用外网"而代码里真有出网点 ⇒ 拒
//      （**这正是"页面在说假话"**）。
//
// ⚠️ 扫描是**字符串层面**的（不看语义，93 §1.1 明写平台不判语义）：
//    它只能回答"这版制品里有没有这些东西"，回答不了"这个外联点正当不正当"。
// ⚠️ 今天容器**可以任意外联**（93 §2.1 O3 · 账 #65）⇒ 这一条拦的是**产品层**，
//    不是防火墙。**不许把它读成"已经在管出网"**。

import nodePath from 'node:path';

/** 制品内那份固定名文件。**只有这一处**写这个名字。 */
export const OUTBOUND_DECL_FILENAME = 'outbound.json';

/** 申报形状的版本。**认不出 ⇒ 拒**（fail-closed，照 `apps.SCHEMA` 同款做法）。 */
export const OUTBOUND_DECL_SCHEMA = 1;

/** `kind` 的取值（93 §2.2）：`none` = 明说"不用外网"。 */
export const OUTBOUND_KINDS = Object.freeze(['ask', 'agent-web', 'artifact-fetch', 'none']);

/** `fields[]` 的**枚举**（93 §2.2）：出现枚举外的值 ⇒ 拒（不许自由文本蒙混）。 */
export const OUTBOUND_FIELDS = Object.freeze([
  'prompt',
  'answer',
  'sub',
  'workspace-bytes',
  'error-text',
  'none',
]);

/**
 * 申报读不出／认不出时的错。**人话**（N11），而且要说清是**哪一种**读不出。
 */
export class DeclarationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeclarationError';
  }
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 那句话是不是"模板话"（93 §2.2：空／模板话 ⇒ 拒）。 */
export function isTemplatePurpose(s) {
  const t = typeof s === 'string' ? s.trim() : '';
  if (t.length === 0) return true;
  // 只认**逐字**的那几句套话（不做语义判断 —— 平台不判语义，93 §1.1）
  return /^(用于提供更好服务|为了更好的服务|提升用户体验|用于改善服务|暂时没有|待补充|无|n\/a|none)$/iu.test(t);
}

/**
 * **解析并逐条校验**一份申报（纯函数）。认不出 ⇒ **抛**（fail-closed）。
 *
 * @param {string|object} raw 文件原文，或者已经解析好的对象
 * @param {object} [o]
 * @param {number|null} [o.version] 这一版的实际版本号（给了就核 `appVersion`）
 * @returns {object} 一份**逐字段都过了枚举**的申报
 */
export function parseOutboundDeclaration(raw, { version = null } = {}) {
  let j = raw;
  if (typeof raw === 'string') {
    try {
      j = JSON.parse(raw);
    } catch {
      throw new DeclarationError(`外联申报（${OUTBOUND_DECL_FILENAME}）看不懂（不是 JSON）—— 声明不可核，不上架`);
    }
  }
  if (!isPlainObject(j)) {
    throw new DeclarationError(`外联申报（${OUTBOUND_DECL_FILENAME}）不是一份对象 —— 声明不可核，不上架`);
  }
  if (j.schema !== OUTBOUND_DECL_SCHEMA) {
    throw new DeclarationError(
      `外联申报的版本认不出（schema=${String(j.schema).slice(0, 20)}）—— 认不出就不上架`,
    );
  }
  if (!Array.isArray(j.outbound)) {
    throw new DeclarationError(`外联申报里没有出网点表（outbound）—— 声明不可核，不上架`);
  }
  const out = [];
  let sawNone = false;
  for (const it of j.outbound) {
    if (!isPlainObject(it)) {
      throw new DeclarationError('外联申报里有一条不是对象 —— 声明不可核，不上架');
    }
    const kind = it.kind;
    if (!OUTBOUND_KINDS.includes(kind)) {
      throw new DeclarationError(`认不出这个出网点是哪种（kind=${String(kind).slice(0, 30)}）—— 认不出就不上架`);
    }
    if (kind === 'none') {
      sawNone = true;
      if (j.outbound.length !== 1) {
        throw new DeclarationError('申报里既写了"不用外网"、又写了别的出网点 —— 两句话不能同时为真，不上架');
      }
      out.push({ kind, target: 'none', purpose: String(it.purpose ?? '').trim(), fields: [], viaRelay: false });
      continue;
    }
    const target = typeof it.target === 'string' ? it.target.trim() : '';
    if (target === '' || target.length > 200) {
      throw new DeclarationError(`有一个出网点没写清去哪儿（target 空或太长）—— 说不清就不上架`);
    }
    const purpose = typeof it.purpose === 'string' ? it.purpose.trim() : '';
    if (isTemplatePurpose(purpose)) {
      throw new DeclarationError(`出网点「${target}」的用途是空的或套话 —— 说清它干什么才上架`);
    }
    if (!Array.isArray(it.fields)) {
      throw new DeclarationError(`出网点「${target}」没有字段表（fields）—— 声明不可核，不上架`);
    }
    const fields = [];
    for (const f of it.fields) {
      if (!OUTBOUND_FIELDS.includes(f)) {
        throw new DeclarationError(`出网点「${target}」带了一个不认识的字段（${String(f).slice(0, 30)}）—— 不上架`);
      }
      if (!fields.includes(f)) fields.push(f);
    }
    if (fields.length === 0) {
      throw new DeclarationError(`出网点「${target}」的字段表是空的 —— 要么写 none，要么写带了什么`);
    }
    if (typeof it.viaRelay !== 'boolean') {
      throw new DeclarationError(`出网点「${target}」没说走不走我们的中转（viaRelay）—— 声明不可核，不上架`);
    }
    out.push({ kind, target, purpose, fields, viaRelay: it.viaRelay });
  }
  const du = j.declaredUsage;
  if (!isPlainObject(du)) {
    throw new DeclarationError('外联申报里没有用量预告（declaredUsage）—— 上架时要交，交不出就不上架');
  }
  if (!Number.isFinite(du.dailyTokensBand) || du.dailyTokensBand < 0) {
    throw new DeclarationError('用量预告里没有量级（dailyTokensBand ≥ 0）—— 上架时要交，交不出就不上架');
  }
  if (!Number.isFinite(du.dailyCallsBand) || du.dailyCallsBand < 0) {
    throw new DeclarationError('用量预告里没有次数（dailyCallsBand ≥ 0）—— 上架时要交，交不出就不上架');
  }
  const basis = typeof du.basis === 'string' ? du.basis.trim() : '';
  if (isTemplatePurpose(basis) && basis.length < 2) {
    throw new DeclarationError('用量预告里没说"凭什么这么估"（basis 空）—— 声明不可核，不上架');
  }
  if (version !== null && version !== undefined && Number.isFinite(j.appVersion)
      && Number.parseInt(j.appVersion, 10) !== Number.parseInt(version, 10)) {
    throw new DeclarationError(
      `申报写的版本（${j.appVersion}）与实际这一版（${version}）对不上 —— 不许拿旧版的申报蒙新版，不上架`,
    );
  }
  return {
    schema: OUTBOUND_DECL_SCHEMA,
    outbound: out,
    declaresNone: sawNone || out.length === 0,
    declaredUsage: {
      dailyTokensBand: du.dailyTokensBand,
      dailyCallsBand: du.dailyCallsBand,
      basis,
    },
    updatedAt: Number.isFinite(j.updatedAt) ? j.updatedAt : null,
    appVersion: Number.isFinite(j.appVersion) ? j.appVersion : null,
  };
}

/** 哪些扩展名当二进制（不扫）—— 认不出的当文本扫，宁可多扫。 */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff2', '.woff', '.ttf', '.ico', '.pdf', '.zip']);

/** 出网点的**字符串形态**（93 §三 R1 那一列逐条）。 ⚠️ 这是"存在性"扫描，不判语义。 */
const PATTERNS = Object.freeze([
  { kind: 'artifact-fetch', re: /\bfetch\s*\(/u, what: 'fetch(' },
  { kind: 'artifact-fetch', re: /\bXMLHttpRequest\b/u, what: 'XMLHttpRequest' },
  { kind: 'artifact-fetch', re: /\bnew\s+WebSocket\s*\(/u, what: 'new WebSocket(' },
  { kind: 'artifact-fetch', re: /\bnew\s+EventSource\s*\(/u, what: 'new EventSource(' },
  { kind: 'artifact-fetch', re: /\bsendBeacon\s*\(/u, what: 'sendBeacon(' },
  { kind: 'ask', re: /\bask\s*\(/u, what: 'ask(' },
  { kind: 'ask', re: /hupo[-_]?ask/u, what: 'hupo-ask' },
  { kind: 'agent-web', re: /\bweb_search\b/u, what: 'web_search' },
  { kind: 'agent-web', re: /\bweb_fetch\b/u, what: 'web_fetch' },
  { kind: 'agent-web', re: /mcp__/u, what: 'mcp__' },
]);

/**
 * **扫这一版制品里的出网点**（93 §三 R1；纯函数）。
 *
 * ⚠️ 跳过申报文件自己（它的正文里就有 `ask` 这些词，扫它等于自证）。
 * @param {Record<string, Buffer|string>} files
 * @returns {Array<{kind:string, path:string, what:string}>}
 */
export function scanOutboundPoints(files = {}) {
  const out = [];
  const seen = new Set();
  for (const [rel, content] of Object.entries(files)) {
    if (nodePath.basename(rel) === OUTBOUND_DECL_FILENAME) continue;
    if (BINARY_EXT.has(nodePath.extname(rel).toLowerCase())) continue;
    let text;
    if (Buffer.isBuffer(content)) {
      if (content.includes(0)) continue; // 含 NUL ⇒ 当二进制
      text = content.toString('utf8');
    } else {
      text = String(content ?? '');
    }
    for (const p of PATTERNS) {
      if (!p.re.test(text)) continue;
      const key = `${p.kind}\u0000${rel}\u0000${p.what}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: p.kind, path: rel, what: p.what });
    }
  }
  return out;
}

/**
 * 🔴 **申报 vs 代码**（93 §三 R1／R2 · A16 的核心判据）。**必须红的那两条**：
 *
 *   · 扫出来的 `kind` 不在申报里 ⇒ 拒（**未申报的出网点**）；
 *   · 申报说"不用外网"而扫出任何东西 ⇒ 拒（**页面在说假话**）。
 *
 * @param {object} o
 * @param {object} o.decl   `parseOutboundDeclaration()` 的结果
 * @param {Record<string, Buffer|string>} o.files
 * @returns {{points:Array<object>, declaredKinds:string[]}}
 */
export function checkDeclarationAgainstCode({ decl, files } = {}) {
  const points = scanOutboundPoints(files);
  const declared = new Set((decl?.outbound ?? []).map((o) => o.kind));
  if (decl?.declaresNone && points.length > 0) {
    const first = points[0];
    throw new DeclarationError(
      `申报说"不用外网"，可这版制品的 ${first.path} 里有 ${first.what} —— 说不做到就上不了架`,
    );
  }
  for (const p of points) {
    if (!declared.has(p.kind)) {
      throw new DeclarationError(
        `这版制品的 ${p.path} 有一个没申报的出网点（${p.what}）—— 先把它写进申报再上架`,
      );
    }
  }
  return { points, declaredKinds: [...declared] };
}

/**
 * **上架闸上的那一句**：从制品字节里读申报、校验、再与代码对照。**任何一步读不出 ⇒ 抛**。
 *
 * @param {object} o
 * @param {Record<string, Buffer|string>} o.files
 * @param {number} [o.version]
 * @returns {{decl:object, points:Array<object>}}
 */
export function assertDeclarationAllowed({ files, version = null } = {}) {
  const hit = Object.keys(files ?? {}).find((rel) => nodePath.basename(rel) === OUTBOUND_DECL_FILENAME);
  if (!hit) {
    throw new DeclarationError(
      `这版制品里没有 ${OUTBOUND_DECL_FILENAME}（外联申报）—— 读不到申报就不上架`,
    );
  }
  const raw = files[hit];
  const decl = parseOutboundDeclaration(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? ''), { version });
  const { points } = checkDeclarationAgainstCode({ decl, files });
  return { decl, points, path: hit };
}
