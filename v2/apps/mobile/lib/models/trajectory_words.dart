// **轨迹那一屏的全部文字**（契约 `docs/dev/118-TRAJECTORY-VIEW.md`）。
//
// ── 它是什么、为什么单独一份 ─────────────────────────────────
// 轨迹是浮窗里**第二个 tab**：把同一条会话摊成一张表（研究 `115` §一.4 ＋
// `115-raw/B-render.md` §1.5）。这一份是那张表上**会显示给用户看**的每一个词/每一句话。
//
// ⚠️ 和 `tool_row_words.dart` / `queue_words.dart` 同一条纪律：**文案集中一处**
//    （不在 widget 里写死）—— 这样才改得动、也才数得清、才进得了禁用词那道扫描。
// ⚠️ `models/` 是纯逻辑层（楼层闸）⇒ 这一份**不 import material**：
//    它只说"屏幕上那句是什么字"，怎么画（颜色/字号/等宽）是
//    `widgets/trajectory_view.dart` 的事。
//
// ── 🔴 与禁用词表的关系（**如实写清**）────────────────────────
// 类别词里的 `工具` / `系统提示词` **都是** `models/forbidden_words.dart` 表里的词
// （`工具` / `系统提示`）。主人 2026-09-26 的原话是*"首先全部开放"*，`115` §七.1
// 说的正是"**聊天窗口内放开 D1.1（内部词＝缺陷）**"（`05-DECISIONS.md` **D1.1·补**）。
// ⇒ 现状是：**词表还禁着、聊天窗口已经放开**。这一批**不许改词表**（派活单点名的），
//    所以 [trajectoryKindWord] 里那两个词**故意没有**进
//    `test/unit/forbidden_words_test.dart` 那份"必须干净"的清单
//    —— 进了会当场红，而红的不是这一份、是那条还没收口的规矩（与 `116` 同一处境）。
// ⚠️ 其余那几句（空会话 / 没加载完 / 过不去 …）**是干净的**，它们在那份清单里。
//
// ── 🔴 一个数都不许编（这一份里最要紧的一条）────────────────
// 屏幕上**没有模型名、没有钱、没有时长、没有百分比**（我们根本收不到，
// 见 `models/trajectory.dart` 顶上那五条）。合计那几个字只说**手上真有的**
// （轮数 ＋ 折得出的 token）；步骤那一格**不画**（拿不到）。
// ⚠️ **复用 `116` 的桶口径**：[trajectoryTotalUsageLine] 与 [turnUsageLine]
//    共用 `turnUsageBucketsLine` —— 一处出处，省得"每一轮那一行"与"合计那一行"
//    列出不同的桶（那就是两个真相）。

import 'tool_row.dart';
import 'tool_row_words.dart';
import 'trajectory.dart';

/// 一条记录的类别 → 屏幕上那个词。
///
/// ⚠️ **五个一个不多一个不少**（[TrajectoryKind] 就这五个）：多出来一个就会让某一处
///    `switch` 走到"默认"上，而那正是"页面在说假话"的起点。
String trajectoryKindWord(TrajectoryKind kind) => switch (kind) {
  TrajectoryKind.user => '用户',
  TrajectoryKind.assistant => '助手',
  TrajectoryKind.tool => '工具',
  TrajectoryKind.systemPrompt => '系统提示词',
  TrajectoryKind.usage => '用量',
};

/// 分组头那一句（`第 N 轮` —— 轮号是**记录自己带的**那个，不是我们数出来的）。
String trajectoryTurnHead(int turn) => '第 $turn 轮';

/// 顶栏合计的抬头。
const String trajectoryTotalsHead = '这一屏合计';

/// 合计里"几轮"那一格。
String trajectoryTurnsCount(int n) => '$n 轮';

/// 合计里 token 那一格的抬头（桶的列法与每一轮那一行**共用一处**）。
const String trajectoryTokensHead = '用量';

/// **更早的还没有加载完** —— 只要 [TrajectoryTotals.complete] 是假就画这一句
/// （宁可不给合计的背书，也不许把一窗说成"全部"）。
const String trajectoryIncompleteLine = '更早的还没有加载完。';

/// 已经到这条会话最早那一条了。
const String trajectoryCompleteLine = '到最早那一条了。';

/// 一条记录都没有时那一句（**不编任何行**）。
const String trajectoryEmptyLine = '这里还没有能摊开的东西。';

/// 这一条在聊天那一屏里**没有单独的一格**（同一轮不是最后一条的用量）——
/// 点它就只能**如实说过不去**，不许滚到别的地方。
const String trajectoryJumpUnavailableLine = '这一条在聊天里没有单独一行，过不去。';

/// 滚过去没成（它还没被画出来 / 列表还没到那儿）——如实说，不假装到了。
const String trajectoryJumpFailedLine = '没滚到那一条，它可能还没画出来。';

/// 这一轮的用量**还没结清 / 有一次没报准** ⇒ 只说这一句，**一个数都不给**。
const String trajectoryUsageNotSettled = '这一轮的用量还没结清。';

/// 摘要为空时的兜底（空消息 / 结果先到而名字也没给的那一行）。
const String trajectoryBlankSummary = '（没有可以看的字）';

/// 一轮的用量那一行（复用 `116` 的 `turnUsageLine`：`本轮用量 · 未缓存输入 … tok`）。
String trajectoryUsageSummary(TurnUsage usage) => turnUsageLine(usage);

/// 合计那一行的用量：**同一批桶**，抬头换成 [trajectoryTokensHead]。
///
/// ⚠️ 为什么不用 `turnUsageLine`：它抬头写的是"**本轮**用量" —— 摆到合计那一行上
///    就是**假话**（那是这一屏所有轮加起来的）。
String trajectoryTotalUsageLine(TurnUsage usage) =>
    '$trajectoryTokensHead · ${turnUsageBucketsLine(usage)}';

/// 喂给纯模型（[trajectoryTableOf]）的文案源。
const TrajectoryWords trajectoryWords = TrajectoryWords(
  kind: trajectoryKindWord,
  usage: trajectoryUsageSummary,
  usageNotSettled: trajectoryUsageNotSettled,
  blank: trajectoryBlankSummary,
);
