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
import 'draft_store.dart';
import 'stream.dart';
import 'timeline_store.dart';
import 'token_store.dart';

class ChatController extends ChangeNotifier {
  ChatController({
    required this.api,
    required this.tokens,
    String? token,
    TimelineStore? local,
    DraftStore? drafts,
    this.onUnauthorized,
  })  : _token = token,
        local = local ?? TimelineStore(),
        drafts = drafts ?? DraftStore();

  final Api api;
  final TokenStore tokens;

  /// 服务端明说"这个令牌没得续了"（续期 401）时叫一声——
  /// **界面那一层靠它回登录页**（services 不 import material，所以只能回调）。
  ///
  /// ⚠️ 和 `logout()`（用户自己按的退出）是两件事，但**收拾的东西一样**：
  ///    清令牌 + 清本机那一屏（换个人登录不许看见上一个人的）。
  final void Function()? onUnauthorized;

  /// 本机那"一屏"（S5c）。**只缓存，不判断**——见 `timeline_store.dart`。
  final TimelineStore local;

  /// 我这边**还没被服务端认领**的那几句（欠账 18）。
  ///
  /// ⚠️ 和 [local] **各存各的、不许重叠**：那边是服务端事实（带 `seq`），
  ///    这边是**没有号**的本地发言。一句被认领（`confirmed`）就从这边消失。
  ///    见 `draft_store.dart` 顶上那张边界表。
  final DraftStore drafts;

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

  /// 登录后启动：**先画本地一屏**（连用户自己打了一半的话一起），再连流。
  ///
  /// ⚠️ 顺序不能反：① 屏幕先有东西（S5c 的全部目的）；
  ///    ② `sinceSeq` 要从缓存里那个号接着要，而不是从 0 重放一遍。
  ///
  /// ⚠️ [openStream] 只给 `test/unit` 用：纯逻辑的闸不该去开真 socket
  ///    （那会让"这件事对不对"变成"这机器上网络快不快"）。
  ///    **生产路径永远是 `true`**，而且顺序永远是"先读本机、再连流"。
  ///
  /// ⚠️ **续期（欠账 13 · 决策 A）排在哪**：读到令牌之后、连流之前，
  ///    但**一定在这句 `notifyListeners()` 之后**。
  ///    理由就是 `17-LOCAL-FIRST.md` 的教训——续期要等网络（最长 8 秒），
  ///    挡在"先画本机一屏"前面的话，冷启动那一屏就没了。
  ///    ⇒ 顺序是：**先画本机 ⇒ 再续期 ⇒ 再连流**。
  Future<void> start({required String token, bool openStream = true}) async {
    _token = token;
    await tokens.write(token);
    _needsSetup = false;
    _lastError = null;
    await _restoreLocal();
    notifyListeners();
    // ★ 本机那一屏已经画出来了，这才轮到网络。
    if (!await _renew()) return; // 令牌真的没了 ⇒ 已经回登录页，别连流
    if (openStream) _ensureStream();
  }

  /// 续一次。**成功就用新的；401 才清；网的问题什么都不清。**
  ///
  /// 返回值：`true` = 可以照常往下走（拿到新令牌、或者拿旧令牌继续）；
  ///        `false` = 令牌真的不行了（已经清干净、也叫了 [onUnauthorized]）。
  ///
  /// ⚠️ 三条分支对应 [renewActionOf] 那个纯函数的三档，
  ///    这里**只管照着做**（判断在纯函数里，测试在 `test/unit` 里逐档钉住）。
  Future<bool> _renew() async {
    final t = _token;
    if (t == null) return true;
    final outcome = await api.renew(t);
    switch (renewActionOf(outcome)) {
      case RenewAction.useNewToken:
        // 存起来再用：**先落盘**（下次开机要拿它去连），再拿它连流。
        final fresh = (outcome as RenewOk).token;
        _token = fresh;
        await tokens.write(fresh);
        return true;
      case RenewAction.keepOldToken:
        // ⚠️ **一个字节都不许清**：网的问题、或者回执读不出来。
        //    拿旧令牌照常往下走——能连上就连，连不上走原来那套"网断了"。
        return true;
      case RenewAction.logout:
        // 服务端明说没得续了（过期 / 被撤销 / 过了绝对上限）——
        // **这是唯一该回登录页的情形**。
        _lastError = '登录过期了，重新登录一下';
        await logout();
        onUnauthorized?.call();
        return false;
    }
  }

  /// 把上一屏读回来（读不到就什么都不做 —— **空屏是允许的，乱画不允许**）。
  Future<void> _restoreLocal() async {
    final events = await local.load();
    if (events.isNotEmpty) {
      _facts.addAll(events);
      timeline.seedFromCache(events);
    }
    // ⚠️ **服务端事实先画完，再画我自己的话**（欠账 18）：
    //    `addLocalUtterance` 借的是"当前最大号"，所以必须等事实都进来了再借，
    //    否则那几句会被排到历史中间去。
    await _restoreDrafts();
  }

