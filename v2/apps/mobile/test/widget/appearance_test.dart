// **聊天窗口跟着"外观 ＋ 字号"变**（契约 `docs/dev/119-APPEARANCE-AND-FONT.md`）。
//
// ⚠️ 这是**提示档**（`AGENTS.md` §5.1：`test/widget` 只有可访问性那一份是硬闸），
//    但它不是可有可无的：它是"这件设置到底有没有画到屏幕上"的**唯一自动化证据**。
//    纯逻辑在 `test/unit/appearance_test.dart` 与 `appearance_store_test.dart`；
//    **用户字号 12/14/17 下不溢出 + 命中区 ≥44** 在 `accessibility_test.dart`（硬闸）。
//
// 这一份钉五件：
//   ① 🔴 切到暗色 ⇒ 聊天窗口那块底**真的换了 token**（不是只有枚举变了）；
//   ② 🔴 "跟随系统" ⇒ 设备暗则窗口暗（`system` 的解析真的发生了）；
//   ③ 🔴 改字号 ⇒ 聊天里那一行字的**渲染度量**真的变了（量字号与高度，不量"看起来像"）；
//   ④ 🔴 **改一下马上生效、不重连**（那条流一个字节都不动：连接只建过一次）；
//   ⑤ 🔴 **存得住**（换一份 store = 重开页面，读到的还是他选的那一档）。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/appearance.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/appearance_store.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/stream.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/composer.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 盘上那个 key（与 `AppearanceStore` 里那一个逐字相同）。
const String kKey = 'hupo_chat_appearance';

http.Response _json(String body) =>
    http.Response(body, 200, headers: {'content-type': 'application/json; charset=utf-8'});

/// 假的那条流：只记账（判据要的是"改外观有没有重连"）。
class _FakeStream implements StreamClient {
  _FakeStream({required this.base, required this.token, required this.api, required this.level, required scope})
    : _focus = scope;

  @override
  final String base;
  @override
  final String token;
  @override
  final Api api;
  @override
  final ProcessLevel level;
  @override
  Duration get pingTimeout => const Duration(seconds: 60);
  @override
  Future<TokenProbe> Function(String token)? get probe => null;
  String _focus;
  @override
  String get scope => _focus;
  @override
  Stream<Map<String, dynamic>> get events => const Stream<Map<String, dynamic>>.empty();
  @override
  Stream<ConnState> get states => const Stream<ConnState>.empty();
  @override
  ConnState get state => ConnState.connected;
  @override
  bool get isConnected => true;
  @override
  int get sinceSeq => 0;
  @override
  void open({int sinceSeq = 0}) {}
  @override
  void focus(String scope, {int sinceSeq = 0}) => _focus = scope;
  @override
  bool answerJob(String id, {required bool yes}) => true;
  @override
  bool unsay(String messageId) => true;
  @override
  void close() {}
  @override
  Future<void> dispose() async {}
}

/// 一条工具行（量字号用那一行工具名：它直接走 `look.content`）。
///
/// ⚠️ 这就是**真入口**（`controller.ingest` 喂服务端那一帧的形状）——
///    不直接 pump `ToolRowView`：那样它底下没有聊天屏，量的不是用户真会看到的树。
void _feedToolRow(ChatController c) {
  c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
  c.ingest({
    'type': 'tool/call',
    'seq': 2,
    'turn': 1,
    'step': 1,
    'callId': 'c_1',
    'name': 'bash',
    'title': '跑一下测试',
    'args': '{"command":"ls"}',
  });
}

/// 一架屏 ＋ 一个控制器 ＋ 那条假流的账（真 `start` 一遍 —— 连接只建这一次）。
///
/// ⚠️ **必须给令牌 + `onSendKey`**：没有它们，桌面上那个「设置」图标根本不会长出来，
///    这道判据就进不去设置那一屏（而屏幕上那两行照样画 —— "闸变弱了"那种形状）。
/// ⚠️ **默认收起档**：那是"点得到桌面上那个图标"的那一档（`initialTier: full`
///    的话浮窗把桌面盖住了，点图标会**点到浮窗上** —— 2026-09-22 实测过）。
///    要量时间线那一块的判据显式传 `FloaterTier.full`。
Future<(Widget, ChatController, List<_FakeStream>)> _screen({
  FloaterTier tier = FloaterTier.collapsed,
}) async {
  final made = <_FakeStream>[];
  final api = Api(
    base: 'http://127.0.0.1:1',
    client: MockClient((_) async => _json(jsonEncode(<String, Object>{}))),
  );
  final c = ChatController(
    api: api,
    tokens: TokenStore(),
    token: 'tok',
    newStream: ({required base, required token, required level, required scope}) {
      final s = _FakeStream(base: base, token: token, api: api, level: level, scope: scope);
      made.add(s);
      return s;
    },
  );
  await c.start(token: 'tok');
  _feedToolRow(c);
  return (
    ChatScreen(
      initialTier: tier,
      controller: c,
      onLoggedOut: () {},
      space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
      onSendKey: (_) async => KeySend.ok,
    ),
    c,
    made,
  );
}

