// 可访问性三样里**能在 v2 落地的那两样**（手册 D3.5 / D3.6）。
//
// ⚠️ 这一份是**硬闸**，不是"提示档"。
//    手册的通用规矩是"`test/widget` 只是提示不是闸"，但 **D3.5 专门把这一条写成了硬闸**：
//    "**尺寸随字算**（容器跟字，不是字跟容器）；**不封顶**——
//     改成**硬闸**：五档 pump **无溢出**"。⇒ 决策点名要硬闸的，不按通用规矩走。
//
// ── 五档是哪儿来的 ──────────────────────────────────────────
// D3.5 的"五档"：**1.0 / 1.3 / 1.75 / 2.0 / 3.1**。
// ⚠️ 3.1 不是随便写的：那是"字号调到最大"那一档，而走查里最实在的一条故障
//    就是"**字大了、笼子没大**"——1.75 倍就溢出。
//
// ── 第三样（甩）为什么不在这一份里 ───────────────────────────
// D3.7 的"甩"是**浮动面板**的手势（下甩收起 / 上甩拉满）。
// **v2 的客户端里没有浮动面板、也没有任何拖拽手势** ⇒ 没有落点。
// 它不是"没做"，是**在 v2 的界面上不成立**（见 `docs/dev/13-A11Y.md` §二）。

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/export_words.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/models/trash_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/screens/landing_screen.dart';
import 'package:hupo_app/screens/login_screen.dart';
import 'package:hupo_app/screens/model_key_screen.dart';
import 'package:hupo_app/screens/waiting_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/notice.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// D3.5 点名的五档。
const scales = <double>[1.0, 1.3, 1.75, 2.0, 3.1];

/// D3.6 点名的下限。
const minTouch = 44.0;

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

Widget _login() => LoginScreen(api: Api(base: 'http://127.0.0.1:1'), onLoggedIn: (String _) {});

/// ⚠️ 字号必须注在 **`MaterialApp` 里面**，不能包在外面。
///    `MaterialApp` 会按 View 自己造一个 MediaQuery、**把外面那个盖掉**——
///    包在外面的话这些测试**全跑在 1.0x**，而它们照样是绿的。
///    （这个坑是被"不封顶"那条测试抓出来的：它断言 3.1x 真的更大，结果没更大。）
Future<void> _pump(WidgetTester tester, Widget child, double scale) async {
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, inner) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
        child: inner!,
      ),
      home: child,
    ),
  );
  await tester.pump();
}

/// 把 pump 期间攒下来的异常全取出来（**溢出就是这么报的**）。
List<Object> _drain(WidgetTester tester) {
  final out = <Object>[];
  for (var e = tester.takeException(); e != null; e = tester.takeException()) {
    out.add(e);
  }
  return out;
}

/// **像用户那样**打开关于页：主界面 → 顶栏「配置」→ 里面的「关于」。
///
/// ⚠️ 直接把 `AboutScreen` 当 `home` 泵出来的话，它**没有返回键**
///    （没有可弹回去的路由）⇒ 命中区扫描会"一个能点的都没扫到"，
///    然后被那条负向对照拦下来。**那条负向对照是对的** —— 它说的就是
///    "扫描是空转的"。⇒ 用真入口进。
///
/// ⚠️ 2026-09-22 改：**「关于」从顶栏搬进了「配置」**（主人要在页面上唤起配置；
///    顶栏再加一个图标就是 7 个 —— 手机上那一条会挤成一团）。
///    ⇒ 这一条闸也跟着走**真入口**，一步都不少。
Future<void> _openAbout(WidgetTester tester, double scale) async {
  await _openConfig(tester, scale);
  // ⚠️ **先滚到「关于」那儿再点**（2026-09-22 配置页改成"卡片 + 可滚列"之后抓到的）：
  //    大字号下它在**折叠线以下**，而 `ListView` **不会把屏幕外的孩子建出来**
  //    ⇒ 直接 `find.text('关于')` 会"一个都没找到"（而人是要滚一下的）。
  //    ⇒ 判据**像用户那样滚**（`scrollUntilVisible`），不是把那一行硬塞进屏幕。
  await tester.scrollUntilVisible(
    find.text('关于'),
    240,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('关于'));
  await tester.pumpAndSettle();
}

