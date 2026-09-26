// **聊天窗口的外观往下传的那一层**（契约 `docs/dev/119-APPEARANCE-AND-FONT.md` §三）。
//
// ── 它解决的两件事 ──────────────────────────────────────────
//   ① **解析**：用户选的是一个**偏好**（亮 / 暗 / 跟随系统），而屏幕上要的是
//      一份**具体色板**（DSH 的 `bootThemeScript` 就是这么干的：`system` 拿
//      `prefers-color-scheme` 解析掉，界面层只拿到结论）。解析要跟着
//      `MediaQuery.platformBrightness` **一起变**（用户在系统里切了暗色，
//      我们的窗口要当场跟着暗，不用重开）—— 所以解析发生在 `ChatScreen.build`
//      里、`AppearanceScope` 只装**解析之后**的结果。
//   ② **"只重做聊天窗口"这条边界**：这个 scope 只值在聊天窗口这一棵子树里，
//      窗口**外面**（桌面图标墙 / 首页 / 登录 / 小程序容器那一圈壳）照旧是
//      暖白纸那套 `models/design.dart`。⇒ 整机暗色**不是这一批的事**
//      （那等于要给暖白纸那套品牌色**发明**一份暗色版，得主人点头）。
//
// ── 为什么是一个 `InheritedWidget` 而不是往下传参数 ──────────────
// 用 token 的控件有十来个、而且深浅不一（工具行、右栏、排队条、
// 输入条、气泡…）。一个个传 = 每加一个控件就要记得多传一次，漏一个的表现是
// "这一块跟着设置走、那一块不跟"——**最难发现的那种不一致**。
// ⇒ 走继承：`DshLook.of(context)` 一处取值，漏不掉。
//
// ⚠️ 数值仍然只有 `models/dsh_design.dart` 一处：这里一个颜色/字号都不写死，
//    只做"token → `ThemeData`"的拼装（和 `screens/app_theme.dart` 那条纪律同一条）。
// ⚠️ 这里**不碰 `textScaler`**：系统字号缩放仍然由 `Text` 自己按 `MediaQuery`
//    施加（D3.5 那条"不封顶"就是靠它）；用户字号那条轴走的是**字号本身**，
//    两件事各是各的（DSH 也是两个独立的东西）。

import 'package:flutter/material.dart';

import '../models/appearance.dart';
import '../models/dsh_design.dart';

/// 聊天窗口这一棵子树现在的外观：**解析之后的色板档** ＋ **用户字号轴**
/// ＋（给设置那两行用的）当前偏好与写回口。
///
/// ⚠️ [settings] / [onAppearance] / [onFontSize] 是**给设置页那两行用的**：
///    它们住在 `screens/settings_screen.dart`（不在这一层），但写的必须是
///    **同一个**状态 —— 所以由 scope 往下递，而不是让设置页自己另存一份
///    （两份状态 = 迟早会漂）。
class AppearanceScope extends InheritedWidget {
  const AppearanceScope({
    super.key,
    required this.variant,
    required this.scale,
    this.settings = const ChatAppearanceSettings(),
    this.onAppearance,
    this.onFontSize,
    required super.child,
  });

  /// 解析之后的色板档（`system` 已经对着设备亮度解掉了）。
  final DshVariant variant;

  /// 用户字号轴（聊天里每一行的字号都必须从这里来）。
  final DshContentScale scale;

  /// 用户**选**的那个偏好（设置那两行要显示"现在选的是哪一个"）。
  final ChatAppearanceSettings settings;

  /// 用户点了三档里的另一个（`null` = 这一棵树没接这一条 ⇒ 那两行不画）。
  final ValueChanged<ChatAppearance>? onAppearance;

  /// 用户按了字号那两下（`null` = 同上）。
  final ValueChanged<int>? onFontSize;

  /// 现在这一棵子树的外观；**没有 scope 就是 `null`**（老调用方 / 单看某一块的判据）。
  static AppearanceScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppearanceScope>();

  @override
  bool updateShouldNotify(AppearanceScope old) =>
      old.variant != variant ||
      old.scale.size != scale.size ||
      old.settings != settings ||
      old.onAppearance != onAppearance ||
      old.onFontSize != onFontSize;
}

