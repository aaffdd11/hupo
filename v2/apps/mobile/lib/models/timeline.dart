// 可见时间线。手册 `02-ARCHITECTURE.md` §5、`08-SPEC.md` §4。
//
// 三条不能破的：
//   1. **一条时间线**，按 `(seq, tie)` 排序。客户端是**哑的**——
//      它不判断"这句合理吗、该不该配对"，只排序与渲染。
//   2. **不做配对**（协议 R1）。用户说两句、助手回一条，是正常的；
//      硬配对会逼出一堆"孤儿消息"。
//   3. **本地发言有乐观态**：按下发送就上屏（`queued`），
//      服务端的 `user/echo` 回来时**认领它**（同一个 messageId），
//      而不是再插一条——否则你会看到自己说的话出现两遍。
//
// ⚠️ 纯逻辑，**不许 import flutter/material**（禁令 1）。要进 `test/unit` 硬闸。

import 'message_state.dart';

/// 一条时间线条目。`seq` 是服务端发的号；本地乐观发言借用"当前最大号"。
sealed class TimelineItem {
  const TimelineItem({required this.seq, this.tie = 0});

  /// 服务端的排队号。
  final int seq;

  /// 同一号内的次序。本地发言用 1（排在已收到事件之后、下一条服务端事件之前）。
  final int tie;

  /// 排序键。**不许用时间戳当排序键**——
  /// 本地发言是客户端钟、服务端事件是服务端钟，混钟排序会乱。
  (int, int) get order => (seq, tie);
}

/// 用户说的一句话。
class UserUtterance extends TimelineItem {
  UserUtterance({
    required this.messageId,
    required this.text,
    required super.seq,
    super.tie,
    this.state = MessageState.queued,
  });

  final String messageId;
  final String text;
  MessageState state;

  UserUtterance copyWith({int? seq, int? tie, MessageState? state}) => UserUtterance(
        messageId: messageId,
        text: text,
        seq: seq ?? this.seq,
        tie: tie ?? this.tie,
        state: state ?? this.state,
      );
}

/// 助手说的一条（快答 + 深答**在同一个气泡里**，协议 R2）。
class AssistantMessage extends TimelineItem {
  AssistantMessage({required this.messageId, required super.seq});

  final String messageId;
  String quick = '';
  String deep = '';
  List<Map<String, dynamic>> sources = const [];
  bool ended = false;
  String? reason;
  String? status; // thinking / working / handoff / listening
  bool catchUp = false;

  /// 用户看到的正文。**中间不加连接词**（那会像两个人在接话）；
  /// 但快答没以句末标点结尾时补一个空格，免得两句粘在一起。
  String get displayText {
    if (quick.isEmpty) return deep;
    if (deep.isEmpty) return quick;
    final needsSpace = !RegExp(r'[。！？!?；;：:…\n]$').hasMatch(quick);
    return needsSpace ? '$quick $deep' : '$quick$deep';
  }

  bool get isEmpty => quick.isEmpty && deep.isEmpty;
}

/// 时间线上的一条分隔（"你不在的时候" / "进入某层"）。
///
/// ⚠️ 它**是持久事件**（取号、落盘、有位置），不是瞬态——
///    "不占号 = 不上时间线"，而它**要上时间线**（决策 P-g）。
class TimelineMarker extends TimelineItem {
  const TimelineMarker({required this.kind, required super.seq, this.label, this.catchUp = false});

  final String kind; // away / enter / leave
  final String? label;
  final bool catchUp;
}

/// 时间线本体。
class Timeline {
  final List<TimelineItem> _items = [];
  final Set<int> _seenSeq = {};
  int _lastSeq = 0;

  /// 已收到的最大服务端号。**补发就从它开始要**。
  int get lastSeq => _lastSeq;

  List<TimelineItem> get items {
    final list = [..._items]..sort((a, b) {
        final c = a.seq.compareTo(b.seq);
        return c != 0 ? c : a.tie.compareTo(b.tie);
      });
    return list;
  }

  bool get isEmpty => _items.isEmpty;

  /// 本地乐观上屏。返回 messageId（重发时要用同一个）。
  ///
  /// 号借 `_lastSeq`、tie=1 ⇒ 排在"已收到的最后一条"之后、
  /// "下一条服务端事件"之前。**这样它不会跳来跳去。**
  String addLocalUtterance(String text, String messageId) {
    _items.add(UserUtterance(messageId: messageId, text: text, seq: _lastSeq, tie: 1));
    return messageId;
  }

  /// 把本地那条推到某个状态。**不允许的转移会被忽略**（不抛）。
  void setLocalState(String messageId, MessageState to) {
    for (var i = 0; i < _items.length; i += 1) {
      final it = _items[i];
      if (it is UserUtterance && it.messageId == messageId) {
        final next = nextState(it.state, to);
        if (next != it.state) _items[i] = it.copyWith(state: next);
        return;
      }
    }
  }

