// **聊天窗口跟着"外观 ＋ 字号"变**（契约 `docs/dev/119-APPEARANCE-AND-FONT.md`）。
//
// ⚠️ 这是**提示档**（`AGENTS.md` §5.1：`test/widget` 只有可访问性那一份是硬闸），
//    但它不是可有可无的：它是"这件设置到底有没有画到屏幕上"的**唯一自动化证据**。
//    纯逻辑在 `test/unit/appearance_test.dart` 与 `appearance_store_test.dart`；
//    **用户字号 12/14/17 下不溢出 + 命中区 ≥44** 在 `accessibility_test.dart`（硬闸）。
//
// 这一份钉五件：
//   ① 🔴 **默认 = 亮**（没存过 ⇒ 亮色板）＋ **设置里只摆「亮」**（暗 / 跟随系统不出现，
//      而明说砍了那句在）—— 2026-09-26 主人暗色手机上的截图报的就是这一屏；
//   ② 🔴 **设备是暗的，窗口也还是亮的**（"跟随系统"暂时一律解成亮 —— 这一条钉那个"暂时"）；
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
import 'package:hupo_app/models/tool_row_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/appearance_store.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/stream.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/mini_app_host.dart';
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

/// 一条工具行（量字号用那一行工具名：它直接走 `look.quiet` —— 非主要那一档）。
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

/// 时间线里那一条助手回话的正文（**聊天"主要"那一档**的载体）。
///
/// 🔴 2026-10-04 起底下那一格改成"语音优先"（手册 `D3.14`：**不再有输入框**）——
///    原来量"主要那一档"是量输入框里那段字；现在改量**时间线里的正文**
///    （同一个 `look.content` = `14+Δ` / `20+Δ`）。
const String _answerText = '这周 7 小时。';

