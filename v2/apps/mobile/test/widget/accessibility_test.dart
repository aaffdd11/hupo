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
import 'package:hupo_app/models/dev_harness.dart';
import 'package:hupo_app/models/dev_harness_words.dart';
import 'package:hupo_app/models/desktop_words.dart';
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/models/harness.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/source_words.dart';
import 'package:hupo_app/models/speak_words.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/models/tool_row.dart';
import 'package:hupo_app/models/tool_row_words.dart';
import 'package:hupo_app/models/voice_record.dart';
import 'package:hupo_app/models/voice_try.dart';
import 'package:hupo_app/models/wallpaper.dart';
import 'package:hupo_app/models/queue_words.dart';
import 'package:hupo_app/models/trash_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/widgets/app_grants_card.dart';
import 'package:hupo_app/widgets/bubbles.dart';
import 'package:hupo_app/widgets/bubble_select_bar.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/desktop_icon_menu.dart';
import 'package:hupo_app/widgets/harness_pane.dart';
import 'package:hupo_app/screens/landing_screen.dart';
import 'package:hupo_app/screens/login_screen.dart';
import 'package:hupo_app/models/app_words.dart';
import 'package:hupo_app/models/harness_words.dart';
import 'package:hupo_app/screens/discover_screen.dart';
import 'package:hupo_app/screens/model_key_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/screens/waiting_screen.dart';
import 'package:hupo_app/models/image_outcome.dart';
import 'package:hupo_app/models/job_words.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/models/notice_words.dart';
import 'package:hupo_app/widgets/notice.dart';
import 'package:hupo_app/widgets/tool_row_view.dart';
import 'package:hupo_app/widgets/wallpaper_picker.dart';
import 'package:hupo_app/widgets/queue_strip.dart';
import 'package:hupo_app/widgets/row_entry.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// D3.5 点名的五档。
const scales = <double>[1.0, 1.3, 1.75, 2.0, 3.1];

/// ★ 批次 4 点名的那三档**用户字号**（契约 `docs/dev/119`）。
///
/// ⚠️ 它是**另一条轴**，不是"第六档系统字号"：那五档改的是 `textScaler`
///    （整页一起缩放），这三档改的是**字号本身**（`14 + Δ`，而且只有聊天内容
///    跟着动）——两条轴都会改布局，所以都要过"不溢出 + 命中区 ≥44"。
const userFontSizes = <int>[
  dshContentFontSizeMin,
  dshContentFontSizeDefault,
  dshContentFontSizeMax,
];

/// **先灌盘（= 用户上次就选了这一档），再 pump** —— 走的是真入口。
///
/// ⚠️ `hupo_chat_appearance` 就是 `AppearanceStore` 里那**一个** key（逐字相同）。
/// ⚠️ **必须 `pumpAndSettle`**：`ChatScreen` 读那个值是异步的，多等一帧
///    才真的换过去（不然量到的还是默认档 —— 那这道闸就是空转）。
Future<void> _pumpFont(WidgetTester tester, Widget child, double scale, int fontSize) async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    'hupo_chat_appearance': 'system|$fontSize',
  });
  await _pump(tester, child, scale);
  await tester.pumpAndSettle();
}

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

/// 一窗里**三轮**、各写一个文件（**三条工具调用**）。
///
/// ⚠️ 它原来是"右栏那一栏"那个夹具（2026-10-03 那一栏整条砍了，
///    见 `docs/dev/171-PANEL-CUT.md`）；现在留着是因为**行级入口那道硬闸**
///    要"屏幕上有几条工具行"（`DshRowEntry` 那一档）。
ChatController _toolCallsFeed() {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final c = _trashController();
  c.ingest({
    'type': 'tool/call',
    'seq': 1,
    'turn': 1,
    'step': 1,
    'callId': 'c_1',
    'name': 'write',
    'title': '写一个新文件',
    'args': '{"path":"/w/账本.txt","content":"7 小时"}',
    'bytes': 40,
    'truncated': false,
  });
  c.ingest({
    'type': 'tool/call',
    'seq': 2,
    'turn': 2,
    'step': 1,
    'callId': 'c_2',
    'name': 'edit',
    'args': '{"file_path":"/w/摘要.md"}',
  });
  c.ingest({
    'type': 'tool/call',
    'seq': 3,
    'turn': 3,
    'step': 1,
    'callId': 'c_3',
    'name': 'write',
    'args': '{"path":"/w/新账本.txt","content":"8 小时"}',
    'bytes': 2000,
    'truncated': true,
  });
  return c;
}

/// 把 pump 期间攒下来的异常全取出来（**溢出就是这么报的**）。
List<Object> _drain(WidgetTester tester) {
  final out = <Object>[];
  for (var e = tester.takeException(); e != null; e = tester.takeException()) {
    out.add(e);
  }
  return out;
}

/// **像用户那样**打开「发现」（乙-3：桌面上的内置图标 ⇒ 别人发出来的小程序那一屏）。
///
/// ⚠️ 和配置页同一条理由：**新加的界面必须也过五档不溢出那道硬闸**。
Future<void> _openDiscover(WidgetTester tester, double scale) async {
  await _pump(tester, ChatScreen(controller: _controller(), onLoggedOut: () {}), scale);
  await tester.tap(find.text(discoverAppLabel));
  await tester.pumpAndSettle();
  expect(find.byType(DiscoverScreen), findsOneWidget, reason: '★ 没进发现那一屏 ⇒ 判据扫错了屏幕');
}

// ── ★ 2026-09-25（批 4 · 一个图标 = 一条对话 · `docs/dev/83-APP-WORKSPACE.md` §五·甲）──
//
// ⚠️ 和关于页 / 发现 / 「我自己那台」同一条理由：**新加的界面（这里是"空房间"那一屏）
//    必须也过那两道硬闸**，不然"五档不溢出 + 命中区 ≥44"会随时间失效。
// ⚠️ 契约 §六·4 点名的那一档就是它：某个小程序**还没有任何对话** ⇒
//    **一句普通话，不是白屏**。这一档是新加的字，所以它自己要被量一次。

/// 那个"我的小程序"（假服务端给的那一条）。
const roomAppId = 'dice';
const roomAppTitle = '掷骰子';

/// 一份"桌面会长出一个我的小程序"的假服务端（不开端口、不碰真网）。
///
/// ⚠️ **不调 `start()`** ⇒ 一条真 socket 都不会开（那条流只在登录之后才有）。
ChatController _roomController() {
  final api = Api(
    client: MockClient((r) async {
      if (r.url.path == '/api/apps') {
        return _json(
          jsonEncode({
            'apps': [
              {
                'id': roomAppId,
                'title': roomAppTitle,
                'icon': 'casino',
                'version': 1,
                'entryUrl': 'https://apps.example/dice/index.html?sig=x',
                'expiresAt': 0,
              },
            ],
          }),
        );
      }
      return _json('{}');
    }),
  );
  return ChatController(api: api, tokens: TokenStore(), token: 'tok');
}

/// **像用户那样**走进某个"我的小程序"的**空房间**。
///
/// 两步都是真实路径：① 点桌面上那个图标（打开它 ⇒ 房间跟着切）；
/// ② 点抓手展开那条聊天（**收起档根本不建时间线**，见 `chat_floater.dart`
/// 那句 `if (collapsed) … else Expanded(child: widget.child)` ——
/// 不展开的话这一屏量的是别的东西，那就是"闸变弱了"）。
Future<void> _openEmptyRoom(WidgetTester tester, double scale) async {
  await _pump(tester, ChatScreen(controller: _roomController(), onLoggedOut: () {}), scale);
  await tester.pumpAndSettle(); // 等 `/api/apps` 回来（桌面才长出那个图标）
  await tester.tap(find.text(roomAppTitle));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(chatHandleKey));
  await tester.pumpAndSettle();
  // 负向对照：**那一句真的画出来了**才算数（没画出来的话这道闸扫的是别的屏）
  expect(find.text(roomEmptyTitle), findsOneWidget, reason: '★ 空房间那句没进这棵树 ⇒ 这道闸扫错了屏');
  expect(find.text(roomEmptyLine(roomAppTitle)), findsOneWidget, reason: '★ 那句普通话必须说出"这是哪间"');
}

/// ★ 2026-09-25（契约 `docs/dev/103-APP-DELETE.md` §一 / 判据 C5）：
/// **像用户那样**长按桌面那一格 ⇒ 出「从桌面上删掉 / 取消」那个小面板。
///
/// ⚠️ 和关于页 / 空房间同一条理由：**新加的界面必须也过这两道硬闸**
///    （五档不溢出 + 命中区 ≥44），不然它们会随时间失效。
/// ⚠️ **从真入口进**：`_roomController()`（假 `/api/apps` 给一条"我的小程序"）
///    + 真长按。不直接 pump 那个面板 —— 那样它底下没有桌面，
///    量的就不是用户真会看到的那棵树。
/// ⚠️ 长按（不是右键）：这一档量的是"面板本身"；右键那条走的是**同一个**面板
///    （两条手势都有，判据在 `test/widget/desktop_remove_test.dart` 的 C1）。
Future<void> _openDesktopRemoveMenu(WidgetTester tester, double scale) async {
  // 默认收起档进场 = 真实路径（桌面图标露着，长按才落得到它上面）
  await _pump(tester, ChatScreen(controller: _roomController(), onLoggedOut: () {}), scale);
  await tester.pumpAndSettle(); // 等 `/api/apps` 回来，桌面才长出那一格
  await tester.longPress(find.text(roomAppTitle));
  await tester.pumpAndSettle();
  // 负向对照：**面板真的画出来了**才算数（没出来的话这道闸量的是别的东西）
  expect(find.byType(DesktopIconMenu), findsOneWidget, reason: '★ 那个小面板没进这棵树 ⇒ 这道闸扫错了屏');
  expect(find.text(desktopRemoveAction), findsOneWidget, reason: '★ 面板上那句没画出来');
}

