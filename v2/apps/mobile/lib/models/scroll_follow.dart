// 「时间线要不要跟到底部」——**一条能算错的规则，所以搬成纯函数**。
//
// ⚠️ 为什么它值得单独一个文件：这条规则**已经算错过一次**（欠账第 24 条）：
//    原先的判据只有"离底部不到 160 像素才继续跟随"，
//    而**首屏 `pixels == 0` 对上一屏历史** ⇒ 那个判据恒为 false
//    ⇒ **打开就停在最老那一条**，最新的话全在屏幕外面。
//    实测证据：`docs/dev/00-PROGRESS.md` §六 第 24 条（截图停在 seq 1–19，盘上已到 78）。
//
// ⇒ 搬出来的理由有两条：
//   ① 它是**纯逻辑**（给几个数，出一个动作），而手册的纪律是
//      **纯函数进 `test/unit` 的硬闸，界面断言只算提示**；
//   ② 它错起来**屏幕上完全看不出来**（"停在那儿"和"跟上了"都只是一屏字），
//      只有把判据本身钉住才防得住。

/// 该做什么。
enum FollowAction {
  /// 什么都不用做（已经在底部，或者根本没有可滚的）。
  none,

  /// **直接跳**到底部。
  ///
  /// 用在首屏：动画在挂载那一帧没有意义，而且**历史一长**，
  /// `animate` 会当着主人的面从最老那条一路滑下来（那是"页面自己在动"，很吓人）。
  jump,

  /// **动画**滑到底部（跟一条新消息进来，不突兀）。
  animate,
}

/// "接近底部"的宽容带：用户自己翻上去之后，离底部这么近才继续跟随。
///
/// ⚠️ 数值只住在代码里（手册维护纪律 1：**不把数值写进文档**）。
const double followSlack = 160;

/// 这一帧该不该跟到底部。
///
/// @param pixels           当前滚动位置
/// @param maxScrollExtent  最大滚动位置（`<= 0` = 内容还没超过一屏）
/// @param userScrolledAway 用户**自己往上翻过**没有（自己 `animateTo` 的不算）
FollowAction scrollFollowAction({
  required double pixels,
  required double maxScrollExtent,
  required bool userScrolledAway,
}) {
  // 没有可滚的 ⇒ 什么都不用做
  if (maxScrollExtent <= 0) return FollowAction.none;
  // 已经在底部 ⇒ 不用动（**先判它**：不然下面那条会每帧都 jump 一次）
  if (pixels >= maxScrollExtent) return FollowAction.none;

  if (!userScrolledAway) {
    // ★ **用户从没自己往上翻过 ⇒ 永远跟到底。**
    //    这一支就是第 24 条的修法：首屏那一次（`pixels == 0`、历史很长）
    //    走的就是这里，而不是"离底部 160 以内"那条老判据。
    return FollowAction.jump;
  }

  // 用户翻上去了：只在"他就在底部附近"时才继续跟随 —— **不许打断他**。
  return maxScrollExtent - pixels < followSlack ? FollowAction.animate : FollowAction.none;
}
