// **设置里那一场"说一句试试"**（V2.0 第一件 · 主人 2026-10-04）。
//
// ── 这一份钉什么（三件，一件都不能少）──────────────────────
//   ① **从设置里进得去**（那一行在、点得开）
//   ② 整条链子走得通：他说的那一句 ⇒ **先被听懂**（`/api/hear`）⇒ 不确定就**问回来**
//      ⇒ 他答 ⇒ 再懂一遍 ⇒ **最终那一份**摆在屏幕上（字看得见）
//   ③ 🔴 **整场一次都不许真发出去**（`/api/say` 一次都不能被叫）—— 主人说的是
//      *"无效的、空白的、临时的……一个演练"*，这一条就是"无效"那两个字。
//
// ⚠️ 这一份跑在 VM 上（`canHear == false`）⇒ 界面上给的是**打字兜底**那一格
//    （正好也把那条路验了）；真机上是那颗麦走同一条链子。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/semantic_switch.dart';
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
        hearCalls += 1;
        // 第一次：有一处不确定 ⇒ 问一句；第二次：可以了
        final body = hearCalls == 1
            ? {'heard': '把上周的账理一下。', 'ask': '是上周还是上个月？', 'fact': 'time', 'scene': 'do'}
            : {'heard': '帮我把上周的账理清楚。', 'ask': null, 'fact': '', 'scene': 'do'};
        return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
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
///    这一份就照着**真机那一串帧**喂：`asr/ready` → `asr/partial` → `asr/final` → `asr/end`，
///    而且 `asr/end` **带原因**（网页那一份在停顿处收尾时就是带原因的）。
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

  void push(Map<String, dynamic> e) => _on?.call(e);
}