/// ★ 2026-09-25（契约 `docs/dev/103-APP-DELETE.md` §七.4 · 决策 **D3.11**）：
/// **像用户那样**点面板里那个【从桌面上删掉】⇒ 出**第二层确认**。
///
/// ⚠️ 它也是**新加的界面**（5 行字 ＋ 两个按钮）⇒ 同一条理由要过五档不溢出 + 命中区 ≥44。
///    字放大到 3.1 倍时这一层最容易顶出屏幕（所以正文是可滚的）。
/// ⚠️ 这一下**不会**发出删除请求（那正是 C7 钉着的）—— 确认层只是提醒。
Future<void> _openRemoveConfirm(WidgetTester tester, double scale) async {
  await _openDesktopRemoveMenu(tester, scale);
  await tester.tap(find.text(desktopRemoveAction));
  await tester.pumpAndSettle();
  // 负向对照：**那一层真的出来了**才算数
  expect(find.text(desktopRemoveConfirmTitle), findsOneWidget, reason: '★ 确认层没进这棵树');
  expect(find.text(desktopRemoveConfirmYes), findsOneWidget, reason: '★ 那个"确实删掉"没画出来');
}

/// ★ 2026-09-25（契约 `docs/dev/104-APP-MENU.md` §一 · 判据 C14）：
/// **像用户那样**在面板里点【改个名字】⇒ 出**改名那一层**（一个输入框 ＋ 两个按钮）。
///
/// ⚠️ 同一条理由：它也是**新加的界面**（还有键盘弹起来那一档最容易顶出去）⇒ 要过这两道硬闸。
Future<void> _openRenameDialog(WidgetTester tester, double scale) async {
  await _openDesktopRemoveMenu(tester, scale);
  await tester.tap(find.text(desktopRenameAction));
  await tester.pumpAndSettle();
  expect(find.text(desktopRenameTitle), findsOneWidget, reason: '★ 改名那一层没进这棵树');
  expect(find.text(desktopRenameOk), findsOneWidget, reason: '★ 那个"改好了"没画出来');
}

/// ★ 2026-09-25（契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 第①步 · 判据 C1）：
/// **像用户那样**收到那句问话 ⇒ 出**确认层 ＋ 两个按钮**。
///
/// ⚠️ 和关于页 / 空房间 / 删除确认同一条理由：**新加的界面必须也过这两道硬闸**
///    （五档不溢出 + 命中区 ≥44），不然它们会随时间失效。
/// ⚠️ **走真入口**：那层确认是 `ChatScreen` 收到**服务端那一帧**之后弹的
///    （`_maybeAskJob`），所以这里也喂一帧进去 —— 不直接 pump 那个面板
///    （那样它底下没有聊天屏，量的就不是用户真会看到的那棵树）。
/// ⚠️ 那一帧是**瞬态**（服务端 `emitTransient`）：不占号、不落盘、不重放。
Future<void> _openJobAsk(WidgetTester tester, double scale) async {
  final c = ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());
  await _pump(tester, ChatScreen(controller: c, onLoggedOut: () {}), scale);
  c.ingest({
    'type': 'job/ask',
    'id': 'j_ask_1',
    'where': 'math-drill',
    'why': '帮我做一个练算数的小程序',
    'text': '这件事要另开一处专门做吗？',
    'at': 7,
  });
  await tester.pumpAndSettle();
  // 负向对照：**那一层真的出来了**才算数（没出来的话这道闸量的是别的屏）
  expect(find.text(jobAskTitle), findsOneWidget, reason: '★ 那层确认没进这棵树 ⇒ 这道闸扫错了屏');
  expect(find.text(jobAskNewPlace), findsOneWidget, reason: '★ 【另开一处做】没画出来');
  expect(find.text(jobAskHere), findsOneWidget, reason: '★ 【就在这儿做】没画出来');
}

/// **像用户那样**打开「我自己那台」（2026-09-24 新加的磁贴 · 契约 `81-HARNESS-ENTRY.md`）。
///
/// ⚠️ 同关于页 / 发现那条理由：**新加的界面必须也过那两道硬闸**
///    （五档不溢出 + 命中区 ≥44），不然它们会随时间失效。
/// ⚠️ 那一层连的是**外面那一台**（一条 WS），VM 上真连不上 ⇒ 这里**注入一条假通道**，
///    把"跑着"和"停了"两种状态都泵出来（两种状态各有各的按钮要量）。
///    真实现那一条的判据在 `test/unit/harness_test.dart`（地址/令牌）与
///    `test/widget/harness_test.dart`（接不上时不白屏）。
Future<void> _openHarness(
  WidgetTester tester,
  double scale, {
  HarnessStatus? state,
  DevHarnessEntry? dev,
}) async {
  final feed = _FakeHarnessFeed(state ?? const HarnessStatus(HarnessState.ready));
  await _pump(
    tester,
    ChatScreen(
      controller: _controller(),
      onLoggedOut: () {},
      harnessFeed: () => feed,
      devHarnessEntry: dev,
    ),
    scale,
  );
  await tester.tap(find.text(harnessAppLabel));
  await tester.pumpAndSettle();
  expect(find.byType(HarnessPane), findsOneWidget, reason: '★ 没进那一层 ⇒ 判据扫错了屏幕');
}

/// ★ 那个**次要入口**（契约 `docs/dev/82-DEV-MODE.md` §五）用的假来源。
///
/// ⚠️ 真那条要服务端现签（VM 上要不到）⇒ 注入一个结果，
///    把"标题 + 按钮"这一排在**五档字号**下真的过一遍闸。
class _FakeDevSource implements DevHarnessSource {
  _FakeDevSource(this.outcome);
  final DevHarnessOutcome outcome;

  @override
  Future<DevHarnessOutcome> link() async => outcome;

  @override
  void forget() {}
}

/// 拿到了那条链接 ⇒ 那一档**有按钮**（D3.6 要量的就是它）。
DevHarnessEntry _devReady() => DevHarnessEntry(
  source: _FakeDevSource(
    const DevHarnessReady(
      DevHarnessLink(
        url: 'https://dsh19145526557.stalkerai.cn/__enter?u=u-1&e=1789000000000&s=abc',
        expiresAt: 0,
      ),
    ),
  ),
  canOpen: true,
  openExternal: (_) => true,
);

/// 没被标（非 200）⇒ 那一档**只有一句普通话**（也量一遍：它一样不能溢出）。
DevHarnessEntry _devNotMarked() => DevHarnessEntry(
  source: _FakeDevSource(const DevHarnessNotMarked(403)),
  canOpen: true,
  openExternal: (_) => true,
);

/// 一条**假的**通道：那一层的两种状态在 VM 上没法靠真连一个口演出来。
///
/// ⚠️ 那几行里**故意**放一条"没见过的"（类型 + JSON）：
///    五档字号下最容易被挤爆的就是那种长 JSON。
class _FakeHarnessFeed implements HarnessFeed {
  _FakeHarnessFeed(this._current);
  final HarnessStatus _current;

  @override
  Stream<HarnessLine> get lines => Stream<HarnessLine>.fromIterable(const [
    HarnessLine(HarnessLineKind.turn, '── 第 1 轮 ──'),
    HarnessLine(HarnessLineKind.user, '你 › 用一句话告诉我今天是星期几'),
    HarnessLine(HarnessLineKind.text, '它 › 今天是星期四。'),
    HarnessLine(HarnessLineKind.unknown, 'todo/write', detail: '{"todos":[1,2,3]}'),
  ]);

  @override
  Stream<HarnessStatus> get status => const Stream<HarnessStatus>.empty();

  @override
  HarnessStatus get current => _current;

  @override
  void open() {}

  @override
  void say(String text) {}

  @override
  void stop() {}

  @override
  void restart() {}

