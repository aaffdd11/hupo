// **小程序那一帧的形状**（手册 `08-SPEC.md` §2.2 · 契约 `docs/dev/111-APP-LIVE-UPDATE.md`）。
//
// 🔴 **为什么单独一个模块**：这一帧的**形状**与**认法**只许有一处 ——
//    否则"服务端推的那份"和"客户端认的那份"各写一遍，迟早漂
//    （手册 §2.2 那张表就是被这种漂咬过的）。
// ⚠️ 与 `job.js` 里那几帧同一条纪律：**只加不改** ——
//    旧客户端认不出的类型会**安静忽略**（`models/timeline.dart` 那句"向前兼容"）。

/**
 * **制品换了一版**那一帧。
 *
 * 🔴 **持久**（有号、落盘、重连/切回来补得上）——它落在**那条可见日志**上，
 *    与 `app/installed`（瞬态）刻意不同：装上了是"现在这一刻的事"，
 *    而"有一版新的"是**盘上的事实**（他离线时发的那一版，回来还得知道）。
 * 🔴 **`scopeId` = 那个 app 的 id**（由调用方 `ScopeView.emit` 盖，见 `worlds.js`）⇒
 *    实时那一侧按焦点路由（`server.js`），**只有正开着这一间的那条连接收得到**。
 */
export const APP_UPDATE_AVAILABLE = 'app/update-available';

/**
 * 那一帧的形状（**只有这一处**：推送与判据都用它）。
 *
 * 🔴 **帧里不许有签名 URL**：`entryUrl` 是**短时效**的（绑人 + 绑版本 + 现签），
 *    落进那条日志就是一句**迟早变假的话**；而且那条日志**同一个人的每条连接都读得到**
 *    （多作用域只是同一份日志上的标签）—— 签名不该跟着走。
 *    ⇒ 这里只给 `id` + `version`：**客户端拿这个自己去 `/api/apps` 现取**
 *      （那里会给**新那一版**现签的 `entryUrl`）。
 *
 * @param {object} o
 * @param {string} o.id       哪个小程序（制品库里那个 id ＝ 那一间的名字）
 * @param {number} o.version  新那一版的版本号
 * @param {number} [o.at]     什么时候（缺省 = 现在）
 */
export function appUpdateAvailableEvent({ id, version, at = Date.now() } = {}) {
  return {
    type: APP_UPDATE_AVAILABLE,
    id: String(id),
    version: Number(version),
    at,
  };
}

/**
 * 认一帧是不是它，并把要用的两个字段取出来。
 *
 * 两半共用同一份读法：服务端判据读它、客户端 `ChatController.ingest` 也照这条规则
 * （形状不对 / 版本号不合法 ⇒ **安静忽略**，绝不猜一个版本号出来）。
 *
 * @param {object} event
 * @returns {{id:string, version:number}|null} `null` = 不是这一帧 / 认不出
 */
export function appUpdateOf(event) {
  if (!event || event.type !== APP_UPDATE_AVAILABLE) return null;
  const id = event.id;
  const version = event.version;
  if (typeof id !== 'string' || id === '') return null;
  if (!Number.isInteger(version) || version < 1) return null;
  return { id, version };
}
