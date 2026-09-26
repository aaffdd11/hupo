// **轨迹那一屏的纯逻辑**（契约 `docs/dev/118-TRAJECTORY-VIEW.md`）。
//
// ── 它是什么 ─────────────────────────────────────────────
// DSH 的窗口顶上有两个 tab：**聊天 / 轨迹**（`docs/dev/115-raw/B-render.md` L65）。
// 轨迹把**同一条会话**摊成一张表（研究 `docs/dev/115-DSH-WINDOW-PARITY.md` §一.4 ＋
// `115-raw/B-render.md` §1.5）。这一份是那张表的**纯逻辑**：把手上这一窗的记录按
// `(seq, tie)` 摊成一行行，按**记录自己带的轮号**分组，并算出"我们真的拿得到"的那几个合计。
//
// ── 🔴 只写我们真收到的（没收到的一格都不许出现）────────────────
//   · **没有模型名** —— 任何一条记录里都没有它（`turn/usage` 上也没有）；
//   · **没有钱** —— DSH 全树只有 token（`B-render.md` §2.7 最后一行），我们连 token 都折得出才画；
//   · **没有时长** —— 服务端**一条记录都不带耗时**（DSH 的 `timeSeconds` 是 `null` 就留白；
//     我们连那个字段都没有）⇒ 那一格**永远不画**；
//   · **没有百分比** —— 缓存命中率是拿两个桶算出来的，我们不算；
//   · **没有"步骤合计"** —— `step/*` 是**瞬态**、一个字节都不落盘（决策 P-g）；
//     工具行上那个 `step` 号只能证明"这一步有工具调用"，证明不了"这一轮一共几步"
//     ⇒ [TrajectoryTotals.steps] **恒为 `null`**（视图那一层就不画它）。
//
// ── 分组：按**收到的轮号**，不许自己数 ─────────────────────
// `user/echo` 与 `message/*` **都不带 `turn`**（服务端 `say.js` / `message-writer.js`
// 逐字如此）⇒ 客户端**算不出**一条消息属于第几轮。按"第几个用户发言 = 第几轮"去数
// 就是拿猜的数上屏（N10：沉默优于编造）。
// ⇒ 这里只给**记录自己带的**那个轮号；没带的那几行 `turn == null`，**按 `(seq, tie)`
//   排在原位**，那一格空着（视图那一层也不编）。
//
// ⚠️ 纯逻辑：不 import `material`、不碰 I/O、不碰计时器
//    （楼层闸 `test/unit/import_rules_test.dart` ⇒ 它才进得了 `test/unit` 硬闸）。
// ⚠️ **`models/` 里不写给人看的字**：类别词 / 兜底那几句 / 用量那一行**都由调用方给**
//    （[TrajectoryWords]）—— 这样它们才进得了禁用词那道闸。
//    这一份里唯一的字面量是 `' · '`（DSH 的**拼接规矩**，不是文案）与
//    `HH:mm:ss`（**时刻格式**，也不是文案）。

import 'timeline.dart';
import 'tool_row.dart';

/// 一条轨迹记录是哪一类（视图上那个小标签）。
///
/// ⚠️ **五个一个不多一个不少**：多出来一个就会让某一处 `switch` 走到默认分支，
///    而那正是"页面在说假话"的起点。
/// ⚠️ **分隔线与通知不在这五类里**：`timeline/marker` 是一条**装饰性的线**、
///    `notice` 是"它替你做的决定"，两者都不是"这条会话发生了什么"的记录
///    ⇒ 它们**不进这张表**（见 [trajectoryTableOf]）——这是**有意**的，不是漏了。
enum TrajectoryKind { user, assistant, tool, systemPrompt, usage }

/// 一行摘要怎么拼、兜底怎么说 —— **字由调用方给**。
///
/// 照 `tool_row.dart` 的 [TurnProcessWords] 那条纪律：`models/` 不写给人看的字，
/// 所以那几句才进得了 `test/unit/forbidden_words_test.dart` 那张清单。
class TrajectoryWords {
  const TrajectoryWords({
    required this.kind,
    required this.usage,
    required this.usageNotSettled,
    required this.blank,
  });

