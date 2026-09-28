// **设置里的「壁纸」那一项 ＋ 桌面真的换底**（契约 `docs/dev/131-WALLPAPER.md`）。
//
// 这一份钉五件：
//   ① 顶层那一列里**有「壁纸」**，小字说的是**现在用的是哪一张**（不是"点一下"那种空话）；
//   ② 点开 ⇒ 28 张 ＋ 一格"不设"；点了某一格 ⇒ **回调收到 id 并退回列表**；
//   ③ 选中的那一格**有个勾**（不许只靠颜色 —— D3 那一族）；
//   ④ 🔴 **桌面上真的铺了那一张**（"画到屏幕上"唯一自动化的证据：那一层 `Image` 在树上）；
//      不设 / 认不出来 ⇒ **没有那张图**（就是原来那张纸）；
//   ⑤ 🔴 **存得住、读得回**，坏值一律回到"不设"（偏好读坏了不许让桌面打不开）。
//
// ⚠️ 这是**提示档**（`AGENTS.md` §5.1）：硬闸是 `test/unit/wallpaper_test.dart` 与
//    `accessibility_test.dart` 里那两条（五档不溢出 ＋ 命中区 ≥44）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/wallpaper.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/services/wallpaper_store.dart';
import 'package:hupo_app/widgets/app_desktop.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/wallpaper_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 盘上那个 key（与 `WallpaperStore` 里那一个逐字相同）。
const String kKey = 'hupo_wallpaper';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

/// 桌面上那一层底图里，**真的画出来的**那张资源（不设 ⇒ 空的）。
List<String> _shownAssets(WidgetTester tester) => tester
    .widgetList<Image>(find.descendant(of: find.byType(AppDesktop), matching: find.byType(Image)))
    .map((i) => (i.image as AssetImage).assetName)
    .toList();

