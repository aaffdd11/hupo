// **"这一窗里动过哪些文件"** —— 纯逻辑那一半（契约 `docs/dev/120-FILE-PANEL.md`）。
//
// ── 为什么是这一样东西 ────────────────────────────────────────
// 主人 2026-09-26：*"首先全部开放，聊天窗口的设计也要重做。"*
// 这一批给聊天窗口加上 DSH 那条**右侧信息栏**（研究 `115` §一.3 ＋ `115-raw/A-layout.md` §3）。
// 右栏到底装什么，有一条硬约束：**不用新服务端接口**（`v2/services/` 这一批一个字节都不动）
// ⇒ 只能拿**我们已经收到的东西**去填。
//
// 而手上那批工具行里**已经**带着"这一次调用动了哪个文件"这个事实：
// `tool/call` 的 `args` 是**原样入参**（`{"path":"…"}` / `{"file_path":"…"}`），
// 服务端逐字发上来（`v2/services/core/src/tool-rows.js`）。
// ⇒ 右栏装的就是它：**这一窗按轮分组、动过哪些文件**。
//
// ── 🔴 四条不许破 ────────────────────────────────────────────
//   ① **绝不猜路径**：路径只从入参那串 **JSON** 里取（`path` / `file_path`）；
//      JSON 坏了、字段没有、字段不是非空串 ⇒ **那一条什么也不贡献**（不是"未知文件"，
//      是**我们不知道** —— N10：沉默优于编造）；
//   ② **fail-closed**：这一份里任何一处坏输入都只许变成"少一行"，**永远不抛**；
//   ③ **纯逻辑**：不 import `material`、不碰 I/O、不碰时钟 ⇒ 它才进得了 `test/unit`
//      （楼层闸 `test/unit/import_rules_test.dart`）；
//   ④ **`models/` 里不写给人看的字**：这一份一个中文文案都没有（`file_panel_words.dart`）。
//
// ── 🔴 我们**没有**收到、所以这一份里**不存在**的东西 ──────────────
//   · **读过的文件**：`read` / `grep` / `glob` 的入参里也有 `file_path` / `path`，
//     但"看过"不是"改过"。右栏说的是**改过哪些** ⇒ 只认 `path` / `file_path`
//     这两个字段（`grep`/`glob` 用的是 `pattern`，天然进不来），配上一个**显式**
//     的改动类工具名名单（见 [dshFileWritingTools]）。⚠️ **不按工具名猜**：
//     `bash` 里跑一句 `echo x > f` 我们**看不到**那个文件名（入参里只有命令字符串），
//     ⇒ 那种改动**这一栏不会出现**，也**不许**编一条出来；
//   · **每次改动的增删行数**：DSH 那张 diff 卡要 `write` / `edit` 的完整入参
//     （`115-raw/B-render.md` §2.1 的 `diffCardModel`），我们**没存** `old_string`/
//     `new_string` 那一对，也没有任何"改了多少"的权威数字 ⇒ 这里**一个数都没有**；
//   · **文件的现在长什么样**：那要读盘（DSH 的 文件 / 文档预览两个 tab）——
//     这一批**没有服务端接口**，客户端更不许碰文件系统（派活单点名：只读、不碰 FS）；
//   · **工作目录 / 绝对根**：`path` 是模型给的原样字符串（可能是相对路径），
//     我们**不拼接、不规范化、不猜测它相对于哪**（拼一次就是编一个路径）。
//
// ⚠️ 这一份的产物只服务**右栏那一个面板**：它不进时间线、不落盘、不影响聊天那一屏。

import 'dart:convert';

import 'tool_row.dart';

/// 一条"某次调用动了某个文件"。
///
/// ⚠️ [path] **就是**入参里那个字符串（没有做任何加工）——界面上那一行要能和他
///    在别处看到的**逐字对上**，所以这里不许 trim 之外的任何处理。
class FileChange {
  const FileChange({
    required this.turn,
    required this.step,
    required this.path,
    required this.tools,
    required this.row,
  });

  /// 哪一轮（[ToolRow.turn]，服务端给的）。
  final int turn;

  /// 第一次动它时那一步（[ToolRow.step]）——同一轮里同一个文件只留第一次那个值
  /// （见 [FileChanges.of] 的去重规矩）。
  final int step;

  /// 文件路径（入参 JSON 里那一个字段的**原样**值，只去过首尾空白）。
  final String path;

