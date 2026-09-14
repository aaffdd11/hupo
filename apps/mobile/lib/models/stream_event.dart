/// 协议模型：客户端 ⇄ **调度器** 的线格式（v1）。
///
/// 与 `packages/protocol/PROTOCOL.md` 一一对应。**改这里必须同时改那份文档。**
///
/// v1 的核心变化：**没有 `turnId`，也没有配对**。
/// 用户发言与调度器发言是两条独立事件流，客户端把它们排进同一条时间线。
library;

/// 文本块归属：快速回答还是深思回答。
enum TextBlock {
  /// 快速回答：确认、方向、能立刻确定的部分。
  quick,

  /// 深思回答：研究之后的结论。
  deep,
}

/// 消息是回应式还是主动发起。
enum DispatcherOrigin {
  /// 回应某条用户输入。
  reactive,

  /// **主动发起**（任务完成、提醒、外部事件）——没有对应的用户输入，这是合法的。
  proactive,
}

/// 状态提示（**不是消息**，不进历史）。
enum StreamStatus {
  /// 在思考（处理层在跑）。
  thinking,

  /// 在聆听（被动模式，不出声）。
  listening,

  /// 正在交接（快答即将交给深答）。
  handoff,

  /// 在干活（异步任务，可能几分钟）。
  working,
}

/// 消息结束原因。
enum MessageEndReason { completed, aborted, failed }

/// 下行事件基类。`seq` 单调递增，是排序、续传与去重的唯一依据。
abstract class ServerEvent {
  const ServerEvent({required this.seq});

  final int seq;

  /// 从线格式解析。未知 `type` 返回 null（**向前兼容**：新事件不该让旧客户端崩）。
  static ServerEvent? tryParse(Map<String, dynamic> json) {
    final seq = json['seq'];
    if (seq is! int) return null;
    switch (json['type']) {
      case 'message/start':
        return MessageStartEvent(
          seq: seq,
          messageId: json['messageId'] as String? ?? '',
          origin: json['origin'] == 'proactive' ? DispatcherOrigin.proactive : DispatcherOrigin.reactive,
          re: (json['re'] as List?)?.map((e) => '$e').toList() ?? const [],
          interrupts: json['interrupts'] == true,
          sources: Source.listFrom(json['sources']),
        );
      case 'task/created':
        return TaskCreatedEvent(
          seq: seq,
          taskId: json['taskId'] as String? ?? '',
          messageId: json['messageId'] as String? ?? '',
          title: json['title'] as String? ?? '',
        );
      case 'task/completed':
        return TaskCompletedEvent(
          seq: seq,
          taskId: json['taskId'] as String? ?? '',
        );
      case 'message/text':
        return MessageTextEvent(
          seq: seq,
          messageId: json['messageId'] as String? ?? '',
          block: json['block'] == 'deep' ? TextBlock.deep : TextBlock.quick,
          seqInBlock: json['seqInBlock'] as int? ?? 0,
          text: json['text'] as String? ?? '',
          isFinal: json['final'] == true,
        );
      case 'message/status':
        return MessageStatusEvent(
          seq: seq,
          messageId: json['messageId'] as String? ?? '',
          state: _parseStatus(json['state']),
        );
      case 'message/end':
        return MessageEndEvent(
          seq: seq,
          messageId: json['messageId'] as String? ?? '',
          reason: _parseReason(json['reason']),
          sources: Source.listFrom(json['sources']),
          at: json['at'] as int?,
        );
      case 'user/echo':
        return UserEchoEvent(
          seq: seq,
          messageId: json['messageId'] as String? ?? '',
          text: json['text'] as String? ?? '',
        );
      case 'client/reload':
        return ClientReloadEvent(
          seq: seq,
          reason: json['reason'] as String? ?? 'build-changed',
          buildId: json['buildId'] as String? ?? '',
        );
      case 'error':
        return ErrorMessageEvent(
          seq: seq,
          messageId: json['messageId'] as String? ?? '',
          code: json['code'] as String? ?? 'UNKNOWN',
          message: json['message'] as String? ?? '',
        );
      default:
        return null;
    }
  }

  static MessageEndReason _parseReason(Object? raw) => switch (raw) {
        'aborted' => MessageEndReason.aborted,
        'failed' => MessageEndReason.failed,
        _ => MessageEndReason.completed,
      };

  static StreamStatus _parseStatus(Object? raw) => switch (raw) {
        'listening' => StreamStatus.listening,
        'handoff' => StreamStatus.handoff,
        'working' => StreamStatus.working,
        _ => StreamStatus.thinking,
      };
}