/// 聊天窗口那一份 `ThemeData`（**只在浮窗里面生效**）。
///
/// ── 为什么非要它不可（这一批最容易踩的一处）────────────────────
/// 聊天窗口里绝大多数控件（气泡、输入框、状态条、分隔线…）**不是直接读 DSH token**
/// 的，它们读的是 `Theme.of(context)`（`models/design.dart` 那套暖白纸）。
/// ⇒ 只把浮窗那块底换成暗色、而里面这些控件照旧拿暖白纸主题，
///    结果是**近黑的字压在近黑的底上**（屏幕上就是"字没了"）。
/// 而且这种坏法 `find.text` **照样找得到**（字还在树里）—— 判据全绿、屏幕是黑的。
/// ⇒ 修法是结构性的：把**窗口里面那一整棵**套上这一份 `ThemeData`，
///    于是"里面的 Material 控件跟着窗口走"这件事由**结构**保证，不靠人记得改每一处。
///
/// ⚠️ 它**只改颜色**：字号阶梯照抄 `Typography.material2021()`（和全站那一份
///    同一个来源、同一套尺寸）⇒ 套上它**不会**让任何一行字变大变小，
///    也就不会把五档字号那道硬闸的读数弄脏。用户字号那条轴是**另走**
///    `DshContentScale` 的（`DshLook`）。
/// ⚠️ 按档缓存：它每一帧都会被取一次，而 `ThemeData` 造起来不便宜。
ThemeData chatThemeOf(DshVariant variant) => _chatThemes.putIfAbsent(
  variant,
  () => _buildChatTheme(variant),
);

final Map<DshVariant, ThemeData> _chatThemes = <DshVariant, ThemeData>{};

ThemeData _buildChatTheme(DshVariant variant) {
  final p = variant.palette;
  final dark = variant.isDark;
  // ⚠️ 语义色**按 DSH 的语义**映射（不是从种子推一份近似色）：
  //    brand（近黑/近白）＝主按钮、business ＝链接与进行中、error ＝失败。
  final scheme = ColorScheme.fromSeed(
    seedColor: p.stateBusiness,
    brightness: dark ? Brightness.dark : Brightness.light,
  ).copyWith(
    primary: p.brandPrimary,
    onPrimary: dark ? p.bgBase : const Color(0xFFFFFFFF),
    secondary: p.stateBusiness,
    surface: p.bgBase,
    onSurface: p.labelPrimary,
    onSurfaceVariant: p.labelSecondary,
    outline: p.borderL2,
    outlineVariant: p.borderL1,
    surfaceContainerLowest: p.bgBase,
    surfaceContainerLow: p.bgLayer1,
    surfaceContainer: p.bgLayer2,
    surfaceContainerHigh: p.bgLayer2,
    surfaceContainerHighest: p.bgLayer2,
    primaryContainer: p.specificBubble,
    onPrimaryContainer: p.labelPrimary,
    error: p.stateError,
    // ⚠️ "没发出去"那条气泡的底：**不能**直接用 `state-error`（那是一整块实心红），
    //    也不能用 Material 从种子推的那份（亮色下是粉、暗色下是暗红，两档都对不上）。
    //    ⇒ 取"这一档的面 + 一点 error 罩色"：两档都是"看得出是失败、但还是一块面"。
    errorContainer: Color.alphaBlend(p.stateError.withValues(alpha: 0.16), p.bgLayer2),
    onErrorContainer: p.labelPrimary,
  );
  // ⚠️ 字号阶梯**一个数都不改**（见 [chatThemeOf] 那条）：只把默认字色换成
  //    这一档的 `label-primary`，让"没显式给颜色的那几行字"也读得出来。
  final typography = Typography.material2021();
  final ramp = dark ? typography.white : typography.black;
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    textTheme: ramp.apply(bodyColor: p.labelPrimary, displayColor: p.labelPrimary),
    scaffoldBackgroundColor: p.bgBase,
    canvasColor: p.bgBase,
    cardColor: p.bgLayer1,
    iconTheme: IconThemeData(color: p.labelTertiary),
    dividerTheme: DividerThemeData(color: p.borderL2),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.bgBase,
      labelStyle: TextStyle(color: p.labelTertiary),
      hintStyle: TextStyle(color: p.labelTertiary),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(DshRadius.r14),
        borderSide: BorderSide(color: p.borderL2),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(DshRadius.r14),
        borderSide: BorderSide(color: p.borderL2),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(DshRadius.r14),
        borderSide: BorderSide(color: p.stateBusiness, width: 2),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: p.labelSecondary),
    ),
    listTileTheme: ListTileThemeData(iconColor: p.labelTertiary, textColor: p.labelPrimary),
    dialogTheme: DialogThemeData(backgroundColor: p.bgLayer1),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: p.bgLayer1),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: p.tooltipBg,
      contentTextStyle: TextStyle(color: p.labelPrimary),
      behavior: SnackBarBehavior.floating,
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: p.stateBusiness),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(color: p.tooltipBg, borderRadius: BorderRadius.circular(DshRadius.r8)),
    ),
  );
}
