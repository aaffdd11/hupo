// 把"时间线 + 网络 + 令牌"串起来。手册 `03-DEVELOPMENT.md` §2.1（services 层）。
//
// 它只做两件事：**把本地意图发出去**、**把服务端事实收进来**。
// 判断（该不该配对、这句合不合理）**不在这里**——客户端是哑的。
//
// ⚠️ 不 import material（禁令 1 的延伸：services 只依赖 models）。

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/conn_state.dart';
import '../models/export.dart';
import '../models/message_state.dart';
import '../models/notice.dart';
import '../models/process_levels.dart';
import '../models/timeline.dart';
import '../models/trash.dart';
import '../models/trash_words.dart';
import 'api.dart';
import 'compose_store.dart';
import 'draft_store.dart';
import 'process_level_store.dart';
import 'stream.dart';
import '../models/token_sub.dart';
import 'timeline_store.dart';
import 'token_store.dart';

class ChatController extends ChangeNotifier {
  ChatController({
    required this.api,
    required this.tokens,
    String? token,
    TimelineStore? local,
    DraftStore? drafts,
    ComposeStore? compose,
    ProcessLevelStore? levels,
    this.onUnauthorized,
  })  : _token = token,
        local = local ?? TimelineStore(),
        drafts = drafts ?? DraftStore(),
        compose = compose ?? ComposeStore(),
        levels = levels ?? ProcessLevelStore() {
    // ⚠️ 构造时就带令牌的场合（`main.dart` 冷启动那条路）也要先绑好命名空间，
    //    否则第一次 `_restoreLocal()` 读的还是默认那一份（= 上一个人的）。
    _bindNamespace(token);
  }

  /// **把两个缓存的命名空间绑到"这是谁"**（多租户 · `38-ISOLATION-SPLIT.md` §8.1）。
  ///
  /// ⚠️ 时机是硬要求：**必须在读缓存之前**（`_restoreLocal()` 之前）。
  ///    晚一步，那一屏画的就还是上一个人的世界。
  /// ⚠️ 令牌读不出 `sub` 时退回一个**谁都不属于**的名字（`cacheNamespaceFallback`），
  ///    **绝不**退回某个可能撞上真人的值。
  /// ⚠️ `levels`（过程档位）**故意不绑**：它是**设备级偏好**，按账号分反而会让
  ///    同一个人换台设备就丢设置。见 §8.2 最后一句。
  void _bindNamespace(String? token) {
    final ns = cacheNamespaceOf(token);
    local.namespace = ns;
    drafts.namespace = ns;
    compose.namespace = ns;
  }

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

  /// **打字框里那串还没发出去的字**（第三本账 —— 见 `compose_store.dart` 顶上那张表）。
  /// ⚠️ 它**不属于时间线**：一个字都没发出去，所以它不进 `items`、不带四态、没有"重发"。
  final ComposeStore compose;

  /// 现在存着的那份打字草稿（`null` = 没有）。界面拿它画"上面那条草稿"。
  String? composeDraft;

  /// 过程四档存在哪（契约 §三）。**按设备存、按账号不存**。
  final ProcessLevelStore levels;

  /// 收进来的**服务端事实**（只留带号的），存缓存就是从这份存。
  ///
  /// ⚠️ 为什么要单独留一份：`Timeline` 里已经是**画出来的条目**了，
  ///    从条目反推事件等于把"缓存"变成"第二次解释"——那就违反"只缓存，不判断"。
  ///
  /// ⚠️ 不 `final`：**删除**要把属于那几个 id 的事实整批换掉
  ///    （`withoutMessages`；纯函数，进 `test/unit`）。
  List<Map<String, dynamic>> _facts = [];

  final Timeline timeline = Timeline();
  String? _token;
  StreamClient? _stream;
  ConnState _conn = ConnState.idle;
  bool _needsSetup = false;
  String? _lastError;
  int _localSeq = 0;

  /// 现在这一幕给用户看多少过程（契约 §三）。**开档前是默认档 `doing`**。
  ProcessLevel _level = defaultProcessLevel;

  /// 浮窗里现在挂着的那一条通知（契约 `29-NOTICE.md` 约束 1）。
  ///
  /// ⚠️ 它**只是浮窗那半边**：时间线那一条在 `Timeline` 里（约束 2），
  ///    两者由**同一个事件**喂进来，界面那一层两处照同一份数据画。
  Notice? _notice;