class MessageStartEvent extends ServerEvent {
  const MessageStartEvent({
    required super.seq,
    required this.messageId,
    required this.origin,
    required this.re,
    this.interrupts = false,
    this.sources = const [],
  });

  final String messageId;
  final DispatcherOrigin origin;
  final List<String> re;

  /// 这条消息**打断**当前话题（例如"对了，我打断一下，前面那件事做完了"）。
  ///
  /// 由服务端判定并生成话术；客户端只据此做视觉区分（不自己写台词）。
  final bool interrupts;

  /// 这条结论**查证过的来源**（可能为空 —— 那就说明没联网）。
  ///
  /// 只做"可核查"用，不在正文里堆链接。
  final List<Source> sources;
}

/// 一条来源。`title` 由搜索返回，可能为空；`url` 必有。
class Source {
  const Source({required this.title, required this.url});

  final String title;
  final String url;

  /// 展示用短名：优先用标题，没有就退回域名。
  String get label {
    final t = title.trim();
    if (t.isNotEmpty) return t;
    return domain.isEmpty ? url : domain;
  }

  /// 域名（去掉 `www.`）。解析失败返回空串。
  String get domain {
    final m = RegExp(r'^[a-z]+://([^/]+)').firstMatch(url);
    final host = m?.group(1) ?? '';
    if (host.isEmpty) return '';
    return host.startsWith('www.') ? host.substring(4) : host;
  }

  static List<Source> listFrom(Object? raw) {
    if (raw is! List) return const [];
    final out = <Source>[];
    for (final e in raw) {
      if (e is! Map) continue;
      final url = '${e['url'] ?? ''}'.trim();
      if (url.isEmpty) continue;
      out.add(Source(title: '${e['title'] ?? ''}'.trim(), url: url));
    }
    return out;
  }
}

/// 这件事不现在答，改成**独立任务**（用户会看到"我拿去做了"）。
///
/// ⚠ 触发条件是**要多久**，不是"简单还是复杂" —— 不存在那种分类。
class TaskCreatedEvent extends ServerEvent {
  const TaskCreatedEvent({
    required super.seq,
    required this.taskId,
    required this.messageId,
    required this.title,
  });

  final String taskId;

  /// 说出"我拿去做了"的那条消息。
  final String messageId;

  /// 一句话说明这件事是什么（面向用户，不是内部任务名）。
  final String title;
}

/// 任务完成 —— 随后会有一条主动消息报结果（可能带 `interrupts`）。
class TaskCompletedEvent extends ServerEvent {
  const TaskCompletedEvent({required super.seq, required this.taskId});
  final String taskId;
}

class MessageTextEvent extends ServerEvent {
  const MessageTextEvent({
    required super.seq,
    required this.messageId,
    required this.block,
    required this.seqInBlock,
    required this.text,
    required this.isFinal,
  });

  final String messageId;
  final TextBlock block;
  final int seqInBlock;
  final String text;
  final bool isFinal;
}

class MessageStatusEvent extends ServerEvent {
  const MessageStatusEvent({required super.seq, required this.messageId, required this.state});
  final String messageId;
  final StreamStatus state;
}

class MessageEndEvent extends ServerEvent {
  const MessageEndEvent({
    required super.seq,
    required this.messageId,
    required this.reason,
    this.sources = const [],
    this.at,
  });
  final String messageId;
  final MessageEndReason reason;

  /// 服务端给这个事件打的时间戳（服务端时钟，毫秒）。
  ///
  /// 客户端用它划一条线：**只有连上之后产生**的消息才回报"我看到了"。
  final int? at;

  /// 这一轮**最终**查到的来源。
  ///
  /// 为什么结束事件也要带一遍：agent 会先说「收到，我先去查…」（那时
  /// `message/start` 已经发出去了），等工具跑完才知道来源 —— 所以以 end 为准。
  final List<Source> sources;
}

class UserEchoEvent extends ServerEvent {
  const UserEchoEvent({required super.seq, required this.messageId, required this.text});
  final String messageId;
  final String text;
}

/// 服务端说：**你该刷新自己了。**
///
/// 前端是哑的 —— 它不猜"系统是不是变了"，只听服务端说。
/// 服务端在部署了新构建时发这个（`client/reload`，只在现场推、不进日志）。
class ClientReloadEvent extends ServerEvent {
  const ClientReloadEvent({
    required super.seq,
    required this.reason,
    required this.buildId,
  });

  final String reason;

  /// 服务端当前部署的构建指纹；客户端拿它和 [kClientBuildId] 比。
  final String buildId;
}

class ErrorMessageEvent extends ServerEvent {
  const ErrorMessageEvent({
    required super.seq,
    required this.messageId,
    required this.code,
    required this.message,
  });
  final String messageId;
  final String code;
  final String message;
}
