// **一套外观只有这一个出处**（契约 `docs/dev/49-STYLE.md` · `docs/dev/72-UI-PASS.md` 的 E）。
//
// 这一份是**棘轮**：`lib/` 里写死的圆角**只许减、不许增**。
//
// 为什么值得一条判据：同一屏上"三种卡片外观"那种毛病，**不是一次大的错**，
// 而是一次一次"顺手写一个 14"攒出来的 —— 攒到后来谁也说不清哪一档是哪一档。
// 真刺：2026-09-23 审计时数出来 14（气泡×2）、12（通知卡）、8（导出框）、
// 以及 Material 自带的两个色（`secondaryContainer` / `outlineVariant`）——
// 全站就那一处不在我们自己的色板里，混在别的卡片中间一眼看得出不是一套。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;

/// 允许留着的那几处（**不是"还没改"，是"本来就不是界面卡片"**）：
///   · `landing_screen.dart` —— 首页那幅**画**（手机壳 26、细条 3/4、卡 18、小标 11）
///     那是插画自己的形状，不是我们这套卡片的圆角；
///   · `chat_floater.dart` —— 抓手那颗 **4px 高的小条**（比最小的 token 还小）。
const Map<String, int> allow = {
  'lib/screens/landing_screen.dart': 6,
  'lib/widgets/chat_floater.dart': 1,
};

/// 扫出来的结果：文件 → 写死圆角的处数。
Map<String, int> scan(String root) {
  final out = <String, int>{};
  final re = RegExp(r'BorderRadius\.circular\(\s*[0-9]');
  for (final e in Directory(root).listSync(recursive: true)) {
    if (e is! File || !e.path.endsWith('.dart')) continue;
    final rel = e.path.replaceFirst(RegExp(r'^.*/lib/'), 'lib/');
    final n = re.allMatches(e.readAsStringSync()).length;
    if (n > 0) out[rel] = n;
  }
  return out;
}

void main() {
  test('🔴 棘轮：写死的圆角只许少、不许多（数值只住 design.dart）', () {
    final found = scan('lib');
    for (final entry in found.entries) {
      final cap = allow[entry.key] ?? 0;
      expect(
        entry.value,
        lessThanOrEqualTo(cap),
        reason:
            '${entry.key} 里有 ${entry.value} 处写死的圆角（上限 $cap）—— '
            '圆角只许用 design.dart 里那三档（radiusCard / radiusField / radiusChip）',
      );
    }
  });

  test('负向对照：这条扫描**真的抓得住**（不是空转）', () {
    final re = RegExp(r'BorderRadius\.circular\(\s*[0-9]');
    expect(re.hasMatch('borderRadius: BorderRadius.circular(14)'), isTrue);
    expect(re.hasMatch('borderRadius: BorderRadius.circular(d.radiusField)'), isFalse);
  });

  test('那三档还在，而且是**从大到小**（大块 / 输入框 / 小方块）', () {
    expect(d.radiusCard, greaterThan(d.radiusField));
    expect(d.radiusField, greaterThan(d.radiusChip));
  });
}
