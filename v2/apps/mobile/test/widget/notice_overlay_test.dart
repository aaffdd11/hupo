// 「系统通知」**画到屏幕上之后**长什么样（契约 `docs/dev/29-NOTICE.md`）。
//
// 这一份钉四件事，每一件都是主人定死的：
//
//   ✅ 约束 1 · **浮窗是 overlay**：盖在内容上、**一个像素都不挤动下面**。
//      判据是 **D4.8：高度变化 = 0px** —— 见 `🔴 浮窗出现前后：下面一个字都没动`。
//      那一条量的是**同一个矩形**（`tester.getRect` 前后比对），
//      不是"看起来像浮着"：把浮窗塞进 `Column` 它当场就红。
//   ✅ 约束 2 · **时间线里必须有那一条**（进列表、跟着滚）。
//   ✅ 约束 3 · **撤销有两份**：浮窗里一个 + 时间线里一个，**同一件事**。
//   ✅ §三① · `notice/urgent` 是**瞬态**：只在浮窗里，**不进时间线**，
//      而且**必须自己说清**"这条没能写进记录里"。
//
// ⚠️ 纯逻辑那半边在 `test/unit/notice_test.dart`（解析 / fail-closed / 不重写文案）。
// ⚠️ 五档不溢出 + 命中区 ≥44 那两道硬闸在 `test/widget/accessibility_test.dart`
//    （这一条通知的两个入口都进了那份扫描，**从真入口进**）。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/notice_words.dart';
import 'package:hupo_app/models/trash_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/timeline_store.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/notice.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// ⚠️ **服务端给的那两句话**（`29-NOTICE.md` §5.1 那张表）。
///    它们住在**这份测试里**正是重点：客户端不许有它们的模板
///    （`test/unit/notice_test.dart` 有一条源码级断言钉着）。
const _expiringText = '有一条过几天会彻底删掉';
const _diskFullText = '盘满了，这条我没能记下来';

/// 撤销的参数（服务端给的）。
const _ids = ['u_x', 'm_y'];

/// 那份 `undo`（服务端给的，**按钮上的字也是**）。
const _undo = {'label': '拿回来', 'action': 'trash/restore', 'messageIds': _ids};

/// 撤销按钮上那几个字（**服务端给的那份**）。
const _undoLabel = '拿回来';

const _minTouch = 44.0;

http.Response _json(String body, [int status = 200]) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// 一个假服务端：记下每一次 `trash/restore` 发的是什么（**撤销走的是哪条路**）。
class _Server {
  final calls = <Map<String, dynamic>>[];
  int restoreStatus = 200;

  MockClient get client => MockClient((r) async {
        if (r.url.path == '/api/trash/restore') {
          calls.add(jsonDecode(r.body) as Map<String, dynamic>);
          return _json('{"ok":true}', restoreStatus);
        }
        return _json('{}');
      });
}

ChatController _controller({_Server? server, TimelineStore? local}) {
  final c = ChatController(
    api: Api(client: server?.client ?? _Server().client),
    tokens: TokenStore(),
    token: 'tok',
    local: local,
  );
  addTearDown(c.dispose);
  return c;
}

/// 一条持久通知（带号 ⇒ 进时间线、也进本机缓存）。
Map<String, dynamic> _notice({
  String kind = 'expiring',
  String text = _expiringText,
  Map<String, dynamic>? undo = _undo,
  int seq = 7,
  bool catchUp = false,
}) =>
    {
      'type': 'notice',
      'kind': kind,
      'text': text,
      'at': 1758400000000,
      'seq': seq,
      if (catchUp) 'catchUp': true,
      if (undo != null) 'undo': undo,
    };

Map<String, dynamic> _urgent({String kind = 'disk-full', String text = _diskFullText}) =>
    {'type': 'notice/urgent', 'kind': kind, 'text': text};

