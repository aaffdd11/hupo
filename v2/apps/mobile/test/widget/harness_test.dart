// **「我自己那台」那一层画出来了没有**（契约 `docs/dev/81-HARNESS-ENTRY.md` §5.4）。
//
// ⚠️ `test/widget`（**提示档**）—— 当闸的那两条在 `accessibility_test.dart`
//    （五档不溢出 + 命中区 ≥44，从**真入口**进）。
//
// ⚠️ 这里绝大多数用例**注入一条假的通道**（`HarnessFeed` 是 `models` 里的抽象）：
//    那一层的四种状态（正在打开 / 跑着 / 停了 / 流进来的行）在 VM 上
//    根本没法靠真连一个口演出来。⇒ 注入之后，"点开真进去了""回车真发出去了"
//    "断了真能重来"这几条**才有自动化证据**。
//    另有一条**不注入**的用例：生产那条（`services/harness_client.dart`）接不上时
//    也不许白屏 —— 那条路只有在真机上才连得通，但"接不上时有话说"这一半现在就能验。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hupo_app/models/dev_harness.dart';
import 'package:hupo_app/models/dev_harness_words.dart';
import 'package:hupo_app/models/harness.dart';
import 'package:hupo_app/models/harness_words.dart';
import 'package:hupo_app/models/space_words.dart' show miniAppBack;
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/harness_pane.dart';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

/// 一条假的通道：记下界面**真的**调了什么（说了哪句 / 停了几次 / 重来几次 / 收掉没有）。
class _FakeFeed implements HarnessFeed {
  _FakeFeed({HarnessStatus? initial})
    : _current = initial ?? const HarnessStatus(HarnessState.booting);

  final _lines = StreamController<HarnessLine>.broadcast();
  final _status = StreamController<HarnessStatus>.broadcast();
  HarnessStatus _current;

  final said = <String>[];
  int opens = 0;
  int stops = 0;
  int restarts = 0;
  int closes = 0;

  @override
  Stream<HarnessLine> get lines => _lines.stream;

  @override
  Stream<HarnessStatus> get status => _status.stream;

  @override
  HarnessStatus get current => _current;

  @override
  void open() => opens++;

  @override
  void say(String text) => said.add(text);

  @override
  void stop() => stops++;

  @override
  void restart() => restarts++;

  @override
  Future<void> close() async {
    closes++;
    await _lines.close();
    await _status.close();
  }

  void push(HarnessLine line) => _lines.add(line);

  void to(HarnessStatus s) {
    _current = s;
    _status.add(s);
  }
}

/// 只泵那一层（注入一条假通道）。
Future<_FakeFeed> _pumpPane(
  WidgetTester tester, {
  HarnessStatus? initial,
  DevHarnessEntry? devEntry,
}) async {
  final feed = _FakeFeed(initial: initial);
  await tester.pumpWidget(
    MaterialApp(home: Scaffold(body: HarnessPane(feed: feed, devEntry: devEntry))),
  );
  await tester.pump();
  return feed;
}

const _ready = HarnessStatus(HarnessState.ready);

/// ★ 那个次要入口（契约 `docs/dev/82-DEV-MODE.md` §五）用的假来源：
/// **那条链接从哪来**在 VM 上演不了（要服务端现签）⇒ 注入一个，把
/// "拿到就有按钮 / 没被标就没有 / 点了真原样交出去"这几件钉住。
class _FakeDevSource implements DevHarnessSource {
  _FakeDevSource(this.outcome);

  static const _devUrl =
      'https://dsh19145526557.stalkerai.cn/__enter?u=u-1&e=1789000000000&s=abc';

  DevHarnessOutcome outcome;
  int fetches = 0;
  int forgets = 0;

  @override
  Future<DevHarnessOutcome> link() async {
    fetches += 1;
    return outcome;
  }

  @override
  void forget() => forgets += 1;
}

