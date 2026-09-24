// 「我自己那台」那一层的**全部文案**（契约 `docs/dev/81-HARNESS-ENTRY.md` §5.2 / §5.4）。
//
// ⚠️ 单独一个文件、纯数据：这一层每一句都要过**禁用词硬闸**
//    （同 `math_words.dart` / `landing_words.dart` 那几份；清单在
//     `test/unit/forbidden_words_test.dart`）。
// ⚠️ 一个内部词都不许有：没有「工作区 / 口令 / 客户端 / 云端 / 服务器 / 会话 / 模型 /
//    工具 / 搜索 / 连接」，也不许出现工具名与英文 `web_search`。
//    ⇒ **这一层最难的一处是 `request/header`**（原事件里是工具清单）：契约只要求
//      "折起或摘要"，所以这里**只报件数，一个名字都不抄**（`harnessHeaderLine`）。
//
// ⚠️ 纯数据，不 import flutter（楼层闸 `test/unit/import_rules_test.dart`）。

/// 桌面上那个图标上的字，**也是**容器顶栏的标题 ——
/// 它没有第二个名字，所以只留这一个常量：两处同一个来源，不会漂。
///
/// 🔴 **这个词是主人定的、且过了禁词闸 —— 不许换成别的说法。**
const String harnessAppLabel = '我自己那台';

// ── 三种状态（契约 §5.2 的 `state`）────────────────────────────

/// `booting`：那一台正在被打开。**不许白屏** —— 这一句占着那块地方。
const String harnessOpening = '正在打开…';

/// `gone`：那一台停下来了（进程退出 / 这一头断了）。后面接原因，再接「重来」。
const String harnessGoneLine = '它这边停下了。';

/// 原因那一行的抬头（原因本身是**对面给的**，见 `harnessWhy`）。
const String harnessWhyPrefix = '它说：';

/// `gone` 之后那个按钮：**点了真的重连**（重连 = 重起它那一台）。
const String harnessRestart = '重来';

/// 这一头自己断的（网线、页面关了、对面把连接收了）—— 原因的兜底说法。
const String harnessDroppedWhy = '这一头没接上';

// ── 输入那一条 ───────────────────────────────────────────────

/// 打字框里的灰字。
const String harnessSayHint = '说一句';

/// 发出那个按钮的说明（它是图标按钮，这是读屏/长按看到的字）。
const String harnessSend = '送出去';

/// 跑着的时候那个「停」的入口（契约 §5.2：发 `{"t":"stop"}`）。
const String harnessStop = '停';

// ── 每一行的抬头 / 兜底 ───────────────────────────────────────

/// 用户自己那句话的抬头（`user/message` 回显时用）。
const String harnessYourPrefix = '你 › ';

/// 它吐出来的字的抬头（`assistant/message` 的 `text` 块）。
const String harnessItsPrefix = '它 › ';

/// 它的思考（`assistant/message` 的 `reasoning` 块）——**原样，但看得出来是"想"**。
const String harnessThinkPrefix = '（它心里）';

/// 它那边定的东西（`system/message`）—— 只加一个点，不替它说话。
const String harnessSystemPrefix = '· ';

/// 一条 JSON-RPC **回执**（不是 `session.event`）。不藏，但也不假装它是话。
const String harnessAnswered = '它应了一声';

/// 类型都认不出来那一条的抬头（后面照样跟着那一小段 JSON —— 判据 H8）。
const String harnessUnknownLine = '一条看不懂的消息';

/// 一条消息里**一个能显示的字都没有**（比如空的 `system/message`）。
/// ⚠️ 它后面**照样带着那一小段 JSON** —— "不隐藏"这条对已知类型也成立。
const String harnessNoTextLine = '这一条里没有字';

/// `interrupted: true`（这一条没说完就断了）。
const String harnessInterruptedLine = '这一条没说完';

/// 一条**结构行**（`turn/start`）。
String harnessTurnStartLine(int turn) => '── 第 $turn 轮 ──';

/// `step/start`：这一轮里的第几步。
String harnessStepStartLine(int turn, int step) => '   第 $turn 轮 · 第 $step 步';

/// `step/end`。
String harnessStepEndLine(int step) => '   第 $step 步走完了';

/// `turn/end`（原因由 [harnessReasonWords] 翻成人话）。
String harnessTurnEndLine(String why) => '── 这一轮完了：$why ──';

/// `turn/end` 的 `reason.kind` → 人话。
///
/// ⚠️ **认不出来就原样带出来**（不猜、也不藏）：认不得的种类总比一句假话好。
String harnessReasonWords(String? kind) {
  final k = (kind ?? '').trim();
  if (k.isEmpty) return '完了';
  return switch (k) {
    'completed' => '说完了',
    'canceled' => '被打断了',
    'max-tokens' => '说到头了',
    'interrupted' => '没说完就断了',
    _ => k,
  };
}

/// `request/header` 的摘要 —— 这一轮它手上能用的**有几样**。
///
/// 🔴 **只报件数，不抄名字**：原事件里那一串就是工具名（含 `web_search` 那一类），
///    抄上来就是内部词上屏。契约对这一档只要求"折起/摘要"。
String harnessHeaderLine(int count) =>
    count <= 0 ? '它这一轮手上没有别的东西' : '它这一轮手上能用的：$count 样';

/// `request/context`（对面给的是一份路由/容量的元数据）。
const String harnessContextLine = '它把这一轮要用的底子看了一遍';

/// `session/title`（那一段的名字）。
String harnessTitleLine(String title) {
  final t = title.trim();
  return t.isEmpty ? '它给这一段起了个名字' : '它给这一段起了个名字：$t';
}

/// `permission/preset`。
const String harnessPermissionLine = '它先过了一遍手边的规矩';

/// `sandbox/mode`（在哪儿动手）。
const String harnessSandboxLine = '它先定了一下在哪儿动手';

/// `approval/policy`（要不要先问一声）。
const String harnessApprovalLine = '它先定了一下要不要先问一声';

/// `agent/inbox/spliced`（把排着的事接进来）。
String harnessSplicedLine(int count) =>
    count <= 0 ? '它把手上的事接了起来' : '它把手上的事接了起来（$count 条）';

/// `session.status`（`running` / `idle`）。
String harnessRunStatusLine(bool running) => running ? '它动手了' : '它停下了';
