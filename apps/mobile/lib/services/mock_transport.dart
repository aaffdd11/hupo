// 本地模拟传输：不连网络，用真实时序回放**调度器**的行为。
//
// 存在的理由：调度器的行为不是"你一句我一句"。这里刻意覆盖五种形态，
// 用来验证界面是否真的去掉了配对假设：
//
//   1. 常规：快答 → 深答（同一气泡，两块）
//   2. 慢深答：中间空窗，状态提示承担在场感
//   3. 深答失败：必须有合法收尾，不留白
//   4. 只记不答（被动聆听）：不出声
//   5. **主动开口**：没有任何用户输入，调度器自己说话 ← 旧模型无处安放的情形

import 'dart:async';

import '../models/agent_status.dart';
import '../models/dev_step.dart';
import '../models/stream_event.dart';
import 'transport.dart';

/// 模拟场景：决定回放哪一条调度器行为。
///
/// ⚠ 这些**只是开发期的回放档位**，不是产品概念。
/// 产品里没有"简单/复杂/深度"这些类别 —— 就是"用户说话，给反馈"。
/// 各档位存在的唯一目的：让边界情况（失败、不出声、主动开口）可被自动测试。
/// 内部信号：dispose 导致回放中止。
class _Aborted implements Exception {}

enum MockScenario {
  /// **默认**：用户说话 → 先应一声，再把想好的答案说出来。
  normal,

  /// 边界档：处理层很快（实测 ~0.9s），快答刚说完就交接。
  fastDeep,

  /// 复杂问题：需要深研（实测 6.5–7.9s），快答说完后有空窗。
  slowDeep,

  /// 深答失败：最危险的失败态 —— 用户已投入阅读却拿不到结论。
  deepFails,

  /// 被动聆听：不出声，只有状态。
  listening,

  /// **主动开口**：用户没说话，调度器自己发来一条（例如异步任务完成）。
  proactive,

  /// **要很久 → 变成独立任务**：说"我拿去做了"，过一会儿**打断**回来报结果。
  ///
  /// 这条覆盖用户明确要的形态：判断依据是「要多久」，不是「复杂还是简单」。
  longTask,
}

class MockTransport implements ChatTransport {
  MockTransport({this.scenario = MockScenario.normal, this.speed = 1.0});

  final MockScenario scenario;

  /// 时间倍速：>1 更快，用于测试。
  final double speed;

  final _controller = StreamController<ServerEvent>.broadcast();
  int _seq = 0;
  int _counter = 0;

  /// 未完成的定时器。dispose 时取消，避免测试里留下悬挂的 timer。
  final List<Timer> _timers = [];
  bool _disposed = false;

  /// 可取消的等待：dispose 后不会再往下走。
  Future<void> _wait(int ms) async {
    if (_disposed) return;
    final completer = Completer<void>();
    late final Timer timer;
    timer = Timer(Duration(milliseconds: (ms / speed).round()), () {
      if (!completer.isCompleted) completer.complete();
    });
    _timers.add(timer);
    await completer.future;
    _timers.remove(timer);
  }

  int _nextSeq() => ++_seq;

  @override
  @override
  Stream<DevStep> get devSteps => const Stream<DevStep>.empty();

  /// 回放模式没有真进程，自然也没有进程状态。
  // ── 鉴权：假传输里一律"不用登录" ──────────────────────────
  String? _token;

  @override
  String? get token => _token;

  @override
  set token(String? value) => _token = value;

  @override
  Stream<void> get unauthorized => const Stream<void>.empty();

  @override
  Future<({bool required, bool authenticated})> authStatus() async =>
      (required: false, authenticated: true);

  @override
  Future<String?> login(String password) async => null;

  @override
  Stream<AgentSnapshot> get agentSnapshots => const Stream<AgentSnapshot>.empty();