  /// 这一轮里**动过它的那些调用**的名字（按第一次见到的顺序，去重）。
  ///
  /// ⚠️ 它可能不止一个：同一轮里 `write` 完再 `edit` 是常事 ——
  ///    只画"最后一次"会把"改过两次"说成"改过一次"。
  /// ⚠️ 名字**可能只有一个空串**：那一次调用的 `name` 本站就不知道
  ///    （`ToolRow.parseResultOnly` 那一档）⇒ 界面**不画名字**，绝不留个占位名。
  final List<String> tools;

  /// 第一次动它的**那一次调用本身**（展开就看它的入参）。
  ///
  /// ⚠️ 存整个 [ToolRow] 而不是自己留一份副本：入参 / `bytes` / `truncated`
  ///    只有一个真相（`tool_row.dart`），这里再存一份就是第二个会漂的数。
  final ToolRow row;

  /// 动它的那些调用里有没有**正在跑**的（还没有结果）。
  bool get running => switch (row.status) {
        ToolStatus.running => true,
        ToolStatus.ok || ToolStatus.error || ToolStatus.interrupted => false,
      };
}

/// **一轮**里改过的文件。
class TurnFileChanges {
  const TurnFileChanges({required this.turn, required this.files});

  final int turn;

  /// 这一轮改过的文件（**第一次见到的顺序**，同一个路径只出现一次）。
  final List<FileChange> files;

  int get fileCount => files.length;
}

/// 整窗的结果：按轮分组 ＋ 几条数得出来的合计。
///
/// ⚠️ [turns] 是**第一次见到的顺序**（不是"按轮号排"）：轮号是服务端的，
///    而这一栏要的是"**哪几轮**动过东西"这个事实。界面要"最新的在上"时
///    自己倒着遍历（见 `widgets/file_panel.dart`）——**不在这里重排**，
///    免得"数据的顺序"与"屏幕上的顺序"变成两处会漂的东西。
class FileChanges {
  const FileChanges({required this.turns, required this.toolRows});

  /// 一轮都没有 ⇒ 面板只画**一句实话**（不编行）。
  static const FileChanges empty = FileChanges(turns: [], toolRows: 0);

  final List<TurnFileChanges> turns;

  /// 我们看过的工具行总数（**不是**文件数）——留给判据用，界面上不画它。
  final int toolRows;

  /// 动过文件的轮数。
  int get totalTurns => turns.length;

  /// 整窗动过的文件数（**逐轮相加**）。
  ///
  /// 🔴 口径写清：**同一轮里**同一个路径只算一次；**跨轮**同一个文件会**各算一次**
  ///    —— 因为"这一轮动过它"是**每一轮各自的事实**（第 2 轮又改了一遍，
  ///    第 1 轮那一行不该因此消失）。⇒ 这个数是"**改动次数**"，
  ///    不是"不同的文件个数"（后者我们**数不出来**：那要跨轮去重，
  ///    而屏幕上每一轮都要能各说各的）。
  int get totalFiles {
    var n = 0;
    for (final t in turns) {
      n += t.files.length;
    }
    return n;
  }

  bool get isEmpty => turns.isEmpty;

  /// 摊平（测试与"整窗"那几句用）。
  Iterable<FileChange> get allChanges =>
      turns.expand((t) => t.files);

  /// 从一批工具行里**抽**出"动过哪些文件"。
  ///
  /// @param rows 这一窗的工具行（`ChatController.items` 里那些 `TimelineToolCall`）
  ///
  /// 规矩（每一条都有判据）：
  ///   · 一行**一个文件也没有**就什么也不贡献（`null` / 坏 JSON / 空路径 / 数组 /
  ///     数字 …… 全部走这一条）；
  ///   · 一行只算**一个**路径（`path` 优先于 `file_path`，见 [pathFromArgs]）；
  ///   · **同一轮**里同一个路径只留一条：`step` 是**第一次**那一步，
  ///     `tools` 把后面那些名字并进去；
  ///   · **跨轮不合并**（每一轮各算各的）；
  ///   · 轮与文件的顺序都是**第一次见到的顺序**；
  ///   · 坏输入**绝不抛**。
  static FileChanges of(Iterable<ToolRow> rows) {
    final order = <int>[];
    final byTurn = <int, List<FileChange>>{};
    var seen = 0;
    for (final row in rows) {
      seen += 1;
      if (!isFileBearingTool(row.name)) continue;
      final path = pathFromArgs(row.args);
      if (path == null) continue;

      final files = byTurn.putIfAbsent(row.turn, () {
        order.add(row.turn);
        return <FileChange>[];
      });
      // 同一轮里同一个路径 ⇒ 并名字（**不新起一行**）
      FileChange? same;
      for (final f in files) {
        if (f.path == path) {
          same = f;
          break;
        }
      }
      if (same == null) {
        files.add(
          FileChange(
            turn: row.turn,
            step: row.step,
            path: path,
            tools: [row.name],
            row: row,
          ),
        );
      } else if (!same.tools.contains(row.name)) {
        same.tools.add(row.name);
      }
    }
    return FileChanges(
      turns: [
        for (final t in order) TurnFileChanges(turn: t, files: byTurn[t]!),
      ],
      toolRows: seen,
    );
  }
}

