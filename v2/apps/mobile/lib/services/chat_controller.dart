// 把"时间线 + 网络 + 令牌"串起来。手册 `03-DEVELOPMENT.md` §2.1（services 层）。
//
// 它只做两件事：**把本地意图发出去**、**把服务端事实收进来**。
// 判断（该不该配对、这句合不合理）**不在这里**——客户端是哑的。
//
// ⚠️ 不 import material（禁令 1 的延伸：services 只依赖 models）。

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/conn_state.dart';
import '../models/chat_queue.dart';
import '../models/export.dart';
import '../models/hearing_session.dart';
import '../models/job_ask.dart';
import '../models/job_words.dart';
import '../models/message_state.dart';
import '../models/mini_update.dart';
import '../models/notice.dart';
import '../models/plan.dart';
import '../models/process_levels.dart';
import '../models/timeline.dart';
import '../models/trash.dart';
import '../models/trash_words.dart';
import 'api.dart';
import 'compose_store.dart';
import 'draft_store.dart';
import 'hearing.dart' as hearing_service;
import 'speech.dart' as speech_service;
import 'speech_store.dart';
import 'process_level_store.dart';
import 'stream.dart';
import 'stream_uri.dart';
import '../models/scope.dart';
import '../models/token_sub.dart';
import '../models/tool_row.dart';
import 'timeline_store.dart';
import 'token_store.dart';

/// **那条流怎么造**（只为判据存在的注入口 —— 见 `ChatController.newStream`）。
///
/// ⚠️ 四个参数**一个都不能少**：`level` 是**连接级**的（服务端按每条连接决定
///    发多少过程）；`scope` 现在是**初始焦点**（C 期起，契约 84 §三·3 ——
///    连上之后切房间走 `StreamClient.focus()` 那一帧，**不重连**）。
///    漏传一个，"这条连接一上来听哪一间 / 发多少过程"就会静默地只对了一半。
typedef NewStream =
    StreamClient Function({
      required String base,
      required String token,
      required ProcessLevel level,
      required String scope,
    });

class ChatController extends ChangeNotifier {
  ChatController({
    required this.api,
    required this.tokens,
    String? token,
    TimelineStore? local,
    DraftStore? drafts,
    ComposeStore? compose,
    ProcessLevelStore? levels,
    SpeechStore? speech,
    this.onUnauthorized,
    /// **念出来**那两个动作（可注入 —— 判据要能验"该念的时候调了没有"）。
    /// ⚠️ 默认就是真的那两个（`services/speech.dart`）；判据注一个记账的进去。
    bool Function(String text, {void Function()? onEnd})? speak,
    void Function()? stop,
    /// **开麦/收手**那两个动作（可注入 —— 判据要能验"按下去了没有"）。
    /// ⚠️ 默认就是真的那两个（`services/hearing.dart`）；判据注一个记账的进去。
    Future<String?> Function({
      required Uri url,
      required String token,
      required void Function(Map<String, dynamic>) onEvent,
    })? startHear,
    void Function()? stopHear,
    /// **那条流怎么造**（可注入 —— 判据要能验"切房间**只发焦点、不重连**"）。
    /// `null` = 生产那一条（`StreamClient` → `/api/stream`）。
    /// ⚠️ 判据里注一个假的进去 ⇒ 不用真开 socket 也验得了 `setScope` 那几件事
    ///    （连接不新建/不重开、焦点帧带的哪一间与哪个游标）。
    NewStream? newStream,
  }) : _token = token,
       local = local ?? TimelineStore(),
       drafts = drafts ?? DraftStore(),
       compose = compose ?? ComposeStore(),
       levels = levels ?? ProcessLevelStore(),
       speech = speech ?? SpeechStore(),
       _newStream = newStream,
       _speak = speak ?? speech_service.speakAloud,
       _stopSpeaking = stop ?? speech_service.stopSpeaking,
       _startHear = startHear ?? hearing_service.startHearing,
       _stopHear = stopHear ?? hearing_service.stopHearing {
    // ⚠️ 构造时就带令牌的场合（`main.dart` 冷启动那条路）也要先绑好命名空间，
    //    否则第一次 `_restoreLocal()` 读的还是默认那一份（= 上一个人的）。
    _bindNamespace(token);
  }

  /// **把两个缓存的命名空间绑到"这是谁"＋"在哪一间"**
  /// （多租户 · `38-ISOLATION-SPLIT.md` §8.1；房间 · `83-APP-WORKSPACE.md` §五·甲）。
  ///
  /// ⚠️ 时机是硬要求：**必须在读缓存之前**（`_restoreLocal()` 之前）。
  ///    晚一步，那一屏画的就还是上一个人的世界（或者上一个房间的）。
  /// ⚠️ 令牌读不出 `sub` 时退回一个**谁都不属于**的名字（`cacheNamespaceFallback`），
  ///    **绝不**退回某个可能撞上真人的值。
  /// ⚠️ `levels`（过程档位）**故意不绑**：它是**设备级偏好**，按账号分反而会让
  ///    同一个人换台设备就丢设置。见 §8.2 最后一句。
  /// ⚠️ **一间一份**（[scopedCacheNamespace]）：不分开的话，切房间就是拿新房间那一屏
  ///    把老房间那份缓存**覆写掉** —— 回到桌面就再也看不到主线原来的对话了。
  ///    主对话沿用老键（理由见 `models/scope.dart`）。
  void _bindNamespace(String? token) {
    final ns = cacheNamespaceOf(token);
    final scoped = scopedCacheNamespace(ns, _scope);
    local.namespace = scoped;
    drafts.namespace = scoped;
    compose.namespace = scoped;
  }

  final Api api;
  final TokenStore tokens;

  /// **把某一间在本机那份缓存丢掉**（契约 `docs/dev/103-APP-DELETE.md` §七 · 决策 D3.11）。
  ///
  /// 服务端把那一间的工作区／对话／数据一起拿走了 ⇒ **本机这份缓存也算那一间的数据**
  ///    —— 不丢的话，"拿不回来"在**这台设备上**还留着一份副本（下一任用户、或者
  ///    以后哪次重放，就可能把它画出来 ⇒ 那就是"删了又回来了"）。
  ///
  /// ⚠️ 做法：把命名空间**临时切到那一间**再 `clear()`（两个 store 的 `clear()` 都是
  ///    "清当前那个键"）⇒ 清完**切回现在这一间**。⚠️ **主线那一间不许从这儿丢**
  ///    （删图标这条路永远不该动主线；真按错了也宁可不删）。
  Future<void> dropRoomCache(String scope) async {
    if (scope == mainScope) return;
    final keepLocal = local.namespace;
    final keepDrafts = drafts.namespace;
    final keepCompose = compose.namespace;
    final scoped = scopedCacheNamespace(cacheNamespaceOf(_token), scope);
    local.namespace = scoped;
    drafts.namespace = scoped;
    compose.namespace = scoped;
    try {
      await local.clear();
      await drafts.clear();
    } finally {
      local.namespace = keepLocal;
      drafts.namespace = keepDrafts;
      compose.namespace = keepCompose;
    }
  }

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

  /// **"我的小程序"变了多少次**（乙-3）：`app/installed` 到了就 +1，
  /// 界面看到它变了就重拉一次 `/api/apps`（**桌面自己长出来**）。
  int appsRevision = 0;

  /// ★ **"这个小程序有新版了"**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）。
  ///
  /// 🔴 它和 [`appsRevision`] **是两件事**，不许并成一个：
  ///    · `app/installed` = 桌上**多了一格**（谁都可以重拉清单）；
  ///    · 这一条 = **某一格换了一版** ⇒ 界面要判"**我正开着它吗**"，
  ///      开着才换那一帧（别人的更新不许把这一屏搞乱 —— 判据 U3）。
  ///
  /// ⚠️ 收到的那一帧是**持久**事件（有号、会补发）⇒ 这里的去重按 `(id, 版本)`：
  ///    补发/重连必然重复（协议 R5）。
  int appUpdateRevision = 0;