  @override
  Future<void> close() async {}
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
  // ⚠️ **2026-09-29 改**：设置改成**一列分类**之后，这一行就是那一列里的一项
  //    ⇒ 指名道姓到**顶层那一列**（`settingsListKey`）。原来那个
  //    `credTab:聊天` 已经不存在了（那一页要**点开**才在）。
  await tester.scrollUntilVisible(
    find.text(aboutEntryTitle),
    240,
    scrollable: find
        .descendant(
          of: find.byKey(settingsListKey),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text(aboutEntryTitle));
  await tester.pumpAndSettle();
}

/// **像用户那样**走进「壁纸」那一页：设置那一列 →「壁纸」。
///
/// ⚠️ 2026-09-29 新加的界面**必须也过那两道硬闸**（五档不溢出 ＋ 命中区 ≥44），
///    不然它们会随时间失效 —— 同关于页 / 空房间那几条的理由。
/// ⚠️ **走真入口**：不直接 pump `WallpaperPicker`（那样它底下没有容器的顶栏，
///    量的就不是用户真会看到的那棵树）。
Future<void> _openWallpaper(WidgetTester tester, double scale) async {
  await _openConfig(tester, scale);
  await tester.scrollUntilVisible(
    find.text(settingsRowWallpaper),
    240,
    scrollable: find
        .descendant(
          of: find.byKey(settingsListKey),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text(settingsRowWallpaper));
  await tester.pumpAndSettle();
  // 负向对照：**真的到了那一页**才算数（不然下面扫的是设置列表）
  expect(find.byType(WallpaperPicker), findsOneWidget, reason: '★ 没进壁纸那一页 ⇒ 这两条判据扫错了屏');
}

/// ★ 2026-09-30（契约 `docs/dev/147-APP-SQLITE.md` §二「册子」）：
/// **注册制那张卡**用的假服务端 —— 那一条小程序**声明了三样**（`db` / `ask` / `net`）。
///
/// ⚠️ 为什么非要单独一份：一个都没声明时那张卡**一个像素都不画**
///    （`_controller()` 那一份 `/api/apps` 是拉不到的 ⇒ 卡不在树上）——
///    直接拿 `_openConfig` 量，这道闸扫的就还是那一列，而它照样绿。
/// ⚠️ 2026-10-01：**`net` 那一行**（"想连网取数据"）也加进来 —— 它是这一轮新加的
///    一行字，不摆出来的话"五档不溢出"就漏了它（同壁纸那一页那条理由）。
ChatController _grantsController() {
  final api = Api(
    client: MockClient((r) async {
      if (r.url.path == '/api/apps') {
        return _json(
          jsonEncode({
            'apps': [
              {
                'id': 'notes',
                'title': '随手记',
                'icon': 'book',
                'version': 1,
                'entryUrl': 'https://apps.example/notes/index.html?sig=x',
                'expiresAt': 0,
                'permissions': ['db', 'ask', 'net'],
                'granted': <String>[],
              },
            ],
          }),
        );
      }
      return _json('{}');
    }),
  );
  return ChatController(api: api, tokens: TokenStore(), token: 'tok');
}

/// **像用户那样**打开设置页、再滚到**注册制那张卡**（契约 `docs/dev/147`）。
///
/// ⚠️ 加一张卡会把折叠线推下去：大字号下那张卡在**屏幕外面**，
///    而 `ListView` 不会把屏幕外的孩子建出来 ⇒ 必须**像用户那样滚**
///    （同 `settings_test.dart` ⑦⑧ 那条：`scrollUntilVisible`，不是把行硬塞进屏幕）。
/// ⚠️ 走真入口（桌面 → 设置）：不直接 pump `SettingsScreen` ——
///    那样底下没有小程序容器，量的就不是用户真会看到的那棵树。
Future<void> _openConfigWithGrants(WidgetTester tester, double scale) async {
  await _pump(
    tester,
    ChatScreen(
      controller: _grantsController(),
      onLoggedOut: () {},
      space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: false),
      onSendKey: (_) async => KeySend.ok,
    ),
    scale,
  );
  await tester.pumpAndSettle(); // 等 `/api/apps` 回来
  await tester.tap(find.text(settingsAppLabel));
  await tester.pumpAndSettle();
  expect(find.byType(SettingsScreen), findsOneWidget, reason: '★ 没进设置那一屏 ⇒ 判据扫错了屏幕');
  await tester.scrollUntilVisible(
    find.byKey(appGrantsCardKey),
    240,
    scrollable: find
        .descendant(
          of: find.byKey(settingsListKey),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pumpAndSettle();
  // 负向对照：那张卡**真的进了树**才算数（不在的话下面量的是设置列表）
  expect(find.byKey(appGrantsCardKey), findsOneWidget, reason: '★ 注册制那张卡没进这棵树');
  // ⚠️ 量的是 `ask`（★ 2026-10-02：存储默认有 ⇒ 那一行不摆，见 `wantRowsOf`）
  expect(find.text(grantWantWords('ask')), findsOneWidget, reason: '★ "它想要什么"没画出来');
}

/// ★ 2026-10-01（契约 `docs/dev/147-APP-SQLITE.md` §五 那笔"清空那颗按钮没做"的欠账 ·
/// 服务端那条口 `POST /api/app-db-clear`）：
/// **像用户那样**点那颗「清空它存下来的东西」⇒ 出**二次确认**（不可逆那一步）。
///
/// ⚠️ 同删除确认 / 改名那一层同一条理由：**新加的界面必须也过这两道硬闸**
///    （五档不溢出 ＋ 命中区 ≥44），不然它们会随时间失效。
/// ⚠️ 大字号下那颗按钮在卡的下面（折叠线以下）⇒ **像用户那样先把它滚出来**再点
///    （`ensureVisible`；`docs/dev/119` §八 那条"折叠线很脆"的教训 —— 不许硬点屏幕外的坐标）。
/// ⚠️ 这一下**不会**发出清空请求（确认层只是提醒）—— "点【清掉】才真发那一条"的判据在
///    `test/widget/settings_grants_test.dart` ⑩（`MockClient` 记那一条 POST）。
Future<void> _openGrantsClearConfirm(WidgetTester tester, double scale) async {
  await _openConfigWithGrants(tester, scale);
  final f = find.byKey(appDbClearKey('notes'));
  // 负向对照：那颗按钮真的在树上（★ 2026-10-02：每个小程序都有它 —— 存储默认有）
  expect(f, findsOneWidget, reason: '★ 那颗"清空"没进这棵树');
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
  // 负向对照：**那一层真的出来了**才算数（没出来的话这道闸扫的是设置那一列）
  expect(find.text(settingsClearDbTitle), findsOneWidget, reason: '★ 二次确认没进这棵树');
  expect(find.text(settingsClearDbWhat), findsOneWidget, reason: '★ 那句"拿不回来"没画出来');
  expect(find.byKey(appDbClearYesKey), findsOneWidget, reason: '★ 那个"清掉"没画出来');
}

/// **像用户那样**打开「配置」：主界面顶栏那个齿轮。
Future<void> _openConfig(WidgetTester tester, double scale) async {
  // ⚠️ **不传 `initialTier`（默认收起）= 真实路径**：一进来聊天是收起那条，
  //    桌面上的「设置」看得见、点得到。⚠️ 传 `full` 的话浮窗把桌面盖住了，
  //    点图标会点到浮窗上（2026-09-22 实测）。
  await _pump(
    tester,
    ChatScreen(
      controller: _controller(),
      onLoggedOut: () {},
      space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: false),
      onSendKey: (_) async => KeySend.ok,
    ),
    scale,
  );
  // 🔴 **入口变了**（主人 2026-09-22）：设置从聊天抓手行搬到了**桌面上那个小程序**
  //    ⇒ 判据要走**新的真实路径**（点桌上的「设置」图标）。
  await tester.tap(find.text(settingsAppLabel));
  await tester.pumpAndSettle();
  // 🔴 **负向对照：点完必须真的到了设置那一屏。**
  //    2026-09-22 实测栽过：图标格上那个 `InkWell` 没把下面那行字包进去 ⇒
  //    点"设置"这行字落到了"点桌面空白"上（只收起了聊天），而下面那道扫描
  //    **照样绿** —— 因为它扫的是**桌面**，根本没进设置那一屏。那就是"闸变弱了"。
  expect(find.byType(SettingsScreen), findsOneWidget, reason: '★ 没进设置那一屏 ⇒ 这两条判据扫错了屏幕');
}

/// ★ 批 7（契约 `docs/dev/123-VOICE-TEST-BUTTON.md`）：
/// **直接泵配置页「语音」那一屏**（含那颗「试一下」＋ 那个文本框）。
///
/// ⚠️ 为什么不从真入口进（同「配置页·图片那一屏」那条的理由）：真入口那趟
///    不接 `onSubmitCreds`、也拿不到 `creds` ⇒ 那一块**不画**（"不给假按钮"那条
///    纪律就是这么定的），于是这道闸会**扫错屏**还照样绿。
///    溢出与命中区这两档要的是**那一棵树**，所以直接把那一屏泵出来。
/// ⚠️ 负向对照：**那一块真的进去了**才算数（不然这些话是白说的）。
Future<void> _pumpVoiceTab(WidgetTester tester, double scale) async {
  await _pump(
    tester,
    Scaffold(
      body: SettingsScreen(
        hasKey: true,
        keyBad: false,
        creds: const SpaceCreds(voice: true),
        localOnly: true,
        onSubmit: (k) async => KeySend.ok,
        onSubmitCreds: (t, v) async => KeySend.ok,
        // 开麦/收手在 VM 上没有真那一份 ⇒ 注一个假的（它只是形状）。
        voiceTry: VoiceTryHandlers(start: (e) async => null, stop: () {}),
        // ★ 2026-09-27：「录一段」那一块也装上 —— 它那两颗按钮要进命中区扫描（≥44），
        //    那一屏也要在五档字号下不溢出（判据见 `test/widget/voice_record_test.dart`）。
        voiceRecord: VoiceRecordHandlers(
          canRecord: true,
          start: () async => null,
          stop: () async => const RecordedClip(url: 'blob:judge', ms: 1000),
          play: (u, onEnded) {},
          stopPlay: () {},
        ),
        canHear: true,
        onLogout: () {},
      ),
    ),
    scale,
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text(credTabVoice));
  await tester.pumpAndSettle();
  expect(find.text(voiceTryStart), findsOneWidget, reason: '★ 那一块没进这棵树 ⇒ 这道闸扫错了屏');
}


// ── ★ `116`：工具行 / 系统提示词行 / 每轮用量 / 过程折叠（主人 2026-09-26）────
//
// ⚠️ 和关于页 / 过程两档同一条理由：**新加的界面必须也过这两道硬闸**
//    （五档不溢出 + 命中区 ≥44），不然"五档不溢出"会随时间失效。
// ⚠️ 四条新事件都走**真入口**（`controller.ingest`）—— 不直接 pump 那几个 widget：
//    那样它底下没有聊天屏，量的就不是用户真会看到的那棵树。
// ⚠️ 两种状态各量一次：**还在跑**（工具行直接摆着）与**收口了**（折成一个控件）——
//    它们是两套控件（IconButton vs TextButton），只量一种会漏掉另一种的命中区。

/// **只有工具行那一格**（那一轮还在跑）。
///
/// ⚠️ **一格一个控制器**（不把三样塞进同一屏）：3.1x 下 `ListView` 是懒加载的，
///    一屏塞不下时**后面那几格根本不会被 build**，闸就量了个空
///    （实测栽过：3.1x 下 `find.text('bash')` 一个都没有）。一格一屏最稳。
/// ⚠️ 前面也不放用户那条气泡（同一个理由）。
ChatController _toolRowOnly() {
  final c = _trashController();
  c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
  c.ingest({
    'type': 'tool/call',
    'seq': 2,
    'turn': 1,
    'step': 1,
    'callId': 'c_1',
    'name': 'bash',
    'title': '跑一下测试',
    'args': '{"command":"ls -la"}',
  });
  c.ingest({
    'type': 'tool/result',
    'seq': 3,
    'turn': 1,
    'step': 1,
    'callId': 'c_1',
    'ok': true,
    'excerpt': 'a.txt\nb.txt\nc.txt',
    'bytes': 1234,
    'truncated': true,
  });
  return c;
}

/// **只有系统提示词那一格**。
ChatController _systemPromptOnly() {
  final c = _trashController();
  c.ingest({
    'type': 'system/prompt',
    'seq': 4,
    'turn': 1,
    'step': 1,
    'text': '你是琥珀。\n第二行。',
    'bytes': 9999,
    'truncated': true,
  });
  return c;
}

/// **只有用量那一行**（五个桶都报 ⇒ 那一行最长的那一档）。
ChatController _usageOnly() {
  final c = _trashController();
  c.ingest({
    'type': 'turn/usage',
    'seq': 1,
    'turn': 1,
    'usage': {'input': 800, 'output': 434, 'cacheRead': 900, 'cacheWrite': 20, 'reasoning': 5},
    'complete': true,
  });
  return c;
}

/// 同一轮**收口了**：工具行折成那一个控件（后面跟着它的用量行）。
ChatController _foldedOnly() {
  final c = _toolRowOnly();
  c.ingest({'type': 'message/start', 'seq': 5, 'messageId': 'm_1'});
  c.ingest({'type': 'message/text', 'seq': 6, 'messageId': 'm_1', 'block': 'quick', 'text': '这周 7 小时。'});
  c.ingest({
    'type': 'turn/usage',
    'seq': 7,
    'turn': 1,
    'usage': {'input': 800, 'output': 434, 'cacheRead': 900},
    'complete': true,
  });
  c.ingest({'type': 'message/end', 'seq': 8, 'messageId': 'm_1', 'reason': 'completed'});
  return c;
}

/// 折叠控件上那句字（**从文案源算**，不手抄 —— 手抄会漂）。
String _foldLabel() => dshTurnProcessLabel(
  const TurnProcess(toolCalls: 1, messages: 0, subagents: 0),
  turnProcessChatWords,
);

// ── ★ `117`：排队那条横条（契约 `docs/dev/117-QUEUE-VISIBLE.md`）──────────
//
// ⚠️ 和 `116` 那几格同一条理由：**新加的界面必须也过这两道硬闸**
//    （五档不溢出 + 命中区 ≥44），不然"五档不溢出"会随时间失效。
// ⚠️ 它走**真入口**（`controller.ingest` 喂那一帧）—— 不直接 pump `QueueStrip`：
//    那样它底下没有聊天屏，量的就不是用户真会看到的那棵树。
// ⚠️ 三种状态各量一次：**一条**（内联那一行）· **三条折着**（只有抬头）·
//    **三条展开**（抬头 ＋ 每一行那颗撤掉按钮）—— 它们是不同的树。

/// **只有排队那一格**（`n` 条）。
ChatController _queueOnly(int n) {
  final c = _trashController();
  c.ingest({
    'type': 'queue/changed',
    'items': [
      for (var i = 0; i < n; i += 1)
        {'messageId': 'm_$i', 'text': '这一件还排着：第 $i 件', 'at': 1790 + i, 'truncated': false},
    ],
    'count': n,
  });
  return c;
}

/// **像用户那样**把时间线拉回最上面。
///
/// ⚠️ 必须的一步：打开就停在最新那一条（`27-SCROLL.md`），3.1x 下头几格会被
///    滚出视口 ⇒ `ListView` 不建它们 ⇒ 这几道闸就成了空转。
///    顺手把 `_userScrolledAway` 立起来，免得跟随又把人拽回底部。
/// ⚠️ **必须指名是聊天那一屏那个 `ListView`**（批 5 起右栏里也有一个 ⇒
///    `find.byType(ListView)` 会**同时找到两个**，`drag` 当场报"ambiguous"）。
Future<void> _toTop(WidgetTester tester) async {
  // 🔴 **2026-09-28 改成"跳到最顶"**（原来是甩一把 `drag(0, 4000)`）。
  //
  // 为什么要改：甩的结果由**甩的物理**＋当时的视口高度决定 —— 而浮窗高一点/矮一点
  // 就会让它停到另一头，`ListView` 的懒加载跟着换一批格子。
  // 实测：主人把浮窗四边留白从 30 改成 10（`FloaterMetrics.margin`）之后，
  // 这一甩的落点从"最顶"变成了"最新"，于是「1 次工具调用」那一条**不在树里**了 ——
  // **被测代码一点毛病都没有**，是这一步的落点不稳（同一族：读数随滚动位置变）。
  // ⇒ 直接 `jumpTo(minScrollExtent)`：**确定性**，而且它正是这个助手名字说的那件事。
  final s = tester.state<ScrollableState>(
    find
        .descendant(of: find.byKey(chatBodyKey), matching: find.byType(Scrollable))
        .first,
  );
  s.position.jumpTo(s.position.minScrollExtent);
  // ⚠️ **只 `pump()` 一帧，不 `pumpAndSettle()`**：展开之后应用会**钉到最新**
  //    （`chat_screen.dart` 那条"展开 = 时间线刚建出来 ⇒ 立刻钉到最新"），
  //    而 `pumpAndSettle` 正好会把它跑到那儿 ⇒ 一跳回最顶又被拉回最新（实测：
  //    pixels 122 → 跳 0 → 又变回 122）。一帧够 `ListView` 把那几格建出来。
  await tester.pump();
}

/// **像用户那样**把工具行展开（点它右边那个箭头）。
///
/// ⚠️ 这一步是**必须**的：收起时那两块正文根本不在树里，不展开就量不到
///    "入参/输出/截断那句"在五档字号下会不会溢。
Future<void> _expandToolRow(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.keyboard_arrow_right).first);
  await tester.pumpAndSettle();
  // 负向对照：**那段正文真的画出来了**才算数
  expect(
    find.text(toolTruncatedLine(1234)),
    findsOneWidget,
    reason: '★ 展开之后"已截断"那句没进这棵树 ⇒ 这道闸量的是收起的样子',
  );
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
// ⚠️ 和关于页 / 过程两档同一条理由：**新加的界面必须也过这两道闸**，
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

/// 一条**带出处**的回答（契约 `67-SOURCES.md`）——
/// ⚠️ 新加的界面/新加的能点的东西**必须进下面那两组扫描**，不然
///    "五档不溢出"与"命中区 ≥44"就有了一个不受检查的缺口（这一节顶上那句老话）。
ChatController _sourceController() {
  final c = _trashController();
  c.ingest({'type': 'user/echo', 'seq': 1, 'messageId': 'u_1', 'text': '北京今天天气怎么样'});
  c.ingest({'type': 'message/start', 'seq': 2, 'messageId': 'm_1'});
  c.ingest({'type': 'message/text', 'seq': 3, 'messageId': 'm_1', 'block': 'quick', 'text': '北京今天多云。'});
  c.ingest({
    'type': 'message/end',
    'seq': 4,
    'messageId': 'm_1',
    'reason': 'completed',
    'sources': [
      {'title': '中国天气网 · 北京今天多云', 'url': 'https://www.weather.com.cn/bj'},
      {'title': 'weather.com.cn', 'url': 'https://www.weather.com.cn/beijing'},
      {'title': 'news.example.cn', 'url': 'https://news.example.cn/x'},
      {'title': 'data.example.cn', 'url': 'https://data.example.cn/y'},
    ],
  });
  return c;
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

/// ★ 2026-09-25（契约 `docs/dev/106-CHAT-SELECT.md` §一 / 判据 S7）：
/// **像用户那样**进多选态：长按 → 菜单 →【多选】⇒ 底栏那条工具条。
///
/// ⚠️ 和关于页 / 空房间 / 桌面那个小面板同一条理由：**新加的界面必须也过这两道硬闸**
///    （五档不溢出 + 命中区 ≥44），不然它们会随时间失效。
/// ⚠️ **从真入口进**（长按真的气泡）——不直接 pump 那个工具条：
///    那样它底下没有聊天，量的就不是用户真会看到的那棵树。
Future<void> _openSelectBar(WidgetTester tester, double scale) async {
  await _openBubbleMenu(tester, scale);
  await tester.tap(find.text(bubbleMenuSelect));
  await tester.pumpAndSettle();
  // 负向对照：**工具条真的画出来了**才算数（没出来的话这道闸扫的是底下的聊天）
  expect(find.byType(BubbleSelectBar), findsOneWidget,
      reason: '★ 工具条没进这棵树 ⇒ 这道闸扫错了屏');
  expect(find.text(bubbleSelectCount(0)), findsOneWidget,
      reason: '★ "已选 0 条"那句没画出来');
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
  //    🔴 2026-09-30：那条通知**不再是浮窗**（`NoticeStrip`，画在浮窗里面、
  //       输入条上面）——它是**瞬态那条**（写盘失败）今天唯一的形状。
  await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), scale);
  // ⚠️ **先补上"已连上、首屏那段历史读完了"**（真实路径上服务端一定会发 `client/hello`）：
  //    没有它，这条通知会被当成**历史**（见 `models/notice.dart` 的 `shouldPopNotice()`）
  //    ⇒ 那一条根本不画 ⇒ 这道闸扫的是底下的页面，而它照样绿 —— 那就成了"闸变弱了"。
  c.ingest({'type': '__caught_up__'});
  c.ingest(_urgentNoticeEvent());
  await tester.pump();
  // 负向对照：**那一条真的画出来了**才算数（没画出来的话下面那道扫描
  // 扫的是底下的页面，而它照样绿 —— 那就是"闸变弱了"）
  expect(find.byType(NoticeStrip), findsOneWidget, reason: '★ 那条没画出来 ⇒ 这条闸漏了它');
  // 🔴 **2026-09-30 改了这里**（契约 `docs/dev/144-NO-NOTICE-OVERLAY.md`）：
  //    从前这道闸量的是"**浮窗里那个撤销**"—— 而带号的通知**不再弹**了，
  //    于是"窗口里那条"今天只剩**瞬态那条**（盘满），它**没有 undo**（服务端不给）。
  //    ⇒ 改量它**真有的那颗按钮**：「知道了」（`noticeDismissLabel`）。
  //    ⚠️ 时间线里那一条**照样在硬闸里** —— 走 `_openNoticeLine`。
  expect(
    find.descendant(of: find.byType(NoticeStrip), matching: find.text(noticeDismissLabel)),
    findsOneWidget,
    reason: '★ 那一条上的按钮也得真在屏幕上（D3.6 要量它）',
  );
}

