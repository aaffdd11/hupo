// 把"时间线 + 网络 + 令牌"串起来。手册 `03-DEVELOPMENT.md` §2.1（services 层）。
//
// 它只做两件事：**把本地意图发出去**、**把服务端事实收进来**。
// 判断（该不该配对、这句合不合理）**不在这里**——客户端是哑的。
//
// ⚠️ 不 import material（禁令 1 的延伸：services 只依赖 models）。

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/message_state.dart';
import '../models/timeline.dart';
import 'api.dart';
import 'stream.dart';
import 'token_store.dart';

class ChatController extends ChangeNotifier {
  ChatController({
    required this.api,
    required this.tokens,
    String? token,
  }) : _token = token;

  final Api api;
  final TokenStore tokens;

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

  /// 登录后启动：连流、并开始收事件。
  Future<void> start({required String token}) async {
    _token = token;
    await tokens.write(token);
    _needsSetup = false;
    _lastError = null;
    notifyListeners();
    _ensureStream();
  }

  Future<void> logout() async {
    _stream?.close();
    _stream = null;
    _token = null;
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
      _lastError = '和服务器对不上了，正在重新同步';
      notifyListeners();
      return;
    }
    timeline.apply(event);
    notifyListeners();
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
