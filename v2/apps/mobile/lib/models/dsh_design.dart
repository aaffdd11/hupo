// **DSH 那一套设计 token，照搬到我们的聊天面上**（研究 `docs/dev/115-DSH-WINDOW-PARITY.md`
// · 视觉规格书 `docs/dev/115-raw/E-visual.md` · 布局 `A-layout.md` §4）。
//
// ── 为什么要有它 ──────────────────────────────────────────
// 主人 2026-09-26：*"聊天窗口，长得几乎跟 dsh 的窗口一样"*。DSH 的配色/字号/圆角
// **不是随手调的**，是三层 token（`--dsw-static-*` 原色板 → `--dsw-alias-*` 语义
// → `--dsh-*` 运行时）。我们照抄它，就得**先把那层 token 落成代码**——
// 否则界面里会到处是"顺手写一个 #fff / 写死 14px"，而"同一份数字写两处 = 一定会漂"
// 是这个项目的老毛病（`models/design.dart` 那一段就是为它写的）。
//
// ⚠️ **数值只住在这里**（和 `design.dart` 同一条纪律）：颜色、字号、圆角、间距、
//    行度量。别处一律 `import` 它，不许再抄一遍。
//
// ⚠️ **不 import `package:flutter/material.dart`**（楼层闸 `test/unit/import_rules_test.dart`：
//    `models` 是纯逻辑层，不许碰 UI）。这里只用 `dart:ui` 的 `Color`（一个纯值类型）
//    —— 和 `design.dart` 的 import 方式**逐字一致**。
//
// ⚠️ 和 `design.dart` 的关系：那个文件是**旧的暖白纸感**（首页/登录/设置那几屏还在用），
//    这一份是**聊天窗口这一批**要换过去的新底子。**两个都在**，不是要立刻删旧的
//    （换屏是一屏一屏来的；`design.dart` 的棘轮 `design_tokens_test.dart` 会看着我们
//    别在界面里写死圆角/尺寸 —— 这一份**一个 `BorderRadius.circular(` 都没写**，正是为它）。
//
// ── 数值是哪来的（**不是猜的**）────────────────────────────
// 真包：`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`
//   里的 `body{…}`（亮）与 `body[data-ds-dark-theme]{…}`（暗）两段别名表，
//   逐条解掉 `var(--dsw-static-*)` 之后的值。与 `E-visual.md` 的表对过，一致。
//
// ⚠️ **三处与派活单上写的近似值不一样，我们按真包来**（判据也照真包断言）：
//   · **失败**：DSH 用的是自有的 `red-600 = #ec1313`（暗 = `red-400 = #f25a5a`），
//     **不是** Tailwind 的 `#dc2626` / `#f87171`；
//   · **警示**：亮暗**同值**，都是 `amber-500 = #f59e0b`（DSH 暗色档没换成 `#fbbf24`）；
//   · **成功**：亮暗**同值**，都是 `green-500 = #22c55e`（`green-400 = #4ed17e` 是它的
//     secondary 档，不是暗色主档 —— `E-visual.md` 的 State 表那两行写着 **identical**）。
//   ⇒ 这三条如果照派活单的值改，屏幕上会比 DSH **更接近 Tailwind、更不像 DSH**。
//
// ⚠️ 还有一条**故意不做**的：DSH 的 `label-primary-dimmed`（`#151517`/`#ebeef2`）不是
//    我们要的那个"淡"字色；我们要的是它另一个 token `label-dimmed`（`#e1e5ee`/`#43454a`,
//    派活单给的就是这个）。这里 [DshPalette.labelDimmed] 取的是**后者**。

import 'dart:math' show max, min;
import 'dart:ui' show Color;

/// 亮 / 暗。**我们自己的**枚举 —— `models` 不许 import `material` 的 `Brightness`。
///
/// DSH 那边没有枚举，只有一个布尔：`body[data-ds-dark-theme]` 这个属性在 = 暗色。
/// 这里用枚举是为了让调用处**写不出**第三个值，也读不出 `true/false` 那种没名字的东西。
enum DshVariant {
  light,
  dark;

  bool get isDark => this == DshVariant.dark;

  /// 这一档的色板。
  DshPalette get palette => this == DshVariant.dark ? DshPalette.dark : DshPalette.light;
}

