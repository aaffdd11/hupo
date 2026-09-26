// 可见时间线。手册 `02-ARCHITECTURE.md` §5、`08-SPEC.md` §4。
//
// 三条不能破的：
//   1. **一条时间线**，按 `(seq, tie)` 排序。客户端是**哑的**——
//      它不判断"这句合理吗、该不该配对"，只排序与渲染。
//   2. **不做配对**（协议 R1）。用户说两句、助手回一条，是正常的；
//      硬配对会逼出一堆"孤儿消息"。
//   3. **本地发言有乐观态**：按下发送就上屏（`queued`），
//      服务端的 `user/echo` 回来时**认领它**（同一个 messageId），
//      而不是再插一条——否则你会看到自己说的话出现两遍。
//
// ⚠️ 纯逻辑，**不许 import flutter/material**（禁令 1）。要进 `test/unit` 硬闸。

import 'chat_queue.dart';
import 'message_state.dart';
import 'notice.dart';
import 'process_words.dart';
import 'tool_row.dart';

/// 一条时间线条目。`seq` 是服务端发的号；本地乐观发言借用"当前最大号"。
sealed class TimelineItem {
  const TimelineItem({required this.seq, this.tie = 0});

  /// 服务端的排队号。
  final int seq;

  /// 同一号内的次序。本地发言用 1（排在已收到事件之后、下一条服务端事件之前）。
  final int tie;

  /// 排序键。**不许用时间戳当排序键**——
  /// 本地发言是客户端钟、服务端事件是服务端钟，混钟排序会乱。
  (int, int) get order => (seq, tie);

  /// 这一条对应的那个 id（分隔线没有 ⇒ `null`）。
  ///
  /// ⚠️ **删除的单位就是它**（契约 `28-DELETE.md` §三·补）：
  ///    落盘的事件里没有轮号，"一轮"由客户端按 `messageId` 认出来。
  String? get messageId => null;
}

/// 用户说的一句话。
class UserUtterance extends TimelineItem {
  UserUtterance({
    required this.messageId,
    required this.text,
    required super.seq,
    super.tie,
    this.state = MessageState.queued,
  });

  /// ⚠️ `@override`：基类那个 `messageId` 是"有的条目没有"（分隔线），
  ///    气泡**一定**有 ⇒ 这里收窄成非空（`_render` 那一层才不用到处判空）。
  @override
  final String messageId;
  final String text;
  MessageState state;

  UserUtterance copyWith({int? seq, int? tie, MessageState? state}) => UserUtterance(
        messageId: messageId,
        text: text,
        seq: seq ?? this.seq,
        tie: tie ?? this.tie,
        state: state ?? this.state,
      );
}

/// 助手说的一条（快答 + 深答**在同一个气泡里**，协议 R2）。
class AssistantMessage extends TimelineItem {
  AssistantMessage({required this.messageId, required super.seq});

  /// ⚠️ `@override`：理由同 [UserUtterance.messageId]。
  @override
  final String messageId;
  String quick = '';
  String deep = '';
  List<Map<String, dynamic>> sources = const [];
  bool ended = false;
  String? reason;
  bool catchUp = false;
  // ⚠️ 这里原先有个 `String? status`（thinking / working / handoff / listening），
  //    **删掉了**：它从来没有过生产者——服务端那几种状态
  //    （DSH 的 `session.status`）**都落在消息生命周期之外**，
  //    按 `messageId` 根本挂不上（见 `services/core/src/dispatcher.js` `#announceTurn`）。
  //    过程状态现在的地址是**轮**，不是气泡（`_turnState` / `agentLine`）。
  //    ⚠️ 批 3 把 `reasoning` 加回来了——**这个有真生产者**（`reasoning/delta`），
  //       而且它挂的正是气泡：主人回头要看的是"**这条回答**当时怎么想的"。

  /// 「推理原文」：**这一轮的思考原文**（D7.4，只有主人、默认关）。
  ///
  /// ⚠️ **一个字节都不许进存储**（契约 `122-TWO-PROCESS-LEVELS.md` §二）：
  ///    它可能含我们这边的原话（产品资产）。它挂在气泡上**只是为了显示**——
  ///    不占号（`reasoning/delta` 是瞬态），所以 `timeline_store` 那条
  ///    "只收带号的"判据天然碰不到它。
  ///
  /// ⚠️ **生命周期**（批 3 改过一次，别改回去）：
  ///    · 一轮收口**不清它**——一出答案就删，等于推理档只剩"生成时盯着看"，
  ///      而它真正的用处是**主人回头看它当时怎么想的**；
  ///    · `reset()`（重放 / 退出登录 / 服务端说号不对了）**必须清**——
  ///      因为它本来就不该存在于任何地方；
  ///    · 换出推理档只是**不显示**（`chat_controller` 那一层挡），不必删。
  String reasoning = '';

  /// 用户看到的正文。**中间不加连接词**（那会像两个人在接话）；
  /// 但快答没以句末标点结尾时补一个空格，免得两句粘在一起。
  String get displayText {
    if (quick.isEmpty) return deep;
    if (deep.isEmpty) return quick;
    final needsSpace = !RegExp(r'[。！？!?；;：:…\n]$').hasMatch(quick);
    return needsSpace ? '$quick $deep' : '$quick$deep';
  }

  bool get isEmpty => quick.isEmpty && deep.isEmpty;

  /// 已经拼进这个气泡的那些**流式片段**：`(block, seqInBlock)`。
  ///
  /// ⚠️ 为什么非记不可（契约 `28-DELETE.md` §三·补 的**那个后果**）：
  ///    "从回收站拿回来"= 服务端把那几条**内容事件按原样重新追加一遍**
  ///    （**新 `seq`** ⇒ 盘上的历史一字不改）。
  ///    而客户端的 `_seenSeq` 是**按 `seq` 去重**的 ⇒ **挡不住这种重发**：
  ///    同一段正文会再 `+=` 一次，屏幕上那句话说两遍。
  ///    ⇒ 判据是 `(messageId, block, seqInBlock)`——`messageId` 不必进键，
  ///      因为这个集合本来就长在**那一条**气泡上。
  ///
  /// ⚠️ 只在内存里（`timeline_store` 存的是**事件**，不是这个集合）⇒
  ///    冷启动重放时它从空开始，缓存里的每一段各自拼一次，正是想要的。
  final Set<(String, int)> _chunks = {};

  /// 拼一段正文。**同一段第二次到 ⇒ 丢掉**（返回 `false`）。
  ///
  /// ⚠️ `seqInBlock` 认不出来（旧生产者 / 坏帧）⇒ **当新的一段拼上去**：
  ///    没有编号就分不出"重发"和"真的一段"，两条路都得选一个坏结果——
  ///    这里选"不吞内容"：吞掉一段正文是**屏幕少了字、没人看得出来**，
  ///    而我们自己的生产者（`message-writer.js` 的 `chunk()`）**每一段都带号**，
  ///    所以这条兜底在真机上根本不该被走到。
  bool addChunk({required String block, required Object? seqInBlock, required String text}) {
    final b = block == 'deep' ? 'deep' : 'quick';
    if (seqInBlock is int && !_chunks.add((b, seqInBlock))) return false;
    if (b == 'deep') {
      deep += text;
    } else {
      quick += text;
    }
    return true;
  }
}

