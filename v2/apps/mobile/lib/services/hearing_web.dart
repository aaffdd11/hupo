// **真开麦**（网页那一份）：麦克风 → 16k 单声道 PCM → 我们那条 `/api/asr`。
//
// 契约：`docs/dev/71-MIC-ASR.md`（形状、判据、没做的）。
//
// ── 三条纪律 ──────────────────────────────────────────────
// ① **只在我们这条路上走**：音频发给我们自己的服务端，**不直连腾讯云** ——
//    直连就得把 SecretKey 交给浏览器（那等于把钥匙摆在 devtools 里）。
// ② **开不了麦就如实说**，绝不用假的字糊过去（这一版**砍掉了**原来那个"演示"）。
// ③ **一次只开一条**：新的开始之前先把旧的收干净（否则两条流一起往里灌字）。
//
// ⚠️ 这一份只在 `flutter build web` 的产物里生效；别的平台是桩（`hearing_stub.dart`）。
//    与 `speech.dart` / `links.dart` 同一条路（条件导出 + 各平台一份）。
//
// ── 为什么采集那一半是 `js_util` 而不是 `dart:html` 里那几个类 ──────
// 🔴 **这个 SDK 的 `dart:html` 里没有 `AudioContext` / `GainNode` / `ScriptProcessorNode`**
//    （2026-09-23 当场被 `flutter analyze` 抓住：`Undefined class 'AudioContext'`；
//      `dart:web_audio` 这个库分析器又不认 —— `Target of URI doesn't exist`）。
//    ⇒ `getUserMedia` 走 `dart:html`（它在那儿），音频图走 `dart:js_util`
//      （**仍然是 SDK 自带、零新依赖**；只是那半边是弱类型的）。
//    ⚠️ 想换 `package:web` 的话要**几个 `_web.dart` 一起换**。
// ⚠️ 用 `ScriptProcessorNode`（已标废弃，但**到处都能跑**，也不需要单独一个 worklet 文件）
//    —— 判据要的是"真的采到声音"，不是"用了最新的 API"。

// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:async';
// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:convert';
// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;
import 'dart:js_interop';
// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:js_util' as jsu;

import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/pcm16.dart';

/// 这个页面能不能真开麦。
///
/// ⚠️ 看的是**浏览器到底有没有那个东西**：不是 https（或者不是 localhost）的页面上
///    `navigator.mediaDevices` 压根不存在 ⇒ 如实返回 `false`，
///    界面据此**不画那个话筒**（"开不了就别画"）。
bool get canHear => html.window.navigator.mediaDevices != null;

/// 一次采集多少帧（`ScriptProcessor` 的块大小）。
/// ⚠️ 它只是**缓冲粒度**，不是"某个尺寸"：48000 采样率下 ≈ 85 毫秒一片。
const int _blockFrames = 4096;

/// 连上之后最多等多久"这台能不能听"（上游握手那一拍）。
const Duration _readyLimit = Duration(seconds: 5);

/// 说过"结束"之后，最多再等多久收尾（等那句最后的字回来）。
const Duration _lingerLimit = Duration(seconds: 8);

/// 手里开着的那些（通常 0 或 1 条；"正在等最后一句"那条也算开着）。
final Set<_Session> _open = <_Session>{};

class _Session {
  _Session({required this.ch});

  final WebSocketChannel ch;

  /// 下面这几样**都是要过一会儿才有的** —— 顺序是：
  /// ① 先连上、问对面"这台能不能听" ② 能听才去要麦克风 ③ 才建音频图。
  /// ⚠️ 这个顺序是有用的：**没配钥匙的部署不该让用户先看到一个麦克风权限框**
  ///    （2026-09-23 在线上实测到：先弹权限、再说"没配好"，白打扰一次）。
  html.MediaStream? stream;

  /// 音频图那几个节点与那个上下文。
  /// ⚠️ 类型写 `Object` 而不是 `JSObject`：这个 SDK 上分析器**认不出 `JSObject`**
  ///    （`Undefined class 'JSObject'`），而 `dart:js_util` 那几个 API 本来就收 `Object`。
  Object? ctx;
  Object? source;
  Object? proc;
  Object? gain;

