// 主界面。手册 `08-SPEC.md` §6（铁律）、`01-PROJECT.md` §五（五条原则）。
//
// 这一屏只干一件事：**让用户知道发生了什么**。
// 走查里十个用户，八个的放弃点落在同一件事上——
// "它到底活着没有、记着没有、说的是不是真的"，**而系统自己也不说**。
//
// 所以这一屏有三块"说话"的地方：
//   ① 顶部状态条：网怎么样、登录还有没有效
//   ② 每条消息的四态（在气泡里）
//   ③ 出错的实话：没发出去就是没发出去
//   ④ 它正在做（`BusyLine`）：一轮开了、还没出字的那段空白
//   ⑤ 关于（顶栏那个 i）：**这台设备上能不能用嘴说** —— D3.3 要求如实说
//
// ⚠️ 文案里**不许出现内部词**（"连接/客户端/云端/工作区"…）——
//    有 `forbidden_words` 那道闸守着，改文案时会拦。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/dev_harness.dart';
import '../models/image_outcome.dart';
import '../models/conn_state.dart';
import '../models/chat_select.dart';
import '../models/design.dart' as d;
import '../models/desktop_words.dart';
import '../models/export_words.dart';
import '../models/scroll_follow.dart';
import '../models/space.dart';
import '../models/app_spec.dart';
import '../models/app_words.dart';
import '../models/harness.dart';
import '../models/harness_words.dart';
import '../models/mini_update.dart';
import '../models/scope.dart';
import '../models/space_words.dart';
import '../models/timeline.dart';
import '../models/trash_words.dart';
import '../services/api.dart';
import '../services/chat_controller.dart';
import '../services/dev_harness_client.dart';
import '../services/harness_client.dart';
import '../services/links.dart';
import '../services/hearing.dart';
import '../services/speech.dart';
import '../widgets/app_desktop.dart';
import '../widgets/harness_pane.dart';
import '../widgets/job_ask_sheet.dart';
import '../widgets/mini_app_icons.dart';
import '../widgets/plan_strip.dart';
import '../widgets/bubble_select_bar.dart';
import '../widgets/bubble_menu.dart';
import '../widgets/bubbles.dart';
import '../widgets/chat_floater.dart';
import '../widgets/mini_app_host.dart';
import '../widgets/mini_app_frame.dart';
import '../widgets/composer.dart';
import '../widgets/notice.dart';
import '../widgets/process_level_menu.dart';
import '../widgets/process_view.dart';
import '../widgets/tool_row_view.dart';
import '../widgets/trash_plan_sheet.dart';
import 'discover_screen.dart';
import 'export_screen.dart';
import 'settings_screen.dart';
import 'trash_screen.dart';

/// "下面那一整块"的名字（状态条 + 内容 + 输入框）。
///
/// ⚠️ **给闸用的**：契约 `29-NOTICE.md` 约束 1 的判据是 **D4.8：高度变化 = 0px**，
///    而"变化"必须量在**同一个东西**上 —— 就是这一块。它一直都在
///    （通知来之前是空屏、来之后是列表），所以前后比它才是 0px 的判据。
const Key chatBodyKey = Key('chat-body');

