// **"这个小程序有新版了 ⇒ 正开着它的那个界面自己换上"**（契约
// `docs/dev/111-APP-LIVE-UPDATE.md` · 判据 U2/U3/U4/U5）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   U2 🔴 正开着 A、收到 A 的更新 ⇒ **自动取了新清单**（`/api/apps` 又被问了一次）
//         ＋ **iframe 换到新 URL**（那一帧的 `entryUrl` 变了）。
//   U3 🔴 收到的是**别的** app 的更新 ⇒ **不换**（帧还是原来那一帧，接口也不多打一次）。
//   U4 没开着那个小程序 ⇒ 不白屏、不报错，**如实记一笔**；下次点开它之前先重拉一次清单。
//   U5 🔴 旧 viewId **收干净**（挂载那本账里只剩新的那一个）。
//
// ⚠️ 判据只能打**客户端这一侧**（V13）：`flutter test` 跑在 VM 上
//    （`mini_runtime` 是 stub、没有 `dart:html`）⇒ "iframe 换没换"在 VM 上看不到，
//    能看到的、而且**就是换帧那一刀**的，是 `MiniAppFrame` 上的 `entryUrl`/`viewId`。
// ⚠️ `test/widget` 是**提示档**；同一件事的纯逻辑那一半在
//    `test/unit/mini_live_update_test.dart`，硬闸在 `scripts/check-client.sh`。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:hupo_app/models/app_words.dart';
import 'package:hupo_app/models/mini_frame.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/mini_app_frame.dart';

/// 第 [n] 次问清单时给的那一版（URL 每次都不一样 —— 服务端**现签**就是这样）。
Map<String, Object?> _entry({
  String id = 'dice',
  String title = '掷骰子',
  int version = 1,
  String mark = 'a',
}) =>
    {
      'id': id,
      'title': title,
      'icon': 'dice',
      'version': version,
      'entry': 'index.html',
      'entryUrl': 'http://127.0.0.1:8021/a/$id/$version/index.html?u=u1&e=99999999999999&s=$mark',
      'expiresAt': 99999999999999,
      'permissions': <String>[],
    };

