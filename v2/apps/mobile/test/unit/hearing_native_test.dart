// **原生开麦那一份**（契约 `docs/dev/129-NATIVE-ANDROID-BUILD.md` §十四）。
//
// 主人 2026-09-28：*"是的，安卓也要支持转文字。开工吧。"*
//
// ── 这一份怎么测（VM 上没有真麦克风，也没有安卓那台机器）───────
//   把两边都**假掉**：
//     · 那条到我们服务端的 WS（`asrWireFactory` 可换）；
//     · 麦克风那条 MethodChannel（`hupo/hearing`，换成假的）。
//   然后量**顺序与话**：
//     ① 🔴 **先连上、问对面能不能听，能听才去要麦克风**（没配钥匙的部署上先弹权限框
//        是白打扰一次 —— 2026-09-23 线上实测到的顺序问题）；
//     ② 只有 `asr/ready` 才算能听：`asr/unavailable` ⇒ `not-configured`、
//        `asr/error` ⇒ `engine`、握不上手 ⇒ `no-entry`（**与"开不了麦"不是一回事**）；
//     ③ 帧原样送出去、说过"结束"之后不再送；
//     ④ 收手**不立刻断**（留着连接等最后那句）。
//
// 🔴 **真麦克风那一下只有装到手机上才算数** —— 这一份量的是"线接对了没有"。

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/services/hearing.dart';
import 'package:hupo_app/services/hearing_native.dart';

const _micCh = MethodChannel('hupo/hearing');

/// 假的那条 WS。
class _FakeWire implements AsrWire {
  final StreamController<dynamic> out = StreamController<dynamic>.broadcast();
  final List<Object?> sent = <Object?>[];
  List<String> protocols = <String>[];
  bool closed = false;
  bool readyFails = false;

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

/// 假的那半边麦克风。
class _FakeMic {
  final List<String> calls = <String>[];
  /// `start` 要回的机器原因（`null` = 开起来了）。
  String? why;
  /// 现在有几条在采（判据用它演"Kotlin 那边往回送帧"）。
  void Function(Uint8List bytes)? onAudio;

  Future<Object?> call(MethodCall c) async {
    calls.add(c.method);
    if (c.method == 'start') return why;
    return null;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _FakeWire wire;
  late _FakeMic mic;
  late List<Map<String, dynamic>> events;

  setUp(() {
    wire = _FakeWire();
    mic = _FakeMic();
    events = <Map<String, dynamic>>[];
    clearNativeHearing();
    asrWireFactory = (Uri url, Iterable<String> protocols) {
      wire.protocols = protocols.toList();
      return wire;
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_micCh, mic.call);
  });

  tearDown(() {
    clearNativeHearing();
    asrWireFactory = _defaultWireForTest();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_micCh, null);
    if (!wire.out.isClosed) wire.out.close();
  });

  Future<String?> start() => startHearing(
    url: Uri.parse('wss://w.stalkerai.cn/api/asr'),
    token: 'tok-判据',
    onEvent: events.add,
  );

  /// 让"连上＋开始听"那几拍跑完（不阻塞在 gate 上）。
  Future<void> settle() => Future<void>.delayed(Duration.zero);

  group('没装钩子（VM / iOS / 桌面那一档）', () {
    test('🔴 恒假 ＋ 一句实话（一次都不碰那条 channel）', () async {
      clearNativeHearing();
      expect(canHear, false, reason: '★ 没装原生钩子就是"开不了麦"');
      expect(await startHearing(url: Uri.parse('wss://x/api/asr'), token: 't', onEvent: (_) {}),
          'unsupported');
      stopHearing();
      expect(mic.calls, isEmpty, reason: '★ 没装钩子时一次都不该去碰麦克风那条 channel');
    });
  });

