// **真开麦（安卓那一份）**：`AudioRecord` 取 16k 单声道 PCM → 我们那条 `/api/asr`。
//
// 契约：`docs/dev/129-NATIVE-ANDROID-BUILD.md` §十四。
// 真东西两半：
//   · Kotlin 那半：`android/app/src/main/kotlin/chat/hupo/hupo_app/NativeMic.kt`（采 PCM、
//     第一次按下去才问权限）；
//   · 这一份：连我们那条 `/api/asr`、把帧送出去、把回帧翻成事件。
//
// ── 与网页那一份（`hearing_web.dart`）**逐条对齐**（不然同一件事会有两种说法）──
//   ① 🔴 **先连上、跟对面说"我要开始了"，然后立刻就要麦克风**（2026-10-06 改：
//      原来要等 `asr/ready` 才开麦，而"按下去"到"能听"之间那一段 **~240 ms（冷启 ~2.7 s）**
//      麦克风压根没开 ⇒ **他开口那几个字从来没被采到过**，主人报的"开头说的话可能会少"
//      就是它；音频先送出去，服务端会把"握上手之前到的"攒住再补发）。
//      ⚠️ 代价如实认下：没配钥匙的部署上他会**先看到权限框、再看到"还没配好"**
//      —— 宁可多弹一次框，也不许弄丢开头那几个字。
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
import '../models/asr_outbox.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'hearing.dart';

/// 与 Kotlin 那一侧（`MainActivity.HEARING_CHANNEL`）**必须逐字一致**。
const String _channelName = 'hupo/hearing';

/// ★ **2026-10-06：「连接 ＋ 握手」这一拍最多等多久**（那道门的兜底）。
///
/// 🔴 现在这一拍与"开麦采集"是**并行**的（音频先攒在本机，见 `AsrOutbox`）——
///    所以这里多等一会儿**不丢东西**，只是晚一点知道成不成。
///    真读数：冷启那一下**连接**本身量到 **4.4 秒**（热 10~25 ms），
///    再加握手 ~240 ms ⇒ 5 秒太紧（会误报"这条走不通"，而他其实马上就说上了）。
///    ⚠️ 与网页那份**同一个数**（两处各写一份会漂，判据 `hearing_open_order_test` 盯着）。
const Duration _verdictLimit = Duration(seconds: 10);

