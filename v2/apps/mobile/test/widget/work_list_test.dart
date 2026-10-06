// **「正在干的活」那张浮窗 ＋ 左下角那颗「清单」**（主人 2026-10-06 ·
//   契约 `docs/dev/198-WORK-LIST.md`）。
//
// 这一份钉五件（每件都带反例）：
//   ① 🔴 那颗按钮在**底下那一行最左**，两个档都在同一个位置，命中区 ≥44；
//   ② 🔴 点一下 ⇒ 那张浮窗长出来（并且**那一刻**才去问一次"现在谁在干活"）；再点一下 ⇒ 收掉；
//   ③ 🔴 **换档就收掉**（那一张属于"刚才那一眼"）；上层不给内容 ⇒ **一颗都不画**；
//   ④ 🔴 三种状态一句都不许混：有活 / 真的一件都没有 / **没问上**（`null`）；
//   ⑤ 🔴 认不出的那间说"另一个对话"，**那串内部 id 一个字都不许出现在屏幕上**。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/work_list.dart';
import 'package:hupo_app/models/work_words.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/widgets/work_list_panel.dart';

/// 一个服务器会回的那一行（判据里的夹具）。
WorkingRow _row({
  String scope = 'abc',
  String? title = '记账',
  int? since = _now - 2 * 60 * 1000,
  int count = 1,
}) => WorkingRow(scope: scope, title: title, since: since, count: count);

const int _now = 1770000000000;

/// 假输入条那一格（真的那一格里**最右是那颗录音圆圈**）。
const Key _fakeComposerKey = Key('fake-composer');

