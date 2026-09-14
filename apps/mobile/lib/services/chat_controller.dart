// 调度器会话状态机。
//
// 核心：把下行事件流折叠成**一条有序时间线** —— 用户发言与调度器发言都是
// 独立条目，**不做任何配对**（见 packages/protocol/PROTOCOL.md 第零节）。
//
// 三条必须做对的事：
// 1. 单条时间线，按 `seq` 排序；用户本地发言用负序号先入列
// 2. `seq` 去重与断线续传
// 3. 中止不擦除（已显示的字撤不回来）

import 'dart:async';

import 'package:flutter/foundation.dart'
    show ChangeNotifier, VoidCallback, kIsWeb, visibleForTesting;

import '../models/agent_status.dart';
import '../models/dev_step.dart';
import '../models/stream_event.dart';
import '../models/timeline.dart';
import 'app_version.dart';
import 'page_reload.dart';
import 'transport.dart';

class ChatController extends ChangeNotifier {
  ChatController({required ChatTransport transport, String conversationId = 'c_default'})
      : _transport = transport,
        _conversationId = conversationId;

  final ChatTransport _transport;
  final String _conversationId;

  StreamSubscription<ServerEvent>? _sub;
  StreamSubscription<DevStep>? _devSub;
  StreamSubscription<bool>? _connSub;
  StreamSubscription<AgentSnapshot>? _agentSub;
  StreamSubscription<void>? _authSub;

  /// **唯一**的界面数据源：一条有序时间线。
  final List<TimelineItem> timeline = [];

  /// 后台活动（**开发者模式**才收集）。给页面顶部的开发卡片用。
  final List<DevStep> devSteps = [];

  /// **agent 进程状态**（开发者模式才收集）。
  ///
  /// 一个会话一个常驻 agent 进程、每个 150–200MB —— 看不见就会失控。
  /// 这是"此刻"的快照，不是流水，所以只保留最新一份。
  AgentSnapshot? agentSnapshot;
  static const int _maxDevSteps = 80;

  /// 会话内最近收到的下行序号（断线续传游标）。
  int lastSeq = 0;

  /// 同一 `seq` 内的本地插入序（保证连续发言顺序不被颠倒）。
  int _localTie = 0;

  bool connected = false;
  String? connectionError;

  /// 服务端要求的"刷新自己"。
  ///
  /// 前端是哑的：它不猜系统有没有变，只听服务端说（`client/reload`）。
  /// 但**什么时候真的刷**由这里决定 —— 不能在用户正看着一段话往外蹦的时候把页面刷掉。
  /// 所以：收到请求先记下来，等手上这轮说完再见机行事；等太久（[reloadGraceMs]）就强刷。
  VoidCallback? onReloadRequested;
  bool _reloadPending = false;
  DateTime? _reloadRequestedAt;
  /// 这次刷新是为了哪个构建指纹（用于护栏）。
  String? _reloadForBuild;

  /// 连上时服务端的时钟。
  ///
  /// 作用：划一条线 —— **只有在这之后产生的消息**才回报"我看到了"。
  /// 不划线的话，刷新页面时服务端会把整段历史补发回来，
  /// 客户端会把几个月前的话也回报一遍，用的是**新会话的钟** ——
  /// 算出来的"用户等了 15 秒"全是假数（实测踩过）。
  int? _serverNowAtConnect;
  static const Duration reloadGraceMs = Duration(seconds: 20);

  /// 刷新护栏：同一个标签页、同一个指纹只自动刷一次。
  ///
  /// 防的是这个死循环：服务端记的指纹和**实际部署的包**对不上（文件写错、
  /// 部署到一半）→ 客户端刷 → 还是旧包 → 又对不上 → 再刷……
  /// 宁可停在"版本对不上"这个状态，也不能让用户的页面自己抽风。
  bool _reloadAlreadyTried(String buildId) =>
      shouldSkipReload(buildId: buildId, alreadyReloadedFor: reloadGuardRead());

  /// 护栏判定是纯函数，单独拎出来是为了能被测试钉住（VM 上 sessionStorage 不存在）。
  @visibleForTesting
  static bool shouldSkipReload({required String buildId, required String? alreadyReloadedFor}) =>
      buildId.isNotEmpty && alreadyReloadedFor == buildId;

  /// 当前等待状态（thinking / listening / handoff / working），null = 无。
  StreamStatus? pendingStatus;

