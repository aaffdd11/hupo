// Landing：**未登录时的第一屏**（主人 2026-09-21 点名要的东西）。
//
// 它只干四件事，按轻重排：
//   ① 一句话说清**它是什么**（手册 `01-PROJECT.md` 〇 那句承诺，原文照抄）；
//   ② **两个入口**：开始用（→ 登录）· 下载安卓版；
//   ③ ⚠️ **不许假装**：安卓版今天**没有**安装包 ⇒ 点了就**如实说没上线**
//      （"说了做不到 = 撒谎"是本项目最贵的那一类缺陷）；
//   ④ 一句话交代"第一次要等一下"——**在点之前就说**，别让他登录完才发现。
//
// ⚠️ 不写死尺寸（D3.5）：字号全部来自 `theme.textTheme`，容器跟着字走；
//    整页是 `ListView`（能滚）⇒ 五档字体下**不溢出**（`accessibility_test.dart` 那道硬闸）。
// ⚠️ 命中区 ≥44（D3.6）。
// ⚠️ 文案全在 `models/landing_words.dart`（那样才进得了禁用词硬闸）。

import 'package:flutter/material.dart';

import '../models/landing_words.dart';

class LandingScreen extends StatelessWidget {
  const LandingScreen({super.key, required this.onStart});

  /// 点"开始用"之后干什么（上层决定：进登录页）。
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          // 内容列限宽（比主界面窄一点：这是"广告牌"，一行的字越少越像话）
          constraints: const BoxConstraints(maxWidth: 560),
          // ⚠️ `ListView` 不是 `Column`：字体放到最大时**能滚**，而不是溢出
          child: ListView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            children: [
              // ── 头图：一块有重心的渐变牌（高度不写死，跟着里面的字走）──
              DecoratedBox(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(24),
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [scheme.primary, scheme.primaryFixedDim],
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 26),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // 一个"标记"：没有 logo，就用一个字块当视觉重心
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                        decoration: BoxDecoration(
                          color: scheme.onPrimary.withValues(alpha: 0.16),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Text(
                          landingTitle,
                          style: theme.textTheme.titleMedium?.copyWith(color: scheme.onPrimary),
                        ),
                      ),
                      const SizedBox(height: 14),
                      Text(
                        landingPromise,
                        style: theme.textTheme.headlineSmall?.copyWith(
                          color: scheme.onPrimary,
                          height: 1.35,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 22),
              // ⚠️⚠️ **两个入口必须排在"三句支撑"之前**（2026-09-21 无障碍硬闸抓出来的）：
              //    原来三句支撑在前 ⇒ 字体放到 **3.1 倍**时两个按钮被挤到屏幕外，
              //    那道闸的话是「**一个能点的都没扫到**」—— 也就是**主入口要滚动才找得到**。
              //    ⇒ 现在先把按钮给出去，再讲细节。这是那一档的真实缺陷，不是闸太严。
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: [
                  FilledButton(
                    onPressed: onStart,
                    style: FilledButton.styleFrom(minimumSize: const Size(48, 52)),
                    child: const Text(landingStart),
                  ),
                  OutlinedButton(
                    onPressed: () => _android(context),
                    style: OutlinedButton.styleFrom(minimumSize: const Size(48, 52)),
                    child: const Text(landingAndroid),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              // 三句支撑放进一张浅色卡里（不然它们飘在空白上，像没排完版）
              DecoratedBox(
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final p in landingPoints)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Icon(Icons.check_circle_outline, size: 20, color: scheme.primary),
                              const SizedBox(width: 10),
                              // ⚠️ `Expanded`：长句在窄屏/大字下换行，不挤出去
                              Expanded(child: Text(p, style: theme.textTheme.bodyLarge)),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(landingStartHint, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 28),
              Text(
                landingFootNote,
                style: theme.textTheme.bodySmall?.copyWith(color: scheme.outline),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// ⚠️ **如实说**：现在没有安卓包。**不许假装开始下载**（不许转圈、不许"正在准备"）。
  void _android(BuildContext context) {
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text(landingAndroidNotYet)));
  }
}