  /// 类别 → 屏幕上那个词（`用户` / `助手` / `工具` / `系统提示词` / `用量`）。
  final String Function(TrajectoryKind kind) kind;

  /// 一轮的用量**折出来了** ⇒ 那一行的摘要（`116` 的 `turnUsageLine`）。
  final String Function(TurnUsage usage) usage;

  /// 折不出来（还没结清 / 有一次没报准）⇒ 如实说一句，**一个数都不给**。
  final String usageNotSettled;

  /// 摘要为空时的兜底（空消息 / 结果先到而名字也没给的那一行）——
  /// **不许编一个占位名或占位正文**，只许说"没有可以看的字"。
  final String blank;
}

/// 轨迹表里的一行（= 时间线上的一条记录）。
class TrajectoryRow {
  const TrajectoryRow({
    required this.seq,
    required this.tie,
    required this.kind,
    required this.turn,
    required this.step,
    required this.summary,
    required this.at,
    required this.turnHead,
    required this.inChat,
    required this.needsUnfold,
    required this.item,
  });

  final int seq;
  final int tie;

  final TrajectoryKind kind;

  /// **记录自己带的**轮号；`null` = 这一条没带（消息那几类）—— 见文件头。
  final int? turn;

  /// 记录自己带的步骤号（工具行 / 系统提示词行有；别的没有）。
  final int? step;

  /// 一行摘要（**已经是一行**：不含换行；空 ⇒ 视图用 [TrajectoryWords.blank]）。
  final String summary;

  /// 服务端给的事件时刻（epoch 毫秒）；`null` = 这条没带（**空着，不补**）。
  final int? at;

  /// 它是不是**这一轮的第一行**（视图在它前面画一个分组头）。
  final bool turnHead;

  /// **聊天那一屏画得出这一条吗**（把这一轮展开之后）。
  ///
  /// `false` 只有一种情况：同一轮里**不是最后一条**的 `turn/usage` ——
  /// 聊天那一屏只画最后那一条（`_planSlots` 的规矩，一处口径），
  /// 所以那几行**在聊天里没有对应的一格** ⇒ 点它要**如实说过不去**，
  /// 不许滚到一个别的地方去。
  final bool inChat;

  /// 跳过去之前得**先把这一轮展开**（它是一条被折起来的工具行）。
  final bool needsUnfold;

  /// 对应的时间线条目（跳转要用它去聊天那一屏找那一格）。
  final TimelineItem item;
}

/// 轨迹里的**一轮**（分组头那几个数）。
class TrajectoryTurn {
  const TrajectoryTurn({required this.turn, required this.process, required this.usage});

  final int turn;

  /// ★ **复用 `116` 的 `TurnProcess`**（工具 / 消息 / subagent 三样，
  ///   工具与 subagent 互斥那条规矩**一处都不重写**）。
  final TurnProcess process;

  /// 这一轮**折出来的**用量；`null` = 一个数都不许画（`foldTurnUsage` 的规矩）。
  final TurnUsage? usage;
}

/// 顶栏那几个"这一屏合计"。
class TrajectoryTotals {
  const TrajectoryTotals({
    required this.turns,
    required this.steps,
    required this.tokens,
    required this.complete,
  });

  /// 这一窗里**出现过的轮数**（不是"这条会话一共几轮" —— 见 [complete]）。
  final int turns;

  /// **恒为 `null`**：我们收不到"这一轮一共几步"（文件头那条）⇒ 视图不画。
  final int? steps;

  /// 逐轮折得出的那些用量**加起来的**；有一轮折不出来 ⇒ **整块 `null`**。
  ///
  /// 🔴 宁可一个数都不给，也不给一个"少算了某一轮"的合计。
  final TurnUsage? tokens;

  /// **更早的都加载完了吗**（`false` ⇒ 屏幕上必须写明"更早的还没有加载完"，
  /// 绝不许把这一窗说成"全部"）。
  final bool complete;
}

