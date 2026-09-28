// **录一段（本机录音 ＋ 回放）**：网页那一份。
//
// 契约：`docs/dev/128-VOICE-RECORD-AND-PLAY.md`。
//
// ── 三条纪律 ──────────────────────────────────────────────
// ① 🔴 **一个字节都不往外发**：录下来的东西用 `URL.createObjectURL` 变成一条**本机地址**，
//    放的时候喂给一个 `Audio` 元素，**不经过任何网络**（这一块与"试一下"那条刻意不同）。
// ② **开不了就如实说**：没权限 / 这里开不了麦 / 浏览器没那套东西（`MediaRecorder`），
//    每一种回一句机器原因，由界面翻成人话（绝不静默、绝不装）。
// ③ **一次只开一条**：新的开录之前先把上一条收干净（同 `hearing_web.dart` 那条）。
//
// ⚠️ 这一份只在 `flutter build web` 的产物里生效；别的平台是桩（`recorder_stub.dart`）。
//    与 `hearing.dart` / `speech.dart` / `links.dart` 同一条路（条件导出，**零新依赖**）。
//
// ── 为什么采集那一半也是 `js_util` ─────────────────────────
// 🔴 与 `hearing_web.dart` 抬头上那条同源：这个 SDK 的 `dart:html` 里**没有**
//    `AudioContext` / `MediaRecorder` 这些（当场会被 `flutter analyze` 抓住：
//    `Undefined class`）⇒ `getUserMedia` 走 `dart:html`（它在那儿），
//    `MediaRecorder` 走 `dart:js_util`（仍然是 SDK 自带、零新依赖）。

// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:async';
import 'dart:math' as math;
// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;
// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:js_util' as jsu;

import '../models/voice_record.dart';

/// 正在录的那一段（通常 0 或 1 条）。
class _Live {
  _Live({required this.stream, required this.rec, required this.startedAt});

  final html.MediaStream stream;
  final Object rec;
  final int startedAt;
  final List<Object> chunks = <Object>[];
  final Completer<void> stopped = Completer<void>();
}

_Live? _live;

/// 录的时候那一串**音量采样**（0..1，最新在后）。
///
/// 网页这一侧用 `AnalyserNode` 量**时域波形**的均方根（RMS）——
/// 与安卓那边 `getMaxAmplitude()` 是两种量法，但两边都归一、都由
/// `LevelMeter.barHeight` 开方压一下 ⇒ 屏幕上那条轴是一个尺度。
final StreamController<double> _levels = StreamController<double>.broadcast();

/// 录的时候那一串音量采样。**没在录的时候什么都不发。**
Stream<double> get levels => _levels.stream;

/// **上一次录下来那条本机地址**（换新的一段之前要 `revokeObjectURL` 放掉）。
String? _lastUrl;

/// 现在在放的那个元素（一次只放一条）。
html.AudioElement? _playing;

/// 这台设备/这个页面**录得了音吗**。
///
/// ⚠️ 两个都要：有麦克风那套（`mediaDevices`）**而且**浏览器有 `MediaRecorder`
///    （没有它就只是"能开麦、录不下来"—— 那更坏：按钮看着能用，按下去什么都没有）。
bool get canRecord {
  final md = html.window.navigator.mediaDevices;
  if (md == null) return false;
  try {
    return jsu.hasProperty(jsu.globalThis, 'MediaRecorder');
  } catch (_) {
    return false;
  }
}

