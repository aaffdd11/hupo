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

import '../models/asr_outbox.dart';
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

/// ★ **2026-10-06：「连接 ＋ 握手」这一拍最多等多久**（那道门的兜底）。
///
/// 🔴 现在这一拍与"开麦采集"是**并行**的（音频先攒在本机，见 `AsrOutbox`）——
///    所以这里多等一会儿**不丢东西**，只是晚一点知道成不成。
///    真读数：冷启那一下**连接**本身量到 **4.4 秒**（热 10~25 ms），
///    再加握手 ~240 ms ⇒ 5 秒太紧（会误报"这条走不通"，而他其实马上就说上了）。
const Duration _verdictLimit = Duration(seconds: 10);

/// 说过"结束"之后，最多再等多久收尾（等那句最后的字回来）。
// ⚠️ **2026-10-05：20 秒**（原来 8）。主人叮嘱过*"要等待语音结束和语义转换结束，
//    不要直接结束"* —— 控制器那条兜底钟（`stopLinger`，15 秒）**必须短于**这一条：
//    这一条一到，连接就收了（之后再不会有任何一帧）⇒ 那边会比它先放弃。
//    ⚠️ 长短关系有判据（`test/unit/hear_drill_test.dart`），改一个要一起改。
const Duration _lingerLimit = Duration(seconds: 20);

/// 手里开着的那些（通常 0 或 1 条；"正在等最后一句"那条也算开着）。
final Set<_Session> _open = <_Session>{};

/// ★ **2026-10-06：热着的那一条连接**（"按下就通"）。
///
/// 🔴 为什么要有它：那条连接**冷启那一次真量到 1.1~4.4 秒**（热的时候 16 ms，见 `199` §二、
///    与 `202` §五·补 那次复测）—— 那一段原来就落在**"按下 → 屏幕上出第一个字"**这条路上。
///    把它挪到"进聊天那一屏"去付（`warmHearing`），按键那一刻就只剩握手那一拍（~200 ms）。
///
/// ⚠️ **它只是"连上了"**：没有麦克风、没有音频图，也**没有跟对面说 `asr/start`**
///    （上游那一跳是 `asr/start` 才开的 ⇒ **预热不花钱**）。
/// ⚠️ **不许一直挂着**：`_warmKeep` 到点自己收；真开始说的时候被 `_takeWarm()` **取走**
///    （取走就不再是"预热"）；一条会话正开着的时候不许再热（`_open` 非空 ⇒ 直接不做）。
WebSocketChannel? _warmCh;
bool _warmOk = false;
Timer? _warmIdle;
/// "收场之后自己热回来"那个定时器（收掉时一起取消，别留下一个孤儿）。
Timer? _warmBack;
/// 上一次用过的地址与令牌 —— 一场说完之后**按它自己热回来**（下一句多半就在几分钟内）。
Uri? _warmUrl;
String? _warmToken;

/// 热着的那条**最多挂多久**（到点自己收掉，别把一条连接永远挂在那儿）。
const Duration _warmKeep = Duration(minutes: 3);
/// 一场说完之后隔多久自己热回来（留一点空当，别在收尾那一拍上抢）。
const Duration _warmAgainAfter = Duration(seconds: 3);

/// 拦住"长按弹出来的那个菜单"（右键 / 手机上的长按菜单）。
StreamSubscription<html.MouseEvent>? _menuBlocker;

/// 🔴 **语音这一档里，长按不许弹浏览器那个菜单**（2026-09-23 主人实测出来的）。
///
/// 原话：*"因为按住会触发默认的右键"* —— 用户会**照着微信的习惯按住**，
/// 而按住在浏览器里会弹出系统/浏览器的右键菜单（选择、复制…那一套）。
/// 这一版已经改成"点一下开始 / 再点一下结束"，但**按住这个动作在语音档里本来就没有别的意思**
/// ⇒ 干脆在这一档里把它按住（出了这一档立刻还回去，别影响别处的选择与复制）。
void _blockMenu(bool on) {
  if (on) {
    if (_menuBlocker != null) return;
    try {
      _menuBlocker = html.document.onContextMenu.listen((e) => e.preventDefault());
    } catch (_) {
      _menuBlocker = null; // 这个浏览器不给拦：不影响功能，只是长按还会弹
    }
    return;
  }
  final sub = _menuBlocker;
  _menuBlocker = null;
  try {
    sub?.cancel();
  } catch (_) {
    /* 已经没了 */
  }
}

