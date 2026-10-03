// 「导出」页（契约 `docs/dev/30-EXPORT.md` §四 ·
// 重做契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.2）。
//
// 这一屏按轻重做四件事：
//   ① **如实体面**：服务端给的那段 `text` **原样**在（拿不到 `items` 时整段退回）；
//   ② ★ **能读**：服务端顺手带回来的 `items` ⇒ **按天分组**、每条前面一行
//      `我` / `它` 的标签（颜色区分），正文走正文那一档字；
//   ③ ★ **一键带走**：抬头右边一颗**常驻**的「复制全部」——
//      复制的**永远是服务端拼好的那段 `text`**，**不拿 `items` 重拼**（§五）；
//   ④ 读不到 / 空对话时**说那句实话**，不给一个空白框（§四）。
//
// ⚠️ **不做文件下载**（§一：手册要的是"能粘走"，不是"能存成文件"）；
//    也**不在这一侧拼那段文字** —— 回收站里删过谁只有服务端知道（§三），
//    两处各算一遍 = 一定会漂（§六）。
// ⚠️ 文案在 `models/export_words.dart`（那样才进得了禁用词硬闸）。
// ⚠️ 不写死尺寸：字长多大容器跟到多大；整页是列表，能滚（D3.5 那道硬闸）。
//    字号/圆角/间距只从 `models/dsh_design.dart` 与 `models/design.dart` 取。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/design.dart' as d;
import '../models/dsh_design.dart';
import '../models/export.dart';
import '../models/export_words.dart';
// ⚠️ "重试"与"登录过期了"两句**和回收站同一个说法**（同一件事同一句话，
//    别再新造一个）——所以从那一份文案里取，不在这儿再抄一遍。
import '../models/trash_words.dart' show trashRetry, trashUnauthorizedLine;
import '../services/api.dart';
import '../services/chat_controller.dart';
import '../widgets/dsh_look.dart';

class ExportScreen extends StatefulWidget {
  const ExportScreen({super.key, required this.controller, this.copy, required this.onLoggedOut});

  final ChatController controller;

  /// 令牌不行了（401）时叫它：上层会把主界面换成登录页（欠账 **#25**）。
  /// ⚠️ 和回收站那一页同一个理由：只说话不回去 = 停在一个读不出来的页面上。
  final VoidCallback onLoggedOut;

  /// 复制那一下。默认走**真剪贴板**；测试可以注入一个假的
  /// （widget 测试里没必要去敲平台通道）。
  final Future<void> Function(String text)? copy;

  @override
  State<ExportScreen> createState() => _ExportScreenState();
}

