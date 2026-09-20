// 把"时间线 + 网络 + 令牌"串起来。手册 `03-DEVELOPMENT.md` §2.1（services 层）。
//
// 它只做两件事：**把本地意图发出去**、**把服务端事实收进来**。
// 判断（该不该配对、这句合不合理）**不在这里**——客户端是哑的。
//
// ⚠️ 不 import material（禁令 1 的延伸：services 只依赖 models）。

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/conn_state.dart';
import '../models/message_state.dart';
import '../models/timeline.dart';
import 'api.dart';
import 'stream.dart';
import 'timeline_store.dart';
import 'token_store.dart';

class ChatController extends ChangeNotifier {
  ChatController({
    required this.api,
    required this.tokens,
    String? token,
    TimelineStore? local,
  })  : _token = token,
        local = local ?? TimelineStore();

  final Api api;
  final TokenStore tokens;

  /// 本机那"一屏"（S5c）。**只缓存，不判断**——见 `timeline_store.dart`。
  final TimelineStore local;

  /// 收进来的**服务端事实**（只留带号的），存缓存就是从这份存。
  ///
  /// ⚠️ 为什么要单独留一份：`Timeline` 里已经是**画出来的条目**了，
  ///    从条目反推事件等于把"缓存"变成"第二次解释"——那就违反"只缓存，不判断"。
  final List<Map<String, dynamic>> _facts = [];

  final Timeline timeline = Timeline();
  String? _token;
  StreamClient? _stream;
  ConnState _conn = ConnState.idle;
  bool _needsSetup = false;
  String? _lastError;
  int _localSeq = 0;

  String? get token => _token;
  bool get needsSetup => _needsSetup;
  ConnState get conn => _conn;
  bool get connected => _conn == ConnState.connected;
  String? get lastError => _lastError;

  /// 界面读这个。
  List<TimelineItem> get items => timeline.items;

  /// 界面上那行「它正在做…」；`null` = 什么都不显示。
  String? get agentLine => timeline.agentLine;

  /// 登录后启动：**先画本地一屏**，再连流。
  ///
  /// ⚠️ 顺序不能反：① 屏幕先有东西（S5c 的全部目的）；
  ///    ② `sinceSeq` 要从缓存里那个号接着要，而不是从 0 重放一遍。
  Future<void> start({required String token}) async {
    _token = token;
    await tokens.write(token);
    _needsSetup = false;
    _lastError = null;
    await _restoreLocal();
    notifyListeners();
    _ensureStream();
  }

  /// 把上一屏读回来（读不到就什么都不做 —— **空屏是允许的，乱画不允许**）。
  Future<void> _restoreLocal() async {
    final events = await local.load();
    if (events.isEmpty) return;
    _facts.addAll(events);
    timeline.seedFromCache(events);
  }

  Future<void> logout() async {
    _stream?.close();
    _stream = null;
    _token = null;
    // ⚠️ 缓存跟着账号走：这台机器换了个人登录，**不许再看见上一个人的一屏**
    _invalidateLocal();
    timeline.reset();
    await tokens.clear();
    _conn = ConnState.idle;
    notifyListeners();
  }

  void _ensureStream() {
    final t = _token;
    if (t == null) return;
    if (_stream != null) return;
    final s = StreamClient(base: '', token: t, api: api);
    s.states.listen((st) {
      _conn = st;
      if (st == ConnState.unauthorized) {
        // ⚠️ 只有这一种情况才清令牌。**网络失败不清**（B1 的修法）
        _lastError = '登录过期了，重新登录一下';
      }
      notifyListeners();
    });
    s.events.listen(ingest);
    s.open(sinceSeq: timeline.lastSeq);
    _stream = s;
  }

  /// **服务端的事实，只有这一个入口。**
  ///
  /// 它公开而不是私有，有两个理由：
  ///   1. 它本来就是"从外面收进来"的那条路（`_ensureStream` 订阅到它就转这里）
  ///   2. 界面那一层要验"**这条事实到底有没有画到屏幕上**"——
  ///      而那只能靠搭起屏幕、从这一个入口喂进去
  ///      （`test/widget/busy_line_test.dart`）。没有它，S2 那类
  ///      "链子断在中间、屏幕上看不出来"的缺陷就**测不到**。
  void ingest(Map<String, dynamic> event) {
    if (event['type'] == '__reset__') {
      // 服务端说"你的号跑到我前面了"⇒ 本地那条时间线不作数了。
      // 不是"没有新东西"——是"从头来"。
      timeline.reset();
      // ⚠️ **缓存也要一起清**：不清的话下次开机又会把那个**已经不存在的世界**
      //    先画出来，然后再被服务端打脸——那一屏就是编造。
      _invalidateLocal();
      _lastError = '和服务器对不上了，正在重新同步';
      notifyListeners();
      return;
    }
    // ★ 服务端开口了：从这一刻起，"它正在做"才是我们**知道**的事
    timeline.markFresh();
    timeline.apply(event);
    if (TimelineStore.isPersistable(event)) {
      _facts.add(event);
      // 内存里也别只涨不降（留一点余量给"还没落盘的那几条"）
      if (_facts.length > TimelineStore.capEvents * 2) {
        _facts.removeRange(0, _facts.length - TimelineStore.capEvents);
      }
      _maybeSave(event);
    }
    notifyListeners();
  }

