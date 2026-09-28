// **没登录时第一屏是哪一屏**（契约 `docs/dev/129-NATIVE-ANDROID-BUILD.md` §十五）。
//
// 主人 2026-09-28 在安卓真机上：*"安卓的首页不是网站的首页，而是那个登录页。
// 所以在安卓上，登录页没有退回首页的箭头。"* —— 问过之后他选的那一条：
// **安卓不要落地页：直接登录页，箭头也去掉**。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **两版不一样，而且这是"定下来的"**：网页 = 先落地页；安卓/iOS/桌面 = 登录页；
//   ② 🔴 源码级：`main.dart` 真的按这条规则分了两支（不是"文档这么说、代码另一套"）；
//   ③ 🔴 **网页那一版一个字没动**：`SoftSwitch`（落地页 ⇄ 登录页那次过渡）还在，
//      而且**只在 `landingFirst` 那一支**里。
//
// ⚠️ 为什么不直接 pump `HupoApp` 量：`kIsWeb` 在 VM 上**恒假** ⇒ 判据里只能看到
//    "安卓那一支"（`test/widget/android_entry_test.dart` 量的就是它）；
//    网页那一支靠 ② 的源码级断言 ＋ 原来那几条界面判据（`landing_transition_test`）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/entry_screen.dart';

void main() {
  test('① 🔴 网页先落地页；安卓/iOS/桌面直接登录页（主人 2026-09-28 定的）', () {
    expect(landingFirstFor(isWeb: true), true, reason: '★ 网页那一版：先落地页（点"开始用"再进登录页）');
    expect(landingFirstFor(isWeb: false), false,
        reason: '★ 装了这个包的人不需要落地页（那一页是给外面的人看的）⇒ 直接登录页');
  });

  test('② `main.dart`：按平台那一刀只有一处（源码级）', () {
    final main = File('lib/main.dart').readAsStringSync();
    expect(main.contains('landingFirstFor(isWeb: kIsWeb)'), isTrue,
        reason: '★ 规则要从 `models/entry_screen.dart` 那一处取 —— 别在界面里另写一个判断');
    expect(main.contains('_entryScreens()'), isTrue, reason: '★ 没登录那一屏要走这一个出口');
    expect(main.contains('NotLoggedInScreen('), isTrue, reason: '★ 那一屏由 `screens/not_logged_in.dart` 给');
    // 负向对照：**别在 main.dart 里另写一个平台判断**（那就是第二处出处）
    expect(RegExp(r'kIsWeb\s*\?\s*LandingScreen').hasMatch(main), isFalse,
        reason: '★ 平台那一刀不许散到界面文件里');
  });

  test('③ 两支都在（源码级）：网页那条过渡与落地页**一个字没动**；安卓那支不传 onBack', () {
    final src = File('lib/screens/not_logged_in.dart').readAsStringSync();
    // 网页那一支：**过渡**（主人 2026-09-22 点名要的）＋ 落地页 ＋ 登录页带 onBack
    expect(src.contains('SoftSwitch('), isTrue, reason: '★ 网页那条"丝滑地换"不许被这一刀顺手删掉');
    expect(src.contains('LandingScreen(onStart: onStart)'), isTrue,
        reason: '★ 落地页还在（只是安卓那一支不走它）');
    expect(src.contains('onBack: onBack'), isTrue, reason: '★ 网页那一支的登录页要能回首页');
    // 安卓那一支：**不传 onBack** ⇒ 不画那颗箭头
    expect(
      RegExp(r'return LoginScreen\(\s*api: api,\s*needsSetup: needsSetup,\s*onLoggedIn: onLoggedIn,\s*\);').hasMatch(src),
      isTrue,
      reason: '★ 安卓那一支的 LoginScreen 里**不许**出现 onBack（出现了就又有那颗箭头）',
    );
  });
}
