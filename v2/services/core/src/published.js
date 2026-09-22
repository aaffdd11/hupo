// **共享的小程序库**（乙-3 · 契约 `docs/dev/59-USER-APPS.md` §四）。
//
// ── 两条形状决定（先说清，后面全靠它们）────────────────────
//   ① **发布 = 把作者当前那一版复制一份进共享库**（作者自己那份不动）。
//      ⇒ 作者删了自己的、或者下架了，**已经装过的人那份还在**。
//   ② **装上 = 把共享库里那一版复制进他自己的制品库**（乙-1 那个 `Apps`）。
//      ⇒ 制品口那条路**一行都不用改**（它只从"你自己那一格"里读），
//        而且"别人下架"不会让装过的人忽然打不开。
//
// ⚠️ **共享库里不存作者的身份**，只存 `authorHash = sha256(sub)` 的前 12 位：
//    下架时比对哈希就够，**原始身份不进这个所有人共享的目录**。
//
// ⚠️ **id 是全局唯一的**（谁先发布谁占住）：重名直接拒，并说清"这个名字被别人用了"。
//    理由：客户端桌面上那个图标按 id 认人，两个不同的人各发一个 `dice`
//    会让"装上哪一个"变成一件说不清的事。

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { AppsError } from './apps.js';

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

/** 作者身份的哈希（只进共享库的那一半）。 */
export function authorHashOf(sub) {
  return nodeCrypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 12);
}

export class Published {
  /**
   * @param {object} o
   * @param {string} o.dir       数据目录（共享库是 `data/published-apps/`）
   * @param {object} [o.fs]
   * @param {()=>number} [o.now]
   * @param {(e:object)=>void} [o.onAudit]
   */
  constructor({ dir, fs = nodeFs, now = Date.now, onAudit = () => {} }) {
    if (!dir) throw new PublishedError('dir 必填');
    this.dir = dir;
    this.fs = fs;
    this.now = now;
    this.onAudit = onAudit;
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
   * ⚠️ 三道必须的：
   *   ① 那个 app 得**真的在作者自己那儿**（不然发布一件不存在的东西）；
   *   ② **id 重名** ⇒ 拒（除非是同一个作者在更新自己那条）；
   *   ③ 复制过去之后**逐字节核对 hash**（发布 = 承诺"别人拿到的是我看到的这一版"）。
   *
   * @returns {{id:string,version:number,title:string,icon:string,permissions:string[],publishedAt:number}}
   */
  publish(apps, { id, authorSub, authorName = '一位用户' }) {
    const mine = apps.list().find((a) => a.id === id);
    if (!mine) throw new PublishedError('你自己这儿还没有这个，先做出来再发');
    const authorHash = authorHashOf(authorSub);
    const prev = this.index(id);
    if (prev && prev.authorHash !== authorHash) {
      throw new PublishedError('这个名字已经被别人用了，换一个短名再发');
    }
    const name = String(authorName ?? '').trim().slice(0, MAX_AUTHOR_CHARS) || '一位用户';

    // 把那一版的每个文件读出来（`read` 会**逐字节核对 hash** ⇒ 复制的是真东西）
    const manifest = apps.manifest(id, mine.version);
    if (!manifest) throw new PublishedError('那一版的清单坏了，发不了');
    const files = {};
    for (const f of manifest.files ?? []) {
      files[f.path] = apps.read(id, mine.version, f.path).content;
    }

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

    this.#audit({ what: 'publish', id, version: mine.version, authorHash, rootHash: mine.rootHash });
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
    if (prev.authorHash !== authorHashOf(authorSub)) throw new PublishedError('这一条不是你发的');
    const next = { ...prev, published: false, unpublishedAt: this.now() };
    const idx = nodePath.join(this.appDir(id), 'index.json');
    const tmp = `${idx}.tmp-${process.pid}-${this.now()}`;
    this.fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
    this.fs.renameSync(tmp, idx);
    this.#audit({ what: 'unpublish', id, authorHash: authorHashOf(authorSub) });
    return next;
  }

  /** **发现**：所有人看得到的那一份清单（只列上架的）。坏索引跳过那一条。 */
  discover() {
    let ids = [];
    try {
      ids = this.fs.readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'versions')
        .map((e) => e.name);
    } catch {
      return [];
    }
    const out = [];
    for (const id of ids.sort()) {
      const j = this.index(id);
      if (!j || j.published !== true) continue;
      out.push({
        id: j.id,
        title: j.title,
        icon: j.icon,
        version: j.version,
        author: j.authorName,
        // ⚠️ 它是**哈希**（12 位），不是身份：只用来分辨"这条是不是我自己发的"
        authorHash: j.authorHash,
        permissions: [...(j.permissions ?? [])],
        publishedAt: j.publishedAt,
      });
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
    });
    this.#audit({ what: 'install', id, version: m.version, by: apps.sub ?? null });
    return { id: m.id, version: m.version, title: m.title };
  }
}