  /// **最后一条"有新版"**（界面靠 `appUpdateRevision` 认"是不是新的一条"）。
  AppUpdate? lastAppUpdate;

  /// **收到过哪些"有新版"**（app id → 版本号）。
  ///
  /// 🔴 **没开着它的时候只记在这儿**（什么都不动）：下次点开它之前先重拉一次清单，
  ///    免得点开还是旧那一版（判据 U4：不许白屏、不许报错，**如实记一笔**）。
  final Map<String, int> appUpdates = <String, int>{};

  /// ★ **"那一间的内容变了"**（契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）。
  ///
  /// 🔴 与 [`appUpdateRevision`] **是两件事**，不许并成一个：
  ///    · `app/update-available` = "**有某一版新的**"（**持久**、带版本号）；
  ///    · 这一条 = "**他正在改的那一份刚被写过**"（**瞬态**、**没有版本号** ——
  ///      用户端没有"版本"这回事：他自己那一份就是源代码部署）。
  ///    ⇒ 界面**不判版本**，收到就**直接重取一次清单**（新 exp ⇒ 新签 URL ⇒ 换一帧）。
  int appWorkspaceRevision = 0;

  /// **最后一条"那一间的内容变了"**（界面靠 [`appWorkspaceRevision`] 认"是不是新的一条"）。
  AppWorkspaceChange? lastAppWorkspaceChange;

  /// **打字框里那串还没发出去的字**（第三本账 —— 见 `compose_store.dart` 顶上那张表）。
  /// ⚠️ 它**不属于时间线**：一个字都没发出去，所以它不进 `items`、不带四态、没有"重发"。
  final ComposeStore compose;

  /// 现在存着的那份打字草稿（`null` = 没有）。界面拿它画"上面那条草稿"。
  String? composeDraft;

  /// 过程两档存在哪（契约 `docs/dev/122` §三）。**按设备存、按账号不存**。
  final ProcessLevelStore levels;

  /// "自动念"那个开关住哪（设备级偏好，见 `speech_store.dart`）。
  final SpeechStore speech;

  /// 真正去念、真正去停的那两个（注入点见构造函数）。
  final bool Function(String text, {void Function()? onEnd}) _speak;
  final void Function() _stopSpeaking;

  /// 那条流怎么造（注入点见构造函数）。`null` = 生产那一条。
  final NewStream? _newStream;

  /// 真正去开麦、真正去收手的那两个（注入点见构造函数）。
  final Future<String?> Function({
    required Uri url,
    required String token,
    required void Function(Map<String, dynamic>) onEvent,
  })
  _startHear;
  final void Function() _stopHear;

  /// 收进来的**服务端事实**（只留带号的），存缓存就是从这份存。
  ///
  /// ⚠️ 为什么要单独留一份：`Timeline` 里已经是**画出来的条目**了，
  ///    从条目反推事件等于把"缓存"变成"第二次解释"——那就违反"只缓存，不判断"。
  ///
  /// ⚠️ 不 `final`：**删除**要把属于那几个 id 的事实整批换掉
  ///    （`withoutMessages`；纯函数，进 `test/unit`）。
  /// ⚠️ 它现在**按房间分开住**（[`_Room`]）—— 见 [`scope`]。
  List<Map<String, dynamic>> get _facts => _room.facts;
  set _facts(List<Map<String, dynamic>> value) => _room.facts = value;

  /// **现在在哪个房间**（契约 `83-APP-WORKSPACE.md` §五·甲：跟着图标走）。
  ///
  /// * 桌面上没打开任何小程序 ⇒ [mainScope]（主对话）；
  /// * 打开一个"我的小程序" ⇒ **那个 app 的 id**；
  /// * 关掉 / 退回桌面 ⇒ 回 [mainScope]。
  ///
  /// ⚠️ 判定是纯函数（`models/scope.dart` 的 `scopeOfOpenApp`），界面那一层拿
  ///    `_openApp` 喂它。这一层**不猜**"现在开着哪个图标"——它只记住被告诉的那个值。
  String _scope = mainScope;

  // ── ★ **派活那一步**（契约 `docs/dev/108-JOB-ASK-FLOW.md`）────────────
  //
  // 那一帧 `job/ask`（瞬态）到了 ⇒ 屏上出一层确认 ＋ 两个按钮；
  // 他答了（走同一条流发一帧）⇒ 服务端建那一处 ＋ 推 `scope/open` ⇒ 窗口自己切过去。
  // 答【就在这儿做】⇒ 什么都不建，它就在主对话里做完。

  /// 现在等着他答的那一笔（`null` = 没有）。
  JobAsk? _jobAsk;

  /// ★「接着往下」用的那一份**视图**：切过去之后那一屏要先看得见**他那句原话**。
  ///
  /// 🔴 **不许复制事实**（契约 §二 C4 / §一 不许破的第 5 条）：这里装的是
  ///    **主对话那一间内存里那条**（同一份 `UserUtterance`），
  ///    `items` 只是把它**排到那一间前面**——不落盘、不进那一间的缓存、
  ///    也不进 `_facts` ⇒ 盘上永远只有一份（它的家还是主对话那条日志）。
  final Map<String, List<TimelineItem>> _carried = {};

  /// 他刚说的那句（发问话那一刻从**主对话**里取的）——`scope/open` 到的时候带过去。
  UserUtterance? _carryCandidate;

  /// ★ **做完自动给他看**：界面那一层要打开的那一格（取走就清）。
  String? _openAppRequest;

  /// 刚才**发出去等回执**的那一笔（回执只认号相同的那一帧；答完就清）。
  ///
  /// ⚠️ 为什么不能拿 `_jobAsk` 当依据：那层确认一按下去就收了（`_jobAsk = null`），
  ///    于是"任何一帧回执"都会被当成自己的 —— 判据当场抓到过这一次。
  String? _answeredId;

  /// **每一个房间在内存里的那一份**（键 = scope）。
  ///
  /// 🔴 为什么必须**一间留一份**，而不是切过去就把上一间丢掉：
  ///    `83-APP-WORKSPACE.md` 的判据 A4 —— *"主线（`main`）**不受影响**
  ///    （老对话还在、还能说）"*。丢了这一份就等于"切一趟房间，主线的对话没了"，
  ///    而没有网的时候它**再也回不来**（流补不回来、缓存也被下一间覆写过）。
  final Map<String, _Room> _rooms = {};

  _Room get _room => _rooms.putIfAbsent(_scope, () => _Room(_scope));

  /// **现在这条聊天是跟谁说的**（界面用不上它算，但判据要读得到）。
  String get scope => _scope;

  Timeline get timeline => _room.timeline;
  String? _token;
  StreamClient? _stream;
  ConnState _conn = ConnState.idle;
  bool _needsSetup = false;
  String? _lastError;
  int _localSeq = 0;

  /// 现在这一幕给用户看多少过程（契约 §三）。**开档前是默认档 `doing`**。
  ProcessLevel _level = defaultProcessLevel;

  /// **自动念**：打开之后，它**新说的话**会被念出来（默认关）。
  ///
  /// ⚠️ 默认关是有意的：突然出声会吓人，而且"安静"要可预期（契约 §三）。
  bool _autoSpeak = false;

  /// **正在念哪一条**（`null` = 没在念）。界面靠它把按钮变成"别念了"。
  String? _speakingId;