/// 时间线上的一条分隔（"你不在的时候" / "进入某层"）。
///
/// ⚠️ 它**是持久事件**（取号、落盘、有位置），不是瞬态——
///    "不占号 = 不上时间线"，而它**要上时间线**（决策 P-g）。
class TimelineMarker extends TimelineItem {
  const TimelineMarker({required this.kind, required super.seq, this.label, this.catchUp = false});

  final String kind; // away / enter / leave
  final String? label;
  final bool catchUp;
}

/// **系统通知那一条**（契约 `29-NOTICE.md` 约束 2）。
///
/// 为什么它必须**进列表、占一个位置**：浮窗只是"喊一声"，它会自己消失；
/// 而"它替你做的决定 / 出事了 / 你不在时发生的事"要**经得起你不在**——
/// 主人在浮窗消失之后回来，也得看得见那一条。
///
/// ⚠️ 它是**持久事件**（`notice` 取号、落盘），所以走的是 `Timeline.apply`
///    那条"带 seq"的路；瞬态的 `notice/urgent` **绝不进这里**（决策 P-g）。
///
/// ⚠️ 它**没有 `messageId`**（不是一轮对话，删的是"话"，不是通知本身）⇒
///    长按删除那条路天然够不着它（`_visible` 那一处说得一样）。
class TimelineNotice extends TimelineItem {
  const TimelineNotice({
    required this.notice,
    required super.seq,
    this.catchUp = false,
  });

  final Notice notice;

  /// 它是**补发**上来的（断线重连 / 冷启动重放）。
  ///
  /// ⚠️ 这个标志只给**浮窗**看：补发的是"过去发生过的事实"，
  ///    而浮窗是"现在喊你一声"（和 `message/start` 那处 `!catchUp` 同理）。
  ///    时间线那一条**照画**——它本来就是给"你不在"留的。
  final bool catchUp;

  /// 这一条按得动的撤销；`null` = **不画那个按钮**。
  ///
  /// ⚠️ fail-closed（和 `NoticeUndo.usable` 同一条规矩）：认不出来的 `action`、
  ///    或者 id 清单是空的 ⇒ 不给入口。画一个按了不会有结果的按钮，
  ///    就是屏幕上说假话（N10）。
  /// ⚠️ 它是个**纯查询**：撤销**怎么走**（走哪条接口）不在这儿，在控制器那一层
  ///    ——两处（浮窗 + 时间线）必须走**同一条路**（约束 3）。
  NoticeUndo? get undo => (notice.undo?.usable ?? false) ? notice.undo : null;
}

// ── 开出来的那三样（`116` · 主人 2026-09-26：*"首先全部开放"*）──────
//
// 服务端把**工具调用 / 模型看到的系统提示词 / 每一轮的 token** 也发上来了
// （`tool/call` · `tool/result` · `system/prompt` · `turn/usage`；都是**持久**事件，
// 带号、落盘、翻页拿得到 —— 引擎在 `v2/services/core/src/tool-rows.js`）。
// 这一层只做一件事：**把它们当事实收进同一条日志**（排序、去重、隐藏、复位都照旧）。
//
// 🔴 **这里不做"消息配对"**（协议 R1 那条禁令还在：客户端不判断哪句该配哪句）。
//    工具行那一步是**认领身份**：`tool/result` 拿服务端给的 `callId` 找回**同一次调用**
//    那一行、就地补上结果（和 `user/echo` 认领本地那条乐观发言是同一个姿势）。
//    行的位置**不动**（还是 `tool/call` 那个 `seq`）⇒ "一条日志按 `(seq, tie)` 排"不变。

/// 时间线上的一次**工具调用**（`tool/call` → 一行；`tool/result` 回来就地补上）。
class TimelineToolCall extends TimelineItem {
  TimelineToolCall({required this.row, required super.seq});

  /// 那一行的全部内容（`ToolRow.parse` 出来的纯值）。
  ///
  /// ⚠️ **可变**：结果那一半到的时候**换掉它**（不是再插一行）——
  ///    换上去之后这行的 `seq` 还是调用那一个，位置一动都不动。
  ToolRow row;

  /// 配对用的身份（服务端给的）。
  String get callId => row.callId;

  /// 挂在哪一轮（折叠按它分组）。
  int get turn => row.turn;
}

/// 时间线上的一条**系统提示词**（`system/prompt`）。
///
/// ⚠️ 它是"**模型看到了什么**"的唯一凭据 ⇒ 逐字存着，一个字都不改
///    （`SystemPromptRow` 顶上那条：截断/改写的提示词行比没有更坏）。
class TimelineSystemPrompt extends TimelineItem {
  const TimelineSystemPrompt({required this.row, required super.seq});

  final SystemPromptRow row;

  int get turn => row.turn;
}

/// 时间线上的一条**用量**（`turn/usage`；一轮**一次尝试**一条）。
///
/// ⚠️ 它自己**不直接画**：账要**折过**才画（`foldTurnUsage`：任何一次没报准 ⇒ 整块不画），
///    由界面那一层在"这一轮的页脚"画一行。它进日志是为了**取号、落盘、翻页拿得到**。
class TimelineTurnUsage extends TimelineItem {
  const TimelineTurnUsage({required this.attempt, required super.seq});

  final TurnUsageAttempt attempt;

  int get turn => attempt.turn;
}

/// 过程里的**一步**（老 `steps` 档的 `step/*`，契约 `docs/dev/122` §四）。
///
/// ⚠️ **今天新客户端不再消费它**：菜单上那一档已经砍掉，界面上不画
///    （`widgets/process_view.dart`）。这一层仍然认 `step/*`，是因为
///    **老客户端还在发 `?level=steps`**、服务端也还按契约发 —— 协议不许破。
///
/// ⚠️ **瞬态**：不占号、不落盘（决策 P-g）⇒ 它**不是**时间线条目，
///    而是挂在**轮**上的一小段临时状态。轮一收口就清掉。
///
/// [state] 是**内部状态名**（`searching`…），要经 `processWord()` 翻成人话才上屏。
class ProcessStep {
  const ProcessStep({
    required this.turn,
    required this.step,
    required this.state,
    this.done = false,
  });

  /// 哪一轮的（乱序保护靠它）。
  final int turn;

  /// 一轮里的第几步（同一号重复到达 ⇒ 覆盖，不重复画）。
  final int step;

  /// 内部状态名。**绝不上屏**（`process_words.dart` 翻）。
  final String state;

  /// `step/end` 到了没有。用来画"这一步做完了"。
  final bool done;

