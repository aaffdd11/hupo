// **「这件事要另开一处做吗」那一层确认**（契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 第①步 · 判据 C1）。
//
// ── 形状：**照既有那条反问路那一层**（`widgets/trash_plan_sheet.dart` 同形）──
//   · 一个**可从底下弹出来的层**（`showModalBottomSheet`）；
//   · 标题 ＋ 几句正文 ＋ **两个按钮**（先"不要"，后"要"）；
//   · 正文**可滚**（字号放到最大那一档也不溢出 —— D3.5 那道硬闸）；
//   · 两个按钮都有 `minimumSize: Size(44, 44)`（D3.6 那道硬闸）。
//
// 🔴 **文案住一处表**（`models/job_words.dart`）：摆在界面里的字符串，
//    禁用词硬闸够不着。⚠️ 而且**问话是服务端给的**（客户端照抄）——
//    与反问那条路同一条规矩：两处各拼一句就会漂。
// 🔴 **两个按钮的分工不许混**：右边那个（"另开一处做"）是**回答"是"**，
//    左边那个（"就在这儿做"）是**回答"否"** —— 它们都不是"取消"，
//    因为那一笔本来就在等他答（没有"什么都不答"这个按钮，不答就是不答，
//    超时由服务端如实收场）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/job_ask.dart';
import '../models/job_words.dart';

class JobAskSheet extends StatelessWidget {
  const JobAskSheet({super.key, required this.ask});

  final JobAsk ask;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      // 列表能滚 ⇒ 字号最大那一档也不会溢出（D3.5 那道硬闸）。
      child: ListView(
        shrinkWrap: true,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(d.gapL, d.gapM, d.gapL, d.gapXs),
            child: Text(jobAskTitle, style: theme.textTheme.titleMedium),
          ),
          // 服务端给的那句问话：**原样**（一个字都不改）。
          Padding(
            padding: const EdgeInsets.fromLTRB(d.gapL, 0, d.gapL, d.gapS),
            child: Text(ask.text, style: theme.textTheme.bodyMedium),
          ),
          // 他说的那句原话：让他认出"你让我做的是这个"。
          // ⚠️ 服务端没给 ⇒ **那一行不画**（不编一句"你要做一个东西"）。
          if (ask.why.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(d.gapL, 0, d.gapL, d.gapS),
              child: Text(jobAskWhyLine(ask.why), style: theme.textTheme.bodySmall),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(d.gapM, d.gapS, d.gapM, d.gapS),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => Navigator.of(context).pop(false),
                  style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
                  child: const Text(jobAskHere),
                ),
                const SizedBox(width: d.gapS),
                FilledButton(
                  onPressed: () => Navigator.of(context).pop(true),
                  style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
                  child: const Text(jobAskNewPlace),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
