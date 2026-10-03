// 时间线上那一行**时间**（契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.1）。
//
// ── 为什么要它 ────────────────────────────────────────────
// 主人 2026-10-02 让我重做聊天窗口。我登录拍了真截图：**一整条时间线上没有一处时间**
// —— 昨天说的和刚才说的长得一模一样，翻上去要靠读内容猜"这是什么时候的事"。
// 而服务端**每个事件都盖了 `at`**（`timeline.emit` 统一盖），客户端原来把它丢了。
//
// ── 规矩 ─────────────────────────────────────────────────
//   · 🔴 **它只用来显示**：排序键仍然是 `(seq, tie)`（`timeline.dart` 那条禁令）。
//   · **不许编**：`at` 读不到（老日志 / 还没被认领的本地发言）⇒ 返回 `false`，
//     一行都不画（N10：沉默优于编造）。
//   · **同一天里隔得近就不画** —— 每两条都盖一个时间戳，屏幕上就变成了一张表
//     （主人的话就是"看不懂"）；隔得远（[timeMarkGapMs]）才再标一次。
//
// ⚠️ 纯逻辑：不 import flutter（`models` 是纯逻辑层，进 `test/unit`）。
//    人话（「今天」/「昨天」）住在 `chat_time_words.dart`（那样才进得了禁用词硬闸）。

import 'chat_time_words.dart';

/// 同一天里，两条之间隔多久就**再标一次**时间。
///
/// ⚠️ 数值只住这儿（和 `design.dart` 那条纪律同一个道理：同一份数字不许有两处）。
/// 30 分钟是**产品判断**：比这更密，"表"就又回来了；比这更疏，翻上去分不清
/// "刚才那句"和"一小时前那句"。
const int timeMarkGapMs = 30 * 60 * 1000;

/// 是不是**同一天**（本地时区 —— 用户看的就是他手上的钟）。
bool sameDay(int a, int b) {
  final x = DateTime.fromMillisecondsSinceEpoch(a);
  final y = DateTime.fromMillisecondsSinceEpoch(b);
  return x.year == y.year && x.month == y.month && x.day == y.day;
}

/// **这一条之前要不要画一行时间**。
///
/// @param prevAt 上一条**画得出来**的时间（没有就是 `null`）
/// @param at 这一条的时间（`null` ⇒ 不画）
/// @param now 现在（毫秒）—— 传进来是为了让判据可控（不许在纯函数里读钟）
bool needsTimeMark({int? prevAt, required int? at, required int now}) {
  if (at == null) return false; // 不知道 ⇒ 不画（不许编）
  if (prevAt == null) return true; // 这一屏的头一条
  if (!sameDay(prevAt, at)) return true; // 跨天 ⇒ 一定要
  return (at - prevAt).abs() >= timeMarkGapMs; // 隔得够久 ⇒ 再标一次
}

/// 那两行字：`HH:MM`（补零）。
String clockLabel(int at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at);
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// 这一行时间**写什么**：
///   · 今天 ⇒「今天 14:32」 · 昨天 ⇒「昨天 09:05」
///   · 今年别的日子 ⇒「10月1日 21:33」
///   · 往年 ⇒「2025年10月1日 21:33」
String timeMarkLabel(int at, {required int now}) {
  final d = DateTime.fromMillisecondsSinceEpoch(at);
  final n = DateTime.fromMillisecondsSinceEpoch(now);
  final clock = clockLabel(at);
  if (sameDay(at, now)) return '$timeMarkToday $clock';
  final yesterday = DateTime(n.year, n.month, n.day)
      .subtract(const Duration(days: 1))
      .millisecondsSinceEpoch;
  if (sameDay(at, yesterday)) return '$timeMarkYesterday $clock';
  if (d.year == n.year) return '${d.month}月${d.day}日 $clock';
  return '${d.year}年${d.month}月${d.day}日 $clock';
}