Future<void> _pump(WidgetTester tester, ChatController c, {bool caughtUp = true}) async {
  await tester.pumpWidget(MaterialApp(home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
  await tester.pump();
  // ⚠️ **真实路径上服务端一定会发这条**（`client/hello` ⇒ 上层收到 `__caught_up__`）：
  //    它之后到达的才叫"现在发生的"。所以"已经连上"的用例都从这一句开始；
  //    要测"首屏那段历史"的用例显式传 `caughtUp: false`。
  if (caughtUp) c.ingest({'type': '__caught_up__'});
}

/// 浮窗里那句通知正文（**指得准**：正文在时间线里也有一份 ⇒ 不许裸 `find.text`）。
Finder _overlayText() => find.descendant(of: find.byType(NoticeOverlay), matching: find.text(_expiringText));

/// 浮窗里那个撤销按钮上的字。
Finder _overlayUndo() =>
    find.descendant(of: find.byType(NoticeOverlay), matching: find.text(_undoLabel));

/// 时间线里那个撤销按钮上的字。
Finder _lineUndo() =>
    find.descendant(of: find.byType(NoticeLine), matching: find.text(_undoLabel));

/// 灌一条通知进去（**从真入口**：控制器收服务端事件那条路）。
Future<void> _arrive(WidgetTester tester, ChatController c, Map<String, dynamic> e) async {
  c.ingest(e);
  await tester.pump();
}

/// 把浮窗收掉再结束这一条 —— 否则那个"自己消失"的钟会留着。
///
/// ⚠️ 这不是测试洁癖：`AutomatedTestWidgetsFlutterBinding` 在**每条用例结束时**
///    会断言 "A Timer is still pending even after the widget tree was disposed"，
///    而这个钟**是这一件要的功能本身**（浮窗自己走）。
///    ⇒ 每条用例要么**走过那个钟**，要么**把它收掉**，不许挂着走。
Future<void> _closeNotice(WidgetTester tester, ChatController c) async {
  c.dismissNotice();
  await tester.pump();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // ── 约束 1：浮窗是 overlay，**不挤动任何东西**（D4.8：0px）──────────

  testWidgets('🔴 浮窗出现前后：下面**一个像素都没动**（D4.8：高度变化 = 0px）', (tester) async {
    final c = _controller();
    await _pump(tester, c);

    // 通知来之前：把下面那几样东西的**矩形**记下来。
    // ⚠️ `chatBodyKey` 就是"下面"那一整块（状态条 + 内容 + 输入框）：
    //    浮窗只要参与布局（塞进 `Column` / 变成非 positioned 的兄弟 / 加个
    //    `Flexible`），这一块的矩形当场就变 —— 判据是 **0px**。
    // ⚠️ 为什么不用空屏那句正文当锚：通知一到，时间线上就有东西了，
    //    空屏**整块消失**（`_EmptyState` 不在了）⇒ 拿它当锚会比较"有 vs 无"，
    //    那不是 0px 的判据。所以锚必须是**一直都在**的那一块。
    final contentBefore = tester.getRect(find.byKey(chatBodyKey));
    final appbarBefore = tester.getRect(find.text('助手'));
    final composerBefore = tester.getRect(find.byType(TextField).first);

    await _arrive(tester, c, _notice());

    // 正对照：浮窗**真的在屏幕上**（否则"什么都没动"也可能是"什么都没画"）
    expect(_overlayText(), findsOneWidget, reason: '浮窗没画出来 ⇒ 这条闸是空转的');
    expect(find.byType(NoticeOverlay), findsOneWidget);
    // 而且它**真的有大小**（0 高的话，"不挤动"是句废话）
    final overlay = tester.getSize(find.byType(NoticeOverlay));
    expect(overlay.height, greaterThan(0), reason: '浮窗是 0 高 ⇒ 这条闸量的是一个不存在的东西');

    // ★★ 判据：同一个东西、同一个矩形 —— **前后一字不差**（0px）
    expect(tester.getRect(find.byKey(chatBodyKey)), contentBefore,
        reason: '★ 浮窗把下面的内容挤动了（D4.8 判据是 0px）。'
            '浮窗是 overlay：它只能盖在内容上，不许参与布局。');
    expect(tester.getRect(find.text('助手')), appbarBefore, reason: '★ 连顶栏都被挤了');
    expect(tester.getRect(find.byType(TextField).first), composerBefore,
        reason: '★ 输入框被挤了 —— 主人最在意的那一处');
    await _closeNotice(tester, c);
  });

  testWidgets('🔴 浮窗**盖在内容上面**（不是把内容推到旁边去）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _arrive(tester, c, _notice());

    final overlay = tester.getRect(find.byType(NoticeOverlay));
    final screen = tester.getRect(find.byType(MaterialApp));
    // 它贴着上面那条边、横跨整宽（"从上面来的通知"）
    expect(overlay.top, closeTo(screen.top, 0.5));
    expect(overlay.left, closeTo(screen.left, 0.5));
    expect(overlay.right, closeTo(screen.right, 0.5));
    await _closeNotice(tester, c);
  });

  testWidgets('浮窗**会自己消失**（而且消失之后不挤动任何东西 —— 0px 是双向的）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    final contentBefore = tester.getRect(find.byKey(chatBodyKey));

    await _arrive(tester, c, _notice());
    expect(find.byType(NoticeOverlay), findsOneWidget);
    // 浮窗在的时候，下面那一块一动没动
    expect(tester.getRect(find.byKey(chatBodyKey)), contentBefore);

    // ⚠️ 时长住在控制器里（`noticeLinger`）——**不许写进任何给用户看的话**。
    // ⚠️ 两拍：第一拍让那个钟到点，第二拍才把新的一帧画出来。
    await tester.pump(ChatController.noticeLinger);
    await tester.pump();
    expect(find.byType(NoticeOverlay), findsNothing, reason: '浮窗不会自己消失 ⇒ 它就成了一个常驻的条');
    expect(find.text(_expiringText), findsOneWidget, reason: '浮窗没了，时间线里那一条还在');
    // ★ 时间线那一条**不跟着消失**（约束 2：撤销窗口不能随浮窗一起走）
    expect(find.byType(NoticeLine), findsOneWidget, reason: '★ 浮窗没了，时间线里那一条必须还在');
    // 而且下面还是老样子（0px 是**双向**的：出现时没挤、消失时也没弹回来）
    expect(tester.getRect(find.byKey(chatBodyKey)), contentBefore);
  });

  // ── 约束 2：时间线里那一条 ────────────────────────────────────

  testWidgets('🔴 时间线里**留了一条**，浮窗没了它还在（它经得起"你不在"）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _arrive(tester, c, _notice());

    expect(find.byType(NoticeLine), findsOneWidget);
    expect(tester
        .widget<NoticeLine>(find.byType(NoticeLine))
        .notice
        .text, _expiringText);
    // 跟着滚：它在列表里（不是一个浮着的条）
    expect(find.ancestor(of: find.byType(NoticeLine), matching: find.byType(ListView)),
        findsOneWidget);
    await _closeNotice(tester, c);
  });

  testWidgets('★ 冷启动那一屏（本机缓存重放）：时间线里有它，但**不弹浮窗**', (tester) async {
    // 上一次开机：这条通知在缓存里（带号 ⇒ 进得了缓存）
    await TimelineStore().save([_notice()]);
    final c = _controller(local: TimelineStore());
    // ⚠️ 不开真 socket：测的是**冷启动那一屏**
    await c.start(token: 'tok', openStream: false);
    await _pump(tester, c);

    expect(find.byType(NoticeLine), findsOneWidget, reason: '★ 通知必须经得起"你不在"');
    expect(find.byType(NoticeOverlay), findsNothing,
        reason: '补发上来的是**过去发生过的事**；冷启动一屏历史通知挨个往外弹是骚扰，也是假话');
  });

  // ── 约束 3：撤销有两份，而且是同一件事 ──────────────────────────

  testWidgets('🔴 浮窗里那个"撤销"走的是回收站那条路（`trash/restore` + 服务端给的 id）', (tester) async {
    final server = _Server();
    final c = _controller(server: server);
    await _pump(tester, c);
    await _arrive(tester, c, _notice());

    // 浮窗里那一个（按钮上的字是**服务端给的** `undo.label`）
    expect(_overlayUndo(), findsOneWidget);
    await tester.tap(_overlayUndo());
    await tester.pumpAndSettle();

    expect(server.calls.length, 1, reason: '★ 按了撤销却没发出请求');
    expect(server.calls.first['messageIds'], _ids);
    expect(server.calls.first.containsKey('confirm'), isFalse,
        reason: '撤销（拿回来）不是破坏性动作，契约没要 confirm');
    // 成没成都说一句
    expect(find.text(trashRestoredLine), findsOneWidget);
    // 撤销之后浮窗撤掉，而时间线里那一条**还在**（它记的是"发生过这件事"）
    expect(find.byType(NoticeOverlay), findsNothing);
    expect(find.byType(NoticeLine), findsOneWidget);
  });

  testWidgets('🔴 时间线里那个"撤销"**是同一件事**（同一条路、同一份 id）', (tester) async {
    final server = _Server();
    final c = _controller(server: server);
    await _pump(tester, c);
    await _arrive(tester, c, _notice());

    // 等浮窗自己走掉 ⇒ 屏幕上只剩时间线那一条（这才是"你回来之后"的样子）
    // ⚠️ 两拍：第一拍让那个钟到点（状态变了），第二拍才把新的一帧画出来
    await tester.pump(ChatController.noticeLinger);
    await tester.pump();
    expect(find.byType(NoticeOverlay), findsNothing);
    expect(find.byType(NoticeLine), findsOneWidget);

    // ⚠️ 先把它完整露出来再点（同 `accessibility_test` 那条理由：
    //    列表里被裁过的按钮，`tap` 会点空）
    await tester.ensureVisible(_lineUndo());
    await tester.pumpAndSettle();
    await tester.tap(_lineUndo());
    await tester.pumpAndSettle();
    expect(server.calls.length, 1, reason: '★ 时间线里那个撤销没走同一条路');
    expect(server.calls.first['messageIds'], _ids);
  });

  testWidgets('★ 撤销**没成**时如实说一句，而且时间线里那一条还在（不许把话说圆）', (tester) async {
    final server = _Server()..restoreStatus = 500;
    final c = _controller(server: server);
    await _pump(tester, c);
    await _arrive(tester, c, _notice());
    await tester.tap(_overlayUndo());
    await tester.pumpAndSettle();

    expect(find.text(trashRestoreFailedLine), findsOneWidget, reason: '成没成都要说');
    expect(find.byType(NoticeLine), findsOneWidget, reason: '没拿回来 ⇒ 那条通知不许从屏幕上消失');
  });

  testWidgets('没有 undo 的通知（续做那条）⇒ **两处都不画撤销**', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _arrive(tester, c, _notice(kind: 'resumed', undo: null));

    expect(find.byType(NoticeLine), findsOneWidget);
    expect(_overlayText(), findsOneWidget); // 浮窗里那句还在
    expect(find.text(_undoLabel), findsNothing, reason: '★ 没有 undo ⇒ 两处都不许出现那个按钮');
    await _closeNotice(tester, c);
  });

  // ── §三①：瞬态那条 ─────────────────────────────────────────

  testWidgets('🔴 瞬态通知：**只出现在浮窗里**、不进时间线，而且自己说清"没能写进记录里"', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _arrive(tester, c, _urgent());

    expect(find.byType(NoticeOverlay), findsOneWidget, reason: '写盘失败时它必须喊得出来（盘满正是它要报的事）');
    expect(find.byType(NoticeLine), findsNothing, reason: '★ 瞬态不占号 ⇒ 时间线里一条都不许有');
    expect(c.timeline.items, isEmpty, reason: '★ 模型那一层也不许有它');
    expect(find.text(_diskFullText), findsOneWidget, reason: '服务端那句话**照抄**');
    expect(find.text(noticeNotKeptLine), findsOneWidget,
        reason: '★ 必须自己说清：这条写不进记录，刷新就看不到了（§三①：例外时要明说）');

    // ⚠️ 浮窗不走 ⇒ 得能手动收掉（不然它会永久挂在屏幕上）
    await tester.tap(find.text(noticeDismissLabel));
    await tester.pumpAndSettle();
    expect(find.byType(NoticeOverlay), findsNothing);
  });

  // ── 判据之外，但错不起的两件 ────────────────────────────────

  testWidgets('不认识的 kind / 认不出的 action：**照实显示那句话**，但不给一个按不动的按钮', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _arrive(
      tester,
      c,
      _notice(kind: 'brand-new', undo: {'label': '拿回来', 'action': 'trash/purge', 'messageIds': _ids}),
    );

    expect(_overlayText(), findsOneWidget, reason: '认不出的只是分类，不是那句话');
    expect(find.text('brand-new'), findsNothing, reason: '内部线名绝不许上屏');
    expect(find.text(_undoLabel), findsNothing, reason: '★ 按了不会有结果的按钮不许画');
    await _closeNotice(tester, c);
  });

  // ── 命中区 ≥44（D3.6）：两处撤销各量一遍 ─────────────────────
  //
  // ⚠️ 硬闸在 `accessibility_test.dart`（那条通知的两个入口进了那份扫描，
  //    **从真入口进**）。这里量的是"这一处到底有没有 ≥44"的**直接证据**，
  //    而且量的同样是**语义矩形**（`padded` 那圈在 `InkWell` 外面，
  //    量内框会误报 —— `13-A11Y.md` §三 那次的教训）。

  testWidgets('🔴 浮窗里那个撤销：命中区 ≥44', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _arrive(tester, c, _notice());

    final r = tester.getSemantics(_overlayUndo()).rect;
    expect(r.width >= _minTouch && r.height >= _minTouch, isTrue,
        reason: '★ 浮窗里的撤销命中区只有 ${r.size}（D3.6：视觉可以小，命中区不许小）');
    await _closeNotice(tester, c);
  });

  testWidgets('🔴 时间线里那个撤销：命中区 ≥44（撤销窗口不能随浮窗一起消失）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _arrive(tester, c, _notice());
    // 等浮窗走掉 ⇒ 屏幕上只剩时间线那一条的按钮
    await tester.pump(ChatController.noticeLinger);
    await tester.pump();
    expect(find.byType(NoticeOverlay), findsNothing);

    await tester.ensureVisible(_lineUndo());
    await tester.pumpAndSettle();
    final r = tester.getSemantics(_lineUndo()).rect;
    expect(r.width >= _minTouch && r.height >= _minTouch, isTrue,
        reason: '★ 时间线里的撤销命中区只有 ${r.size}');
  });

  // ─────────────────────────────────────────────────────────────
  // 🔴 2026-09-22：主人报的那个现象 —— 这是他报的原话：
  //    *"登录后，出现刚才出了点事，我已经重来了。但是其他手机的并没有出现这段话。"*
  //
  // 查下来是**两边各说各话**：服务端（决策 P-h）说"`sinceSeq == 0` 是历史本身，
  // 不是补发" ⇒ **故意不打 `catchUp`**；而客户端把"没打 catchUp"当成了"现在发生的"
  // ⇒ 冷启动整段历史都被喊了一遍。于是那条**很久以前**的崩溃通知每次登录都弹。
  // ─────────────────────────────────────────────────────────────

  testWidgets('🔴 首屏那段历史里的通知**不弹浮窗**（时间线里照样留着）', (tester) async {
    final c = _controller();
    await _pump(tester, c, caughtUp: false); // ← 还在读首屏那段历史

    // ① 连上之后、`__caught_up__` 之前到达的 ⇒ 那是**历史**
    c.ingest(_notice(kind: 'crash', text: _expiringText));
    await tester.pump();

    expect(find.byType(NoticeOverlay), findsNothing,
        reason: '★ 历史通知不许弹浮窗 —— 弹了就是"每次登录都喊一次"（通知疲劳 + 假话）');
    // ⚠️ 但**时间线里必须有它**：通知要经得起"你不在"（约束 2），
    //    所以判据的另一半是"它还在"（不许为了不弹就把它吞掉）。
    expect(find.text(_expiringText), findsOneWidget, reason: '★ 不许为了不弹浮窗就把这一条吞掉');
  });

  testWidgets('🔴 读到 `client/hello` 之后**新来**的通知 ⇒ 必须弹（别修过头）', (tester) async {
    final c = _controller();
    await _pump(tester, c, caughtUp: false); // 先处在"还在读历史"那一相位

    c.ingest(_notice(kind: 'crash', text: _expiringText)); // 历史：不弹
    c.ingest({'type': '__caught_up__'}); // 服务端说：补发到此为止
    await tester.pump();
    expect(find.byType(NoticeOverlay), findsNothing, reason: '历史那一条仍然不许弹');

    c.ingest(_notice(kind: 'expiring', text: _expiringText, seq: 8)); // 现在发生的
    await tester.pump();
    expect(find.byType(NoticeOverlay), findsOneWidget,
        reason: '★ 连上之后新来的通知**必须**弹 —— 不然就是把"现在喊你"也一起修没了');

    // ⚠️ 收尾：让它那个"自己消失"的钟走完（不然测试框架会报"还有定时器没结束"）
    await tester.pump(ChatController.noticeLinger);
    await tester.pump();
  });
}
