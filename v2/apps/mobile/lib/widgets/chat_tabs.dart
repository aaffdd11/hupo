// **浮窗标题行上那两个 tab**：聊天 / 轨迹（契约 `docs/dev/118-TRAJECTORY-VIEW.md` §一）。
//
// 形状是 DSH 的（`docs/dev/115-raw/B-render.md` L65：`role="tablist"` ＋ 每个已注册的
// view 一个 `role="tab"`，`view.chat` / `view.trajectory`）：
// 选中那一档的字更重、颜色更实，底下一条 0.5px 的指示线；另一档是淡的。
//
// ⚠️ **切换是瞬时的、不重连**（`screens/chat_screen.dart` 的 `_setView`）：
//    它只换浮窗里那一块画什么，那条流一个字节都不动。
// ⚠️ 两颗都是**真按钮**（`TextButton`）：命中区由 Material 撑着 ≥44（D3.6）；
//    **不用裸 `GestureDetector`**（`accessibility_test.dart` 有一条源码级禁令）。
// ⚠️ 数值只从 `models/dsh_design.dart` 来（`design_tokens_test.dart` 那条棘轮
//    管着"新文件写死的尺寸 = 0 处"）。

import 'package:flutter/material.dart';

import '../models/chat_view.dart';
import '../models/dsh_design.dart';
import 'dsh_look.dart';

/// 某一档 tab 那颗按钮的 key（判据用它点、也用它量命中区）。
Key chatTabKey(ChatView view) => ValueKey('chat-tab-${view.wire}');

/// 标题行上那两个 tab。
class ChatTabs extends StatelessWidget {
  const ChatTabs({super.key, required this.current, required this.onPick});

  /// 现在看的是哪一档。
  final ChatView current;

  /// 点了另一档（点当前那一档是**空动作** —— 调用方自己会判，见下）。
  final ValueChanged<ChatView> onPick;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final v in ChatView.values) _tab(look, v),
      ],
    );
  }

  /// 一颗 tab。
  ///
  /// ⚠️ **当前那一档也按得动**（`onPressed` 不为空）：按下去什么都不发生
  ///    （`_setView` 认"还是这一档"）。为什么不做成 `disabled`：
  ///    可访问性那道硬闸会去量**每一颗按钮**的命中区，而"按不动"的控件
  ///    在屏幕上是个死东西 —— 他按一下以为坏了。切换器本来就不该有死键。
  Widget _tab(DshLook look, ChatView v) {
    final p = look.palette;
    final on = v == current;
    return TextButton(
      key: chatTabKey(v),
      onPressed: () => onPick(v),
      style: TextButton.styleFrom(
        // D3.6：命中区下限 44（视觉可以小，命中区不许小）
        minimumSize: const Size(44, 44),
        padding: const EdgeInsets.symmetric(horizontal: DshSpace.s8),
        foregroundColor: on ? p.labelPrimary : p.labelTertiary,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            v.tab,
            style: dshTextStyle(
              on ? look.scale.at(DshTypes.sStrong) : look.scale.at(DshTypes.s),
              on ? p.labelPrimary : p.labelTertiary,
            ),
          ),
          // 选中那条指示线（DSH 的 tab 底下就是它）—— 0.5px，token。
          Container(
            height: dshHairline,
            color: on ? p.labelPrimary : Colors.transparent,
          ),
        ],
      ),
    );
  }
}