  /// **语音那一步现在什么样**（纯状态机，`models/hearing_session.dart`）。
  ///
  /// ⚠️ 状态住在这儿（不属于某个 widget）：它要跨这一屏活着，
  ///    而且收尾那几个字是**在用户按了结束之后**才回来的。
  Hearing _hearing = const Hearing();


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
  /// 界面上现在这些条目 —— **更早那几页在最前面**（批 C：往上翻加载）。
  ///
  /// ⚠️ 更早那几页**不在** `timeline` 里（它们不进本机缓存，见 `_olderItems`），
  ///    所以这里要把两段拼起来；界面那一层照旧只用这一个口。
  ///
  /// ★ **「接着往下」**（契约 108 §二 C4）：他答【另开一处做】之后切过去，
  ///    那一屏**先看得见他那句原话** —— 它排在**这一间自己那些条目之前**
  ///    （他先说的话，然后才是这一间的活）。⚠️ 它是**视图**（内存里那份），
  ///    盘上不多一个字（见 `_carried` 那段）。
  List<TimelineItem> get items => [...?_carried[_scope], ..._olderItems, ...timeline.items];

  /// ★ 现在等着他答的那一笔（`null` = 没有）—— 界面那一层按它出确认层。
  JobAsk? get pendingJobAsk => _jobAsk;

  /// ★ **做完自动给他看**：界面那一层取一次（取走就清 ⇒ 只自动打开一次）。
  String? takeOpenAppRequest() {
    final id = _openAppRequest;
    _openAppRequest = null;
    return id;
  }

  /// 主对话里**最后那句已经确认的**用户发言；没有 ⇒ `null`（**不编**）。
  ///
  /// ⚠️ 用 `timeline.items`（**那一间自己的**事实），不是 `items`
  ///    （那个已经把"带过去的"也算进去了 —— 拿它当来源会自己吃自己）。
  UserUtterance? _lastConfirmedUtterance() {
    for (final it in timeline.items.reversed) {
      if (it is UserUtterance && it.state == MessageState.confirmed && it.text.trim().isNotEmpty) {
        return it;
      }
    }
    return null;
  }

  /// ★ **他答了那一句问话**（契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 第②/③步）。
  ///
  /// 只发一帧（**同一条流**），然后**等回执**：
  ///   · 收下了 ⇒ 那层确认收掉；要是答的"是"，紧接着那一帧 `scope/open` 会让窗口自己切过去
  ///     （🔴 **这一层不自己切房间**：两个裁判就会切两次）；
  ///   · 没送出去（流没连着 / 号码对不上）⇒ **如实说一句**，绝不假装收下了。
  ///
  /// ⚠️ **不许猜**：`yes` 就是他按下的那一个按钮，这里不做任何"默认选哪个"。
  void answerJobAsk({required bool yes}) {
    final ask = _jobAsk;
    if (ask == null) return;
    final s = _stream;
    final sent = s != null && s.answerJob(ask.id, yes: yes);
    if (!sent) {
      // 那层确认**留着**：他再按一次就有机会送出去（不是"按了没反应"）。
      _lastError = jobAskFailedLine;
      notifyListeners();
      return;
    }
    _jobAsk = null;
    _answeredId = ask.id; // 只等**这一笔**的回执
    // 答【否】⇒ 不会再有 `scope/open` ⇒ 那份"带过去"的也就不该留着。
    if (!yes) _carryCandidate = null;
    notifyListeners();
  }

  /// 界面上那行「它正在做…」；`null` = 什么都不显示。
  ///
  /// ⚠️ 2026-09-26 起**没有"安静档"了**（契约 `docs/dev/122` §一）：
  ///    那一档只掐这一行、掐不住工具行 ⇒ 它做不到它名字说的事，已从菜单砍掉。
  ///    ⇒ 这一层不再按档位掐它：屏幕上什么都没有时，它就是唯一的"它在动"信号。
  String? get agentLine => timeline.agentLine;

  /// 推理档要看的思考原文 —— **挂在它那条气泡上**（`AssistantMessage.reasoning`）。
  ///
  /// ⚠️ 只**不显示**，不删：换出推理档之后它还在内存里，
  ///    换回来还看得见（那是"回头看它当时怎么想的"这条路）。
  ///    真正让它消失的是 `Timeline.reset()`（重放 / 退出登录）。
  ///
  /// ⚠️ 闸必须打在这一层：界面是哑的，而"现在是不是推理档"只有这里有。
  ///    服务端那边也有一道闸（**只有 `reasoning` 档才发推理原文**，D7.4）——
  ///    🔴 那一道**绝不能**挪到客户端来判（那是隐私闸）。
  String reasoningOf(AssistantMessage m) =>
      _level == ProcessLevel.reasoning ? m.reasoning : '';

  /// 屏幕上有没有**过程**可画（决定列表尾巴那一条要不要占位置）。
  ///
  /// ⚠️ **推理原文不算在内**：它挂在气泡上、由 `_render` 那条路画，不在尾巴上。
  /// ⚠️ **步骤流水也不算**：那一档已从菜单砍掉，`step/*` 只剩"老客户端
  ///    `steps` 档"那一条通道（契约 `docs/dev/122` §四）—— 收了也不画。
  bool get hasProcess => agentLine != null;

  // ── ★ `116`：工具行 / 系统提示词 / 每轮用量 / 过程折叠（主人 2026-09-26）──
  //
  // 那一批的事实现在**就住在同一条时间线里**（`TimelineToolCall` /
  // `TimelineSystemPrompt` / `TimelineTurnUsage`，见 `models/timeline.dart`）。
  // 这里只补三个**给界面用的纯查询** —— 判断（折几行、显不显示用量）都留在
  // `models/tool_row.dart` 那两个纯函数里（所以它们进得了 `test/unit`）。

  /// **已经收口到的最高轮号**（`≤` 它的轮才算"做完了"）。
  ///
  /// ⚠️ 折叠要它：**收口之后**那些工具行才折（还在跑时展开着 —— DSH 同一条）。
  int get closedThrough => timeline.closedThrough;

  /// 这一轮里的**工具行**（按时间线顺序）。
  ///
  /// ⚠️ 取的是**画得出来的那些**（`items`：本间 + 翻上来的老页 + 带过来的那句），
  ///    和屏幕上看到的**同一份** —— 从这里另推一份清单就迟早会漂。
  List<TimelineToolCall> toolRowsOfTurn(int turn) => [
    for (final it in items)
      if (it is TimelineToolCall && it.turn == turn) it,
  ];

  /// 这一轮的过程计数（`dshTurnProcessLabel` 就是拿它拼那一行字）。
  ///
  /// ⚠️ **消息数这一档今天恒为 0**（如实说，不是漏了）：
  ///    DSH 那一档数的是"**严格早于最终答案那一步**、且有正文的助手消息"，
  ///    而我们的 `message/start` / `message/end` **不带 `turn`/`step`**
  ///    ⇒ 客户端算不出"哪条消息是哪一步的"。`fold` 收到空 `replySteps` ⇒ messages = 0，
  ///    于是那一行**永远不会出现"N 条消息"**（宁可不显示，也不编一个数）。
  ///    要补上它，得让服务端在 `message/*` 上带 `turn`/`step`（现在没有）。
  TurnProcess processOfTurn(int turn) => TurnProcess.fold(
    rows: [for (final it in toolRowsOfTurn(turn)) it.row],
    turn: turn,
  );

  /// 这一轮**折出来的**用量；`null` = **一个数都不许画**。
  ///
  /// ⚠️ **折**（不是拿一条就画）：`foldTurnUsage` 的规矩是"任何一次尝试没报准 ⇒ 整块不画"；
  ///    服务端今天一轮只发一条（它自己已经折过），但客户端**照同一条规矩再折一遍** ——
  ///    这样"重发 / 多次尝试"那一天的形状不用改界面。
  TurnUsage? turnUsage(int turn) => foldTurnUsage([
    for (final it in items)
      if (it is TimelineTurnUsage && it.turn == turn) it.attempt,
  ]);