  ProcessStep copyWith({bool? done}) =>
      ProcessStep(turn: turn, step: step, state: state, done: done ?? this.done);
}

/// **一轮** = 一条用户的话 + 它的回答（契约 `28-DELETE.md` §三·补）。
///
/// ⚠️ 为什么"分组"是**客户端**的事：落盘的事件里没有轮号
///    （`message/status` / `step/*` 上的 `turn` 是瞬态，盘上留不下），
///    而删除的单位又是"一轮" ⇒ 服务端没法自己分，只能由看得见时间线的这一侧给。
///
/// ⚠️ 它不是一个新的"配对协议"（协议 R1 那条禁令还在：客户端**不做配对**、
///    不判断哪句该配哪句）。它只回答一个很窄的问题：
///    **长按某一条时，该把哪几个 id 交给服务端**。
class TurnGroup {
  TurnGroup({this.userMessageId, this.answerMessageId});

  /// 用户那条的 id（还没说过话、或者话没被服务端认领 ⇒ `null`）。
  String? userMessageId;

  /// 回答那条的 id（还没答 / 还没轮到 ⇒ `null`）。
  String? answerMessageId;

  /// 交给服务端的 id 清单（**两个都可能只有其中一个**）。
  List<String> get messageIds => [
        if (userMessageId != null) userMessageId!,
        if (answerMessageId != null) answerMessageId!,
      ];

  bool contains(String messageId) =>
      userMessageId == messageId || answerMessageId == messageId;
}

/// 把一条时间线分成"一轮一轮"（纯函数 ⇒ 进 `test/unit` 硬闸）。
///
/// 规矩只有两条：
///   1. **只有到过服务端的那条才算一轮的头**（`confirmed` 的用户发言；助手的气泡
///      本来就是服务端来的）。用户自己还没发出去/没被认领的那句 ⇒ 不成轮
///      ——服务端那边根本没有它，删它是个空请求。
///   2. 回答**先到先配**：一条回答配给**最早那条还没配上回答**的用户发言。
///      ⇒ 这和服务端自己那套 `#turnOwner`（`delivered.shift()`）是同一条规矩，
///        连发两句时不会两边认成不同的一轮。
///
/// 配不上的两种残局也各自成组（"只有用户那句" / "只有那条回答"）——
/// 它们各是一个能删的东西，藏起来不必等另一半。
List<TurnGroup> turnGroupsOf(Iterable<TimelineItem> items) {
  final ordered = [...items]..sort((a, b) {
      final c = a.seq.compareTo(b.seq);
      return c != 0 ? c : a.tie.compareTo(b.tie);
    });
  final groups = <TurnGroup>[];
  final waiting = <TurnGroup>[]; // 说过话、还没等到回答的那些（先来先配）
  for (final it in ordered) {
    switch (it) {
      case UserUtterance():
        if (it.state != MessageState.confirmed) continue;
        final g = TurnGroup(userMessageId: it.messageId);
        groups.add(g);
        waiting.add(g);
      case AssistantMessage():
        if (waiting.isEmpty) {
          groups.add(TurnGroup(answerMessageId: it.messageId));
        } else {
          waiting.removeAt(0).answerMessageId = it.messageId;
        }
      case TimelineMarker():
        continue; // 分隔线不属于任何一轮
      case TimelineNotice():
        continue; // 通知也不属于任何一轮（它没有 messageId，删的是"话"）
      case TimelineToolCall():
      case TimelineSystemPrompt():
      case TimelineTurnUsage():
        // ★ `116` 那三样是**过程内容**，不是"谁说的话" ⇒ 不属于任何一轮
        //   （它们没有 messageId，删除那条路碰不到它们）。
        continue;
    }
  }
  return groups;
}

/// 某个 id 所在的那一轮；**不在任何一轮里 ⇒ `null`**。
///
/// ⚠️ `null` 是有意思的：比如"这句还没发出去"（它在服务端不存在），
///    那时界面上**不该给删掉这个入口**——给了就是个删不掉的动作。
TurnGroup? turnGroupOf(Iterable<TimelineItem> items, String messageId) {
  for (final g in turnGroupsOf(items)) {
    if (g.contains(messageId)) return g;
  }
  return null;
}

/// 时间线本体。
class Timeline {
  final List<TimelineItem> _items = [];
  final Set<int> _seenSeq = {};
  int _lastSeq = 0;

  /// 被删掉（进了回收站）的那些 id —— **藏起来，不销毁**（契约 §8.3）。
  ///
  /// ⚠️ 为什么是一份"id 集合"而不是挂在条目上的一个布尔：
  ///    · `turn/deleted` **可能比那些条目先到**（补发 / 重放时尤其）——
  ///      挂布尔的话那时无处可挂，后到的条目会照样画出来（屏幕说假话）；
  ///    · 恢复只是把这几个 id 从集合里拿掉，**一个字节都不用重建**（契约 §8.3：
  ///      恢复要立刻、且不许再要一次网络）。
  final Set<String> _hiddenIds = {};

  /// 服务端说"这一轮开始了"——**内部状态名**（`process_words.dart` 负责翻成人话）。
  ///
  /// ⚠️ 它是**瞬态**（决策 P-g：UI 状态不落盘）。所以断线重连不会被补发——
  ///    那正是 `_hasOpenAssistant` 存在的理由（见 `agentLine`）。
  String? _turnState;

  /// 已经见过的最新轮号。**用来挡乱序/迟到的帧。**
  ///
  /// ⚠️ 手册 H4 点名要"**乱序保护 + 超时收敛**"。
  ///    收敛那一半由服务端的硬收口保证（每条开过的轮都有收尾）；
  ///    这一半在这儿：**旧轮的状态不许把新轮的提示点回来**——
  ///    否则一条迟到的 `turn=1` 会在第 3 轮已经收口之后
  ///    把「它正在做…」又亮起来，而屏幕上那是假的。
  ///
  /// ⚠️ 批 3 起**状态与步骤共用这一个号**：两条路都得挡同一件事
  ///    （迟到的旧轮），各记各的一定会漂。
  int _seenTurn = 0;

  /// 已经收口的最高轮号。**≤ 它的过程帧一律丢**。
  ///
  /// 为什么要有它：收口事件（`message/end`）里**没有 `turn` 字段**
  /// （`services/core/src/message-writer.js` 的 `end()`），
  /// 客户端只知道"某一轮收口了"，不知道是哪一轮。
  /// 收口时把见到的最大轮号记下来，就等于
  /// "这一号以前的都不许再把提示点回来"——H4 那条既有规矩的延伸。
  int _closedThrough = 0;

  /// 老 `steps` 档的步骤（契约 `docs/dev/122` §四）：**按 `step` 号排**。
  ///
  /// ⚠️ 今天**界面上不画它**（那一档已从菜单砍掉）；留着这一层是因为
  ///    服务端仍要为老客户端发 `step/*`。
  /// ⚠️ 它是瞬态 ⇒ 轮收口时**必须清空**（契约：不许留成"永远在查资料"）。
  final List<ProcessStep> _steps = [];