/// **像用户那样**打开「配置」：主界面顶栏那个齿轮。
Future<void> _openConfig(WidgetTester tester, double scale) async {
  await _pump(
    tester,
    ChatScreen(initialTier: FloaterTier.full, 
      controller: _controller(),
      onLoggedOut: () {},
      space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: false),
      onSendKey: (_) async => KeySend.ok,
    ),
    scale,
  );
  await tester.tap(find.byTooltip(configEntry));
  await tester.pumpAndSettle();
}

/// **像用户那样**打开过程四档的切换面板（批 3 新加的入口）。
///
/// ⚠️ 和关于页同一条理由：新加的界面**必须也过五档不溢出那道硬闸**，
///    不然"五档不溢出"会随时间失效。
Future<void> _openProcessMenu(WidgetTester tester, double scale) async {
  await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: _controller(), onLoggedOut: () {}), scale);
  await tester.tap(find.byTooltip('它说多少过程'));
  await tester.pumpAndSettle();
}

/// 一份"过程那一块拉满"的控制器：步骤流水 + 推理原文都在屏幕上。
///
/// ⚠️ 用**最高的那一档**（`reasoning`）：它同时包含步骤流水与推理原文，
///    也就是这一批新加的两样最多的字。
/// ⚠️ 推理原文**挂在气泡上** ⇒ 得先有 `message/start`，否则它只是"待挂"、
///    一个像素都不画（那道闸就白量了）。
Future<ChatController> _processController() async {
  final c = _controller();
  await c.setLevel(ProcessLevel.reasoning);
  c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
  c.ingest({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
  c.ingest({'type': 'step/start', 'turn': 1, 'step': 2, 'state': 'writing'});
  c.ingest({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
  c.ingest({'type': 'message/text', 'messageId': 'm1', 'block': 'quick', 'text': '这周 7 小时。', 'seq': 2});
  c.ingest({'type': 'reasoning/delta', 'turn': 1, 'text': '他问的是这周，我先把账翻出来对一下。'});
  return c;
}

/// 一份"什么内容都有"的时间线：四态、快答+深答、标记、断了的那条。
void _stuff(Timeline t) {
  t.addLocalUtterance('帮我把这周工时记一下', 'u_1');
  t.setLocalState('u_1', MessageState.failed); // 会渲染出"重发"入口
  t.addLocalUtterance('第二条：查一下明天的天气怎么样，要出门', 'u_2');
  t.apply({'type': 'message/start', 'messageId': 'm1', 'seq': 2});
  t.apply({'type': 'message/text', 'messageId': 'm1', 'block': 'quick', 'text': '收到，我查一下。', 'seq': 3});
  t.apply({'type': 'message/text', 'messageId': 'm1', 'block': 'deep', 'text': '明天晴，最高 26 度。', 'seq': 4});
  t.apply({'type': 'message/end', 'messageId': 'm1', 'seq': 5, 'reason': 'completed'});
  t.apply({'type': 'message/start', 'messageId': 'm2', 'seq': 6});
  t.apply({
    'type': 'message/text',
    'messageId': 'm2',
    'block': 'quick',
    'text': '这条我说太长了，被长度限制截断，剩下的我没说完。',
    'seq': 7,
  });
  t.apply({'type': 'message/end', 'messageId': 'm2', 'seq': 8, 'reason': 'failed'});
  t.apply({'type': 'timeline/marker', 'kind': 'away', 'seq': 9});
}

// ── 批 3「删掉 / 回收站」那一批（`28-DELETE.md`）新加的界面 ──────────
//
// ⚠️ 和关于页 / 过程四档同一条理由：**新加的界面必须也过这两道闸**，
//    不然"五档不溢出 + 命中区 ≥44"会随时间失效。
// ⚠️ 全部**从真入口进**（顶栏那个回收站图标 / 长按气泡），
//    不直接把页面当 `home` pump 出来 —— 那样没有返回键，
//    命中区扫描会"一个能点的都没扫到"。

/// 假回执。⚠️ **必须带 `charset=utf-8`**（`http.Response` 默认按 latin1 编正文，
/// 正文里有中文就当场抛）；真服务端也是带 charset 的。
http.Response _json(String body) =>
    http.Response(body, 200, headers: {'content-type': 'application/json; charset=utf-8'});

/// 一份"回收站里有东西、清单里有一条删不掉"的假服务端（不开端口、不碰真网）。
ChatController _trashController() {
  final api = Api(
    client: MockClient((r) async {
      if (r.url.path == '/api/trash') {
        return _json(jsonEncode({
          'items': [
            {
              'messageIds': ['u_1', 'm_1'],
              'at': 1758400000000,
              'purgeAt': 1758400000000,
              'preview': '帮我把这周工时记一下',
            },
            {'messageIds': ['u_2'], 'at': 1758400000000, 'purgeAt': 1758400000000, 'preview': ''},
          ],
        }));
      }
      if (r.url.path == '/api/trash/plan') {
        return _json(jsonEncode({
          'messageIds': ['u_1', 'm_1'],
          'items': [
            {
              'what': '可见的那几句',
              'where': '这台设备',
              'verdict': 'delete',
              'note': '这一屏上看得到的，会跟着清掉',
            },
            {
              'what': '它记住的那一段',
              'where': '记忆里',
              'verdict': 'cannot',
              'note': '要等这段对话的记忆被重建才会消失',
            },
          ],
          'purgeAt': 1758400000000,
          'ttlDays': 30,
        }));
      }
      return _json('{}');
    }),
  );
  // ⚠️ **必须给令牌**：没有它，`loadTrash` / `planDelete` 会当场返回"令牌不行"，
  //    于是这一页只显示一句人话、列表与清单都不画 —— 而扫描照样绿（"闸变弱了"）。
  return ChatController(api: api, tokens: TokenStore(), token: 'tok');
}

/// 一份**一整轮**的时间线（用户那句 + 它的回答）——
/// 长按要认得出一轮（`turnGroupOf`）才会给菜单。
ChatController _turnController() {
  final c = _trashController();
  c.ingest({'type': 'user/echo', 'seq': 1, 'messageId': 'u_1', 'text': '帮我把这周工时记一下'});
  c.ingest({'type': 'message/start', 'seq': 2, 'messageId': 'm_1'});
  c.ingest({'type': 'message/text', 'seq': 3, 'messageId': 'm_1', 'block': 'quick', 'text': '这周 7 小时。'});
  c.ingest({'type': 'message/end', 'seq': 4, 'messageId': 'm_1', 'reason': 'completed'});
  return c;
}

/// **像用户那样**打开回收站页：从主界面点顶栏那个入口。
Future<void> _openTrash(WidgetTester tester, double scale) async {
  await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: _trashController(), onLoggedOut: () {}), scale);
  await tester.tap(find.byTooltip(trashTooltip));
  await tester.pumpAndSettle();
}

/// 一份"导出页拿得到东西"的假服务端（批 3 欠的最后一件）。
ChatController _exportController() {
  final api = Api(
    client: MockClient((r) async {
      if (r.url.path == '/api/export') {
        return _json(jsonEncode({
          'text': '—— 9月21日 ——\n\n我：帮我把这周工时记一下\n\n它：这周 7 小时。\n\n'
              '（这儿只是这条对话里你我互相说过的话。它自己记在记忆里的那一层不在里面。）',
          'hiddenCount': 2,
        }));
      }
      return _json('{}');
    }),
  );
  return ChatController(api: api, tokens: TokenStore(), token: 'tok');
}

/// **像用户那样**打开导出页：从主界面点顶栏那个入口。
///
/// ⚠️ 契约 §五⑥ 点名要**从真入口进** —— 直接把 `ExportScreen` 当 `home` 泵出来，
///    它没有返回键，命中区扫描会"一个能点的都没扫到"，量的也不是用户真看到的那棵树。
Future<void> _openExport(WidgetTester tester, double scale) async {
  await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: _exportController(), onLoggedOut: () {}), scale);
  await tester.tap(find.byTooltip(exportTooltip));
  await tester.pumpAndSettle();
}