  // ── ★ `117`：排队看得见、撤得掉（主人 2026-09-26）────────────────
  //
  // 他在琥珀还在做上一件事的时候又发了一句 —— 服务端**早就**把那一句排队了
  // （`dispatcher.js` 的 `#delivered` 票），可屏幕上**一个字都没有**：
  // 他既看不见自己还排着什么，也撤不掉。
  // 这一节把那本账接到界面上：一条**读**（[queue]）＋ 一条**写**（[unsay]）。

  /// **这一间现在排着什么**（`queue/changed` 那一帧）。
  ///
  /// ⚠️ 它取的是**现在这一间**的那份（一间一份，住在 [`Timeline`] 里）——
  ///    与 `items` / 那条流 / 那句 say **同一个 scope**，不会串到别间去。
  /// ⚠️ **瞬态**：刷新之后靠服务端在 `client/hello` 那一刻现发的那份快照重建
  ///    （队列本身是**进程内**的：进程重启就没了 —— 那是如实的，不是缺陷）。
  ChatQueue get queue => timeline.queue;

  /// ★ **撤掉排队里那一句**（契约 §二 · 客户端→服务端 `{"t":"unsay","messageId":"m_…"}`）。
  ///
  /// 🔴 **不做乐观删除**：这里只发那一帧，屏幕上那一行**等新快照回来**才消失
  ///    —— 因为"到底撤没撤掉"只有服务端知道（那一句可能**已经在跑了**，
  ///    那时服务端什么都不做，而屏幕上把它抹掉就是**说假话**）。
  /// ⚠️ 没连着（流断了）⇒ 发不出去 ⇒ 那一行**留着**（他再按一次就行）；
  ///    这里**不新造一句话**（"没撤掉"这件事由那一行还在屏幕上如实说）。
  /// @returns 那一帧发出去了没有（界面对它**不做**任何乐观处理，只做诊断/判据）。
  bool unsay(String messageId) {
    final s = _stream;
    return s != null && s.unsay(messageId);
  }

  /// **现在这一份计划**（harness 自己的目标 / 任务清单）—— 没有就 `null`。
  ///
  /// ⚠️ 取的是**最后一条** `plan/updated`：它是**整表快照**（last-write-wins），
  ///    而且新的一轮开始时服务端会发一条"清空"的 ⇒ 倒着找第一条就是现在这份。
  ///    ⚠️ 冷启动也从 `_facts` 里拿（本机缓存带号事件）——刷新一下计划条不该变空。
  /// ⚠️ 解不出来（认不出形状 / 空的那份）⇒ `null` ⇒ 界面**一个像素都不画**。
  // ── 往前翻：更早那几页**只用来显示**（批 C · `64-CHAT-REDESIGN.md` §三）────────
  //
  // ⚠️ **为什么不塞进 `_facts`**：那一份是"本机只留一屏"的缓存（`17-LOCAL-FIRST.md`），
  //    它的裁剪会把这些**刚从服务端取回来的**老消息又丢掉（于是下次还得再取一遍，
  //    而且用户会看到"我刚翻上去的那几条又没了"）。⇒ 分开：`_facts` = 落盘的，
  //    `_olderItems` = 现在屏幕上多出来的那几页。
  //
  // ⚠️ 和 `_facts` 一样，它**按房间分开住**（[`_Room`]）：A 房间翻上去的那几页
  //    不许出现在 B 房间（那是**别人的老话**）。
  List<TimelineItem> get _olderItems => _room.olderItems;
  Set<int> get _olderSeqs => _room.olderSeqs;
  bool get _olderLoading => _room.olderLoading;
  set _olderLoading(bool value) => _room.olderLoading = value;
  bool get _olderDone => _room.olderDone;
  set _olderDone(bool value) => _room.olderDone = value;
  bool get _olderFailed => _room.olderFailed;
  set _olderFailed(bool value) => _room.olderFailed = value;
  int get _olderPages => _room.olderPages;
  set _olderPages(int value) => _room.olderPages = value;

  /// 一页取多少条 / 本机最多留几页（**住代码里**：阈值不进文档）。
  static const int olderPageSize = 50;
  static const int olderMaxPages = 10;

  bool get olderLoading => _olderLoading;

  /// 到头了（服务端说没有更早的，或者本机留的页数到顶了）。
  bool get olderExhausted => _olderDone;

  /// **手上这一窗最老那一号**（含往上翻上来的那几页）；一条都没有 ⇒ `null`。
  ///
  /// ★ `118` 的轨迹那一屏要它：这一号是 `1` ⇒ **这条会话最早那一件事就在手上**
  ///   ⇒ 才敢说"到最早那一条了"（见 `ChatScreen` 的 `_historyComplete`）。
  /// ⚠️ **它不是"服务端还有没有更早的"**：那是 `olderExhausted`
  ///   （而且它只在真的翻过一次之后才有意义 —— 见 `_applyAutoFold` 那段）。
  int? get oldestLoadedSeq => _oldestKnownSeq();

  /// 刚才**没问上**（跟"真到头了"是两件事，界面上要分开说）。
  bool get olderFailed => _olderFailed;

  /// 本机留的页数到顶了（不是服务端没有，是我们不再留了）——**如实说**。
  bool get olderCapped => _olderDone && _olderPages >= olderMaxPages;

  /// 往前取一页更早的。**幂等/防重入**：正在取、已经到头 ⇒ 直接返回。
  ///
  /// ⚠️ **它钉住"从哪一间翻"**（进来的那一刻那一间）：翻页要等网络，而用户
  ///    完全可能在这一问还没回来时切了房间 —— 那几帧属于**原来那一间**，
  ///    落进新房间就是把别人的老话接进来。⇒ 全部状态读写的都是那个 [`_Room`]。
  Future<void> loadOlder() async {
    final room = _room;
    if (room.olderLoading || room.olderDone) return;
    final before = _oldestKnownSeq();
    if (before == null || before <= 1) {
      room.olderDone = true;
      notifyListeners();
      return;
    }
    room.olderLoading = true;
    room.olderFailed = false;
    notifyListeners();
    final page = await api.older(
      token: token ?? '',
      before: before,
      limit: olderPageSize,
      // ★ **哪一间的老消息**（契约 `83` §六·4）——和那条流、那句 say 同一个 scope
      scope: room.scope,
    );
    room.olderLoading = false;
    if (!page.ok) {
      // ⚠️ 没问到 ⇒ **不说"到头了"**（那会把"网络不好"说成"没有更早的了"）
      room.olderFailed = true;
      notifyListeners();
      return;
    }
    // ★ 用**同一套**时间线规则把它变成条目（去重、分组、墓碑、隐藏都照旧）——
    //   在别处再写一套 = 两处口径，迟早会漂。
    final tmp = Timeline();
    for (final e in page.frames) {
      tmp.apply(e);
    }
    final fresh = <TimelineItem>[];
    for (final it in tmp.items) {
      if (room.olderSeqs.add(it.seq)) fresh.add(it);
    }
    room.olderItems.insertAll(0, fresh);
    room.olderPages += 1;
    if (!page.hasMore || room.olderPages >= olderMaxPages) room.olderDone = true;
    notifyListeners();
  }

  /// 我手上**最老那一号**（往前走就从它开始）。
  int? _oldestKnownSeq() {
    final a = timeline.oldestSeq;
    final b = _olderSeqs.isEmpty ? null : _olderSeqs.reduce((x, y) => x < y ? x : y);
    if (a == null) return b;
    if (b == null) return a;
    return a < b ? a : b;
  }

  void _clearOlder() {
    _olderItems.clear();
    _olderSeqs.clear();
    _olderPages = 0;
    _olderDone = false;
    _olderFailed = false;
    _olderLoading = false;
  }

  Plan? get plan {
    for (var i = _facts.length - 1; i >= 0; i -= 1) {
      final e = _facts[i];
      if (e['type'] != 'plan/updated') continue;
      return Plan.fromEvent(e); // 空的那份 ⇒ null（不再往后找：清空就是清空）
    }
    return null;
  }

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
    //   它决定那一屏上推理原文要不要画（`doing` 档不画）。
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

