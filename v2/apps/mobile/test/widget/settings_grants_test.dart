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
//   ⑤ 关闭**只是"现在不给"** —— 界面上没有"删掉 / 清空"那类东西。
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
    // 🔴 关闭只是"现在不给"：屏幕上说的是这一句，而且**没有**删除/清空那种按钮
    expect(find.text(settingsGrantsHint), findsOneWidget);
    for (final bad in ['删掉', '清空', '清除']) {
      expect(find.textContaining(bad), findsNothing,
          reason: '★ 关掉不是删东西（`147` §五）：屏幕上不该有「$bad」');
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
}

http.Response _json(String body) => http.Response(
  body,
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