  /// **正在做的事**（异步任务）。用户可见："还有件事在处理"。
  ///
  /// 触发条件是"要多久"而不是"简单还是复杂" —— 需要很久的事不占用对话，
  /// 变成独立任务，做完再主动回来说。
  final Map<String, ActiveTask> activeTasks = {};

  String get conversationId => _conversationId;

  /// 时间线上最后一条**调度器消息**（界面据此决定是否显示"停下"按钮）。
  DispatcherMessage? get latestDispatcherMessage {
    for (var i = timeline.length - 1; i >= 0; i--) {
      final item = timeline[i];
      if (item is DispatcherMessage) return item;
    }
    return null;
  }

  /// 是否处于被动聆听（状态提示走独立区域，不进时间线）。
  bool get isListening =>
      pendingStatus == StreamStatus.listening ||
      timeline.any((t) => t is DispatcherMessage && t.status == StreamStatus.listening);

  void connect({int resumeFrom = 0, bool dev = false}) {
    _sub?.cancel();
    _devSub?.cancel();
    // 令牌被拒 ⇒ 弹回登录页（只订阅一次）
    _authSub ??= _transport.unauthorized.listen((_) => _onUnauthorized());
    if (dev) {
      _devSub = _transport.devSteps.listen((step) {
        devSteps.add(step);
        if (devSteps.length > _maxDevSteps) devSteps.removeAt(0);
        notifyListeners();
      });
      _agentSub?.cancel();
      _agentSub = _transport.agentSnapshots.listen((snap) {
        agentSnapshot = snap;
        notifyListeners();
      });
    }
    // 连接状态由**传输层**说了算（它自己会重连，所以只有它知道现在通不通）。
    // 界面据此把聊天窗口变灰、不可操作；恢复后自动变回来。
    _connSub?.cancel();
    _connSub = _transport.connectionState.listen((up) {
      if (connected == up) return;
      connected = up;
      if (up) connectionError = null;
      notifyListeners();
    });

    _sub = _transport.connect(conversationId: _conversationId, sinceSeq: resumeFrom, dev: dev).listen(
      _onEvent,
      onError: (Object e) {
        connected = false;
        connectionError = e.toString();
        notifyListeners();
      },
      onDone: () {
        connected = false;
        notifyListeners();
      },
    );
    connected = true;
    connectionError = null;
    // 每次连上（含重连）都对一次版本：断线期间部署了新版本的话，推送是收不到的
    unawaited(checkVersion());
    notifyListeners();
  }

  /// 断线重连：从 [lastSeq] 续传。移动端切后台/换网络是常态。
  void reconnect() => connect(resumeFrom: lastSeq, dev: devEnabled);

  // ── 鉴权状态 ──────────────────────────────────────────────
  //
  // 这台机器上跑着一个能执行命令、能动自己代码的 agent。
  // 没登录时界面**只能显示登录页**，一个字的对话内容都不能露出来。

  /// 服务端要不要登录。
  bool authRequired = false;

  /// 现在算不算登录了。
  bool authenticated = false;

  /// 登录是不是正在进行中。
  bool loggingIn = false;

  /// 上一次登录失败的原因（成功/未尝试时为 null）。
  String? loginError;

  /// 有没有拿到令牌（界面据此决定显示登录页还是对话页）。
  bool get needsLogin => authRequired && !authenticated;

  /// 问一次鉴权状态。App 启动和"令牌被拒"时都会调。
  Future<void> refreshAuth() async {
    final was = authenticated;
    final r = await _transport.authStatus();
    authRequired = r.required;
    authenticated = r.authenticated;
    if (authenticated != was) notifyListeners();
  }

  /// 登录：口令换令牌。
  Future<bool> login(String password) async {
    loggingIn = true;
    loginError = null;
    notifyListeners();
    try {
      final tok = await _transport.login(password);
      loggingIn = false;
      if (tok == null) {
        loginError = '口令不对';
        notifyListeners();
        return false;
      }
      authenticated = true;
      authRequired = true;
      notifyListeners();
      // 登录后才真正建连（令牌要带上去）
      connect(dev: devEnabled);
      return true;
    } catch (e) {
      loggingIn = false;
      loginError = '$e'.replaceFirst('Exception: ', '');
      notifyListeners();
      return false;
    }
  }

