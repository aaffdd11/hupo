// **小程序制品库**（契约 `docs/dev/59-USER-APPS.md`；主人 2026-09-22 拍板做"乙"）。
//
// ── 它是什么 ──────────────────────────────────────────────
// 每个人的世界里有 `hupo/apps/<id>/`：一份指针 + 若干**不可变**版本 + 一份只追加的审计。
// **按人一份**（`worlds.pathsFor(sub).dir`）—— 这就是"只有他自己可见"的落点。
//
// ── 四条硬规矩（这一篇守的就是它们）────────────────────────
//   ① 🔴 **版本不可变**：`versions/<n>/` 写下去就不再改；同版本重发 ⇒ **拒**。
//   ② 🔴 **校验不过 ⇒ 盘上一个字节都不动**（先在内存里全过一遍，不是"写一半再回滚"）。
//   ③ 🔴 **读回来的每一个字节都要对得上 hash**（对不上 ⇒ 抛，不是"尽力画"）。
//   ④ 🔴 **路径不许越界**：`id` 与制品内的相对路径都走白名单；`..` / 绝对路径 / 反斜杠一律拒。
//
// ⚠️ **数字只住这个文件**（手册纪律 1：写进文档的那一刻它就开始过期）。
//
// ⚠️ **它不做**：不发布到共享库（那是乙-3）· 不签名（签名在 `app-serve.js`）·
//    不认识令牌（调用方已经知道这是谁）。

import { pickIcon, resolveIcon } from './app-icons.js';
import { reclaimScope } from './reclaim.js';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 制品放在每个人世界的哪个相对目录下（`hupo/apps/`）。 */
export const APPS_REL = nodePath.join('hupo', 'apps');

/**
 * **回收处那一格叫什么**（`<root>/.removed/`）—— **只有这一处**。
 *
 * ⚠️ 单独导出是给 `worlds.js` 用的：它建那条日志时要按留痕抬一个"号的地板"
 *    （见 `reclaim.js` 顶上"尾巴被抽走"那段）—— 那个目录名不许在别处再抄一遍。
 */
export const REMOVED_DIRNAME = '.removed';

/** 清单的形状版本。**加字段要能分辨**，所以它进 manifest 一起存。 */
export const SCHEMA = 1;

// ── 限额（**只有这一处**）────────────────────────────────────
/** `id` 的字符上限（也是文件名的上限）。 */
export const MAX_ID_CHARS = 32;
/** 标题的字符上限（它是**给人看的名字**，D3.8 不许只有图形）。 */
export const MAX_TITLE_CHARS = 40;
/** 一个版本最多几个文件。 */
export const MAX_FILES = 40;
/** 单个文件上限。 */
export const MAX_FILE_BYTES = 256 * 1024;
/** 一个版本的总大小上限。 */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/** 一个 app 保留多少个版本（超了拒新的，**不许悄悄删旧版本**）。 */
export const MAX_VERSIONS = 20;
/** 制品内相对路径的长度上限。 */
export const MAX_REL_CHARS = 120;
/**
 * **复制时最多试几个新名字**（`104` §三）：新 id 撞了往后加数字（`-copy` / `-copy2`…），
 * 新标题重名也一样往后加。试到这个数还撞 ⇒ **如实拒**（不是无限试 —— 那会变成
 * 一个永远转圈、永远不出结果的请求）。
 */
export const MAX_COPY_TRIES = 50;

/**
 * **图标名白名单**。
 *
 * ⚠️ 客户端把它映射成**常量** `IconData` —— `flutter build web --release` 会 tree-shake 图标字体，
 *    运行时算出来的图标**线上画不出来**（`52-DESKTOP.md` §6.3 记着这个坑）。
 * ⇒ 这里只放**客户端真的有映射**的名字。
 */
// ⚠️ **图标库只有一处出处**（`src/app-icons.js`）—— 这里不再抄一份
//    （原来这里一份、`mcp-apps-server.mjs` 又抄了一份，而客户端只跟其中一份对表）。
export { ICONS } from './app-icons.js';

/**
 * **权限白名单**（乙-4 开门：`ask`）。
 *
 * `ask` = 允许它请求「用**看的人**的钥匙问一句话」。
 * ⚠️ **声明 ≠ 能用**：制品必须在清单里声明，**而且看的人明确授予**，两样都齐了才算（见 `grants`）。
 * ⚠️ **钥匙永远不进制品**：制品只拿得到"问一句"这个动作，拿不到钥匙本身，也拿不到别人的钥匙。
 */
export const PERMISSIONS = Object.freeze(['ask']);

/**
 * **一次问话的配额**（数字只住这里）。
 *
 * ⚠️ 为什么必须有它：`ask` 花的是**看的人自己的钱** ——
 *    一个别人写的页面可以一直问，那是**他的钱袋在漏**。
 * ⇒ 两道：每天每 app 一个总次数 + 两次之间一个最小间隔。
 */
export const ASK_PER_DAY = 40;
export const ASK_MIN_INTERVAL_MS = 3000;

/** 内容类型（按扩展名）。**认不出来一律 `application/octet-stream`**（宁可下载也不猜）。 */
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
});

