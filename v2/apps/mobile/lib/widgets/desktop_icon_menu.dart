// 桌面图标上的小面板：**长按 / 右键 ⇒ 从桌面上删掉**
// （契约 `docs/dev/103-APP-DELETE.md` §一 的形状）。
//
// ⚠️ 形状**照 `bubble_menu.dart` 那一份**（那一批刻意定的最小形态）：底栏一个小面板，
//    **只有一个动作 + 一个取消**。位置等主人看过再定 ⇒ 将来挪地方只丢这一个文件。
//
// 🔴 面板上**只有两句**（契约 §三）：`desktopRemoveAction` 与 `desktopRemoveCancel`。
//    不另加标题、不另加解释 —— 这一批最忌讳的就是"多说一句，多一句假话"
//    （服务端是软删，但今天没有拿回来的入口 ⇒ 任何"还能拿回来"的说法都是假话）。
//
// ⚠️ 文案不写在这儿——在 `models/desktop_words.dart`，
//    那样它才进得了 `test/unit` 的禁用词硬闸。
//
// ⚠️ 用 `ListView(shrinkWrap: true)`（和气泡菜单 / 过程四档同一条理由）：
//    最大字号那一档（3.1x）下这一行 + 取消会顶出屏幕 ——
//    列表能滚，溢出就永远不会发生（D3.5 那道硬闸）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/desktop_words.dart';

/// 长按 / 右键桌面图标之后选了什么。现在只有一样，但**写成枚举**：
/// 将来加"改个名字"之类不用改调用方的形状（同 `BubbleAction`）。
enum DesktopIconAction { remove }

class DesktopIconMenu extends StatelessWidget {
  const DesktopIconMenu({super.key});

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
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