  /// 令牌被服务端拒了：回到登录页。**不清对话内容**（那本来就是空的）。
  void _onUnauthorized() {
    authenticated = false;
    authRequired = true;
    notifyListeners();
  }

  /// 是不是"连不上、界面该变灰"。
  ///
  /// 注意这里**不看** `connectionError`：那条是给用户看的原因说明，
  /// 而"变灰"只取决于通不通。
  bool get offline => !connected;

  /// 是否开启开发者模式（页面顶部显示后台活动卡片）。
  bool devEnabled = false;

  /// 切换开发者模式：重连以订阅/退订开发事件。
  void setDevMode(bool enabled) {
    if (devEnabled == enabled) return;
    devEnabled = enabled;
    if (!enabled) devSteps.clear();
    connect(resumeFrom: lastSeq, dev: enabled);
  }

  void _onEvent(ServerEvent event) {
    // 去重与防乱序回退
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;

    switch (event) {
      case MessageStartEvent():
        // 调度器开始一条新消息 —— **无论有没有对应的用户输入都接受**
        timeline.add(DispatcherMessage(
          seq: event.seq,
          at: DateTime.now(),
          messageId: event.messageId,
          origin: event.origin,
          interrupts: event.interrupts,
          re: event.re,
          sources: event.sources,
        ));
      case TaskCreatedEvent():
        // 这件事不现在答，改成独立任务：用户会看到"我拿去做了"
        activeTasks[event.taskId] = ActiveTask(
          taskId: event.taskId,
          title: event.title,
          startedAt: DateTime.now(),
        );
      case TaskCompletedEvent():
        activeTasks.remove(event.taskId);
      case MessageTextEvent():
        final m = _messageOf(event.messageId);
        if (m == null) return;
        if (event.block == TextBlock.deep) pendingStatus = null;
        if (!m.applyText(event)) return;
        // 第一次拿到这条消息的正文 ⇒ 记下"我是什么时候看到的"
        if (m.clientFirstSeenAt == null && event.text.isNotEmpty) {
          m.clientFirstSeenAt = DateTime.now().millisecondsSinceEpoch;
        }
      case MessageStatusEvent():
        pendingStatus = event.state;
        _messageOf(event.messageId)?.applyStatus(event);
      case ErrorMessageEvent():
        _messageOf(event.messageId)?.applyError(event);
      case MessageEndEvent():
        pendingStatus = null;
        final m = _messageOf(event.messageId);
        if (m == null) return;
        m.applyEnd(event);
        // 回报"我什么时候看到的"给监控层（失败也不影响用户）。
        // ⚠ 只报**连上之后产生**的消息（用服务端时钟划线），
        //   否则刷新时的历史补发会被当成"用户刚看到的"，测出来的延迟是假的。
        final endedAtServer = event.at;
        // ⚠ 拿不到服务端时钟就**不报** —— 宁可少一条数据，也不能把历史补发
        //   当成"用户刚看到的"（那会把延迟算成十几秒的假数）。
        final isLive = endedAtServer != null &&
            _serverNowAtConnect != null &&
            endedAtServer >= _serverNowAtConnect!;
        if (isLive) {
          m.clientEndedSeenAt = DateTime.now().millisecondsSinceEpoch;
          unawaited(_transport.reportSeen(
            conversationId: _conversationId,
            messageId: event.messageId,
            firstSeenAt: m.clientFirstSeenAt,
            endedSeenAt: m.clientEndedSeenAt,
          ));
        }
      case ClientReloadEvent():
        _requestReload(buildId: event.buildId);
      case UserEchoEvent():
        // 多端同步：服务端确认了某条用户发言（本端可能已有，去重）
        if (!timeline.any((t) => t is UserUtterance && t.messageId == event.messageId)) {
          timeline.add(UserUtterance(
            seq: event.seq,
            at: DateTime.now(),
            messageId: event.messageId,
            text: event.text,
            pending: false,
          ));
        }
    }
    _sortTimeline();
    _maybeReload();
    notifyListeners();
  }

  /// 服务端说该刷新了（或本地对版本发现不一致）。
  void _requestReload({String buildId = ''}) {
    // 注意：**服务端推来的刷新令在本地开发构建上也照做** —— 它是真实信号。
    // 只有"自己对版本"那条路才需要挡掉 dev 构建（'dev' ≠ 服务端指纹）。
    if (_reloadAlreadyTried(buildId)) return; // 已经为这个指纹刷过一次了，别再刷
    _reloadForBuild = buildId.isEmpty ? null : buildId;
    _reloadPending = true;
    _reloadRequestedAt ??= DateTime.now();
    _maybeReload();
  }