class _Session {
  _Session({required this.ch});

  final WebSocketChannel ch;

  /// 顺序（**2026-10-06 改过**）：① 先连上、跟对面说"我要开始了"
  /// ② 🔴 **立刻就要麦克风**（不再等对面说"能听"）③ 音频先往对面送
  /// ④ 回头再看对面那个结论（失败就把麦克风收掉、如实说）。
  /// ⚠️ 为什么②要提前：等那一拍的时候（热 ~240 ms、冷启 ~2.7 s）**麦克风压根没开**
  ///    ⇒ 他开口那几个字从来没被采到过（主人报的"开头说的话可能会少"）。
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

  /// ★ **还没连上时攒着的音频**（见 `models/asr_outbox.dart`）：一包都不丢。
  final AsrOutbox outbox = AsrOutbox();
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
  _warmUrl = url; // 收场之后按它热回来
  _warmToken = token;

  final md = html.window.navigator.mediaDevices;
  if (md == null) return 'unsupported';

  // 🔴🔴 **AudioContext 必须"在用户手势这一拍里"建出来并 `resume()`**
  //   （2026-10-01 主人报"聊天窗口里按了语音、输入框不出字"之后查到的一处**真缺陷**）。
  //
  //   为什么必须在这里：下面是**两次 `await`**（先等 WS 连上、再等上游 `asr/ready`，
  //   然后才 `getUserMedia`）—— 等回来的时候**用户那一下手势已经过期了**。
  //   在 iOS Safari（以及任何严格按自动播放规矩来的浏览器）上，手势之外
  //   `resume()` **叫不醒** `AudioContext` ⇒ 那个 `onaudioprocess` **一次都不回调**
  //   ⇒ 屏幕上写着"正在听"，而**服务端一个字节都收不到** ⇒ 识别那头自然一个字都没有
  //   （表现与"什么都没听到"一模一样，极难查）。
  //   ⚠️ 这正是 `docs/dev/71-MIC-ASR.md` 里记着的那条欠账（"iOS Safari 那套
  //      AudioContext 必须在用户手势里 resume —— 这台机器验不了 iOS"）——
  //      现在把顺序改对了：**先建、先叫醒，再去连**。
  late final Object ctx;
  int rate = 48000;
  try {
    ctx = jsu.callConstructor(
      jsu.getProperty<Object>(jsu.globalThis, 'AudioContext'),
      <Object?>[],
    );
    jsu.callMethod(ctx, 'resume', <Object?>[]);
    rate = jsu.getProperty<num>(ctx, 'sampleRate').round();
  } catch (_) {
    return 'unsupported';
  }
  // ⚠️ **这里不许同步读 `state` 判死**：`resume()` 是**异步**的，刚调完读到的
  //    多半还是 `suspended`（那会误杀本来能用的浏览器）⇒ 真正的判据放到 ③ 那一步
  //    （`await` 过 resume 之后再读，见下）。

  // ── ① 先把那条连接**开出去**（令牌走子协议，和聊天那条一样；**不进 URL**）──
  //
  //   🔴 **2026-10-06 第二处修**（主人：*"我说话以后，没有直接显示语音转换文字，
  //   响应很慢，然后真正出现的时候，前面的几个字可能会不见。"*）：
  //   原来这里是 `await ch.ready` —— **握上手才往下走**，而"握上手"冷启那一下
  //   **真量到 4.4 秒**（热的时候 10~25ms）⇒ 那几秒里麦克风压根没开，
  //   他开头说的字**采都没采**（补不回来）。
  //   ⇒ 现在**不等它**：立刻往下开麦，音频先在**本机**攒着（[AsrOutbox]），
  //     这条连接一握上手就把攒着的按顺序补发。
  //   ⚠️ 失败（网关 / 隧道不认这条路径）**照旧如实说 `no-entry`** ——
  //     只是那句话现在从下面那个 `ready` 回调里来，不是从这一行抛出来。
  final WebSocketChannel ch;
  final warm = _takeWarm(); // ★ 热着的那一条（有就拿去用 —— 这就是"按下就通"）
  if (warm != null) {
    ch = warm;
  } else {
    try {
      ch = WebSocketChannel.connect(url, protocols: ['bearer', token]);
    } catch (_) {
      return 'no-entry';
    }
  }

  final session = _Session(ch: ch);
  _open.add(session);
  _blockMenu(true);

