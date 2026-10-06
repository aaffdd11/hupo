// **"按下就通"：预热那一条连接**（2026-10-06 · 契约 `docs/dev/205-ASR-WARM.md`）。
//
// ── 为什么要有这一条 ──────────────────────────────────────
//   那条 `/api/asr` 的连接**冷启那一次真量到 1.1~4.4 秒**（热的时候 16 ms）——
//   它原来落在**"按下 → 屏幕上出第一个字"**这条路上。
//   ⇒ 现在进聊天那一屏就把它**先连上**（`warmNativeHearing` / `warmHearing`），
//     按键那一刻只剩握手那一拍（~200 ms）。
//
// ── 这一份钉四件事（各带负向对照）──────────────────────────
//   ① **预热只连一条**，而且**一个字节都不发**（不发 `asr/start` ⇒ 上游不开、不花钱）；
//   ② **按下时用的是那条热的**（不新造连接）—— 这就是"按下就通"的全部；
//   ③ **热的那条已经死了 ⇒ 丢掉、现连一条**（宁可慢一点，不许拿着一条死的当热的）；
//   ④ 不预热 ⇒ 照旧现连（老形状没被改坏）。
//
// ⚠️ 量的走的是**安卓那一份**（`asrWireFactory` 可以换）—— 那是他真正用的那一端；
//    网页那一份同一条路，另有源码级判据（`hearing_open_order_test.dart`）盯着。

import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/services/hearing.dart';
import 'package:hupo_app/services/hearing_native.dart';

const _micCh = MethodChannel('hupo/hearing');

/// 假的那条 WS（记账：被造过几次、发过什么、还活着吗）。
class _Wire implements AsrWire {
  _Wire(this.name);
  final String name;
  final StreamController<dynamic> out = StreamController<dynamic>.broadcast();
  final List<Object?> sent = <Object?>[];

  /// 握不上手（演"这条根本连不通"）。
  bool readyFails = false;
  bool closed = false;

  @override
  bool get alive => !closed;

  @override
  Future<void> get ready async {
    if (readyFails) throw StateError('握不上手');
  }

  @override
  Stream<dynamic> get stream => out.stream;

  @override
  void send(Object? data) => sent.add(data);

  @override
  Future<void> close() async {
    closed = true;
    if (!out.isClosed) await out.close();
  }
}

/// 假的那半边麦克风（`start` 一律成功）。
class _Mic {
  Future<Object?> call(MethodCall c) async => null;
}

Future<void> _tick() => Future<void>.delayed(Duration.zero);

/// **按下那一颗**：⚠️ `startNativeHearing` 要等"对面说能听"那个结论才返回
/// （假线不推事件 ⇒ 它会一直等）⇒ 判据里**不 await 它**，踢出去之后走几个微任务再看。
Future<void> _press(List<Map<String, dynamic>> events) async {
  unawaited(startNativeHearing(
    url: Uri.parse('wss://x/api/asr'),
    token: 't',
    onEvent: events.add,
  ));
  await _tick();
  await _tick();
}

/// 收尾时把工厂还原成"一调就抛"那一份（别影响别的判据）。
AsrWire Function(Uri, Iterable<String>) _defaultWireForTest() =>
    (Uri url, Iterable<String> protocols) => throw StateError('判据里不该真的连出去');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late List<_Wire> made;
  late List<List<String>> protocols;
  late List<Map<String, dynamic>> events;

  setUp(() {
    made = <_Wire>[];
    protocols = <List<String>>[];
    events = <Map<String, dynamic>>[];
    clearNativeHearing();
    resetHearingForTest(); // 判据之间不许互相带状态（预热是模块级的）
    asrWireFactory = (Uri url, Iterable<String> pr) {
      final w = _Wire('w${made.length + 1}');
      made.add(w);
      protocols.add(pr.toList());
      return w;
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_micCh, _Mic().call);
  });

  tearDown(() {
    resetHearingForTest();
    clearNativeHearing();
    asrWireFactory = _defaultWireForTest();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_micCh, null);
    for (final w in made) {
      if (!w.out.isClosed) w.out.close();
    }
  });

  test('★ 预热：**只连一条**，而且**一个字节都不发**（不发 asr/start ⇒ 不花钱）', () async {
    await warmNativeHearing(url: Uri.parse('wss://x/api/asr'), token: 't');
    await _tick();
    expect(made.length, 1, reason: '★ 预热要真的连一条（不然"按下就通"是空话）');
    expect(protocols.single, ['bearer', 't'], reason: '★ 令牌走子协议（不进 URL）—— 与按下那条一致');
    expect(made.single.sent, isEmpty,
        reason: '🔴 预热**不许**发 `asr/start`：那一下就把上游开了（花钱），而我们只是想先把连接连上');
    // 负向对照 ①：再热一次**不许**再连一条（叠起来就是两条连接）
    await warmNativeHearing(url: Uri.parse('wss://x/api/asr'), token: 't');
    await _tick();
    expect(made.length, 1, reason: '★ 重复预热不许再连一条');
  });

  test('★ **按下时用的是那条热的**（不新造连接）—— 这就是"按下就通"', () async {
    // 先热身
    await warmNativeHearing(url: Uri.parse('wss://x/api/asr'), token: 't');
    await _tick();
    expect(made.length, 1);
    // 再按下
    await _press(events);
    expect(made.length, 1, reason: '🔴 按下那一刻**不许**再连一条 —— 热的就该拿去用（不然预热白做）');
    expect(made.single.sent.whereType<String>().join(), contains('asr/start'),
        reason: '按下之后才发 `asr/start`（上游到这时候才开）');
    stopNativeHearing();
  });

  test('★ 热的那条**已经死了** ⇒ 丢掉、现连一条（不许拿着一条死的当热的）', () async {
    await warmNativeHearing(url: Uri.parse('wss://x/api/asr'), token: 't');
    await _tick();
    made.single.closed = true; // 对面把它关了（挂久了就会这样）
    await _press(events);
    expect(made.length, 2, reason: '★ 死的那条要被丢掉、当场现连一条（慢一点，但不许拿着死的）');
    stopNativeHearing();
  });

  test('★ 预热**握不上手** ⇒ 不留在手里（下一次按下照旧现连）', () async {
    asrWireFactory = (Uri url, Iterable<String> pr) {
      final w = _Wire('dead')..readyFails = true;
      made.add(w);
      return w;
    };
    await warmNativeHearing(url: Uri.parse('wss://x/api/asr'), token: 't');
    await _tick();
    expect(made.length, 1);
    // 按下：那条预热已经被丢掉 ⇒ 现连一条（这里的 factory 还是"连不上"那条，只数次数）
    await _press(events);
    expect(made.length, 2, reason: '★ 握不上手的那条不许留在手里当下一次的"热的"');
    stopNativeHearing();
  });

  test('★ 负向对照：**不预热** ⇒ 按下就现连一条（老形状一个字没坏）', () async {
    await _press(events);
    expect(made.length, 1, reason: '不预热时照旧现连一条');
    stopNativeHearing();
  });
}
