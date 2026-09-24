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

import '../models/dev_harness.dart';
import '../models/image_outcome.dart';
import '../models/conn_state.dart';
import '../models/design.dart' as d;
import '../models/export_words.dart';
import '../models/scroll_follow.dart';
import '../models/space.dart';
import '../models/app_spec.dart';
import '../models/app_words.dart';
import '../models/harness.dart';
import '../models/harness_words.dart';
import '../models/math_words.dart';
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
import '../widgets/mini_app_icons.dart';
import '../widgets/mini_runtime.dart';
import '../widgets/plan_strip.dart';
import '../widgets/bubble_menu.dart';
import '../widgets/bubbles.dart';
import '../widgets/chat_floater.dart';
import '../widgets/mini_app_host.dart';
import '../widgets/composer.dart';
import '../widgets/notice.dart';
import '../widgets/process_level_menu.dart';
import '../widgets/process_view.dart';
import '../widgets/trash_plan_sheet.dart';
import 'discover_screen.dart';
import 'export_screen.dart';
import 'math_quiz_screen.dart';
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

  /// **"我的小程序"在 `_openApp` 里的前缀**（跟内置那两个区分开：`'settings'` / `'math'`）。
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
  /// ⚠️ 原来是个布尔（只装得下「设置」一个）。主人 2026-09-22 要加「奥数题」⇒ 改成名字。
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
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    // 离开这一屏 ⇒ 把「我自己那台」那一头收干净（对面就不会留一个孤儿进程）
    _closeHarness();
    _scroll.dispose();
    super.dispose();
  }

  void _onChanged() {
    if (!mounted) return;
    setState(() {});
    // ★ **服务端说"装上了一个小程序"** ⇒ 重拉一次清单（桌面**自己长出来**，不用刷新页面）
    final rev = widget.controller.appsRevision;
    if (rev != _appsRevision) {
      _appsRevision = rev;
      unawaited(_loadMyApps());
    }
    // ★ **换了房间 ⇒ 换句话说，现在该看的是另一条对话**（契约 `83` §五·甲）。
    //   ⚠️ 两件跟着走的事：
    //     ① "用户自己往上翻过"那个标志**不作数了** —— 那是**上一间**里的动作，
    //        拿它挡着的话，切进新房间会停在**最老**那一条（`27-SCROLL.md` 那类缺陷）；
    //     ② 钉到最新（新视口里没有"他刚才在看哪儿"可言）。
    if (widget.controller.scope != _shownScope) {
      _shownScope = widget.controller.scope;
      _userScrolledAway = false;
      WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToLatest());
    }
    // 新东西进来时重绘 + 滚到底；**用户正在往上翻时不打断他**
    WidgetsBinding.instance.addPostFrameCallback((_) => _followBottom());
  }

  /// **上一次画出来的那个房间**（用来认出"房间换了" —— 见 [_onChanged]）。
  late String _shownScope = widget.controller.scope;

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
                // ★ 第二个小程序（主人 2026-09-22 点名的"奥数题库" ⇒ 见 `57-MATH.md`）
                DesktopApp(
                  label: mathAppLabel,
                  id: builtInMathId,
                  icon: _builtInIcon(builtInMathId),
                  onOpen: (from) => _openMiniApp(from, builtInMathId),
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
        view: buildMiniAppView(
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
    if (_openApp == builtInMathId) {
      return (view: const MathQuizScreen(), title: mathTitle);
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

  /// 容器顶上那行字：谁开着就写谁。
  String _mineTitle(ChatController c) {
    final mine = _openMine();
    if (mine != null) return mine.title;
    if (_openApp == builtInDiscoverId) return discoverTitle;
    // ⚠️ 「我自己那台」也要在这儿认一下：不认的话聊天条那个图标会写着
    //    「在『设置』里问」—— 一句假话（`chat_scope_icon_test` 就是钉这件事的形状）。
    if (_openApp == builtInHarnessId) return harnessAppLabel;
    return _openApp == builtInMathId ? mathTitle : configTitle;
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
    builtInMathId => Icons.calculate_outlined,
    builtInDiscoverId => Icons.travel_explore_outlined,
    builtInHarnessId => Icons.computer_outlined,
    _ => Icons.settings_outlined,
  };

  /// **现在这句话是在哪儿说的** ⇒ 聊天条最前面那个图标（主人 2026-09-23）。
  ///
  /// * 没进任何小程序 = **在桌面上**（也就是全局）⇒ 一个**家**；
  /// * 进了某个小程序 ⇒ **那个小程序自己的图标**（桌面点开的那个）。
  ///
  /// ⚠️ **它只是指示、不是按钮**：点了什么都不做 —— 主人要的是"看得出来现在在哪儿"。
  ///    真让它可点就等于多一个出口，那要另配一条行为与 ≥44 的命中区（D3.6），不在这一刀里。
  IconData _scopeIcon() {
    final id = _openApp;
    if (id == null) return Icons.home_outlined;
    if (id.startsWith(_minePrefix)) {
      final mine = _openMine();
      // ⚠️ 清单刷新之后那条可能没了（`_openMine()` 为 null）⇒ 给默认的小程序图标，
      //    **不许**掉进下面那个 switch（那会把"我的某个小程序"画成设置）。
      return mine == null ? defaultAppIcon : miniAppIconFor(mine.icon);
    }
    return _builtInIcon(id);
  }

  /// 那个图标本身（带说明：长按/读屏听到"这句话是在哪儿说的"）。
  Widget _scopeBadge(ChatController c) => Tooltip(
    message: _openApp == null
        ? chatScopeDesktop
        : chatScopeInApp(_mineTitle(c)),
    child: Icon(_scopeIcon(), size: 18, color: d.ink),
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

  /// 拉一次"我的小程序"（乙-1）。**失败了就当空的**（不弹错 —— 它不是用户主动要的东西）。
  Future<void> _loadMyApps() async {
    final token = widget.controller.token;
    if (token == null) return;
    final got = await widget.controller.api.apps(token);
    if (!mounted) return;
    setState(() => _myApps = got);
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
    if (which.startsWith(_minePrefix) && _mineStale(which)) {
      await _loadMyApps(); // 拿新的签名 URL（失败就当没拿到：下面照样开，至多是那句空）
    }
    if (!mounted) return;
    setState(() {
      _appFrom = from;
      _openApp = which;
    });
    // 🔴 **跟着图标走**（契约 `83-APP-WORKSPACE.md` §五·甲）：
    //    打开哪个小程序，**下面那条聊天就是它的对话**。
    //    ⚠️ 判定是**纯函数**（`models/scope.dart`）：只有"我的小程序"有自己的房间，
    //      内置那几个（设置 / 奥数题 / 发现 / 「我自己那台」）**不在** `/api/apps` 里，
    //      服务端没有它们的 id ⇒ 那期间房间**仍然是主线**（理由写在那个文件顶上）。
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
        controller: _scroll,
        // ★ 主人 2026-09-22："聊天浮窗的 padding 减少一些"（里面这一圈）：12 → 8
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        itemCount: header + c.items.length + (c.hasProcess ? 1 : 0),
        itemBuilder: (context, i) {
          if (header == 1 && i == 0) return olderLine!;
          final k = i - header;
          if (k < c.items.length) return _render(c.items[k], c);
          return ProcessTail(
            level: c.level,
            busyText: c.agentLine,
            steps: c.steps,
          );
        },
      ),
    );
  }

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
      onResend: () => c.resend(item.messageId),
      onLongPress: () => _onBubbleLongPress(c, item),
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
          onLongPress: () => _onBubbleLongPress(c, m),
          // ⚠️ 开不了外面的地址就传 `null` ⇒ 出处只当文字（**不画按不动的按钮**）
          onOpenSource: canOpenLinks ? openExternal : null,
          // ★ **读一遍**（每条都能念；念不了就传 `null` —— 同一条规矩）
          onSpeak: canSpeak ? () => c.speakMessage(m.messageId, m.displayText) : null,
          onStopSpeak: c.stopSpeakingNow,
          speaking: c.speakingId == m.messageId,
        ),
        if (reasoning.isNotEmpty) ReasoningBlock(text: reasoning),
      ],
    );
  }

  // ── 长按气泡 → 删掉这一轮（契约 `28-DELETE.md`）────────────────

  /// 长按气泡：先弹菜单，选中"删掉"之后**先取清单、再删**（§四：删前必须列清单）。
  ///
  /// ⚠️ 一次问答 = 一轮 = 两个 `messageId`（§三·补）——那两个 id 由
  ///    `ChatController.turnMessageIds` 从**画得出来的**那几条里算出来。
  ///    算不出来（比如这句还没发出去）⇒ **连入口都不给**：那会是一个
  ///    "看起来能删、其实服务端没有它"的动作。
  Future<void> _onBubbleLongPress(ChatController c, TimelineItem item) async {
    final id = item.messageId;
    if (id == null) return;
    final ids = c.turnMessageIds(id);
    if (ids == null) return;

    final action = await showModalBottomSheet<BubbleAction>(
      context: context,
      builder: (_) => const BubbleMenu(),
    );
    if (action != BubbleAction.delete || !mounted) return;
    await _deleteTurn(c, ids);
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
