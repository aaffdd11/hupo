// 连"流"的那个地址怎么算。
//
// ⚠️ **这里出过一次事故，而且是那种"每道闸都绿、用户那里全黑"的事故。**
//
// 原来的写法是：
//
//     final scheme = base.startsWith('https') ? 'wss' : 'ws';
//
// 在 web 上 `base` **恒为空串**（同源；没有 `HUPO_API` 之类的东西，见 `api.dart`），
// 而 `''.startsWith('https')` 是 `false` ⇒ 在 **https 页面**上拼出了 `ws://`。
//
// 后果：浏览器按**混合内容**直接拦掉（同步抛 `SecurityError`，`ready` 都不会到）。
// 而页面本身、登录、`/api/version`、关于页——**全是同一个源上的相对路径，照常工作**。
// 于是屏幕上的表现是「网断了，我在等它回来」，看起来像网络问题，
// 实际是**这一跳被浏览器拒了**；而 `w.stalkerai.cn` 的 http 会 301 到 https
// ⇒ **这条路从来没通过一次**。
//
// 为什么闸没拦住：验收用的是 node 探针，而探针**把 `wss://` 写死了**
// （`new WebSocket('wss://w.stalkerai.cn/api/stream', …)`），
// 它**绕过了这个函数**，于是它测的从来不是客户端真正会发的东西。
// ⇒ 探针绿 ≠ 浏览器行。**凡是"客户端自己算出来的东西"，闸必须打在客户端这一侧。**
//
// 所以现在：**同源时看页面自己的协议，跨源时看 `base` 的协议。**
// 纯函数，`test/unit/stream_uri_test.dart` 钉住（含一条 https 页面**不许降级**的金丝雀）。

/// 算出流该往哪儿连：`wss://<host>/api/stream?sinceSeq=<n>`。
///
/// * [base] 空串 = **同源**（生产就是这个），协议取 [page]（浏览器地址栏里的那个）。
/// * [base] 非空 = 跨源调试用，协议取它自己的。
/// * [sinceSeq] 是续传起点（断线重连时带上，服务端从这里把缺的补回来）。
Uri streamUri({
  required String base,
  required Uri page,
  required int sinceSeq,
}) {
  final raw = base.trim();
  final origin = raw.isEmpty
      ? page
      : raw.contains('://')
          ? Uri.parse(raw)
          // 只写了主机名（本机调试常见）：当作明文
          : Uri.parse('http://${raw.replaceAll(RegExp(r'/+$'), '')}');

  // ⚠️ 用 `hasPort` 而不是 `port`：`port` 会给默认端口填上 443/80，
  //    拼进 URL 就会变成一个多余的 `:443`。
  final host = '${origin.host}${origin.hasPort ? ':${origin.port}' : ''}';
  final scheme = origin.scheme == 'https' ? 'wss' : 'ws';
  return Uri.parse('$scheme://$host/api/stream?sinceSeq=$sinceSeq');
}
