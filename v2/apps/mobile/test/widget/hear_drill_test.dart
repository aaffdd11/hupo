// **设置里那一场"说一句试试"**（V2.0 第一件 · 主人 2026-10-04）。
//
// ── 这一份钉什么（三件，一件都不能少）──────────────────────
//   ① **从设置里进得去**（那一行在、点得开）
//   ② 整条链子走得通：他说的那一句 ⇒ **听成字** ⇒ **最终那一份摆出来**（字看得见）
//      —— 用嘴那条路与打字那条兜底路都量
//   ③ 🔴 **整场一次都不许真发出去**（`/api/say` 一次都不能被叫）—— 主人说的是
//      *"无效的、空白的、临时的……一个演练"*，这一条就是"无效"那两个字。
//
// 🔴 **2026-10-07：那一层"抽离"删了**（主人：*"我们之前对语音，是抽离出来做了一层，
//   没问题才发给聊天的。现在我需要把这个抽离的部分给去掉。"*）⇒ 原来那三条量
//   "问一句 / 最多两轮 / 打开开关"的判据**整族删掉**：这一屏现在**不问那一层**，
//   听到什么就是什么（`/api/hear` 一次都不许被叫）。
//
// ⚠️ 这一份跑在 VM 上（`canHear == false`）⇒ 界面上给的是**打字兜底**那一格
//    （正好也把那条路验了）；真机上是那颗麦走同一条链子。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hear_words.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/hear_drill_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/hearing.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 服务端那一头（**记下每一次请求** —— 判据要数"发了几次"）。
class _Server {
  final List<String> paths = [];
  int sayCalls = 0;
  int hearCalls = 0;

  late final Api api = Api(
    base: '',
    client: MockClient((req) async {
      paths.add(req.url.path);
      if (req.url.path == '/api/apps') {
        return http.Response(jsonEncode({'apps': <Object>[]}), 200,
            headers: {'content-type': 'application/json'});
      }
      if (req.url.path == '/api/hear') {
        // 🔴 这一层删了 ⇒ 走到这儿就是判据要抓的事（`hearCalls` 必须是 0）
        hearCalls += 1;
        return http.Response(jsonEncode({'error': '这一层已经删了'}), 500,
            headers: {'content-type': 'application/json'});
      }
      if (req.url.path == '/api/say') {
        sayCalls += 1;
        return http.Response(jsonEncode({'ok': true}), 200, headers: {'content-type': 'application/json'});
      }
      return http.Response('', 404);
    }),
  );
}

Future<_Server> _pump(WidgetTester tester) async {
  final server = _Server();
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        controller: ChatController(api: server.api, tokens: TokenStore(), token: '测试令牌'),
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 50));
  return server;
}

/// 进设置 ⇒ 点开那一行。
Future<void> _openDrill(WidgetTester tester) async {
  await tester.tap(find.text('设置').first);
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
  // ⚠️ 那一行在设置一列里靠下（四把钥匙 ＋ 壁纸之后）⇒ 手机上要滚一下才看得到，
  //    判据里也一样（**滚动本身也是"他能不能够得着"的一部分**）。
  await tester.dragUntilVisible(
    find.text(hearDrillTitle),
    find.byKey(settingsListKey),
    const Offset(0, -120),
  );
  await tester.pump();
  expect(find.text(hearDrillTitle), findsWidgets, reason: '★ 设置里要有那一行');
  await tester.tap(find.text(hearDrillTitle).first);
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
  expect(find.text(hearDrillBanner), findsOneWidget, reason: '★ 先说清"不会发出去"');
}

Future<void> _typeAndSend(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(hearDrillTypeKey), text);
  await tester.pump();
  await tester.tap(find.byKey(hearDrillAnswerKey));
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

/// **一条假的"真开麦"**（把原生那个钩子装上 ⇒ 界面上那颗麦就会画出来）。
///
/// 🔴 这一条是**补的**：2026-10-04 主人在真机上试出来"能转文字、没有后文" ——
///    根子是**麦克风那条路从没被判据走过**（打字那条路验了，说话那条没有）。
///    这一份就照着**真机那一串帧**喂：`asr/ready` → `asr/partial` → `asr/final` → `asr/end`。
class _FakeHearing implements NativeHearingApi {
  void Function(Map<String, dynamic>)? _on;
  bool started = false;

