// **我的小程序摆在桌面上**（乙-1 · 契约 `docs/dev/59-USER-APPS.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 清单里多一条 ⇒ 桌面上多一个**带字**的图标（D3.8）
//   ② 🔴 点开 ⇒ 容器顶上写它的名字，里面是**沙箱运行时**（VM 上是那句实话，不许白屏）
//   ③ 🔴 **过期的 / 没签名的** 一条都不许摆（摆了就是"点了没反应"）
//   ④ 清单拉不到 ⇒ **只是没有那些图标**，内置那两个和聊天照常在
//
// ⚠️ 屏幕上的字在 `flutter test` 里查得到（VM 上没有 canvas），这是这条的唯一自动化证据；
//    真浏览器里长什么样，还得靠 `scripts/check-web-browser.mjs --shot` 看一眼（V13）。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/widgets/mini_app_icons.dart';
import 'package:hupo_app/models/app_words.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 一个假的接口：只答 `/api/apps`，别的一律 404（**不碰真网**）。
Api _apiWith(List<Object?> apps, {int status = 200}) {
  return Api(
    base: '',
    client: MockClient((req) async {
      if (req.url.path == '/api/apps') {
        return http.Response(jsonEncode({'apps': apps}), status,
            headers: {'content-type': 'application/json'});
      }
      return http.Response('', 404);
    }),
  );
}

Map<String, Object?> _entry({
  String id = 'dice',
  String title = '掷骰子',
  String icon = 'dice',
  int version = 1,
  int? expiresAt,
  String? entryUrl,
}) =>
    {
      'id': id,
      'title': title,
      'icon': icon,
      'version': version,
      'entry': 'index.html',
      'entryUrl': entryUrl ??
          'http://127.0.0.1:8021/a/$id/$version/index.html?u=u1&e=99999999999999&s=ab',
      'expiresAt': expiresAt ?? 99999999999999,
      'permissions': <String>[],
    };

Future<void> _pump(WidgetTester tester, Api api) async {
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
  await tester.pump();          // 起一帧
  await tester.pump(const Duration(milliseconds: 50)); // 让那次拉的 Future 落地
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('★ 清单里多一条 ⇒ 桌面上多一个带字的图标', (tester) async {
    await _pump(tester, _apiWith([_entry()]));
    expect(find.text('掷骰子'), findsOneWidget, reason: '★ 我的小程序该在桌面上');
    expect(find.byIcon(miniAppIconFor('dice')), findsOneWidget, reason: '图标也要在（D3.8：字 + 图形）');
    // 内置那两个照旧
    expect(find.text(settingsAppLabel), findsOneWidget);
  });

  testWidgets('🔴 点开 ⇒ 容器写它的名字，里面是沙箱运行时（VM 上是那句实话，不是白屏）', (tester) async {
    await _pump(tester, _apiWith([_entry()]));
    await tester.tap(find.text('掷骰子'));
    await tester.pumpAndSettle();

    expect(find.text('掷骰子'), findsWidgets, reason: '容器顶上该写它的名字');
    expect(find.text(appRuntimeNotHere), findsOneWidget,
        reason: '★ 跑不起来就说一句人话（"点了没反应"是这个项目最忌的形状）');
    expect(find.byType(SettingsScreen), findsNothing, reason: '开的不该是设置');
  });

  testWidgets('🔴 过期的 / 没入口 URL 的，一条都不许摆（负向对照）', (tester) async {
    await _pump(tester, _apiWith([
      _entry(id: 'old', title: '过期那个', expiresAt: 1),
      _entry(id: 'nourl', title: '没有入口那个', entryUrl: 'ftp://x'),
      _entry(id: 'good', title: '好的那个'),
    ]));
    expect(find.text('好的那个'), findsOneWidget);
    expect(find.text('过期那个'), findsNothing, reason: '★ 摆了就是"点了没反应"');
    expect(find.text('没有入口那个'), findsNothing);
  });

  testWidgets('清单拉不到（500 / 空）⇒ 只剩内置那几个，聊天照常', (tester) async {
    await _pump(tester, _apiWith(const [], status: 500));
    expect(find.text(settingsAppLabel), findsOneWidget);
    expect(find.text('说点什么'), findsOneWidget, reason: '聊天不许因为清单拉不到就坏掉');
  });

  _discoverTests();
  _expiryTests();
}

// ── 乙-3：「发现」那一屏 + 桌面自己长出来 ─────────────────────

