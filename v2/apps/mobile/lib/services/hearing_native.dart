// **真开麦（安卓那一份）**：`AudioRecord` 取 16k 单声道 PCM → 我们那条 `/api/asr`。
//
// 契约：`docs/dev/129-NATIVE-ANDROID-BUILD.md` §十四。
// 真东西两半：
//   · Kotlin 那半：`android/app/src/main/kotlin/chat/hupo/hupo_app/NativeMic.kt`（采 PCM、
//     第一次按下去才问权限）；
//   · 这一份：连我们那条 `/api/asr`、把帧送出去、把回帧翻成事件。
//
// ── 与网页那一份（`hearing_web.dart`）**逐条对齐**（不然同一件事会有两种说法）──
//   ① 🔴 **先连上、问对面"这台能不能听"，能听才去要麦克风**：没配钥匙的部署上
//      先弹一个权限框、再说"没配好"，是白打扰一次（2026-09-23 线上实测到过）。
//   ② **只有 `asr/ready` 才算能听**（上游握手真的成了）；`asr/unavailable` ⇒
//      `not-configured`、`asr/error` ⇒ `engine`、连不上 ⇒ `no-entry`（**与"开不了麦"
//      不是一回事**：2026-09-23 那条线上事故就是这两句混着说）。
//   ③ **收手不是立刻断**：先停采集、跟对面说 `{type:'asr/stop'}`，**留着连接**
//      等最后那几个字回来（`_lingerLimit` 兜底，对面一直不回也要收干净）。
//   ④ **一次只开一条**：新的开始之前先把旧的那条收干净。
//
// 🔴 **音频只发给我们自己的服务端**（`wss://w.stalkerai.cn/api/asr`）：签名与
//    `SecretKey` 只在服务端那一跳上用（浏览器/手机都不许拿到）。
// 🔴 **一个字节都不留在本机**：这一条**不落盘**（与「录一段」那块刻意不同）。

import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'hearing.dart';

/// 与 Kotlin 那一侧（`MainActivity.HEARING_CHANNEL`）**必须逐字一致**。
const String _channelName = 'hupo/hearing';

/// 连上之后最多等多久"这台能不能听"（上游握手那一拍）—— 与网页那份同一个数。
const Duration _readyLimit = Duration(seconds: 5);

/// 说过"结束"之后，最多再等多久收尾（等那句最后的字回来）。
const Duration _lingerLimit = Duration(seconds: 8);

// ── 那条 WS 的**最小接口**（判据注入假的）──────────────────────
//
// ⚠️ 为什么不直接调 `WebSocketChannel.connect`：那样这一份就**没法在 VM 上判**了
//    （判据要能演"对面回 asr/unavailable / 握不上手 / 半路断"这几档）。
//    ⇒ 抽成三件事：ready / stream / send（＋ close），默认那份就是真的 WS。

/// 一条 ASR 连接（判据可以换成假的）。
abstract class AsrWire {
  /// 握上手了（连不上会抛）。
  Future<void> get ready;
  Stream<dynamic> get stream;
  void send(Object? data);
  Future<void> close();
}

/// 造一条连接。**判据可以换掉它**。
AsrWire Function(Uri url, Iterable<String> protocols) asrWireFactory = _realWire;

AsrWire _realWire(Uri url, Iterable<String> protocols) {
  final ch = WebSocketChannel.connect(url, protocols: protocols);
  return _ChannelWire(ch);
}

class _ChannelWire implements AsrWire {
  _ChannelWire(this._ch);
  final WebSocketChannel _ch;

  @override
  Future<void> get ready => _ch.ready;

  @override
  Stream<dynamic> get stream => _ch.stream;

  @override
  void send(Object? data) => _ch.sink.add(data);

  @override
  Future<void> close() => _ch.sink.close();
}

/// 手里开着的那一条（**一次只开一条**）。
_Session? _open;

/// 现在这条会话是不是还在"开着"（旧的回调不许往里灌）。
int _generation = 0;

/// 麦克风那条 channel（装了钩子之后建一次）。
const MethodChannel _mic = MethodChannel(_channelName);

class _Session {
  _Session(this.wire, this.onEvent);

  final AsrWire wire;
  final void Function(Map<String, dynamic>) onEvent;
  StreamSubscription<dynamic>? sub;
  Timer? linger;
  bool stopping = false;

  /// 麦克风那一侧**真的开起来了**才置真 —— 收尾时据此决定要不要去叫它停。
  /// ⚠️ 没开过就不许碰那条 channel：这样"没配钥匙那一档**一次都不碰麦克风**"
  ///    才是一句能判的话（判据 `hearing_native_test` 钉着）。
  bool micStarted = false;
}