/// **单看那张浮窗**（不经浮窗外壳）。
Future<void> _pumpPanel(
  WidgetTester tester, {
  required List<WorkingRow>? rows,
  bool busy = false,
  Map<String, String> mineNames = const {},
  void Function(WorkingRow)? onPick,
  VoidCallback? onClose,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: SizedBox(
            width: 380,
            child: WorkListPanel(
              rows: rows,
              busy: busy,
              mineNames: mineNames,
              now: _now,
              onPick: onPick ?? (_) {},
              onClose: onClose ?? () {},
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// **连着外壳一起泵**（那颗按钮 ＋ 它点开的那张浮窗）。
Future<void> _pumpFloater(
  WidgetTester tester, {
  FloaterTier tier = FloaterTier.collapsed,
  bool withPanel = true,
  List<WorkingRow>? rows,
  VoidCallback? onWorkOpen,
  double maxHeight = 600,
}) async {
  // ⚠️ **先清一次**：连着泵两次会复用同一个 `State`（`initialTier` 只在 `initState` 读一次）
  await tester.pumpWidget(const SizedBox());
  await tester.pump();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: SizedBox(
            width: 420,
            child: ChatFloater(
              maxHeight: maxHeight,
              initialTier: tier,
              title: '琥珀聊天',
              composer: const SizedBox(
                key: _fakeComposerKey,
                width: 300,
                height: d.voiceCircleBox,
              ),
              onWorkOpen: onWorkOpen,
              workPanel: withPanel
                  ? (ctx, close) => WorkListPanel(
                      rows: rows,
                      busy: false,
                      now: _now,
                      onClose: close,
                      onPick: (_) => close(),
                    )
                  : null,
              child: const SizedBox.shrink(),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  // ── ① 那颗按钮 ─────────────────────────────────────────────

  testWidgets('① 🔴 两个档里「清单」都在**底下那一行最左**，命中区 ≥44', (tester) async {
    for (final tier in [FloaterTier.collapsed, FloaterTier.full]) {
      await _pumpFloater(tester, tier: tier);
      expect(find.byKey(chatWorkKey), findsOneWidget, reason: '$tier：★ 清单那颗不见了');
      final b = tester.getRect(find.byKey(chatWorkKey));
      final bar = tester.getRect(find.byKey(_fakeComposerKey));
      expect(b.width >= 44 && b.height >= 44, true,
          reason: '$tier：★ 命中区 ${b.size} 小于 44×44（D3.6）');
      // 🔴 "左下角" ⇒ 它在输入条那一格**左边**，而且与它同一行（竖直方向重叠）
      expect(b.right <= bar.left + 0.5, true,
          reason: '$tier：★ 跑到输入条右边去了（${b.right} vs ${bar.left}）');
      expect(b.bottom > bar.top && b.top < bar.bottom, true,
          reason: '$tier：★ 与输入条不在同一行（${b.center.dy} vs ${bar.center.dy}）');
      // 🔴 而且它是**那一行最左**的东西（左边再没有别的东西同排）
      final handle = tester.getRect(find.byKey(chatHandleKey));
      expect(b.left < handle.left, true, reason: '$tier：★ 它该在展开那颗的左边');
    }
  });

  testWidgets('③ 🔴 上层不给内容 ⇒ 一颗按钮都不画（屏幕上不许有按不动的东西）', (tester) async {
    await _pumpFloater(tester, withPanel: false);
    expect(find.byKey(chatWorkKey), findsNothing);
    expect(find.byKey(workPanelKey), findsNothing);
    // 反例：给了内容它就必须在（不然上面那条就是空转）
    await _pumpFloater(tester, withPanel: true);
    expect(find.byKey(chatWorkKey), findsOneWidget);
  });

  // ── ② 点开 / 收掉 ──────────────────────────────────────────

  testWidgets('② 🔴 点一下长出来、再点一下收回去；点开那一下**才**去问一次', (tester) async {
    var asked = 0;
    await _pumpFloater(tester, rows: [_row()], onWorkOpen: () => asked++);
    expect(find.byKey(workPanelKey), findsNothing, reason: '一上来它不该是开着的');

    await tester.tap(find.byKey(chatWorkKey));
    await tester.pumpAndSettle();
    expect(find.byKey(workPanelKey), findsOneWidget, reason: '★ 点了它没长出来');
    expect(asked, 1, reason: '★ 点开的那一下该去问一次（清单要的是"现在"）');
    expect(find.text('记账'), findsOneWidget);

    // 再点一下 ⇒ 收掉（同一个入口）
    await tester.tap(find.byKey(chatWorkKey));
    await tester.pumpAndSettle();
    expect(find.byKey(workPanelKey), findsNothing, reason: '★ 再点一下没有收掉');
    expect(find.text('记账'), findsNothing);
    expect(asked, 1, reason: '收掉那一下不该再去问');
  });

  testWidgets('② 🔴 「关上」那颗真的收得掉（不是画着好看的）', (tester) async {
    await _pumpFloater(tester, rows: [_row()]);
    await tester.tap(find.byKey(chatWorkKey));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(workCloseKey));
    await tester.pumpAndSettle();
    expect(find.byKey(workPanelKey), findsNothing);
    // 🔴 反例：那颗按钮自己**不许**跟着消失（收掉的是清单，不是那颗按钮）
    expect(find.byKey(chatWorkKey), findsOneWidget);
  });

  testWidgets('③ 🔴 换档就把它收掉（那一张属于"刚才那一眼"）', (tester) async {
    await _pumpFloater(tester, rows: [_row()]);
    await tester.tap(find.byKey(chatWorkKey));
    await tester.pumpAndSettle();
    expect(find.byKey(workPanelKey), findsOneWidget);
    // 点抓手 ⇒ 拉满
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byKey(workPanelKey), findsNothing, reason: '★ 换档之后那张还挂在屏幕上');
  });

  // ── ④ 三种状态 ────────────────────────────────────────────

  testWidgets('④ 🔴 有活：名字 ＋（在干活 · 干了多久）都在；点一行走 onPick', (tester) async {
    WorkingRow? picked;
    await _pumpPanel(
      tester,
      rows: [_row(scope: 'abc', title: '记账', count: 3)],
      onPick: (r) => picked = r,
    );
    expect(find.text('记账'), findsOneWidget);
    expect(
      find.text('$workBusyLabel$workPartSep${3} $workCountUnit$workPartSep干了 2 分钟'),
      findsOneWidget,
      reason: '★ 底下那一句不对（件数与时长）',
    );
    await tester.tap(find.byKey(workRowKey('abc')));
    await tester.pumpAndSettle();
    expect(picked?.scope, 'abc', reason: '★ 点那一行没有把那一间报上去');
  });

  testWidgets('④ 🔴 真的一件都没有 ⇒ 说"没有在干的活"', (tester) async {
    await _pumpPanel(tester, rows: const []);
    expect(find.text(workEmptyWords), findsOneWidget);
    expect(find.text(workFailWords), findsNothing);
  });

  testWidgets('④ 🔴 没问上（`null`）⇒ 说"没问上"，**绝不许**说"没有在干的活"', (tester) async {
    // 还在问
    await _pumpPanel(tester, rows: null, busy: true);
    expect(find.text(workLoadingWords), findsOneWidget);
    expect(find.text(workEmptyWords), findsNothing,
        reason: '★ 还没问到就说"没有在干的活" = 假话');
    // 问完了、没问上
    await _pumpPanel(tester, rows: null, busy: false);
    expect(find.text(workFailWords), findsOneWidget);
    expect(find.text(workEmptyWords), findsNothing,
        reason: '★ 看不见 ≠ 没有（这一条是这张清单最容易说错的一句话）');
  });

  // ── ⑤ 名字 ────────────────────────────────────────────────

  testWidgets('⑤ 🔴 认不出的那间说"另一个对话"，那串内部 id 一个字都不上屏', (tester) async {
    const weird = 'a7f3c9e1e8b2';
    await _pumpPanel(tester, rows: [_row(scope: weird, title: null)]);
    expect(find.text(workNamelessName), findsOneWidget);
    expect(find.text(weird), findsNothing, reason: '★ 内部 id 上屏了');
    expect(find.textContaining(weird), findsNothing, reason: '★ 内部 id 混进别的句子里了');
    // 反例：服务端给了名字就照它的说
    await _pumpPanel(tester, rows: [_row(scope: weird, title: '记账')]);
    expect(find.text('记账'), findsOneWidget);
    expect(find.text(workNamelessName), findsNothing);
  });

  testWidgets('⑤ 🔴 服务端没给名字，但壳里那份清单认得它 ⇒ 用壳里那个名字', (tester) async {
    const weird = 'a7f3c9e1e8b2';
    await _pumpPanel(
      tester,
      rows: [_row(scope: weird, title: null)],
      mineNames: const {weird: '记账'},
    );
    expect(find.text('记账'), findsOneWidget);
    expect(find.text(workNamelessName), findsNothing);
    expect(find.textContaining(weird), findsNothing);
  });

  // ── 行级命中区（D3.6 那一档：整行宽 × 行高 ≥ 44×44）────────────

  testWidgets('⑤ 🔴 每一行是**整行**可点的，面积过 D3.6 的行级那一档', (tester) async {
    await _pumpPanel(tester, rows: [_row(scope: 'abc'), _row(scope: 'def', title: '天气')]);
    for (final s in ['abc', 'def']) {
      final r = tester.getRect(find.byKey(workRowKey(s)));
      expect(r.width >= 44, true, reason: '$s：★ 整行宽 ${r.width} 小于 44');
      expect(r.width * r.height >= 44 * 44, true,
          reason: '$s：★ 面积 ${r.width * r.height} 小于 44×44（D3.6 行级那一档）');
    }
  });

  testWidgets('⑤ 地方不够时那张清单自己滚，不许把底下那一行顶出去', (tester) async {
    // 一台"很矮"的窗口：浮窗可用高度刚好够放下"清单 ＋ 底下那一行"
    await _pumpFloater(
      tester,
      rows: [for (var i = 0; i < 8; i++) _row(scope: 'r$i', title: '第 $i 间')],
      maxHeight: 180,
    );
    await tester.tap(find.byKey(chatWorkKey));
    await tester.pumpAndSettle();
    expect(find.byKey(workPanelKey), findsOneWidget);
    // 🔴 底下那一行**还在屏幕上**（清单没有把它挤出去）
    expect(find.byKey(_fakeComposerKey), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
