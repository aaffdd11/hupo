// **顶上那一条（系统状态栏）该怎么画** —— **只有这一处出口**。
//
// 主人 2026-10-05 报的：*"我们在安卓端，打开时，桌面顶部的手机或平板状态栏，底色是桌面的，
//   但是当我们点开自建的小程序时，底色没有延展到状态栏……底色是白色，系统状态栏会变成黑色系，
//   底色是深色系，状态栏会变成浅色系。所以这个app，可能出现深色底，也可能出现浅色底。
//   我们该怎么处理？"*
//
// ── 查清楚的两件事（都要记住，不然还会再问一遍）────────────
//   ① 🔴 **顶上那一条不是设计，是 2026-09-28 那次修的**（他报"第一行压在时钟底下"）：
//      小程序与内置那几屏**从安全区下面开始**（`mini_app_host.dart` 的 `top: safe.top`）。
//      ⇒ 露出来的那一条**是壳自己的**（桌面那一层在它后面）。
//   ② 🔴 **图标深浅今天没有任何一行代码去设它** —— 所以它不跟着底走。
//
// ── 定案（主人 2026-10-05 选"归我们"）────────────────────
//   · **顶上那一条归壳**：小程序那一屏画成**壳自己的纸色**（页面从它下面开始），
//     桌面那一屏**跟着壁纸走**（`wallpaperTopIsDark`，28 张离线量好）。
//   · **图标跟着这一条走**：这一条是浅的 ⇒ 深色图标；深的 ⇒ 浅色图标。
//   · 🔴 **为什么不让页面铺上去**：小程序是**第三方 HTML**，我们**读不到它的颜色**
//     （也不许注入脚本去读）⇒ 图标没法"跟着页面走"。铺上去就只能固定盖一层渐变，
//     而页面第一行又会压回时钟底下（正是 2026-09-28 那次报的事）。
//
// ⚠️ 用 `AnnotatedRegion` 交出去（声明式）：Flutter 在**状态栏那一条的正中**取样，
//    取到**最上面**那一层的值（`rendering/view.dart` 的 `_updateSystemChrome`）。
//    ⇒ 谁盖在顶上，就由谁说了算：小程序开着 ⇒ 小程序那一层；没开 ⇒ 桌面那一层。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// **顶上那一条的样子**（底色我们要自己画，所以这里只管图标深浅）。
///
/// * [darkBackground] 为真 ⇒ 底是深的 ⇒ 图标要**浅**（白）；
///   为假 ⇒ 底是浅的 ⇒ 图标要**深**（黑）。
SystemUiOverlayStyle statusBarStyle({required bool darkBackground}) => SystemUiOverlayStyle(
      // ⚠️ **透明**：底色由我们自己画（桌面画壁纸、小程序那一屏画纸色），
      //    系统再涂一层就会盖掉它。
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: darkBackground ? Brightness.light : Brightness.dark,
      // iOS 那个字段语义是反的（"底色亮不亮"），别拿它当同一个
      statusBarBrightness: darkBackground ? Brightness.dark : Brightness.light,
    );

/// **把顶上那一条交给某一层说了算**（各屏自己包一层）。
///
/// ⚠️ 只包**真正盖住那一条**的东西（小程序那个会长的面、桌面那一整层）——
///    包一个空的满屏盒子会让"没开小程序"的时候也抢到话事权。
class SystemBarTint extends StatelessWidget {
  const SystemBarTint({super.key, required this.darkBackground, required this.child});

  /// 这一层顶上那一条是深色吗（见 [statusBarStyle]）。
  final bool darkBackground;

  final Widget child;

  @override
  Widget build(BuildContext context) =>
      AnnotatedRegion<SystemUiOverlayStyle>(
        value: statusBarStyle(darkBackground: darkBackground),
        child: child,
      );
}
