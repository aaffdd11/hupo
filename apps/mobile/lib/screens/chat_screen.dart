// 对话页：用户与**调度器**的界面。
//
// 关键认知：用户不是跟某个 agent 聊天，而是跟调度器聊天。
// 所以界面渲染的是**一条时间线** —— 用户发言与调度器发言都是独立条目，
// 不做配对、不强制交替。用户可以说三句而调度器只回一句，也可以一句不说。
//
// 版面结构（自下而上三层）：
//   1. 应用桌面 —— 主页面，图标墙。它同时也是聊天浮窗**后面那一层**。
//   2. 贴底浮窗 —— 聊天窗口，**永远在**。可以拖、可以甩、可以点标题行收起。
//   3. 小程序容器 —— 点桌面图标打开的整页，盖在最上面。
//
// 窗口高度用一个系数 [_hFactor] 表示（0=收起 1=拉满），所有操作
// （拖拽 / 甩动 / 按钮 / 点外面 / 新消息）最终都归到改这个数。

import 'package:flutter/material.dart';

import '../apps/app_registry.dart';
import '../apps/mini_app.dart';
import '../models/stream_event.dart';
import '../models/timeline.dart';
import '../services/chat_controller.dart';
import '../services/transport.dart';
import '../widgets/answer_bubble.dart';
import '../widgets/app_desktop.dart';
import '../widgets/dev_card.dart';
import '../widgets/mini_app_container.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.controller,
    this.transport,
    this.bottomSheet,
    this.devMode = false,
    this.onExitDevMode,
  });

  final ChatController controller;

  /// 网络传输：桌面上的"会话"应用要用它。为 null 时那个应用不出现。
  final ChatTransport? transport;

  /// 可选的底部附加区域（开发期放场景切换器）。
  final Widget? bottomSheet;

  /// 开发者模式：桌面上会多一个「开发者模式」应用（默认关闭）。
  final bool devMode;

  /// 关闭开发者模式。
  final VoidCallback? onExitDevMode;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> with WidgetsBindingObserver {
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();

  // ── 浮窗高度 ──────────────────────────────────────────────
  /// 收起时的高度：抓手 + 一行预览 + 输入条。
  static const double _collapsedH = 124;

  /// 浮窗四周留的边距 —— **这就是"边缘"**。
  static const double _gapX = 10;
  static const double _gapBottom = 10;
  static const double _gapTop = 12;

  /// 高度系数：0 = 收起，1 = 拉满。
  double _hFactor = 0.0;

  /// 上一次"展开"用到的高度，供收起后再展开恢复。
  double _lastExpandedFactor = 1.0;
  double _maxH = 600;

  /// 正在用手指拖：这期间高度必须**跟手**（零动画），松手才做吸附动画。
  bool _dragging = false;

  /// 上一次看到的调度器消息 id —— 用来判断"助手是不是刚开口"。
  String? _lastSeenMessageId;

  /// 有没有见过时间线里的东西。
  ///
  /// 用来区分"补历史"和"正在对话"：补历史不该把浮窗拽开 ——
  /// 用户刚进来是要看桌面的，不是要看几小时前的旧对话。
  bool _sawTimeline = false;

  /// 当前打开的应用（null = 在桌面上）。
  MiniApp? _openApp;

  // ── 历史分页 ──────────────────────────────────────────────
  static const int _pageSize = 10;
  int _visibleCount = _pageSize;
  int _hiddenRows = 0;
  bool _didInitialScroll = false;
  bool _adjustingScroll = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_onChanged);
    _scrollController.addListener(_onScroll);
  }

  @override
  void didUpdateWidget(ChatScreen old) {
    super.didUpdateWidget(old);
    // 开发者模式被关掉：桌面上不该留一个点开是空的图标，正开着的也关掉。
    if (old.devMode && !widget.devMode && _openApp?.id == 'dev') {
      _openApp = null;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_onChanged);
    _scrollController.removeListener(_onScroll);
    _inputController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 切回前台必须续传补齐 —— 移动端这是常态，不是异常分支
    if (state == AppLifecycleState.resumed) widget.controller.reconnect();
  }

  void _onChanged() {
    if (!mounted) return;

    final c = widget.controller;
    final latestId = c.latestDispatcherMessage?.messageId;

    // 第一批历史（进页面后一次性补上来的）不算"对话发生了"，
    // 不能把浮窗拽开 —— 那会把桌面糊掉。
    final hydration = !_sawTimeline && c.timeline.isNotEmpty;
    if (c.timeline.isNotEmpty) _sawTimeline = true;

    if (latestId != null && latestId != _lastSeenMessageId) {
      _lastSeenMessageId = latestId;
      // 助手**开始回答**也拉满 —— "每次对话，浮窗就是最大化的"
      if (!hydration && _hFactor < 0.999) _maximize();
    }

    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      final pos = _scrollController.position;

      // 进入以后**停在最新的那几条上**，不是从头开始的第 1 条。
      if (!_didInitialScroll && c.timeline.isNotEmpty) {
        _didInitialScroll = true;
        _adjustingScroll = true;
        _scrollController.jumpTo(pos.maxScrollExtent);
        _adjustingScroll = false;
        return;
      }

      if (pos.maxScrollExtent - pos.pixels < 160) {
        _scrollController.animateTo(
          pos.maxScrollExtent,
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
        );
      }
    });
  }

  /// 往上滑到顶 ⇒ 再放出一页更早的。
  void _onScroll() {
    if (_adjustingScroll) return;
    if (!_scrollController.hasClients) return;
    if (_hiddenRows <= 0) return;
    if (_scrollController.position.pixels > 24) return;
    _showOlder();
  }

  /// 把藏在上面的更早一页放出来。
  ///
  /// 关键：放出来之后要**保住"离底部有多远"** —— 否则每放一页，
  /// 用户正看着的那句话就会往下跑一屏，读历史变成追历史。
  void _showOlder() {
    if (_adjustingScroll || !_scrollController.hasClients) return;
    final fromBottom =
        _scrollController.position.maxScrollExtent - _scrollController.position.pixels;
    setState(() => _visibleCount += _pageSize);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      final pos = _scrollController.position;
      final target = (pos.maxScrollExtent - fromBottom)
          .clamp(pos.minScrollExtent, pos.maxScrollExtent)
          .toDouble();
      _adjustingScroll = true;
      _scrollController.jumpTo(target);
      _adjustingScroll = false;
    });
  }

  /// 这一页铺不满一屏时，"往上滑"这个动作根本做不出来 —— 那就接着再放。
  void _fillViewportIfNeeded() {
    if (!mounted || _adjustingScroll) return;
    if (!_scrollController.hasClients) return;
    if (_hiddenRows <= 0) return;
    if (_scrollController.position.maxScrollExtent > 0) return;
    _showOlder();
  }

  Future<void> _say() async {
    final text = _inputController.text.trim();
    if (text.isEmpty) return;
    _inputController.clear();
    _maximize(); // 每次对话都拉满，别让用户对着一条缝等
    await widget.controller.say(text);
  }

  // ── 应用桌面 ──────────────────────────────────────────────

  List<MiniApp> _apps() => availableMiniApps(MiniAppEnv(
        controller: widget.controller,
        transport: widget.transport,
        devMode: widget.devMode,
        exitDevMode: widget.onExitDevMode ?? () {},
      ));

  void _open(MiniApp app) {
    setState(() => _openApp = app);
  }

  /// 关掉当前应用。开发者模式那个应用被关掉 = 开发者模式也关掉。
  void _closeApp() {
    final app = _openApp;
    setState(() => _openApp = null);
    if (app != null && app.id == 'dev') widget.onExitDevMode?.call();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final theme = Theme.of(context);
    final latest = c.latestDispatcherMessage;
    final busyNow = latest != null && !latest.isFinished;
    final open = _openApp;

    return Scaffold(
      // 键盘弹出时整个 body 上移，浮窗跟着抬起来，不会被挡住
      body: LayoutBuilder(
        builder: (context, constraints) {
          _maxH = constraints.maxHeight;
          WidgetsBinding.instance.addPostFrameCallback((_) => _fillViewportIfNeeded());
          final h = _panelHeight(constraints.maxHeight);

          return Stack(
            children: [
              // ── 第一层：应用桌面 ──────────────────────────
              //
              // 点**这里**（浮窗外面）才收起 —— 点浮窗自己不该有任何反应。
              // 点图标则打开对应的应用（图标有自己的手势，会先赢）。
              Positioned.fill(
                child: GestureDetector(
                  key: const Key('panel-backdrop'),
                  behavior: HitTestBehavior.opaque,
                  onTap: _collapseFromOutside,
                  child: AppDesktop(
                    apps: _apps(),
                    status: widget.devMode ? _devStatus(c) : null,
                    onOpen: _open,
                  ),
                ),
              ),

              // ── 第二层：贴底浮窗（永远在）─────────────────
              Positioned(
                left: _gapX,
                right: _gapX,
                bottom: _gapBottom,
                child: _floatingPanel(c, theme, h, busyNow),
              ),

              // ── 第三层：打开的应用（盖在最上面）───────────
              if (open != null)
                Positioned.fill(
                  child: MiniAppContainer(
                    app: open,
                    onClose: _closeApp,
                  ),
                ),
            ],
          );
        },
      ),
    );
  }

  /// 桌面上那行小字：后台正在做什么。
  static String _devStatus(ChatController c) {
    final phase = currentDevPhase(c.devSteps);
    return phase == null ? '' : '正在：$phase';
  }

  /// 顶部要留出多少：没有开发卡片之后就是固定的一条缝。
  double get _topInset => _gapTop;

  /// 可伸缩的空间：屏幕高 − 上下边距 − 收起高度。
  double _spanFor(double maxH) =>
      (maxH - _topInset - _gapBottom - _collapsedH).clamp(0.0, double.infinity);

  double _panelHeight(double maxH) {
    return _collapsedH + _spanFor(maxH) * _hFactor.clamp(0.0, 1.0);
  }

  bool get _collapsed => _hFactor <= 0.001;

  // ── 拉升 / 缩小 ───────────────────────────────────────────
  //
  // 四种方法，随便哪种都行：
  //   · 拖抓手或标题行（整条都能拖，不再只有那 14px）
  //   · 甩：往下甩收起、往上甩拉满（按速度判，不看拖了多远）
  //   · 点标题行右边的收起/展开按钮
  //   · 双击抓手 ／ 点浮窗外面

  void _onDragStart(DragStartDetails _) {
    setState(() => _dragging = true);
  }

  void _onDragUpdate(DragUpdateDetails d) {
    final span = _spanFor(_maxH);
    if (span <= 0) return;
    setState(() {
      // 往下拖 = 变矮
      _hFactor = (_hFactor - d.delta.dy / span).clamp(0.0, 1.0);
    });
  }

  void _onDragEnd(DragEndDetails d) {
    setState(() => _dragging = false);
    _snapWithVelocity(d.velocity.pixelsPerSecond.dy);
  }

  /// 松手：按速度决定去向，速度不够就吸附到最近的档位。
  void _snapWithVelocity(double vy) {
    const stops = <double>[0.0, 0.5, 1.0];
    double target;
    if (vy > 650) {
      target = 0.0; // 往下甩 ⇒ 收起
    } else if (vy < -650) {
      target = 1.0; // 往上甩 ⇒ 拉满
    } else {
      // 拖到 0.3 以下就当用户想收起，不要卡在中间档
      target = _hFactor < 0.3
          ? 0.0
          : stops.reduce((a, b) => (b - _hFactor).abs() < (a - _hFactor).abs() ? b : a);
    }
    setState(() {
      _hFactor = target;
      if (target > 0) _lastExpandedFactor = target;
    });
    _scrollToBottom();
  }

  void _toggleCollapsed() {
    setState(() {
      if (_collapsed) {
        _hFactor = _lastExpandedFactor;
      } else {
        _lastExpandedFactor = _hFactor;
        _hFactor = 0.0;
      }
    });
    _scrollToBottom();
  }

  /// 点浮窗**外面**：收起。已经在收起状态就什么都不做（没有更可收的了）。
  void _collapseFromOutside() {
    if (_collapsed) return;
    setState(() {
      _lastExpandedFactor = _hFactor;
      _hFactor = 0.0;
    });
  }

  /// **拉满**：每次对话（用户开口 / 助手开始回答）都回到最大化。
  void _maximize() {
    if (_hFactor >= 0.999) {
      _scrollToBottom();
      return;
    }
    setState(() {
      _hFactor = 1.0;
      _lastExpandedFactor = 1.0;
    });
    _scrollToBottom();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    });
  }

  /// 浮窗本体：抓手 + 标题行 + 消息列表 + 状态条 + 输入条。
  ///
  /// **连不上后端时整块变灰并且不可触达**：
  /// 服务在重启的那几秒里，用户点什么都没用 —— 与其让他戳半天没反应，
  /// 不如明确告诉他"现在不通，正在自己回来"，然后自动恢复。
  Widget _floatingPanel(
    ChatController c,
    ThemeData theme,
    double h,
    bool busy,
  ) {
    final panel = _panelBody(c, theme, h, busy);
    if (c.connected) return panel;

    return Stack(
      children: [
        // 灰掉：不是调透明度（那只是变淡），是**真的抽掉颜色**
        ColorFiltered(
          colorFilter: const ColorFilter.matrix(<double>[
            0.2126, 0.7152, 0.0722, 0, 0, //
            0.2126, 0.7152, 0.0722, 0, 0, //
            0.2126, 0.7152, 0.0722, 0, 0, //
            0, 0, 0, 1, 0, //
          ]),
          child: IgnorePointer(child: panel), // 不可触达
        ),
        Positioned.fill(
          child: IgnorePointer(
            child: Center(
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 16),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surface.withValues(alpha: 0.92),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2, color: theme.hintColor),
                    ),
                    const SizedBox(height: 10),
                    Text('正在恢复连接…',
                        style: theme.textTheme.bodyMedium?.copyWith(color: theme.hintColor)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _panelBody(
    ChatController c,
    ThemeData theme,
    double h,
    bool busy,
  ) {
    final latestText = c.latestDispatcherMessage?.displayText.trim() ?? '';

    return GestureDetector(
      // 只用来**挡住**手势：点在浮窗自己身上（读、写、翻历史）不该有任何反应。
      // 收起改由"点浮窗外面"触发（见 build 里的桌面层）。
      // ⚠ behavior 必须是 opaque —— deferToChild 挡不住，点在空白处会漏到桌面。
      behavior: HitTestBehavior.opaque,
      child: AnimatedContainer(
        // 测试锚点：用它量浮窗的位置和高度（"是不是贴底、有没有铺满"）
        key: const Key('floating-panel'),
        height: h,
        // 拖的时候必须跟手（零动画），松手才做吸附动画
        duration: _dragging ? Duration.zero : const Duration(milliseconds: 200),
        curve: Curves.easeOutCubic,
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerLow,
          // 四个角都圆：两边留了边距，圆角才看得出来
          borderRadius: BorderRadius.circular(18),
          boxShadow: [
            // 两层阴影：外面一层散的（把浮窗从背景上抬起来），
            // 里面一层紧的（勾出边缘）。只有一层会像"画上去的"，不像浮着。
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.45),
              blurRadius: 32,
              spreadRadius: 2,
              offset: const Offset(0, -6),
            ),
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.35),
              blurRadius: 6,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(18),
          child: Column(
            children: [
              // ── 抓手 + 标题行：整条都是拖拽区 ──────────────
              GestureDetector(
                key: const Key('panel-handle'),
                behavior: HitTestBehavior.opaque,
                onVerticalDragStart: _onDragStart,
                onVerticalDragUpdate: _onDragUpdate,
                onVerticalDragEnd: _onDragEnd,
                onDoubleTap: _toggleCollapsed,
                child: Column(
                  children: [
                    SizedBox(
                      height: 14,
                      child: Center(
                        child: Container(
                          width: 40,
                          height: 4,
                          decoration: BoxDecoration(
                            color: theme.hintColor.withValues(alpha: 0.5),
                            borderRadius: BorderRadius.circular(2),
                          ),
                        ),
                      ),
                    ),
                    // 收起时这行就是"最新一句话"
                    SizedBox(
                      height: 32,
                      child: Row(
                        children: [
                          const SizedBox(width: 14),
                          Icon(Icons.graphic_eq, size: 14, color: theme.hintColor),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              latestText.isEmpty
                                  ? '助手'
                                  : latestText.replaceAll('\n', ' '),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.hintColor,
                              ),
                            ),
                          ),
                          if (busy)
                            const Padding(
                              padding: EdgeInsets.only(right: 6),
                              child: SizedBox(
                                width: 11,
                                height: 11,
                                child: CircularProgressIndicator(strokeWidth: 1.5),
                              ),
                            ),
                          // 收起时也要让用户知道"还有件事没回来"——
                          // 但不能占输入条的地方，所以压缩成一个小标
                          if (_collapsed && c.activeTasks.isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(right: 4),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(Icons.schedule, size: 12, color: theme.hintColor),
                                  const SizedBox(width: 3),
                                  Text(
                                    '${c.activeTasks.length}',
                                    style: theme.textTheme.labelSmall?.copyWith(
                                      color: theme.hintColor,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          IconButton(
                            tooltip: _collapsed ? '展开' : '收起',
                            iconSize: 19,
                            visualDensity: VisualDensity.compact,
                            icon: Icon(
                              _collapsed ? Icons.expand_less : Icons.expand_more,
                            ),
                            onPressed: _toggleCollapsed,
                          ),
                          const SizedBox(width: 4),
                        ],
                      ),
                    ),
                  ],
                ),
              ),

              // ── 消息列表 ────────────────────────────────
              Expanded(
                child: ListView(
                  controller: _scrollController,
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  children: _buildRows(c, theme),
                ),
              ),

              if (!_collapsed && c.connectionError != null)
                Container(
                  width: double.infinity,
                  color: theme.colorScheme.errorContainer,
                  padding: const EdgeInsets.symmetric(
                    vertical: 6,
                    horizontal: 12,
                  ),
                  child: Text(
                    c.connectionError!,
                    style: theme.textTheme.bodySmall,
                  ),
                ),
              // 正在做的事：让用户知道"还有件事没回来"，但不显示进度百分比
              if (!_collapsed && c.activeTasks.isNotEmpty)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    vertical: 6,
                    horizontal: 16,
                  ),
                  color: theme.colorScheme.surfaceContainer,
                  child: Row(
                    children: [
                      SizedBox(
                        width: 12,
                        height: 12,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.6,
                          color: theme.hintColor,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          c.activeTasks.length == 1
                              ? '还有件事在处理：${c.activeTasks.values.first.title}'
                              : '还有 ${c.activeTasks.length} 件事在处理',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.hintColor,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              // 被动聆听：状态走独立区域，**不占消息位**（状态不是消息）
              if (!_collapsed && c.isListening)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    vertical: 6,
                    horizontal: 16,
                  ),
                  color: theme.colorScheme.surfaceContainer,
                  child: Row(
                    children: [
                      Icon(Icons.graphic_eq, size: 14, color: theme.hintColor),
                      const SizedBox(width: 6),
                      Text(
                        '正在听…',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.hintColor,
                        ),
                      ),
                    ],
                  ),
                ),
              _Composer(
                controller: _inputController,
                onSend: _say,
                // 输入框**永不锁死**：调度器在说话时也允许插话
                onCancel: busy ? c.cancelLatest : null,
              ),
              if (widget.bottomSheet != null) widget.bottomSheet!,
            ],
          ),
        ),
      ),
    );
  }

  /// 时间线 → 界面。
  ///
  /// **不做配对**：直接按顺序渲染，用户发言与调度器消息各自成条。
  ///
  /// 另外：进来只铺**最新的 [_pageSize] 条**。更早的藏在上面，
  /// 往上滑到顶才一页一页放出来（见 [_onScroll]）。
  List<Widget> _buildRows(ChatController c, ThemeData theme) {
    final items = <TimelineItem>[];
    for (final item in c.timeline) {
      switch (item) {
        case UserUtterance():
          items.add(item);
        case DispatcherMessage():
          if (_shouldRender(item)) items.add(item);
      }
    }

    final hidden = items.length > _visibleCount ? items.length - _visibleCount : 0;
    _hiddenRows = hidden;
    final visible = hidden > 0 ? items.sublist(items.length - _visibleCount) : items;

    final rows = <Widget>[];
    for (final item in visible) {
      switch (item) {
        case UserUtterance():
          rows.add(_UserBubble(utterance: item));
        case DispatcherMessage():
          rows.add(AnswerBubble(message: item));
      }
    }

    if (rows.isEmpty) {
      rows.add(
        Padding(
          padding: const EdgeInsets.only(top: 120),
          child: Center(
            child: Text(
              '说点什么',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.hintColor,
              ),
            ),
          ),
        ),
      );
    }
    return rows;
  }

  /// 该条调度器消息是否渲染成气泡。
  ///
  /// - 有正文 ⇒ 渲染
  /// - 无正文但在思考/交接/干活 ⇒ 渲染（气泡里只有状态行，承担在场感）
  /// - 无正文且**被动聆听** ⇒ 不渲染（不出声；状态由独立指示器承担）
  bool _shouldRender(DispatcherMessage m) {
    if (m.hasAnyText) return true;
    if (m.status == null) return false;
    return m.status != StreamStatus.listening;
  }
}

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.utterance});

  final UserUtterance utterance;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 520),
        margin: const EdgeInsets.symmetric(vertical: 6, horizontal: 12),
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 14),
        decoration: BoxDecoration(
          color: theme.colorScheme.primaryContainer,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(4),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: SelectableText(
                utterance.text,
                style: theme.textTheme.bodyLarge,
              ),
            ),
            if (utterance.pending) ...[
              const SizedBox(width: 8),
              SizedBox(
                width: 10,
                height: 10,
                child: CircularProgressIndicator(
                  strokeWidth: 1.4,
                  color: theme.hintColor,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.onSend,
    this.onCancel,
  });

  final TextEditingController controller;
  final VoidCallback onSend;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        decoration: BoxDecoration(
          border: Border(
            top: BorderSide(color: theme.dividerColor, width: 0.5),
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                controller: controller,
                minLines: 1,
                maxLines: 5,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => onSend(),
                decoration: InputDecoration(
                  hintText: '说点什么',
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(
                    vertical: 10,
                    horizontal: 14,
                  ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(20),
                    borderSide: BorderSide.none,
                  ),
                  filled: true,
                  fillColor: theme.colorScheme.surfaceContainerHighest,
                ),
              ),
            ),
            const SizedBox(width: 4),
            if (onCancel != null)
              IconButton(
                tooltip: '停下',
                onPressed: onCancel,
                visualDensity: VisualDensity.compact,
                iconSize: 20,
                icon: const Icon(Icons.stop_circle_outlined),
              ),
            IconButton(
              tooltip: '发送',
              onPressed: onSend,
              visualDensity: VisualDensity.compact,
              iconSize: 20,
              icon: const Icon(Icons.arrow_upward),
            ),
          ],
        ),
      ),
    );
  }
}