/// 喂一条助手回话（`quick` 那一块 —— 它画在正文那一档上）。
///
/// ⚠️ **默认不收尾**（不喂 `message/end`）：这一轮一收，`_planSlots` 会把工具行
///    折进"过程"那一条 ⇒ **非主要那一档（工具行）就不在树里了**，量不到。
///    （要量两档的判据都得让它开着 —— 这正是"同一轮里两档同时在场"的真形状。）
void _feedAnswer(ChatController c, {bool ended = false}) {
  c.ingest({'type': 'message/start', 'seq': 5, 'messageId': 'm_a'});
  c.ingest({
    'type': 'message/text',
    'seq': 6,
    'messageId': 'm_a',
    'block': 'quick',
    'text': _answerText,
  });
  if (ended) {
    c.ingest({'type': 'message/end', 'seq': 8, 'messageId': 'm_a', 'reason': 'completed'});
  }
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
  // ★ 聊天"主要"那一档的载体（时间线里的正文）—— 这道屏上有它才量得到
  _feedAnswer(c);
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

/// **浮窗现在用的是哪一档色板**（**不看透明度**）。
///
/// ⚠️ 原来这一条量的是浮窗那块底的**实测颜色**（`Material.color`）。2026-10-04
///    主人把底下那一格改成"语音优先"、收起档**不再画那个框**（*"语音按钮下面的平台
///    不需要了"*）⇒ 收起档那个 `Material` 的颜色是**全透明的**，量颜色已经量不到"哪一档"。
/// ⇒ 现在守的是**同一件事**：浮窗里面那一整棵套的是哪一档的 `Theme`
///    （`chatThemeOf(variant)` 的 `cardColor` = 该档的 `bg-layer-1`）——
///    它才是"这一面按哪一档画"的出处，收起 / 展开两档都读得到，值也没变。
Color _floaterBg(WidgetTester tester) => tester
    .widget<Theme>(
      find.descendant(of: find.byType(ChatFloater), matching: find.byType(Theme)).first,
    )
    .data
    .cardColor;

/// **像用户那样**打开「设置」那一屏（点桌面上那个图标）。
Future<void> _openSettings(WidgetTester tester) async {
  await tester.tap(find.text(settingsAppLabel));
  await tester.pumpAndSettle();
  // 🔴 负向对照：**真的到了设置那一屏**才算数（没到的话下面量的是桌面）。
  expect(find.byType(SettingsScreen), findsOneWidget,
      reason: '★ 没进设置那一屏 ⇒ 这道判据扫错了屏');
}

/// 走进「这块窗口」那一页，并把要量的那一行滚进视野。
///
/// ⚠️ 2026-09-29 改：设置改成**一列分类**之后，那两行**不在顶层**了 ——
///    它们住在「这块窗口」那一页里 ⇒ 判据必须**像用户那样点开它**
///    （不点开就找不到 —— 那正是"点开才是配置"这件事在屏幕上的样子）。
Future<void> _scrollTo(WidgetTester tester, String label) async {
  await tester.scrollUntilVisible(
    find.text(settingsAppearanceSection),
    200,
    scrollable: find
        .descendant(
          of: find.byKey(settingsListKey),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text(settingsAppearanceSection));
  await tester.pumpAndSettle();
  // ⚠️ 子页里那一行也可能在折叠线以下（大字号）⇒ 再滚一次（这次滚的是**子页那一列**）
  if (find.text(label).evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      find.text(label),
      200,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pumpAndSettle();
  }
  expect(find.text(label), findsOneWidget, reason: '★「$label」没进这棵树 ⇒ 这一条量错了地方');
}

/// **聊天正文那一档**（时间线里助手那一句）的**渲染字号**。
///
/// ⚠️ 原来那一个（`_composerFontSize`）量的是输入框里那段字 —— 2026-10-04 起
///    底下那一格不再有输入框（手册 `D3.14`）⇒ 同一档的字改住在**时间线的正文**上
///    （`look.content` = `14+Δ` / `20+Δ`）。量法与 `_rowFontSize` 逐字相同。
double _mainFontSize(WidgetTester tester) {
  expect(find.text(_answerText), findsOneWidget,
      reason: '★ 助手那一句不在树里 ⇒ 量不到聊天正文那一档（这一条会红）');
  final p = tester.renderObject<RenderParagraph>(find.text(_answerText));
  return p.textScaler.scale(p.text.style!.fontSize!);
}

/// 同一句的**渲染高度**（字号轴真的传到了布局，不只是样式字段）。
double _mainHeight(WidgetTester tester) =>
    tester.getSize(find.text(_answerText)).height;

/// 聊天里那一行工具名的**渲染字号**。
///
/// ⚠️ `style.fontSize` 是**没缩放**的那个值 ⇒ 显式把 `textScaler` 用上
///    （与 `accessibility_test.dart` 那条"不封顶"同一个量法）。
double _rowFontSize(WidgetTester tester) {
  // ★ 2026-10-02（`154` §2.1）：那一格现在是**人话**（`bash` → 「跑命令」）
  expect(find.text(toolHumanName('bash')!), findsOneWidget,
      reason: '★ 工具行不在树里 ⇒ 量不到聊天里的字（这一条会红）');
  final p = tester.renderObject<RenderParagraph>(find.text(toolHumanName('bash')!));
  return p.textScaler.scale(p.text.style!.fontSize!);
}

/// **像用户那样**在设置里按一下字号那一颗（大一点 / 小一点）。
///
/// ⚠️ 打开某一屏会**自动把聊天收起来**（`_openMiniApp`）⇒ 要先把展开的那一档收回去，
///    桌面上那个「设置」图标才点得到（展开的浮窗把桌面盖住了）。
Future<void> _tapFontInSettings(WidgetTester tester, {required bool bigger}) async {
  final collapse = find.byKey(chatCollapseKey);
  if (collapse.evaluate().isNotEmpty) {
    await tester.tap(collapse);
    await tester.pumpAndSettle();
  }
  await _openSettings(tester);
  await _scrollTo(tester, settingsFontSizeLabel);
  await tester.tap(find.byTooltip(bigger ? settingsFontSizeBigger : settingsFontSizeSmaller));
  await tester.pumpAndSettle();
}

/// 从设置那一屏退回去、把聊天展开 —— 时间线里的正文这才回到了树上（量得到）。
Future<void> _backToChat(WidgetTester tester) async {
  await tester.tap(find.text(settingsBack)); // 子页 ⇒ 设置那一列
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(miniAppExitKey)); // 设置那一屏 ⇒ 桌面
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(chatHandleKey)); // 桌面 ⇒ 展开聊天
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('🔴 没存过 ⇒ 窗口是**亮**色板；设置里只摆「亮」（暗 / 跟随系统不出现）', (tester) async {
    final (screen, _, _) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();

    // ① 默认那一档 = 亮（暗色那一套没做完；没做完的样子不许当默认推给人）
    expect((await AppearanceStore().read()).appearance, ChatAppearance.light,
        reason: '★ 没存过时的默认不是亮 ⇒ 暗色手机上又会是"黑底 ＋ 淡粉条"');
    expect(_floaterBg(tester), DshPalette.light.bgLayer1,
        reason: '★ 默认那一档的底不是亮色板');

    // ② 设置那一屏：只有「亮」可选，另外两档**不在屏幕上**，但"明说砍了"那句在
    await _openSettings(tester);
    await _scrollTo(tester, settingsAppearanceLabel);
    expect(find.text(ChatAppearance.light.label), findsWidgets, reason: '★「亮」那一颗没画出来');
    expect(find.text(ChatAppearance.dark.label), findsNothing,
        reason: '★「暗」还在设置里摆着 —— 暗色那一套没做完，不许摆出来给人按');
    expect(find.text(ChatAppearance.system.label), findsNothing,
        reason: '★「跟随系统」还在设置里摆着（同上）');
    expect(find.text(settingsAppearanceDarkNotReady), findsOneWidget,
        reason: '★ 砍了却不说 = 主人不知道那两档去哪了（手册纪律 4）');

    // ③ 暗色那套 token **还在**（只是暂时没人能选到）：色板没被删
    expect(DshPalette.dark.bgLayer1, isNot(DshPalette.light.bgLayer1),
        reason: '★ 暗色 token 被删了 —— 以后要放出来就得重做一份');
  });

  testWidgets('🔴 盘上存着老值 `system` ⇒ 设置里**不在「跟随系统」上打勾**（窗口是亮的）', (tester) async {
    // 主人那台手机最可能的形状：老版本写过 `system|<字号>`（他改过字号就会写这一条）。
    // 现在 `system` **一律解成亮** ⇒ 设置里那一栏必须是「亮」被选中、
    // 「跟随系统」**不出现**（在它上面打勾 = 页面在说假话：窗口明明是亮的）。
    SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'system|15'});
    final (screen, _, _) = await _screen();
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();
    expect(_floaterBg(tester), DshPalette.light.bgLayer1,
        reason: '★ 存着 system 时窗口不是亮的');

    await _openSettings(tester);
    await _scrollTo(tester, settingsAppearanceLabel);
    expect(find.text(ChatAppearance.light.label), findsWidgets, reason: '★「亮」不在屏幕上');
    expect(find.text(ChatAppearance.system.label), findsNothing,
        reason: '★「跟随系统」又摆出来了（而且在它上面打了勾）—— 窗口明明是亮的');
    expect(find.text(ChatAppearance.dark.label), findsNothing);
    // ⚠️ 盘上那份偏好**没被他点过就不动**（这一条是"只改显示、不改他的盘"）
    expect((await AppearanceStore().read()).appearance, ChatAppearance.system);
    expect((await AppearanceStore().read()).fontSize, 15, reason: '★ 字号那一半被外观这一半带坏了');
  });

  testWidgets('🔴 设备是暗的 ⇒ 窗口**还是亮的**（"跟随系统"暂时一律亮）', (tester) async {
    // 这一条就是主人 2026-09-26 那张截图的回归网：暗色手机 + 默认档 ⇒ 以前是近黑底
    // （里面的气泡/通知条还是暖白纸那套 ⇒ 黑底压淡粉、字读不出来）。
    SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'system|14'});
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
    // 盘上真存着 `system`（老版本写的 / 他以前选过）—— 照收，但**暂时解成亮**
    expect((await AppearanceStore().read()).appearance, ChatAppearance.system);
    expect(_floaterBg(tester), DshPalette.light.bgLayer1,
        reason: '★ 暗色手机上又跟着系统变暗了 —— 那正是主人报的那一屏（暗色还没做完）');
  });

  testWidgets('🔴 改字号 ⇒ 聊天里那一行字的**渲染度量**真的变了', (tester) async {
    // 三档各来一次（12 / 14 / 17）—— 判据量的是**字号与高度**，不是"看起来像"。
    // 原来量的是**输入框那一段的字**（"它永远跟着那条轴走"）。🔴 2026-10-04 起
    // 底下那一格改成"语音优先"（手册 `D3.14`：不再有输入框）⇒ 现在守的是
    // **等价的那一件事**：同一档（`look.content`）的字住在**时间线的正文**上，
    // 量它的字号与渲染高度 —— 轴没传下去照样会红。
    final seen = <int, (double, double)>{};
    for (final n in <int>[12, 14, 17]) {
      SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'system|$n'});
      final c = ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());
      _feedToolRow(c);
      _feedAnswer(c);
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
      seen[n] = (_mainFontSize(tester), _mainHeight(tester));
    }
    // 12 / 14 / 17 的字号**逐档对得上**那条轴（不是"都在变"就算过）
    expect(seen[12]!.$1, 12);
    expect(seen[14]!.$1, 14);
    expect(seen[17]!.$1, 17);
    // 而且**渲染高度**也跟着长（字号轴真的传到了布局，不只是样式字段）
    expect(seen[17]!.$2, greaterThan(seen[14]!.$2));
    expect(seen[12]!.$2, lessThan(seen[14]!.$2));
  });

  testWidgets('★ 聊天那两块的字：主要 14/20 · 非主要 11/14（差 3 号、行高紧得多）', (tester) async {
    // 原来"主要"量的是**输入框那一段**。🔴 输入框没了（手册 `D3.14`）⇒
    // 主要那一档改量**时间线里的正文**（同一个 `look.content`）；非主要照旧量工具行。
    final (screen, _, _) = await _screen(tier: FloaterTier.full);
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();

    // ① **主要**：时间线里的正文 ⇒ 14 / 行高 20
    final mainStyle = tester.widget<Text>(find.text(_answerText)).style!;
    final mainSize = mainStyle.fontSize!;
    final mainLine = mainSize * mainStyle.height!;
    expect(mainSize, 14, reason: '★ 主要那一档的字号');
    expect(mainLine, closeTo(20, 0.01), reason: '★ 主要那一档的行高（绝对值）');

    // ② **非主要**：那一行工具名 ⇒ 11 / 行高 14
    //   ★ 2026-10-02：那一格是人话（`toolHumanName`），不再是内部名
    expect(find.text(toolHumanName('bash')!), findsOneWidget);
    final rowStyle = tester.widget<Text>(find.text(toolHumanName('bash')!)).style!;
    final rowSize = rowStyle.fontSize!;
    final rowLine = rowSize * rowStyle.height!;
    expect(rowSize, 11, reason: '★ 非主要那一档的字号（工具行）');
    expect(rowLine, closeTo(14, 0.01), reason: '★ 非主要那一档的行高');

    // ③ 🔴 主人要的那两件事：**非主要更小**，而且**行间距小很多**
    expect(rowSize, lessThan(mainSize), reason: '★ 非主要没有比主要小');
    expect(rowStyle.height!, lessThan(mainStyle.height!),
        reason: '★ 非主要的行高（倍数）没有更紧');
    expect(mainLine / mainSize, greaterThan(1.4));
    expect(rowLine / rowSize, lessThan(1.3), reason: '★ 行高比值没小下来');
  });

  testWidgets('🔴 非主要那一档有**地板**：他把字号调到最小（12）时它是 11，不是 9', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'system|12'});
    final c = ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());
    _feedToolRow(c);
    _feedAnswer(c);
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}),
      ),
    );
    await tester.pumpAndSettle();
    // 主要那一档照轴缩到 12（原来量的是输入框里那段字；输入框没了 ⇒ 量时间线里的正文）
    expect(_mainFontSize(tester), 12);
    // 而非主要**不再往下缩**（11）—— 9 号字在平板上是看不清的
    expect(_rowFontSize(tester), 11, reason: '★ 非主要那一档掉到 11 以下了');
  });

  testWidgets('🔴 在设置里按"大一点" ⇒ 聊天**当场**跟着变，而且**不重连**', (tester) async {
    // ⚠️ 原来量的是**输入条那个框**（收起档也在树上 ⇒ 设置开着时也量得到）。
    //    🔴 输入框没了（手册 `D3.14`）⇒ 现在守的是**等价的那一件事**：同一棵树里，
    //    按完退回聊天、量**时间线里的正文**（`look.content`）跟着那条轴走；
    //    而那条流自始至终**只建过一次**（改字号不是"重新连一次"）。
    final (screen, _, made) = await _screen(); // 收起档：桌面上那个图标点得到
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();
    expect(made.length, 1, reason: '起点：那条流只建过一次');

    // 起点那一档（14）—— 展开才量得到时间线里的正文
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(_mainFontSize(tester), 14, reason: '起点是默认档（14 = 聊天主要那一档 + Δ0）');

    // 按"大一点" ⇒ 屏幕上的正文**当场**大了一号（14 ⇒ 15）
    await _tapFontInSettings(tester, bigger: true);
    expect((await AppearanceStore().read()).fontSize, 15);
    expect(made.length, 1, reason: '★ 改外观/字号重开了连接 —— 那正是这一条要挡的');
    await _backToChat(tester);
    expect(_mainFontSize(tester), 15, reason: '★ 按了"大一点"而聊天里的字没变');

    // 负向对照：按"小一点"回去（不是单行道）
    await _tapFontInSettings(tester, bigger: false);
    expect((await AppearanceStore().read()).fontSize, 14);
    await _backToChat(tester);
    expect(_mainFontSize(tester), 14);
    expect(made.length, 1, reason: '★ 改字号重开了连接');
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
    expect(_floaterBg(tester), DshPalette.light.bgLayer1,
        reason: '★ 认不出的外观没有退回默认档');
    expect(_rowFontSize(tester), 11, reason: '★ 认不出的字号没有退回默认档（非主要那一档 = 11）');
  });
}