  /// 重发：把失败的那条推回 `queued`，让它看起来又是"在发"。
  void retry(String messageId) => setLocalState(messageId, MessageState.queued);

  /// 吃一个服务端事件。不认识的类型**安静忽略**（协议：向前兼容）。
  void apply(Map<String, dynamic> event) {
    final type = event['type'];
    if (type is! String) return;

    // 瞬态事件没有 seq ⇒ **不上时间线**（决策 P-g）。
    // 它们只改已有条目的状态，绝不新增条目。
    final rawSeq = event['seq'];
    if (rawSeq is! int) {
      _applyTransient(event);
      return;
    }

    // 去重：补发/重连必然重复（协议 R5）
    if (!_seenSeq.add(rawSeq)) return;
    if (rawSeq > _lastSeq) _lastSeq = rawSeq;

    final catchUp = event['catchUp'] == true;
    final messageId = event['messageId'] as String?;

    switch (type) {
      case 'user/echo':
        _applyEcho(messageId, event, rawSeq, catchUp);
      case 'message/start':
        if (messageId == null) return;
        if (_findMessage(messageId) != null) return;
        _items.add(AssistantMessage(messageId: messageId, seq: rawSeq)
          ..catchUp = catchUp);
      case 'message/text':
        final m = _findMessage(messageId);
        if (m == null) return;
        final text = event['text'] as String? ?? '';
        if (event['block'] == 'deep') {
          m.deep += text;
        } else {
          m.quick += text;
        }
      case 'message/end':
        final m = _findMessage(messageId);
        if (m == null) return;
        m.ended = true;
        m.reason = event['reason'] as String?;
        final s = event['sources'];
        if (s is List) {
          // ⚠️ 协议 R8：end 上的来源是**权威版本**，覆盖 start 上带的
          m.sources = s.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
        }
      case 'timeline/marker':
        _items.add(TimelineMarker(
          kind: event['kind'] as String? ?? 'away',
          label: event['label'] as String?,
          seq: rawSeq,
          catchUp: catchUp,
        ));
      default:
        // 未知类型：安静忽略（向前兼容）
        return;
    }
  }

  void _applyEcho(String? messageId, Map<String, dynamic> event, int seq, bool catchUp) {
    if (messageId == null) return;
    // ★ 认领本地那条乐观发言——**不是再插一条**
    for (var i = 0; i < _items.length; i += 1) {
      final it = _items[i];
      if (it is UserUtterance && it.messageId == messageId) {
        _items[i] = it.copyWith(seq: seq, tie: 0, state: nextState(it.state, MessageState.confirmed));
        return;
      }
    }
    // 没认领到（别的设备发的、或者本地没上屏过）⇒ 当作新的一条
    _items.add(UserUtterance(
      messageId: messageId,
      text: event['text'] as String? ?? '',
      seq: seq,
      state: MessageState.confirmed,
    ));
  }

  /// 瞬态：只改状态，不新增条目。
  void _applyTransient(Map<String, dynamic> event) {
    if (event['type'] != 'message/status') return;
    final m = _findMessage(event['messageId'] as String?);
    if (m == null) return; // ⚠️ 取不到就什么都别做（不许凭空造一条消息）
    m.status = event['state'] as String?;
  }

  AssistantMessage? _findMessage(String? messageId) {
    if (messageId == null) return null;
    for (final it in _items) {
      if (it is AssistantMessage && it.messageId == messageId) return it;
    }
    return null;
  }

  /// 服务端说"你的号跑到我前面了" ⇒ 本地这条时间线不作数了，从头来。
  ///
  /// ⚠️ **但用户自己说的话必须留下**——
  ///    那些话**只在本机有一份**（还没被服务端认领）。
  ///    清掉它们等于"把用户打好的字弄丢了"，而那是留存最狠的杀手（09）。
  ///    ⇒ 只清服务端来的；本地的未确认发言**原样留着**。
  void reset() {
    final mine = _items
        .whereType<UserUtterance>()
        .where((u) => u.state != MessageState.confirmed)
        .toList();
    _items
      ..clear()
      ..addAll(mine);
    _seenSeq.clear();
    _lastSeq = 0;
    // 本地那条的号要重新借（现在最大号是 0）
    for (var i = 0; i < _items.length; i += 1) {
      final u = _items[i] as UserUtterance;
      _items[i] = u.copyWith(seq: 0, tie: 1);
    }
  }

  /// 重放一批补发帧（断线重连时）。
  void applyAll(Iterable<Map<String, dynamic>> events) {
    for (final e in events) {
      apply(e);
    }
  }
}