/// 摊开的那张表（视图只负责画它）。
class TrajectoryTable {
  const TrajectoryTable({required this.rows, required this.turns, required this.totals});

  /// 一行一条记录，**已经是 `(seq, tie)` 序**。
  final List<TrajectoryRow> rows;

  /// 有轮号的那几轮，**轮号升序**。
  final List<TrajectoryTurn> turns;

  final TrajectoryTotals totals;

  /// 一条记录都没有（⇒ 视图只说一句实话，**不编任何行**）。
  bool get isEmpty => rows.isEmpty;
}

/// 把手上这一窗的记录摊成一张轨迹表。
///
/// @param items 界面上那一条时间线（`ChatController.items`：本间 ＋ 翻上来的老页）
/// @param words 给人看的字（见 [TrajectoryWords]）
/// @param processOfTurn 这一轮的计数 —— **调用方必须走 `TurnProcess.fold`**
///        （`ChatController.processOfTurn`），这里**一条规矩都不重写**
/// @param usageOf 这一轮折出来的用量（`ChatController.turnUsage`：走 `foldTurnUsage`）
/// @param unfoldedTurns 用户自己展开过的那几轮（判断工具行被折起来了没有）
/// @param closedThrough 已经收口到的最高轮号（`Timeline.closedThrough`）
/// @param historyComplete 更早的是不是都加载完了（`false` ⇒ 不许说"全部"）
///
/// ⚠️ **认不出来的记录安静跳过**（fail-closed）：坏数据的后果只许是"这一行不画"，
///    绝不能是"打不开这一屏"。
TrajectoryTable trajectoryTableOf({
  required Iterable<TimelineItem> items,
  required TrajectoryWords words,
  required TurnProcess Function(int turn) processOfTurn,
  required TurnUsage? Function(int turn) usageOf,
  Set<int> unfoldedTurns = const <int>{},
  int closedThrough = 0,
  bool historyComplete = false,
}) {
  // ① 排序：**永远按 `(seq, tie)`**（不按时刻 —— 两个钟混排会乱，见 `TimelineItem.at`）。
  final ordered = [...items]..sort((a, b) {
      final c = a.seq.compareTo(b.seq);
      return c != 0 ? c : a.tie.compareTo(b.tie);
    });

  // ② 同一轮里**最后一条** `turn/usage` 才是聊天那一屏画出来的那一条
  //    （与 `chat_screen.dart` 的 `_planSlots` **同一条规矩**）。
  final lastUsageSeq = <int, int>{};
  for (final it in ordered) {
    if (it is TimelineTurnUsage) lastUsageSeq[it.turn] = it.seq;
  }

  final rows = <TrajectoryRow>[];
  final headed = <int>{};
  for (final it in ordered) {
    final row = _rowOf(
      it,
      words: words,
      usageOf: usageOf,
      unfoldedTurns: unfoldedTurns,
      closedThrough: closedThrough,
      lastUsageSeq: lastUsageSeq,
    );
    if (row == null) continue;
    final turn = row.turn;
    // ③ 分组：**这一轮的第一行**带上"画分组头"那个标记（后面同一个轮号的不再带）。
    rows.add(row._withTurnHead(turn != null && headed.add(turn)));
  }

  // ④ 分组头要的那几个数：**按轮号升序**，一轮一份。
  final numbers = <int>[
    for (final r in rows)
      if (r.turn != null) r.turn!,
  ]..sort();
  final turns = <TrajectoryTurn>[
    for (final n in numbers.toSet().toList())
      TrajectoryTurn(turn: n, process: processOfTurn(n), usage: usageOf(n)),
  ];

  return TrajectoryTable(
    rows: rows,
    turns: turns,
    totals: TrajectoryTotals(
      turns: turns.length,
      // 🔴 拿不到"这一轮一共几步"（文件头那条）⇒ 恒 null，视图不画它。
      steps: null,
      tokens: _sessionTokens(turns),
      complete: historyComplete,
    ),
  );
}

