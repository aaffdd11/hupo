// **画一张试试**（配置页「图片」那一屏里那一块 · P1-27）。
//
// ── 为什么要有它 ──────────────────────────────────────────
//   主人 2026-09-24：*"配置页用来配置模型，语言大模型apikey，语音大模型，图片生成，视频生成。"*
//   填了一把画图的钥匙之后，**他得能当场知道"这把钥匙到底能不能画"** ——
//   不然那就是"填了一个不知道有没有用的东西"（这个项目里最忌的形状）。
//
// ── 三条规矩 ──────────────────────────────────────────────
//   1. 输入框**不遮**（提示词不是秘密；遮起来反而没法改）；
//   2. 🔴 **失败的那句话由服务端给**（他才知道上游说了什么）—— 这里**不编**；
//   3. 图**有边界**地显示（大字/窄屏都不许把这一页撑爆 —— D3.5 那道硬闸盯着）。
//
// ⚠️ 界面上**没有** `模型` / `工具` / `客户端` 这些词（词表硬闸会拦）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/image_outcome.dart';
import '../models/space_words.dart';

class ImageTry extends StatefulWidget {
  const ImageTry({super.key, required this.onDraw});

  /// 交给上层去画（这一块只管界面与那几句状态话）。
  final Future<ImageOutcome> Function(String prompt) onDraw;

  @override
  State<ImageTry> createState() => _ImageTryState();
}

class _ImageTryState extends State<ImageTry> {
  final _c = TextEditingController();
  bool _busy = false;
  String? _words;
  List<String> _urls = const [];

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _run() async {
    final p = _c.text.trim();
    if (p.isEmpty) {
      setState(() => _words = imagePromptBlank);
      return;
    }
    setState(() {
      _busy = true;
      _words = null;
    });
    final r = await widget.onDraw(p);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _urls = r.ok ? r.urls : const [];
      _words = r.ok ? null : (r.words ?? imageTryFailed);
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
          imageTryLabel,
          style: t.textTheme.titleSmall?.copyWith(color: d.ink, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: d.gapXs),
        Text(imageTryHint, style: t.textTheme.bodySmall?.copyWith(color: d.muted)),
        const SizedBox(height: d.gapS),
        TextField(
          controller: _c,
          // 提示词**不遮**（它不是秘密，而且要能看见自己写了什么）
          maxLines: 2,
          minLines: 1,
          decoration: const InputDecoration(
            labelText: imagePromptLabel,
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: d.gapS),
        FilledButton(
          onPressed: _busy ? null : _run,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          child: Text(_busy ? imageGenerating : imageTrySubmit),
        ),
        if (_words != null) ...[
          const SizedBox(height: d.gapS),
          Text(
            _words!,
            style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error),
            textAlign: TextAlign.center,
          ),
        ],
        for (final url in _urls) ...[
          const SizedBox(height: d.gapS),
          // ⚠️ **有边界**：宽度跟着卡片，高度按图自己的比例（不会把这一页撑爆）
          ClipRRect(
            borderRadius: BorderRadius.circular(d.radiusCard),
            child: Image.network(
              url,
              fit: BoxFit.contain,
              // 取不到图时**说一句实话**（不是留一块空白让人猜）
              errorBuilder: (_, __, ___) => Padding(
                padding: const EdgeInsets.all(d.gapM),
                child: Text(
                  imageLoadFailed,
                  style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error),
                  textAlign: TextAlign.center,
                ),
              ),
              loadingBuilder: (_, child, progress) => progress == null
                  ? child
                  : Padding(
                      padding: const EdgeInsets.all(d.gapM),
                      child: Text(
                        imageGenerating,
                        style: t.textTheme.bodySmall?.copyWith(color: d.muted),
                        textAlign: TextAlign.center,
                      ),
                    ),
            ),
          ),
          const SizedBox(height: d.gapXs),
          Text(
            imageTempLink,
            style: t.textTheme.bodySmall?.copyWith(color: d.muted),
            textAlign: TextAlign.center,
          ),
        ],
      ],
    );
  }
}