  /// 浮窗**自己消失**用的那个钟。
  ///
  /// ⚠️ 时长住在这一处、**不许写进任何给用户看的话**（契约 §一 第 4 条：
  ///    不承诺时间——"3 秒后消失"那类话是承诺，一个都不许有）。
  static const noticeLinger = Duration(seconds: 6);

  /// **这条连接还在读首屏那段历史吗**（见 `ingest()` 里 `__caught_up__` 那一段）。
  /// ⚠️ 每次连上都从 `true` 开始，读到服务端那条 `client/hello` 才变 `false`。
  bool _readingHistory = true;

  Timer? _noticeTimer;

  String? get token => _token;
  bool get needsSetup => _needsSetup;
  ConnState get conn => _conn;
  bool get connected => _conn == ConnState.connected;
  String? get lastError => _lastError;

  /// 浮窗里现在该显示的那一条；`null` = **一个像素都不画**（约束 1：
  /// 它要么浮在内容上、要么不在，**绝不参与布局**）。
  Notice? get notice => _notice;

  /// 现在这一幕的过程档位。
  ProcessLevel get level => _level;

  /// 界面读这个。
  List<TimelineItem> get items => timeline.items;

  /// 界面上那行「它正在做…」；`null` = 什么都不显示。
  ///
  /// ⚠️ **安静档（`quiet`）在这儿被掐掉**：契约 §一 说那一档
  ///    "连「它正在做…」也没有"。
  ///    光靠服务端不发 `message/status` 是不够的——`timeline.agentLine`
  ///    还有一条兜底（"有没收口的气泡" ⇒ 推得出它在做），
  ///    那条路跟档位无关。所以闸必须打在**拿到档位的这一层**。
  String? get agentLine =>
      _level == ProcessLevel.quiet ? null : timeline.agentLine;

  /// 第 ③ 档要画的步骤流水（其余档位返回空 ⇒ 界面自然不画）。
  ///
  /// ⚠️ `doing` 档服务端本来就不发步骤，但这一层也要挡：
  ///    用户从"步骤流水"切回"在做什么"时，屏幕上**立刻**不该再留着那串步骤
  ///    （它们下一帧就会被清，但那一帧可能很久才来）。
  List<ProcessStep> get steps =>
      _level == ProcessLevel.steps || _level == ProcessLevel.reasoning
          ? timeline.steps
          : const [];

  /// 第 ④ 档要看的思考原文 —— **挂在它那条气泡上**（`AssistantMessage.reasoning`）。
  ///
  /// ⚠️ 只**不显示**，不删：换出第 ④ 档之后它还在内存里，
  ///    换回来还看得见（那是"回头看它当时怎么想的"这条路）。
  ///    真正让它消失的是 `Timeline.reset()`（重放 / 退出登录）。
  ///
  /// ⚠️ 闸必须打在这一层（和 [agentLine] 同一条理由）：界面是哑的，
  ///    而"现在是不是第 ④ 档"只有这里有。
  String reasoningOf(AssistantMessage m) =>
      _level == ProcessLevel.reasoning ? m.reasoning : '';

