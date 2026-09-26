// **容器里现在装着的那一帧制品**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）。
//
// ── 它是什么 ─────────────────────────────────────────────
// `ChatScreen` 把"现在开着的那一个小程序"交给它：一条 `entryUrl` = 一帧。
// 版本换了 ⇒ 服务端 `/api/apps` 现签一条**新的** `entryUrl` ⇒ 这里换成新的一帧
// ⇒ Web 那一侧 `viewId` 跟着变（`miniViewIdOf`）⇒ **iframe 换掉**，
// 而且**不用他刷新、不用他关掉重开**。
//
// 🔴 **旧那一帧收干净**是这个 Widget 的活（判据 U5）：
//    · `miniViewLedger.unhost(旧的)`（不收了的话，老那条全局监听会把新页面的
//      "问一句"再送一次 —— 那是**多花一次他的额度**）；
//    · `releaseMiniAppView(旧的)`（Web 那一侧真去退订；非 Web 那一侧是空操作）。
//    ⚠️ **`registered` 那本账不许销**（平台那边同一个 viewType 只许注册一次 ——
//       `mini_runtime_web.dart` 的 `registerViewFactory`，重复注册当场抛）。
//
// ⚠️ 为什么"换没换"要钉在**这一层**：`flutter test` 跑在 VM 上（那里
//    `mini_runtime` 是 stub、没有 `dart:html`）⇒ 判据只能读**这一层**的
//    `entryUrl` / `viewId`（判据 U2/U3 就是这么打的）。

import 'package:flutter/widgets.dart';

import '../models/mini_frame.dart';
import 'mini_runtime.dart';

class MiniAppFrame extends StatefulWidget {
  const MiniAppFrame({
    super.key,
    required this.entryUrl,
    required this.title,
    this.onAsk,
  });

  /// 服务端**现签**的入口 URL（绑人 + 绑版本 + 短时效）。
  final String entryUrl;

  /// 容器顶上那行字（由容器给，制品自己不许画）。
  final String title;

  /// 那条唯一的回话通道（乙-4b）。
  final Future<String> Function(String prompt)? onAsk;

  /// 这一帧的 `viewId`（换版本 ⇒ 换它）。
  String get viewId => miniViewIdOf(entryUrl);

  @override
  State<MiniAppFrame> createState() => _MiniAppFrameState();
}

class _MiniAppFrameState extends State<MiniAppFrame> {
  late String _viewId = miniViewIdOf(widget.entryUrl);

  @override
  void initState() {
    super.initState();
    miniViewLedger.host(_viewId);
  }

  @override
  void didUpdateWidget(covariant MiniAppFrame old) {
    super.didUpdateWidget(old);
    final next = miniViewIdOf(widget.entryUrl);
    if (next == _viewId) return;
    // 🔴 **换了一帧**：先把旧那一帧收干净，再挂新的（顺序刻意 —— 反过来的话
    //    中间那一刻两帧都"挂着"，一条消息会被处理两遍）。
    _drop(_viewId);
    _viewId = next;
    miniViewLedger.host(_viewId);
  }

  @override
  void dispose() {
    _drop(_viewId);
    super.dispose();
  }

  /// 收掉**这一帧**：销号 ＋ 让运行时退订（Web 那一侧真做，别处空操作）。
  void _drop(String viewId) {
    miniViewLedger.unhost(viewId);
    releaseMiniAppView(viewId);
  }

  @override
  Widget build(BuildContext context) => buildMiniAppView(
    entryUrl: widget.entryUrl,
    title: widget.title,
    onAsk: widget.onAsk,
  );
}
