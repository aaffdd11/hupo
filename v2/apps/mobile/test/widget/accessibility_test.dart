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

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/login_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
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

/// **像用户那样**打开关于页：从主界面点顶栏那个 i。
///
/// ⚠️ 直接把 `AboutScreen` 当 `home` 泵出来的话，它**没有返回键**
///    （没有可弹回去的路由）⇒ 命中区扫描会"一个能点的都没扫到"，
///    然后被那条负向对照拦下来。**那条负向对照是对的** —— 它说的就是
///    "扫描是空转的"。⇒ 用真入口进。
Future<void> _openAbout(WidgetTester tester, double scale) async {
  await _pump(tester, ChatScreen(controller: _controller(), onLoggedOut: () {}), scale);
  await tester.tap(find.byTooltip('关于'));
  await tester.pumpAndSettle();
}

/// **像用户那样**打开过程四档的切换面板（批 3 新加的入口）。
///
/// ⚠️ 和关于页同一条理由：新加的界面**必须也过五档不溢出那道硬闸**，
///    不然"五档不溢出"会随时间失效。
Future<void> _openProcessMenu(WidgetTester tester, double scale) async {
  await _pump(tester, ChatScreen(controller: _controller(), onLoggedOut: () {}), scale);
  await tester.tap(find.byTooltip('它说多少过程'));
  await tester.pumpAndSettle();
}

/// 一份"过程那一块拉满"的控制器：步骤流水 + 推理原文都在屏幕上。
///
/// ⚠️ 用**最高的那一档**（`reasoning`）：它同时包含步骤流水与推理原文，
///    也就是这一批新加的两样最多的字。
Future<ChatController> _processController() async {
  final c = _controller();
  await c.setLevel(ProcessLevel.reasoning);
  c.ingest({'type': 'message/status', 'turn': 1, 'state': 'started'});
  c.ingest({'type': 'step/start', 'turn': 1, 'step': 1, 'state': 'searching'});
  c.ingest({'type': 'step/start', 'turn': 1, 'step': 2, 'state': 'writing'});
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

void main() {
  // 换档会写本机设置（`ProcessLevelStore`）——测试里给它一个空盘，
  // 免得真去敲一个不存在的平台插件（写失败也不会抛，但别让它去敲）。
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // ── D3.5 ──────────────────────────────────────────────────

  group('D3.5：容器跟字算，五档不许溢出', () {
    for (final s in scales) {
      testWidgets('登录页 @ ${s}x', (tester) async {
        await _pump(tester, _login(), s);
        expect(_drain(tester), isEmpty, reason: '登录页在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（满内容 + 那行"它正在做…"）', (tester) async {
        final c = _controller();
        _stuff(c.timeline);
        c.timeline.apply({'type': 'message/status', 'turn': 1, 'state': 'started'});
        await _pump(tester, ChatScreen(controller: c, onLoggedOut: () {}), s);
        expect(_drain(tester), isEmpty, reason: '主界面在 ${s}x 溢出了');
      });

      testWidgets('主界面 @ ${s}x（步骤流水 + 推理原文拉满 —— 批 3 新加的）', (tester) async {
        final c = await _processController();
        await _pump(tester, ChatScreen(controller: c, onLoggedOut: () {}), s);
        expect(_drain(tester), isEmpty, reason: '过程那一块在 ${s}x 溢出了');
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

      testWidgets('空屏 @ ${s}x', (tester) async {
        await _pump(tester, ChatScreen(controller: _controller(), onLoggedOut: () {}), s);
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
      await _pump(tester, ChatScreen(controller: _controller(), onLoggedOut: () {}), 1.0);
      fontSize[1.0] = fontSizeAt(tester, bodyLine);
    });

    testWidgets('记下 3.1x 的字号', (tester) async {
      await _pump(tester, ChatScreen(controller: _controller(), onLoggedOut: () {}), 3.1);
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
    void sweep(WidgetTester tester, String where) {
      var checked = 0;
      for (final type in <Type>[IconButton, TextButton, FilledButton, ElevatedButton]) {
        for (final e in find.byType(type).evaluate()) {
          final r = tester.getSemantics(find.byWidget(e.widget)).rect;
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
      testWidgets('登录页 @ ${s}x', (tester) async {
        await _pump(tester, _login(), s);
        sweep(tester, '登录页 @${s}x');
      });

      testWidgets('关于页（从真入口进）@ ${s}x', (tester) async {
        await _openAbout(tester, s);
        sweep(tester, '关于页 @${s}x');
      });

      testWidgets('主界面（含"重发"那个入口）@ ${s}x', (tester) async {
        final c = _controller();
        _stuff(c.timeline);
        await _pump(tester, ChatScreen(controller: c, onLoggedOut: () {}), s);
        sweep(tester, '主界面 @${s}x');
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