/// **开录**。
///
/// @returns `null` = 真开起来了；否则一句**机器原因**
///   （`denied` 没权限 / `unsupported` 这里录不了 / `failed` 开不起来）。
Future<String?> recordStart() async {
  _closeLive();
  stopPlay();

  final md = html.window.navigator.mediaDevices;
  if (md == null) return 'unsupported';
  if (!canRecord) return 'unsupported';

  final html.MediaStream stream;
  try {
    stream = await md.getUserMedia({
      'audio': {'channelCount': 1, 'echoCancellation': true, 'noiseSuppression': true},
    });
  } catch (err) {
    final s = err.toString().toLowerCase();
    return (s.contains('notallowed') || s.contains('permission') || s.contains('denied'))
        ? 'denied'
        : 'failed';
  }

  final Object rec;
  try {
    rec = jsu.callConstructor(jsu.getProperty<Object>(jsu.globalThis, 'MediaRecorder'), <Object?>[
      stream,
    ]);
  } catch (_) {
    _stopTracks(stream);
    return 'failed';
  }

  final live = _Live(
    stream: stream,
    rec: rec,
    startedAt: DateTime.now().millisecondsSinceEpoch,
  );
  _live = live;

  // ★ **那份电平**（主人 2026-09-28："录音时，可以检测收到语音，并且给出一个录音
  //   时候的那种时间轴语音bar吗？"）：`AnalyserNode` 量 RMS，每 ~100ms 推一个进流。
  //   ⚠️ 它**只是应答**（屏幕上那条轴），**不进录音数据** —— 音频还是原来那几块。
  _startMeter(stream);

  // 每攒够一块就叫我们一声（`dataavailable`）—— 收手那一下才有东西可拼。
  try {
    jsu.setProperty(
      rec,
      'ondataavailable',
      jsu.allowInterop((Object e) {
        try {
          final blob = jsu.getProperty<Object>(e, 'data');
          final size = jsu.getProperty<num>(blob, 'size');
          if (size > 0) live.chunks.add(blob);
        } catch (_) {
          /* 这一块不要了（不是致命） */
        }
      }),
    );
    jsu.setProperty(
      rec,
      'onstop',
      jsu.allowInterop((Object _) {
        if (!live.stopped.isCompleted) live.stopped.complete();
      }),
    );
    jsu.callMethod(rec, 'start', <Object?>[]);
  } catch (_) {
    _closeLive();
    return 'failed';
  }
  return null;
}

/// 正在采电平的那一套（`AudioContext` ＋ 定时器）—— **一次只有一套**。
Object? _meterCtx;
Timer? _meterTimer;

/// 开始每 ~100ms 量一次电平。**这一台量不了就什么都不推** —— 界面那条轴就不画
/// （"没有读数就不许编一个"）。
void _startMeter(html.MediaStream stream) {
  _stopMeter();
  try {
    final ctx = jsu.callConstructor(
      jsu.getProperty<Object>(jsu.globalThis, 'AudioContext'),
      <Object?>[],
    );
    // ⚠️ Safari 上新建的 `AudioContext` 可能是 **suspended** 的（它不处理 ⇒ 量出来全是 0）
    //    ⇒ 叫它一声（已经在跑的话这是空操作）。我们是在**用户的点击**里建它的，
    //      浏览器的自动播放策略不会拦。
    try {
      jsu.callMethod(ctx, 'resume', <Object?>[]);
    } catch (_) {
      /* 老实现没有 resume —— 那就照旧 */
    }
    final src = jsu.callMethod(ctx, 'createMediaStreamSource', <Object?>[stream]);
    final an = jsu.callMethod(ctx, 'createAnalyser', <Object?>[]);
    jsu.setProperty(an, 'fftSize', 1024);
    jsu.callMethod(src, 'connect', <Object?>[an]);
    _meterCtx = ctx;
    _meterTimer = Timer.periodic(const Duration(milliseconds: 100), (_) {
      try {
        final n = jsu.getProperty<num>(an, 'frequencyBinCount').toInt();
        final buf = jsu.callConstructor(
          jsu.getProperty<Object>(jsu.globalThis, 'Float32Array'),
          <Object?>[n],
        );
        jsu.callMethod(an, 'getFloatTimeDomainData', <Object?>[buf]);
        var sum = 0.0;
        for (var i = 0; i < n; i++) {
          final v = jsu.getProperty<num>(buf, i).toDouble();
          sum += v * v;
        }
        if (!_levels.isClosed) _levels.add(math.sqrt(sum / n));
      } catch (_) {
        // 量不到就算了（不是致命：那条轴画不出来而已）
      }
    });
  } catch (_) {
    _stopMeter();
  }
}

void _stopMeter() {
  _meterTimer?.cancel();
  _meterTimer = null;
  final c = _meterCtx;
  _meterCtx = null;
  if (c != null) {
    try {
      jsu.callMethod(c, 'close', <Object?>[]);
    } catch (_) {
      /* 已经没了 */
    }
  }
}