/// 一套语义色（DSH `--dsw-alias-*`）。
///
/// 每个字段的注释里写了它在 DSH 那边叫什么、亮/暗各是什么 —— 这样下一个人
/// 要核对时**不用再去解那个 90KB 的 bundle**。
class DshPalette {
  const DshPalette({
    required this.bgBase,
    required this.bgLayer1,
    required this.bgLayer2,
    required this.bgLayer3,
    required this.borderL1,
    required this.borderL2,
    required this.borderL3,
    required this.borderL4,
    required this.labelPrimary,
    required this.labelSecondary,
    required this.labelTertiary,
    required this.labelCaption,
    required this.labelDimmed,
    required this.brandPrimary,
    required this.stateBusiness,
    required this.stateSuccess,
    required this.stateWarn,
    required this.stateError,
    required this.interactiveBgHover,
    required this.specificBubble,
    required this.markdownCodeBlock,
    required this.tooltipBg,
    required this.scrollbar,
    required this.scrollbarHover,
    required this.mask,
    required this.maskSoft,
    required this.maskStrong,
  });

  /// 应用底（DSH `bg-base`）。
  final Color bgBase;

  /// 抬起来的三个面（DSH `bg-layer-1/2/3`）。
  ///
  /// 🔴 **亮色三档全是纯白** —— 层次**只靠 0.5px 描边 + 柔光阴影**，不靠底色差。
  ///    这是最容易做错的一条（"以为亮色要灰一点才分得出层"）；见 `E-visual.md` §6 第 ① 条。
  final Color bgLayer1;
  final Color bgLayer2;
  final Color bgLayer3;

  /// 四级描边（DSH `border-l1..l4`）。
  ///
  /// ⚠️ 它们是**半透明黑/白**，不是灰 —— 压在什么底上就带一点那个底的颜色。
  ///    画在 Flutter 里要么用 0.5 逻辑像素的 `stroke`，要么当 `border` 用（见 [dshHairline]）。
  final Color borderL1;
  final Color borderL2;
  final Color borderL3;
  final Color borderL4;

  /// 文字五档（DSH `label-primary/secondary/tertiary/caption/dimmed`）。
  final Color labelPrimary;
  final Color labelSecondary;
  final Color labelTertiary;
  final Color labelCaption;
  final Color labelDimmed;

  /// 品牌色（DSH `brand-primary`）。
  ///
  /// 🔴 **它不是蓝**：亮色近黑 `#0f1115`、暗色近白 `#f9fafb`。
  ///    真正的蓝是 [stateBusiness]。**拿蓝色做主按钮会一眼就错**（`115-DSH-WINDOW-PARITY.md` §一.7 ②）。
  final Color brandPrimary;

  /// 业务蓝（DSH `state-business-primary`）：链接、选中、进行中。
  final Color stateBusiness;

  /// 成功（DSH `state-success-primary`）。
  final Color stateSuccess;

  /// 警示（DSH `state-warn-primary`）。
  final Color stateWarn;

  /// 失败（DSH `state-error-primary`）。
  final Color stateError;

  /// 悬停/选中的那一层罩色（DSH `interactive-bg-hover`，半透明）。
  final Color interactiveBgHover;

  /// **用户那条气泡的底色**（DSH `specific-bubble`）。
  final Color specificBubble;

  /// Markdown 代码块底（DSH `markdown-code-block`）。
  final Color markdownCodeBlock;

  /// 气泡提示底（DSH `tooltip-bg`）。
  final Color tooltipBg;

  /// 滚动条滑块（DSH `scrollbar-bg-l1`）。
  final Color scrollbar;

  /// 滚动条悬停（DSH `scrollbar-hover-l1`）。
  final Color scrollbarHover;

  /// 遮罩（DSH `bg-mask-1`；[maskSoft] = `bg-mask-2`，[maskStrong] = `bg-mask-3`）。
  final Color mask;
  final Color maskSoft;
  final Color maskStrong;

