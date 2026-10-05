// **永不结束的动画的那个总开关**（手册 `08-SPEC.md` §6.1.1 的 M1–M4）。
//
// ── 为什么要有这一条 ────────────────────────────────────────
// `pumpAndSettle()` 的出口是"没有下一帧了"。一个 `..repeat()` **永远出不来**
// ⇒ 那一份判据会转到 10 分钟超时，而**那种红不指向真 bug**（手册原话）。
// 而且"默认关"也不行：线上是静止的、测试是绿的 —— 两边都不知道自己错了（M1）。
//
// ⇒ 三条落地：
//   · **默认开**（M1）；
//   · 关它的地方**只有一处**（M2）= `test/flutter_test_config.dart`；
//   · **关掉 ≠ 删掉**（M3）：那一层照旧在树上、照旧画，只是**停在第 0 刻**。
//
// ⚠️ 现在库里只有一个永不结束的动画：录音时那颗话筒上的**脉动**
//    （今天的落点是 `widgets/rec_blink.dart`：那一格换成语音优先之后，
//     "闪动的 bar" 变成了"那颗圆圈一明一暗"；`rec_pulse.dart` 2026-10-06 已删）。
//    将来再加，**读这一个开关**，别各写各的。
//
// ⚠️ 它住 `models/` ⇒ 不许 import flutter（`import_rules_test` 钉着）：就是一个布尔。

/// **出厂默认**（M1：**开**）。
///
/// ⚠️ 判据钉的是**这一个常量**，不是"测试里现在那个值"——
///    否则那条判据等于自己读自己的答案（手册 §6.1.1 末尾那条教训）。
const bool hupoAnimationsDefault = true;

/// 永不结束的动画**开着吗**（默认 **开**）。
bool hupoAnimationsEnabled = hupoAnimationsDefault;

/// **唯一**该关它的地方是 `test/flutter_test_config.dart`（M2）。
///
/// ⚠️ 别在单个用例里关：那等于"每个新用例都可能漏一行"，
///    而漏掉的那一个会以**超时**的形式红（看不出来是这一层的事）。
void setHupoAnimationsEnabled({required bool on}) => hupoAnimationsEnabled = on;