/// **收手**：停下那一台、把那几块拼成一个 `Blob`、换成一条**本机**地址。
///
/// @returns 那一段；**空的那一段**（一毫秒都不到 / 一个字节都没有）⇒ `null`。
Future<RecordedClip?> recordStop() async {
  final live = _live;
  if (live == null) return null;
  _live = null;

  // ① 先关麦（他按下"停"的那一刻就不该再采了）＋ 电平那一路也停掉
  _stopMeter();
  _stopTracks(live.stream);

  // ② 让 `MediaRecorder` 把最后一块吐出来，然后停下
  try {
    jsu.callMethod(live.rec, 'stop', <Object?>[]);
  } catch (_) {
    /* 已经没了 */
  }
  try {
    await live.stopped.future.timeout(const Duration(seconds: 3));
  } catch (_) {
    /* 它没回话也照旧把手里那几块拼出来（宁可给一段短的，也不装没有） */
  }

  final ms = DateTime.now().millisecondsSinceEpoch - live.startedAt;
  if (live.chunks.isEmpty) return null;

  final Object blob;
  try {
    // ⚠️ 把那一串小块**当成一个参数**传进去（dart2js 会把 Dart `List` 映射成 JS 数组）——
    //    不需要 `js_interop` 的 `toJS`（那要求每一块都是 `JSAny`，而它们是**不透明的** JS 对象）。
    blob = jsu.callConstructor(jsu.getProperty<Object>(jsu.globalThis, 'Blob'), <Object?>[
      live.chunks,
    ]);
  } catch (_) {
    return null;
  }

  final String url;
  try {
    url = jsu.callMethod(jsu.getProperty<Object>(jsu.globalThis, 'URL'), 'createObjectURL', <Object?>[blob]) as String;
  } catch (_) {
    return null;
  }
  // 上一段放掉（它是本机的临时地址，不释放就一直挂着）
  final old = _lastUrl;
  if (old != null && old != url) _revoke(old);
  _lastUrl = url;
  return RecordedClip(url: url, ms: ms);
}

/// **放那一段**（[onEnded] 是它自己放完时叫我们一声 —— 按钮要回到"听一遍"）。
void play(String url, void Function() onEnded) {
  stopPlay();
  try {
    final el = html.AudioElement(url);
    el.onEnded.listen((_) {
      if (identical(_playing, el)) _playing = null;
      onEnded();
    });
    el.onError.listen((_) {
      if (identical(_playing, el)) _playing = null;
      onEnded();
    });
    _playing = el;
    // 🔴 **`play()` 返回的是一个 Promise，而"自动播放被拦"那一下是它 reject** ——
    //    那条路上 **`onError` 根本不响**（Chrome 的原话是 *"play() failed because
    //    the user didn't interact with the document first"*），于是按钮会**一直停在
    //    "别放了"**上：没有声音、屏幕上却说正在放（页面在说假话）。
    //    ⇒ 当场接住它：接住了就按"放完了"收场（按钮回到"听一遍"）。
    //    ⚠️ 这一条是 2026-09-27 在**线上真页面**上用假麦克风录一段时看出来的
    //      （契约 `docs/dev/128` §五·补：按了「听一遍」之后那 7 秒里屏幕上一直写着「别放了」）。
    try {
      final p = jsu.callMethod(el, 'play', <Object?>[]);
      if (p != null) {
        jsu.callMethod(jsu.getProperty<Object>(p, 'catch'), 'call', <Object?>[
          p,
          jsu.allowInterop((Object _) {
            if (identical(_playing, el)) _playing = null;
            onEnded();
          }),
        ]);
      }
    } catch (_) {
      if (identical(_playing, el)) _playing = null;
      onEnded();
    }
  } catch (_) {
    _playing = null;
    onEnded();
  }
}

/// **别放了**。
void stopPlay() {
  final el = _playing;
  _playing = null;
  if (el == null) return;
  try {
    el.pause();
  } catch (_) {
    /* 已经没了 */
  }
}

/// 离开这一屏时**把手里那一段也放掉**（本机临时地址不释放就一直挂着）。
void releaseAll() {
  stopPlay();
  _stopMeter();
  _closeLive();
  final old = _lastUrl;
  _lastUrl = null;
  if (old != null) _revoke(old);
}

void _closeLive() {
  _stopMeter();
  final live = _live;
  _live = null;
  if (live == null) return;
  _stopTracks(live.stream);
  try {
    jsu.callMethod(live.rec, 'stop', <Object?>[]);
  } catch (_) {
    /* 已经没了 */
  }
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

void _revoke(String url) {
  try {
    jsu.callMethod(jsu.getProperty<Object>(jsu.globalThis, 'URL'), 'revokeObjectURL', <Object?>[url]);
  } catch (_) {
    /* 已经没了 */
  }
}
