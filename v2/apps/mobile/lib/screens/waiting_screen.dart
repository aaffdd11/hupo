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

import 'dart:async';

import 'package:flutter/material.dart';

import '../models/space.dart';
import '../models/space_words.dart';

class WaitingScreen extends StatefulWidget {
  const WaitingScreen({
    super.key,
    required this.onRetry,
    this.busy = false,
    this.askedTooLong = false,
    this.retryFailed = false,
    this.steps = const [],
    this.queued = false,
    this.full = false,
    this.onRefresh,
  });

  /// ★ **它自己会刷新**（主人 2026-09-21："我需要一个动态的"）：
  ///    上层每 `refreshEvery` 重新问一次"到哪一步了"，**不用用户按按钮**。
  ///    ⚠️ `null` = 不自动刷（测试里用）。
  final Future<void> Function()? onRefresh;

  /// 多久问一次。⚠️ 它**只是"多久问一次"**，不是进度。
  static const Duration refreshEvery = Duration(seconds: 2);

  /// **开空间那三步**（真进度）。空 ⇒ 只显示那句话（老服务端 / 认不出来）。
  final List<SpaceStep> steps;

  /// 我们自己这边还没给他开（那不是"马上就好"）。
  final bool queued;

  /// 🔴 **给不了**（满了 / 那台没建成）。
  ///
  /// ⚠️ 这一档与"还在开"是**两件事**，而原来它们共用一句话 ——
  ///    于是屏幕上没有一个字说"它不会自己好了"，而这一屏每 2 秒还在自问、
  ///    三步一直不勾 ⇒ **看着像在动**。这正是项目点名禁的假象。
  /// ⇒ 它一到，这一屏就该：**说清楚** + **停止自问**（再问也不会变，还费电）。
  final bool full;

  /// 用户按了"再看看"。（多久算太久**住在服务端**，客户端不复制那个数。）
  final VoidCallback onRetry;

  /// 正在问（按钮转一下，但**不画进度**）。
  final bool busy;

  /// 上一次问的时候还是"在建，而且比平常久"。
  final bool askedTooLong;

  /// 上一次问**根本没问上**（网/服务端的问题）—— 要说清是"没问上"，不是"还在开"。
  final bool retryFailed;

  @override
  State<WaitingScreen> createState() => _WaitingScreenState();
}

class _WaitingScreenState extends State<WaitingScreen> {
  Timer? _poll;
  Timer? _tick;
  int _elapsed = 0;

  @override
  void initState() {
    super.initState();
    // ⚠️ **给不了的时候一个定时器都不许开**：
    //    · 那个秒数是在量"你等了多久" —— 而这一台**不会来了**，量它就是在骗人；
    //    · 每 2 秒再问一次也不会有别的答案（白耗电、还让用户以为"在动"）。
    if (widget.full) return;
    // ★ **真的在走的秒数**（量真实时间 ⇒ 诚实；不是进度）
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _elapsed += 1);
    });
    // ★ **它自己问**：不用用户按"再看看"
    final r = widget.onRefresh;
    if (r != null) {
      _poll = Timer.periodic(WaitingScreen.refreshEvery, (_) => r());
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    // ⚠️ 三句话**分开**：混用会让用户以为"它一直在稳步推进"，而事实可能是"根本没问上"
    final String note = widget.retryFailed
        ? waitingRetryFail
        : (widget.askedTooLong ? waitingStillLong : waitingBody);

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
                if (widget.full)
                  // 🔴 **给不了就说给不了**：不画那三步（一步都没走），也不挂秒数。
                  //    让他知道"再等下去不会有变化"，而不是继续盯着一个不会动的东西。
                  Text(waitingFull, style: t.textTheme.bodyMedium, textAlign: TextAlign.center)
                else if (widget.queued)
                  Text(waitingQueued, style: t.textTheme.bodyMedium, textAlign: TextAlign.center)
                else if (widget.steps.isNotEmpty)
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (var i = 0; i < widget.steps.length; i++)
                        _StepRow(
                          label: spaceStepWords[widget.steps[i].step] ?? widget.steps[i].step,
                          done: widget.steps[i].done,
                          // 第一个还没做完的 = **正在做的那一步**
                          current: !widget.steps[i].done && widget.steps.take(i).every((e) => e.done),
                          // ★ **在动**（主人要的"动态"）：当前那一步旁边转圈。
                          //   ⚠️ 转的是"**在做事**"，**不是**"做了百分之几"。
                          spinning: !widget.steps[i].done &&
                              widget.steps.take(i).every((e) => e.done),
                        ),
                    ],
                  ),
                const SizedBox(height: 12),
                // ⚠️ 给不了的时候上面已经把话说完了 ⇒ 不再叠一句"还在开"
                //    （两句意思相反的话同时在屏幕上，用户只会更慌）
                if (!widget.full) ...[
                  Text(note, style: t.textTheme.bodyMedium, textAlign: TextAlign.center),
                  const SizedBox(height: 4),
                  // ★ **一个真的在走的秒数**（量真实时间 ⇒ 诚实；**不是百分比**）
                  Text(
                    waitingElapsedWords(_elapsed),
                    style: t.textTheme.bodySmall,
                    textAlign: TextAlign.center,
                  ),
                ],
                const SizedBox(height: 24),
                // ⚠️ 命中区 ≥44：`minimumSize` 而不是写死宽高
                FilledButton(
                  onPressed: widget.busy ? null : widget.onRetry,
                  style: FilledButton.styleFrom(minimumSize: const Size(120, 48)),
                  child: Text(widget.busy ? '…' : waitingRetry),
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
  const _StepRow({
    required this.label,
    required this.done,
    required this.current,
    this.spinning = false,
  });
  final String label;
  final bool done;
  final bool current;

  /// 那一步**正在做**（旁边转个圈）。
  /// ⚠️ 它**不是进度**：转圈只说"在做事"，**不说"做了多少"**。
  final bool spinning;

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
          SizedBox(
            width: 24,
            child: spinning
                // ⚠️ 小转圈：**不可点**（不影响命中区 ≥44 那条闸）
                ? const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(mark, style: style),
          ),
          Expanded(child: Text(label, style: style)),
        ],
      ),
    );
  }
}
