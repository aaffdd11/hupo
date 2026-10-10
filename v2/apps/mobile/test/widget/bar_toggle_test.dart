// 🔴 **最左那颗窄按钮：把底下这一条收起来 ⇄ 放回来**（主人 2026-10-10）。
//
// 主人原话：*"帮我在左下角的两个按钮左边，放一个高度等于语音按钮高度，宽度非常窄的按钮，
//   icon是一个向左的箭头，用来展开和隐藏底下的聊天工具栏。隐藏时应左移，左移后，
//   出现一个按钮，贴着边显示，是一个向右的箭头。"*
//
// 这一份钉六件（每件都带反例）：
//   ① 🔴 它**在「清单」左边**、高 = 那颗圆圈的直径、**看得见那块只有 20 宽**
//      （"非常窄"）、而**手势那一格仍是 44×64**（D3.6 硬闸量的是布局盒子）；
//      两个档都在、位置一样；
//   ② 🔴 点一下 ⇒ **底下那一整行整条移出屏幕左边**（不是"变透明"：矩形真的在左边外面），
//      而**它自己留在原地**、并且**浮窗贴到了屏幕左边缘**（主人："贴着边显示"）；
//   ③ 🔴 再点一下 ⇒ 回来（位置一个像素不差）；箭头 左 ⇄ 右 翻面；
//   ④ 🔴 **字不丢**：收起来之前打的那半句，放回来还在（那一行只是被移走，不是拆掉）；
//   ⑤ 🔴 **展开着的时候按它 = 把聊天整个收起来**（"只剩时间线、没有输入条"那种窗口
//      不该存在）；顺带把「清单」那张浮窗也收掉；
//   ⑥ 🔴 收起来之后，屏幕底下那条**看不见的地带不吃点击**（不然就是"看不见却挡着"）。


import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/hearing.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/voice_bar.dart';
import 'package:hupo_app/widgets/work_list_panel.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(String body, [int status = 200]) => http.Response(
  body,
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

ChatController _controller() => ChatController(
  api: Api(
    client: MockClient((req) async {
      if (req.url.path.contains('/api/apps')) return _json('{"apps":[]}');
      return _json('{}');
    }),
  ),
  tokens: TokenStore(),
  token: 'tok',
);

/// 判据要量**那颗圆圈**（那颗窄按钮"高 = 圆圈的高"）⇒ 给它装一台假麦克风
/// （`canHear = true`；不装的话 VM 上那份是桩、那颗圆圈根本不画）——
/// 与 `desktop_floater_test.dart` 用的是**同一个钩子**。
class _Mic implements NativeHearingApi {
  @override
  bool get canHear => true;

  @override
  Future<String?> start({
    required Uri url,
    required String token,
    required void Function(Map<String, dynamic>) onEvent,
  }) async => null;

  @override
  void stop() {}

  @override
  Future<void> warm({required Uri url, required String token}) async {}
}

/// **走真入口**（与 `keyboard_button_test.dart` 同一条路）。
Future<void> _pump(
  WidgetTester tester,
  ChatController c, {
  FloaterTier tier = FloaterTier.collapsed,
}) async {
  nativeHearingApi = _Mic();
  SharedPreferences.setMockInitialValues(<String, Object>{
    'hupo_chat_appearance': 'light|$dshContentFontSizeDefault',
  });
  await tester.pumpWidget(
    MaterialApp(home: ChatScreen(initialTier: tier, controller: c, onLoggedOut: () {})),
  );
  await tester.pumpAndSettle();
}

/// 那颗窄按钮**看得见的那一块**（判据量的是它，不是外面那一格）。
Rect _tabFace(WidgetTester tester) => tester.getRect(
  find.descendant(of: find.byKey(chatBarToggleKey), matching: find.byType(Container)).first,
);

