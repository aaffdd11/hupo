// **「验一下」那一块**（配置页「视频」那一屏里 · v3.0 · 主人 2026-10-07 选的档）。
//
// ── 为什么视频那一屏不照抄「试一张」──────────────────────────
// 图片那一屏的「试一张」是**真画一张**（花钱、几十秒）。视频**又慢又贵**，
// 而他点这一下往往只是想确认"这把钥匙到底对不对"。
// ⇒ 主人 2026-10-07 当场选的：**只验钥匙和路，不花钱**（见 `docs/dev/219` §一）。
//
// ── 三条规矩（与 `image_try.dart` 一样）──────────────────────
//   1. 🔴 **结果那句话由服务端给** —— 这里**不编**（编了就是"页面在说假话"）；
//   2. 它**不碰钥匙**：只叫一声上层，钥匙只在那边往上游去（`cred_section.dart` 那条纪律）；
//   3. 按钮的命中区、五个档位的不溢出 —— 与 `image_try.dart` 同一条（D3.5 那道硬闸）。
//
// ⚠️ **它不许说"能出片"**：验的是"那边认不认这把钥匙"，不是"名字对不对"
//    （那要真跑一次）。所以这里一个"能/做/画"的承诺都不写死，只显示服务端那句话。

import 'package:flutter/material.dart';

import '../models/ark_check_outcome.dart';
import '../models/design.dart' as d;
import '../models/space_words.dart';

class VideoTry extends StatefulWidget {
  const VideoTry({super.key, required this.onCheck});

  /// 交给上层去验（这一块只管界面与那几句状态话）。
  final Future<ArkCheckOutcome> Function() onCheck;

  @override
  State<VideoTry> createState() => _VideoTryState();
}

class _VideoTryState extends State<VideoTry> {
  bool _busy = false;
  String? _words;
  bool _ok = false;

  Future<void> _run() async {
    setState(() {
      _busy = true;
      _words = null;
    });
    final r = await widget.onCheck();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _ok = r.ok;
      _words = r.words ?? (r.ok ? null : videoCheckFailed);
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Divider(height: d.gapL),
        Text(
          videoCheckLabel,
          style: t.textTheme.titleSmall?.copyWith(color: d.ink, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: d.gapXs),
        Text(videoCheckHint, style: t.textTheme.bodySmall?.copyWith(color: d.muted)),
        const SizedBox(height: d.gapS),
        FilledButton(
          onPressed: _busy ? null : _run,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          child: Text(_busy ? videoChecking : videoCheckSubmit),
        ),
        if (_words != null) ...[
          const SizedBox(height: d.gapS),
          Text(
            _words!,
            // ⚠️ 成了／没成**不只靠颜色**（同一个界面上两句话本来就不一样），
            //    但"成了"用正文色、"没成"用提醒色 —— 与 `image_try.dart` 同一个样子
            style: t.textTheme.bodySmall?.copyWith(color: _ok ? d.ink : t.colorScheme.error),
            textAlign: TextAlign.center,
          ),
        ],
      ],
    );
  }
}
