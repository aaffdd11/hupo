// **计划条**：harness 自己的「进行中的目标 / 任务列表」（主人 2026-09-23 · `64-CHAT-REDESIGN.md`）。
//
// 数据来自服务端那条持久事件 **`plan/updated`**（形状见 `v2/services/core/src/plan.js`）：
//   `{ goal: {text, phase} | null, todos: [{text, now, done}], doneCount, total, more }`
//
// ⚠️ 这一层是**纯数据**（楼层闸：`models` 不许 import material）——
//    图标与颜色由 `widgets/plan_strip.dart` 那一层决定。

/// 目标的一档（**服务端给的封闭集合**；文案在这一层映射成人话）。
enum PlanPhase { active, paused, complete, blocked, unknown }

PlanPhase planPhaseOf(String? wire) => switch (wire) {
  'active' => PlanPhase.active,
  'paused' => PlanPhase.paused,
  'complete' => PlanPhase.complete,
  'blocked' => PlanPhase.blocked,
  // ⚠️ 认不出的阶段 ⇒ `unknown`（界面上**照样把它画出来**：宁可少说一句状态，
  //    也不许因为一个新阶段就把整条计划**藏掉** —— 那就是"看不见的东西等于不存在"）。
  _ => PlanPhase.unknown,
};

/// 清单上的一件。
class PlanTodo {
  const PlanTodo({required this.text, required this.now, required this.done});

  final String text;

  /// 正在做的那一件（dsh 的 `in_progress`）。
  final bool now;

  /// 做完了（`completed`）。
  final bool done;

  static PlanTodo? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final text = raw['text'];
    if (text is! String || text.trim().isEmpty) return null;
    return PlanTodo(
      text: text,
      now: raw['now'] == true,
      done: raw['done'] == true,
    );
  }
}

/// 现在这一份计划（**空的那份不存在** —— 见 [Plan.fromEvent]）。
class Plan {
  const Plan({
    required this.goal,
    required this.phase,
    required this.todos,
    required this.doneCount,
    required this.total,
    required this.more,
  });

  /// 目标那句话（没有目标时 `null`）。
  final String? goal;
  final PlanPhase phase;
  final List<PlanTodo> todos;
  final int doneCount;

  /// 服务端报的**总条数**（可能比 `todos.length` 大 —— 那边封了顶）。
  final int total;

  /// 封顶之外还剩几件（**如实报**，别假装只有这些）。
  final int more;

  bool get isEmpty => goal == null && todos.isEmpty;

  /// 从一条 `plan/updated` 事件解出来；**认不出 / 空的** ⇒ `null`（界面就不画）。
  static Plan? fromEvent(Object? event) {
    if (event is! Map || event['type'] != 'plan/updated') return null;
    final goalRaw = event['goal'];
    String? goal;
    var phase = PlanPhase.unknown;
    if (goalRaw is Map) {
      final t = goalRaw['text'];
      if (t is String && t.trim().isNotEmpty) {
        goal = t;
        phase = planPhaseOf(goalRaw['phase'] as String?);
      }
    }
    final todos = <PlanTodo>[];
    final list = event['todos'];
    if (list is List) {
      for (final raw in list) {
        final t = PlanTodo.fromJson(raw);
        if (t != null) todos.add(t);
      }
    }
    final plan = Plan(
      goal: goal,
      phase: phase,
      todos: todos,
      doneCount: event['doneCount'] is int
          ? event['doneCount'] as int
          : todos.where((t) => t.done).length,
      total: event['total'] is int ? event['total'] as int : todos.length,
      more: event['more'] is int ? event['more'] as int : 0,
    );
    return plan.isEmpty ? null : plan;
  }

  /// 界面上最多画几件（**住代码里**：那条要小、要一眼看完）。
  static const int shownTodos = 3;

  /// 界面要画的那几件：**在做的那件排最前**，然后按原顺序。
  List<PlanTodo> get shown {
    final now = todos.where((t) => t.now).toList();
    final rest = todos.where((t) => !t.now).toList();
    return [...now, ...rest].take(shownTodos).toList();
  }

  /// 还有几件没画出来（含服务端封顶之外的那些）——**如实说**。
  int get hidden => (total - shownCount).clamp(0, 1 << 30);
  int get shownCount => shown.length;

  /// **清单上每一件都做完了吗** —— 界面据此**把这条收起来**（见 `plan_strip.dart`）。
  ///
  /// 为什么要有它（主人 2026-09-23 的实测反馈：*"还在。它列了几件事"*）：
  /// 这条的定位是"**它现在打算做哪几件**"，而**全做完之后它就不再是"进行中"了** ——
  /// 挂在那儿只会变成屏幕上沿一排打勾 + 划掉的字（主人把那些横线读成了"删掉了"）。
  ///
  /// ⚠️ 三条边界（都有判据）：
  ///   · **一件都没有**（`total == 0`）不算"全做完"——那叫"没有计划"，本来就不画；
  ///   · 🔴 **服务端封过顶**（`more > 0` 或 `total > todos.length`）⇒ **绝不许说全做完**：
  ///     没画出来的那几件我们**不知道**做没做完 ⇒ 宁可留着，也不许假装收工；
  ///   · 只有服务端报的 `doneCount` 数到了 `total`、而且一条都没漏 ⇒ `true`。
  bool get allDone =>
      total > 0 &&
      more == 0 &&
      todos.length == total &&
      doneCount >= total;
}
