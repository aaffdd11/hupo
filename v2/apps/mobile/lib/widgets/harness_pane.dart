// **「我自己那台」那一层**（契约 `docs/dev/81-HARNESS-ENTRY.md` §5.4）。
//
// 它是**显示器 + 键盘**：里面是那台 DSH 自己的原始会话流（它的思考、它吐的字
// **原样**），我们**不做任何包装** —— 所以这里长得像**终端**（等宽、一行一条、
// 能滚、自动跟到底），**不是**聊天气泡那一套。
//
// ── 画法（契约 §5.4 逐条对表）────────────────────────────────
//   · `booting` ⇒ 「正在打开…」（不许白屏）；
//   · `ready` ⇒ 打字框活过来 + 一个「停」；
//   · `gone` ⇒ 一句普通话 + 对面给的原因 + 「重来」（**点了真的重连**）；
//   · 每一行都从 `models/harness.dart` 的 `harnessLinesOf` 来（已知的画人话、
//     **未知的画「类型 + 一小段 JSON」** —— 判据 H8 就钉在那儿）。
//
// 🔴 **断线不许白屏**：状态那几行本身也算这个滚动区里的行
//    （所以字放大到 3.1 倍时它们跟着滚，不会把整块挤爆 —— D3.5 那道硬闸）。
//
// ⚠️ 楼层闸：`widgets` 只许看 `models` ⇒ 这里**不 import services**：
//    通道的**形状**是 `models/harness.dart` 的 [HarnessFeed]，真实现由 `screens` 接上。

import 'dart:async';

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/dev_harness.dart';
import '../models/dev_harness_words.dart';
import '../models/harness.dart';
import '../models/harness_words.dart';
import '../models/scroll_follow.dart';

/// 那一层（**不 push 新页面**，它就是 `MiniAppHost` 里的一个孩子）。
class HarnessPane extends StatefulWidget {
  const HarnessPane({super.key, required this.feed, this.devEntry});

  /// 那条通道（生产上注入 `services/harness_client.dart` 的实现；
  /// 判据里注入一个假的 —— 界面只认这个形状）。
  final HarnessFeed feed;

  /// ★ **那个次要入口**（契约 `docs/dev/82-DEV-MODE.md` §四 / §五）：
  /// 「在浏览器里打开」那一句普通话 + 一个按钮。
  ///
  /// ⚠️ 形状在 `models/dev_harness.dart`（`widgets` 只许看 `models` —— 楼层闸），
  ///    真实现（要那条链接、真去开浏览器）由 `screens` 一层接上。
  /// ⚠️ `null` = 这条路没接上 ⇒ 那个入口**一个字都不画**（单看这一层的判据可以不传）。
  final DevHarnessEntry? devEntry;

  @override
  State<HarnessPane> createState() => _HarnessPaneState();
}

class _HarnessPaneState extends State<HarnessPane> {
  /// 已经流进来的那些行（**原样攒着**：它到了就该看得见，不重排、不合并）。
  final _lines = <HarnessLine>[];

  /// 现在什么状态（初值 = `booting`：一挂上就说"正在打开…"，不许白屏）。
  HarnessStatus _status = const HarnessStatus(HarnessState.booting);

  final _scroll = ScrollController();
  final _input = TextEditingController();

  /// 用户**自己往上翻过**没有（判定走纯函数 [scrollFollowAction]，和聊天那条同一个）。
  bool _scrolledAway = false;

  StreamSubscription<HarnessLine>? _lsub;
  StreamSubscription<HarnessStatus>? _ssub;

  /// **那个次要入口**现在什么状态。
  ///
  /// `null` = 还没问过（界面画「正在准备…」）；**非 200 的档由 [devEntryViewOf] 定**，
  /// 这一层不认识状态码（它是 `models` 的纯函数说了算）。
  DevHarnessOutcome? _dev;

  /// 刚才那一下**没打开**（点了失败 ⇒ 下次重取；按钮留着让他再点）。
  bool _devOpenFailed = false;

  /// 正在问那条链接（防手快的第二下）。
  bool _devBusy = false;

  @override
  void initState() {
    super.initState();
    // ⚠️ **订阅之前先读一次现状**：`open()` 是在这一层挂上之前调的，
    //    广播流**不会**把那时发过的状态补给我 ⇒ 不读的话可能永远停在"正在打开…"。
    _status = widget.feed.current;
    _listen();
    WidgetsBinding.instance.addPostFrameCallback((_) => _follow());
    // ★ **次要入口**（契约 `82-DEV-MODE.md` §五）：一挂上就问一次
    //   （这个平台打不开浏览器的话**不去问** —— 要一条用不上的链接没有意义）。
    unawaited(_askDev());
  }

  void _listen() {
    _lsub = widget.feed.lines.listen((line) {
      if (!mounted) return;
      setState(() => _lines.add(line));
      _follow();
    });
    _ssub = widget.feed.status.listen((s) {
      if (!mounted) return;
      setState(() => _status = s);
      _follow();
    });
  }