  /// 把"我打了、还没发出去"的那几句放回时间线。
  ///
  /// 放回去之后它们仍走**同一条渲染路径**（`UserBubble`）⇒ 屏幕上还是
  /// 「没发出去」+「重发」那条路（N11：可重试），而不是凭空变成"已收到"。
  Future<void> _restoreDrafts() async {
    for (final d in await drafts.load()) {
      timeline.addLocalUtterance(d.text, d.messageId);
      // 回到它原来的态（`sent` 读回来是 `failed`，理由见 [storableState]）
      timeline.setLocalState(d.messageId, d.state);
    }
  }

  /// 存档**从时间线现算一遍**（不另立一份"影子列表"）。
  ///
  /// ⚠️ 现算 = 不可能出现"存档里有一条屏幕上没有的"。而那正是最坏的那种缺陷：
  ///    刷新之后冒出一句用户以为自己已经发出去（或者根本没打过）的话。
  ///
  /// ⚠️ **只在真的变了的时候写盘**：这个方法在 `ingest()` 里是**每一帧**都调的，
  ///    而一轮流式回答能来上百条 `message/text`。不挡的话每一帧都写一次
  ///    localStorage——那是"一个用户几十个字就把盘写爆"的那类浪费
  ///    （`_maybeSave` 那套 `textSaveEvery` 去抖是同一个顾虑）。
  ///    比的是**刚交给磁盘的那一份**，不是"磁盘上现在是什么"（写落盘是异步的）。
  List<LocalDraft>? _draftsHandedOff;

  void _saveDrafts() {
    final now = draftsFrom(timeline.items);
    if (listEquals(now, _draftsHandedOff)) return;
    _draftsHandedOff = now;
    drafts.save(now);
  }

  Future<void> logout() async {
    _stream?.close();
    _stream = null;
    _token = null;
    // ⚠️ 缓存跟着账号走：这台机器换了个人登录，**不许再看见上一个人的一屏**，
    //    也**不许看见上一个人打了一半的话**（欠账 18）
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
      // ⚠️ 上面那一清把存档也清了，而 `timeline.reset()` **刻意保住了**
      //    用户自己未确认的那几句 ⇒ 立刻按"幸存下来的时间线"重存一次。
      //    不重存的话，刷新之后那几句就真没了——那正是欠账 18 要修的东西。
      _saveDrafts();
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
    // ⚠️ 服务端可能**正好在这一帧里认领了**本地那条（`user/echo`）⇒ 立刻把它
    //    从存档里去掉。晚一步的话，刷新之后它会被画两遍（一遍事实、一遍存档）。
    _saveDrafts();
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
  ///    那一步由两个 store 内部各自的排队挡住（见那里的 `_enqueue`）。
  ///
  /// ⚠️ 存档（本机那几句）**一起清**，但调用方在复位之后要**再存一次**：
  ///    `timeline.reset()` **刻意保住**用户自己未确认的那几句（`timeline.dart`），
  ///    所以那几句马上会从时间线里被重新派生出来——清的只是"服务端不认的那个世界"。
  void _invalidateLocal() {
    _textSinceSave = 0;
    _facts.clear();
    _draftsHandedOff = null; // 存档要清了 ⇒ "上一次交出去的那份"也不作数了
    local.clear();
    drafts.clear();
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
    // ⚠️ **在发出去之前先落存档**（欠账 18）：用户按下发送之后马上切出去、
    //    或者这一次请求就挂在网上，那这句话也必须还在。
    _saveDrafts();
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
    _saveDrafts(); // 态变了 ⇒ 存档跟着变（重发中也是 `queued`，刷新后仍可重发）
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
      case SayBusy():
        // 服务端**明说这一句没收下**（它满了，不是网的事、也不是令牌的事）
        // ⇒ 落 `failed`：屏幕上就是「没发出去」+「重发」，
        //   **用户可以就地重来**——那正是 N11 要的"可重试"。
        timeline.setLocalState(messageId, MessageState.failed);
        // 顶部状态条要说出**为什么**（N11：拒绝必须给人话，不是静默）。
        // ⚠️ 用词两条线：① 不许有内部词（`forbidden_words.dart` 那道闸守着）；
        //    ② **不许说成"网断了"**——网是通的，那是另一回事，说错了就是把排查带偏。
        //    阈值/占用比**只说在服务端**，这里一个字都不提。
        _lastError = '它现在忙不过来，过一会儿再发一次';
      case SayRejected(:final message):
        timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '服务器没收下：$message';
      case SayNetworkError():
        timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '网没通，这条没发出去';
    }
    // ⚠️ 上面每一条分支都改了那条的态（`sent` 或 `failed`）⇒ 存档要跟着走。
    //    `sent` 存进去时会被降成 `failed`（理由见 `draft_store.storableState`）：
    //    刷新之后回执不会再来，屏幕上必须有「重发」那条路，不能停在"已送到"。
    _saveDrafts();
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
