// **宿主 ↔ 盒子：小程序库的那条桥**（B15 · `docs/dev/77-BLOCKERS.md` 那一行）。
//
// ── 它修的是什么 ──────────────────────────────────────────
// 小程序有过**两处库**：
//   · 桌面读的是**宿主**那份（`data/users/<id>/hupo/apps/`）；
//   · 助手写的是**盒子里**那份（盒内 `/data/hupo/apps/`）。
// ⇒ 主人新做的小程序**永远不上桌面**（页面在说假话）。主人 2026-09-25 拍板：
//   **以盒子里那份为准**。
//
// ── 这一层怎么修（两条路，别读成一条）──────────────────────
//   ① **盒子那侧**：在**可信 UDS**（`trusted === true` 那条，公网口接不上）上开三个
//      **极小的内部口** —— 列清单 / 取字节 / 收一次创建。它们**不验签**（验签在宿主），
//      也**不认识令牌**（身份就是"你从哪条 UDS 进来的"，由内核的文件权限保证）。
//   ② **宿主那侧**：`/api/apps` 与制品口对**租户用户**不再读本机那份，而是**经现有隧道**
//      去问他的盒子；拿回来的清单由宿主**用它自己的 `appsSignKey` / `appsBase` 现签**
//      （公开基址与签名键在宿主这边是权威 —— 这正是**不**把整条路由塞进 `TENANT_ROUTES`
//      的理由：塞进去就等于让盒子去签名，而盒子的公开基址不一定对）。
//
// ── 三条不许破 ────────────────────────────────────────────
//   ① 🔴 **先验签，再碰盒子**：制品的顺序一个字都没动（`app-serve.js` 里那一步）。
//      这一层只负责"验完签之后去哪儿取字节"。
//   ② 🔴 **失败就说失败**：盒子不通 ⇒ 抛 `BoxError`，调用方**如实回 503/403**，
//      **绝不许**悄悄退回宿主那份旧的（那正是这次要修的病）。
//   ③ 🔴 **内部口只在可信口上**：公网口走到那三条路径 ⇒ 404，而且**一次都不碰**库。
//
// ⚠️ 这里是**同进程的两侧**：宿主与盒子跑的是同一份代码（`serve.js` 两边都跑）。
//    靠 `trusted` 这个参数分开 —— 它在 `listenTrusted` 那条 UDS 上恒为 `true`。

import nodeHttp from 'node:http';

import { AppsError } from './apps.js';

/** 内部口的前缀。**不带 `/api/`**：它故意不在那套令牌语义里（见文件头）。 */
export const INTERNAL_PREFIX = '/internal/';

/** 列清单。 */
export const BOX_APPS_PATH = '/internal/apps';
/** 取一个制品的字节。 */
export const BOX_ARTIFACT_PATH = '/internal/artifact';
/** 收一次创建（**迁移用**：走盒子自己那条写入路，版本/清单/权限语义一致）。 */
export const BOX_APP_PATH = '/internal/app';

/**
 * 一次内部请求最多等多久。
 *
 * ⚠️ 必须有上限：隧道那头要是不回话，这个请求会**一直挂着** ——
 *    而客户端看到的是"转圈"（本项目最忌的"看起来在跑"）。
 */
export const BOX_TIMEOUT_MS = 15_000;

/** 盒子这条路上出的错。**人话**，而且带一个 `why` 给调用方分岔。 */
export class BoxError extends Error {
  constructor(message, why = 'box') {
    super(message);
    this.name = 'BoxError';
    this.why = why;
  }
}

/**
 * 认一条内部路径。**认不出来一律 `null`**（不猜）。
 *
 * ⚠️ 它是**两侧共用**的：盒子那侧据此决定"这是不是内部口"，
 *    判据里也用它钉住"公网口接不上那三条"。
 */
export function parseInternalPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(INTERNAL_PREFIX)) return null;
  if (pathname === BOX_APPS_PATH) return { kind: 'list' };
  if (pathname === BOX_APP_PATH) return { kind: 'create' };
  if (pathname === BOX_ARTIFACT_PATH) return { kind: 'artifact' };
  return null;
}

/** 把 `/internal/artifact?...` 的查询解出来。**缺一样就 `null`**（不猜）。 */
export function parseArtifactQuery(search) {
  const q = new URLSearchParams(typeof search === 'string' ? search : '');
  const id = q.get('id') ?? '';
  const version = q.get('version') ?? '';
  const rel = q.get('rel') ?? '';
  if (!id || !version || !rel) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  if (!/^[1-9][0-9]*$/.test(version)) return null;
  return { id, version, rel };
}

/**
 * **一次请求走完一条已经连上的隧道**（把那条 `Duplex` 当 socket 塞给 `http.request`）。
 *
 * ⚠️ 用它而不是自己写解析：HTTP 的序列化/解析**不用自己写**
 *    （也就少一整类"自己写解析器写错"的事）—— 和 `proxyToTenant` 同一条理由。
 * ⚠️ 收工一定把这条隧道**掐掉**：一次内部请求一条隧道，留着就是泄漏。
 */
