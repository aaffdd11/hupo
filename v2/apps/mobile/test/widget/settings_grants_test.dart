// **设置页那张「注册制」卡**（契约 `docs/dev/147-APP-SQLITE.md` §二「册子」）。
//
// 主人原话：*「注册制，在设置里可以看到也可以关闭」*。
//
// ── 这一份要像用户那样按下去 ────────────────────────────────
//   ① 只列**声明了东西**的；一个都没有 ⇒ **这张卡一个像素都不画**；
//   ② 开关开不开 ＝ `granted` 里有没有那一项（声明 ≠ 允许）；
//   ③ 🔴 **点一下**：真的去说了（`/api/app-grant`）＋ **成了屏幕才变**；
//      **没成 ⇒ 开关一动不动 ＋ 如实说一句**（服务端那句人话优先）；
//   ④ 老服务端不回 `granted` ⇒ **不给开关**（不给假状态）；
//   ⑤ 关闭**只是"现在不给"** —— 界面上没有"删掉"那种东西；
//   ⑥ ★ **"清空它存下来的东西"**（2026-10-01 · `POST /api/app-db-clear`）：
//      只在声明了存东西的 app 上有那颗按钮 · 点一下**先弹二次确认** ·
//      **点"取消"不许发请求** · 点"清掉"才真发（正文 `{id}`）＋ 屏幕跟着变 ·
//      服务端回错时**照它说**、**不许**显示成清掉了 · 等回执时按钮按不动 ·
//      **跟开关无关**（关掉存储也能清）。
//
// ⚠️ 判据不写"控件存在就算完"：每一条都走真入口 / 真手势，并带**负向对照**
//    （改回旧行为它得当场红）。

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/app_spec.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/app_grants_card.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 一次"他点了开关"的记录。
typedef GrantCall = ({String id, String permission, bool allow});

/// 一次"他确认清空了"的记录（就是那个 appId）。
typedef ClearCall = String;

MiniApp _app({
  String id = 'notes',
  String title = '随手记',
  List<String> permissions = const ['db'],
  List<String>? granted = const [],
}) => MiniApp(
  id: id,
  title: title,
  icon: 'book',
  version: 1,
  entryUrl: 'https://apps.example/$id/index.html?sig=x',
  permissions: permissions,
  granted: granted,
);

