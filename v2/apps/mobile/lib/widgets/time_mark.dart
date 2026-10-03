// 时间线上那一行**时间**（契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.1）。
//
// 形状照 `bubbles.dart` 的 `MarkerLine`（"你不在的时候"那条）——
// 但**更安静**：它是时间的刻度，不是一件事；它不该跟内容抢眼睛。
//
// ⚠️ 数值/颜色/字号一律走 token（`dsh_design.dart`）：这一份里一个写死的数都没有。
// ⚠️ 判据要能在**五档字号**（1.0–3.1）下不溢出 —— 它是一行 `Expanded` 夹着的字。

import 'package:flutter/material.dart';

import '../models/dsh_design.dart';
import 'dsh_look.dart';

class TimeMarkLine extends StatelessWidget {
  const TimeMarkLine({super.key, required this.label});

  /// 那一行写什么（`chat_time.dart` 的 `timeMarkLabel` 算好的，**这里不拼**）。
  final String label;

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: DshSpace.s8),
      child: Row(
        children: [
          // 两边的细线**不与字抢**：用最淡那一级描边、发丝粗细
          Expanded(child: Divider(height: 1, thickness: dshHairline, color: p.borderL1)),
          // ⚠️ 字可以很长（「2025年10月1日 21:33」）⇒ **`Flexible` ＋ 省略号**：
          //    窄屏 + 3.1 倍字号下这一行**绝不许横向溢出**（D3.5 那道硬闸抓过我一次：
          //    只给 `maxLines` 不给弹性，字会照自己的宽度铺出去）。
          Flexible(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: DshSpace.s8),
              child: Text(
                label,
                style: dshTextStyle(look.caption, p.labelTertiary),
                maxLines: 1,
                softWrap: false,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          Expanded(child: Divider(height: 1, thickness: dshHairline, color: p.borderL1)),
        ],
      ),
    );
  }
}
