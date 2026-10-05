// 「系统通知」**画到屏幕上之后**长什么样（契约 `docs/dev/144-NO-NOTICE-OVERLAY.md`）。
//
// 🔴 **2026-09-30 主人改了口径**（原话）：
//    *「顶部会出来一个浮窗，叫我去做做完叫你。这个不对。**不要浮窗**。」*
//    ⇒ 从前那条"**浮窗喊一声**"（`29-NOTICE.md` 约束 1）**撤了**。今天的两条路：
//
//      · **带号的通知**（"我去做，做完叫你" / "做完了" / "这件事我没做完"…）
//        ⇒ **只进时间线**（`NoticeLine`，在列表里、跟着滚、经得起"你不在"）。
//          屏幕上**只出现一次** —— 从前是"时间线一条 ＋ 顶上飘一条"（两处）。
//      · **瞬态那条**（`notice/urgent`：写盘失败）⇒ 画在**浮窗里面**
//        （输入条上面那一条，与排队那条同一种形状）—— 它**不进时间线**
//        （物理上写不进去），所以必须自己说清"这条没能写进记录里"（`29-NOTICE.md` §三①）。
//
// ⚠️ **一条都不许浮在内容上面**：这两条都参与布局（判据见下）。
//    从前那条 overlay 的"D4.8 ＝ 0px"判据**还在**（新增助手消息不许挤动布局），
//    只是不再由通知来犯这个错。
//
// ⚠️ 纯逻辑那半边在 `test/unit/notice_test.dart`。
// ⚠️ 五档不溢出 ＋ 命中区 ≥44 那两道硬闸在 `test/widget/accessibility_test.dart`。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/notice_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/timeline_store.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/notice.dart';
import 'package:hupo_app/widgets/voice_bar.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// ⚠️ **服务端给的那几句**（`29-NOTICE.md` §5.1）。住在测试里正是重点：
///    客户端不许有它们的模板（`test/unit/notice_test.dart` 有一条源码级断言钉着）。
const _expiringText = '有一条过几天会彻底删掉';
const _diskFullText = '盘满了，这条我没能记下来';

const _ids = ['u_x', 'm_y'];
const _undo = {'label': '拿回来', 'action': 'trash/restore', 'messageIds': _ids};
const _undoLabel = '拿回来';

http.Response _json(String body, [int status = 200]) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// 一个假服务端：记下每一次 `trash/restore` 发的是什么。
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
  await tester.pumpWidget(MaterialApp(
      home: ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {})));
  await tester.pump();
  if (caughtUp) c.ingest({'type': '__caught_up__'});
}

/// 灌一条通知进去（**从真入口**：控制器收服务端事件那条路）。
Future<void> _arrive(WidgetTester tester, ChatController c, Map<String, dynamic> e) async {
  c.ingest(e);
  await tester.pump();
}