  @override
  void didUpdateWidget(covariant HarnessPane old) {
    super.didUpdateWidget(old);
    // 换了一条通道（正常不会发生）⇒ 旧订阅收掉、把屏幕清干净重新听
    if (!identical(old.feed, widget.feed)) {
      _lsub?.cancel();
      _ssub?.cancel();
      _lines.clear();
      _status = widget.feed.current;
      _listen();
    }
  }

  @override
  void dispose() {
    // ⚠️ **只退订，不关通道**：通道是上层（`screens`）的东西，它决定什么时候收
    //    （离开这个入口 = 收掉这一头 = 对面把那一台停掉）。
    _lsub?.cancel();
    _ssub?.cancel();
    _scroll.dispose();
    _input.dispose();
    super.dispose();
  }

  /// 钉到最新（尊重"用户自己翻走了没有"，判定复用 `models/scroll_follow.dart`）。
  void _follow() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final pos = _scroll.position;
      final action = scrollFollowAction(
        pixels: pos.pixels,
        maxScrollExtent: pos.maxScrollExtent,
        userScrolledAway: _scrolledAway,
      );
      switch (action) {
        case FollowAction.none:
          return;
        case FollowAction.jump:
          pos.jumpTo(pos.maxScrollExtent);
        case FollowAction.animate:
          _scroll.animateTo(
            pos.maxScrollExtent,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut,
          );
      }
    });
  }

  /// 状态那几行：**它们也算这个滚动区里的行**（D3.5：字放大不许把外面挤爆）。
  List<HarnessLine> get _statusLines => switch (_status.state) {
    HarnessState.booting => const [
      HarnessLine(HarnessLineKind.note, harnessOpening),
    ],
    HarnessState.ready => const [],
    HarnessState.gone => [
      const HarnessLine(HarnessLineKind.turn, harnessGoneLine),
      if ((_status.why ?? '').isNotEmpty)
        HarnessLine(HarnessLineKind.note, '$harnessWhyPrefix${_status.why}'),
    ],
  };

  void _send() {
    final text = _input.text;
    if (text.trim().isEmpty) return;
    widget.feed.say(text);
    _input.clear();
  }

  // ── ★ 那个次要入口（契约 `82-DEV-MODE.md` §四 / §五）──────────

  /// 问一次那条链接（**只在该问的时候问**：这个平台打不开就不去要）。
  Future<void> _askDev() async {
    final e = widget.devEntry;
    if (e == null || !e.canOpen || _devBusy) return;
    _devBusy = true;
    final got = await e.source.link();
    if (!mounted) return;
    setState(() {
      _devBusy = false;
      _dev = got;
    });
  }

  /// 点「在浏览器里打开」：拿到那条链接 ⇒ **原样**交给外面那套打开。
  ///
  /// ⚠️ 过期/点了失败 ⇒ **重取**（`source.forget()`；契约 §五：那条链接短时效）。
  Future<void> _openDev() async {
    final e = widget.devEntry;
    if (e == null || _devBusy) return;
    _devBusy = true;
    setState(() => _devOpenFailed = false);
    final got = await e.source.link();
    if (!mounted) return;
    if (got is! DevHarnessReady) {
      // 这几档**都没有按钮**（回执自己变了：没被标 / 这会儿问不到）
      setState(() {
        _devBusy = false;
        _dev = got;
      });
      return;
    }
    setState(() {
      _devBusy = false;
      _dev = got;
    });
    final opened = e.openExternal(got.link.url);
    if (!mounted) return;
    if (!opened) {
      // 没打开 ⇒ 下一下重取（并如实说一句）
      e.source.forget();
      setState(() => _devOpenFailed = true);
    }
  }

  /// 那一条：一句普通话（+ 能开的时候一个按钮）。
  ///
  /// 🔴 **不给按钮的那几档只有一个字：那几句普通话** ——
  ///    画一个按不动的按钮就是"界面上出现做不到的东西"（`AGENTS.md` §六·4）。
  /// ⚠️ 用 `Wrap` 不用 `Row`：字放大到 3.1 倍时它会**换行**，而不是把这一行挤爆（D3.5）。
  Widget _devBar(ThemeData t) {
    final e = widget.devEntry!;
    final view = devEntryViewOf(
      canOpen: e.canOpen,
      outcome: _dev,
      openFailed: _devOpenFailed,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(d.gapS, d.gapS, d.gapS, 0),
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: d.gapS,
        runSpacing: d.gapXs,
        children: [
          Text(
            devEntryWords(view),
            style: (t.textTheme.bodySmall ?? const TextStyle()).copyWith(color: d.muted),
          ),
          if (devEntryHasButton(view))
            TextButton(
              // D3.6：命中区 ≥44
              style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              onPressed: _devBusy ? null : _openDev,
              child: const Text(devOpenAction),
            ),
        ],
      ),
    );
  }

  /// **看板那句话**（主人 2026-09-25 拍的「甲」· 契约 `109-DEV-ENTRY-IS-YOURS.md` §八）。
  ///
  /// 🔴 **必须一直在**：这一层里回话的**不是琥珀**（那台进程没带人格那层），
  ///    名字却叫"我自己那台" —— 不写这一句，界面就在说假话。
  /// ⚠️ 用 `Wrap`：3.1 倍字号时它**换行**，而不是把上面那块挤爆（D3.5）。
  Widget _notHupoBar(ThemeData t) {
    final style = (t.textTheme.bodySmall ?? const TextStyle()).copyWith(color: d.muted);
    return Container(
      width: double.infinity,
      color: d.accentTint,
      padding: const EdgeInsets.fromLTRB(d.gapS, d.gapXs, d.gapS, d.gapXs),
      child: Wrap(
        spacing: d.gapXs,
        runSpacing: d.gapXs,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(devBoardNotHupo, style: style.copyWith(color: d.accent)),
          Text(devBoardWhyNot, style: style),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final status = _statusLines;
    final ready = _status.state == HarnessState.ready;
    final gone = _status.state == HarnessState.gone;
    return Column(
      children: [
        // ★ **看板那句话**：一进来就看得见，滚不走（契约 109 §八）
        _notHupoBar(t),
        Expanded(
          child: NotificationListener<ScrollNotification>(
            // ⚠️ **只有手指拖出来的滚动**才算"用户自己翻走了"（自己 `animateTo` 的不算）
            onNotification: (n) {
              if (n is ScrollStartNotification && n.dragDetails != null && !_scrolledAway) {
                setState(() => _scrolledAway = true);
              }
              if (n is ScrollUpdateNotification && n.dragDetails != null && !_scrolledAway) {
                setState(() => _scrolledAway = true);
              }
              return false;
            },
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.all(d.gapS),
              itemCount: _lines.length + status.length,
              itemBuilder: (_, i) =>
                  _line(t, i < _lines.length ? _lines[i] : status[i - _lines.length]),
            ),
          ),
        ),
        // ★ 那个次要入口（没接上这条路 ⇒ 一个字都不画）
        if (widget.devEntry != null) _devBar(t),
        Divider(height: 1, color: d.line),
        _composer(t, ready: ready, gone: gone),
      ],
    );
  }

  /// **一行**（终端的样子：等宽、朴素、一条一行；`detail` 是那一小段 JSON）。
  Widget _line(ThemeData t, HarnessLine line) {
    final detail = line.detail;
    return Padding(
      padding: const EdgeInsets.only(bottom: d.gapXs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText(line.text, style: _mono(t, line.kind, false)),
          if (detail != null && detail.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: d.gapXs),
              child: SelectableText(detail, style: _mono(t, line.kind, true)),
            ),
        ],
      ),
    );
  }

  /// 等宽那一套（**不写死字号**：D3.5 的字要跟着系统走，这里只换字体与颜色）。
  TextStyle _mono(ThemeData t, HarnessLineKind kind, bool detail) {
    final base = (t.textTheme.bodySmall ?? const TextStyle()).copyWith(
      fontFamily: 'monospace',
    );
    final c = switch (kind) {
      HarnessLineKind.turn => d.accent,
      HarnessLineKind.user => d.ink,
      HarnessLineKind.text => d.ink,
      HarnessLineKind.unknown => detail ? d.muted : d.accent,
      _ => d.muted,
    };
    return base.copyWith(
      color: c,
      fontWeight: kind == HarnessLineKind.turn || kind == HarnessLineKind.user
          ? FontWeight.w600
          : null,
      fontStyle: kind == HarnessLineKind.think ? FontStyle.italic : null,
    );
  }

  /// 底下那一条：打字框 + （跑着的时候）「停」/（停了的时候）「重来」+ 送出。
  Widget _composer(ThemeData t, {required bool ready, required bool gone}) {
    return Padding(
      padding: const EdgeInsets.all(d.gapS),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _input,
              // ⚠️ **没开好就不给打字**：这时候发出去的话没人接（那才是"点了没反应"）
              enabled: ready,
              style: _mono(t, HarnessLineKind.text, false),
              textInputAction: TextInputAction.send,
              // **回车发出**（契约 §5.4）
              onSubmitted: (_) => _send(),
              decoration: const InputDecoration(hintText: harnessSayHint, isDense: true),
            ),
          ),
          const SizedBox(width: d.gapS),
          if (gone)
            TextButton(
              // D3.6：命中区 ≥44
              style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              // **点了真的重连**（重连 = 重起对面那一台）
              onPressed: widget.feed.restart,
              child: const Text(harnessRestart),
            )
          else if (ready)
            TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              onPressed: widget.feed.stop,
              child: const Text(harnessStop),
            ),
          const SizedBox(width: d.gapS),
          IconButton(
            tooltip: harnessSend,
            onPressed: ready ? _send : null,
            icon: const Icon(Icons.send),
          ),
        ],
      ),
    );
  }
}