  /// 亮色（DSH 的 `body{}`）。
  static const DshPalette light = DshPalette(
    bgBase: Color(0xFFFFFFFF), // #fff
    bgLayer1: Color(0xFFFFFFFF), // #fff（对，三档都是纯白）
    bgLayer2: Color(0xFFFFFFFF), // #fff
    bgLayer3: Color(0xFFFFFFFF), // #fff
    borderL1: Color(0x0A000000), // #0000000a
    borderL2: Color(0x1A000000), // #0000001a
    borderL3: Color(0x1F000000), // #0000001f
    borderL4: Color(0x29000000), // #00000029
    labelPrimary: Color(0xFF0F1115), // #0f1115
    labelSecondary: Color(0xFF61666B), // #61666b
    labelTertiary: Color(0xFF81858C), // #81858c
    labelCaption: Color(0xFFADB2B8), // #adb2b8
    labelDimmed: Color(0xFFE1E5EE), // #e1e5ee（是 label-dimmed，不是 label-primary-dimmed）
    brandPrimary: Color(0xFF0F1115), // #0f1115（近黑，不是蓝）
    stateBusiness: Color(0xFF4176E6), // deepseek-500 #4176e6
    stateSuccess: Color(0xFF22C55E), // green-500 #22c55e
    stateWarn: Color(0xFFF59E0B), // amber-500 #f59e0b
    stateError: Color(0xFFEC1313), // red-600 #ec1313（不是 #dc2626）
    interactiveBgHover: Color(0x0F263148), // #2631480f
    specificBubble: Color(0xFFEDF3FE), // deepseek-50 #edf3fe
    markdownCodeBlock: Color(0xFFF9FAFB), // bluish-50 #f9fafb
    tooltipBg: Color(0xFF2C2C2E), // bluish-850 #2c2c2e
    scrollbar: Color(0xFFE5E5E5), // neutral-200 #e5e5e5
    scrollbarHover: Color(0xFFD4D4D4), // neutral-300 #d4d4d4
    mask: Color(0x3D000000), // #0000003d
    maskSoft: Color(0x1F000000), // #0000001f
    maskStrong: Color(0x7A000000), // #0000007a
  );

  /// 暗色（DSH 的 `body[data-ds-dark-theme]`）。
  static const DshPalette dark = DshPalette(
    bgBase: Color(0xFF151517), // bluish-950 #151517
    bgLayer1: Color(0xFF232324), // bluish-875 #232324
    bgLayer2: Color(0xFF2C2C2E), // bluish-850 #2c2c2e
    bgLayer3: Color(0xFF353638), // bluish-800 #353638
    borderL1: Color(0x0FFFFFFF), // #ffffff0f
    borderL2: Color(0x1FFFFFFF), // #ffffff1f
    borderL3: Color(0x29FFFFFF), // #ffffff29
    borderL4: Color(0x33FFFFFF), // #fff3（= #ffffff33）
    labelPrimary: Color(0xFFF9FAFB), // bluish-50 #f9fafb
    labelSecondary: Color(0xFFCFD3D6), // bluish-300 #cfd3d6
    labelTertiary: Color(0xFFADB2B8), // bluish-400 #adb2b8
    labelCaption: Color(0xFF81858C), // bluish-600 #81858c
    labelDimmed: Color(0xFF43454A), // bluish-750 #43454a
    brandPrimary: Color(0xFFF9FAFB), // #f9fafb（近白）
    stateBusiness: Color(0xFF679EFE), // deepseek-400 #679efe
    stateSuccess: Color(0xFF22C55E), // green-500 #22c55e（暗色**同值**）
    stateWarn: Color(0xFFF59E0B), // amber-500 #f59e0b（暗色**同值**）
    stateError: Color(0xFFF25A5A), // red-400 #f25a5a（不是 #f87171）
    interactiveBgHover: Color(0x14FFFFFF), // #ffffff14
    specificBubble: Color(0xFF2C2C2E), // #2c2c2e
    markdownCodeBlock: Color(0xFF1B1B1C), // bluish-900 #1b1b1c
    tooltipBg: Color(0xFF43454A), // bluish-750 #43454a
    scrollbar: Color(0xFF3C3C3D), // neutral-700 #3c3c3d
    scrollbarHover: Color(0xFF545557), // neutral-600 #545557
    mask: Color(0x80000000), // #00000080
    maskSoft: Color(0x33000000), // #0003（= #00000033）
    maskStrong: Color(0x7A000000), // #0000007a
  );
}

/// 挑色板（从枚举）。
DshPalette dshPalette(DshVariant variant) => variant.palette;

/// 挑色板（从一个布尔）—— 给"本机存的就是一个 bool"那种调用处用。
DshPalette dshPaletteFor({required bool dark}) =>
    dark ? DshPalette.dark : DshPalette.light;

/// 把一个颜色写成 **DSH 表格里那种写法**：`#rrggbb`，带透明度时 `#rrggbbaa`（CSS 顺序）。
///
/// ⚠️ 为什么要它：`Color` 的 `toString()` 是 `Color(0x0f263148)`，而 DSH 的表里写的是
///    `#2631480f`（**alpha 在后**）。判据要"逐字对着 DSH 的表比"，就得有这一层翻译。
///    （DSH 自己会把 `#ffffff` 缩写成 `#fff`、把 `#ffffff33` 缩写成 `#fff3`；
///      这里一律给**不缩写的**形式 —— 同一支颜色的规范写法，只此一种。）
String dshCssHex(Color c) {
  final argb = c.toARGB32();
  final a = (argb >> 24) & 0xFF;
  final r = (argb >> 16) & 0xFF;
  final g = (argb >> 8) & 0xFF;
  final b = argb & 0xFF;
  String two(int v) => v.toRadixString(16).padLeft(2, '0');
  final rgb = '#${two(r)}${two(g)}${two(b)}';
  return a == 0xFF ? rgb : '$rgb${two(a)}';
}

