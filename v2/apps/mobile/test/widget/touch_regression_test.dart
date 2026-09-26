// **触屏那一类回归：长按那一条不许把整个窗口吃掉；手机宽度下那一串动作不许"看不见还挂着"。**
//
// 主人 2026-09-26 报的三条（真机 Android Chrome）：
//   ①「又无法滚动聊天窗口了」 ②「按钮也不对，点不开」 ③「聊天依然收起才能发送」
//
// ── 复现与根因（真机 + 活站点上的合成触屏都跑过；读数在 `docs/dev/124-TOUCH-REGRESSION.md`）──
//
// 🔴 **根因 A：`kLongPressTimeout` = 500ms；手按住气泡不放 ⇒ 弹一层
//    `showModalBottomSheet` ⇒ 它那层 barrier 把整个窗口吃掉。**
//    量到的（线上 `0ec2b1af0068`）：按住 450ms ⇒ 菜单不弹；600ms ⇒ 弹。
//    弹着的时候：拖时间线**一点不动**、点发送**两次都没发出去**、
//    那张单子还**整个盖住输入条**。收起的窗口没有气泡 ⇒ 长按不到
//    ⇒ 只有它正常 —— 那正是主人那句"收起才能发送"。
//    ⚠️ **合成的瞬点（`tester.tap` / 探针同拍 down+up）永远碰不到它** ——
//      上一批（#168）就是这么漏掉的。
//    ⇒ 现在改成**不弹层**：输入条上面那一条（`BubbleActionsBar`），
//      它开着的时候时间线照样滑、发送照样发、抓手行照样点。
//
// 🔴 **根因 B：标题行里那个 `Spacer()` 和动作条**都是 flex 1 ⇒
//    手机宽度（390）下动作条只分到几十像素，`回收站/导出` 排在**视口外面**，
//    而 a11y 树里它们**还挂在那两个 tab 的坐标上**（点"回收站"那颗节点，
//    真点下去命中的是【聊天】tab —— 真浏览器上量到过）。
//    ⇒ 拿掉那个 `Spacer`（动作条拿走全部剩余宽），并且**把这件事钉成判据**。
//    ⚠️ 2026-09-26（`#173`）：那两个 tab 已按主人决定删掉 ⇒ 上面"挂在 tab 坐标上"
//       那个具体实例没有了，横滚条也从 53 宽变成 101 宽（新读数在
//       `docs/dev/124-TOUCH-REGRESSION.md` §三·五 的补注里）。
//       下面这条 390 宽的判据**照旧**要过（「过程」仍得整颗在里面）。
//
// ⚠️ 这一份是提示档（`AGENTS.md` §5.1：`test/widget` 只有可访问性那份是硬闸），
//    但它是"这三条到底有没有修好"的唯一自动化证据。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/models/export_words.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/trash_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/bubble_menu.dart';
import 'package:hupo_app/widgets/bubble_select_bar.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(String body, [int status = 200]) => http.Response(
  body,
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// 假服务端：只记 `/api/say` 那几笔（"发了几句"是这一份要钉的事）。
class _Rec {
  final says = <String>[];
  late ChatController c;
}