  /// 现在能不能刷：手上没有还没说完的话就刷，否则等它说完。
  void _maybeReload() {
    if (!_reloadPending) return;
    final waiting = timeline.any((t) => t is DispatcherMessage && !t.isFinished);
    final overdue = _reloadRequestedAt != null &&
        DateTime.now().difference(_reloadRequestedAt!) > reloadGraceMs;
    if (waiting && !overdue) return; // 让这一轮先说完整
    _reloadPending = false;
    // 先记护栏再刷：否则刷回来还是对不上，就成死循环了
    if (kIsWeb) {
      reloadClient(buildId: _reloadForBuild);
    } else {
      onReloadRequested?.call();
    }
  }

  /// 连上（或重连上）之后对一次版本：和服务端说的对不上就刷新自己。
  ///
  /// 为什么不能只靠服务端推：刷新令是**只在现场**推的，
  /// 断线期间部署了新版本的话客户端收不到 —— 所以每次连上都要自己对一次。
  Future<void> checkVersion() async {
    final info = await _transport.serverVersion();
    final now = info?['serverNow'];
    if (now is int) _serverNowAtConnect = now;
    if (isDevBuild) return; // 本地开发构建没有指纹，比不了，比了就是无限刷新
    final serverBuild = info?['buildId'];
    if (serverBuild is! String || serverBuild.isEmpty) return; // 服务端没说，或还没部署过
    if (serverBuild == kClientBuildId) return;
    _requestReload(buildId: serverBuild);
  }

  /// 排序：(seq, tie) 升序。
  ///
  /// 本地发言取 `lastSeq` 作为 seq、递增 tie ⇒ 必然排在已收到的事件之后、
  /// 下一条服务端事件之前，且**连续发言顺序不乱**。
  void _sortTimeline() =>
      timeline.sort((a, b) => a.seq != b.seq ? a.seq.compareTo(b.seq) : a.tie.compareTo(b.tie));

  DispatcherMessage? _messageOf(String messageId) {
    for (var i = timeline.length - 1; i >= 0; i--) {
      final item = timeline[i];
      if (item is DispatcherMessage && item.messageId == messageId) return item;
    }
    return null;
  }

  /// 本地记录的"我什么时候按的发送"（客户端时钟）。
  ///
  /// 用途：监控层要算**用户等了多久才看到反馈**。只有服务端时钟算不出来 ——
  /// 用户按下发送到请求到达服务器之间还有一段时间。
  final Map<String, int> _saidAt = {};

  /// 用户发言。**立即入列**（不等待服务端），调度器可能有也可能没有回应。
  Future<void> say(String text) async {
    if (text.trim().isEmpty) return;
    final messageId = 'u_${DateTime.now().microsecondsSinceEpoch}';
    final now = DateTime.now();
    final utterance = UserUtterance(
      seq: lastSeq, // 排在已收到事件之后、下一条服务端事件之前
      tie: ++_localTie, // 连续发言顺序由 tie 保证
      at: now,
      sentAt: now.millisecondsSinceEpoch,
      messageId: messageId,
      text: text,
    );
    timeline.add(utterance);
    _sortTimeline();
    notifyListeners();

    _saidAt[messageId] = utterance.sentAt;
    try {
      await _transport.say(
        conversationId: _conversationId,
        messageId: messageId,
        text: text,
        clientAt: utterance.sentAt,
      );
      utterance.pending = false;
    } catch (e) {
      connectionError = '发送失败：$e';
      utterance.pending = false; // 保留在时间线上，由界面提供重试
    }
    notifyListeners();
  }

  /// 中止调度器当前输出。
  ///
  /// **已显示的字撤不回来** ⇒ 只做"就此打住"并追加说明（追加是唯一正确的纠错方式）。
  Future<void> cancelLatest() async {
    final m = latestDispatcherMessage;
    if (m == null || m.isFinished) return;
    await _transport.cancelMessage(conversationId: _conversationId, messageId: m.messageId);
    if (m.abort()) notifyListeners();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _devSub?.cancel();
    _connSub?.cancel();
    _agentSub?.cancel();
    _authSub?.cancel();
    _transport.dispose();
    super.dispose();
  }
}