/// **像用户那样**长按一条回答，弹出删除菜单。
Future<void> _openBubbleMenu(WidgetTester tester, double scale) async {
  await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: _turnController(), onLoggedOut: () {}), scale);
  await tester.longPress(find.text('这周 7 小时。'));
  await tester.pumpAndSettle();
}

/// **像用户那样**一路走到**删前那份清单**：长按 → 菜单 → 删掉。
Future<void> _openPlan(WidgetTester tester, double scale) async {
  await _openBubbleMenu(tester, scale);
  await tester.tap(find.text(bubbleMenuDelete));
  await tester.pumpAndSettle();
}

/// **像用户那样**让浮窗出现在屏幕上（批 3「系统通知」新加的界面）。
///
/// ⚠️ 和关于页同一条理由：新加的界面**必须也过这两道闸**。
/// ⚠️ **从真入口进**：走的是控制器收服务端事件那条路（`ingest`），
///    不是直接 pump 一个 `NoticeOverlay` —— 那样它没有底下的页面，
///    "五档不溢出"量的就不是用户真会看到的那棵树。
///
/// ⚠️ 浮窗那个"自己消失"的钟：**这一条用例必须把它收掉**，
///    否则 `AutomatedTestWidgetsFlutterBinding` 会在用例结束时
///    断言 "A Timer is still pending"（那是这个框架的硬规矩）。
Future<void> _openNoticeIn(WidgetTester tester, ChatController c, double scale) async {
  // ⚠️ **先挂起来、再让通知到**：浮窗和主界面是 `Stack` 的两层，
  //    通知到时 `setState` 会把这一帧重画出来。
  await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), scale);
  // ⚠️ **先补上"已连上、首屏那段历史读完了"**（真实路径上服务端一定会发 `client/hello`）：
  //    没有它，这条通知会被当成**历史**（见 `models/notice.dart` 的 `shouldPopNotice()`）
  //    ⇒ 浮窗根本不弹 ⇒ 这道闸扫的是底下的页面，而它照样绿 —— 那就成了"闸变弱了"。
  c.ingest({'type': '__caught_up__'});
  c.ingest(_noticeEvent());
  await tester.pump();
  // 负向对照：**浮窗真的画出来了**才算数（没画出来的话下面那道扫描
  // 扫的是底下的页面，而它照样绿 —— 那就是"闸变弱了"）
  expect(find.byType(NoticeOverlay), findsOneWidget, reason: '★ 浮窗没画出来 ⇒ 这条闸漏了它');
  // ⚠️ 范围必须**指到浮窗里**：同一句话在时间线那一条上也有一份
  //    （两处撤销是同一份数据 —— 那正是约束 3）
  expect(
    find.descendant(of: find.byType(NoticeOverlay), matching: find.text(noticeUndoLabel2)),
    findsOneWidget,
    reason: '★ 浮窗里那个撤销按钮也得真在屏幕上（D3.6 要量它）',
  );
}

