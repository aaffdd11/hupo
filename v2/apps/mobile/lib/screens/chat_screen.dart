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
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;
import 'package:flutter/scheduler.dart' show SchedulerBinding;
import 'package:flutter/services.dart';

import '../models/appearance.dart';
import '../models/dev_harness.dart';
import '../models/image_outcome.dart';
import '../models/chat_time.dart';
import '../models/conn_state.dart';
import '../models/chat_select.dart';
import '../models/design.dart' as d;
import '../models/desktop_words.dart';
import '../models/landing_words.dart';
import '../models/dsh_design.dart';
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
import '../models/voice_try.dart';
import '../models/voice_record.dart';
import '../models/wallpaper.dart';
import '../services/api.dart';
// ★ **录一段（录音 ＋ 回放）**：本机那一套（`services/recorder.dart` 的条件导出）。
//   ⚠️ 取一个前缀：`canRecord` / `play` 这种名字在这里太容易和其它含义撞。
import '../services/recorder.dart' as rec;
import '../services/appearance_store.dart';
import '../services/chat_controller.dart';
import '../services/dev_harness_client.dart';
import '../services/harness_client.dart';
import '../services/links.dart';
import '../services/hearing.dart';
import '../services/speech.dart';
import '../services/wallpaper_store.dart';
import '../widgets/app_desktop.dart';
import '../widgets/app_grants_ask.dart';
import '../widgets/appearance_scope.dart';
import '../widgets/dsh_look.dart';
import '../widgets/harness_pane.dart';
import '../widgets/job_ask_sheet.dart';
import '../widgets/mini_app_icons.dart';
import '../widgets/plan_strip.dart';
import '../widgets/bubble_select_bar.dart';
import '../widgets/bubble_menu.dart';
import '../widgets/bubbles.dart';
import '../widgets/chat_floater.dart';
import '../widgets/mini_app_host.dart';
import '../widgets/voice_bar.dart';
import '../widgets/mini_app_frame.dart';
import '../widgets/notice.dart';
import '../widgets/queue_strip.dart';
import '../widgets/process_view.dart';
import '../widgets/time_mark.dart';
import '../widgets/tool_row_view.dart';
import '../widgets/trash_plan_sheet.dart';
import 'discover_screen.dart';
import 'hear_drill_screen.dart';
import 'settings_screen.dart';

/// "下面那一整块"的名字（状态条 + 内容 + 输入框）。
///
/// ⚠️ **给闸用的**：契约 `29-NOTICE.md` 约束 1 的判据是 **D4.8：高度变化 = 0px**，
///    而"变化"必须量在**同一个东西**上 —— 就是这一块。它一直都在
///    （通知来之前是空屏、来之后是列表），所以前后比它才是 0px 的判据。
const Key chatBodyKey = Key('chat-body');

/// **聊天条最前面那颗 home**（主人 2026-09-27：*"点击 home 就是回到桌面"*）。

/// 进小程序之后那条浮窗（同一天：*"点击 home 那个 icon 上面会有一个浮窗"*）。
const Key chatHomeHintKey = Key('chat-home-hint');

/// 那颗 home 的**图形**多大（原来 18 —— 主人 2026-09-27：*"扩大一些"*）。
const double homeButtonIcon = 22;


/// 那颗 home 的**命中区**（D3.6：≥44；图形摆在中间，四周透明）。
const double homeButtonHit = 44;

/// 那条浮窗**自己待多久**（主人：*"大概停留 3~4 秒钟"*）—— 取中间，3.5 秒。
/// ⚠️ 它是一句"告诉你出口在哪"的话，不是待办：**到点自己走**，不用他点。
const Duration homeHintFor = Duration(milliseconds: 3500);

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

class _ChatScreenState extends State<ChatScreen> with WidgetsBindingObserver {
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

  /// ★ **进小程序之后那条浮窗**（主人 2026-09-27）：现在正画着吗。
  /// ⚠️ 它与 `_openApp` **不是一回事**：关掉那一屏之后它可能还在（3.5 秒没到），
  ///    所以他还能看到"点这里回桌面"那句话 —— 但它**在输入条上面浮着**，不挡任何东西。
  bool _homeHint = false;

  /// 那条浮窗**到点自己走**用的钟（换屏/离开这一屏都要收掉）。
  Timer? _homeHintTimer;

  /// 聊天**展开着**吗（展开 = 桌面小程序被盖住 —— 手册 §6.4 规则 2/3）。
  /// ⚠️ 由浮窗自己报（它换档时调 `onTier`），不是这里猜的。
  bool _floaterExpanded = false;

  /// 浮窗现在**占多高**（含它自己那条）。收起档的高度是**内容算出来**的（D3.5）
  /// ⇒ 只能等它画完再报；这里拿它给小程序内容做**底部内缩**（§6.4 规则 1）。
  /// **收起档那一条的高度**（只往下记 ⇒ 一旦量到就不再变）。
  ///
  /// 🔴 **它必须是个"稳定值"**（2026-10-01 主人报：*「性能变得非常差，开关动效全没了。」*）：
  ///    小程序那一层（Web 上是**真的 `<iframe>`**）的底边内缩**不能跟着浮窗当前高度走** ——
  ///    `onHeight` 是**每帧**都会报一次的，一旦那个数成了平台视图的**布局输入**，
  ///    那个 iframe 的 DOM 盒子就**每帧被 resize 一次**（Web 上最贵的一件事）；
  ///    而"开一个小程序"那一下**浮窗自己也在收**（两个动画叠着）⇒ 整段动画直接卡没。
  ///    ⇒ 这里取**历次报数里的最小值**（= 收起档那一条），它不随档位/拖动变。
  ///    ⚠️ **展开档不用管**：那一下 `covered` 为真 ⇒ 这一层**本来就不收指针事件**
  ///      （`mini_runtime_web.dart` 的 `setMiniAppsInteractive(false)`），
  ///      而且展开档是**不透明**的（`chat_floater.dart`）—— 它自己就把底下挡严了。
  double _barH = 0;

  /// 用户**自己往上翻过**没有。
  ///
  /// ⚠️ 这个布尔是欠账第 24 条的修法里唯一的新状态：
  ///    在此之前，"要不要跟到底部"只看"离底部近不近"，
  ///    而**首屏 `pixels == 0` 对上一屏历史** ⇒ 那个判据恒为 false
  ///    ⇒ **打开就停在最老那一条**。判据本身搬去了 `models/scroll_follow.dart`。
  bool _userScrolledAway = false;

  /// **上一次"看得见的那块地方"有多高**（屏高 − 键盘）。
  ///
  /// 🔴 2026-09-30 主人报的真缺陷：*「输入法打开的时候，页面被覆盖，无法显示最新消息。」*
  ///    现场（真浏览器 · 手机 UA · 390 宽 · 键盘 300）：浮窗**正确地**让开了键盘，
  ///    可**时间线自己没跟到底** —— 视口变矮时 Flutter **不会**替我们把滚动位置收到底，
  ///    于是刚才在最下面那条"最新的话"被挤到**看得见的那块地方之外**
  ///    （前后两张截图：键盘弹起前最下面是「我现在接不上活…」，弹起后变成更早的一条）。
  ///    ⇒ 记着这个高度，**一变就拿既有那条规则重新对一次**（见 [didChangeDependencies]）。
  double? _lastVisibleH;

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

  // ── ★ 批次 4：聊天窗口的外观与字号（契约 `docs/dev/119`）────────────
  //
  // 这一屏是**这两样的主人**：设置页那两行写的是这里的状态，`AppearanceScope`
  // 把解析之后的色板与字号轴发给聊天面每一个用 token 的控件。
  // ⇒ "改一下马上生效"是**结构**保证的（同一个 `setState` 里既写盘又重建那一棵子树），
  //    不靠重连、不靠刷新。

  /// 用户选的那两样（默认 = 跟随系统 ＋ 14 字）。
  ///
  /// 🔴 **2026-09-29 起它是一个 `ValueNotifier`**（外面包一个同名 getter）：
  ///    设置里那些子页是 `push` 出来的**新路由** —— 它们**不在**这一屏 `setState`
  ///    的那棵子树里，只拿到一份"推出去那一刻"的快照 ⇒ 在子页里连按两下步进器
  ///    会**按着旧值算**（实测：14 →大一点→ 15，再按小一点 ⇒ **13**，
  ///    而页面上那个数字还写着 14 —— 那是"页面在说假话"）。
  ///    ⇒ 状态还是**只有这一份**，只是它现在**会通知**订阅者（子页订阅它）。
  final ValueNotifier<ChatAppearanceSettings> _appearanceVN =
      ValueNotifier<ChatAppearanceSettings>(const ChatAppearanceSettings());

  ChatAppearanceSettings get _appearance => _appearanceVN.value;

