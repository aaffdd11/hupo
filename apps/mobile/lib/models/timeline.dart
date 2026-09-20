/// 时间线模型：用户发言与调度器发言是**两条独立的事件流**，不做配对。
///
/// 为什么不是"一问一答"（见 `packages/protocol/PROTOCOL.md` 第零节）：
/// 调度器可以主动开口、可以一次回应几条、可以只记不答、可以让结论晚到 ——
/// 任何"用户消息[i] ↔ 回答[i]"的配对假设都会在这些情形下错位。
///
/// 所以界面渲染的是**一条按 `seq` 排序的时间线**，条目之间没有从属关系。
library;

import 'stream_event.dart';

/// 时间线上的一个条目。
sealed class TimelineItem {
  const TimelineItem({required this.seq, required this.at, this.tie = 0});

  /// 主排序键：服务端下行的单调序号。
  ///
  /// 用户本地发言取**当前已知的最大序号**（即 `lastSeq`）—— 它必然排在
  /// 已收到的服务端事件之后、下一条服务端事件之前。
  final int seq;

  /// 次排序键：同一 `seq` 内的插入顺序。
  ///
  /// 用途：用户连续说两句时，两条本地发言的 `seq` 相同，
  /// 靠 `tie` 保证**说话顺序不被颠倒**（早说的排在前面）。
  final int tie;

  final DateTime at;
}

/// 用户发言。本地立即入列（`seq` 为负），服务端 `user/echo` 用于多端对齐。
class UserUtterance extends TimelineItem {
  UserUtterance({
    required super.seq,
    required super.at,
    required this.messageId,
    required this.text,
    this.sentAt = 0,
    this.pending = true,
    super.tie,
  });

  final String messageId;
  final String text;

  /// **用户按下发送的时刻**（客户端时钟，毫秒）。监控层算感知延迟要用。
  final int sentAt;

  /// 尚未被服务端确认（界面显示一个小转圈）。
  bool pending;
}

/// 调度器的一条消息（= 界面上的一个气泡）。
///
/// 快答与深答是**同一条消息的两个块**，必须渲染成同一个气泡。
class DispatcherMessage extends TimelineItem {
  DispatcherMessage({
    required super.seq,
    required super.at,
    required this.messageId,
    this.origin = DispatcherOrigin.reactive,
    this.interrupts = false,
    List<String>? re,
    List<Source>? sources,
  })  : re = re ?? const [],
        sources = sources ?? const [];

  final String messageId;

  /// **客户端看到的时刻**（客户端时钟，毫秒）。
  ///
  /// 监控层要判时效性：用户说完 → 他多久看到第一句、多久看到结论。
  /// 这两个值和用户的发送时刻用**同一个钟**，相减不受两端时钟偏差影响。
  int? clientFirstSeenAt;
  int? clientEndedSeenAt;

  /// 回应式还是主动发起。**主动消息没有对应的用户输入**，这是允许的。
  final DispatcherOrigin origin;

  /// 这条消息在回应哪些用户消息（可为空）。
  ///
  /// ⚠ 仅作**溯源信息**使用。界面渲染**不依赖**它 ——
  /// 依赖它就会退回到"配对"假设。
  final List<String> re;

  /// 这条消息**打断**了当前话题（例如"对了，我打断一下，前面那件事做完了"）。
  /// 话术由服务端生成，客户端只做视觉区分。
  final bool interrupts;

  /// 这条结论**查证过的来源**。空 = 没联网（客户端不解释原因，只不显示）。
  List<Source> sources;

  final StringBuffer _quick = StringBuffer();
  final StringBuffer _deep = StringBuffer();

  /// 已合并的块内序号（去重 + 防乱序回退）。
  final Map<TextBlock, int> _lastSeqInBlock = {TextBlock.quick: -1, TextBlock.deep: -1};

  final Set<TextBlock> _finishedBlocks = {};

  StreamStatus? status;
  MessageEndReason? endReason;
  String? errorCode;
  String? errorMessage;

  /// 服务端已放行且客户端已收到的字节数（诊断"用户实际看到了多少"）。
  int deliveredChars = 0;

  String get quickText => _quick.toString();
  String get deepText => _deep.toString();

  /// 用户看到的完整文本：快答在前，深答接上，**中间不加连接词**。
  /// 承接由服务端生成（见 docs/handbook/08-SPEC.md §1.2「两块回答必须是一个人说的」）。
  String get displayText {
    final q = _quick.toString();
    final d = _deep.toString();
    if (q.isEmpty) return d;
    if (d.isEmpty) return q;
    return _endsWithSentencePunctuation(q) ? '$q$d' : '$q $d';
  }

  bool get isFinished => endReason != null;
  bool get hasAnyText => _quick.isNotEmpty || _deep.isNotEmpty;
  bool get deepStarted => _deep.isNotEmpty;

  /// 合并一个文本块；返回是否有变化。
  bool applyText(MessageTextEvent event) {
    final last = _lastSeqInBlock[event.block] ?? -1;
    if (event.seqInBlock <= last) return false; // 去重：断线重传必然重复
    _lastSeqInBlock[event.block] = event.seqInBlock;

    if (event.text.isNotEmpty) {
      final buffer = event.block == TextBlock.deep ? _deep : _quick;
      buffer.write(event.text);
      deliveredChars += event.text.length;
    }
    if (event.isFinal) _finishedBlocks.add(event.block);
    return true;
  }

  bool applyStatus(MessageStatusEvent event) {
    if (status == event.state) return false;
    status = event.state;
    return true;
  }

  bool applyError(ErrorMessageEvent event) {
    errorCode = event.code;
    errorMessage = event.message;
    return true;
  }

  bool applyEnd(MessageEndEvent event) {
    endReason = event.reason;
    status = null;
    // 最终来源（可能晚于 message/start 才知道）—— end 带的就是权威版本
    if (event.sources.isNotEmpty) sources = event.sources;
    return true;
  }

  /// 中止：保留已收到的文本，只标记结束（**已显示的字撤不回来**）。
  bool abort() {
    if (endReason != null) return false;
    endReason = MessageEndReason.aborted;
    status = null;
    return true;
  }

  static bool _endsWithSentencePunctuation(String s) {
    if (s.isEmpty) return true;
    const puncts = ['。', '！', '？', '…', '；', '\n', '.', '!', '?', ';'];
    return puncts.contains(s[s.length - 1]);
  }
}

/// 一件**在做的事**（面向用户可见：用户知道还有事情没回来）。
///
/// ⚠ 不显示进度百分比 —— 那是伪精确（见 PROTOCOL.md R6）。
class ActiveTask {
  ActiveTask({required this.taskId, required this.title, required this.startedAt});

  final String taskId;

  /// 一句话说明这是什么（面向用户，不是内部任务名）。
  final String title;

  final DateTime startedAt;
}

/// 会话列表项。
class ConversationSummary {
  const ConversationSummary({
    required this.conversationId,
    required this.title,
    required this.lastText,
    required this.updatedAt,
    this.unread = 0,
  });

  final String conversationId;
  final String title;
  final String lastText;
  final DateTime updatedAt;
  final int unread;
}
