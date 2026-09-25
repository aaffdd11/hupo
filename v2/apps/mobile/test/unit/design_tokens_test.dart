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

  // ── P1-8（2026-09-24）：棘轮从「圆角」扩到**间距/尺寸** ──────────────
  //
  // ⚠️ **它不是"这些全是缺陷"**：装饰性的留白本来就允许写数字
  //   （D3/D3.5 管的是**装字的容器** —— 容器跟字算，不许夹住字）。
  //   这条棘轮管的是**别再涨**：同一屏上"三种卡片外观"那种毛病，
  //   正是从"顺手写个 12"一处一处攒出来的（本项目第一条纪律：数值只住 design.dart）。
  //
  // 基线 = 2026-09-24 实测：**161 处 / 25 个文件**；2026-09-25 把奥数题那一屏整个删掉
  // （它原来 2 处）⇒ **159 处 / 24 个文件**。只许少、不许多。
  const Map<String, int> dimBaseline = {
    'lib/screens/about_screen.dart': 4,
    'lib/screens/app_theme.dart': 2,
    'lib/screens/chat_screen.dart': 6,
    'lib/screens/discover_screen.dart': 3,
    'lib/screens/export_screen.dart': 7,
    'lib/screens/landing_screen.dart': 36,
    'lib/screens/login_screen.dart': 7,
    'lib/screens/model_key_screen.dart': 4,
    'lib/screens/settings_screen.dart': 1,
    'lib/screens/trash_screen.dart': 6,
    'lib/screens/waiting_screen.dart': 8,
    'lib/widgets/app_desktop.dart': 1,
    'lib/widgets/bubble_menu.dart': 2,
    'lib/widgets/bubbles.dart': 22,
    'lib/widgets/chat_floater.dart': 4,
    'lib/widgets/composer.dart': 14,
    'lib/widgets/key_form.dart': 4,
    'lib/widgets/mini_app_host.dart': 1,
    'lib/widgets/notice.dart': 6,
    'lib/widgets/page_header.dart': 1,
    'lib/widgets/plan_strip.dart': 4,
    'lib/widgets/process_level_menu.dart': 1,
    'lib/widgets/process_view.dart': 5,
    'lib/widgets/trash_plan_sheet.dart': 10
  };

  /// 一处"写死的间距/尺寸"长什么样（只数**数字字面量**；`d.gapM` 那种不算）。
  int hardcodedDims(String src) {
    final pats = <RegExp>[
      RegExp(r'EdgeInsets\.all\(\s*[0-9]'),
      RegExp(r'EdgeInsets\.symmetric\([^)]*?[a-zA-Z]+:\s*[0-9]'),
      RegExp(r'EdgeInsets\.fromLTRB\(\s*[0-9]'),
      RegExp(r'EdgeInsets\.only\([^)]*?[a-zA-Z]+:\s*[0-9]'),
      RegExp(r'SizedBox\(\s*height:\s*[0-9]'),
      RegExp(r'SizedBox\(\s*width:\s*[0-9]'),
    ];
    var n = 0;
    for (final r in pats) {
      n += r.allMatches(src).length;
    }
    return n;
  }

  test('★ P1-8 棘轮：写死的间距/尺寸只许少、不许多（基线 159 处）', () {
    final over = <String>[];
    var total = 0;
    for (final e in Directory('lib').listSync(recursive: true)) {
      if (e is! File || !e.path.endsWith('.dart')) continue;
      final rel = e.path.startsWith('./') ? e.path.substring(2) : e.path;
      final n = hardcodedDims(e.readAsStringSync());
      total += n;
      final cap = dimBaseline[rel] ?? 0;
      if (n > cap) over.add('$rel: $n > 上限 $cap');
    }
    expect(over, isEmpty,
        reason: '写死的间距/尺寸涨了：\n${over.join('\n')}\n'
            '（要用 d.gapS/gapM/gapL 或 design.dart 里那几档；确实该新增一档就先改 token）');
    expect(total, lessThanOrEqualTo(159),
        reason: '总处数从 159 涨到 $total —— 棘轮只许往下走');
  });

  test('P1-8 负向对照：这个计数**真的数得出来**（不是空转）', () {
    expect(hardcodedDims('padding: EdgeInsets.all(12)'), 1);
    expect(hardcodedDims('SizedBox(height: 8)'), 1);
    expect(hardcodedDims('padding: EdgeInsets.all(d.gapM)'), 0);
    expect(hardcodedDims('SizedBox(height: d.gapS)'), 0);
  });
}
