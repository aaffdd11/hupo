// **重连退避那一档**（P1-10，2026-09-24）· 契约 `docs/dev/16-STREAM.md`（B1 / B5）
//
// 为什么把它从 `stream.dart` 里提出来：那里原来是一句**写死的算式**
//   `final secs = (_attempt * 2).clamp(1, 8);`
// —— 而"退避到底怎么涨、封顶多少"是**行为**，行为要能判（当时只靠肉眼看）。
// ⇒ 提到 `models/`（纯逻辑层，不 import material），判据 `test/unit/retry_test.dart`。
//
// ⚠️ 两条历史教训（都写在这里，免得下一次又踩）：
//   · **B5**：`_attempt` **只在连成功时归零**（旧实现每次 open 都归零 ⇒ 封顶值永不生效，
//     断线风暴里会变成"每 2 秒重连一次"打到底）；
//   · **B1**：401 要**停下来**（`ConnState.unauthorized`），不是无限重连。
//     那一条住 `stream.dart` 的状态机里，不在这条纯函数里。

/// 第 [attempt] 次重连等多少秒（**从 1 开始**）。
///
/// 现在的档：1 → 2s · 2 → 4s · 3 → 6s · 4 及以上 → **8s 封顶**。
/// ⚠️ 上限刻意是 8 秒：再长，用户会觉得"它死了"；再短，断线风暴里等于没退避。
int retrySeconds(int attempt) {
  final n = attempt < 1 ? 1 : attempt;
  final secs = n * 2;
  return secs > 8 ? 8 : secs;
}
