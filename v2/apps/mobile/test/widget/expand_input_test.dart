// **展开后的那一窗：发得出去、历史滑得动**（主人 2026-09-26 报的两条）。
//
// 主人原话：
//   *"聊天窗口的发送按钮有bug，展开时无法发送。另外聊天历史展开时也无法滑动。"*
//
// ── 这一份为什么存在（都在真机/真浏览器上复现过）────────────────────
//
// 🔴 **根因一：时间线"跟不跟到底"只认得"拖"那一种滚动。**
//    `_userScrolledAway`（`screens/chat_screen.dart`）原来只在
//    `ScrollStart/UpdateNotification.dragDetails != null` 时置位 —— 而
//    **滚轮 / 触控板 / 滚动条 / 键盘翻页都没有 `dragDetails`**。
//    ⇒ 桌面浏览器上（鼠标拖根本不算滚动设备，`ScrollBehavior.dragDevices`
//      里没有 mouse ⇒ 滚轮是**唯一**手段）用户翻上去之后这个标志仍是假，
//      之后**任何**一帧控制器变化（流式回答的每一条 `message/text`、工具行、
//      排队快照）都会让 `scrollFollowAction` 走"永远跟到底"那一支、
//      把用户刚翻上去的一屏**硬跳回底部**。屏幕上就是"聊天历史无法滑动"。
//      真浏览器读数（线上那一版 `cb3c68fb118f`、临时核心、60 轮历史）：
//      滚轮翻到第 42–46 轮 ⇒ 点一下发送 ⇒ 屏幕上又只剩第 60 轮。
//    ⚠️ 判据用**滚轮**（`TestPointer.scroll`）打，**不用拖** ——
//      拖那条路一直是绿的（`dragDetails != null`），正是它把这道闸骗过去的。
//
// 🔴 **根因二：展开那一下的"补帧"会停在半路，以后随便哪一帧再醒过来。**
//    `_jumpToLatest` 用 `addPostFrameCallback` 递归补 4 帧（本意：懒加载的列表
//    跳一次会差一条），而 **`addPostFrameCallback` 自己不排帧** ⇒ 没人排帧时
//    这一串就停住，等到下一次"因为别的原因"来的那一帧才接着跑 ——
//    那可能就是用户**刚用滚轮翻上去**的那一帧。真读数（widget 层）：
//    滚轮把偏移挪到 4415 之后，下一帧 `_jumpToLatest(left: 1)` 又把它拉回 4715。
//
// 🔴 **根因三：键盘那一段被算了两遍 ⇒ 时间线被挤成 0 高。**
//    `_sheetBody` 里留着一格第一版的 `SizedBox(height: viewInsets.bottom)`
//    （那时输入条就住在这个 Column 里），而输入条 2026-09-24 已经搬去浮窗
//    （是这个 Column 的**兄弟**）⇒ `Scaffold` 缩过一次身子、这里再占一段。
//    真读数（390×844 ＋ 键盘 300 ＋ 6 行字）：时间线矩形 `(30, -71.5, 360, -71.5)`
//    —— **高 0、整块在屏幕上方**；`Column-[<'chat-body'>]` 当场
//    `RenderFlex overflowed`。没有东西可滚，就是"滚不动"。
//    同一条账还让浮窗**顶出屏幕**：`maxH` 按整屏算（`Positioned` 不给 `top`
//    时高度是无界的）⇒ 顶在 **-270**，抓手/标题行/两个 tab 一个都点不到。
//
// 🔴 **根因四（批 5 那一栏）：手机上"挤"会把聊天挤成 30 像素。**
//    只判"这一栏放得下"（`available ≥ 300`）不够：浮窗里那一块 ≈ 屏宽 − 60
//    ⇒ 330 上下，栏宽正好 300 ⇒ 聊天只剩 **30**，气泡那一行
//    `RenderFlex overflowed by 41 pixels`（`bubbles.dart:141`）。⇒ 不够两边用就改走"盖"。
//
// ⚠️ **这一份是提示档**（`AGENTS.md` §5.1：`test/widget` 只有可访问性那一份是硬闸），
//    但它是"这两条到底有没有修好"的**唯一自动化证据**：纯逻辑（`scrollFollowAction`）
//    早就有判据，而这两条都**不在纯逻辑里** —— 一条在"谁算用户自己动的"，
//    一条在"布局把键盘算了几遍"。
// ⚠️ **发送那一条（`展开后发送`）在修之前就是绿的**：我把主人点名的四种状态
//    （常态 · 有折叠控件 · 有工具行 · 亮/暗 ＋ 非默认字号）全过了一遍，
//    真浏览器里也用真事件（假 harness）验过 —— **没有复现出"发不出去"**。
//    它是**回归网**（防以后谁把这条链子碰断），不是"修好了"的证据；如实记在
//    `docs/dev/121-EXPAND-INPUT-FIX.md` §五。