class _ExportScreenState extends State<ExportScreen> {
  /// 拿到的那一份。`null` = 还在读。
  ExportDoc? _doc;
  TrashAnswer<ExportDoc>? _failed;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _doc = null;
      _failed = null;
    });
    final a = await widget.controller.loadExport();
    if (!mounted) return;
    if (a is TrashUnauthorized) {
      // ★ 401：**说一句 + 退回登录页**（欠账 #25，与回收站同一套）。
      _say(trashUnauthorizedLine);
      Navigator.of(context).popUntil((r) => r.isFirst);
      widget.onLoggedOut();
      return;
    }
    setState(() {
      switch (a) {
        case TrashOk(:final value):
          _doc = value;
        case TrashUnauthorized():
          break; // 上面已经处理并返回（switch 要穷尽）
        case TrashFailed():
          _failed = a;
      }
    });
  }

  /// 说一句结果（成没成都说 —— N11：拒绝必须给人话）。
  void _say(String line) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(line)));
  }

  Future<void> _copy() async {
    final doc = _doc;
    if (doc == null) return;
    try {
      // 🔴 复制的是**服务端那段原文**（`doc.text`）——**不是**拿 `items` 重拼的一段。
      await (widget.copy ?? _toClipboard)(doc.text);
      _say(exportCopiedLine);
    } catch (_) {
      // ⚠️ 复制失败**也要说**，而且给一条能自己动手的路 ——
      //    沉默的话用户会以为已经复制了，粘出去却发现是空的。
      _say(exportCopyFailedLine);
    }
  }

  static Future<void> _toClipboard(String text) =>
      Clipboard.setData(ClipboardData(text: text));

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final look = DshLook.of(context);
    return Scaffold(
      // 这一屏的底跟着色板走（亮色就是白，与聊天面同一套底）。
      backgroundColor: look.palette.bgBase,
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            // 内容列限宽，同主界面（平板上一行七十个字没人读）
            constraints: const BoxConstraints(maxWidth: 760),
            child: Column(
              children: [
                _header(look),
                Expanded(child: _body(theme, look)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 抬头：返回（≥44）＋ 标题（20/w600）＋ 右边一颗常驻的「复制全部」（≥44）。
  ///
  /// ⚠️ 复制按钮**只在有东西可拿时才画**：空对话时画一个按了没东西的按钮
  ///    比不画更坏（契约 `30-EXPORT.md` §九·4）。
  Widget _header(DshLook look) {
    final p = look.palette;
    final canCopy = _doc?.hasText ?? false;
    return Padding(
      padding: const EdgeInsets.only(
        left: DshSpace.s8,
        right: DshSpace.s8,
        top: DshSpace.s8,
      ),
      child: Row(
        children: [
          // ⚠️ **标准的 `BackButton`，不是裸 `IconButton(arrow_back)`**：
          //    判据里 `tester.pageBack()` 只认它（`find.byTooltip('Back')`）——
          //    `test/widget/touch_regression_test.dart` 的"宽屏 800"那条要从这一页退回来。
          //    命中区（≥44）由它自己那颗 `IconButton` 撑（D3.6），不用我们另给。
          BackButton(color: p.labelPrimary),
          Expanded(
            child: Text(
              exportTitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: dshTextStyle(DshTypes.title, p.labelPrimary),
            ),
          ),
          if (canCopy)
            TextButton.icon(
              onPressed: _copy,
              style: TextButton.styleFrom(
                minimumSize: const Size(44, 44),
                foregroundColor: p.labelPrimary,
              ),
              icon: const Icon(Icons.copy_all_outlined),
              label: const Text(exportCopyAll),
            ),
        ],
      ),
    );
  }

  Widget _body(ThemeData theme, DshLook look) {
    final failed = _failed;
    if (failed != null) {
      // ⚠️ "令牌不行"和"网不好"是两件事（对用户说的话不一样，能做的事也不一样）。
      final line = failed is TrashUnauthorized ? trashUnauthorizedLine : exportLoadFailedLine;
      return ListView(
        padding: const EdgeInsets.symmetric(horizontal: DshSpace.s20, vertical: DshSpace.s16),
        children: [
          Text(line, style: theme.textTheme.bodyMedium),
          const SizedBox(height: d.gapS),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _load,
              style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              child: const Text(trashRetry),
            ),
          ),
        ],
      );
    }

    final doc = _doc;
    if (doc == null) return const Center(child: CircularProgressIndicator());

    // ⚠️ 空对话：**只说那句实话 ＋ 一句"能干什么"**，不给框、不给复制按钮（§四）。
    if (!doc.hasText) {
      return ListView(
        padding: const EdgeInsets.symmetric(horizontal: DshSpace.s20, vertical: DshSpace.s16),
        children: [
          Text(exportEmptyLine, style: theme.textTheme.bodyMedium),
          const SizedBox(height: d.gapS),
          Text(exportEmptyHint, style: theme.textTheme.bodySmall),
        ],
      );
    }

    // ★ 拿得到 `items` ⇒ 按天分组能读的一页；拿不到（老服务端）⇒ 退回原来那段文字块。
    if (doc.items.isEmpty) return _textBlock(theme, doc);
    return _grouped(look, doc.items);
  }

  /// **退回原来那段文字块**（§2.2：拿不到 `items` 的老服务端，一个像素都不少）。
  ///
  /// ⚠️ 这一档原来长什么样，现在还是什么样（可全选的成品原文）；
  ///    变的只有"复制"那一下就够 —— 它现在住在抬头（那颗常驻的「复制全部」）。
  Widget _textBlock(ThemeData theme, ExportDoc doc) {
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: DshSpace.s20, vertical: DshSpace.s16),
      children: [
        Text(exportHintLine, style: theme.textTheme.bodySmall),
        const SizedBox(height: d.gapS),
        // ⚠️ 那一圈边是**字外面的框**（不夹住字）：字放大它跟着长（D3.5）。
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(DshSpace.s12),
          decoration: BoxDecoration(
            border: Border.all(color: d.line),
            borderRadius: BorderRadius.circular(d.radiusField),
          ),
          // 可全选：`SelectableText` 既能长按选，也能整段复制。
          child: SelectableText(doc.text, style: theme.textTheme.bodyLarge),
        ),
      ],
    );
  }

  /// **按天分组的那一页**（§2.2）：每天一个小标题，每条前面一行 `我` / `它`。
  Widget _grouped(DshLook look, List<ExportItem> items) {
    final rows = _dayRows(items);
    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: DshSpace.s20, vertical: DshSpace.s16),
      itemCount: rows.length,
      itemBuilder: (context, i) => _row(look, rows[i]),
    );
  }

  Widget _row(DshLook look, ({String? day, ExportItem item}) row) {
    final p = look.palette;
    final me = row.item.isMe;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (row.day != null)
          Padding(
            padding: const EdgeInsets.only(top: DshSpace.s12, bottom: DshSpace.s8),
            child: Text(
              row.day!,
              style: dshTextStyle(DshTypes.xsStrong, p.labelTertiary),
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(bottom: DshSpace.s4),
          child: Text(
            me ? exportWhoMe : exportWhoIt,
            // ★ 颜色区分两个人（§2.2）：我说的话用业务蓝（与聊天气泡同一支），
            //   它说的话用次要灰。⚠️ 不只靠颜色：标签上的**字**本身也不同（我 / 它）。
            style: dshTextStyle(DshTypes.xsStrong, me ? p.stateBusiness : p.labelSecondary),
          ),
        ),
        // 正文那一档（DSH 的 markdown 正文：`14+Δ` / `24+Δ`）——能选、能长按复制。
        SelectableText(
          row.item.text,
          style: dshTextStyle(look.scale.content, p.labelPrimary),
        ),
        const SizedBox(height: DshSpace.s16),
      ],
    );
  }

  /// 把条目折成"带小标题的行"：跨天的那一条带上 `day`，其余 `day` 是 `null`。
  ///
  /// ⚠️ `at` 只用来**显示哪一天**（§五：不许拿它排序 —— 顺序照旧是服务端给的）。
  /// ⚠️ `at` 为 `null` 的条目不带小标题（服务端没给时刻，就不编一个）。
  List<({String? day, ExportItem item})> _dayRows(List<ExportItem> items) {
    final out = <({String? day, ExportItem item})>[];
    String? last;
    for (final it in items) {
      final at = it.at;
      final day = at == null ? null : exportDayLabel(at);
      final fresh = day != null && day != last;
      if (fresh) last = day;
      out.add((day: fresh ? day : null, item: it));
    }
    return out;
  }
}
