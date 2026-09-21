// 从令牌里读出"这是谁" —— **只用来给本机缓存分命名空间**。
//
// 为什么要它（`docs/dev/38-ISOLATION-SPLIT.md` §8.1/§8.2）：
//   客户端原来**一个地方都不解析令牌**，两个 store 的 `namespace` 都停在默认值
//   `'single'` ⇒ **全站共用一份缓存**。共用设备上换个人登录，
//   他会先看到上一个人的整屏、**连他打了一半的草稿一起**；他一发，
//   那句话就进了另一个人的账本。
//
// ── 四条纪律（少一条就会变成安全洞）────────────────────────
//   1. 🔴 **不验签、不判断权限**。验签是**服务端**的事（`08-SPEC.md` §15.5：
//      客户端不做鉴权）。这里读出来的东西**只当缓存键**，任何"因为令牌里写了
//      sub 就让他看某个东西"的用法都是错的。
//   2. 🔴 **读不出来就返回 `null`**（畸形 / 空的 / 没有 sub / 形状不对）——
//      **绝不猜**。猜错的方向是"拿别人的缓存当自己的"。
//   3. 🔴 **把它当不可信输入**：令牌是**服务端发的**，但客户端**没有验过签**，
//      所以这一段的字节是**请求方可控的**。⇒ 形状必须卡死（见 [subShape]），
//      否则一个被改过的令牌能让它变成一个奇怪的 `SharedPreferences` 键。
//   4. **纯函数**（只用 `dart:convert`，不碰 I/O）⇒ 进 `test/unit` 逐条钉。

import 'dart:convert';

/// `sub` 该长什么样。**与服务端 `tenants.safeUserId()` 是同一套形状**。
///
/// ⚠️ 两边必须一致：服务端拿它当**目录名**，客户端拿它当**缓存键**。
///    在这边放宽一位，就会多出一类"服务端不肯当目录名、客户端却拿它当键"的值。
final RegExp subShape = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

/// 读不出 `sub` 时用的命名空间。
///
/// ⚠️ **它刻意就是多租户之前那个默认值**（`'single'`）。三条理由：
///   1. **它不是任何真人的键**：真人的键是 `sub`（`owner` / `u1` / …），
///      所以"读不出身份"**不会**撞上别人的缓存；
///   2. **它让"读不出"退回旧行为**——多租户之前全站共用 `'single'`，
///      所以退回它不会让一台老设备上的旧缓存凭空消失；
///   3. 退出登录会把**所有**命名空间清掉（含它），所以它不会留到下一次。
///
/// 🔴 **它配着一条闸**：万一客户端哪天**解不开真令牌**了（服务端换了编码），
///    所有人会**静默退回同一个命名空间**——那正是多租户要修的那个串号。
///    ⇒ 所以有一条判据专门盯"**真令牌的形状解得开**"
///    （`test/unit/cache_namespace_test.dart` 的头一条）。那条红了就说明
///    这个兜底正在被大规模使用，**不是**"兜底很安全"。
const String cacheNamespaceFallback = 'single';

/// 从令牌里读出 `sub`；读不出来就 `null`。
///
/// 令牌的形状是 `<base64url(payload)>.<签名>`（服务端 `auth.js` 的 `issue()`）：
/// 载荷是 JSON，`sub` 就是 userId。**签名那一段这里完全不看。**
String? subFromToken(String? token) {
  if (token == null) return null;
  // ⚠️ 只看**第一个** `.` 之前那一段：签名本身是 base64url，不含 `.`，
  //    但"多点一个"这种畸形输入不该被当成合法的。
  final dot = token.indexOf('.');
  if (dot <= 0) return null;
  final body = token.substring(0, dot);
  if (body.isEmpty) return null;

  final Object? decoded;
  try {
    // Node 的 `base64url` **不带 padding**，dart 的 `decode` 要求带
    // ⇒ 先 `normalize()` 补齐（少这一步，真令牌一律解不开）。
    decoded = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(body))));
  } catch (_) {
    // 解不开就是解不开：畸形 / 不是 JSON / 不是 UTF-8 —— 一律 null，**不猜**
    return null;
  }
  if (decoded is! Map) return null;
  final sub = decoded['sub'];
  if (sub is! String) return null;
  // 🔴 形状卡死（纪律 3）：不验签 ⇒ 这一段不可信
  return subShape.hasMatch(sub) ? sub : null;
}

/// 该给缓存用哪个命名空间。读不出 `sub` 时退回 [cacheNamespaceFallback]。
String cacheNamespaceOf(String? token) => subFromToken(token) ?? cacheNamespaceFallback;