/// 一条记录 → 一行；**不是这五类记录的 ⇒ `null`**（见 [TrajectoryKind] 那段）。
TrajectoryRow? _rowOf(
  TimelineItem it, {
  required TrajectoryWords words,
  required TurnUsage? Function(int turn) usageOf,
  required Set<int> unfoldedTurns,
  required int closedThrough,
  required Map<int, int> lastUsageSeq,
}) {
  switch (it) {
    case UserUtterance():
      return _row(
        it,
        kind: TrajectoryKind.user,
        turn: null,
        step: null,
        summary: firstLineOf(it.text),
        words: words,
      );
    case AssistantMessage():
      return _row(
        it,
        kind: TrajectoryKind.assistant,
        turn: null,
        step: null,
        summary: firstLineOf(it.displayText),
        words: words,
      );
    case TimelineToolCall():
      // 折起来的工具行：聊天那一屏把它换成了那一轮的折叠控件
      // ⇒ 跳过去之前**先把这一轮展开**（那之后它就画得出来了）。
      return _row(
        it,
        kind: TrajectoryKind.tool,
        turn: it.turn,
        step: it.row.step,
        summary: trajectoryToolSummary(it.row, words),
        words: words,
        needsUnfold: it.turn <= closedThrough && !unfoldedTurns.contains(it.turn),
      );
    case TimelineSystemPrompt():
      return _row(
        it,
        kind: TrajectoryKind.systemPrompt,
        turn: it.turn,
        step: it.row.step,
        summary: firstLineOf(it.row.text),
        words: words,
      );
    case TimelineTurnUsage():
      final u = usageOf(it.turn);
      return _row(
        it,
        kind: TrajectoryKind.usage,
        turn: it.turn,
        step: null,
        // 折得出才画数；折不出就只说"还没结清"（**一个数都不给**）。
        summary: u != null ? words.usage(u) : words.usageNotSettled,
        words: words,
        // 聊天那一屏只画同一轮**最后**那一条 ⇒ 别的几条在那一屏里没有对应的一格。
        inChat: lastUsageSeq[it.turn] == it.seq,
      );
    case TimelineMarker():
    case TimelineNotice():
      // 分隔线与通知**不是那五类记录**（见 [TrajectoryKind] 那段）⇒ 不进这张表。
      return null;
  }
}

TrajectoryRow _row(
  TimelineItem it, {
  required TrajectoryKind kind,
  required int? turn,
  required int? step,
  required String summary,
  required TrajectoryWords words,
  bool inChat = true,
  bool needsUnfold = false,
}) =>
    TrajectoryRow(
      seq: it.seq,
      tie: it.tie,
      kind: kind,
      turn: turn,
      step: step,
      // 空摘要 ⇒ 兜底那一句（**不编占位名 / 占位正文**）。
      summary: summary.isEmpty ? words.blank : summary,
      at: it.at,
      turnHead: false,
      inChat: inChat,
      needsUnfold: needsUnfold,
      item: it,
    );

/// 只换 `turnHead` 那一格（不可变值的小工具）。
extension _TrajectoryRowCopy on TrajectoryRow {
  TrajectoryRow _withTurnHead(bool head) => head == turnHead
      ? this
      : TrajectoryRow(
          seq: seq,
          tie: tie,
          kind: kind,
          turn: turn,
          step: step,
          summary: summary,
          at: at,
          turnHead: head,
          inChat: inChat,
          needsUnfold: needsUnfold,
          item: item,
        );
}

/// 一次工具调用的**一行摘要**：`名字 · 人话标题`（那是 `116` 那一行上的**同一份数据**）。
///
/// ⚠️ **名字可以是空的**：`tool/call` 那条配不上时（合同 `116` §一 规矩 4）
///    只画结果那一行，那时**我们不知道是哪个工具** ⇒ 名字那一格空着，
///    一个占位名都不许编（N10）。
/// ⚠️ 两半都没有 ⇒ 空串（由 [_row] 换成 [TrajectoryWords.blank]）。
String trajectoryToolSummary(ToolRow row, TrajectoryWords words) {
  final name = row.name.trim();
  final title = row.title?.trim() ?? '';
  if (name.isNotEmpty && title.isNotEmpty) return '$name$dshTrajectorySeparator$title';
  if (name.isNotEmpty) return name;
  return title;
}

