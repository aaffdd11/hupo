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

import 'package:flutter/material.dart';

import '../models/conn_state.dart';
import '../models/export_words.dart';
import '../models/scroll_follow.dart';
import '../models/space.dart';
import '../models/space_words.dart';
import '../models/timeline.dart';
import '../models/trash_words.dart';
import '../services/api.dart';
import '../services/chat_controller.dart';
import '../widgets/bubble_menu.dart';
import '../widgets/bubbles.dart';
import '../widgets/composer.dart';
import '../widgets/notice.dart';
import '../widgets/process_level_menu.dart';
import '../widgets/process_view.dart';
import '../widgets/trash_plan_sheet.dart';
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
    this.onCancelMe,
    this.onKeyChanged,
  });

  final ChatController controller;
  final VoidCallback onLoggedOut;

  /// **"我那台到哪一步了"**（服务端说的）—— 「配置」那一屏要拿它如实说现状。
  final SpaceInfo space;

  /// 把钥匙交上去（和第一次那一屏**同一个入口**）。`null` ⇒ 顶栏不显示「配置」
  /// （单看这一屏的测试可以不传）。
  final Future<KeySend> Function(String key)? onSendKey;

  /// 取消注册（照样只有一次实现，见 `KeyForm`）。
  final Future<CancelOutcome> Function()? onCancelMe;

  /// 换成功之后叫一声（上层去重问状态）。
  final VoidCallback? onKeyChanged;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _scroll = ScrollController();

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
    // ⚠️ **首屏也要跟一次**：本机缓存那一屏（`17-LOCAL-FIRST.md`）可能
    //    在挂载之前就已经在控制器里了，那时 `_onChanged` 一次都不会触发。
    WidgetsBinding.instance.addPostFrameCallback((_) => _followBottom());
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    _scroll.dispose();
    super.dispose();
  }

  void _onChanged() {
    if (!mounted) return;
    setState(() {});
    // 新东西进来时滚到底；**用户正在往上翻时不打断他**
    WidgetsBinding.instance.addPostFrameCallback((_) => _followBottom());
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
        _scroll.animateTo(pos.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    // ⚠️ **浮窗（通知）与主界面是 `Stack` 的两层，不是 `Column` 的两行。**
    //    约束 1 的判据是 **D4.8：高度变化 = 0px** —— 塞进 `Column` 就当场破掉
    //    （下面整块内容会被那条通知往下推）。有闸钉着：
    //    `test/widget/notice_overlay_test.dart` 量的是**下面内容前后同一个矩形**。
    final sheet = Scaffold(
      appBar: AppBar(
        title: const Text('助手'),
        actions: [
          // ⚠️ **回收站**（契约 §二 第 2 条：放顶栏）。删掉的东西先进这儿，
          //    30 天内能拿回来 —— 顶栏这一处就是"我删的东西去哪了"的答案。
          IconButton(
            tooltip: trashTooltip,
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => TrashScreen(controller: c, onLoggedOut: widget.onLoggedOut),
              ),
            ),
            icon: const Icon(Icons.delete_outline),
          ),
          // ⚠️ **导出**（契约 `30-EXPORT.md` §四：和删除入口**对称** ——
          //    能删掉，就能拿走）。位置**等主人看过再定，不属于契约**，
          //    所以这一批只保证"有一个能进去的入口"。
          IconButton(
            tooltip: exportTooltip,
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ExportScreen(controller: c, onLoggedOut: widget.onLoggedOut),
              ),
            ),
            icon: const Icon(Icons.copy_all_outlined),
          ),
          // ⚠️ **过程四档的入口**（契约 §五：位置等主人看过再定，
          //    所以这一批只做"能切"）。换档要重连（`level` 是连接级的）。
          IconButton(
            tooltip: '它说多少过程',
            onPressed: () => _pickLevel(c),
            icon: const Icon(Icons.tune),
          ),
          // ⚠️ **配置**（主人 2026-09-22："用户可以在页面唤起配置。配置上可以输入 apikey"）。
          //    ⚠️ 它**不是**装饰：钥匙原来是"填过就再也回不去"的（欠账 #34），
          //      这一处就是那个缺口 —— 换一把、或者看看自己到底填过没有。
          //    ⚠️ **「关于」搬进它里面了**：顶栏原来 5 个图标，再加一个就是 7 个，
          //      手机上那一条会挤成一团（五档字号那道硬闸本来就在盯这个）；
          //      而"关于"本来就是配置那一类东西。
          if (widget.onSendKey != null)
            IconButton(
              tooltip: configEntry,
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => SettingsScreen(
                    hasKey: widget.space.hasKey,
                    keyBad: widget.space.keyBad,
                    // ⚠️ 本机那一份（主人自己那个号）**没有单独一台** ⇒ 那一屏只说实话
                    localOnly: !widget.space.isTenant,
                    onSubmit: widget.onSendKey!,
                    onCancel: widget.onCancelMe,
                    onCancelled: widget.onLoggedOut,
                    onKeyChanged: widget.onKeyChanged,
                  ),
                ),
              ),
              icon: const Icon(Icons.settings_outlined),
            ),
          IconButton(
            tooltip: '退出',
            onPressed: () async {
              await c.logout();
              widget.onLoggedOut();
            },
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: _sheetBody(c),
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
              child: _body(c),
            ),
          ),
        ),
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: Composer(onSend: c.send),
          ),
        ),
        SizedBox(height: MediaQuery.viewInsetsOf(context).bottom),
      ],
    );
  }

  /// 时间线本体 + 尾巴上那一块**过程**（步骤流水 / 那行「它正在做…」）。
  ///
  /// ⚠️ 那一块**算在列表里**（会跟着滚），不是浮在输入框上面——
  ///    它是"这一轮正在发生"，属于对话流，不属于工具栏。
  Widget _body(ChatController c) {
    if (c.items.isEmpty && !c.hasProcess) return const _EmptyState();
    return NotificationListener<ScrollNotification>(
      // ⚠️ **只有手指拖出来的滚动**才算"用户自己翻走了"。
      //    我们自己 `animateTo` 产生的那一次不算 —— 否则第一次跟随
      //    就等于把自己关掉（那正是"打开停在最老"的另一种写法）。
      onNotification: (n) {
        // ⚠️ 两类分开判：`dragDetails` 不在基类 `ScrollNotification` 上，
        //    合在一个条件里 Dart 提升不出类型来（会报 undefined_getter）。
        if (n is ScrollStartNotification && n.dragDetails != null) {
          _userScrolledAway = true;
        }
        if (n is ScrollUpdateNotification && n.dragDetails != null) {
          _userScrolledAway = true;
        }
        return false;
      },
      child: ListView.builder(
        controller: _scroll,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        itemCount: c.items.length + (c.hasProcess ? 1 : 0),
        itemBuilder: (context, i) => i < c.items.length
            ? _render(c.items[i], c)
            : ProcessTail(
                level: c.level,
                busyText: c.agentLine,
                steps: c.steps,
              ),
      ),
    );
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
        AnswerBubble(message: m, onLongPress: () => _onBubbleLongPress(c, m)),
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
      color: isError ? theme.colorScheme.errorContainer : theme.colorScheme.surfaceContainerHighest,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Text(text, style: theme.textTheme.bodySmall),
    );
  }
}

/// 空屏。手册 D1/D3：**不许写"你好，我能帮你做什么"**（人格硬规则禁止留客式追问）。
class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text('说点什么', style: theme.textTheme.titleMedium),
          const SizedBox(height: 12),
          Text(
            // 说清"能干什么"，不是"我是什么"
            '记一笔账、问一件事、让它去查个东西。\n'
            '它会把做过的事说给你听。',
            style: theme.textTheme.bodyMedium,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}
