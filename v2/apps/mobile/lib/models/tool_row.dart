// **工具行 + 一轮的过程折叠**：新服务端事件（`tool/call` · `tool/result` ·
// `turn/usage` · `system/prompt`）的**客户端那一半契约**。
//
// ── 这一批要补的是什么（`docs/dev/115-DSH-WINDOW-PARITY.md` 丙-1 / 丙-2 / 丙-3）──
// 我们今天只收 5 种**被翻译过的**过程事件（`message/status` · `step/*` ·
// `reasoning/delta` · `plan/updated`），于是"它到底调了什么、成没成、这一轮大概多贵"
// **在屏幕上没有一行**（研究 §四：这是最大的一处信息损失）。这一批往后：
// 服务端把每次工具调用**逐条**发上来，客户端**逐条画出来**（`ToolRow`）；
// 一轮结束时把它折成一行计数（`TurnProcess`）；用量**宁可不显示也不给半个**（`foldTurnUsage`）。
//
// ⚠️ **这四个 payload 服务端还没有**（这一批只做客户端这一半）。所以这里每一条
//    **都按"输入可能是任何东西"来写**：认不出来 ⇒ `null`，**绝不抛**
//    （同 `process_levels.dart` 那条：坏数据的后果只许是"这一行不画"，不能是"打不开聊天"）。
//
// ⚠️ **纯逻辑**：不 import `material`、不碰 I/O、不碰计时器 —— 所以它才能进 `test/unit`
//    （楼层闸 `test/unit/import_rules_test.dart`）。
//
// ⚠️ **`models/` 里不许有给人看的字**：这一份一个中文文案都没有。
//    折叠那一行的"次工具调用 / 条消息 / 个 subagent"由**调用方**给（[TurnProcessWords]），
//    三样全 0 时那句兜底也由调用方给 —— 这样文案才能进禁用词闸（`forbidden_words_test.dart`）
//    扫的那张清单里，而不是躲在这一层里。

/// 一次工具调用的收尾状态。
///
/// ⚠️ 线上只有四个值，**多一个都不许加**：界面按它选颜色/图标，
///    多出来的值会让某一处 `switch` 悄悄走到默认分支（那正是"页面在说假话"的起点）。
enum ToolStatus {
  /// 发出去了，还没有结果。
  running,

  /// 有结果，且成。
  ok,

  /// 有结果，且败。
  error,

  /// **被打断**（用户停了 / 轮次被中断）。
  ///
  /// ⚠️ 它和 [error] **不是一回事**：屏幕上一个是"没做成"，一个是"我没让它做完"。
  ///    合成一个会让"我自己按的停止"看起来像"它坏了"。
  interrupted,
}

/// 一次工具调用 → 屏幕上一行。
///
/// 字段就是画那一行要用的全部：**哪个工具**（[name]）、**一句人话标题**（[title]，
/// 服务端给，可能没有）、**原样入参**（[args]，可能没有）、**成败**（[status]）、
/// **一行摘要**（[excerpt]）、**多大 / 有没有被截**（[bytes] / [truncated]）、
/// **挂在哪一轮哪一步**（[turn] / [step]）。
class ToolRow {
  const ToolRow({
    required this.callId,
    required this.name,
    required this.title,
    required this.args,
    required this.status,
    required this.excerpt,
    required this.bytes,
    required this.truncated,
    required this.turn,
    required this.step,
  });

  /// 配对用的身份（`tool/call` ↔ `tool/result`）。
  final String callId;

  /// 工具名（服务端给的原文）。
  ///
  /// ⚠️ **它是不是能上屏，是另一件事**：`forbidden_words.dart` 那一层的规矩是
  ///    "内部词上屏 = 缺陷"。这一层只负责**如实存下来**——要不要画、怎么画，
  ///    由界面层（以及主人对 115 §七.1 的拍板）决定。
  final String name;

  /// 服务端给的一句人话标题（`null` = 没给）。
  final String? title;

  /// 原样入参（`null` = 没给）。
  final String? args;

  final ToolStatus status;

  /// 结果的一行摘要（`null` = 没有，或还没结果）。
  final String? excerpt;