/**
 * 制品库出的错。**人话**，而且够具体。
 *
 * ⚠️ `status`（可选）是给调用方分岔用的：**没给就是 `null`** ⇒ 调用方按老规矩当 404
 *    （"没这个东西"，`/api/app-remove` 那条就是这么读的，**一个字没改**）。
 *    给了就是**这一条路该回的那个码** —— `104` 的两条口要分清
 *    "名字不合法（400）" / "试不出来（409）" / "不在他这儿（404）"。
 *    形状照 `src/say.js` 的 `SayError(message, status)`（那里也是 400 起）。
 */
export class AppsError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'AppsError';
    this.status = status;
  }
}

/** `/^[a-z0-9][a-z0-9-]{0,31}$/` —— 小写字母数字与短横，首字符不能是短横。 */
export function checkAppId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > MAX_ID_CHARS) {
    throw new AppsError(`小程序 id 不合法（只许小写字母、数字、短横，最多 ${MAX_ID_CHARS} 个字符）：${String(id).slice(0, 60)}`);
  }
  return id;
}

/**
 * **app 不许占用的 id**（🔴 **唯一出处**）：主线那个房间 ＋ 桌面内置那四格。
 *
 * 🔴 为什么名单住这里（不另抄一份在 `worlds.js`）：**闸要落在写入路的汇合点**——
 *    制品库那个 `apps.create()`。所有写路（新路 `snapshotWorkspace`、老路
 *    `apps-socket.js` 的那一支、装上 `published.installInto`）最后都汇到这里。
 *    `apps.js` 是叶子模块，`worlds.js` 反过来可以引用它，**不会成环**。
 *
 * ⚠️ 与客户端 `v2/apps/mobile/lib/models/app_spec.dart` 的四个内置 id **逐字一致**
 *    （对不上 ⇒ 客户端拿一个服务端不认的 scope 去连 ⇒ 404）。
 */
export const REFUSED_APP_IDS = Object.freeze(['main', 'settings', 'math', 'discover', 'harness']);

/**
 * 保留 id ⇒ **人话拒**（N11）；不是保留 id ⇒ 原样返回。
 *
 * ⚠️ `main` 与内置那四个是同一道闸的两半：前者"谁都不许占"，后者"它已经是别人的房间"。
 * ⚠️ 它**只拦"当 app"**，不拦"当房间"：`main` 由 `workspace.checkScope` 另有一条，
 *    内置那四个走 `worlds.roomFor`（那里对内置是**放行**的）。
 */
export function refuseReservedAppId(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!REFUSED_APP_IDS.includes(s)) return s;
  if (s === 'main') throw new AppsError(`"${s}" 是主线那个房间，不能再拿它当小程序的名字`);
  throw new AppsError(`"${s}" 是桌面上本来就有的那一格，不能再拿它当小程序的名字`);
}

/**
 * **制品里不许出现 `.` 开头的路径**（91 契约 §2.1／§11.3·4）。
 *
 * 🔴 为什么非有不可：`workspace.read()` 只跳过 `.` 开头（`workspace.js:395`），
 *    那是**读取侧**唯一那道"不进制品"的机制；而 `checkRelPath` 是**允许**
 *    `.data/`／`.exp/` 这类路径的 ⇒ 只要调用方把一份带 `.data/` 的 `files` 直接交给
 *    `apps.create`（老路、装上、迁移都行），数据／经验就会**进制品、进共享库**。
 *    ⇒ 把闸补在**写入侧**：这里。
 *
 * ⚠️ 判的是**每一段**，不只看首字符：`assets/.hidden/x.js` 同样读不进工作区快照，
 *    所以同样不许进制品（与 `workspace.read()` 的递归跳过逐字对齐）。
 */
export function refuseHiddenRelPath(rel) {
  const seg = String(rel).split('/').find((p) => p.startsWith('.'));
  if (seg === undefined) return rel;
  const where = seg === '.data' || seg === '.exp'
    ? '（这类是你的数据或经验，不进制品、也不跟着装走）'
    : '（`.` 开头的名字不进制品）';
  throw new AppsError(`制品里不许有以 "." 开头的文件${where}：${rel}`);
}

/**
 * **制品内的相对路径**：白名单 + 拒越界。
 *
 * 🔴 这是整个模块最要紧的一道校验：一个能写 `../../../../etc/passwd` 的制品库
 *    等于把整台机器交出去（而制品的内容**来自模型**）。
 */
export function checkRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new AppsError('制品里有一个空路径');
  }
  if (rel.length > MAX_REL_CHARS) {
    throw new AppsError(`制品里的路径太长（上限 ${MAX_REL_CHARS}）：${rel.slice(0, 60)}`);
  }
  if (rel.startsWith('/') || rel.includes('\\')) {
    throw new AppsError(`制品里的路径不许是绝对路径、也不许有反斜杠：${rel}`);
  }
  if (/\0|[\u0000-\u001f]/.test(rel)) {
    throw new AppsError('制品里的路径含控制字符');
  }
  if (!/^[A-Za-z0-9._\-/]+$/.test(rel)) {
    throw new AppsError(`制品里的路径只许字母数字与 . _ - /：${rel}`);
  }
  const parts = rel.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') {
      throw new AppsError(`制品里的路径不许有空的、"." 或 ".." 的那一段：${rel}`);
    }
  }
  return rel;
}