  /// 「推理原文」：**还没找到气泡的那一段**。
  ///
  /// ⚠️ 为什么需要它：服务端是**先发推理段、后发正文**的（`assistant/message`
  ///    的 `content` 里 reasoning 在前、text 在后 ⇒ `#emitReasoning` 先于
  ///    `message/start`）。所以推理可能**没有气泡可挂**。
  ///    这一段先存在这儿，`message/start` 一到就挂上去。
  ///
  /// ⚠️ 它同样是"只在内存里"（不占号、不进存储）。
  String _pendingReasoning = '';

  /// ★ **`117`：这一间现在排着什么**（`queue/changed`，契约 `docs/dev/117-QUEUE-VISIBLE.md`）。
  ///
  /// 🔴 **它是一条"跨帧的快照"，不是时间线条目**：
  ///    · 那一帧是**瞬态**的（服务端 `emitTransient`：不占号、不落盘、重连**不重放**）
  ///      ⇒ 它**进不了** `_items`（进去就是"屏幕上多出一条谁也看不见的东西"）。
  ///    · 所以它住在这儿：**一间一份**（`Timeline` 本来就是一间一份），
  ///      由 `_applyTransient` 整份换掉。
  /// ⚠️ **`reset()` 故意不清它**：它不是从那条日志重放出来的（是服务端现推的快照），
  ///    `reset()` 清的是"上一个世界重放出来的东西"。清掉它反而会让那条横条
  ///    在没有新帧的时候凭空消失 —— 那是屏幕上说假话。
  ChatQueue _queue = ChatQueue.empty;

  /// 这一间现在排着什么（一条都没有 ⇒ [ChatQueue.empty]，界面**一个像素都不画**）。
  ChatQueue get queue => _queue;

  /// **结果先到、调用还没到**的那几条 `tool/result`（键 = `callId`）。
  ///
  /// ⚠️ 为什么会有这种顺序：`tool/call` 与 `tool/result` 之间可能**隔着一次翻页**
  ///    （往上翻是一页一页取的，切口正好落在两者之间；本机缓存那 200 条的裁剪
  ///    也可能把调用那条挤掉）。那时先到的是结果。
  /// ⚠️ 不能直接丢掉它：调用那条**晚一步**（翻到更早那一页时）到了之后，
  ///    没有它这一行会**永远停在"在跑"** —— 那是屏幕上说假话。
  /// ⚠️ **有界**：认不出对应调用的结果最多留 [maxPendingToolResults] 条
  ///    （先来先丢）—— 坏帧 / 协议异常不许把内存撑爆。
  final Map<String, Map<String, dynamic>> _pendingToolResults = {};

  /// [Timeline._pendingToolResults] 的上限。
  static const int maxPendingToolResults = 64;

  /// 服务端说了"它断了 / 接不上活" ⇒ **那一轮已经死了**。
  ///
  /// ⚠️ 为什么要单独一个标志：`_hasOpenAssistant` 那条兜底（给断线重连用的）
  ///    在"气泡还开着、但它已经死了"的时候会**把提示点回来**——
  ///    那时屏幕上写的是"它正在做"，而它其实已经不做了。**那就是说假话。**
  ///    ⇒ 知道了就别装不知道。下一次真开轮（收到认识的状态名）时清掉。
  bool _agentDead = false;

  /// 这一屏是**从本机缓存先画出来的**，服务端还没开口（S5c）。
  ///
  /// ⚠️ 见 [agentLine]：这个标志拦的就是"拿缓存当事实"。
  bool _stale = false;

  /// 界面上该显示的那句「它在做…」；`null` = **什么都不显示**。
  ///
  /// 两个来源，缺一不可：
  ///   ① `_turnState`：这一轮刚开、**一个字都还没说** ——
  ///      ⚠️ **只有它能覆盖那段空白**（那时时间线上一个条目都还没有）
  ///   ② 有**没收口的气泡**：重连之后瞬态没了，但落盘的事件还在 ⇒ 仍然推得出来
  ///
  /// ⇒ **不可能出现"永远停在正在做"**：每一条开过的轮都一定有 `message/end`
  ///   （超时硬收口 / 进程死掉都会补一条，见 `docs/dev/07-TIMEOUT.md`）。
  ///   手册 H4 说的那个失败模式（卡住时永久停在"在查资料"）就是靠这条堵住的。
  String? get agentLine {
    if (_agentDead) return null; // 知道它死了就别再说"它正在做"
    // ⚠️ **从本机缓存画出来的那一屏，在服务端开口之前一个字都不许说。**
    //    那一屏可能是上次关机时断的——我们**不知道那一轮还活着没有**。
    //    而 `_hasOpenAssistant` 那条兜底会照旧把「它正在做…」点回来，
    //    于是屏幕上写着一件我们其实不知道的事。沉默优于编造（N10）。
    if (_stale) return null;
    final w = processWord(_turnState);
    if (w != null) return w;
    return _hasOpenAssistant ? busyFallback : null;
  }

  /// 有没有**还没收口**的助手气泡（= 它正在说，或者说到一半断了）。
  ///
  /// ⚠️ 只数**画得出来的**那些：一条被删掉（藏起来）的没收口气泡
  ///    不该让屏幕上冒出"它正在做…"——那一轮已经不在屏幕上了。
  bool get _hasOpenAssistant =>
      _items.any((it) => it is AssistantMessage && !it.ended && _visible(it));

  /// 现在还没收口的那**一条**助手气泡（一轮最多一条，N22）。
  ///
  /// ⚠️ 推理段要挂到它上面——所以这里取的是**最后**那条没结束的。
  AssistantMessage? get _openAssistant {
    for (final it in _items.reversed) {
      if (it is AssistantMessage && !it.ended) return it;
    }
    return null;
  }

  /// 步骤（**老 `steps` 档那一路**；按 `step` 号排；轮收口即空）。
  ///
  /// ⚠️ 今天界面不画它（契约 `docs/dev/122` §四）。
  /// 界面要拿 `processWord(s.state)` 翻成人话，**认不出来的跳过**
  /// （N10：沉默优于编造）。
  List<ProcessStep> get steps => List.unmodifiable(_steps);

  /// 已收到的最大服务端号。**补发就从它开始要**。
  int get lastSeq => _lastSeq;

  /// **已经收口到的最高轮号**（`≤` 它的轮都不再动了）。
  ///
  /// ⚠️ 过程折叠要它：一轮**收口之后**那些工具行才折起来（还在跑时展开着 —— DSH 同一条）。
  ///    收口事件里没有 `turn`（见 [_closedThrough]），所以这是一个"见到的最大轮号"的近似；
  ///    现实中轮是串行的（一次只有一轮在跑）⇒ 这个近似是准的。
  int get closedThrough => _closedThrough;

