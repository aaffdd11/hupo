// **安卓那一版的第一屏**（主人 2026-09-28 在真机上定案 · 契约 `docs/dev/129` §十五）。
//
// 原话：*"安卓的首页不是网站的首页，而是那个登录页。所以在安卓上，登录页没有退回首页的箭头。"*
// ⇒ 他选的那一条：**安卓不要落地页 —— 直接登录页，箭头也去掉**。
//
// ⚠️ `kIsWeb` 在 VM 上**恒假** ⇒ 这一份量的正是**安卓那一支**（网页那一支由
//    `test/unit/entry_screen_test.dart` 的源码级断言 ＋ `landing_transition_test.dart` 兜着）。
//
// 🔴 判据的读法（跟"删掉一个页面"有关，所以要说清）：
//    ① 没登录时**第一屏就是登录页**（不是落地页）；
//    ② 顶上**没有**那颗"回首页"的箭头（没有首页可回 —— 留着它就是个假按钮）；
//    ③ 负向对照：登录页**本身还在**（别把整块登录一起干掉）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/login_words.dart';
import 'package:hupo_app/screens/landing_screen.dart';
import 'package:hupo_app/screens/login_screen.dart';
import 'package:hupo_app/screens/not_logged_in.dart';
import 'package:hupo_app/services/api.dart';

/// 泵"没登录那一屏"。
///
/// ⚠️ **不泵整个 `HupoApp`**：它开机那一下会真的去问 `/api/needsSetup`（VM 上发不出去），
///    于是屏上停在转圈那一帧 —— 那量到的不是"摆哪一屏"（而这一份量的正是它）。
///    ⇒ 直接泵这一块，两支（安卓 / 网页）都能量。
Future<void> _pump(WidgetTester tester, {required bool landingFirst, bool showLogin = false}) async {
  var back = 0;
  await tester.pumpWidget(MaterialApp(
    home: NotLoggedInScreen(
      landingFirst: landingFirst,
      showLogin: showLogin,
      onStart: () {},
      onBack: () => back += 1,
      api: Api(),
      needsSetup: false,
      onLoggedIn: (_) {},
    ),
  ));
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('🔴 安卓那一支：第一屏就是**登录页**，没有落地页、也没有回首页的箭头', (tester) async {
    await _pump(tester, landingFirst: false);
    expect(find.byType(LoginScreen), findsOneWidget, reason: '★ 安卓包里第一屏该是登录页（他要的就是这个）');
    expect(find.byType(LandingScreen), findsNothing, reason: '★ 落地页是给外面的人看的：app 里不摆它');
    expect(find.byTooltip(loginBack), findsNothing,
        reason: '★ 没有首页可回 —— 留着那颗箭头就是个点了不动的假按钮');
  });

  testWidgets('★ 负向对照（网页那一支）：先落地页；进了登录页**才有**那颗箭头', (tester) async {
    // ① 第一屏是落地页
    await _pump(tester, landingFirst: true);
    expect(find.byType(LandingScreen), findsOneWidget, reason: '★ 网页那一版不许被这一刀改掉');
    // ② 停在登录页时：箭头要在（点了回首页 —— 主人 2026-09-22 点名要的）
    await _pump(tester, landingFirst: true, showLogin: true);
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.byTooltip(loginBack), findsOneWidget, reason: '★ 网页那一版的登录页照旧能回首页');
  });
}