void _discoverTests() {
  testWidgets('🔴 「发现」是**只读**的：列出别人的小程序，而且**明说装的动作在对话里**', (tester) async {
    final api = Api(
      base: '',
      client: MockClient((req) async {
        if (req.url.path == '/api/discover') {
          return http.Response(
            jsonEncode({
              'apps': [
                {'id': 'dice', 'title': '掷骰子', 'icon': 'dice', 'version': 2, 'author': '用户 3f2a', 'permissions': <String>[]},
                {'id': 'wenda', 'title': '问答小抄', 'icon': 'book', 'version': 1, 'author': '用户 9b1c', 'permissions': ['ask']},
              ],
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        if (req.url.path == '/api/apps') {
          return http.Response(jsonEncode({'apps': <Object>[]}), 200, headers: {'content-type': 'application/json'});
        }
        return http.Response('', 404);
      }),
    );
    await _pump(tester, api);
    await tester.tap(find.text(discoverAppLabel));
    await tester.pumpAndSettle();

    expect(find.text('掷骰子'), findsOneWidget, reason: '别人的小程序该列出来');
    expect(find.textContaining('用户 3f2a'), findsOneWidget, reason: '谁发的要看得见');
    expect(find.text(discoverHowTo), findsOneWidget, reason: '★ 必须明说"装的动作在对话里"（不然他会在这儿找按钮）');
    // 🔴 **如实告知**：要"用你的钥匙"的那一条，装上之前就看得见
    expect(find.text(discoverNeedsAsk), findsOneWidget, reason: '★ "它会用你自己的钥匙问话"必须写在这儿');
    expect(find.text('问答小抄'), findsOneWidget, reason: '要权限的那条也要列出来');
  });

  testWidgets('空「发现」⇒ 如实说"现在还没有"（不是白屏）', (tester) async {
    await _pump(tester, _apiWith(const []));
    await tester.tap(find.text(discoverAppLabel));
    await tester.pumpAndSettle();
    expect(find.text(discoverEmpty), findsOneWidget);
  });

  testWidgets('★ 服务端说"装上了一个" ⇒ 桌面**自己长出来**（不用刷新页面）', (tester) async {
    var served = 0;
    final api = Api(
      base: '',
      client: MockClient((req) async {
        if (req.url.path == '/api/apps') {
          served += 1;
          // 第一次空、第二次有 —— 模拟"装上之后重拉"
          final apps = served == 1 ? <Object>[] : [_entry(id: 'fromfriend', title: '别人做的')];
          return http.Response(jsonEncode({'apps': apps}), 200, headers: {'content-type': 'application/json'});
        }
        return http.Response('', 404);
      }),
    );
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
    expect(find.text('别人做的'), findsNothing, reason: '一开始他桌上没有');

    // 服务端推一条 app/installed ⇒ 界面该去重拉
    c.ingest({'type': 'app/installed', 'appId': 'fromfriend', 'title': '别人做的'});
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();
    expect(find.text('别人做的'), findsOneWidget, reason: '★ 桌面该自己长出来');
  });
}

// ── 入口 URL 十分钟就过期 ⇒ 快过期时先重拉再开 ────────────────

void _expiryTests() {
  testWidgets('🔴 入口 URL 快过期 ⇒ 打开之前先重拉一次（不然点开是空的）', (tester) async {
    var served = 0;
    final api = Api(
      base: '',
      client: MockClient((req) async {
        if (req.url.path == '/api/apps') {
          served += 1;
          final soon = DateTime.now().millisecondsSinceEpoch + 5 * 1000; // 5 秒后过期
          return http.Response(
            jsonEncode({
              'apps': [
                _entry(id: 'dice', title: '掷骰子')
                  ..['entryUrl'] = 'http://127.0.0.1:8021/a/dice/1/index.html?u=u1&e=1&s=第$served次'
                  ..['expiresAt'] = soon,
              ],
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response('', 404);
      }),
    );
    await _pump(tester, api);
    expect(served, 1, reason: '开机拉过一次');

    await tester.tap(find.text('掷骰子'));
    await tester.pumpAndSettle();
    expect(served, 2, reason: '★ 快过期 ⇒ 打开之前该再拉一次（拿新的签名 URL）');
    expect(find.text('掷骰子'), findsWidgets, reason: '而且照样要打开');
  });

  testWidgets('对照：URL 还早得很 ⇒ **不**多拉一次（别每次点都打接口）', (tester) async {
    var served = 0;
    final api = Api(
      base: '',
      client: MockClient((req) async {
        if (req.url.path == '/api/apps') {
          served += 1;
          return http.Response(jsonEncode({'apps': [_entry()]}), 200,
              headers: {'content-type': 'application/json'});
        }
        return http.Response('', 404);
      }),
    );
    await _pump(tester, api);
    await tester.tap(find.text('掷骰子'));
    await tester.pumpAndSettle();
    expect(served, 1, reason: '还早着呢，不该多打一次接口');
  });
}
