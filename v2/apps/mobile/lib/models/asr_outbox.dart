// **连上之前先把音频攒着**（2026-10-06 修的那一处 · 契约 `docs/dev/199-ASR-HEAD.md`）。
//
// ── 为什么非要有它 ────────────────────────────────────────
//   主人 2026-10-06 报的：*"我说话以后，没有直接显示语音转换文字，响应很慢，
//   然后真正出现的时候，前面的几个字可能会不见。"*
//   **量出来的两段**（真读数见 `199`）：
//     ① 手机上那颗包（当天 05:51 打的）里，麦克风要**等对面说"能听"**才开
//        （那一段：热 ~240ms、**冷启真量到 4.4 秒**）⇒ 他开口那几个字**采都没采**；
//     ② 就算换成新的顺序，客户端仍然**先 `await` 那条连接握上手，再开麦** ——
//        冷启那几秒同样丢。
//   ⇒ 规矩改成：**按下去就开麦**，音频先在**本机**攒着；那条连接一握上手，
//     把攒着的**按顺序**补发（服务端那一侧也有一份同样的攒法：
//     `src/asr-doubao.js` 的队列，见判据「连上之前推的音频不丢」）。
//   🔴 **一个字都不许丢** —— 丢的正是他开头说的那几个字，而那是补不回来的。
//
// ⚠️ 纯逻辑（`dart:typed_data` 而已，不碰 flutter / 不碰 IO）⇒ 进 `test/unit`。

import 'dart:typed_data';

/// 一次会话里"还没连上时攒着的那几包"。
///
/// 用法（两份平台实现同一个形状）：
/// ```dart
/// for (final b in session.outbox.add(pcm)) socket.send(b);   // 没连上就是空表
/// ...
/// socket.ready.then((_) { for (final b in session.outbox.open()) socket.send(b); });
/// ```
class AsrOutbox {
  final List<Uint8List> _held = <Uint8List>[];
  int _bytes = 0;
  bool _open = false;

  /// 那条连接握上手了吗（`open()` 调过就是）。
  bool get isOpen => _open;

  /// 现在攒着多少字节（**没发出去的**）。
  int get pendingBytes => _bytes;

  /// 攒着几包。
  int get pendingChunks => _held.length;

  /// **一包音频**：连上了就当场交出去（调用方直接发），没连上就**攒着**。
  ///
  /// @returns 现在就该发出去的包（**没连上时是空表** —— 一个字节都没丢，只是先攒着）
  List<Uint8List> add(Uint8List chunk) {
    if (chunk.isEmpty) return const <Uint8List>[]; // 空包没有意义（也别记账）
    if (_open) return <Uint8List>[chunk];
    _held.add(chunk);
    _bytes += chunk.length;
    return const <Uint8List>[];
  }

  /// **连上了** ⇒ 把攒着的按**原来的顺序**交出来（之后 `add` 直接交出去）。
  ///
  /// ⚠️ 顺序不许变：音频是**连着说的话**，颠一包就是颠一句。
  List<Uint8List> open() {
    _open = true;
    if (_held.isEmpty) return const <Uint8List>[];
    final out = List<Uint8List>.of(_held);
    _held.clear();
    _bytes = 0;
    return out;
  }

  /// **收干净**（用户按停 / 连接失败 / 这条会话被扔掉）。
  ///
  /// @returns 这一次**没送出去**的字节数 —— 调用方拿它如实记账
  ///          （"丢了多少"这件事必须能说出来，不许悄悄咽掉）
  int clear() {
    final n = _bytes;
    _held.clear();
    _bytes = 0;
    return n;
  }
}
