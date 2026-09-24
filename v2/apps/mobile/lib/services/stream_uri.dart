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
//
// ── 批 3：地址上多带一个 `level`（过程四档）────────────────────
//
// `level` 是**连接级**的：服务端按每条连接决定发多少过程
// （`docs/dev/26-PROCESS-LEVELS.md` §三）。⇒ 它必须跟着地址走，
// **不能**连上之后再补发一个"改档"的帧（那会变成全局开关）。
// 契约：不带 = `doing`；客户端**永远带上**，好让"用户在哪个档"这件事
// 在服务端和客户端只有一种理解。
//
// ── 批 4：地址上再多带一个 `scope`（一个图标 = 一条对话）──────────
//
// 契约 `docs/dev/83-APP-WORKSPACE.md` §六·4（§五 定的是**甲**：跟着图标走）：
// 打开某个"我的小程序"⇒ 下面那条聊天就是**它的**对话 ⇒ 那条流也得连到它那一间。
// `scope` 和 `level` **同一类**：**连接级**的（服务端按每条连接决定补发哪一间、
// 订阅哪一间）⇒ 切房间**只能靠重连**，不能连上之后再补一帧。
// 契约：不带 = `main`；客户端**永远带上**（和 `level` 一个道理：
// "在哪个房间"在服务端与客户端只许有一种理解）。
//
// ⚠️ **这一刀一个字都不许动那个老坑**：协议还是 [_wsOrigin] 算的
//    （`ws://` vs `wss://` 那次事故，见 `16-STREAM.md`）——
//    `scope` 只是往后面接一个参数，**不是**第二个地址构造入口。

import '../models/process_levels.dart';
import '../models/scope.dart';

/// 算出流该往哪儿连：
/// `wss://<host>/api/stream?sinceSeq=<n>&level=<档>&scope=<房间>`。
///
/// * [base] 空串 = **同源**（生产就是这个），协议取 [page]（浏览器地址栏里的那个）。
/// * [base] 非空 = 跨源调试用，协议取它自己的。
/// * [sinceSeq] 是续传起点（断线重连时带上，服务端从这里把缺的补回来）。
/// * [level] 过程四档（契约 §三）。默认 [defaultProcessLevel] = `doing`。
/// * [scope] 房间（契约 `83` §五·甲）。默认 [mainScope] = 桌面上那条主对话。
///
/// ⚠️ **令牌不进地址**（走子协议 `['bearer', token]`，手册 §2.1）——
///    这里多出来的只有 `scope` 这一个**不是秘密**的东西。
Uri streamUri({
  required String base,
  required Uri page,
  required int sinceSeq,
  ProcessLevel level = defaultProcessLevel,
  String scope = mainScope,
}) => Uri.parse(
  '${_wsOrigin(base: base, page: page)}/api/stream'
  '?sinceSeq=$sinceSeq&level=${level.wire}&scope=${Uri.encodeQueryComponent(scope)}',
);

/// 算出**语音那条**该往哪儿连：`wss://<host>/api/asr`（主人 2026-09-23：真开麦）。
///
/// 🔴 它和上面那条**共用同一个算地址的函数**（[streamUri] 顶上记着那次事故：
///    "客户端自己算地址、闸却打在另一侧" ⇒ 每道闸都绿、用户那里全黑）。
///    ⇒ 语音这条**不许再拼一遍**，否则同一个坑会有第二个入口。
///    判据：`test/unit/stream_uri_test.dart`（含 https 页面**不许降级**的金丝雀）。
Uri asrUri({required String base, required Uri page}) =>
    Uri.parse('${_wsOrigin(base: base, page: page)}/api/asr');

/// 算出**「我自己那台」那条**该往哪儿连：`wss://<host>/api/harness`
/// （契约 `docs/dev/81-HARNESS-ENTRY.md` §5.1）。
///
/// 🔴 它和上面两条**共用同一个算地址的函数**（[streamUri] 顶上记着那次事故：
///    "客户端自己算地址、闸却打在另一侧" ⇒ 每道闸都绿、用户那里全黑）。
///    ⇒ 这一条**不许再拼一遍** `ws://`，否则同一个坑会有第三个入口。
///    令牌用法与 `/api/stream` 完全一致（子协议 `['bearer', token]`，不进 URL）。
///    判据：`test/unit/stream_uri_test.dart`（含 https 页面**不许降级**的金丝雀）。
Uri harnessUri({required String base, required Uri page}) =>
    Uri.parse('${_wsOrigin(base: base, page: page)}/api/harness');

/// `wss://<host>`（不带路径）：同源看页面协议，跨源看 `base` 的协议。
String _wsOrigin({required String base, required Uri page}) {
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
  return '$scheme://$host';
}