  /// **我手上最老那一号**（往前翻的游标；一条都没有 ⇒ `null`）。
  ///
  /// ⚠️ 用 `_seenSeq` 而不是"第一个条目"：条目里有日期行那种没有号的装饰，
  ///    而且被隐藏的那些条目也照样占着号。
  int? get oldestSeq => _seenSeq.isEmpty ? null : _seenSeq.reduce((a, b) => a < b ? a : b);

  /// **界面上该画的那几条**（按 `(seq, tie)` 排）。
  ///
  /// ⚠️ **被删掉的那些不在这儿**（契约 §8.3：藏起来，不销毁）——
  ///    渲染、草稿存档、以及"哪几条属于哪一轮"全都从这一份推，
  ///    于是"藏起来"这件事**只有一处**，不可能某条路漏了它。
  ///    （被藏起来的条目仍然在 `_items` 里：恢复要立刻、不许再要一次网络。）
  List<TimelineItem> get items {
    final list = _items.where(_visible).toList()
      ..sort((a, b) {
        final c = a.seq.compareTo(b.seq);
        return c != 0 ? c : a.tie.compareTo(b.tie);
      });
    return list;
  }

  bool get isEmpty => items.isEmpty;

  /// 这一条现在该不该画出来。
  ///
  /// ⚠️ 分隔线没有 `messageId` ⇒ **永远画**：它不属于任何一轮，
  ///    删除删的是一轮里的话，不是"你不在的时候"那条线。
  bool _visible(TimelineItem it) {
    final id = it.messageId;
    return id == null || !_hiddenIds.contains(id);
  }

  /// 这一条是不是"被删掉了、现在藏着"。
  bool isHidden(String messageId) => _hiddenIds.contains(messageId);

  /// 收到 `turn/deleted`（或删成功之后）：**把这几个 id 藏起来**（不销毁）。
  ///
  /// ⚠️ 藏起来的若是**还开着的那条**（它正在说），过程那一块也跟着撤：
  ///    步骤是"那一轮的事"，那一轮被删了还留在屏幕上是在说一件没发生的事。
  ///
  /// ⚠️ **`116` 的工具行藏不掉**（这一批有意留的缺口，如实写在这里）：
  ///    墓碑事件给的是 `messageIds`，而工具行**没有 `messageId`**，客户端也没有
  ///    "哪一轮 = 哪条消息"的映射（`message/start` 不带 `turn`）⇒ 删一轮之后
  ///    那一轮的工具行**仍留在屏幕上**。要收口得让服务端在墓碑事件里带上 `turn`
  ///    （或让 `message/*` 带 `turn`）—— 那时这一段才有依据去藏。
  void hideMessages(Iterable<String> messageIds) {
    final ids = _ids(messageIds);
    if (ids.isEmpty) return;
    _hiddenIds.addAll(ids);
    final open = _openAssistant;
    if (open != null && ids.contains(open.messageId)) {
      _turnState = null;
      _steps.clear();
      _pendingReasoning = '';
    }
  }

  /// 收到 `turn/restored`：**取消隐藏**（内容还在服务端，补发会带回来）。
  void showMessages(Iterable<String> messageIds) {
    for (final id in _ids(messageIds)) {
      _hiddenIds.remove(id);
    }
  }

  /// 收到 `turn/purged`：服务端已经压实 ⇒ **从内存里丢掉**（永远不会再补发）。
  ///
  /// ⚠️ 号**不还**：压实时那些事件的 `seq` 是保留的（契约 §三：号一个不跳），
  ///    所以 `_seenSeq` 里那些号继续留着 —— 补发再收到同号也不该重新画出来。
  void purgeMessages(Iterable<String> messageIds) {
    final ids = _ids(messageIds);
    if (ids.isEmpty) return;
    _hiddenIds.removeAll(ids);
    _items.removeWhere((it) {
      final id = it.messageId;
      return id != null && ids.contains(id);
    });
  }

  static Set<String> _ids(Iterable<String> messageIds) =>
      {for (final id in messageIds) if (id.isNotEmpty) id};

  /// 事件里那份 `messageIds`（契约 §8.1）。读不出来 ⇒ **空**
  /// （空 = 什么都不做：宁可不动，也不许凭猜删东西）。
  static List<String> messageIdsOfEvent(Map<String, dynamic> event) {
    final raw = event['messageIds'];
    if (raw is! List) return const [];
    return [
      for (final e in raw)
        if (e is String && e.isNotEmpty) e,
    ];
  }

  /// 本地乐观上屏。返回 messageId（重发时要用同一个）。
  ///
  /// 号借 `_lastSeq`、tie=1 ⇒ 排在"已收到的最后一条"之后、
  /// "下一条服务端事件"之前。**这样它不会跳来跳去。**
  String addLocalUtterance(String text, String messageId) {
    _items.add(UserUtterance(messageId: messageId, text: text, seq: _lastSeq, tie: 1));
    return messageId;
  }

  /// 把本地那条推到某个状态。**不允许的转移会被忽略**（不抛）。
  void setLocalState(String messageId, MessageState to) {
    for (var i = 0; i < _items.length; i += 1) {
      final it = _items[i];
      if (it is UserUtterance && it.messageId == messageId) {
        final next = nextState(it.state, to);
        if (next != it.state) _items[i] = it.copyWith(state: next);
        return;
      }
    }
  }

  /// 重发：把失败的那条推回 `queued`，让它看起来又是"在发"。
  void retry(String messageId) => setLocalState(messageId, MessageState.queued);

