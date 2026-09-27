// **录一段（录音 ＋ 回放）**：设置页「语音」那一屏里的那一块
// （主人 2026-09-27：*"先实现录音功能。录音和播放。在设置页。"*）。
//
// 契约：`docs/dev/128-VOICE-RECORD-AND-PLAY.md`。
//
// ── 为什么要有它（与旁边那块「试一下」的分工）──────────────────
//   「试一下」验的是**整条识别路**（要钥匙、要上游、要那台机器接上）；
//   这一块验的是**这台设备的麦克风本身**：录一段、在下面听一遍 ——
//   **不依赖任何钥匙、任何上游、任何网络**。
//   🔴 屏幕上那句"这段只留在你这台设备上，不发给任何人"说的就是这个事实。
//
// ── 四条规矩 ──────────────────────────────────────────────
//   1. 🔴 **这里不碰麦克风**：开录/收手/放音都是注入进来的（[VoiceRecordHandlers]，
//      真实现在 `services/recorder.dart` 的条件导出里）。
//   2. 🔴 **一个失败一个原因**：没权限 / 这里录不了 / 开不起来 / 录下来是空的 ——
//      每一档都有自己的话，**绝不静默**；与话筒那几句**共用**（同一个原因不许两种说法）。
//   3. **他不许被抢**：正经录着的时候屏幕上是"停下"（他不会误以为在放音）；
//      放音的时候按"开始录"⇒ **先把放音停掉**再开录（不叠在一起、也没有按不动的键）。
//   4. **尺寸跟字算**：按钮命中区 ≥44；字放到最大也不许溢出（那是硬闸 D3.5/D3.6）。
//
// ⚠️ 界面上**没有**内部词（`AGENTS.md` §六 第 4 条；词表硬闸会拦）。

import 'dart:async';

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/hearing_words.dart';
import '../models/voice_record.dart';

class VoiceRecord extends StatefulWidget {
  const VoiceRecord({super.key, required this.handlers});

  /// 开录 / 收手 / 放音那几个动作（真实现在 `services/recorder.dart`）。
  final VoiceRecordHandlers handlers;

  @override
  State<VoiceRecord> createState() => _VoiceRecordState();
}

class _VoiceRecordState extends State<VoiceRecord> {
  RecPhase _phase = RecPhase.idle;

  /// 上一次失败的原因（机器那句原话由 `whyOf` 翻成人话；空 = 没什么要说的）。
  String _why = '';

  /// 手里那一段（录完才有）。
  RecordedClip? _clip;

  /// **开录**（第一次按下去）。
  Future<void> _start() async {
    // 正在放 ⇒ 先停掉（不叠在一起）
    if (_phase == RecPhase.playing) {
      widget.handlers.stopPlay();
      setState(() => _phase = RecPhase.ready);
    }
    if (!widget.handlers.canRecord) {
      // 这里录不了：**如实说一句白话**（不装、也不静默）
      setState(() {
        _phase = RecPhase.idle;
        _why = hearCantHere;
      });
      return;
    }
    setState(() {
      _why = '';
      _phase = RecPhase.recording;
    });
    final why = await widget.handlers.start();
    if (!mounted) return;
    if (why != null) {
      // ⚠️ 开不起来 ⇒ **收场并说明白**（绝不假装在录）
      setState(() {
        _phase = RecPhase.idle;
        _why = _whyOf(why);
      });
    }
  }

  /// **收手**（第二次按下去）⇒ 拿到那一段（或"这段是空的"）。
  Future<void> _stop() async {
    final got = await widget.handlers.stop();
    if (!mounted) return;
    setState(() {
      _phase = RecPhase.ready;
      if (got == null || !got.ok) {
        _clip = null;
        _why = voiceRecEmpty;
        return;
      }
      _clip = got;
      _why = '';
    });
  }

  /// **听一遍 / 别放了**。
  void _togglePlay() {
    final clip = _clip;
    if (clip == null) return;
    if (_phase == RecPhase.playing) {
      widget.handlers.stopPlay();
      setState(() => _phase = RecPhase.ready);
      return;
    }
    setState(() => _phase = RecPhase.playing);
    widget.handlers.play(clip.url, () {
      // 它自己放完了 ⇒ 按钮回到"听一遍"（⚠️ 这一块可能已经被拆掉）
      if (mounted && _phase == RecPhase.playing) setState(() => _phase = RecPhase.ready);
    });
  }

  /// 机器原因 → 人话（**与话筒那几句共用**：同一个原因不许有两种说法）。
  String _whyOf(String why) {
    switch (why) {
      case 'denied':
        return hearDenied;
      case 'unsupported':
        return hearCantHere;
      case 'failed':
      default:
        return hearFailed;
    }
  }

  @override
  void dispose() {
    // 走开的时候：**把麦关掉、把声音停掉**（这一块没有一个"一直在"的位置提醒他）
    widget.handlers.stopPlay();
    if (_phase == RecPhase.recording) unawaited(widget.handlers.stop());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final recording = _phase == RecPhase.recording;
    final notice = voiceRecNotice(
      phase: _phase,
      why: _why,
      canRecord: widget.handlers.canRecord,
    );
    final playLabel = voiceRecPlayButton(_phase, hasClip: _clip != null);
    final lengthLine = voiceRecLengthLine(_phase, _clip);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Divider(height: d.gapL),
        Text(
          voiceRecTitle,
          style: t.textTheme.titleSmall?.copyWith(color: d.ink, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: d.gapXs),
        Text(voiceRecHint, style: t.textTheme.bodySmall?.copyWith(color: d.muted)),
        const SizedBox(height: d.gapS),
        // 那颗大按钮：**正在录**时它自己就是"停下"；其余时候（含正在放）都是"开始录"
        FilledButton(
          onPressed: recording ? _stop : _start,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          child: Text(voiceRecButton(_phase)),
        ),
        // 手里有一段 ⇒ 才画"听一遍 / 别放了"（**没有东西可放就不画**）
        if (playLabel != null) ...[
          const SizedBox(height: d.gapXs),
          OutlinedButton(
            onPressed: _togglePlay,
            // ⚠️ **48，不是 44**：这一屏的主题是 `VisualDensity.compact`，
            //    它会把按钮再收 2 ⇒ 写 44 量出来只有 42，命中区那道硬闸当场判红（真栽过）。
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            child: Text(playLabel),
          ),
        ],
        if (lengthLine.isNotEmpty) ...[
          const SizedBox(height: d.gapXs),
          Text(
            lengthLine,
            textAlign: TextAlign.center,
            style: t.textTheme.bodySmall?.copyWith(color: d.muted),
          ),
        ],
        if (notice.isNotEmpty) ...[
          const SizedBox(height: d.gapXs),
          Text(
            notice,
            textAlign: TextAlign.center,
            style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error),
          ),
        ],
      ],
    );
  }
}