  /// 它存在哪（**按设备**；照 `process_level_store.dart` 那一对）。
  final _appearanceStore = AppearanceStore();

  /// 进来时读一次"上次选的亮暗与字号"（读不出来 ⇒ 默认档 —— 见 `AppearanceStore`）。
  ///
  /// ⚠️ **读盘是异步的**：第一帧可能是默认档（亮/14），读到之后才换成他选的那一档。
  ///    这是**刻意**的取舍：把它变成"先等盘、再画第一帧"会让冷启动多一帧空白，
  ///    而那一帧空白的代价比"闪一下默认外观"大（首屏那一条见 `17-LOCAL-FIRST.md`）。
  Future<void> _loadAppearance() async {
    final s = await _appearanceStore.read();
    if (!mounted || s == _appearance) return;
    setState(() => _appearanceVN.value = s);
  }

  /// 用户换了一档外观（设置页那三个之一）。
  void _setAppearance(ChatAppearance a) {
    if (a == _appearance.appearance) return; // 点当前那一档 = 空动作（切换器里不许有死键）
    final next = _appearance.copyWith(appearance: a);
    setState(() => _appearanceVN.value = next);
    // 存不上也得能用（这一次会话里屏幕上是对的）。
    unawaited(_appearanceStore.write(next));
  }

  /// 用户换了字号（设置页那个步进器）。**值已经夹在 12–17**（到边界按钮就按不动）。
  void _setFontSize(int size) {
    final n = chatFontSizeOf(size);
    if (n == _appearance.fontSize) return;
    final next = _appearance.copyWith(fontSize: n);
    setState(() => _appearanceVN.value = next);
    unawaited(_appearanceStore.write(next));
  }

  // ── ★ 2026-09-29：桌面那张壁纸（契约 `docs/dev/131-WALLPAPER.md`）──────
  //
  // 形状与上面外观/字号**一模一样**（同一套纪律、同一对读写）：
  //   · 状态住**这一屏**（`_wallpaper`）：设置页只是它的入口；
  //   · **按设备**存（`WallpaperStore`，key `hupo_wallpaper`）；
  //   · 换一下 ⇒ **同一个 `setState` 里既写盘又重建桌面**（不刷新、不重连）。

  /// 桌面现在铺的是哪一张（`''` = 不设 —— 那张暖纸）。
  ///
  /// ⚠️ 与 `_appearance` 同一条：**`ValueNotifier` ＋ 同名 getter**，
  ///    因为「壁纸」那一页也是 `push` 出来的新路由（订阅它才看得到当前那一张）。
  final ValueNotifier<String> _wallpaperVN = ValueNotifier<String>(wallpaperNone);

  String get _wallpaper => _wallpaperVN.value;

  final _wallpaperStore = WallpaperStore();

  /// 进来时读一次壁纸。**两段走**（2026-10-04 起 · 契约 `docs/dev/183`）：
  ///
  ///   ① 先按**本机缓存**画（离线 / 慢网也不白屏、不闪一下 —— 与 `_loadAppearance` 同一条取舍）；
  ///   ② 再问**账号那一份**（壁纸跟着账号走）：
  ///      · 问上了、跟我这儿不一样 ⇒ **换成账号那一张**（这就是"换台设备也看得见"）；
  ///      · 账号里**没记录**、而我这台有 ⇒ **把本机这份顶上去**
  ///        （老用户升级上来的第一下：他挑过的那张不该被"没记录"抹成默认）；
  ///      · **没问上** ⇒ 什么都不动（网不通不等于他改了）。
  ///   ③ 顺带补一次"上次没同步上的那一下"（`pending`）。
  Future<void> _loadWallpaper() async {
    final local = await _wallpaperStore.read();
    if (mounted && local != _wallpaper) setState(() => _wallpaperVN.value = local);

    final token = widget.controller.token;
    if (token == null) return; // 还没登录 ⇒ 只有本机这一份（不问、不写）
    final pending = await _wallpaperStore.readPending();
    final remote = await widget.controller.api.prefsWallpaper(token);
    final r = resolveWallpaper(remote: remote, local: local);
    if (!mounted) return;
    if (r.pushUp) {
      unawaited(_pushWallpaper(token, r.value));
    } else if (pending && remote != null) {
      // 他上次在这台设备上挑的那张没写进账号 ⇒ 补一次（网通了就补上）
      unawaited(_pushWallpaper(token, local));
    }
    if (remote != null && !r.pushUp && r.value != local) {
      await _wallpaperStore.write(r.value);
      if (mounted) setState(() => _wallpaperVN.value = r.value);
    }
  }

  /// 把"本机这一张"写进账号（写成了就清掉 `pending`）。
  Future<void> _pushWallpaper(String token, String id) async {
    final ok = await widget.controller.api.setWallpaperPref(token, id);
    await _wallpaperStore.writePending(!ok);
  }

  /// 用户挑了一张（设置里那一格）。**认不出来的一律当"不设"**（模型那一层兜底）。
  ///
  /// ⚠️ **先把本机这一份写死、屏幕当场换**（他按下就该看见），**然后**才去写账号：
  ///    账号那一下没成 ⇒ 留个 `pending`，下次开机会补（**不许假装同步上了**）。
  void _setWallpaper(String id) {
    final n = wallpaperOf(id);
    if (n == _wallpaper) return; // 点当前那一张 = 空动作（不许有死键）
    setState(() => _wallpaperVN.value = n);
    unawaited(_saveWallpaper(n));
  }