  @override
  bool get canHear => true;

  @override
  Future<String?> start({
    required Uri url,
    required String token,
    required void Function(Map<String, dynamic>) onEvent,
  }) async {
    started = true;
    _on = onEvent;
    return null;
  }

  @override
  void stop() {}

  @override
  Future<void> warm({required Uri url, required String token}) async {}

  void push(Map<String, dynamic> e) => _on?.call(e);
}

void main() {
  testWidgets('🔴 从设置进得去，整条链子走一遍；**一次都不发出去**', (tester) async {
    final s = await _pump(tester);
    await _openDrill(tester);

    // ── ① 他说的那一句（VM 上开不了麦 ⇒ 打字兜底那一格）──
    expect(find.text(hearDrillTypeInstead), findsOneWidget, reason: '★ 开不了麦就如实说，并给打字那条路');
    await _typeAndSend(tester, '把上周的账理一下');
    // ── ② 手上那份字**就是最终那一份**（没有第二层、一个字都不改）──
    expect(find.text('把上周的账理一下'), findsOneWidget, reason: '★ 听到什么就摆什么');
    expect(find.text(hearDrillReadyFoot), findsOneWidget, reason: '★ 说清"就停在这儿"');

    // ── ③ 🔴 整场**一次都没发**（"无效"那两个字）──
    expect(s.sayCalls, 0, reason: '★★ 演练里一次都不许真发出去');
    expect(s.paths.contains('/api/say'), false, reason: '★★ 连那一条口都不该碰');
    expect(s.hearCalls, 0, reason: '★★ 那一层删了：这一屏也不许再调它');
  });

  testWidgets('🔴 用嘴说那条路：字出来了就要有**后文**（最终那一份摆在屏幕上）', (tester) async {
    final fake = _FakeHearing();
    nativeHearingApi = fake;
    addTearDown(clearNativeHearing);

    final s = await _pump(tester);
    await _openDrill(tester);
    // 这颗麦：开得了 ⇒ 界面上就该有它
    expect(find.byKey(hearDrillMicKey), findsOneWidget);
    await tester.tap(find.byKey(hearDrillMicKey));
    await tester.pump();
    expect(fake.started, true, reason: '前提：麦真开起来了');

    // ── 真机那一串帧 ──
    fake.push({'type': 'asr/ready'});
    fake.push({'type': 'asr/partial', 'text': '帮我把上周的账'});
    await tester.pump();
    expect(find.textContaining('帮我把上周的账'), findsWidgets, reason: '半句也要看得见');
    fake.push({'type': 'asr/final', 'text': '帮我把上周的账理一下'});
    fake.push({'type': 'asr/end', 'text': '帮我把上周的账理一下', 'reason': 'upstream'});
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 120));
    }
    // ★ 这一条就是主人报的那个缺陷：原来是**没有后文**（一个字都不再动）
    expect(find.text('帮我把上周的账理一下'), findsWidgets, reason: '★ 要有后文：最终那一份得摆出来');
    expect(find.text(hearDrillReadyFoot), findsOneWidget);
    expect(s.hearCalls, 0, reason: '★★ 那一层删了：这一条路也不许调它');
    expect(s.sayCalls, 0, reason: '★★ 演练里仍然一次都不发');
  });

  testWidgets('🔴 说了一整段（几句）⇒ 最终那一份是**整段**，一个字都不少', (tester) async {
    final fake = _FakeHearing();
    nativeHearingApi = fake;
    addTearDown(clearNativeHearing);

    final s = await _pump(tester);
    await _openDrill(tester);
    await tester.tap(find.byKey(hearDrillMicKey));
    await tester.pump();

    fake.push({'type': 'asr/ready'});
    fake.push({'type': 'asr/partial', 'text': '你好啊，'});
    fake.push({'type': 'asr/final', 'text': '你好啊，'});
    fake.push({'type': 'asr/partial', 'text': '我说两句试试'});
    fake.push({'type': 'asr/final', 'text': '我说两句试试'});
    fake.push({'type': 'asr/end', 'text': '你好啊，我说两句试试', 'reason': 'user-stop'});
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 120));
    }
    expect(find.text('你好啊，我说两句试试'), findsWidgets,
        reason: '★ 整段都要在（"前面那句话没了"那一族不许回来）');
    expect(s.sayCalls, 0);
  });
}