  /// 结果有多大（字节）。⚠️ 还没结果时是 `0` —— 那是"**还没报**"，不是"零字节"。
  final int bytes;

  /// 结果有没有被截断。**必须原样保留**：截了不说 = 页面在说假话。
  final bool truncated;

  final int turn;
  final int step;

  /// 解析一对事件 → 一行；**认不出来返回 `null`（fail-closed，绝不抛）**。
  ///
  /// @param call `tool/call` 的 payload（`{type, turn, step, callId, name, title, args, at}`）
  /// @param result `tool/result` 的 payload，或 `null`（还在跑）
  ///
  /// 认得出来的条件是：
  ///   · `call.type == 'tool/call'`，`callId` / `name` 是非空字符串，`turn` / `step` 是非负整数；
  ///   · `result == null` ⇒ [ToolStatus.running]；
  ///   · 否则 `result.type == 'tool/result'`、`callId` **与 call 对上**、`ok` 是布尔、
  ///     `bytes` 是非负整数 —— 少一样就 `null`（**不猜**：猜出来的成败会直接画到屏幕上）。
  ///
  /// ⚠️ **可选字段坏了不算坏**：`title` / `args` / `excerpt` 这类只影响"那一行好不好看"的，
  ///    类型不对就当没有（`null`）。**身份字段与成败字段坏了才是坏**。
  static ToolRow? parse(Object? call, Object? result) {
    if (_field(call, 'type') != 'tool/call') return null;
    final callId = _nonEmptyString(_field(call, 'callId'));
    final name = _nonEmptyString(_field(call, 'name'));
    final turn = _count(_field(call, 'turn'));
    final step = _count(_field(call, 'step'));
    if (callId == null || name == null || turn == null || step == null) return null;

    final title = _stringOrNull(_field(call, 'title'));
    final args = _stringOrNull(_field(call, 'args'));

    if (result == null) {
      return ToolRow(
        callId: callId,
        name: name,
        title: title,
        args: args,
        status: ToolStatus.running,
        excerpt: null,
        bytes: 0,
        truncated: false,
        turn: turn,
        step: step,
      );
    }

    if (_field(result, 'type') != 'tool/result') return null;
    if (_stringOrNull(_field(result, 'callId')) != callId) return null;
    final ok = _field(result, 'ok');
    if (ok is! bool) return null;
    final bytes = _count(_field(result, 'bytes'));
    if (bytes == null) return null;
    final error = _stringOrNull(_field(result, 'error'));

    return ToolRow(
      callId: callId,
      name: name,
      title: title,
      args: args,
      status: ok ? ToolStatus.ok : _failedStatus(error),
      excerpt: _stringOrNull(_field(result, 'excerpt')),
      bytes: bytes,
      truncated: _field(result, 'truncated') == true,
      turn: turn,
      step: step,
    );
  }

  /// **只有结果那一半**（`tool/call` 那条配不上 / 还没到）⇒ 也画一行。
  ///
  /// 合同 `docs/dev/116-CHAT-OPEN-AND-REDESIGN.md` §一 规矩 4：
  /// *"靠 `callId` 配回 `tool/call`；**配不上就只画结果那一行**"*。
  ///
  /// ⚠️ 名字那一格**空着**（[name] = `''`）：不是"未知工具"，是**我们不知道** ——
  ///    编一个占位名字摆上去就是拿猜的东西上屏（N10：沉默优于编造）。
  /// ⚠️ 校验规则与 [parse] 的结果那一半**逐条相同**（复用同一批小工具，
  ///    所以两处不会漂）：`callId` 非空、`turn`/`step` 认得出、`ok` 是布尔、
  ///    `bytes` 是非负整数；少一样 ⇒ `null`（**绝不抛**）。
  static ToolRow? parseResultOnly(Object? result) {
    if (_field(result, 'type') != 'tool/result') return null;
    final callId = _nonEmptyString(_field(result, 'callId'));
    final turn = _count(_field(result, 'turn'));
    final step = _count(_field(result, 'step'));
    if (callId == null || turn == null || step == null) return null;
    final ok = _field(result, 'ok');
    if (ok is! bool) return null;
    final bytes = _count(_field(result, 'bytes'));
    if (bytes == null) return null;
    final error = _stringOrNull(_field(result, 'error'));

    return ToolRow(
      callId: callId,
      name: '',
      title: null,
      args: null,
      status: ok ? ToolStatus.ok : _failedStatus(error),
      excerpt: _stringOrNull(_field(result, 'excerpt')),
      bytes: bytes,
      truncated: _field(result, 'truncated') == true,
      turn: turn,
      step: step,
    );
  }
}

