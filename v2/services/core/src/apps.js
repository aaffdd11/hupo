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
// ★ **一个小程序自己那一格存储**（主人 2026-09-30 拍板 · 契约 `147-APP-SQLITE.md`）。
//   ⚠️ **执行那一步在 `app-db.js`**（子进程 + 硬超时）；这里只管"该不该跑"。
import {
  DB_CALLS_PER_MINUTE,
  DB_ERROR_TEXT,
  DB_FILE,
  DB_FULL_TEXT,
  DB_PERMISSION,
  DB_TOO_MANY_TEXT,
  checkAppDb,
  runDbChild,
} from './app-db.js';
// ★ **小程序定时任务**（`148` §四）：清单形状与"该不该跑"只在那一份里判（`checkTaskList`）
import { checkTaskList, nextTaskState } from './app-tasks.js';
// ★ **`A3·补`（D4.24 · 2026-10-03）：审计里的身份换凭据哈希**（推不回明文，见那个文件卷首）。
import { credHashOf } from './cred-hash.js';
// ★ **形状声明（`D4.24` · A1 · 2026-10-03）**：那份随 fork 走、值永不随的固定名文件。
//   🔴 **规则本体只在 `data-shape.js` 一处**：这里只用它的两个名字（文件名 / 那道判据）。
import { DATA_SHAPE_FILENAME, parseDataShape, readDataShape } from './data-shape.js';
import { reclaimScope } from './reclaim.js';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 制品放在每个人世界的哪个相对目录下（`hupo/apps/`）。 */
export const APPS_REL = nodePath.join('hupo', 'apps');

/**
 * ★ **"活的那一份"的登记文件**（`hupo/apps/<id>/app.json`）—— 用户端**不再是"包"**。
 *
 * ── 它为什么存在（主人 2026-09-26 定的形状 · `docs/dev/113-APP-SHAPE-LIVE.md`）──
 *   *"所谓的版本快照，只在市场中存在。不在用户端。用户 a 创建的，在他自己那里
 *     就是一段源代码部署……所以**不需要什么压缩**。"*
 *
 *  ⇒ 他自己那一份的内容住在**工作区**（`workspaces/<id>/`），桌面点开的也是它（`/w/`）。
 *    这个文件**只登记那张脸**：`id` / `title` / `icon` / `entry` / 权限 / 一个版本计数。
 *    🔴 **它不存内容、不查尺寸、不查文件数** —— 那三道是"包"的规矩（`create()`），
 *      只属于**发到市场那一侧**。
 *
 * ⚠️ 旧的（有 `current.json` + `versions/` 的）app **照样认**：`meta()` 两者都读，
 *    所以"装来的那一份"和"发过一版的"行为一个字没变。
 */
export const APP_META = 'app.json';

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

/**
 * **描述**最多多少个字（主人 2026-09-27 要的那一栏：**可以不填**）。
 * ⚠️ 它只是"这一间是干什么的"一句话 —— 给助手看的活页夹封面，不是内容，
 *    所以**短**：太长就该写进页面里，而不是塞进清单。
 */
export const MAX_DESC_CHARS = 200;
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
 * ★ **`agent`：它要跟"它的助手"说一句话**（`148` §三 · 主人："这些功能都要有"）。
 *
 * 🔴 **它比 `ask` 重**：`ask` 是"直连模型问一句"（没工具、没记忆、不改东西）；
 *    这一样是把问题送进**那个 app 那一间**，由**那一间的助手**来答 ——
 *    那个助手**是有手的**（能读文件、能查网）。所以三道一起：
 *    ① **它必须先在设置里被允许**（跟别的能力一样，声明了默认就给，他能关掉）；
 *    ② **配额**（每天几次 ＋ 两次之间最小间隔 —— 见下面那两个常量）；
 *    ③ 🔴 **每一次都看得见**：问题以"**来自小程序**"的样子落进那一间的对话里，
 *       助手怎么答也在那儿 ⇒ 他随时翻得到（**不许**做成一条他看不见的暗线）。
 * ⚠️ 条数、字节、时长这些**数只住代码**（手册纪律 1）。
 */
export const AGENT_PERMISSION = 'agent';

/**
 * ★ **`tasks`：它要"按点自己跑一件小事"**（`148` §四 · 主人："这些功能都要有"）。
 *
 * 🔴 **注册制**：声明了（而且他没关掉）才跑 —— **每一次都跑在他自己的盒子里**、
 *    **串行**、有**每天上限**，而且**结果回到那一间对话**（他翻得到）。
 * ⚠️ 间隔、每天几次、最多几件那些**数只住 `app-tasks.js`**。
 */
export const TASKS_PERMISSION = 'tasks';

/**
 * ★ **`net`：它要访问哪几个站**（主人 2026-09-30：*「这些功能都要有」*）。
 *
 * ── 形状（两样一起才算）────────────────────────────────────
 *   · `permissions` 里有 **`net`** ⇒ "**它要上网**"（设置页那颗开关管的就是这一样）；
 *   · `net: ["api.example.com", …]` ⇒ **白名单**（它只许连这几个站）。
 * ⇒ **能上网 ＋ 名单** 两样齐了，制品页那条 CSP 才会把名单放进去（`app-serve.js` 的 `cspFor`）。
 *   ⚠️ 那一下**由浏览器/WebView 自己执行**（CSP 是硬的）—— **关掉开关 ⇒ 名单立刻不进 CSP**
 *     ⇒ 它当场连不出去（判据 `N4`）。
 *
 * 🔴 **名单的来源是助手**（主人 2026-09-30：*「agent 可以去访问网站并为小程序建立白名单」*）：
 *   助手写页面时**自己去访问过**，然后把用到的域名写进清单 ⇒ **声明了就能用**（傻瓜式）。
 *   ⚠️ **加新站 = 新的一版**（要重新声明）——**不许**"运行时自己往白名单里加"。
 */
export const NET_PERMISSION = 'net';

/**
 * **权限白名单**（乙-4 开门：`ask`；2026-09-30 加第二个门：`db`）。
 *
 * `ask` = 允许它请求「用**看的人**的钥匙问一句话」。
 * `db`  = 允许它**存东西**（它自己那一格独立的 SQLite 文件，见 `147-APP-SQLITE.md`）。
 * ⚠️ **声明 ≠ 能用**：制品必须在清单里声明，**而且看的人明确授予**，两样都齐了才算（见 `grants`）。
 * ⚠️ **钥匙永远不进制品**：制品只拿得到"问一句"这个动作，拿不到钥匙本身，也拿不到别人的钥匙。
 * ⚠️ **`db` 也拿不到文件**：它拿到的只是"替我执行这一条"这个动作（跨库那条路是堵死的）。
 */
export const PERMISSIONS = Object.freeze(['ask', DB_PERMISSION, NET_PERMISSION, AGENT_PERMISSION, TASKS_PERMISSION]);

/**
 * **跟助手说一句的配额**（数只住这里）。
 *
 * ⚠️ 比 `ask` 紧得多：这一样会**真的请动那一间的助手**（它可能去读文件、查网），
 *    所以"每天几次"要小。⚠️ 超了要**说清是哪一道**（今天问得够多了 / 问得太快了）。
 */
export const AGENT_PER_DAY = 20;
export const AGENT_MIN_INTERVAL_MS = 10_000;

