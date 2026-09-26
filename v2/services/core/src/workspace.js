// **一个图标 = 一个工作区**（契约 `docs/dev/83-APP-WORKSPACE.md` §三）。
//
// ── 它解决什么 ────────────────────────────────────────────
// 手册 `02-ARCHITECTURE.md` §2.1 早就画着 `workspaces/<scope-name>/ ← 子工作区
// （= 桌面上的一个图标）`，但**从来没有人建它**：小程序的文件躺在主目录
// （`/data/main/city-weather/`）里，而"造一个小程序"这件事**只发生在模型的记忆里**
// —— 它记得就建，忘了文件就躺回主目录（契约 §二那张表）。
//
// ⇒ 这一层把"建工作区"变成**服务端自己那一刀**（契约 §三·4）：
//     造 app 的第一步 = `mkdir <dir>/workspaces/<scope>/` ＋ 骨架 ＋ 登记，
//     **不靠模型记得**。
//
// ── 三条不许破 ────────────────────────────────────────────
//   ① 🔴 **`main` 与 `workspaces` 必须平行**（手册 §2.2 第二条）：
//      `workspaces/` 在 `<dir>/` 下面，**不**在主目录里面 ——
//      主目录的 agent 就写不进子工作区（这是"平行"那句话的全部意义）。
//   ② 🔴 **scope 名字进路径之前必须校验**：
//      `..` / `/` 那类一个字母就能跑出根外（和 `tenants.safeUserId` 同一条纪律）。
//   ③ 🔴 **制品库是快照，工作区才是干活的地方**（契约 §三·5）：
//      快照是**从工作区读回来**的 ⇒ "改了没发布，线上不变"在结构上成立。
//
// ⚠️ **它不认识令牌**：这是"谁的工作区"由调用方定（`worlds.js` 按 `claim.sub` 取）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { checkLiveRel, liveRelOk } from './app-live.js';
import {
  AppsError,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_ID_CHARS,
  MAX_TOTAL_BYTES,
  MAX_VERSIONS,
  checkAppId,
  checkRelPath,
  contentTypeOf,
  refuseReservedAppId,
  rootHashOf,
  sha256hex,
} from './apps.js';
import { shouldHandToAgent } from './socket-owner.mjs';

/** 工作区根目录叫什么（`<dir>/workspaces`）。**只有这一处**。 */
export const WORKSPACES_DIRNAME = 'workspaces';

/**
 * 工作区里那份**清单**的文件名。
 *
 * ⚠️ 用点开头的名字是刻意的：它**不是制品**（`read()` 会跳过所有 `.` 开头的），
 *    也不会和模型写的文件撞名 —— 否则一个叫 `manifest.json` 的制品
 *    会把工作区自己的账本覆盖掉。
 */
export const WORKSPACE_MANIFEST = '.hupo.json';

/**
 * **不能拿来当 scope 的名字**。
 *
 * `main` 是主线那个房间（契约 §三·2）——它有自己的工作目录与时间线，
 * 一个叫 `main` 的 app 会让"这句话进哪个房间"变成一件说不清的事。
 */
export const RESERVED_SCOPES = Object.freeze(['main']);

/** 工作区根（`<dir>/workspaces`）。**永远与主目录平行**，不是它的子目录。 */
export function workspacesRoot(dir) {
  return nodePath.join(dir, WORKSPACES_DIRNAME);
}

/** 某个 scope 的工作区（`<dir>/workspaces/<scope>`）。 */
export function scopeDirFor(dir, scope) {
  return nodePath.join(workspacesRoot(dir), checkScope(scope));
}

/**
 * scope 名字的形状。**认不出 ⇒ `null`**（不许猜）。
 *
 * 和 app 的 id **同一条规则**（scope 就是那个 app 的 id）：小写字母数字与短横，
 * 首字符不能是短横，长度上限与 `apps.MAX_ID_CHARS` 共用一处。
 */
