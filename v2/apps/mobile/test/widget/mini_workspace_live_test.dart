// **"那一间的内容变了 ⇒ 正开着它的那个界面自己换一帧"**（契约
// `docs/dev/112-OWN-APP-IS-LIVE.md` · 判据 V5）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   V5-① 🔴 正开着 A、收到 A 的"内容变了" ⇒ **自动重取一次清单**
//         ＋ **换到新那一帧**（新 exp ⇒ 新签 URL ⇒ 新 `viewId` ⇒ 换 iframe）。
//   V5-② 🔴 收到的是**别的** app 的 ⇒ **一个像素都不动、一个请求都不发**。
//   V5-③ **没开着**任何小程序 ⇒ 不白屏、不报错（也没人可换）。
//   V5-④ 🔴 旧 viewId **收干净**（挂载那本账里只剩新的那一个）。
//
// ⚠️ 判据只能打**客户端这一侧**（V13）：`flutter test` 跑在 VM 上
//    （`mini_runtime` 是 stub、没有 `dart:html`）⇒ "iframe 换没换"在 VM 上看不到，
//    能看到的、而且**就是换帧那一刀**的，是 `MiniAppFrame` 上的 `entryUrl`/`viewId`。
// ⚠️ `test/widget` 是**提示档**；纯逻辑那一半在 `test/unit/mini_workspace_change_test.dart`，
//    硬闸在 `scripts/check-client.sh`。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:hupo_app/models/mini_frame.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/mini_app_frame.dart';

/// 第 [served] 次问清单时给的那一条（**活地址**：`/w/<id>/<entry>`；
/// URL 每次都带新的 exp/签名 —— 服务端**现签**就是这样）。
Map<String, Object?> _entry({
  String id = 'dice',
  String title = '掷骰子',
  String mark = 'a',
}) =>
    {
      'id': id,
      'title': title,
      'icon': 'dice',
      'version': 1, // ⚠️ 字段照旧给，但**换不换帧不看它**（用户端没有"版本"这回事）
      'entry': 'index.html',
      'entryUrl': 'http://127.0.0.1:8021/w/$id/index.html?u=u1&e=99999999999999&s=$mark',
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

/// 泵出那一屏（照 `test/widget/mini_live_update_test.dart`）。
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

/// 服务端推一条"那一间的内容变了"（**瞬态**：没有 `seq`、没有版本号）。
void _pushLive(ChatController c, String id) {
  c.ingest({'type': 'app/workspace-changed', 'id': id, 'at': 1});
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('🔴 V5：正开着它、收到"内容变了" ⇒ **自动重取清单 ＋ 换到新 URL**（不用他刷新）',
      (tester) async {
    // 第 1 次：旧签名；之后：新签名（服务端现签 ⇒ 每次都不同）
    final fake = _apiWith((served) => [_entry(mark: served >= 2 ? 'live2' : 'live1')]);
    final c = await _pump(tester, fake.api);
    await _openApp(tester, '掷骰子');
    expect(fake.served.length, 1, reason: '开机拉过一次');
    final before = _frame(tester);
    expect(before.entryUrl.contains('live1'), true, reason: '开的是原来那一条活地址');

    _pushLive(c, 'dice');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    expect(fake.served.length, 2, reason: '★ 正开着 ⇒ 该**自动重取一次清单**（拿新签的活地址）');
    final after = _frame(tester);
    expect(after.entryUrl.contains('live2'), true,
        reason: '★ 容器里那一帧该换成新 URL（换 URL ⇒ 换 viewId ⇒ 换 iframe）');
    expect(after.viewId == before.viewId, false, reason: '★ 换了 URL 就得换 viewId');
  });

  testWidgets('🔴 V5（反例）：收到的是**别的**小程序的 ⇒ 一个像素都不动（也不多打一次接口）',
      (tester) async {
    final fake = _apiWith((served) => [
      _entry(id: 'dice', title: '掷骰子', mark: 'dice1'),
      _entry(id: 'other', title: '别的东西', mark: 'other1'),
    ]);
    final c = await _pump(tester, fake.api);
    await _openApp(tester, '掷骰子');
    final before = _frame(tester);
    final servedBefore = fake.served.length;

    _pushLive(c, 'other');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    expect(_frame(tester).entryUrl, before.entryUrl, reason: '★ 变的是别人 ⇒ 这一屏不许被搞乱');
    expect(fake.served.length, servedBefore, reason: '★ 连接口都不该多打一次');
  });

  testWidgets('V5（反例）：**没开着**任何小程序 ⇒ 不白屏不报错（也没人可换）', (tester) async {
    final fake = _apiWith((served) => [_entry(mark: served >= 2 ? 'live2' : 'live1')]);
    final c = await _pump(tester, fake.api);
    expect(find.byType(MiniAppFrame), findsNothing, reason: '现在在桌面上');

    final servedBefore = fake.served.length;
    _pushLive(c, 'dice');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull, reason: '不许报错 / 不许白屏');
    expect(fake.served.length, servedBefore, reason: '没开着 ⇒ 不必重取');
  });

  testWidgets('🔴 V5：换了一帧 ⇒ 旧 viewId **收干净**（挂载那本账里只剩新的）', (tester) async {
    final fake = _apiWith((served) => [_entry(mark: served >= 2 ? 'swap2' : 'swap1')]);
    final c = await _pump(tester, fake.api);
    await _openApp(tester, '掷骰子');
    final oldId = _frame(tester).viewId;
    expect(miniViewLedger.isHosted(oldId), true, reason: '开着的这一帧该挂着');

    _pushLive(c, 'dice');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    final newId = _frame(tester).viewId;
    expect(newId == oldId, false);
    expect(miniViewLedger.isHosted(newId), true, reason: '新那一帧该挂上');
    expect(miniViewLedger.isHosted(oldId), false,
        reason: '★ 旧那一帧要收干净（不然它还会替新页面问第二遍）');
  });

  // ⚠️ 这一条盯的是**这一批的真正形状**：用户端那条活地址是 `/w/…`（不是 `/a/<版本>/…`）
  testWidgets('那一帧开的是**活地址**（`/w/`）—— 用户端没有"版本"这回事', (tester) async {
    final fake = _apiWith((served) => [_entry(mark: 'w1')]);
    await _pump(tester, fake.api);
    await _openApp(tester, '掷骰子');
    expect(_frame(tester).entryUrl.contains('/w/dice/index.html'), true);
    expect(_frame(tester).entryUrl.contains('/a/'), false, reason: '制品那一条是市场那一侧的事');
  });
}
