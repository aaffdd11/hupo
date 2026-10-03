// **右栏那个文件面板的全部文字**（契约 `docs/dev/120-FILE-PANEL.md`）。
//
// 和 `tool_row_words.dart` 同一条纪律：
// **文案集中一处**（不在 widget 里写死），于是它改得动、也数得清 ——
// 并且能进 `test/unit/forbidden_words_test.dart` 那份扫描。
//
// ⚠️ `models/` 是纯逻辑层（楼层闸）⇒ 这一份**不 import material**：
//    它只说"屏幕上那句是什么字"，怎么画是 `widgets/file_panel.dart` 的事。
//
// ── 🔴 与禁用词表的关系（与 `tool_row_words.dart` 同一处境）──────
// [filePanelToolLine] 里那个「工具」**就是** `models/forbidden_words.dart` 表里的词。
// 主人 2026-09-26 已在**聊天窗口内**放开（`D1.1·补`），而词表这一批**不许改**
// ⇒ 这一个常量**故意没有进** `forbidden_words_test.dart` 的"必须干净"清单
//   （与 `toolStatusWord` 一样）。其余几句都进了。

/// 面板抬头（DSH 那条右栏顶上那一行的位置）。
///
/// ⚠️ 措辞刻意避开 `会话`（禁用词）：说出来是"这一窗"，也就是他眼前这条聊天。
const String filePanelTitle = '这一窗动过哪些文件';

/// 打开它的那颗按钮的无障碍名 / 悬停提示（DSH 是 `aria-label="打开右侧边栏"`）。
const String filePanelOpenLabel = '打开右侧边栏';

/// 关上它的那颗按钮（面板抬头右端那一个）。
const String filePanelCloseLabel = '收起这一栏';

/// 抬头底下那一行**口径**：说清"最新在上"与"这是这一窗"两件事。
const String filePanelOrderLine = '最近改的在上，只算这一窗已经摊开的这些轮';

/// 有内容的合计那一行（DSH 那种"N 项"）。
///
/// @param turns 动过文件的轮数
/// @param files 改动次数（**逐轮相加**，见 `FileChanges.totalFiles` 那段口径）
String filePanelCountLine(int turns, int files) => '$turns 轮 · $files 处';

/// **一轮那一组的份数**（分组头右边那一格）。
///
/// ⚠️ 它**只数这一轮里几个文件**（不是"几轮几处"——那一轮只有一轮）。
String filePanelTurnFiles(int files) => '$files 个文件';

/// **一句实话**（一窗里一条文件行都没有时**只有它**，不编任何行）。
const String filePanelEmptyLine = '这一窗里还没有改过文件。';

/// 一轮的分组头（例：`第 3 轮`）。
String filePanelTurnHead(int turn) => '第 $turn 轮';

/// 一行里"是哪件事碰的"。
///
/// ★ **2026-10-02 改了口径**（契约 `154` §2.1）：这一格原来把**内部名原样**摆出来
///    （`edit` / `write` / `mcp__apps__app_create`）—— 那是 `116` 那批"全部开放"留下的形状。
///    主人这一批让我重做界面，而"界面上出现内部词 = 缺陷"是手册那条没被撤掉的规矩
///    ⇒ 现在传进来的是**人话**（`toolHumanName` 翻好的），这里只负责拼起来。
/// ⚠️ `tools` 可能是空的（一次都没认出来 / 名字本站就不知道）⇒ 这一句**不画**
///    （由调用方判空），绝不留个占位名。
String filePanelToolLine(List<String> tools) => '被这些工具碰过：${tools.join(' · ')}';

/// 认不出的工具在那一行里怎么说。
///
/// 🔴 **不许**在这里把内部名补回去（那就是"内部词上屏"）；也**不许**装作没有它
///    （那一行说的就是"这一窗动过哪些文件"，少一件就是少说一件）。
/// ⇒ 就照实说"认不出"，一个字都不编。
const String filePanelUnknownTool = '一件我说不上来的事';

/// 展开那一块里"这是它的入参"的抬头。
const String filePanelArgsHead = '那一次的入参原文';

/// 🔴 **截断那句实话**（服务端在 `tool/call` 上报了 `truncated` 才说）。
///
/// 用词与 `toolTruncatedLine` 同一套（"已截断，共 N 字节"），
/// 因为那本来就是**同一件事**：服务端把入参裁到上限并如实报了原始字节数。
/// ⚠️ 只报服务端给的数，**不自己数一遍**（我们手上这串已经是裁过的）。
String filePanelArgsTruncatedLine(int bytes) => '… 已截断，共 $bytes 字节';

/// 点一行那一格的无障碍名/悬停提示（收起态）。
const String filePanelRowExpandLabel = '看那次调用的入参';

/// 同上（展开态）。
const String filePanelRowCollapseLabel = '收起这一段';
