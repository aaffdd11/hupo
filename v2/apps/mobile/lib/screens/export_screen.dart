// 「导出」页（契约 `docs/dev/30-EXPORT.md` §四）。
//
// 这一屏只有四件事，按轻重排：
//   ① **如实体面**：拿到的那段文字**原样**显示（它就是服务端拼好的成品）；
//   ② **能全选**：那是一个 `SelectableText` 的框（用户也可以长按自己选）；
//   ③ **一键复制**：命中区 ≥44（D3.6）；
//   ④ 读不到 / 空对话时**说那句实话**，不给一个空白框（§四）。
//
// ⚠️ **不做文件下载**（§一：手册要的是"能粘走"，不是"能存成文件"）；
//    也**不在这一侧拼那段文字** —— 回收站里删过谁只有服务端知道（§三）。
// ⚠️ 文案在 `models/export_words.dart`（那样才进得了禁用词硬闸）。
// ⚠️ 不写死尺寸：字长多大容器跟到多大；整页是列表，能滚（D3.5 那道硬闸）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import 'package:flutter/services.dart';

import '../models/export.dart';
import '../models/export_words.dart';
// ⚠️ "重试"与"登录过期了"两句**和回收站同一个说法**（同一件事同一句话，
//    别再新造一个）——所以从那一份文案里取，不在这儿再抄一遍。
import '../models/trash_words.dart' show trashRetry, trashUnauthorizedLine;
import '../services/api.dart';
import '../services/chat_controller.dart';

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
    return Scaffold(
      appBar: AppBar(title: const Text(exportTitle)),
      body: Center(
        child: ConstrainedBox(
          // 内容列限宽，同主界面（平板上一行七十个字没人读）
          constraints: const BoxConstraints(maxWidth: 760),
          child: _body(theme),
        ),
      ),
    );
  }

  Widget _body(ThemeData theme) {
    final failed = _failed;
    if (failed != null) {
      // ⚠️ "令牌不行"和"网不好"是两件事（对用户说的话不一样，能做的事也不一样）。
      final line = failed is TrashUnauthorized ? trashUnauthorizedLine : exportLoadFailedLine;
      return ListView(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        children: [
          Text(line, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 8),
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

    // ⚠️ 空对话：**只说那句实话**，不给框、不给复制按钮（§四）。
    if (!doc.hasText) {
      return ListView(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        children: [Text(exportEmptyLine, style: theme.textTheme.bodyMedium)],
      );
    }

    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
      children: [
        Text(exportHintLine, style: theme.textTheme.bodySmall),
        const SizedBox(height: 8),
        // ⚠️ 那一圈边是**字外面的框**（不夹住字）：字放大它跟着长（D3.5）。
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            border: Border.all(color: d.line),
            borderRadius: BorderRadius.circular(d.radiusField),
          ),
          // 可全选：`SelectableText` 既能长按选，也能整段复制。
          child: SelectableText(doc.text, style: theme.textTheme.bodyLarge),
        ),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: _copy,
            style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
            icon: const Icon(Icons.copy_all_outlined),
            label: const Text(exportCopy),
          ),
        ),
      ],
    );
  }
}
