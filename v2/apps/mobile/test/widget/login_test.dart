// 登录那一屏：**手机号 + 验证码**（主人 2026-09-21 改的）。
//
// 三条最值钱的判据在这儿：
//   🔴 那一屏**不许再有"密码"**（手册 R4：口令挡住 06，她第一天就放弃）；
//   🔴 **临时验证码必须如实说**（现在没有短信）—— 不说就是让用户以为这是真短信验证；
//   🔴 **"码不对"和"还没接短信"必须分开说**（混成一句，用户会一直重输）。
//
// ⚠️ 提示档（`test/widget` 的通用规矩）；五档不溢出/命中区在 `accessibility_test.dart`（硬闸）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/landing_words.dart';
import 'package:hupo_app/models/login_words.dart';
import 'package:hupo_app/screens/login_screen.dart';
import 'package:hupo_app/services/api.dart';

http.Response _json(String body, [int status = 200]) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

Future<void> _pump(WidgetTester tester, {required int status, String body = '{}'}) async {
  final api = Api(client: MockClient((_) async => _json(body, status)));
  await tester.pumpWidget(MaterialApp(
    home: LoginScreen(api: api, onLoggedIn: (_) {}),
  ));
  await tester.pumpAndSettle();
}

Future<void> _fill(WidgetTester tester, {String phone = '13800000001', String code = '000000'}) async {
  await tester.enterText(find.widgetWithText(TextField, loginPhoneLabel), phone);
  await tester.enterText(find.widgetWithText(TextField, loginCodeLabel), code);
  await tester.tap(find.text(loginSubmit));
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('🔴 那一屏是**手机号 + 验证码**，而且**没有"密码"**', (tester) async {
    await _pump(tester, status: 200, body: '{"token":"t"}');
    expect(find.widgetWithText(TextField, loginPhoneLabel), findsOneWidget);
    expect(find.widgetWithText(TextField, loginCodeLabel), findsOneWidget);
    // ★ 负向对照：一个"密码"框都不许留（R4：它挡住 06）
    expect(find.text('密码'), findsNothing);
    expect(find.textContaining('密码'), findsNothing, reason: '★ 连"忘了密码"那种也要拿掉');
  });

  testWidgets('🔴 **那串码一个字都不许写在屏上**（主人 2026-09-21 定的：验证码是掩码）', (tester) async {
    // ⚠️ **这条判据原来是反的**：那时"临时码写在屏上"被当成"如实"。
    //    主人 2026-09-21 把它推翻了 —— 写在屏上 = 谁看见谁就能进，
    //    而"验证码"这三个字就变成了摆设。
    await _pump(tester, status: 200, body: '{"token":"t"}');
    expect(find.textContaining('123456'), findsNothing, reason: '🔴 码不许出现在屏上');
    expect(find.textContaining('临时码'), findsNothing, reason: '🔴 别用"临时码"这种说法告诉他在哪拿');
    // ⚠️ 但**要留一条"怎么拿到它"的路**（不然人们不知道该怎么登录）
    expect(find.widgetWithText(OutlinedButton, loginSendCode), findsOneWidget,
        reason: '★ 主人点名：找不到获取验证码的按钮');
    expect(find.text(loginTempCodeNote), findsOneWidget, reason: '★ 那一路要如实说清楚');
  });

  testWidgets('★ 按【获取验证码】⇒ 说"还没接短信"（**码不回界面**）', (tester) async {
    await _pump(tester, status: 503, body: '{"error":"no-sms"}');
    await tester.tap(find.widgetWithText(OutlinedButton, loginSendCode));
    await tester.pumpAndSettle();
    expect(find.text(loginSendNoSms), findsOneWidget);
    expect(find.textContaining('123456'), findsNothing);
  });

  testWidgets('🔴 码不对（401）⇒ 说"验证码不对"，**不许**说成"还没接短信"', (tester) async {
    await _pump(tester, status: 401, body: '{"error":"bad-code"}');
    await _fill(tester);
    expect(find.text(loginErrCode), findsOneWidget);
    expect(find.text(loginErrNoSms), findsNothing, reason: '★ 两件事不许混');
  });

  testWidgets('🔴 还没接短信（503）⇒ 说那一句，**不许**说成"码错了"', (tester) async {
    await _pump(tester, status: 503, body: '{"error":"no-sms"}');
    await _fill(tester);
    expect(find.text(loginErrNoSms), findsOneWidget);
    expect(find.text(loginErrCode), findsNothing, reason: '★ 两件事不许混（这条是负向对照）');
  });

  testWidgets('手机号不像（400）⇒ 让它数位数，不是笼统一句"失败"', (tester) async {
    await _pump(tester, status: 400, body: '{"error":"bad-phone"}');
    await _fill(tester, phone: '12345');
    expect(find.text(loginErrPhone), findsOneWidget);
  });

  testWidgets('连不上 ⇒ 说"网回来自己进"（**不是**"你输错了"）', (tester) async {
    final api = Api(client: MockClient((_) async => throw Exception('网断了')));
    await tester.pumpWidget(MaterialApp(home: LoginScreen(api: api, onLoggedIn: (_) {})));
    await tester.pumpAndSettle();
    await _fill(tester);
    expect(find.text(loginErrNetwork), findsOneWidget);
  });

  testWidgets('🔴 登录页**留着首页那个 header**，而且返回箭头能回首页', (tester) async {
    // 主人 2026-09-22：*"登录页应该能回到首页。所以首页那个 header 也留在登录页吧。"*
    var back = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(
          api: Api(base: 'http://127.0.0.1:1'),
          onLoggedIn: (String _) {},
          onBack: () => back += 1,
        ),
      ),
    );
    await tester.pump();
    // header 三样：标志（那块红方块里的字）+ 红小标 + 大标题
    expect(find.text(landingBrand), findsOneWidget, reason: '标志要在（和首页同一份）');
    expect(find.text(landingKicker), findsOneWidget, reason: '红小标要在');
    expect(find.text(landingPromise), findsOneWidget, reason: '大标题要在');
    // 返回箭头：点了要**通知上层回首页**
    expect(find.byTooltip(loginBack), findsOneWidget);
    await tester.tap(find.byTooltip(loginBack));
    await tester.pump();
    expect(back, 1, reason: '箭头点了要回首页');
  });

  testWidgets('⚠️ 不给 onBack ⇒ **不画那个箭头**（单看这一屏的测试不受影响）', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(api: Api(base: 'http://127.0.0.1:1'), onLoggedIn: (String _) {}),
      ),
    );
    await tester.pump();
    expect(find.byTooltip(loginBack), findsNothing);
  });
}