import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/tool_row_view.dart';
import 'package:hupo_app/widgets/voice_bar.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(String body, [int status = 200]) => http.Response(
  body,
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// 假服务端：记下 `/api/say` 那几笔，并替 `/api/hear` 说一句"听清了"。
///
/// ⚠️ 今天没有"输入框 ＋ 发送"那条路了（那一格已经换成"语音优先"，2026-10-05）：
///    开不了麦时走的是**那颗「打字」的退路**，它把那一句交给 `/api/hear`
///    （听懂那一层只改错别字）⇒ 通顺了才由**界面这一侧自己**发出去（`/api/say`）。
///    ⇒ 这条链子上"交给服务端恰好一句"仍然钉在这里，只是中间多了一层"听懂"。
class _Rec {
  final says = <String>[];
  final asked = <String>[];
  late ChatController c;
}

_Rec _controller() {
  final r = _Rec();
  final api = Api(
    client: MockClient((req) async {
      if (req.url.path.contains('/api/hear')) {
        r.asked.add(req.body);
        // 听懂那一层只改错别字：这里原样回一句（`heard` 非空 ⇒ `ready` ⇒ 自己发出去）
        final b = jsonDecode(req.body) as Map<String, dynamic>;
        return _json(jsonEncode({'heard': (b['text'] as String?) ?? ''}));
      }
      if (req.url.path.contains('/api/say')) {
        r.says.add(req.body);
        return _json('{"ok":true}');
      }
      if (req.url.path.contains('/api/apps')) return _json('{"apps":[]}');
      return _json('{}');
    }),
  );
  r.c = ChatController(api: api, tokens: TokenStore(), token: 'tok');
  return r;
}

/// 一屏放不下的历史（默认测试窗口 800×600 里足以滚起来）。
void _feed(ChatController c, int rounds, {bool tools = false}) {
  var seq = 1;
  for (var i = 1; i <= rounds; i += 1) {
    c.ingest({'type': 'user/echo', 'seq': seq++, 'messageId': 'u$i', 'text': '第 $i 句'});
    if (tools) {
      // ⚠️ 服务端每轮先报一句"开始了"（`_seenTurn` 就是它拨上去的 ——
      //    少了它 `_closeTurn()` 收不出轮号、折叠控件一条都不会出现）。
      c.ingest({'type': 'message/status', 'turn': i, 'state': 'started'});
      c.ingest({
        'type': 'tool/call',
        'seq': seq++,
        'turn': i,
        'step': 1,
        'callId': 'c_$i',
        'name': 'write',
        'title': '写第 $i 个文件',
        'args': '{"path":"/w/f$i.txt"}',
      });
      c.ingest({
        'type': 'tool/result',
        'seq': seq++,
        'turn': i,
        'step': 1,
        'callId': 'c_$i',
        'ok': true,
        'excerpt': '好了',
        'bytes': 6,
      });
    }
    c.ingest({'type': 'message/start', 'messageId': 'm$i', 'seq': seq++});
    c.ingest({
      'type': 'message/text',
      'messageId': 'm$i',
      'block': 'quick',
      'text': '第 $i 答',
      'seq': seq++,
    });
    // ⚠️ `tools: true` 时**故意不封口**：这样最后一轮的工具行还摊在屏幕上
    //    （"有工具行"那个状态）；要"有折叠控件"的用例自己补一条 `message/end`。
    if (!tools) {
      c.ingest({'type': 'message/end', 'messageId': 'm$i', 'seq': seq++, 'reason': 'completed'});
    }
  }
}

