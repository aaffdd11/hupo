// 连「我自己那台」那条通道（契约 `docs/dev/81-HARNESS-ENTRY.md` §5.1 / §5.2）。
//
// ── 它和 `stream.dart`（琥珀自己的那条流）**故意不像**的地方 ─────────
//   ① **不自动重连**：契约 §5.4 说"断线/`gone` ⇒ 一句普通话 + 「重来」"。
//      一个终端会话，"重来" = **重起对面那一台**（一个连接 = 一个进程），
//      悄悄自动重连等于背着用户重开一台 —— 那不是"显示器 + 键盘"该做的事。
//   ② **没有"太久没帧就算断了"的看门狗**：`stream.dart` 那条有，是因为对面
//      会周期性发 ping；这一条**没有任何心跳消息**（协议只有那三种），
//      而终端**安安静静地待着**是完全正常的（它没说话 ≠ 它断了）。
//      照搬那个看门狗会把"它在想"误判成"断了"。
//   ③ 令牌用法与 `/api/stream` **完全一致**：子协议 `['bearer', token]`，不进 URL。
//
// ⚠️ 地址**只从 `stream_uri.dart` 来**（[harnessUri] 复用同一个 `_wsOrigin`）——
//    `ws://` vs `wss://` 那个老 bug 的落点就在那儿（`docs/dev/16-STREAM.md`）。
//    这一份里**一个 `ws://` 都不许拼**。

import 'dart:async';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/harness.dart';
import '../models/harness_words.dart';
import 'stream_uri.dart';

/// 一条 WebSocket = 对面一台 DSH 进程。
class HarnessClient implements HarnessFeed {
  HarnessClient({required this.base, required this.token, Uri? page}) : _page = page;

  /// 空串 = 同源（生产就是这个，和 `api.dart` / `stream.dart` 同一条规矩）。
  final String base;

  /// 令牌（走子协议，不进 URL）。
  final String token;

  /// 页面地址（同源时用它定 `ws`/`wss`）。`null` = `Uri.base`（真机就是它）。
  final Uri? _page;

  final _lines = StreamController<HarnessLine>.broadcast();
  final _status = StreamController<HarnessStatus>.broadcast();

  WebSocketChannel? _ch;
  StreamSubscription<dynamic>? _sub;
  bool _want = false;
  HarnessStatus _last = const HarnessStatus(HarnessState.booting);

  @override
  Stream<HarnessLine> get lines => _lines.stream;

  @override
  Stream<HarnessStatus> get status => _status.stream;

  @override
  HarnessStatus get current => _last;

  /// 现在只看状态那一位（完整的、含 `why` 的那一份看 [current]）。
  HarnessState get state => _last.state;

  /// 接上（**连接建立 ⇒ 对面起它那一台**）。
  @override
  void open() {
    _want = true;
    _connect();
  }

  Future<void> _connect() async {
    if (!_want) return;
    // 一连就先说"正在打开…"（界面那块地方不许空着）
    _emit(const HarnessStatus(HarnessState.booting));

    // ⚠️ 别在这里自己拼协议：同源时必须看**页面**的协议（`stream_uri.dart` 记着那次事故）。
    final uri = harnessUri(base: base, page: _page ?? Uri.base);

    final WebSocketChannel ch;
    try {
      ch = WebSocketChannel.connect(uri, protocols: ['bearer', token]);
    } catch (_) {
      _onClosed();
      return;
    }
    _ch = ch;
    // ⚠️ **先挂上监听再等握手**：握手失败那一下的错误要有人接
    //    （不接的话它会变成一个没人管的异常，而屏幕上什么都不说）
    _sub = ch.stream.listen(
      (raw) => _onFrame(ch, raw),
      onDone: () => _onClosed(ch),
      onError: (_) => _onClosed(ch),
      cancelOnError: true,
    );
    try {
      await ch.ready;
    } catch (_) {
      _onClosed(ch);
    }
  }

  void _onFrame(WebSocketChannel from, dynamic raw) {
    // 旧那一条（已经"重来"过了）迟到的帧：丢掉
    if (!identical(_ch, from)) return;
    // 对面发的是文本帧（协议里全是 JSON 文本）
    if (raw is! String) return;
    final msg = harnessIncomingOf(raw);
    switch (msg) {
      case HarnessStateIn(:final status):
        _emit(status);
      case HarnessRawIn(:final m):
        for (final line in harnessLinesOf(m)) {
          if (!_lines.isClosed) _lines.add(line);
        }
      case null:
        break; // 认不出来的帧：安静丢掉（不猜、也不许当成某条已知消息）
    }
  }

  void _emit(HarnessStatus s) {
    _last = s;
    if (!_status.isClosed) _status.add(s);
  }

  /// 这一头断了（对面收摊 / 网断 / 握手被拒）。
  ///
  /// [from] 给了就只认**现在这一条**：`restart()` 之后旧那一条迟到的
  /// `onDone`/`onError` **不许**把新那一条的状态改掉（也不许把 `_ch` 清空）。
  void _onClosed([WebSocketChannel? from]) {
    if (from != null && !identical(_ch, from)) return;
    _sub?.cancel();
    _sub = null;
    _ch = null;
    if (!_want) return;
    // ⚠️ 对面已经明说过"为什么"了（`state:gone` + `why`）⇒ **别用我们的话盖掉它**。
    if (_last.state == HarnessState.gone) return;
    _emit(const HarnessStatus(HarnessState.gone, harnessDroppedWhy));
  }

  @override
  void say(String text) {
    final t = text.trim();
    if (t.isEmpty) return; // 空话不发（发了对面也只是空转一轮）
    _send(harnessSayFrame(t));
  }

  @override
  void stop() => _send(harnessStopFrame);

  @override
  void restart() {
    // 先把这一头收掉（`_closeSocket` 会先取消订阅 ⇒ 不会触发一次假的 `gone`），
    // 再重新连 —— 对面收到新连接就是**重起它那一台**。
    _closeSocket();
    _want = true;
    _connect();
  }

  void _send(String frame) {
    final ch = _ch;
    if (ch == null) return; // 没接上就发不出去（界面上那个框本来就该是灰的）
    try {
      ch.sink.add(frame);
    } catch (_) {
      // 发不出去不抛给界面：下一帧 `onDone` 会把它变成"停下了 + 重来"
    }
  }

  /// 收掉这一头（**先取消订阅**，免得 `onDone` 又报一次状态）。
  void _closeSocket() {
    _sub?.cancel();
    _sub = null;
    try {
      _ch?.sink.close();
    } catch (_) {
      // 已经关了就算了
    }
    _ch = null;
  }

  @override
  Future<void> close() async {
    _want = false;
    _closeSocket();
    await _lines.close();
    await _status.close();
  }
}
