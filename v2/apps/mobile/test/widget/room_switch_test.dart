// **跟着图标走** —— 一个图标 = 一条对话（契约 `docs/dev/83-APP-WORKSPACE.md` §五·甲）。
//
// 主人 2026-09-25 亲口选的**甲**：
//     *"跟着图标走：打开某个小程序时，**下面那条聊天就是它的对话**
//       （在哪个房间说话，就是跟哪个房间聊）。"*
//
// ⚠️ `test/widget`（**提示档**）—— 它钉的是"这一刀到底有没有画到屏幕上"。
//    当闸的两条在别处：`test/unit/scope_test.dart`（房间怎么算 / 地址与 body 带对了没 /
//    切房间不丢主线）与 `test/widget/accessibility_test.dart`（五档不溢出 + 命中区 ≥44，
//    里面有一条**从真入口进空房间**的用例）。
//
// ⚠️ 不连真网：假 `/api/apps` + 假 `/api/say`（`MockClient`），
//    而且**不调 `start()`** ⇒ 一条 socket 都不会开。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hupo_app/models/math_words.dart';
import 'package:hupo_app/models/scope.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/math_quiz_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';

/// 那个"我的小程序"（服务端 `/api/apps` 会给的那一条）。
const diceId = 'dice';
const diceTitle = '掷骰子';

http.Response _json(String body, [int status = 200]) => http.Response(
  body,
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// 一份假服务端：只答 `/api/apps`（别的一律空对象）。
///
/// ⚠️ 它**故意**不答 `/api/timeline`（那一问在这条用例里不该发生）——
///    真发生了的话返回 `{}` ⇒ `older()` 解不出 `frames` ⇒ 空的一页，
///    不会把测试弄挂，但也测不出什么。
ChatController _controller() {
  final api = Api(
    client: MockClient((r) async {
      if (r.url.path == '/api/apps') {
        return _json(
          jsonEncode({
            'apps': [
              {
                'id': diceId,
                'title': diceTitle,
                'icon': 'casino',
                'version': 1,
                'entryUrl': 'https://apps.example/dice/index.html?sig=x',
                'expiresAt': 0,
              },
            ],
          }),
        );
      }
      return _json('{}');
    }),
  );
  // 🔴 令牌只用来让 `_loadMyApps()` 去问那一趟；**不调 `start()`** ⇒ 不开流。
  return ChatController(api: api, tokens: TokenStore(), token: 'tok');
}

Future<void> _pump(WidgetTester tester, ChatController c) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(controller: c, onLoggedOut: () {}),
    ),
  );
  // 让 `_loadMyApps()` 那一趟回来（桌面才长出那一个图标）
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('🔴 跟着图标走：进小程序的房间 ⇒ 聊天就是它的对话；退回桌面 ⇒ 主线还在', (tester) async {
    final c = _controller();
    // 主线先有一轮（**在挂屏之前**喂进去 = 冷启动那一屏就有的东西）
    c.ingest({'type': 'user/echo', 'seq': 1, 'messageId': 'u1', 'text': '主线那句话'});
    c.ingest({'type': 'message/start', 'seq': 2, 'messageId': 'm1'});
    c.ingest({
      'type': 'message/text',
      'seq': 3,
      'messageId': 'm1',
      'block': 'quick',
      'text': '主线那句回答',
    });
    await _pump(tester, c);

    // 还没开小程序 ⇒ 主线
    expect(c.scope, mainScope, reason: '桌面上 = 主线（契约：不带 scope = main）');
    expect(
      find.text(diceTitle),
      findsOneWidget,
      reason: '★ 我的小程序那个图标没长出来 ⇒ 这条用例扫错了',
    );

    // 点它（真实路径：桌面上的图标）
    await tester.tap(find.text(diceTitle));
    await tester.pumpAndSettle();
    expect(c.scope, diceId, reason: '★ 打开某个"我的小程序" ⇒ 房间就是**那个 app 的 id**');
    // 聊天条最前面那个图标/说明跟着走（"看得出来现在在哪个房间"）
    expect(
      find.byTooltip(chatScopeInApp(diceTitle)),
      findsOneWidget,
      reason: '★ 聊天条上要看得出来现在跟谁在说',
    );

    // 展开聊天 ⇒ 屏幕上是**它那一间**
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(
      find.text(roomEmptyTitle),
      findsOneWidget,
      reason: '★ 这一间还空着 ⇒ 一句普通话（不是白屏，也不是主线那句通用话）',
    );
    expect(find.text(roomEmptyLine(diceTitle)), findsOneWidget);
    expect(find.text('主线那句话'), findsNothing, reason: '★ 主线的话不许露到小程序这一间（判据 A3）');

    // 这一间里进来的话走**同一套渲染**（同一时间线、同一套气泡）
    c.ingest({'type': 'user/echo', 'seq': 9, 'messageId': 'u9', 'text': '骰子那一间那句话'});
    await tester.pump();
    expect(find.text('骰子那一间那句话'), findsOneWidget);
    expect(find.text('主线那句话'), findsNothing);

    // 收起聊天（把屏幕还给小程序），然后从容器顶上那个返回关掉它
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byType(MathQuizScreen), findsNothing, reason: '（负向对照：这一屏不是奥数题）');
    await tester.tap(find.byTooltip(miniAppBack));
    await tester.pumpAndSettle();
    expect(c.scope, mainScope, reason: '★ 关掉它 ⇒ 回到桌面那一间');

    // 展开聊天 ⇒ 主线那两句**一个字节都没丢**
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.text('主线那句话'), findsOneWidget, reason: '★ 回到桌面必须还看得见主线原来那句');
    expect(find.text('主线那句回答'), findsOneWidget);
    expect(find.text('骰子那一间那句话'), findsNothing, reason: '★ 小程序那一间的话不许露到主线');
  });

  testWidgets('★ 内置那几个（设置 / 奥数题 / …）**不是**房间：它们不在 `/api/apps` 里', (tester) async {
    // ⚠️ 这是一条**判断**，写在 `models/scope.dart` 顶上：
    //    契约把 scope 定成"`/api/apps` 里那个 id"，而内置那几个磁贴是壳自己写死的屏
    //    ⇒ 它们那期间房间**仍然是主线**（拿壳里的目录名去冒充一个服务端认识的 scope
    //      等于把话丢进一个不存在的房间）。
    final c = _controller();
    await _pump(tester, c);
    await tester.tap(find.text(mathAppLabel));
    await tester.pumpAndSettle();
    expect(find.byType(MathQuizScreen), findsOneWidget, reason: '★ 没进奥数题那一屏 ⇒ 判据扫错了屏幕');
    expect(c.scope, mainScope, reason: '★ 内置的图标没有自己的房间 ⇒ 仍是主线');
    // 而"看得出来现在在哪儿"照旧（那是上一批就有的指示，不是房间）
    expect(find.byTooltip(chatScopeInApp(mathTitle)), findsOneWidget);
  });
}