/// 收掉那一条（**并让那一帧画出来**）：用例结尾用它清掉那个钟。
Future<void> _closeNotice(WidgetTester tester, ChatController c) async {
  c.dismissNotice();
  await tester.pump();
}

/// 🔴 2026-09-30：带号的通知**本来就不弹**（直接进时间线）—— 这一条量的是
/// **时间线里那一条**。
///
/// ⚠️ **2026-10-03 改**：那颗「撤销」（拿回来）**砍了**（主人："回收站…我们也不需要"）
///    ⇒ 这里不再要求它在那儿；这一条照旧量"那条通知真的进了树、而且不溢出"。
Future<void> _openNoticeLine(WidgetTester tester, double scale) async {
  final c = _controller();
  await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), scale);
  c.ingest({'type': '__caught_up__'}); // 同 `_openNoticeIn`：先把"已连上"补上
  c.ingest(_noticeEvent());
  await tester.pump();
  expect(find.byType(NoticeLine), findsOneWidget, reason: '★ 带号的通知必须进时间线（约束 2 没动）');
  expect(find.byType(NoticeStrip), findsNothing, reason: '★ 它不许再浮一次');
  // 负向对照：**通知自己真的画出来了**才算数（不然这一组量的是空屏）
  expect(find.byType(NoticeLine), findsOneWidget);
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

