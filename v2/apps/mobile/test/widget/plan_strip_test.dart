// **计划条**（主人 2026-09-23 要的「进行中的目标 / 任务列表」· `64-CHAT-REDESIGN.md`）。
//
// 这一份钉三件：
//   ① 服务端那条 `plan/updated` 解得对（目标 / 三档状态 / 清单 / 条数）
//   ② 🔴 **空的那份 / 认不出的 ⇒ `null`**（界面**一个像素都不画**）
//   ③ 界面上最多画三件、在做的那件排最前、没画出来的**如实报数**

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/plan.dart';
import 'package:hupo_app/models/plan_words.dart';
import 'package:hupo_app/widgets/plan_strip.dart';

Map<String, dynamic> ev({
  Object? goal,
  List<Object?> todos = const [],
  int? doneCount,
  int? total,
  int? more,
}) => {
  'type': 'plan/updated',
  if (goal != null) 'goal': goal,
  'todos': todos,
  if (doneCount != null) 'doneCount': doneCount,
  if (total != null) 'total': total,
  if (more != null) 'more': more,
};

void main() {
  group('解析（纯函数）', () {
    test('★ 目标 + 清单：字段各归各位，在做的那件排最前', () {
      final p = Plan.fromEvent(
        ev(
          goal: {'text': '把聊天窗口重设计做完', 'phase': 'active'},
          todos: [
            {'text': '读代码', 'now': false, 'done': true},
            {'text': '写那条计划条', 'now': true, 'done': false},
            {'text': '跑闸', 'now': false, 'done': false},
          ],
          doneCount: 1,
          total: 3,
        ),
      )!;
      expect(p.goal, '把聊天窗口重设计做完');
      expect(p.phase, PlanPhase.active);
      expect(p.shown.first.text, '写那条计划条', reason: '在做的那件排最前');
      expect(p.doneCount, 1);
      expect(p.hidden, 0);
    });

    test('🔴 空的那份 / 认不出的 ⇒ `null`（界面不画）', () {
      expect(Plan.fromEvent({'type': 'plan/updated', 'todos': []}), isNull);
      expect(
        Plan.fromEvent({'type': 'plan/updated', 'goal': null, 'todos': []}),
        isNull,
      );
      expect(Plan.fromEvent({'type': '别的'}), isNull);
      expect(Plan.fromEvent(null), isNull);
      expect(Plan.fromEvent('plan/updated'), isNull);
    });

    test('★ 认不出的阶段 ⇒ `unknown`，但**照样把计划画出来**（不许整条藏掉）', () {
      final p = Plan.fromEvent(
        ev(
          goal: {'text': '干一件事', 'phase': '未来才有的阶段'},
          todos: [
            {'text': '一件', 'now': false, 'done': false},
          ],
        ),
      )!;
      expect(p.phase, PlanPhase.unknown);
      expect(p.goal, '干一件事');
      expect(planPhaseWords['unknown'], '');
    });

    test('★ 只画三件；没画出来的**如实报数**（含服务端封顶之外的那些）', () {
      final p = Plan.fromEvent(
        ev(
          todos: List.generate(
            9,
            (i) => {'text': '第 ${i + 1} 件', 'now': false, 'done': false},
          ),
          total: 25,
          more: 16,
        ),
      )!;
      expect(p.shown.length, Plan.shownTodos);
      expect(p.total, 25);
      expect(p.hidden, 25 - Plan.shownTodos, reason: '还剩多少件要如实说');
      expect(planMoreWords(p.hidden), contains('22'));
    });

    test('★ 每一件都做完了 ⇒ `allDone`（界面据此把这条收起来）', () {
      final plan = Plan.fromEvent(
        ev(todos: [
          {'text': '写计划条', 'now': false, 'done': true},
          {'text': '跑闸', 'now': false, 'done': true},
        ]),
      )!;
      expect(plan.allDone, true);
      expect(plan.doneCount, 2);
      expect(plan.total, 2);
    });

    test('🔴 负向对照：还有没做完的 ⇒ 不算全做完', () {
      final plan = Plan.fromEvent(
        ev(todos: [
          {'text': '写完了', 'now': false, 'done': true},
          {'text': '还没做', 'now': true, 'done': false},
        ]),
      )!;
      expect(plan.allDone, false);
    });

    test('🔴 服务端**封过顶**时绝不说"全做完"（没画出来的那几件我们不知道）', () {
      // 画面上三件全打勾，而服务端说一共 7 件 ⇒ 剩下 4 件做没做完**不知道**
      final plan = Plan.fromEvent(
        ev(
          todos: [
            {'text': '甲', 'now': false, 'done': true},
            {'text': '乙', 'now': false, 'done': true},
            {'text': '丙', 'now': false, 'done': true},
          ],
          doneCount: 3,
          total: 7,
          more: 4,
        ),
      )!;
      expect(plan.allDone, false, reason: '★ 封顶之外的没画出来 ⇒ 不许假装收工');
    });

    test('🔴 一件都没有（只有目标）⇒ 不算"全做完"（那叫"没有计划"，本来就不画）', () {
      final plan = Plan.fromEvent(ev(goal: {'text': '把这件事做完', 'phase': 'active'}))!;
      expect(plan.total, 0);
      expect(plan.allDone, false);
    });

    test('★ 条目的形状卡住：没有正文 / 不是 map 的直接丢掉', () {
      final p = Plan.fromEvent(
        ev(
          todos: [
            {'text': '  ', 'now': false, 'done': false},
            '不是 map',
            {'now': true},
            {'text': '好的这一件', 'now': true, 'done': false},
          ],
        ),
      )!;
      expect(p.todos.length, 1);
      expect(p.todos.single.text, '好的这一件');
    });
  });

  group('界面上那一条', () {
    Future<void> pump(WidgetTester tester, Plan? plan) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topCenter,
              child: PlanStrip(plan: plan),
            ),
          ),
        ),
      );
      await tester.pump();
    }

    testWidgets('🔴 没有计划 ⇒ **一个像素都不画**（空态禁令）', (tester) async {
      await pump(tester, null);
      expect(find.byType(Text), findsNothing);
      expect(find.byType(Icon), findsNothing);
    });

    testWidgets('🔴 全做完了 ⇒ **收起来**（"还在"不是我们要的：它不再是"进行中"）', (tester) async {
      final plan = Plan.fromEvent(
        ev(todos: [
          {'text': '查北京天气', 'now': false, 'done': true},
          {'text': '查上海天气', 'now': false, 'done': true},
        ]),
      )!;
      expect(plan.allDone, true, reason: '★ 夹具本身要真是全做完的');
      await pump(tester, plan);
      expect(find.byType(Text), findsNothing, reason: '★ 全做完就得收起来（主人 2026-09-23 的实测反馈）');
      expect(find.byType(Icon), findsNothing);
    });

    testWidgets('🔴 完成的条目不画**删除线**（那条横线会被读成"删掉了"）', (tester) async {
      final plan = Plan.fromEvent(
        ev(todos: [
          {'text': '这一件做完了', 'now': false, 'done': true},
          {'text': '这一件在做', 'now': true, 'done': false},
        ]),
      )!;
      await pump(tester, plan);
      final done = tester.widget<Text>(find.textContaining('这一件做完了'));
      final doing = tester.widget<Text>(find.textContaining('这一件在做'));
      expect(
        done.style?.decoration,
        isNot(TextDecoration.lineThrough),
        reason: '★ 完成用勾说，不用横线说（横线被读成"删掉了"）',
      );
      expect(doing.style?.decoration, isNot(TextDecoration.lineThrough));
      // 负向对照：勾**还在**（"做完了"这个信息一个都没少）
      expect(find.byIcon(Icons.check_box_outlined), findsOneWidget);
    });

    testWidgets('★ 有计划 ⇒ 目标一行 + 那几件 + 「还有 N 件」都在屏幕上', (tester) async {
      final plan = Plan.fromEvent(
        ev(
          goal: {'text': '把重设计做完', 'phase': 'active'},
          todos: [
            {'text': '写计划条', 'now': true, 'done': false},
            {'text': '跑闸', 'now': false, 'done': false},
          ],
          total: 7,
        ),
      )!;
      await pump(tester, plan);
      expect(find.textContaining('把重设计做完'), findsOneWidget);
      expect(find.textContaining('写计划条'), findsOneWidget);
      expect(find.textContaining('跑闸'), findsOneWidget);
      expect(
        find.textContaining('还有'),
        findsOneWidget,
        reason: '没画出来的那几件要如实报数',
      );
    });

    testWidgets('🔴 3.1 倍字号下**不溢出**（大字号最容易把这一条炸开）', (tester) async {
      // ⚠️ 为什么单钉：可访问性硬闸扫的那几屏里**没有计划**（`c.plan == null` ⇒ 不画），
      //    所以那条闸**盖不到这一条**。而它是"跟字算"这条纪律最容易被破的地方。
      //    Flutter 的测试框架会把溢出记成异常 ⇒ 这一条不需要断言别的东西。
      final plan = Plan.fromEvent({
        'type': 'plan/updated',
        'goal': {'text': '把聊天窗口重设计这一段整个做完，包括计划条与聊天记录那些事', 'phase': 'active'},
        'todos': [
          {'text': '写服务端那一条事件，并且把工具名与内部 id 全部挡在门外', 'now': true, 'done': false},
          {'text': '写客户端那一条 UI', 'now': false, 'done': false},
          {'text': '跑闸、部署、截图看一眼', 'now': false, 'done': false},
        ],
        'total': 9,
      })!;
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(textScaler: TextScaler.linear(3.1)),
            child: Scaffold(
              body: Align(
                alignment: Alignment.topCenter,
                child: PlanStrip(plan: plan),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(
        tester.takeException(),
        isNull,
        reason: '3.1 倍下溢出 = 缺陷（D3.5：跟字算、不封顶）',
      );
    });

    testWidgets('🔴 它**不可点**（点它要穿透到桌面，不然屏幕上沿多一块死区）', (tester) async {
      final plan = Plan.fromEvent(
        ev(
          goal: {'text': '干一件事', 'phase': 'active'},
          todos: [
            {'text': '一件', 'now': false, 'done': false},
          ],
        ),
      )!;
      var tapped = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Stack(
              children: [
                // 桌面在下面：它自己可点（这一条模拟"点桌面空白"那条路）
                Positioned.fill(
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => tapped += 1,
                    child: const SizedBox.expand(),
                  ),
                ),
                Align(
                  alignment: Alignment.topCenter,
                  child: PlanStrip(plan: plan),
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.textContaining('干一件事'));
      await tester.pump();
      expect(tapped, 1, reason: '★ 那一下该落到桌面上（计划条只是指示，不是按钮）');
    });
  });
}
