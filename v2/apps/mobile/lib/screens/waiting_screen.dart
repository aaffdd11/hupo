// **"正在给你开一个只属于自己的空间"**（契约 `docs/dev/38-ISOLATION-SPLIT.md` §8.3）。
//
// ── 三条规矩（都是 §8.3 点名的）────────────────────────────
//   1. **如实说**：在建就说在建，久了就说久了（`waitingStillLong`），
//      问不上就说问不上（`waitingRetryFail`）—— 三句话**不混用**；
//   2. 🔴 **不许假进度**：这屏上**一个百分号都没有**，也没有进度条
//      （"看着在动、其实不知道到哪了"比诚实的一句更坏）；
//   3. 🔴 **这时候不许有输入框**：空间还没好，让他打字等于让他白打。
//
// ⚠️ 布局：`SingleChildScrollView` + 不写死尺寸 ——
//    可访问性硬闸有五档字号（最大 3.1x），写死了那一档就溢出。

import 'package:flutter/material.dart';

import '../models/space.dart';
import '../models/space_words.dart';

class WaitingScreen extends StatelessWidget {
  const WaitingScreen({
    super.key,
    required this.onRetry,
    this.busy = false,
    this.askedTooLong = false,
    this.retryFailed = false,
    this.steps = const [],
    this.queued = false,
  });

  /// **开空间那三步**（真进度）。空 ⇒ 只显示那句话（老服务端 / 认不出来）。
  final List<SpaceStep> steps;

  /// 池子里没有空位了（那不是"马上就好"）。
  final bool queued;

  /// 用户按了"再看看"。（多久算太久**住在服务端**，客户端不复制那个数。）
  final VoidCallback onRetry;

  /// 正在问（按钮转一下，但**不画进度**）。
  final bool busy;

  /// 上一次问的时候还是"在建，而且比平常久"。
  final bool askedTooLong;

  /// 上一次问**根本没问上**（网/服务端的问题）—— 要说清是"没问上"，不是"还在开"。
  final bool retryFailed;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    // ⚠️ 三句话**分开**：混用会让用户以为"它一直在稳步推进"，而事实可能是"根本没问上"
    final String note = retryFailed
        ? waitingRetryFail
        : (askedTooLong ? waitingStillLong : waitingBody);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Text(waitingTitle, style: t.textTheme.titleLarge, textAlign: TextAlign.center),
                const SizedBox(height: 12),
                // ★ **真进度**（主人 2026-09-21）：把服务端**真的知道的那三步**画出来。
                //   ⚠️ 只有"做完了没有" —— **没有百分比、没有进度条**（不许假进度）。
                if (queued)
                  Text(waitingQueued, style: t.textTheme.bodyMedium, textAlign: TextAlign.center)
                else if (steps.isNotEmpty)
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (var i = 0; i < steps.length; i++)
                        _StepRow(
                          label: spaceStepWords[steps[i].step] ?? steps[i].step,
                          done: steps[i].done,
                          // 第一个还没做完的 = **正在做的那一步**
                          current: !steps[i].done && steps.take(i).every((e) => e.done),
                        ),
                    ],
                  ),
                const SizedBox(height: 12),
                Text(note, style: t.textTheme.bodyMedium, textAlign: TextAlign.center),
                const SizedBox(height: 24),
                // ⚠️ 命中区 ≥44：`minimumSize` 而不是写死宽高
                FilledButton(
                  onPressed: busy ? null : onRetry,
                  style: FilledButton.styleFrom(minimumSize: const Size(120, 48)),
                  child: Text(busy ? '…' : waitingRetry),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 清单里的一行：✓ 做完了 / … 正在做 / · 还没轮到。
/// ⚠️ 三个符号就够 —— **没有百分比**（不许假进度）。
class _StepRow extends StatelessWidget {
  const _StepRow({required this.label, required this.done, required this.current});
  final String label;
  final bool done;
  final bool current;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final mark = done ? '✓' : (current ? '…' : '·');
    final style = done
        ? t.textTheme.bodyMedium
        : (current
            ? t.textTheme.bodyMedium
            : t.textTheme.bodySmall?.copyWith(color: t.disabledColor));
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 24, child: Text(mark, style: style)),
          Expanded(child: Text(label, style: style)),
        ],
      ),
    );
  }
}