export function requestOverSocket(sock, {
  method = 'GET',
  path,
  headers = {},
  body = null,
  timeoutMs = BOX_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new BoxError('盒子没应（超时）', 'timeout')), timeoutMs);
    timer.unref?.();
    function finish(err, val) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* 已经没了 */
      }
      if (err) reject(err);
      else resolve(val);
    }
    const up = nodeHttp.request(
      { createConnection: () => sock, method, path, headers },
      (upRes) => {
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () =>
          finish(null, {
            status: upRes.statusCode ?? 0,
            headers: upRes.headers,
            body: Buffer.concat(chunks),
          }),
        );
        upRes.on('error', (e) => finish(e));
      },
    );
    up.on('error', (e) => finish(e));
    up.end(body === null ? undefined : body);
  });
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/** 拿一条隧道；没有就抛（`why:'unreachable'` —— 调用方据此如实回 503/403）。 */
function dialOnce(dial) {
  let sock = null;
  try {
    sock = dial();
  } catch (err) {
    throw new BoxError(`你那台现在连不上：${err?.message ?? err}`, 'unreachable');
  }
  if (!sock) throw new BoxError('你那台现在连不上（隧道没通）', 'unreachable');
  return sock;
}

/**
 * **宿主这一侧：把盒子那份库当成一个 `Apps` 来用。**
 *
 * ⚠️ 形状故意和 `src/apps.js` 的 `Apps` 对齐（`list` / `read`），
 *    这样 `/api/apps` 与制品口**只换了一个取值来源**，别的判断一处都不用改。
 * ⚠️ 两个方法都是**异步**的（要过隧道）—— 调用方必须 `await`。
 * ⚠️ **懒dial**：造这个对象**不碰隧道**（签不过的请求连 dial 都不会发生，
 *    这正是判据 B15-2 的反例要盯的那件事）。
 *
 * @param {object} o
 * @param {string} [o.sub]       谁（只进日志/排障）
 * @param {()=>any} o.dial       拿一条到**他盒子**的隧道；`null` = 不通
 * @param {(m:string)=>void} [o.log]
 */
export function createBoxApps({ sub = 'owner', dial, log = () => {} } = {}) {
  if (typeof dial !== 'function') throw new BoxError('dial 必填');
  return {
    /** 盒子里那份清单（形状与 `Apps.list()` 逐字段相同）。 */
    async list() {
      const r = await requestOverSocket(dialOnce(dial), { path: BOX_APPS_PATH });
      if (r.status !== 200) {
        throw new BoxError(`盒子里那份清单读不出来（HTTP ${r.status}）`, 'bad-status');
      }
      const j = parseJson(r.body);
      if (!j || !Array.isArray(j.apps)) throw new BoxError('盒子里那份清单看不懂', 'bad-json');
      return j.apps;
    },
    /** 盒子里那份的字节（`Apps.read()` 的形状）。 */
    async read(id, version, rel) {
      const q = new URLSearchParams({ id: String(id), version: String(version), rel: String(rel) });
      const r = await requestOverSocket(dialOnce(dial), { path: `${BOX_ARTIFACT_PATH}?${q}` });
      if (r.status === 404) throw new AppsError('制品里没有这个文件');
      if (r.status !== 200) {
        log(`盒子取字节不过（${id}）：HTTP ${r.status}`);
        throw new BoxError(`盒子那边取不到这个文件（HTTP ${r.status}）`, 'bad-status');
      }
      return {
        content: r.body,
        contentType: String(r.headers['content-type'] ?? 'application/octet-stream'),
      };
    },
    /**
     * **往盒子里写一版**（`Apps.create()` 的形状；迁移那一条唯一用它）。
     * ⚠️ 它落在盒子自己那条写入路上 ⇒ 版本 / 清单 / 权限语义与助手造 app 时一致。
     */
    async create(app) {
      return boxPushApp({ dial, app });
    },
    /** 只给排障看：这个对象代表谁的盒子。 */
    get sub() {
      return sub;
    },
  };
}

/**
 * **把一版制品推进盒子**（存量迁移那一件唯一的写口）。
 *
 * 🔴 它落在**盒子自己那条写入路**上（`Apps.create()`），
 *    所以版本号 / 清单 / 权限语义与助手自己造 app 时**逐字相同** ——
 *    不是"往它的卷里撒一堆文件"。
 *
 * @returns {Promise<object>} 盒子里那一版的 manifest
 */
export async function boxPushApp({ dial, app, timeoutMs = BOX_TIMEOUT_MS }) {
  const files = {};
  for (const [rel, buf] of Object.entries(app.files ?? {})) {
    files[rel] = Buffer.from(buf).toString('base64');
  }
  const payload = Buffer.from(
    JSON.stringify({
      id: app.id,
      title: app.title,
      icon: app.icon,
      entry: app.entry,
      files,
      permissions: app.permissions ?? [],
      createdBy: app.createdBy ?? 'user',
      createdTurn: app.createdTurn ?? null,
    }),
    'utf8',
  );
  const r = await requestOverSocket(dialOnce(dial), {
    method: 'POST',
    path: BOX_APP_PATH,
    headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
    body: payload,
    timeoutMs,
  });
  const j = parseJson(r.body);
  if (r.status !== 200 || !j?.ok) {
    throw new BoxError(j?.error ?? `盒子那边没写进去（HTTP ${r.status}）`, 'create-failed');
  }
  return j.manifest;
}
