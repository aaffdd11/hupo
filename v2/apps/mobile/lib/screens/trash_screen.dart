// 「回收站」页（契约 `docs/dev/28-DELETE.md` §二 第 2 条、§八·8.2）。
//
// 三件事，按这一屏的轻重排：
//   ① **如实说这里有什么**：读不到就说读不到（N10：沉默优于编造），
//      不拿一个空白页冒充"回收站是空的"；
//   ② **恢复**一键就回来（契约 §8.3：恢复要立刻）；
//   ③ **彻底删掉**要**二次确认**（§8.2：破坏性动作不许一个手滑就触发），
//      确认框里明说"拿不回来了"。
//
// ⚠️ 每条都写明**什么时候会彻底删掉**（§七：这一件先把账记准）——
//    那个时间**由服务端算**（`purgeAt`），客户端不复制天数。
// ⚠️ 文案在 `models/trash_words.dart`（那样才进得了禁用词硬闸）。
// ⚠️ 不写死尺寸：字长多大容器跟到多大；整页是列表，能滚（D3.5 那道硬闸）。

import 'package:flutter/material.dart';

import '../models/trash.dart';
import '../models/trash_words.dart';
import '../services/api.dart';
import '../services/chat_controller.dart';

class TrashScreen extends StatefulWidget {
  const TrashScreen({super.key, required this.controller});

  final ChatController controller;

  @override
  State<TrashScreen> createState() => _TrashScreenState();
}

class _TrashScreenState extends State<TrashScreen> {
  /// 读到的那一份。`null` = 还在读。
  List<TrashEntry>? _entries;
  TrashAnswer<List<TrashEntry>>? _failed;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _entries = null;
      _failed = null;
    });
    final a = await widget.controller.loadTrash();
    if (!mounted) return;
    setState(() {
      switch (a) {
        case TrashOk(:final value):
          _entries = value;
        case TrashUnauthorized():
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

  Future<void> _restore(List<String> messageIds) async {
    final a = await widget.controller.restoreTurn(messageIds);
    if (!mounted) return;
    switch (a) {
      case TrashOk():
        _say(trashRestoredLine);
      case TrashUnauthorized():
        _say(trashUnauthorizedLine);
      case TrashFailed():
        _say(trashRestoreFailedLine);
    }
    await _load();
  }

  Future<void> _purge(List<String> messageIds) async {
    // ★ 二次确认（契约 §8.2）。`showDialog` 的 actions 是 `OverflowBar`
    //   ⇒ 字放大了它会自己折行，不会溢出。
    final yes = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text(trashPurgeConfirmTitle),
        content: const Text(trashPurgeConfirmBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(d).pop(false),
            style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
            child: const Text(trashPurgeConfirmNo),
          ),
          FilledButton(
            onPressed: () => Navigator.of(d).pop(true),
            style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
            child: const Text(trashPurgeConfirmYes),
          ),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    final a = await widget.controller.purgeTurn(messageIds);
    if (!mounted) return;
    switch (a) {
      case TrashOk():
        _say(trashPurgedLine);
      case TrashUnauthorized():
        _say(trashUnauthorizedLine);
      case TrashFailed():
        _say(trashPurgeFailedLine);
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text(trashTitle)),
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
      final line = failed is TrashUnauthorized ? trashUnauthorizedLine : trashLoadFailedLine;
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
    final entries = _entries;
    if (entries == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (entries.isEmpty) {
      return ListView(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        children: [Text(trashEmptyLine, style: theme.textTheme.bodyMedium)],
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
      itemCount: entries.length,
      itemBuilder: (context, i) => _entry(theme, entries[i]),
    );
  }

  Widget _entry(ThemeData theme, TrashEntry e) {
    final purge = purgeAtLine(e.purgeAt);
    return Padding(
      // ⚠️ 这是**字外面的留白**（不包住字）：字长多大它都不挡（D3.5）。
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            e.preview.isEmpty ? trashNoPreviewLine : e.preview,
            style: theme.textTheme.bodyLarge,
          ),
          if (purge.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(purge, style: theme.textTheme.bodySmall),
            ),
          // ⚠️ `Wrap` 不是 `Row`：两个按钮在最大字号下要能折到第二行，
          //    否则屏幕上就是一条溢出（D3.5 那道硬闸量的就是这个）。
          Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: e.usable ? () => _restore(e.messageIds) : null,
                style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
                child: const Text(trashRestore),
              ),
              TextButton(
                onPressed: e.usable ? () => _purge(e.messageIds) : null,
                style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
                child: const Text(trashPurge),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
