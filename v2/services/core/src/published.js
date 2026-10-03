// **共享的小程序库**（乙-3 · 契约 `docs/dev/59-USER-APPS.md` §四）。
//
// ── 两条形状决定（先说清，后面全靠它们）────────────────────
//   ① **发布 = 把作者当前那一版复制一份进共享库**（作者自己那份不动）。
//      ⇒ 作者删了自己的、或者下架了，**已经装过的人那份还在**。
//   ② **装上 = 把共享库里那一版复制进他自己的制品库**（乙-1 那个 `Apps`）。
//      ⇒ 制品口那条路**一行都不用改**（它只从"你自己那一格"里读），
//        而且"别人下架"不会让装过的人忽然打不开。
//
// ⚠️ **共享库里不存作者的身份**，只存 `authorHash`：
//    下架时比对这个假名就够，**原始身份不进这个所有人共享的目录**。
//
// 🔴 **`A3·补·二`（D4.24 · B1 · 2026-10-03）**：这一格原来是 **`sha256(sub)` 的前 12 位**
//    —— 那是**裸 sha256 截断**，而 `sub` 是可枚举的（`u1`/`u2`…）⇒ **能穷举反推**
//    ⇒ 与 B1「真身份不给」冲突（账本 `#73`）。现在换成 `cred-hash.js` 那套
//    **带键 HMAC**（同一把键、同一个域 `hupo-cred-v1`）。
//
// 🔴 但这一格**承重**（`publish` 的重名判 · `unpublish` 的"这一条不是你发的" ·
//    `discover` 的"哪条是我发的"），而**存量 `index.json`（真机上的
//    `published-apps/coin`）写的是旧口径** ⇒ 改法必须是
//    **"读得出老值、只写新值"**：读走 `readAuthorHash`（新旧都认，
//    认不出一律 fail-closed），写永远走 `authorHashOf`（新口径）。
//
// ⚠️ **id 是全局唯一的**（谁先发布谁占住）：重名直接拒，并说清"这个名字被别人用了"。
//    理由：客户端桌面上那个图标按 id 认人，两个不同的人各发一个 `dice`
//    会让"装上哪一个"变成一件说不清的事。

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { AppsError } from './apps.js';
import { assertDeclarationAllowed } from './app-outbound.js';
// ★ **`A3·补`（D4.24 · 2026-10-03）：共享库审计里的 `by:<sub>` 换成凭据哈希**
//   （这是"越界风险 ＋ 同装共现那条决定的前提"要修的那一处，见 `90` §9.2·1）。
import { credHashOf } from './cred-hash.js';
import { assertOutboundAllowed, assertOutboundBytes } from './outbound.js';

/** 共享库放在数据目录下的哪个子目录。 */
export const PUBLISHED_DIR = 'published-apps';

/** 作者昵称的长度上限（它会在「发现」那一屏给所有人看）。 */
export const MAX_AUTHOR_CHARS = 24;

export class PublishedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishedError';
  }
}

/**
 * 作者假名的**当前口径**：`cred-hash.js` 那把**带键 HMAC**（域 `hupo-cred-v1`）。
 *
 * 🔴 与审计账（`apps.js#audit` · `published.js#installInto`）**同一个函数同一把键** ——
 *    "署名"与"审计里的身份"不许两处各推一个（两处一定会漂）。
 *
 * @param {string} sub 身份（`owner` / `u1` / …）
 * @param {Buffer|string|null} [key] 凭据键（生产 = `appsSignKey`；不给 ⇒ 退化键，见 `cred-hash.js`）
 */
export function authorHashOf(sub, key = null) {
  return credHashOf(sub, key);
}

/**
 * ⚠️ **旧口径（只读）**：`sha256(sub)` 的前 12 位。
 *
 * 存量共享库里在架的那些 `index.json` 写的**就是它**（真机上的
 * `published-apps/coin`：`4c1029697ee3` = `sha256("owner")[:12]`）——
 * 不许把它当"不存在"。🔴 **只许用来读**：写永远走 `authorHashOf`（新口径）。
 */