  @override
  Stream<ServerEvent> connect({required String conversationId, int sinceSeq = 0, bool dev = false}) {
    // 主动场景：连接后不需要用户输入，调度器自己开口
    if (scenario == MockScenario.proactive && sinceSeq == 0) {
      unawaited(_playProactive());
    }
    return _controller.stream;
  }

  Future<void> _playProactive() async {
    await _wait(900);
    if (_disposed) return;
    final messageId = 'm_${++_counter}';
    void emit(ServerEvent e) {
      if (!_controller.isClosed) _controller.add(e);
    }
    emit(MessageStartEvent(
        seq: _nextSeq(), messageId: messageId, origin: DispatcherOrigin.proactive, re: const []));
    // 主动开口：没有对应的用户消息，这在 v1 里是**合法**的
    for (final unit in ['你上次让我盯的那个接口，有结果了。', '是连接池上限被占满，不是代码问题。']) {
      emit(MessageTextEvent(
        seq: _nextSeq(),
        messageId: messageId,
        block: TextBlock.deep,
        seqInBlock: _blockSeq++,
        text: unit,
        isFinal: false,
      ));
      await _wait(400);
      if (_disposed) return;
    }
    emit(MessageEndEvent(seq: _nextSeq(), messageId: messageId, reason: MessageEndReason.completed));
  }

  int _blockSeq = 0;

  @override
  Future<void> say({
    required String conversationId,
    required String messageId,
    required String text,
    int? clientAt,
  }) async {
    unawaited(_playReply(messageId, text));
  }

  Future<void> _playReply(String userMessageId, String userText) async {
    try {
      await _playReplyInner(userMessageId, userText);
    } on _Aborted {
      // dispose 导致的中止：正常退出，不报错
    }
  }

