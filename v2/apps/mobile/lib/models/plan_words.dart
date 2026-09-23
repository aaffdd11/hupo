// 计划条上那几句话（主人 2026-09-23 · `64-CHAT-REDESIGN.md`）。
//
// ⚠️ **界面上的字只有这一处**（D3.10：一套外观一处出处；文案同一条规矩）。
// ⚠️ 不许出现内部词（工具 / 上下文 / 时间线 / 作用域…）：这里说的是"它现在打算做哪几件"。

/// 目标那一行的前缀（后面接 objective 原文）。
const String planGoalLabel = '正在做';

/// 没有目标、只有任务清单时的前缀。
const String planTodoOnlyLabel = '它列了几件事';

/// 各档状态各一个词（`unknown` **什么都不加** —— 认不出的阶段少说一句，
/// 而不是猜一个"正在做"出来）。
const Map<String, String> planPhaseWords = {
  'active': '',
  'paused': '先搁着',
  'complete': '做完了',
  'blocked': '卡住了',
  'unknown': '',
};

/// "还有 N 件"（界面只画前几件，剩下的如实报数）。
String planMoreWords(int n) => '还有 $n 件';
