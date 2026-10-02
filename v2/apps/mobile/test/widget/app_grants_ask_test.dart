// **打开时那张弹窗**（契约 `docs/dev/147-APP-SQLITE.md` §二·乙 ·
// 主人 2026-10-01：*「小程序不要声明，应该是打开后有弹窗申请权限」* ·
// *「打开时一次问完」* · *「那一样用不了，别的照旧」*）。
//
// ── 这一份要像用户那样按下去 ────────────────────────────────
//   ① **一次问完**：声明了、还没表过态的那几样**都在同一张窗里**；
//   ② **默认全开**：他一个字都不改，按「就这样」就等于全给（傻瓜式）；
//   ③ 🔴 **他关掉一样**：回来那份选择里那一样是 `false`，**别的照旧是 `true`**；
//   ④ 🔴 **「都不给」**：每一样都是 `false`（**也是他表过态** ⇒ 之后不再自动问）；
//   ⑤ 🔴 **没有要问的样就不弹**（`needsAskOnOpen` 为假时屏那一侧根本不会调它 ——
//      这里钉住"哪几样会进窗"那一半）；
//   ⑥ ★ `net` 那一样多一句**要连的站**（只有这一张窗摆域名）；
//   ⑦ ★ 字放到 3.1 倍时**不溢出**（D3.5）。
//
// ⚠️ 判据不写"控件存在就算完"：每一条都走真手势（点开关 / 点按钮），
//    并带**负向对照**（改回旧行为它得当场红）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/app_spec.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/widgets/app_grants_ask.dart';

MiniApp _app({
  String id = 'tianqi',
  String title = '看天气',
  // ⚠️ ★ 2026-10-02：`db` **不再进这张窗** ⇒ 量的是另外几样（存储默认有）
  List<String> permissions = const ['ask', 'net'],
  List<String>? unanswered = const ['ask', 'net'],
  List<String> net = const ['api.example.com'],
}) => MiniApp(
  id: id,
  title: title,
  icon: 'cloud',
  version: 1,
  entryUrl: 'https://apps.example/$id/index.html?sig=x',
  permissions: permissions,
  granted: const [],
  unanswered: unanswered,
  net: net,
);

/// 泵出那张弹窗，并把"他选了什么"接住（`null` = 没表态）。
Future<Map<String, bool>?> _pump(WidgetTester tester, MiniApp app) async {
  Map<String, bool>? got;
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (ctx) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () async {
                got = await askOnOpen(ctx, app);
              },
              child: const Text('开'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('开'));
  await tester.pumpAndSettle();
  return got;
}

void main() {
  testWidgets('★ 一次问完：还没表过态的那几样都在同一张窗里，名字是人话', (tester) async {
    await _pump(tester, _app());
    expect(find.byKey(askOnOpenKey), findsOneWidget, reason: '弹窗没出来');
    // 抬头带上它的名字（"「看天气」想用几样东西"）
    expect(find.textContaining('看天气'), findsWidgets);
    // 两样都在，而且是**人话**（协议名一个都不许上屏）
    expect(find.text(grantWantWords('ask')), findsOneWidget);
    expect(find.text(grantWantWords('net')), findsOneWidget);
    expect(find.text('ask'), findsNothing);
    expect(find.text('net'), findsNothing);
    // ★ 只有 `net` 那一样多一句要连的站
    expect(find.textContaining('api.example.com'), findsOneWidget);
    // 底下那句"别的照旧"
    expect(find.text(askOnOpenLead), findsOneWidget);
    expect(find.text(askOnOpenLater), findsOneWidget);
  });

  testWidgets('★ 默认全开：他什么都不改，按「就这样」= 全给（傻瓜式）', (tester) async {
    Map<String, bool>? got;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (ctx) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  got = await askOnOpen(ctx, _app());
                },
                child: const Text('开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('开'));
    await tester.pumpAndSettle();
    // 两颗开关都是开的（默认），而且旁边那个字写着"允许"
    for (final p in ['ask', 'net']) {
      final sw = tester.widget<Switch>(find.byKey(askOnOpenSwitchKey(p)));
      expect(sw.value, true, reason: '★ $p 默认要给（傻瓜式）');
    }
    expect(find.text(askOnOpenOn), findsNWidgets(2));
    await tester.tap(find.byKey(askOnOpenGoKey));
    await tester.pumpAndSettle();
    expect(got, {'ask': true, 'net': true}, reason: '★ 一个字都没改 ⇒ 全给');
    expect(find.byKey(askOnOpenKey), findsNothing, reason: '按完就该收起来');
  });

  testWidgets('🔴 他关掉一样：那一样 false，别的照旧 true（"那一样用不了，别的照旧"）', (tester) async {
    Map<String, bool>? got;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (ctx) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  got = await askOnOpen(ctx, _app(permissions: const ['ask', 'net'], unanswered: const ['ask', 'net']));
                },
                child: const Text('开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('开'));
    await tester.pumpAndSettle();
    // 像用户那样按一下存储那一颗开关（关掉它）
    await tester.tap(find.byKey(askOnOpenSwitchKey('ask')));
    await tester.pumpAndSettle();
    // 那颗开关旁边那个字跟着变成"不给"（现状要看得见）
    expect(tester.widget<Switch>(find.byKey(askOnOpenSwitchKey('ask'))).value, false);
    expect(tester.widget<Switch>(find.byKey(askOnOpenSwitchKey('net'))).value, true,
        reason: '★ 负向对照：关一样不许把别的也关了');
    await tester.tap(find.byKey(askOnOpenGoKey));
    await tester.pumpAndSettle();
    expect(got, {'ask': false, 'net': true});
  });

  testWidgets('🔴 「都不给」：每一样都是 false（他表过态 ⇒ 之后不再自动问）', (tester) async {
    Map<String, bool>? got;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (ctx) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  got = await askOnOpen(ctx, _app());
                },
                child: const Text('开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('开'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(askOnOpenNoneKey));
    await tester.pumpAndSettle();
    expect(got, {'ask': false, 'net': false});
    expect(find.byKey(askOnOpenKey), findsNothing);
  });

  testWidgets('🔴 划掉不算回答：`null` ⇒ 屏那一侧什么都不记（下次再问）', (tester) async {
    Map<String, bool>? got;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (ctx) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  got = await askOnOpen(ctx, _app());
                },
                child: const Text('开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('开'));
    await tester.pumpAndSettle();
    // 系统返回键（Android 那一侧就是划掉 / 返回）
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(got, isNull, reason: '★ 没表态 ⇒ 不许替他记成"不给"');
  });

  testWidgets('★ 字放到 3.1 倍也不溢出（D3.5）', (tester) async {
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(textScaler: TextScaler.linear(3.1)),
        child: MaterialApp(
          home: Builder(
            builder: (ctx) => Scaffold(
              body: Center(
                child: ElevatedButton(
                  onPressed: () => askOnOpen(ctx, _app()),
                  child: const Text('开'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('开'));
    await tester.pumpAndSettle();
    expect(find.byKey(askOnOpenKey), findsOneWidget);
    // 溢出在测试里会抛异常（`RenderFlex overflowed`）⇒ 走到这儿没抛就是没溢出
    expect(tester.takeException(), isNull);
  });
}