  Future<void> _playReplyInner(String userMessageId, String userText) async {
    final messageId = 'm_${++_counter}';
    Future<void> wait(int ms) => Future<void>.delayed(Duration(milliseconds: (ms / speed).round()));
    void emit(ServerEvent e) {
      if (!_controller.isClosed) _controller.add(e);
    }

    if (scenario == MockScenario.longTask) {
      // ① 先给一句反馈：这件事我拿去做了（不占用当前对话）
      final taskId = 'task_${++_counter}';
      emit(MessageStartEvent(
          seq: _nextSeq(), messageId: messageId, origin: DispatcherOrigin.reactive, re: [userMessageId]));
      emit(MessageStatusEvent(seq: _nextSeq(), messageId: messageId, state: StreamStatus.thinking));
      await wait(800);
      _blockSeq = 0;
      emit(MessageTextEvent(
        seq: _nextSeq(),
        messageId: messageId,
        block: TextBlock.quick,
        seqInBlock: _blockSeq++,
        text: '这件事我得翻一遍历史记录再对一遍日志，要花点时间。',
        isFinal: true,
      ));
      emit(MessageTextEvent(
        seq: _nextSeq(),
        messageId: messageId,
        block: TextBlock.deep,
        seqInBlock: _blockSeq++,
        text: '我拿去做了，完了跟你说。',
        isFinal: true,
      ));
      emit(MessageEndEvent(
          seq: _nextSeq(), messageId: messageId, reason: MessageEndReason.completed));
      emit(TaskCreatedEvent(
        seq: _nextSeq(),
        taskId: taskId,
        messageId: messageId,
        title: '翻历史记录并对日志',
      ));

      // ② 过一会儿做完 → **打断**回来报结果
      await wait(6000);
      emit(TaskCompletedEvent(seq: _nextSeq(), taskId: taskId));
      final reportId = 'm_${++_counter}';
      emit(MessageStartEvent(
        seq: _nextSeq(),
        messageId: reportId,
        origin: DispatcherOrigin.proactive,
        re: [userMessageId],
        interrupts: true, // 打断当前话题
      ));
      _blockSeq = 0;
      for (final unit in ['对了，我打断一下 —— 前面那件事做完了。', '是下游那个服务的重试策略有问题，不是你的代码。']) {
        emit(MessageTextEvent(
          seq: _nextSeq(),
          messageId: reportId,
          block: TextBlock.deep,
          seqInBlock: _blockSeq++,
          text: unit,
          isFinal: false,
        ));
        await wait(420);
      }
      emit(MessageEndEvent(
          seq: _nextSeq(), messageId: reportId, reason: MessageEndReason.completed));
      return;
    }

    if (scenario == MockScenario.listening) {
      // 只记不答：不出声，状态提示走独立区域，**不进时间线**
      emit(MessageStartEvent(
          seq: _nextSeq(), messageId: messageId, origin: DispatcherOrigin.reactive, re: [userMessageId]));
      emit(MessageStatusEvent(seq: _nextSeq(), messageId: messageId, state: StreamStatus.listening));
      return;
    }

    _blockSeq = 0;
    emit(MessageStartEvent(
        seq: _nextSeq(), messageId: messageId, origin: DispatcherOrigin.reactive, re: [userMessageId]));

    // 阶段 1：首字前等待（实测 0.8–1.5s）
    emit(MessageStatusEvent(seq: _nextSeq(), messageId: messageId, state: StreamStatus.thinking));
    await wait(900);

    // 阶段 2：快答按"投递单元"到达（服务端只在句边界放行）
    final quickUnits = _quickUnitsFor(userText);
    for (var i = 0; i < quickUnits.length; i++) {
      emit(MessageTextEvent(
        seq: _nextSeq(),
        messageId: messageId,
        block: TextBlock.quick,
        seqInBlock: _blockSeq++,
        text: quickUnits[i],
        isFinal: i == quickUnits.length - 1,
      ));
      await wait(420);
    }

    // 阶段 3：等深答
    final deepDelay = switch (scenario) {
      MockScenario.normal => 1400,
      MockScenario.fastDeep => 300,
      MockScenario.slowDeep => 4200,
      MockScenario.deepFails => 3000,
      _ => 1000,
    };
    if (deepDelay > 2500) {
      await wait(2000);
      emit(MessageStatusEvent(seq: _nextSeq(), messageId: messageId, state: StreamStatus.working));
      await wait(deepDelay - 2000);
    } else {
      await wait(deepDelay);
    }

    if (scenario == MockScenario.deepFails) {
      emit(ErrorMessageEvent(
          seq: _nextSeq(), messageId: messageId, code: 'DEEP_FAILED', message: '深度分析没能完成'));
      _blockSeq = 0;
      emit(MessageTextEvent(
        seq: _nextSeq(),
        messageId: messageId,
        block: TextBlock.deep,
        seqInBlock: _blockSeq++,
        text: '这条我没能给出结论，先按上面那条走；要我再试一次就说一声。',
        isFinal: true,
      ));
      emit(MessageEndEvent(seq: _nextSeq(), messageId: messageId, reason: MessageEndReason.failed));
      return;
    }

    // 阶段 4：深答接上（同一气泡追加）
    emit(MessageStatusEvent(seq: _nextSeq(), messageId: messageId, state: StreamStatus.handoff));
    _blockSeq = 0;
    final deepUnits = _deepUnitsFor(userText);
    for (var i = 0; i < deepUnits.length; i++) {
      emit(MessageTextEvent(
        seq: _nextSeq(),
        messageId: messageId,
        block: TextBlock.deep,
        seqInBlock: _blockSeq++,
        text: deepUnits[i],
        isFinal: i == deepUnits.length - 1,
      ));
      await wait(380);
    }

    emit(MessageEndEvent(seq: _nextSeq(), messageId: messageId, reason: MessageEndReason.completed));
  }

  // ── 模拟回复文案 ─────────────────────────────────────────────────
  //
  // ⚠ 这些是**占位数据**：服务端尚未实现，客户端先用它验证交互形态。
  //   写它们的两条纪律：
  //   1. **不知道就别说知道** —— 不许拿"你描述的现象"这类兜底词硬凑句子
  //   2. **快答与深答必须对得上** —— 快答说的方向，深答要给同一件事的结论

