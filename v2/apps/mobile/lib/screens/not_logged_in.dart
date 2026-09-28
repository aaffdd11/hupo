// **没登录的时候摆哪一屏**（契约 `docs/dev/129-NATIVE-ANDROID-BUILD.md` §十五）。
//
// 主人 2026-09-28 在安卓真机上定的：*"安卓的首页不是网站的首页，而是那个登录页。
// 所以在安卓上，登录页没有退回首页的箭头。"* ⇒ 他选的那一条：
// **安卓不要落地页 —— 直接登录页，箭头也去掉**。
//
// ── 两版为什么不一样（这不是"少一个页面"，是两件事）──────────
//   · **落地页**（`landing_screen.dart`）是给**还没用的人**看的：一句"这是什么" ＋
//     两个入口（开始用 / 下载安卓版）—— **它长在网页上**；
//   · 已经装了这个包的人不需要它，而且那一页上那颗「下载安卓版」在包里点它只会得到
//     一句"你正在用的就是这个安卓版"（诚实，但没意义）；
//   · 所以安卓**直接从登录页开始**，登录页顶上那颗"回首页"的箭头也**不画**
//     （没有首页可回，留着它就是个点了不动的假按钮）。
//
// 🔴 **网页那一版一个字不动**：先落地页 ⇒ 点"开始用" ⇒ 登录页（带箭头回首页），
//    而且那一次切换仍然是 `SoftSwitch` 的**丝滑过渡**（主人 2026-09-22 点名要的）。
//
// ⚠️ 为什么要单独一个 widget（而不是把这一支写在 `main.dart` 里）：
//    `kIsWeb` 在 VM 上**恒假** ⇒ 写在 `main.dart` 里的话，"网页那一支"在判据里
//    **永远量不到**（那正是本仓库最忌的"判据打在另一侧"）。
//    ⇒ 把 `landingFirst` 做成**入参**：判据两支都能泵。

import 'package:flutter/material.dart';

import '../services/api.dart';
import '../widgets/soft_switch.dart';
import 'landing_screen.dart';
import 'login_screen.dart';

class NotLoggedInScreen extends StatelessWidget {
  const NotLoggedInScreen({
    super.key,
    required this.landingFirst,
    required this.showLogin,
    required this.onStart,
    required this.onBack,
    required this.api,
    required this.needsSetup,
    required this.onLoggedIn,
  });

  /// 第一屏是不是落地页。**由上层按平台算**：`landingFirstFor(isWeb: kIsWeb)`。
  /// ⚠️ 做成入参是**为了可判**（见文件顶上那段）。
  final bool landingFirst;

  /// 网页那一版：现在停在登录页了吗（那次过渡的另一半）。
  final bool showLogin;

  /// 点"开始用"（网页那一版）。
  final VoidCallback onStart;

  /// 点"回首页"那颗箭头（只在落地页那一支才有）。
  final VoidCallback onBack;

  /// 登录页要用的那个口（`services/api.dart`）。
  final Api api;
  /// "这台设过密码没有"（登录页据此决定说什么）。
  final bool needsSetup;
  final void Function(String token) onLoggedIn;

  @override
  Widget build(BuildContext context) {
    if (!landingFirst) {
      // 安卓 / iOS / 桌面：**就是登录页**，没有"回首页"这回事（不传 `onBack` ⇒ 不画箭头）
      return LoginScreen(
        api: api,
        needsSetup: needsSetup,
        onLoggedIn: onLoggedIn,
      );
    }
    return SoftSwitch(
      showSecond: showLogin,
      first: LandingScreen(onStart: onStart),
      second: LoginScreen(
        api: api,
        needsSetup: needsSetup,
        onLoggedIn: onLoggedIn,
        onBack: onBack,
      ),
    );
  }
}