/// 收掉浮窗（**并让那一帧画出来**）：用例结尾用它清掉那个钟。
Future<void> _closeNotice(WidgetTester tester, ChatController c) async {
  c.dismissNotice();
  await tester.pump();
}

/// **像用户那样**让浮窗自己走掉，屏幕上只剩**时间线里那一条通知**。
Future<void> _openNoticeLine(WidgetTester tester, double scale) async {
  final c = _controller();
  await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), scale);
  c.ingest({'type': '__caught_up__'}); // 同 `_openNoticeIn`：先把"已连上"补上
  c.ingest(_noticeEvent());
  // ⚠️ 两拍：第一拍让那个钟到点，第二拍才把新的一帧画出来
  await tester.pump(ChatController.noticeLinger);
  await tester.pump();
  expect(find.byType(NoticeLine), findsOneWidget, reason: '★ 浮窗走了，时间线里那一条必须还在（约束 2）');
  expect(
    find.descendant(of: find.byType(NoticeLine), matching: find.text(noticeUndoLabel2)),
    findsOneWidget,
    reason: '★ 时间线里那个撤销也得在（"你不在"之后还能按）',
  );
}

/// 一条**有撤销**的系统通知（服务端给的形状，`29-NOTICE.md` §五）。
///
/// ⚠️ `text` 与 `undo.label` 都是**服务端给的**：写在这份测试里，
///    不是客户端文案（`test/unit/notice_test.dart` 钉着"客户端不许有模板"）。
Map<String, dynamic> _noticeEvent() => {
      'type': 'notice',
      'kind': 'expiring',
      'text': '有一条过几天会彻底删掉',
      'at': 1758400000000,
      'seq': 42,
      'undo': {
        'label': noticeUndoLabel2,
        'action': 'trash/restore',
        'messageIds': ['u_x', 'm_y'],
      },
    };

/// 服务端给的那个撤销按钮字。
const noticeUndoLabel2 = '拿回来';