  /// 确认语模板。多条轮换，避免每个话题开头一模一样（一眼假）。
  static const _acks = [
    '收到，这类问题通常出在几个固定位置，我先按顺序排一遍。',
    '行，我先把可能的原因过一遍再回你。',
    '收到，我按可能性从高到低查一遍。',
  ];

  /// 快答：确认 + 方向。基于用户实际说的话，**不知道就不编**。
  List<String> _quickUnitsFor(String text) {
    if (_topicOf(text) == null) return ['收到，我先看看。'];
    final ack = _acks[text.length % _acks.length];
    return ['收到。$ack'];
  }

  /// 深答：结论。与快答说的方向一致，是一段连贯的话。
  List<String> _deepUnitsFor(String text) {
    switch (_topicOf(text)) {
      case '接口报错':
        return [
          '排完了，是连接池被打满，不是代码逻辑的问题。',
          '高峰期连接被占住，新请求只能排队，排不到就超时。',
          '先把池上限和等待队列这两个指标调出来看。',
        ];
      case '日程冲突':
        return [
          '看过了，周三下午已经有一个会，硬排会撞上。',
          '要么把新会挪到周四上午，要么把原来那个会挪走。',
          '你倾向哪个，我直接改。',
        ];
      case '作息':
        return [
          '看了下规律，你是躺下之后越等越清醒，不是睡不着。',
          '这个情况下躺着最耗人，躺 20 分钟没睡意就起来做点别的。',
          '连着记三天起床时间，比记入睡时间有用。',
        ];
      case '表达':
        return [
          '写好了，给你三个方向：数字加动作、目标加影响、反差加悬念。',
          '你这篇里"完成了"出现太多次，换成具体数字会更抓人。',
          '要我把三个版本都写出来吗？',
        ];
      default:
        // 不知道就给一个**诚实**的回复，而不是编一个结论
        return [
          '这条我不敢直接下结论。',
          '你把具体的现象、报错或者截图发我一段，我再看。',
        ];
    }
  }

  /// 识别话题。**认不出来就返回 null** —— 由调用方给出诚实的回复。
  String? _topicOf(String text) {
    if (text.contains('500') || text.contains('接口') || text.contains('报错')) return '接口报错';
    if (text.contains('日程') || text.contains('排') || text.contains('会')) return '日程冲突';
    if (text.contains('睡') || text.contains('失眠') || text.contains('作息')) return '作息';
    if (text.contains('标题') || text.contains('周报') || text.contains('文案')) return '表达';
    return null;
  }

  @override
  Future<void> reportSeen({
    required String conversationId,
    required String messageId,
    int? firstSeenAt,
    int? endedSeenAt,
  }) async {}

  @override
  Future<void> cancelMessage({required String conversationId, required String messageId}) async {
    if (!_controller.isClosed) {
      _controller.add(MessageEndEvent(
          seq: _nextSeq(), messageId: messageId, reason: MessageEndReason.aborted));
    }
  }

  /// 回放模式永远"连着"。
  @override
  Stream<bool> get connectionState => Stream<bool>.value(true);

  /// 回放模式没有"服务端版本"这回事 —— 明确返回 null，表示"别刷新"。
  @override
  Future<Map<String, dynamic>?> serverVersion() async => null;

  @override
  Future<List<Map<String, dynamic>>> listConversations() async => [
        {
          'conversationId': 'c_mock',
          'title': '接口偶发 500',
          'lastText': '确认了，问题在连接池，不是下游超时。',
          'updatedAt': DateTime.now().millisecondsSinceEpoch,
          'unread': 0,
        },
      ];

  @override
  Future<void> dispose() async {
    _disposed = true;
    for (final t in _timers) {
      t.cancel();
    }
    _timers.clear();
    if (!_controller.isClosed) await _controller.close();
  }
}