/// 一个只有 `SettingsScreen` 的小夹具（不接网络、不碰聊天那条流）。
Widget _settings({required String wallpaper, void Function(String)? onPick}) => SettingsScreen(
  hasKey: false,
  keyBad: false,
  onSubmit: (_) async => KeySend.ok,
  wallpaper: wallpaper,
  onWallpaperChanged: onPick,
);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('① 顶层那一列有「壁纸」，小字说的是**现在用的是哪一张**', (tester) async {
    // 🔴 负向对照：先钉"不设"那一档说的话 —— 不许出现"点一下试试"那种空话
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: _settings(wallpaper: wallpaperNone))));
    await tester.pumpAndSettle();
    expect(find.text(settingsRowWallpaper), findsOneWidget);
    expect(find.text(wallpaperLabel(wallpaperNone)), findsOneWidget);

    // 换一张 ⇒ 那行小字**跟着变**（不是写死的）
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: _settings(wallpaper: 'wp-07'))));
    await tester.pumpAndSettle();
    expect(find.text(wallpaperLabel('wp-07')), findsOneWidget);
    expect(find.text(wallpaperLabel(wallpaperNone)), findsNothing);
  });

  testWidgets('② 点开 ⇒ 28 张 ＋ 一格"不设"；点一格 ⇒ 回调收到 id 且退回列表', (tester) async {
    final picked = <String>[];
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: _settings(wallpaper: wallpaperNone, onPick: picked.add))),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text(settingsRowWallpaper));
    await tester.pumpAndSettle();

    // 负向对照：**真的进了那一页**
    expect(find.byType(WallpaperPicker), findsOneWidget, reason: '★ 没进壁纸那一页');
    expect(find.text(wallpaperHint), findsOneWidget, reason: '这一页要说清"第一格是原来那张纸"');
    // 那一页上的格子：**每一格都在**（"不设" ＋ 每一张）
    for (final id in wallpaperIds) {
      expect(find.byKey(wallpaperCellKey(id)), findsOneWidget, reason: '少了这一格：$id');
    }
    expect(wallpaperIds.length, wallpaperCount + 1);

    // 点第 3 张（`wp-03`）—— 像用户那样点那一格
    await tester.tap(find.byKey(wallpaperCellKey('wp-03')));
    await tester.pumpAndSettle();
    expect(picked, ['wp-03'], reason: '★ 点了那一格却没把 id 交给上层');
    // 选完**退回设置列表**（他刚做完一件事；留在这一页要多按一次）
    expect(find.byType(WallpaperPicker), findsNothing, reason: '★ 选完没退回去');
    expect(find.text(settingsRowWallpaper), findsOneWidget);
  });

  testWidgets('③ 选中的那一格**有个勾**（不许只靠颜色）', (tester) async {
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: _settings(wallpaper: 'wp-05', onPick: (_) {}))),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text(settingsRowWallpaper));
    await tester.pumpAndSettle();
    // 勾**只有一格**，而且它在被选中的那一格里面
    expect(find.byIcon(Icons.check_circle), findsOneWidget,
        reason: '★ 选中的那一格没有勾（只剩颜色一个通道）');
    expect(
      find.descendant(
        of: find.byKey(wallpaperCellKey('wp-05')),
        matching: find.byIcon(Icons.check_circle),
      ),
      findsOneWidget,
      reason: '★ 勾打在了别的格子上',
    );
    // 负向对照：**别的格子没有勾**（勾是跟着选中的那一格走的，不是每格都画）
    expect(
      find.descendant(
        of: find.byKey(wallpaperCellKey('wp-01')),
        matching: find.byIcon(Icons.check_circle),
      ),
      findsNothing,
      reason: '★ 没选中的格子也画了勾 ⇒ "选中的是哪一张"就读不出来了',
    );
    expect(
      find.descendant(
        of: find.byKey(wallpaperCellKey(wallpaperNone)),
        matching: find.byIcon(Icons.check_circle),
      ),
      findsNothing,
    );
  });

  testWidgets('④ 🔴 桌面上真的铺了那一张（不设 ⇒ 不铺，就是原来那张纸）', (tester) async {
    // 不设：底图那一层**没有** `Image`（画的是纸色）
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(controller: _controller(), onLoggedOut: () {})),
    );
    await tester.pumpAndSettle();
    expect(_shownAssets(tester), isEmpty, reason: '★ 不设壁纸时却铺了一张图');

    // ⚠️ **先把上一棵树拆掉**：`pumpWidget` 同类型的 widget 会**复用同一个 State**
    //    ⇒ `initState` 不再跑，新灌的那份盘根本没人读（实测栽过：桌上一直没图）。
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();

    // 灌盘 = 用户上次挑的就是 `wp-03` ⇒ 进来之后桌面铺的就是它
    SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'wp-03'});
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(controller: _controller(), onLoggedOut: () {})),
    );
    await tester.pumpAndSettle();
    expect(_shownAssets(tester), contains('assets/wallpapers/wp-03.jpg'),
        reason: '★ 盘上挑的是 wp-03，桌面上却没铺它（"画到屏幕上"没发生）');
    // 🔴 **聊天浮窗还是那张暖纸**：壁纸只换桌面那一层（纪律 ①）
    final floater = tester.widget<Material>(
      find.descendant(of: find.byType(ChatFloater), matching: find.byType(Material)).first,
    );
    expect(floater.color, isNotNull, reason: '★ 浮窗被壁纸顶掉了自己的底');
    // ⚠️ 底图上还罩着一层纸色（图标下面那行字要读得出来）
    expect(d.wallpaperScrim.a, greaterThan(0), reason: '★ 罩色没了 ⇒ 深色壁纸上图标名会读不出来');
  });

  testWidgets('④·补 盘上存着**认不出来**的值 ⇒ 桌面就是原来那张纸（不白屏、不报错）', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'wp-99-坏了'});
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(controller: _controller(), onLoggedOut: () {})),
    );
    await tester.pumpAndSettle();
    expect(_shownAssets(tester), isEmpty, reason: '★ 认不出来的 id 被当成了真壁纸');
    expect(tester.takeException(), isNull, reason: '★ 坏值把桌面弄崩了');
  });

  test('⑤ 🔴 存得住、读得回；坏值一律回到"不设"', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await WallpaperStore().write('wp-12');
    // ⚠️ 换一个实例读 —— 不然读到的只是**内存里那个缓存**（判据就成了空转）
    expect(await WallpaperStore().read(), 'wp-12');
    expect(await SharedPreferences.getInstance(), isNotNull);
    final p = await SharedPreferences.getInstance();
    expect(p.getString(kKey), 'wp-12', reason: '★ 没真的写进盘里');

    // 坏值（老版本写的 / 被人改坏的）⇒ 不设，而且**不抛**
    SharedPreferences.setMockInitialValues(<String, Object>{kKey: '不是壁纸'});
    expect(await WallpaperStore().read(), wallpaperNone);
    // 认不出来的值写进去也只会存成"不设"
    await WallpaperStore().write('wp-77');
    expect(await WallpaperStore().read(), wallpaperNone);
  });
}
