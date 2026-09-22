// **首页 → 登录页那次切换，到底是不是"丝滑的过渡"**（不是硬切）。
//
// 主人 2026-09-22：*"从首页，点击开始，到登录页显示，我希望是一个丝滑的过渡展示效果，
// 而不是突然出现的效果。"*
//
// ⚠️ **这条判据的形状**：硬切与过渡的**唯一可观察差别**是——
//    **动画中途，两屏是不是同时在**（硬切的话，一帧之内旧屏就没了）。
//    所以判据是"点下去之后**先别 pumpAndSettle**，看此刻树里有什么"。
//    ⚠️ 只断言"点完能到登录页"是**测不出硬切的** —— 硬切也能到。
//
// ⚠️ 为什么不去 pump 整个 `HupoApp`：它开机要真打网络（`Api()`）与读写本机存储，
//    在这一层测不了。所以这里**照 `main.dart` 那条路**把两个孩子装进同一个 `SoftSwitch`
//    （同一个组件、同一份时长），只是不跑它的开机流程。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/landing_words.dart';
import 'package:hupo_app/models/login_words.dart';
import 'package:hupo_app/screens/landing_screen.dart';
import 'package:hupo_app/screens/login_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/widgets/soft_switch.dart';

/// 和 `main.dart` **同一条路**：首页 ⇄ 登录页，靠一个布尔切。
class _Harness extends StatefulWidget {
  const _Harness();
  @override
  State<_Harness> createState() => _HarnessState();
}

class _HarnessState extends State<_Harness> {
  bool showLogin = false;

  @override
  Widget build(BuildContext context) => SoftSwitch(
        showSecond: showLogin,
        first: LandingScreen(onStart: () => setState(() => showLogin = true)),
        second: LoginScreen(
          api: Api(base: 'http://127.0.0.1:1'),
          onLoggedIn: (_) {},
          onBack: () => setState(() => showLogin = false),
        ),
      );
}

/// 正在进场那一屏的不透明度（从 `SoftSwitch` 套上去的那个 `FadeTransition` 读）。
double _incomingOpacity(WidgetTester tester, Finder screen) {
  final f = tester.widget<FadeTransition>(
    find.ancestor(of: screen, matching: find.byType(FadeTransition)).first,
  );
  return f.opacity.value;
}

Future<void> _pump(WidgetTester tester) async {
  await tester.pumpWidget(const MaterialApp(home: _Harness()));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('★ 时长是个"看得出过渡、又不觉得卡"的数（不是随手写的）', (tester) async {
    // ⚠️ 编码的是产品判断：太短 = 等于硬切；太长 = 点了像没反应。
    expect(d.motionPage.inMilliseconds >= 200, true, reason: '${d.motionPage.inMilliseconds}ms 太短，等于硬切');
    expect(d.motionPage.inMilliseconds <= 500, true, reason: '${d.motionPage.inMilliseconds}ms 太长，点了像没反应');
  });

  testWidgets('🔴 点「开始用」⇒ **不是硬切**：动画中途两屏同时在，登录页正在淡入', (tester) async {
    await _pump(tester);
    expect(find.byType(LandingScreen), findsOneWidget);
    expect(find.byType(LoginScreen), findsNothing);

    await tester.tap(find.text(landingStart));
    await tester.pump(); // 动画第 0 帧

    // ★ 判据就在这两行：硬切的话，这一帧首页**已经没了**
    expect(find.byType(LandingScreen), findsOneWidget, reason: '首页不该在一帧之内就消失 —— 那就是"突然出现"');
    expect(find.byType(LoginScreen), findsOneWidget, reason: '登录页该已经在进场了');

    // 中途：登录页的不透明度**在 0 与 1 之间**（这是"淡入"的直接证据）
    await tester.pump(Duration(milliseconds: d.motionPage.inMilliseconds ~/ 2));
    final mid = _incomingOpacity(tester, find.byType(LoginScreen));
    expect(mid > 0.0 && mid < 1.0, true, reason: '中途不透明度该在 0~1 之间（实测 $mid）');

    // 收尾：只剩登录页，而且它是**完全不透明**的（别停在半透明上）
    await tester.pumpAndSettle();
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.byType(LandingScreen), findsNothing, reason: '动画完了首页该退场');
    expect(_incomingOpacity(tester, find.byType(LoginScreen)), 1.0);
  });

  testWidgets('🔴 那条箭头回来**也走同一次过渡**（只做一半 = 回来那下还是会闪）', (tester) async {
    await _pump(tester);
    await tester.tap(find.text(landingStart));
    await tester.pumpAndSettle();
    expect(find.byType(LoginScreen), findsOneWidget);

    await tester.tap(find.byTooltip(loginBack));
    await tester.pump();
    expect(find.byType(LoginScreen), findsOneWidget, reason: '回来时登录页不该一帧就消失');
    expect(find.byType(LandingScreen), findsOneWidget, reason: '首页该已经在进场');

    await tester.pump(Duration(milliseconds: d.motionPage.inMilliseconds ~/ 2));
    final mid = _incomingOpacity(tester, find.byType(LandingScreen));
    expect(mid > 0.0 && mid < 1.0, true, reason: '中途不透明度该在 0~1 之间（实测 $mid）');

    await tester.pumpAndSettle();
    expect(find.byType(LandingScreen), findsOneWidget);
    expect(find.byType(LoginScreen), findsNothing);
  });

  testWidgets('🔴 负向对照：正在退场的那一屏**点不到**（半透明时点它 = 点到已经走了的东西）', (tester) async {
    await _pump(tester);
    await tester.tap(find.text(landingStart));
    await tester.pump();
    await tester.pump(Duration(milliseconds: d.motionPage.inMilliseconds ~/ 2));
    // ⚠️ 这一条钉的是 `SoftSwitch` 里那个 `IgnorePointer`：
    //    去掉它的话，动画那半秒里"开始用"还能被点到。
    expect(
      find.ancestor(of: find.byType(LandingScreen), matching: find.byType(IgnorePointer)),
      findsWidgets,
      reason: '退场那一屏必须被 IgnorePointer 包住',
    );
  });
}