  group('装上钩子（安卓那一档）', () {
    test('🔴 顺序：先连上 → 对面说"能听" → **才**去要麦克风', () async {
      installNativeHearing();
      expect(canHear, true);
      final fut = start();
      await settle();
      // ① 先跟对面说"我要开始了"
      expect(wire.sent, contains(jsonEncode({'type': 'asr/start'})));
      expect(wire.protocols, ['bearer', 'tok-判据'], reason: '★ 令牌走子协议，不进 URL');
      // ② 对面还没说"能听"之前，**一下都不许碰麦克风**
      expect(mic.calls, isEmpty, reason: '★ 没配钥匙的部署上先弹权限框 = 白打扰一次');
      // ③ 对面说能听 ⇒ 这才去要麦
      wire.out.add(jsonEncode({'type': 'asr/ready'}));
      expect(await fut, isNull, reason: 'null = 真开起来了');
      expect(mic.calls, contains('start'));
    });

    test('🔴 对面说"没配" ⇒ `not-configured`，而且**一次都没要麦克风**', () async {
      installNativeHearing();
      final fut = start();
      await settle();
      wire.out.add(jsonEncode({'type': 'asr/unavailable', 'reason': 'no-creds'}));
      expect(await fut, 'not-configured');
      expect(mic.calls, isEmpty, reason: '★ 白打扰那一条：这一档不许碰麦克风');
      expect(events.map((e) => e['type']), contains('asr/unavailable'), reason: '★ 事件要转给界面');
    });

    test('🔴 握不上手 ⇒ `no-entry`（**不是**"开不了麦"），且不会去要麦克风', () async {
      installNativeHearing();
      wire.readyFails = true;
      expect(await start(), 'no-entry');
      expect(mic.calls, isEmpty);
    });

    test('★ 上游那一头出错（`asr/error`）⇒ `engine`', () async {
      installNativeHearing();
      final fut = start();
      await settle();
      wire.out.add(jsonEncode({'type': 'asr/error', 'reason': 'engine'}));
      expect(await fut, 'engine');
      // 前端别漏了：那条 error 要原样转出去（界面据此说"引擎/额度"那一句）
      expect(events.map((e) => e['type']), contains('asr/error'));
    });

    test('★ 麦克风那一侧说"没权限" ⇒ `denied`，而且连接收干净', () async {
      installNativeHearing();
      mic.why = 'denied';
      final fut = start();
      await settle();
      wire.out.add(jsonEncode({'type': 'asr/ready'}));
      expect(await fut, 'denied');
      expect(wire.closed, true, reason: '★ 开不了麦 ⇒ 这条连接不许挂在那儿');
    });

    test('🔴 帧：采到的 PCM **原样**送出去；说过"结束"之后不再送', () async {
      installNativeHearing();
      final fut = start();
      await settle();
      wire.out.add(jsonEncode({'type': 'asr/ready'}));
      expect(await fut, isNull);
      // Kotlin 那边往回送一块（16k 单声道 PCM16 ⇒ 一块 3200 字节）
      final chunk = Uint8List.fromList(List<int>.generate(3200, (i) => i % 251));
      await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
        'hupo/hearing',
        const StandardMethodCodec().encodeMethodCall(MethodCall('onAudio', chunk)),
        (_) {},
      );
      expect(wire.sent.whereType<Uint8List>().toList(), [chunk], reason: '★ 原样送（不加工、不重采样）');
      // 收手之后：帧再回来也不许送（对面已经在收尾了）
      stopHearing();
      await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
        'hupo/hearing',
        const StandardMethodCodec().encodeMethodCall(MethodCall('onAudio', chunk)),
        (_) {},
      );
      expect(wire.sent.whereType<Uint8List>().toList(), hasLength(1));
    });

    test('★ 收手**不立刻断**：先说"结束"、留着连接等最后那句', () async {
      installNativeHearing();
      final fut = start();
      await settle();
      wire.out.add(jsonEncode({'type': 'asr/ready'}));
      expect(await fut, isNull);
      stopHearing();
      expect(wire.sent, contains(jsonEncode({'type': 'asr/stop'})));
      expect(mic.calls, contains('stop'), reason: '★ 停采集');
      expect(wire.closed, false, reason: '★ 立刻断的话，最后那几个字就丢了');
      // 对面把最后那句吐回来 ⇒ 转给界面
      wire.out.add(jsonEncode({'type': 'asr/end', 'text': '说完了'}));
      await settle();
      expect(events.map((e) => e['type']), contains('asr/end'));
      expect(wire.closed, true, reason: '★ 收尾之后要收干净');
    });
  });

  group('装钩子那一行只在 Android 上（源码级）', () {
    test('🔴 `main.dart`：Android 分支装开麦；channel 名字两边逐字一致', () {
      final main = File('lib/main.dart').readAsStringSync();
      expect(main.contains('installNativeHearing()'), isTrue,
          reason: '★ 装了才有原生开麦 —— 少了这一句，安卓上还是"这里开不了麦"');
      expect(main.contains('defaultTargetPlatform == TargetPlatform.android'), isTrue);
      final stub = File('lib/services/hearing_stub.dart').readAsStringSync();
      expect(stub.contains('nativeHearingApi?.canHear ?? false'), isTrue,
          reason: '★ 没装钩子必须恒假（不许假装能开麦）');
      final kt = File('android/app/src/main/kotlin/chat/hupo/hupo_app/MainActivity.kt').readAsStringSync();
      expect(kt.contains('"hupo/hearing"'), isTrue);
      expect(File('lib/services/hearing_native.dart').readAsStringSync().contains("'hupo/hearing'"), isTrue);
      final mic = File('android/app/src/main/kotlin/chat/hupo/hupo_app/NativeMic.kt').readAsStringSync();
      expect(mic.contains('16000'), isTrue, reason: '★ 上游要 16k');
      expect(mic.contains('CHANNEL_IN_MONO'), isTrue, reason: '★ 单声道');
      expect(mic.contains('ENCODING_PCM_16BIT'), isTrue, reason: '★ PCM16（与 voice_format=1 对齐）');
    });
  });
}

/// 收尾时把工厂还原成真的那一份（别影响别的判据）。
AsrWire Function(Uri, Iterable<String>) _defaultWireForTest() =>
    (Uri url, Iterable<String> protocols) => throw StateError('判据里不该真的连出去');