class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.controller,
    required this.onLoggedOut,
    this.space = const SpaceInfo(),
    this.onSendKey,
    this.onSendCreds,
    this.onDrawImage,
    this.onCancelMe,
    this.onKeyChanged,
    this.initialTier = FloaterTier.collapsed,
    this.harnessFeed,
    this.devHarnessEntry,
  });

  final ChatController controller;
  final VoidCallback onLoggedOut;

  /// **"我那台到哪一步了"**（服务端说的）—— 「配置」那一屏要拿它如实说现状。
  final SpaceInfo space;

  /// 把钥匙交上去（和第一次那一屏**同一个入口**）。`null` ⇒ 抓手行不显示「配置」
  /// （单看这一屏的测试可以不传）。
  final Future<KeySend> Function(String key)? onSendKey;

  /// **画一张图**（P1-27）：配置页「图片」那一屏的「试一张」用它。
  final Future<ImageOutcome> Function(String prompt)? onDrawImage;

  /// **配置页那四样**（主人 2026-09-24）：某一屏填好了 ⇒ 一次送出去。
  /// ⚠️ `tab` 就是那四个 tab 的名字（`space_words.dart` 里那四个常量）。
  final Future<KeySend> Function(String tab, Map<String, String> values)? onSendCreds;

  /// 取消注册（照样只有一次实现，见 `KeyForm`）。
  final Future<CancelOutcome> Function()? onCancelMe;

  /// 换成功之后叫一声（上层去重问状态）。
  final VoidCallback? onKeyChanged;

  /// 一进来浮窗是哪一档。
  ///
  /// ⚠️ **默认收起**（主人 2026-09-22 定：一进来看得见桌面，点那条带字的「展开」才开聊）。
  /// ⚠️ 要**展开态**的测试/调用方**显式传 `FloaterTier.full|half`** ——
  ///    别去改默认值来"哄断言"：默认值这件事本身就是主人定的产品行为。
  final FloaterTier initialTier;

  /// **「我自己那台」那条通道怎么造**（契约 `docs/dev/81-HARNESS-ENTRY.md` §5.4）。
  ///
  /// `null` = 生产那一条（`HarnessClient` → `/api/harness`）；
  /// 判据里注入一个假的 ⇒ "磁贴点开真的进去了"这件事**不用真连一个口**也验得了。
  final HarnessFeed Function()? harnessFeed;

  /// ★ **那个次要入口怎么接**（契约 `docs/dev/82-DEV-MODE.md` §四 / §五）：
  /// 「在浏览器里打开」那一句普通话 + 一个按钮。
  ///
  /// `null` = 生产那一条（`DevHarnessClient` → `/api/dev-harness`，再由
  /// `services/links.dart` 的 `canOpenLinks` / `openExternal` 去开）；
  /// 判据里注入一个 ⇒ "拿到链接真有按钮 / 没被标真没按钮"不用真开浏览器也验得了。
  final DevHarnessEntry? devHarnessEntry;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _scroll = ScrollController();

  /// 浮窗那一层的把手（外面要叫它"拉满"/"收起"）。
  final _floaterKey = GlobalKey<ChatFloaterState>();

  /// **"我的小程序"在 `_openApp` 里的前缀**（跟内置那三个区分开：`'settings'` / `'discover'` / …）。
  ///
  /// ⚠️ 前缀本身搬去了 `models/scope.dart`（`mineAppPrefix`）——因为"现在在哪个房间"
  ///    那条判定是**纯函数**，它得看得见这个前缀（判据在 `test/unit/scope_test.dart`）。
  ///    这里留个别名，好让这一屏里那些 `'$_minePrefix${a.id}'` 照旧读得通。
  static const _minePrefix = mineAppPrefix;

  /// **收回动画期间接着画的那一屏 + 顶上那行字**。
  ///
  /// 🔴 为什么要有它（主人 2026-09-23 报的：*"在小程序退出的时候，其他的小程序竟然会
  ///    先切换页面到设置才缩小隐藏"*）：关掉 = `_openApp = null`，而"现在开着哪一屏"
  ///    那一串判断原来**最后兜底到 `SettingsScreen`** ⇒ 收回动画那一帧里画的是**设置**。
  ///    ⇒ 现在没开就返回 `null`（不再兜底到设置），外面用**上一帧那一屏**把动画播完 ——
  ///      用户看到的是"它自己缩回图标那儿"，而不是"闪一下设置再缩"。
  Widget? _lastAppView;
  String _lastAppTitle = '';

  /// **现在开着哪个小程序**（`null` = 没开）。
  ///
  /// ⚠️ 原来是个布尔（只装得下「设置」一个）。后来桌面上不止一格（发现 /「我自己那台」）
  ///    ⇒ 改成名字。
  /// ⚠️ **同时只开一个**：关掉再开另一个。真要做"多个同时开着"（`IndexedStack` + 各自状态），
  ///    等真的需要时再说 —— 现在没有那个需求，先不做（`04-ROADMAP.md` §十一：做一半比不做更坏）。
  String? _openApp;

  /// **我的小程序**（乙-1：`/api/apps` 拿回来的那一批 —— 每个人自己的）。
  /// ⚠️ 空清单就是空清单（问不到也不摆一个假图标）。
  List<MiniApp> _myApps = const [];

  /// 打开这一条（带签名的那份 URL）；`null` = 现在开着的不是"我的小程序"。
  MiniApp? _openMine() {
    final id = _openApp;
    if (id == null || !id.startsWith(_minePrefix)) return null;
    final want = id.substring(_minePrefix.length);
    for (final a in _myApps) {
      if (a.id == want) return a;
    }
    return null;
  }

  /// **它是从哪儿打开的**（图标在屏幕上的矩形）—— 小程序从那儿"扩开"到全屏。
  Rect? _appFrom;

  /// 聊天**展开着**吗（展开 = 桌面小程序被盖住 —— 手册 §6.4 规则 2/3）。
  /// ⚠️ 由浮窗自己报（它换档时调 `onTier`），不是这里猜的。
  bool _floaterExpanded = false;

  /// 浮窗现在**占多高**（含它自己那条）。收起档的高度是**内容算出来**的（D3.5）
  /// ⇒ 只能等它画完再报；这里拿它给小程序内容做**底部内缩**（§6.4 规则 1）。
  double _floaterH = 0;

  /// 用户**自己往上翻过**没有。
  ///
  /// ⚠️ 这个布尔是欠账第 24 条的修法里唯一的新状态：
  ///    在此之前，"要不要跟到底部"只看"离底部近不近"，
  ///    而**首屏 `pixels == 0` 对上一屏历史** ⇒ 那个判据恒为 false
  ///    ⇒ **打开就停在最老那一条**。判据本身搬去了 `models/scroll_follow.dart`。
  bool _userScrolledAway = false;

  // ── ★ `116`：过程折叠（DSH 的 `turn-process` 控件 · 主人 2026-09-26）────

  /// **时间线那一块**（自动折叠要问它"键盘焦点在不在里面"，见 [_focusInTranscript]）。
  final _transcriptKey = GlobalKey();

  /// **用户自己展开过的那几轮**（键 = 轮号）。
  ///
  /// ⚠️ 语义只有这一条：**收口之后默认折起来，用户点开过就展开**
  ///    （`_applyAutoFold` 只在"这一轮第一次收口"那一下动它一次 —— 之后听用户的）。
  /// ⚠️ 换房间要清（轮号在两间里各自从 1 开始 ⇒ 不清会把 A 间展开过的第 3 轮
  ///    带到 B 间去）。
  final Set<int> _unfoldedTurns = {};

  /// **已经为哪几轮做过"收口那一下"的决定**（各只做一次）。
  final Set<int> _autoFoldApplied = {};

  /// 时间线那一块的 [FocusManager] 监听（焦点离开时要补做那次"迟到的折叠"）。
  ///
  /// ⚠️ 为什么要监听焦点：自动折叠撞上焦点在里面时**必须推迟**（见 [_applyAutoFold]），
  ///    而"焦点什么时候走"不是一个滚动/控制器事件 —— 不监听就再也没有第二次机会。
  void _onFocusChanged() => _applyAutoFold(widget.controller);

  /// **自动折叠一次**（每轮只在收口那一下做一次）。
  ///
  /// 🔴 **硬规矩：自动折叠绝不许吃掉键盘焦点**（DSH `B-render.md` §2.3：
  ///    *"if it would, the group stays open and focus stays put"*）。
  ///    做法：收口那一下如果焦点**就在这一屏里**（比如用户正把光标停在某个
  ///    工具行的展开按钮上），就**这一轮保持展开**、并记下"已决定"——
  ///    人还在那儿，东西不许在他眼皮底下消失。
  ///
  /// ⚠️ **没做到 DSH 那条"上面还有更早的就不折"**（诚实说清缺什么）：
  ///    DSH 的 `historyIncomplete = hasMore` 是一个**权威的**"更早还有没有"，
  ///    它从会话窗口（翻页游标 + 服务端的 projection）直接读得到。
  ///    我们这一侧**没有这样一个权威的 hasMore**：`ChatController.olderExhausted`
  ///    只在**用户真的往上翻过一次之后**才有意义（在那之前它恒为 false —— 谁都没问过）。
  ///    ⇒ 按"不知道就不假装知道"：**不拿它当折叠闸**。拿它当闸的后果是
  ///    "用户不往上翻，屏幕上的过程行就永远不折"——那不是 DSH 那条规矩，是我们编的。
  ///    要补上它，得让服务端在流/接口上给一个权威的"更早还有没有"（今天没有）。
  void _applyAutoFold(ChatController c) {
    final closed = c.closedThrough;
    if (closed <= 0) return;
    final pending = <int>[
      for (final it in c.items)
        if (it is TimelineToolCall && it.turn <= closed && _autoFoldApplied.add(it.turn)) it.turn,
    ];
    if (pending.isEmpty) return;
    if (_focusInTranscript()) {
      // 焦点还在里面 ⇒ 这一轮**保持展开**（人还在看/在操作）。
      _unfoldedTurns.addAll(pending);
    }
    if (mounted) setState(() {});
  }

  /// **键盘焦点现在在不在时间线里**。
  ///
  /// ⚠️ 论"在不在"要**沿祖先走**（`primaryFocus.context` 是那个具体控件，
  ///    不是时间线本身）；只看"有没有焦点"会把**输入框里打字**（最常见的那档）
  ///    误判成"焦点在过程里"，于是永远不折 —— 那是把这条规矩用反了。
  bool _focusInTranscript() {
    final focusCtx = FocusManager.instance.primaryFocus?.context;
    final root = _transcriptKey.currentContext;
    if (focusCtx == null || root == null) return false;
    if (identical(focusCtx, root)) return true;
    var inside = false;
    focusCtx.visitAncestorElements((e) {
      if (identical(e, root)) {
        inside = true;
        return false;
      }
      return true;
    });
    return inside;
  }

  /// 这一轮的过程行**现在折起来了吗**（收口 + 用户没展开过）。
  bool _processFolded(int turn, int closedThrough) =>
      turn <= closedThrough && !_unfoldedTurns.contains(turn);

  // ── 多选态（契约 `docs/dev/106-CHAT-SELECT.md` §一）──────────────

  /// 现在在不在**多选态**（点了菜单里那个【多选】之后）。
  ///
  /// ⚠️ 它的唯一入口是【多选】那一项 —— 长按本身**不进多选态**。
  /// ⚠️ 进去之后，点气泡**只切换选中**：重发 / 打开链接 / 再弹长按菜单
  ///    三样一个都不许触发（§一 + 判据 S6）。
  bool _selecting = false;

  /// 多选态里已选中的那几条（键 = `messageId`）。
  ///
  /// ⚠️ 进多选态时**从空开始**：长按的那一条**不预先选中** ——
  ///    契约 §一 只说"点一下 = 选中"，而判据 S3 是"点两条 ⇒ 计数 2"
  ///    （预选的话就成了 3）。
  final Set<String> _selectedIds = {};

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onChanged);
    // ★ **"读出来"这个开关**存盘读过一次（设备级偏好；读不出来当关）。
    unawaited(widget.controller.loadAutoSpeak());
    // ★ **我的小程序**（乙-1）：登录之后拉一次。⚠️ 拉不到就是空清单，**不许**因此把界面弄坏。
    unawaited(_loadMyApps());
    // ⚠️ **首屏也要跟一次**：本机缓存那一屏（`17-LOCAL-FIRST.md`）可能
    //    在挂载之前就已经在控制器里了，那时 `_onChanged` 一次都不会触发。
    WidgetsBinding.instance.addPostFrameCallback((_) => _followBottom());
    // ★ `116`：焦点离开时间线时，把那次"因为焦点在里面而推迟的折叠"补上。
    FocusManager.instance.addListener(_onFocusChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    FocusManager.instance.removeListener(_onFocusChanged);
    // 离开这一屏 ⇒ 把「我自己那台」那一头收干净（对面就不会留一个孤儿进程）
    _closeHarness();
    _scroll.dispose();
    super.dispose();
  }

  void _onChanged() {
    if (!mounted) return;
    // ★ `116`：先做"这一轮收口了没有"那一下自动折叠（它自己会 setState）。
    //    ⚠️ 必须在下面那次 setState **之前**：不然屏幕上会先闪一帧"没折"的样子。
    _applyAutoFold(widget.controller);
    setState(() {});
    // ★ **服务端说"装上了一个小程序"** ⇒ 重拉一次清单（桌面**自己长出来**，不用刷新页面）
    final rev = widget.controller.appsRevision;
    if (rev != _appsRevision) {
      _appsRevision = rev;
      unawaited(_loadMyApps());
    }
    // ★ **服务端说"这个小程序有新版了"**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）：
    //   正开着它 ⇒ **现取一次清单，把那一帧换掉**（不要求他刷新）；
    //   没开着 ⇒ 只记一笔（判据 U2/U3/U4）。
    final upd = widget.controller.appUpdateRevision;
    if (upd != _appUpdateRevision) {
      _appUpdateRevision = upd;
      unawaited(_onAppUpdate(widget.controller.lastAppUpdate));
    }
    // ★ **那一间的内容变了**（契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）：
    //   他正在改的那一份刚被写过 ⇒ 正开着它 ⇒ **直接重取一次清单、换一帧**
    //   （那一条**不带版本号** ⇒ 不判版本，收到就重取）；没开着 / 别人的 ⇒ 一个像素都不动。
    final live = widget.controller.appWorkspaceRevision;
    if (live != _appWorkspaceRevision) {
      _appWorkspaceRevision = live;
      unawaited(_onAppWorkspaceChanged(widget.controller.lastAppWorkspaceChange));
    }
    // ★ **派活那一步**（契约 `docs/dev/108-JOB-ASK-FLOW.md`）：
    //   ① 他接下一件新东西 ⇒ 服务端先问一句 ⇒ 出那层确认（两个按钮）；
    //   ② 做完且他正开着那一间 ⇒ **自动把那个东西打开**（"点开图标"那条老路）。
    //   ⚠️ 两件都**不抢屏**：① 只在服务端问了才弹；② 服务端只推给"正开着那一间"
    //      的那条连接，而且这一层还要认得出那个名字才开（见 `_maybeAutoOpen`）。
    _maybeAskJob();
    _maybeAutoOpen();
    // ★ **换了房间 ⇒ 换句话说，现在该看的是另一条对话**（契约 `83` §五·甲）。
    //   ⚠️ 两件跟着走的事：
    //     ① "用户自己往上翻过"那个标志**不作数了** —— 那是**上一间**里的动作，
    //        拿它挡着的话，切进新房间会停在**最老**那一条（`27-SCROLL.md` 那类缺陷）；
    //     ② 钉到最新（新视口里没有"他刚才在看哪儿"可言）。
    if (widget.controller.scope != _shownScope) {
      _shownScope = widget.controller.scope;
      _userScrolledAway = false;
      // ★ `116`：轮号在两间里各自从 1 开始 ⇒ 折叠那两份账也跟着换（见 `_unfoldedTurns`）。
      _unfoldedTurns.clear();
      _autoFoldApplied.clear();
      WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToLatest());
    }
    // 新东西进来时重绘 + 滚到底；**用户正在往上翻时不打断他**
    WidgetsBinding.instance.addPostFrameCallback((_) => _followBottom());
  }

  /// **上一次画出来的那个房间**（用来认出"房间换了" —— 见 [_onChanged]）。
  late String _shownScope = widget.controller.scope;

  /// ★ **那层确认现在开着吗**（同一笔只弹一次 —— 见 [_maybeAskJob]）。
  bool _askSheetOpen = false;

  /// ★ **他接下一件新东西 ⇒ 服务端先问一句 ⇒ 出那层确认**（契约 108 §一 第①步 · C1）。
  ///
  /// 🔴 **同一笔只弹一次**：`_onChanged` 会被叫很多次（每一帧都叫），
  ///    没有这个开关就会叠出一摞一样的层（而且每一层都答一次）。
  /// 🔴 **文案与问话都照服务端给的**（`JobAsk`）：这一层一个字都不自己拼。
  Future<void> _maybeAskJob() async {
    final c = widget.controller;
    final ask = c.pendingJobAsk;
    if (ask == null || _askSheetOpen || !mounted) return;
    _askSheetOpen = true;
    try {
      final yes = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        builder: (_) => JobAskSheet(ask: ask),
      );
      if (!mounted) return;
      // ⚠️ **他滑掉了那一层**（`null`）⇒ **什么都不答**（不替他选）。
      //    那一笔还在服务端等着；到点它会推"作废了"那一帧，那时如实说一句。
      if (yes == null) return;
      // 🔴 **答案发回服务端**（走同一条流）；至于"建不建、切不切"，
      //    那是服务端的事 —— 这一层**不自己切房间**（两个裁判会切两次）。
      c.answerJobAsk(yes: yes);
    } finally {
      _askSheetOpen = false;
    }
  }

  /// ★ **做完自动给他看**（契约 108 §一 第④步 · C5/C6）。
  ///
  /// 条件**两个都要**（缺一个都不许开）：
  ///   ① 服务端推来了那一帧，而且它属于**现在这一间**（服务端那一侧也只推给
  ///      "正开着那一间"的那条连接 ⇒ 这里再挡一道，结构上抢不了屏）；
  ///   ② 那个名字**真的在他清单里**（认不出就不开 —— 开了就是一屏"找不到"，
  ///      那比不开更坏）。
  void _maybeAutoOpen() {
    final c = widget.controller;
    final want = c.takeOpenAppRequest();
    if (want == null || !mounted) return;
    final mine = _myApps.any((a) => a.id == want);
    if (!mine) return; // 还没拉到清单 / 不是他的 ⇒ **不开**（不猜）
    setState(() {
      _openApp = '$_minePrefix$want';
    });
  }

  /// **钉到最新**（`jumpTo`，不带条件）。
  ///
  /// ⚠️ 只在"**新的视口刚刚建出来**"时用（展开那一档）——平时的跟随走
  ///    [`_followBottom`]，那条会尊重"用户自己翻走了没有"。
  /// ⚠️ 刚建出来那一帧可能还没有布局（`maxScrollExtent` 还是 0）⇒
  ///    等下一帧再试，最多几次（`hasContentDimensions` 才是"布局过了"的信号）。
  void _jumpToLatest({int left = 4}) {
    if (!mounted || !_scroll.hasClients) return;
    // 🔴 **用户一动过手就立刻收手**（哪怕这几次补帧还没跑完）。
    //    这一条是**必须**的：4 帧的强制钉底会把用户刚做的上滑又拉回底部 ——
    //    正在翻旧话的人被拽走，是这个项目一直在挡的那种形状
    //    （`models/scroll_follow.dart` 的 `userScrolledAway` 就是为它存在的）。
    //    ⚠️ 实测代价：D3.6 那条判据（先上滑到顶找"重发"）就是这么红的。
    if (_userScrolledAway) return;
    final pos = _scroll.position;
    if (pos.hasContentDimensions) pos.jumpTo(pos.maxScrollExtent);
    // ⚠️ **一次跳不够，要连补几帧**（2026-09-23 实测栽过）：
    //    ① 刚建出来那一帧可能还没布局（`hasContentDimensions` 还是假）；
    //    ② 而且列表是**懒加载**的 —— 跳到底之后，新露出来的条目才被 build，
    //       `maxScrollExtent` **又长了一截** ⇒ 只跳一次会**差一条**
    //       （实测：最后那条用户的话被输入条切掉，它的回答还在下面）。
    //    ⇒ 连补几帧（每帧再钉一次当前的最大值），直到稳定。4 帧 ≈ 66ms，看不出来。
    if (left > 0) WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToLatest(left: left - 1));
  }

  /// 按纯函数的判定跟到底部（判据与理由见 `models/scroll_follow.dart`）。
  void _followBottom() {
    if (!mounted || !_scroll.hasClients) return;
    final pos = _scroll.position;
    final action = scrollFollowAction(
      pixels: pos.pixels,
      maxScrollExtent: pos.maxScrollExtent,
      userScrolledAway: _userScrolledAway,
    );
    switch (action) {
      case FollowAction.none:
        return;
      case FollowAction.jump:
        _scroll.jumpTo(pos.maxScrollExtent);
      case FollowAction.animate:
        _scroll.animateTo(
          pos.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    // ★ **记住"上一帧开着的那一屏"**：`_openApp` 一置空，`_appView` 就返回 `null`，
    //   而收回动画还要把**它自己**缩回图标那儿（不是闪一下设置、也不是空白）。
    //   ⚠️ 这里只是缓存（不 `setState`），所以不会引起重建循环。
    final appView = _appView(c);
    if (appView != null) {
      _lastAppView = appView.view;
      _lastAppTitle = appView.title;
    }
    // ⚠️ **浮窗（通知）与主界面是 `Stack` 的两层，不是 `Column` 的两行。**
    //    约束 1 的判据是 **D4.8：高度变化 = 0px** —— 塞进 `Column` 就当场破掉
    //    （下面整块内容会被那条通知往下推）。有闸钉着：
    //    `test/widget/notice_overlay_test.dart` 量的是**下面内容前后同一个矩形**。
    // ⚠️ **桌面铺满整屏（底图），聊天浮窗贴在屏幕底部浮着、四边各留 30**
    //    （主人 2026-09-22 更正："桌面是全屏的，聊天窗口是在底部的"；
    //      契约 `52-DESKTOP.md`、手册 §六 Z4）。
    //    两层是 `Stack`，不是上下排的 `Column` —— 桌面在**下面那一层**，不是"下面那一条"。
    //    ⚠️ `Positioned` 必须是 `Stack` 的**直接孩子**（包一层 `LayoutBuilder` 会让整棵树报
    //       `Incorrect use of ParentDataWidget`）；所以浮窗能用的高度从 `MediaQuery` 算，
    //       不在 `Positioned` 里套 `LayoutBuilder`。
    final mq = MediaQuery.of(context);
    final maxH = mq.size.height - mq.padding.top - FloaterMetrics.margin * 2;
    final sheet = Scaffold(
      backgroundColor: d.paper,
      body: Stack(
        children: [
          // ① 桌面（整页底图；点它的空白 = 收起聊天）
          //
          // 🔴 **聊天不是桌面上的一个小程序**（主人 2026-09-22）：
          //    *"聊天和桌面是独立的，聊天是永续的，永远在底下。所以聊天不是桌面上的一个小程序。
          //      桌面上应当有一个设置的小程序，用来退出登录，注销账号，修改 apikey。"*
          //    ⇒ 桌上那个「会话」图标**删掉**（聊天永远在那条浮窗里，它不需要一个入口）；
          //      换成**设置**。
          Positioned.fill(
            child: AppDesktop(
              apps: [
                // ⚠️ 没接上那条路就不摆一个"按不动"的图标（同原来那个齿轮的规矩）
                if (widget.onSendKey != null)
                  DesktopApp(
                    label: settingsAppLabel,
                    id: builtInSettingsId,
                    icon: _builtInIcon(builtInSettingsId),
                    // 打开小程序 ⇒ **聊天自动收起**（§6.4 规则 5：把屏幕让给小程序）
                    onOpen: (from) => _openMiniApp(from, builtInSettingsId),
                  ),
                // ★ **发现**（乙-3）：别人发出来的（**只读那一屏**；装/发都在对话里）
                DesktopApp(
                  label: discoverAppLabel,
                  id: builtInDiscoverId,
                  icon: _builtInIcon(builtInDiscoverId),
                  onOpen: (from) => _openMiniApp(from, builtInDiscoverId),
                ),
                // ★ **「我自己那台」**（2026-09-24 · 契约 `docs/dev/81-HARNESS-ENTRY.md` §5.4）：
                //   点开 = 桌面上多一层**终端**，里面是**他自己那一台**的原始会话流
                //   （它的思考、它吐的字，**原样**；我们只当显示器 + 键盘）。
                //   ⚠️ 走的是宿主那条 `/api/harness`（连接建立 = 对面起它那一台），
                //      所以这里**不摆"取不到就不画"**：接不上那一层会**如实说一句 + 重来**。
                DesktopApp(
                  label: harnessAppLabel,
                  id: builtInHarnessId,
                  icon: _builtInIcon(builtInHarnessId),
                  onOpen: (from) => _openMiniApp(from, builtInHarnessId),
                ),
                // ★ **我的小程序**（乙-1）：他自己/助手造的那一批 ——
                //   图标与名字都来自 `/api/apps`，点开跑在**另一个原点**的沙箱里（N1）。
                for (final a in _myApps)
                  DesktopApp(
                    label: a.title,
                    id: '$_minePrefix${a.id}',
                    icon: miniAppIconFor(a.icon),
                    onOpen: (from) => _openMiniApp(from, '$_minePrefix${a.id}'),
                    // ★ 2026-09-25（契约 `docs/dev/103-APP-DELETE.md` §一 ·
                    //   `docs/dev/104-APP-MENU.md` §一）：
                    //   **只有"他自己做的那几个"才给这个面板** —— 内置那几格
                    //   （设置 / 发现 /「我自己那台」）不在 `/api/apps` 里，
                    //   服务端那三条路都认不出它们（传 `null` = 连面板都不出）。
                    //   ⚠️ 传下去的是**服务端那一份的 id**（`a.id`），不是屏幕上带前缀那串。
                    onRename: () => _renameMyApp(a.id, a.title),
                    onCopy: () => _copyMyApp(a.id),
                    onRemove: () => _removeMyApp(a.id),
                  ),
              ],
              // ★ 2026-09-24：正在扩开/收回的那一格，**图标先消失**（打开那一瞬间就藏；
              //   收回时**藏到动画结束**才放回来 —— 主人原话："appicon 应该是动效结束后出现"）
              hideIconId: _openApp ?? (_appSettled ? null : _hideIdCache),
              onTapBlank: () => _floaterKey.currentState?.collapse(),
            ),
          ),
          // ①.5 小程序容器（**在桌面之上、聊天之下** —— Z1 说聊天永远最上）
          Positioned.fill(
            child: MiniAppHost(
              open: _openApp != null,
              fromRect: _appFrom,
              // ⚠️ 没开的时候用**上一帧那一屏**（收回动画要缩的是它自己，不是别的）
              title: _appView(c)?.title ?? _lastAppTitle,
              // ★ 2026-09-24 主人定案：前半程要看到"**图标自己在长大**"
              icon: _appIconFor(),
              onClose: () {
                // 离开这个入口 ⇒ 把「我自己那台」那一头收掉（对面就把那一台停掉）
                _closeHarness();
                setState(() {
                  _openApp = null;
                  _appSettled = false; // 收回动效开始 ⇒ 图标先别回来
                });
                // 🔴 **退回桌面 ⇒ 回到主线那条对话**（契约 `83` §五·甲：
                //    "关掉/退回桌面 ⇒ 回到 `main`"）。⚠️ 主线那一份**一直在**
                //    （控制器按房间分开留着），所以这一下只是"换回它"，
                //    不是"重新拉一遍"。
                unawaited(widget.controller.setScope(mainScope));
              },
              onSettled: () {
                if (mounted) setState(() => _appSettled = true);
              },
              covered: _floaterExpanded,
              onCoveredTap: () => _floaterKey.currentState?.collapse(),
              // 收起那条压住多少 ⇒ 内容底部内缩（规则 1：不是简单覆盖，否则最后一行永远点不到）
              bottomInset: _floaterExpanded
                  ? 0
                  : FloaterMetrics.margin + _floaterH,
              child: _appView(c)?.view ?? _lastAppView ?? const SizedBox.shrink(),
            ),
          ),
          // ①.8 **计划条**（主人 2026-09-23 定案：*"浮在屏幕上方（窗口不动）"*）
          //  · 在桌面之上、聊天浮窗之下（两者不重叠：它贴上沿、浮窗贴底）
          //  · 🔴 `PlanStrip` 里面是 `IgnorePointer` ⇒ 点它**穿透到桌面**，
          //    所以"点桌面空白 = 收起聊天"在那块**照样有效**（不是死区）
          //  · 没有计划 ⇒ 它自己画空盒子（`SizedBox.shrink`）
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(bottom: false, child: PlanStrip(plan: c.plan)),
          ),
          // ② 聊天浮窗（贴底、四边 30、永远在最上 —— Z1/Z3/Z4）
          Positioned(
            left: FloaterMetrics.margin,
            right: FloaterMetrics.margin,
            bottom: FloaterMetrics.margin,
            // ⚠️ **不给 `height`**：收起档的高度要**由内容算**（D3.5）；
            //    半开/最大化由 `ChatFloater` 自己按系数定（它拿到 `maxHeight`）。
            child: ChatFloater(
              key: _floaterKey,
              maxHeight: maxH,
              title: '助手',
              initialTier: widget.initialTier,
              trailing: _actions(c),
              composer: _composer(c),
              // 上层拿这两个数去算"小程序被盖住没有 / 内容要内缩多少"（§6.4 规则 1/2/3）
              onTier: (t) {
                final expanded = t != FloaterTier.collapsed;
                if (expanded != _floaterExpanded) {
                  setState(() => _floaterExpanded = expanded);
                  // 🔴 **展开 = 时间线刚刚被建出来**（收起档**根本不建它** ——
                  //    见 `chat_floater.dart` 的 `if (collapsed) … else Expanded(child: widget.child)`）
                  //    ⇒ 那个新视口的偏移从 **0** 开始 = 屏幕上停在**最早**那一条。
                  //    ⚠️ 主人 2026-09-23 报的就是这个：*"聊天展开的时候默认显示了最早的聊天。这是不对的。"*
                  //    ⚠️ 为什么以前的判据没抓住：它们全都从"一上来就展开"的入口进
                  //       （`initialTier: FloaterTier.full`），而**真应用是从收起档开始的**
                  //       —— 又一条"闸打在了替代的那一侧"（V13 那一族）。
                  //
                  // ⇒ **展开之后立刻钉到最新**，而且这个场合**强制**（不管
                  //    `_userScrolledAway`）：新视口里没有"他刚才在看哪儿"可言，
                  //    默认就该是最新的聊天。
                  if (expanded) {
                    _userScrolledAway = false;
                    WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToLatest());
                  }
                }
              },
              onHeight: (h) {
                // ⚠️ 只在**真的变了**的时候 setState（它每帧都会报一次，不然会抖）
                if ((h - _floaterH).abs() > 0.5) setState(() => _floaterH = h);
              },
              child: _sheetBody(c),
            ),
          ),
        ],
      ),
    );
    final n = c.notice;
    // ⚠️ `Positioned(top/left/right)` **不给 bottom** ⇒ 浮窗只占它自己那么大，
    //    而且**不参与 `Stack` 的尺寸计算**（`Stack` 的尺寸由非 positioned 的
    //    那个孩子决定）。这就是"浮在上面、不挤动下面"的**结构**保证——
    //    不是靠"看起来像浮着"。
    return PopScope(
      // ⚠️ 退出这一屏就把浮窗撤了：它是"现在喊你一声"，
      //    而下一屏上没有它（不然那个钟到点时会去动一棵已经没了的树）。
      onPopInvokedWithResult: (didPop, _) => c.dismissNotice(),
      child: Stack(
        children: [
          sheet,
          if (n != null)
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: NoticeOverlay(
                notice: n,
                // ⚠️ 浮窗那个**不带 `from`**：它读浮窗手上那一条
                onUndo: () => _undoNotice(),
                onDismiss: c.dismissNotice,
              ),
            ),
        ],
      ),
    );
  }


  /// **现在开着的那一屏 + 顶上那行字**；`null` = 没开（或者认不出的 id）。
  ///
  /// 🔴 **兜底不再是设置**（主人 2026-09-23 报的缺陷）：设置只有在
  ///    `_openApp == builtInSettingsId` 时才画。⚠️ 有判据钉着这件事。
  ///
  /// ⚠️ 这里**顺手把 `mine` 捕获在闭包外**：原来 `onAsk` 里是 `_mineOpen()!.id`，
  ///    而收回动画期间 `_openApp` 已经是 `null` ⇒ 那一句会**空指针**（潜在崩溃）。
  /// **现在（或刚才）那一屏的图标** —— "从图标长出来"那一层用它。
  ///
  /// ⚠️ 收回的时候 `_openApp` 已经是 null 了，所以要**自己记一份**
  ///    （跟 `_lastAppView` / `_lastAppTitle` 同一个道理：动画要缩的是**它自己**）。
  IconData? _lastAppIcon;

  /// 扩开/收回**落定了吗**（落定 ⇒ 桌面那一格的图标可以回来了）。
  bool _appSettled = true;

  /// 刚才在动的是哪一格（收回时 `_openApp` 已经是 null，只能自己记）。
  String? _hideIdCache;

  IconData? _appIconFor() {
    if (_openApp != null) _hideIdCache = _openApp; // 打开这一瞬间就记下来（收回要用）
    final mine = _openMine();
    // ⚠️ `mine.icon` 是**名字**（服务器给的那个），要过同一张表变成 `IconData`
    //   （和桌面那一格用的是同一个函数 ⇒ 两处永远一致）
    if (mine != null) return _lastAppIcon = miniAppIconFor(mine.icon);
    final id = _openApp;
    if (id != null) return _lastAppIcon = _builtInIcon(id);
    return _lastAppIcon;
  }

  ({Widget view, String title})? _appView(ChatController c) {
    final mine = _openMine();
    if (mine != null) {
      return (
        // ★ **一帧 = 一条 `entryUrl`**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）：
        //   版本换了 ⇒ 服务端现签一条新的 ⇒ 这里换一帧 ⇒ Web 那一侧换 iframe。
        //   旧那一帧的收尾（退订 + 销号）在 `MiniAppFrame` 里（判据 U5）。
        view: MiniAppFrame(
          entryUrl: mine.entryUrl,
          title: mine.title,
          // ★ **那条唯一的回话通道**（乙-4b）：页面说"我要问一句"，
          //   壳替它去问 —— **花的是看的人自己的钥匙**（服务端送进他自己的环境里花）。
          //   ⚠️ 能不能问由**服务端**说了算（声明 + 授予 + 配额），壳这一侧不判。
          onAsk: (prompt) => _askFor(mine.id, prompt),
        ),
        title: mine.title,
      );
    }
    if (_openApp == builtInDiscoverId) {
      return (
        view: DiscoverScreen(load: _loadDiscover, refreshToken: _appsRevision),
        title: discoverTitle,
      );
    }
    // ★ **「我自己那台」**（契约 `81-HARNESS-ENTRY.md` §5.4）：桌面上的一层**终端**，
    //   里面是那台 DSH 自己的原始流（`HarnessPane` 只认 `models` 里那条通道的形状）。
    //   ⚠️ **不 push 新页面** —— 它就是 `MiniAppHost` 里的一个孩子（和别的小程序一样）。
    if (_openApp == builtInHarnessId) {
      return (
        view: HarnessPane(
          feed: _ensureHarness(),
          // ★ 那个**次要入口**（契约 `82-DEV-MODE.md` §五）：形状在 `models/`，
          //   实现是 `services/` + `links.dart` —— 这一层负责接上。
          devEntry: widget.devHarnessEntry ?? _devHarnessEntry(),
        ),
        title: harnessAppLabel,
      );
    }
    if (_openApp == builtInSettingsId) {
      return (
        view: SettingsScreen(
          hasKey: widget.space.hasKey,
          keyBad: widget.space.keyBad,
          localOnly: !widget.space.isTenant,
          onSubmit: widget.onSendKey ?? ((_) async => KeySend.failed),
          creds: widget.space.creds,
          onSubmitCreds: widget.onSendCreds,
          onDrawImage: widget.onDrawImage,
          onCancel: widget.onCancelMe,
          onCancelled: widget.onLoggedOut,
          onKeyChanged: widget.onKeyChanged,
          onLogout: _logout(c),
        ),
        title: configTitle,
      );
    }
    return null;
  }

  /// **现在这一间是哪一个小程序**（空房间那一句要用它的名字）；`null` = 不是
  /// 某一个"我的小程序"（主对话 / 名字一时查不到）。
  ///
  /// ⚠️ 从 **`c.scope` 反查清单**，不是从 `_openApp` 推：
  ///    `_openApp` 在收回动效那一瞬间已经是 `null` 了，而房间那一会儿才刚切回去 ——
  ///    照 `_openApp` 推会推出**「设置」**这个名字（一句假话）。查不到就 `null`，
  ///    那一句**宁可不显示**，也不许报错一个名字。
  String? _roomAppTitle(ChatController c) {
    if (c.scope == mainScope) return null;
    for (final a in _myApps) {
      if (a.id == c.scope) return a.title;
    }
    return null;
  }

  /// **一个内置小程序的图标**。
  ///
  /// ⚠️ 桌面那个图标与**聊天条前面那个**必须是**同一个**（不然"进去了"这件事
  ///    在两处长得不一样）⇒ 图标只写在这儿，两处都从这儿取。
  static IconData _builtInIcon(String which) => switch (which) {
    builtInDiscoverId => Icons.travel_explore_outlined,
    builtInHarnessId => Icons.computer_outlined,
    _ => Icons.settings_outlined,
  };

  /// **现在这句话是在哪儿说的** ⇒ 聊天条最前面那个图标（主人 2026-09-23）。
  ///
  /// * 主对话 = **在桌面上**（也就是全局）⇒ 一个**家**；
  /// * 某一间 ⇒ **那一间自己的图标**。
  ///
  /// ★ 2026-09-25（主人拍的 **B35**）：它**看的是"现在在哪一间"（`c.scope`）**，
  ///   不再看"点开了哪个图标"（`_openApp`）—— 窗口**自己跟到新那一间**之后，
  ///   原来那句「在桌面上问（全局）」就成了**假话**（话其实进了另一间）。
  ///
  /// ⚠️ **它只是指示、不是按钮**：点了什么都不做 —— 主人要的是"看得出来现在在哪儿"。
  ///    真让它可点就等于多一个出口，那要另配一条行为与 ≥44 的命中区（D3.6），不在这一刀里。
  IconData _scopeIcon(ChatController c) {
    final s = c.scope;
    if (s == mainScope) return Icons.home_outlined;
    for (final a in _myApps) {
      if (a.id == s) return miniAppIconFor(a.icon);
    }
    if (s == builtInSettingsId ||
        s == builtInDiscoverId ||
        s == builtInHarnessId) {
      return _builtInIcon(s);
    }
    // ⚠️ 认不出那一间 ⇒ 给一个"在说话"的图标：**不许**画成"设置"，
    //    更不许画成主线的家（那两样都是在说假话）。
    return Icons.forum_outlined;
  }

  /// 那条说明（长按 / 读屏听到"这句话是在哪儿说的"）。
  ///
  /// ★ 同 [_scopeIcon]：**按"现在在哪一间"算**（B35）。
  String _scopeWords(ChatController c) {
    final s = c.scope;
    if (s == mainScope) return chatScopeDesktop;
    for (final a in _myApps) {
      if (a.id == s) return chatScopeInApp(a.title);
    }
    if (s == builtInSettingsId) return chatScopeInApp(configTitle);
    if (s == builtInDiscoverId) return chatScopeInApp(discoverTitle);
    if (s == builtInHarnessId) return chatScopeInApp(harnessAppLabel);
    // 名字查不到（刚派出去那一间 —— 名字在他盒子里 · B20）⇒ 不撒谎的模糊话
    return chatScopeElsewhere;
  }

  /// 那个图标本身（带说明）。
  Widget _scopeBadge(ChatController c) => Tooltip(
    message: _scopeWords(c),
    child: Icon(_scopeIcon(c), size: 18, color: d.ink),
  );

  /// 替**现在开着的那一个小程序**问一句（乙-4b）。
  ///
  /// ⚠️ `appId` 取自**壳自己的状态**（`_openMine()`），不是页面说了算 ——
  ///    页面报什么 id 都不作数（不然一个页面可以冒充另一个去花别人的额度）。
  Future<String> _askFor(String appId, String prompt) async {
    final token = widget.controller.token;
    if (token == null) throw '这台设备上还没登录';
    final r = await widget.controller.api.appAsk(token, appId, prompt);
    if (r.ok) return r.text!;
    throw r.error ?? '没问成';
  }

  /// **发现**那一屏的取数（乙-3）。**问不到就是空清单**（那一屏会如实说"还没有"）。
  Future<List<DiscoverApp>> _loadDiscover() async {
    final token = widget.controller.token;
    if (token == null) return const [];
    return widget.controller.api.discover(token);
  }

  /// **上一次看到的"我的小程序"版本号**（乙-3：服务端说"装上了"就重拉）。
  int _appsRevision = 0;

  /// **上一次处理过的"有新版"那一条**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）。
  int _appUpdateRevision = 0;

  /// **上一次处理过的"那一间的内容变了"**（契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）。
  int _appWorkspaceRevision = 0;

  /// **没开着、但已经听说"有新版"的那些**（app id）。
  ///
  /// 🔴 **没开着它的时候什么都不动**（判据 U3/U4：别人的更新、或者本来就没开着的那个，
  ///    一个像素都不许跟着变）；只记一笔 —— 下次点开它之前先重拉一次清单，
  ///    否则点开的还是旧那一版（那正是这一条要修的东西）。
  final Set<String> _staleMine = <String>{};

  /// **这个小程序有新版了**（服务端那一帧 · 判据 U2/U3/U4）。
  ///
  /// * **正开着它** ⇒ 现取一次清单（`/api/apps` 会给新那一版**现签**的 `entryUrl`）
  ///   ⇒ 下面 `build` 出来的就是新的一帧（新 URL ⇒ 新 `viewId` ⇒ **新 iframe**）。
  ///   🔴 **不要求他刷新、也不动聊天浮窗/桌面**：只换容器里那一个孩子。
  /// * **不是它** ⇒ 什么都不动（只记一笔）—— 见 [_staleMine]。
  Future<void> _onAppUpdate(AppUpdate? update) async {
    if (update == null) return;
    final mine = _openMine();
    if (mine == null || mine.id != update.id) {
      _staleMine.add(update.id);
      return;
    }
    // 已经在这一版上了（补发/重复）⇒ 没有必要重拉一次（那会白换一帧）
    if (update.version <= mine.version) return;
    await _loadMyApps();
    if (!mounted) return;
    _staleMine.remove(update.id);
  }

  /// **那一间的内容变了**（服务端那一帧 · 契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）。
  ///
  /// 🔴 **与 [`_onAppUpdate`] 的差别只有一处**：那一条带版本号（要判"是不是比我新"，
  ///    而且补发会重复）；这一条**不带**（用户端没有"版本"这回事，而且它是**瞬态**、
  ///    不会补发）⇒ 收到就**直接重取一次清单**。
  /// 🔴 **只重取"正开着的那一个"**：不是它 ⇒ **一个请求都不发**
  ///    （别人的改动不许把这一屏搞乱 —— 判据 V5 的反例）。
  /// ⚠️ 重取之后下面 `build` 出来的就是新的一帧（新 exp ⇒ 新签 URL ⇒ 新 `viewId`
  ///    ⇒ 换 iframe，旧那一帧由 `MiniAppFrame` 收干净）—— **不要求他刷新**。
  Future<void> _onAppWorkspaceChanged(AppWorkspaceChange? change) async {
    if (change == null) return;
    final mine = _openMine();
    if (mine == null || mine.id != change.id) return;
    await _loadMyApps();
  }

  /// 拉一次"我的小程序"（乙-1）。**失败了不当成"他没有"**（不弹错 —— 它不是用户主动要的东西）。
  ///
  /// 🔴 **问不到 ⇒ 绝不用空清单覆盖**（2026-09-25 修的真缺陷）：`Api.apps()` 在网络/非 200/
  ///    读不懂时回的也是空清单，而这里原来直接 `_myApps = got` ⇒ 只要抖一下，
  ///    **整个桌面会被清空**（界面上却刚说过"已经删掉了"）。
  ///    ⇒ 现在分得清"他没有小程序"与"这一次没问上"；没问上时**保留旧清单**。
  ///
  /// @param dropId 服务端**明说成了**的那一次删除 —— 没问上清单时，只把**这一条**从本地
  ///        清单里去掉（那一条的去处是服务端确认过的），别的**一个都不动**。
  Future<void> _loadMyApps({String? dropId}) async {
    final token = widget.controller.token;
    if (token == null) return;
    final got = await widget.controller.api.appsOrNull(token);
    if (!mounted) return;
    setState(() {
      if (got != null) {
        _myApps = got;
        return;
      }
      if (dropId != null) _myApps = _myApps.where((a) => a.id != dropId).toList();
    });
  }

  /// **第二次确认**（契约 `docs/dev/103-APP-DELETE.md` §七.4 · 决策 **D3.11**）。
  ///
  /// 主人 2026-09-25：*"点击删除，也会提醒用户，回收相应的工作区、经验、数据。
  /// 需要用户二次确认。"* ⇒ 这一层把"会一起拿走哪几样"**逐条**摆出来（措辞住
  /// `models/desktop_words.dart`），再点一下才真的删。
  ///
  /// 🔴 **这一层之前一个请求都不发**（判据 C7 的反例就是"第一下就发了"）。
  /// ⚠️ 形状照 `trash_screen.dart` 的 `_purge`（§8.2：破坏性动作不许手滑就触发），
  ///    两个按钮都 ≥44；字放大时这一屏会高过手机 ⇒ **要能滚**（§6.7 第 7 条那族）。
  Future<bool> _confirmRemove() async {
    final yes = await showDialog<bool>(
      context: context,
      // ⚠️ 形参**别叫 `d`** —— 那会把 `design.dart as d` 遮住（这一处踩过一次）
      builder: (dialogCtx) => AlertDialog(
        scrollable: true,
        title: const Text(desktopRemoveConfirmTitle),
        content: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(desktopRemoveConfirmLead),
            for (final one in desktopRemoveConfirmItems)
              Padding(
                // ⚠️ 间距走 `design.dart` 那几档（棘轮：`chat_screen.dart` 的写死尺寸只许少）
                padding: const EdgeInsets.only(top: d.gapXs),
                child: Text('· $one'),
              ),
            const Padding(
              padding: EdgeInsets.only(top: d.gapM),
              child: Text(desktopRemoveConfirmTail),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogCtx).pop(false),
            style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
            child: const Text(desktopRemoveConfirmNo),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogCtx).pop(true),
            style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
            child: const Text(desktopRemoveConfirmYes),
          ),
        ],
      ),
    );
    return yes == true;
  }

  /// **给它改个名字**（契约 `docs/dev/104-APP-MENU.md` §一 / 判据 C14）。
  ///
  /// 三步：① 弹出那一层（**预填现在的名字**）；②【算了】⇒ 一个请求都不发；
  /// ③【改好了】⇒ 发 `POST /api/app-rename {id, title}`（`id` = **服务端那一份的 id**），
  ///    成了就**重拉清单**（桌上那一格的字跟着变）＋ 如实说一句。
  ///
  /// ⚠️ **空名字本地就拦住**（`desktopRenameEmpty`）：发一个注定被拒的请求，
  ///    然后拿服务端那句工程话去解释，比不说更坏。
  Future<void> _renameMyApp(String id, String currentTitle) async {
    final name = await _askNewName(currentTitle);
    if (name == null || !mounted) return;
    final token = widget.controller.token;
    if (token == null) {
      _say(desktopRenameFailed);
      return;
    }
    final out = await widget.controller.api.appRename(token: token, id: id, title: name);
    if (!mounted) return;
    switch (out) {
      case AppEditOk():
        await _loadMyApps();
        if (mounted) _say(desktopRenameDone);
      case AppEditUnauthorized():
        _unauthorized();
      case AppEditFailed():
        // 🔴 没成 ⇒ 名字一个像素都不许变（"先说改了"就是界面在说假话）
        _say(desktopRenameFailed);
    }
  }

  /// 改名那一层：**一个输入框 ＋ 两个按钮**（照回收站那个二次确认的形状）。
  ///
  /// ⚠️ 输入框**预填现在的名字**（他要的多半是改一两个字，不是从头打一遍 ——
  ///    目标用户里有不会拼音的人，别让他打第二遍）。
  /// ⚠️ 返回 `null` = 【算了】/ 点外面 ⇒ 什么都不做；返回空串 = 他按了确定但没写字
  ///    （**本地就拦住**，别发一个注定被拒的请求）。
  Future<String?> _askNewName(String current) async {
    final v = await showDialog<String>(
      context: context,
      builder: (_) => _RenameDialog(initial: current),
    );
    if (v == null) return null;
    final name = v.trim();
    if (name.isEmpty) {
      _say(desktopRenameEmpty);
      return null;
    }
    return name;
  }

  /// **复制出一个新的一格**（契约 `docs/dev/104-APP-MENU.md` §一 / 判据 C15）。
  ///
  /// ⚠️ 新那一格的 **id 与名字由服务端定**（客户端不许猜）⇒ 成了之后**重拉清单**，
  ///    桌子照服务端那一份画（新那一格就自己长出来了）。
  Future<void> _copyMyApp(String id) async {
    final token = widget.controller.token;
    if (token == null) {
      _say(desktopCopyFailed);
      return;
    }
    final out = await widget.controller.api.appCopy(token: token, id: id);
    if (!mounted) return;
    switch (out) {
      case AppEditOk():
        await _loadMyApps();
        if (mounted) _say(desktopCopyDone);
      case AppEditUnauthorized():
        _unauthorized();
      case AppEditFailed():
        _say(desktopCopyFailed);
    }
  }

  /// **从桌面上删掉一个**（契约 `docs/dev/103-APP-DELETE.md` §一 / 判据 C6）。
  ///
  /// 四步，**一步都不许省**：
  ///   ⓪ 🔴 **第二次确认**（§七.4）：这一下会把**那一间**一起拿走 ⇒ 先提醒、再要一次确认
  ///      （【算了】⇒ 到这里就回去了，**一个请求都不发**）；
  ///   ① 请服务端把那一格拿走（`POST /api/app-remove {id}`；`id` = **服务端那一份的 id**）；
  ///   ② 🔴 **服务端明说成了**才**重新拉一遍** `/api/apps` —— 桌面上真的少一个，
  ///      不是"只把本地那一项抹掉"（C6 点名的就是这一条）；
  ///   ③ 没成 ⇒ **如实说一句**，而且**图标一个像素都不动**
  ///      （"先删了再说"就是界面上说假话）。
  ///
  /// ⚠️ 401 走 [`_unauthorized`]（**说一句 + 回登录页**），和回收站那一路同一句人话。
  Future<void> _removeMyApp(String id) async {
    if (!await _confirmRemove()) return;
    if (!mounted) return;
    final token = widget.controller.token;
    if (token == null) {
      // 没登录 ⇒ 请求根本发不出去；照样**如实说**（不许静默当成功）
      _say(desktopRemoveFailed);
      return;
    }
    final out = await widget.controller.api.appRemove(token: token, id: id);
    if (!mounted) return;
    switch (out) {
      case AppRemoveOk():
        // ★ 第二轮（契约 §七 · 决策 D3.11）：那一间**真被拿走了** ⇒ 两件跟着做：
        //   ① 他现在要是**正开着那一间**，回主对话（那间没了，别把他留在一个空洞里）；
        //   ② **这台设备上那一间的缓存一起丢掉** —— 它也算"那一间的数据"，
        //      不丢的话，"拿不回来"在本机还留着一份副本（哪天又被画出来就是"删了又回来"）。
        if (widget.controller.scope == id) {
          await widget.controller.setScope(mainScope);
        }
        await widget.controller.dropRoomCache(id);
        // ② 真的重拉一遍（桌面照服务端那一份画）。⚠️ 带上 `dropId`：万一这一次没问上，
        //    只把这一个从本地清单里去掉（它的去处服务端确认过了），**别的都不动**。
        await _loadMyApps(dropId: id);
        if (mounted) _say(desktopRemoveDone);
      case AppRemoveUnauthorized():
        _unauthorized();
      case AppRemoveFailed():
        // 🔴 失败 ⇒ 那句人话 + 图标留在原地（C6 的反例是"界面先删了、服务端其实没删"）
        _say(desktopRemoveFailed);
    }
  }

  /// **「我自己那台」那条通道**（契约 `docs/dev/81-HARNESS-ENTRY.md` §5.1 / §5.4）。
  ///
  /// 一个连接 = 对面一台 DSH：`say` 说一句、`stop` 收掉这一轮、断了就「重来」。
  /// ⚠️ 它**不自动重连**（悄悄重开一台不是"显示器 + 键盘"该做的事）。
  /// ⚠️ 它**只在这个入口开着的时候活着**：离开就收掉（对面不会留孤儿）。
  HarnessFeed? _harness;

  /// 造（或者拿）那一条通道，并且**接上**。
  ///
  /// ⚠️ 造完立刻 `open()`：一进去就该是"正在打开…"，而不是等用户点一下才动。
  /// ⚠️ 生产那条在 `services/harness_client.dart`（`/api/harness`，令牌用法同 `/api/stream`）。
  HarnessFeed _ensureHarness() {
    final old = _harness;
    if (old != null) return old;
    final make =
        widget.harnessFeed ??
        () => HarnessClient(
          base: widget.controller.api.base,
          token: widget.controller.token ?? '',
        );
    final feed = make();
    _harness = feed;
    feed.open();
    return feed;
  }

  /// 收掉这一头（**离开这个入口 = 对面把那一台停掉** —— 不留孤儿）。
  void _closeHarness() {
    final h = _harness;
    if (h == null) return;
    _harness = null;
    unawaited(h.close());
  }

  /// **那个次要入口**那三样（契约 `docs/dev/82-DEV-MODE.md` §五）。
  ///
  /// ⚠️ **取回来那条链接要缓存住**（有过期时间）⇒ 这条来源只造一次
  ///    （造两次 = 两个缓存 = 来回问）。
  /// ⚠️ 令牌**现取**（`DevHarnessClient` 拿的是个 getter）：登录是异步的。
  DevHarnessEntry? _devEntry;

  DevHarnessEntry _devHarnessEntry() =>
      _devEntry ??= DevHarnessEntry(
        source: DevHarnessClient(
          api: widget.controller.api,
          token: () => widget.controller.token ?? '',
        ),
        // ⚠️ 能不能开由**平台那一份**说（`services/links.dart` 的条件导出）；
        //    非网页那一侧它是 `false` ⇒ 那个入口**如实说打不开**，不去问也不要按钮。
        canOpen: canOpenLinks,
        openExternal: openExternal,
      );

  /// **打开一个小程序**：先把聊天收起（§6.4 规则 5），再记下"从哪儿开的"（那个图标的矩形）。
  ///
  /// ⚠️ **入口 URL 只有十分钟有效**（服务端现签、绑人绑版本）⇒ 页面开着不动、过一会儿再点图标，
  ///    那条 URL 就已经过期了，点开是空的。⇒ 快过期/已过期就先**重拉一次清单**再开。
  Future<void> _openMiniApp(Rect? from, String which) async {
    _floaterKey.currentState?.collapse();
    // ★ **「我自己那台」那一头跟着这个入口走**：开它 ⇒ 起这一条；
    //   开别的 ⇒ 把这一条收掉（一个连接 = 对面一台，走了就不许还挂着）。
    if (which == builtInHarnessId) {
      _ensureHarness();
    } else {
      _closeHarness();
    }
    if (which.startsWith(_minePrefix) &&
        (_mineStale(which) || _staleMine.contains(which.substring(_minePrefix.length)))) {
      // ★ 拿新的签名 URL；**或者**拿新那一版（听说"有新版"时 —— 契约 111 判据 U4：
      //   他当时没开，这里补上那次重拉，免得点开还是旧那一版）。
      await _loadMyApps();
      if (mounted) _staleMine.remove(which.substring(_minePrefix.length));
    }
    if (!mounted) return;
    setState(() {
      _appFrom = from;
      _openApp = which;
    });
    // 🔴 **跟着图标走**（契约 `83-APP-WORKSPACE.md` §五·甲）：
    //    打开哪个小程序，**下面那条聊天就是它的对话**。
    //    ⚠️ 判定是**纯函数**（`models/scope.dart`）：内置那几格（设置 / 发现 /
    //      「我自己那台」）和"我的小程序"一样**各回自己的 id**（B16「要分家」）——
    //      服务端 `BUILTIN_SCOPES` 把那几个名字登记成了合法房间。
    //    ⚠️ 它**不挡打开**：先把那一屏画出来（上面那个 `setState`），再换房间。
    unawaited(widget.controller.setScope(scopeOfOpenApp(which)));
  }

  /// 这一条的入口 URL 是不是**快过期或已经过期**了（留 60 秒余量）。
  bool _mineStale(String which) {
    final want = which.substring(_minePrefix.length);
    for (final a in _myApps) {
      if (a.id == want) {
        if (a.expiresAt <= 0) return false; // 没给到期时间 ⇒ 没得判，照开
        final left = a.expiresAt - DateTime.now().millisecondsSinceEpoch;
        return left < 60 * 1000;
      }
    }
    return false;
  }

  /// **退出登录**（主人 2026-09-22：它属于设置，不属于聊天 —— 抓手行不该管这个）。
  VoidCallback? _logout(ChatController c) => () async {
    await c.logout();
    widget.onLoggedOut();
  };

  /// 抓手行右边那一串动作（原来挂在 `AppBar.actions` 上）。
  ///
  /// ⚠️ **位置变了，理由要记住**：桌面出来之后顶栏那一条没有地方站了 ——
  ///    它会把"浮着"这件事拆掉（页面顶上一条实心栏 = 不是一个浮窗）。
  ///    ⇒ 搬进抓手行；宽度不够时靠**横滚**（`ChatFloater` 那边），**不靠藏**。
  List<Widget> _actions(ChatController c) => <Widget>[
    // ⚠️ **回收站**（契约 §二 第 2 条：放顶栏）。删掉的东西先进这儿，
    //    30 天内能拿回来 —— 顶栏这一处就是"我删的东西去哪了"的答案。
    //
    // ★ 2026-09-23（主人：*"先整理整个UI"*）：这三个原来**只有图标 + tooltip**，
    //   而手机上没有 hover ⇒ 用户只能瞎点（那排图标在展开态最显眼）。
    //   ⇒ 改成**图标 + 中文短标签**（D3.8 的同一条道理：不许只有无字图形）。
    //   ⚠️ 它们在浮窗里是**横向可滚**的（见 `chat_floater.dart`）⇒ 加字也不会把这一行撑高。
    TextButton.icon(
      style: _actionStyle,
      onPressed: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              TrashScreen(controller: c, onLoggedOut: widget.onLoggedOut),
        ),
      ),
      icon: const Icon(Icons.delete_outline),
      label: const Text(trashTooltip),
    ),
    // ⚠️ **导出**（契约 `30-EXPORT.md` §四：和删除入口**对称** ——
    //    能删掉，就能拿走）。位置**等主人看过再定，不属于契约**，
    //    所以这一批只保证"有一个能进去的入口"。
    TextButton.icon(
      style: _actionStyle,
      onPressed: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              ExportScreen(controller: c, onLoggedOut: widget.onLoggedOut),
        ),
      ),
      icon: const Icon(Icons.copy_all_outlined),
      label: const Text(exportTooltip),
    ),
    // ⚠️ **过程四档的入口**（契约 §五：位置等主人看过再定，
    //    所以这一批只做"能切"）。换档要重连（`level` 是连接级的）。
    TextButton.icon(
      style: _actionStyle,
      onPressed: () => _pickLevel(c),
      icon: const Icon(Icons.tune),
      label: const Text(levelActionWords),
    ),
  ];

  /// 顶栏那一排动作的样子（一处定、三个都照它）。
  ///
  /// ⚠️ **命中区 ≥44**（D3.6）+ 文字用主题里那一档（**不写死字号**）。
  static final ButtonStyle _actionStyle = TextButton.styleFrom(
    minimumSize: const Size(0, 44),
    padding: const EdgeInsets.symmetric(horizontal: 10),
  );

  /// **聊天区**（状态条 + 时间线）。⚠️ **不含输入条** —— 输入条由 `_composer` 单独给，
  /// 因为**收起态也要有它**（主人 2026-09-22：*"助手那个聊天窗口，收缩的时候也有一个输入框。"*）。
  /// ⇒ 而且必须是**同一个实例**：两个地方各建一个 Composer 的话，
  ///    "打了一半再展开"会换一个 `State`，**框里的字就丢了**。
  Widget _sheetBody(ChatController c) {
    return Column(
      // ⚠️ 这个键是**给闸用的**（见 `chatBodyKey`）
      key: chatBodyKey,
      children: [
        _StatusStrip(state: c.conn, error: c.lastError),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              // 内容列限宽（手册 D4.6 / R5）：平板上一行七十个字读不下去
              constraints: const BoxConstraints(maxWidth: 760),
              // ⚠️ **更早那句提示不许放在列表外面**（2026-09-23 实测栽过）：
              //    它一出现就会把列表的**视口**压小 —— 而"最老那条消息在不在树里"
              //    是 a11y 那条判据量的东西（3.1 倍字号下当场红）。⇒ 它现在当
              //    **列表的第一项**（见 `_body`），视口一个像素都不变。
              child: Stack(
                children: [
                  _body(c),
                  // ★ **回到最新**（用户自己翻走了才出现；他没翻走 = 本来就在最新）
                  //    ⚠️ 它是 `Positioned` ⇒ **不参与 Stack 的尺寸计算**，视口不受影响。
                  if (_userScrolledAway)
                    Positioned(
                      right: 8,
                      bottom: 8,
                      child: FilledButton.tonalIcon(
                        // 命中区 ≥44（D3.6）
                        style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
                        onPressed: _backToBottom,
                        icon: const Icon(Icons.arrow_downward, size: 18),
                        label: const Text(backToLatestWords),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
        // ★ **多选态**那条底栏工具条（契约 `docs/dev/106-CHAT-SELECT.md` §一）。
        //   ⚠️ 只在多选态出现 ⇒ 平时这一屏**一个像素都不变**
        //      （通知那条 D4.8："高度变化 = 0px" 量的是平时那一屏）。
        if (_selecting)
          BubbleSelectBar(
            count: _selectedIds.length,
            onCopy: () => _copySelected(c),
            onCancel: _exitSelect,
          ),
        SizedBox(height: MediaQuery.viewInsetsOf(context).bottom),
      ],
    );
  }

  /// **输入条**（收起态和展开态共用的**同一个**东西）。
  Widget _composer(ChatController c) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        child: Composer(
          // ★ **这一行最前面那个图标：这句话是在哪儿说的**（桌面 = 家；进了小程序 = 它自己的图标）。
          //   ⚠️ 2026-09-24：聊天窗口收成**一行**之后，它从抓手行搬到了这一行的最前面
          //      （主人：*"homeicon 放在聊天窗口左边"*）。
          leading: _scopeBadge(c),
          // ★ **打字框草稿**（主人 2026-09-22）：*"要有一个空的输入框，但如果用户输入过，
          //   没发送，则显示在上面作为草稿。草稿也是要记住的。"*
          //   ⚠️ 它和"已发未认领那句话"（`draft_store.dart`）**不是同一本账**。
          draft: c.composeDraft,
          onDraftChanged: c.saveComposeDraft,
          onDraftCleared: c.clearComposeDraft,
          // ★ **点了打字框 ⇒ 把窗口打开**（主人 2026-09-22：*"点击说点什么，聊天窗口会自动打开。"*）
          //   ⚠️ 收起态那条里也有这个框。展开**不会丢字**：两态用的是**同一个 Composer 实例**，
          //      Flutter 认得出它、把它**挪过去**（不是重建）—— 有判据钉着。
          onFocused: () => _floaterKey.currentState?.expand(),
          // ★ **读出来那个开关**（替掉原来演示用的"听筒/扬声器"）
          autoSpeak: c.autoSpeak,
          onToggleAutoSpeak: (on) => c.setAutoSpeak(on),
          canSpeak: canSpeak,
          // ★ **真开麦**（主人 2026-09-23：*"你做一下按钮。是按一下开始语音跟踪…
          //   再按一下结束。然后将文字展示出来。用户可以选择发送。"*）
          //   ⚠️ 开不了麦（不是网页 / 不是 https）⇒ **不画那个话筒**。
          canHear: canHear,
          hearing: c.hearing,
          onMicToggle: c.toggleHearing,
          // 🔴 **用户按下发送 ⇒ 最大化**（§6.2"发就拉满"）。
          //    ⚠️ 反过来不成立：**状态变化不许动窗口**（D4.8：新增助手消息的高度变化 = 0px）。
          //    ★ 现在**收起态也能发**（那儿也有输入框）⇒ 发出去就拉满，这一步比以前更有用。
          onSend: (text) {
            _floaterKey.currentState?.maximize();
            c.clearComposeDraft(); // 发出去了 ⇒ 上面那条草稿该消失
            c.send(text);
          },
        ),
      ),
    );
  }

  /// 时间线本体 + 尾巴上那一块**过程**（步骤流水 / 那行「它正在做…」）。
  ///
  /// ⚠️ 那一块**算在列表里**（会跟着滚），不是浮在输入框上面——
  ///    它是"这一轮正在发生"，属于对话流，不属于工具栏。
  /// **更早的消息那一条**（`null` = 一个字都不画）。
  ///
  /// ⚠️ 四种情形**各说各的**，尤其"没问到"与"到头了"不许混（那是假话）。
  Widget? _olderLine(ChatController c) {
    final loadedOlder = c.items.length > c.timeline.items.length;
    final String? text = c.olderLoading
        ? olderLoadingWords
        : c.olderFailed
        ? olderFailedWords
        : c.olderCapped
        ? olderCappedWords
        : (c.olderExhausted && loadedOlder)
        ? olderEndWords
        : null;
    if (text == null) return null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(color: d.muted),
      ),
    );
  }

  Widget _body(ChatController c) {
    if (c.items.isEmpty && !c.hasProcess) {
      // ★ **空房间要说清"这是哪间"**（契约 `83` §六·4："某个 app 还没有任何对话 ⇒
      //   给一句普通话（不是白屏）"）。⚠️ 同一个渲染口、同一套画法 ——
      //   只是**主对话**那一屏还是原来那句（那一间不属于任何小程序，没有名字可报）。
      return _EmptyState(roomApp: _roomAppTitle(c));
    }
    // ★ **更早那句提示当第一项**（放外面会改变视口 —— 见 `_sheetBody` 那条注释）
    final olderLine = _olderLine(c);
    final header = olderLine == null ? 0 : 1;
    // ★ `116`：先把"这一屏到底画哪几格"算出来（折叠就是把某些工具行换成那一个控件）。
    final slots = _planSlots(c);
    return NotificationListener<ScrollNotification>(
      // ⚠️ **只有手指拖出来的滚动**才算"用户自己翻走了"。
      //    我们自己 `animateTo` 产生的那一次不算 —— 否则第一次跟随
      //    就等于把自己关掉（那正是"打开停在最老"的另一种写法）。
      onNotification: (n) {
        // ⚠️ 两类分开判：`dragDetails` 不在基类 `ScrollNotification` 上，
        //    合在一个条件里 Dart 提升不出类型来（会报 undefined_getter）。
        // ⚠️ **要 setState**：那颗「回到最新」是按这个标志画的 ——
        //    只改字段不重建的话，用户翻上去了而按钮**不出现**（判据当场抓到过）。
        if (n is ScrollStartNotification && n.dragDetails != null && !_userScrolledAway) {
          setState(() => _userScrolledAway = true);
        }
        if (n is ScrollUpdateNotification && n.dragDetails != null && !_userScrolledAway) {
          setState(() => _userScrolledAway = true);
        }
        // ★ **滚到顶 ⇒ 往前取一页**（批 C：老消息往上翻着加载）
        if (n.metrics.pixels <= _olderTriggerPx) _maybeLoadOlder();
        return false;
      },
      child: ListView.builder(
        key: _transcriptKey,
        controller: _scroll,
        // ★ 主人 2026-09-22："聊天浮窗的 padding 减少一些"（里面这一圈）：12 → 8
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        itemCount: header + slots.length + (c.hasProcess ? 1 : 0),
        itemBuilder: (context, i) {
          if (header == 1 && i == 0) return olderLine!;
          final k = i - header;
          if (k < slots.length) return _renderSlot(slots[k], c);
          return ProcessTail(
            level: c.level,
            busyText: c.agentLine,
            steps: c.steps,
          );
        },
      ),
    );
  }

  /// **这一屏画哪几格**：真条目 + "折起来的那一轮"那一个控件。
  ///
  /// 规矩三条（都来自 DSH，见 `docs/dev/115-raw/B-render.md` §2.3）：
  ///   · **还在跑的那一轮不折**（过程行照画）；
  ///   · **收口之后**同一轮的工具行折成一个控件 —— 控件画在**第一条**那个位置
  ///     （哪一条是"答案"我们这一侧认不出来，见 `turn/usage` 那段：`message/*` 不带 step）；
  ///   · **系统提示词行不参与折叠**（DSH：它是 `TURN_PROCESS_INDEPENDENT_KINDS`），
  ///     用量行也不（它是这一轮的页脚）。
  List<_Slot> _planSlots(ChatController c) {
    final closed = c.closedThrough;
    final slots = <_Slot>[];
    // 一轮的用量只在**它最后一条** `turn/usage` 上画一次（服务端今天一轮发一条；
    // 多发也不许画出两行 —— 那会像"这一轮花了两次钱"）。
    final lastUsageSeq = <int, int>{};
    for (final it in c.items) {
      if (it is TimelineTurnUsage) lastUsageSeq[it.turn] = it.seq;
    }
    final placed = <int>{};
    for (final it in c.items) {
      if (it is TimelineToolCall && _processFolded(it.turn, closed)) {
        if (placed.add(it.turn)) slots.add(_FoldSlot(it.turn));
        continue;
      }
      if (it is TimelineTurnUsage && lastUsageSeq[it.turn] != it.seq) continue;
      slots.add(_ItemSlot(it));
    }
    return slots;
  }

  /// 画一格（真条目走 [_render]；折叠控件走它自己那一个）。
  Widget _renderSlot(_Slot slot, ChatController c) => switch (slot) {
    _ItemSlot(:final item) => _render(item, c),
    _FoldSlot(:final turn) => TurnProcessControl(
      counts: c.processOfTurn(turn),
      expanded: !_processFolded(turn, c.closedThrough),
      onToggle: () => setState(() {
        if (!_unfoldedTurns.remove(turn)) _unfoldedTurns.add(turn);
      }),
    ),
  };

  /// **离顶多近就触发"再往前取一页"**（住代码里；大一点更容易触发，但会多问几次）。
  static const double _olderTriggerPx = 32;

  /// 正在取 / 取到了几页 —— 防重入（用户一直往上蹭会call很多次）。
  bool _olderInFlight = false;

  /// **往前取一页，并且把视觉锚点钉住**。
  ///
  /// ⚠️ 为什么必须钉锚点：几页老消息**插在最前面** ⇒ 内容总高度变高，
  ///    而滚动偏移不变 ⇒ 用户眼前那一条会**突然往下跳**（看着像"刚才那些字跑了"）。
  ///    做法：取之前记下 `maxScrollExtent`，取完在 post-frame 里把偏移加上"长出来的那一段"。
  Future<void> _maybeLoadOlder() async {
    final c = widget.controller;
    if (_olderInFlight || c.olderLoading || c.olderExhausted) return;
    if (!_scroll.hasClients) return;
    final before = _scroll.position.maxScrollExtent;
    final atTop = _scroll.position.pixels;
    // ⚠️ **只有真的插进了内容才需要钉锚点**（2026-09-23 实测栽过）：
    //    "正在取更早的…"那句提示自己也会让 `maxScrollExtent` 变大一点点，
    //    要是照着它去 `jumpTo`，就会**把最老那条滚出视野** ——
    //    而"最老那条在不在树里"正是 a11y 那条判据量的东西（1.75x 下当场红）。
    final beforeCount = c.items.length;
    _olderInFlight = true;
    try {
      await c.loadOlder();
    } catch (_) {
      // ⚠️ **取更早的失败绝不许影响这一屏**：它是"多给一点历史"，不是主线。
      //    （控制器那边本来就把失败吞成 `olderFailed`；这里再兜一层，
      //      免得将来哪次改动把异常甩到滚动手势里 —— 那会让整屏都坏掉。）
    } finally {
      _olderInFlight = false;
    }
    if (!mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      if (c.items.length <= beforeCount) return; // 没取到东西 ⇒ **一个像素都别动**
      final grew = _scroll.position.maxScrollExtent - before;
      if (grew > 0) _scroll.jumpTo(atTop + grew);
    });
  }

  /// 回到最新那一条（用户自己翻走之后才出现那个按钮）。
  void _backToBottom() {
    if (!_scroll.hasClients) return;
    _userScrolledAway = false;
    _scroll.animateTo(
      _scroll.position.maxScrollExtent,
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOut,
    );
    setState(() {});
  }

  /// 打开四档的切换面板。**选中即生效**（换档会重连，见 `setLevel`）。
  Future<void> _pickLevel(ChatController c) async {
    await showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => ProcessLevelMenu(
        current: c.level,
        onPick: (level) {
          Navigator.of(sheet).pop();
          c.setLevel(level);
        },
      ),
    );
  }

  Widget _render(TimelineItem item, ChatController c) => switch (item) {
    UserUtterance() => UserBubble(
      utterance: item,
      // 🔴 多选态里**别的动作一个都不许触发**（契约 §一 + S6）：
      //    重发不给、长按菜单不给，点气泡只走 `onTap`（切换选中）。
      onResend: _selecting ? null : () => c.resend(item.messageId),
      onLongPress: _selecting ? null : () => _onBubbleLongPress(c, item),
      selected: _selecting && _selectedIds.contains(item.messageId),
      onTap: _selecting ? () => _toggleSelect(item.messageId) : null,
    ),
    AssistantMessage() => _answer(item, c),
    TimelineMarker() => MarkerLine(marker: item),
    // ★ **系统通知那一条**（契约 `29-NOTICE.md` 约束 2）：进列表、跟着滚、
    //   占一个位置。有 `undo` 时在这儿也渲染撤销（约束 3）——
    //   ⚠️ 按下去走的是**同一条路**（`_undoNotice` → `c.undoNotice()`）。
    TimelineNotice() => NoticeLine(
      notice: item.notice,
      onUndo: item.undo == null ? null : () => _undoNotice(item),
    ),
    // ── ★ `116` 那三样（主人 2026-09-26：*"首先全部开放"*）──────────
    //
    // ⚠️ 折叠**不在这里做**：折起来的那几行由 `_planSlots` 换成那个控件、
    //    **根本不会走到这儿**（少画 = 真省，不是画出来再藏）。
    TimelineToolCall() => ToolRowView(key: ValueKey('tool:${item.callId}'), row: item.row),
    TimelineSystemPrompt() => SystemPromptView(
      key: ValueKey('sys:${item.seq}'),
      row: item.row,
    ),
    // ⚠️ 用量那一行**由控制器折过**才画（`turnUsage`：任何一次没报准 ⇒ null ⇒ 一个像素不占）。
    TimelineTurnUsage() => TurnUsageRowView(usage: c.turnUsage(item.turn)),
  };

  /// 按"撤销"（**浮窗里那个与时间线里那个共用这一条**，约束 3）。
  ///
  /// [from] 不传 = 浮窗里那个；传了 = 时间线里那一条
  /// （⚠️ 两者的 undo **各读各的**：浮窗会自己消失，时间线那一条不会）。
  ///
  /// ⚠️ 成没成都如实说（N11）——用词与回收站那一页**同一句**
  ///    （同一件事同一句话，别再新造一个说法）。
  Future<void> _undoNotice([TimelineNotice? from]) async {
    final r = await widget.controller.undoNotice(from: from);
    if (!mounted || r == null) return;
    switch (r) {
      case TrashOk():
        _say(trashRestoredLine);
      case TrashUnauthorized():
        _unauthorized();
      case TrashFailed():
        _say(trashRestoreFailedLine);
    }
  }

  /// 401：**说一句 + 回登录页**（欠账 **#25**）。
  ///
  /// ⚠️ 只说话不回去 = 用户停在一个永远读不出来的界面上，反复点重试
  ///    （"令牌过期了"不是一个能靠重试解决的问题，得重新登录）。
  /// ⚠️ 顺序：**先说话再走** —— 那句话挂在**根**的 `ScaffoldMessenger` 上，
  ///    所以换成登录页之后它仍然看得见（用户得知道**为什么**被退回来）。
  void _unauthorized() {
    _say(trashUnauthorizedLine);
    widget.onLoggedOut();
  }

  /// 一条回答：气泡 + （第 ④ 档时）**它自己那条**的思考原文。
  ///
  /// ⚠️ 推理原文摆在**它那条气泡的正下方**，不是对话流尾巴上：
  ///    主人回头看的是"这条回答当时怎么想的"——挂尾巴上会跟着下一轮跑掉。
  /// ⚠️ 它与气泡是**两个容器**（D7.4：它不是它说的话）。
  Widget _answer(AssistantMessage m, ChatController c) {
    final reasoning = c.reasoningOf(m);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AnswerBubble(
          message: m,
          // 🔴 多选态里长按 / 打开链接 / 念出来都不给（同 `_render` 那条）——
          //    点气泡只走 `onTap`（切换选中）。
          onLongPress: _selecting ? null : () => _onBubbleLongPress(c, m),
          // ⚠️ 开不了外面的地址就传 `null` ⇒ 出处只当文字（**不画按不动的按钮**）
          onOpenSource: _selecting ? null : (canOpenLinks ? openExternal : null),
          // ★ **读一遍**（每条都能念；念不了就传 `null` —— 同一条规矩）
          onSpeak: _selecting
              ? null
              : (canSpeak ? () => c.speakMessage(m.messageId, m.displayText) : null),
          onStopSpeak: c.stopSpeakingNow,
          speaking: c.speakingId == m.messageId,
          selected: _selecting && _selectedIds.contains(m.messageId),
          onTap: _selecting ? () => _toggleSelect(m.messageId) : null,
        ),
        if (reasoning.isNotEmpty) ReasoningBlock(text: reasoning),
      ],
    );
  }

  // ── 长按气泡 → 复制 / 多选 / 删掉（契约 `28-DELETE.md` + `106-CHAT-SELECT.md`）──

  /// 长按气泡：先弹菜单，选中哪一项就走哪一条（§四：删前必须列清单）。
  ///
  /// ⚠️ 一次问答 = 一轮 = 两个 `messageId`（§三·补）——那两个 id 由
  ///    `ChatController.turnMessageIds` 从**画得出来的**那几条里算出来。
  ///    算不出来（比如这句还没发出去）⇒ **连入口都不给**：那会是一个
  ///    "看起来能删、其实服务端没有它"的动作。
  /// ⚠️ 这一条**管着三项**：进不来的那条（不在任何一轮里）三项都不给 ——
  ///    契约 `106` 的【复制】【多选】只说了"长按任意一条"，
  ///    而"还没发出去的那句"在界面上本来就没有长按入口（§四 没要求改它）。
  Future<void> _onBubbleLongPress(ChatController c, TimelineItem item) async {
    final id = item.messageId;
    if (id == null) return;
    final ids = c.turnMessageIds(id);
    if (ids == null) return;

    final action = await showModalBottomSheet<BubbleAction>(
      context: context,
      builder: (_) => const BubbleMenu(),
    );
    if (!mounted) return;
    switch (action) {
      case BubbleAction.copy:
        await _copyOne(item);
      case BubbleAction.select:
        _enterSelect();
      case BubbleAction.delete:
        await _deleteTurn(c, ids);
      case null:
        return; // 划掉 / 点了"算了" ⇒ 什么都不做
    }
  }

  // ── 复制 / 多选（契约 `docs/dev/106-CHAT-SELECT.md`）────────────

  /// 复制**一条**：复制的是 `bubbleBodyOf` 给的那串正文（§二 的表）。
  ///
  /// ⚠️ 空正文 ⇒ **如实说一句**，而且**剪贴板一个字节都不碰**
  ///    （把空串塞进去还说"复制好了" = 屏幕说假话，§二 的 🔴）。
  /// ⚠️ 剪贴板写入**由他那一下手势触发**（§二 的 ⚠️：网页上读剪贴板要手势，
  ///    顺手写是同一个道理）—— 所以这里**只在按下【复制】之后**写，
  ///    任何"进来顺手先复制一份"的写法都是错的。
  Future<void> _copyOne(TimelineItem item) async {
    final body = bubbleBodyOf(item);
    if (body.isEmpty) {
      _say(bubbleCopyEmptyLine);
      return;
    }
    if (!await _writeClipboard(body)) return;
    _say(bubbleCopiedLine);
  }

  /// 进多选态。**选中清单从空开始**（长按那一条不预选，见 `_selectedIds`）。
  void _enterSelect() {
    setState(() {
      _selecting = true;
      _selectedIds.clear();
    });
  }

  /// 退出多选态。**剪贴板一个字节都不碰**（判据 S5）。
  void _exitSelect() {
    setState(() {
      _selecting = false;
      _selectedIds.clear();
    });
  }

  /// 多选态里点气泡 = **只切换选中**（判据 S3 / S6）。
  void _toggleSelect(String messageId) {
    setState(() {
      if (!_selectedIds.add(messageId)) _selectedIds.remove(messageId);
    });
  }

  /// 多选态点【复制】：**按时间顺序、一条一行**，做完**退出多选态**（判据 S4）。
  ///
  /// ⚠️ 顺序用 `c.items` 自己的顺序（它按 `(seq, tie)` 排过 = 时间顺序）——
  ///    在这里另排一次（比如按点选顺序）就是"顺序反了"那条反例。
  /// ⚠️ 一条能复制的都没有 ⇒ 如实说，**既不碰剪贴板也不退出**
  ///    （什么都没做，就没有"做完"可言）。
  Future<void> _copySelected(ChatController c) async {
    final bodies = bubbleBodiesOf(
      c.items,
      keep: (it) => it.messageId != null && _selectedIds.contains(it.messageId),
    );
    if (bodies.isEmpty) {
      _say(bubbleCopyEmptyLine);
      return;
    }
    if (!await _writeClipboard(bodies.join('\n'))) return;
    if (!mounted) return;
    _exitSelect();
    _say(bubbleCopiedManyLine(bodies.length));
  }

  /// 真的写剪贴板。返回有没有写成功（失败时**如实说**，见 `bubbleCopyFailedLine`）。
  ///
  /// ⚠️ 包一层 try：剪贴板是平台通道，写不进去（权限 / 没有那个通道）时
  ///    抛出来会打断手势，而**沉默**更坏 —— 用户会以为复制好了，粘出去却是空的。
  Future<bool> _writeClipboard(String text) async {
    try {
      await Clipboard.setData(ClipboardData(text: text));
      return true;
    } catch (_) {
      _say(bubbleCopyFailedLine);
      return false;
    }
  }

  /// 删掉这一轮：**清单 → 确认 → 删**。
  Future<void> _deleteTurn(ChatController c, List<String> ids) async {
    final plan = await c.planDelete(ids);
    if (!mounted) return;
    switch (plan) {
      case TrashOk(:final value):
        final yes = await showModalBottomSheet<bool>(
          context: context,
          isScrollControlled: true,
          builder: (_) => TrashPlanSheet(plan: value),
        );
        if (yes != true || !mounted) return;
        final done = await c.removeTurn(ids);
        if (!mounted) return;
        // ⚠️ 成没成都**如实说**：这一步错了的话用户会以为删掉了（或以为没删）。
        switch (done) {
          case TrashOk():
            _say(trashDeletedLine);
          case TrashUnauthorized():
            _unauthorized();
          case TrashFailed():
            _say(trashDeleteFailedLine);
        }
      case TrashUnauthorized():
        _unauthorized();
      case TrashFailed():
        // ⚠️ 清单都拿不到 ⇒ **一个字都不许删**（"先看清单"这一步不许绕）。
        _say(trashPlanFailedLine);
    }
  }

  void _say(String line) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(line)));
  }
}