/// DSH 的拼接规矩（原文就是 `" · "`）—— **它不是文案**，所以住在这里。
const String dshTrajectorySeparator = ' · ';

/// **一行摘要**：取正文的**第一个非空行**，两端去空白。
///
/// ⚠️ 为什么是"第一个非空行"而不是"字面上的第一行"：正文可能以一个空行开头，
///    那时字面第一行是空的 —— 拿它当摘要等于**屏幕上什么都不说**。
///    取第一个**有字**的行仍然逐字是这条正文里的一行，不是编的。
/// ⚠️ 认不出来的输入（`null` / 不是字符串）⇒ `''`（fail-closed，绝不抛）。
String firstLineOf(Object? text) {
  if (text is! String) return '';
  for (final line in text.split('\n')) {
    final t = line.trim();
    if (t.isNotEmpty) return t;
  }
  return '';
}

/// 事件时刻 → 屏幕上那一格（`HH:mm:ss`，**设备本地时区**）。
///
/// ⚠️ 服务端给的是 epoch 毫秒（`Timeline.emit` 的 `at`），这里按**本机时区**画；
///    跨天的会话看不出日期 —— 这是**有意**的：那一格窄，而且它只用来看"先后"。
///    要改就得连文档一起改（`118` §六 明写着这条）。
/// ⚠️ 纯函数（进得了 `test/unit`）：不读系统时钟、不读时区设置。
String trajectoryClock(DateTime t) {
  String two(int n) => n < 10 ? '0$n' : '$n';
  return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
}

/// 这一窗里"每轮都折得出"的那些用量**加起来**；**只要有一轮折不出来就整块 `null`**。
///
/// 规矩（与 `foldTurnUsage` 同一条精神：**宁可不给，也不给半个**）：
///   · 有一轮 `usage == null`（那一次没报准 / 还没结清）⇒ `null`
///     —— 少算一轮的合计比不画更坏；
///   · 可选的桶（缓存读/写、推理）**要么每一轮都报了、要么整块不给**；
///   · 溢出安全整数（上限就是 JS 那一个）⇒ `null`。
TurnUsage? _sessionTokens(List<TrajectoryTurn> turns) {
  if (turns.isEmpty) return null;
  var input = 0;
  var output = 0;
  final cacheReads = <int>[];
  final cacheWrites = <int>[];
  final reasonings = <int>[];
  for (final t in turns) {
    final u = t.usage;
    if (u == null) return null;
    input += u.input;
    output += u.output;
    if (!_safeTokenCount(u.input) || !_safeTokenCount(u.output)) return null;
    for (final v in [u.cacheRead, u.cacheWrite, u.reasoning]) {
      if (v != null && !_safeTokenCount(v)) return null;
    }
    if (u.cacheRead != null) cacheReads.add(u.cacheRead!);
    if (u.cacheWrite != null) cacheWrites.add(u.cacheWrite!);
    if (u.reasoning != null) reasonings.add(u.reasoning!);
  }
  if (!_safeTokenCount(input) || !_safeTokenCount(output)) return null;
  return TurnUsage(
    input: input,
    output: output,
    cacheRead: _sumIfEveryTurn(cacheReads, turns.length),
    cacheWrite: _sumIfEveryTurn(cacheWrites, turns.length),
    reasoning: _sumIfEveryTurn(reasonings, turns.length),
  );
}

int? _sumIfEveryTurn(List<int> values, int turns) {
  if (values.length != turns) return null;
  var sum = 0;
  for (final v in values) {
    sum += v;
  }
  return _safeTokenCount(sum) ? sum : null;
}

bool _safeTokenCount(int n) => n >= 0 && n <= dshMaxSafeTokenCount;
