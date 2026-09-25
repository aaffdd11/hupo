// 「桌面图标 ⇒ 从桌面上删掉」的**全部文案**（契约 `docs/dev/103-APP-DELETE.md` §三）。
//
// ⚠️ 为什么单放一个 models 文件、不写在界面里：摆在 `widgets/` 里的字符串
//    **禁用词硬闸够不着**（`test/unit/forbidden_words_test.dart` 扫的是这份表）
//    —— 和 `trash_words.dart` / `about_facts.dart` 同一条理由。
//
// 🔴 这一批最要紧的是**诚实边界**（契约 §三，判据 C3/C4）：
//   · **不许说"还能拿回来 / 可恢复"**：服务端那条路确实是软删（挪进 `.removed/`），
//     但**今天没有任何一处能把它列出来、也没有拿回来的入口**
//     ⇒ 界面上写"可恢复"就是**假话**（要写就得先把入口做出来，那是下一批）。
//   · **不许出现内部词**：`app` / 小程序 / 工作区 / 卸载 / 图标 id 这类工程词
//     **一个都不许上屏** —— 用户看到的只是"桌面上这一格"。
//   · **不说"对话与工作区照旧还在"**：`remove()` 只动制品库那一格，这句话本身是真的，
//     但**界面这一版不给对应的入口** ⇒ 说了就是承诺一条走不到的路（契约 §三）。
//
// ⚠️ 纯数据，**不许 import flutter/material**（楼层闸 `test/unit/import_rules_test.dart`）。

/// 面板上那个动作（契约 `103 §三` 点名的"主句"）。
///
/// ⚠️ 逐字就是**从桌面上删掉**：`test/unit/desktop_remove_test.dart` 把这一句钉死了
///    —— 换个说法（"卸载"之类）当场红。
/// ⚠️ 主人 2026-09-25 说那句 *"删除**小程序**"* **不能照字面写**：「小程序」是上屏禁用词
///    （`06` 禁令 4，硬闸一直扫这一份表）⇒ 菜单上还是这一句。
const String desktopRemoveAction = '从桌面上删掉';

// ── 同一个面板里另外两项（契约 `docs/dev/104-APP-MENU.md` §一）──────────────
//
// 主人 2026-09-25：*"一个选项，跟右键点击效果类似，但是只有重命名，复制小程序，
// 删除小程序。这三个选项。"* ⇒ 面板上三项 + 取消；**只挂"我自己做的那几个"**
// （内置那三个不是制品 ⇒ 不给它们挂菜单）。

/// 第一项：改个名字（= 主人说的"重命名"；不用"重命名"三个字，说人话）。
const String desktopRenameAction = '改个名字';

/// 第二项：复制一个（= 主人说的"复制小程序"）。
const String desktopCopyAction = '复制一个';

/// ── 改名那一层（一个小输入框 ＋ 两个按钮）────────────────────────────────

/// 那一层的标题。
const String desktopRenameTitle = '给它改个名字';

/// 输入框里那句提示（`hintText`）。
const String desktopRenameHint = '叫什么';

/// 那一层的两个按钮。
const String desktopRenameOk = '改好了';
const String desktopRenameNo = '算了';

/// 名字是空的 ⇒ **本地就拦住**（不许发一个注定被拒的请求，也别让服务端去说这句话）。
const String desktopRenameEmpty = '名字不能空着';

/// 改成了 / 没改成（**成没成都如实说一句**，同这一份表里那几条的规矩）。
const String desktopRenameDone = '名字改好了';
const String desktopRenameFailed = '没改成，过一会儿再试';

/// ── 复制那一条 ────────────────────────────────────────────────────────

/// 复制成了（桌面上会**自己长出**新那一格 —— 清单是重新拉过的）。
const String desktopCopyDone = '复制好了，桌面上多了一个';

/// 没复制成（服务端 4xx/5xx / 网不通 / 回执读不出来）。
const String desktopCopyFailed = '没复制成，过一会儿再试';

/// 面板上那个取消（契约 `103 §三` 点名的第二句）。
const String desktopRemoveCancel = '取消';

// ── 做完之后如实说一句（**成没成都说** —— 同 `trash_words.dart` 那几条的规矩）──

/// 成了：桌面上那一格真的没了（清单是**重新拉过**的，不是本地抹的）。
const String desktopRemoveDone = '已经从桌面上删掉了';

/// 没成（服务端 4xx/5xx / 网不通 / 回执读不出来）。
///
/// 🔴 **只在这一种情况下说它**，而且这时候图标**一个像素都不许动**：
///    "界面上先删了、服务端其实没删"是这一批最不许出现的形状（契约 C6 的反例）。
const String desktopRemoveFailed = '没删掉，过一会儿再试';

// ── 🔴 第二次确认（契约 `docs/dev/103-APP-DELETE.md` §七.4 · 决策 D3.11）──────
//
// 主人 2026-09-25：*"点击删除，也会提醒用户，回收相应的工作区、经验、数据。
// 需要用户二次确认。"* ⇒ 第一下**只出这一层**（一个请求都不发），
// 把"会一起拿走哪几样"**逐条摆出来** ＋ 明说**拿不回来**；再点一下才真的删。
//
// ⚠️ **上屏的措辞一个字都不许用内部词**（主人说的"工作区/经验/数据"要翻成人话）：
//    · 工作区 ⇒ **它自己那一间**（`roomEmptyLine` 里"这一间"就是同一个说法）
//    · 经验（对话记录）⇒ **你在这儿说过的话**
//    · 数据 ⇒ **它在这儿存下来的东西**
//    `test/unit/forbidden_words_test.dart` 那条硬闸扫这一份表（工作区/数据/app/小程序/卸载/id 一个都不许有）。
// ⚠️ **"拿不回来"现在是真的**（第二轮起服务端真把那四样拿走）—— 反过来，
//    **不许**写"还能拿回来/可恢复"（B29：今天没有任何入口能把它列出来）。

/// 第二层那个标题。
const String desktopRemoveConfirmTitle = '连它那一间一起删掉？';

/// 正文的头一句（底下**逐条**列那三样）。
const String desktopRemoveConfirmLead = '这一下会一起拿走：';

/// 会一起拿走的那几样（**逐条**，一条一句 —— 不许糊成一句话）。
const List<String> desktopRemoveConfirmItems = [
  '它自己那一间',
  '你在这儿说过的话',
  '它在这儿存下来的东西',
];

/// 正文的收尾（这一句是**这一批最要紧的诚实边界**）。
const String desktopRemoveConfirmTail = '拿不回来。';

/// 第二层的两个按钮（都 ≥44 —— `accessibility_test.dart` 那条硬闸）。
const String desktopRemoveConfirmYes = '确实删掉';
const String desktopRemoveConfirmNo = '算了';
