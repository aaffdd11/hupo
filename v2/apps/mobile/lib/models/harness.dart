// **「我自己那台」那条路的纯逻辑**（契约 `docs/dev/81-HARNESS-ENTRY.md` §5.2 / §5.4）。
//
// ── 这一份守什么 ──────────────────────────────────────────
//   ① **线上消息只有三种**（契约 §5.2，字段冻结）：
//        发 `{"t":"say","text":…}` / `{"t":"stop"}`
//        收 `{"t":"state","s":"booting"|"ready"|"gone","why":…}` / `{"t":"raw","m":<对象>}`
//      ⇒ 编码/解码都只有这一处，于是它能进 `test/unit` 被逐字钉住。
//   ② 🔴 **`raw.m` 是 DSH stdout 的原样**（JSON-RPC）。这一份负责把**已知**的那些
//      `session.event` 画成人话；**未知的一律不藏** —— 画成「类型 + 一小段 JSON」
//      （判据 H8）。这条是"原样显示"唯一的判据落点。
//   ③ **不碰传输、不碰界面**：不发网络、不 import flutter（楼层闸
//      `test/unit/import_rules_test.dart`）⇒ 它进 `test/unit` 硬闸。
//
// ⚠️ 已知事件那张表**是照 DSH 自己的类型声明抄的**，不是猜的：
//    `@deepseek-ai/dsh-api-session-controller` 的 `SessionEventMap`
//    （`turn/start{turn}` · `step/start{turn,step}` · `assistant/message{turn,step,message,usage?}`
//     · `turn/end{turn,reason{kind}}` · `request/header{header{tools?},reason}` ·
//     `session/title{title}` · `sandbox/mode{mode}` · `approval/policy{policy}` ·
//     `agent/inbox/spliced{inserted,…}` …），`assistant/message` 的
//    `message.content` 是 `[{type:'text'|'reasoning'|…, text?}]`（`docs/dev/05-AGENT.md` §一）。

import 'dart:async';
import 'dart:convert';

import 'harness_words.dart';

// ── 发出去那两条（契约 §5.2）──────────────────────────────────

/// `{"t":"say","text":"…"}`。
///
/// ⚠️ 键序固定（`t` 在前）—— 判据逐字比字符串，改顺序就等于改协议。
String harnessSayFrame(String text) => jsonEncode({'t': 'say', 'text': text});

/// `{"t":"stop"}`：放弃这一轮（对面把那个进程收掉）。
const String harnessStopFrame = '{"t":"stop"}';

// ── 收回来那两条 ─────────────────────────────────────────────

/// 那一台现在什么状态（契约 §5.2 的 `state`）。
enum HarnessState { booting, ready, gone }

/// 一条 `state`（`why` 只在 `gone` 时给，而且**是对面给的人话**）。
class HarnessStatus {
  const HarnessStatus(this.state, [this.why]);
  final HarnessState state;
  final String? why;
}

/// `{"t":"state",…}` → [HarnessStatus]；**不是它、或者 `s` 认不出来 ⇒ `null`**
/// （fail-closed：认不出来的状态**不许**当成某个已知状态，那会让界面说假话）。
HarnessStatus? harnessStatusOf(Object? decoded) {
  if (decoded is! Map) return null;
  if (decoded['t'] != 'state') return null;
  final s = switch (decoded['s']) {
    'booting' => HarnessState.booting,
    'ready' => HarnessState.ready,
    'gone' => HarnessState.gone,
    _ => null,
  };
  if (s == null) return null;
  final why = decoded['why'];
  return HarnessStatus(
    s,
    why is String && why.trim().isNotEmpty ? why.trim() : null,
  );
}

/// 一行线上回来的东西。
sealed class HarnessIncoming {
  const HarnessIncoming();
}

/// 一条状态变化。
class HarnessStateIn extends HarnessIncoming {
  const HarnessStateIn(this.status);
  final HarnessStatus status;
}

/// 一条原样的 JSON-RPC（`m` 原样，**一个字段都不许动**）。
class HarnessRawIn extends HarnessIncoming {
  const HarnessRawIn(this.m);
  final Object? m;
}