/** 内容类型；认不出来 ⇒ 二进制流（**不猜**）。 */
export function contentTypeOf(rel) {
  return CONTENT_TYPES[nodePath.extname(rel).toLowerCase()] ?? 'application/octet-stream';
}

/** 一个字符串/字节的 sha256（十六进制）。 */
export function sha256hex(data) {
  return nodeCrypto.createHash('sha256').update(data).digest('hex');
}

/**
 * **整份制品的 hash**：把文件按路径排序，拼 `path\nhash\n` 再算一次。
 *
 * ⚠️ **必须排序**：否则同一个版本换个写入顺序就得到不同的 rootHash，
 *    而那会把"hash 一样 ⇒ 内容一样"这句话变成假话。
 */
export function rootHashOf(files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = sorted.map((f) => `${f.path}\n${f.sha256}\n`).join('');
  return sha256hex(text);
}

/** 原子写：先写临时文件，再 rename（同 `store` / `ledger` 的既有做法）。 */
function writeAtomic(fs, file, data, mode = 0o444) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export class Apps {
  /**
   * @param {object} o
   * @param {string} o.dir        这个人世界的根（`worlds.pathsFor(sub).dir`）
   * @param {string} [o.sub]      谁的（只进审计那一行；`null` = 不知道）
   * @param {object} [o.fs]       注入文件系统（测试用）
   * @param {()=>number} [o.now]  注入时钟
   * @param {(e:object)=>void} [o.onAudit]  额外审计落点（全局 `audit.log`）；**它出错不许挡住主流程**
   * @param {object|(()=>object)} [o.reclaim]
   *        ★ **`103` §七：真回收的上下文**（一个人一份）。给了 ⇒ `remove()` 除了软删
   *        制品那一格，还会把**那一间的工作区 / 对话 / 助手那边的会话记录**一起搬进
   *        同一个回收处，并写 `reclaimed.json`（`src/reclaim.js` · **一处实现**）。
   *        `null`（缺省）⇒ 只有软删 ＋ 审计，**逐字是第一轮的行为**（老测试与
   *        单测里那两个"只有 `{dir, sub}`"的用法不受影响）。
   *        ⚠️ 传**函数**（惰性取）是有意的：`worlds.js` 里那几本账（`unread`/`work`）
   *        在 `new Apps()` 之后才建 —— 但 `remove()` 一定发生在它们建好之后。
   */
  constructor({ dir, sub = null, fs = nodeFs, now = Date.now, onAudit = () => {}, reclaim = null }) {
    if (!dir) throw new AppsError('dir 必填');
    this.dir = dir;
    this.sub = sub;
    this.fs = fs;
    this.now = now;
    this.onAudit = onAudit;
    this.reclaim = reclaim;
  }

  /** 这个人的制品库根目录（不在时装不建 —— 只在真的要写的时候建）。 */
  get root() {
    return nodePath.join(this.dir, APPS_REL);
  }

  appDir(id) {
    return nodePath.join(this.root, checkAppId(id));
  }

  versionsDir(id) {
    return nodePath.join(this.appDir(id), 'versions');
  }

  versionDir(id, version) {
    return nodePath.join(this.versionsDir(id), String(version));
  }

  #ensureRoot() {
    this.fs.mkdirSync(this.root, { recursive: true, mode: 0o755 });
  }

  /** 只追加的审计（**它坏了不许挡住主流程**）。 */
  #audit(entry) {
    const line = JSON.stringify({ at: this.now(), sub: this.sub, ...entry });
    try {
      this.#ensureRoot();
      this.fs.appendFileSync(nodePath.join(this.root, 'audit.jsonl'), `${line}\n`, { mode: 0o644 });
    } catch {
      // 审计写不进去也**不许**把用户的操作弄失败（但调用方的全局审计还有一次机会）
    }
    try {
      this.onAudit(entry);
    } catch {
      // 同上
    }
  }

  /** 现在指向哪个版本（`null` = 这个 app 还不存在）。 */
  current(id) {
    checkAppId(id);
    try {
      const raw = this.fs.readFileSync(nodePath.join(this.appDir(id), 'current.json'), 'utf8');
      const j = JSON.parse(raw);
      const v = Number.parseInt(j?.version, 10);
      return Number.isInteger(v) && v >= 1 ? v : null;
    } catch {
      return null;
    }
  }

  /** 一个版本目录里有什么（**盘上的**事实；坏 manifest 返回 `null`）。 */
  manifest(id, version) {
    checkAppId(id);
    const n = Number.parseInt(version, 10);
    if (!Number.isInteger(n) || n < 1) throw new AppsError(`版本号不合法：${String(version).slice(0, 20)}`);
    try {
      const j = JSON.parse(this.fs.readFileSync(nodePath.join(this.versionDir(id, n), 'manifest.json'), 'utf8'));
      if (!j || j.id !== id || Number.parseInt(j.version, 10) !== n) return null;
      return j;
    } catch {
      return null;
    }
  }

  /** **我的清单**：每个 app 的当前版本（坏的就跳过那一个，不许整个清单炸）。 */
  list() {
    let ids = [];
    try {
      ids = this.fs.readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
    const out = [];
    for (const id of ids.sort()) {
      const v = this.current(id);
      if (!v) continue;
      const m = this.manifest(id, v);
      if (!m) continue;
      out.push({
        id,
        title: m.title,
        icon: m.icon,
        version: v,
        entry: m.entry,
        rootHash: m.rootHash,
        bytes: m.bytes,
        permissions: [...(m.permissions ?? [])],
        minShellVersion: m.minShellVersion,
        createdAt: m.createdAt,
      });
    }
    return out;
  }

  /**
   * **建一个新版本**（管线的全部）。
   *
   * 顺序是刻意的：**先在内存里把一切校验完、算完 hash，再动盘**（规矩②）。
   * 写盘顺序：`versions/<n>/` 先写全部文件 → 再写 `manifest.json`（它是"这一版好了"的凭据）
   * → 最后才移指针。⇒ 中途断电最坏是"多一个没人指向的版本"，**不是"指针指向一个残缺版本"**。
   *
   * @param {object} o
   * @param {string} o.id
   * @param {string} o.title
   * @param {string} o.icon
   * @param {string} o.entry          必须是 `files` 里的一个
   * @param {Record<string,string|Buffer>} o.files  path → 内容
   * @param {string} [o.createdBy]    `user` | `agent`
   * @param {number} [o.createdTurn]  哪一轮造的（**可倒查**）
   * @param {string} [o.expectRootHash] 🔴 **这一版"应该"是这个起点吗**（可选）。
   *   给了就**逐字比对**算出来的 `rootHash`，对不上 ⇒ 拒（**在动盘之前**）。
   *   ⚠️ 它是"装上"那条路要的：共享库里那份 `index.rootHash` 是**登记在册的承诺**，
   *      比对不上说明**那份东西被人动过** —— 不许静默换一个起点收下。
   *   ⚠️ 顺序刻意：它在**所有既有闸之后**（保留 id、权限、路径、隐藏路径……），
   *      所以既有判据的**报错顺序与话都不变**（`test/app-write-gates.test.js` 那条保留 id 判据）。
   * @returns {object} 写下去的 manifest
   */
  create({ id, title, icon, entry, files, permissions = [], createdBy = 'user', createdTurn = null, expectRootHash = null }) {
    checkAppId(id);
    // 🔴 **保留 id 的唯一一道闸**（`REFUSED_APP_IDS`）：主线 ＋ 桌面内置四格。
    //    写在这里 ⇒ **每一条写路都过它**（含 `apps-socket.js` 那条老路、装上、迁移）。
    refuseReservedAppId(id);
    // 🔴 权限**只许白名单里的**；乙-1 白名单是空的 ⇒ 现在任何非空权限都拒。
    //    这样"制品拿不到任何能力"在乙-1 是**结构上成立**的，而不是"我们记得没给它"。
    if (!Array.isArray(permissions)) throw new AppsError('permissions 必须是数组');
    for (const p of permissions) {
      if (!PERMISSIONS.includes(p)) {
        throw new AppsError(`这个权限现在还不给（${String(p).slice(0, 30)}）—— 制品暂时什么能力都没有`);
      }
    }
    if (typeof title !== 'string' || title.trim().length === 0) throw new AppsError('小程序要有一个名字');
    if (title.length > MAX_TITLE_CHARS) throw new AppsError(`名字太长（上限 ${MAX_TITLE_CHARS} 个字）`);
    // ★ **图标：给了白的就用，别的（没给 / 不认识）一律自动配一个**
    //   （主人 2026-09-23：*"给每个小程序创造一个默认 icon"*）。
    //   ⚠️ 这里**不再抛错** —— 桌面上出现一个空白图标，比换一个相近的图标坏得多。
    const picked = resolveIcon({ icon, title, id });
    icon = picked.icon;
    if (typeof entry !== 'string' || entry.length === 0) throw new AppsError('入口文件必填');
    checkRelPath(entry);
    if (!files || typeof files !== 'object') throw new AppsError('files 必填');

    const paths = Object.keys(files);
    if (paths.length === 0) throw new AppsError('制品里一个文件都没有');
    if (paths.length > MAX_FILES) throw new AppsError(`文件太多（上限 ${MAX_FILES} 个）`);

    const checked = [];
    let total = 0;
    for (const rel of paths) {
      checkRelPath(rel);
      // 🔴 `.data/`／`.exp/`／任何 `.` 开头的路径 ⇒ **写入侧也拒**（不再只靠读取侧跳过）
      refuseHiddenRelPath(rel);
      const raw = files[rel];
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
      if (buf.length === 0) throw new AppsError(`制品里有空文件：${rel}`);
      if (buf.length > MAX_FILE_BYTES) throw new AppsError(`单个文件太大：${rel}`);
      total += buf.length;
      checked.push({ path: rel, buf, sha256: sha256hex(buf) });
    }
    if (total > MAX_TOTAL_BYTES) throw new AppsError('整个制品太大');
    if (!checked.some((f) => f.path === entry)) throw new AppsError(`入口文件不在制品里：${entry}`);

    if (createdBy !== 'user' && createdBy !== 'agent') throw new AppsError(`createdBy 不合法：${String(createdBy).slice(0, 20)}`);

    const prev = this.current(id);
    const version = prev === null ? 1 : prev + 1;
    if (version > MAX_VERSIONS) {
      throw new AppsError(`这个小程序的版本太多了（上限 ${MAX_VERSIONS} 个）—— 要腾地方得你自己说一句`);
    }
    // 🔴 **同版本重发 ⇒ 拒**（版本不可变的第一道）
    if (this.manifest(id, version) !== null) throw new AppsError('这一版已经存在了（版本不可变）');

    const manifest = {
      schema: SCHEMA,
      id,
      version,
      title,
      icon,
      entry,
      files: checked.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.buf.length })),
      rootHash: rootHashOf(checked.map((f) => ({ path: f.path, sha256: f.sha256 }))),
      permissions: [...permissions],
      minShellVersion: 1,
      createdBy,
      createdTurn,
      createdAt: this.now(),
      bytes: total,
    };

    // 🔴 **"应该就是这个起点吗"**（装上那条路的承诺比对；见 `expectRootHash` 的说明）。
    //    ⚠️ 放在**这里**（内存里全算完、盘还没动）—— 对不上就拒，且盘上零残留。
    if (expectRootHash !== null && expectRootHash !== undefined) {
      if (typeof expectRootHash !== 'string' || manifest.rootHash !== expectRootHash) {
        throw new AppsError(
          '这一版的内容跟它登记的起点（rootHash）对不上 —— 说明那份东西被人动过，装不了',
        );
      }
    }

    // ── 到这里为止，盘上一个字节都没动（规矩②）────────────────
    this.fs.mkdirSync(this.versionsDir(id), { recursive: true, mode: 0o755 });
    const vdir = this.versionDir(id, version);
    if (this.fs.existsSync(vdir)) throw new AppsError('这一版的目录已经存在了（版本不可变）');
    this.fs.mkdirSync(vdir, { recursive: false, mode: 0o755 });
    for (const f of checked) {
      const target = nodePath.join(vdir, f.path);
      this.fs.mkdirSync(nodePath.dirname(target), { recursive: true, mode: 0o755 });
      writeAtomic(this.fs, target, f.buf);
    }
    writeAtomic(this.fs, nodePath.join(vdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // 最后才移指针（顺序刻意：中途断电最坏是"多一个没人指向的版本"）
    writeAtomic(this.fs, nodePath.join(this.appDir(id), 'current.json'), `${JSON.stringify({ version })}\n`, 0o644);

    this.#audit({ what: 'create', id, version, rootHash: manifest.rootHash, by: createdBy, turn: createdTurn });
    return manifest;
  }

  /**
   * **读一个文件**：先验这一版的 hash（规矩③），再验路径（规矩④）。
   *
   * @returns {{ content: Buffer, contentType: string }}
   */
  read(id, version, rel) {
    checkAppId(id);
    checkRelPath(rel);
    const m = this.manifest(id, version);
    if (!m) throw new AppsError('这一版不在（或者它的清单坏了）');
    const rec = (m.files ?? []).find((f) => f.path === rel);
    if (!rec) throw new AppsError('制品里没有这个文件');
    let buf;
    try {
      buf = this.fs.readFileSync(nodePath.join(this.versionDir(id, m.version), rel));
    } catch {
      throw new AppsError('这个文件读不出来');
    }
    // 🔴 每个字节都要对得上 hash —— 对不上就抛（**不是"尽力画"**）
    if (sha256hex(buf) !== rec.sha256) {
      this.#audit({ what: 'hash-mismatch', id, version: m.version, path: rel });
      throw new AppsError('这个文件的内容对不上它的 hash（被人动过了）');
    }
    return { content: buf, contentType: contentTypeOf(rel) };
  }

  /**
   * **他授予了哪些权限**（乙-4）。**没授予过 ⇒ 空数组**（fail-closed）。
   *
   * ⚠️ 存在**他自己那一格**里（`<id>/grant.json`）：授予是**他**的决定，
   *    不是作者写进清单就能生效的东西。
   */
  grants(id) {
    checkAppId(id);
    try {
      const j = JSON.parse(this.fs.readFileSync(nodePath.join(this.appDir(id), 'grant.json'), 'utf8'));
      const out = [];
      for (const p of j?.permissions ?? []) {
        if (PERMISSIONS.includes(p)) out.push(p);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** **授予 / 撤销**（只认白名单里的名字；不是白名单的一律丢掉）。 */
  setGrants(id, permissions) {
    checkAppId(id);
    if (this.current(id) === null) throw new AppsError('这个小程序不在你这儿');
    const keep = [];
    for (const p of permissions ?? []) {
      if (!PERMISSIONS.includes(p)) throw new AppsError(`这个权限不认识：${String(p).slice(0, 20)}`);
      if (!keep.includes(p)) keep.push(p);
    }
    writeAtomic(
      this.fs,
      nodePath.join(this.appDir(id), 'grant.json'),
      `${JSON.stringify({ permissions: keep, at: this.now() })}\n`,
      0o644,
    );
    this.#audit({ what: 'grant', id, permissions: keep });
    return keep;
  }

  /**
   * **问一句的配额**（乙-4b）：`ask` 花的是**看的人自己的钱**，所以两道闸。
   *
   * 状态住在 `<id>/ask.json`（`{day, n, lastAt}`）。
   * ⚠️ **拒绝也要说清是哪一道**（"今天问得够多了" / "问得太快了"）——
   *    混成一句，用户会一直重试。
   *
   * @returns {{ok:true, left:number} | {ok:false, reason:string}}
   */
  askQuota(id, now = null) {
    checkAppId(id);
    const at = now ?? this.now();
    const day = new Date(at).toISOString().slice(0, 10);
    let st = { day, n: 0, lastAt: 0 };
    try {
      const j = JSON.parse(this.fs.readFileSync(nodePath.join(this.appDir(id), 'ask.json'), 'utf8'));
      if (j && j.day === day) st = { day, n: Number(j.n) || 0, lastAt: Number(j.lastAt) || 0 };
    } catch {
      /* 没有就是今天还没问过 */
    }
    if (st.n >= ASK_PER_DAY) return { ok: false, reason: '今天这个小程序问得够多了，明天再来' };
    if (at - st.lastAt < ASK_MIN_INTERVAL_MS) return { ok: false, reason: '问得太快了，等一下再问' };
    return { ok: true, left: ASK_PER_DAY - st.n };
  }

  /** 记一次问话（**先记再花**：宁可少花一次，也不许漏账）。 */
  bumpAsk(id, now = null) {
    checkAppId(id);
    const at = now ?? this.now();
    const day = new Date(at).toISOString().slice(0, 10);
    let st = { day, n: 0, lastAt: 0 };
    try {
      const j = JSON.parse(this.fs.readFileSync(nodePath.join(this.appDir(id), 'ask.json'), 'utf8'));
      if (j && j.day === day) st = { day, n: Number(j.n) || 0, lastAt: Number(j.lastAt) || 0 };
    } catch {
      /* 同上 */
    }
    const next = { day, n: st.n + 1, lastAt: at };
    writeAtomic(this.fs, nodePath.join(this.appDir(id), 'ask.json'), `${JSON.stringify(next)}\n`, 0o644);
    return next;
  }

  /**
   * ★ **`104`：给"我的小程序"改个名字**（主人 2026-09-25：桌面那个面板里的一项）。
   *
   * 改的是**那一版 manifest 里的 `title`** —— 桌面上显示的就是它，所以 `list()`
   * 跟着变（不需要另存一份"显示名"）。
   *
   * ⚠️ **只动 `title` 这一个字段**：`files` / `rootHash` / `version` / 权限…一个字节不动
   *    ⇒ "读回来的字节要对得上 hash"那几条判据照旧成立。
   * ⚠️ 版本本来是**不可变**的（规矩①）；这是**唯一**一处例外，而且是主人点名要的形状
   *    （契约 `docs/dev/104-APP-MENU.md` §三）。
   * ⚠️ **上限复用 `MAX_TITLE_CHARS`**（不许另写一个数）。
   *
   * 🔴 **落点只有这一处**：宿主那条路与盒里那条路都只调它（盒里调的是**同一个**方法）。
   *
   * @returns {string} 改完之后的那个名字（回执里就是它）
   */
  setTitle(id, title) {
    checkAppId(id);
    const version = this.current(id);
    // 认不出 / 不在他这儿 ⇒ 404（`status` 不写，由调用方按老规矩当 404）
    if (version === null) throw new AppsError('这个小程序不在你这儿');
    const name = typeof title === 'string' ? title.trim() : '';
    // 空名字 / 太长 ⇒ 400 ＋ 人话
    if (name.length === 0) throw new AppsError('名字不能是空的', 400);
    if (name.length > MAX_TITLE_CHARS) {
      throw new AppsError(`名字太长（上限 ${MAX_TITLE_CHARS} 个字）`, 400);
    }
    const m = this.manifest(id, version);
    if (!m) throw new AppsError('这个小程序的清单坏了，改不了名字');
    writeAtomic(
      this.fs,
      nodePath.join(this.versionDir(id, version), 'manifest.json'),
      `${JSON.stringify({ ...m, title: name }, null, 2)}\n`,
    );
    this.#audit({ what: 'rename', id, version, title: name });
    return name;
  }

  /**
   * ★ **`104`：把"我的小程序"复制出一个新的一格**（主人 2026-09-25）。
   *
   * | 件 | 怎么做 |
   * |---|---|
   * | 新 id | `<原id>-copy`；撞了往后加数字（`-copy2`/`-copy3`…），**有上限** ⇒ 试不出来**如实拒** |
   * | 新名字 | `<原标题> 副本`；重名再加 2、3…（同样有上限）|
   * | 字节 | **所有版本的字节照搬**（逐文件再核一次 hash ⇒ 源那份被人动过就当场拒）|
   * | 🔴 新那一间 | **是空的**：只有制品。**用量 / 授予 / 血缘 / 对话 / 工作区一个都不复制** |
   *
   * ⚠️ **复制的是"东西"，不是"那一段经历"**（主人原话）—— 所以这里只搬
   *    `versions/` 与 `current.json`；`usage.jsonl` / `grant.json` / `ask.json` /
   *    `lineage.json` 都**不进新格**（它们记的是那一间干过什么，不是制品本身）。
   * ⚠️ 清单里的 `id` / `title` 必须换掉（`manifest()` 会核 `j.id === id`），
   *    其余字段**逐字保留**（`rootHash` 照旧 —— 文件字节没动，hash 天然一致）。
   * ⚠️ 先在内存里把源那份**全读完、逐文件核过 hash**，再动盘（规矩②：不留"复制了一半"）。
   *
   * 🔴 **落点只有这一处**：宿主那条路与盒里那条路都只调它。
   *
   * @returns {{id:string, title:string}} 新那一格的 id 与名字
   */
  copy(id) {
    checkAppId(id);
    const from = this.current(id);
    if (from === null) throw new AppsError('这个小程序不在你这儿');
    const newId = this.#freeCopyId(id);
    const title = this.#freeCopyTitle(this.manifest(id, from)?.title ?? '');

    // ── ① 源那份全读进内存（顺便逐文件核 hash：源被人动过 ⇒ 如实拒）──────
    const packs = [];
    for (let v = 1; v <= MAX_VERSIONS; v += 1) {
      const m = this.manifest(id, v);
      if (!m) continue;
      const files = [];
      for (const rec of m.files ?? []) {
        let buf;
        try {
          buf = this.fs.readFileSync(nodePath.join(this.versionDir(id, v), rec.path));
        } catch {
          throw new AppsError(`那一版里有个文件读不出来，复制不了：${rec.path}`);
        }
        if (sha256hex(buf) !== rec.sha256) {
          throw new AppsError(`那一版里有个文件的内容对不上 hash，复制不了：${rec.path}`);
        }
        files.push({ path: rec.path, buf });
      }
      packs.push({ manifest: m, files });
    }

    // ── ② 动盘（出错就把新那一格整个收掉，不留"复制了一半"）─────────────
    try {
      this.fs.mkdirSync(this.appDir(newId), { recursive: false, mode: 0o755 });
      this.fs.mkdirSync(this.versionsDir(newId), { recursive: true, mode: 0o755 });
      for (const p of packs) {
        const vdir = this.versionDir(newId, p.manifest.version);
        this.fs.mkdirSync(vdir, { recursive: false, mode: 0o755 });
        for (const f of p.files) {
          const target = nodePath.join(vdir, f.path);
          this.fs.mkdirSync(nodePath.dirname(target), { recursive: true, mode: 0o755 });
          writeAtomic(this.fs, target, f.buf);
        }
        // 清单：**只换 id 与 title**，别的字段逐字保留（rootHash 照旧）
        writeAtomic(
          this.fs,
          nodePath.join(vdir, 'manifest.json'),
          `${JSON.stringify({ ...p.manifest, id: newId, title }, null, 2)}\n`,
        );
      }
      // 最后才移指针（与 `create()` 同一个顺序：中途断电最坏是多一个没人指向的版本）
      writeAtomic(
        this.fs,
        nodePath.join(this.appDir(newId), 'current.json'),
        `${JSON.stringify({ version: from })}\n`,
        0o644,
      );
    } catch (err) {
      try {
        this.fs.rmSync(this.appDir(newId), { recursive: true, force: true });
      } catch {
        /* 收不干净也不许盖住原来那个错 */
      }
      throw err;
    }

    this.#audit({ what: 'copy', id, newId, title });
    return { id: newId, title };
  }

  /** 挑一个没被占的新 id（`<原id>-copy`，撞了往后加数字；**有上限**）。 */
  #freeCopyId(id) {
    for (let n = 1; n <= MAX_COPY_TRIES; n += 1) {
      const suffix = n === 1 ? '-copy' : `-copy${n}`;
      // ⚠️ id 也有长度上限 ⇒ 短一点的源头截一段，绝不拼出一个超长的 id
      const base = id.slice(0, Math.max(1, MAX_ID_CHARS - suffix.length));
      const cand = `${base}${suffix}`;
      if (cand.length > MAX_ID_CHARS) continue;
      if (this.fs.existsSync(this.appDir(cand))) continue;
      return cand;
    }
    throw new AppsError(
      `连着试了 ${MAX_COPY_TRIES} 个名字都被占了，复制不出来（先给它改个名字再试）`,
      409,
    );
  }

  /** 挑一个没重名的新标题（`<原标题> 副本`，重名再加 2、3…；**有上限**）。 */
  #freeCopyTitle(baseTitle) {
    const taken = new Set(this.list().map((a) => a.title));
    const clean = typeof baseTitle === 'string' ? baseTitle.trim() : '';
    for (let n = 1; n <= MAX_COPY_TRIES; n += 1) {
      const suffix = n === 1 ? ' 副本' : ` 副本${n}`;
      // 原标题可能已经顶到上限 ⇒ 截一段，绝不拼出一个超长的标题
      const base = clean.slice(0, Math.max(0, MAX_TITLE_CHARS - suffix.length));
      const cand = `${base}${suffix}`;
      if (!taken.has(cand)) return cand;
    }
    throw new AppsError(
      `连着试了 ${MAX_COPY_TRIES} 个名字都重名，复制不出来（先给它改个名字再试）`,
      409,
    );
  }

  /**
   * **从桌面上删掉**：软删制品那一格 ＋（`103` §七起）**把那一间整个回收掉**。
   *
   * ⚠️ **软删**（挪进 `<root>/.removed/<id>-<ts>/`），不是真删 ——
   *    这个项目的规矩是"删错了能拿回来"（回收站那条）。真删要人自己说。
   * ⚠️ 挪走之后 `list()` 里就没有它了（`.` 开头的不算 app）。
   *
   * ★ **`103` §七（D3.11）**：主人拍的是**真回收** —— 除了制品那一格，还要把
   *   **那一间的工作区 / 那条日志里 `scopeId==id` 的行 / 助手那边的会话记录**
   *   一起搬进**同一个**回收处，并写 `reclaimed.json`（号洞的留痕）。
   *   🔴 **一处实现**：这三样住 `src/reclaim.js` 的 `reclaimScope()`，**宿主那条路
   *      与盒里那条路都走这里**（两条路都只调 `remove()`，见 `server.js`）。
   *   🔴 **失败不许留"删了一半"**：回收没做完 ⇒ 连制品那一格也**搬回原位**再抛。
   *      ⇒ 调用方只有"全成"与"如实失败"两种结局，**没有第二种成功形状**。
   *
   * @returns {string} 回收处那个目录（`.removed/<id>-<ts>`）
   */
  remove(id) {
    checkAppId(id);
    if (this.current(id) === null) throw new AppsError('这个小程序不在你这儿');
    const at = this.now();
    const to = nodePath.join(this.root, REMOVED_DIRNAME, `${id}-${at}`);
    this.fs.mkdirSync(nodePath.dirname(to), { recursive: true, mode: 0o755 });
    this.fs.renameSync(this.appDir(id), to);

    // ★ 惰性取"真回收"的上下文（`worlds.js` 里那几本账在 `new Apps()` 之后才建）
    let ctx = null;
    if (this.reclaim) {
      ctx = typeof this.reclaim === 'function' ? this.reclaim() : this.reclaim;
    }
    if (ctx) {
      try {
        reclaimScope({
          ...ctx,
          // ⚠️ 显式的这几样**最后给**：它们以 `Apps` 自己那份为准（上下文覆盖不了）
          id,
          into: to,
          sub: this.sub,
          at,
          fs: this.fs,
          log: (m) => ctx.log?.(m),
        });
      } catch (err) {
        // 回收没做完 ⇒ 制品那一格也搬回去（**不留"删了一半"**）
        try {
          this.fs.renameSync(to, this.appDir(id));
        } catch (back) {
          (ctx.log ?? (() => {}))(`制品那一格没搬回原位：${back?.message ?? back}`);
        }
        throw err;
      }
    }

    this.#audit({ what: 'remove', id });
    return to;
  }

  /**
   * **回滚**：把指针移回某一个已经存在的版本（内容不再重新生成，所以 hash 天然一致）。
   * ⚠️ 只改指针 ⇒ 旧版本还在 ⇒ 还能再滚回来。
   */
  rollback(id, version) {
    checkAppId(id);
    const n = Number.parseInt(version, 10);
    if (this.manifest(id, n) === null) throw new AppsError('要回滚到的那一版不在');
    writeAtomic(this.fs, nodePath.join(this.appDir(id), 'current.json'), `${JSON.stringify({ version: n })}\n`, 0o644);
    this.#audit({ what: 'rollback', id, version: n });
    return n;
  }

  /**
   * **血缘边**（90 Q4.6／Q4.9 · 91 §8.3）：**分叉**时把"上游那一版"记下来。
   *
   * 落点是 **`hupo/apps/<id>/lineage.json`**（登记，与 `current.json` / `grant.json` 同一格），
   * **不写进不可变 `manifest.json`** —— 清单会被下一版覆盖，血缘一写就丢（90 Q4.9）。
   * 边的形状照契约：`(base rootHash, 我的那一版)`；**只记能力体**，不碰数据／经验。
   *
   * ⚠️ 它**不承重**：删掉它，app 照样能装能跑（可检查性归 0 ⇒ 90 Q4.8）。
   */
  noteLineage(id, entry = {}) {
    checkAppId(id);
    if (this.current(id) === null) throw new AppsError('这个小程序不在你这儿');
    const all = this.lineage(id);
    const rec = { at: this.now(), ...entry };
    all.push(rec);
    writeAtomic(
      this.fs,
      nodePath.join(this.appDir(id), 'lineage.json'),
      `${JSON.stringify(all, null, 2)}\n`,
      0o644,
    );
    this.#audit({ what: 'lineage', id, ...entry });
    return rec;
  }

  /** 盘上那串血缘边（没有 / 坏了 ⇒ 空数组，**不猜**）。 */
  lineage(id) {
    checkAppId(id);
    try {
      const j = JSON.parse(this.fs.readFileSync(nodePath.join(this.appDir(id), 'lineage.json'), 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
}