/// **开麦**（原生那一份的真实现；对外那三个名字在 `hearing.dart` / `hearing_stub.dart`）。
///
/// ⚠️ 名字带 `Native` 是**刻意的**：它和 `hearing.dart` 对外那个 `startHearing`
///    同时被 import 时会撞名（判据里两个都要用）。
Future<String?> startNativeHearing({
  required Uri url,
  required String token,
  required void Function(Map<String, dynamic>) onEvent,
}) async {
  _closeAll();
  final myGen = ++_generation;

  // ── ① 先连上（令牌走子协议 `['bearer', token]`，和聊天那条一样；**不进 URL**）──
  final AsrWire w;
  try {
    w = asrWireFactory(url, <String>['bearer', token]);
    await w.ready;
  } catch (_) {
    // ⚠️ **这一句和"麦克风开不了"不是一回事**：这一步失败通常意味着这条连接
    //    在中间某一跳就断了（网关 / 隧道不认这条路径）—— 两句混着说就是假话
    //    （网页那一份 2026-09-23 在线上真踩到过）。
    return 'no-entry';
  }

  final session = _Session(w, onEvent);
  _open = session;

  // ── ② 对面说"能听"之前，一下都不去碰麦克风 ────────────────────
  final gate = Completer<String?>();
  session.sub = w.stream.listen(
    (raw) {
      if (!identical(_open, session)) return; // 已经换了一条：旧的不认
      if (raw is! String) return;
      Map<String, dynamic> event;
      try {
        event = jsonDecode(raw) as Map<String, dynamic>;
      } catch (_) {
        return; // 不认识的一律丢（不猜）
      }
      final t = event['type'];
      if (!gate.isCompleted) {
        if (t == 'asr/unavailable') {
          onEvent(event);
          gate.complete('not-configured');
          _close(session);
          return;
        }
        if (t == 'asr/error') {
          onEvent(event);
          gate.complete('engine');
          _close(session);
          return;
        }
        if (t == 'asr/ready') gate.complete(null);
      }
      onEvent(event);
      if (t == 'asr/end' || t == 'asr/unavailable') _close(session);
    },
    onDone: () {
      if (!gate.isCompleted) gate.complete('failed');
      _close(session);
    },
    onError: (_) {
      if (!gate.isCompleted) gate.complete('failed');
      _close(session);
    },
    cancelOnError: true,
  );
  try {
    w.send(jsonEncode({'type': 'asr/start'}));
  } catch (_) {
    /* 对面已经断了 */
  }

  final verdict = await gate.future.timeout(_readyLimit, onTimeout: () => 'no-entry');
  if (verdict != null) {
    _close(session);
    return verdict;
  }
  if (myGen != _generation || !identical(_open, session)) {
    _close(session);
    return 'failed';
  }

  // ── ③ 对面能听 ⇒ 现在才去要麦克风（用户那一下手势还在这一拍里）────
  //
  // ⚠️ 帧从 Kotlin 那半回来（`onAudio`，16k 单声道 PCM16），到这里原样送出去。
  _mic.setMethodCallHandler((call) async {
    if (call.method != 'onAudio') return null;
    final s = _open;
    if (s == null || !identical(s, session) || s.stopping) return null;
    final data = call.arguments;
    if (data is Uint8List && data.isNotEmpty) {
      try {
        w.send(data);
      } catch (_) {
        /* 对面断了：收尾那一路会把它收干净 */
      }
    }
    return null;
  });

  String? why;
  try {
    why = await _mic.invokeMethod<String?>('start');
  } on PlatformException {
    why = 'failed';
  } on MissingPluginException {
    why = 'unsupported';
  }
  if (why != null) {
    _close(session);
    return why;
  }
  session.micStarted = true;
  if (!identical(_open, session)) {
    // 要权限这一会儿里用户按了停 ⇒ 别把麦克风留在手里
    await _mic.invokeMethod<void>('stop').catchError((Object _) {});
    return 'failed';
  }
  return null; // 真开起来了
}

/// **收手**（用户按了第二下）：停采集 ＋ 跟对面说"结束"，但**留着这条连接**
/// 等它把最后一句吐回来 —— 立刻断掉的话，最后那几个字就丢了。
void stopNativeHearing() {
  final s = _open;
  if (s == null || s.stopping) return;
  s.stopping = true;
  if (s.micStarted) _mic.invokeMethod<void>('stop').catchError((Object _) {});
  try {
    s.wire.send(jsonEncode({'type': 'asr/stop'}));
  } catch (_) {
    /* 对面已经断了 */
  }
  s.linger = Timer(_lingerLimit, () => _close(s));
}

/// 收干净一条（连接、麦克风、那半边的回调）。
void _close(_Session s) {
  if (!identical(_open, s)) return;
  _open = null;
  s.linger?.cancel();
  s.stopping = true;
  if (s.micStarted) _mic.invokeMethod<void>('stop').catchError((Object _) {});
  _mic.setMethodCallHandler(null);
  try {
    s.sub?.cancel();
  } catch (_) {
    /* 已经没了 */
  }
  unawaited(s.wire.close().catchError((Object _) {}));
}

void _closeAll() {
  final s = _open;
  if (s != null) _close(s);
}

/// **原生那一份**：装钩子（**只在 Android 上调**）。
void installNativeHearing() {
  nativeHearingApi = _NativeHearing();
}

class _NativeHearing implements NativeHearingApi {
  @override
  bool get canHear => true; // 真正的判定在 `start` 那一下（没麦克风/没权限各回各的原因）

  @override
  Future<String?> start({
    required Uri url,
    required String token,
    required void Function(Map<String, dynamic>) onEvent,
  }) => startNativeHearing(url: url, token: token, onEvent: onEvent);

  @override
  void stop() => stopNativeHearing();
}
