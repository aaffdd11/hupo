// 桌面图标上的小面板：**按住 / 右键 ⇒ 改个名字 / 复制一个 / 从桌面上删掉**
// （契约 `docs/dev/104-APP-MENU.md` §一；"删掉"那一条走 `103` §七 那套）。
//
// ⚠️ 形状**照 `bubble_menu.dart` 那一份**（那一批刻意定的最小形态）：底栏一个小面板。
//    位置等主人看过再定 ⇒ 将来挪地方只丢这一个文件。
//
// 🔴 面板上**只有四项**（三项动作 + 取消），每一项的文案都住 `models/desktop_words.dart`：
//    `desktopRenameAction` / `desktopCopyAction` / `desktopRemoveAction` / `desktopRemoveCancel`。
//    ⚠️ **主人说的"删除小程序"没有照字面写**：「小程序」是上屏禁用词
//    （`06` 禁令 4，`test/unit/forbidden_words_test.dart` 一直扫这一份表）。
//
// ⚠️ 用 `ListView(shrinkWrap: true)`（和气泡菜单 / 过程四档同一条理由）：
//    最大字号那一档（3.1x）下这几行 + 取消会顶出屏幕 ——
//    列表能滚，溢出就永远不会发生（D3.5 那道硬闸）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/desktop_words.dart';

/// 按住 / 右键桌面图标之后选了什么。
enum DesktopIconAction { rename, copy, remove }

class DesktopIconMenu extends StatelessWidget {
  const DesktopIconMenu({super.key});

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          ListTile(
            leading: const Icon(Icons.drive_file_rename_outline),
            title: const Text(desktopRenameAction),
            onTap: () => Navigator.of(context).pop(DesktopIconAction.rename),
          ),
          ListTile(
            leading: const Icon(Icons.copy_all_outlined),
            title: const Text(desktopCopyAction),
            onTap: () => Navigator.of(context).pop(DesktopIconAction.copy),
          ),
          ListTile(
            leading: const Icon(Icons.remove_circle_outline),
            title: const Text(desktopRemoveAction),
            onTap: () => Navigator.of(context).pop(DesktopIconAction.remove),
          ),
          Padding(
            // ⚠️ 数字全走 `design.dart`（棘轮 `design_tokens_test.dart`：新文件的上限是 0）
            padding: const EdgeInsets.fromLTRB(d.gapS, d.gapXs, d.gapS, d.gapS),
            child: Align(
              alignment: Alignment.centerRight,
              // 触控目标 ≥44：`TextButton` 的 `minimumSize` 撑命中区（同气泡菜单）
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(),
                style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
                child: const Text(desktopRemoveCancel),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