void main() {
  // 换档会写本机设置（`ProcessLevelStore`）——测试里给它一个空盘，
  // 免得真去敲一个不存在的平台插件（写失败也不会抛，但别让它去敲）。
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // ── D3.5 ──────────────────────────────────────────────────

  group('D3.5：容器跟字算，五档不许溢出', () {
    for (final s in scales) {
      testWidgets('第一屏（landing）@ ${s}x', (tester) async {
        // ⚠️ 主人 2026-09-21 点名要的那一屏 —— 它是**未登录时的第一屏**，
        //    所以它必须也过五档不溢出（手册 D3.5 那道硬闸）。
        await _pump(tester, LandingScreen(onStart: () {}), s);
        expect(_drain(tester), isEmpty, reason: '第一屏在 ${s}x 溢出了');
      });

      testWidgets('登录页 @ ${s}x', (tester) async {
        await _pump(tester, _login(), s);
        expect(_drain(tester), isEmpty, reason: '登录页在 ${s}x 溢出了');
      });

      testWidgets('等待那屏（"正在给你开一个只属于自己的空间"）@ ${s}x', (tester) async {
        // ⚠️ 多租户新加的两屏 ⇒ 必须也过五档不溢出（同第一屏 / 登录页那条理由）
        await _pump(tester, WaitingScreen(onRetry: () {}), s);
        expect(_drain(tester), isEmpty, reason: '等待那屏在 ${s}x 溢出了');
      });

      testWidgets('填钥匙那屏 @ ${s}x', (tester) async {
        // ⚠️ 把"取消注册"那个入口也带进来（它是 2026-09-22 新加的，
        //    而**加一个控件就会加高度** ⇒ 五档字号必须重新过一遍）
        await _pump(
          tester,
          ModelKeyScreen(
            onSubmit: (_) async => KeySend.ok,
            onCancel: () async => CancelOutcome.ok,
            onCancelled: () {},
          ),
          s,
        );
        expect(_drain(tester), isEmpty, reason: '填钥匙那屏在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（满内容 + 那行"它正在做…"）', (tester) async {
        final c = _controller();
        _stuff(c.timeline);
        c.timeline.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        expect(_drain(tester), isEmpty, reason: '主界面在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（步骤流水 + 推理原文拉满 —— 批 3 新加的）', (tester) async {
        final c = await _processController();
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        expect(_drain(tester), isEmpty, reason: '过程那一块在 ${s}x 溢出了');
      });

      testWidgets('配置页（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 新加的界面**必须也过这道闸** —— 不然"五档不溢出"会随时间失效。
        await _openConfig(tester, s);
        expect(_drain(tester), isEmpty, reason: '配置页在 ${s}x 溢出了');
      });

      testWidgets('关于页（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 新加的界面**必须也过这道闸** —— 不然"五档不溢出"会随时间失效。
        await _openAbout(tester, s);
        expect(_drain(tester), isEmpty, reason: '关于页在 ${s}x 溢出了');
      });

      testWidgets('过程四档的切换面板（从真入口进）@ ${s}x', (tester) async {
        await _openProcessMenu(tester, s);
        expect(_drain(tester), isEmpty, reason: '切换面板在 ${s}x 溢出了');
        // 命中区：面板里那四项每一行都得 ≥44（它们是 `ListTile`，
        // 不在下面那份按钮扫描的种类里，所以在这儿单独量）。
        for (final t in find.byType(ListTile).evaluate()) {
          final size = tester.getSize(find.byWidget(t.widget));
          expect(size.height >= minTouch, isTrue,
              reason: '切换面板 @${s}x：一行的命中区只有 ${size.height}');
        }
      });

      testWidgets('回收站页（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 批 3 新加的页面 ⇒ 必须也过这道闸（同关于页那条的理由）。
        await _openTrash(tester, s);
        expect(_drain(tester), isEmpty, reason: '回收站页在 ${s}x 溢出了');
        // 负向对照：**真的画出了条目**才算数（只画出"读不到"那一句的话，
        // 这道闸量的是一个空页）。
        expect(find.text(trashRestore), findsWidgets, reason: '★ 回收站页没画出条目 ⇒ 这条闸漏了它');
      });

      testWidgets('气泡长按菜单（从真入口进）@ ${s}x', (tester) async {
        await _openBubbleMenu(tester, s);
        expect(_drain(tester), isEmpty, reason: '删除菜单在 ${s}x 溢出了');
        // 菜单里那一行是 `ListTile`（不在按钮扫描的种类里）⇒ 单独量它的命中区。
        for (final t in find.byType(ListTile).evaluate()) {
          final size = tester.getSize(find.byWidget(t.widget));
          expect(size.height >= minTouch, isTrue,
              reason: '删除菜单 @${s}x：一行的命中区只有 ${size.height}');
        }
      });

      testWidgets('导出页（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 批 3 欠的最后一件（`30-EXPORT.md`）：新加的页面**必须也过这道闸**。
        await _openExport(tester, s);
        expect(_drain(tester), isEmpty, reason: '导出页在 ${s}x 溢出了');
        // 负向对照：**那段字真的画出来了**才算数
        //（只画出"没拿到"那一句的话，这道闸量的是一个空页）。
        expect(find.byType(SelectableText), findsOneWidget,
            reason: '★ 导出页没画出那一段字 ⇒ 这条闸漏了它');
      });

      testWidgets('删前那份清单（从真入口进，含"删不掉"那一条）@ ${s}x', (tester) async {
        await _openPlan(tester, s);
        expect(_drain(tester), isEmpty, reason: '删前清单在 ${s}x 溢出了');
        // 而且它**照实**把"删不掉"写出来了（§五：那句必须出现在屏幕上）
        expect(find.text(planCannotLine), findsOneWidget);
      });

      testWidgets('浮窗（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 批 3「系统通知」的新界面（`29-NOTICE.md`）：**必须也过这道闸**。
        final c = _controller();
        await _openNoticeIn(tester, c, s);
        expect(_drain(tester), isEmpty, reason: '浮窗在 ${s}x 溢出了');
        await _closeNotice(tester, c);
      });

      testWidgets('时间线里那一条通知（从真入口进）@ ${s}x', (tester) async {
        await _openNoticeLine(tester, s);
        expect(_drain(tester), isEmpty, reason: '时间线里那一条在 ${s}x 溢出了');
      });

      testWidgets('空屏 @ ${s}x', (tester) async {
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: _controller(), onLoggedOut: () {}), s);
        expect(_drain(tester), isEmpty, reason: '空屏在 ${s}x 溢出了');
      });
    }

    // ⚠️ "不封顶"这条分**三个测试**量：同一个测试里连续 pump 两棵树时，
    //    `find.text` 会同时匹配到新旧两棵（"Too many elements"）。
    //    量的是**解析之后的 `fontSize`**（`RenderParagraph` 上那个），
    //    它比"渲染高度"更直接：**高度受布局影响，字号不受**。
    final fontSize = <double, double>{};

    // ⚠️ 量的是空屏**正文**那句，不是标题那句 —— 标题「说点什么」和输入框的
    //    **提示语是同一句话**（`find.text` 会同时匹配到两个）。
    const bodyLine = '记一笔账、问一件事、让它去查个东西。\n它会把做过的事说给你听。';
    // ⚠️ **字号缩放不住在 `style` 里。** `Text` 把 `textScaler` 作为**独立字段**
    //    交给 `RenderParagraph`，`text.style.fontSize` 始终是**没缩放的**那个值。
    //    量 `style.fontSize` 会得到"两个档一样大"的假结论（我第一版就是这么量的）。
    //    ⇒ 要显式把 scaler 用上：`textScaler.scale(style.fontSize)`。
    double fontSizeAt(WidgetTester tester, String text) {
      final p = tester.renderObject<RenderParagraph>(find.text(text));
      return p.textScaler.scale(p.text.style!.fontSize!);
    }

    testWidgets('记下 1.0x 的字号', (tester) async {
      await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: _controller(), onLoggedOut: () {}), 1.0);
      fontSize[1.0] = fontSizeAt(tester, bodyLine);
    });

    testWidgets('记下 3.1x 的字号', (tester) async {
      await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: _controller(), onLoggedOut: () {}), 3.1);
      fontSize[3.1] = fontSizeAt(tester, bodyLine);
    });

    test('🔴 字号**不许封顶**：3.1x 的字号 ≈ 1.0x 的 3.1 倍', () {
      // D3.5 的另一半：**不封顶**。"你把系统字体调到 2.0，我们只给 1.3"
      // —— 手册把那种做法列进了"被否决的选项"：**又是一种假装支持**。
      final small = fontSize[1.0];
      final big = fontSize[3.1];
      expect(small, isNotNull, reason: '前两个测试没跑？');
      expect(big, isNotNull, reason: '前两个测试没跑？');
      expect(
        big! / small!,
        closeTo(3.1, 0.05),
        reason: '★ 放大倍率必须跟着系统走（≈3.1），但实际是 ${(big / small).toStringAsFixed(2)} 倍。'
            '这条红了 = 有人给字号加了上限 —— 那是"假装支持"。',
      );
    });
  });

  // ── D3.6 ──────────────────────────────────────────────────

  group('D3.6：触控目标 ≥44（**视觉可以小，命中区不许小**）', () {
    /// ⚠️ 量的是**语义矩形**，不是内部那个 `InkWell`。
    ///
    /// D3.6 原话是"视觉仍小，**用透明 padding 撑命中区**"——
    /// 也就是说**视觉框允许多小**，判据是**命中区**。
    /// Flutter 的 `MaterialTapTargetSize.padded`（默认）正是把那圈 padding 加在
    /// `InkWell` **外面**：实测某个 `IconButton` 的 `InkWell` 是 40×40，
    /// 而它的**语义矩形是 48×48**。
    /// ⇒ 量内层那个框会**误报**（我第一版就是这么误报的，见 `13-A11Y.md` §三）。
    /// ⚠️ 量之前**先把这个按钮完整露出来**（见下面"被裁过的矩形"那段）。
    Future<void> sweep(WidgetTester tester, String where) async {
      var checked = 0;
      for (final type in <Type>[IconButton, TextButton, FilledButton, ElevatedButton]) {
        for (final e in find.byType(type).evaluate()) {
          final w = find.byWidget(e.widget);
          // ⚠️ **先 `ensureVisible`，再量语义矩形。**
          //    为什么非这样不可（2026-09-21 实测）：时间线**会滚**之后，
          //    一个滚到一半的按钮，它的语义矩形是**被视口裁过的**——
          //    「重发」明明有 44 高，量出来是 `Size(65.2, 20.5)`。
          //    ⇒ 那种读数**随滚动位置变**：同一份代码，滚到哪儿决定闸红不红。
          //      而"读数会变的闸"下一步就是被绕过。
          await tester.ensureVisible(w);
          await tester.pumpAndSettle();
          final r = tester.getSemantics(w).rect;
          checked += 1;
          expect(
            r.width >= minTouch && r.height >= minTouch,
            isTrue,
            reason: '$where：$type 的**命中区**是 ${r.size}，小于 $minTouch×$minTouch',
          );
        }
      }
      // ⚠️ **故意不扫 `GestureDetector`。**
      //    Flutter 会给每个 `TextField` 在**应用最外层的 Overlay** 里塞两个选字手柄
      //    （`_SelectionHandleOverlay`），它们就是**裸的 GestureDetector**，
      //    而且只有 22×22 / 40×40 —— 那是**框架的**东西，不是我们的命中区，
      //    在真机上也由系统按平台习惯画。
      //    试过按祖先过滤（"在 EditableText 里就跳过"）：**不管用** ——
      //    手柄在 Overlay 里，`EditableText` **不是它的祖先**。
      //    ⇒ 改成两条：这里只扫我们自己的按钮；再用一条源码级断言
      //      **禁止 lib 里出现裸 GestureDetector**（真加了，就必须把它加进这份扫描）。
      // 负向对照：一个都没扫到 ⇒ 这条闸是空转的
      expect(checked, greaterThan(0), reason: '$where：一个能点的都没扫到');
    }

    for (final s in scales) {
      testWidgets('第一屏（landing）@ ${s}x', (tester) async {
        await _pump(tester, LandingScreen(onStart: () {}), s);
        await sweep(tester, '第一屏 @${s}x');
      });

      testWidgets('登录页 @ ${s}x', (tester) async {
        await _pump(tester, _login(), s);
        await sweep(tester, '登录页 @${s}x');
      });

      testWidgets('配置页（从真入口进）@ ${s}x', (tester) async {
        await _openConfig(tester, s);
        await sweep(tester, '配置页 @${s}x');
      });

      testWidgets('关于页（从真入口进）@ ${s}x', (tester) async {
        await _openAbout(tester, s);
        await sweep(tester, '关于页 @${s}x');
      });

      testWidgets('等待那屏 @ ${s}x', (tester) async {
        // ⚠️ 新加的屏也要进这份扫描 —— 不然"再看看"那个按钮没人守着命中区 ≥44
        await _pump(tester, WaitingScreen(onRetry: () {}), s);
        await sweep(tester, '等待那屏 @${s}x');
      });

      testWidgets('填钥匙那屏 @ ${s}x', (tester) async {
        // ⚠️ 把"取消注册"那个入口也带进来（它是 2026-09-22 新加的，
        //    而**加一个控件就会加高度** ⇒ 五档字号必须重新过一遍）
        await _pump(
          tester,
          ModelKeyScreen(
            onSubmit: (_) async => KeySend.ok,
            onCancel: () async => CancelOutcome.ok,
            onCancelled: () {},
          ),
          s,
        );
        await sweep(tester, '填钥匙那屏 @${s}x');
      });

      testWidgets('回收站页（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 新加的页面必须也进这份扫描 —— 不然它的按钮（恢复 / 彻底删掉）
        //    就没有任何东西守着"命中区 ≥44"。
        await _openTrash(tester, s);
        await sweep(tester, '回收站页 @${s}x');
      });

      testWidgets('删前那份清单（从真入口进）@ ${s}x', (tester) async {
        await _openPlan(tester, s);
        await sweep(tester, '删前清单 @${s}x');
      });

      testWidgets('气泡长按菜单（从真入口进）@ ${s}x', (tester) async {
        await _openBubbleMenu(tester, s);
        await sweep(tester, '删除菜单 @${s}x');
      });

      testWidgets('导出页（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 那个"复制"按钮必须进这份扫描 —— 不然它的命中区没有任何东西守着（D3.6）。
        await _openExport(tester, s);
        await sweep(tester, '导出页 @${s}x');
      });

      testWidgets('浮窗（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 浮窗里的"撤销 / 知道了"两个按钮必须也进这份扫描 ——
        //    不然它们的命中区没有任何东西守着（D3.6）。
        final c = _controller();
        await _openNoticeIn(tester, c, s);
        await sweep(tester, '浮窗 @${s}x');
        await _closeNotice(tester, c);
      });

      testWidgets('时间线里那一条通知（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 撤销窗口**不能随浮窗一起消失**（约束 3）⇒ 它自己也得被量到。
        await _openNoticeLine(tester, s);
        await sweep(tester, '时间线里那条通知 @${s}x');
      });

      testWidgets('主界面（含"重发"那个入口）@ ${s}x', (tester) async {
        final c = _controller();
        _stuff(c.timeline);
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        // ⚠️ **先滚到最上面**：时间线现在打开就停在**最新**那一条（`27-SCROLL.md`），
        //    而"重发"那个入口属于**最老**那条（第一条就发失败了）。
        //    不滚上去的话，字放大之后它可能根本没被 build ⇒ **这一条闸就漏掉了它**，
        //    而 `checked > 0` 照样是绿的（顶栏那几个图标永远在）——那就是"闸变弱"。
        //    ⇒ 显式把它露出来，再量。
        await tester.drag(find.byType(ListView), const Offset(0, 4000));
        await tester.pumpAndSettle();
        // ★ 这条用例的意义就在这个入口：**必须真的量到它**，
        //   不许因为它现在在屏幕外面就悄悄漏过去。
        expect(find.text('重发'), findsOneWidget, reason: '★ "重发"入口没进到这棵树里 ⇒ 这条闸漏了它');
        await sweep(tester, '主界面 @${s}x');
      });
    }
  });

  test('🔴 lib 里不许出现**裸的** GestureDetector（框架的选字手柄不算）', () {
    // 上一条只扫我们自己的按钮。这条补上另一半：
    // **如果将来有人自己写一个 GestureDetector，就必须把它加进那份扫描**——
    // 否则"命中区 ≥44"这件事就有了一个不受检查的缺口。
    final hits = <String>[];
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>()) {
      if (!f.path.endsWith('.dart')) continue;
      if (RegExp(r'\bGestureDetector\s*\(').hasMatch(f.readAsStringSync())) hits.add(f.path);
    }
    expect(
      hits,
      isEmpty,
      reason: '这些文件里有裸的 GestureDetector：$hits —— '
          '要么改用按钮（IconButton/TextButton，命中区有 Material 撑着），'
          '要么把它加进上面的扫描里。',
    );
  });
}