void main() {
  // 🔴 **2026-10-06**：这一屏原来展示的是"听懂那一层理顺之后的样子"；主人当天说
  //   *「先暂停语义检查」* ⇒ 生产里**不问那一层**了（显示的是语音转文字的原话）。
  //   下面那三条量的仍是**打开着**那条路（代码还在）⇒ 这里临时打开；验完还原。
  //   ⚠️ **"关着"那一档**（生产形状）由这一份最后那一条单独钉住。
  setUp(() => semanticCheckOn = true);
  tearDown(() => semanticCheckOn = false);

  testWidgets('🔴 从设置进得去，整条链子走一遍；**一次都不发出去**', (tester) async {
    final s = await _pump(tester);
    await _openDrill(tester);

    // ── ① 他说的第一句（VM 上开不了麦 ⇒ 打字兜底那一格）──
    expect(find.text(hearDrillTypeInstead), findsOneWidget, reason: '★ 开不了麦就如实说，并给打字那条路');
    await _typeAndSend(tester, '把上周的账理一下');
    expect(s.hearCalls, 1, reason: '★ 说完要先送进听懂那一层（而不是直接发）');
    // ── ② 它问回来那一句（字在屏幕上）──
    expect(find.text('是上周还是上个月？'), findsOneWidget, reason: '★ 不确定就要问回来');
    // ⚠️ 按 key 找那一格（聊天那条输入框还在树里 ⇒ `byType` 会数到两个）
    expect(find.byKey(hearDrillTypeKey), findsOneWidget, reason: '★ 他在这一屏答得出来（打字兜底）');

    // ── ③ 他答一句 ⇒ 再懂一遍 ⇒ 最终那一份摆出来 ──
    await _typeAndSend(tester, '上周');
    expect(s.hearCalls, 2, reason: '★ 答完要再懂一遍');
    expect(find.text('帮我把上周的账理清楚。'), findsOneWidget, reason: '★ 最终那一份要看得见');
    expect(find.text(hearDrillReadyFoot), findsOneWidget, reason: '★ 说清"就停在这儿"');

    // ── ④ 🔴 整场**一次都没发**（"无效"那两个字）──
    expect(s.sayCalls, 0, reason: '★★ 演练里一次都不许真发出去');
    expect(s.paths.contains('/api/say'), false, reason: '★★ 连那一条口都不该碰');
  });

  testWidgets('🔴 它问了两轮还没问完 ⇒ 按已经听懂的那份停住（也不发）', (tester) async {
    final s = _Server();
    // 这一趟：两次都还要问 ⇒ 界面上必须**到上限就不再问**
    var calls = 0;
    final api = Api(
      base: '',
      client: MockClient((req) async {
        if (req.url.path == '/api/apps') {
          return http.Response(jsonEncode({'apps': <Object>[]}), 200, headers: {'content-type': 'application/json'});
        }
        if (req.url.path == '/api/hear') {
          calls += 1;
          return http.Response(
            jsonEncode({'heard': '第 $calls 遍听懂的。', 'ask': '还要问第 $calls 轮？', 'scene': 'do'}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        if (req.url.path == '/api/say') {
          s.sayCalls += 1;
        }
        return http.Response('', 404);
      }),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          controller: ChatController(api: api, tokens: TokenStore(), token: '测试令牌'),
          onLoggedOut: () {},
          space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
          onSendKey: (_) async => KeySend.ok,
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await _openDrill(tester);
    await _typeAndSend(tester, '帮我做个小程序');
    await _typeAndSend(tester, '要');   // 第一轮答完（还想问）
    await _typeAndSend(tester, '要');   // 第二轮答完 ⇒ 上限到了
    expect(calls, 3, reason: '★ 问了两轮就够（第三遍是收尾那一遍）');
    expect(find.textContaining('第 3 遍听懂的'), findsOneWidget, reason: '★ 到上限就按这份走');
    expect(find.text(hearDrillReadyFoot), findsOneWidget);
    expect(s.sayCalls, 0, reason: '★★ 还是不许发');
  });

  testWidgets('🔴 用嘴说那条路：字出来了就要有**后文**（问一句 / 最终那一份）', (tester) async {
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

    // ── 真机那一串帧（收尾**带原因** —— 网页那一份在停顿处就是这样）──
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
    expect(s.hearCalls, 1, reason: '★ 说完了就要送进听懂那一层（带原因收尾也算说完）');
    expect(find.text('是上周还是上个月？'), findsOneWidget, reason: '★ 要有后文：它得问回来');

    // ── 他答一句（还是用嘴）⇒ 最终那一份 ──
    await tester.tap(find.byKey(hearDrillMicKey));
    await tester.pump();
    fake.push({'type': 'asr/final', 'text': '上周'});
    fake.push({'type': 'asr/end', 'text': '上周'});
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 120));
    }
    expect(s.hearCalls, 2, reason: '★ 答完要再懂一遍');
    expect(find.text('帮我把上周的账理清楚。'), findsOneWidget, reason: '★ 最终那一份要看得见');
    expect(s.sayCalls, 0, reason: '★★ 演练里仍然一次都不发');
  });

  testWidgets('🔴 **关着**（现在这一档）：不问那一层，直接把原话当最终那一份 ＋ 明说一句', (tester) async {
    // ★ 2026-10-06：主人说"先暂停语义检查" ⇒ 这一屏**不调 `/api/hear`**，
    //   显示的是**语音转文字的原话**，并且顶上如实说一句（不然他会以为"它没听懂"）。
    semanticCheckOn = false;
    final s = await _pump(tester);
    await _openDrill(tester);

    await _typeAndSend(tester, '帮我把上周的账理清楚');

    expect(s.hearCalls, 0, reason: '★ 说了"暂停语义检查"，这一屏却还是调了它');
    expect(find.text('帮我把上周的账理清楚'), findsOneWidget,
        reason: '★ 要把**原话**当最终那一份摆出来（一个字都不许改）');
    expect(find.text(hearDrillPausedNote), findsOneWidget,
        reason: '★ 得如实说一句"现在不做语义检查"');
    expect(s.sayCalls, 0, reason: '★★ 演练里仍然一次都不发');
  });
}