// ── 尺寸 ────────────────────────────────────────────────────────
//
/// **发丝线 = 0.5 逻辑像素**（DSH `--dsw-elevation-stroke: 0 0 0 .5px <borderL4>`）。
///
/// 🔴 **不许改成 1.0**。DSH 的层次感有一半来自"线细到几乎看不见、但压得住边界"；
///    1.0 的线在 2x 屏上就是一条实心灰边，整块面立刻变"表格"而不是"浮起来"。
/// ⚠️ 而且它**是描边（stroke），不是 border**：`A-layout.md` §4.4 原话
///    *"the 'hairline' is a 0.5px stroke, not a border"* —— Flutter 里对应
///    `BorderSide(width: dshHairline)`，别用 `Container` 的 1px 边框去凑。
const double dshHairline = 0.5;

/// 一段文字的三个数：字号 / 字重 / 行高（DSH 每个 `--dsw-font-*` 都有这三个兄弟）。
class DshType {
  const DshType({required this.size, required this.weight, required this.lineHeight});

  /// 字号（逻辑像素）。
  final double size;

  /// 字重（DSH 只用到 400/500/600/700）。界面层再翻成 `FontWeight`。
  final int weight;

  /// 行高（逻辑像素，DSH 用的是**绝对行高**，不是倍数）。
  final double lineHeight;
}

/// UI 字号阶梯（DSH `--dsw-font-*`，`A-layout.md` §4.3 全表）。
///
/// ⚠️ 命名里的数是 **DSH token 的名字**，不是值 —— 最坑的一个是 `m`：
///    它叫 `--dsw-font-m-18`，**值却是 16/28**（`A-layout.md` 专门记了这条，
///    `E-visual.md` §6 也点名"别信 token 后缀里的数字"）。
abstract final class DshTypes {
  /// `--dsw-font-xl-24`：600 24/32。
  static const DshType xl24 = DshType(size: 24, weight: 600, lineHeight: 32);

  /// `--dsw-font-l-20`：500 20/28。
  static const DshType l20 = DshType(size: 20, weight: 500, lineHeight: 28);

  /// `--dsw-font-m-18`：500 **16**/28（名字里的 18 是骗人的）。
  static const DshType m = DshType(size: 16, weight: 500, lineHeight: 28);

  /// `--dsw-font-base-16`：400 16/24。
  static const DshType base = DshType(size: 16, weight: 400, lineHeight: 24);

  /// `--dsw-font-base-strong-16`：500 16/24。
  static const DshType baseStrong = DshType(size: 16, weight: 500, lineHeight: 24);

  /// `--dsw-font-s-14`：400 14/22。
  static const DshType s = DshType(size: 14, weight: 400, lineHeight: 22);

  /// `--dsw-font-s-strong-14`：500 14/22。
  static const DshType sStrong = DshType(size: 14, weight: 500, lineHeight: 22);

  /// `--dsw-font-xs-13`：400 13/20。
  static const DshType xs = DshType(size: 13, weight: 400, lineHeight: 20);

  /// `--dsw-font-xs-strong-13`：500 13/20。
  static const DshType xsStrong = DshType(size: 13, weight: 500, lineHeight: 20);

  /// `--dsw-font-xxs-12`：400 12/18。
  static const DshType xxs = DshType(size: 12, weight: 400, lineHeight: 18);

  /// `--dsw-font-xxs-strong-12`：500 12/18。
  static const DshType xxsStrong = DshType(size: 12, weight: 500, lineHeight: 18);

  /// **正文的底**：DSH `--dsw-font-markdown-base` = 400 `calc(14px + Δ)` / `calc(24px + Δ)`。
  ///
  /// ⚠️ 它的字号与行高**都带 Δ**（用户那个 12–17 的设置）—— 拿 [content] 去算，
  ///    别直接用它。它单独列出来是因为 markdown 正文和 UI 正文（16/24）是两套。
  static const DshType contentBase = DshType(size: 14, weight: 400, lineHeight: 24);

  /// markdown 正文加粗：DSH `--dsw-font-markdown-base-strong` = 600 `calc(14px + Δ)`。
  static const DshType contentBaseStrong = DshType(size: 14, weight: 600, lineHeight: 24);
}

// ── 内容字号轴（用户设置 12–17）────────────────────────────────
//
/// 用户能设的正文最小字号（DSH 设置项 `Font size` 的下限）。
const int dshContentFontSizeMin = 12;

