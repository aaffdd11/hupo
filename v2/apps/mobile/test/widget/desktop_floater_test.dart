// 桌面（底部一条）+ 聊天浮窗（四边 30 + 阴影 + 三档）：**画出来了没有**。
//
// 契约 `docs/dev/52-DESKTOP.md` · 手册 `08-SPEC.md` §六（Z1–Z4 / 6.2 三档 / 6.3 手势 / 6.5 无障碍）。
//
// ⚠️ 这一份是 `test/widget`（**提示档**），但它钉的是"这一刀到底有没有画到屏幕上"。
//    真正当闸的两条在别处：
//      · **五档不溢出 + 命中区 ≥44** → `accessibility_test.dart`（硬闸，已经跑过这一屏）；
//      · **桌面/浮窗的边距与档位** → 就是这一份（下面每条都带负向对照）。
//
// ⚠️ **默认是收起**（主人 2026-09-22 定：一进来看得见桌面）。

import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/landing_words.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/hearing.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/app_desktop.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/voice_bar.dart';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

http.Response _json(String body) => http.Response(
  body,
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// **一台"开得了麦"的假设备**（VM 上真设备开不了麦，那一格里画的是「打字」退路 ——
/// 与 `voice_send_test.dart` 同一个钩子）。判据要量那颗圆圈时自己装一台。
class _Mic implements NativeHearingApi {
  int started = 0;

  @override
  bool get canHear => true;

  @override
  Future<String?> start({
    required Uri url,
    required String token,
    required void Function(Map<String, dynamic>) onEvent,
  }) async {
    started += 1;
    return null;
  }

  @override
  void stop() {}
}

/// 假服务端：`/api/hear` 说"听清了"，`/api/say` 记下那句（"发就拉满"那两条要用）。
class _Srv {
  final said = <String>[];
  late final ChatController c;
}

_Srv _voiceController() {
  final s = _Srv();
  final api = Api(
    client: MockClient((req) async {
      if (req.url.path.contains('/api/hear')) return _json('{"heard":"在吗"}');
      if (req.url.path.contains('/api/say')) {
        s.said.add(req.body);
        return _json('{"ok":true}');
      }
      if (req.url.path.contains('/api/apps')) return _json('{"apps":[]}');
      return _json('{}');
    }),
  );
  s.c = ChatController(api: api, tokens: TokenStore(), token: 'tok');
  return s;
}

/// **走那条打字退路**（开不了麦时才有的那一格）：按「打字」→ 往那一格里打字。
/// ⚠️ 没有它，这一档里 `find.byType(TextField)` 是**一个都找不到**的 ——
/// 原来的输入框（`Composer`）已经被"语音优先"那一格换掉了（2026-10-05）。
Future<void> _typeInstead(WidgetTester tester, String text) async {
  await tester.tap(find.byKey(voiceBarTypeChipKey));
  await tester.pump();
  expect(find.byKey(voiceBarTypeKey), findsOneWidget, reason: '★ 那颗「打字」没把输入格摊开');
  await tester.enterText(find.byKey(voiceBarTypeKey), text);
  await tester.pump();
}

Future<void> _pump(WidgetTester tester, {FloaterTier tier = FloaterTier.collapsed}) async {
  await tester.pumpWidget(
    MaterialApp(home: ChatScreen(initialTier: tier, controller: _controller(), onLoggedOut: () {})),
  );
  await tester.pump();
}

/// 浮窗那一块（`ChatFloater` 自己的矩形）。
Rect _floaterRect(WidgetTester tester) => tester.getRect(find.byType(ChatFloater));

void main() {
  // 默认这一台"开不了麦"（VM 上就是真的）；要量那颗圆圈的判据自己装一台假的。
  setUp(clearNativeHearing);
  tearDown(clearNativeHearing);

  testWidgets('🔴 一进来是**收起**那一档：看得见桌面，**说话那一格也在**，但时间线不画', (tester) async {
    // ⚠️ 原来这里断言的是"输入框（`Composer`）也在"。🔴 2026-10-05 主人把那一格换成
    //    了"语音优先"（`voice_bar.dart`）⇒ 等价的那件事是：收起态也画着**那颗圆圈**
    //    （点一下就能开麦说话，`D3.14`）。
    nativeHearingApi = _Mic();
    await _pump(tester);
    // 桌面在（整页底图）
    expect(find.byType(AppDesktop), findsOneWidget);
    // 🔴 **桌面上不该有「会话」**（主人 2026-09-22）：*"聊天和桌面是独立的，聊天是永续的，
    //    永远在底下。所以聊天不是桌面上的一个小程序。"* ⇒ 聊天没有桌面图标。
    expect(find.text('会话'), findsNothing, reason: '聊天不是桌面上的小程序 ⇒ 它不该有图标');
    expect(find.byIcon(Icons.chat_bubble_outline), findsNothing, reason: '同上');
    // ★ **收起态的展开入口**：主人 2026-09-24 改形状了 ——
    //   *"展开用一条杠，杠上面有一个小箭头，箭头比较平…放在上边框的正中央"*
    //   ⇒ 它**不再有可见的字**（D3.8 那条同日改掉），字挂在 tooltip 上；
    //     但**命中区仍然 ≥44**、而且它就在上边框正中央（下面的判据量的就是这两条）。
    expect(find.byKey(chatHandleKey), findsOneWidget, reason: '收起态该有那个抓手');
    expect(find.byTooltip('展开'), findsOneWidget, reason: '收起态抓手要说得出"展开"');
    // ★ **收起态也有那一格**（主人 2026-09-22：*"助手那个聊天窗口，收缩的时候也有一个输入框。"*）
    expect(find.byKey(voiceBarCircleKey), findsOneWidget, reason: '★ 收起时也该能直接说话（那颗圆圈）');
    // 但**展开态才有的东西一个都不许在**（判档位要看这些，不是看输入条）
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '收起态不该有「收起」');
    expect(find.byKey(chatBodyKey), findsNothing, reason: '收起态不画状态条 + 时间线那一块');
  });

  testWidgets('🔴 四边边距都是 30（Z3/Z4），桌面在浮窗**下面**', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    final screen = tester.getRect(find.byType(MaterialApp));
    final f = _floaterRect(tester);
    final desk = tester.getRect(find.byType(AppDesktop));
    const m = FloaterMetrics.margin;

    expect(f.left - screen.left, m, reason: '左边距');
    expect(screen.right - f.right, m, reason: '右边距');
    expect(f.top - screen.top, m, reason: '上边距');
    // ⚠️ 主人更正过的那一处：**浮窗贴屏幕底**（不是"底面那条桌子的上面"）
    expect(screen.bottom - f.bottom, m, reason: '下边距 = 浮窗底到屏幕底');
    // ⚠️ 桌面是**整页底图**（铺满整屏），不是底部一条
    expect(desk.top, screen.top, reason: '桌面从屏幕顶开始');
    expect(desk.bottom, screen.bottom, reason: '桌面铺到屏幕底');
    expect(desk.left, screen.left);
    expect(desk.right, screen.right);

    // 负向对照：浮窗**不是铺满**（Z3：盖住不是铺满）
    expect(f.width < screen.width, true);
    expect(f.height < screen.height, true);
  });

  // ── ★ 2026-09-29：底部那条 bar（主人："一个半透明的bar，左 home、中输入、右语音；
  //    这些按钮就不是透明的了"）────────────────────────────────────────

  /// 浮窗自己那块 `Material`（深度优先里它排在最前面 —— 与 `appearance_test.dart` 同一条）。
  Material barMaterial(WidgetTester tester) => tester.widget<Material>(
    find.descendant(of: find.byType(ChatFloater), matching: find.byType(Material)).first,
  );

  testWidgets('🔴 模糊那一层**两档形状一样**（都不糊）：收起⇄展开不重建那一棵', (tester) async {
    // ⚠️ 这一条原来量的是"收起那条 bar 是**磨砂玻璃**"（模糊半径 = `barBlurSigma`）。
    //    🔴 2026-10-04 主人：*"语音按钮下面的平台不需要了……不需要底下那个框了。"*
    //    ⇒ 收起档那个框（底 / 圆角 / 磨砂）整条撤了，展开档本来就不糊。
    //    这一条现在守的是**原来那个负向对照要守的事**：`BackdropFilter` 这个**形状
    //    两档都在**（收起⇄展开时子树类型不变 ⇒ 那一格不会被重建、状态不会丢）。
    await _pump(tester);
    final blur = tester.widget<BackdropFilter>(
      find.descendant(of: find.byType(ChatFloater), matching: find.byType(BackdropFilter)).first,
    );
    expect(
      blur.filter.toString(),
      ImageFilter.blur(sigmaX: 0, sigmaY: 0).toString(),
      reason: '★ 收起档又糊上了 —— 那个框 2026-10-04 已经撤了（白算一层）',
    );
    // 负向对照：不许把磨砂玻璃（`barBlurSigma`）又加回来
    expect(
      blur.filter.toString(),
      isNot(ImageFilter.blur(sigmaX: d.barBlurSigma, sigmaY: d.barBlurSigma).toString()),
      reason: '★ 磨砂玻璃又回来了 —— 主人明确说"不需要底下那个框了"',
    );

    // 展开档：**同一个形状**、同样不糊
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
    await _pump(tester, tier: FloaterTier.full);
    final blur2 = tester.widget<BackdropFilter>(
      find.descendant(of: find.byType(ChatFloater), matching: find.byType(BackdropFilter)).first,
    );
    expect(
      blur2.filter.toString(),
      ImageFilter.blur(sigmaX: 0, sigmaY: 0).toString(),
      reason: '★ 展开档在糊时间线（白算，而且没意义）',
    );
  });

  testWidgets('🔴 收起那条 bar **完全透明**（那个框撤了）；展开档**必须不透明**（时间线要读字）', (tester) async {
    // ⚠️ 原来收起档量的是"半透明（`barVeilAlpha`）"。🔴 2026-10-04 那个框撤了 ⇒
    //    收起档那一条**一个底都不画**（桌面直接透过来）；"按钮不是透明的"那件事
    //    改由**每颗按钮自己那层实底**保证（下一条守着）。
    await _pump(tester);
    final collapsed = barMaterial(tester).color!;
    expect(collapsed.a, 0.0, reason: '★ 收起那条 bar 又自己画上底了（2026-10-04 那个框已经撤了）');
    expect(collapsed.a, lessThan(1.0), reason: '★ 收起那条 bar 是实底 —— 桌面透不过来');

    // ⚠️ **先把上一棵树拆掉**：同类型的 `ChatScreen` 再泵一次会**复用同一个 State**
    //    ⇒ `initialTier` 不再生效（这一条判据第一版就是这么假绿/假红的）。
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
    await _pump(tester, tier: FloaterTier.full);
    final full = barMaterial(tester).color!;
    expect(full.a, 1.0, reason: '★ 展开档透了 —— 时间线的字会压在壁纸上，读不出来');
  });

  testWidgets('🔴 bar 自己透明，可上面那几颗**各自是不透明的**：录音圆圈 ＋ 右边那一列', (tester) async {
    // ⚠️ 原来这一条量的是"home 圆片 / 输入框 / 话筒各自实底"。今天：
    //    · home 2026-10-04 取消了（`D3.15`：出口搬到每个 app 右上角）；
    //    · 输入框随整个 `Composer` 一起被"语音优先"那一格换掉（2026-10-05）。
    //    ⇒ 现在这一行上只剩**那颗录音圆圈**与**它右边那一列两颗**（`chat_floater.dart`）。
    nativeHearingApi = _Mic();
    await _pump(tester);

    // ① **录音圆圈**：**内部透明** ＋ 一圈实色琥珀（`voice_bar.dart` 的 `_circle`）
    //    ⚠️ 2026-10-06 主人把"白底"改成 *"不是边框透明，是按钮内部底色透明"*
    //      ⇒ 底色那一格从 `d.card` 改成**透明的**；⚠️ 于是"实底"这条口径**跟着改**：
    //      **界线靠那一圈实色轮廓 ＋ 图形与那一圈同色**（下面钉着）。
    final circleFace = tester.widget<Material>(
      find
          .descendant(of: find.byKey(voiceBarCircleKey), matching: find.byType(Material))
          .first,
    );
    // ⚠️ **2026-10-06 定案**（主人：*"不是边框透明，是按钮内部底色透明"*）：
    //   **内部透明**（`color!.a == 0`）＋ **一圈实色的琥珀**（界线全靠它）
    //   ＋ 图形与那一圈同色（墨色压在深色壁纸上会看不见）。
    expect(circleFace.shape, isA<CircleBorder>(), reason: '★ 录音那颗不是圆的');
    expect((circleFace.shape! as CircleBorder).side.color, d.accent, reason: '★ 那一圈不是琥珀色');
    expect(tester.getSize(find.byKey(voiceBarCircleKey)), const Size(d.voiceCircleBox, d.voiceCircleBox));

    // ② **右边那一列**：看得见的那块长方形也是实底 ＋ 一圈轮廓（`_auxFace`）
    final face = tester.widget<Container>(
      find.descendant(of: find.byKey(chatHandleKey), matching: find.byType(Container)).first,
    );
    final dec = face.decoration! as BoxDecoration;
    expect(dec.color!.a, 0.0, reason: '★ 那一列的面还有底色 —— 主人要的是"内部透明"');
    // 界线靠**实色轮廓**：底色可以透，那一圈不许透（不然压在壁纸上就看不见按钮在哪）
    expect(dec.border!.top.color.a, 1.0, reason: '★ 那一圈轮廓是半透明的 ⇒ 界线会跟着壁纸糊掉');
    expect(dec.border, isNotNull, reason: '★ 那一列的面没有轮廓');

    // ③ 负向对照：**bar 自己是透明的** ⇒ "按钮不透明"这件事只能靠每颗自己那层底
    expect(barMaterial(tester).color!.a, 0.0, reason: '★ bar 自己画上了底 —— 那上面这条就白量了');
  });

  testWidgets('🔴 那颗圆圈在**说话那一格的最右**（不在任何打字框里面）', (tester) async {
    // ⚠️ 原来这一条是"话筒在输入框右边、不在框里面"（网页的输入法 DOM 会盖住整个
    //    `TextField` 的矩形 ⇒ 按钮必须住在它外面）。今天那一格里**根本没有输入框**：
    //    它就是"左边一句字 ＋ 右边那颗圆圈"（`voice_bar.dart`）⇒ 等价的那件事是
    //    **圆圈贴着那一格的右内沿**（在字那一侧的右边）。
    nativeHearingApi = _Mic();
    await _pump(tester);
    final mic = find.byKey(voiceBarCircleKey);
    // 负向对照：开得了麦时那一格里一个打字框都不该有（有的话它就又被圈进那块矩形了）
    expect(find.byType(TextField), findsNothing, reason: '★ 那一格里又长出一个打字框');
    // 而且它在那一格的**右半边**（拿屏幕坐标量，不猜结构）
    final micRect = tester.getRect(mic);
    final barRect = tester.getRect(find.byType(VoiceBar));
    expect(
      micRect.right,
      closeTo(barRect.right - d.gapM, 1),
      reason: '★ 圆圈不在那一格的右内沿：mic=$micRect bar=$barRect',
    );
    expect(micRect.left, greaterThan(barRect.center.dx), reason: '★ 圆圈不在右半边');
  });

  testWidgets('🔴 浮窗有阴影（不是靠描边假装浮着）', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    // ⚠️ **只扫浮窗里面那一棵**（2026-09-22 栽过）：桌面图标也有阴影了，
    //    全树扫会先扫到**图标**那个（blur 12）⇒ 判据当场红，而浮窗其实没问题。
    //    ⇒ 这就是"判据要钉在**这件事独有**的东西上"的第三次。
    final shadows = <BoxShadow>[];
    for (final e in find
        .descendant(of: find.byType(ChatFloater), matching: find.byType(DecoratedBox))
        .evaluate()) {
      final dec = (e.widget as DecoratedBox).decoration;
      if (dec is BoxDecoration) shadows.addAll(dec.boxShadow ?? const []);
    }
    expect(shadows.isNotEmpty, true, reason: '浮窗必须有阴影（手册阈值总表：blur 32 · α.45 · offset(0,-6)）');
    final s = shadows.first;
    expect(s.blurRadius, 32);
    expect(s.offset.dy, -6);
    // 🔴 2026-09-29 主人：*"……我想用白色透明，不用黑色透明。"*
    //    ⇒ 影的颜色是**白**（`floaterShadowColor`），**不是**墨色那个黑。
    expect(s.color.a > 0, true);
    expect(s.color, d.floaterShadowColor);
    expect(s.color.r, closeTo(1.0, 0.001), reason: '★ 阴影不是白的（还是黑的那一支）');
    expect(s.color.g, closeTo(1.0, 0.001));
    expect(s.color.b, closeTo(1.0, 0.001));
    // 负向对照：**不许**再用 ink 当影色（那是改前那一版）
    expect(s.color.r, isNot(closeTo(d.ink.r, 0.01)),
        reason: '★ 又用回"墨色黑影"了 —— 主人明确说不要黑');
  });

  testWidgets('🔴 收起态按那颗圆圈 ⇒ **真去开麦**（不是"点一下窗口就打开"）', (tester) async {
    // ⚠️ 原来这一条是"点收起态那个「说点什么」⇒ 窗口自动打开（而且字不丢）"。
    //    🔴 那个输入框已经被"语音优先"那一格换掉了（2026-10-05）：收起态那一格里
    //    **没有"点一下就展开"的入口** —— 按那颗圆圈 = **开麦**（`D3.14`）。
    //    窗口自己打开只发生在**一句话说完、真发出去之后**（判据在 `voice_send_test.dart`）。
    final mic = _Mic();
    nativeHearingApi = mic;
    // ⚠️ 开麦要**手里有令牌**（`hearOnce` 没令牌直接回 `failed`，连设备都不碰）
    final s = _voiceController();
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(controller: s.c, onLoggedOut: () {})),
    );
    await tester.pump();
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '一开始是收起的');

    await tester.tap(find.byKey(voiceBarCircleKey));
    await tester.pump();
    await tester.pump();

    expect(mic.started, 1, reason: '★ 按了那颗圆圈却没去开麦');
    expect(find.byIcon(Icons.stop_rounded), findsOneWidget, reason: '★ 在录的时候该是那颗"停"');
    // 负向对照：按圆圈**不是**展开的入口（窗口还在收起档）
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '★ 按圆圈把窗口也打开了 —— 那一颗只负责开麦');
    expect(find.byKey(chatBodyKey), findsNothing, reason: '收起档不许画状态条 + 时间线那一块');
  });

  testWidgets('🔴 那条**打字退路**：打了一半，点「展开」⇒ 字不丢（那一格是同一个实例）', (tester) async {
    // ⚠️ 这条原来钉的是**实现上的一个关键选择**：输入条从 `_sheetBody` 里**拆出来单独传给浮窗**，
    //    上下两态共用**同一个** `Composer`。要是两处各建一个，"打了一半再展开"会换一个 `State`，
    //    **框里的字就没了**（那是最气人的那种丢字）。
    //    🔴 那个输入框已经被"语音优先"那一格换掉了（2026-10-05）⇒ 等价的那件事是：
    //    **开不了麦时那条打字退路**（`voice_bar.dart` 的 `_typedField`）里打了一半的字，
    //    点「展开」之后**还在框里**（同一格、同一个 State）。
    await _pump(tester);
    await _typeInstead(tester, '半句话');
    expect(
      tester.widget<TextField>(find.byKey(voiceBarTypeKey)).controller!.text,
      '半句话',
      reason: '前提：字该先打在框里',
    );

    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();

    expect(find.byKey(voiceBarTypeKey), findsOneWidget,
        reason: '★ 展开之后那条打字退路没了（那一格被重建了）');
    expect(
      tester.widget<TextField>(find.byKey(voiceBarTypeKey)).controller!.text,
      '半句话',
      reason: '★ 展开不该把你打了一半的字弄丢',
    );
  });

  testWidgets('🔴 收起态那条**打字退路真能发**：发出去就拉满（§6.2"发就拉满"）', (tester) async {
    // ⚠️ 原来这一条走的是"收起态也有输入框，打完按发送"。🔴 那个输入框已经被
    //    "语音优先"那一格换掉了（2026-10-05）⇒ 等价的那条路是**开不了麦时那颗「打字」
    //    的退路**（`voice_bar.dart`）；而"发就拉满"这件事一个字没变（`maximize()`）。
    final s = _voiceController();
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(controller: s.c, onLoggedOut: () {})),
    );
    await tester.pump();
    final before = _floaterRect(tester).height; // 收起态
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '一开始是收起的');

    await _typeInstead(tester, '在吗');
    await tester.tap(find.byKey(voiceBarTypedSendKey));
    await tester.pumpAndSettle();

    expect(s.said.length, 1, reason: '★ 那条退路没把这一句交出去');
    expect(_floaterRect(tester).height > before, true,
        reason: '★ 从收起态发出去 ⇒ 该拉满（$before → ${_floaterRect(tester).height}）');
    expect(find.byTooltip(chatCollapse), findsWidgets, reason: '拉满之后该有「收起」');
  });

  testWidgets('🔴 点「展开」⇒ 真的开（时间线那一块出来、多出「收起」）', (tester) async {
    await _pump(tester);
    expect(find.byTooltip(chatCollapse), findsNothing);
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byTooltip(chatCollapse), findsWidgets, reason: '开了之后该有「收起」');
    expect(find.byKey(chatBodyKey), findsOneWidget, reason: '开了之后状态条 + 时间线该在');
    // ★ **2026-10-05 主人改了这一处**：*"把它变成展开以后是变成缩小窗口的按钮啊，
    //   所以它位置就不变"* ⇒ 展开态那一颗**还在原处**（不再留空），只是朝下、点它收起。
    expect(find.byKey(chatHandleKey), findsOneWidget,
        reason: '★ 展开态那一颗该"翻成收起"（位置不许动）');
    // 而它带来的代价要如实钉住：**滑动改高度**在展开态改绑在**标题行**上（§6.3）
    expect(find.byTooltip(chatCollapse), findsWidgets);
  });

  testWidgets('🔴 点桌面空白 ⇒ 收起；点浮窗**内部** ⇒ 无反应（负向对照）', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    final before = _floaterRect(tester).height;

    // ① 点浮窗内部（标题那一行）⇒ **不许**收起（§6.3：点浮窗内部无反应）
    //    ⚠️ 2026-09-24 改：原来是点"最上面 12px"，而现在那一块**就是抓手**
    //      （主人要它在上边框正中央）⇒ 再点那儿等于点抓手，判据会红得毫无意义。
    //      改成点标题那几个字（那儿没有按钮，也在浮窗内部）。
    await tester.tap(find.text(appName));
    await tester.pumpAndSettle();
    expect(_floaterRect(tester).height, before, reason: '点浮窗内部不该动它（更不该漏到桌面）');
    expect(find.byTooltip(chatCollapse), findsWidgets, reason: '还是展开着');

    // ② 点桌面空白 ⇒ 收起。
    //    ⚠️ **得点浮窗盖不到的地方**：桌面现在是整页底图，浮窗贴底盖住了中间那一大块，
    //       所以"空白"是左边那条**留白带子**（这也正是 Z3 要留出边距的理由之一）。
    //    🔴 **那一点要从常量算，不能写死 10**（2026-09-28 修）：主人把留白从 30 改成 10
    //       之后，`left + 10` 正好落在浮窗**自己的左边缘上** ⇒ 这一条会红得莫名其妙
    //       （它量的其实是"浮窗边距有多宽"，不是"点空白收不收得起"）。
    //       ⇒ 取那条带子的**中间**：留白怎么变都还是空白。
    final screen = tester.getRect(find.byType(MaterialApp));
    await tester.tapAt(Offset(screen.left + FloaterMetrics.margin / 2, screen.center.dy));
    await tester.pumpAndSettle();
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '点桌面空白该收起');
  });

  testWidgets('🔴 负向对照：点**浮窗左边那条桌面**不会误伤浮窗自己的按钮', (tester) async {
    // 上一条证明了"点桌面能收起"；这一条反向确认"边距那条带子确实不属于浮窗"，
    // 免得哪天有人把浮窗的 `left/right` 写成 0（那样桌面就点不到了，而上面那条会红）
    await _pump(tester, tier: FloaterTier.full);
    final f = _floaterRect(tester);
    expect(f.left, FloaterMetrics.margin, reason: '浮窗左边必须留出桌面那条带子');
  });

  testWidgets('🔴 展开档按发送 ⇒ 已经**全开就不动**（两档之间没有中间态）', (tester) async {
    // ⚠️ 原来这一条是"在输入条上按发送 ⇒ 最大化"。🔴 今天只有**两档**（收起 / 完全展开）：
    //    "拉满"只发生在**从收起态发出去**那一下（上一条守着）；展开档本来就是全开。
    //    ⇒ 这一条守反向的那件事：发出去这一下**不许**把窗口改成别的形状（不许又长出第三档）。
    final s = _voiceController();
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(initialTier: FloaterTier.full, controller: s.c, onLoggedOut: () {}),
      ),
    );
    await tester.pump();
    final open = _floaterRect(tester).height;
    await _typeInstead(tester, '在吗');
    await tester.tap(find.byKey(voiceBarTypedSendKey));
    await tester.pumpAndSettle();
    expect(s.said.length, 1, reason: '★ 展开档里那句没发出去');
    expect(_floaterRect(tester).height, open,
        reason: '★ 发送把已经全开的窗口又改了（$open → ${_floaterRect(tester).height}）');
  });

  testWidgets('🔴 拖**时间线**仍然滚动（手势只绑抓手行，不吃列表滚动）', (tester) async {
    // ⚠️ 这条是回归判据：第一版把拖拽手势挂在整块浮窗上 ⇒ 拖时间线被当成"改窗口高度"，
    //    而当时只有"重发"那条判据红了。这里把它钉住。
    //
    // ⚠️ 得先**喂几条话**：空屏画的是 `_EmptyState`，**根本没有 `ListView`** ——
    //    拿不到列表就量不了"拖它会不会改窗口高度"（第一版这条判据就是这么空转的）。
    final c = _controller();
    var seq = 1;
    for (var i = 1; i <= 6; i += 1) {
      c.ingest({'type': 'user/echo', 'seq': seq++, 'messageId': 'u$i', 'text': '第 $i 句'});
      c.ingest({'type': 'message/start', 'messageId': 'm$i', 'seq': seq++});
      c.ingest({'type': 'message/text', 'messageId': 'm$i', 'block': 'quick', 'text': '第 $i 答', 'seq': seq++});
      c.ingest({'type': 'message/end', 'messageId': 'm$i', 'seq': seq++, 'reason': 'completed'});
    }
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})),
    );
    await tester.pump();
    expect(find.byType(ListView), findsOneWidget, reason: '喂了话之后时间线该在');
    final before = _floaterRect(tester).height;
    await tester.drag(find.byType(ListView), const Offset(0, -120));
    await tester.pumpAndSettle();
    expect(_floaterRect(tester).height, before, reason: '拖时间线不该改浮窗高度');
  });

  testWidgets('🔴 桌面**铺满整屏**（是底图，不是"内容那么宽"的一块）', (tester) async {
    // ⚠️ 2026-09-22 实测抓到过的形状：桌面被缩成 **100px 宽、居中**
    //    （截图上看不出来：它底色跟页面一样）—— 那时它还是"底部一条"。
    //    现在形状改成"桌面=整页底图"，这条判据钉的就是**四边都贴屏幕**。
    await _pump(tester);
    final desk = tester.getRect(find.byType(AppDesktop));
    final screen = tester.getRect(find.byType(MaterialApp));
    expect(desk.left, screen.left, reason: '桌面左边该贴屏幕左');
    expect(desk.right, screen.right, reason: '桌面右边该贴屏幕右');
    expect(desk.top, screen.top, reason: '桌面该从屏幕顶开始');
    expect(desk.bottom, screen.bottom, reason: '桌面该铺到屏幕底');
    expect(desk.size, screen.size, reason: '桌面该铺满整屏（实测过它只有 ${desk.size}）');
  });

  testWidgets('🔴 抓手：命中区 ≥44 ＋ 在**右半边**（录音圆圈右边），而且**两档位置一样**', (tester) async {
    // ⚠️ 2026-10-05 主人：*"语音按钮的右侧，需要两个按钮。一个是展开聊天，一个是播放语音。……
    //    他们都要有一个长方形的按钮轮廓。"* ⇒ 那颗抓手的**位置**是产品定死的：
    //    它在**下面那一行**、在**录音圆圈的右边**（右半边），而且**两档里一个像素都不动**
    //    （他当场报过"打开聊天历史窗口后语音按键位置改变了"）。
    await _pump(tester);
    // 图形本身小（22×6 的箭头），但**它那个按钮**要够大（D3.6）
    final btn = tester.getRect(find.byKey(chatHandleKey));
    expect(btn.height >= 44, true, reason: '抓手命中区只有 ${btn.height}');
    expect(btn.width >= 44, true, reason: '抓手命中区只有 ${btn.width}');
    final f = _floaterRect(tester);
    expect(btn.center.dx > f.center.dx, true,
        reason: '抓手该在右半边（差 ${btn.center.dx - f.center.dx}）—— 主人要的是"语音按钮的右侧"');
    final inCollapsed = Offset(f.right - btn.right, f.bottom - btn.bottom);

    // 🔴 **两档位置一样**（那一行两个档同一个形状 —— `chat_floater.dart` 的 `_bottomRow`）
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
    await _pump(tester, tier: FloaterTier.full);
    final btn2 = tester.getRect(find.byKey(chatHandleKey));
    final f2 = _floaterRect(tester);
    expect(btn2.center.dx > f2.center.dx, true, reason: '★ 展开档那颗跑到左半边去了');
    expect(f2.right - btn2.right, closeTo(inCollapsed.dx, 1),
        reason: '★ 展开那一下抓手横向跳了（${inCollapsed.dx} → ${f2.right - btn2.right}）');
    expect(f2.bottom - btn2.bottom, closeTo(inCollapsed.dy, 1),
        reason: '★ 展开那一下抓手纵向跳了（${inCollapsed.dy} → ${f2.bottom - btn2.bottom}）');
    // 负向对照：**顶上那一行早就撤掉了**（展开档里它在**底部那一行**，不在标题行）
    expect(btn2.top > f2.center.dy, true,
        reason: '★ 抓手贴着浮窗上沿（差 ${btn2.top - f2.top}）—— 顶上那一行撤掉了，它在底部那一行');
  });

  testWidgets('🔴 收起态那颗抓手 ⇒ 展开；展开态标题行那颗「收起」⇒ 收起（各有一颗看得见的东西负责）', (tester) async {
    // ⚠️ 原来是"双击 = 收起 ⇄ 展开"；2026-09-24 改成"单击抓手"。
    //    ★ 2026-09-29 主人：*"展开后右上角有个收起按钮。"* ⇒
    //      **收起态**：点那颗平箭头（抓手）= 展开；
    //      **展开态**：点标题行右端那颗「收起」= 收起。
    //    ⚠️ 原来这里还断言"展开态也有输入框（`Composer`）"。🔴 那个输入框已经被
    //    "语音优先"那一格换掉了（2026-10-05）⇒ 等价的那件事是"展开态也画着那一格"
    //    （`VoiceBar`：那颗圆圈 ＋ 它左边那句字）。
    await _pump(tester, tier: FloaterTier.full);
    expect(find.byType(VoiceBar), findsOneWidget, reason: '★ 展开态也该有说话那一格');
    // ⚠️ 展开态里 `chatCollapse` 有**两颗**（标题行那颗 ＋ 录音旁边那颗翻过来的）
    //    ⇒ 点哪一颗都得指名道姓（`tester.tap` 只认唯一一个）。
    await tester.tap(find.byKey(chatCollapseKey));
    await tester.pumpAndSettle();
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '点「收起」该收起');
    // 收起之后：平箭头回来了（它就是"再展开"的入口）
    expect(find.byKey(chatHandleKey), findsOneWidget, reason: '收起态该有那颗平箭头');
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byTooltip(chatCollapse), findsWidgets, reason: '点平箭头该再展开');
  });

  // ── ★ 2026-09-29：**展开态不再单独占一行**（主人："展开对话那一小排的占地空间太大。
  //    我不要那根杠了。" ＋ "展开后右上角有个收起按钮。"）────────────────────

  testWidgets('🔴 展开态**不再单独占一行**（同一颗按钮翻成收起）；收起态**只剩箭头**', (tester) async {
    await _pump(tester, tier: FloaterTier.full);
    expect(find.byKey(chatHandleKey), findsOneWidget,
        reason: '★ 展开态那颗该在（翻成收起），不是消失');

    // 省下来的空间**要能量得出来**：标题行上沿离浮窗上沿只有那一点点内边距
    final floater = _floaterRect(tester);
    final title = tester.getRect(find.text(appName));
    // ⚠️ 2026-10-03：这一条原来卡 `< 12`，而右侧那颗改成**带字的按钮**之后
    //    标题行高了约 2px（读数正好 12.0）⇒ 口径改成"**没有多出一整行**"：
    //    真有那一行抓手的话，差值是 40 上下（那一行 44 高）。
    expect(title.top - floater.top, lessThan(30),
        reason: '★ 标题行上面还压着一块（差 ${title.top - floater.top}）—— 那一行没真的省掉');

    // 收起态：抓手在，而且里面**不是那根 44×4 的杠**（而是那块有底的小长方形）
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
    await _pump(tester);
    expect(find.byKey(chatHandleKey), findsOneWidget, reason: '收起态留着那颗平箭头（展开入口）');
    // ⚠️ 2026-10-05：那颗按钮里现在有一块**有底色的长方形**（主人要的"底色/轮廓"）——
    //    所以"子树里一个方块都没有"这条断言过期了；改成"那不是那根 4 像素的杠"。
    final face = tester.getSize(
      find.descendant(of: find.byKey(chatHandleKey), matching: find.byType(Container)).first,
    );
    expect(face.height, greaterThan(10),
        reason: '★ 那根 44×4 的杠又回来了（量到 $face）—— 主人：*"我不要那根杠了。"*');
    // 负向对照：那颗箭头**还在**（不是把整个抓手都删了）
    expect(
      find.descendant(of: find.byKey(chatHandleKey), matching: find.byType(CustomPaint)),
      findsWidgets,
    );
  });

  testWidgets('🔴 展开态：拖**标题行**也**不改高度**了（主人 2026-10-05 定的）', (tester) async {
    // 主人原话：*"展开聊天我希望不要有移动聊天窗口高度的选项，就是完全展开或者完全收起。"*
    //   ⇒ §6.3 那条"竖向拖 = 改高度"**整条砍掉**（两档之间没有中间态）。
    await _pump(tester, tier: FloaterTier.full);
    final before = _floaterRect(tester).height;
    await tester.drag(find.text(appName), const Offset(0, -200));
    await tester.pumpAndSettle();
    expect(_floaterRect(tester).height, before,
        reason: '★ 拖了还会变高（$before → ${_floaterRect(tester).height}）—— 主人要的是"只有全开/全收"');
  });

  testWidgets('🔴 拖那颗展开箭头**不改高度**，点它 = **一次拉满**（两档之间没有中间态）', (tester) async {
    await _pump(tester, tier: FloaterTier.collapsed);
    final collapsed = _floaterRect(tester).height;
    // ① 拖：**什么都不该发生**（负向对照：它不再是"改高度"的手势）
    await tester.drag(find.byKey(chatHandleKey), const Offset(0, -260));
    await tester.pumpAndSettle();
    expect(_floaterRect(tester).height, collapsed,
        reason: '★ 拖那颗箭头还会改高度（$collapsed → ${_floaterRect(tester).height}）');
    // ② 点：**一次到全开**（不是半开）
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    final screen = tester.getRect(find.byType(MaterialApp));
    final open = _floaterRect(tester);
    expect(open.height > collapsed, true, reason: '★ 点它没展开');
    // "全开"＝贴着上下那两条边距（不是"可用高度的百分之多少"）
    expect(open.top, closeTo(screen.top + FloaterMetrics.margin, 1),
        reason: '★ 展开后上边距不是"完全展开"那一档（top=${open.top}）');
    expect(find.byTooltip(chatCollapse), findsWidgets, reason: '展开之后该有「收起」');
  });
}