/// **时间线上一格**（`116`）：要么是一条真条目，要么是"折起来的那一轮"那一个控件。
///
/// ⚠️ 为什么要这一层：折叠之后**那一轮的工具行根本不建**（不是画出来再藏）——
///    DSH 那边是靠 `hidden` 藏（浏览器 Ctrl-F 还找得到），我们这一侧没有那个机制，
///    所以选择"少画"；代价是折起来的过程行**屏幕上搜不到**（如实记在这儿）。
sealed class _Slot {
  const _Slot();
}

/// 一格真条目（照旧走 `_render`）。
class _ItemSlot extends _Slot {
  const _ItemSlot(this.item);
  final TimelineItem item;
}

/// 一格"这一轮折起来了"那个控件。
class _FoldSlot extends _Slot {
  const _FoldSlot(this.turn);
  final int turn;
}

/// 顶部状态条。**只在"需要用户知道点什么"的时候出现**——
/// 一切正常的时候它不该占地方（那会变成一种噪音）。
class _StatusStrip extends StatelessWidget {
  const _StatusStrip({required this.state, this.error});

  final ConnState state;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // 屏幕上那句话在 `models/conn_state.dart` 里（纯函数，进硬闸）——
    // ⚠️ 别在这里直接写死："网断了"这句话曾经在网没断的时候也显示（那是一次事故）。
    final (String? text, bool isError) = statusLine(state, error: error);
    if (text == null) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      color: isError
          ? theme.colorScheme.errorContainer
          : theme.colorScheme.surfaceContainerHighest,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Text(text, style: theme.textTheme.bodySmall),
    );
  }
}