/// 把那条会自己走的通知收掉（`AutomatedTestWidgetsFlutterBinding` 会断言没有挂着的钟）。
Future<void> _closeNotice(WidgetTester tester, ChatController c) async {
  c.dismissNotice();
  await tester.pump();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // ── 一、带号的通知：**只进时间线**，一个浮的东西都不许有 ──────────────

  testWidgets('🔴 带号的通知 ⇒ 屏幕上**只出现一次**（时间线里那一条）', (tester) async {
    final c = _controller();
    await _pump(tester, c);

    // 通知来之前，把**底下那一格**（语音条）的矩形记下来。
    // ⚠️ 锚**不能用 `chatBodyKey`**：通知一到，时间线上就有东西了、空屏整块消失
    //    ⇒ 那一块的矩形本来就会变（从前那版测试的注释里写过这个坑）。
    // ⚠️ 原来锚的是**输入框**（`find.byType(TextField)`）—— 2026-10-04 起底下那一格
    //    改成"语音优先"（手册 `D3.14`：不再有输入框）⇒ 改锚**那一格本身**（`VoiceBar`），
    //    守的还是同一件事：通知**不许把它挤动**。
    final composerBefore = tester.getRect(find.byType(VoiceBar));

    await _arrive(tester, c, _notice());

    // 正对照：时间线里那条**真的画出来了**（否则"没有浮窗"也可能是"什么都没画"）
    expect(find.byType(NoticeLine), findsOneWidget, reason: '★ 通知必须进时间线（经得起"你不在"）');
    expect(tester.widget<NoticeLine>(find.byType(NoticeLine)).notice.text, _expiringText);
    // 🔴 **主人 2026-09-30 要的那一条**：不再有第二个入口
    expect(find.byType(NoticeStrip), findsNothing, reason: '★ 又来一个浮的/第二个入口 = 主人说的那个"浮窗"');
    expect(find.text(_expiringText), findsOneWidget, reason: '★ 同一句话画了两遍（时间线一份 ＋ 别处一份）');
    // 而且它**在列表里**（不是一个浮着的条）
    expect(find.ancestor(of: find.byType(NoticeLine), matching: find.byType(ListView)),
        findsOneWidget);
    // 底下那一格一个像素都没动（通知**不参与**"浮"这件事）
    expect(tester.getRect(find.byType(VoiceBar)), composerBefore,
        reason: '★ 通知把底下那一格挤动了 —— 主人最在意的那一处');
  });

  testWidgets('★ 冷启动那一屏（本机缓存重放）：时间线里有它，什么都不弹', (tester) async {
    await TimelineStore().save([_notice()]);
    final c = _controller(local: TimelineStore());
    await c.start(token: 'tok', openStream: false);
    await _pump(tester, c);

    expect(find.byType(NoticeLine), findsOneWidget, reason: '★ 通知必须经得起"你不在"');
    expect(find.byType(NoticeStrip), findsNothing);
    expect(find.text(_expiringText), findsOneWidget);
  });

  // ── 二、瞬态那条（写盘失败）：画在**浮窗里面**，不浮在内容上 ──────────

  testWidgets('🔴 瞬态那条 ⇒ 画在**浮窗里面**（不是浮在内容上面），而且时间线里没有它', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    final bodyBefore = tester.getRect(find.byKey(chatBodyKey));

    await _arrive(tester, c, _urgent());

    expect(find.byType(NoticeStrip), findsOneWidget, reason: '★ 盘满了这条谁也不说 = 静默（N11 不许）');
    expect(find.text(_diskFullText), findsOneWidget);
    // 时间线里**没有**它（时间线物理上写不进这一条）
    expect(find.byType(NoticeLine), findsNothing);
    // 🔴 它在**浮窗里面**（当年那个浮窗是 `Positioned(top:0)` 浮在内容上面）
    final floater = tester.getRect(find.byType(ChatFloater));
    final strip = tester.getRect(find.byType(NoticeStrip));
    expect(floater.contains(strip.topLeft) && floater.contains(strip.bottomRight), isTrue,
        reason: '★ 它跑到浮窗外面去了（那又成了一个"浮在内容上面"的东西）');
    // ⚠️ 它**参与布局**（画在输入条上面那一条里）⇒ 时间线那一块会矮一点点 ——
    //    这是**要的**（与排队那条同一种形状）；不许的是"浮在内容上面"。
    expect(bodyBefore.height, greaterThan(0));
    // 必须自己说清"这条没能写进记录里"（`29-NOTICE.md` §三①）
    expect(find.text(noticeNotKeptLine), findsOneWidget);
    await _closeNotice(tester, c);
  });

  testWidgets('瞬态那条**会自己消失**（时间线那一条不会跟着走）', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _arrive(tester, c, _urgent());
    expect(find.byType(NoticeStrip), findsOneWidget);

    await tester.pump(ChatController.noticeLinger);
    await tester.pump();
    expect(find.byType(NoticeStrip), findsNothing, reason: '它不会自己消失 ⇒ 那成了一条常驻的条');
  });

  // ── 三、撤销：**只剩时间线那一处**，而且仍是同一条路 ────────────────

  testWidgets('🔴 通知上**不再有**「撤销」（那条路 2026-10-03 砍了）', (tester) async {
    // 🔴 主人 2026-10-03：*「回收站，导出，过程，我们也不需要。」*（甲：功能一起删掉）
    //    ⇒ 通知照旧上屏（那是服务端的事实），但**一个按钮都不挂**。
    //    ⚠️ 负向对照就在这条里：先证明那句话**真画出来了**，再证明按钮不在 ——
    //      不然"没扫到"可能是因为整条通知都没进树。
    final server = _Server();
    final c = _controller(server: server);
    await _pump(tester, c);
    await _arrive(tester, c, _notice());
    expect(find.byType(NoticeLine), findsOneWidget, reason: '★ 那条通知该在屏幕上');
    expect(find.text(_undoLabel), findsNothing, reason: '★ 撤销那条路砍了，不该再画它');
    expect(server.calls, isEmpty, reason: '★ 什么都没按 ⇒ 一个请求都不该发');
  });

  testWidgets('没有 undo 的通知（续做那条）⇒ **不画**撤销按钮', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _arrive(tester, c, _notice(kind: 'resumed', text: '有一件只读的活我接着做', undo: null));

    expect(find.byType(NoticeLine), findsOneWidget);
    expect(find.text(_undoLabel), findsNothing, reason: '★ 不给一个按不动的按钮');
  });

  testWidgets('不认识的 kind / 认不出的 action：照实显示那句话，但**不给按不动的按钮**', (tester) async {
    final c = _controller();
    await _pump(tester, c);
    await _arrive(tester, c, {
      'type': 'notice',
      'kind': '未来才有的那种',
      'text': '一句我们认不出类型的话',
      'at': 1758400000000,
      'seq': 9,
      'undo': {'label': '拿回来', 'action': 'future/undo', 'messageIds': _ids},
    });

    expect(find.text('一句我们认不出类型的话'), findsOneWidget, reason: '★ 服务端那句话照抄');
    expect(find.text(_undoLabel), findsNothing, reason: '★ 认不出的动作不许画成按得动的按钮');
  });

}
