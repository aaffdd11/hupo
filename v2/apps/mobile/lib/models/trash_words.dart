// 「删掉 / 回收站」这一路**用户会看到的字**（契约 `28-DELETE.md`）。
//
// ⚠️ 为什么文案单放一个 models 文件、不写在界面里：
//    摆在 `screens/` / `widgets/` 里的字符串，**禁用词硬闸够不着**
//    （`test/unit/forbidden_words_test.dart` 扫的是这份表）。
//    —— 和 `about_facts.dart`、`process_levels.dart` 同一条理由。
//
// ⚠️ 用词纪律：说人话。不许出现"工作区 / 客户端 / 服务器 / 时间线 / 会话 /
//    工具 / 搜索"那些内部词（那是缺陷，不是文风问题）。
//
// ⚠️ 纯逻辑，**不许 import flutter/material**。

/// 顶栏那个入口，以及那一页的标题。
const trashTitle = '回收站';
const trashTooltip = '回收站';

// ── 气泡长按菜单（契约 §二 第 2 条：入口先做**最小**那一个）──────────

/// 菜单标题。
///
/// ⚠️ **不许写"轮"**：那是内部概念（协议里那个 `turn`），用户不知道它是什么
///    ——"内部词出现在界面上是缺陷，不是文风问题"（`AGENTS.md` §六 第 4 条）。
/// ⚠️ 也不写编号（"第 1 个"那种系统编号是禁用的：不是用户的话）。
/// ⚠️⚠️ **而且不许描述"形状"**：能删的组有**三种** —— 一问一答 · 只有那句话
///    （还没轮到它答）· 只有回答（对面那次问已经不在对话里了）。
///    写成"这一问一答"的话，后两种当场变成**屏幕上说假话**（这一批最忌讳的形状）。
///    ⇒ 用一句三种形状都成立的话；**真正"会删掉什么"由紧跟着那份清单说清**。
/// ⚠️ **2026-09-25 改**（契约 `docs/dev/106-CHAT-SELECT.md` §一）：菜单里多了
///    【复制】【多选】两件**与删掉无关**的事 ⇒ 原来那句"要删掉这一处吗"只说删掉，
///    **就是屏幕上说假话**。⇒ 换成对三件事都成立的一句。
///    ⚠️ **删掉那一项本身一个字没动**（`bubbleMenuDelete` / `bubbleMenuDeleteHint`）。
const bubbleMenuTitle = '要拿这一条怎么办';
const bubbleMenuDelete = '删掉';
const bubbleMenuDeleteHint = '先放进回收站，过一阵子才真的删';
const bubbleMenuCancel = '算了';

// ── 长按菜单新加的两项：复制 / 多选（契约 `docs/dev/106-CHAT-SELECT.md`）──
//
// ⚠️ 和上面那几句**同一份表**（"气泡菜单那几句的住处"只有这一处）——
//    摆在界面里的字**禁用词硬闸够不着**（`test/unit/forbidden_words_test.dart` 扫这份表）。

/// 菜单里那两项。工具条上那个【复制】用**同一句**（同一件事同一句话）。
const bubbleMenuCopy = '复制';
const bubbleMenuSelect = '多选';

/// 多选态那条工具条：`已选 N 条` + 退出。
///
/// ⚠️ 数的是**选中的条数**（不是"能复制的条数"）；复制完那句才报**真复制了几条**。
String bubbleSelectCount(int n) => '已选 $n 条';
const bubbleSelectCancel = '取消';

/// 复制的结果（**成没成都如实说** —— N11）。
///
/// 🔴 空正文**不许**说这一句（把空串塞进剪贴板还告诉他"复制好了" = 屏幕说假话）。
const bubbleCopiedLine = '已经复制了';
String bubbleCopiedManyLine(int n) => '复制了 $n 条';
const bubbleCopyEmptyLine = '没有能复制的字';
const bubbleCopyFailedLine = '没复制成，再试一次';

// ── 删前那份清单（契约 §8.2 的 plan；§五 要求"删不掉"那句必须上屏）──

const planTitle = '要删掉这些吗';
const planCancel = '先不删';
const planConfirm = '删掉';

/// 有"删不掉"的那一条时要显眼地说一句 —— **不许美化成"已全部删除"**。
const planCannotLine = '有一条删不掉，下面写清了为什么';

/// 清单为空时（理论上有，但别让屏幕上出现一个空白框）。
const planEmptyLine = '没有列出要删的东西';

/// 在回收站里留多久 / 什么时候彻底删掉。
///
/// ⚠️ `ttlDays` / `purgeAt` **都从服务端来**，客户端不复制那两个数
///    （阈值只住在服务端与手册里）；读不出来就**只说"过一阵子"**。
String planTtlLine(int? ttlDays) => ttlDays == null || ttlDays <= 0
    ? '先放进回收站，过一阵子会彻底删掉。'
    : '先放进回收站，$ttlDays 天之后彻底删掉。';

String purgeAtLine(int? purgeAt) =>
    purgeAt == null ? '' : '彻底删掉的时间：${dateOf(purgeAt)}';

/// 一条清单项的归属（"哪一样（在哪儿）"）。读不出 `where` 就只说 `what`。
String planItemTitle(String what, String where) {
  final w = where.trim();
  if (what.trim().isEmpty) return w;
  return w.isEmpty ? what : '$what（$w）';
}

/// 服务端给的 `verdict` → 人话。
///
/// ⚠️ 只有**明说 `delete`** 的才显示"会删掉"；其余（含认不出的）显示"删不掉"
///    —— 与 `TrashPlanItem.cannot` 的 fail-closed 同一条规矩。
String verdictLabel(String verdict) => verdict == 'delete' ? '会删掉' : '删不掉';

// ── 回收站那一页 ────────────────────────────────────────────

const trashEmptyLine = '回收站是空的';
const trashNoPreviewLine = '（这一条没有能看的字）';
const trashLoadFailedLine = '没读到回收站，过一会儿再试';
const trashRetry = '再试一次';
const trashRestore = '恢复';
const trashPurge = '彻底删掉';

/// 彻底删要**二次确认**（契约 §8.2：破坏性动作不许手滑就触发）。
const trashPurgeConfirmTitle = '彻底删掉？';
const trashPurgeConfirmBody = '删掉之后就拿不回来了。';
const trashPurgeConfirmYes = '彻底删掉';
const trashPurgeConfirmNo = '算了';

// 做完之后如实说一句（**成没成都说**）。
const trashDeletedLine = '已经放进回收站了';
const trashRestoredLine = '已经拿回来了';
const trashPurgedLine = '已经彻底删掉了';
const trashDeleteFailedLine = '没删成，过一会儿再试';
const trashRestoreFailedLine = '没拿回来，过一会儿再试';
const trashPurgeFailedLine = '没删成，过一会儿再试';
const trashPlanFailedLine = '没拿到要删的清单，过一会儿再试';

/// 这一轮"删前清单"没拿到 / 删不掉，要是**登录过期**就得说那一句
/// （和 `chat_controller` 里同一句话：同一件事同一句，别再新造一个说法）。
const trashUnauthorizedLine = '登录过期了，重新登录一下';

/// 毫秒 → `YYYY-MM-DD`（本机时区）。
///
/// ⚠️ 手写而不是引 `intl`：这一条只要"哪一天"，
///    而多一个依赖就多一份要跟着升的东西。纯函数 ⇒ 进 `test/unit`。
String dateOf(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
  String two(int v) => v < 10 ? '0$v' : '$v';
  return '${d.year}-${two(d.month)}-${two(d.day)}';
}