/// 空屏。手册 D1/D3：**不许写"你好，我能帮你做什么"**（人格硬规则禁止留客式追问）。
///
/// 🔴 **2026-09-22：它原来不可滚，被浮窗那一刀当场判红。**
/// 桌面出来之后，浮窗能用的高度变少了（屏高 − 四边 30 − 桌面那一条），
/// 3.1 倍字号下这一块只分到 **104px**，而它自己要 **272px**
/// ⇒ `RenderFlex overflowed by 168 pixels`（五档不溢出那道硬闸抓的）。
/// 修法不是"把字写小"，而是**让它在没地方时能滚**（有地方时仍然居中）：
/// 容器跟字算，地方不够就滚 —— 这跟 `ListView` 那条时间线是同一个姿势。
///
/// ⚠️ **2026-09-25（批 4）**：多了一个 [roomApp] —— 空的是**某个小程序那一间**时，
///    要说清"这是哪间"（契约 `83` §六·4：不是白屏、也不是一句放到哪儿都对的话）。
///    主对话（`roomApp == null`）那一屏**一个字都不变**。
class _EmptyState extends StatelessWidget {
  const _EmptyState({this.roomApp});

  /// 空着的是哪一个小程序那一间（`null` = 主对话 / 名字一时查不到）。
  final String? roomApp;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final app = roomApp;
    return LayoutBuilder(
      builder: (ctx, cons) => SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: ConstrainedBox(
          // 有地方 ⇒ 撑满并居中；没地方 ⇒ 内容说了算，滚
          constraints: BoxConstraints(minHeight: cons.maxHeight - 64),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                app == null ? '说点什么' : roomEmptyTitle,
                style: theme.textTheme.titleMedium,
              ),
              const SizedBox(height: 12),
              Text(
                // 说清"能干什么"，不是"我是什么"
                // ⚠️ 空的是某个小程序那一间 ⇒ 说清"在这间说话会记在哪儿"
                //    （这一句在 `space_words.dart`，和别的界面文案一起过禁词闸）
                app == null
                    ? '记一笔账、问一件事、让它去查个东西。\n'
                          '它会把做过的事说给你听。'
                    : roomEmptyLine(app),
                style: theme.textTheme.bodyMedium,
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 改名那一层（契约 `docs/dev/104-APP-MENU.md` §一 · 判据 C14）。
///
/// ⚠️ **它自己持有那个 `TextEditingController`**，理由很实（2026-09-25 实测栽过）：
///    在 `showDialog` 返回之后马上 `dispose()` 它 ⇒ 弹层**还没拆完**，里面的输入框
///    还在用 ⇒ 当场抛 `A TextEditingController was used after being disposed`。
///    ⇒ 交给这一层（`State.dispose` 是框架在真正卸载时调的）。
class _RenameDialog extends StatefulWidget {
  const _RenameDialog({required this.initial});

  /// 现在的名字（**预填**：改一两个字的人不用从头打一遍）。
  final String initial;

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final TextEditingController _name = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      // 字放大到 3.1 倍时这一层会高过手机 ⇒ **要能滚**（§6.7 第 7 条那族）
      scrollable: true,
      title: const Text(desktopRenameTitle),
      content: TextField(
        controller: _name,
        autofocus: true,
        decoration: const InputDecoration(hintText: desktopRenameHint),
        onSubmitted: (_) => Navigator.of(context).pop(_name.text),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
          child: const Text(desktopRenameNo),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_name.text),
          style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
          child: const Text(desktopRenameOk),
        ),
      ],
    );
  }
}