/// 一帧文本 → 解出来的东西；**认不出来 ⇒ `null`**（安静丢掉，不猜）。
HarnessIncoming? harnessIncomingOf(String frame) {
  Object? decoded;
  try {
    decoded = jsonDecode(frame);
  } catch (_) {
    return null;
  }
  if (decoded is! Map) return null;
  final t = decoded['t'];
  if (t == 'state') {
    final st = harnessStatusOf(decoded);
    return st == null ? null : HarnessStateIn(st);
  }
  if (t == 'raw') return HarnessRawIn(decoded['m']);
  return null;
}

// ── 原始消息 → 屏幕上的行（H8）────────────────────────────────

/// 这一行是什么（界面按它挑样子；**不许**把已知的画成未知、也不许反过来）。
enum HarnessLineKind {
  /// 一轮的开始 / 结束（`turn/start` · `turn/end`）。
  turn,

  /// 一步的边界（`step/start` · `step/end`）。
  step,

  /// 它吐出来的字（`assistant/message` 的 `text` 块）。
  text,

  /// 它的思考（`assistant/message` 的 `reasoning` 块）—— 原样，但看得出来是"想"。
  think,

  /// 用户自己那句话的回显（`user/message`）。
  user,

  /// 它那边定的东西（`system/message`）。
  system,

  /// 一行说明或者摘要（`request/header` 那类）。
  folded,

  /// 别的说明。
  note,

  /// 🔴 **没见过的**：`text` 是类型，`detail` 是那一小段 JSON。**一个都不许藏**。
  unknown,
}

/// 屏幕上的一行。
class HarnessLine {
  const HarnessLine(this.kind, this.text, {this.detail});
  final HarnessLineKind kind;
  final String text;

  /// 跟着这行一起显示的 JSON（未知事件 / 一条里没有字的那些）。
  final String? detail;

  @override
  String toString() => detail == null ? '$kind($text)' : '$kind($text) $detail';
}

/// 那一小段 JSON 最多留多少个字（多出来的截掉，末尾加省略号）。
const int harnessSnippetMax = 400;

/// 把一条 `raw.m` 画成屏幕上的行（**可能不止一行**：一条消息里有好几块字）。
///
/// 🔴 兜底那一条就是判据 H8：**未知 ⇒ 「类型 + 一小段 JSON」**，绝不返回空。
List<HarnessLine> harnessLinesOf(Object? m) {
  if (m is! Map) {
    return [
      HarnessLine(HarnessLineKind.unknown, harnessUnknownLine, detail: harnessSnippet(m)),
    ];
  }
  final method = m['method'];
  if (method == 'session.event') {
    final params = m['params'];
    final event = params is Map ? params['event'] : null;
    if (event is! Map) {
      return [
        HarnessLine(HarnessLineKind.unknown, 'session.event', detail: harnessSnippet(params ?? m)),
      ];
    }
    final type = event['type'];
    if (type is! String || type.isEmpty) {
      return [
        HarnessLine(HarnessLineKind.unknown, 'session.event', detail: harnessSnippet(event)),
      ];
    }
    final data = event['data'];
    final known = harnessKnownLines(type, data);
    if (known != null) return known;
    return [HarnessLine(HarnessLineKind.unknown, type, detail: harnessSnippet(data ?? event))];
  }
  // `session.status running|idle`：§四 的实测样本里有它（不是那 14 种 `session.event`，
  // 但它是**认识**的 —— 认得的就画成人话，认不得的才落到下面那一条）。
  if (method == 'session.status') {
    final params = m['params'];
    final s = params is Map ? params['status'] : null;
    if (s == 'running' || s == 'idle') {
      return [HarnessLine(HarnessLineKind.note, harnessRunStatusLine(s == 'running'))];
    }
    return [
      HarnessLine(HarnessLineKind.unknown, 'session.status', detail: harnessSnippet(params ?? m)),
    ];
  }
  if (method is String && method.isNotEmpty) {
    return [HarnessLine(HarnessLineKind.unknown, method, detail: harnessSnippet(m['params']))];
  }
  // JSON-RPC **回执**（`initialize` 那种）：不是话，但也不许藏。
  if (m.containsKey('id') && (m.containsKey('result') || m.containsKey('error'))) {
    return [
      HarnessLine(
        HarnessLineKind.note,
        harnessAnswered,
        detail: harnessSnippet(m['result'] ?? m['error']),
      ),
    ];
  }
  return [
    HarnessLine(HarnessLineKind.unknown, harnessUnknownLine, detail: harnessSnippet(m)),
  ];
}