/// 用户能设的正文最大字号。
const int dshContentFontSizeMax = 17;

/// 默认字号（DSH `--dsh-content-font-size` 的 fallback）。
const int dshContentFontSizeDefault = 14;

/// 二级字号（表格、注脚那些）**名义上的**台阶，也是 Δ₂ 的基准。
///
/// ⚠️ 注意：DSH 的公式在 12–15 那几档会算出**比 13 小**的二级字号（见 [dshContentScale]）
///    —— 那个 `max(13, …)` 是**第二个操作数的下限**，不是结果的。照抄公式，别"顺手修正"。
const int dshSecondaryFontSizeBase = 13;

/// 把一个"用户设置里的字号"收进合法区间。
///
/// ⚠️ 输入来自本机存的值：可能是旧版本写的、也可能被改坏了 ⇒
///    **认不出来就回默认档，越界就夹住，绝不抛**（同 `process_levels.dart` 那条）。
int dshClampContentFontSize(Object? setting) {
  if (setting is int) {
    return setting.clamp(dshContentFontSizeMin, dshContentFontSizeMax);
  }
  if (setting is num && setting.isFinite && setting == setting.roundToDouble()) {
    return setting.toInt().clamp(dshContentFontSizeMin, dshContentFontSizeMax);
  }
  return dshContentFontSizeDefault;
}

/// 用户字号轴上的四个数（DSH 那两个 CSS 变量解出来的东西）。
///
/// DSH 原文（`A-layout.md` §4.3 / `E-visual.md`）：
/// ```css
/// --dsh-content-font-delta: calc(var(--dsh-content-font-size,14px) - 14px);
/// --dsh-content-font-size-secondary: min(calc(N - 1px), max(13px, calc(N - 2px)));
/// --dsh-content-font-delta-secondary: calc(var(--dsh-content-font-size-secondary) - 13px);
/// ```
class DshContentScale {
  const DshContentScale({
    required this.size,
    required this.secondary,
    required this.delta,
    required this.secondaryDelta,
  });

  /// 正文基准字号（已夹在 12–17）。
  final int size;

  /// 二级基准字号（表格、注脚）。**不是**一定 ≥13（见 [dshContentFontSizeBase] 那条）。
  final int secondary;

  /// `size - 14`。
  final int delta;

  /// `secondary - 13`。
  final int secondaryDelta;

  /// 把一段**UI 阶梯上的**样式搬到用户字号轴上：`calc(size + Δ)` / `calc(lineHeight + Δ)`。
  ///
  /// ⚠️ 字重不动（Δ 只加字号与行高）—— DSH 的每一处 `calc(Npx + Δ)` 都只改这两个数。
  DshType at(DshType base) => DshType(
        size: base.size + delta,
        weight: base.weight,
        lineHeight: base.lineHeight + delta,
      );

  /// 同上，但走二级台阶（`calc(Npx + Δ₂)`）。
  DshType secondaryAt(DshType base) => DshType(
        size: base.size + secondaryDelta,
        weight: base.weight,
        lineHeight: base.lineHeight + secondaryDelta,
      );

  /// 聊天正文那一段（DSH `markdown-base`：400 `14+Δ` / `24+Δ`）。
  DshType get content => at(DshTypes.contentBase);

  /// 聊天正文加粗那一段。
  DshType get contentStrong => at(DshTypes.contentBaseStrong);
}

/// 从一个"用户设置的字号"解出整条轴（**聊天里每一行的字号都必须从这里来**）。
DshContentScale dshContentScale(Object? setting) {
  final size = dshClampContentFontSize(setting);
  // 逐字照 DSH 那条 CSS：min(N - 1, max(13, N - 2))。
  final secondary = min(size - 1, max(dshSecondaryFontSizeBase, size - 2));
  return DshContentScale(
    size: size,
    secondary: secondary,
    delta: size - dshContentFontSizeDefault,
    secondaryDelta: secondary - dshSecondaryFontSizeBase,
  );
}

// ── 圆角 / 间距（DSH 那两套台阶）────────────────────────────────
//
/// DSH 现场数出来的圆角（`E-visual.md` §3.6：33 种），**收成一套 token**。
///
/// 语义命名只给最常用的两个（[bubble] / [button]）；其余按数值取用 ——
/// DSH 自己也是这么用的（它现场有 18px×12 · 14px×10 · 22px×7 …）。
/// ⚠️ 现场还有一个 `20px`（菜单 / DockKit 浮层，出现 15 次），派活单那一套里没有它 ——
///    等真有菜单要画时再加，别现在多摆一个没人用的数。
abstract final class DshRadius {
  static const double r2 = 2;
  static const double r4 = 4;
  static const double r6 = 6;
  static const double r8 = 8;
  static const double r10 = 10;
  static const double r12 = 12;
  static const double r14 = 14;
  static const double r16 = 16;
  static const double r18 = 18;
  static const double r22 = 22;
  static const double r24 = 24;
  static const double r28 = 28;
  static const double r32 = 32;