  // ⚠️ **这道门现在只决定"要不要把麦克风收掉"**（2026-10-06 改）：
  //    原来它决定"要不要开麦"，而"按下去"到"能听"之间那一段麦克风压根没开
  //    ⇒ 他开口那几个字**从来没被采到过**（主人报的"开头说的话可能会少"）。
  //    ⇒ 开麦已经挪到下面 ③ 去了（按下去就开）；这里只等它一个结论。
  final gate = Completer<String?>();

  /// **握上手了**（或者**永远握不上**）：补发攒着的音频；握不上就如实报 `no-entry`。
  ///
  /// ⚠️ 这一条是**异步**的（`connect` 不 await），所以它可能在开麦之后才跑到 ——
  ///    那正是要的形状：**采集与连接并行**，谁也别等谁。
  unawaited(() async {
    try {
      await ch.ready;
    } catch (_) {
      // 这一条路走不通（网关 / 隧道不认它）⇒ 让上面那道门如实收场
      if (!gate.isCompleted) gate.complete('no-entry');
      return;
    }
    if (!_open.contains(session)) return; // 这一会儿里已经被收掉了
    // 跟对面说"我要开始了"（上游到这时候才连；它握上手会回 `asr/ready`）
    try {
      ch.sink.add(jsonEncode({'type': 'asr/start'}));
      for (final b in session.outbox.open()) {
        ch.sink.add(b);
      }
    } catch (_) {
      /* 对面已经断了：收尾那一路会把它收干净 */
    }
  }());

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
  // ⚠️ `asr/start` 那一条**已经挪到**上面"握上手"那个回调里了（与补发攒着的音频
  //    一起发）—— 这里一个字节都不发，免得在"还没连上"时先撞一次 sink。

  // ── ② 🔴 **现在就要麦克风 —— 不再等 `asr/ready`**（2026-10-06 修）───────
  //
  //   **主人报的原话**：*"语音处理有问题，开头说的话可能会少。"*
  //   **量出来的根子**：按下去到"对面说能听"之间那一段，麦克风**压根没开** ——
  //   真读数（线上那条路 · 宿主 ⇒ 他自己的盒子 ⇒ 豆包）：
  //     · 热的时候 **~240 ms**；· 冷启第一次 **~2.7 s**
  //   再加上 `getUserMedia` 与接音频图那一点时间 ⇒ **他开口那几个字从来没被采到过**
  //   （采都没采，后面谁也补不回来）。
  //
  //   ⚠️ **为什么现在敢先开**：服务端那一侧**本来就会**把"握上手之前到的音频"
  //   攒住、握上手立刻补发（`src/asr-doubao.js` 的队列 ＋ 判据
  //   `test/asr.test.js`「连上之前推的音频不丢（先攒着，握上手就补发）」）。
  //   ⚠️ 代价如实认下：这台要是**没配钥匙**，他会先看到权限框、再看到"还没配好"
  //   （原来那一下是"先问能不能听、能听才碰麦克风"）—— 宁可多弹一次框，
  //   也不许把他开口那几个字弄丢。
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
  //   ⚠️ 那个 `AudioContext` 是**上面手势里就建好、叫醒过的**（见那段批注）——
  //      这里**只往上接**，绝不再建第二个（再建一个还是会 suspended）。
  try {
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
    // 🔴 **最后一次叫醒 + 真判据**：`await` 它（异步）之后再读 `state` ——
    //    还不是 `running` ⇒ **如实说"这台开不了麦"**，绝不装成"在听"
    //    （装成"在听"的表现就是：屏幕上有"正在听"，而服务端一个字节都收不到）。
    //   ⚠️ **加超时**：`resume()` 那个 promise 在某些浏览器上可能一直 pending
    //      （叫不醒又不报错）—— 不给它上限，屏幕上就会永远挂着"正在听"。
    await jsu
        .promiseToFuture<Object?>(jsu.callMethod(ctx, 'resume', <Object?>[]))
        .timeout(_readyLimit, onTimeout: () => null);
    if (jsu.getProperty<String>(ctx, 'state') != 'running') {
      _close(session);
      return 'unsupported';
    }
    session.ctx = ctx;
    session.source = source;
    session.proc = proc;
    session.gain = gain;
    session.rate = rate; // 用**手势里读到**的那个采样率（同一个 context）
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
    // 🔴 **还没连上就先攒着**（这一句就是"开头那几个字"的落点）：
    //    `add` 在没握上手时把这一包留在本机（一包都不丢），握上手那个回调
    //    会按顺序把它们补发出去。
    for (final b in session.outbox.add(bytes)) {
      try {
        ch.sink.add(b);
      } catch (_) {
        /* 对面断了：收尾那一路会把它收干净 */
      }
    }
  });
  jsu.setProperty(session.proc!, 'onaudioprocess', session.onAudio);

  // ── ③ **回头再看对面怎么说**（音频已经在往那边送了）──────────────
  //   ⚠️ 这一步**不能提前**：早了就等于把上面那段"没开麦的时间"又还回去。
  //   失败（没配钥匙 / 引擎出错 / 连不上）⇒ 把麦克风收掉、如实说（原样）。
  //   ⚠️ 这条兜底钟**只兜"连接 + 握手"这一拍**（现在它俩是并行的，
  //      而冷启那一下真量到 4.4 秒 ⇒ 给得比原来宽一点：攒着的音频不会丢，
  //      所以多等一会儿是**白赚**，不是风险）。
  final verdict = await gate.future.timeout(
    _verdictLimit,
    onTimeout: () => 'no-entry',
  );
  if (verdict != null) {
    _close(session);
    return verdict;
  }

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
  if (_open.isEmpty) {
    _blockMenu(false);
    _warmAgain(); // ★ 一场说完 ⇒ 隔一会儿自己热回来（下一句多半就在几分钟内）
  }
  s.linger?.cancel();
  s.stopping = true;
  // 攒着还没送出去的那些（这条连接没能握上手就结束了）—— 清掉，别留在内存里
  s.outbox.clear();
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
  if (_open.isEmpty) _blockMenu(false); // 一条都不剩 ⇒ 把菜单还回去
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