export function legacyAuthorHashOf(sub) {
  return nodeCrypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 12);
}

/**
 * **读**一个存量 `authorHash`（"读得出老值、只写新值"的唯一入口）。
 *
 * @param {unknown} stored `index.json` 里那一格
 * @param {string} sub 这是谁
 * @param {Buffer|string|null} [key] 凭据键
 * @returns {'cred'|'legacy'|null} `null` ⇒ **读不出来**。调用方一律 **fail-closed**
 *   （当成"不是他写的"），**绝不许**落到"那就是别人"；键不对时同一个人的新值
 *   也读不出来 —— 那正是"换键就换值"。
 */
export function readAuthorHash(stored, sub, key = null) {
  const s = typeof stored === 'string' ? stored : '';
  if (s === '') return null;
  if (s === authorHashOf(sub, key)) return 'cred';
  if (s === legacyAuthorHashOf(sub)) return 'legacy';
  return null;
}

export class Published {
  /**
   * @param {object} o
   * @param {string} o.dir       数据目录（共享库是 `data/published-apps/`）
   * @param {object} [o.fs]
   * @param {()=>number} [o.now]
   * @param {(e:object)=>void} [o.onAudit]
   * @param {Buffer|string|null} [o.credKey]
   *        ★ **`A3·补`：审计账里那把凭据哈希的键**（`serve.js` 给的是制品签名键）。
   *        不给 ⇒ `cred-hash.js` 的退化键。**审计里不再写明文 `sub`。**
   */
  constructor({ dir, fs = nodeFs, now = Date.now, onAudit = () => {}, credKey = null }) {
    if (!dir) throw new PublishedError('dir 必填');
    this.dir = dir;
    this.fs = fs;
    this.now = now;
    this.onAudit = onAudit;
    this.credKey = credKey;
  }

  get root() {
    return nodePath.join(this.dir, PUBLISHED_DIR);
  }

  appDir(id) {
    return nodePath.join(this.root, String(id));
  }