/** 一个 app 最多声明几个站（防呆：这不是给人手写的长名单）。 */
export const MAX_NET_HOSTS = 8;

/** 一个域名最长多少字符（DNS 的实际上限就在这一带）。 */
export const MAX_HOST_CHARS = 100;

/**
 * **一张白名单过一遍**（纯函数，**只有这一处**）。
 *
 * 🔴 它是一道**安全边界**：名单会被拼进**响应头**（`connect-src …`）——
 *   一条带 `;`／空格／引号的"域名"就足以**改写整条 CSP**。
 * ⇒ 只认**规规矩矩的 https 域名**：小写字母/数字/`-`/`.`，至少一个点，不许通配、不许端口、
 *    不许路径、不许 scheme、不许空白。**认不出来就拒**（不猜、不修）。
 *
 * @param {unknown} raw
 * @returns {{ok:true, hosts:string[]} | {ok:false, text:string}}
 */
export function checkNetHosts(raw) {
  if (raw === undefined || raw === null) return { ok: true, hosts: [] };
  if (!Array.isArray(raw)) return { ok: false, text: '要访问的站得列一个清单。' };
  if (raw.length > MAX_NET_HOSTS) return { ok: false, text: `最多写 ${MAX_NET_HOSTS} 个站。` };
  const out = [];
  for (const one of raw) {
    if (typeof one !== 'string') return { ok: false, text: '清单里有一个看不懂。' };
    // 🔴 **一个空白字符都不许有**（这一串会被拼进**响应头**）——
    //    所以不做 trim 容忍：`" api.example.com\n"` 这种**直接拒**（判据 N3）。
    if (one !== one.trim() || /\s/.test(one)) return { ok: false, text: '清单里那个不许带空白字符。' };
    const h = one.toLowerCase();
    if (h.length === 0 || h.length > MAX_HOST_CHARS) return { ok: false, text: '清单里有一个太长或者空的。' };
    // 🔴 严格形状：`a.b` / `a.b.c`；标签只许字母数字与短横（不许以短横开头/结尾）
    if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(h)) {
      return { ok: false, text: '清单里那个不像是域名（只写域名本身，别带 http://、路径、端口或通配）。' };
    }
    if (!out.includes(h)) out.push(h);
  }
  return { ok: true, hosts: out };
}

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
 * ⚠️ `code`（可选）是给**读侧那道闸**分岔用的（`HIDDEN_PATH_CODE`）：老调用方只看
 *    `message` 与 `status`，多一个标记**一个字都不影响**；新调用方（制品口 / 盒子那条口）
 *    据此把"这条路径按规矩不许取"与"真没有这个文件"分开回 —— 不再一律 404。
 */
export class AppsError extends Error {
  constructor(message, status = null, code = null) {
    super(message);
    this.name = 'AppsError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 🔴 **读侧那道闸拒的时候带的标记**（`D4.24` · 2026-10-03 主人点头「加」）。
 *
 * **只有这一处**：`refuseHiddenRelPath()` 抛它，制品口 / 盒子内部口 / 盒代理都 `import` 它
 * （`isHiddenPathRefusal()` 判），**不许在别处再写一遍这个字符串**。
 */
export const HIDDEN_PATH_CODE = 'hidden-path';

/** 这个错是不是"读侧那道闸拒了这条路径"（**判据只有这一处**）。 */
export function isHiddenPathRefusal(err) {
  return err instanceof AppsError && err.code === HIDDEN_PATH_CODE;
}

/** `/^[a-z0-9][a-z0-9-]{0,31}$/` —— 小写字母数字与短横，首字符不能是短横。 */
export function checkAppId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > MAX_ID_CHARS) {
    throw new AppsError(`小程序 id 不合法（只许小写字母、数字、短横，最多 ${MAX_ID_CHARS} 个字符）：${String(id).slice(0, 60)}`);
  }
  return id;
}

/**
 * **app 不许占用的 id**（🔴 **唯一出处**）：主线那个房间 ＋ 桌面内置那三格。
 *
 * 🔴 为什么名单住这里（不另抄一份在 `worlds.js`）：**闸要落在写入路的汇合点**——
 *    制品库那个 `apps.create()`。所有写路（新路 `snapshotWorkspace`、老路
 *    `apps-socket.js` 的那一支、装上 `published.installInto`）最后都汇到这里。
 *    `apps.js` 是叶子模块，`worlds.js` 反过来可以引用它，**不会成环**。
 *
 * ⚠️ 与客户端 `v2/apps/mobile/lib/models/app_spec.dart` 的三个内置 id **逐字一致**
 *    （对不上 ⇒ 客户端拿一个服务端不认的 scope 去连 ⇒ 404）。
 */
export const REFUSED_APP_IDS = Object.freeze(['main', 'settings', 'discover', 'harness']);

/**
 * 保留 id ⇒ **人话拒**（N11）；不是保留 id ⇒ 原样返回。
 *
 * ⚠️ `main` 与内置那三个是同一道闸的两半：前者"谁都不许占"，后者"它已经是别人的房间"。
 * ⚠️ 它**只拦"当 app"**，不拦"当房间"：`main` 由 `workspace.checkScope` 另有一条，
 *    内置那三个走 `worlds.roomFor`（那里对内置是**放行**的）。
 */
export function refuseReservedAppId(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!REFUSED_APP_IDS.includes(s)) return s;
  if (s === 'main') throw new AppsError(`"${s}" 是主线那个房间，不能再拿它当小程序的名字`);
  throw new AppsError(`"${s}" 是桌面上本来就有的那一格，不能再拿它当小程序的名字`);
}

/**
 * ★ **给"从桌面上新建的那个小程序"配一个短名**（主人 2026-09-27：加号那颗按钮）。
 *
 * 🔴 **服务端生成，客户端不猜**（同 `/api/app-rename` 那条：id 由服务端定）：
 *    他填的是**名字**（中文也行），而 id 只许小写字母/数字/短横
 *    ⇒ 从名字里"音译"一个 id 是**编**，所以取随机那几个字符。
 *
 * ⚠️ **撞了就再抽**（有界重试）：`taken` 由调用方给（它就是"他这儿有没有这个东西"）。
 *
 * @param {{taken?:(id:string)=>boolean, rand?:()=>string, tries?:number}} [o]
 * @returns {string} 一个**没被占**的合法 id
 */
export function newAppId({ taken = () => false, rand = null, tries = MAX_COPY_TRIES } = {}) {
  const pick = typeof rand === 'function'
    ? rand
    : () => Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 8).padEnd(8, '0');
  for (let i = 0; i < Math.max(1, tries); i += 1) {
    const id = `app-${pick()}`.slice(0, MAX_ID_CHARS);
    if (taken(id)) continue;
    return checkAppId(id);
  }
  throw new AppsError('取不出一个没被占用的短名（试了几次都不行）');
}

/**
 * ★ **这一间是不是"一个小程序"**（主人 2026-09-27 那条"里面不能再开一个"的判据）。
 *
 *   · 他库里真有的那一个（`has`）；或者
 *   · 桌面内置那几格（`REFUSED_APP_IDS`：设置 / 发现 /「我自己那台」）。
 *
 * ⚠️ `main` **不算**（那是桌面本身）；**派活/长活那种临时的间也不算**
 *    （它们不在他的库里）—— 长活"另开一处做"那条路本来就要在那里把新 app 造出来。
 * ⚠️ 认不出（`apps` 没给 / `has` 抛）⇒ **`false`**：这是"别再套娃"的礼貌闸，
 *    不是安全闸（安全那两道是身份与保留 id）。
 */