  /// 胶囊 / 正圆（DSH 写 `border-radius:50%` 或 `999px`）。
  static const double pill = 999;

  /// **用户气泡 / 输入卡**：DSH 现场出现次数最多的那一个（`.Sixlwa_bubble` 原文 `22px`）。
  static const double bubble = r22;

  /// **按钮 / 字号步进器**：DSH named radius 里的第二个（`18px`）。
  static const double button = r18;
}

/// 间距台阶。
///
/// ⚠️ **DSH 没有一套具名的间距 token**（真包里没有 `--ds*-space*` 这种名字）——
///    这一套是"它现场真用到的那些 gap"收成的台阶（派活单给的也是这一套）。
abstract final class DshSpace {
  static const double s4 = 4;
  static const double s6 = 6;
  static const double s8 = 8;
  static const double s12 = 12;
  static const double s16 = 16;
  static const double s20 = 20;
  static const double s24 = 24;
  static const double s32 = 32;
}

// ── 聊天面的行度量（DSH `.wSkVaW_*` / `.Sixlwa_*` / flow gap）────
//
/// **正文列的宽**：`max(680, min(列宽 * 0.64, 920))`。
///
/// 出处：`E-visual.md` `--dsh-chat-content-width` 原文
/// `clamp(680px, calc(var(--dsh-conversation-column-width,0px) * .64), 920px)`。
/// ⚠️ 输入是**列宽**（我们浮窗里那一条的可用宽），不是屏幕宽。
double dshContentWidth(double columnWidth) {
  final scaled = columnWidth * 0.64;
  if (scaled < dshContentWidthMin) return dshContentWidthMin;
  if (scaled > dshContentWidthMax) return dshContentWidthMax;
  return scaled;
}

/// 正文列的下限。
const double dshContentWidthMin = 680;

/// 正文列占列宽的比例。
const double dshContentWidthFactor = 0.64;

/// 正文列的上限。
const double dshContentWidthMax = 920;

/// **用户气泡**的圆角 / 内边距（`E-visual.md` 原文 `.Sixlwa_bubble{border-radius:22px;
/// padding:10px 16px; background:var(--dsw-specific-bubble)}`）。
const double dshUserBubbleRadius = DshRadius.bubble;
const double dshUserBubblePaddingH = 16;
const double dshUserBubblePaddingV = 10;

/// 用户气泡相对正文列的最大宽比例。
const double dshUserBubbleContentFactor = 0.702;

/// 用户气泡相对**可用宽**的最大比例（兜底：列宽很窄时不让气泡顶到边）。
const double dshUserBubbleAvailableFactor = 0.82;

/// 用户气泡的最大宽度：`min(正文列 * 0.702, 可用宽 * 82%)`。
///
/// 出处：`.Sixlwa_userStack{max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%)}`。
double dshUserBubbleMaxWidth({
  required double contentWidth,
  required double available,
}) {
  final byContent = contentWidth * dshUserBubbleContentFactor;
  final byAvailable = available * dshUserBubbleAvailableFactor;
  return byContent < byAvailable ? byContent : byAvailable;
}

/// **transcript 里两条行之间**的距离（DSH `--dsh-chat-flow-gap`）。
const double dshTranscriptRowGap = 16;

/// **折起来的那一轮里**，正文那一步与上面过程之间的距离。
///
/// 出处：`B-render.md` §2.3 —— 每个流程项 `margin-top: var(--dsh-chat-flow-gap,16px)`，
/// 而**答案那一步**把 gap 覆盖成 8px（`[data-turn-process-answer]{--dsh-chat-flow-gap:8px}`）。
/// ⇒ 16 是行与行，8 是"折叠控件/过程"与它下面那句答案。
const double dshTranscriptAnswerGap = 8;

/// **有界正文那一段的最高高度**（DSH `.XrJvXW_body` 的 `max-height:141px`）。
///
/// 出处：`B-render.md` §2.4「Bounded」那一行（`context bodies max-height:141px`）
/// 与 §1.1 的 `system-prompt` 那条（展开正文在 **141px 的滚动窗**里）。
///
/// 🔴 **它是"有界"，不是"限高截断"**：里面照样能滚到最后一个字 ——
///    DSH 的规矩是"系统提示词逐字给全"，只是不让它把整条时间线顶掉。
/// ⚠️ 别改成"超了就删"：那会让这一行**说假话**（它是"模型看到了什么"的唯一凭据）。
const double dshOpaqueBodyMaxHeight = 141;