  /// 屏幕上有没有**过程**可画（决定列表尾巴那一条要不要占位置）。
  ///
  /// ⚠️ **推理原文不算在内**：它挂在气泡上、由 `_render` 那条路画，
  ///    不在尾巴上（批 3 改过一次，见 `AssistantMessage.reasoning`）。
  bool get hasProcess => agentLine != null || steps.isNotEmpty;

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
    // 🔴 **读缓存之前**先绑命名空间（晚一步 = 那一屏画的是上一个人的世界）
    _bindNamespace(token);
    await tokens.write(token);
    _needsSetup = false;
    _lastError = null;
    // ★ 过程档位是**本机偏好**，跟"先画本机一屏"一起读出来——
    //   它决定了那一屏上那行「它正在做…」要不要出现（安静档不许有）。
    _level = await levels.read();
    await _restoreLocal();
    notifyListeners();
    // ★ 本机那一屏已经画出来了，这才轮到网络。
    if (!await _renew()) return; // 令牌真的没了 ⇒ 已经回登录页，别连流
    if (openStream) _ensureStream();
  }

  /// 换档（契约 §三）。
  ///
  /// ⚠️ **`level` 是连接级的** ⇒ 换档只能靠**重连**：旧的连接还按旧档
  ///    在发（或者按旧档在*不发*）。重连时带上 `timeline.lastSeq`，
  ///    中间那段事实由服务端的补发兜住（协议 R5）。
  ///
  /// ⚠️ 存盘**先做**：就算马上要重连、就算这一次重连失败，
  ///    下次开机也得是用户刚选的那一档。
  Future<void> setLevel(ProcessLevel level) async {
    if (level == _level) return;
    _level = level;
    await levels.write(level);
    notifyListeners();
    if (_stream == null) return;
    // ⚠️ `dispose` 不是 `close`：换档会反复走这条路，旧的流连它那两个
    //    `StreamController` 一起收掉，别留着一堆没人引用的监听。
    final old = _stream;
    _stream = null;
    await old?.dispose();
    _ensureStream();
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
    // ★ 打字框里那份草稿（第三本账）：**只读进内存**，不往时间线上放
    //   （它一个字都没发出去 —— 放上去就是"画一条假历史"）。
    composeDraft = await compose.load();

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
    // ⚠️ 浮窗跟着账号走：换个人登录不许还看见上一位那条通知
    _dismissNotice();
    // ⚠️ 缓存跟着账号走：这台机器换了个人登录，**不许再看见上一个人的一屏**，
    //    也**不许看见上一个人打了一半的话**（欠账 18）
    _invalidateLocal();
    timeline.reset();
    // ⚠️ 打字框那份草稿**跟着账号走**：换个人登录不许看见上一个人打了一半的话
    composeDraft = null;
    await compose.clear();
    await tokens.clear();
    _conn = ConnState.idle;
    notifyListeners();
  }

  void _ensureStream() {
    final t = _token;
    if (t == null) return;
    if (_stream != null) return;
    final s = StreamClient(base: '', token: t, api: api, level: _level);
    s.states.listen((st) {
      _conn = st;
      if (st == ConnState.unauthorized) {
        // ⚠️ 只有这一种情况才清令牌。**网络失败不清**（B1 的修法）
        _lastError = '登录过期了，重新登录一下';
      }
      notifyListeners();
    });
    s.events.listen(ingest);
    // 每开一条新连接都从「在读历史」开始（读到 `client/hello` 才算读到「现在」）
    _readingHistory = true;
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
    if (event['type'] == '__caught_up__') {
      // ★ **首屏那段历史读完了**（信号来自 `stream.dart` 收到的 `client/hello`）
      //   —— 从这一刻起收到的才算"现在发生的"。
      //   🔴 起因（主人 2026-09-22 报的）：*"登录后，出现'刚才出了点事，我已经重来了'。
      //     但是其他手机的并没有出现这段话。"* 那条是**很久以前**的崩溃通知，
      //     却**每次登录都弹一次浮窗** —— 既是骚扰（R1.2 通知疲劳），也是假话
      //     （"刚才"其实不是刚才）。规则见 `models/notice.dart` 的 `shouldPopNotice()`。
      _readingHistory = false;
      return;
    }
    if (event['type'] == '__reset__') {
      // 服务端说"你的号跑到我前面了"⇒ 本地那条时间线不作数了。
      // 不是"没有新东西"——是"从头来"。
      timeline.reset();
      // ⚠️ **浮窗一起撤**：它是"现在喊你一声"，而这一屏已经不算是那个世界了
      //    （时间线里那一条也跟着被清掉，重放会把它重新送上来）。
      _dismissNotice();
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

    // ★ 系统通知（契约 `29-NOTICE.md`）：
    //   · `notice`（带号）⇒ ① 时间线里留一条（`timeline.apply`）
    //                        ② 浮窗喊一声（**补发上来的不喊**，见下）
    //   · `notice/urgent`（无号）⇒ **只在浮窗里**、绝不新增时间线条目。
    //   ⚠️ 浮窗那一声必须**在 `timeline.apply` 之前**决定，理由只有一个：
    //      补发的（`catchUp`）通知是**过去发生过的事**，而浮窗是"现在喊你"。
    //      混起来的话，冷启动一屏历史通知会一条条往外弹（那是骚扰，也是假话）。
    final type = event['type'];
    if (type == 'notice/urgent') {
      _showNotice(Notice.fromEvent(event));
    } else if (type == 'notice' &&
        shouldPopNotice(catchUp: event['catchUp'] == true, readingHistory: _readingHistory)) {
      // ⚠️ **浮窗里的撤销与时间线里那条是同一件事**（约束 3）⇒
      //    两处都渲染 `notice.undo`，都由 `undoNotice()` 走同一条路。
      _showNotice(Notice.fromEvent(event));
    }
    timeline.apply(event);

    // ★ **删掉 / 恢复 / 真删**（契约 §8.1、§8.3）：模型那一层已经把条目
    //   藏起来 / 取消藏 / 丢掉了；这里补的是**本机那两份**（契约 §四 🔴）：
    //   缓存里那一屏 + 属于这一轮的草稿。
    //
    //   ⚠️ 为什么非清不可：不清的话，下一次开机本机缓存会**先把那一屏画出来**
    //      ——屏幕上又出现"已经删掉的话"，而服务端那边它已经没了。那就是说假话。
    //   ⚠️ 墓碑事件**自己不许清**：它是"谁被删过"的唯一凭据，
    //      冷启动要靠它把藏起来这件事重新立起来。
    final forgets = event['type'] == 'turn/deleted' || event['type'] == 'turn/purged';
    final ids = Timeline.messageIdsOfEvent(event);

    if (TimelineStore.isPersistable(event)) {
      _facts.add(event);
      // 内存里也别只涨不降（留一点余量给"还没落盘的那几条"）
      if (_facts.length > TimelineStore.capEvents * 2) {
        _facts.removeRange(0, _facts.length - TimelineStore.capEvents);
      }
      if (forgets) {
        // ⚠️ **先去掉、再写盘**：反过来的话会先把"已经删掉的那一屏"原样写回去，
        //    下一次开机就又画出来了。
        // ⚠️ 写盘**立刻做**（不走 `_maybeSave` 的去抖）：这一条是结构性的，
        //    而且它错了的代价是屏幕上出现已经删掉的话。
        _facts = withoutMessages(_facts, ids.toSet());
        local.save(_facts);
      } else {
        _maybeSave(event);
      }
    }
    // ⚠️ 服务端可能**正好在这一帧里认领了**本地那条（`user/echo`）⇒ 立刻把它
    //    从存档里去掉。晚一步的话，刷新之后它会被画两遍（一遍事实、一遍存档）。
    // ★ 被删掉的那一轮若在存档里（它还没被认领）⇒ 这一句会把它一并去掉：
    //   `draftsFrom` 是从**画得出来的那些**条目推的（`timeline.items`）。
    _saveDrafts();
    notifyListeners();
  }

  // ── 系统通知那半边的浮窗（契约 `29-NOTICE.md` 约束 1 / 3）────────

  /// 把一条通知挂到浮窗上（**并让它自己消失**）。
  ///
  /// ⚠️ 这里**只管浮窗**：时间线那一条由 `timeline.apply` 管（约束 2）。
  ///    两处不是"两份状态"，是**同一条通知的两个落点**。
  ///
  /// ⚠️ 谁也不许在这里写"几秒后消失"那种话（契约 §一 第 4 条）。
  void _showNotice(Notice? n) {
    // 没有话 / 读不出来的通知不上屏（宁可没有，也不给一个空框）
    if (n == null) return;
    _noticeTimer?.cancel();
    _notice = n;
    _noticeTimer = Timer(noticeLinger, _dismissNotice);
  }

  /// **打字框里的字变了**（界面每敲一下就喊一声）。
  ///
  /// ⚠️ 存的是"**打了一半**"这件事本身：一个字都没发出去。
  ///    与 `_saveDrafts()`（已发未认领那本账）**井水不犯河水**。
  void saveComposeDraft(String text) {
    final t = text.trim().isEmpty ? null : text;
    if (t == composeDraft) return;
    composeDraft = t;
    compose.save(text); // 不 await：存不上也不能让打字卡住
  }

  /// **把这份草稿丢掉**（用户说"不用了"，或者他发出去了）。
  void clearComposeDraft() {
    if (composeDraft == null) return;
    composeDraft = null;
    compose.clear();
    notifyListeners();
  }

  /// 浮窗撤掉（用户按了撤销 / 知道了 / 它自己到点了 / 退出登录）。
  ///
  /// ⚠️ **时间线那一条不跟着撤**（约束 2）：那正是这一件存在的理由——
  ///    浮窗只是"喊一声"，而通知要经得起"你不在"。
  void _dismissNotice() {
    _noticeTimer?.cancel();
    _noticeTimer = null;
    if (_notice == null) return;
    _notice = null;
    notifyListeners();
  }

  /// 界面上那两个"知道了"按的就是这个。
  void dismissNotice() => _dismissNotice();

  /// 撤销这条路要交给服务端的东西（**按不动就 `null`**）。
  ///
  /// ⚠️ 两个入口、**同一份判断**：
  ///    · `from == null` ⇒ 浮窗里那个（读浮窗手上那一条）；
  ///    · 给了 `from` ⇒ **时间线里**那一条。
  ///
  /// ⚠️ 为什么时间线那个**不能**读浮窗手上那一条（这一条踩过一次，别改回去）：
  ///    浮窗**会自己消失**（约束 2），而"撤销窗口不能随浮窗一起消失"
  ///    正是约束 3 的全部意思。读浮窗 = 浮窗一走，时间线那个按钮就成了
  ///    一个按了不会有结果的按钮 —— 那是屏幕上说假话（N10）。
  ///
  /// ⚠️ `action` 今天只有一条（`trash/restore`，契约 §五）：
  ///    认不出来的 action 一律**不给入口**。
  /// ⚠️ 它**不新造接口**：复用的是回收站那条 `trashRestore`（`restoreTurn`）。
  ///    通知的撤销与回收站里那个"恢复"是同一件事。
  List<String>? undoNoticeIds({TimelineNotice? from}) {
    final u = from?.undo ?? _notice?.undo;
    if (u == null || !u.usable) return null;
    if (u.action != NoticeUndoAction.trashRestore) return null;
    return u.messageIds;
  }

  /// 按撤销：**和回收站里那个"恢复"是同一条路**。
  ///
  /// [from] 同 [undoNoticeIds]：不传 = 浮窗那个；传了 = 时间线那一条。
  ///
  /// ⚠️ 成没成都如实说（N11）：失败时把浮窗撤掉、把那一句写上顶部状态条，
  ///    而且把结果**交回调用方**（按下它的那一层才说得出话）。
  ///    ——"以为拿回来了其实没有"和"以为没拿回来其实拿回来了"都不许出现
  ///    （契约 §四 🔴 与回收站那一批同一条纪律）。
  ///
  /// ⚠️ **两处走的是同一个方法**（约束 3 说的"同一件事"就是这个意思）：
  ///    差别只有"这份 undo 是从哪儿读的"。浮窗撤掉只是顺手——
  ///    时间线那一条**不撤**（它就是给"你不在"留的）。
  ///
  /// 返回值：`null` = 这一条没有按得动的撤销（**什么都没做**）。
  Future<TrashAnswer<bool>?> undoNotice({TimelineNotice? from}) async {
    final ids = undoNoticeIds(from: from);
    if (ids == null) return null;
    _notice = null;
    _noticeTimer?.cancel();
    _noticeTimer = null;
    final r = await restoreTurn(ids);
    if (r is! TrashOk<bool>) {
      _lastError = r is TrashUnauthorized ? trashUnauthorizedLine : trashRestoreFailedLine;
      notifyListeners();
    }
    return r;
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
    // 🔴 **还要清掉"别人的那一份"**（共用设备）：只清自己那份等于没清 ——
    //    他退出了，下一个用这台机器的人照样能把那个世界画出来（`38` §8.2）。
    //    ⚠️ 这两句**故意不 await**：清缓存是"最好有"，不许挡住回登录页那一屏。
    local.clearAllNamespaces();
    drafts.clearAllNamespaces();
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

  // ── 删掉 / 回收站（契约 `docs/dev/28-DELETE.md`）──────────────

  /// 长按某一条时，**该把哪几个 id 交给服务端**。
  ///
  /// 一轮 = 一条用户的话 + 它的回答（契约 §三·补：落盘的事件里没有轮号，
  /// 所以"哪两条算一轮"只能由看得见时间线的这一侧给）。
  ///
  /// 返回 `null` = 这一条还不在任何一轮里（**比如还没发出去的那句**）——
  /// 那时界面上不该给"删掉"这个入口：那会是一个删不掉的动作。
  List<String>? turnMessageIds(String messageId) {
    final g = turnGroupOf(timeline.items, messageId);
    if (g == null) return null;
    final ids = g.messageIds;
    return ids.isEmpty ? null : ids;
  }

  /// 删前那份清单。**只读**（契约 §8.2：这一步不许有门槛）。
  Future<TrashAnswer<TrashPlan>> planDelete(List<String> messageIds) async {
    final t = _token;
    if (t == null) return const TrashUnauthorized<TrashPlan>();
    return api.trashPlan(messageIds: messageIds, token: t);
  }

  /// 删掉（放进回收站）。
  ///
  /// ⚠️ 成功之后**立刻就地藏 + 清本机**，不等 WS 上那条 `turn/deleted`：
  ///    契约 §四 🔴 要的是"删完屏幕上就一个字都不剩"，
  ///    而"等服务端那一帧"在断线时**永远不会来**——那时就是屏幕在说假话。
  ///    （事件到了会再走一遍，幂等。）
  Future<TrashAnswer<bool>> removeTurn(List<String> messageIds) async {
    final t = _token;
    if (t == null) return const TrashUnauthorized<bool>();
    final r = await api.trashRemove(messageIds: messageIds, token: t);
    if (r is TrashOk<bool>) await _forgetTurn(messageIds);
    return r;
  }

  /// 回收站里现在有什么。
  Future<TrashAnswer<List<TrashEntry>>> loadTrash() async {
    final t = _token;
    if (t == null) return const TrashUnauthorized<List<TrashEntry>>();
    return api.trashList(token: t);
  }

  /// 从回收站拿回来。
  ///
  /// ⚠️ 服务端会落一条 `turn/restored`（契约 §8.3），但那一帧要是没到
  ///    （断线 / 补发窗口已经过去），屏幕上就少了一条**其实已经拿回来**的话
  ///    ——那也是一种说假话 ⇒ 就地取消隐藏（幂等，事件到了再做一遍没差别）。
  Future<TrashAnswer<bool>> restoreTurn(List<String> messageIds) async {
    final t = _token;
    if (t == null) return const TrashUnauthorized<bool>();
    final r = await api.trashRestore(messageIds: messageIds, token: t);
    if (r is TrashOk<bool>) {
      timeline.showMessages(messageIds);
      notifyListeners();
    }
    return r;
  }

  /// 彻底删掉（拿不回来）。成功后**从内存里丢掉**（契约 §8.3）。
  Future<TrashAnswer<bool>> purgeTurn(List<String> messageIds) async {
    final t = _token;
    if (t == null) return const TrashUnauthorized<bool>();
    final r = await api.trashPurge(messageIds: messageIds, token: t);
    if (r is TrashOk<bool>) await _forgetTurn(messageIds, purge: true);
    return r;
  }

  /// **导出**：拿那一段能粘走的文字（契约 `docs/dev/30-EXPORT.md`）。
  ///
  /// ⚠️ **不在这一侧拼**：那段文字由服务端渲染（§六）——
  ///    只有它知道回收站里删过谁（§三：那些不算进来，但条数要报）。
  ///    客户端拿到成品，只负责显示与复制。
  /// ⚠️ 没有令牌 ⇒ 直接 [TrashUnauthorized]（**不是**"网不好"）。
  Future<TrashAnswer<ExportDoc>> loadExport() async {
    final t = _token;
    if (t == null) return const TrashUnauthorized<ExportDoc>();
    return api.exportText(token: t);
  }

  /// 就地收拾"这一轮已经不在了"：藏起来（或丢掉）+ **清本机那两份**。
  ///
  /// ⚠️ 这两件事必须**一起**做。只藏内存不清缓存 ⇒ 下次开机那一屏又画出来；
  ///    只清缓存不藏内存 ⇒ 这一屏现在还看得见。
  Future<void> _forgetTurn(List<String> messageIds, {bool purge = false}) async {
    final ids = messageIds.toSet();
    if (purge) {
      timeline.purgeMessages(messageIds);
    } else {
      timeline.hideMessages(messageIds);
    }
    _facts = withoutMessages(_facts, ids);
    // ⚠️ 立刻写盘（不是 `_maybeSave` 那种去抖）：这是结构性的，
    //    而且**写晚了就等于"已经删掉的一屏还留在盘上"**。
    await local.save(_facts);
    // 草稿从"画得出来的那些"重算 ⇒ 属于这一轮的草稿跟着消失（`draftsFrom`）。
    _saveDrafts();
    notifyListeners();
  }

  /// 启动时查一次"这台机器设密码了没"。
  Future<void> refreshSetupState() async {
    _needsSetup = await api.needsSetup();
    notifyListeners();
  }

  @override
  void dispose() {
    // ⚠️ 那个"自己消失"的钟必须先停：不然它到点时会去动一个已经 dispose 的
    //    通知器（而且在测试里**留一个没走完的定时器本身就是一种失败**）。
    _noticeTimer?.cancel();
    _noticeTimer = null;
    _stream?.dispose();
    _stream = null;
    super.dispose();
  }
}