_Rec _controller() {
  final r = _Rec();
  final api = Api(
    client: MockClient((req) async {
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

/// 一屏放不下的历史。
void _feed(ChatController c, int rounds) {
  var seq = 1;
  for (var i = 1; i <= rounds; i += 1) {
    c.ingest({'type': 'user/echo', 'seq': seq++, 'messageId': 'u$i', 'text': '第 $i 句'});
    c.ingest({'type': 'message/start', 'messageId': 'm$i', 'seq': seq++});
    c.ingest({
      'type': 'message/text',
      'messageId': 'm$i',
      'block': 'quick',
      'text': '第 $i 答',
      'seq': seq++,
    });
    c.ingest({'type': 'message/end', 'messageId': 'm$i', 'seq': seq++, 'reason': 'completed'});
  }
}

Future<void> _pump(WidgetTester tester, ChatController c) async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    'hupo_chat_appearance': 'light|$dshContentFontSizeDefault',
  });
  await tester.pumpWidget(
    MaterialApp(home: ChatScreen(controller: c, onLoggedOut: () {})),
  );
  await tester.pumpAndSettle();
}

/// 像用户那样展开（点抓手）—— 真应用就是从收起档开始的。
Future<void> _expand(WidgetTester tester) async {
  await tester.tap(find.byKey(chatHandleKey));
  await tester.pumpAndSettle();
  expect(find.byType(ListView), findsWidgets, reason: '★ 抓手那一下没把浮窗展开');
}

/// 把"展开那一下的补帧"跑完（与 `expand_input_test` 同一条理由）。
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

/// 发送钮此刻按不按得动（灰 = `onPressed == null`）。
bool _sendReady(WidgetTester tester) => tester
    .widget<IconButton>(
      find.ancestor(of: find.byIcon(Icons.arrow_upward), matching: find.byType(IconButton)),
    )
    .onPressed !=
    null;

/// 真手指那一下：**按住 600ms**（> `kLongPressTimeout`）。
///
/// ⚠️ 为什么不用 `tester.longPress`：那个走的是 `kLongPressTimeout` 的**默认**，
///    而这条判据要钉的正是"**手按住一下**会发生什么"（真机上的 600ms 读数）。
Future<void> _hold(WidgetTester tester, Finder target, {int ms = 600}) async {
  final gesture = await tester.startGesture(tester.getCenter(target));
  await tester.pump(Duration(milliseconds: ms));
  await gesture.up();
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // ── ① 🔴 长按那一条：摆出来的必须是**不挡窗口**的那条，而且窗口照样能用 ──

  testWidgets('🔴 按住气泡 600ms ⇒ 摆出的是输入条上面那条（不是弹层）＋ 时间线照样滑、发送照样发', (tester) async {
    final r = _controller();
    _feed(r.c, 40);
    await _pump(tester, r.c);
    await _expand(tester);
    await _drainFrames(tester);

    final pos = _transcript(tester);
    final bottom = pos.maxScrollExtent;
    expect(bottom, greaterThan(0), reason: '★ 这一屏根本没得滚 ⇒ 这条判据不成立');

    // 手按住最后那条用户气泡 600ms（真手指的"按下去准备滑"就是这个量级）
    await _hold(tester, find.text('第 40 句'));
    expect(
      find.byKey(bubbleActionsBarKey),
      findsOneWidget,
      reason: '★ 按住 600ms 那一条没摆出来（真机上它必须出得来）',
    );
    // 🔴 **不许是弹层**：`showModalBottomSheet` 摆出来的是一张 `BottomSheet`
    //    ＋一层铺满全屏的 `ModalBarrier` —— 那正是"整个窗口当场死掉"那条老路。
    expect(
      find.byType(BottomSheet),
      findsNothing,
      reason: '★ 摆出来的又是一层弹出来的底部单子 ⇒ 它的 barrier 会把窗口吃掉',
    );

    // ① 时间线照样能滑（老那一版：这一拖会被 barrier 吃掉，一点不动）
    await tester.drag(find.byType(ListView).first, const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(
      pos.pixels,
      lessThan(bottom - 100),
      reason: '★ 那一条摆着的时候时间线滑不动了 —— 屏幕上就是"无法滚动聊天窗口"',
    );

    // ② 发送照样发得出去（老那一版：这张单子整个盖住输入条）
    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    expect(_sendReady(tester), isTrue, reason: '★ 有字了发送钮还是灰的');
    await tester.tap(find.byTooltip('发送'), warnIfMissed: true);
    await tester.pumpAndSettle();
    expect(r.says.length, 1, reason: '★ 那一条摆着的时候点发送没反应（真机上就是"收起才能发送"）');
    expect(r.says.single, contains('在吗'));

    // ③ 它是**非模态**的：发完还在（用户自己收）
    expect(find.byKey(bubbleActionsBarKey), findsOneWidget, reason: '★ 那条不该被别人的动作挤没');
  });

  testWidgets('对照组：**短按**气泡 ⇒ 那一条不许冒出来（而且本来就什么都不该挡）', (tester) async {
    final r = _controller();
    _feed(r.c, 40);
    await _pump(tester, r.c);
    await _expand(tester);
    await _drainFrames(tester);

    await tester.tap(find.text('第 40 句'));
    await tester.pumpAndSettle();
    expect(find.byKey(bubbleActionsBarKey), findsNothing, reason: '★ 轻轻点一下不该把那条摆出来');

    final pos = _transcript(tester);
    final bottom = pos.maxScrollExtent;
    await tester.drag(find.byType(ListView).first, const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(pos.pixels, lessThan(bottom - 100), reason: '★ 对照组：这一屏本来就该滑得动');

    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'), warnIfMissed: true);
    await tester.pumpAndSettle();
    expect(r.says.length, 1, reason: '★ 对照组：没摆那条的时候发送本来就是好的');
  });

  // ── ② 那一条自己的出口（不是摆设：按了要真收起来）──────────────

  testWidgets('那一条上【算了】⇒ 收起来；【多选】⇒ 换成多选那条工具条', (tester) async {
    final r = _controller();
    _feed(r.c, 6);
    await _pump(tester, r.c);
    await _expand(tester);
    await _drainFrames(tester);

    await _hold(tester, find.text('第 6 句'));
    expect(find.byKey(bubbleActionsBarKey), findsOneWidget);
    await tester.tap(find.text(bubbleMenuCancel));
    await tester.pumpAndSettle();
    expect(find.byKey(bubbleActionsBarKey), findsNothing, reason: '★【算了】没收起来');

    await _hold(tester, find.text('第 6 句'));
    expect(find.byKey(bubbleActionsBarKey), findsOneWidget);
    await tester.tap(find.text(bubbleMenuSelect));
    await tester.pumpAndSettle();
    expect(find.byKey(bubbleActionsBarKey), findsNothing, reason: '★ 进了多选态 ⇒ 长按那一条该收起');
    expect(find.byType(BubbleSelectBar), findsOneWidget, reason: '★【多选】没进多选态');
  });

  // ── ③ 🔴 手机宽度：横滚条不许被一个"什么都不画"的 Spacer 吃掉一半 ──

  testWidgets('🔴 手机宽 390：横滚条至少得装得下**一整颗**动作（Spacer 吃掉一半 = 红）', (tester) async {
    const size = Size(390, 844);
    final r = _controller();
    _feed(r.c, 6);
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await _pump(tester, r.c);
    await _expand(tester);
    await _drainFrames(tester);

    final strip = tester.getRect(find.byKey(chatActionsStripKey));
    expect(strip.width, greaterThan(0), reason: '★ 动作条没量到');
    // 🔴 「过程」是这一串里**最后一个**（`reverse: true` ⇒ 它一定贴着视口右缘）。
    //    读数（390 宽）：有那个 `Spacer` ⇒ 条 35.4 宽，「过程」被切掉半个；
    //    拿掉它 ⇒ 条 53 宽，「过程」整颗在里面。
    final last = tester.getRect(find.text(levelActionWords));
    expect(
      last.left >= strip.left - 0.5 && last.right <= strip.right + 0.5,
      isTrue,
      reason: '★ 横滚条（$strip）连最后那一颗「$levelActionWords」（$last）都装不下 —— '
          '屏幕上就是"那一排按钮点不开"',
    );
  });

  testWidgets('对照组：宽屏 800 ⇒ 那一串动作**一颗都不缺**、全在视口里、点得动', (tester) async {
    final r = _controller();
    _feed(r.c, 6);
    await _pump(tester, r.c); // 默认 800×600
    await _expand(tester);
    await _drainFrames(tester);
    final strip = tester.getRect(find.byKey(chatActionsStripKey));
    for (final w in const [trashTooltip, exportTooltip, levelActionWords]) {
      final rect = tester.getRect(find.text(w));
      expect(
        rect.left >= strip.left - 0.5 && rect.right <= strip.right + 0.5,
        isTrue,
        reason: '★ 宽屏下「$w」（$rect）居然不在横滚条（$strip）里',
      );
      // ⚠️ `warnIfMissed`：点得到才算数（落在视口外会报出来）
      await tester.tap(find.text(w), warnIfMissed: true);
      await tester.pumpAndSettle();
      // 前两条各进一屏（回收站 / 导出）⇒ 退回来继续下一颗；
      // 最后一条（过程）弹的是那层面板，留着不收（用例到此为止）。
      if (w != levelActionWords) {
        await tester.pageBack();
        await tester.pumpAndSettle();
      }
    }
  });
}