/// `ok == false` 时，**"没做成"与"没让它做完"要分开**。
///
/// ⚠️ 线上 `tool/result` **没有** `status` 字段，只有一个 `error` 字符串
///    ⇒ 这一层只能从 `error` 里认那几个"打断"的词。认不出来一律算 [ToolStatus.error]
///    （**fail-closed**：不认识的词不许被当成"打断"，那会把真失败说轻）。
///    ⚠️ **这一条是客户端与临时约定**：服务端要是以后加了显式状态字段，
///      这一段就该删掉、改成读那个字段（别让两个真相同时存在）。
const Set<String> dshToolInterruptedCodes = {
  'interrupted',
  'aborted',
  'cancelled',
  'canceled',
};

ToolStatus _failedStatus(String? error) {
  if (error == null) return ToolStatus.error;
  return dshToolInterruptedCodes.contains(error.trim().toLowerCase())
      ? ToolStatus.interrupted
      : ToolStatus.error;
}

// ── 一轮的过程折叠（DSH `TurnProcessNodeView` 那一条计数）──────────
//
/// 一轮里的三样计数（**互斥**，见 [TurnProcess.fold]）。
///
/// DSH 的原文（`B-render.md` §2.3 `updateProcessState`）：
///   · `toolCallCount` —— 每次 `tool/call`，**且它不是一次 subagent 派活**；
///   · `subagentCount`  —— 每次 `tool/call`，**且它是一次 subagent 派活**
///     （`name == "subagent" || name.startsWith("subagent_")`）；
///   · `messageCount`   —— **有回复内容**的助手消息，且**在最终答案那一步之前**；
///   · 系统提示词与上下文注入**不计数**。
/// ⇒ 工具与 subagent **互斥**（同一次调用只进一个桶）。
class TurnProcess {
  const TurnProcess({
    required this.toolCalls,
    required this.messages,
    required this.subagents,
  });

  final int toolCalls;

  /// 只数**有回复内容**的助手消息，且**严格早于**最终答案那一步。
  ///
  /// 为什么有这么一条：最后那一步那句正文就是"答案"，如果再把它数进去，
  /// 折叠行会变成"N 次工具调用 · 1 条消息"——而用户面前明明只看到一句回答。
  final int messages;

  final int subagents;

  /// 三样全 0（DSH 这时候显示"已思考"）。
  bool get isEmpty => toolCalls == 0 && messages == 0 && subagents == 0;

  int get total => toolCalls + messages + subagents;

  /// **非零**的那几段，顺序**固定**为 工具 · 消息 · subagent（DSH `:3281-3285`）。
  ///
  /// ⚠️ 顺序是写死的，不是"按数量大小排" —— 同一轮里数字一变顺序就跳，读起来像换了一行。
  List<TurnProcessSegment> get segments => [
        for (final s in TurnProcessSegment.values)
          if (_countOf(s) > 0) s,
      ];

  int _countOf(TurnProcessSegment s) => switch (s) {
        TurnProcessSegment.toolCalls => toolCalls,
        TurnProcessSegment.messages => messages,
        TurnProcessSegment.subagents => subagents,
      };