  /// **换房间**（契约 `83-APP-WORKSPACE.md` §五·甲：跟着图标走；
  /// C 期按 `84-DISPATCHER-FOCUS.md` §三·3 **收回了"按房间重连"**）。
  ///
  /// 界面那一层在"打开某个小程序 / 关掉退回桌面"时叫它，参数是纯函数
  /// `scopeOfOpenApp(...)` 算出来的那个房间名。
  ///
  /// 三件事，一件都不能少：
  ///   ① **上一间原地留着**（[`_rooms`] 就是它的家）—— 主线那一屏、翻上去的那几页、
  ///      打字框里那半句全都不动。切回来时它们还在（判据 A4）。
  ///   ② **本机那一屏先画出来**（新房间没来过 ⇒ 读它的缓存；S5c：先本机、再网络），
  ///      然后 `notifyListeners()` —— 屏幕立刻换成新房间的，不留一段白屏。
  ///   ③ **把焦点告诉服务端**（[StreamClient.focus]）——**不重连**。
  ///      带上**这一间自己的游标** ⇒ 服务端把这一间缺的那一段按**视图**补发过来
  ///      （这就是"历史按 `?scope=` 视图重载"：一条日志上的那层视图，不是另一份日志）。
  ///
  /// 🔴 **为什么不再重连**：手册 §四 核心原则 3 —— *"一个 WS 连接是物理约束，
  ///    不能每个会话一条连接"*。按房间重连会为每个图标各开一条连接，
  ///    而且切一趟就断一次（`84 §八` 把那种形状列为**明确不做**）。
  /// ⚠️ 换房间**不许**动 `level`（一个管"说多少过程"、一个管"哪一间"），
  ///    也不许把房间存到盘上（刷新之后回到桌面那条主对话才是对的：
  ///    房间是"我现在开着哪个图标"的影子，图标不在就回主线）。
  Future<void> setScope(String scope) async {
    final want = scope.trim().isEmpty ? mainScope : scope;
    if (want == _scope) return;
    // ② 先切过去（缓存命名空间跟着走），把那一间读出来再让屏幕换
    _scope = want;
    _bindNamespace(_token);
    // ⚠️ "上一次交给磁盘的那份"不作数了（换了一间 = 换了一个键，
    //    不重置的话新房间的重算结果会和旧房间那份"看起来一样"而被跳过）。
    _draftsHandedOff = null;
    final room = _room;
    if (!room.restored) await _restoreLocal();
    // ① 屏幕先换成这一间 —— 网络那一步在下面，不许挡在它前面
    notifyListeners();
    // ③ ★ **焦点是一帧，不是一条连接**（C 期）：连着的流照旧连着，
    //    只把"我在看哪一间"告诉服务端；顺带把这一间的游标给它（补发那一段）。
    //    ⚠️ **没在跑就不"顺手开一条"**（和 `setLevel` 同一条规矩）：真实路径上
    //      `start()` 之后它一定在跑；而"没跑"的场合（还没登录完 / 判据里
    //      `openStream:false`）凭空开一条会去连一个不该连的地址。
    //      ⚠️ `focus()` 在没连着时也记账（新焦点 + 新游标），重连那一下会用上它。
    final s = _stream;
    if (s != null) {
      // ★ 切焦点之后，那一间的历史是**补发**过来的（服务端按它那层视图给）——
      //   在收到那条确认帧之前收到的都算**历史**：不许为它弹浮窗，更不许念出来。
      //   （不给这一句的话，头一回进一间有历史的房间，冷启动那批通知会一条条往外弹
      //     —— 那既是骚扰也是假话："刚才"其实不是刚才。旧形状靠"每次新连接都从
      //     在读历史开始"挡住了它，现在连接不再新建，这个界就得显式划。）
      //   ⚠️ 没连着时也置位：重连那一路会发 `client/hello`（⇒ `__caught_up__`）把它放下来。
      _readingHistory = true;
      s.focus(want, sinceSeq: room.timeline.lastSeq);
    }
    notifyListeners();
  }

  /// **自动念开着吗**。
  bool get autoSpeak => _autoSpeak;

  /// **正在念哪一条**（`null` = 没在念）。
  String? get speakingId => _speakingId;

  /// 开机时读一次这个偏好（设备级；读不出来当关 —— 见 `speech_store.dart`）。
  Future<void> loadAutoSpeak() async {
    _autoSpeak = await speech.read();
    notifyListeners();
  }

  /// 开关自动念。
  ///
  /// ⚠️ **关掉的时候要立刻停下正在念的那一段**：不然用户关了它还听见声音，
  ///    那就是"按钮说关、它还在念"（这一族的毛病这个项目栽过好几次）。
  Future<void> setAutoSpeak(bool on) async {
    if (on == _autoSpeak) return;
    _autoSpeak = on;
    await speech.write(on);
    if (!on) stopSpeakingNow();
    notifyListeners();
  }

  /// **念这一条**（用户点了"读一遍"）。
  ///
  /// ⚠️ 一次只念一段：真的"停下上一段"由 `speech.dart` 那一层做（它 `speak()` 里先 `cancel()`）；
  ///    这里先把状态摘掉，免得**上一段的回调**把这一条的状态清掉。
  void speakMessage(String messageId, String text) {
    _speakingId = null;
    final started = _speak(text, onEnd: () {
      // ⚠️ 只有"还是这一条在念"的时候才复位（用户可能已经点了别的一段）
      if (_speakingId != messageId) return;
      _speakingId = null;
      notifyListeners();
    });
    _speakingId = started ? messageId : null;
    notifyListeners();
  }

  /// **别念了**（用户点了同一个按钮的第二下，或者关了开关）。
  void stopSpeakingNow() {
    _stopSpeaking();
    if (_speakingId == null) return;
    _speakingId = null;
    notifyListeners();
  }

  /// **语音那一步现在什么样**（界面照它画）。
  Hearing get hearing => _hearing;

  /// 这台设备/这个页面**开得了麦吗**（`services/hearing.dart`）。
  /// ⚠️ 假 ⇒ 界面**不画那个话筒**（开不了就别摆在那儿）。
  bool get canHear => hearing_service.canHear;

  /// **按了一下那个按钮**（开始 / 结束都由当前状态决定 —— 主人 2026-09-23：
  /// *"是按一下开始语音跟踪…再按一下结束"*）。
  ///
  /// ⚠️ 三条：
  ///  ① **按下去立刻有反馈**（先变成"正在听"，再去开麦）—— 开麦要弹权限框，
  ///     那一小会儿界面上不能什么都不动；
  ///  ② 开麦那一步失败 ⇒ **如实说**（权限 / 没配钥匙 / 开不了），
  ///     绝不用假的字糊过去（这一版把原来那个"演示"砍了）；
  ///  ③ 结束那一下**只关麦**：最后那几个字是在我们说"结束"之后才回来的，
  ///     所以状态先停在"听着"，等对面说 `asr/end` 才真的停（见 [Hearing.event]）。
  Future<void> toggleHearing() async {
    if (_hearing.listening) {
      _stopHear();
      _hearing = _hearing.tapped();
      notifyListeners();
      return;
    }
    // 收尾中（按了停、还在等最后一句）：按了不算 —— 界面上那颗按钮这期间也不画
    if (_hearing.phase == HearingPhase.finishing) return;
    final t = _token;
    if (t == null) {
      _hearing = _hearing.broke('failed');
      notifyListeners();
      return;
    }
    _hearing = _hearing.tapped();
    notifyListeners();
    final why = await _startHear(
      // ⚠️ 地址由 `stream_uri.dart` 那一个函数算（同源看页面协议）——
      //    语音这条**不许再拼一遍**（那条事故的第二个入口）。
      url: asrUri(base: '', page: Uri.base),
      token: t,
      onEvent: _onHearingEvent,
    );
    if (why != null) {
      _hearing = _hearing.broke(why);
      notifyListeners();
    }
  }