export function safeScope(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[a-z0-9][a-z0-9-]*$/.test(s) && s.length <= MAX_ID_CHARS ? s : null;
}

/** 校验一个 scope 名字；不合法 / 被占用的名字一律抛（人话）。 */
export function checkScope(raw) {
  const s = safeScope(raw);
  if (!s) {
    throw new AppsError(
      `工作区的名字不合法（只许小写字母、数字、短横，最多 ${MAX_ID_CHARS} 个字符）：${String(raw).slice(0, 60)}`,
    );
  }
  if (RESERVED_SCOPES.includes(s)) {
    throw new AppsError(`"${s}" 是主线那个房间，不能再拿来当工作区`);
  }
  return s;
}

/** 原子写：先写临时文件，再 rename（同 `apps.js` / `store.js` 的既有做法）。 */
function writeAtomic(fs, file, data, mode = 0o644) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

/** 骨架里那个占位页面。**他一行字都没写的时候，工作区里也得有个东西能打开。** */
export function placeholderIndex({ id, title = null } = {}) {
  const name = String(title ?? id ?? '');
  return [
    '<!doctype html>',
    '<html lang="zh">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${name.replace(/[<>&]/g, '')}</title>`,
    '</head>',
    '<body>',
    '  <p>这里还空着。</p>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * **一个人的那些工作区**。
 *
 * ⚠️ `dir` 是"他那一格"（`worlds.pathsFor(sub).dir`）——
 *    对主人就是 `/data`（所以工作区落在 `/data/workspaces/<scope>`，
 *    正好是手册 §2.1 画的那张图）。
 */
export class AppWorkspaces {
  /**
   * @param {object} o
   * @param {string} o.dir        这个人世界的根
   * @param {object} [o.fs]
   * @param {()=>number} [o.now]
   * @param {(m:string)=>void} [o.log] 警告日志（**交给 agent 那一步失败要报出来**）
   * @param {object} [o.env]      注入环境（测试用；"这个 agent 是谁"那条规则在 `socket-owner.mjs`）
   * @param {number} [o.uid]      注入进程 uid（同上）
   */
  constructor({
    dir,
    fs = nodeFs,
    now = Date.now,
    log = () => {},
    env = process.env,
    uid = process.getuid?.(),
  }) {
    if (!dir) throw new AppsError('dir 必填');
    this.dir = dir;
    this.fs = fs;
    this.now = now;
    this.log = log;
    this.env = env;
    this.uid = uid;
  }

  /** 工作区根（`<dir>/workspaces`）。它**不在**主目录里面 —— 平行。 */
  get root() {
    return workspacesRoot(this.dir);
  }

  dirFor(scope) {
    return nodePath.join(this.root, checkScope(scope));
  }

  manifestPath(scope) {
    return nodePath.join(this.dirFor(scope), WORKSPACE_MANIFEST);
  }

  /** 这个 scope 的工作区在不在（**只看盘上的事实**）。 */
  has(scope) {
    const s = safeScope(scope);
    if (!s || RESERVED_SCOPES.includes(s)) return false;
    try {
      return this.fs.statSync(this.dirFor(s)).isDirectory();
    } catch {
      return false;
    }
  }

  /** 盘上那份清单（没有 / 坏了 ⇒ `null`）。 */
  manifestOf(scope) {
    const s = safeScope(scope);
    if (!s) return null;
    try {
      const j = JSON.parse(this.fs.readFileSync(this.manifestPath(s), 'utf8'));
      if (!j || j.id !== s) return null;
      return j;
    } catch {
      return null;
    }
  }

  /** 已经建出来的那些工作区（给清理与排障看）。 */
  list() {
    let names = [];
    try {
      names = this.fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      return [];
    }
    return names.filter((n) => safeScope(n) && !RESERVED_SCOPES.includes(n)).sort();
  }

  /**
   * **把这一间交给干活的那个 uid**（盒子里的 agent 是 uid 1000，服务是 root）。
   *
   * 🔴 为什么非做不可：`<dir>/workspaces` 这一格由 `entry.mjs` 建成 **1000:1000 0700**，
   *    但**子目录是我们现建的**（root）——不交出去，agent（uid 1000）连进都进不去，
   *    表现就是它写不了自己的工作区（**和 2026-09-24 那两条套接字一模一样的病**：
   *    主人那一格看不出来，因为那边服务与 agent 同 uid）。
   *
   * ⚠️ 规则的**唯一出处**是 `socket-owner.mjs`（"谁是 agent"只有那一处）——
   *    宿主上（没配 `HUPO_AGENT_UID`）这一整条是**空操作**。
   * ⚠️ 顺序照它那条实测经验：**先 chmod 再 chown**。
   * ⚠️ **不抛**（服务不该因为这一下起不来），但**必须报出来**（`log`）——
   *    静默失败的样子正是"盒子那头一句 EACCES"。
   */
  hand(scope) {
    const id = checkScope(scope);
    const d = shouldHandToAgent({ env: this.env, uid: this.uid });
    if (!d.hand) return { hand: false, done: false, why: d.why, errors: [] };
    const dir = this.dirFor(id);
    if (!this.has(id)) return { hand: true, done: false, why: '工作区不在', errors: [] };
    const errors = [];
    const one = (p, mode) => {
      try {
        const st = this.fs.statSync(p);
        if (st.uid === d.owner.uid && st.gid === d.owner.gid) {
          if ((st.mode & 0o777) !== mode) this.fs.chmodSync(p, mode); // 已经是他的 ⇒ 要 FOWNER
          return;
        }
        this.fs.chmodSync(p, mode); // 此刻还是 root 自己的
        this.fs.chownSync(p, d.owner.uid, d.owner.gid);
      } catch (err) {
        errors.push(`${p}: ${err?.message ?? err}`);
      }
    };
    one(this.root, 0o700);
    const walk = (rel) => {
      const here = rel === '' ? dir : nodePath.join(dir, rel);
      one(here, 0o700);
      for (const e of this.fs.readdirSync(here, { withFileTypes: true })) {
        const next = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(next);
        else one(nodePath.join(dir, next), 0o644);
      }
    };
    walk('');
    if (errors.length > 0) {
      this.log(
        `工作区 ${id} 没能交给 agent(${d.owner.uid}:${d.owner.gid})：${errors[0]}`
        + ` ⇒ 盒子里它会写不进自己的地方（EACCES）`,
      );
    }
    return { hand: true, done: errors.length === 0, why: d.why, errors };
  }

  /**
   * **服务端那一刀**：把这个 scope 的工作区建出来（幂等）。
   *
   * 顺序：建目录 → 没有 `index.html` 就写一个**占位**页面 → 写清单。
   * ⚠️ 占位内容会记在清单的 `placeholder` 里（连 hash 一起）—— 见 `write()`：
   *    模型真的给了内容之后，**只有内容仍是占位**的那个才会被删掉。
   *
   * @returns {{id:string, dir:string, created:boolean, manifest:object}}
   */
  ensure(scope, { title = null, entry = null, at = null } = {}) {
    // 🔴 **保留 id 不许在这里建出 app 的工作区**（闸只有一份：`apps.refuseReservedAppId`）。
    //    ⚠️ 建工作区**发生在写制品之前**（`apps-socket.js` 先 `ensure` 再 `snapshotWorkspace`）
    //    ⇒ 只靠 `apps.create` 拒的话，一个保留 id 会先在盘上留一个空工作区。
    //    ⚠️ 内置那三个**是合法房间**：它们的目录走 `worlds.roomFor` 的 `mkdir ＋ hand`，
    //       不走 `ensure`（B16-2）—— 所以这里拒它们，拒的是"当 app"，不是"当房间"。
    refuseReservedAppId(scope);
    const id = checkScope(scope);
    const dir = this.dirFor(id);
    const created = !this.has(id);
    this.fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    let man = this.manifestOf(id);
    if (!man) {
      man = {
        schema: 1,
        kind: 'hupo-workspace',
        id,
        title: typeof title === 'string' && title.trim() !== '' ? title : id,
        entry: typeof entry === 'string' && entry !== '' ? checkRelPath(entry) : 'index.html',
        placeholder: {},
        createdAt: at ?? this.now(),
      };
    } else if (typeof title === 'string' && title.trim() !== '' && man.title !== title) {
      man.title = title; // 他改了名字 ⇒ 跟着改（工作区那份清单是"现在叫什么"）
    }
    if (typeof entry === 'string' && entry !== '') man.entry = checkRelPath(entry);

    const placeholders = { ...(man.placeholder ?? {}) };
    const index = nodePath.join(dir, 'index.html');
    if (!this.fs.existsSync(index)) {
      const buf = Buffer.from(placeholderIndex({ id, title: man.title }), 'utf8');
      writeAtomic(this.fs, index, buf, 0o644);
      placeholders['index.html'] = sha256hex(buf);
    }
    man.placeholder = placeholders;
    writeAtomic(this.fs, this.manifestPath(id), Buffer.from(`${JSON.stringify(man, null, 2)}\n`), 0o644);
    // ★ 交给干活的那个 uid（盒子里 agent 是 1000、服务是 root）—— 宿主上是空操作
    this.hand(id);
    return { id, dir, created, manifest: man };
  }

  /**
   * **把产物落到工作区里**（模型给的 `files`，或者从别处镜像过来的一份）。
   *
   * ⚠️ 两条和 `apps.js` 同款的规矩：
   *   ① **先在内存里全校验完，再动盘**（不是"写一半再回滚"）；
   *   ② 路径走白名单（`checkRelPath`）—— 一个能写 `../../etc/passwd` 的
   *      工作区等于把整台机器交出去（而内容**来自模型**）。
   *
   * @param {Record<string,string|Buffer>} files
   * @returns {{id:string, dir:string, wrote:string[]}}
   */
  write(scope, files) {
    // 🔴 同 `ensure`：保留 id 的工作区不许被"当 app"写（闸只有一份）
    refuseReservedAppId(scope);
    const id = checkScope(scope);
    const dir = this.dirFor(id);
    if (!this.has(id)) throw new AppsError(`工作区还没建出来：${id}`);
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      throw new AppsError('产物要是一张「文件名 → 内容」的表');
    }
    const paths = Object.keys(files);
    if (paths.length === 0) throw new AppsError('一个文件都没有');
    if (paths.length > MAX_FILES) throw new AppsError(`文件太多（上限 ${MAX_FILES} 个）`);

    const checked = [];
    let total = 0;
    for (const rel of paths) {
      checkRelPath(rel);
      // 🔴 我们自己那份清单的名字**不许被制品占掉**
      if (rel === WORKSPACE_MANIFEST || rel.startsWith('.hupo')) {
        throw new AppsError(`这个文件名是工作区自己在用的，换一个：${rel}`);
      }
      const raw = files[rel];
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
      if (buf.length === 0) throw new AppsError(`空文件：${rel}`);
      if (buf.length > MAX_FILE_BYTES) throw new AppsError(`单个文件太大：${rel}`);
      total += buf.length;
      checked.push({ rel, buf });
    }
    if (total > MAX_TOTAL_BYTES) throw new AppsError('这一份东西太大了');

    for (const f of checked) {
      const target = nodePath.join(dir, f.rel);
      this.fs.mkdirSync(nodePath.dirname(target), { recursive: true, mode: 0o700 });
      writeAtomic(this.fs, target, f.buf, 0o644);
    }

    // ★ **占位页面**：模型给了自己的内容之后，把**还是占位**的那个删掉。
    //   ⚠️ 只删"内容对得上占位 hash"的 —— 他（或者模型）改过的**一律不碰**。
    const man = this.manifestOf(id);
    if (man?.placeholder) {
      const kept = { ...man.placeholder };
      for (const [rel, sha] of Object.entries(kept)) {
        if (checked.some((f) => f.rel === rel)) {
          delete kept[rel];
          continue;
        }
        const p = nodePath.join(dir, rel);
        try {
          if (sha256hex(this.fs.readFileSync(p)) === sha) {
            this.fs.unlinkSync(p);
            delete kept[rel];
          }
        } catch {
          /* 读不到 / 删不掉：留着，不算错（宁可多一个文件，也不许删错东西） */
        }
      }
      man.placeholder = kept;
      writeAtomic(this.fs, this.manifestPath(id), Buffer.from(`${JSON.stringify(man, null, 2)}\n`), 0o644);
    }
    // ★ 新写的那些文件也要交给干活的那个 uid（同上）
    this.hand(id);
    return { id, dir, wrote: checked.map((f) => f.rel) };
  }

  /**
   * **把工作区读回来**（制品快照的唯一来源）。
   *
   * ⚠️ 跳过所有以 `.` 开头的路径：那份清单是我们自己的账，不是制品。
   * ⚠️ 入口认不出来时退回"第一个 `.html`"——**认不出也要能读出东西**，
   *    但绝不编一个不存在的文件名。
   *
   * @returns {{id:string, dir:string, files:Record<string,Buffer>, entry:string|null, manifest:object|null}}
   */
  read(scope) {
    const id = checkScope(scope);
    const dir = this.dirFor(id);
    if (!this.has(id)) throw new AppsError(`没有这个工作区：${id}`);
    const files = {};
    const walk = (rel) => {
      const here = rel === '' ? dir : nodePath.join(dir, rel);
      for (const e of this.fs.readdirSync(here, { withFileTypes: true })) {
        if (String(e.name).startsWith('.')) continue;
        const next = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(next);
        else if (e.isFile()) files[next] = this.fs.readFileSync(nodePath.join(dir, next));
      }
    };
    walk('');
    const man = this.manifestOf(id);
    let entry = typeof man?.entry === 'string' ? man.entry : 'index.html';
    if (!files[entry]) {
      const html = Object.keys(files).filter((f) => f.toLowerCase().endsWith('.html')).sort();
      entry = html[0] ?? Object.keys(files).sort()[0] ?? null;
    }
    return { id, dir, files, entry, manifest: man };
  }

  /**
   * ★ **按工作区读一个"活文件"**（契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）。
   *
   * ── 它和 `read()` 的分工 ──────────────────────────────────
   *   · `read()` —— 把**整间**读回来给制品快照（发布/血缘那一条路用）；
   *   · 这一个 —— 给"桌面那一格现在要显示什么"读**一个**文件，**现读现给**。
   *     ⇒ "他改了没发布，屏幕上也是新的"在结构上成立：**读的就是那一份**。
   *
   * 🔴 **两道路径安全**：`checkLiveRel`（白名单：`.` 开头与 `build/` 一律拒）＋
   *    下面那次 **resolve 之后的"还在不在这间里"**（防符号链接/`..` 那种绕过）。
   * 🔴 **只读、不建目录、不写**：读不到 ⇒ 抛（人话），绝不替它编一个页面出来。
   *
   * @returns {{content:Buffer, contentType:string, rel:string}}
   */
  readLive(scope, rel) {
    const id = checkScope(scope);
    if (!this.has(id)) throw new AppsError(`没有这个工作区：${id}`);
    const r = checkLiveRel(rel);
    const dir = nodePath.resolve(this.dirFor(id));
    const abs = nodePath.resolve(dir, r);
    // 🔴 第二道：解析之后必须**还在这一间里面**（`checkLiveRel` 只判字符串）
    if (abs !== dir && !abs.startsWith(`${dir}${nodePath.sep}`)) {
      throw new AppsError(`工作区里没有这个文件：${r}`);
    }
    let st;
    try {
      st = this.fs.statSync(abs);
    } catch {
      throw new AppsError(`工作区里没有这个文件：${r}`);
    }
    if (!st.isFile()) throw new AppsError(`工作区里没有这个文件：${r}`);
    return { content: this.fs.readFileSync(abs), contentType: contentTypeOf(r), rel: r };
  }
}

/**
 * ★ **"他那一份现在长什么样" —— 读一个活文件，必要时先把它落成**（契约 112 §三）。
 *
 * ── 为什么要"必要时先落成"（真机读数逼出来的）────────────────
 * 真机上主人那三个 app（`dice` / `wenda` / `coin`）**早于"一个图标 = 一个工作区"**
 * （契约 83）就存在 ⇒ `data/workspaces/` **根本不存在**。而 `roomFor()` 又会在
 * "制品库里有、工作区还没建"时建一个**空目录**（那是给它当 cwd 的）。
 * ⇒ 只认"目录在不在"的话，那三个 app 一点开就是"取不到这个文件"。
 *
 * 🔴 **判据不是"目录在不在"，是"那一间自己的清单在不在"**（`.hupo.json`）：
 *    `AppWorkspaces.ensure()` 一定会写它 ⇒ 有清单 = 这间真的落成过。
 *    没有清单（老 app / 刚装上的 / `roomFor` 建的空壳）⇒ 从**当前那一版**镜像一次。
 *    ⚠️ **镜像之后再没有**（清单在了）⇒ **绝不再拿旧版顶替**：他删掉的文件就是删掉了，
 *       "悄悄退回某一版"正是这一条要修的那种假话。
 *
 * ⚠️ 它**只写一次**（幂等：镜像完清单就在了）；写的是**这个人自己盒子里**那一份。
 */
export function readLiveApp({ apps, workspaces, id, rel }) {
  if (!workspaces) throw new AppsError('没有这一间工作区');
  try {
    return workspaces.readLive(id, rel);
  } catch (err) {
    if (!(err instanceof AppsError)) throw err;
    // 已经落成过（有清单）⇒ 这就是"真没有这个文件"，不许拿旧版顶替
    if (workspaces.manifestOf(id) !== null) throw err;
    if (!apps || typeof apps.current !== 'function' || apps.current(id) === null) throw err;
    mirrorArtifactIntoWorkspace({ apps, workspaces, id });
    return workspaces.readLive(id, rel);
  }
}

/**
 * ★ **`fs.watch` 报来的那条相对路径，算哪一间**（契约 112 §四）。
 *
 * 逐条拒（**认不出就 `null`**，不许猜）：
 *   · 空 / 只有一层（改的是某间目录自己）⇒ 不算；
 *   · 第一段不是合法 scope（`..` / 大写 / 太长）⇒ 不算；
 *   · `main`（主线那个房间，不是小程序）⇒ 不算；
 *   · 白名单不过（`.` 开头 / `build/` / 临时文件）⇒ 不算。
 *
 * ⚠️ 它住在**这一份**（而不是 `app-live.js`）是因为"scope 名字合法吗"那条规则
 *    只有这一处（`safeScope` / `RESERVED_SCOPES`）；两边各写一遍迟早会漂。
 */
export function liveScopeOfChange(root, filename) {
  if (typeof filename !== 'string' || filename === '') return null;
  const parts = filename.split(nodePath.sep).filter((p) => p !== '');
  if (parts.length < 2) return null;
  const scope = safeScope(parts[0]);
  if (!scope || RESERVED_SCOPES.includes(scope)) return null;
  const rel = parts.slice(1).join('/');
  return liveRelOk(rel) ? scope : null;
}

/**
 * ★ **"活地址"那一侧的取值来源**（契约 112 §三 · 唯一一处）。
 *
 * 形状与 `serve.js` 的 `appsForSub` **逐条对齐**（同一个道理，别读成两套）：
 *   · **租户** ⇒ `boxLive(sub, tenant)`（宿主给的是"经现有隧道读他盒子里那份"）；
 *   · **主人 / 单租户** ⇒ 本机那一间（`readLiveApp`）。
 *
 * 🔴 **为什么抽成一个函数而不是写在 `serve.js` 里**：写在 `serve.js` 里的接线
 *    **判据够不着**（那是个一跑就起监听的模块）—— 2026-09-26 真机当场栽了一次：
 *    那里少 import 一个名字，请求进来才 `ReferenceError`，而**单测全绿**
 *    （它们各自搭了一根自己的接线）。⇒ 把接线搬到一个能在 VM 上驱动的函数里，
 *    判据直接打它（V13 那族：**闸要打在被测的那一侧**）。
 *
 * @param {object} o
 * @param {(sub:string)=>object|null} o.worldFor
 * @param {(sub:string)=>string|null} [o.tenantOf]  `null` = 本机那一份
 * @param {(sub:string, tenant:string)=>object|null} [o.boxLive]  租户那一条（宿主给）
 * @returns {(sub:string)=>{readLive:(id:string,rel:string)=>{content:Buffer,contentType:string}}|null}
 */
export function makeLiveForSub({ worldFor, tenantOf = () => null, boxLive = null } = {}) {
  if (typeof worldFor !== 'function') throw new AppsError('worldFor 必填');
  return (sub) => {
    const tenant = tenantOf(sub);
    if (tenant) return typeof boxLive === 'function' ? boxLive(sub, tenant) : null;
    const w = worldFor(sub);
    if (!w?.workspaces) return null;
    return {
      readLive: (id, rel) => readLiveApp({ apps: w.apps, workspaces: w.workspaces, id, rel }),
    };
  };
}

/**
 * **制品库那一份 = 从工作区拷过去的快照**（契约 §三·5）。
 *
 * 🔴 顺序是这一条判据的全部：**先有工作区里的字节，才有制品**。
 *    所以"工作区改了没发布 ⇒ 线上不变"不是一个约定，是**读的那个地方不同**。
 *
 * @returns {{manifest:object, workspace:string, files:string[]}}
 */
export function snapshotWorkspace({
  apps,
  workspaces,
  id,
  title = null,
  icon = undefined,
  entry = null,
  permissions = [],
  createdBy = 'agent',
  createdTurn = null,
}) {
  if (!apps) throw new AppsError('apps 必填（快照要落进制品库）');
  if (!workspaces) throw new AppsError('workspaces 必填（快照从工作区读）');
  const ws = workspaces.read(id);
  const m = apps.create({
    id,
    title: title ?? ws.manifest?.title ?? id,
    icon,
    entry: entry ?? ws.entry,
    files: ws.files,
    permissions,
    createdBy,
    createdTurn,
  });
  return { manifest: m, workspace: ws.dir, files: Object.keys(ws.files).sort() };
}

/**
 * **工作区当前内容的指纹** —— 与制品 `rootHash` **同一条算法**（排序后拼 `path\nhash\n`）。
 *
 * 🔴 为什么必须是同一条算法：装／升级前要比的就是"**我这儿改过没有**"，
 *    两个 hash 只有同源才比得动（90 Q4.5 的判据就是"工作区 hash ≠ 当前 `rootHash`"）。
 * ⚠️ 它走 `read()` ⇒ 与制品同一条边界（`.` 开头的**不算**能力体）。
 *
 * @returns {string} 十六进制 sha256（工作区里一个文件都没有时是空串的 hash）
 */
export function workspaceRootHash(workspaces, id) {
  const ws = workspaces.read(id);
  return rootHashOf(Object.entries(ws.files).map(([path, buf]) => ({ path, sha256: sha256hex(buf) })));
}

/**
 * **装／升级前先拍工作区快照**（90 Q4.3／Q4.5 · 89 §⑫ 那条"最该先做的"）。
 *
 * 🔴 它只做一件事：**在任何覆盖发生之前**，把工作区这一份原始字节留档。
 *    落点贴现有布局：`hupo/apps/<id>/versions/<n>/`（不可变版本 ＋ 逐文件 sha）——
 *    **不新造第二套存储**（`apps.create` 本来就把 `files[].sha256` 写进 manifest）。
 *
 * ⚠️ **宁多一份，不重复拍**：工作区内容已经等于某一版（比如"没改过"时就是当前版）
 *    ⇒ 那一版**就是**可以逐字节回退的快照，不再开一版；否则新开一版留档。
 *    否则每次升级都白吃两个版本号（`apps.MAX_VERSIONS` 兜着）。
 *
 * @returns {{version:number|null, rootHash:string, created:boolean, reused:boolean, empty?:boolean, manifest?:object}}
 */
export function snapshotBeforeInstall({
  apps,
  workspaces,
  id,
  title = null,
  icon = undefined,
  createdTurn = null,
}) {
  if (!apps || !workspaces) throw new AppsError('apps 与 workspaces 都必填（快照要落进制品库）');
  const ws = workspaces.read(id);
  const hash = rootHashOf(Object.entries(ws.files).map(([path, buf]) => ({ path, sha256: sha256hex(buf) })));
  // 空工作区：没有"可丢的东西" ⇒ 不用拍（也拍不成：制品不许一个文件都没有）
  if (Object.keys(ws.files).length === 0) {
    return { version: null, rootHash: hash, created: false, reused: false, empty: true };
  }
  // 已经有一版一模一样的 ⇒ 它就是快照（判据："逐文件 sha 可核"由那一版的 manifest 给出）
  for (let v = 1; v <= MAX_VERSIONS; v += 1) {
    const m = apps.manifest(id, v);
    if (m && m.rootHash === hash) {
      return { version: v, rootHash: hash, created: false, reused: true };
    }
  }
  const snap = snapshotWorkspace({
    apps,
    workspaces,
    id,
    title: title ?? workspaces.manifestOf(id)?.title ?? id,
    icon,
    createdBy: 'user',
    createdTurn,
  });
  return {
    version: snap.manifest.version,
    rootHash: snap.manifest.rootHash,
    created: true,
    reused: false,
    manifest: snap.manifest,
  };
}

/**
 * **把制品库的某一版镜像回工作区**（"装上别人的"那条路，也是**回退**那条路）。
 *
 * 为什么需要它：一个装上来的小程序也**必须有一个属于它自己的工作区**——
 * 契约第一条是"一个图标 = 一个工作区"，不分成"自己造的"和"装来的"。
 * ⚠️ 读的是**制品库那一版**（不是共享库）：装上的那一刻它已经是他的快照了。
 *
 * @param {number|null} [o.version] 指定镜像哪一版（默认 = 当前指针那一版）。
 *   ★ 指定版本 = **拿快照逐字节还原**（90 S3）：先 `apps.rollback(id, v)` 再叫它，
 *     或者直接叫它（它只读那一版，不改指针）。
 */
export function mirrorArtifactIntoWorkspace({ apps, workspaces, id, version = null }) {
  if (!apps || !workspaces) throw new AppsError('apps 与 workspaces 都必填');
  const v = version === null || version === undefined ? apps.current(id) : Number.parseInt(version, 10);
  if (v === null || !Number.isInteger(v)) throw new AppsError('这个小程序不在你这儿');
  const man = apps.manifest(id, v);
  if (!man) throw new AppsError('那一版的清单坏了');
  const files = {};
  for (const f of man.files ?? []) {
    files[f.path] = apps.read(id, v, f.path).content;
  }
  workspaces.ensure(id, { title: man.title, entry: man.entry });
  workspaces.write(id, files);
  return { id, version: v, files: Object.keys(files).sort() };
}