/// 聊天窗口那块底的 `Material`（浮窗自己那一个 —— 深度优先里它排在最前面）。
Material _floaterMaterial(WidgetTester tester) => tester.widget<Material>(
  find.descendant(of: find.byType(ChatFloater), matching: find.byType(Material)).first,
);

/// **像用户那样**打开「设置」那一屏（点桌面上那个图标）。
Future<void> _openSettings(WidgetTester tester) async {
  await tester.tap(find.text(settingsAppLabel));
  await tester.pumpAndSettle();
  // 🔴 负向对照：**真的到了设置那一屏**才算数（没到的话下面量的是桌面）。
  expect(find.byType(SettingsScreen), findsOneWidget,
      reason: '★ 没进设置那一屏 ⇒ 这道判据扫错了屏');
}

/// 把「这块窗口」那张卡滚进视野（窄屏 + 大字号下它在折叠线以下）。
Future<void> _scrollTo(WidgetTester tester, String label) async {
  await tester.scrollUntilVisible(
    find.text(label),
    200,
    scrollable: find
        .descendant(
          of: find.byKey(const ValueKey('credTab:$credTabChat')),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pumpAndSettle();
}

/// 输入条那个框的字号（收起档也在树上 —— 它一样是"聊天里的字"）。
///
/// ⚠️ 必须**指名到 `Composer` 里那一个** `TextField`：设置那一屏自己也有一个
///    （钥匙那个框），`find.byType(TextField).first` 会摸错人。
double _composerFontSize(WidgetTester tester) => tester
    .widget<TextField>(
      find.descendant(of: find.byType(Composer), matching: find.byType(TextField)),
    )
    .style!
    .fontSize!;

/// 聊天里那一行工具名的**渲染字号**。
///
/// ⚠️ `style.fontSize` 是**没缩放**的那个值 ⇒ 显式把 `textScaler` 用上
///    （与 `accessibility_test.dart` 那条"不封顶"同一个量法）。
double _rowFontSize(WidgetTester tester) {
  expect(find.text('bash'), findsOneWidget,
      reason: '★ 工具行不在树里 ⇒ 量不到聊天里的字（这一条会红）');
  final p = tester.renderObject<RenderParagraph>(find.text('bash'));
  return p.textScaler.scale(p.text.style!.fontSize!);
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('🔴 切到暗色 ⇒ 聊天窗口那块底**真的换了 token**', (tester) async {
    final (screen, _, _) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();

    // 负向对照：默认（跟随系统 ＋ 测试环境是亮色）⇒ **亮色那一档**
    expect(_floaterMaterial(tester).color, DshPalette.light.bgLayer1,
        reason: '★ 默认那一档就不对 ⇒ 下面的正例没有意义');

    await _openSettings(tester);
    await _scrollTo(tester, settingsAppearanceLabel);
    await tester.tap(find.text(ChatAppearance.dark.label));
    await tester.pumpAndSettle();

    // 正例：**同一块 Material 的颜色换成了暗色那一档**
    expect(_floaterMaterial(tester).color, DshPalette.dark.bgLayer1,
        reason: '★ 选了"暗"而窗口的底还是亮色 ⇒ 设置没接上去');
    expect((await AppearanceStore().read()).appearance, ChatAppearance.dark,
        reason: '★ 没存下来 ⇒ 重开页面就丢');

    // 切回"亮"：窗口跟着回去（不是单行道）
    await tester.tap(find.text(ChatAppearance.light.label));
    await tester.pumpAndSettle();
    expect(_floaterMaterial(tester).color, DshPalette.light.bgLayer1);
    expect((await AppearanceStore().read()).appearance, ChatAppearance.light);
  });

  testWidgets('🔴 跟随系统：设备是暗的 ⇒ 窗口是暗的（`system` 真的解析了）', (tester) async {
    final (screen, _, _) = await _screen(tier: FloaterTier.full);
    await tester.pumpWidget(
      MaterialApp(
        // ⚠️ **`copyWith`，不许自己造一份 `MediaQueryData()`**：那样 `size` 会是
        //    `Size.zero`，浮窗被夹到最小高度、当场纵向溢出（第一版就是这么红的）。
        //    而且它必须注在 `MaterialApp` **里面**（外面那个会被它自己那份盖掉）。
        home: Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context).copyWith(platformBrightness: Brightness.dark),
            child: screen,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    // 默认就是"跟随系统"（这一条本身也要成立，不然量的是别的东西）
    expect((await AppearanceStore().read()).appearance, ChatAppearance.system);
    expect(_floaterMaterial(tester).color, DshPalette.dark.bgLayer1,
        reason: '★ 设备是暗的、设置是"跟随系统"，窗口却是亮的 ⇒ 解析没做');
  });

  testWidgets('🔴 改字号 ⇒ 聊天里那一行字的**渲染度量**真的变了', (tester) async {
    // 三档各来一次（12 / 14 / 17）—— 判据量的是**字号与高度**，不是"看起来像"。
    final seen = <int, (double, double)>{};
    for (final n in <int>[12, 14, 17]) {
      SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'system|$n'});
      final c = ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());
      _feedToolRow(c);
      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(
            // ⚠️ **每一档一个新 key**：同一个测试里连着 pump 同一种 widget 时
            //    Flutter 会**复用那个 State**（`initState` 不再跑）⇒ 后面两档
            //    量的还是第一档的字号（第一版就是这么量出"三档都是 12"的）。
            key: ValueKey('u$n'),
            initialTier: FloaterTier.full,
            controller: c,
            onLoggedOut: () {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      final h = tester.getSize(find.text('bash')).height;
      seen[n] = (_rowFontSize(tester), h);
    }
    // 12 / 14 / 17 的字号**逐档对得上**那条轴（不是"都在变"就算过）
    expect(seen[12]!.$1, 12);
    expect(seen[14]!.$1, 14);
    expect(seen[17]!.$1, 17);
    // 而且**渲染高度**也跟着长（字号轴真的传到了布局，不只是样式字段）
    expect(seen[17]!.$2, greaterThan(seen[14]!.$2));
    expect(seen[12]!.$2, lessThan(seen[14]!.$2));
  });

  testWidgets('🔴 在设置里按"大一点" ⇒ 聊天**当场**跟着变，而且**不重连**', (tester) async {
    // ⚠️ 这一条量的是**输入条那个框**（收起档也在树上，而且它就是"聊天里的字"）：
    //    设置那一屏开着时浮窗是收起的（打开小程序会自动收起），时间线不在树里
    //    ⇒ 量它才是"屏幕上真的变了"。
    final (screen, _, made) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();
    expect(made.length, 1, reason: '起点：那条流只建过一次');
    expect(_composerFontSize(tester), 16, reason: '起点是默认档（16 = `DshTypes.base` + Δ0）');

    await _openSettings(tester);
    await _scrollTo(tester, settingsFontSizeLabel);
    await tester.tap(find.byTooltip(settingsFontSizeBigger));
    await tester.pumpAndSettle();

    // ① 屏幕上（同一棵树里）：那个框的字**当场**大了一号（15 ⇒ 17）
    expect(_composerFontSize(tester), 17, reason: '★ 按了"大一点"而聊天里的字没变');
    // ② 存住了
    expect((await AppearanceStore().read()).fontSize, 15);
    // ③ 🔴 **没有重连**：那条流一个字节都没动（改外观不是"重新连一次"）
    expect(made.length, 1, reason: '★ 改外观/字号重开了连接 —— 那正是这一条要挡的');

    // 负向对照：按"小一点"回去（不是单行道）
    await tester.tap(find.byTooltip(settingsFontSizeSmaller));
    await tester.pumpAndSettle();
    expect(_composerFontSize(tester), 16);
    expect((await AppearanceStore().read()).fontSize, 14);
  });

  testWidgets('🔴 数据坏在盘上 ⇒ 窗口照开（回到默认档，不是打不开）', (tester) async {
    // 这是"fail-closed"那一条在**屏幕上**的证据：坏值只许退回默认。
    SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'DARK|坏了'});
    final c = ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());
    _feedToolRow(c);
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull, reason: '★ 盘上那个串把界面弄崩了');
    expect(_floaterMaterial(tester).color, DshPalette.light.bgLayer1,
        reason: '★ 认不出的外观没有退回默认档');
    expect(_rowFontSize(tester), 14, reason: '★ 认不出的字号没有退回默认档');
  });
}