/// 说过"结束"之后，最多再等多久收尾（等那句最后的字回来）。
// ⚠️ **2026-10-05：20 秒**（原来 8）。主人叮嘱过*"要等待语音结束和语义转换结束，
//    不要直接结束"* —— 控制器那条兜底钟（`stopLinger`，15 秒）**必须短于**这一条：
//    这一条一到，连接就收了（之后再不会有任何一帧）⇒ 那边会比它先放弃。
//    ⚠️ 长短关系有判据（`test/unit/hearing_session_test.dart`），改一个要一起改。
const Duration _lingerLimit = Duration(seconds: 20);

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

  /// ★ **这条还活着吗**（2026-10-06 · 预热用）：对面已经关掉它的话，**不许**拿去用
  ///    （宁可现连一条慢一点，也不许拿着一条死的当"热的"）。
  /// ⚠️ 给个**具体成员**（默认 `true`）：判据里那些假线不用为此改一个字。
  bool get alive => true;
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
  bool get alive => _ch.closeCode == null;

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

  /// ★ **还没连上时攒着的音频**（见 `models/asr_outbox.dart`）：一包都不丢。
  final AsrOutbox outbox = AsrOutbox();
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

  // ── ① 把那条连接**开出去**（令牌走子协议 `['bearer', token]`，和聊天那条一样；**不进 URL**）──
  //
  //   🔴 **2026-10-06 第二处修**（主人：*"我说话以后，没有直接显示语音转换文字，
  //   响应很慢，然后真正出现的时候，前面的几个字可能会不见。"*）：
  //   原来这里是 `await w.ready` —— **握上手才往下走**，而"握上手"冷启那一下
  //   **真量到 4.4 秒**（热的时候 10~25ms）⇒ 那几秒里麦克风压根没开，
  //   他开头说的字**采都没采**（补不回来）。
  //   ⇒ 现在**不等它**：立刻往下开麦，音频先在**本机**攒着（[AsrOutbox]），
  //     这条连接一握上手就把攒着的按顺序补发。
  //   ⚠️ 失败（网关 / 隧道不认这条路径）**照旧如实说 `no-entry`** ——
  //     只是那句话现在从下面那个 `ready` 回调里来，不是从这一行抛出来。
  _warmUrl = url; // 收场之后按它热回来
  _warmToken = token;
  final AsrWire w;
  final warm = _takeWarm(); // ★ 热着的那一条（有就拿去用 —— 这就是"按下就通"）
  if (warm != null) {
    w = warm;
  } else {
    try {
      w = asrWireFactory(url, <String>['bearer', token]);
    } catch (_) {
      return 'no-entry';
    }
  }

  final session = _Session(w, onEvent);
  _open = session;

  // ── ② 接住对面的回话（**开麦已经不等它了** —— 见下面 ③ 那段批注）────
  final gate = Completer<String?>();

  /// **握上手了**（或者**永远握不上**）：补发攒着的音频；握不上就如实报 `no-entry`。
  ///
  /// ⚠️ 这一条是**异步**的（`connect` 不 await），所以它可能在开麦之后才跑到 ——
  ///    那正是要的形状：**采集与连接并行**，谁也别等谁。
  unawaited(() async {
    try {
      await w.ready;
    } catch (_) {
      if (!gate.isCompleted) gate.complete('no-entry');
      return;
    }
    if (!identical(_open, session)) return; // 这一会儿里已经被收掉了
    try {
      w.send(jsonEncode({'type': 'asr/start'}));
      for (final b in session.outbox.open()) {
        w.send(b);
      }
    } catch (_) {
      /* 对面已经断了：收尾那一路会把它收干净 */
    }
  }());

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
  // ⚠️ `asr/start` 那一条**已经挪到**上面"握上手"那个回调里了（与补发攒着的音频
  //    一起发）—— 这里一个字节都不发，免得在"还没连上"时先撞一次 send。

  if (myGen != _generation || !identical(_open, session)) {
    _close(session);
    return 'failed';
  }

  // ── ③ 🔴 **现在就要麦克风 —— 不再等 `asr/ready`**（2026-10-06 修）────
  //
  //   **主人报的原话**：*"语音处理有问题，开头说的话可能会少。"*
  //   **量出来的根子**：按下去到"对面说能听"之间那一段，麦克风**压根没开** ——
  //   真读数（线上那条路 · 宿主 ⇒ 他自己的盒子 ⇒ 豆包）：热的时候 **~240 ms**、
  //   冷启第一次 **~2.7 s** ⇒ **他开口那几个字从来没被采到过**（采都没采，补不回来）。
  //
  //   ⚠️ **为什么现在敢先开**：服务端那一侧**本来就会**把"握上手之前到的音频"
  //   攒住、握上手立刻补发（`src/asr-doubao.js` 的队列 ＋ 判据 `test/asr.test.js`
  //   「连上之前推的音频不丢」）。⚠️ 代价如实认下：这台要是**没配钥匙**，
  //   他会先看到权限框、再看到"还没配好" —— 宁可多弹一次框，也不许弄丢开头那几个字。
  //
  // ⚠️ 帧从 Kotlin 那半回来（`onAudio`，16k 单声道 PCM16），到这里原样送出去。
  //   🔴 **还没连上就先攒着**（这一句就是"开头那几个字"的落点）：`add` 在没握上手时
  //      把这一包留在本机（一包都不丢），握上手那个回调会按顺序把它们补发出去。
  _mic.setMethodCallHandler((call) async {
    if (call.method != 'onAudio') return null;
    final s = _open;
    if (s == null || !identical(s, session) || s.stopping) return null;
    final data = call.arguments;
    if (data is Uint8List && data.isNotEmpty) {
      for (final b in s.outbox.add(data)) {
        try {
          w.send(b);
        } catch (_) {
          /* 对面断了：收尾那一路会把它收干净 */
        }
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

  // ── ④ **回头再看对面怎么说**（音频已经在往那边送了）────────────────
  //   ⚠️ 这一步**不能提前**：早了就等于把上面那段"没开麦的时间"又还回去。
  //   失败（没配钥匙 / 引擎出错 / 连不上）⇒ 把麦克风收掉、如实说（原样）。
  final verdict = await gate.future.timeout(warm == null ? _verdictLimit : _warmAliveLimit,
      onTimeout: () => 'no-entry');
  if (verdict != null) {
    _close(session);
    return verdict;
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
  _warmAgain(); // ★ 一场说完 ⇒ 隔一会儿自己热回来（下一句多半就在几分钟内）
  s.linger?.cancel();
  s.stopping = true;
  // 攒着还没送出去的那些（这条连接没能握上手就结束了）—— 清掉，别留在内存里
  s.outbox.clear();
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

// ── ★ **预热那一半**（2026-10-06 · "按下就通"）────────────────────────
//
// 🔴 只做一件事：**把那条连接先连上**。不发 `asr/start`（⇒ 上游不开、不花钱）、
//    不碰麦克风、不碰权限。全部价值就是**把那 1.1~4.4 秒从按键那一刻挪到进聊天那一屏**。

/// 热着的那条（`null` = 没有）。
AsrWire? _warm;
bool _warmOk = false;
Timer? _warmIdle;
/// "收场之后自己热回来"那个定时器（收掉时一起取消，别留下一个孤儿）。
Timer? _warmBack;
Uri? _warmUrl;
String? _warmToken;

/// 热着的那条**最多挂多久**（到点自己收掉，别把一条连接永远挂在那儿）。
///
/// 🔴 **2026-10-07 收紧：3 分钟 → 60 秒**（主人报 *"初次点击会出现 failed，
///    第二次再点击就好了"*）：中间那一层（隧道 / 网关）会**悄悄收掉**一条长时间
///    没动静的连接，而本地**既不响也不报错** ⇒ 那一条看着还活着、其实已经死了
///    （`_takeWarm()` 那个 `alive` 判不出来）。挂得越久、撞上一条死的概率越高
///    ⇒ 宁可偶尔多付一次握手，也不许按下那一下撞上一条死的。
const Duration _warmKeep = Duration(seconds: 60);

/// **那条热着的连接最多等它多久算"死的"**。
///
/// ⚠️ 只用在**热着的那条**上：热的那条握上手只要 10~25 ms，它背后上游那一跳
///    最坏 ~2.7 秒 ⇒ 4 秒足够它开口，又不至于让他干等。不开口 ⇒ 当成死的，
///    当场换一条新的再试一次（控制器的 `voiceWhyRetryable` 那一跳）。
///    **新连的那条**照旧用 `_verdictLimit`（10 秒：冷启那一跳本来就慢）。
const Duration _warmAliveLimit = Duration(seconds: 4);
const Duration _warmAgainAfter = Duration(seconds: 3);

/// **先连上**（进聊天那一屏就调它）。重复调没事；一次会话正开着时不热（那会多一条）。
Future<void> warmNativeHearing({required Uri url, required String token}) async {
  _warmUrl = url;
  _warmToken = token;
  if (_warm != null) return;
  if (_open != null) return; // 正在说 —— 这时候再开一条是浪费
  final AsrWire w;
  try {
    w = asrWireFactory(url, <String>['bearer', token]);
  } catch (_) {
    return; // 连都连不出去 ⇒ 静默（按下去那一下会照旧如实报 `no-entry`）
  }
  _warm = w;
  _warmOk = false;
  _warmIdle?.cancel();
  _warmIdle = Timer(_warmKeep, () {
    if (identical(_warm, w)) _dropWarm();
  });
  try {
    await w.ready;
  } catch (_) {
    if (identical(_warm, w)) _dropWarm();
    return;
  }
  if (!identical(_warm, w)) return; // 这一会儿里已经被取走/收掉了
  _warmOk = true;
}

/// **把热着的那条取走**（真开始说的时候）。不健康 ⇒ 丢掉并回 `null`。
AsrWire? _takeWarm() {
  final w = _warm;
  if (w == null) return null;
  final ok = _warmOk && w.alive;
  _dropWarm();
  return ok ? w : null;
}

/// 把热着的那条收掉（过期 / 取走 / 连不上）。
void _dropWarm() {
  _warmIdle?.cancel();
  _warmIdle = null;
  _warmBack?.cancel();
  _warmBack = null;
  final w = _warm;
  _warm = null;
  _warmOk = false;
  if (w == null) return;
  unawaited(w.close().catchError((Object _) {}));
}

/// **一场说完之后自己热回来**。
void _warmAgain() {
  final url = _warmUrl;
  final token = _warmToken;
  if (url == null || token == null) return;
  _warmBack?.cancel();
  _warmBack = Timer(_warmAgainAfter, () {
    _warmBack = null;
    unawaited(warmNativeHearing(url: url, token: token));
  });
}

/// （给判据用的）把"热着的那条"与"还挂着的那一轮"都清干净
/// —— 判据之间不许互相带状态（**生产里没有人调它**；同 `clearNativeHearing()` 那条路）。
void resetHearingForTest() {
  _dropWarm();
  final s = _open;
  if (s == null) return;
  _open = null;
  s.linger?.cancel();
  s.stopping = true;
  try {
    s.sub?.cancel();
  } catch (_) {
    /* 已经没了 */
  }
  unawaited(s.wire.close().catchError((Object _) {}));
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

  @override
  Future<void> warm({required Uri url, required String token}) =>
      warmNativeHearing(url: url, token: token);
}