export function isAnAppRoom(apps, scope) {
  const s = typeof scope === 'string' ? scope.trim() : '';
  if (!s || s === 'main') return false;
  if (REFUSED_APP_IDS.includes(s)) return true;
  try {
    return apps?.has?.(s) === true;
  } catch {
    return false;
  }
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
  // 🔴 `HIDDEN_PATH_CODE`：读侧那几处（制品口 / 盒子内部口）据此把"不许取"与"没有"分开回。
  throw new AppsError(`制品里不许有以 "." 开头的文件${where}：${rel}`, null, HIDDEN_PATH_CODE);
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
   * @param {(e:{id:string,version:number,title:string})=>void} [o.onVersion]
   *        ★ **一版真的写下去了**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）：
   *        "制品换了版本 ⇒ 正开着它的那个界面自己换上"那一帧的**唯一触发点**。
   *        🔴 为什么挂在**这里**：`create()` 是**所有写路都经过的那个漏斗**
   *        （工具那条新路 `snapshotWorkspace`、旧路、从共享库"装上"、
   *        `/api/app-copy` 复制一份都走它）⇒ 挂在漏斗上，"多写了一条路却没喊"
   *        在结构上不可能；挂在某一个调用点上的话，下一条写路就会漏。
   *        ⚠️ **第一版不喊**（`version === 1`）：那不是"更新"，而且那一刻
   *        还没有任何界面开着它（新东西走 `app/installed` 那条）。
   *        ⚠️ **它出错不许让"写成了"这件事失败** —— 版本已经在盘上了，
   *        这时候回报一个失败就是让工具说假话（见 `create()` 末尾的 try/catch）。
   * @param {object|(()=>object)} [o.reclaim]
   *        ★ **`103` §七：真回收的上下文**（一个人一份）。给了 ⇒ `remove()` 除了软删
   *        制品那一格，还会把**那一间的工作区 / 对话 / 助手那边的会话记录**一起搬进
   *        同一个回收处，并写 `reclaimed.json`（`src/reclaim.js` · **一处实现**）。
   *        `null`（缺省）⇒ 只有软删 ＋ 审计，**逐字是第一轮的行为**（老测试与
   *        单测里那两个"只有 `{dir, sub}`"的用法不受影响）。
   *        ⚠️ 传**函数**（惰性取）是有意的：`worlds.js` 里那几本账（`unread`/`work`）
   *        在 `new Apps()` 之后才建 —— 但 `remove()` 一定发生在它们建好之后。
   * @param {object|(()=>object)} [o.live]
   *        ★ **`114`：活的那一份复制时要读/写工作区**（内容在工作区里，不在这儿）。
   *        形状 `{ workspaces }`（`AppWorkspaces`）；`null`（缺省）⇒ 只有"包"那一套复制。
   *        ⚠️ 与 `reclaim` 同一条理由传**函数/惰性**：`workspaces` 在 `new Apps()` 之后才建。
   * @param {Buffer|string|null} [o.credKey]
   *        ★ **`A3·补`：审计账里那把凭据哈希的键**（`serve.js` 给的是制品签名键）。
   *        不给 ⇒ `cred-hash.js` 的退化键。**审计里不再写明文 `sub`。**
   */
  constructor({
    dir,
    sub = null,
    fs = nodeFs,
    now = Date.now,
    onAudit = () => {},
    onVersion = () => {},
    reclaim = null,
    live = null,
    credKey = null,
  }) {
    if (!dir) throw new AppsError('dir 必填');
    this.dir = dir;
    this.sub = sub;
    this.credKey = credKey;
    this.fs = fs;
    this.now = now;
    this.onAudit = onAudit;
    this.onVersion = onVersion;
    this.reclaim = reclaim;
    this.live = live;
    /**
     * **每个 app 最近这一分钟调了几次存储**（只在内存里）。
     *
     * ⚠️ 为什么频率闸住内存、不住盘：它是**防呆**，不是记账 ——
     *    进程重启之后重新数就够了；而每调一次写一下盘，等于用 I/O 换一个不需要那么准的数。
     *    （**"花了多少"那种要跨重启的账不走这儿**：那是 `ask.json` 那种。）
     */
    this.dbCalls = new Map();
  }

  /** 惰性取"活的那一份"要用的那两样（工作区）。取不到 ⇒ `null`（调用方如实说）。 */
  #liveWorkspaces() {
    try {
      const holder = typeof this.live === 'function' ? this.live() : this.live;
      return holder?.workspaces ?? null;
    } catch {
      return null;
    }
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
    /**
     * 🔴 **`A3·补`（D4.24 · 2026-10-03）：这一行写的是凭据哈希，不是明文身份。**
     *    原来第一格是 `sub: this.sub`（`"sub":"u1"` 直接落盘）。
     *    ⇒ 换成 `credHashOf`：同一个部署里同一个人的行仍然对得上（稳定假名），
     *      但推不回明文（键在签名键里，只服务端有）。
     *    ⚠️ **老行一个字都不改**（只对新写入的这一行生效）。
     */
    const line = JSON.stringify({ at: this.now(), sub: credHashOf(this.sub, this.credKey), ...entry });
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

  /** "活的那一份"那张脸的登记文件（`hupo/apps/<id>/app.json`）。 */
  metaPath(id) {
    return nodePath.join(this.appDir(id), APP_META);
  }

  /** 盘上那份登记（没有 / 坏了 ⇒ `null`，**不猜**）。 */
  #readMeta(id) {
    try {
      const j = JSON.parse(this.fs.readFileSync(this.metaPath(id), 'utf8'));
      if (!j || j.id !== id) return null;
      return j;
    } catch {
      return null;
    }
  }

  /**
   * ★ **一个 app 的那张脸**（`list()` / 认人 / 改名都走它）—— **只有这一处**。
   *
   * 两个来源，优先级刻意（两种 app 今天同时在世上）：
   *   · **活的那一份**（`app.json`）：名字 / 图标 / 入口 / 权限**以它为准**（他改的名字立刻算数）；
   *   · **包**（`current.json` + `manifest.json`）：版本 / `rootHash` / 字节数**以它为准**
   *     （发过一版、或者从市场装来的，就是有一个包）。
   * ⇒ 只有包（旧的 / 装来的）⇒ 逐字是原来那一条；只有登记（他自己造的）⇒ 报一个版本计数。
   *
   * @returns {object|null} `null` = 这儿没有这个东西
   */
  meta(id) {
    checkAppId(id);
    const live = this.#readMeta(id);
    const v = this.current(id);
    if (live === null && v === null) return null;
    if (live === null) {
      const m = this.manifest(id, v);
      if (!m) return null;
      return {
        id,
        title: m.title,
        description: '',
        icon: m.icon,
        version: v,
        entry: m.entry,
        rootHash: m.rootHash,
        bytes: m.bytes,
        permissions: [...(m.permissions ?? [])],
        net: [...(m.net ?? [])],
        tasks: (m.tasks ?? []).map((t) => ({ ...t })),
        minShellVersion: m.minShellVersion,
        createdAt: m.createdAt,
        live: false,
      };
    }
    if (v === null) {
      return {
        id,
        title: typeof live.title === 'string' ? live.title : id,
        description: typeof live.description === 'string' ? live.description : '',
        icon: live.icon ?? null,
        version: Number.isInteger(live.version) && live.version >= 1 ? live.version : 1,
        entry: typeof live.entry === 'string' && live.entry !== '' ? live.entry : 'index.html',
        rootHash: live.rootHash ?? null,
        bytes: live.bytes ?? null,
        permissions: [...(live.permissions ?? [])],
        net: [...(live.net ?? [])],
        tasks: (live.tasks ?? []).map((t) => ({ ...t })),
        minShellVersion: 1,
        createdAt: live.createdAt ?? null,
        live: true,
      };
    }
    const m = this.manifest(id, v);
    if (!m) return null;
    return {
      id,
      title: typeof live.title === 'string' ? live.title : m.title,
      description: typeof live.description === 'string' ? live.description : '',
      icon: live.icon ?? m.icon,
      version: v,
      entry: typeof live.entry === 'string' && live.entry !== '' ? live.entry : m.entry,
      rootHash: m.rootHash,
      bytes: m.bytes,
      permissions: [...(live.permissions ?? [])],
      net: [...(live.net ?? [])],
      tasks: (live.tasks ?? []).map((t) => ({ ...t })),
      minShellVersion: m.minShellVersion,
      createdAt: live.createdAt ?? m.createdAt,
      live: true,
    };
  }

  /** 这个东西在他这儿吗（**活的那一份与包都算**）。 */
  has(id) {
    try {
      return this.meta(id) !== null;
    } catch {
      return false;
    }
  }

  /**
   * ★ **登记"他自己那一份"**（用户端唯一那一刀 · 契约 `docs/dev/114`）。
   *
   * 🔴 **它不写内容、不建版本目录、不查尺寸/文件数** —— 内容住在**工作区**里，
   *    桌面点开的就是它。这一刀只回答"桌面上那张脸叫什么、点开是哪个文件"。
   * 🔴 **上限一个都不查**：那是"包"的规矩（`create()`），只属于市场那一侧
   *    （主人原话：*"所以不需要什么压缩"*）。
   * ⚠️ 校验里保留的是**形状**那几道（id / 保留名 / 权限白名单 / 名字长度 / 入口路径）
   *    —— 它们是安全与协议，不是容量。
   *
   * @param {object} o
   * @param {string} o.id
   * @param {string} o.title
   * @param {string} [o.icon]        认不出/没给 ⇒ 自动配一个（同 `create`）
   * @param {string} o.entry
   * @param {string[]} [o.permissions]
   * @param {string[]} [o.net]        ★ 要访问的站（`148` §二）：**只有声明了 `net` 才算数**
   * @param {object[]} [o.tasks]      ★ 定时任务（`148` §四）：**只有声明了 `tasks` 才算数**
   * @param {string} [o.createdBy]   `user` | `agent`
   * @param {number} [o.createdTurn]
   * @param {string|null} [o.rootHash] 登记那一刻工作区的指纹（**可以不带**；不带就不写）
   * @param {number|null} [o.bytes]
   * @returns {object} 写下去的登记
   */
  register({
    id,
    title,
    icon = undefined,
    entry,
    permissions = [],
    net = [],
    tasks = [],
    createdBy = 'agent',
    createdTurn = null,
    description = '',
    rootHash = null,
    bytes = null,
  }) {
    checkAppId(id);
    refuseReservedAppId(id);
    if (!Array.isArray(permissions)) throw new AppsError('permissions 必须是数组');
    for (const p of permissions) {
      if (!PERMISSIONS.includes(p)) {
        throw new AppsError(`这个权限现在还不给（${String(p).slice(0, 30)}）—— 制品暂时什么能力都没有`);
      }
    }
    // ★ `148` §二：**白名单只在声明了 `net` 的时候才算数**（校验只有这一处，两个入口共用它）
    const netCheck = checkNetHosts(net);
    if (netCheck.ok !== true) throw new AppsError(netCheck.text);
    if (netCheck.hosts.length > 0 && !permissions.includes(NET_PERMISSION)) {
      throw new AppsError('写了要访问的站，却没说要用网 —— 两样要一起给');
    }
    // ★ `148` §四：定时任务的形状（同一把尺子在 `create` 那边；两处缺一不可）
    const taskCheck = checkTaskList(tasks);
    if (taskCheck.ok !== true) throw new AppsError(taskCheck.text);
    if (taskCheck.tasks.length > 0 && !permissions.includes(TASKS_PERMISSION)) {
      throw new AppsError('写了定时任务，却没说要用这个能力 —— 两样要一起给');
    }
    if (typeof title !== 'string' || title.trim().length === 0) throw new AppsError('小程序要有一个名字');
    if (title.length > MAX_TITLE_CHARS) throw new AppsError(`名字太长（上限 ${MAX_TITLE_CHARS} 个字）`);
    // ★ **描述：可选**（主人 2026-09-27）。空 ⇒ 存空串（**不写 `undefined`**：
    //   清单里少一个字段和"这个字段是空的"是两件事，读的人得说得清）。
    const desc = typeof description === 'string' ? description.trim() : '';
    if (desc.length > MAX_DESC_CHARS) throw new AppsError(`描述太长（上限 ${MAX_DESC_CHARS} 个字）`);
    const picked = resolveIcon({ icon, title, id });
    if (typeof entry !== 'string' || entry.length === 0) throw new AppsError('入口文件必填');
    checkRelPath(entry);
    if (createdBy !== 'user' && createdBy !== 'agent') throw new AppsError(`createdBy 不合法：${String(createdBy).slice(0, 20)}`);

    const prev = this.#readMeta(id);
    const version = (prev?.version ?? 0) + 1;
    const now = this.now();
    const meta = {
      schema: SCHEMA,
      live: true,
      id,
      title,
      description: desc,
      icon: picked.icon,
      entry,
      permissions: [...permissions],
      net: [...netCheck.hosts],
      tasks: taskCheck.tasks.map((t) => ({ ...t })),
      version,
      rootHash: typeof rootHash === 'string' && rootHash !== '' ? rootHash : null,
      bytes: Number.isInteger(bytes) && bytes >= 0 ? bytes : null,
      createdBy,
      createdTurn,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.fs.mkdirSync(this.appDir(id), { recursive: true, mode: 0o755 });
    writeAtomic(this.fs, this.metaPath(id), `${JSON.stringify(meta, null, 2)}\n`, 0o644);
    this.#audit({ what: prev === null ? 'register' : 'update', id, version, by: createdBy, turn: createdTurn });
    return meta;
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

  /**
   * **这一版"形状"的号**（92 §③ 阶段 5 的第三个号；91 §8.1「三个号互不代管」）。
   *
   * ── 它读哪儿、为什么是那儿 ────────────────────────────────
   *   形状**不是**经验的号，**也不是**能力体内容的号 —— 它是**制品声明的那套形状契约**
   *   （`manifest.schema`，`apps.SCHEMA` 那一族）：入口形态 / 目录形态 / 清单字段形态。
   *   ⇒ 它住在**清单里**（那正是"形状住制品内固定名文件"这条决定在能力体这一侧的落点：
   *     制品里那个固定名文件就是 `manifest.json`，它已经是清单本身）。
   *   🔴 **所以只改 `.exp/` ⇒ 它不变** —— 这是 92 §③ 阶段 5 第一条判据，且是**结构性的**：
   *     `.exp/` 的字节根本不进 `manifest.json`，也不参与 `rootHash`。
   *
   * ⚠️ **读不到 ⇒ `null`**（不猜一个号出来）：这一版不在 / 清单坏了 ⇒ 说"没有"。
   * ⚠️ 它**不替代** `rootHash`：`rootHash` 管"内容是不是这一份"，它管"形状是哪一族"。
   *
   * @returns {number|null} 形状的号（清单里的 `schema`），读不出 ⇒ `null`
   */
  shapeVersion(id, version = null) {
    checkAppId(id);
    const v = version === null || version === undefined ? this.current(id) : Number.parseInt(version, 10);
    if (!Number.isInteger(v) || v < 1) return null;
    const m = this.manifest(id, v);
    if (!m) return null;
    const s = Number.parseInt(m.schema, 10);
    return Number.isInteger(s) && s >= 1 ? s : null;
  }

  /**
   * ★ **这一版带的那份形状声明**（`D4.24` · A1 · 2026-10-03）。
   *
   * 它与上面 `shapeVersion()` **不是一回事**（91 §8.1「三个号互不代管」）：
   *   · `shapeVersion()` = **能力体那一族的号**（`manifest.schema`）；
   *   · 这一个 = **数据那一族的号**（`data-shape.json` 里每个包自己的内容地址）。
   *
   * 🔴 **读它 = 读制品里的字节**（`apps.read` 会逐字节核 `sha256`）⇒ 它**随版本冻结**：
   *    改一个键名／类型／空值口径／去重键 ⇒ 那一包 `shapeVersion` 必变；
   *    而"只改数据的值"动的是**另一格**（`.data/` 里的字节）⇒ 这份文件逐字不动。
   * ⚠️ **读不到 ⇒ `{declared:false}`**（如实的"没有声明"）；**文件在而认不出 ⇒ 抛**（fail-closed）。
   *
   * @returns {{declared:boolean, decl:object|null, digest:string|null, version:number}}
   */
  dataShape(id, version = null) {
    checkAppId(id);
    return readDataShape({ apps: this, id, version });
  }

  /**
   * **我的清单**：每个 app 的那张脸（坏的就跳过那一个，不许整个清单炸）。
   *
   * ★ `114`：**活的那一份（只要有 `app.json`）也在里面** —— 他自己造的小程序
   *   从今天起**不需要先落一版**才上桌面（主人原话：*"版本快照只在市场中存在"*）。
   *   认人那一步只有一处（`meta()`），所以"活的"与"有包的"不可能分成两套读法。
   */
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
      const m = this.meta(id);
      if (!m) continue;
      out.push(m);
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
  create({ id, title, icon, entry, files, permissions = [], net = [], tasks = [], createdBy = 'user', createdTurn = null, expectRootHash = null }) {
    checkAppId(id);
    // 🔴 **保留 id 的唯一一道闸**（`REFUSED_APP_IDS`）：主线 ＋ 桌面内置三格。
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
    // ★ `148` §二：**白名单只在声明了 `net` 的时候才算数**（与 `register` 同一个纯函数）
    const netOk = checkNetHosts(net);
    if (netOk.ok !== true) throw new AppsError(netOk.text);
    if (netOk.hosts.length > 0 && !permissions.includes(NET_PERMISSION)) {
      throw new AppsError('写了要访问的站，却没说要用网 —— 两样要一起给');
    }
    // ★ `148` §四：定时任务的形状（与 `register` 同一个纯函数）
    const taskOk = checkTaskList(tasks);
    if (taskOk.ok !== true) throw new AppsError(taskOk.text);
    if (taskOk.tasks.length > 0 && !permissions.includes(TASKS_PERMISSION)) {
      throw new AppsError('写了定时任务，却没说要用这个能力 —— 两样要一起给');
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
      // 🔴 **形状声明（`D4.24` A1）那道闸就在它的汇合点**（与 `refuseHiddenRelPath` 同一处位置）。
      //    `data-shape.json` 是制品里那份**固定名文件**（随 `rootHash` 冻结、随 fork 走）——
      //    它只许写形状、**值一个字节都不许进来**；认不出 ⇒ 拒。
      //    ⚠️ 位置刻意：它跑在**动盘之前**（四条硬规矩②）⇒ 拒的时候**盘上零残留**；
      //       规则本体只在 `data-shape.js` 一处，这里**只调它**（判据 S4b 的变异会核这一下真的承重）。
      if (rel === DATA_SHAPE_FILENAME) parseDataShape(buf);
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
      net: [...netOk.hosts],
      tasks: taskOk.tasks.map((t) => ({ ...t })),
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
    // ★ **一版真的写下去了**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）：
    //   走到这里 = 文件、`manifest.json`、`current.json`（指针）**都写成了**。
    //   🔴 顺序刻意：它在**指针移完之后** —— 早一步喊，客户端去 `/api/apps`
    //      可能拿到**上一版**（那就成了一句假话：屏幕上什么都不会换）。
    //   ⚠️ **第一版不喊**（见构造函数那段）。
    //   ⚠️ 喊不出去**不许**让"写成了"这件事失败：盘上已经有这一版了。
    if (version > 1) {
      try {
        this.onVersion({ id, version, title: manifest.title });
      } catch {
        /* 喊不出去不影响制品；下一次 `/api/apps` 照样拿得到新的 */
      }
    }
    return manifest;
  }

  /**
   * **读一个文件**：先验这一版的 hash（规矩③），再验路径（规矩④）。
   *
   * 🔴 **读侧的同一道闸**（`D4.24` · 2026-10-03 主人点头「加」；落地见
   *    `docs/dev/164-READ-SIDE-HIDDEN-GATE.md`，来由是 `dev/158` §五·1 那一笔）：
   *    写侧 `create()` 里那道 `refuseHiddenRelPath` 在这里**再跑一遍** ——
   *    **规则一个字都不另抄**，就是同一个函数。
   *
   *    老租户的包里可能有**写侧那道闸之前**写进去的隐藏路径（`.data/…`／`.exp/…`）。
   *    本闸让那些包**从今天起读不出来** —— 这个代价主人 2026-10-03 点头接受了；
   *    但**"弄坏"必须是"看得见的拒绝"**：拒的时候带 `code = 'hidden-path'`，
   *    制品口据此回一条**能查的明确理由**（不是白屏、不是假 404），
   *    并在这里留一条审计（`<world>/hupo/apps/audit.jsonl`）。
   *
   * 🔴 **顺序刻意**：先认这一版在不在（"没有这一版"是真话），再判路径 ——
   *    所以对**真的存在**的那一版，隐藏路径**一律拒**（不管清单里有没有声明它）。
   *    它跑在**读第一个字节之前**。
   *
   * @returns {{ content: Buffer, contentType: string }}
   */
  read(id, version, rel) {
    checkAppId(id);
    checkRelPath(rel);
    const m = this.manifest(id, version);
    if (!m) throw new AppsError('这一版不在（或者它的清单坏了）');
    try {
      // 🔴 与写侧 `create()` 同一个函数（**同一条规则只住一处**）
      refuseHiddenRelPath(rel);
    } catch (err) {
      // 拒得**看得见**：留一条审计（谁的世界 · 哪个 app · 哪条路径）。
      if (isHiddenPathRefusal(err)) {
        const n = Number.parseInt(version, 10);
        this.#audit({ what: 'hidden-path-refused', id, version: Number.isInteger(n) ? n : null, path: rel });
      }
      throw err;
    }
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
   * **他关掉了哪几样**（`grant.json` · ★ **2026-09-30 语义翻了，见下**）。
   *
   * ── 🔴 为什么是"关掉清单"而不是"允许清单"（主人 2026-09-30）──────────
   *   *「我希望是傻瓜式的，用户需求做 app 小程序，那就尽量理解并给全套。」*
   *   ⇒ 一个**他自己**让助手做出来的小程序，声明了要存东西就**该当场能用** ——
   *     不该让他先去设置里点一下开关（那是把"作者"的活推给了用户）。
   *   ⇒ 所以落盘的语义是 **`{denied: [...]}`**：**没关过的 = 给的**；
   *     他在设置页把某一样关掉 ⇒ 那一样进 `denied`。
   *
   * ⚠️ **老文件照旧认**（`{permissions: [...]}` 是当年那份"允许清单"）：
   *    读的时候现算 `denied = 制品声明的 − 老文件里允许的` ——
   *    ⇒ **当年被他关掉的那一样，翻新语义之后仍然是关着的**（不许"悄悄给他打开"）。
   *    下次写入时自然变成新格式（**不偷偷改写他的文件**）。
   *
   * @returns {string[]} 关掉的那几样（只认白名单里的名字）
   */
  #grantBook(id) {
    let j = null;
    try {
      j = JSON.parse(this.fs.readFileSync(nodePath.join(this.appDir(id), 'grant.json'), 'utf8'));
    } catch {
      return { allowed: [], denied: [] }; // 没这份文件 ⇒ **他还没表过态**（新版默认：不给）
    }
    const pick = (arr) => (Array.isArray(arr) ? arr.filter((p) => PERMISSIONS.includes(p)) : []);
    if (Array.isArray(j?.allowed) || Array.isArray(j?.denied)) {
      return { allowed: pick(j?.allowed), denied: pick(j?.denied) };
    }
    if (Array.isArray(j?.permissions)) {
      /**
       * ⚠️ **更早那份格式（允许清单）**：那时"写进清单 = 他允许了" ⇒ 原样认成 `allowed`
       *    （他当年的点头不能因为换了一版就作废）。
       */
      return { allowed: pick(j.permissions), denied: [] };
    }
    if (Array.isArray(j?.denied)) {
      return { allowed: [], denied: pick(j.denied) };
    }
    return { allowed: [], denied: [] };
  }

  /** **制品声明了哪几样**（`permissions`；读不出来 ⇒ 空数组）。 */
  #declaredOf(id) {
    try {
      const m = this.meta(id);
      const list = Array.isArray(m?.permissions) ? m.permissions : [];
      return list.filter((p) => PERMISSIONS.includes(p));
    } catch {
      return [];
    }
  }

  /**
   * **他现在能用哪几样** = **制品声明的 − 他关掉的**。
   *
   * 🔴 含义（★ 2026-09-30 起）：**没关过的就是给的** ——
   *    他自己那个小程序声明了 `db` ⇒ **当场就能存**，不用他去设置里点任何东西。
   *    ⚠️ 这**不是**"谁写进清单就自动生效"：清单是**他让助手做的那个 app** 的清单，
   *    而把某一样关掉的那一下**永远在他手里**（设置页那张卡）。
   */
  grants(id) {
    checkAppId(id);
    const { allowed, denied } = this.#grantBook(id);
    // ★ **默认不给**（主人 2026-10-01）：**清单里声明 = "它想要什么"**（弹窗的依据），
    //   真正生效要**他点头**（`allowed`）。他点过"不给"的一样不生效（`denied`）。
    // ⚠️ 同上：`db` 不算"他允许的那几样"（它本来就一直能用）。
    return this.#declaredOf(id)
      .filter((p) => p !== DB_PERMISSION)
      .filter((p) => allowed.includes(p) && !denied.includes(p));
  }

  /**
   * **他还没表过态的那几样** = 声明的 − 已允许 − 已拒绝。
   *
   * ★ 这张表是**那条"打开时弹窗"的依据**（主人 2026-10-01 选的形状）：
   *   打开一个小程序 ⇒ 拿这张表 ⇒ 非空就弹一张"它想用：… [允许] [不给]"。
   *   ⚠️ **弹过并且他拒了的，不再自动弹**（免得天天问同一件事）；**设置页里随时能改**。
   */
  unanswered(id) {
    checkAppId(id);
    const { allowed, denied } = this.#grantBook(id);
    // ⚠️ 存储（`db`）**不进这张表**：它默认就有、不用他表态（2026-10-02）。
    return this.#declaredOf(id)
      .filter((p) => p !== DB_PERMISSION)
      .filter((p) => !allowed.includes(p) && !denied.includes(p));
  }

  /**
   * **他点的那一下**（设置页的开关）：入参仍是"**他要的允许清单**"
   * （**线上协议一个字没改** —— 客户端与新老盒子都照旧传 `permissions`），
   * 内部翻译成 `denied` 落盘。
   *
   * @param {string[]} permissions 他要允许的那几样（白名单外的名字 ⇒ 抛）
   * @returns {string[]} 落盘之后**实际**能用的那几样
   */
  setGrants(id, permissions) {
    checkAppId(id);
    if (!this.has(id)) throw new AppsError('这个小程序不在你这儿');
    const keep = [];
    for (const p of permissions ?? []) {
      if (!PERMISSIONS.includes(p)) throw new AppsError(`这个权限不认识：${String(p).slice(0, 20)}`);
      if (!keep.includes(p)) keep.push(p);
    }
    const declared = this.#declaredOf(id);
    /**
     * ★ **两张表**（主人 2026-10-01 的新形状）：
     *   · `allowed` = 他点过头的那几样（**只有这个才生效**）；
     *   · `denied`  = 他点过"不给"的那几样（**不再自动弹**；设置里能改回来）。
     * ⚠️ 入参 `permissions` 仍然是"他要允许的那几样"（**线上协议一个字没改**：
     *    客户端与新老盒子照旧传这个），只是**落盘的意思变成了两张表**。
     * ⚠️ **只有"制品声明了的"才有资格进这两张表**（没声明的本来就用不了，不用记）。
     */
    const allowed = declared.filter((p) => keep.includes(p));
    const denied = declared.filter((p) => !keep.includes(p));
    writeAtomic(
      this.fs,
      nodePath.join(this.appDir(id), 'grant.json'),
      `${JSON.stringify({ allowed, denied, at: this.now() })}\n`,
      0o644,
    );
    this.#audit({ what: 'grant', id, permissions: allowed, denied });
    // ⚠️ 回的是**实际生效**的那几样（制品**没声明**的名字给了也不算数 —— 那是"声明"那道闸）
    return allowed;
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
   * ★ **把他这个 app 的数据清掉**（`148` §五 · 设置页那颗按钮背后就这一下）。
   *
   * 🔴 **它清的是"内容"，不是"壳"**：只删那个库文件（连它旁边的 `-wal`/`-shm`），
   *    **不动制品、不动工作区、也不动那个 app 本身**（它还在桌上，下次打开是一个空库）。
   * ⚠️ **拿不回来** —— 调用方（那条 HTTP 口）必须让界面**二次确认**，这一层只负责删干净。
   * ⚠️ 没有库（从没存过）⇒ 也算成了（**幂等**）：他点"清空"两次不该看到报错。
   * ⚠️ **关掉存储（`denied`）不影响这一下**：清空是"我的东西我拿走"，与"给不给它用"无关。
   */
  dbClear(id) {
    checkAppId(id);
    if (!this.has(id)) throw new AppsError('这个小程序不在你这儿');
    const file = this.dbPath(id);
    let removed = 0;
    for (const one of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      try {
        this.fs.rmSync(one, { force: true });
        removed += 1;
      } catch {
        /* 没有就算了（幂等） */
      }
    }
    this.#audit({ what: 'db-clear', id, files: removed });
    return { ok: true, removed };
  }

  /**
   * ★ **跟助手说一句的配额**（`148` §三）：和 `ask` 那一对同形（状态住 `<id>/agent.json`）。
   *
   * ⚠️ **拒绝也要说清是哪一道**（今天说得够多了 / 说得太快了）——
   *    混成一句，用户会一直重试。
   *
   * @returns {{ok:true, left:number} | {ok:false, reason:string}}
   */
  agentQuota(id, now = null) {
    checkAppId(id);
    const at = now ?? this.now();
    const day = new Date(at).toISOString().slice(0, 10);
    let st = { day, n: 0, lastAt: 0 };
    try {
      const j = JSON.parse(this.fs.readFileSync(nodePath.join(this.appDir(id), 'agent.json'), 'utf8'));
      if (j && j.day === day) st = { day, n: Number(j.n) || 0, lastAt: Number(j.lastAt) || 0 };
    } catch {
      /* 没有就是今天还没说过 */
    }
    if (st.n >= AGENT_PER_DAY) return { ok: false, reason: '今天这个小程序跟你的助手说得够多了，明天再来' };
    if (at - st.lastAt < AGENT_MIN_INTERVAL_MS) return { ok: false, reason: '说得太快了，等一下再说' };
    return { ok: true, left: AGENT_PER_DAY - st.n };
  }

  /** 记一次"跟助手说话"（**先记再花**：宁可少说一次，也不许漏账）。 */
  bumpAgent(id, now = null) {
    checkAppId(id);
    const at = now ?? this.now();
    const day = new Date(at).toISOString().slice(0, 10);
    let st = { day, n: 0, lastAt: 0 };
    try {
      const j = JSON.parse(this.fs.readFileSync(nodePath.join(this.appDir(id), 'agent.json'), 'utf8'));
      if (j && j.day === day) st = { day, n: Number(j.n) || 0, lastAt: Number(j.lastAt) || 0 };
    } catch {
      /* 同上 */
    }
    const next = { day, n: st.n + 1, lastAt: at };
    writeAtomic(this.fs, nodePath.join(this.appDir(id), 'agent.json'), `${JSON.stringify(next)}\n`, 0o644);
    return next;
  }

  /**
   * ★ **定时任务的账**（`148` §四）：`<id>/tasks.json` ⇒ `{v:1, tasks:{<id>:{lastAt,nextAt,day,n}}}`。
   *
   * ⚠️ 读不出来 ⇒ `{}`（**当作没跑过**：那一件会被排上，但**先记再跑**那道闸还在）。
   * ⚠️ 它**不删**：一件任务从清单里去掉之后，它那一行账留着（他哪天加回来，不会"一天跑十次"）。
   */
  taskState(id) {
    checkAppId(id);
    try {
      const j = JSON.parse(this.fs.readFileSync(nodePath.join(this.appDir(id), 'tasks.json'), 'utf8'));
      const out = {};
      for (const [k, v] of Object.entries(j?.tasks ?? {})) {
        if (typeof k !== 'string' || !v || typeof v !== 'object') continue;
        out[k] = {
          lastAt: Number(v.lastAt) || 0,
          nextAt: Number(v.nextAt) || 0,
          day: typeof v.day === 'string' ? v.day : '',
          n: Number(v.n) || 0,
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * **记下这一趟**（`148` §四 · **先记再跑**）：调它成功之后，调度器才会去干活。
   *
   * @param {string} id
   * @param {string} taskId
   * @param {number} at
   * @param {number} everyMs 那一件的间隔（用来算 `nextAt`）
   */
  recordTask(id, taskId, at, everyMs = 0) {
    checkAppId(id);
    const all = this.taskState(id);
    all[String(taskId)] = nextTaskState({ entry: all[String(taskId)], at, everyMs });
    writeAtomic(
      this.fs,
      nodePath.join(this.appDir(id), 'tasks.json'),
      `${JSON.stringify({ v: 1, tasks: all })}\n`,
      0o644,
    );
    this.#audit({ what: 'task-run', id, taskId: String(taskId) });
    return all[String(taskId)];
  }

  /**
   * ★ **一个小程序那一格存储在哪**（主人 2026-09-30 拍板 · 契约 `147-APP-SQLITE.md`）。
   *
   * 🔴 **一个 app 一个文件**，而且落在 `appDir(id)` 里、**`versions/` 外面**：
   *    · 发新版 ⇒ **不动它**（版本是快照，数据是活的）；
   *    · 删那个 app ⇒ **跟着它一起走**（`appDir` 整个挪进 `.removed/`）；
   *    · 按人分开 ⇒ 甲看不见乙的（`appDir` 本来就是按人的）。
   *
   * ⚠️ **路径只有这一处出处** —— 页面报的任何路径一个字节都不采信。
   */
  dbPath(id) {
    return nodePath.join(this.appDir(id), DB_FILE);
  }

  /**
   * **频率闸**（每个 app 每分钟一个数）：过了 ⇒ `true` 并**记一次**（先记再跑）。
   *
   * ⚠️ 先记再跑的理由和 `ask` 那条一样：**宁可少跑一次，也不许漏账** ——
   *    漏账的那一侧是"页面自己写个死循环，把这个盒子拖垮"。
   */
  #takeDbSlot(id, at) {
    const win = 60_000;
    const seen = (this.dbCalls.get(id) ?? []).filter((t) => at - t < win);
    if (seen.length >= DB_CALLS_PER_MINUTE) {
      this.dbCalls.set(id, seen);
      return false;
    }
    seen.push(at);
    this.dbCalls.set(id, seen);
    return true;
  }

  /**
   * ★ **替它跑一条**（`run` / `get` / `all`）—— **一个小程序一个独立的 SQLite**。
   *
   * ── 顺序（一道都不许省）──────────────────────────────────
   *   ① `checkAppId`（形状）→ ② 这个 app 在他的吗 → ③ **制品声明了吗** →
   *   ④ **他允许了吗** → ⑤ 语句 / 参数过一遍 → ⑥ 频率 → ⑦ **子进程里跑，超时就杀**。
   *
   * 🔴 **它是 `async`**：执行那一步是**子进程**（还可能被杀），而且租户那一侧
   *    这一条要过隧道（盒子里那份才是权威，见 `apps-box.js`）。
   *
   * ⚠️ **绝不抛业务错**：该拒的都回 `{ok:false,status,error,text}` —— 调用方（那条 HTTP 口）
   *    只管照着回。**抛**只留给"这个 app 根本不在他这儿"这种接线错误。
   *
   * @param {string} id
   * @param {{op?:string, sql?:unknown, params?:unknown}} req
   * @returns {Promise<{ok:true, rows:any[], changes:number, lastInsertRowid:number, truncated:boolean}
   *                   | {ok:false, status:number, error:string, text:string}>}
   */
  async dbExec(id, req = {}) {
    checkAppId(id);
    const m = this.meta(id);
    if (m === null) throw new AppsError('这个小程序不在你这儿');
    // ★ **2026-10-02：存储是基本能力** —— 不再看"声明了没有/他点头了没有"
    //   （见 `app-db.js` 的 `checkAppDb` 那段批注）。
    const verdict = checkAppDb({ op: req?.op, sql: req?.sql, params: req?.params });
    if (verdict.ok !== true) {
      // 拒的那几档**留痕**（"谁想干什么被拦了"要查得到；成了的不写，量太大）
      this.#audit({ what: 'db-deny', id, error: verdict.error });
      return { ok: false, status: verdict.status, error: verdict.error, text: verdict.text };
    }
    if (!this.#takeDbSlot(id, this.now())) {
      this.#audit({ what: 'db-rate', id });
      return { ok: false, status: 429, error: 'too-many', text: DB_TOO_MANY_TEXT };
    }
    try {
      this.fs.mkdirSync(this.appDir(id), { recursive: true, mode: 0o755 });
    } catch {
      /* 建不出来 ⇒ 下面那一步会如实说取不到 */
    }
    const r = await runDbChild({
      file: this.dbPath(id),
      op: req?.op,
      sql: verdict.sql,
      params: verdict.params,
      // ⚠️ 子进程的 cwd 就是这个 app 自己那一格：万一哪条语句里有相对路径，
      //    也落不出它自己的地界（`ATTACH` 那一档另有 authorizer 拦）
      cwd: this.appDir(id),
    });
    if (r.ok !== true) {
      // 满了是**存储**那一档（507）；太久 / 太频繁是**等一下再试**那一档；其余是这一条 SQL 自己的问题
      const status = r.error === 'full' ? 507 : r.error === 'timeout' ? 503 : 400;
      if (r.error === 'full') this.#audit({ what: 'db-full', id });
      return { ok: false, status, error: r.error, text: r.text === DB_FULL_TEXT ? DB_FULL_TEXT : r.text || DB_ERROR_TEXT };
    }
    return r;
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
    const live = this.#readMeta(id);
    // 认不出 / 不在他这儿 ⇒ 404（`status` 不写，由调用方按老规矩当 404）
    if (version === null && live === null) throw new AppsError('这个小程序不在你这儿');
    const name = typeof title === 'string' ? title.trim() : '';
    // 空名字 / 太长 ⇒ 400 ＋ 人话
    if (name.length === 0) throw new AppsError('名字不能是空的', 400);
    if (name.length > MAX_TITLE_CHARS) {
      throw new AppsError(`名字太长（上限 ${MAX_TITLE_CHARS} 个字）`, 400);
    }
    // ★ `114`：活的那一份 —— 名字改在**登记**上（桌面显示的就是它 `meta()`）
    if (live !== null) {
      writeAtomic(this.fs, this.metaPath(id), `${JSON.stringify({ ...live, title: name }, null, 2)}\n`, 0o644);
    }
    // 有包的那一份：清单里的名字照旧跟着改（老行为一个字不变）
    if (version !== null) {
      const m = this.manifest(id, version);
      if (!m) {
        if (live === null) throw new AppsError('这个小程序的清单坏了，改不了名字');
      } else {
        writeAtomic(
          this.fs,
          nodePath.join(this.versionDir(id, version), 'manifest.json'),
          `${JSON.stringify({ ...m, title: name }, null, 2)}\n`,
        );
      }
    }
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
    const liveMeta = this.#readMeta(id);
    if (from === null && liveMeta === null) throw new AppsError('这个小程序不在你这儿');
    const newId = this.#freeCopyId(id);
    const title = this.#freeCopyTitle(liveMeta?.title ?? this.manifest(id, from)?.title ?? '');

    // ── ★ `114`：**活的那一份**（他自己造的、还没有包）──────────────────
    //    它没有 `versions/` 可搬 ⇒ 复制的是**他正在改的那间工作区里的字节**
    //    （`104` §三那条"字节一模一样"照旧成立：源工作区 → 新工作区，逐字节）。
    //    ⚠️ 新那一间照旧**是空的**：只复制东西，不复制那一段经历（用量/授予/血缘/对话都不进）。
    if (from === null) {
      const ws = this.#liveWorkspaces();
      if (!ws) throw new AppsError('这一份是活的，复制它要从工作区那一侧走（这儿没接上）');
      const src = ws.read(id);
      ws.ensure(newId, { title, entry: liveMeta.entry ?? src.entry });
      ws.write(newId, src.files);
      const m = this.register({
        id: newId,
        title,
        icon: liveMeta.icon,
        entry: liveMeta.entry ?? src.entry,
        permissions: liveMeta.permissions ?? [],
        createdBy: 'user',
      });
      this.#audit({ what: 'copy', id, newId, title });
      return { id: newId, title: m.title };
    }

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
    if (!this.has(id)) throw new AppsError('这个小程序不在你这儿');
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
   *
   * ── ★ 92 §③ 阶段 5：这里是**能力体版本边**（三条登记边里的第一条）──────
   * 🔴 **它是"只增"的那一条**：`lineage.json` 只有追加，**没有任何一条删边的路**
   *    （这个类里没有 `removeLineage`／`unlink lineate.json`；本函数也只 `push`）。
   * 🔴 **来源只许是 `baseRootHash`（64 位十六进制）**：正式记录走
   *    [`capabilityEdgeOf`]（`src/method-edge.js`）——它当场核"那个起点在我们这儿立得住"。
   * 🔴 **经验／数据的"来源"不许塞进这条边**（92 §③ 阶段 5 第二条判据）：
   *    那两样各有自己的边与自己的登记处（经验 → `methodEdge*`；数据 → `delivery/*`）。
   *    塞进来 ⇒ **当场拒**（见下面的白名单）。理由：血缘是**能力体**那一族的关系，
   *    混进别人的来源之后，"这个 app 是从哪一版长出来的"这件事就说不清了。
   *
   * @param {object} entry 白名单：`kind` · `baseRootHash` · `baseVersion` · `myVersion`
   *   （`at` 由这里填）。**别的键一律拒** —— 那是别的边的东西。
   */
  noteLineage(id, entry = {}) {
    checkAppId(id);
    if (!this.has(id)) throw new AppsError('这个小程序不在你这儿');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppsError('血缘边要是一条记录');
    }
    // 🔴 **只收能力体版本边自己的字段**（92 §③ 阶段 5）—— 多一个都不收。
    const LIN_KEYS = ['kind', 'baseRootHash', 'baseVersion', 'myVersion'];
    const foreign = Object.keys(entry).filter((k) => k !== 'at' && !LIN_KEYS.includes(k));
    if (foreign.length > 0) {
      throw new AppsError(
        `血缘边只记能力体那一族（根 hash 与版本），收不了这些：${foreign.join('、')}`
        + ' —— 经验／数据的来源住它们自己那条登记边（不在 app 血缘里）',
      );
    }
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