  /// 把这一轮**数出来**。
  ///
  /// @param rows 这一轮（或这一窗）里所有 `tool/call` 行
  /// @param replySteps 产生了**有回复内容**的助手消息的那些 step（可重复，一个 step 一条）
  /// @param answerStep 最终答案所在的 step；`null` = 这一轮还没有答案（还在跑 / 没有正文）
  /// @param turn 只数这一轮；`null` = 传进来的 [rows] 已经筛好了
  ///
  /// ⚠️ **不按 `callId` 去重**：DSH 数的是**事件**（一次 `tool/call` = 一次），
  ///    去重会把"同一个 callId 重放两次"这种协议异常悄悄吃掉 —— 那属于服务端该报的错，
  ///    不该由客户端猜。
  static TurnProcess fold({
    required Iterable<ToolRow> rows,
    Iterable<int> replySteps = const [],
    int? answerStep,
    int? turn,
  }) {
    var tools = 0;
    var subs = 0;
    for (final r in rows) {
      if (turn != null && r.turn != turn) continue;
      if (isSubagentDelegation(r.name)) {
        subs++;
      } else if (dshControlTools.contains(r.name)) {
        // 控制类工具（发消息、看孩子）**两个桶都不进**。
        // DSH 那句"Control tools such as send_message and list_agents are deliberately
        // excluded"就是说的这个：它们不是"干活的工具调用"，也不是派活。
      } else {
        tools++;
      }
    }

    var messages = 0;
    for (final step in replySteps) {
      if (answerStep == null || step < answerStep) messages++;
    }

    return TurnProcess(toolCalls: tools, messages: messages, subagents: subs);
  }

  /// 这一条调用是不是"派了一个 subagent 出去"。
  ///
  /// ⚠️ 逐字照 DSH 的 `isSubagentDelegationTool`：`name == 'subagent' || name.startsWith('subagent_')`。
  static bool isSubagentDelegation(String name) =>
      name == 'subagent' || name.startsWith('subagent_');
}

/// 控制类工具：**既不算工具调用，也不算 subagent**（见 [TurnProcess.fold]）。
///
/// ⚠️ 名单是**短的、显式的**，故意不写成"`send_*` / `list_*` 都算"那种模式：
///    模式会把将来某个真干活的 `list_xxx` 工具悄悄漏掉计数。
const Set<String> dshControlTools = {
  'send_message', // 往别的会话说一句话
  'list_agents', // 看一眼有哪些孩子在跑
};

/// 折叠行里的三段（顺序 = 枚举顺序）。
enum TurnProcessSegment { toolCalls, messages, subagents }

/// 折叠行那句字**怎么拼**——由调用方给（`models/` 不写给人看的字）。
///
/// 每个 count 函数**只会被非零的那几段调用**（0 的段省略 —— DSH 的规矩）；
/// 三样全 0 时用 [fallback]（DSH 是"已思考"）。
class TurnProcessWords {
  const TurnProcessWords({
    required this.toolCalls,
    required this.messages,
    required this.subagents,
    required this.fallback,
  });

  final String Function(int count) toolCalls;
  final String Function(int count) messages;
  final String Function(int count) subagents;
  final String fallback;
}

/// 段与段之间的分隔（DSH 原文就是 `" · "` —— 一个空格 + 中点 + 一个空格）。
///
/// ⚠️ 这**不是文案**，是 DSH 的拼接规矩（`B-render.md` §2.3：`" · "`-joined）；
///    所以它住在这里，而不是由调用方当文案传进来。
const String dshTurnProcessSeparator = ' · ';

/// 把计数拼成一行字（零段省略；全零 ⇒ [TurnProcessWords.fallback]）。
String dshTurnProcessLabel(TurnProcess counts, TurnProcessWords words) {
  final parts = <String>[
    for (final s in counts.segments)
      switch (s) {
        TurnProcessSegment.toolCalls => words.toolCalls(counts.toolCalls),
        TurnProcessSegment.messages => words.messages(counts.messages),
        TurnProcessSegment.subagents => words.subagents(counts.subagents),
      },
  ];
  if (parts.isEmpty) return words.fallback;
  return parts.join(dshTurnProcessSeparator);
}

// ── 一轮的 token 用量（宁可不显示，也不给半个）──────────────────
//
/// JS 的"安全整数"上界（`2^53 - 1`）。
///
/// ⚠️ 为什么不是 Dart 的 `int` 上界：这个数**是从 JS 服务端来的**（`JSON.parse` 之后
///    超过它就已经不准了）。DSH 的规矩就是"非负**安全整数**才算数"。
const int dshMaxSafeTokenCount = 9007199254740991;

/// 一次尝试的用量（DSH `normalizeUsage` 那一层）。
class TurnUsage {
  const TurnUsage({
    required this.input,
    required this.output,
    this.cacheRead,
    this.cacheWrite,
    this.reasoning,
  });