  Future<void> _saveWallpaper(String n) async {
    await _wallpaperStore.write(n);
    final token = widget.controller.token;
    if (token == null) {
      await _wallpaperStore.writePending(true); // 登录之后补
      return;
    }
    await _pushWallpaper(token, n);
  }

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
    // ★ **2026-10-04：他离开这一屏 / 回到这一屏，桌面都要重拉一次**（见 `didChangeAppLifecycleState`）
    WidgetsBinding.instance.addObserver(this);
    // ★ **"读出来"这个开关**存盘读过一次（设备级偏好；读不出来当关）。
    unawaited(widget.controller.loadAutoSpeak());
    // ★ **我的小程序**（乙-1）：登录之后拉一次。⚠️ 拉不到就是空清单，**不许**因此把界面弄坏。
    unawaited(_loadMyApps());
    // ⚠️ **首屏也要跟一次**：本机缓存那一屏（`17-LOCAL-FIRST.md`）可能
    //    在挂载之前就已经在控制器里了，那时 `_onChanged` 一次都不会触发。
    WidgetsBinding.instance.addPostFrameCallback((_) => _followBottom());
    // ★ `116`：焦点离开时间线时，把那次"因为焦点在里面而推迟的折叠"补上。
    FocusManager.instance.addListener(_onFocusChanged);
    // ★ 批次 4：进来先读一次"上次选的亮暗与字号"（读不出来 ⇒ 跟随系统 ＋ 14）。
    unawaited(_loadAppearance());
    // ★ 2026-09-29：桌面那张壁纸（读不出来 ⇒ 那张暖纸）。
    unawaited(_loadWallpaper());
  }

  /// 🔴 **"看得见的那块地方"变了 ⇒ 时间线重新对一次底**（2026-09-30 主人报的真缺陷）。
  ///
  /// 现场：*「输入法打开的时候，页面被覆盖，无法显示最新消息。」*
  /// 真浏览器读数（手机 UA · 390 宽 · 键盘 300，见 `docs/dev/142-IME-LATEST-MESSAGE.md`）：
  ///   · 浮窗**是对的** —— 输入条让开键盘（编辑元素 `y 648 → 348`，正好 300）；
  ///   · 时间线**没跟** —— 键盘弹起前最下面是「我现在接不上活…」（最新那条），
  ///     弹起后最下面变成更早的一句 ⇒ **最新的话被挤到看得见的地方之外**。
  ///
  /// 为什么：视口变矮时 Flutter **不会**替我们把滚动位置收到底
  /// （`maxScrollExtent` 小了 300，而 `pixels` 还是原来那个数）
  /// ⇒ 原来贴着底的那一屏，露出来的就只剩上半截。
  /// 而"跟不跟到底"这件事**只在控制器有变化时**才算（`_onChanged` → `_followBottom`），
  /// 键盘弹起**不产生新事件** ⇒ 那条路一次都不走。
  ///
  /// ⇒ 拿**既有那条规则**重新对一次（`models/scroll_follow.dart` 的纯函数）：
  ///   他**自己往上翻过**就不动（`userScrolledAway` ⇒ 只在贴底附近才跟），
  ///   从没翻过 ⇒ 钉回最新（`FollowAction.jump`，不带动画）。
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // ⚠️ `MediaQuery` 一变（键盘 / 窗口尺寸 / 系统那条手势条）这里就会跑一次；
    //    别的继承变化（主题、字号）也会进来 ⇒ **只认高度这个数**。
    final mq = MediaQuery.of(context);
    final visibleH = mq.size.height - mq.viewInsets.bottom;
    final was = _lastVisibleH;
    _lastVisibleH = visibleH;
    if (was == null || (visibleH - was).abs() < 0.5) return;
    // 下一帧再对：这一刻布局还没按新高度算过（`maxScrollExtent` 还是旧的）。
    WidgetsBinding.instance.addPostFrameCallback((_) => _followBottom());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_onChanged);
    FocusManager.instance.removeListener(_onFocusChanged);
    // 离开这一屏 ⇒ 把「我自己那台」那一头收干净（对面就不会留一个孤儿进程）
    _closeHarness();
    // ★ 那条浮窗的钟也要收（不然它到点会去动一棵已经没了的树）
    _homeHintTimer?.cancel();
    // ★ 那两个"会通知订阅者"的状态也得收（子页订阅着它们）
    _appearanceVN.dispose();
    _wallpaperVN.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// ★ **2026-10-04（主人报的"桌面并没有自动刷新"）—— 刷新机制的第二半：**
  ///   他**回到这一屏**（手机从后台切回来 / 浏览器标签切回来）⇒ **重拉一次清单**。
  ///
  /// 🔴 **为什么光有服务端那几帧不够**：那些帧是**实时**的（瞬态事件不补发）——
  ///    他不在看的那段时间里发生的事（盒子里的助手把小程序的入口写完了），
  ///    这一屏**一条都收不到**。回到屏幕前那一下不重拉，他看到的就还是旧样子
  ///    （灰的"在建"格），只能靠手动刷新页面。
  /// ⚠️ 就一次很小的清单请求；拉不到不许把界面弄坏（`_loadMyApps` 自己吞）。
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    if (!mounted) return;
    unawaited(_loadMyApps());
  }

  void _onChanged() {
    if (!mounted) return;
    // ★ `116`：先做"这一轮收口了没有"那一下自动折叠（它自己会 setState）。
    //    ⚠️ 必须在下面那次 setState **之前**：不然屏幕上会先闪一帧"没折"的样子。
    _applyAutoFold(widget.controller);
    setState(() {});
    // ★ **乙期：语音那一档自己发出去了** ⇒ 把那扇**聊天记录窗口**打开（`D3.14`）
    //   （他说完 → 听懂 → 通顺就发；发的那一下不用他点任何东西，但**要让他看见**）
    final sent = widget.controller.voiceSent;
    if (sent != _voiceSent) {
      _voiceSent = sent;
      _floaterKey.currentState?.maximize();
    }
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
      // ★ 换房间 ⇒ 那条动作横条指的**不是这一屏的那一条**了 ⇒ 收起来
      _menuItem = null;
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
    // ★ 和"自己点开图标"同一条：进屏就把那颗 home 的说明浮一下（主人 2026-09-27）
    _startHomeHint();
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
    // 🔴 **补帧要自己叫帧**（2026-09-26 修）：`addPostFrameCallback` **不排帧**
    //    （`SchedulerBinding.addPostFrameCallback` 只往队列里放一格）。
    //    没人排帧 ⇒ 这一串补帧会**停在那儿**，等到下一次"因为别的原因"来的一帧
    //    才接着跑 —— 那可能是几秒以后、也可能正是用户**刚用滚轮翻上去**的那一帧，
    //    于是"展开时钉到最新"变成"随时把用户拽回底部"（真机上就是"滚不动"）。
    //    ⇒ 补帧是**这次展开**的事，就让它在这几帧里跑完。
    if (left > 0) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToLatest(left: left - 1));
      SchedulerBinding.instance.scheduleFrame();
    }
  }

  /// **这一次滚动是不是"用户自己动的"**（时间线那一块的"跟不跟到底"靠它）。
  ///
  /// 🔴 三种都要认，缺一种就是"用户滚不动"：
  ///   · **拖**（手指/鼠标按着拖）：`ScrollStart/UpdateNotification.dragDetails != null`；
  ///   · **滚轮 / 触控板**：没有 `dragDetails`，但 `ScrollPosition.pointerScroll()` 会把
  ///     `userScrollDirection` 拨到非 idle ⇒ 来一条非 idle 的 `UserScrollNotification`；
  ///   · **滚动条 / 键盘翻页**：同样走非 idle 的那条路。
  ///
  /// ⚠️ **为什么不能只看 `dragDetails`**（真机踩到的形状）：桌面浏览器上滚轮是
  ///    **唯一**能把时间线滚起来的手段（Flutter 默认不给鼠标拖拽当滚动设备，
  ///    `ScrollBehavior.dragDevices` 里没有 mouse），而它**不带 `dragDetails`**
  ///    ⇒ 那个标志恒为假 ⇒ 之后**任何**一帧控制器变化（流式回答、工具行、排队）
  ///    都会走 `scrollFollowAction(userScrolledAway: false)` 的"永远跟到底"那一支，
  ///    把用户刚翻上去的那一屏**硬跳回底部**。屏幕上就是"聊天历史无法滑动"。
  ///
  /// ⚠️ **我们自己 `jumpTo` / `animateTo` 的那几次不算**：`jumpTo` 会把方向拨回
  ///    `idle`（`ScrollPositionWithSingleContext.jumpTo → goIdle()`），
  ///    `animateTo` 走的是 `DrivenScrollActivity`、**不动**方向 ⇒ 两者都不会
  ///    产生一条非 idle 的 `UserScrollNotification`（判据：`expand_input_test.dart`
  ///    的"展开补帧不许把用户拽走"那一条）。
  bool _isUserScroll(ScrollNotification n) {
    if (n is ScrollStartNotification && n.dragDetails != null) return true;
    if (n is ScrollUpdateNotification && n.dragDetails != null) return true;
    if (n is UserScrollNotification && n.direction != ScrollDirection.idle) return true;
    return false;
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
    //    `test/widget/notice_shape_test.dart（2026-09-30 改名）` 量的是**下面内容前后同一个矩形**。
    // ⚠️ **桌面铺满整屏（底图），聊天浮窗贴在屏幕底部浮着、四边各留 30**
    //    （主人 2026-09-22 更正："桌面是全屏的，聊天窗口是在底部的"；
    //      契约 `52-DESKTOP.md`、手册 §六 Z4）。
    //    两层是 `Stack`，不是上下排的 `Column` —— 桌面在**下面那一层**，不是"下面那一条"。
    //    ⚠️ `Positioned` 必须是 `Stack` 的**直接孩子**（包一层 `LayoutBuilder` 会让整棵树报
    //       `Incorrect use of ParentDataWidget`）；所以浮窗能用的高度从 `MediaQuery` 算，
    //       不在 `Positioned` 里套 `LayoutBuilder`。
    final mq = MediaQuery.of(context);
    // 🔴 **浮窗的高度上限要按"看得见的那块地方"算**（2026-09-26 修）：
    //    `Positioned(left/right/bottom)` **不给 top** ⇒ 它给孩子的约束里
    //    **高度是无界的**（`RenderStack.layoutPositionedChild`：没给 `height`/`top`
    //    就不 tighten 高度）⇒ 浮窗的高度**只由这里这个 `maxH` 决定**，
    //    父层不会替它收进来。
    //    键盘弹起来时 `Scaffold`（`resizeToAvoidBottomInset`）把**身子的高**缩小了，
    //    而 `mq.size` 仍是**整屏**（`viewInsets` 记着键盘占掉的那一段）
    //    ⇒ 照整屏算出来的 `maxH` 会让浮窗**顶到屏幕外面去**
    //    （真机读数：390×844 + 键盘 300 ⇒ 浮窗顶在 **-270**，抓手/标题行/两个 tab
    //      全在屏幕上方，一个都点不到）。⇒ 减掉 `viewInsets.bottom`。
    //  ★ **底下那条也要让出来**（2026-09-28 安卓真机）：手势条/导航条那一块
    //    在 edge-to-edge 下是**盖在窗口上的** ⇒ 浮窗贴底贴到 10 的话，
    //    输入条会被手势条压住。⇒ 取"我们要的留白"与"系统那条"里**大的那个**：
    //    · 没有系统条（网页、桌面）⇒ `padding.bottom` 是 0 ⇒ 就是那个留白；
    //    · 键盘弹起来时 `padding.bottom` 变 0（`Scaffold` 已经把身子缩到键盘之上）⇒ 也是那个留白。
    final bottomGap = math.max(FloaterMetrics.margin, mq.padding.bottom);
    final maxH =
        mq.size.height -
        mq.padding.top -
        mq.viewInsets.bottom -
        FloaterMetrics.margin -
        bottomGap;
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
                    // ★ **还在做**（`/api/apps` 的 `building` · 2026-10-04）：
                    //   那一格画**灰的、转着圈的在建图标**（主人：*"就像 ios 那个开发中的那个"*）。
                    isBuilding: a.building,
                    // ★ **这一间现在有活在做**（`/api/apps` 的 `working` · 2026-10-04）：
                    //   右下角一个小圈（转着的）—— 与在建是两件事。
                    isWorking: a.working,
                    // 🔴 在建的那一格**点了不打开**（那一间里只有一页"这里还空着"）——
                    //   但要**说一句**（点了没反应 = 屏幕上说假话），所以走 `_say`。
                    onOpen: (from) => a.building
                        ? _say(appBuildingLine)
                        : _openMiniApp(from, '$_minePrefix${a.id}'),
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
                // ★ **创建小程序**（主人 2026-09-27）：桌面末尾那一格"空心加号"。
                //   🔴 **它只长在桌面上** —— 小程序容器一开就把整页盖住 ⇒
                //      进了小程序就点不到它（"里面不能再建一个"在**看得见**这一侧成立）；
                //      助手那条路另有一道闸（`apps-socket.js` 的 `create`）。
                //   ⚠️ 那一格**没有菜单**（不改名 / 不复制 / 不删）：三样都传 `null`。
                DesktopApp(
                  label: createAppLabel,
                  icon: Icons.add,
                  isCreate: true,
                  onOpen: (_) => unawaited(_createApp()),
                ),
              ],
              // ★ 2026-09-24：正在扩开/收回的那一格，**图标先消失**（打开那一瞬间就藏；
              //   收回时**藏到动画结束**才放回来 —— 主人原话："appicon 应该是动效结束后出现"）
              hideIconId: _openApp ?? (_appSettled ? null : _hideIdCache),
              // ★ 2026-09-29：桌面那张**壁纸**（契约 `docs/dev/131-WALLPAPER.md`）。
              //   ⚠️ 它只画在**桌面这一层**：聊天浮窗、图标墙、小程序都不受影响。
              wallpaper: _wallpaper,
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
              // ★ **2026-10-04（`D3.15`）：出口在这一屏的右上角。**
              //   主人：*「所有的app，右上角都有一个退出按钮。所以我不再需要home按钮」*
              //   ⇒ 入口在 `MiniAppHost` 里，动作还是这一处（回桌面）。
              onExit: () => _backToDesktop(c),
              onSettled: () {
                if (mounted) setState(() => _appSettled = true);
              },
              covered: _floaterExpanded,
              onCoveredTap: () => _floaterKey.currentState?.collapse(),
              // 收起那条压住多少 ⇒ 内容底部内缩（规则 1：不是简单覆盖，否则最后一行永远点不到）
              // 🔴 **2026-10-01 更正（主人报"所有小程序打开后都无法点击聊天了"）**：
              //    这里原来给"制品那一屏"开了一个 `bleed` —— 平台视图**铺满整屏**。
              //    那是**做反了**：Web 上小程序是**真的 DOM 元素**、压在画布**上面**，
              //    铺满之后它把聊天浮窗整个盖住 ⇒ **小程序凌驾于聊天之上**，
              //    而规矩是反过来的（**Z1：聊天永远最上** —— 桌面之上、小程序之上）。
              //    ⇒ **平台视图的矩形不许盖到聊天浮窗的矩形**，制品也一样：
              //      底下那一条照旧让出来（判据 `test/widget/safe_area_test.dart`）。
              bottomInset: FloaterMetrics.margin + _barH,
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
          // ② 聊天浮窗（贴底、四边 `FloaterMetrics.margin`、永远在最上 —— Z1/Z3/Z4）
          Positioned(
            left: FloaterMetrics.margin,
            right: FloaterMetrics.margin,
            // ⚠️ 底下那个值见上面 `bottomGap` 那段（**系统那条比我们的留白大时听系统的**）。
            bottom: bottomGap,
            // ⚠️ **不给 `height`**：收起档的高度要**由内容算**（D3.5）；
            //    半开/最大化由 `ChatFloater` 自己按系数定（它拿到 `maxHeight`）。
            child: ChatFloater(
              key: _floaterKey,
              maxHeight: maxH,
              title: appName,
              initialTier: widget.initialTier,
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
                // 🔴 **只往下记** —— 这个数**唯一**的去处是小程序那一层的底边内缩
                //    （下面 `bottomInset`），而那个内缩是**平台视图的布局输入**：
                //    跟着"浮窗当前高度"走 ⇒ 那个真 `<iframe>` 的 DOM 盒子**每帧被 resize
                //    一次** ⇒ 开关小程序那一下直接卡没（主人 2026-10-01 报的
                //    *「性能变得非常差，开关动效全没了。」*）。详见 `_barH` 那段注释。
                //    ⚠️ 它每帧都会被叫一次，所以这里**不许**写成"h 变了就 setState"。
                if (h > 0 && (_barH == 0 || h < _barH - 0.5)) {
                  setState(() => _barH = h);
                }
              },
              child: _sheetBody(c),
            ),
          ),
        ],
      ),
    );
    // 🔴 **2026-09-30**：这里原来读 `c.notice` 去画那个顶部浮窗 —— 撤了（主人：
    //    *「不要浮窗。」*）。今天带号的通知只进时间线，瞬态那条画在
    //    `_composerBody` 的输入条上面（`NoticeStrip`，**参与布局**）。
    // ★ 批次 4：**这一棵子树**就是"聊天窗口"那两样的作用域。
    //   ⚠️ 解析发生在**这里**（`MediaQuery.platformBrightness`）：用户在系统里切了
    //      暗色，`MediaQuery` 一变这一屏就重建 ⇒ `system` 当场跟着变（不用重开）。
    //   ⚠️ 包在**整棵树**（含桌面与小程序容器）上，但只有**调用 `DshLook.of` 的控件**
    //      读它 ⇒ 桌面图标墙 / 首页 / 登录 / 小程序容器那一圈壳一个像素都不动
    //      （整机暗色**不是这一批的事**，见 `docs/dev/119` §五）。
    final platformDark =
        MediaQuery.platformBrightnessOf(context) == Brightness.dark;
    return AppearanceScope(
      variant: _appearance.resolve(platformDark: platformDark),
      scale: _appearance.scale,
      settings: _appearance,
      onAppearance: _setAppearance,
      onFontSize: _setFontSize,
      child: PopScope(
        // ⚠️ 退出这一屏就把浮窗撤了：它是"现在喊你一声"，
        //    而下一屏上没有它（不然那个钟到点时会去动一棵已经没了的树）。
        onPopInvokedWithResult: (didPop, _) => c.dismissNotice(),
        child: Stack(
          children: [
            sheet,
            // 🔴 **2026-09-30：这里原来挂着一个 `NoticeOverlay`（顶部浮窗）—— 撤了。**
            //    主人原话：*「顶部会出来一个浮窗，叫我去做做完叫你。这个不对。不要浮窗。」*
            //    ⇒ 带号的通知**只进时间线**（那一半是 2026-09-21 定的，没动）；
            //      瞬态那条（写盘失败）改画在**浮窗里面**（`_composerBody` 里那一条）。
          ],
        ),
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
          onExit: () => _backToDesktop(c),
          // 🔴 **2026-10-01 更正**：这条 URL 原来还带 `pt`/`pb`（让**页面自己**留出
          //   状态栏与聊天条那两条边距，为的是"页面铺满整屏还能不被压住"）。
          //   可**只要平台视图铺满，聊天浮窗就被它盖住** —— 见上面 `bottomInset` 那一段。
          //   ⇒ 现在**不往 URL 上带边距**：那两条由**壳**让（`MiniAppHost` 的 `Padding`），
          //     页面拿到的就是**已经被让好的**那个矩形，它自己不用再留。
          //   ⚠️ 服务端那条注入（`app-serve.js` 的 `injectShellInset`）因此暂时用不上 ——
          //     **留着不动**（老客户端还在带 `pt`/`pb`，它照旧要认）；真要删它是另一批的事。
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
          // ★ 语音那屏的边界句要说实话：机器上**真有一份**才说"先收着"（见 `SpaceInfo.voiceReady`）
          voiceReady: widget.space.voiceReady,
          onSubmitCreds: widget.onSendCreds,
          onDrawImage: widget.onDrawImage,
          // ★ 批 7：**语音那一屏的「试一下」**（主人 2026-09-26）——
          //   开麦/收手与聊天那颗话筒**共用同两个函数**（`services/hearing.dart`），
          //   地址也共用 `stream_uri.dart` 那一个；这里只是把控制器那两个动作接上。
          //   🔴 **不碰钥匙**：那两样走 `/api/creds` ⇒ 服务端的 `voiceCredsFor`，
          //      这颗按钮只把音频送到 `/api/asr`（钥匙只有这一条路）。
          voiceTry: VoiceTryHandlers(start: c.hearOnce, stop: c.stopHearingNow),
          // ★ **录一段（录音 ＋ 回放）**（主人 2026-09-27）：**本机那一套**，
          //   与聊天那颗话筒/「试一下」**不共用**（那两条要走上游，这一条不出去）。
          voiceRecord: VoiceRecordHandlers(
            canRecord: rec.canRecord,
            start: rec.recordStart,
            stop: rec.recordStop,
            play: rec.play,
            stopPlay: rec.stopPlay,
            // ★ 录的时候那条**音量轴**（主人 2026-09-28）：网页与安卓各报各的电平，
            //   桩那一份是空流 ⇒ 界面**不画那条轴**（没有读数就不许编一个）。
            levels: rec.levels,
          ),
          canHear: c.canHear,
          onCancel: widget.onCancelMe,
          onCancelled: widget.onLoggedOut,
          onKeyChanged: widget.onKeyChanged,
          onLogout: _logout(c),
          // ★ 批次 4：**这块窗口**那两行（外观 / 字号）。
          //   ⚠️ 状态住**这一屏**（`_appearance`）：设置页只是那两行的入口，
          //      改完由 `setState` + `AppearanceScope` 让聊天面**当场**跟着变。
          appearance: _appearance,
          onAppearanceChanged: _setAppearance,
          onFontSizeChanged: _setFontSize,
          // ★ 2026-09-29：子页是 `push` 出来的**新路由**（不在这一屏的子树里）
          //   ⇒ 它们拿一份快照就会"按着旧值算" ⇒ 这两条路把**会通知的那一份**递下去。
          appearanceLive: _appearanceVN,
          // ★ 2026-09-29：**壁纸**那一项（状态住这一屏，同外观那两行）。
          wallpaper: _wallpaper,
          onWallpaperChanged: _setWallpaper,
          wallpaperLive: _wallpaperVN,
          // ★ 2026-09-30：**注册制那张卡**（契约 `docs/dev/147-APP-SQLITE.md`）。
          //   清单就是这一屏手上那份 `/api/apps`（桌面那一墙也是它）；
          //   "答应它 / 现在不给"那一下由这一屏去说（见 `_grantMyApp`）。
          // ★ 2026-10-04：**「读出来」那个开关搬到语音那一屏**（原来住在被换掉的
          //   聊天底下那一行里 —— 那颗喇叭）—— 同一档能力，新家。
          autoSpeak: c.autoSpeak,
          onToggleAutoSpeak: (on) => c.setAutoSpeak(on),
          // ★ 2026-10-04（V2.0 第一件）：设置里那一场"说一句试试"（演练，不会发出去）
          hearDrillPage: () => HearDrillScreen(controller: c),
          apps: _myApps,
          onGrant: _grantMyApp,
          // ★ 2026-10-01：**清空它存下来的东西**（`POST /api/app-db-clear`）——
          //   同"答应它"那条：由这一屏去说（见 `_clearMyApp`）。
          onClear: _clearMyApp,
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
  /// 那条说明（长按 / 读屏听到"这句话是在哪儿说的"）。
  ///
  /// ★ 同 [_scopeIcon]：**按"现在在哪一间"算**（B35）。
  /// **那颗 home 按钮**（原来它只是一个"在哪儿说话"的指示：只指示、不响应点击）。
  ///
  /// 🔴 主人 2026-09-27 定的三件（同一句话里）：
  ///   · *"让我的聊天窗口那边左侧的那个 home 按钮扩大一些"* ⇒ 图形 18 → 22，
  ///     命中区撑到 **≥44**（D3.6；图形再大也不许把命中区做成"只有图形那么大"）；
  ///   · *"点击 home 就是回到桌面"* ⇒ 点它 = [`_backToDesktop`]；
  ///   · *"点击 home 那个 icon 上面会有一个浮窗"* ⇒ 见 [_startHomeHint] ＋ [_homeHintBubble]。
  ///
  /// ⚠️ **图形规则一个字没改**（主人 2026-09-23 定的）：桌面上是**家**，
  ///    进了某个小程序就是**它自己的图标**（`_scopeIcon`，与桌面上那一个是同一个来源）。
  ///    他这次说的是**那颗按钮**（位置/作用），不是"把图形换成房子"。
  /// **点那颗 home**（主人 2026-09-27：*"点击 home 就是回到桌面"*）。
  ///
  /// 两件一起做，缺一件都"回不到桌面"：
  ///   ① 开着某一屏 ⇒ **关掉它**（与原来那个返回箭头同一套：收 harness ＋ 回主线 ＋ 收回动效）；
  ///   ② 再把聊天**收起来**（桌面才露得出来 —— 展开的聊天是盖满屏的）。
  /// ⚠️ 在桌面上按它也一样有结果：只有 ②（把聊天收起来）—— 所以它**任何时候都不是一颗空按钮**。
  void _backToDesktop(ChatController c) {
    _hideHomeHint();
    if (_openApp != null) {
      _closeApp(c);
      return;
    }
    _floaterKey.currentState?.collapse();
  }

  /// **关掉现在开着那一屏**（原来挂在容器顶栏那个返回箭头上，2026-09-27 起挂在 home 上）。
  void _closeApp(ChatController c) {
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
    unawaited(c.setScope(mainScope));
    // ★ **2026-10-04（主人报的"桌面并没有自动刷新"）：退回桌面 = 重拉一次清单。**
    //   🔴 他开着某一间小程序的那段时间里，桌面那一格可能已经变了（做完了 / 活收口了），
    //      而"正开着那一间"的那条连接**收不到**那些帧（服务端按焦点路由）
    //      ⇒ 回到桌面这一下不重拉，他看到的就还是旧样子。
    //   ⚠️ 一次很小的清单请求（清单本来也是现签 URL 的，重复拉没有副作用）。
    unawaited(_loadMyApps());
    // 顺手把聊天收起来：他要的是"回到桌面"，而展开的聊天是盖满屏的
    _floaterKey.currentState?.collapse();
  }

  /// ★ **进屏之后那条浮窗**（主人 2026-09-27）：说清"这颗 home 是干嘛的"。
  ///
  /// 三条：
  ///   · **自己会走**（`homeHintFor` = 3.5 秒）—— 它是一句说明，不是待办；
  ///   · **再进一次会重新计一遍**（不是"一辈子只看一次"：他这次进的是**另一个**小程序）；
  ///   · 他真按了 home ⇒ 立刻收（[`_hideHomeHint`]）。
  void _startHomeHint() {
    _homeHintTimer?.cancel();
    if (!_homeHint) setState(() => _homeHint = true);
    _homeHintTimer = Timer(homeHintFor, () {
      if (mounted) setState(() => _homeHint = false);
    });
  }

  void _hideHomeHint() {
    _homeHintTimer?.cancel();
    _homeHintTimer = null;
    if (_homeHint && mounted) setState(() => _homeHint = false);
  }

  /// **那条浮窗长什么样**（主人：*"点击 home 那个 icon 上面会有一个浮窗"*）。
  ///
  /// ⚠️ **位置不归它管**：它交给 `Composer` 的 `hintAbove`，由那一层挂在**输入条那一行**
  ///    上面（`Positioned` ＋ `FractionalTranslation` ⇒ 不占排版、不动窗口；
  ///    `IgnorePointer` 也在那一层包着）。
  Widget _homeHintBubble(DshLook look) => Container(
    key: chatHomeHintKey,
    // ⚠️ 用 token（不写数字）：与输入条那几条 strip（`composer.dart` 的 `_noticeStrip`）
    //    同一套留白 —— 而且 `design_tokens_test` 那条棘轮只许往下走。
    padding: const EdgeInsets.symmetric(horizontal: d.radiusField, vertical: d.gapS),
    decoration: BoxDecoration(
      color: look.palette.bgLayer2,
      borderRadius: BorderRadius.circular(d.radiusField),
      border: Border.all(color: look.palette.borderL2),
    ),
    child: Text(
      homeHintWords,
      // ★ 2026-10-01：这一句是提示，不是回答 ⇒ 走非主要那一档（原来这里写死 13）
      style: dshTextStyle(look.quiet, look.palette.labelSecondary),
    ),
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

  /// 语音那一档**发出去几次**（`D3.14`：发一次就把记录窗口打开一次）。
  int _voiceSent = 0;

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
  /// ★ **"创建一个小程序"那一趟**（主人 2026-09-27）。
  ///
  /// 顺序：**先问名字与描述**（那一层浮窗）⇒ 交给服务端 ⇒ 成了**重拉清单**
  /// （桌子照服务端那一份画 —— 新那一格就自己长出来了，不用客户端拼）。
  ///
  /// 🔴 三条：
  ///   · **名字必填**：他按了确定却没写字 ⇒ **本地就拦住**（别发一个注定被拒的请求），
  ///     并说一句"得先起个名字"；
  ///   · **描述可以不写**（原话：*"这个描述用户可以写也可以不写"*）；
  ///   · 服务端拒了（名字太长…）⇒ **把服务端那句人话原样说出来**（那几句话只有它说得准）。
  Future<void> _createApp() async {
    final got = await _askNewApp();
    if (got == null || !mounted) return;
    if (got.title.isEmpty) {
      _say(createAppNeedName);
      return;
    }
    final token = widget.controller.token;
    if (token == null) {
      _say(createAppFailed);
      return;
    }
    final out = await widget.controller.api.createApp(
      token: token,
      title: got.title,
      description: got.description,
    );
    if (!mounted) return;
    switch (out) {
      case CreateAppOk():
        await _loadMyApps();
        if (mounted) _say(createAppDone);
      case CreateAppUnauthorized():
        _unauthorized();
      case CreateAppFailed(:final words):
        _say(words.isEmpty ? createAppFailed : words);
    }
  }

  /// 那一层浮窗：**名字（必填）＋ 描述（选填）**。
  ///
  /// ⚠️ 返回 `null` = 【算了】/ 点外面 ⇒ 什么都不做；返回的那一对**原样**（trim 过的）
  ///    —— 空名字那一条由 [_createApp] 说一句（**同一处判**，不在这儿再判一遍）。
  Future<({String title, String description})?> _askNewApp() async {
    final v = await showDialog<({String title, String description})>(
      context: context,
      builder: (_) => const _CreateAppDialog(),
    );
    if (v == null) return null;
    return (title: v.title.trim(), description: v.description.trim());
  }

  /// ★ **打开时那张弹窗**（2026-10-01 · 契约 `docs/dev/147-APP-SQLITE.md` §二·乙）。
  ///
  /// 主人原话：*「小程序不要声明，应该是打开后有弹窗申请权限」* ·
  /// *「打开时一次问完」* · *「那一样用不了，别的照旧」*。
  ///
  /// 顺序是刻意的：
  ///   ① 手上没有这一条（清单还没拿到 / 刚被别人改过）⇒ **先拉一次**再判 ——
  ///      不然会"该问的没问"就把它打开（页面上一片空白，他还要猜为什么）；
  ///   ② 它**没有还没问过的**（或老服务端没这个字段）⇒ 一个字都不弹；
  ///   ③ 弹窗只负责把"他勾成什么样"交回来；**发请求是这一步做的**
  ///      （`_grantMyApp`：那儿才有令牌，也才拿得到回执）；
  ///   ④ 他要是**把窗划掉**（`null` = 没表态）⇒ 什么都不记（下次打开再问）；
  ///   ⑤ 有几样**没记下来** ⇒ 如实说一句（`askOnOpenFailed`），而**窗照开**
  ///      —— 没记住的那一样下次再问，别的照旧。
  Future<void> _askGrantsOnOpen(String id) async {
    MiniApp? mine = _mineApp(id);
    if (mine == null) {
      await _loadMyApps();
      if (!mounted) return;
      mine = _mineApp(id);
    }
    if (mine == null || !needsAskOnOpen(mine)) return;
    final choices = await askOnOpen(context, mine);
    if (!mounted || choices == null) return; // 划掉了 ⇒ 没表态
    var missed = 0;
    for (final e in choices.entries) {
      final out = await _grantMyApp(id, e.key, e.value);
      if (!mounted) return;
      if (out is! GrantOk) missed += 1;
    }
    if (missed > 0 && mounted) _say(askOnOpenFailed);
  }

  /// 手上那份清单里有没有这一个（**「我的小程序」那一批**）。
  MiniApp? _mineApp(String id) {
    for (final a in _myApps) {
      if (a.id == id) return a;
    }
    return null;
  }

  /// ★ **注册制那一下**（契约 `docs/dev/147-APP-SQLITE.md` §二 ·
  /// 主人原话：*「注册制，在设置里可以看到也可以关闭」*）。
  ///
  /// 设置页那张卡把"他点了开关"交到这儿 ⇒ 去说一声（`POST /api/app-grant`）：
  ///   · **服务端明说成了** ⇒ 把这一屏手上那份清单里那一条**改成新的一份**
  ///     （界面照它画：桌面那一墙、下一次打开设置页，都是这一份）；
  ///   · 令牌不行 ⇒ 走既有那条"该回登录页"的路（**不在这儿**说成"没给"）；
  ///   · 其余（网 / 非 200 / `ok` 不是 true）⇒ **一个字节都不改**，
  ///     把服务端那句人话**原样交回**给那张卡去说（**不许**先拨过去再回滚）。
  ///
  /// ⚠️ 返回的是**那个结果本身**（卡片拿它决定说什么）—— 这一层不替它编话。
  Future<GrantOutcome> _grantMyApp(String id, String permission, bool allow) async {
    final token = widget.controller.token;
    if (token == null) {
      _unauthorized();
      return const GrantFailed('');
    }
    final out = await widget.controller.api.appGrant(
      token: token,
      id: id,
      permission: permission,
      allow: allow,
    );
    if (!mounted) return out;
    switch (out) {
      case GrantOk(:final permissions):
        setState(() {
          _myApps = [
            for (final a in _myApps)
              if (a.id == id)
                // ★ **问过就不再问**：允许 / 不给都算他表过态 ⇒ 把这一样从
                //    `unanswered` 里挪走（老服务端没这个字段 ⇒ 保持"不知道"）。
                a.withGrantAnswer(
                  permissions ?? nextGranted(a.granted ?? const [], permission, allow),
                  a.unanswered == null
                      ? null
                      : [
                          for (final p in a.unanswered!)
                            if (p != permission) p,
                        ],
                )
              else
                a,
          ];
        });
      case GrantUnauthorized():
        _unauthorized();
      case GrantFailed():
        // 没成 ⇒ 清单**一个字都不动**（卡片那边也只说一句、不拨开关）。
        break;
    }
    return out;
  }

  /// ★ **清空它存下来的东西**（2026-10-01 · 契约 `docs/dev/147-APP-SQLITE.md` §五）。
  ///
  /// 设置页那张卡把"他确认过的那一下"交到这儿 ⇒ 去说一声（`POST /api/app-db-clear`）。
  ///   · **服务端明说成了** ⇒ 卡片说一句"清掉了"（这一屏手上那份清单**一个字都不用改** ——
  ///     被清掉的是那个小程序自己存的东西，不是"它要什么 / 你给了没有"）；
  ///   · 令牌不行 ⇒ 走既有那条"该回登录页"的路（**不在这儿**说成"没清掉"）；
  ///   · 其余（网 / 非 200 / `ok` 不是 true）⇒ **一个字节都不许当成功**，
  ///     把服务端那句人话**原样交回**给卡片去说。
  ///
  /// ⚠️ 返回的是**那个结果本身**（卡片拿它决定说什么）—— 这一层不替它编话。
  /// ⚠️ 确认那一步在卡片那边（`_confirmClear`）：走到这儿 = 他已经点过"清掉"。
  Future<ClearOutcome> _clearMyApp(String id) async {
    final token = widget.controller.token;
    if (token == null) {
      _unauthorized();
      return const ClearFailed('');
    }
    final out = await widget.controller.api.appDbClear(token: token, id: id);
    if (!mounted) return out;
    if (out is ClearUnauthorized) _unauthorized();
    return out;
  }

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
    // ★ **打开之前先问一句**（2026-10-01 主人定的规矩：*"小程序不要声明，应该是打开后
    //   有弹窗申请权限"* · *"打开时一次问完"*）。
    //   🔴 必须**在这一屏画出来之前**问完：他那几样是服务端记的账，而页面（`net` 那一样）
    //      的响应头就是照那本账算的 —— 等他点完再建 iframe，它才连得出去。
    //   ⚠️ 他要是**一样都不给**，那也照开（"那一样用不了，别的照旧"）。
    if (which.startsWith(_minePrefix)) {
      await _askGrantsOnOpen(which.substring(_minePrefix.length));
      if (!mounted) return;
    }
    setState(() {
      _appFrom = from;
      _openApp = which;
    });
    // ★ **进屏那条浮窗**（主人 2026-09-27）：3.5 秒后自己走
    _startHomeHint();
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
        // 🔴 **2026-10-03 砍掉**：这一格原来摆的是**右栏**（"这一窗动过哪些文件"，
        //    契约 `docs/dev/120-FILE-PANEL.md`）。主人的原话：
        //    *「聊天窗口有个展开，这一轮动过哪些地方，这个我们可以关掉，不需要这个功能。」*
        //    ⇒ 整条（那一栏 ＋ 会话头上那颗展开按钮 ＋ 它的几何 token）**删掉了**，
        //      不是"藏起来"（手册 §六 纪律 6：要么做，要么明说砍了）。
        //    ⚠️ 顺手的好处：标题行**少了一格**（约 52px）⇒ 那一排动作的可视宽度变宽
        //      （读数见 `docs/dev/171-PANEL-CUT.md`）。
        Expanded(child: _chatPane(c)),
        // ★ **长按气泡之后那一条**（契约 `28-DELETE.md` §二 / `106-CHAT-SELECT.md`）。
        //   🔴 它**摆在这儿**（输入条上面、时间线的兄弟）而不是弹一层：
        //      弹一层会带 barrier ⇒ 弹着的时候**整个窗口都点不动、也发不出去**
        //      （真机复现见 `docs/dev/124-TOUCH-REGRESSION.md`）。
        //   ⚠️ 它**不会挡住多选态那条**：按下【多选】时这一条先收起来（见 `_pickBubbleAction`）。
        //   ⚠️ 那条已经不在这一屏了（删了 / 换了房间）⇒ 不画（免得留一条指向空气的横条）。
        if (_menuItem != null && c.items.any((it) => identical(it, _menuItem)))
          BubbleActionsBar(
            onPick: (a) => _pickBubbleAction(c, a),
            onCancel: () => setState(() => _menuItem = null),
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
        // 🔴 **这里原来有一格 `SizedBox(height: viewInsets.bottom)` —— 2026-09-26 删了。**
        //    它是 `a43ec38`（第一版真界面）留下的：那会儿**输入条就住在这个 Column 里**
        //    （见那一版：`… Center(Composer…) , SizedBox(viewInsets.bottom)`），
        //    所以要用它把输入条顶到键盘上面。2026-09-24 起输入条搬去了浮窗
        //    （`ChatFloater.composer`，是这个 Column 的**兄弟**），这一格就成了
        //    **多算一遍键盘**：`Scaffold` 已经把身子缩过一次，这里再占一段
        //    ⇒ 时间线（`Expanded`）被挤到 **0 高**。
        //    真机读数（390×844 + 键盘 300 + 6 行字）：时间线矩形 `(30, -71.5, 360, -71.5)`
        //    = 高 0、整块在屏幕上方；`Column-[<'chat-body'>]` 当场
        //    `RenderFlex overflowed`。屏幕上就是**"聊天历史滚不动"**（没有东西可滚）。
        //    ⇒ 键盘那一段由浮窗自己负责（`maxH` 减 `viewInsets.bottom`，见 `build`）。
      ],
    );
  }

  /// 聊天那一块（时间线 ＋ 「回到最新」）。
  ///
  /// ⚠️ **右栏开 / 关底下是同一棵子树**（同一个 `State`、同一个 `ScrollPosition`）
  ///    ⇒ 开关那一栏不会丢滚动位置。
  Widget _chatPane(ChatController c) {
    return Center(
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
    );
  }

  /// **输入条**（收起态和展开态共用的**同一个**东西）。
  Widget _composer(ChatController c) {
    // ⚠️ 用 `Builder`：`AppearanceScope` 是在这一屏的 `build()` 里造的 ⇒
    //    只有**它下面**的 context 才读得到那一档色板（`DshLook.of`）。
    return Builder(builder: (ctx) => _composerBody(c, DshLook.of(ctx)));
  }

  Widget _composerBody(ChatController c, DshLook look) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        // ★ **`117`：排队那条横条画在输入条**上面**、浮窗里面**（契约
        //   `docs/dev/117-QUEUE-VISIBLE.md` §四）。空队时它一个像素都不占
        //   （`QueueStrip` 自己画 `SizedBox.shrink()`）。
        //   ⚠️ 它与 `SayBusy` **不是一回事**：那一档是**内存准入闸**（这一句根本
        //      没被收下），而这里排着的每一句**都已经收下、都落盘了**，只是还没轮到
        //      它变成一轮 —— 所以一个画在气泡上（"没发出去"），一个画在这儿（"排着"）。
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // ★ **窗口里面那一条**（2026-09-30）：原来它是顶部那个浮窗。
            //   今天只剩**瞬态那一种**（写盘失败）—— 带号的通知只进时间线。
            if (c.notice != null)
              // 🔴 2026-10-03：「拿回来」那条路砍了 ⇒ 这一条不再挂撤销按钮。
              NoticeStrip(notice: c.notice!, onDismiss: c.dismissNotice),
            QueueStrip(queue: c.queue, onCancel: c.unsay),
            VoiceBar(
              flow: c.voiceFlow,
              canHear: canHear,
              speakable: canSpeak,
              onMic: () => unawaited(c.toggleVoiceCompose()),
              onTyped: (text) => unawaited(c.answerVoiceCompose(text)),
              hintAbove: _homeHint ? _homeHintBubble(look) : null,
            ),
          ],
        ),
      ),
    );
  }

  /// 时间线本体 + 尾巴上那一行「它正在做…」（步骤流水那一档已砍，不再画）。
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
      // ⚠️ **用户自己翻走了**要认四种手指/设备：拖、滚轮、触控板、滚动条/键盘。
      //    🔴 判据是 [_isUserScroll]（`dragDetails` 只管得住"拖"那一种）。
      onNotification: (n) {
        // ⚠️ **要 setState**：那颗「回到最新」是按这个标志画的 ——
        //    只改字段不重建的话，用户翻上去了而按钮**不出现**（判据当场抓到过）。
        if (!_userScrolledAway && _isUserScroll(n)) {
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
        // ★ 2026-10-01（主人："间距有问题"）：上下那一条跟着字一起收（8 → 6）
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: DshChatSpace.listPadV),
        itemCount: header + slots.length + (c.hasProcess ? 1 : 0),
        itemBuilder: (context, i) {
          if (header == 1 && i == 0) return olderLine!;
          final k = i - header;
          if (k < slots.length) return _renderSlot(slots[k], c);
          return ProcessTail(busyText: c.agentLine);
        },
      ),
    );
  }

  /// **这一屏画哪几格**：真条目 + 时间那一行 + 合起来的通知 + "折起来的那一轮"那一个控件。
  ///
  /// 规矩（前三条来自 DSH，见 `docs/dev/115-raw/B-render.md` §2.3；
  /// ★ 后两条是 `154` 这一批加的）：
  ///   · **还在跑的那一轮不折**（过程行照画）；
  ///   · **收口之后**同一轮的工具行折成一个控件 —— 控件画在**第一条**那个位置
  ///     （哪一条是"答案"我们这一侧认不出来，见 `turn/usage` 那段：`message/*` 不带 step）；
  ///   · **系统提示词行不参与折叠**（DSH：它是 `TURN_PROCESS_INDEPENDENT_KINDS`）；
  ///   · ★ **用量那一行也收进"过程"里**（`154` §2.1）：它是"过程"的一半，
  ///     不是"他说的话"的一半 —— 收起来之后屏幕上那一串 `tok` 默认就不见了；
  ///   · ★ **时间那一行**：跨天 / 隔得够久（`chat_time.needsTimeMark`）才插一条；
  ///   · ★ **连着同样几句通知合成一行**（`154` §2.1，判据在 `timeline.mergeableNotices`）。
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
    final now = DateTime.now().millisecondsSinceEpoch;
    // 「上一处画过的时间」：只由**画得出来**的条目推进（工具行/用量/系统提示词不推进，
    // 它们是那一轮的内部细节，不该把时间那一行拉到它们头上）。
    int? prevAt;
    TimelineNotice? runNotice;
    var runCount = 0;
    void flushRun() {
      if (runNotice == null) return;
      slots.add(_NoticeRunSlot(notice: runNotice!, count: runCount));
      runNotice = null;
      runCount = 0;
    }
    for (final it in c.items) {
      // ── 折起来的那一轮：工具行换成那一个控件（用量也一起收进去）──
      if (it is TimelineToolCall && _processFolded(it.turn, closed)) {
        flushRun();
        if (placed.add(it.turn)) slots.add(_FoldSlot(it.turn));
        continue;
      }
      if (it is TimelineTurnUsage) {
        if (lastUsageSeq[it.turn] != it.seq) continue;
        // ★ 收起来的那一轮：用量进"过程"（默认一个 `tok` 都不上屏）。
        // 🔴 **一轮只说了话、一个工具行都没有时，也要给它一个控件** ——
        //    不然那一串 token 收起来之后**再也点不出来**（"全部开放"那条不许
        //    靠"藏起来"实现）。控件那一行就是 DSH 那个「已思考」
        //    （零段的兜底，见 `turnProcessFallback`）。
        if (_processFolded(it.turn, closed)) {
          flushRun();
          if (placed.add(it.turn)) slots.add(_FoldSlot(it.turn));
          continue;
        }
        flushRun();
        slots.add(_ItemSlot(it));
        continue;
      }
      // ── 通知：连着同样几句合成一行（有撤销的**不合并**，见 `mergeableNotices`）──
      if (it is TimelineNotice) {
        if (runNotice != null && mergeableNotices(runNotice!, it)) {
          runCount += 1;
          prevAt = it.at ?? prevAt;
          continue;
        }
        flushRun();
        runNotice = it;
        runCount = 1;
        if (needsTimeMark(prevAt: prevAt, at: it.at, now: now)) {
          slots.add(_TimeMarkSlot(it.at!));
        }
        prevAt = it.at ?? prevAt;
        continue;
      }
      flushRun();
      // ── 时间那一行（只在"说得上话"的那几种之前插）──
      final showTime = (it is UserUtterance || it is AssistantMessage || it is TimelineMarker) &&
          needsTimeMark(prevAt: prevAt, at: it.at, now: now);
      if (showTime) slots.add(_TimeMarkSlot(it.at!));
      if (it is UserUtterance || it is AssistantMessage || it is TimelineMarker) {
        if (it.at != null) prevAt = it.at;
      }
      slots.add(_ItemSlot(it));
    }
    flushRun();
    return slots;
  }

  /// 画一格（真条目走 [_render]；另外三种各有自己的画法）。
  Widget _renderSlot(_Slot slot, ChatController c) => switch (slot) {
    _ItemSlot(:final item) => _render(item, c),
    _TimeMarkSlot(:final at) => TimeMarkLine(
      label: timeMarkLabel(at, now: DateTime.now().millisecondsSinceEpoch),
    ),
    _NoticeRunSlot(:final notice, :final count) =>
      NoticeLine(notice: notice.notice, count: count),
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
    //   ⚠️ 2026-10-03：「拿回来」（撤销）**砍了** —— 通知照旧上屏，不挂按钮。
    // 🔴 2026-10-03：**「拿回来」那条路砍了**（主人：*"回收站…我们也不需要"*）
    //    ⇒ 通知照旧上屏（它是服务端的事实），但**不再挂那个撤销按钮**。
    TimelineNotice() => NoticeLine(notice: item.notice),
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

  /// 一条回答：气泡 + （推理档时）**它自己那条**的思考原文。
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
          // ★ **点开那段视频**（2026-10-01 · 视频那一样）：与"出处"同一条规矩 ——
          //   开不了外面的地址就传 `null` ⇒ 那个框**画成不可点的**（不给假按钮）。
          onOpenVideo: _selecting ? null : (canOpenLinks ? openExternal : null),
          selected: _selecting && _selectedIds.contains(m.messageId),
          onTap: _selecting ? () => _toggleSelect(m.messageId) : null,
        ),
        if (reasoning.isNotEmpty) ReasoningBlock(text: reasoning),
      ],
    );
  }

  // ── 长按气泡 → 复制 / 多选 / 删掉（契约 `28-DELETE.md` + `106-CHAT-SELECT.md`）──

  /// 长按气泡：把那条动作横条**摆出来**（不是弹一层 —— 见下面那段）。
  ///
  /// ⚠️ 一次问答 = 一轮 = 两个 `messageId`（§三·补）——那两个 id 由
  ///    `ChatController.turnMessageIds` 从**画得出来的**那几条里算出来。
  ///    算不出来（比如这句还没发出去）⇒ **连入口都不给**：那会是一个
  ///    "看起来能删、其实服务端没有它"的动作。
  /// ⚠️ 这一条**管着三项**：进不来的那条（不在任何一轮里）三项都不给 ——
  ///    契约 `106` 的【复制】【多选】只说了"长按任意一条"，
  ///    而"还没发出去的那句"在界面上本来就没有长按入口（§四 没要求改它）。
  ///
  /// 🔴 **2026-09-26：原来这里是 `showModalBottomSheet`，改成摆一条横条。**
  ///    理由不是好看：那一层带**铺满全屏的 barrier**，手按住 500ms
  ///    （`kLongPressTimeout`，老人家的慢按 / "按下去准备滑"那一下就够）
  ///    就会把它弹出来，于是**整个窗口当场死掉**：时间线拖不动、抓手行按钮
  ///    一个都点不动、输入条被盖住发不出去。真机读数与复现步骤见
  ///    `docs/dev/124-TOUCH-REGRESSION.md`。
  ///    ⇒ 现在它只是 `_sheetBody` 里的一个孩子（与 `BubbleSelectBar` 同一条路），
  ///      **时间线、输入条、抓手行一样都不受影响**。
  void _onBubbleLongPress(ChatController c, TimelineItem item) {
    final id = item.messageId;
    if (id == null) return;
    if (c.turnMessageIds(id) == null) return;
    // 同一条再长按一次 = 收起来（点着玩不会越堆越高）
    setState(() => _menuItem = identical(_menuItem, item) ? null : item);
  }

  /// **长按气泡之后选中的那一项**（`null` = 横条不画）。
  ///
  /// ⚠️ 它只是**一个界面状态**：真动作全在 [`_pickBubbleAction`] 里，
  ///    与原来那个 `await showModalBottomSheet(...)` 的返回值**一一对应**。
  TimelineItem? _menuItem;

  /// 横条上按了哪一项（对应原来那个弹层的返回值）。
  Future<void> _pickBubbleAction(ChatController c, BubbleAction action) async {
    final item = _menuItem;
    setState(() => _menuItem = null); // 先收起横条（与弹层 pop 之后那一下同一个时机）
    if (item == null) return;
    final id = item.messageId;
    final ids = id == null ? null : c.turnMessageIds(id);
    switch (action) {
      case BubbleAction.copy:
        await _copyOne(item);
      case BubbleAction.select:
        _enterSelect();
      case BubbleAction.delete:
        if (ids == null) return; // 一轮都算不出来 ⇒ 连清单都列不了（原来那条门的另一半）
        await _deleteTurn(c, ids);
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

/// ★ 一格**时间那一行**（`154` §2.1）：跨天 / 隔得够久才出现。
class _TimeMarkSlot extends _Slot {
  const _TimeMarkSlot(this.at);

  /// 那一条的时刻（毫秒）—— **画什么字由 `_renderSlot` 现算**
  /// （「今天」这种东西跟"现在是哪一天"有关，不该在规划的那一步定死）。
  final int at;
}

/// ★ 一格**合起来的通知**（连着同样几句合成一行；`154` §2.1）。
///
/// ⚠️ 里面装的仍是那**一条** `TimelineNotice`（撤销要按它走那条路），
///    外加"它重复了几次"。服务端给的那句话**逐字照抄**，只多一个次数。
class _NoticeRunSlot extends _Slot {
  const _NoticeRunSlot({required this.notice, required this.count});

  final TimelineNotice notice;
  final int count;
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
          //
          // 🔴 `117`：**必须夹到 ≥0**。原来直接写 `cons.maxHeight - 64` ——
          //    分到的高度不足 64 时它就是个**负数**，而 `BoxConstraints` 一收到
          //    负的 `minHeight` 当场抛（`negative minimum height`）。
          //    真栽过：排队那条横条展开着 + 3.1 倍字号 ⇒ 这一块只分到 37.5 像素
          //    ⇒ 负数约束 ⇒ 五档那道硬闸红。夹到 0 之后"地方不够就滚"照旧成立。
          constraints: BoxConstraints(minHeight: (cons.maxHeight - 64).clamp(0.0, double.infinity)),
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

/// **"新建一个小程序"那一层浮窗**（主人 2026-09-27 · 契约 `docs/dev/127`）。
///
/// 形状与改名那一层同源（`AlertDialog` + 自己的 `TextEditingController`）：
/// **一个名字（必填）＋ 一个描述（选填）**，两个按钮。
/// ⚠️ 控制器住**这一层**（不是 `showDialog` 那个闭包里）：弹层还没拆完就 dispose
///    会当场抛 `A TextEditingController was used after being disposed`（改名那条踩过）。
/// ⚠️ 描述那一栏的标签上**就写着"可以不写"** —— 不许让他猜这一栏要不要填。
class _CreateAppDialog extends StatefulWidget {
  const _CreateAppDialog();

  @override
  State<_CreateAppDialog> createState() => _CreateAppDialogState();
}

class _CreateAppDialogState extends State<_CreateAppDialog> {
  final _name = TextEditingController();
  final _desc = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
    _desc.dispose();
    super.dispose();
  }

  void _ok() => Navigator.of(context).pop(
    (title: _name.text, description: _desc.text),
  );

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      // 字放大到 3.1 倍时这一层会高过手机 ⇒ **要能滚**（§6.7 第 7 条那族）
      scrollable: true,
      title: const Text(createAppTitle),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _name,
            autofocus: true,
            decoration: const InputDecoration(
              labelText: createAppNameLabel,
              hintText: createAppNameHint,
            ),
          ),
          const SizedBox(height: d.gapM),
          TextField(
            controller: _desc,
            maxLines: 2,
            decoration: const InputDecoration(
              labelText: createAppDescLabel,
              hintText: createAppDescHint,
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
          child: const Text(createAppNo),
        ),
        FilledButton(
          onPressed: _ok,
          style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
          child: const Text(createAppOk),
        ),
      ],
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
