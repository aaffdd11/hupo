// **"这一台现在有没有钥匙"** —— 给客户端的那两个字段（契约 `docs/dev/48-SETTINGS-KEY.md`）。
//
// 为什么单立成纯函数：配置那一屏要**如实**区分三种状态，而它们的判断原来散在
// `serve.js` 一段长长的对象字面量里（那种地方进不了 `test/unit`，也就没人钉得住）：
//
//     ① 还没填过          ⇒ `hasKey:false, keyBad:false`
//     ② 有（能用的）      ⇒ `hasKey:true,  keyBad:false`
//     ③ 填过、但上游说它不灵 ⇒ `hasKey:false, keyBad:true`
//
// ⚠️ ③ 原来在客户端看来和 ① **一模一样**（都是 `hasKey:false`）——
//    于是界面只能说"还没有填"，而用户明明填过、还被拒了（`00-PROGRESS` §六 #34 那一条）。
//
// ── 两个来源取"或"（这是 2026-09-21 那个 bug 的修法）──────────
//   `hasKeyPushed`   = 宿主内存里记着"我送过"（**宿主一重启就忘**）
//   `hasKeyReported` = **容器自己报的**（它真的拿着）—— 这个才是权威
//   ⚠️ 少了后者，宿主一重启就会**再问用户要一次钥匙**（主人亲报过："刷新后又要我输入 apikey"）。

/**
 * @param {object} o
 * @param {boolean} [o.hasKeyPushed]    宿主内存里有没有"我送过"这条记忆
 * @param {boolean} [o.hasKeyReported]  容器有没有自报"我这儿有"
 * @param {boolean} [o.rejected]        上游有没有说过"这把不灵"
 * @returns {{hasKey: boolean, keyBad: boolean}}
 */
export function keyStateOf({ hasKeyPushed = false, hasKeyReported = false, rejected = false } = {}) {
  const keyBad = rejected === true;
  // ⚠️ **被拒的那把不算"有"**（它已经被容器删掉了），而 `keyBad` 要说出来 ——
  //    两者不是一回事：前者是"现在能不能用它"，后者是"为什么没有"。
  return { hasKey: !keyBad && (hasKeyPushed === true || hasKeyReported === true), keyBad };
}