ChatFloaterState _floater(WidgetTester tester) =>
    tester.state<ChatFloaterState>(find.byType(ChatFloater));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // ── ① 它在哪儿、长多大 ─────────────────────────────────────

  testWidgets('① 🔴 在「清单」左边：高 = 那颗圆圈、看得见只有 20 宽、命中格 44×64；两个档一样', (tester) async {
    final seen = <FloaterTier, Rect>{};
    for (final tier in [FloaterTier.collapsed, FloaterTier.full]) {
      final c = _controller();
      await _pump(tester, c, tier: tier);
      final where = tier == FloaterTier.collapsed ? '收起档' : '展开档';

      expect(find.byKey(chatBarToggleKey), findsOneWidget, reason: '$where：★ 那颗窄按钮不见了');
      final hit = tester.getRect(find.byKey(chatBarToggleKey));
      final face = _tabFace(tester);
      final work = tester.getRect(find.byKey(chatWorkKey));
      seen[tier] = hit;

      // 🔴 "在左下角的两个按钮左边"
      expect(hit.left < work.left, true, reason: '$where：★ 它没在「清单」左边');
      // 🔴 "高度等于语音按钮高度" —— 与那颗圆圈上下齐平（同一条中线）
      expect(hit.height, d.voiceCircleBox,
          reason: '$where：★ 高不是 ${d.voiceCircleBox}（${hit.height}）');
      final circle = tester.getRect(find.byKey(voiceBarCircleKey));
      expect(hit.top, closeTo(circle.top, 0.5),
          reason: '$where：★ 没与那颗圆圈齐平（${hit.top} vs ${circle.top}）');
      // 🔴 "宽度非常窄" —— 看得见那块 20，比手势那一格窄
      expect(face.width, d.voiceAuxTabW, reason: '$where：★ 看得见那块不是 ${d.voiceAuxTabW} 宽');
      expect(face.width < 44, true, reason: '$where：★ 看不出来"非常窄"');
      // 🔴 负向对照：**手势那一格仍是 44×64**（D3.6 点名的硬闸量的就是它）
      expect(hit.width, greaterThanOrEqualTo(44), reason: '$where：★ 命中区只有 ${hit.width} 宽');
      expect(hit.height, greaterThanOrEqualTo(44));

      // 平时面**居中**（两端留白与右边那颗一样：实测 12 / 10）—— 这是"左移"的起点
      expect(face.left - tester.getRect(find.byType(ChatFloater)).left, closeTo(12, 0.5),
          reason: '$where：★ 平时它没居中在自己那一格里（${face.left}）');
    }
    // 🔴 **两个档位置一个像素都不差**（不然打开聊天窗口那一下它会跳）
    expect(seen[FloaterTier.full], seen[FloaterTier.collapsed],
        reason: '★ 两个档里那颗窄按钮的位置不一样（`${seen[FloaterTier.collapsed]}` vs '
            '`${seen[FloaterTier.full]}`）—— 打开聊天那一下它会跳');
  });

  // ── ② 点一下：那一整行左移出屏；它留下来、贴着边 ──────────────

  testWidgets('② 🔴 点一下 ⇒ 底下那一整行整条移出屏幕左边；浮窗贴到屏幕左边缘', (tester) async {
    final c = _controller();
    await _pump(tester, c);

    // 前提：没收之前，那一行上这些东西**都在屏幕里**
    final composerBefore = tester.getRect(find.byKey(voiceBarCircleKey));
    expect(composerBefore.left, greaterThan(0));

    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();

    expect(_floater(tester).barHidden, true, reason: '★ 点了它没把这一条收起来');

    // 🔴 "贴着边显示"：浮窗本身贴到屏幕左边缘（连那 10px 留白一起吃进去）
    final floater = tester.getRect(find.byType(ChatFloater));
    expect(floater.left, 0, reason: '★ 浮窗没贴到屏幕左边缘（${floater.left}）');
    // 🔴 而且**这一格真的缩到那一颗那么宽** —— 不只是"看不见"：
    //    浮窗那层 `Material` 是吃点击的 ⇒ 留着整条宽的格子，屏幕底下就多一条
    //    "看不见却挡着"的地带（见 ⑥）。
    expect(floater.width, closeTo(d.voiceAuxW, 0.5),
        reason: '★ 收起来之后这一格还是 ${floater.width} 宽（该是那一颗的 ${d.voiceAuxW}）');
    final face = _tabFace(tester);
    expect(face.left, 0, reason: '★ 那颗按钮没贴着边（${face.left}）');
    expect(find.byIcon(Icons.chevron_right_rounded), findsOneWidget,
        reason: '★ 收起来之后它不是"向右的箭头"');

    // 🔴 那一整行**整条在左边外面**（一个像素都不许露）。
    //    ⚠️ 「播放」不在这张单子里：VM 上 `canSpeak` 恒假 ⇒ 真入口里那颗**本来就不画**
    //      （`voice_buttons_test` ③ 钉着那条门）。下面这几样已经覆盖"整条"。
    for (final (name, k) in [
      ('清单', chatWorkKey),
      ('键盘', chatKeyboardKey),
      ('展开', chatHandleKey),
      ('录音圆圈', voiceBarCircleKey),
    ]) {
      final rect = tester.getRect(find.byKey(k));
      expect(rect.right, lessThanOrEqualTo(floater.left + 0.5),
          reason: '★ $name 还露在屏幕上（${rect.right} vs ${floater.left}）');
    }
    // 反例：**留下来的那一颗**在屏幕上（而且贴着边）
    expect(tester.getRect(find.byKey(chatBarToggleKey)).left,
        greaterThanOrEqualTo(floater.left - 0.5));
  });

  // ── ③ 再点一下：回来 ───────────────────────────────────────

  testWidgets('③ 🔴 再点一下 ⇒ 回来（一个像素不差）＋ 箭头翻回去', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    final before = tester.getRect(find.byKey(chatWorkKey));
    final tabBefore = tester.getRect(find.byKey(chatBarToggleKey));

    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();

    expect(_floater(tester).barHidden, false, reason: '★ 再点一下没收回来');
    expect(find.byIcon(Icons.chevron_left_rounded), findsOneWidget,
        reason: '★ 放回来之后它不是"向左的箭头"');
    expect(tester.getRect(find.byKey(chatWorkKey)), before, reason: '★ 放回来之后「清单」没回到原位');
    expect(tester.getRect(find.byKey(chatBarToggleKey)), tabBefore,
        reason: '★ 那颗窄按钮自己挪了位置');
    expect(tester.getRect(find.byType(ChatFloater)).left, FloaterMetrics.margin,
        reason: '★ 浮窗没挪回原来的留白');
  });

  // ── ④ 字不丢 ─────────────────────────────────────────────

  testWidgets('④ 🔴 收起来之前打的那半句，放回来还在（那一行只是被移走，不是拆掉）', (tester) async {
    final c = _controller();
    await _pump(tester, c);

    await tester.tap(find.byKey(chatKeyboardKey)); // 摊开输入框
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(voiceBarTypeKey), '半句话');
    await tester.pumpAndSettle();
    expect(c.composeText, contains('半句话'), reason: '★ 打的字没进控制器（前提不成立）');

    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();
    // 前提·补：收起来那一下**输入框也收掉了**（＝软键盘跟着收，见 ⑦）
    expect(find.byKey(voiceBarTypeKey), findsNothing, reason: '前提：收起来时那个框该收掉');

    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();

    // 🔴 **字不丢**：那一行只是被移走（不是拆掉重建）⇒ 再点开那颗「键盘」，
    //    框里还是他打的那半句。
    await tester.tap(find.byKey(chatKeyboardKey));
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(find.byKey(voiceBarTypeKey)).controller?.text,
      contains('半句话'),
      reason: '★ 收起再放回来，那半句话没了（那一行被拆掉重建了）',
    );
  });

  // ── ⑤ 展开着的时候按它 ────────────────────────────────────

  testWidgets('⑤ 🔴 展开档按它 ⇒ 聊天整个收起来（不该留下"只有时间线、没有输入条"的窗口）', (tester) async {
    final c = _controller();
    await _pump(tester, c, tier: FloaterTier.full);
    expect(_floater(tester).tier, FloaterTier.full, reason: '前提：一上来该是展开档');

    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();

    expect(_floater(tester).tier, FloaterTier.collapsed,
        reason: '★ 展开着按它没收起来 —— 屏幕上会剩一个没有输入条的窗口');
    expect(_floater(tester).barHidden, true);
  });

  testWidgets('⑤·补 🔴 收起来时「清单」那张浮窗跟着关掉（不然它下次亮着灯却不在）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await tester.tap(find.byKey(chatWorkKey));
    await tester.pumpAndSettle();
    // 前提：那张浮窗真的开着（判据按 key 认，不看字）
    expect(find.byKey(workPanelKey), findsOneWidget, reason: '★ 清单没打开（前提不成立）');

    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();
    expect(find.byKey(workPanelKey), findsNothing, reason: '★ 收起来之后那张浮窗还开着');
  });

  // ── ⑥ 看不见的地带不许吃点击 ───────────────────────────────
  testWidgets('⑥ 🔴 收起来之后，底下那条看不见的地带**不吃点击**（点它 = 点到桌面）', (tester) async {    final c = _controller();
    await _pump(tester, c);

    // 浮窗自己那一层 `Listener`（`_barSurface` 里那个，树里最外层的 Listener）。
    final barrier = tester.renderObject(
      find.descendant(of: find.byType(ChatFloater), matching: find.byType(Listener)).first,
    );
    // 量一个"那一行上什么都没有"的点：这一格的右下角（收起来之后那儿是空的）。
    final floater = tester.getRect(find.byType(ChatFloater));
    final probe = Offset(floater.right - 20, floater.center.dy);
    bool blocked() => tester
        .hitTestOnBinding(probe)
        .path
        .any((e) => identical(e.target, barrier));

    // 负向对照：没收起来时这一点**是**被那一层挡住的（不然下面那条就是空转）
    expect(blocked(), true, reason: '★ 没收起来时这一点居然没被浮窗挡住（前提不成立）');

    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();
    expect(blocked(), false,
        reason: '★ 收起来之后那一条还在吃点击（看不见却挡着 —— 桌面点不动）');
    // 反例之二：那颗窄按钮**自己**照样点得到（它还在屏幕左边缘）
    expect(tester.getRect(find.byKey(chatBarToggleKey)).contains(probe), false);
    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();
    expect(_floater(tester).barHidden, false, reason: '★ 收起来之后就点不回来了');
  });

  // ── ⑦ 收起来时把键盘放回去 ─────────────────────────────────

  testWidgets('⑦ 🔴 收起来的时候，摊开着的输入框（＝软键盘）也收掉', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await tester.tap(find.byKey(chatKeyboardKey));
    await tester.pumpAndSettle();
    expect(find.byKey(voiceBarTypeKey), findsOneWidget, reason: '★ 输入框没摊开（前提不成立）');

    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();
    expect(find.byKey(voiceBarTypeKey), findsNothing,
        reason: '★ 把这一条收起来了，那个框（＝软键盘）还浮在屏幕上');
    // ⚠️ 反例：**放回来的时候不许自己又摊开**（那是他自己按的开关，不是"顺带"）
    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pumpAndSettle();
    expect(find.byKey(voiceBarTypeKey), findsNothing,
        reason: '★ 放回来之后那个框自己又出来了（他没按那颗「键盘」）');
  });

  // ── ⑧ 是"滑过去"的，不是"啪"地跳过去 ──────────────────────

  testWidgets('⑧ 🔴 半途那一行在**往左走**（主人：*"隐藏时应左移"*）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    final before = tester.getRect(find.byKey(voiceBarCircleKey));

    await tester.tap(find.byKey(chatBarToggleKey));
    await tester.pump(); // 起手这一帧
    await tester.pump(const Duration(milliseconds: 60)); // 全程 220 的前一小段
    final mid = tester.getRect(find.byKey(voiceBarCircleKey));

    // 🔴 半途：**已经往左走了一截**（不是原地不动 = "跳"过去）……
    expect(mid.left, lessThan(before.left - 1),
        reason: '★ 半途它没往左走（${before.left} → ${mid.left}）—— 那是"跳"不是"滑"');
    // ……而且**还在屏幕里**（不是一按就没了）
    expect(mid.left, greaterThan(0),
        reason: '★ 半途整条就已经出屏了（${mid.left}）—— 那也不叫滑动');

    await tester.pumpAndSettle();
    expect(tester.getRect(find.byKey(chatWorkKey)).right, lessThanOrEqualTo(0.5),
        reason: '★ 收完了但那一行还在屏幕里');
  });
}
