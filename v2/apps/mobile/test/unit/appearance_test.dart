// **聊天窗口的外观与字号**（契约 `docs/dev/119-APPEARANCE-AND-FONT.md` §一）。
//
// ⚠️ 这一份钉两句话：
//   ① **token 与默认值与 DSH 逐字一致**（`light`/`dark`/`system`；12–17，默认 14）；
//   ② 🔴 **坏值一律退回默认，绝不抛**（它是本机盘上那个字符串，旧版本 / 别人改坏
//      都可能造成怪值 —— 坏掉的后果只许是"回到默认"，绝不能是打不开聊天）。
//
// 依据（逐字，不是猜的）：`docs/dev/115-raw/E-visual.md` §1.2
// （`THEME_PREFERENCES = ["light","dark","system"]` · `DEFAULT_PREFERENCE = "system"` ·
//  `FONT_SIZE_MIN = 12` · `FONT_SIZE_MAX = 17` · `DEFAULT_FONT_SIZE = 14` · `step(1)`）
// 与 `docs/dev/115-raw/A-layout.md` §470（*"Two settings only: color scheme +
// content font size (integer 12–17px, default 14px, stepper)"*）。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/appearance.dart';
import 'package:hupo_app/models/dsh_design.dart';

void main() {
  group('外观三档（身份与字）', () {
    test('★ 就三档，token 与屏幕上的字都不许漂（DSH 逐字）', () {
      expect(ChatAppearance.values.length, 3);
      expect(ChatAppearance.light.wire, 'light');
      expect(ChatAppearance.dark.wire, 'dark');
      expect(ChatAppearance.system.wire, 'system');
      expect(ChatAppearance.light.label, '亮');
      expect(ChatAppearance.dark.label, '暗');
      expect(ChatAppearance.system.label, '跟随系统');
    });

    test('★ 默认 = **跟随系统**（DSH `DEFAULT_PREFERENCE = "system"`，逐字）', () {
      expect(defaultChatAppearance, ChatAppearance.system);
      expect(const ChatAppearanceSettings().appearance, ChatAppearance.system);
    });

    test('认得出就照它来', () {
      expect(chatAppearanceOf('light'), ChatAppearance.light);
      expect(chatAppearanceOf('dark'), ChatAppearance.dark);
      expect(chatAppearanceOf('system'), ChatAppearance.system);
    });

    test('🔴 认不出来的 token ⇒ **跟随系统**（不抛、也不猜）', () {
      // 全部退回 `system` 的理由写在 `appearance.dart` 那个函数上：
      // `system` 是 DSH 的默认档，也是**唯一一个不会替用户拿主意**的档。
      for (final bad in <Object?>[
        null,
        '',
        'Dark',
        'LIGHT',
        ' dark',
        'dark ',
        'auto',
        7,
        true,
        <String>['dark'],
        <String, String>{'appearance': 'dark'},
      ]) {
        expect(
          chatAppearanceOf(bad),
          ChatAppearance.system,
          reason: '「$bad」被当成了一个外观档',
        );
      }
    });
  });

  group('字号 12–17（夹住 / 默认 14 / 绝不抛）', () {
    test('★ 区间里每一个数都原样收下', () {
      for (var n = dshContentFontSizeMin; n <= dshContentFontSizeMax; n += 1) {
        expect(chatFontSizeOf(n), n);
      }
    });

    test('默认档是 14，而且它就是 token 那一份默认（不是另写一个数）', () {
      expect(chatFontSizeOf(null), dshContentFontSizeDefault);
      expect(dshContentFontSizeDefault, 14);
      expect(chatFontSizeOf(''), dshContentFontSizeDefault);
    });

    test('🔴 越界 ⇒ 夹到 12 / 17（不是拒绝、也不是照抄）', () {
      expect(chatFontSizeOf(0), dshContentFontSizeMin);
      expect(chatFontSizeOf(11), dshContentFontSizeMin);
      expect(chatFontSizeOf(-99), dshContentFontSizeMin);
      expect(chatFontSizeOf(18), dshContentFontSizeMax);
      expect(chatFontSizeOf(1000), dshContentFontSizeMax);
      expect(chatFontSizeOf('11'), dshContentFontSizeMin);
      expect(chatFontSizeOf('99'), dshContentFontSizeMax);
    });

    test('🔴 非整数 / 垃圾 / 别的类型 ⇒ 默认档（绝不抛、也不四舍五入）', () {
      for (final bad in <Object>[
        14.5,
        13.0001,
        double.nan,
        double.infinity,
        double.negativeInfinity,
        '14.5',
        '15px',
        'abc',
        '十四',
        true,
        <int>[15],
        <String, int>{'fontSize': 15},
      ]) {
        expect(
          chatFontSizeOf(bad),
          dshContentFontSizeDefault,
          reason: '「$bad」被当成了一个字号',
        );
      }
    });

    test('整数 double 是合法的（`15.0` ⇒ 15，盘上/JSON 里很常见）', () {
      expect(chatFontSizeOf(15.0), 15);
      expect(chatFontSizeOf('15'), 15);
      // ⚠️ 前后空白是 `int.tryParse` 自己的口径（数字一个不少）⇒ 照收；
      //    多出来的**字**（`'15px'`）才回默认档 —— 那条在上面那个反例里。
      expect(chatFontSizeOf('15 '), 15);
      expect(chatFontSizeOf(' 15'), 15);
    });
  });

  group('把偏好解成具体色板（`system` 对着设备亮度解）', () {
    test('亮 / 暗：**不管设备是什么亮度**都照用户选的来', () {
      const light = ChatAppearanceSettings(appearance: ChatAppearance.light);
      const dark = ChatAppearanceSettings(appearance: ChatAppearance.dark);
      expect(light.resolve(platformDark: false), DshVariant.light);
      expect(light.resolve(platformDark: true), DshVariant.light);
      expect(dark.resolve(platformDark: false), DshVariant.dark);
      expect(dark.resolve(platformDark: true), DshVariant.dark);
    });

    test('跟随系统：设备暗就暗、设备亮就亮（DSH 那三行逐字）', () {
      const sys = ChatAppearanceSettings();
      expect(sys.resolve(platformDark: false), DshVariant.light);
      expect(sys.resolve(platformDark: true), DshVariant.dark);
    });

    test('解出来的色板**真的换了一份**（不是只有枚举变了）', () {
      const s = ChatAppearanceSettings();
      expect(s.resolve(platformDark: false).palette, DshPalette.light);
      expect(s.resolve(platformDark: true).palette, DshPalette.dark);
    });
  });

  group('字号那条轴（`DshContentScale` 是**推出来**的，不是另存一份）', () {
    test('★ 14 档：Δ=0、二级 13（这时屏幕上与改前逐像素相同）', () {
      final s = dshContentScale(ChatAppearanceSettings().fontSize);
      expect(s.size, 14);
      expect(s.secondary, 13);
      expect(s.delta, 0);
      expect(s.secondaryDelta, 0);
      expect(s.content.size, DshTypes.contentBase.size);
      expect(s.content.lineHeight, DshTypes.contentBase.lineHeight);
    });

    test('★ 12 档：Δ=-2，二级按 DSH 那条 `min(N-1, max(13, N-2))` = 11', () {
      final s = const ChatAppearanceSettings(fontSize: 12).scale;
      expect(s.size, 12);
      expect(s.secondary, 11);
      expect(s.delta, -2);
      expect(s.secondaryDelta, -2);
      expect(s.content.size, 12);
      expect(s.content.lineHeight, 22);
    });

    test('★ 17 档：Δ=+3，二级 = 15、Δ₂ = +2', () {
      final s = const ChatAppearanceSettings(fontSize: 17).scale;
      expect(s.size, 17);
      expect(s.secondary, 15);
      expect(s.delta, 3);
      expect(s.secondaryDelta, 2);
      expect(s.content.size, 17);
      expect(s.content.lineHeight, 27);
    });

    test('🔴 `scale` 走的是**夹过**的值：坏字号那一条轴上也是合法的', () {
      // `ChatAppearanceSettings` 只保证"值是夹过的" —— 直接拿坏值构不出来，
      // 所以这里走**盘上那条路**（`chatAppearanceSettingsOf`）验一遍。
      final s = chatAppearanceSettingsOf('dark|999').scale;
      expect(s.size, dshContentFontSizeMax);
      final t = chatAppearanceSettingsOf('dark|-1').scale;
      expect(t.size, dshContentFontSizeMin);
    });
  });

  group('盘上那个字符串（`"<wire>|<字号>"`）', () {
    test('★ 存了再读：两样都对得上（三档 × 三个字号）', () {
      for (final a in ChatAppearance.values) {
        for (final n in [12, 14, 17]) {
          final s = ChatAppearanceSettings(appearance: a, fontSize: n);
          final back = chatAppearanceSettingsOf(chatAppearanceSettingsWire(s));
          expect(back, s, reason: '${a.wire}|$n 丢了');
          expect(back.appearance, a);
          expect(back.fontSize, n);
        }
      }
    });

    test('★ 编码就是那两个 token 拼起来（不是 JSON、也不含别的）', () {
      expect(
        chatAppearanceSettingsWire(
          const ChatAppearanceSettings(appearance: ChatAppearance.dark, fontSize: 16),
        ),
        'dark|16',
      );
      expect(chatAppearanceSettingsWire(const ChatAppearanceSettings()), 'system|14');
    });

    test('🔴 两个轴**各退各的**：一半坏了不许把另一半也丢掉', () {
      // 用户刚选的"暗"不该因为字号那一格脏了就白选。
      final a = chatAppearanceSettingsOf('dark|坏了');
      expect(a.appearance, ChatAppearance.dark);
      expect(a.fontSize, dshContentFontSizeDefault);
      // 反过来也一样：外观认不出，字号照收。
      final b = chatAppearanceSettingsOf('DARK|16');
      expect(b.appearance, defaultChatAppearance);
      expect(b.fontSize, 16);
    });

    test('🔴 整个串是垃圾 / 别的类型 ⇒ 两份都是默认，绝不抛', () {
      for (final bad in <Object?>[
        null,
        '',
        '|',
        7,
        true,
        <String>['dark', '15'],
        <String, Object>{'a': 'dark'},
      ]) {
        final s = chatAppearanceSettingsOf(bad);
        expect(s.appearance, defaultChatAppearance, reason: '「$bad」的外观不是默认');
        expect(s.fontSize, dshContentFontSizeDefault, reason: '「$bad」的字号不是默认');
      }
    });

    test('少一半 ⇒ 少的那一半走默认（另一半照收）', () {
      final a = chatAppearanceSettingsOf('dark');
      expect(a.appearance, ChatAppearance.dark);
      expect(a.fontSize, dshContentFontSizeDefault);
      final b = chatAppearanceSettingsOf('|15');
      expect(b.appearance, defaultChatAppearance);
      expect(b.fontSize, 15);
    });

    test('多出来的那一段忽略（旧版本多写了一个字段也读得回来）', () {
      final s = chatAppearanceSettingsOf('light|15|extra');
      expect(s.appearance, ChatAppearance.light);
      expect(s.fontSize, 15);
    });
  });

  group('值类（一个设置、一条 scope 往下传）', () {
    test('`copyWith` 只换说的那一半', () {
      const s = ChatAppearanceSettings(appearance: ChatAppearance.dark, fontSize: 16);
      expect(s.copyWith(appearance: ChatAppearance.light).fontSize, 16);
      expect(s.copyWith(fontSize: 12).appearance, ChatAppearance.dark);
      expect(s.copyWith(), s);
    });

    test('相等按两样算（`AppearanceScope` 靠它决定要不要重建）', () {
      expect(
        const ChatAppearanceSettings(appearance: ChatAppearance.dark, fontSize: 15),
        const ChatAppearanceSettings(appearance: ChatAppearance.dark, fontSize: 15),
      );
      expect(
        const ChatAppearanceSettings(appearance: ChatAppearance.dark, fontSize: 15),
        isNot(const ChatAppearanceSettings(appearance: ChatAppearance.dark, fontSize: 16)),
      );
      expect(
        const ChatAppearanceSettings(appearance: ChatAppearance.dark),
        isNot(const ChatAppearanceSettings(appearance: ChatAppearance.light)),
      );
    });
  });
}
