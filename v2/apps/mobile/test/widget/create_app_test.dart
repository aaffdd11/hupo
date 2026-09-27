// **桌面上那颗「创建小程序」加号**（主人 2026-09-27 ·
// 契约 `docs/dev/127-CREATE-APP-FROM-DESKTOP.md`）。
//
// 原话：*"帮我在 home 那边增加一个加号，要比较显著的有 UI 上面的区分，就是一个空心加号，
// 然后这个叫做创建工作区或者叫创建小程序，我觉得就叫创建小程序吧，然后点击它以后会出现一个
// 浮窗，然后它就可以选择小程序名字…创建小程序名字是必须的，然后还有一个就是描述，
// 这个描述用户可以写也可以不写。点击创建完以后就是一个空白的一个项目，但是它是有一个
// 小程序 icon 的，然后点击那个 icon 就可以进入小程序。"*
//
// ⚠️ `test/widget`（**提示档**）—— 它钉的是"这一刀有没有画到屏幕上"。
//    当闸的两条在别处：五档不溢出 + 命中区 ≥44（`accessibility_test.dart`）。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/app_desktop.dart';
import 'package:hupo_app/widgets/chat_floater.dart';

/// 一份"桌面会长出一个我的小程序"的假服务端（不开端口、不碰真网）。
///
/// ⚠️ **不调 `start()`** ⇒ 一条真 socket 都不会开（那条流只在登录之后才有）。
class _Fake {
  _Fake();

  /// 现在他桌上有哪几个（`create` 成了就往里加一个 —— 与真服务端同一顺序）。
  final List<Map<String, dynamic>> apps = [];

  /// 那一条 `POST /api/app-create` 收到过什么（**一次一条**）。
  final List<Map<String, dynamic>> creates = [];

  /// 让下一条 create **被拒**（试服务端那句人话会不会原样上屏）。
  String? refuseWords;

  ChatController controller() => ChatController(
    // ⚠️ 令牌要**给上**：没有令牌时那一趟会在"还没登录"那一步就回头（判据里那条路
    //    走不到"真的发了请求"）。
    token: 'tok-判据',
    api: Api(
      client: MockClient((r) async {
        if (r.url.path == '/api/apps') {
          return _json(jsonEncode({'apps': apps}));
        }
        if (r.url.path == '/api/app-create') {
          final body = jsonDecode(r.body) as Map<String, dynamic>;
          creates.add(body);
          if (refuseWords != null) {
            return _json(jsonEncode({'error': 'title-too-long', 'text': refuseWords}), 400);
          }
          final id = 'app-new0001';
          apps.add({
            'id': id,
            'title': body['title'],
            'description': body['description'] ?? '',
            'icon': 'dice',
            'version': 1,
            'entryUrl': 'https://apps.example/$id/index.html?sig=x',
            'expiresAt': 0,
          });
          return _json(jsonEncode({'ok': true, 'id': id, 'title': body['title'], 'icon': 'dice'}));
        }
        return _json('{}', 404);
      }),
    ),
    tokens: TokenStore(),
  );

  static http.Response _json(String body, [int status = 200]) => http.Response(
    body,
    status,
    headers: {'content-type': 'application/json'},
  );
}

/// 那一层浮窗里的输入框（**不是**聊天条里那个！`find.byType(TextField).first`
/// 会命中输入条 —— 判据自己栽过一次）。
Finder _dialogField(int i) => find.descendant(
  of: find.byType(AlertDialog),
  matching: find.byType(TextField),
).at(i);