/// **走真入口**（与 `accessibility_test.dart` 同一条路）：`ChatScreen` ＋ 假 API。
Future<void> _pump(
  WidgetTester tester,
  ChatController c, {
  double scale = 1.0,
  int fontSize = dshContentFontSizeDefault,
  bool dark = false,
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    'hupo_chat_appearance': '${dark ? 'dark' : 'light'}|$fontSize',
  });
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, inner) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
        child: inner!,
      ),
      home: ChatScreen(controller: c, onLoggedOut: () {}),
    ),
  );
  await tester.pumpAndSettle();
}

/// **像用户那样展开**（点抓手）—— 真应用就是从收起档开始的。
Future<void> _expand(WidgetTester tester) async {
  await tester.tap(find.byKey(chatHandleKey));
  await tester.pumpAndSettle();
  // 负向对照：真展开了（收起档根本不建时间线）
  expect(find.byType(ListView), findsWidgets, reason: '★ 抓手那一下没把浮窗展开');
}

/// **把"展开那一下的补帧"跑完**。
///
/// ⚠️ 真应用里帧是连续来的（展开之后总还有几帧），而测试里要自己推；
///    不推的话量到的是"补帧还没跑完"那个中间态（那正是根因二）。
Future<void> _drainFrames(WidgetTester tester, [int n = 8]) async {
  for (var i = 0; i < n; i += 1) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

ScrollPosition _transcript(WidgetTester tester) => tester
    .state<ScrollableState>(
      find.descendant(of: find.byType(ListView).first, matching: find.byType(Scrollable)),
    )
    .position;

/// **滚轮往上翻**（鼠标滚轮 / 触控板那一类：`PointerScrollEvent`）。
Future<void> _wheelUp(WidgetTester tester, {double by = 600}) async {
  final p = TestPointer(1, PointerDeviceKind.mouse);
  await tester.sendEventToBinding(p.hover(tester.getCenter(find.byType(ListView).first)));
  await tester.sendEventToBinding(p.scroll(Offset(0, -by)));
  await tester.pumpAndSettle();
}

/// **走那条打字退路**（开不了麦时才有的那一格）：按「打字」→ 往那一格里打字。
///
/// ⚠️ 原来的输入框（`Composer` ＋ 那颗「发送」）已经被"语音优先"那一格换掉了
///    （2026-10-05）⇒ `find.byType(TextField)` 在这一档里**一个都找不到**：
///    先得按那颗「打字」，那一格才摊开（`voice_bar.dart` 的 `_typedField`）。
Future<void> _typeInstead(WidgetTester tester, String text) async {
  await tester.tap(find.byKey(voiceBarTypeChipKey));
  await tester.pump();
  expect(find.byKey(voiceBarTypeKey), findsOneWidget, reason: '★ 那颗「打字」没把输入格摊开');
  await tester.enterText(find.byKey(voiceBarTypeKey), text);
  await tester.pump();
}

/// 那条退路里「就这句」此刻按不按得动（灰 = `onPressed == null`）。
bool _sendReady(WidgetTester tester) =>
    tester.widget<FilledButton>(find.byKey(voiceBarTypedSendKey)).onPressed != null;

/// **一条新事件进来**（流式回答里的每一条 `message/text` 都会走这条路）。
void _newText(ChatController c) => c.ingest({
  'type': 'message/text',
  'messageId': 'm_last',
  'block': 'quick',
  'text': '又一句',
  'seq': 90001,
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // ── ① 发送：展开之后，点一次 = 交出去**恰好一句** ────────────────
  //
  // ⚠️ 下面这一组在**修之前就是绿的**（我没能复现"发不出去"，见文件头）。
  //    留着它是回归网：主人点名的四种状态各一条，谁碰断了当场红。
  // ⚠️ 2026-10-05 起"输入框 ＋ 发送"那条路没了（那一格换成"语音优先"）⇒
  //    这一组走的是**开不了麦时那颗「打字」的退路**：按它 → 打字 → 「就这句」
  //    ⇒ 交给 `/api/hear` 听懂那一层 ⇒ 通顺就**自己发出去**（`/api/say`）。
  //    "恰好一句"这件事一个字没变 —— 只是中间多了一层"听懂"。

  for (final state in const ['常档', '有折叠控件', '有工具行']) {
    testWidgets('展开后发送（打字退路）· $state ⇒ 恰好交给服务端一句', (tester) async {
      final r = _controller();
      _feed(r.c, 6, tools: state == '有工具行' || state == '有折叠控件');
      if (state == '有折叠控件') {
        // 让第 1 轮收口（工具行折成那一个控件）
        r.c.ingest({'type': 'message/end', 'messageId': 'm1', 'seq': 90000, 'reason': 'completed'});
      }
      await _pump(tester, r.c);
      await _expand(tester);
      if (state == '有折叠控件') {
        // 负向对照：折叠控件**真的在屏幕上**（不然这条量的是别的状态）
        expect(find.byType(TurnProcessControl), findsWidgets, reason: '★ 没有折叠控件 ⇒ 这条没量到那个状态');
      }
      if (state == '有工具行') {
        expect(find.byType(ToolRowView), findsWidgets, reason: '★ 没有工具行 ⇒ 这条没量到那个状态');
      }
      await _typeInstead(tester, '在吗');
      expect(_sendReady(tester), isTrue, reason: '★ 有字了那颗「就这句」还是灰的');

      // ⚠️ `warnIfMissed`：点歪了（被别的东西盖住 / 落在视口外）会报出来
      await tester.tap(find.byKey(voiceBarTypedSendKey), warnIfMissed: true);
      await tester.pumpAndSettle();

      // 负向对照（"恰好一次"）：再等几帧也不许多交一句
      await _drainFrames(tester, 4);
      expect(r.says.length, 1, reason: '★ 点一次发送，服务端该收到**恰好一句**（$state）');
      expect(r.says.single, contains('在吗'), reason: '★ 交给服务端的那句不是框里那句');
      expect(find.text('在吗'), findsWidgets, reason: '★ 发出去了，屏幕上该看得见那句话');
    });
  }

  testWidgets('展开后发送（打字退路）· 暗色 ＋ 用户字号 17 ⇒ 一样发得出去', (tester) async {
    final r = _controller();
    _feed(r.c, 6);
    await _pump(tester, r.c, dark: true, fontSize: dshContentFontSizeMax);
    await _expand(tester);
    await _typeInstead(tester, '在吗');
    expect(_sendReady(tester), isTrue);
    await tester.tap(find.byKey(voiceBarTypedSendKey), warnIfMissed: true);
    await tester.pumpAndSettle();
    expect(r.says.length, 1, reason: '★ 暗色/大字号下那颗「就这句」点不动');
  });

  // ── ② 滚轮翻上去之后，谁也不许把它拽回底部 ──────────────────────

  testWidgets('🔴 滚轮往上翻 ⇒ 后面来的新事件不许把它拽回底部', (tester) async {
    final r = _controller();
    _feed(r.c, 40);
    await _pump(tester, r.c);
    await _expand(tester);
    await _drainFrames(tester);

    final pos = _transcript(tester);
    final bottom = pos.maxScrollExtent;
    expect(bottom, greaterThan(0), reason: '★ 这一屏根本没得滚 ⇒ 这条判据不成立');

    await _wheelUp(tester);
    final afterWheel = pos.pixels;
    expect(
      afterWheel,
      lessThan(bottom - 100),
      reason: '★ 滚轮翻上去之后**立刻**被拽回了底部 —— 屏幕上就是"聊天历史滑不动"',
    );

    _newText(r.c);
    await tester.pumpAndSettle();

    expect(
      pos.pixels,
      afterWheel,
      reason: '★ 新事件进来把用户刚翻上去的位置拽回底部了 —— 屏幕上就是"聊天历史滑不动"',
    );
  });

  testWidgets('对照组：**手指拖**上去 ⇒ 后面来的新事件也不许动它（这条一直是对的）', (tester) async {
    final r = _controller();
    _feed(r.c, 40);
    await _pump(tester, r.c);
    await _expand(tester);
    await _drainFrames(tester);

    final pos = _transcript(tester);
    final bottom = pos.maxScrollExtent;
    await tester.drag(find.byType(ListView).first, const Offset(0, 600));
    await tester.pumpAndSettle();
    final afterDrag = pos.pixels;
    expect(afterDrag, lessThan(bottom - 100), reason: '★ 拖都没拖动 ⇒ 这条判据不成立');

    _newText(r.c);
    await tester.pumpAndSettle();
    expect(pos.pixels, afterDrag, reason: '★ 手指拖上去的也被拽走了');
  });

  testWidgets('🔴 展开那一下的补帧不许"停在半路"、以后再把用户拽走', (tester) async {
    final r = _controller();
    _feed(r.c, 40);
    await _pump(tester, r.c);
    await _expand(tester);
    await _drainFrames(tester);

    final pos = _transcript(tester);
    await _wheelUp(tester);
    final afterWheel = pos.pixels;
    expect(
      afterWheel,
      lessThan(pos.maxScrollExtent - 100),
      reason: '★ 滚轮翻上去之后立刻被拽回了底部（补帧停在半路、稍后醒过来）',
    );

    // ⚠️ **不喂任何新事件**，只让帧继续走：停在半路的补帧会在这一帧醒过来
    await _drainFrames(tester, 6);
    expect(
      pos.pixels,
      afterWheel,
      reason: '★ 展开的补帧停在半路，稍后醒过来把用户拽回了底部',
    );
  });

  // ── ③ 键盘（手机上打字）不许把时间线挤成 0 高 ────────────────────

  testWidgets('🔴 手机竖屏 + 键盘 ⇒ 时间线不是一个 0 高的东西、窗口不顶出屏幕', (tester) async {
    const size = Size(390, 844);
    const keyboard = 300.0;
    final r = _controller();
    _feed(r.c, 40);
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await _pump(tester, r.c);
    await _expand(tester);
    // ⚠️ 今天要打字就得先按那颗「打字」（原来的输入框已经被"语音优先"那一格
    //    换掉，2026-10-05）⇒ 这一格摊开之后，它（连同那颗「就这句」）必须让开键盘。
    await _typeInstead(tester, '在吗');
    tester.view.viewInsets = const FakeViewPadding(bottom: keyboard);
    await tester.pumpAndSettle();
    await _drainFrames(tester);

    final floater = tester.getRect(find.byType(ChatFloater));
    final transcript = tester.getRect(find.byType(ListView).first);
    // ⚠️ 原来这里量的是最右那颗话筒（"永远在那一行的最右"）。🔴 今天量的是
    //    **那颗「就这句」**（打字退路的出口 —— 它就在那一行里，键盘一起来必须没被盖住）。
    final send = tester.getRect(find.byKey(voiceBarTypedSendKey));

    expect(
      transcript.height,
      greaterThan(40),
      reason: '★ 键盘一起来时间线就被挤成 0 高（`_sheetBody` 把键盘那一段算了两遍）',
    );
    expect(floater.top, greaterThanOrEqualTo(0), reason: '★ 浮窗顶出屏幕上方了（抓手/标题行都点不到）');
    expect(
      floater.bottom,
      lessThanOrEqualTo(size.height - keyboard),
      reason: '★ 浮窗压在键盘底下',
    );
    expect(send.bottom, lessThanOrEqualTo(size.height - keyboard), reason: '★ 那颗「就这句」被键盘盖住了');

    // 顺手核一句：这个状态下还是发得出去
    await tester.tap(find.byKey(voiceBarTypedSendKey), warnIfMissed: true);
    await tester.pumpAndSettle();
    expect(r.says.length, 1, reason: '★ 键盘开着时那颗「就这句」点不动');
  });

  // ── ③·补 键盘弹起 ⇒ **最新那条仍然看得见**（主人 2026-09-30 报的）──────
  //
  // 主人原话：*「输入法打开的时候，页面被覆盖，无法显示最新消息。」*
  // 真浏览器读数（手机 UA · 390 宽 · 键盘 300）：浮窗**是对的**（输入条让开键盘），
  // 可**时间线没跟到底** —— 视口变矮时 Flutter 不会替我们把滚动位置收到底
  // ⇒ 刚才贴着底那条"最新的话"被挤到看得见的地方之外。
  testWidgets('🔴 手机 + 键盘弹起 ⇒ 最新那条仍贴着底（视口变了要重新对一次）', (tester) async {
    const size = Size(390, 844);
    const keyboard = 300.0;
    final r = _controller();
    _feed(r.c, 40);
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await _pump(tester, r.c);
    await _expand(tester);
    await _drainFrames(tester);

    final before = _transcript(tester);
    expect(
      before.pixels,
      closeTo(before.maxScrollExtent, 1),
      reason: '前提：键盘还没弹起来时，时间线本来就该贴着底',
    );
    final oldMax = before.maxScrollExtent;

    tester.view.viewInsets = const FakeViewPadding(bottom: keyboard);
    await tester.pumpAndSettle();
    await _drainFrames(tester);

    final after = _transcript(tester);
    expect(
      after.maxScrollExtent,
      greaterThan(oldMax),
      reason: '前提：键盘确实把那块地方弄矮了（视口变矮 ⇒ 内容超出得更多、maxScrollExtent 变大）',
    );
    expect(
      after.pixels,
      closeTo(after.maxScrollExtent, 1),
      reason: '★ 键盘弹起来之后最新那条被挤到看不见的地方了（视口变了没重新对底）',
    );
  });

  testWidgets('对照组：用户自己翻上去了 ⇒ 键盘弹起**不许**把他拽回底部', (tester) async {
    const keyboard = 300.0;
    final r = _controller();
    _feed(r.c, 40);
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await _pump(tester, r.c);
    await _expand(tester);
    await _drainFrames(tester);
    await _wheelUp(tester);
    final away = _transcript(tester).pixels;

    tester.view.viewInsets = const FakeViewPadding(bottom: keyboard);
    await tester.pumpAndSettle();
    await _drainFrames(tester);
    expect(
      _transcript(tester).pixels,
      away,
      reason: '★ 他正看着老话，键盘一起来就把他拽回底部了（那是"打断他"）',
    );
  });

  testWidgets('对照组：没有键盘 ⇒ 时间线本来就该有一大块（这条一直是对的）', (tester) async {
    final r = _controller();
    _feed(r.c, 40);
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await _pump(tester, r.c);
    await _expand(tester);
    await _drainFrames(tester);
    expect(
      tester.getRect(find.byType(ListView).first).height,
      greaterThan(200),
      reason: '★ 没有键盘时时间线也该有一大块',
    );
  });

}