/// 泵出**设置页那一列**（注册制那张卡就在里头）。
Future<void> pumpSettings(
  WidgetTester tester, {
  List<MiniApp> apps = const [],
  Future<GrantOutcome> Function(String, String, bool)? onGrant,
  Future<ClearOutcome> Function(String)? onClear,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SettingsScreen(
          hasKey: false,
          keyBad: false,
          onSubmit: (k) async => KeySend.ok,
          onLogout: () {},
          apps: apps,
          onGrant: onGrant,
          onClear: onClear,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// **像用户那样滚到那张卡**（它在那一列的下面 —— `ListView` 不会把屏幕外的孩子建出来）。
Future<void> scrollToCard(WidgetTester tester) async {
  await tester.scrollUntilVisible(
    find.byKey(appGrantsCardKey),
    240,
    scrollable: find
        .descendant(of: find.byKey(settingsListKey), matching: find.byType(Scrollable))
        .first,
  );
  await tester.pumpAndSettle();
}

/// **像用户那样点那颗「清空它存下来的东西」**（先滚到它、再点）。
Future<void> tapClear(WidgetTester tester, {String id = 'notes'}) async {
  final f = find.byKey(appDbClearKey(id));
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
}

/// 那一列现在能滚多长（用来量"没有声明的东西时这张卡是不是真占零个像素"）。
double listExtent(WidgetTester tester) {
  final s = tester.state<ScrollableState>(
    find
        .descendant(of: find.byKey(settingsListKey), matching: find.byType(Scrollable))
        .first,
  );
  return s.position.maxScrollExtent;
}

Switch switchOf(WidgetTester tester, {String id = 'notes', String permission = 'db'}) =>
    tester.widget<Switch>(find.byKey(grantSwitchKey(id, permission)));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('① 只列**声明了东西**的；一个都没有 ⇒ 这张卡一个像素都不画', (tester) async {
    // ① 一条都没有
    await pumpSettings(tester);
    expect(find.byKey(appGrantsCardKey), findsNothing, reason: '★ 没有小程序 ⇒ 不许画卡');
    expect(find.text(settingsGrantsTitle), findsNothing);
    final bare = listExtent(tester);

    // ② 有小程序，但**一个都没声明** ⇒ 照样一个像素都不画
    await pumpSettings(tester, apps: [_app(permissions: const [], granted: const [])]);
    expect(find.byKey(appGrantsCardKey), findsNothing,
        reason: '★ 它什么都没要 ⇒ 不许画卡');
    expect(find.text(settingsGrantsTitle), findsNothing);
    expect(find.text('随手记'), findsNothing, reason: '★ 没声明的 app 一个字都不许出现');
    // ⚠️ "一个像素"不是修辞：这一列**一点都不许多出来**
    expect(listExtent(tester), bare, reason: '★ 没声明东西时那张卡占了位置 ⇒ 不是"一个像素都不画"');

    // 负向对照：**声明了** ⇒ 它必须在（不然上面那两条是空转的）
    await pumpSettings(tester, apps: [_app()]);
    await scrollToCard(tester);
    expect(find.byKey(appGrantsCardKey), findsOneWidget, reason: '★ 声明了东西却不画卡');
    expect(find.text('随手记'), findsOneWidget);
    expect(find.text(grantWantWords('db')), findsOneWidget, reason: '★ 它想要什么要看得到');
  });

  testWidgets('② 开关开不开 ＝ `granted` 里有没有那一项（声明 ≠ 允许）', (tester) async {
    // ⚠️ 这一组要量**开关** ⇒ 必须把那条路接上（没接线时**不给开关**，见 ⑦·补）
    Future<GrantOutcome> grant(String id, String p, bool allow) async =>
        const GrantOk(<String>[]);
    await pumpSettings(tester, apps: [_app(granted: const [])], onGrant: grant);
    await scrollToCard(tester);
    expect(switchOf(tester).value, false, reason: '声明了、但还没给 ⇒ 关着');

    await pumpSettings(tester, apps: [_app(granted: const ['db'])], onGrant: grant);
    await scrollToCard(tester);
    expect(switchOf(tester).value, true, reason: '★ 允许了 ⇒ 开着');

    // 负向对照：**声明**里没有、`granted` 里却有 ⇒ 界面上**不给开关**
    //（`grantSwitchOn` 判的是"它声明了这一样没有"）
    await pumpSettings(
      tester,
      apps: [_app(permissions: const ['ask'], granted: const ['db'])],
      onGrant: grant,
    );
    await scrollToCard(tester);
    expect(find.byKey(grantSwitchKey('notes', 'db')), findsNothing,
        reason: '它没声明 db ⇒ 不许摆一个 db 的开关');
  });

  testWidgets('③ 🔴 像用户那样点一下：**成了屏幕才变**（先等回执，不许先拨过去）', (tester) async {
    final calls = <GrantCall>[];
    final gate = Completer<GrantOutcome>();
    await pumpSettings(
      tester,
      apps: [_app(granted: const [])],
      onGrant: (id, p, allow) {
        calls.add((id: id, permission: p, allow: allow));
        return gate.future;
      },
    );
    await scrollToCard(tester);
    expect(switchOf(tester).value, false);

    await tester.tap(find.byKey(grantSwitchKey('notes', 'db')));
    await tester.pump();
    // ★ 负向对照：回执还没回来 ⇒ **屏幕上不许已经是"已允许"**
    expect(switchOf(tester).value, false,
        reason: '★ 服务端还没说成，开关就拨过去了 ⇒ 那是"先说改好了"');
    expect(calls, [(id: 'notes', permission: 'db', allow: true)],
        reason: '★ 点下去要真的去说那一声（正文三样：id / permission / allow）');

    gate.complete(const GrantOk(['db']));
    await tester.pumpAndSettle();
    expect(switchOf(tester).value, true, reason: '★ 明说成了 ⇒ 屏幕才跟着变');
  });

  testWidgets('④ 关掉那一趟：说 `allow:false`，成了才关；而且没有"删掉"那种东西', (tester) async {
    final calls = <GrantCall>[];
    await pumpSettings(
      tester,
      apps: [_app(granted: const ['db'])],
      onGrant: (id, p, allow) async {
        calls.add((id: id, permission: p, allow: allow));
        return const GrantOk(<String>[]);
      },
    );
    await scrollToCard(tester);
    expect(switchOf(tester).value, true);

    await tester.tap(find.byKey(grantSwitchKey('notes', 'db')));
    await tester.pumpAndSettle();
    expect(calls, [(id: 'notes', permission: 'db', allow: false)]);
    expect(switchOf(tester).value, false, reason: '★ 成了 ⇒ 关');
    // 🔴 关闭只是"现在不给"：屏幕上说的是这一句，而且这一趟**没有**删除/清空那种按钮
    //    ⚠️ 2026-10-01：那张卡上**多了一颗「清空它存下来的东西」**（另一件事，见下面 ⑩–⑭），
    //       但它**只在接线了 `onClear` 时才摆**；这一条泵的没接线 ⇒ 屏幕上不该有它。
    //       ⚠️ **"关掉 ≠ 删掉"这一条本身没松**：它说的仍是"关一下不会动他存的东西"。
    expect(find.text(settingsGrantsHint), findsOneWidget);
    for (final bad in ['删掉', '清空', '清除']) {
      expect(find.textContaining(bad), findsNothing,
          reason: '★ 关掉不是删东西（`147` §五）：这一趟屏幕上不该有「$bad」');
    }
  });

  testWidgets('⑤ 🔴 没成 ⇒ 开关**一动不动**，而且如实说一句（服务端那句人话优先）', (tester) async {
    const serverWords = '这个小程序要的东西现在还不给。';
    await pumpSettings(
      tester,
      apps: [_app(granted: const [])],
      onGrant: (id, p, allow) async => const GrantFailed(serverWords),
    );
    await scrollToCard(tester);
    await tester.tap(find.byKey(grantSwitchKey('notes', 'db')));
    await tester.pumpAndSettle();
    // ★ 负向对照：没成却把开关拨过去（或拨过去又回滚）⇒ 这里当场红
    expect(switchOf(tester).value, false, reason: '★ 没成不许假装成了');
    expect(find.text(serverWords), findsOneWidget,
        reason: '★ 没成必须有一句话，而且优先用服务端那句');
    // 也不许把它说成"已经给了"（只看这张卡自己说了什么）
    expect(
      find.descendant(
        of: find.byKey(appGrantsCardKey),
        matching: find.textContaining('已经'),
      ),
      findsNothing,
    );
  });

  testWidgets('⑤·补 服务端没给人话 ⇒ 用兜底那句（**不许静默**）', (tester) async {
    await pumpSettings(
      tester,
      apps: [_app(granted: const [])],
      onGrant: (id, p, allow) async => const GrantFailed(''),
    );
    await scrollToCard(tester);
    await tester.tap(find.byKey(grantSwitchKey('notes', 'db')));
    await tester.pumpAndSettle();
    expect(switchOf(tester).value, false);
    expect(find.text(settingsGrantsFailed), findsOneWidget,
        reason: '★ 他点了一下，屏幕上必须有一句话（不许静默）');
  });

  testWidgets('⑥ 令牌不行 ⇒ 照样一动不动、也不说成"给了"', (tester) async {
    await pumpSettings(
      tester,
      apps: [_app(granted: const [])],
      onGrant: (id, p, allow) async => const GrantUnauthorized(),
    );
    await scrollToCard(tester);
    await tester.tap(find.byKey(grantSwitchKey('notes', 'db')));
    await tester.pumpAndSettle();
    expect(switchOf(tester).value, false);
    expect(find.text(settingsGrantsFailed), findsOneWidget);
  });

  testWidgets('⑦ 老服务端不回 `granted` ⇒ **不给开关**（但"它想要什么"照说）', (tester) async {
    await pumpSettings(
      tester,
      apps: [_app(granted: null)],
      onGrant: (id, p, allow) async => const GrantOk(['db']),
    );
    await scrollToCard(tester);
    expect(find.text(grantWantWords('db')), findsOneWidget,
        reason: '"它想要什么"是真话，照样说');
    expect(find.byKey(grantSwitchKey('notes', 'db')), findsNothing,
        reason: '★ 不知道"你给了没有" ⇒ 一个开关都不许画（不给假开关）');
  });

  testWidgets('⑦·补 这一条路没接上 ⇒ 也**不给开关**（同"不给假按钮"那条纪律）', (tester) async {
    await pumpSettings(tester, apps: [_app(granted: const [])]); // onGrant 没接线
    await scrollToCard(tester);
    expect(find.text(grantWantWords('db')), findsOneWidget);
    expect(find.byKey(grantSwitchKey('notes', 'db')), findsNothing,
        reason: '★ 按了也没人接 ⇒ 不许摆一个按不动的开关');
  });

  testWidgets('⑧ 认不出来的那一样：有一句人话，但**不给开关**', (tester) async {
    await pumpSettings(
      tester,
      apps: [_app(permissions: const ['something-new'], granted: const [])],
      onGrant: (id, p, allow) async => const GrantOk(['something-new']),
    );
    await scrollToCard(tester);
    expect(find.text(grantWantWords('something-new')), findsOneWidget);
    expect(find.byKey(grantSwitchKey('notes', 'something-new')), findsNothing);
  });

  testWidgets('⑨ ★ 从真入口走一遍：桌面 → 设置 → 点开关 ⇒ 真发了那一条请求，屏幕跟着变',
      (tester) async {
    // 一份假的 `/api/apps` ＋ 记下 `/api/app-grant` 那一条请求。
    Map<String, dynamic>? grantBody;
    final api = Api(
      client: MockClient((r) async {
        if (r.url.path == '/api/apps') {
          return _json(jsonEncode({
            'apps': [
              {
                'id': 'notes',
                'title': '随手记',
                'icon': 'book',
                'version': 1,
                'entryUrl': 'https://apps.example/notes/index.html?sig=x',
                'expiresAt': 0,
                'permissions': ['db'],
                'granted': <String>[],
              },
            ],
          }));
        }
        if (r.url.path == '/api/app-grant') {
          grantBody = jsonDecode(r.body) as Map<String, dynamic>;
          return _json(jsonEncode({'ok': true, 'permissions': ['db']}));
        }
        return _json('{}');
      }),
    );
    final c = ChatController(api: api, tokens: TokenStore(), token: 'tok');
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          controller: c,
          onLoggedOut: () {},
          // ⚠️ 桌面上那颗「设置」只在**这条路接上时**才摆（同 `_openConfig` 那条判据）——
          //    不接线的话这一屏上根本没有入口（那是产品行为，不是这一条的事）。
          space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: false),
          onSendKey: (_) async => KeySend.ok,
        ),
      ),
    );
    await tester.pumpAndSettle(); // 等 `/api/apps` 回来
    await tester.tap(find.text(settingsAppLabel));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget, reason: '★ 没进设置那一屏');
    await scrollToCard(tester);

    await tester.tap(find.byKey(grantSwitchKey('notes', 'db')));
    await tester.pumpAndSettle();
    expect(grantBody, {'id': 'notes', 'permission': 'db', 'allow': true},
        reason: '★ 那一下必须真的走到 `/api/app-grant`（正文三样）');
    expect(switchOf(tester).value, true, reason: '★ 服务端明说成了 ⇒ 屏幕跟着变了');
  });

  // ── ★ 2026-10-01：**清空它存下来的东西**（`POST /api/app-db-clear`）──────────
  //
  // 契约 `docs/dev/147-APP-SQLITE.md` §五那笔欠账。🔴 那一步**拿不回来** ⇒
  // 判据里最要命的两条是"**点取消不许发**"与"**没成不许显示成清掉了**"。

  /// ★ 从**真入口**走一遍（桌面 → 设置 → 那张卡），并把 `/api/app-db-clear`
  /// 那一条**原样**记下来。
  ///
  /// ⚠️ 与 ⑨ 同一条理由：只有走真入口，量的才是"用户真会看到的那棵树"；
  ///    而且**只有真的发出去**才算数（`MockClient`：不开端口、不碰真网）。
  Future<void> pumpGrantsViaChat(
    WidgetTester tester, {
    required List<http.Request> clearCalls,
    required http.Response Function(http.Request req) onClear,
    List<String> permissions = const ['db'],
    List<String> granted = const [],
  }) async {
    final api = Api(
      client: MockClient((r) async {
        if (r.url.path == '/api/apps') {
          return _json(jsonEncode({
            'apps': [
              {
                'id': 'notes',
                'title': '随手记',
                'icon': 'book',
                'version': 1,
                'entryUrl': 'https://apps.example/notes/index.html?sig=x',
                'expiresAt': 0,
                'permissions': permissions,
                'granted': granted,
              },
            ],
          }));
        }
        if (r.url.path == '/api/app-db-clear') {
          clearCalls.add(r);
          return onClear(r);
        }
        return _json('{}');
      }),
    );
    final c = ChatController(api: api, tokens: TokenStore(), token: 'tok');
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          controller: c,
          onLoggedOut: () {},
          space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: false),
          onSendKey: (_) async => KeySend.ok,
        ),
      ),
    );
    await tester.pumpAndSettle(); // 等 `/api/apps` 回来
    await tester.tap(find.text(settingsAppLabel));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget, reason: '★ 没进设置那一屏');
    await scrollToCard(tester);
  }

  testWidgets('⑩ ★ 点清空⇒弹确认；点【取消】**不许发请求**；再点一次、点【清掉】⇒ 真发了 POST ＋ 屏幕跟着变',
      (tester) async {
    final calls = <http.Request>[];
    await pumpGrantsViaChat(
      tester,
      clearCalls: calls,
      onClear: (_) => _json(jsonEncode({'ok': true, 'removed': 2})),
    );
    // ⚠️ 这一趟存储那一颗是**关着的**（`granted` 空）—— 下面要证明"清空跟开关无关"
    expect(switchOf(tester).value, false, reason: '这一趟 granted 是空的');
    expect(find.byKey(appDbClearKey('notes')), findsOneWidget,
        reason: '★ 声明了存东西 ⇒ 那颗按钮必须在（跟开关无关）');

    // ① 点一下 ⇒ **先弹二次确认**（这一刻一个请求都不许发）
    await tapClear(tester);
    expect(find.text(settingsClearDbTitle), findsOneWidget, reason: '★ 没弹二次确认层');
    expect(find.text(settingsClearDbWhat), findsOneWidget,
        reason: '★ 那句"拿不回来"必须说清（不然二次确认是走过场）');
    expect(calls, isEmpty, reason: '★ 只是弹了确认层 —— 一个请求都不许发');

    // ② 点【取消】⇒ 什么都不发，也不许冒出任何"清掉了"的话
    await tester.tap(find.byKey(appDbClearNoKey));
    await tester.pumpAndSettle();
    expect(calls, isEmpty, reason: '★ 点"取消"不许发出那一条请求');
    expect(find.text(settingsClearDbDone), findsNothing,
        reason: '★ 取消了还冒出"清掉了" ⇒ 那是页面在说假话');
    expect(find.byKey(appDbClearNoteKey('notes')), findsNothing);

    // ③ 再点一次 ⇒ 点【清掉】⇒ **只有这一刻**才真发
    await tapClear(tester);
    await tester.tap(find.byKey(appDbClearYesKey));
    await tester.pumpAndSettle();
    expect(calls.length, 1, reason: '★ 确认之后那一下必须真的走到 `/api/app-db-clear`');
    expect(calls.single.method, 'POST', reason: '★ 是 POST');
    expect(calls.single.url.path, '/api/app-db-clear');
    expect(calls.single.headers['authorization'], 'Bearer tok',
        reason: '★ 签字走登录态（照 appRename / appGrant 那条）');
    expect(jsonDecode(calls.single.body), {'id': 'notes'},
        reason: '★ 正文只有那个 app 的 id');

    // ④ 屏幕跟着变：如实说一句（`removed` 不必显示）
    expect(find.text(settingsClearDbDone), findsOneWidget,
        reason: '★ 服务端明说成了 ⇒ 屏幕上必须有一句"清掉了"');
  });

  testWidgets('⑪ ★ 服务端回错 ⇒ **照它那句说**，而且**不许**显示成清掉了', (tester) async {
    const serverWords = '你那台还在准备，稍等一下再试。';
    final calls = <http.Request>[];
    await pumpGrantsViaChat(
      tester,
      clearCalls: calls,
      onClear: (_) => http.Response(
        jsonEncode({'ok': false, 'error': 'tenant-not-ready', 'text': serverWords}),
        503,
        headers: {'content-type': 'application/json; charset=utf-8'},
      ),
    );
    await tapClear(tester);
    await tester.tap(find.byKey(appDbClearYesKey));
    await tester.pumpAndSettle();
    expect(calls.length, 1);
    expect(find.text(serverWords), findsOneWidget, reason: '★ 服务端有人话 ⇒ 照它说');
    expect(find.byKey(appDbClearNoteKey('notes')), findsOneWidget,
        reason: '★ 不许静默（他点了一下，屏幕上必须有一句话）');
    expect(find.text(settingsClearDbDone), findsNothing,
        reason: '★ 没成却显示成"清掉了" ⇒ 那是这个项目最忌的那种假话');
  });

  testWidgets('⑪·补 ★ **200 但 `ok` 不是 true** ⇒ 一样算没成（最容易写成"200 就成"）', (tester) async {
    // ⚠️ 单开一条用例（不跟 ⑪ 挤在同一个 `pumpWidget` 里）：
    //    同一个用例里连泵两棵 `ChatScreen`，`Navigator` 会把上一条路由留着，
    //    于是 `find.text('设置')` 撞到的是**退到幕后**那一棵 —— 那一下点了个空，
    //    而下面的断言照样绿（"闸变弱了"的形状）。一条用例一棵树最稳。
    final calls = <http.Request>[];
    await pumpGrantsViaChat(
      tester,
      clearCalls: calls,
      onClear: (_) => _json(jsonEncode({'error': 'not-done'})),
    );
    await tapClear(tester);
    await tester.tap(find.byKey(appDbClearYesKey));
    await tester.pumpAndSettle();
    expect(calls.length, 1);
    expect(find.text(settingsClearDbDone), findsNothing,
        reason: '★ 200 但没有明说 ok ⇒ 一个字节都不当成功');
    expect(find.text(settingsClearDbFailed), findsOneWidget,
        reason: '★ 它没说人话 ⇒ 用兜底那句（仍然不许静默）');
  });

  testWidgets('⑫ ★ 等回执的时候那颗按钮按不动（别让他连点）', (tester) async {
    final calls = <ClearCall>[];
    final gate = Completer<ClearOutcome>();
    await pumpSettings(
      tester,
      apps: [_app()],
      onClear: (id) {
        calls.add(id);
        return gate.future;
      },
    );
    await scrollToCard(tester);
    await tapClear(tester);
    await tester.tap(find.byKey(appDbClearYesKey));
    await tester.pump();
    expect(calls, ['notes'], reason: '★ 确认之后才发');
    final btn = tester.widget<TextButton>(find.byKey(appDbClearKey('notes')));
    expect(btn.onPressed, isNull, reason: '★ 回执还没回来 ⇒ 那颗按钮按不动');

    // 连点也不许多发一条
    await tester.tap(find.byKey(appDbClearKey('notes')), warnIfMissed: false);
    await tester.pump();
    expect(calls, ['notes'], reason: '★ 按不动就是按不动（别让他连点）');

    gate.complete(const ClearOk(1));
    await tester.pumpAndSettle();
    expect(find.text(settingsClearDbDone), findsOneWidget);
  });

  testWidgets('⑬ ★ 没声明存东西的 app 上**没有**那颗按钮；这条路没接上也不给', (tester) async {
    // ① 声明了 ask / net，但**没声明**存东西 ⇒ 不许摆一个"清空"
    await pumpSettings(
      tester,
      apps: [_app(permissions: const ['ask', 'net'], granted: const [])],
      onClear: (_) async => const ClearOk(0),
    );
    await scrollToCard(tester);
    expect(find.text(grantWantWords('net')), findsOneWidget,
        reason: '★ "想连网取数据"那一句要在屏幕上（认得 = 给开关）');
    expect(grantSwitchOn(_app(permissions: const ['ask', 'net']), 'net'), false,
        reason: '★ net 认得 ⇒ 开关的值只看 granted');
    expect(find.byKey(appDbClearKey('notes')), findsNothing,
        reason: '★ 它没声明存东西 ⇒ 摆一个"清空"就是假按钮');

    // ② 声明了存东西，但这一条路没接上 ⇒ 也不给（同"不给假按钮"那条纪律）
    await pumpSettings(tester, apps: [_app()]);
    await scrollToCard(tester);
    expect(find.byKey(appDbClearKey('notes')), findsNothing,
        reason: '★ 按了也没人接 ⇒ 不许摆一颗按不动的"清空"');
  });

  testWidgets('⑭ ★ 幂等：没存过（`removed:0`）也算成了 —— 如实说"清掉了"，不许报错', (tester) async {
    final calls = <http.Request>[];
    await pumpGrantsViaChat(
      tester,
      clearCalls: calls,
      onClear: (_) => _json(jsonEncode({'ok': true, 'removed': 0})),
    );
    await tapClear(tester);
    await tester.tap(find.byKey(appDbClearYesKey));
    await tester.pumpAndSettle();
    expect(calls.length, 1);
    expect(find.text(settingsClearDbDone), findsOneWidget,
        reason: '★ 幂等：没存过也回 200 ⇒ 他连点两次不该看到报错');
  });
}

http.Response _json(String body) => http.Response(
  body,
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