/// 一个假的接口：`/api/apps` 答 `appsFor(第几次问)`，别的一律 404（**不碰真网**）。
({Api api, List<int> served}) _apiWith(List<Object?> Function(int served) appsFor) {
  final served = <int>[];
  final api = Api(
    base: '',
    client: MockClient((req) async {
      if (req.url.path == '/api/apps') {
        served.add(served.length + 1);
        return http.Response(
          jsonEncode({'apps': appsFor(served.length)}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }
      return http.Response('', 404);
    }),
  );
  return (api: api, served: served);
}

/// 泵出那一屏（照 `remote_app_test.dart`）。
Future<ChatController> _pump(WidgetTester tester, Api api) async {
  final c = ChatController(api: api, tokens: TokenStore(), token: '测试令牌');
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        controller: c,
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pumpAndSettle();
  return c;
}

/// 桌上那一格（真实路径：点图标）。
Future<void> _openApp(WidgetTester tester, String label) async {
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

/// 现在容器里那一帧。
MiniAppFrame _frame(WidgetTester tester) =>
    tester.widget<MiniAppFrame>(find.byType(MiniAppFrame));

/// 服务端推一条"有新版了"。
void _pushUpdate(ChatController c, String id, int version, {int seq = 900}) {
  c.ingest({
    'type': 'app/update-available',
    'id': id,
    'version': version,
    'at': 1,
    'seq': seq,
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('🔴 U2：正开着它、收到它的更新 ⇒ **自动重拉清单 ＋ 换到新 URL**（不用他刷新）',
      (tester) async {
    // 第 1 次：v1；之后：v2（新的一版、新签的 URL）
    final fake = _apiWith((served) => [
      _entry(version: served >= 2 ? 2 : 1, mark: served >= 2 ? 'v2' : 'v1'),
    ]);
    final c = await _pump(tester, fake.api);
    await _openApp(tester, '掷骰子');
    expect(fake.served.length, 1, reason: '开机拉过一次');
    final before = _frame(tester);
    expect(before.entryUrl.contains('v1'), true, reason: '开的是旧那一版');

    _pushUpdate(c, 'dice', 2);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    expect(fake.served.length, 2, reason: '★ 正开着 ⇒ 该**自动重拉一次清单**（拿新那一版）');
    final after = _frame(tester);
    expect(after.entryUrl.contains('v2'), true,
        reason: '★ 容器里那一帧该换成新 URL（换 URL ⇒ 换 viewId ⇒ 换 iframe）');
    expect(after.viewId == before.viewId, false, reason: '★ 换了 URL 就得换 viewId');
  });

  testWidgets('🔴 U3：收到的是**别的**小程序的更新 ⇒ 一个像素都不动（也不多打一次接口）',
      (tester) async {
    final fake = _apiWith((served) => [
      _entry(id: 'dice', title: '掷骰子', version: 1, mark: 'dice1'),
      _entry(id: 'other', title: '别的东西', version: 1, mark: 'other1'),
    ]);
    final c = await _pump(tester, fake.api);
    await _openApp(tester, '掷骰子');
    final before = _frame(tester);
    final servedBefore = fake.served.length;

    _pushUpdate(c, 'other', 2);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    expect(_frame(tester).entryUrl, before.entryUrl, reason: '★ 换的是别人 ⇒ 这一屏不许被搞乱');
    expect(fake.served.length, servedBefore, reason: '★ 连接口都不该多打一次');
  });

  testWidgets('🔴 U3（对照）：同一个版本号再来一次 ⇒ **不换**（补发/重复不许白换一帧）',
      (tester) async {
    final fake = _apiWith((served) => [_entry(version: served >= 2 ? 2 : 1, mark: served >= 2 ? 'v2' : 'v1')]);
    final c = await _pump(tester, fake.api);
    await _openApp(tester, '掷骰子');
    final before = _frame(tester);
    final servedBefore = fake.served.length;

    _pushUpdate(c, 'dice', 1); // 就是现在这一版
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    expect(_frame(tester).entryUrl, before.entryUrl, reason: '已经在这一版上了');
    expect(fake.served.length, servedBefore, reason: '★ 白拉一次清单就是白换一帧');
  });

  testWidgets('U4：**没开着**它 ⇒ 不白屏不报错，如实记一笔；下次点开之前先重拉一次',
      (tester) async {
    final fake = _apiWith((served) => [
      _entry(version: served >= 2 ? 2 : 1, mark: served >= 2 ? 'v2' : 'v1'),
    ]);
    final c = await _pump(tester, fake.api);
    // 桌面上（没开任何小程序）
    expect(find.byType(MiniAppFrame), findsNothing);

    _pushUpdate(c, 'dice', 2);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();
    expect(c.appUpdates['dice'], 2, reason: '★ 如实记一笔');
    expect(tester.takeException(), isNull, reason: '不许报错 / 不许白屏');

    final servedBefore = fake.served.length;
    await _openApp(tester, '掷骰子');
    expect(fake.served.length, servedBefore + 1,
        reason: '★ 听说有新版 ⇒ 点开之前先重拉一次（不然点开还是旧那一版）');
    expect(_frame(tester).entryUrl.contains('v2'), true, reason: '点开的就是新那一版');
  });

  testWidgets('🔴 U5：换了一帧 ⇒ 旧 viewId **收干净**（挂载那本账里只剩新的）', (tester) async {
    final fake = _apiWith((served) => [
      _entry(version: served >= 2 ? 2 : 1, mark: served >= 2 ? 'swap2' : 'swap1'),
    ]);
    final c = await _pump(tester, fake.api);
    await _openApp(tester, '掷骰子');
    final oldId = _frame(tester).viewId;
    expect(miniViewLedger.isHosted(oldId), true, reason: '开着的这一帧该挂着');

    _pushUpdate(c, 'dice', 2);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    final newId = _frame(tester).viewId;
    expect(newId == oldId, false);
    expect(miniViewLedger.isHosted(newId), true, reason: '新那一帧该挂上');
    expect(miniViewLedger.isHosted(oldId), false, reason: '★ 旧那一帧要收干净（不然它还会替新页面问第二遍）');
    expect(miniViewLedger.hosted.contains(oldId), false);
    // ⚠️ "注册那本账只增不减"在**这一层验不到**：VM 上 `mini_runtime` 是 stub，
    //    `register` 只有 Web 那一侧才会叫（那份在读源码那条判据 +
    //    `test/unit/mini_live_update_test.dart` 里直接驱动账本那一半）。
  });

  testWidgets('U5（另一半）：关掉这一屏 ⇒ 那一帧也收干净（不留常驻监听）', (tester) async {
    final fake = _apiWith((served) => [_entry(version: 1, mark: 'close1')]);
    await _pump(tester, fake.api);
    await _openApp(tester, '掷骰子');
    final id = _frame(tester).viewId;
    expect(miniViewLedger.isHosted(id), true);

    // 关掉小程序（容器顶栏那个返回 ⇒ 退回桌面）
    await tester.tap(find.byTooltip(miniAppBack));
    await tester.pumpAndSettle();
    expect(miniViewLedger.isHosted(id), false, reason: '★ 关掉了就该销号');
  });

  // ⚠️ 这条只是把"判据钉在真那一层"说清：换帧的**唯一**入口是 `MiniAppFrame`
  testWidgets('那一帧就是容器里那一个孩子（不是另开一层）', (tester) async {
    final fake = _apiWith((served) => [_entry()]);
    await _pump(tester, fake.api);
    await _openApp(tester, '掷骰子');
    expect(find.byType(MiniAppFrame), findsOneWidget);
    expect(find.text(appRuntimeNotHere), findsOneWidget, reason: 'VM 上是那句实话（不是白屏）');
  });
}
