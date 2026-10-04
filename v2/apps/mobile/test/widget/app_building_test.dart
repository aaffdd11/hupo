// **还在做的小程序：桌面上那一格是"灰的在建图标"**（主人 2026-10-04：
//   *"icon 是一个灰色的在建图标。就像 ios 那个开发中的那个。"*）。
//
// ── 这一份钉三件 ──────────────────────────────────────────
//   ① 服务端说 `building: true` ⇒ 那一格画**转着的圈**（＝看得出来"它在动、还没好"）
//   ② 那一格的底色**不是**它那个身份色（是灰的）—— 与"做好了"的那一格比一比
//   ③ 🔴 点它**不打开**（那一间里只有一页"这里还空着"），而是**说一句实话**
//      （点了没反应 = 屏幕上说假话）
//
// ⚠️ 负向对照就在 ②/③ 里：同一个 id、同一个名字，只把 `building` 翻过来，
//    行为必须跟着翻 —— 不然"闸"量的是别的东西。

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

const String _title = '在建那个';

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

Map<String, Object?> _entry({required bool building}) => {
  'id': 'zaijian',
  'title': _title,
  'icon': 'list',
  'version': 1,
  'entry': 'index.html',
  'entryUrl': 'http://127.0.0.1:8021/w/zaijian/index.html?e=99999999999999&s=ab',
  'expiresAt': 99999999999999,
  'permissions': <String>[],
  'granted': <String>[],
  'unanswered': <String>[],
  'building': building,
};

Future<void> _pump(WidgetTester tester, {required bool building}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        controller: ChatController(api: _apiWith([_entry(building: building)]), tokens: TokenStore(), token: '测试令牌'),
        onLoggedOut: () {},
        space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
        onSendKey: (_) async => KeySend.ok,
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 50));
  // ⚠️ **在建那一格有个"转着的圈"**（`CircularProgressIndicator` 是**永远动**的）
  //    ⇒ `pumpAndSettle` 会一直等下去（它等的是"没有动画了"）。
  //    这正是"它在动"的代价，测试里改成泵几帧就够。
  if (!building) await tester.pumpAndSettle();
}

/// 那一格的底色（`Container` 上那一层 `BoxDecoration`）。
/// ⚠️ 从"名字那行字"往上找那一格方块：`_DesktopIcon` 里只有那一个 64×64 的方块。
Color? _tileColor(WidgetTester tester, String label) {
  final c = tester.widget<Container>(find.byKey(desktopIconBoxKey(label)));
  return (c.decoration as BoxDecoration?)?.color;
}

void main() {
  testWidgets('🔴 在做的那一格：**转着圈**（一眼看出还没好）', (tester) async {
    await _pump(tester, building: true);
    expect(find.text(_title), findsWidgets, reason: '前提：这一格得先在桌面上');
    expect(find.byType(CircularProgressIndicator), findsWidgets,
        reason: '★ 在建的那一格必须有一个转着的圈（主人要的"开发中"那个样子）');
  });

  testWidgets('🔴 做好了的那一格：**没有**那个圈（负向对照）', (tester) async {
    await _pump(tester, building: false);
    expect(find.text(_title), findsWidgets, reason: '前提：这一格得在桌面上');
    expect(find.byType(CircularProgressIndicator), findsNothing,
        reason: '★ 做好了还转着圈 = 屏幕在说假话');
  });

  testWidgets('🔴 在建 ⇒ 底色是**灰的**（不是它那个身份色）', (tester) async {
    await _pump(tester, building: true);
    final c = _tileColor(tester, _title);
    expect(c, isNotNull, reason: '★ 那一格没量到底色 ⇒ 这条闸扫错了地方');
    expect(c, d.line, reason: '★ 在建那一格该是灰底（主人要的"灰色的在建图标"）');
  });

  testWidgets('🔴 做好了 ⇒ 底色**不是**那个灰（负向对照）', (tester) async {
    await _pump(tester, building: false);
    final c = _tileColor(tester, _title);
    expect(c, isNotNull);
    expect(c == d.line, isFalse,
        reason: '★ 做好了还画成灰的 = 屏幕在说假话（它该用自己那个身份色）');
  });

  testWidgets('🔴 点在建那一格 ⇒ **不打开**，而是说一句实话', (tester) async {
    await _pump(tester, building: true);
    await tester.tap(find.text(_title).first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text(appBuildingLine), findsOneWidget,
        reason: '★ 点了没反应 = 屏幕上说假话');
    // 🔴 **那一间不许开起来**：开起来的样子是"容器顶上写它的名字 ＋ 里面是运行时"
    //    （`remote_app_test` 里"点开"那一条量的就是这两样）⇒ 这里两样都不许出现。
    expect(find.text(appRuntimeNotHere), findsNothing,
        reason: '★ 在建的那一格被点开了（点进去只有一页"这里还空着"）');
  });
}