  /// 采到的时候那个采样率（`AudioContext.sampleRate`）。
  int rate = 48000;

  /// 那个回调要**留住引用**（不然可能被回收；收尾时也要把它摘下来）。
  Function? onAudio;
  StreamSubscription<dynamic>? wire;
  Timer? linger;
  bool stopping = false;
}

/// **开麦**。
///
/// @returns `null` = 真的开起来了；否则是一句**机器原因**
///   （`'denied'` 没权限 / `'unsupported'` 这个页面开不了 / `'failed'` 开麦失败）。
Future<String?> startHearing({
  required Uri url,
  required String token,
  required void Function(Map<String, dynamic>) onEvent,
}) async {
  _closeAll(); // ③ 一次只开一条

  final md = html.window.navigator.mediaDevices;
  if (md == null) return 'unsupported';

  // ── ① 先连上（令牌走子协议，和聊天那条一样；**不进 URL**）──────────
  final WebSocketChannel ch;
  try {
    ch = WebSocketChannel.connect(url, protocols: ['bearer', token]);
    await ch.ready;
  } catch (_) {
    // ⚠️ **这一句和"麦克风开不了"不是一回事**：那一步失败通常意味着
    //    这条连接在中间某一跳就断了（网关 / 隧道不认这条路径）。
    //    两句混在一起报，页面就在说假话（2026-09-23 在线上真的踩到了：
    //    公网 nginx 没给 `/api/asr` 配升级头 ⇒ 屏幕上却说"开不了麦克风"）。
    return 'no-entry';
  }

  final session = _Session(ch: ch);
  _open.add(session);

  // 🔴 **在对面说"能听"之前，一下都不去碰麦克风**：
  //    没配钥匙的部署上先弹一个权限框、再说"没配好"，是白打扰一次
  //    （2026-09-23 在线上实测到的就是这个顺序问题）。
  final gate = Completer<String?>();
  session.wire = ch.stream.listen(
    (raw) {
      if (raw is! String) return;
      if (!_open.contains(session)) return; // 已经换了一条：旧的不认
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
        // ⚠️ **只有 `asr/ready`（上游握手真的成了）才算能听**
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
  // 跟对面说"我要开始了"（上游到这时候才连；它握上手会回 `asr/ready`）
  try {
    ch.sink.add(jsonEncode({'type': 'asr/start'}));
  } catch (_) {
    /* 对面已经断了 */
  }

  final verdict = await gate.future.timeout(
    _readyLimit,
    onTimeout: () => 'no-entry',
  );
  if (verdict != null) {
    _close(session);
    return verdict;
  }

  // ── ② 对面能听 ⇒ 现在才去要麦克风（用户手势还在这一拍里）──────────
  final html.MediaStream stream;
  try {
    stream = await md.getUserMedia({
      'audio': {
        'channelCount': 1,
        'echoCancellation': true,
        'noiseSuppression': true,
      },
    });
  } catch (err) {
    _close(session);
    final s = err.toString().toLowerCase();
    return (s.contains('notallowed') ||
            s.contains('permission') ||
            s.contains('denied'))
        ? 'denied'
        : 'failed';
  }
  if (!_open.contains(session)) {
    // 要权限这一会儿里用户按了停 ⇒ 别把麦克风留在手里
    _stopTracks(stream);
    return 'failed';
  }
  session.stream = stream;

  // ── ③ 音频图：麦克风 → 16k 单声道 PCM → 对面 ────────────────────
  try {
    final ctx = jsu.callConstructor(
      jsu.getProperty<Object>(jsu.globalThis, 'AudioContext'),
      <Object?>[],
    );
    final source = jsu.callMethod(ctx, 'createMediaStreamSource', <Object?>[
      stream,
    ]);
    final proc = jsu.callMethod(ctx, 'createScriptProcessor', <Object?>[
      _blockFrames,
      1,
      1,
    ]);
    final gain = jsu.callMethod(ctx, 'createGain', <Object?>[]);
    // 🔴 **增益 0**：这一条只是为了"把处理器拉起来"，
    //    绝不能把用户自己的声音从喇叭放出来（那会啸叫）。
    jsu.setProperty(jsu.getProperty<Object>(gain, 'gain'), 'value', 0);
    jsu.callMethod(source, 'connect', <Object?>[proc]);
    jsu.callMethod(proc, 'connect', <Object?>[gain]);
    jsu.callMethod(gain, 'connect', <Object?>[
      jsu.getProperty<Object>(ctx, 'destination'),
    ]);
    // 刚建出来时可能是 suspended（自动播放那套规矩）——按用户的手势把它叫醒
    jsu.callMethod(ctx, 'resume', <Object?>[]);
    session.ctx = ctx;
    session.source = source;
    session.proc = proc;
    session.gain = gain;
    session.rate = jsu.getProperty<num>(ctx, 'sampleRate').round();
  } catch (_) {
    _close(session);
    return 'failed';
  }

  session.onAudio = jsu.allowInterop((Object e) {
    if (session.stopping) return; // 说过结束了就别再推（对面已经在收尾）
    final ib = jsu.getProperty<Object>(e, 'inputBuffer');
    // ⚠️ 这里**用 `as` 不用 `is`**：对 JS interop 类型做 `is` 判断会被分析器
    //    判成"跨平台不一致"（`invalid_runtime_check_with_js_interop_types`）。
    //    `getChannelData` 回来的一定是 Float32Array（接口就是这么定的）。
    final frames =
        (jsu.callMethod(ib, 'getChannelData', <Object?>[0]) as JSFloat32Array)
            .toDart;
    final bytes = pcm16FromFloat(frames, sampleRate: session.rate);
    if (bytes.isEmpty) return;
    try {
      ch.sink.add(bytes);
    } catch (_) {
      /* 对面断了：收尾那一路会把它收干净 */
    }
  });
  jsu.setProperty(session.proc!, 'onaudioprocess', session.onAudio);

  return null; // 真开起来了
}

/// **收手**（用户按了第二下）：关麦 + 跟对面说"结束"，但**留着这条连接**
/// 等它把最后一句吐回来 —— 立刻断掉的话，最后那几个字就丢了。
void stopHearing() {
  for (final s in _open.toList()) {
    if (s.stopping) continue;
    s.stopping = true;
    _stopCaptureHardware(s);
    try {
      s.ch.sink.add(jsonEncode({'type': 'asr/stop'}));
    } catch (_) {
      /* 对面已经断了 */
    }
    // 兜底：对面一直不回，也要收干净（不能把连接挂在那儿）
    s.linger = Timer(_lingerLimit, () => _close(s));
  }
}

/// 收干净一条（连接、音频图、麦克风）。
void _close(_Session s) {
  if (!_open.remove(s)) return;
  s.linger?.cancel();
  s.stopping = true;
  _stopCaptureHardware(s);
  try {
    s.wire?.cancel();
  } catch (_) {
    /* 已经没了 */
  }
  try {
    s.ch.sink.close();
  } catch (_) {
    /* 已经没了 */
  }
}

void _closeAll() {
  for (final s in _open.toList()) {
    _close(s);
  }
}

/// 麦克风与音频图这一半（**立刻**放掉：用户按了结束，就不该再采）。
/// ⚠️ 这几样**可能是 null**（还没走到建音频图那一步就被停了）—— 都要认。
void _stopCaptureHardware(_Session s) {
  if (s.proc != null) {
    try {
      jsu.setProperty(s.proc!, 'onaudioprocess', null);
    } catch (_) {
      /* 已经没了 */
    }
  }
  s.onAudio = null;
  for (final node in [s.proc, s.gain, s.source]) {
    if (node == null) continue;
    try {
      jsu.callMethod(node, 'disconnect', <Object?>[]);
    } catch (_) {
      /* 已经没了 */
    }
  }
  if (s.ctx != null) {
    try {
      jsu.callMethod(s.ctx!, 'close', <Object?>[]);
    } catch (_) {
      /* 已经没了 */
    }
  }
  final stream = s.stream;
  if (stream != null) _stopTracks(stream);
}

void _stopTracks(html.MediaStream stream) {
  try {
    for (final t in stream.getTracks()) {
      t.stop();
    }
  } catch (_) {
    /* 已经没了 */
  }
}
