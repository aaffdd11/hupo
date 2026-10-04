// **某一间正有活在做：桌面上那一格右下角转着一个小圈**（主人 2026-10-04：
//   *"如果某个小程序的聊天还在运行，我们应该给这个小程序有一个状态。
//     就是某项工作还在工作中。"*）· 契约 `docs/dev/178-APP-WORKING.md`。
//
// ── 这一份钉四件 ──────────────────────────────────────────
//   ① 服务端说 `working: true` ⇒ 那一格多出一个**转着的圈**（右下角）
//   ② 🔴 它**不是**"在建"那个圈：颜色不一样（`amber` vs `ink`），而且
//      **两样可以同时发生**（圈有两个）—— 这两件事不许被画成同一件
//   ③ 🔴 点它**照样打开**（"在做"≠"还不能用"：主人要的是个状态，不是一道门）
//   ④ 底色照旧是它自己的身份色（**不因为"在做"变成灰的**）
//
// ⚠️ 负向对照：同一个 id、同一个名字，只把 `working` 翻过来 —— 圈必须跟着有/没有。
// ⚠️ 形状照 `test/widget/app_building_test.dart`（同一族判据，同一套泵法）。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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

const String _title = '在忙那个';

Api _apiWith(List<Object?> apps) => Api(
  base: '',
  client: MockClient((req) async {
    if (req.url.path == '/api/apps') {
      return http.Response(jsonEncode({'apps': apps}), 200,
          headers: {'content-type': 'application/json'});
    }
    return http.Response('', 404);
  }),
);

Map<String, Object?> _entry({required bool working, bool building = false}) => {
  'id': 'mangzhe',
  'title': _title,
  'icon': 'list',
  'version': 1,
  'entry': 'index.html',
  'entryUrl': 'http://127.0.0.1:8021/w/mangzhe/index.html?e=99999999999999&s=ab',
  'expiresAt': 99999999999999,
  'permissions': <String>[],
  'granted': <String>[],
  'unanswered': <String>[],
  'building': building,
  'working': working,
};

Future<void> _pump(WidgetTester tester, {required bool working, bool building = false}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        controller: ChatController(
            api: _apiWith([_entry(working: working, building: building)]),
            tokens: TokenStore(),
            token: '测试令牌'),
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 50));
  // ⚠️ 只要屏幕上有"转着的圈"，`pumpAndSettle` 就永远等不到头
  //    （它等的是"没有动画了"）⇒ 泵固定几帧，别 settle。
}

/// 那一格的底色（`Container` 上那一层 `BoxDecoration`）。
Color? _tileColor(WidgetTester tester, String label) {
  final c = tester.widget<Container>(find.byKey(desktopIconBoxKey(label)));
  return (c.decoration as BoxDecoration?)?.color;
}

/// 屏幕上那几个转着的圈，各自什么颜色。
List<Color?> _spinnerColors(WidgetTester tester) => tester
    .widgetList<CircularProgressIndicator>(find.byType(CircularProgressIndicator))
    .map((w) => w.color)
    .toList();

void main() {
  testWidgets('🔴 在做的那一格：多出一个**转着的圈**（右下角那个）', (tester) async {
    await _pump(tester, working: true);
    expect(find.text(_title), findsWidgets, reason: '前提：这一格得先在桌面上');
    // ⚠️ 用 `RegExp`：读屏读到的是**整格**那句话（"这个小程序正在做一件事 ＋ 名字"），
    //    不是逐字等于这一句 —— 判据要量**它读得到读不到**，不是量拼串的格式。
    expect(find.bySemanticsLabel(RegExp(appWorkingLine)), findsOneWidget,
        reason: '★ "在做"那一下必须有一个说得出口的状态（无障碍也读得到）');
    expect(_spinnerColors(tester), [d.amber],
        reason: '★ 在做那个圈是 amber（不只是"有个圈"—— 还得是**这一个**）');
  });

  testWidgets('🔴 没在做的同一格：那个圈**不在**（负向对照）', (tester) async {
    await _pump(tester, working: false);
    expect(find.text(_title), findsWidgets, reason: '前提：这一格得在桌面上');
    expect(find.bySemanticsLabel(RegExp(appWorkingLine)), findsNothing,
        reason: '★ 没活还亮着"在做" = 屏幕在说假话');
    expect(_spinnerColors(tester), isEmpty,
        reason: '★ 一个圈都不该有（两样都不是）');
  });

  testWidgets('🔴 "在做"与"在建"不是同一个圈：颜色不同，而且**可以同时有**', (tester) async {
    // 在建（灰的、入口还是占位页）**同时**有活在跑：两个圈，颜色分得开
    await _pump(tester, working: true, building: true);
    final colors = _spinnerColors(tester);
    expect(colors.length, 2, reason: '★ 两件事同时发生 ⇒ 两个圈都在（不许互相顶掉）');
    expect(colors.contains(d.amber), isTrue, reason: '★ 在做那个圈（amber）没了');
    expect(colors.contains(d.ink), isTrue, reason: '★ 在建那个圈（ink）没了');
    expect(_tileColor(tester, _title), d.line, reason: '前提：在建 ⇒ 底色是灰的');
  });

  testWidgets('🔴 "在做"不许把那一格变成灰的（底色还是它自己的）', (tester) async {
    await _pump(tester, working: true);
    final c = _tileColor(tester, _title);
    expect(c, isNotNull, reason: '★ 那一格没量到底色 ⇒ 这条闸扫错了地方');
    expect(c == d.line, isFalse,
        reason: '★ "在做"不是"还没好"：底色不许变灰（那是"在建"的样子）');
  });

  testWidgets('🔴 点在做的那一格 ⇒ **照样打开**（"在做"是个状态，不是一道门）', (tester) async {
    await _pump(tester, working: true);
    await tester.tap(find.text(_title).first);
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 120));
    }
    expect(find.text(appRuntimeNotHere), findsOneWidget,
        reason: '★ 它该被打开（VM 上就落到那句实话），而不是"点了没反应"');
  });
}