  /// 未命中缓存的输入 token（DSH `uncachedInputTokens`）。
  final int input;

  /// 输出 token（DSH `outputTokens`）。
  final int output;

  /// 缓存读取 / 缓存写入（**可能没有**：上游不一定报）。
  ///
  /// ⚠️ `null` 不等于 0。0 是"报了，确实是零"；`null` 是"没报"——
  ///    两者在折叠时**后果不同**（见 [foldTurnUsage]）。
  final int? cacheRead;
  final int? cacheWrite;

  /// 其中推理 token（**可能没有**）。它必须 ≤ [output]（下面会验）。
  final int? reasoning;

  /// 四个桶的和（DSH 的 `uncachedInput + output + cacheRead + cacheWrite`）。
  ///
  /// ⚠️ `null` 的桶**按 0 加**在这里只用于显示"大概多少"；**是否允许显示整块**
  ///    由 [foldTurnUsage] 决定（那才是 DSH 的判据）。
  int get total => input + output + (cacheRead ?? 0) + (cacheWrite ?? 0);
}

/// 一条 `turn/usage` 事件（一轮里**每一次尝试**一条）。
class TurnUsageAttempt {
  const TurnUsageAttempt({
    required this.turn,
    required this.usage,
    required this.complete,
  });

  final int turn;

  /// `null` = **这一次尝试没报用量**（payload 允许 `usage: null`）。
  final TurnUsage? usage;

  /// 这一次尝试的账**结清了没有**。
  final bool complete;

  /// 解析一条 `turn/usage`；认不出来 ⇒ `null`（绝不抛）。
  ///
  /// ⚠️ `usage` 缺失/为 `null` **不算"认不出来"** —— 那是一条**合法的**
  ///    "这次没报用量"，它会（正确地）让整轮折叠结果变成 `null`。
  ///    但 `usage` 在、数字却是坏的（负数 / 非整数 / 超安全整数）⇒ 整条不认。
  static TurnUsageAttempt? parse(Object? event) {
    if (_field(event, 'type') != 'turn/usage') return null;
    final turn = _count(_field(event, 'turn'));
    if (turn == null) return null;
    final complete = _field(event, 'complete');
    if (complete is! bool) return null;

    final raw = _field(event, 'usage');
    if (raw == null) {
      return TurnUsageAttempt(turn: turn, usage: null, complete: complete);
    }
    if (raw is! Map) return null;

    final input = _count(_field(raw, 'input'));
    final output = _count(_field(raw, 'output'));
    if (input == null || output == null) return null;

    final cacheRead = _optionalCount(raw, 'cacheRead');
    final cacheWrite = _optionalCount(raw, 'cacheWrite');
    final reasoning = _optionalCount(raw, 'reasoning');
    if (!cacheRead.ok || !cacheWrite.ok || !reasoning.ok) return null;

    return TurnUsageAttempt(
      turn: turn,
      complete: complete,
      usage: TurnUsage(
        input: input,
        output: output,
        cacheRead: cacheRead.value,
        cacheWrite: cacheWrite.value,
        reasoning: reasoning.value,
      ),
    );
  }
}