  /// 语音那条回来的事件（**唯一入口** —— 和 `ingest()` 一个道理：
  /// 状态只在一个地方被改，判据才打得准）。
  void _onHearingEvent(Map<String, dynamic> e) {
    _hearing = _hearing.event(e);
    // ⚠️ 半句也要刷（"实时转文字"就是靠它）；事件很稀（一句一两个），不是热路径
    notifyListeners();
  }

  /// 时间线里那一条助手的话（自动念要它的原文）。
  ///
  /// ⚠️ 找不到就返回空串 ⇒ **不念**（绝不念一个猜出来的东西）。
  String textOfMessage(String messageId) {
    for (final it in timeline.items) {
      if (it is AssistantMessage && it.messageId == messageId) return it.displayText;
    }
    return '';
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
  ///
  /// ⚠️ 它读的是**现在这一间**的缓存（命名空间由 [`_bindNamespace`] 绑好）。
  ///    进来先把这一间标成 `restored`（防重入：同一间不许读两遍 ——
  ///    读两遍 = 把已经在内存里的那一屏又 `seedFromCache` 一次，画两遍）。
  ///    ⚠️ **没读成就把标记退回去**：房间在这两个 `await` 之间被换掉时，
  ///    这一份属于原来那一间、一个字都不许落进新房间 ——
  ///    而原来那一间也**没真读成**，下次切回去必须重新读一遍。
  Future<void> _restoreLocal() async {
    final room = _room;
    room.restored = true;
    final events = await local.load();
    // ⚠️ 读完这一句之后**房间可能已经换了**（`local.load()` 是异步的）——
    //    那一份就属于原来那一间，一个字都不许落进新房间。
    if (!identical(room, _room)) {
      room.restored = false; // 没读成 ⇒ 下次切回那一间要重新读
      return;
    }
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
  ///
  /// ⚠️ **每一间各读各的**（命名空间按房间分，理由见 [`_bindNamespace`]）：
  ///    不分开的话，在 A 间打了一半的话会出现在 B 间的时间线上（那是假话）。
  /// ⚠️ 两个 `await` 之间**房间可能已经换了** ⇒ 每一步都要回头看还是不是原来那一间。
  Future<void> _restoreDrafts() async {
    final room = _room;
    // ★ 打字框里那份草稿（第三本账）：**只读进内存**，不往时间线上放
    //   （它一个字都没发出去 —— 放上去就是"画一条假历史"）。
    final draft = await compose.load();
    if (!identical(room, _room)) return;
    composeDraft = draft;

    final saved = await drafts.load();
    if (!identical(room, _room)) return;
    for (final d in saved) {
      room.timeline.addLocalUtterance(d.text, d.messageId);
      // 回到它原来的态（`sent` 读回来是 `failed`，理由见 [storableState]）
      room.timeline.setLocalState(d.messageId, d.state);
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
    // 🔴 **所有房间一起丢，而且回到主线**（契约 `83` §五·甲）：下一个人进来看到的
    //    必须是**桌面上那条主对话** —— 上一位开着的那个小程序那一间一个人都不许剩下
    //    （`38-ISOLATION-SPLIT.md` §8.2 那条"共用设备"的规矩，只是这回分的是房间）。
    _rooms.clear();
    _scope = mainScope;
    _bindNamespace(_token);
    // ⚠️ 缓存跟着账号走：这台机器换了个人登录，**不许再看见上一个人的一屏**，
    //    也**不许看见上一个人打了一半的话**（欠账 18）
    _invalidateLocal();
    timeline.reset();
    _clearOlder(); // ★ 更早那几页跟着时间线一起清（同一个世界的）
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
    // ★ **一条连接服务所有房间**（C 期 · 契约 84 §三·3）：开它的时候那一间只是
    //   **初始焦点**（构造参数走 `?scope=`）；之后切房间靠 `focus()` 那一帧。
    final s =
        _newStream?.call(
          base: '',
          token: t,
          level: _level,
          scope: _scope,
        ) ??
        StreamClient(base: '', token: t, api: api, level: _level, scope: _scope);
    s.states.listen((st) {
      // ⚠️ 连接状态是**连接级**的（不再属于某间房）⇒ 不再按房间丢。
      _conn = st;
      if (st == ConnState.unauthorized) {
        // ⚠️ 只有这一种情况才清令牌。**网络失败不清**（B1 的修法）
        _lastError = '登录过期了，重新登录一下';
      }
      notifyListeners();
    });
    s.events.listen((e) {
      final type = e['type'];
      // 内部信号（`stream.dart` 造的，不属于任何一间）
      if (type == '__caught_up__' || type == '__reset__' || type == '__focus_ready__') {
        ingest(e);
        return;
      }
      // ★ **焦点路由在这一侧也要钉一道**（判据 F3 的客户端那一半）：
      //   一条连接现在服务所有房间，切焦点时**上一间可能在补发**、
      //   用户还可能手快连点两个图标 —— 不属于**现在这一间**的帧不许落进来
      //   （落进来就是"甲房的话出现在乙房的屏幕上"）。
      if (!eventInScope(e, _scope)) return;
      ingest(e);
    });
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
    if (event['type'] == '__focus_ready__') {
      // ★ **切焦点那一间的历史发完了**（信号来自 `stream.dart` 收到的 `client/focus`，
      //   服务端保证"补发在前、这一帧在后"）—— 从这一刻起收到的才算"现在发生的"。
      //   ⚠️ 和 `__caught_up__` 是**两件事**：那条管"这条连接的头一屏"，
      //      这条管"每一次切焦点"（连接不再新建 ⇒ 那个界也得每一次重划）。
      _readingHistory = false;
      return;
    }
    if (event['type'] == '__reset__') {
      // 服务端说"你的号跑到我前面了"⇒ 本地那条时间线不作数了。
      // 不是"没有新东西"——是"从头来"。
      timeline.reset();
    _clearOlder(); // ★ 更早那几页跟着时间线一起清（同一个世界的）
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
      // ★ P0-4（2026-09-24）：原来这里把「服务器」写上了屏幕 —— 内部词不许上屏
      _lastError = '这边对不上了，正在重新同步';
      notifyListeners();
      return;
    }
    // ★ **装上了一个小程序**（乙-3）：不去动时间线，只**举手** ——
    //   界面收到就重拉一次清单，桌面**自己长出来**（不用刷新页面）。
    //   ⚠️ 它是**瞬时事件**（服务端那边 `emitTransient`）：不占号、不写盘，
    //     所以它不会混进历史里被重放（重放会让桌面莫名其妙地闪一下）。
    if (event['type'] == 'app/installed') {
      appsRevision += 1;
      notifyListeners();
      return;
    }

    // ★ **那一间的内容变了**（契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）：
    //   他（或者助手在**那个目录里**干活）刚改过那一间 ⇒ 正开着它的那个界面
    //   **自己重取一次**（新 exp ⇒ 新签 URL ⇒ 换一帧）。
    //
    //   ⚠️ **瞬态**（服务端 `emitTransient`：不占号、不写盘、重连**不重放**）
    //      ⇒ 与上面 `app/installed` 同族：这里 `return`，**不许喂给 `timeline`**
    //      （喂了会在历史里留下一条谁也看不见的东西，重放时还会再换一次帧）。
    //   ⚠️ 它**不带版本号**（用户端没有"版本"这回事）⇒ 界面**不判版本**，收到就重取。
    //      它只推给"正开着这一间"的那条连接（服务端按焦点路由）。
    if (event['type'] == 'app/workspace-changed') {
      final change = AppWorkspaceChange.of(event);
      if (change != null) {
        lastAppWorkspaceChange = change;
        appWorkspaceRevision += 1;
        notifyListeners();
      }
      return;
    }

    // ★ **这个小程序有新版了**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）：
    //   正开着它的那个界面要**自己换上**（主人 2026-09-26：*"不需要刷新"*）。
    //
    //   ⚠️ 与上面那条相反，这一帧是**持久**的（服务端 `Timeline.emit`：有号、落盘）⇒
    //      **这里不许 `return`** —— 它必须继续走到 `timeline.apply`，
    //      否则游标停在这一号上，每次重连都从这一号重放一遍。
    //      （它本身画不出任何东西：`models/timeline.dart` 对认不出的类型安静忽略。）
    //   ⚠️ **去重按 `(id, 版本)`**：补发那条路会把它再送一遍（协议 R5），
    //      不挡的话界面会白重拉一次清单。
    final update = AppUpdate.of(event);
    if (update != null && appUpdates[update.id] != update.version) {
      appUpdates[update.id] = update.version;
      lastAppUpdate = update;
      appUpdateRevision += 1;
    }

    // ★ **"这件事搬到新的一处去了"**（契约 `docs/dev/102` 追加的 ⑤，主人定案"甲·变"）：
    //   在主对话里派出去一件活 ⇒ 服务端另开一处 ⇒ 屏幕**自己跟过去**
    //   （不用用户再手点一下那个图标 —— 主人报的正是"窗口没进该去的那一处"）。
    //
    //   ⚠️ 三条边界，每条都有理由：
    //     ① **它是瞬态**（服务端 `emitTransient`：不占号、不写盘、不重放）
    //        ⇒ 这里 `return`，**不许喂给 `timeline`**（喂了就会在历史里留下
    //        一条谁也看不见的东西，重放时还会再切一次房间）；
    //     ② **字段是 `scope` 不是 `scopeId`**：`scopeId` 是"这条帧属于哪一间"，
    //        而这一帧是**发给主线那条连接的**（`eventInScope` 会按 `scopeId`
    //        路由，带上就被主线自己丢掉）；
    //     ③ **已经在那一间就不动**（`setScope` 自己也会挡，这里挡一次是免得
    //        白跑一趟磁盘）。
    if (event['type'] == 'scope/open') {
      final to = event['scope'];
      if (to is String && to.isNotEmpty) {
        // ★ **「接着往下」**（契约 108 §二 C4）：切过去之前，把**发起那一间**
        //   刚说的那句"按视图带过去"（只放内存，见 `_carried` 那段）。
        //   ⚠️ **他答了【另开一处做】才会有这一帧**（答【否】没有这一帧，
        //      那一句就留在主对话里不动 —— 那本来就是对的）。
        final carried = _carryCandidate;
        if (carried != null) {
          _carryCandidate = null;
          _carried.putIfAbsent(to, () => <TimelineItem>[]).add(carried);
        }
        if (to != _scope) unawaited(setScope(to));
      }
      return;
    }

    // ★ **契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 第①步**：他接下一件新东西时，
    //   服务端**先问一句** ⇒ 屏上出一层确认 ＋ 两个按钮。
    //   ⚠️ 它是**瞬态**（不占号、不落盘）⇒ 这里 `return`，**不许喂给 `timeline`**
    //      （喂了就是"屏幕上多出一条谁也看不见的东西"，重放时还会再问一遍）。
    final ask = jobAskOf(event);
    if (ask != null) {
      // ★ 「接着往下」那一份要**在发问话的这一刻**从主对话里取（他刚说完那句）。
      _carryCandidate = _lastConfirmedUtterance();
      _jobAsk = ask;
      notifyListeners();
      return;
    }

    // ★ **那一笔作废了**（超时 / 不答 ⇒ 不许猜）：把那层确认收掉 ＋ 如实说一句。
    //   🔴 只认**号相同**的那一帧（作废的是那一笔，不是"所有的问话"）。
    final mine = _jobAsk;
    if (mine != null && jobAskExpiredOf(event, mine.id) != null) {
      final text = event['text'];
      _jobAsk = null;
      _carryCandidate = null;
      _lastError = text is String && text.trim().isNotEmpty ? text.trim() : jobAskExpiredFallback;
      notifyListeners();
      return;
    }

    // ★ **答话的回执**（收下了没有）—— `ok:false` 时那句人话**照抄服务端给的**
    //   （与反问那条路同一条规矩：那句人话到得了状态条，绝不静默）。
    final ack = jobAnswerAckOf(event);
    if (ack != null) {
      if (ack.id != _answeredId) return; // 别的号的回执：不是这一笔的事
      _answeredId = null;
      if (!ack.ok) {
        _jobAsk = null;
        _carryCandidate = null;
        _lastError = ack.text ?? jobAskFailedLine;
      }
      notifyListeners();
      return;
    }

    // ★ **做完自动给他看**（契约 §一 第④步 · 判据 C5/C6）：
    //   🔴 **只有他正开着那一间**才认这一帧（服务端也只推给那一间的那条连接，
    //      这里再挡一道：帧不是属于**现在这一间**的就丢掉 ⇒ 结构上抢不了屏）。
    //   ⚠️ **不落盘、不进时间线**：那句总结的家只有主进程那条 `job/report`
    //      （一条事实一个家）⇒ 这里只在浮窗里"旁边留一句"。
    final open = jobOpenOf(event);
    if (open != null && eventInScope(event, _scope)) {
      _openAppRequest = open.app;
      if (open.text.isNotEmpty) {
        _showNotice(Notice(kind: NoticeKind.unknown, text: open.text));
      }
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
        shouldPopNotice(
          catchUp: event['catchUp'] == true,
          readingHistory: _readingHistory,
        )) {
      // ⚠️ **浮窗里的撤销与时间线里那条是同一件事**（约束 3）⇒
      //    两处都渲染 `notice.undo`，都由 `undoNotice()` 走同一条路。
      _showNotice(Notice.fromEvent(event));
    }
    timeline.apply(event);

    // ★ **自动念**（主人 2026-09-23 定案）：开着开关时，它**新说的话**念出来。
    //
    // ⚠️ 三条边界，每条都有判据：
    //   · **不念首屏那段历史**（`_readingHistory`）—— 一登录就把它以前说过的话全念一遍，
    //     那是骚扰，而且用户根本没在等这一句；
    //   · **只念说完了的**（`reason == 'completed'`）—— 半句 /"没说完"/"卡住了"不念
    //     （那几句是给眼睛看的交代，念出来会让人以为事情做完了）；
    //   · **空的不念**（`speakAloud` 自己也会挡一层）。
    if (_autoSpeak && !_readingHistory && event['type'] == 'message/end' && event['reason'] == 'completed') {
      final id = event['messageId'];
      if (id is String) {
        final text = textOfMessage(id);
        if (text.trim().isNotEmpty) speakMessage(id, text);
      }
    }

    // ★ **删掉 / 恢复 / 真删**（契约 §8.1、§8.3）：模型那一层已经把条目
    //   藏起来 / 取消藏 / 丢掉了；这里补的是**本机那两份**（契约 §四 🔴）：
    //   缓存里那一屏 + 属于这一轮的草稿。
    //
    //   ⚠️ 为什么非清不可：不清的话，下一次开机本机缓存会**先把那一屏画出来**
    //      ——屏幕上又出现"已经删掉的话"，而服务端那边它已经没了。那就是说假话。
    //   ⚠️ 墓碑事件**自己不许清**：它是"谁被删过"的唯一凭据，
    //      冷启动要靠它把藏起来这件事重新立起来。
    final forgets =
        event['type'] == 'turn/deleted' || event['type'] == 'turn/purged';
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
      _lastError = r is TrashUnauthorized
          ? trashUnauthorizedLine
          : trashRestoreFailedLine;
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
    // ★ **派活那一步那一份也一起清**（契约 108）：待答的那一笔、以及
    //   "带过去的那句原话"都是**上一位的**（共用设备那条规矩，`38` §8.2）。
    _jobAsk = null;
    _carryCandidate = null;
    _openAppRequest = null;
    _carried.clear();
    // ★ **更早那几页也一起清**（批 C）：它们是"上一个世界"的老消息，
    //   留着的话下一个用这台机器的人会看到别人的历史（`38` §8.2 同一类病）。
    _clearOlder();
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
  ///
  /// ⚠️ **它带着当前房间一起走**（契约 `83` §五·甲）：这一句发给**现在这一间**，
  ///    而且从按下那一刻起就钉住 —— 请求在路上时用户切了房间，
  ///    这一句也不许改投到另一间（"我在 A 间说的话跑进 B 间"是最坏那种串号）。
  Future<void> send(String text) async {
    final t = _token;
    if (t == null || text.trim().isEmpty) return;
    final room = _room;

    _localSeq += 1;
    final messageId = 'u_${DateTime.now().millisecondsSinceEpoch}_$_localSeq';
    room.timeline.addLocalUtterance(text, messageId);
    _lastError = null;
    // ⚠️ **在发出去之前先落存档**（欠账 18）：用户按下发送之后马上切出去、
    //    或者这一次请求就挂在网上，那这句话也必须还在。
    _saveDrafts();
    notifyListeners();

    await _deliver(room, messageId, text, t);
  }

  /// 重发。**必须用同一个 messageId**——否则服务端会当成新的一句，
  /// 于是 agent 干两遍（评审 E2）。
  Future<void> resend(String messageId) async {
    final t = _token;
    if (t == null) return;
    final text = _textOf(messageId);
    if (text == null) return;
    final room = _room;
    room.timeline.retry(messageId);
    _saveDrafts(); // 态变了 ⇒ 存档跟着变（重发中也是 `queued`，刷新后仍可重发）
    notifyListeners();
    await _deliver(room, messageId, text, t);
  }

  Future<void> _deliver(_Room room, String messageId, String text, String token) async {
    final outcome = await api.say(
      messageId: messageId,
      text: text,
      token: token,
      clientAt: DateTime.now().millisecondsSinceEpoch,
      // ★ **说给哪一间**（契约 `83` §六·4）：和那条流、那一问老消息是同一个 scope
      scope: room.scope,
    );

    switch (outcome) {
      case SayOk():
        // 走到 `sent`。真正的 `confirmed` 要等 WS 上那句回声——
        // **不能拿 HTTP 200 冒充"服务端收到了我这句"**：
        // 那只能说"请求到过"，不能说"我看见了"。
        room.timeline.setLocalState(messageId, MessageState.sent);
      case SayUnauthorized():
        room.timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '登录过期了，重新登录一下';
        // 令牌确实失效了（服务端明说 401）⇒ 这才清
        await tokens.clear();
        _token = null;
      case SayNotSetup():
        room.timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '这台机器还没设密码';
      case SayLocked(:final retryAfterSec):
        room.timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '试得太频繁，${(retryAfterSec / 60).ceil()} 分钟后再试';
      case SayBusy():
        // 服务端**明说这一句没收下**（它满了，不是网的事、也不是令牌的事）
        // ⇒ 落 `failed`：屏幕上就是「没发出去」+「重发」，
        //   **用户可以就地重来**——那正是 N11 要的"可重试"。
        //
        // 🔴 **`117`：它和"排队"是两件事，别混。**
        //    · 这一档是**内存准入闸**（`admission.js` / `08-SPEC.md` §9.1）：
        //      这一句**根本没被收下**（`say.say()` 都没调）⇒ 屏幕上「没发出去」；
        //    · "排队"是这一句**已经收下了、落盘了**，只是还没轮到它变成一轮
        //      （`dispatcher.js` 的 `#delivered` 票）⇒ 屏幕上那条 `QueueStrip`。
        //    ⇒ 这一档**进不了队列**，也**不该**被画成"排队中"（那是两句不同的话）。
        room.timeline.setLocalState(messageId, MessageState.failed);
        // 顶部状态条要说出**为什么**（N11：拒绝必须给人话，不是静默）。
        // ⚠️ 用词两条线：① 不许有内部词（`forbidden_words.dart` 那道闸守着）；
        //    ② **不许说成"网断了"**——网是通的，那是另一回事，说错了就是把排查带偏。
        //    阈值/占用比**只说在服务端**，这里一个字都不提。
        _lastError = '它现在忙不过来，过一会儿再发一次';
      case SayRejected(:final message):
        room.timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '没收下：$message';
      case SayAsk(:final question):
        // ★ **C 期：第 16 条的反问**（契约 84 §三·3）：服务端不确定这一句该送到哪一间
        //   ——既不按焦点送、也不按提示送，先问一句。
        //   它**一个字都没落盘**（所以这一句还算"没被收下"）：落到 `failed`，
        //   屏幕上就是「没发出去」+「重发」，**一个字都不丢**（N11）。
        //   ⚠️ 那句问话**原样**用服务端给的（客户端不许自己拼一句：两处口径会漂）。
        room.timeline.setLocalState(messageId, MessageState.failed);
        _lastError = question;
      case SayNetworkError():
        room.timeline.setLocalState(messageId, MessageState.failed);
        _lastError = '网没通，这条没发出去';
    }
    // ⚠️ 上面每一条分支都改了那条的态（`sent` 或 `failed`）⇒ 存档要跟着走。
    //    `sent` 存进去时会被降成 `failed`（理由见 `draft_store.storableState`）：
    //    刷新之后回执不会再来，屏幕上必须有「重发」那条路，不能停在"已送到"。
    //    ⚠️ 存档只存**现在这一间**的（切走了的话，被改的那间由 WS 上那句回声兜住：
    //       它一到就把那条推成 `confirmed`，而 `confirmed` 本来就不进存档）。
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
  Future<void> _forgetTurn(
    List<String> messageIds, {
    bool purge = false,
  }) async {
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
    // ⚠️ 离开这一屏就**别再念了**（用户走了、声音还在说话 = 这一族最讨嫌的形状）
    _stopSpeaking();
    // 🔴 离开这一屏也**必须关麦**：麦克风开着而人已经走了，是这一族里最严重的一种
    //    （浏览器上那个录制标记会一直亮着）。
    _stopHear();
    _stream?.dispose();
    _stream = null;
    super.dispose();
  }
}

/// **一个房间在内存里的全部状态**（契约 `83-APP-WORKSPACE.md` §五·甲）。
///
/// 一个 scope（`main` / 某个小程序的 id）一份：时间线、收进来的服务端事实、
/// 往上翻回来的那几页。⚠️ **一间一份**不是优化，是**判据 A4** ——
/// "切一趟房间，主线那一边的对话还在、还能说"。
///
/// ⚠️ 它是 `services/` 里的私有形状（不 import 任何东西）：[`ChatController`]
///    是唯一碰它的地方。
class _Room {
  _Room(this.scope);

  /// 这一间的名字（= `/api/say`、那条流、`/api/timeline` 上带的那个 `scope`）。
  final String scope;

  /// 画出来的那些条目（和从前那个全局的 `Timeline` 是同一个类，同一套规则）。
  final Timeline timeline = Timeline();

  /// 收进来的服务端事实（带号的才进得来）。存缓存就是从这一份存。
  List<Map<String, dynamic>> facts = [];

  /// 往上翻回来的那几页（**不进本机缓存**，见 `_olderItems` 那一段的理由）。
  final List<TimelineItem> olderItems = [];
  final Set<int> olderSeqs = {};
  bool olderLoading = false;
  bool olderDone = false;
  bool olderFailed = false;
  int olderPages = 0;

  /// **这一间的本机一屏读过了没有**（`_restoreLocal` 置位）。
  /// ⚠️ 切回来时不许再读一遍 —— 再读一遍会把已经画出来的那一屏又画一次。
  bool restored = false;
}