  /// 吃一个服务端事件。不认识的类型**安静忽略**（协议：向前兼容）。
  void apply(Map<String, dynamic> event) {
    final type = event['type'];
    if (type is! String) return;

    // 瞬态事件没有 seq ⇒ **不上时间线**（决策 P-g）。
    // 它们只改已有条目的状态，绝不新增条目。
    final rawSeq = event['seq'];
    if (rawSeq is! int) {
      _applyTransient(event);
      return;
    }

    // 去重：补发/重连必然重复（协议 R5）
    if (!_seenSeq.add(rawSeq)) return;
    if (rawSeq > _lastSeq) _lastSeq = rawSeq;

    final catchUp = event['catchUp'] == true;
    final messageId = event['messageId'] as String?;

    switch (type) {
      case 'user/echo':
        _applyEcho(messageId, event, rawSeq, catchUp);
      case 'message/start':
        if (messageId == null) return;
        if (_findMessage(messageId) != null) return;
        final fresh = AssistantMessage(messageId: messageId, seq: rawSeq)
          ..catchUp = catchUp;
        // ★ 推理段可能**先于正文**到（服务端先发 reasoning 再发 text）⇒
        //   把先存着的那一段挂到这条气泡上。
        //   ⚠️ 只挂给**实时**开的那条：补发放的是落盘历史，不可能带着推理。
        if (!catchUp && _pendingReasoning.isNotEmpty) {
          fresh.reasoning = _pendingReasoning;
          _pendingReasoning = '';
        }
        _items.add(fresh);
      case 'message/text':
        final m = _findMessage(messageId);
        if (m == null) return;
        // ⚠️ **按 `(messageId, block, seqInBlock)` 去重**（`AssistantMessage.addChunk`）：
        //    "从回收站拿回来"会把这一段**按原样重新追加一遍**（新 `seq`），
        //    而上面的 `_seenSeq` 只认 `seq` ⇒ **挡不住重发**。
        //    少了这一条，屏幕上那句话说两遍。
        m.addChunk(
          block: event['block'] as String? ?? 'quick',
          seqInBlock: event['seqInBlock'],
          text: event['text'] as String? ?? '',
        );
      case 'message/end':
        // 这一轮说完了 ⇒ 界面上那行「它在做…」跟着撤，
        // **步骤流水一起清掉**（不收的话就会留成"永远在查资料"）。
        // ⚠️ **推理原文不清**：它挂在气泡上，主人回头还要看（见
        //    `AssistantMessage.reasoning` 那段生命周期说明）。
        _turnState = null;
        _closeTurn();
        final m = _findMessage(messageId);
        if (m == null) return;
        m.ended = true;
        m.reason = event['reason'] as String?;
        final s = event['sources'];
        if (s is List) {
          // ⚠️ 协议 R8：end 上的来源是**权威版本**，覆盖 start 上带的
          m.sources = s.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
        }
      case 'timeline/marker':
        _items.add(TimelineMarker(
          kind: event['kind'] as String? ?? 'away',
          label: event['label'] as String?,
          seq: rawSeq,
          catchUp: catchUp,
        ));
      // ── ★ `116` 那三样（主人 2026-09-26：*"首先全部开放"*）──────────
      //
      // ⚠️ 四条都是**持久**事件（服务端 `Timeline.emit`：有号、落盘、翻页/重连拿得到）
      //    ⇒ 它们走的就是这条"带 seq"的路（和 `message/*` 同一条纪律）。
      // ⚠️ 认不出来的 payload 一律**安静丢掉**（`ToolRow.parse` / `…parse` 返回 `null`）：
      //    坏数据的后果只许是"这一行不画"，**绝不能是"打不开聊天"**。
      case 'tool/call':
        _applyToolCall(event, rawSeq);
      case 'tool/result':
        _applyToolResult(event, rawSeq);
      case 'system/prompt':
        final p = SystemPromptRow.parse(event);
        // 空的那条**不占一行**（DSH：非空的 `system/message` 才有一行）
        if (p == null || p.text.isEmpty) return;
        _items.add(TimelineSystemPrompt(row: p, seq: rawSeq));
      case 'turn/usage':
        final u = TurnUsageAttempt.parse(event);
        // `usage:null, complete:false` 那条是**合法的**（"这一轮没报用量"）——
        // 它照样进日志（取号、落盘），只是折出来是 `null` ⇒ 界面上一行都不画。
        if (u == null) return;
        _items.add(TimelineTurnUsage(attempt: u, seq: rawSeq));
      // ── 系统通知（契约 `29-NOTICE.md` 约束 2：**时间线里必须有那一条**）──
      //
      // ⚠️ `text` **由服务端给、客户端照抄**（§五 🔴）——这里一个字都不重写。
      // ⚠️ 只有认得出的**那句话**才上时间线：`text` 读不出来 ⇒ 什么都不加
      //    （一条没有话的通知占一个位置，屏幕上就是一行空白）。
      // ⚠️ 瞬态的 `notice/urgent` **走不到这里**：它没有 seq（见 `_applyTransient`）。
      case 'notice':
        final n = Notice.fromEvent(event);
        if (n == null) return;
        _items.add(TimelineNotice(notice: n, seq: rawSeq, catchUp: catchUp));
      // ── 删掉 / 恢复 / 真删（契约 §8.1、§8.3）────────────────────
      //
      // ⚠️ 三条都**取号、落盘**，所以它们走的是这条"带 seq"的路
      //    （不是 `_applyTransient`）——重启之后客户端才知道谁被删过。
      // ⚠️ 键是 `messageIds`：**没有轮号可算**（落盘的事件里没有 `turn`）。
      // ⚠️ 一条里认不出的 id 一律不认（`messageIdsOfEvent`）——
      //    宁可什么都不动，也不许凭猜藏/删东西。
      case 'turn/deleted':
        hideMessages(messageIdsOfEvent(event));
      case 'turn/restored':
        showMessages(messageIdsOfEvent(event));
      case 'turn/purged':
        purgeMessages(messageIdsOfEvent(event));
      default:
        // 未知类型：安静忽略（向前兼容）
        return;
    }
  }

  void _applyEcho(String? messageId, Map<String, dynamic> event, int seq, bool catchUp) {
    if (messageId == null) return;
    // ★ 认领本地那条乐观发言——**不是再插一条**
    for (var i = 0; i < _items.length; i += 1) {
      final it = _items[i];
      if (it is UserUtterance && it.messageId == messageId) {
        final next = nextState(it.state, MessageState.confirmed);
        // ⚠️ **已经认领过的那条不再改它排在哪。**
        //    理由（和 `message/text` 那个去重是同一件事的两面）：从回收站拿回来时，
        //    服务端会把这一问一答**按原样重新追加**（新 `seq`）。
        //    照旧无条件 `copyWith(seq:)` 的话，用户那句话会**跳到它自己那条回答后面**
        //    ——因为回答那条走的是 `message/start`，而它被 `_findMessage` 挡在门口、
        //    位置一动不动。两半的位置就错开了，屏幕上"问答"会看着像反的。
        //    ⇒ 只在"本地那条还没被认领"时把号换成服务端的（那一步是必须的：
        //      本地借的是 `_lastSeq`，不换就排错地方）。
        if (it.state == MessageState.confirmed) {
          if (next != it.state) _items[i] = it.copyWith(state: next);
          return;
        }
        _items[i] = it.copyWith(seq: seq, tie: 0, state: next);
        return;
      }
    }
    // 没认领到（别的设备发的、或者本地没上屏过）⇒ 当作新的一条
    _items.add(UserUtterance(
      messageId: messageId,
      text: event['text'] as String? ?? '',
      seq: seq,
      state: MessageState.confirmed,
    ));
  }

