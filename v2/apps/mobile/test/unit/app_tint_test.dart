// **小程序图标那一格的底色**（契约 `docs/dev/132-ICON-TINT-AND-BAR.md`。
//   主人 2026-09-29：*"所有小程序的icon都需要一个背景颜色。不同的背景颜色。"*）。
//
// 纯逻辑（`models/app_tint.dart`）：住在 VM 上直接量。
//
// ⚠️ 这一份**不钉"两两不同"** —— 主人当场选的是"**按 app 的身份算**"，
//    那一条的代价就是"两个 app 可能撞成同一个颜色"（他自己认下的）。
//    钉的是：**同一个身份永远同色**（换位置/前后加东西都不变）。
//    ⚠️ 唯一钉死的"不同"是**桌面第一眼那三个内置的**（设置/发现/我自己那台）：
//       它们永远同时在屏幕上，撞色了就是一眼看得见的毛病。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/app_spec.dart';
import 'package:hupo_app/models/app_tint.dart';
import 'package:hupo_app/models/design.dart' as d;

void main() {
  test('① 同一个身份**永远**同一个色（换多少次、在哪儿问都一样）', () {
    for (final id in ['settings', 'mine:dice', 'mine:aoshu-bank', '一个中文名']) {
      final a = appTintFor(id);
      expect(appTintFor(id), a, reason: '$id 两次问出来不是一个色');
      // 这一条钉的是"不按位置算"：同一个 id 与它在桌面上排第几无关
      expect(appTintFor(String.fromCharCodes(id.codeUnits)), a);
    }
  });

  test('② 每一格**都有底**：认不出来的名字 / 空串也给得出一个色（不是透明）', () {
    for (final key in ['', '  ', '???', '一个从来没见过的名字']) {
      final c = appTintFor(key);
      expect(appTints.contains(c), isTrue, reason: '$key 拿到的色不在调色板里');
      expect(c.a, 1.0, reason: '$key 的底色是半透明的 —— 桌面上会看出"没底"');
    }
  });

  test('③ 🔴 桌面第一眼那两格（设置 / 发现）**互不同色**', () {
    // ⚠️ 2026-10-06：内置那三格变两格（「我自己那台」删了）—— 这一条跟着改成两格。
    final set = {
      appTintFor(builtInSettingsId),
      appTintFor(builtInDiscoverId),
    };
    expect(set.length, 2, reason: '两个内置的撞色了 —— 它们永远同时出现在桌面上，一眼看得见');
  });

  test('④ 底色那一族都够浅：**墨色**（`d.ink`）压上去读得出来', () {
    // ⚠️ 这是"图标还是墨色画的"那条规矩唯一能自动量的一半：
    //    亮度差（相对亮度）够大。数值门槛住这一份（它是判据，不是产品参数）。
    for (final c in appTints) {
      expect(c.computeLuminance(), greaterThan(0.35),
          reason: '$c 太深了 —— 墨色的图标压上去读不出来（见 app_tint.dart 文件头 ②）');
      expect(
        c.computeLuminance() - d.ink.computeLuminance(),
        greaterThan(0.3),
        reason: '$c 与墨色的对比不够',
      );
    }
  });

  test('④·补 🔴 **够鲜**（主人 2026-09-29："app颜色我想用明亮一点的色系"）', () {
    // ⚠️ 这是**棘轮**：第一版那一族是"暖、浅、低饱和"（饱和度只有 0.10–0.30，看着发灰），
    //    主人看过真机之后要"明亮一点" ⇒ 下限钉在这儿，别悄悄滑回"灰扑扑"。
    //    门槛住这一份（判据不是产品参数）；**字体色仍是墨色**（上面那条亮度判据管着）。
    for (final c in appTints) {
      final sat = HSVColor.fromColor(c).saturation;
      expect(sat, greaterThanOrEqualTo(0.40),
          reason: '$c 的饱和度只有 ${sat.toStringAsFixed(2)} —— 又滑回"发灰"那一族了');
    }
  });

  test('⑤ 调色板**够用**（别只有两三种，那等于没分颜色）', () {
    expect(appTints.toSet().length, appTints.length, reason: '调色板里有重复的色');
    expect(appTints.length, greaterThanOrEqualTo(8));
  });
}