Future<_Fake> _pump(WidgetTester tester) async {
  final fake = _Fake();
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        initialTier: FloaterTier.collapsed,
        controller: fake.controller(),
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
  return fake;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  SharedPreferences.setMockInitialValues(<String, Object>{});

  testWidgets('🔴 桌面上有一格「创建小程序」：**空心加号** ＋ 那一行字', (tester) async {
    await _pump(tester);
    expect(find.text(createAppLabel), findsOneWidget, reason: '★ 那一格的字');
    // 空心加号（形状）—— 它与别的图标**同一种画法**，只是图形是那个加号
    expect(
      find.descendant(of: find.byType(AppDesktop), matching: find.byIcon(Icons.add)),
      findsWidgets,
      reason: '★ 那一格画的是加号',
    );
    // ⚠️ 它**没有菜单**（不改名/不复制/不删）：按住不该弹出那个面板
    final tile = find.ancestor(
      of: find.text(createAppLabel),
      matching: find.byType(InkWell),
    );
    expect(tile, findsWidgets, reason: '（这格本身是可点的）');
  });

  testWidgets('🔴 点它 ⇒ 出现那一层浮窗：名字（必填）＋ 描述（可以不写）＋ 两个按钮', (tester) async {
    await _pump(tester);
    await tester.tap(find.text(createAppLabel));
    await tester.pumpAndSettle();

    expect(find.text(createAppTitle), findsOneWidget);
    expect(find.text(createAppNameLabel), findsOneWidget, reason: '★ 名字那一栏');
    expect(find.text(createAppDescLabel), findsOneWidget, reason: '★ 描述那一栏**自己写着"可以不写"**');
    expect(find.text(createAppOk), findsOneWidget);
    expect(find.text(createAppNo), findsOneWidget);
  });

  testWidgets('🔴 没写名字就按【建好】⇒ **一个请求都不发**，并说一句"得先起个名字"', (tester) async {
    final fake = await _pump(tester);
    await tester.tap(find.text(createAppLabel));
    await tester.pumpAndSettle();
    await tester.tap(find.text(createAppOk));
    await tester.pumpAndSettle();

    expect(fake.creates, isEmpty, reason: '★ 名字是必填的 ⇒ 本地就拦住（不发一个注定被拒的请求）');
    expect(find.text(createAppNeedName), findsWidgets, reason: '★ 要跟他说一句');
  });

  testWidgets('🔴 点【算了】⇒ 什么都不做（一个请求都不发）', (tester) async {
    final fake = await _pump(tester);
    await tester.tap(find.text(createAppLabel));
    await tester.pumpAndSettle();
    await tester.tap(find.text(createAppNo));
    await tester.pumpAndSettle();
    expect(fake.creates, isEmpty);
    expect(find.text(createAppTitle), findsNothing, reason: '★ 那一层收回去了');
  });

  testWidgets('🔴 填了名字（描述留空）⇒ 真的建了：请求带上两样 ⇒ 桌上多出一格', (tester) async {
    final fake = await _pump(tester);
    await tester.tap(find.text(createAppLabel));
    await tester.pumpAndSettle();

    await tester.enterText(_dialogField(0), '买菜清单');
    await tester.tap(find.text(createAppOk));
    await tester.pumpAndSettle();

    expect(fake.creates.length, 1, reason: '★ 恰好发一条');
    expect(fake.creates.single['title'], '买菜清单');
    expect(fake.creates.single['description'], '', reason: '★ 描述**可以不写**（空串照发）');

    // 成了 ⇒ 重拉清单 ⇒ 新那一格自己长出来（客户端不拼）
    expect(find.text('买菜清单'), findsWidgets, reason: '★ 桌面上多了一格（点它就能进去）');
    expect(find.text(createAppDone), findsWidgets, reason: '★ 说一句"建好了"');
  });

  testWidgets('★ 描述也写了 ⇒ 两样一起送出去', (tester) async {
    final fake = await _pump(tester);
    await tester.tap(find.text(createAppLabel));
    await tester.pumpAndSettle();
    await tester.enterText(_dialogField(0), '买菜清单');
    await tester.enterText(_dialogField(1), '每天记一下要买的东西');
    await tester.tap(find.text(createAppOk));
    await tester.pumpAndSettle();

    expect(fake.creates.single['title'], '买菜清单');
    expect(fake.creates.single['description'], '每天记一下要买的东西');
  });

  testWidgets('🔴 服务端拒了 ⇒ **把服务端那句人话原样说出来**（不许自己编一句）', (tester) async {
    final fake = await _pump(tester);
    fake.refuseWords = '名字太长了（最多 40 个字）。';
    await tester.tap(find.text(createAppLabel));
    await tester.pumpAndSettle();
    await tester.enterText(_dialogField(0), '很长的名字');
    await tester.tap(find.text(createAppOk));
    await tester.pumpAndSettle();

    expect(find.text('名字太长了（最多 40 个字）。'), findsWidgets, reason: '★ 服务端那句话原样上屏');
    expect(find.text('很长的名字'), findsNothing, reason: '★ 被拒了 ⇒ 桌上不许长出一格');
  });
}