/// 一个"拿到了"的那种来源。
_FakeDevSource _devReady() => _FakeDevSource(
  DevHarnessReady(
    const DevHarnessLink(url: _FakeDevSource._devUrl, expiresAt: 0),
  ),
);

/// 从**真入口**（桌面磁贴）进那一层，而且那条次要入口接的是注入的那一个。
Future<void> _openHarnessWithDev(
  WidgetTester tester,
  _FakeDevSource src, {
  required bool canOpen,
  required bool Function(String url) openExternal,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        controller: _controller(),
        onLoggedOut: () {},
        harnessFeed: () => _FakeFeed(initial: _ready),
        devHarnessEntry: DevHarnessEntry(
          source: src,
          canOpen: canOpen,
          openExternal: openExternal,
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.tap(find.text(harnessAppLabel));
  await tester.pumpAndSettle();
  expect(find.byType(HarnessPane), findsOneWidget, reason: '★ 没进那一层 ⇒ 判据扫错了屏幕');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  SharedPreferences.setMockInitialValues(<String, Object>{});

  testWidgets('★ 真入口（注入那条通道）：桌上磁贴 ⇒ 点开真的进去了，而且有话说', (tester) async {
    final feed = _FakeFeed();
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          controller: _controller(),
          onLoggedOut: () {},
          harnessFeed: () => feed,
        ),
      ),
    );
    await tester.pump();
    // 负向对照：那个磁贴真的在桌面上（不在的话下面这条断言扫的是别的东西）
    expect(find.text(harnessAppLabel), findsOneWidget, reason: '★ 桌面上该有「$harnessAppLabel」');

    await tester.tap(find.text(harnessAppLabel));
    await tester.pumpAndSettle();

    expect(find.byType(HarnessPane), findsOneWidget, reason: '★ 那一层没进这棵树');
    expect(feed.opens, 1, reason: '★ 点开就该把这一头接上（不是等用户再点一下）');
    // 🔴 不许白屏：屏幕上必须有话
    expect(find.text(harnessOpening), findsOneWidget, reason: '★ 还没开好也要说一句普通话');
  });

  testWidgets('★ **看板那句话**：那一层里回话的不是琥珀 ⇒ 页面上明写（契约 109 §八）', (tester) async {
    // 主人 2026-09-25 拍的「甲」：**能看能聊，但页面上明写"在这儿说话的不是琥珀"**。
    // ⚠️ 这一条是那句话的**自动化证据**：少了它，界面就在说假话
    //    （名字叫"我自己那台"，答话的却是那台自带的嗓子）。
    final feed = _FakeFeed(initial: _ready);
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          controller: _controller(),
          onLoggedOut: () {},
          harnessFeed: () => feed,
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.text(harnessAppLabel));
    await tester.pumpAndSettle();
    expect(find.byType(HarnessPane), findsOneWidget, reason: '★ 没进那一层 ⇒ 判据扫错了屏幕');
    // 🔴 两句都要**在那一层里**（不许是别处某个长得像的句子）
    for (final line in [devBoardNotHupo, devBoardWhyNot]) {
      expect(
        find.descendant(of: find.byType(HarnessPane), matching: find.text(line)),
        findsOneWidget,
        reason: '★ 「$line」没画到那一层上 ⇒ 名字一样、东西不一样（假话）',
      );
    }
  });

  testWidgets('★ 真入口（**不注入**）：生产那条接不上时也**不许白屏**', (tester) async {
    // ⚠️ 这一条走的是真实现（`services/harness_client.dart`）。VM 上它连不上
    //    （`Uri.base` 是个 file:// ⇒ 算不出主机），但那正是"接不上"这一半要验的样子：
    //    屏幕上得有那句"停下了 + 重来"，而不是一块白板。
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(controller: _controller(), onLoggedOut: () {})),
    );
    await tester.pump();
    await tester.tap(find.text(harnessAppLabel));
    await tester.pumpAndSettle();

    expect(find.byType(HarnessPane), findsOneWidget);
    // 底下的键盘那一条永远在 ⇒ 白屏在这棵树上已经不可能
    // ⚠️ 要**指名道姓**到那一层里：聊天浮窗自己也有一个打字框
    expect(
      find.descendant(of: find.byType(HarnessPane), matching: find.byType(TextField)),
      findsOneWidget,
    );
    // 而"正在打开…"或者"停下了（+重来）"至少有一句在
    final words =
        find.text(harnessOpening).evaluate().isNotEmpty ||
        find.text(harnessGoneLine).evaluate().isNotEmpty;
    expect(words, true, reason: '★ 接不上也要有一句普通话（不许白屏）');
  });

  testWidgets('🔴 还没开好 ⇒ 那句"正在打开…"占着地方，而且打字框是灰的', (tester) async {
    await _pumpPane(tester);
    expect(find.text(harnessOpening), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, false,
        reason: '★ 没开好就不给打字：这时候发出去的话没人接');
    expect(find.text(harnessStop), findsNothing, reason: '还没跑起来，没有可停的东西');
  });

  testWidgets('🔴 跑着的时候 ⇒ 打字框能用 + 一个「$harnessStop」，点了真发 stop', (tester) async {
    final feed = await _pumpPane(tester, initial: _ready);
    expect(find.text(harnessOpening), findsNothing);
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, true);
    expect(find.text(harnessStop), findsOneWidget);

    await tester.tap(find.text(harnessStop));
    await tester.pump();
    expect(feed.stops, 1, reason: '★ 点了"停"就该真发出去（点了没反应 = 坏了）');
  });

  testWidgets('🔴 回车 ⇒ 真发出 say，而且框清空', (tester) async {
    final feed = await _pumpPane(tester, initial: _ready);
    await tester.enterText(find.byType(TextField), '在吗');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();

    expect(feed.said, ['在吗']);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);
  });

  testWidgets('空话不发（发了对面也只是空转一轮）', (tester) async {
    final feed = await _pumpPane(tester, initial: _ready);
    await tester.enterText(find.byType(TextField), '   ');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();
    expect(feed.said, isEmpty);
  });

  testWidgets('🔴 流进来的行画出来了：类型 + 那一小段 JSON（未知的**不许藏**）', (tester) async {
    final feed = await _pumpPane(tester, initial: _ready);
    feed.push(
      const HarnessLine(HarnessLineKind.unknown, 'todo/write', detail: '{"todos":[1,2]}'),
    );
    // ⚠️ 广播流的事件是**微任务**：一次 pump 只把微任务冲掉、那一帧还没画出来
    await tester.pump();
    await tester.pump();

    expect(find.text('todo/write'), findsOneWidget, reason: '★ 类型要在屏幕上');
    expect(find.text('{"todos":[1,2]}'), findsOneWidget, reason: '★ 那一小段 JSON 也要在');
  });

  testWidgets('🔴 停了 ⇒ 一句普通话 + 原因 + 「$harnessRestart」，点了**真的重连**', (tester) async {
    final feed = await _pumpPane(tester, initial: _ready);
    feed.to(const HarnessStatus(HarnessState.gone, '它那一台被收了'));
    await tester.pump();
    await tester.pump();

    expect(find.text(harnessGoneLine), findsOneWidget, reason: '★ 停了要说一句');
    expect(find.text('$harnessWhyPrefix它那一台被收了'), findsOneWidget, reason: '★ 原因也要说');
    expect(find.text(harnessRestart), findsOneWidget, reason: '★ 要有能自己动手的入口（N11）');
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, false);
    expect(find.text(harnessStop), findsNothing, reason: '已经停了就没有"停"');

    await tester.tap(find.text(harnessRestart));
    await tester.pump();
    expect(feed.restarts, 1, reason: '★ 点了"重来"就该真去重连（点了没反应 = 坏了）');
  });

  testWidgets('🔴 离开这个入口 ⇒ 那一头收干净（对面不留孤儿）', (tester) async {
    final feed = _FakeFeed();
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          controller: _controller(),
          onLoggedOut: () {},
          harnessFeed: () => feed,
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.text(harnessAppLabel));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip(miniAppBack));
    await tester.pumpAndSettle();

    expect(feed.closes, greaterThanOrEqualTo(1), reason: '★ 走了就要把这一头收掉');
  });

  // ── ★ 那个次要入口（契约 `82-DEV-MODE.md` §四 / §五）────────

  testWidgets('★ 拿到了那条链接 ⇒ 一句普通话 + 一个按钮，点了**原样**交出去', (tester) async {
    final src = _devReady();
    final opened = <String>[];
    await _openHarnessWithDev(
      tester,
      src,
      canOpen: true,
      openExternal: (u) {
        opened.add(u);
        return true;
      },
    );

    // 负向对照：那个按钮真的在屏幕上（不在的话下面那句断言扫的是别的东西）
    expect(find.text(devOpenAction), findsOneWidget, reason: '★ 那个按钮没进这棵树');
    expect(find.text(devOpenLead), findsOneWidget, reason: '★ 还要有一句普通话');

    await tester.tap(find.text(devOpenAction));
    await tester.pumpAndSettle();
    expect(
      opened,
      [_FakeDevSource._devUrl],
      reason: '★ 那条地址必须**原样**交出去（不许自己拼、不许改参数）',
    );
  });

  testWidgets('🔴 没被标（非 200）⇒ 只有一句普通话，**一个按钮都没有**', (tester) async {
    final src = _FakeDevSource(const DevHarnessNotMarked(403));
    await _openHarnessWithDev(tester, src, canOpen: true, openExternal: (_) => true);

    expect(find.text(devOpenNotMarked), findsOneWidget, reason: '★ 要如实说一句');
    expect(find.text(devOpenAction), findsNothing, reason: '★ 没被标就**不许**画按钮');
    // 负向对照：确实问过一趟（不是"忘了问"才没有按钮）
    expect(src.fetches, greaterThanOrEqualTo(1));
  });

  testWidgets('🔴 这个平台打不开 ⇒ 如实说一句、没有按钮，而且**连问都不问**', (tester) async {
    final src = _devReady();
    await _openHarnessWithDev(tester, src, canOpen: false, openExternal: (_) => true);

    expect(find.text(devOpenCannotHere), findsOneWidget, reason: '★ 要如实说打不开');
    expect(find.text(devOpenAction), findsNothing);
    expect(src.fetches, 0, reason: '★ 打不开就别去要那条链接');
  });

  testWidgets('🔴 点了没打开 ⇒ 如实说一句，而且**重取**（下次不再用那一条）', (tester) async {
    final src = _devReady();
    await _openHarnessWithDev(tester, src, canOpen: true, openExternal: (_) => false);

    await tester.tap(find.text(devOpenAction));
    await tester.pumpAndSettle();

    expect(find.text(devOpenFailed), findsOneWidget, reason: '★ 没打开也要说一句普通话');
    expect(find.text(devOpenAction), findsOneWidget, reason: '★ 按钮留着，让他再点一下');
    expect(src.forgets, 1, reason: '★ 点了失败 ⇒ 缓存要丢（契约 §五：短时效）');
  });

  testWidgets('🔴 问不到（网的问题）⇒ 一句普通话，没有按钮', (tester) async {
    final src = _FakeDevSource(const DevHarnessUnreachable('网断了'));
    await _openHarnessWithDev(tester, src, canOpen: true, openExternal: (_) => true);

    expect(find.text(devOpenUnreachable), findsOneWidget);
    expect(find.text(devOpenAction), findsNothing);
  });
}
