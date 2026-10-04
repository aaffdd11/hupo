// **桌面自己会刷新**（主人 2026-10-04 报的真缺陷：
//   *"桌面并没有自动刷新。就是app做好了没有刷新。我们要有刷新机制。"*）。
//
// ── 这一份钉什么（三半，缺一条那种"刷新机制"就还是漏的）────
//   ① **服务端说"桌面可能变了"**（`app/installed` 瞬态）⇒ 当场重拉清单
//      （那一格从"灰的在建"变回来 —— 不用他手动刷新页面）
//   ② **退回桌面那一下**（点 home 关掉正开着的小程序）⇒ 重拉一次
//      （他开着小程序的那段时间，服务端那些帧是按焦点路由的 ⇒ 他一条都收不到）
//   ③ **从后台回到这一屏**（手机切回来 / 浏览器标签切回来）⇒ 也重拉一次
//
// ⚠️ 负向对照：**每次回到桌面都真的发了一次清单请求**（不是"看起来新了"）——
//    量的是 `/api/apps` 被问了几次。
// ⚠️ 形状照 `test/widget/app_building_test.dart`（同一族的泵法：**不许 `pumpAndSettle`**，
//    在建那一格上有个永远转着的圈）。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/widgets/mini_app_host.dart';
import 'package:hupo_app/models/app_words.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/app_desktop.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const String _title = '刷新那个';
const String _id = 'shuaxin';

Map<String, Object?> _entry({required bool building}) => {
  'id': _id,
  'title': _title,
  'icon': 'list',
  'version': 1,
  'entry': 'index.html',
  'entryUrl': 'http://127.0.0.1:8021/w/$_id/index.html?e=99999999999999&s=ab',
  'expiresAt': 99999999999999,
  'permissions': <String>[],
  'granted': <String>[],
  'unanswered': <String>[],
  'building': building,
  'working': false,
};

/// 一份"会变"的清单：**第几次问**由调用方决定给什么（判据据此数请求次数）。
class _Server {
  int calls = 0;
  bool building = true;
  late final Api api = Api(
    base: '',
    client: MockClient((req) async {
      if (req.url.path == '/api/apps') {
        calls += 1;
        return http.Response(jsonEncode({'apps': [_entry(building: building)]}), 200,
            headers: {'content-type': 'application/json'});
      }
      return http.Response('', 404);
    }),
  );
}

class _Harness {
  _Harness(this.server, this.controller);
  final _Server server;
  final ChatController controller;
}

Future<_Harness> _pump(WidgetTester tester) async {
  final server = _Server();
  final controller = ChatController(api: server.api, tokens: TokenStore(), token: '测试令牌');
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        controller: controller,
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 50));
  return _Harness(server, controller);
}

Color? _tileColor(WidgetTester tester) {
  final c = tester.widget<Container>(find.byKey(desktopIconBoxKey(_title)));
  return (c.decoration as BoxDecoration?)?.color;
}

void main() {
  testWidgets('🔴 服务端说"桌面可能变了" ⇒ 当场重拉清单（那一格不再是灰的）', (tester) async {
    final h = await _pump(tester);
    expect(h.server.calls, 1, reason: '前提：进来先拉了一次');
    expect(_tileColor(tester), d.line, reason: '前提：服务端说他"在建" ⇒ 那一格是灰的');

    // 服务端那边"入口写完了" ⇒ 推一条 `app/installed`（真机上就是那一条瞬态）
    h.server.building = false;
    h.controller.ingest(<String, dynamic>{'type': 'app/installed', 'appId': _id, 'title': _title});
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(h.server.calls, 2, reason: '★ 收到那一帧必须**真的再问一次**（不是只重画）');
    expect(_tileColor(tester) == d.line, isFalse, reason: '★ 清单换了 ⇒ 那一格不该还是灰的');
    expect(find.byType(CircularProgressIndicator), findsNothing, reason: '★ 那个"在建"的圈要收掉');
  });

  testWidgets('🔴 退回桌面那一下 ⇒ 重拉一次（他开着小程序时收不到那些帧）', (tester) async {
    final h = await _pump(tester);
    h.server.building = false;
    h.controller.ingest(<String, dynamic>{'type': 'app/installed', 'appId': _id});
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));
    final before = h.server.calls;

    // 打开它（这一屏盖住桌面）—— 然后按 home 回桌面
    await tester.tap(find.text(_title).first);
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 120));
    }
    expect(find.text(appRuntimeNotHere), findsOneWidget, reason: '前提：他真进了那一屏');
    h.server.building = true; // 假装"离开的这一会儿，桌面那一格又变了"
    await tester.tap(find.byKey(miniAppExitKey));
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 120));
    }
    expect(h.server.calls, greaterThan(before), reason: '★ 回到桌面必须重拉一次清单');
    expect(find.text(_title), findsWidgets, reason: '回到桌面 ⇒ 桌面那一屏在');
  });

  testWidgets('🔴 从后台切回来 ⇒ 也重拉一次（没人在看的那段时间变的事）', (tester) async {
    final h = await _pump(tester);
    final before = h.server.calls;
    // ⚠️ 生命周期那几步**要按 Flutter 认得出那条路走**
    //    （`resumed → inactive → hidden → paused → hidden → inactive → resumed`）：
    //    跳着发，框架自己那个 `AppLifecycleListener` 会当场断言。
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(h.server.calls, before, reason: '离开后台那一下不必拉（他看不见）');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(h.server.calls, greaterThan(before), reason: '★ 回到这一屏要重拉一次');
  });
}