/// **工具行展开后那块正文的最高高度**（DSH `.o3BgMG_bodyScroll` 的 `max-height:260px`）。
///
/// 出处：`E-visual.md` §2.4「Bounded」/`.o3BgMG_bodyScroll | max-height:260px`。
/// ⚠️ 同 [dshOpaqueBodyMaxHeight]：**有界 ≠ 截断** —— 超了在框里滚。
///    真被服务端截过的那一段另有话要说（`tool_row_words.dart` 的截断那句）。
const double dshToolBodyMaxHeight = 260;

/// **排队那一块列表的最高高度**（DSH QueueDock 的 `list{max-height:180px}`）。
///
/// 出处：`docs/dev/115-raw/B-render.md` §3.3（*"CSS: panel `border-radius: 12px 12px 0 0`;
/// list `max-height: 180px`; row `height: 36px`"*）。
///
/// ⚠️ **只搬了这一条**：DSH 那个 `row height: 36px` **故意没搬** ——
///    我们的行里有一个**命中区 ≥44** 的撤掉按钮（D3.6），把行写死 36 就会
///    在大字号下夹住字（D3.5："容器跟字算，不是字跟容器"）。
/// ⇒ 行高**跟字算**，列表**有界**（超了在框里滚，与工具行那条同一条纪律）。
const double dshQueueListMaxHeight = 180;

/// **排队那一块列表相对屏高的上限比例**（超过 180 像素那一档时按屏裁）。
///
/// 🔴 **为什么不能只用那个 180 像素的上限**：字号调到最大那一档时，一行文字本身
///    就有几十像素，几条排下来会把聊天区挤成一条缝 —— `accessibility_test.dart`
///    那道硬闸（D3.5 五档不溢出）当场红（真栽过：3.1 倍下溢出 23 像素）。
///    ⇒ 列表取 `min(180, 屏高 × 这个比例)`：正常档就是 180（与 DSH 同值），
///      大字/矮屏下按屏裁 —— 上限的意思本来就是"**不许把别的挤没**"。
const double dshQueueListMaxHeightFactor = 0.2;

// ── ★ 批 5：右栏（DSH 的 right sidebar；契约 `docs/dev/120-FILE-PANEL.md`）──
//
// 数值出处：`docs/dev/115-raw/A-layout.md` §3 —— **右栏（第 5 行）**
//   `0 或 clamp(300, viewport*0.45 first open)`，上限 `viewport*0.70`；
//   **28×28 那颗展开按钮**（§3：`ExpandButton … 28×28 button with
//   aria-label 打开右侧边栏` 与 `Panel icon buttons: 28×28; border-radius:28px`）；
//   **窄屏**：它的 `computeColumns` 先压右栏、再让占位者自己关掉（`available < 300 ⇒ r = 0`）。
//
// ⚠️ **我们与 DSH 的推法刻意不同的一处（如实记）**：DSH 的右栏是**三轨网格**
//    里的一轨（它一开，中间那一列就变窄）；我们这里是**浮窗里面**一块
//    **滑进来的盖板**（派活单点名："slides in from the right **inside the floating
//    window**，不是新的一屏"）。⇒ 这里算出来的是**盖板自己的宽**，
//    中间那一列**一个像素都不动**（聊天那一屏的滚动位置正是靠这个不动的）。
const double dshRightPanelWidthMin = 300;
const double dshRightPanelWidthMax = 420;
const double dshRightPanelWidthFactor = 0.45;
const double dshRightPanelMaxRatio = 0.7;

/// 窄屏的那一刀（DSH 的 "available < 300 ⇒ 右栏 0"，我们反过来：**盖满**）。
///
/// 🔴 为什么是"盖满"而不是"关掉"：他不是在缩窗口，是在**点那颗按钮**
///    ——他要看那一栏。窄屏下按不动（关掉 = 点了没反应）比"盖住聊天"坏得多。
const double dshRightPanelNarrowWidth = 300;