  /// `tool/call`：**新增一行**（结果那一半可能已经在 [_pendingToolResults] 里等着）。
  ///
  /// ⚠️ `ToolRow.parse` 认不出来（缺 `callId`/`name`/`turn`/`step`）⇒ **不画**
  ///    （fail-closed：猜一个成败/名字画到屏幕上比少一行更坏）。
  void _applyToolCall(Map<String, dynamic> event, int seq) {
    final callId = event['callId'];
    final pending = callId is String ? _pendingToolResults.remove(callId) : null;
    final row = ToolRow.parse(event, pending);
    if (row == null) return;
    // ★ 之前可能已经画过"**只有结果那一行**"（合同 `116` §一 规矩 4）——
    //   配对之后那两半是**一行**：**就地换掉它**（位置改成**调用**那个 `seq` ——
    //   结果那一行的位置排晚了）。已有的那一行（有名字的）⇒ 幂等，不再插一条。
    for (var i = 0; i < _items.length; i += 1) {
      final it = _items[i];
      if (it is! TimelineToolCall || it.callId != row.callId) continue;
      if (it.row.name.isEmpty) _items[i] = TimelineToolCall(row: row, seq: seq);
      return;
    }
    _items.add(TimelineToolCall(row: row, seq: seq));
  }

  /// `tool/result`：**就地补上结果**（认领身份，不是再插一行 —— 见那三样顶上那段）。
  ///
  /// ⚠️ 找不到对应调用（翻页 / 缓存裁剪把调用那条隔掉了）⇒ **先把结果那一行画出来**
  ///    （合同 `116` §一 规矩 4：配不上就只画结果那一行），并把它记进
  ///    [_pendingToolResults]，等调用那条晚一步到了再换成一整行。
  ///    直接丢的后果是那一行**永远看不见**，而屏幕上那句话是**真发生过**的。
  void _applyToolResult(Map<String, dynamic> event, int seq) {
    final callId = event['callId'];
    if (callId is! String || callId.isEmpty) return;
    for (final it in _items) {
      if (it is! TimelineToolCall || it.callId != callId) continue;
      if (it.row.name.isEmpty) {
        // 已经画着"只有结果那一行" ⇒ 换掉它（同名同 seq，位置不动）
        final only = ToolRow.parseResultOnly(event);
        if (only != null) it.row = only;
      } else {
        // 已经有那一行（有名字的调用）⇒ 补上结果。
        // ⚠️ 结果坏了（`ok` 不是布尔 / `bytes` 读不出）⇒ `parse` 返回 `null`
        //    ⇒ **行不动**（宁可留着"在跑"，也不猜一个成败）。
        final next = ToolRow.parse(_callPayloadOf(it), event);
        if (next != null) it.row = next;
      }
      return;
    }
    // 还没有那一行：**先画结果那一行**（名字那一格空着 —— 不猜），并记着等调用那条。
    final only = ToolRow.parseResultOnly(event);
    if (only != null) _items.add(TimelineToolCall(row: only, seq: seq));
    // ⚠️ 有界（先来先丢），坏帧不许把内存撑爆。
    _pendingToolResults[callId] = event;
    while (_pendingToolResults.length > maxPendingToolResults) {
      _pendingToolResults.remove(_pendingToolResults.keys.first);
    }
  }

  /// 从已经建好的那一行反推出 `tool/call` 的 payload（结果回来时要重新 parse 一对）。
  ///
  /// ⚠️ 只 {@link ToolRow.parse} 认那几个字段；不参与绘制的字段丢了没关系
  ///    （它们本来也不进 `ToolRow`）。
  static Map<String, dynamic> _callPayloadOf(TimelineToolCall it) => {
        'type': 'tool/call',
        'turn': it.row.turn,
        'step': it.row.step,
        'callId': it.row.callId,
        'name': it.row.name,
        'title': it.row.title,
        'args': it.row.args,
      };

  /// 瞬态：只改状态，**不新增条目**（决策 P-g）。
  void _applyTransient(Map<String, dynamic> event) {
    switch (event['type']) {
      case 'message/status':
        _applyStatus(event);
      case 'step/start':
        _applyStepStart(event);
      case 'step/end':
        _applyStepEnd(event);
      case 'reasoning/delta':
        _applyReasoning(event);
      case 'error':
        // 它断了 / 接不上活 ⇒ 那一轮**不会再有收尾了**，这行提示必须撤掉。
        // ⚠️ 少了这一条，手册 H4 那个失败模式就回来了：
        //   卡住时**永久停在"它正在做…"**，比空白更坏。
        _turnState = null;
        _agentDead = true;
        // 步骤是**过程噪音** ⇒ 那一轮死了就不该留着。
        // ⚠️ 推理原文**留着**：它是内容，挂在那条还开着的气泡上（改过一次，别改回去）。
        _closeTurn();
      case 'notice/urgent':
        // ⚠️ **瞬态通知不进时间线**（契约 §三① + 决策 P-g）：它没有号，
        //    所以它只在浮窗里喊一声（`ChatController` 那条路接住它）。
        //    这一句是**故意什么都不做**，不是漏了——写在这儿免得下一个人
        //    以为"应该在这儿加一条"。
        return;
      case 'queue/changed':
        // ★ **`117`：这一间现在排着什么**（契约 `docs/dev/117-QUEUE-VISIBLE.md`）。
        //   整份换掉（服务端每次报的都是**现在是这样**，不是增量）。
        //   ⚠️ 认不出 ⇒ `null` ⇒ **不动**（留着手上那份，宁可旧一点也不编一份空的）。
        final q = ChatQueue.of(event);
        if (q != null) _queue = q;
        return;
      default:
        return;
    }
  }

  /// `message/status`（第 ② 档「在做什么」）。
  void _applyStatus(Map<String, dynamic> event) {
    // ★ **按轮寻址**，不按气泡（见 `agentLine` 上面那段）。
    //   只有**认得出来的**状态才认；认不出来的**保持安静**——
    //   不猜、也不把内部词漏到屏幕上（N10：沉默优于编造）。
    final state = event['state'] as String?;
    final turn = event['turn'];
    // 乱序保护：比见过的旧、或那一轮已经收口 ⇒ **丢掉**
    // （不许让旧轮把提示点回来）
    if (turn is int && _isLate(turn)) return;
    if (processWord(state) == null) return;
    if (turn is int) _openTurn(turn);
    _turnState = state;
    _agentDead = false; // 又开了一轮 ⇒ 它活着
  }

  /// `step/start`（老 `steps` 档那一路；新客户端不再消费它，见 `docs/dev/122` §四）。
  ///
  /// ⚠️ 同一 `(turn, step)` 重复到达 ⇒ **覆盖**，不是再画一条
  ///    （断线重连、乱序都会重复）。
  void _applyStepStart(Map<String, dynamic> event) {
    final turn = event['turn'];
    final step = event['step'];
    final state = event['state'];
    if (turn is! int || step is! int) return;
    if (_isLate(turn)) return; // 迟到的旧轮 / 已收口的那一轮 ⇒ 丢
    if (processWord(state) == null) return; // 认不出来 ⇒ 安静
    _openTurn(turn); // 步骤可能先于 `message/status` 到
    _agentDead = false;
    for (var i = 0; i < _steps.length; i += 1) {
      if (_steps[i].step == step) {
        _steps[i] = ProcessStep(turn: turn, step: step, state: state);
        return;
      }
    }
    _steps.add(ProcessStep(turn: turn, step: step, state: state));
    _steps.sort((a, b) => a.step.compareTo(b.step));
  }