  #ensureRoot() {
    this.fs.mkdirSync(this.root, { recursive: true, mode: 0o755 });
  }

  #audit(entry) {
    try {
      this.#ensureRoot();
      this.fs.appendFileSync(
        nodePath.join(this.root, 'audit.jsonl'),
        `${JSON.stringify({ at: this.now(), ...entry })}\n`,
        { mode: 0o644 },
      );
    } catch {
      /* 审计写不进去不许挡住发布/装上 */
    }
    try {
      this.onAudit(entry);
    } catch {
      /* 同上 */
    }
  }

  /** 这一条在共享库里的索引（没有 / 坏了 ⇒ `null`）。 */
  index(id) {
    try {
      const j = JSON.parse(this.fs.readFileSync(nodePath.join(this.appDir(id), 'index.json'), 'utf8'));
      if (!j || String(j.id) !== String(id)) return null;
      return j;
    } catch {
      return null;
    }
  }

  /**
   * **发布**：把 `apps` 里那个 app 的当前版本复制进共享库。
   *
   * ⚠️ 四道必须的：
   *   ① 🔴 **出界那一条独木桥**（92 §③ 阶段 2）：带 `share:true` 的申报若是**没有锚**
   *      （或锚核不出来、血缘指不回它）⇒ **拒**，而且**在碰任何盘之前**就拒；
   *   ② 那个 app 得**真的在作者自己那儿**（不然发布一件不存在的东西）；
   *   ③ **id 重名** ⇒ 拒（除非是同一个作者在更新自己那条）；
   *   ④ 复制过去之后**逐字节核对 hash**（发布 = 承诺"别人拿到的是我看到的这一版"）。
   *
   * 🔴 **它是共享库（`published-apps/`）唯一的写入者** ⇒ 出界的裁决也只有这一处
   *    （`outbound.assertOutboundAllowed`；另开一条出去的路会被 `test/outbound-gate.test.js`
   *    的「第二出口」判据扫出来）。
   *
   * @param {object} o
   * @param {object} [o.workspaces] `AppWorkspaces`（读 `<scope>/.exp/` 与 `<scope>/.data/`
   *   那些申报要用它；不给就按默认布局 `<apps.dir>/workspaces/<id>/` 找 —— **默认也要读**，不许留旁路）
   * @returns {{id:string,version:number,title:string,icon:string,permissions:string[],publishedAt:number}}
   */
  publish(apps, { id, authorSub, authorName = '一位用户', workspaces = null }) {
    const mine = apps.list().find((a) => a.id === id);
    if (!mine) throw new PublishedError('你自己这儿还没有这个，先做出来再发');
    // 🔴 **出界的唯一裁决**（92 §③ 阶段 2）：无锚的 `share:true` ⇒ 拒。
    //    顺序刻意：它在**重名判、复制、写 index 之前** —— 拒的时候共享库一个字节都不动。
    const adj = assertOutboundAllowed({ route: 'publish', apps, workspaces, id, version: mine.version });
    const authorHash = authorHashOf(authorSub, this.credKey);
    const prev = this.index(id);
    // 🔴 **读得出老值**（`A3·补·二`）：存量那条 index.json 写的是旧口径
    //    ⇒ 认得出的照旧"拦住别人、放行本人"；**认不出**（含键换过）⇒ 当"别人的"
    //    （fail-closed：绝不把一个读不出来的值算成"那就是他"）。
    if (prev && readAuthorHash(prev.authorHash, authorSub, this.credKey) === null) {
      throw new PublishedError('这个名字已经被别人用了，换一个短名再发');
    }
    const name = String(authorName ?? '').trim().slice(0, MAX_AUTHOR_CHARS) || '一位用户';

    // 把那一版的每个文件读出来（`read` 会**逐字节核对 hash** ⇒ 复制的是真东西）
    const manifest = apps.manifest(id, mine.version);
    if (!manifest) throw new PublishedError('那一版的清单坏了，发不了');
    /**
     * 🔴 **声明那一半先在读字节之前跑一遍**（`164` · 2026-10-03）。
     *
     * ── 为什么非要有这一下 ────────────────────────────────────
     * 读侧那条路（`apps.read`）**今天也有同一道闸**了（`D4.24`：主人点头「加」）——
     * 而它是这一条出界断言**读字节时必经的路**。⇒ 一份声明了 `.data/…` 的清单
     * 会**在读第一个字节时**就被读侧拒掉，出界这条断言就再也不是"发布路径自带的
     * 第一现场"了（`check-outbound-bridge.sh` 判据 F1 钉的就是**这一条**）。
     * ⇒ 把**声明 ↔ 声明**那一半提到读字节之前：同一个 `assertOutboundBytes`
     *   （**不是第二处规则**），下面那次带字节的再核一遍"声明 ↔ 字节"。
     *
     * ⚠️ 位置刻意：它在 `assertOutboundAllowed`（两格申报那条闸）**之后** ——
     *    无锚的 `share:true` 仍然第一个拒（既有报错顺序与话一个字不变）。
     */
    assertOutboundBytes({ route: 'publish', id, manifest });
    const files = {};
    for (const f of manifest.files ?? []) {
      files[f.path] = apps.read(id, mine.version, f.path).content;
    }

    // 🔴 **92 §③ 阶段 6：出界那一刻的常驻断言** —— 这里是**发布路径自带**的那一条，
    //    不再是闸脚本里的技巧：**准备出界的字节，必须与那一版清单逐条对得上**
    //    （多了／少了／换过字节／一条 `.` 开头的段 ⇒ 拒）。它**压的是声明 ↔ 字节**，
    //    不是内容正则（理由见 `outbound.js` 里那段）。
    //    ⚠️ 顺序刻意：它在**任何一次写盘之前**；拒的时候共享库一个字节都不动。
    const seal = assertOutboundBytes({ route: 'publish', id, manifest, files });

    // 🔴 **外联申报（A16）** —— 93 §2.4：**读不到申报 ⇒ 拒上架**（fail-closed，
    //    **不是**"当没有外联"）。申报是制品里的一个普通文件 ⇒ **随 `rootHash` 冻结**
    //    （主人第 5 条）；它同时也被**逐个出网点对照代码**（93 §三 R1／R2）。
    //    ⚠️ 顺序刻意：它在 `assertOutboundAllowed`（两格申报那条）**之后**、
    //       在**任何一次写盘之前** —— 拒的时候共享库一个字节都不动。
    assertDeclarationAllowed({ files, version: mine.version });

    const vdir = nodePath.join(this.appDir(id), 'versions', String(mine.version));
    this.fs.mkdirSync(vdir, { recursive: true, mode: 0o755 });
    for (const [rel, buf] of Object.entries(files)) {
      const target = nodePath.join(vdir, rel);
      this.fs.mkdirSync(nodePath.dirname(target), { recursive: true, mode: 0o755 });
      const tmp = `${target}.tmp-${process.pid}-${this.now()}`;
      this.fs.writeFileSync(tmp, buf, { mode: 0o444 });
      this.fs.renameSync(tmp, target);
      // ③ 逐字节核对（发出去的每一份都要对得上）
      const back = this.fs.readFileSync(target);
      if (nodeCrypto.createHash('sha256').update(back).digest('hex')
          !== nodeCrypto.createHash('sha256').update(buf).digest('hex')) {
        throw new PublishedError('复制过去之后对不上，这次没发成');
      }
    }

    const index = {
      schema: 1,
      id,
      title: mine.title,
      icon: mine.icon,
      entry: mine.entry,
      version: mine.version,
      rootHash: mine.rootHash,
      permissions: [...(mine.permissions ?? [])],
      authorHash,
      authorName: name,
      publishedAt: this.now(),
      published: true,
    };
    const idx = nodePath.join(this.appDir(id), 'index.json');
    const tmp = `${idx}.tmp-${process.pid}-${this.now()}`;
    this.fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o644 });
    this.fs.renameSync(tmp, idx);

    this.#audit({
      what: 'publish',
      id,
      version: mine.version,
      authorHash,
      rootHash: mine.rootHash,
      // 🔴 **常驻断言的留痕**（92 §③ 阶段 6）：这一版出去的时候，字节与清单**逐条核过**
      //    —— `files` 是核过的条数、`bytes` 是字节数、`digest` 是登记的起点、
      //    `share` 是带锚的可分享条目数（没有锚的在上一步就拒了）。
      //    ⚠️ 它是**成功才写**的：拒的时候 `#audit` 一次都不调（共享库一个字节都不动）。
      outbound: {
        sealed: true,
        files: seal.count,
        bytes: seal.bytes,
        share: adj.share.length,
        digest: seal.digest,
      },
    });
    return index;
  }

  /**
   * **下架**：从「发现」里撤掉。
   * ⚠️ **已经装过的人那份不动**（复制模型的好处就在这里）——
   *    所以"下架"只影响**还没装的人**。
   */
  unpublish(id, authorSub) {
    const prev = this.index(id);
    if (!prev) throw new PublishedError('这一条不在共享库里');
    // 🔴 **读得出老值**：存量那条写的是旧口径（裸 sha256 前 12 位）⇒ 本人照旧撤得下来。
    //    读不出来 ⇒ fail-closed（"这一条不是你发的"），**不是**"那就是别人"。
    if (readAuthorHash(prev.authorHash, authorSub, this.credKey) === null) {
      throw new PublishedError('这一条不是你发的');
    }
    const next = { ...prev, published: false, unpublishedAt: this.now() };
    const idx = nodePath.join(this.appDir(id), 'index.json');
    const tmp = `${idx}.tmp-${process.pid}-${this.now()}`;
    this.fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
    this.fs.renameSync(tmp, idx);
    this.#audit({ what: 'unpublish', id, authorHash: authorHashOf(authorSub, this.credKey) });
    return next;
  }

  /**
   * **发现**：所有人看得到的那一份清单（只列上架的）。坏索引跳过那一条。
   *
   * ★ **`A3·补·二`**：多收一个可选的"这是谁"（`sub` ＋ `key`）——
   *   给了就**顺带判出 `mine`**（哪几条是他自己发的）。判据必须走
   *   `readAuthorHash`（新旧口径都认）**而不是**拿两个哈希直接比：
   *   存量那条写的是旧口径 ⇒ 直接比会把他自己发的那条**误判成"别人发的"**
   *   （`mcp-apps-server.mjs` 的 `app_discover` 就是照 `mine` 分的）。
   *
   * @param {{sub?:string|null, key?:Buffer|string|null}} [o]
   */
  discover({ sub = null, key = null } = {}) {
    let ids = [];
    try {
      ids = this.fs.readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'versions')
        .map((e) => e.name);
    } catch {
      return [];
    }
    const wantMine = sub !== null && sub !== undefined && sub !== '';
    const out = [];
    for (const id of ids.sort()) {
      const j = this.index(id);
      if (!j || j.published !== true) continue;
      const row = {
        id: j.id,
        title: j.title,
        icon: j.icon,
        version: j.version,
        author: j.authorName,
        // ⚠️ 它是**假名**（新口径 = 带键 HMAC；存量可能是旧口径），不是身份：
        //    只用来分辨"这条是不是我自己发的"
        authorHash: j.authorHash,
        permissions: [...(j.permissions ?? [])],
        publishedAt: j.publishedAt,
      };
      // 只有给了"这是谁"才多这一格（不给 ⇒ 形状与以前一字不差）
      if (wantMine) row.mine = readAuthorHash(j.authorHash, sub, key) !== null;
      out.push(row);
    }
    return out;
  }

  /** 共享库里那一版有什么文件（**装上**要读它）。 */
  filesOf(id, version) {
    const j = this.index(id);
    if (!j) throw new PublishedError('共享库里没有这一条');
    const vdir = nodePath.join(this.appDir(id), 'versions', String(version));
    const files = {};
    const walk = (rel) => {
      for (const e of this.fs.readdirSync(nodePath.join(vdir, rel), { withFileTypes: true })) {
        const next = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(next);
        } else {
          files[next] = this.fs.readFileSync(nodePath.join(vdir, next));
        }
      }
    };
    walk('');
    if (Object.keys(files).length === 0) throw new PublishedError('那一版里一个文件都没有');
    return { index: j, files };
  }

  /**
   * **装上**：把共享库里那一版**复制进他自己的制品库**。
   *
   * ⚠️ 复制（不是"指过去"）是刻意的：作者下架/删掉之后，**他这份还在**。
   * ⚠️ 已经是他的同名 app ⇒ 那就是一次**更新**（`apps.create` 会开新版本）。
   */
  installInto(apps, id) {
    const { index, files } = this.filesOf(id, this.index(id)?.version);
    if (index.published !== true) throw new PublishedError('这一条已经下架了，装不了');
    const m = apps.create({
      id: index.id,
      title: index.title,
      icon: index.icon,
      entry: index.entry,
      files,
      permissions: index.permissions ?? [],
      createdBy: 'user',
      // 🔴 **登记在册的那个起点，必须与重算出来的逐字一致**（91 §11.3 那条洞：
      //    改前这里**从不比对** `index.rootHash` ⇒ 共享库被改会**静默换一个 rootHash**
      //    收下）。比对不上 ⇒ 拒装 ＋ 人话；而比对发生在 `apps.create` **动盘之前**，
      //    所以盘上零残留。
      //    ⚠️ 保留 id 那条判据的报错顺序**不变**：它在 `apps.create` 里排在更前面。
      expectRootHash: index.rootHash,
    });
    // ★ **`A3·补`：装的人也不写明文** —— 原来这里是 `by: apps.sub ?? null`。
    this.#audit({ what: 'install', id, version: m.version, by: credHashOf(apps.sub, this.credKey) });
    return { id: m.id, version: m.version, title: m.title };
  }
}
