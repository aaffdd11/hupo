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

import '../models/space_words.dart';

class WaitingScreen extends StatelessWidget {
  const WaitingScreen({
    super.key,
    required this.onRetry,
    this.busy = false,
    this.askedTooLong = false,
    this.retryFailed = false,
  });

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