/// **"挤"的那条路给聊天留下的最小宽度**（不够宽就改走"盖"）。
///
/// 🔴 为什么必须有这一条（2026-09-26 修）：光判"这一栏放得下"是不够的 ——
///    手机上（浮窗里那一块 ≈ 屏宽 − 60 ⇒ 330 上下）`dshRightPanelFits` 为真、
///    算出来的栏宽正好是 300 ⇒ `Row` 里聊天只剩 **30 像素**，
///    气泡那一行当场 `RenderFlex overflowed by 41 pixels`（`bubbles.dart:141`）。
///    "挤"的本意是"**还看得见一条边**"（与 DSH 的三轨同一个形状），
///    只剩 30 像素不是"看得见"，是把聊天**弄坏**了。
/// ⇒ 取 [dshRightPanelNarrowWidth] 同一个数：两根柱子**各自都要有一块能用的宽度**
///    （这一栏是 300，聊天也是 300）—— 两个数同源，不是各写一份。
const double dshRightPanelChatMinWidth = dshRightPanelNarrowWidth;

/// 这一块地方**够不够**摆那块盖板。
///
/// ⚠️ "放得下这一栏" ≠ "可以挤"：能不能走 `Row` 那条路还要问
///    [_dshRightPanelLeavesRoomForChat]（见那个函数的说明）。
bool dshRightPanelFits(double available) =>
    available >= dshRightPanelNarrowWidth;

/// **走"挤"（`Row`）那条路之后，聊天还剩不剩得下一块能用的宽度**。
///
/// 假 ⇒ 改走"盖"（`Stack` ＋ `Align`）：栏照旧滑进来，聊天一个像素都不动。
bool dshRightPanelLeavesRoomForChat(double available) =>
    available - dshRightPanelWidth(available) >= dshRightPanelChatMinWidth;

/// 盖板该多宽（`available` = 浮窗里那一块的可用宽）。
///
/// 三条（与 DSH 的 `computeColumns` 同一个形状，数值换成上面那几个 token）：
///   · 够宽 ⇒ `clamp(300, 可用宽 × 0.45, 420)`（首次打开取屏幕的 45%）；
///   · 不够宽但**放得下一整个**（≥300）⇒ 占 `min(420, 可用宽 × 0.70)`
///     —— 于是左边**总留一条缝**（看得见聊天还在，不是"换了一屏"）；
///   · 连 300 都没有 ⇒ **盖满**（见 [dshRightPanelNarrowWidth]）。
double dshRightPanelWidth(double available) {
  if (available <= 0) return 0;
  final byFactor = available * dshRightPanelWidthFactor;
  final wide = byFactor.clamp(dshRightPanelWidthMin, dshRightPanelWidthMax);
  if (dshRightPanelFits(available) && wide < available) return wide;
  final byRatio = available * dshRightPanelMaxRatio;
  final narrow = byRatio > dshRightPanelWidthMax ? dshRightPanelWidthMax : byRatio;
  return narrow < available ? narrow : available;
}

/// DSH 那一排小图标按钮的**图形**尺寸（`28×28`，`115-raw/A-layout.md` §3）。
///
/// 🔴 **它不是命中区**：D3.6 那条硬闸量的是**命中区**（≥44，
///    `accessibility_test.dart` 的 `sweep`）—— 图形可以 28，按钮得给到 44。
///    （DSH 也这么干：`28×28` 是画出来的那个框，点击靠浏览器/系统的命中区。）
const double dshPanelIconButtonSize = 28;

/// 右栏滑进 / 滑出的时长。
///
/// ⚠️ 出处是 DSH 自己的 `--ds-transition-duration-slow`（`A-layout.md` §1.2
///    那张表里 frame 的 `grid-template-columns` 用的就是它）——
///    **同一个动作、同一个数**，不是我们顺手挑的。
/// ⚠️ 曲线（`--ds-ease-in-out`）**不在这里**：`Curve`/`Curves` 住在
///    `package:flutter/animation.dart`，而 `models/` 是纯逻辑层（楼层闸）
///    —— 它是 widget 那一层的常量（见 `widgets/dsh_look.dart` 的 `dshPanelSlideCurve`）。
const Duration dshPanelSlideDuration = Duration(milliseconds: 240);

/// 右栏那个滚动面**多缓存一段**（逻辑像素）。
///
/// 它是给"**紧挨着抬头下面**的那几行"用的：抬头把视口占满时（大字号），
/// 下面那几行本来要等用户滚了才建 —— 而判据要求**一开始就能 `ensureVisible` 到**。
/// ⚠️ **它治不了"抬头与列表上下分家"那种病**（那要改布局：见
///    `docs/dev/120-FILE-PANEL.md` §3.2）；这一条只是让"刚出视口"的那几行也建出来。
/// ⚠️ 它**不影响画在哪**（`sweep` 那道硬闸量的仍是**真的可见**的矩形）——
///    缓存只管"建不建"。
const double dshPanelCacheExtent = 400;
