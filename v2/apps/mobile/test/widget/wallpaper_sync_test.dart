// **壁纸跟着账号走**（主人 2026-10-04 定：*"壁纸不要按设备存"* ・ 契约 `docs/dev/183`）。
//
// ── 这一份钉什么（一句话）──────────────────────────────────
//   ① 🔴 **换一台设备登录也看得见**（账号里那张 ⇒ 这台新设备铺的就是它）；
//   ② 🔴 **老用户升级上来的第一下**：本机挑过、账号里没记录 ⇒ **把本机那份顶上去**；
//   ③ 🔴 **问不上（网不通）⇒ 什么都不动**（本机那份照旧，一个字节都不写账号）；
//   ④ 🔴 **账号里"明确不设"（`''`）压过本机那张**（他选了不设就是不要）；
//   ⑤ 他在这台设备上挑了一张 ⇒ 本机当场换 ＋ **写进账号**（别的设备下次就看得见）。
//
// ⚠️ 负向对照都在里面：每一档都同时看**屏幕上铺的图**与**有没有写账号**，
//    只对一半不算过。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/app_desktop.dart';
import 'package:hupo_app/widgets/wallpaper_picker.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const String kKey = 'hupo_wallpaper';
const String kPending = 'hupo_wallpaper_pending';

/// 一台"会记账"的假服务端：`/api/prefs` 的读回什么、写了什么，判据全看得见。
class _Server {
  _Server({this.remote, this.readFails = false});

  /// `GET /api/prefs` 回的 `wallpaper`（**`null` = 账号里没记录**）。
  String? remote;

  /// `true` ⇒ 读那一条模拟"没问上"（500）。
  bool readFails;

  /// `true` ⇒ 写那一条模拟"没存上"（500）。
  bool writeFails = false;

  /// 写过来过什么（顺序）。
  final List<String> posted = <String>[];

  late final Api api = Api(
    base: '',
    client: MockClient((req) async {
      final json = {'content-type': 'application/json'};
      if (req.url.path == '/api/prefs') {
        if (req.method == 'GET') {
          if (readFails) return http.Response('boom', 500);
          return http.Response(jsonEncode({'wallpaper': remote}), 200, headers: json);
        }
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        posted.add(body['wallpaper'] as String);
        if (writeFails) return http.Response('boom', 500);
        return http.Response(jsonEncode({'ok': true, 'wallpaper': body['wallpaper']}), 200, headers: json);
      }
      if (req.url.path == '/api/apps') {
        return http.Response(jsonEncode({'apps': <Object>[]}), 200, headers: json);
      }
      return http.Response('', 404);
    }),
  );
}

/// 桌面上那一层底图里**真的画出来的**那张资源（不设 ⇒ 空的）。
List<String> _shownAssets(WidgetTester tester) => tester
    .widgetList<Image>(find.descendant(of: find.byType(AppDesktop), matching: find.byType(Image)))
    .map((i) => (i.image as AssetImage).assetName)
    .toList();