  /// 存缓存：**按"句子的边界"写，不按钟写**。
  ///
  /// * 结构性事件（一轮开始 / 收口 / 用户那句 / 分节标记）⇒ **立刻写**：
  ///   它们正好是屏幕上"稳定"的那些点。
  /// * 流式的 `message/text` ⇒ 每 [textSaveEvery] 条写一次。
  ///
  /// ⚠️ 为什么不用 `Timer` 做去抖：**测试里挂着一个没走完的定时器本身就是一种失败**
  ///    （`test/widget/busy_line_test.dart` 当场变红——那是"这件事有没有画到屏幕上"
  ///    唯一的自动化证据，不能被这种小事弄坏）。而且每一轮的末尾**一定**会有一次
  ///    `message/end`（超时硬收口也补一条，见 `07-TIMEOUT.md`）⇒ 尾巴不会丢。
  static const textSaveEvery = 8;
  int _textSinceSave = 0;

  /// 这一屏作废（服务端判死 / 退出登录）。
  ///
  /// ⚠️ 光清内存不够：**已经在飞的那次 `save()` 会晚一步落地**把刚判死的缓存写回去。
  ///    那一步由 `TimelineStore` 内部排队挡住（见那里的 `_enqueue`）。
  void _invalidateLocal() {
    _textSinceSave = 0;
    _facts.clear();
    local.clear();
  }

  void _maybeSave(Map<String, dynamic> event) {
    if (event['type'] == 'message/text') {
      _textSinceSave += 1;
      if (_textSinceSave < textSaveEvery) return;
    }
    _textSinceSave = 0;
    local.save(_facts);
  }

  /// 说一句。
  ///
  /// 顺序**不能反**：先本地乐观上屏（用户立刻看到自己的话），
  /// 再发请求，拿到结果再改状态。
  /// 反过来（先等请求回来再上屏）会让"按下发送"到"看见自己的字"之间是空的——
  /// 而那正是 8/10 的放弃点。
  Future<void> send(String text) async {
    final t = _token;
    if (t == null || text.trim().isEmpty) return;

    _localSeq += 1;
    final messageId = 'u_${DateTime.now().millisecondsSinceEpoch}_$_localSeq';
    timeline.addLocalUtterance(text, messageId);
    _lastError = null;
    notifyListeners();

    await _deliver(messageId, text, t);
  }

  /// 重发。**必须用同一个 messageId**——否则服务端会当成新的一句，
  /// 于是 agent 干两遍（评审 E2）。
  Future<void> resend(String messageId) async {
    final t = _token;
    if (t == null) return;
    final text = _textOf(messageId);
    if (text == null) return;
    timeline.retry(messageId);
    notifyListeners();
    await _deliver(messageId, text, t);
  }

  Future<void> _deliver(String messageId, String text, String token) async {
    final outcome = await api.say(
      messageId: messageId,
      text: text,
      token: token,
      clientAt: DateTime.now().millisecondsSinceEpoch,
    );

    switch (outcome) {
      case SayOk():
        // 走到 `sent`。真正的 `confirmed` 要等 WS 上那句回声——
        // **不能拿 HTTP 200 冒充"服务端收到了我这句"**：
        // 那只能说"请求到过"，不能说"我看见了"。
        timeline.setLocalState(messageId, MessageState.sent);
      case SayUnauthorized():
        timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '登录过期了，重新登录一下';
        // 令牌确实失效了（服务端明说 401）⇒ 这才清
        await tokens.clear();
        _token = null;
      case SayNotSetup():
        timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '这台机器还没设密码';
      case SayLocked(:final retryAfterSec):
        timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '试得太频繁，${(retryAfterSec / 60).ceil()} 分钟后再试';
      case SayRejected(:final message):
        timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '服务器没收下：$message';
      case SayNetworkError():
        timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '网没通，这条没发出去';
    }
    notifyListeners();
  }

  String? _textOf(String messageId) {
    for (final it in timeline.items) {
      if (it is UserUtterance && it.messageId == messageId) return it.text;
    }
    return null;
  }

  /// 启动时查一次"这台机器设密码了没"。
  Future<void> refreshSetupState() async {
    _needsSetup = await api.needsSetup();
    notifyListeners();
  }

  @override
  void dispose() {
    _stream?.dispose();
    _stream = null;
    super.dispose();
  }
}