/// 已知的那些 `session.event` 画成什么；**认不出来返回 `null`**（交给 [harnessLinesOf] 兜底）。
///
/// `data` 就是 `params.event.data`（DSH 自己的类型声明里那个），照 §5.4 分三类：
/// 结构行 / 文本 / 一行说明（`request/header` 只做摘要）。
List<HarnessLine>? harnessKnownLines(String type, Object? data) {
  final d = data is Map ? data : const <String, Object?>{};
  switch (type) {
    case 'turn/start':
      return [HarnessLine(HarnessLineKind.turn, harnessTurnStartLine(harnessNum(d['turn'])))];
    case 'step/start':
      return [
        HarnessLine(
          HarnessLineKind.step,
          harnessStepStartLine(harnessNum(d['turn']), harnessNum(d['step'])),
        ),
      ];
    case 'step/end':
      return [HarnessLine(HarnessLineKind.step, harnessStepEndLine(harnessNum(d['step'])))];
    case 'turn/end':
      return [
        HarnessLine(HarnessLineKind.turn, harnessTurnEndLine(harnessReasonWords(harnessReasonKind(d)))),
      ];
    case 'user/message':
      return _messageLines('user', d);
    case 'assistant/message':
      return _messageLines('assistant', d);
    case 'system/message':
      return _messageLines('system', d);
    case 'request/header':
      return [HarnessLine(HarnessLineKind.folded, harnessHeaderLine(harnessToolCount(d)))];
    case 'request/context':
      return [const HarnessLine(HarnessLineKind.note, harnessContextLine)];
    case 'session/title':
      return [HarnessLine(HarnessLineKind.note, harnessTitleLine('${d['title'] ?? ''}'))];
    case 'permission/preset':
      return [const HarnessLine(HarnessLineKind.note, harnessPermissionLine)];
    case 'sandbox/mode':
      return [const HarnessLine(HarnessLineKind.note, harnessSandboxLine)];
    case 'approval/policy':
      return [const HarnessLine(HarnessLineKind.note, harnessApprovalLine)];
    case 'agent/inbox/spliced':
      return [HarnessLine(HarnessLineKind.note, harnessSplicedLine(harnessInsertedCount(d)))];
    default:
      return null;
  }
}

/// `turn/end` 的 `reason`：它可以是一个对象（`{kind}`），也可能直接是个字符串。
String? harnessReasonKind(Map d) {
  final r = d['reason'];
  if (r is Map) {
    final k = r['kind'];
    return k is String ? k : null;
  }
  return r is String ? r : null;
}

/// `request/header.header.tools` 有几样（**只数件数，不抄名字**）。
int harnessToolCount(Map d) {
  final header = d['header'];
  if (header is! Map) return 0;
  final tools = header['tools'];
  return tools is List ? tools.length : 0;
}

/// `agent/inbox/spliced.inserted` 有几条。
int harnessInsertedCount(Map d) {
  final inserted = d['inserted'];
  return inserted is List ? inserted.length : 0;
}

/// 一个数字字段（读不出来当 `0` —— 屏幕上就是"第 0 轮"那种，**不编**）。
int harnessNum(Object? v) => v is num ? v.toInt() : 0;

