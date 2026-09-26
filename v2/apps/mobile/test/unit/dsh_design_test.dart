// DSH 设计底子（`lib/models/dsh_design.dart` · 研究 `docs/dev/115-DSH-WINDOW-PARITY.md`
// · 视觉规格 `docs/dev/115-raw/E-visual.md` / `A-layout.md` §4）。
//
// ⚠️ 这一份是**逐字对着 DSH 真包与那两张表**的判据（不是"看着差不多"）：
//   · 颜色对的是真包解出来的 hex（`dsh-client-ui-theme/lib/client.js` 的
//     `body{}` / `body[data-ds-dark-theme]{}`），格式统一成 `#rrggbb(aa)`；
//   · 字号/发丝线/行度量对的是 `A-layout.md` §4.3/§4.4 与 `E-visual.md` 的量表。
//
// 为什么值得这么"死"：DSH 的层次感**全靠这些差一点点**的数（发丝 0.5 不是 1、
// 亮色三层面全是纯白、品牌色是近黑不是蓝）。这些数一旦被"顺手调齐"，
// 屏幕上看不出是哪错了，只觉得"不像那个产品"。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/dsh_design.dart';

void main() {
  group('色板（亮 / 暗两套）', () {
    test('★ 底色与三个面：亮色三档**全是纯白**，暗色才分层', () {
      // E-visual.md §6 第 ① 条：亮色 `bg-layer-1/2/3` 全白，层次靠 0.5px 描边 + 柔光。
      expect(dshCssHex(DshPalette.light.bgBase), '#ffffff');
      expect(dshCssHex(DshPalette.light.bgLayer1), '#ffffff');
      expect(dshCssHex(DshPalette.light.bgLayer2), '#ffffff');
      expect(dshCssHex(DshPalette.light.bgLayer3), '#ffffff');

      expect(dshCssHex(DshPalette.dark.bgBase), '#151517');
      expect(dshCssHex(DshPalette.dark.bgLayer1), '#232324');
      expect(dshCssHex(DshPalette.dark.bgLayer2), '#2c2c2e');
      expect(dshCssHex(DshPalette.dark.bgLayer3), '#353638');
    });

    test('★ 四级描边：亮色半透明黑、暗色半透明白（不是灰）', () {
      expect(
        [
          DshPalette.light.borderL1,
          DshPalette.light.borderL2,
          DshPalette.light.borderL3,
          DshPalette.light.borderL4,
        ].map(dshCssHex),
        ['#0000000a', '#0000001a', '#0000001f', '#00000029'],
      );
      expect(
        [
          DshPalette.dark.borderL1,
          DshPalette.dark.borderL2,
          DshPalette.dark.borderL3,
          DshPalette.dark.borderL4,
        ].map(dshCssHex),
        // ⚠️ 最后一个是 DSH 写作 `#fff3` 的那个（= `#ffffff33`）。
        ['#ffffff0f', '#ffffff1f', '#ffffff29', '#ffffff33'],
      );
    });

    test('★ 文字五档（两套逐字）', () {
      expect(
        [
          DshPalette.light.labelPrimary,
          DshPalette.light.labelSecondary,
          DshPalette.light.labelTertiary,
          DshPalette.light.labelCaption,
          DshPalette.light.labelDimmed,
        ].map(dshCssHex),
        ['#0f1115', '#61666b', '#81858c', '#adb2b8', '#e1e5ee'],
      );
      expect(
        [
          DshPalette.dark.labelPrimary,
          DshPalette.dark.labelSecondary,
          DshPalette.dark.labelTertiary,
          DshPalette.dark.labelCaption,
          DshPalette.dark.labelDimmed,
        ].map(dshCssHex),
        ['#f9fafb', '#cfd3d6', '#adb2b8', '#81858c', '#43454a'],
      );
    });

    test('🔴 品牌色**不是蓝**（拿蓝色做主按钮会一眼就错）', () {
      expect(dshCssHex(DshPalette.light.brandPrimary), '#0f1115');
      expect(dshCssHex(DshPalette.dark.brandPrimary), '#f9fafb');
      // 真正的蓝是 state-business。
      expect(dshCssHex(DshPalette.light.stateBusiness), '#4176e6');
      expect(dshCssHex(DshPalette.dark.stateBusiness), '#679efe');
      expect(
        DshPalette.light.brandPrimary,
        isNot(DshPalette.light.stateBusiness),
        reason: '品牌色与业务蓝混了 —— 那是"一眼不像 DSH"的第一名',
      );
    });

    test('★ 状态三色：成功/警示亮暗同值，失败分档（**真包不是 Tailwind**）', () {
      // E-visual.md 的 State 表里 `#22c55e` / `#f59e0b` 两行都写着 identical。
      expect(dshCssHex(DshPalette.light.stateSuccess), '#22c55e');
      expect(dshCssHex(DshPalette.dark.stateSuccess), '#22c55e');
      expect(dshCssHex(DshPalette.light.stateWarn), '#f59e0b');
      expect(dshCssHex(DshPalette.dark.stateWarn), '#f59e0b');
      // 失败：DSH 自有的 red-600 / red-400。
      expect(dshCssHex(DshPalette.light.stateError), '#ec1313');
      expect(dshCssHex(DshPalette.dark.stateError), '#f25a5a');
    });

    test('负向对照：失败色**不是** Tailwind 那两个（免得下一个人"顺手改回去"）', () {
      expect(dshCssHex(DshPalette.light.stateError), isNot('#dc2626'));
      expect(dshCssHex(DshPalette.dark.stateError), isNot('#f87171'));
      expect(dshCssHex(DshPalette.dark.stateWarn), isNot('#fbbf24'));
    });

    test('★ 气泡 / 罩色 / 代码块 / 提示 / 滚动条 / 遮罩', () {
      expect(dshCssHex(DshPalette.light.specificBubble), '#edf3fe');
      expect(dshCssHex(DshPalette.dark.specificBubble), '#2c2c2e');
      expect(dshCssHex(DshPalette.light.interactiveBgHover), '#2631480f');
      expect(dshCssHex(DshPalette.dark.interactiveBgHover), '#ffffff14');
      expect(dshCssHex(DshPalette.light.markdownCodeBlock), '#f9fafb');
      expect(dshCssHex(DshPalette.dark.markdownCodeBlock), '#1b1b1c');
      expect(dshCssHex(DshPalette.light.tooltipBg), '#2c2c2e');
      expect(dshCssHex(DshPalette.dark.tooltipBg), '#43454a');
      expect(dshCssHex(DshPalette.light.scrollbar), '#e5e5e5');
      expect(dshCssHex(DshPalette.dark.scrollbar), '#3c3c3d');
      expect(dshCssHex(DshPalette.light.mask), '#0000003d');
      expect(dshCssHex(DshPalette.dark.mask), '#00000080');
    });

    test('🔴 没有一个是"圆整得像占位"的值（负向对照）', () {
      // 一批 token 逐个比"不是纯黑/纯白/整灰"——防的正是"先随便填一个回头再调"。
      final light = DshPalette.light;
      for (final c in [
        light.labelSecondary,
        light.labelTertiary,
        light.labelCaption,
        light.labelDimmed,
        light.stateBusiness,
        light.stateSuccess,
        light.stateWarn,
        light.stateError,
        light.specificBubble,
        light.tooltipBg,
      ]) {
        final hex = dshCssHex(c);
        expect(hex, isNot('#000000'), reason: '$hex 是纯黑占位');
        expect(hex, isNot('#ffffff'), reason: '$hex 是纯白占位');
        // `#333333` / `#666666` / `#999999` 那一类"灰得正好"的占位。
        final r = hex.substring(1, 3);
        final g = hex.substring(3, 5);
        final b = hex.substring(5, 7);
        expect(
          r == g && g == b,
          isFalse,
          reason: '$hex 是三通道相等的灰（DSH 的语义色一个都不是纯灰）',
        );
      }
    });

    test('dshCssHex 的写法：alpha 放在**后面**（CSS 顺序），不缩写', () {
      // DSH 表里写 `#2631480f`；`Color` 内部是 0x0f263148 —— 两者必须能对上。
      expect(dshCssHex(DshPalette.light.interactiveBgHover), '#2631480f');
      // 不透明时只给六位（不补 `ff`）。
      expect(dshCssHex(DshPalette.light.bgBase), '#ffffff');
      expect(dshCssHex(DshPalette.light.bgBase).length, 7);
      expect(dshCssHex(DshPalette.light.interactiveBgHover).length, 9);
    });

    test('挑色板的两个入口都对得上', () {
      expect(dshPalette(DshVariant.light), same(DshPalette.light));
      expect(dshPalette(DshVariant.dark), same(DshPalette.dark));
      expect(dshPaletteFor(dark: true), same(DshPalette.dark));
      expect(dshPaletteFor(dark: false), same(DshPalette.light));
      expect(DshVariant.dark.isDark, isTrue);
      expect(DshVariant.light.isDark, isFalse);
      expect(DshVariant.dark.palette, same(DshPalette.dark));
    });
  });

  group('发丝线', () {
    test('🔴 是 0.5，**永远不是 1.0**', () {
      expect(dshHairline, 0.5);
      expect(dshHairline, isNot(1.0));
      expect(dshHairline, lessThan(1.0));
    });
  });

  group('UI 字号阶梯（DSH `--dsw-font-*`）', () {
    test('★ 七个台阶逐字（含 `m` 那个"名字 18、值 16"的坑）', () {
      expect([DshTypes.xl24.size, DshTypes.xl24.weight, DshTypes.xl24.lineHeight], [24, 600, 32]);
      expect([DshTypes.l20.size, DshTypes.l20.weight, DshTypes.l20.lineHeight], [20, 500, 28]);
      expect([DshTypes.m.size, DshTypes.m.weight, DshTypes.m.lineHeight], [16, 500, 28],
          reason: '`--dsw-font-m-18` 的名字骗人：值是 16/28');
      expect([DshTypes.base.size, DshTypes.base.weight, DshTypes.base.lineHeight], [16, 400, 24]);
      expect([DshTypes.baseStrong.weight], [500]);
      expect([DshTypes.s.size, DshTypes.s.weight, DshTypes.s.lineHeight], [14, 400, 22]);
      expect([DshTypes.sStrong.weight], [500]);
      expect([DshTypes.xs.size, DshTypes.xs.weight, DshTypes.xs.lineHeight], [13, 400, 20]);
      expect([DshTypes.xsStrong.weight], [500]);
      expect([DshTypes.xxs.size, DshTypes.xxs.weight, DshTypes.xxs.lineHeight], [12, 400, 18]);
      expect([DshTypes.xxsStrong.weight], [500]);
    });

    test('负向对照：`m` 不是 18（别信 token 名字里的数）', () {
      expect(DshTypes.m.size, isNot(18));
    });

    test('markdown 正文那一段是 14/24（不是 UI 的 16/24）', () {
      expect(
        [DshTypes.contentBase.size, DshTypes.contentBase.weight, DshTypes.contentBase.lineHeight],
        [14, 400, 24],
      );
    });
  });

  group('内容字号轴（用户设置 12–17）', () {
    test('🔴 12→17 整张表（secondary = min(N-1, max(13, N-2))）', () {
      // 逐档抄 DSH 的那条 CSS，包括它在低档会算出**小于 13** 的二级字号这件事。
      const want = <int, (int, int, int)>{
        12: (11, -2, -2),
        13: (12, -1, -1),
        14: (13, 0, 0),
        15: (13, 1, 0),
        16: (14, 2, 1),
        17: (15, 3, 2),
      };
      want.forEach((size, expected) {
        final s = dshContentScale(size);
        expect(s.size, size, reason: '夹取把 $size 改了');
        expect(s.secondary, expected.$1, reason: '$size 的二级字号');
        expect(s.delta, expected.$2, reason: '$size 的 Δ');
        expect(s.secondaryDelta, expected.$3, reason: '$size 的 Δ₂');
      });
    });

    test('★ 默认是 14（Δ = 0），上下界就是 12 / 17', () {
      expect(dshContentFontSizeDefault, 14);
      expect(dshContentFontSizeMin, 12);
      expect(dshContentFontSizeMax, 17);
      final d = dshContentScale(null);
      expect(d.size, 14);
      expect(d.delta, 0);
      expect(d.secondary, 13);
      expect(d.secondaryDelta, 0);
    });

    test('🔴 坏值 / 越界：夹住或回默认，**绝不抛**', () {
      expect(dshContentScale(11).size, 12);
      expect(dshContentScale(0).size, 12);
      expect(dshContentScale(-5).size, 12);
      expect(dshContentScale(18).size, 17);
      expect(dshContentScale(999).size, 17);
      expect(dshContentScale('15').size, 14);
      expect(dshContentScale(true).size, 14);
      expect(dshContentScale(15.0).size, 15, reason: '整数值的 double 该认');
      expect(dshContentScale(15.5).size, 14, reason: '半个的 double 不认');
      expect(dshContentScale(double.nan).size, 14);
    });

    test('★ 每一行的字号/行高都从轴上来：`calc(Npx + Δ)`（字重不动）', () {
      final tall = dshContentScale(17); // Δ = 3
      final t = tall.at(DshTypes.s); // 14/22 + 3
      expect([t.size, t.lineHeight, t.weight], [17, 25, 400]);
      final strong = tall.at(DshTypes.sStrong);
      expect([strong.size, strong.lineHeight, strong.weight], [17, 25, 500]);
      // 二级台阶走 Δ₂（17 档的 Δ₂ 是 2）。
      final sec = tall.secondaryAt(DshTypes.xs); // 13/20 + 2
      expect([sec.size, sec.lineHeight], [15, 22]);
    });

    test('正文那一段就是 markdown-base 加 Δ', () {
      final s = dshContentScale(12); // Δ = -2
      expect([s.content.size, s.content.lineHeight], [12, 22]);
      expect(s.contentStrong.weight, 600);
    });
  });

  group('圆角 / 间距', () {
    test('★ 圆角那一套数都在（含胶囊），且语义名指对了', () {
      expect(
        [
          DshRadius.r2,
          DshRadius.r4,
          DshRadius.r6,
          DshRadius.r8,
          DshRadius.r10,
          DshRadius.r12,
          DshRadius.r14,
          DshRadius.r16,
          DshRadius.r18,
          DshRadius.r22,
          DshRadius.r24,
          DshRadius.r28,
          DshRadius.r32,
          DshRadius.pill,
        ],
        [2, 4, 6, 8, 10, 12, 14, 16, 18, 22, 24, 28, 32, 999],
      );
      expect(DshRadius.bubble, 22, reason: '用户气泡 / 输入卡 = 22');
      expect(DshRadius.button, 18, reason: '按钮 = 18');
    });

    test('★ 间距台阶 4/6/8/12/16/20/24/32，且从小到大', () {
      const steps = [
        DshSpace.s4,
        DshSpace.s6,
        DshSpace.s8,
        DshSpace.s12,
        DshSpace.s16,
        DshSpace.s20,
        DshSpace.s24,
        DshSpace.s32,
      ];
      expect(steps, [4, 6, 8, 12, 16, 20, 24, 32]);
      for (var i = 1; i < steps.length; i++) {
        expect(steps[i], greaterThan(steps[i - 1]));
      }
    });
  });

  group('聊天面的行度量（DSH 原文量）', () {
    test('★ 正文列宽 `max(680, min(列宽*0.64, 920))`', () {
      expect(dshContentWidth(1000), 680, reason: '1000*0.64=640 < 680 ⇒ 抬到下限');
      expect(dshContentWidth(1200), 768);
      expect(dshContentWidth(2000), 920, reason: '1280 > 920 ⇒ 压到上限');
      expect(dshContentWidth(0), 680, reason: '列宽还没量出来时不许给出 0 宽');
    });

    test('★ 用户气泡最大宽 `min(正文列*0.702, 可用宽*82%)`', () {
      final byContent = dshUserBubbleMaxWidth(contentWidth: 768, available: 2000);
      expect(byContent, closeTo(768 * 0.702, 0.001));
      final byAvailable = dshUserBubbleMaxWidth(contentWidth: 768, available: 600);
      expect(byAvailable, closeTo(600 * 0.82, 0.001));
    });

    test('★ 气泡的圆角与内边距就是 `22 / 10×16`', () {
      expect(dshUserBubbleRadius, 22);
      expect(dshUserBubblePaddingV, 10);
      expect(dshUserBubblePaddingH, 16);
    });

    test('★ 行距 16；折叠那一轮里答案离过程只有 8', () {
      expect(dshTranscriptRowGap, 16);
      expect(dshTranscriptAnswerGap, 8);
      expect(dshTranscriptAnswerGap, lessThan(dshTranscriptRowGap));
    });

    test('负向对照：16 不是 12 / 8 不是 16（免得被"顺手对齐"）', () {
      expect(dshTranscriptRowGap, isNot(12));
      expect(dshTranscriptAnswerGap, isNot(dshTranscriptRowGap));
    });
  });

  // ★ `116`（聊天气泡那一批新加的两行：系统提示词 / 工具行）：
  //   两块展开正文的**最高高度**。它们是"有界 ≠ 截断"那条规矩的落点
  //   （超了在框里滚，一个字都不许删）。
  group('有界正文那两档（DSH 的 max-height）', () {
    test('★ 系统提示词 141 · 工具行 260（照 DSH 真包量出来的）', () {
      expect(dshOpaqueBodyMaxHeight, 141);
      expect(dshToolBodyMaxHeight, 260);
    });

    test('负向对照：都是正的、而且**不是** 0 / 无限（有界才有意义）', () {
      for (final h in [dshOpaqueBodyMaxHeight, dshToolBodyMaxHeight]) {
        expect(h, greaterThan(0));
        expect(h.isFinite, isTrue);
        expect(h, isNot(double.infinity));
      }
      // 工具行的正文比系统提示词那块高（它装的是入参 + 输出两段）。
      expect(dshToolBodyMaxHeight, greaterThan(dshOpaqueBodyMaxHeight));
    });
  });
}