/// 把一轮里的**所有**尝试折成一个数；**只要有一点不精确就返回 `null`**。
///
/// DSH 的规矩（`B-render.md` §2.7 `aggregateAttempts`）：
///   · 每一次尝试都要报了用量；没报 ⇒ **整块详情不画**（不许拿报了的几次凑一个"约等于"）；
///   · `complete` 不是 `true` 的尝试 ⇒ 这一轮**还没结清** ⇒ 不画；
///   · `reasoning ≤ output`（不满足就是账本身矛盾）⇒ 不画；
///   · 可选的桶（缓存读/写、推理）**要么每一次都报了、要么整块不给**（不许给半个和）。
///
/// ⚠️ 全空 ⇒ `null`（不是 0）：0 会被画成"这一轮没花 token"，那是假话。
TurnUsage? foldTurnUsage(Iterable<TurnUsageAttempt> attempts) {
  final list = attempts.toList(growable: false);
  if (list.isEmpty) return null;

  int? turn;
  for (final a in list) {
    if (turn == null) {
      turn = a.turn;
    } else if (a.turn != turn) {
      return null; // 混了不止一轮 ⇒ 不猜"这是哪一轮的账"
    }
    if (!a.complete) return null;
    final u = a.usage;
    if (u == null) return null;
    if (!_safe(u.input) || !_safe(u.output)) return null;
    for (final v in [u.cacheRead, u.cacheWrite, u.reasoning]) {
      if (v != null && !_safe(v)) return null;
    }
    if (u.reasoning != null && u.reasoning! > u.output) return null;
  }

  var input = 0;
  var output = 0;
  final cacheReads = <int>[];
  final cacheWrites = <int>[];
  final reasonings = <int>[];
  for (final a in list) {
    final u = a.usage!;
    input += u.input;
    output += u.output;
    if (u.cacheRead != null) cacheReads.add(u.cacheRead!);
    if (u.cacheWrite != null) cacheWrites.add(u.cacheWrite!);
    if (u.reasoning != null) reasonings.add(u.reasoning!);
  }
  if (!_safe(input) || !_safe(output)) return null;

  return TurnUsage(
    input: input,
    output: output,
    cacheRead: _sumIfEveryAttempt(cacheReads, list.length),
    cacheWrite: _sumIfEveryAttempt(cacheWrites, list.length),
    reasoning: _sumIfEveryAttempt(reasonings, list.length),
  );
}

int? _sumIfEveryAttempt(List<int> values, int attempts) {
  if (values.length != attempts) return null;
  var sum = 0;
  for (final v in values) {
    sum += v;
  }
  return _safe(sum) ? sum : null;
}

// ── 系统提示词行 ────────────────────────────────────────────────
//
/// 一条 `system/prompt` → 屏幕上那一行（**逐字原文**，DSH 的规矩：
/// "system-prompt text with real line breaks" —— 模型看到的原样，不加工）。
///
/// ⚠️ 为什么它必须**逐字**：这一行存在的唯一意义就是"能核对模型到底看到了什么"。
///    截断/改写的提示词行，比没有这一行更坏。
class SystemPromptRow {
  const SystemPromptRow({
    required this.turn,
    required this.step,
    required this.text,
    required this.bytes,
    required this.truncated,
  });

  final int turn;
  final int step;

  /// 原文（保留换行）。可能是空串 —— 要不要画由界面层定（DSH 是"非空才画一行"）。
  final String text;

  final int bytes;
  final bool truncated;

  /// 解析一条 `system/prompt`；认不出来 ⇒ `null`（绝不抛）。
  static SystemPromptRow? parse(Object? event) {
    if (_field(event, 'type') != 'system/prompt') return null;
    final turn = _count(_field(event, 'turn'));
    final step = _count(_field(event, 'step'));
    if (turn == null || step == null) return null;
    final text = _field(event, 'text');
    if (text is! String) return null;
    final bytes = _count(_field(event, 'bytes'));
    if (bytes == null) return null;
    return SystemPromptRow(
      turn: turn,
      step: step,
      text: text,
      bytes: bytes,
      truncated: _field(event, 'truncated') == true,
    );
  }
}

// ── 取值小工具（**只做"能不能信"的判断，不做类型转换的魔法**）────

/// 读一个字段；不是 Map 就当作没有。
Object? _field(Object? value, String key) =>
    value is Map ? value[key] : null;

/// 非负**安全整数**（`int`，或 `double` 但正好是个整数）。
int? _count(Object? value) {
  int? n;
  if (value is int) {
    n = value;
  } else if (value is num && value.isFinite && value == value.roundToDouble()) {
    n = value.toInt();
  }
  if (n == null || n < 0 || !_safe(n)) return null;
  return n;
}

/// 可选计数（三态）：**没有** / **有且合法** / **有但坏了**。
({bool ok, int? value}) _optionalCount(Object? map, String key) {
  final raw = _field(map, key);
  if (raw == null) return (ok: true, value: null);
  final n = _count(raw);
  return (ok: n != null, value: n);
}

bool _safe(int n) => n >= 0 && n <= dshMaxSafeTokenCount;

String? _nonEmptyString(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

String? _stringOrNull(Object? value) => value is String ? value : null;