/// 一小段 JSON（**未知事件那一条的判据**：类型 + 它）。
String harnessSnippet(Object? x) {
  if (x == null) return '';
  String s;
  try {
    s = jsonEncode(x);
  } catch (_) {
    s = '$x';
  }
  final runes = s.runes.toList();
  if (runes.length <= harnessSnippetMax) return s;
  // ⚠️ 按 **rune** 截（按 `substring` 截会把一个字符切成半个代理对）
  return '${String.fromCharCodes(runes.take(harnessSnippetMax))}…';
}

/// 一条消息里那几块字 → 几行。
///
/// * `data.message` 在（`assistant/message` / `system/message`）就取它；不在
///   （`user/message` 的 `data` **本身就是那条消息**）就用 `data`。
/// * `content` 里 `text` / `reasoning` 两种块显示文本；**别的块不藏** ——
///   画成「块类型 + 一小段 JSON」。
List<HarnessLine> _messageLines(String role, Map data) {
  final raw = data['message'];
  final msg = raw is Map ? raw : data;
  final out = <HarnessLine>[];
  final content = msg['content'];
  if (content is List) {
    for (final block in content) {
      if (block is! Map) continue;
      final bt = block['type'];
      final text = block['text'];
      final label = bt is String && bt.isNotEmpty ? bt : harnessUnknownLine;
      if (text is String && text.trim().isNotEmpty) {
        switch (bt) {
          case 'text':
            out.add(HarnessLine(_roleKind(role), _withPrefix(role, text)));
          case 'reasoning':
            out.add(HarnessLine(HarnessLineKind.think, '$harnessThinkPrefix$text'));
          default:
            out.add(
              HarnessLine(HarnessLineKind.unknown, label, detail: harnessSnippet(block)),
            );
        }
      } else {
        out.add(HarnessLine(HarnessLineKind.unknown, label, detail: harnessSnippet(block)));
      }
    }
  }
  if (out.isEmpty) {
    // 一条消息但一个能显示的字都没有（比如空 prompt 的 `system/message`）——
    // **不隐藏**：照样把这一条的样子摆出来。
    out.add(HarnessLine(HarnessLineKind.note, harnessNoTextLine, detail: harnessSnippet(msg)));
  }
  if (data['interrupted'] == true) {
    out.add(const HarnessLine(HarnessLineKind.note, harnessInterruptedLine));
  }
  return out;
}

HarnessLineKind _roleKind(String role) => switch (role) {
  'user' => HarnessLineKind.user,
  'assistant' => HarnessLineKind.text,
  _ => HarnessLineKind.system,
};

String _withPrefix(String role, String text) => switch (role) {
  'user' => '$harnessYourPrefix$text',
  'assistant' => '$harnessItsPrefix$text',
  _ => '$harnessSystemPrefix$text',
};

// ── 这一层要的那条通道（界面只认它，不认传输实现）──────────────
//
// ⚠️ 楼层闸：`widgets` 只许看 `models` ⇒ 界面这一层**不能** import
//    `services/harness_client.dart`。所以通道的**形状**住在这儿（纯抽象），
//    真实现（`services/harness_client.dart`）由 `screens` 那一层接上去。

/// 「我自己那台」这一条通道。
abstract class HarnessFeed {
  /// 原样流回来的那些行（已经画成人话/类型+JSON）。
  Stream<HarnessLine> get lines;

  /// 状态（`booting` / `ready` / `gone`）。
  Stream<HarnessStatus> get status;

  /// **现在**是什么状态。
  ///
  /// ⚠️ 为什么光有 [status] 那条流不够：界面是在 `open()` **之后**才挂上来的，
  ///    而广播流**不补发** ⇒ 不读这一眼的话，那一层可能永远停在"正在打开…"。
  HarnessStatus get current;

  /// 接上（连上 ⇒ 对面起它那一台）。
  void open();

  /// 说一句（`{"t":"say"}`）。
  void say(String text);

  /// 放弃这一轮（`{"t":"stop"}`）。
  void stop();

  /// **重来**：把这一头收掉、重新连一条（对面就是重起它那一台）。
  void restart();

  /// 这一层走了（离开这个入口）——把这一头收干净。
  Future<void> close();
}