/// 🔴 2026-09-30：**只有瞬态那条**（写盘失败）会画在窗口里那一条上
///    （带号的通知只进时间线 —— 主人：*「不要浮窗。」*，契约 `docs/dev/144`）。
///    ⇒ 这道闸要扫那一条，就得从**真入口**灌这一条。
Map<String, dynamic> _urgentNoticeEvent() => {
      'type': 'notice/urgent',
      'kind': 'disk-full',
      'text': '盘满了，这条我没能记下来',
    };

/// 服务端给的那个撤销按钮字。
const noticeUndoLabel2 = '拿回来';

/// **命中区扫描**（D3.6）—— 量的是**语义矩形**，不是内部那个 `InkWell`。
///
/// D3.6 原话是"视觉仍小，**用透明 padding 撑命中区**"——
/// 也就是说**视觉框允许多小**，判据是**命中区**。
/// Flutter 的 `MaterialTapTargetSize.padded`（默认）正是把那圈 padding 加在
/// `InkWell` **外面**：实测某个 `IconButton` 的 `InkWell` 是 40×40，
/// 而它的**语义矩形是 48×48**。
/// ⇒ 量内层那个框会**误报**（我第一版就是这么误报的，见 `13-A11Y.md` §三）。
/// ⚠️ 量之前**先把这个按钮完整露出来**（见下面"被裁过的矩形"那段）。
///
/// ⚠️ 批次 4 把它从 D3.6 那个 `group` 里**提到顶层**：用户字号那一组也要用它
///    （12/14/17 是**另一条轴**，命中区一样不许小）。搬动**没改一个字节的行为**。
Future<void> sweep(WidgetTester tester, String where) async {
  var checked = 0;
  /// 被列表回收而**这一次量不到**的格子（它不在屏幕上）。
  /// ⚠️ **要 == 0**：不为 0 就说明"扫描时列表在回收"，那这道闸量的就不是整屏了
  ///    —— 与其悄悄弱下去，不如当场红（这条是 2026-09-26 加快照时一起加的）。
  var recycled = 0;
  // ⚠️ **用 `is ButtonStyleButton`，不要用 `find.byType(TextButton)`**
  //    （2026-09-23 修）：`TextButton.icon(...)` / `FilledButton.tonalIcon(...)`
  //    造出来的是**子类**（`_TextButtonWithIcon`…），而 `find.byType` 只认
  //    **精确类型** ⇒ 那些**带图标的按钮从来没被这道闸量过**。
  //    发现经过：出处那几行新加的按钮一条都没扫到，而 `checked > 0` 照样绿
  //    （顶栏那几个图标撑着它）—— 这正是"闸在替自己作假"的形状。
  final targets = <(String, Finder)>[
    ('IconButton', find.byType(IconButton)),
    ('ButtonStyleButton', find.byWidgetPredicate((w) => w is ButtonStyleButton)),
  ];
  for (final (label, finder) in targets) {
    // 🔴 **先拍一份快照再遍历**（2026-09-26 修）：`Finder.evaluate()` 是**惰性**的
    //    （`CachingIterable`），而下面每一格都要 `ensureVisible` ＋ `pumpAndSettle`
    //    —— 这一滚，懒加载的列表（设置页那一列 `ListView`）就会把视口外的格子
    //    **卸掉** ⇒ 惰性迭代走到那一格时取 `e.widget` 会**抛异常**
    //    （不是报红，是崩：`Null check operator used on a null value`）。
    //    ⚠️ 触发条件只是"设置页那张卡多了一行"（2026-09-26 加"暗色还在做"那一句时撞上）
    //    ⇒ 这是**判据助手自己的脆**，不是被测代码的问题。
    //    ⚠️ **快照必须在任何滚动之前拍**：`Element.widget` 对**已经卸掉**的 element
    //      会**抛**（里面是 `_widget!`），不是返回 null —— 一边滚一边取就当场崩。
    //    ⚠️ 快照**不改这道闸的覆盖面**：`evaluate()` 本来就只看得到**已经建出来**的格子
    //      （视口外、还没建的格子从来就没进过这份扫描）。
    final snapshot = <(String, Widget)>[
      for (final e in finder.evaluate()) (label, e.widget),
    ];
    for (final (type, widget) in snapshot) {
      final w = find.byWidget(widget);
      // 这一格已经被列表回收 ⇒ 它**不在屏幕上**，这一次量不到它（如实记数）。
      if (w.evaluate().isEmpty) {
        recycled += 1;
        continue;
      }
      // 🔴 **量的是这颗按钮的布局盒子（`RenderBox.size`），不是语义矩形。**
      //    为什么换掉（2026-09-27，加"录一段"那一块时撞上）：
      //    **同一棵树、同一颗** 62 高的按钮，语义矩形会随滚动位置读出
      //    `Size(552, 62)` / `Size(552, 42)` / `Size(552, -459)` 三种值
      //    （实测：`配置页·语音那一屏` 3.1x；负的高度连矩形都不是）。
      //    根子在框架那一侧：语义矩形的几何要按祖先视口的**语义裁剪**
      //    在变换后的坐标里再切一次，切错了也没人报错。
      //    ⇒ 那种读数**随滚动位置变**：同一份代码，滚到哪儿决定闸红不红。
      //      而"读数会变的闸"下一步就是被绕过（原话见上面那段批注）。
      //    ⚠️ **命中区**该量的是"手势打到哪儿"，而那正是 `RenderBox.hitTest`
      //      用的 `size`；`_RenderInputPadding` 已经把 `Material` 之外那一圈
      //      也算进来了（那本来就是 Flutter 给的命中区）。
      //    ⚠️ 这一改**不放宽**判据：语义矩形只可能比盒子**小**（被裁过），
      //      所以读数从"裁过的"换成"真的"——只可能把**假的红**量绿，不会反过来。
      //
      // 🔴 **2026-09-28：不再 `ensureVisible` 了**（原来那一滚先摆到屏幕上再量）。
      //    理由：`RenderBox.size` 本来就**与滚动位置无关**（滚不滚都是那个盒子），
      //    而那一滚会把懒加载列表里的格子**回收重建** ⇒ 快照里那个 `Widget` 实例
      //    再也 match 不上（`getSize` 当场 `Bad state: No element`，或如实记进
      //    `recycled` 而被下面那条"必须量满整屏"的断言抓住 —— 两种都不是被测代码的毛病）。
      //    实测触发条件只是**浮窗高了 20 像素**（主人把留白 30 改成 10）：
      //    3.1x 下右栏那一屏有 5 颗按钮被回收。⇒ 不滚就没有回收，
      //    `recycled` 回到 0（那条断言反而更严了：**整屏每一颗都量到**）。
      //    ⚠️ 覆盖面一点没少：`evaluate()` 本来就只看得到**已经建出来**的格子。
      final r = tester.getSize(w);
      checked += 1;
      expect(
        r.width >= minTouch && r.height >= minTouch,
        isTrue,
        reason: '$where：$type 的**命中区**是 $r，小于 $minTouch×$minTouch',
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
  // ── 行级入口（D3.6 的"行级那一档"，2026-10-03 加）──────────────────
  // 整行可点的那种行（`DshRowEntry`）**不给 44 高** —— 那会把 11 号字那一行撑到 50
  // （主人 2026-10-03：*"那个右边点一下展开的箭头，行高明显占用太大了"*）。
  // 改成按**面积**算：整行宽 × 行高 ≥ 44×44（1936），而且宽度 ≥44。
  // ⚠️ 这**不是放宽**：原来那颗 44×44 的箭头是 1936 px²，而一行通常 300×20 = 6000
  //    —— 手指要够的地方从"一颗小图标"变成**整行**（理由写在 `row_entry.dart` 顶上）。
  // ⚠️ 这一条**扫到 0 行不算红**（这一屏可能本来就没有这种行）；
  //    "一行都扫不到 ⇒ 空转"由 D3.6 那一组的专用用例盯着（它用**有工具行的**夹具）。
  for (final e in [for (final e in find.byType(DshRowEntry).evaluate()) e.widget]) {
    final w = find.byWidget(e);
    if (w.evaluate().isEmpty) {
      recycled += 1;
      continue;
    }
    final r = tester.getSize(w);
    checked += 1;
    expect(
      r.width >= minTouch && r.width * r.height >= minTouch * minTouch,
      isTrue,
      reason: '$where：行级入口是 ${r.width}×${r.height} —— 要"宽 ≥$minTouch 且面积 ≥ ${minTouch * minTouch}"',
    );
  }

  // 负向对照：一个都没扫到 ⇒ 这条闸是空转的
  expect(checked, greaterThan(0), reason: '$where：一个能点的都没扫到');
  // ⚠️ 被回收的格子数如实报出来（0 = 整屏都量到了）。见 `recycled` 那段说明。
  expect(
    recycled,
    0,
    reason: '$where：有 $recycled 个按钮因为列表回收没量到 —— 这一趟量的不是整屏',
  );
}

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

      testWidgets('主界面 @ ${s}x（工具行 —— 116 新加的·展开着）', (tester) async {
        final c = _toolRowOnly();
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        await _toTop(tester);
        // 负向对照：**那一行真的画出来了**才算数（没画出来的话这道闸扫的是别的屏）
        expect(find.byType(ToolRowView), findsOneWidget, reason: '★ 工具行没进这棵树 ⇒ 这道闸扫错了屏');
        await _expandToolRow(tester);
        expect(_drain(tester), isEmpty, reason: '工具行（展开）在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（系统提示词行 —— 116 新加的）', (tester) async {
        final c = _systemPromptOnly();
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        await _toTop(tester);
        expect(find.text(systemPromptTitle), findsOneWidget, reason: '★ 系统提示词那一行没进这棵树');
        expect(_drain(tester), isEmpty, reason: '系统提示词行在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（每轮用量那一行 —— 116 新加的）', (tester) async {
        final c = _usageOnly();
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        await _toTop(tester);
        expect(find.textContaining(turnUsageUnit), findsOneWidget, reason: '★ 用量那一行没进这棵树');
        expect(_drain(tester), isEmpty, reason: '用量那一行在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（过程折起来那一条 —— 116 新加的）', (tester) async {
        final c = _foldedOnly();
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        await _toTop(tester);
        expect(find.text(_foldLabel()), findsOneWidget, reason: '★ 折叠控件没进这棵树');
        // 负向对照：折起来就必须**真的少画**（不然量的是"没折"的样子）
        expect(find.byType(ToolRowView), findsNothing, reason: '★ 折起来之后那一行不该还在树里');
        expect(_drain(tester), isEmpty, reason: '折叠控件在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（排队横条·一条 —— 117 新加的）', (tester) async {
        final c = _queueOnly(1);
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        // 负向对照：**那一格真的画出来了**才算数
        expect(find.byKey(queueStripKey), findsOneWidget, reason: '★ 排队横条没进这棵树');
        expect(find.byTooltip(queueCancelLabel), findsOneWidget);
        expect(_drain(tester), isEmpty, reason: '排队横条（一条）在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（排队横条·三条折着 —— 117 新加的）', (tester) async {
        final c = _queueOnly(3);
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        expect(find.byKey(queueHeaderKey), findsOneWidget, reason: '★ 那条计数抬头没进这棵树');
        expect(find.text(queueCountHeader(3)), findsOneWidget);
        expect(_drain(tester), isEmpty, reason: '排队抬头在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（排队横条·三条展开 —— 117 新加的）', (tester) async {
        final c = _queueOnly(3);
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        await tester.tap(find.byKey(queueHeaderKey));
        await tester.pumpAndSettle();
        // 负向对照：展开之后每一行那颗撤掉按钮都真的在
        expect(find.byTooltip(queueCancelLabel), findsNWidgets(3), reason: '★ 展开没成');
        expect(_drain(tester), isEmpty, reason: '排队横条（展开）在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（出处那几行拉满 —— 2026-09-23 新加的）', (tester) async {
        final c = _sourceController();
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        expect(find.text(sourcesHeadWords), findsOneWidget, reason: '★ 出处没进到这棵树里 ⇒ 这道闸漏了它');
        expect(_drain(tester), isEmpty, reason: '出处那几行在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（回答下面那条"读一遍" —— 2026-09-23 新加的）', (tester) async {
        // ⚠️ 测试环境里 `canSpeak` 是假（`services/speech_stub.dart`）⇒ **从真入口进去
        //    这条路画不出那个按钮**。所以这里直接搭气泡、把回调注入进去 ——
        //    它照样要过"五档不溢出"（那几行是**跟着字算**的）。
        for (final onSpeak in [true]) {
          final m = AssistantMessage(messageId: 'm_speak', seq: 9)
            ..quick = '北京今天多云，19 度。'
            ..ended = true
            ..reason = 'completed';
          await _pump(
            tester,
            Scaffold(
              body: SingleChildScrollView(
                child: AnswerBubble(message: m, onSpeak: () {}),
              ),
            ),
            s,
          );
          await tester.pumpAndSettle();
          expect(find.text(speakOnceWords), findsOneWidget, reason: '★ 那个按钮没进这棵树（onSpeak=$onSpeak）');
          expect(_drain(tester), isEmpty, reason: '"读一遍"在 ${s}x 溢出了');
        }
      });

      testWidgets('配置页（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 新加的界面**必须也过这道闸** —— 不然"五档不溢出"会随时间失效。
        await _openConfig(tester, s);
        expect(_drain(tester), isEmpty, reason: '配置页在 ${s}x 溢出了');
      });

      testWidgets('配置页·壁纸那一页（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-29 新加的那一页（28 格缩略图）也要过五档 —— 同上面那条的理由。
        await _openWallpaper(tester, s);
        expect(_drain(tester), isEmpty, reason: '壁纸那一页在 ${s}x 溢出了');
      });

      testWidgets('配置页·注册制那张卡（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-30（契约 `docs/dev/147-APP-SQLITE.md`）：**新加的那张卡**
        //    （一条小程序 ＋ 两样"它想要的东西" ＋ 两个开关）必须也过五档不溢出
        //    —— 同关于页 / 壁纸那一页那条理由（不然"五档不溢出"会随时间失效）。
        //    🔴 它把设置那一列的**折叠线推下去了**：所以这一条**像用户那样滚**过去
        //    （`_openConfigWithGrants`），不是把行硬塞进屏幕。
        await _openConfigWithGrants(tester, s);
        expect(_drain(tester), isEmpty, reason: '注册制那张卡在 ${s}x 溢出了');
      });

      testWidgets('配置页·清空那层的二次确认（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-10-01（契约 `docs/dev/147-APP-SQLITE.md` §五）：**新加的那一层**
        //    （一句"拿不回来" ＋ 两个按钮）必须也过五档不溢出 —— 同删除确认那条理由。
        await _openGrantsClearConfirm(tester, s);
        expect(_drain(tester), isEmpty, reason: '清空确认层在 ${s}x 溢出了');
      });

      testWidgets('配置页·图片那一屏（含「试一张」）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-24（P1-27）：**新加的那一块**（P1-27 的「试一张」＋真图）也要过五档。
        //    真入口那一趟拿到的 `creds` 全是"没有" ⇒ 那一块**不画**（负向对照见 widget 判据），
        //    所以这里**直接泵那一屏**（溢出这一档不需要"从真入口进"）。
        await _pump(
          tester,
          Scaffold(
            body: SettingsScreen(
              hasKey: true,
              keyBad: false,
              creds: const SpaceCreds(image: true),
              onSubmit: (k) async => KeySend.ok,
              onSubmitCreds: (t, v) async => KeySend.ok,
              onDrawImage: (p) async => const ImageOutcome(ok: false, words: '这次没画成，等会儿再试。'),
              onLogout: () {},
            ),
          ),
          s,
        );
        await tester.pumpAndSettle();
        // 切到「图片」那一屏（那一块只在它上面画）
        await tester.tap(find.text(credTabImage));
        await tester.pumpAndSettle();
        expect(_drain(tester), isEmpty, reason: '图片那一屏（含试一张）在 ${s}x 溢出了');
      });

      testWidgets('配置页·语音那一屏（含「试一下」＋ 文本框）@ ${s}x', (tester) async {
        // ⚠️ 批 7（契约 `docs/dev/123`）：**新加的那一块**（一颗按钮 ＋ 一个文本框）
        //    必须也过"五档不溢出"这道硬闸 —— 不然它会随时间失效。
        await _pumpVoiceTab(tester, s);
        expect(_drain(tester), isEmpty, reason: '语音那一屏（含试一下）在 ${s}x 溢出了');
      });

      testWidgets('发现（从真入口进）@ ${s}x', (tester) async {
        await _openDiscover(tester, s);
        expect(_drain(tester), isEmpty, reason: '发现在 ${s}x 溢出了');
      });

      testWidgets('我自己那台（从真入口进·跑着）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-24 新加的那一层（`81-HARNESS-ENTRY.md`）⇒ 必须也过这道闸。
        await _openHarness(tester, s);
        expect(_drain(tester), isEmpty, reason: '那一层在 ${s}x 溢出了');
      });

      testWidgets('我自己那台（从真入口进·停了）@ ${s}x', (tester) async {
        // ⚠️ "停了"那一态比"跑着"多两行字（一句普通话 + 原因）⇒ 它也得过五档。
        await _openHarness(
          tester,
          s,
          state: const HarnessStatus(HarnessState.gone, '它那一台被收了'),
        );
        expect(_drain(tester), isEmpty, reason: '那一层（停了）在 ${s}x 溢出了');
      });

      testWidgets('我自己那台·浏览器那个入口（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-24 新加的**次要入口**（契约 `82-DEV-MODE.md` §五）⇒
        //    多了一行字 + 一个按钮，必须也过五档。
        await _openHarness(tester, s, dev: _devReady());
        // 负向对照：那个按钮真的在屏幕上（不在的话这条闸量的是别的东西）
        expect(find.text(devOpenAction), findsOneWidget, reason: '★ 那个按钮没进这棵树');
        expect(_drain(tester), isEmpty, reason: '那个入口在 ${s}x 溢出了');
      });

      testWidgets('我自己那台·没被标那一档（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ **非 200 那一档只有一句普通话**（没有按钮）—— 它一样是屏幕上的一行字，
        //    字放大到 3.1 倍时也不许把那一层挤爆。
        await _openHarness(tester, s, dev: _devNotMarked());
        expect(find.text(devOpenAction), findsNothing, reason: '★ 没被标就不许有按钮');
        expect(find.text(devOpenNotMarked), findsOneWidget, reason: '★ 那句普通话没进这棵树');
        expect(_drain(tester), isEmpty, reason: '没被标那一档在 ${s}x 溢出了');
      });

      testWidgets('关于页（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 新加的界面**必须也过这道闸** —— 不然"五档不溢出"会随时间失效。
        await _openAbout(tester, s);
        expect(_drain(tester), isEmpty, reason: '关于页在 ${s}x 溢出了');
      });

      testWidgets('气泡长按菜单（从真入口进）@ ${s}x', (tester) async {
        await _openBubbleMenu(tester, s);
        // ★ 2026-09-25（`106-CHAT-SELECT.md`）：**新加的那两项**也必须在这一屏上
        //   —— 它们也是 `ListTile`，下面那个循环会连它们一起量命中区。
        expect(find.text(bubbleMenuCopy), findsOneWidget, reason: '★【复制】那一项没进这棵树');
        expect(find.text(bubbleMenuSelect), findsOneWidget, reason: '★【多选】那一项没进这棵树');
        expect(_drain(tester), isEmpty, reason: '删除菜单在 ${s}x 溢出了');
        // 菜单里那一行是 `ListTile`（不在按钮扫描的种类里）⇒ 单独量它的命中区。
        for (final t in find.byType(ListTile).evaluate()) {
          final size = tester.getSize(find.byWidget(t.widget));
          expect(size.height >= minTouch, isTrue,
              reason: '删除菜单 @${s}x：一行的命中区只有 ${size.height}');
        }
      });

      testWidgets('多选态那条工具条（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（契约 `docs/dev/106-CHAT-SELECT.md` §一 / S7）：
        //    "已选 N 条 + 【复制】+【取消】"是**新加的界面** ⇒ 必须也过五档不溢出。
        await _openSelectBar(tester, s);
        expect(_drain(tester), isEmpty, reason: '多选工具条在 ${s}x 溢出了');
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

      testWidgets('行级入口：整行可点 + 面积 ≥ 44×44（D3.6 行级那一档）@ ${s}x', (tester) async {
        // 🔴 2026-10-03 新加的**那一档**：整行可点的那种行（工具行 / 系统提示词行 /
        //    轮次过程 / 排队抬头）**不再凑 44 的行高**，改成"整行都是命中区"。
        //    这条用例钉三件：① 真的扫到（不是空转）；② 面积够、宽够；
        //    ③ **行高 < 44** —— 那正是这次重设计的目的，谁把它改回去就该红。
        //    ⚠️ 夹具用 `_toolCallsFeed()`：它里面有**三条工具调用**（每一行一个入口）。
        final c = _toolCallsFeed();
        await _pump(
          tester,
          ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}),
          s,
        );
        final entries = find.byType(DshRowEntry);
        expect(entries, findsWidgets, reason: '★ 一行都没扫到 ⇒ 这条判据是空转的');
        for (final e in [for (final e in entries.evaluate()) e.widget]) {
          final r = tester.getSize(find.byWidget(e));
          expect(r.width >= minTouch, isTrue, reason: '行级入口的宽只有 ${r.width}');
          expect(
            r.width * r.height >= minTouch * minTouch,
            isTrue,
            reason: '行级入口的面积只有 ${r.width}×${r.height}（要 ≥ ${minTouch * minTouch}）',
          );
        }
        final row = tester.getRect(entries.first);
        // ⚠️ 只在 1.0x 上钉这一条：3.1x 下**文字自己**的行高就超过 44 了，
        //    那时候这一行本来就该高（容器跟字算，D3.5）—— 不是被按钮撑的。
        if (s == 1.0) {
          expect(row.height < minTouch, isTrue,
              reason: '行级入口又被撑到 ${row.height} 高了（这次就是要它跟着文字走）');
        }
        // 点**行里最左边**那一段（不是右边那颗箭头）也要展开 —— 这就是"整行可点"。
        await tester.tapAt(Offset(row.left + 4, row.center.dy));
        await tester.pumpAndSettle();
        expect(
          find.byIcon(Icons.keyboard_arrow_down),
          findsWidgets,
          reason: '★ 点行的左边也该展开（整行才是入口）',
        );
      });

      testWidgets('我的小程序·空房间（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（批 4）：那一间还没有任何对话时那两句是**新加的字** ⇒ 也要过五档。
        await _openEmptyRoom(tester, s);
        expect(_drain(tester), isEmpty, reason: '空房间在 ${s}x 溢出了');
      });

      testWidgets('桌面图标的小面板（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（契约 `103-APP-DELETE.md`）：长按 / 右键那个**新加的界面**
        //    必须也过五档不溢出（同关于页 / 空房间那条理由）。
        await _openDesktopRemoveMenu(tester, s);
        expect(_drain(tester), isEmpty, reason: '那个小面板在 ${s}x 溢出了');
        // 面板里那一行是 `ListTile`（不在下面那份按钮扫描的种类里）⇒ 单独量它的命中区。
        for (final t in find.byType(ListTile).evaluate()) {
          final size = tester.getSize(find.byWidget(t.widget));
          expect(size.height >= minTouch, isTrue,
              reason: '桌面小面板 @${s}x：一行的命中区只有 ${size.height}');
        }
      });

      testWidgets('桌面删除的**第二层确认**（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（契约 `103` §七.4）：5 行字 ＋ 两个按钮 ⇒ 字放大时最容易顶出屏幕。
        await _openRemoveConfirm(tester, s);
        expect(_drain(tester), isEmpty, reason: '删除确认层在 ${s}x 溢出了');
      });

      testWidgets('派活那一层确认（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（契约 `108` §一 第①步）：那一层里有一句**他说的原话**
        //    （长度不可控）＋ 两个按钮 —— 字号放到最大那一档最容易顶出屏幕。
        await _openJobAsk(tester, s);
      });

      testWidgets('桌面图标的**改名那一层**（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（契约 `104` §一）：输入框 ＋ 标题 ＋ 两个按钮 —— 字放大那一档最险。
        await _openRenameDialog(tester, s);
        expect(_drain(tester), isEmpty, reason: '改名那一层在 ${s}x 溢出了');
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

      testWidgets('配置页·注册制那张卡（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-30（契约 `docs/dev/147-APP-SQLITE.md`）：那张卡上的**开关**
        //    正是"要真按下去"的那一下 ⇒ 命中区必须 ≥44（D3.6）。
        //    🔴 `Switch` **不在** `sweep` 扫的那两类控件里（`IconButton` /
        //    `ButtonStyleButton`）⇒ 它得**单独量**（同 `ListTile` 那几处的摆法）——
        //    不量的话这个新控件就没有任何东西守着"≥44"。
        await _openConfigWithGrants(tester, s);
        await sweep(tester, '注册制那张卡 @${s}x');
        final switches = find.byType(Switch).evaluate().toList();
        expect(switches, isNotEmpty, reason: '★ 一个开关都没扫到 ⇒ 这条闸是空转的');
        for (final e in switches) {
          final size = tester.getSize(find.byWidget(e.widget));
          expect(
            size.width >= minTouch && size.height >= minTouch,
            isTrue,
            reason: '注册制那张卡 @${s}x：开关的命中区是 $size，小于 $minTouch×$minTouch',
          );
        }
        // ★ 2026-10-01：那颗「清空它存下来的东西」**也得真的在树上** ——
        //    不摆出来的话 `sweep` 扫的是别的按钮，而它照样绿（"闸变弱了"）。
        //    ⚠️ 它是 `TextButton`（`ButtonStyleButton` 那一类）⇒ `sweep` 已经量了它的命中区。
        expect(find.byKey(appDbClearKey('notes')), findsOneWidget,
            reason: '★ 那颗"清空"没进这棵树 ⇒ 这道闸漏了它');
      });

      testWidgets('配置页·清空那层的二次确认（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-10-01（契约 `docs/dev/147-APP-SQLITE.md` §五）：【取消】/【清掉】
        //    两个按钮都要进这份扫描 —— 破坏性动作那一下的命中区更不许小。
        await _openGrantsClearConfirm(tester, s);
        await sweep(tester, '清空确认层 @${s}x');
      });

      testWidgets('配置页·语音那一屏那颗「试一下」（直接泵）@ ${s}x', (tester) async {
        // ⚠️ 批 7（契约 `docs/dev/123`）：那颗按钮是"要真按下去"的那一下 ⇒
        //    它的命中区必须 ≥44。⚠️ 那一屏真入口进不去（见 `_pumpVoiceTab`）。
        await _pumpVoiceTab(tester, s);
        await sweep(tester, '语音「试一下」@${s}x');
      });

      testWidgets('配置页·壁纸那一页（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-29：那一页有 28 格**可点**的缩略图 ⇒ 每一格的命中区
        //    （`wallpaperCell`）必须 ≥44，而格子是**写死的**尺寸 ⇒ 大字号下
        //    最容易"字大了它却没大"的那一类。这一条就是守它的。
        await _openWallpaper(tester, s);
        // 负向对照：那 28 格真的在树上（不然这趟扫的是别的东西）
        expect(find.bySemanticsLabel(wallpaperLabel('wp-01')), findsOneWidget,
            reason: '★ 缩略图那一格没进这棵树');
        await sweep(tester, '壁纸那一页 @${s}x');
      });

      testWidgets('发现（从真入口进）@ ${s}x', (tester) async {
        await _openDiscover(tester, s);
        await sweep(tester, '发现 @${s}x');
      });

      testWidgets('我自己那台（从真入口进·跑着）@ ${s}x', (tester) async {
        // ⚠️ 新加的那一层里的按钮（跑着时的「停」/ 送出）也得进这份扫描。
        await _openHarness(tester, s);
        await sweep(tester, '我自己那台 @${s}x');
      });

      testWidgets('我自己那台（从真入口进·停了）@ ${s}x', (tester) async {
        // ⚠️ 「重来」是**另一条状态**下的按钮：不单独泵一次的话，它的命中区
        //    没有任何东西守着（而 D3.6 就是"命中区 ≥44"）。
        await _openHarness(
          tester,
          s,
          state: const HarnessStatus(HarnessState.gone, '它那一台被收了'),
        );
        // 负向对照：那个「重来」真的在屏幕上（不在的话这条扫描量的是别的按钮）
        expect(find.text(harnessRestart), findsOneWidget, reason: '★「重来」没进这棵树');
        await sweep(tester, '我自己那台（停了）@${s}x');
      });

      testWidgets('我自己那台·浏览器那个入口（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 新加的那个按钮（「在浏览器里打开」）也得进这份扫描 ——
        //    不单独泵一次的话，它的命中区没有任何东西守着（D3.6 就是"命中区 ≥44"）。
        await _openHarness(tester, s, dev: _devReady());
        expect(find.text(devOpenAction), findsOneWidget, reason: '★ 那个按钮没进这棵树');
        await sweep(tester, '我自己那台·浏览器入口 @${s}x');
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


      testWidgets('删前那份清单（从真入口进）@ ${s}x', (tester) async {
        await _openPlan(tester, s);
        await sweep(tester, '删前清单 @${s}x');
      });

      testWidgets('气泡长按菜单（从真入口进）@ ${s}x', (tester) async {
        await _openBubbleMenu(tester, s);
        await sweep(tester, '删除菜单 @${s}x');
      });

      testWidgets('多选态那条工具条（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（契约 `docs/dev/106-CHAT-SELECT.md` §一 / S7）：
        //    工具条那两个按钮（【复制】【取消】）必须进这份扫描 ——
        //    不然它们的命中区没有任何东西守着（D3.6 就是"命中区 ≥44"）。
        await _openSelectBar(tester, s);
        await sweep(tester, '多选工具条 @${s}x');
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

      testWidgets('我的小程序·空房间（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（批 4）：进了某个"我的小程序"、聊天展开着 —— 那一组合下
        //    时间线、抓手、顶栏那三个动作、输入条都在屏幕上 ⇒ 它们的命中区也得量一次。
        await _openEmptyRoom(tester, s);
        await sweep(tester, '空房间 @${s}x');
      });

      testWidgets('桌面图标的小面板（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（契约 `103-APP-DELETE.md`）：那个「取消」按钮必须进这份扫描
        //    —— 不然它的命中区没有任何东西守着（D3.6 就是"命中区 ≥44"）。
        //    ⚠️ 面板里那一行（`ListTile`）不在 `sweep` 的种类里 ⇒ 它由上面 D3.5
        //       那一组单独量（同气泡长按菜单的摆法）。
        await _openDesktopRemoveMenu(tester, s);
        await sweep(tester, '桌面小面板 @${s}x');
      });

      testWidgets('桌面删除的**第二层确认**（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（契约 `103` §七.4 · D3.11）：【算了】/【确实删掉】两个按钮
        //    都要进这份扫描 —— 破坏性动作那一下的命中区更不许小。
        await _openRemoveConfirm(tester, s);
        await sweep(tester, '删除确认层 @${s}x');
      });

      testWidgets('桌面图标的**改名那一层**（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（契约 `104` §一）：【算了】/【改好了】两个按钮也要进这份扫描。
        await _openRenameDialog(tester, s);
        await sweep(tester, '改名那一层 @${s}x');
      });

      testWidgets('派活那一层确认（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ 2026-09-25（契约 `108` §一 第①步）：【另开一处做】/【就在这儿做】
        //    两个按钮的命中区都要 ≥44（这是他真要按下去的那一下）。
        await _openJobAsk(tester, s);
        await sweep(tester, '派活确认层 @${s}x');
      });

      testWidgets('工具行的展开按钮（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ `116`：那一格里的 `IconButton`（展开/收起）必须进这份扫描 ——
        //    不然它的命中区没有任何东西守着（D3.6 就是"命中区 ≥44"）。
        //    ⚠️ **不展开**：展开那块正文里没有按钮，而展开会把时间线拉高 ⇒
        //       `ensureVisible` 一滚、懒加载就把快照里的控件换掉了（那条路实测会翻车）。
        final c = _toolRowOnly();
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        await _toTop(tester);
        expect(find.byType(ToolRowView), findsOneWidget, reason: '★ 工具行没进这棵树');
        await sweep(tester, '工具行 @${s}x');
      });

      testWidgets('系统提示词行的展开按钮（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ `116`：另一个 `IconButton`（同一个形状、另一格）—— 单独量一次。
        final c = _systemPromptOnly();
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        await _toTop(tester);
        expect(find.text(systemPromptTitle), findsOneWidget, reason: '★ 系统提示词那一行没进这棵树');
        await sweep(tester, '系统提示词行 @${s}x');
      });

      testWidgets('过程折叠控件（从真入口进）@ ${s}x', (tester) async {
        // ⚠️ `116`：折起来那一条是**另一个控件**（通栏 `TextButton`）——
        //    不单独泵一次的话，它的命中区没人量。
        final c = _foldedOnly();
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        await _toTop(tester);
        expect(find.text(_foldLabel()), findsOneWidget, reason: '★ 折叠控件没进这棵树');
        await sweep(tester, '折叠控件 @${s}x');
      });

      testWidgets('排队横条的撤掉按钮（从真入口进·一条）@ ${s}x', (tester) async {
        // ⚠️ `117`：那一行上那颗撤销按钮必须进这份扫描 ——
        //    它正是"要真按下去"的那一下（D3.6 就是"命中区 ≥44"）。
        final c = _queueOnly(1);
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        expect(find.byKey(queueStripKey), findsOneWidget, reason: '★ 排队横条没进这棵树');
        await sweep(tester, '排队横条（一条）@${s}x');
      });

      testWidgets('排队横条的抬头 ＋ 每行撤销（从真入口进·三条展开）@ ${s}x', (tester) async {
        // ⚠️ `117`：抬头（`TextButton`）与**每一行**那颗撤销（`IconButton`）
        //    是两套控件 —— 不单独泵一次、不展开，它们的命中区没人量。
        final c = _queueOnly(3);
        await _pump(tester, ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}), s);
        await tester.tap(find.byKey(queueHeaderKey));
        await tester.pumpAndSettle();
        expect(find.byTooltip(queueCancelLabel), findsNWidgets(3), reason: '★ 展开没成');
        await sweep(tester, '排队横条（展开）@${s}x');
      });

        }

    testWidgets('"读一遍"（能念时）的命中区 ≥44 —— 五档都量', (tester) async {
      // ⚠️ 同一个理由：测试环境里念不了（`speech_stub`），真入口画不出它 ⇒
      //    把回调**注入**进气泡直接量。
      for (final s in scales) {
        final m = AssistantMessage(messageId: 'm_speak', seq: 9)
          ..quick = '北京今天多云，19 度。'
          ..ended = true
          ..reason = 'completed';
        await _pump(
          tester,
          Scaffold(
            body: SingleChildScrollView(
              child: AnswerBubble(message: m, onSpeak: () {}, onStopSpeak: () {}),
            ),
          ),
          s,
        );
        await tester.pumpAndSettle();
        await sweep(tester, '"读一遍" @${s}x');
      }
    });

    testWidgets('出处那几行（能点开时）的命中区 ≥44 —— 五档都量', (tester) async {
      // ⚠️ 为什么要单独一条：**测试环境里 `canOpenLinks` 是假**（`services/links_stub.dart`）
      //    ⇒ 从真入口进去，出处是**纯文字**、根本没有按钮 ⚠️ 于是"命中的东西"这一档
      //    会**悄悄漏掉**这个控件。⇒ 这里把回调**注入**进气泡，直接量它。
      for (final s in scales) {
        final m = AssistantMessage(messageId: 'm_src', seq: 9)
          ..quick = '北京今天多云。'
          ..ended = true
          ..reason = 'completed';
        m.sources = [
          {'title': '中国天气网 · 北京今天多云', 'url': 'https://www.weather.com.cn/bj'},
          {'title': 'news.example.cn', 'url': 'https://news.example.cn/x'},
        ];
        await _pump(
          tester,
          Scaffold(
            body: SingleChildScrollView(
              child: AnswerBubble(message: m, onOpenSource: (_) {}),
            ),
          ),
          s,
        );
        await tester.pumpAndSettle();
        await sweep(tester, '出处那几行 @${s}x');
        expect(_drain(tester), isEmpty, reason: '出处那几行在 ${s}x 溢出了');
      }
    });
  });

  // ── ★ 批次 4：**用户字号**那条轴（契约 `docs/dev/119`）──────────────
  //
  // ⚠️ 和上面每一组同一条理由：**新加的设置必须也过这两道硬闸**
  //    （五档不溢出 + 命中区 ≥44），不然"字号能调"这件事会随时间退化成
  //    "调大之后有东西被挤没 / 有按钮点不到"。
  // ⚠️ 这里用**系统 1.0x 与 1.75x 两档**配 12/14/17：两条轴是**乘起来**的
  //    （用户字号改的是字号本身，系统缩放再乘上去）—— 最坏的一档是两者都大。
  group('D3.5/D3.6 · 批 4：**用户字号** 12/14/17 也一样', () {
    for (final u in userFontSizes) {
      testWidgets('主界面（满内容）@ 用户字号 $u · 系统 1.0x', (tester) async {
        final c = _controller();
        _stuff(c.timeline);
        await _pumpFont(
          tester,
          ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}),
          1.0,
          u,
        );
        expect(_drain(tester), isEmpty, reason: '主界面在用户字号 $u（1.0x）溢出了');
      });

      testWidgets('主界面（满内容）@ 用户字号 $u · 系统 1.75x', (tester) async {
        // 🔴 **两条轴一起**：用户字号是"字号更大"，系统缩放是"整页再放大"。
        final c = _controller();
        _stuff(c.timeline);
        await _pumpFont(
          tester,
          ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}),
          1.75,
          u,
        );
        expect(_drain(tester), isEmpty, reason: '主界面在用户字号 $u × 系统 1.75x 溢出了');
      });

      testWidgets('工具行（展开着）@ 用户字号 $u', (tester) async {
        final c = _toolRowOnly();
        await _pumpFont(
          tester,
          ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}),
          1.75,
          u,
        );
        await _toTop(tester);
        // 负向对照：**那一行真的画出来了**才算数
        expect(find.byType(ToolRowView), findsOneWidget, reason: '★ 工具行没进这棵树 ⇒ 这道闸扫错了屏');
        await _expandToolRow(tester);
        expect(_drain(tester), isEmpty, reason: '工具行（展开）在用户字号 $u 溢出了');
      });

      testWidgets('排队横条（三条展开）@ 用户字号 $u', (tester) async {
        final c = _queueOnly(3);
        await _pumpFont(
          tester,
          ChatScreen(initialTier: FloaterTier.full, controller: c, onLoggedOut: () {}),
          1.75,
          u,
        );
        await tester.tap(find.byKey(queueHeaderKey));
        await tester.pumpAndSettle();
        expect(find.byTooltip(queueCancelLabel), findsNWidgets(3), reason: '★ 展开没成');
        expect(_drain(tester), isEmpty, reason: '排队横条在用户字号 $u 溢出了');
      });

      testWidgets('配置页（「这块窗口」那两行 · 不溢出 ＋ 命中区 ≥44）@ 用户字号 $u', (tester) async {
        // 🔴 这是**这一批新加的那两行**：3.1x 系统字号下它最容易顶出屏幕
        //    （三个选项 + 一个步进器 + 一行预览），所以两条闸都要量。
        SharedPreferences.setMockInitialValues(<String, Object>{
          'hupo_chat_appearance': 'system|$u',
        });
        await _pump(
          tester,
          ChatScreen(
            controller: _controller(),
            onLoggedOut: () {},
            space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: false),
            onSendKey: (_) async => KeySend.ok,
          ),
          3.1,
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text(settingsAppLabel));
        await tester.pumpAndSettle();
        expect(find.byType(SettingsScreen), findsOneWidget, reason: '★ 没进设置那一屏');
        // ⚠️ 2026-09-29：那两行现在住在「这块窗口」**那一页**里（顶层只有名目）
        //    ⇒ 像用户那样点开它，再量（用户也是这么走的）。
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
        // 负向对照：那两行**真的画出来了**
        expect(find.text(settingsAppearanceLabel), findsOneWidget, reason: '★「外观」那一行没进这棵树');
        expect(find.text(settingsFontSizePreview), findsOneWidget, reason: '★ 那一行实时预览没进这棵树');
        expect(_drain(tester), isEmpty, reason: '「这块窗口」在用户字号 $u 溢出了');
        await sweep(tester, '「这块窗口」@用户字号 $u');
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