/// **入参里那个路径**（抽不出来 ⇒ `null`，绝不猜）。
///
/// * `args` **必须是**一个 JSON 对象（`{…}`）——原样那串是服务端裁过的
///   （`MAX_ARGS_CHARS`），裁过的 JSON **解不出来** ⇒ 那一行不贡献（对，就是丢了一行；
///   留一行"未知文件"比丢一行更坏：那是拿猜的东西上屏）；
/// * 数组 / 数字 / 字符串 / `null` ⇒ `null`（`[]` 会被 `JSON.parse` 解出来，
///   但它不是"一张参数表" —— 服务端那边同样把它挡掉了）；
/// * 只认 `path`，再认 `file_path`（**第一个非空串**；前面那个在、但是空串 ⇒
///   继续看后面的 —— DSH 自己那两个字段就是这两个名字，见 `115-raw/B-render.md` §2.1）；
/// * 值只去首尾空白；**不拼、不规范化、不猜后缀**。
String? pathFromArgs(String? args) {
  if (args == null) return null;
  final trimmed = args.trim();
  if (trimmed.isEmpty) return null;
  Object? decoded;
  try {
    decoded = jsonDecode(trimmed);
  } catch (_) {
    // 坏 JSON / 半截 JSON（服务端截断过）⇒ 这一行不贡献。**绝不抛**。
    return null;
  }
  if (decoded is! Map) return null;
  for (final key in dshFileArgKeys) {
    final v = decoded[key];
    if (v is String) {
      final s = v.trim();
      if (s.isNotEmpty) return s;
    }
  }
  return null;
}

/// 入参里装路径的那几个字段名（**顺序 = 优先级**）。
///
/// ⚠️ 名单是**短的、显式的**，故意不写成"任何带 `path` 字样的键都算"：
///    那会把 `paths` / `filePaths` / 别的工具的 `path_pattern` 悄悄放进来。
/// ⚠️ 只有这两个：`115-raw/B-render.md` §2.1 里 `write` / `edit` / `read`
///    用的就是 `file_path`，`write` / `edit` 也会给 `path`。
const List<String> dshFileArgKeys = ['path', 'file_path'];

/// **改动类**工具的名字（**显式名单**，顺序只为可读）。
///
/// ⚠️ 它**不是**"能不能上屏"的判据（那是聊天窗口那一层的规矩）——
///    它只回答一件事：**这个工具算不算"动过文件"**。
/// ⚠️ 名单里这四件是 DSH 自己那几件落盘工具（`115-raw/B-render.md` §2.1
///    的 `write` / `edit` / `str_replace_editor` / 那批 diff 卡）。
/// ⚠️ **不写通配**（`*_write` / `*edit*` 那种）：通配会把将来某个只读的
///    `preview_edit` 之类悄悄算成"改过"，而这一栏一旦多一条就是**在说假话**。
const Set<String> dshFileWritingTools = {
  'write',
  'edit',
  'str_replace_editor',
  'apply_patch',
};

/// 这一行**算不算"可能动过文件"**。
///
/// 两条都要满足：
///   ① 名字在 [dshFileWritingTools] 里（**显式**那四件）；
///   ② 入参里真有一个能认出来的路径（[pathFromArgs]）。
///
/// ⇒ 于是"名字对但入参里没有路径"（例：`write` 的入参被截断了）**不贡献**，
///    `read` / `grep` / `glob` 也**不贡献**（它们不是改动类，见文件头那段）。
bool isFileBearingTool(String name) => dshFileWritingTools.contains(name);