// ── ★ **预热那一半**（2026-10-06 · "按下就通"）────────────────────────
//
// 🔴 这一半只做一件事：**把那条连接先连上**。它不发 `asr/start`（⇒ 上游不开、不花钱）、
//    不碰麦克风。它的全部价值就是**把那 1.1~4.4 秒从按键那一刻挪到"进聊天那一屏"**。

/// **先连上**（进聊天那一屏就调它）。重复调没事；一次会话正开着时不热（那会多一条）。
Future<void> warmHearing({required Uri url, required String token}) async {
  _warmUrl = url;
  _warmToken = token;
  if (_warmCh != null) return; // 已经热着一条
  if (_open.isNotEmpty) return; // 正在说 —— 这时候再开一条是浪费
  final WebSocketChannel ch;
  try {
    ch = WebSocketChannel.connect(url, protocols: ['bearer', token]);
  } catch (_) {
    return; // 连都连不出去 ⇒ 静默（按下去那一下会照旧如实报 `no-entry`）
  }
  _warmCh = ch;
  _warmOk = false;
  _warmIdle?.cancel();
  _warmIdle = Timer(_warmKeep, () {
    if (identical(_warmCh, ch)) _dropWarm();
  });
  try {
    await ch.ready;
  } catch (_) {
    if (identical(_warmCh, ch)) _dropWarm();
    return;
  }
  if (!identical(_warmCh, ch)) return; // 这一会儿里已经被取走/收掉了
  _warmOk = true;
}

/// **把热着的那条取走**（真开始说的时候）。不健康（没连上过 / 已经被对面关了）⇒
/// 丢掉并回 `null`（调用方照旧现连一条 —— **宁可慢一点，不许拿着一条死的**）。
WebSocketChannel? _takeWarm() {
  final ch = _warmCh;
  if (ch == null) return null;
  final ok = _warmOk && ch.closeCode == null;
  _dropWarm();
  return ok ? ch : null;
}

/// 把热着的那条收掉（过期 / 取走 / 连不上）。
void _dropWarm() {
  _warmIdle?.cancel();
  _warmIdle = null;
  _warmBack?.cancel();
  _warmBack = null;
  final ch = _warmCh;
  _warmCh = null;
  _warmOk = false;
  if (ch == null) return;
  try {
    ch.sink.close();
  } catch (_) {
    /* 已经没了 */
  }
}

/// **一场说完之后自己热回来**（下一句多半就在几分钟内 —— 不热的话又得付那次冷连）。
void _warmAgain() {
  final url = _warmUrl;
  final token = _warmToken;
  if (url == null || token == null) return;
  _warmBack?.cancel();
  _warmBack = Timer(_warmAgainAfter, () {
    _warmBack = null;
    unawaited(warmHearing(url: url, token: token));
  });
}