Future<void> _pump(WidgetTester tester, _Server server) async {
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
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('🔴 换一台设备（本机没挑过）登录 ⇒ 铺的是**账号里那一张**', (tester) async {
    final server = _Server(remote: 'wp-01');
    await _pump(tester, server);
    expect(_shownAssets(tester), contains('assets/wallpapers/wp-01.jpg'),
        reason: '★ 账号里有记录 ⇒ 这台新设备要铺它（这就是"跟着账号走"）');
    expect(server.posted, isEmpty, reason: '★ 只是读回来，不该往账号里写');
  });

  testWidgets('🔴 老用户升级上来：本机挑过、账号里没记录 ⇒ **把本机那份顶上去**', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'wp-03'});
    final server = _Server(remote: null);
    await _pump(tester, server);
    expect(_shownAssets(tester), contains('assets/wallpapers/wp-03.jpg'),
        reason: '★ 本机那张不许被"账号里没记录"抹成默认');
    expect(server.posted, ['wp-03'], reason: '★ 而且要把本机这份写进账号（别的设备才跟得上）');
    expect((await SharedPreferences.getInstance()).getString(kPending), '0',
        reason: '★ 写成了 ⇒ pending 要清掉（下次开机不许再白写一遍）');
  });

  testWidgets('🔴 问不上（网不通）⇒ 本机那份照旧，**一个字节都不许写账号**', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'wp-05'});
    final server = _Server(remote: 'wp-09', readFails: true);
    await _pump(tester, server);
    expect(_shownAssets(tester), contains('assets/wallpapers/wp-05.jpg'),
        reason: '★ 问不上就看本机那份（不许闪回默认）');
    expect(server.posted, isEmpty, reason: '🔴 网不通 ≠ 他改了 —— 不许拿本机那份去盖账号');
  });

  testWidgets('🔴 账号里"明确不设" ⇒ 压过本机那张（他选了不要就是不要）', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'wp-03'});
    final server = _Server(remote: '');
    await _pump(tester, server);
    expect(_shownAssets(tester), isEmpty, reason: '★ 账号说不设 ⇒ 回到那张暖纸');
    expect(server.posted, isEmpty, reason: '★ "不设"是他账号里的选择，不许被本机那张顶回去');
  });

  testWidgets('🔴 他在这台设备上挑了一张 ⇒ 当场换 ＋ **写进账号**（走真入口，不塞私货）', (tester) async {
    final server = _Server(remote: null);
    await _pump(tester, server);
    expect(_shownAssets(tester), isEmpty, reason: '前提：一开始没有壁纸');

    // 真入口：桌面 →「设置」→（滚到）「壁纸」→ 点第 11 张
    await tester.tap(find.text(settingsAppLabel));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget, reason: '★ 没进设置那一屏 ⇒ 下面点的是别的东西');
    await tester.scrollUntilVisible(
      find.text(settingsRowWallpaper),
      240,
      scrollable: find
          .descendant(of: find.byKey(settingsListKey), matching: find.byType(Scrollable))
          .first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text(settingsRowWallpaper));
    await tester.pumpAndSettle();
    expect(find.byType(WallpaperPicker), findsOneWidget, reason: '★ 没进壁纸那一页');
    await tester.tap(find.byKey(wallpaperCellKey('wp-11')));
    await tester.pumpAndSettle();

    expect(server.posted, ['wp-11'], reason: '★ 挑了就要写进账号（别的设备下次登录就是这一张）');
    expect((await SharedPreferences.getInstance()).getString(kKey), 'wp-11',
        reason: '★ 本机缓存也要跟上（离线时靠它先画）');
    expect((await SharedPreferences.getInstance()).getString(kPending), '0', reason: '★ 存上了 ⇒ 不留 pending');

    // ⚠️ "屏幕上真的换了那一张"由 `wallpaper_test.dart` ④ 钉着（它量的是桌面那一层 `Image`）；
    //    这一条量的是**那一半没人量过的**：他挑的那张有没有写进账号、本机缓存跟没跟上。
  });

  testWidgets('🔴 写账号没成功 ⇒ 留 pending（**不许假装同步上了**），下次开机补一次', (tester) async {
    final server = _Server(remote: null);
    server.writeFails = true;
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await _pump(tester, server);
    await tester.tap(find.text(settingsAppLabel));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text(settingsRowWallpaper),
      240,
      scrollable: find
          .descendant(of: find.byKey(settingsListKey), matching: find.byType(Scrollable))
          .first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text(settingsRowWallpaper));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(wallpaperCellKey('wp-13')));
    await tester.pumpAndSettle();

    expect(server.posted, ['wp-13'], reason: '前提：真的试着写了一次');
    expect((await SharedPreferences.getInstance()).getString(kPending), '1',
        reason: '🔴 没写成就得留着 —— 下次开机补一次（不然"这台换了、别的设备看不见"会静悄悄发生）');
    expect((await SharedPreferences.getInstance()).getString(kKey), 'wp-13',
        reason: '★ 本机这份照旧生效（他按了就该看见）');
  });
}