  /// `step/end`。**只标完成，不新增**——没见过的号（比如状态名认不出来
  /// 而被跳过的那一步）就不该凭空冒出来。
  void _applyStepEnd(Map<String, dynamic> event) {
    final turn = event['turn'];
    final step = event['step'];
    if (turn is! int || step is! int) return;
    if (_isLate(turn)) return;
    for (var i = 0; i < _steps.length; i += 1) {
      if (_steps[i].turn == turn && _steps[i].step == step) {
        _steps[i] = _steps[i].copyWith(done: true);
        return;
      }
    }
  }

  /// `reasoning/delta`（「推理原文」）。
  ///
  /// ⚠️ **只在内存里拼**，而且是拼在**那一轮的气泡上**：契约 §二 说它一个
  ///    字节都不许落盘（它可能含我们这边的原话，D7.4），但"不落盘"**不等于**
  ///    "答案一到就删"——主人回头要看的就是它当时怎么想的。
  ///    真正的边界是：**进不了任何存储**，以及 `reset()` 时**必须没**
  ///    （重放 / 退出登录之后它不该存在于任何地方）。
  void _applyReasoning(Map<String, dynamic> event) {
    final turn = event['turn'];
    final text = event['text'];
    if (turn is! int || text is! String || text.isEmpty) return;
    if (_isLate(turn)) return;
    _openTurn(turn);
    _agentDead = false;
    final m = _openAssistant;
    if (m != null) {
      m.reasoning += text;
    } else {
      // 气泡还没开（推理先于正文到）⇒ 先存着，`message/start` 会把它挂上去。
      _pendingReasoning += text;
    }
  }

  /// 这一号是不是"迟到的旧轮"（比见过的旧，或者已经收口了）。
  ///
  /// ⚠️ 两条合起来才算完：`_seenTurn` 挡"旧轮"，`_closedThrough` 挡
  ///    "收口之后又飘回来的那几帧"——后者正是 H4 说的"永久停在正在做"的根。
  bool _isLate(int turn) => turn < _seenTurn || turn <= _closedThrough;

  /// 新的一轮开始了（比见过的都新）⇒ 上一轮的**步骤**不作数了。
  ///
  /// ⚠️ **只清步骤和"还没挂上去的那段推理"**，**不清气泡上的推理**——
  ///    那是上一轮的内容，主人回头还要看。
  void _openTurn(int turn) {
    if (turn <= _seenTurn) return;
    _seenTurn = turn;
    _steps.clear();
    _pendingReasoning = '';
  }

  /// 轮收口 ⇒ **清掉这一轮的步骤**（契约 §三：不许留成"永远在查资料"）。
  ///
  /// ⚠️ **推理原文不在清理之列**——它挂在气泡上，是内容不是过程噪音。
  ///    `reset()` 才是它的终点（重放 / 退出登录）。
  ///
  /// ⚠️ 收口事件里没有 `turn`（见 `_closedThrough`），所以只能按
  ///    "见到的最大轮号"收。现实中轮是串行的（一次只有一轮在跑），
  ///    这个近似就是准的。
  void _closeTurn() {
    _steps.clear();
    _pendingReasoning = '';
    if (_seenTurn > _closedThrough) _closedThrough = _seenTurn;
  }

  AssistantMessage? _findMessage(String? messageId) {
    if (messageId == null) return null;
    for (final it in _items) {
      if (it is AssistantMessage && it.messageId == messageId) return it;
    }
    return null;
  }

  /// 服务端说"你的号跑到我前面了" ⇒ 本地这条时间线不作数了，从头来。
  ///
  /// ⚠️ **但用户自己说的话必须留下**——
  ///    那些话**只在本机有一份**（还没被服务端认领）。
  ///    清掉它们等于"把用户打好的字弄丢了"，而那是留存最狠的杀手（09）。
  ///    ⇒ 只清服务端来的；本地的未确认发言**原样留着**。
  void reset() {
    final mine = _items
        .whereType<UserUtterance>()
        .where((u) => u.state != MessageState.confirmed)
        .toList();
    _items
      ..clear()
      ..addAll(mine);
    _seenSeq.clear();
    _lastSeq = 0;
    // 谁被删过也从头来：墓碑事件**本身也落盘**（§8.1），重放会把它重新发上来
    // ⇒ 清掉不会丢东西，而留着反倒可能挡住"这一轮已经被拿回来"的新事实。
    _hiddenIds.clear();
    // 服务端亲口说"你这号不对了" ⇒ 这一屏不再是缓存画的（缓存本身由调用方清）
    _stale = false;
    // 瞬态不属于"落盘的历史" ⇒ 重放之前先清掉（它会被后面的帧重新点起来）
    _turnState = null;
    // 号也从头来（服务端会重发一轮轮的帧）
    _seenTurn = 0;
    _closedThrough = 0;
    // 过程（步骤 + 还没挂上去的那段推理）跟着一起清
    _steps.clear();
    _pendingReasoning = '';
    // ★ `116`：还没配上的那几条工具结果也一起清 —— 它们是"上一个世界"的残留
    //   （清掉会丢的只是"那一行暂时还停在在跑"，而留着会把上一屏的结果
    //    配到重放之后新出现的一行上 —— 那才是真的配错）。
    _pendingToolResults.clear();
    // ⚠️ 推理原文的**终点就在这儿**：重放（服务端说号不对了）与退出登录
    //    都走 `reset()`，而它本来就不该存在于任何地方（契约 §二）。
    //    气泡本身已经被上面清掉了（只留用户自己没确认的那几句），
    //    所以挂在气泡上的推理随之消失——**不需要另立一份"要清的东西"清单**。
    // 本地那条的号要重新借（现在最大号是 0）
    for (var i = 0; i < _items.length; i += 1) {
      final u = _items[i] as UserUtterance;
      _items[i] = u.copyWith(seq: 0, tie: 1);
    }
  }

  /// 重放一批补发帧（断线重连时）。
  void applyAll(Iterable<Map<String, dynamic>> events) {
    for (final e in events) {
      apply(e);
    }
  }

  /// **先用本机缓存把上一屏画出来**（S5c），画完仍标着"没跟服务端对上"。
  ///
  /// 纯函数：进来的是**服务端说过的事实**，不是"缓存版的状态"。
  void seedFromCache(Iterable<Map<String, dynamic>> events) {
    _stale = true;
    applyAll(events);
  }

  /// 服务端开口了（收到任何一条真帧）⇒ 这一屏不再是从缓存猜的。
  ///
  /// ⚠️ 只要**一条**帧就够：它证明链路是通的、服务端还在那个世界上。
  ///    而"那一轮还活着没有"由服务端的收口事件回答（它接着会被补发上来）。
  void markFresh() => _stale = false;

  /// 这一屏是不是"从缓存先画出来的"。
  bool get isStale => _stale;
}
