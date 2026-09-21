// **取消注册**（主人 2026-09-22："贴 apikey 的时候，也要有个撤回的功能。隐蔽一点。
// 就是取消注册。这样我就不用浪费资源了"）。
//
// ── 这一份钉四条（每条都带负向对照）────────────────────────
//   1. 🔴 **先说清删什么，再动手**（手册 X3 ② 那条"删前列清单"）——
//      点入口**只弹框**，**一次都不许调接口**；
//   2. 「先算了」⇒ **一次都不调**（负向对照：白弹一个框就删了，就是事故）；
//   3. 「确定取消」⇒ 调**一次**；成功 ⇒ 回登录页（`onCancelled` 被叫）；
//   4. **几种"不行"分开说**（还没接上 / 那一台得找人收 / 没送上去）——
//      混成一句他会一直重试；而且**都不许把人踢回登录页**（他还在，只是没收成）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/model_key_screen.dart';
import 'package:hupo_app/services/api.dart';

/// 搭一个钥匙屏，并把"调了几次接口 / 回没回登录页"记下来。
Future<({List<int> calls, List<int> loggedOut})> _pump(
  WidgetTester tester,
  CancelOutcome outcome, {
  bool withCancel = true,
}) async {
  final calls = <int>[];
  final out = <int>[];
  await tester.pumpWidget(MaterialApp(
    home: ModelKeyScreen(
      onSubmit: (_) async => KeySend.ok,
      onCancel: withCancel
          ? () async {
              calls.add(1);
              return outcome;
            }
          : null,
      onCancelled: withCancel ? () => out.add(1) : null,
    ),
  ));
  return (calls: calls, loggedOut: out);
}

void main() {
  testWidgets('🔴 点那个入口 ⇒ **只弹框**，而且框里把"删掉什么"列清楚了', (tester) async {
    final r = await _pump(tester, CancelOutcome.ok);
    expect(find.text(keyCancelEntry), findsOneWidget, reason: '入口要在');
    await tester.tap(find.text(keyCancelEntry));
    await tester.pumpAndSettle();

    expect(find.text(keyCancelTitle), findsOneWidget);
    // ★ "删前列清单"：那句话说清了会没掉什么、以及**没法撤销**
    expect(find.text(keyCancelWhat), findsOneWidget);
    expect(keyCancelWhat.contains('没法撤销'), isTrue, reason: '必须说清不可逆');
    // 🔴 负向对照：**还没点"确定"**，所以一次都不许调
    expect(r.calls, isEmpty, reason: '🔴 弹框就调接口 = 点了才知道会删');
  });

  testWidgets('🔴 「先算了」⇒ **一次都不调**（负向对照）', (tester) async {
    final r = await _pump(tester, CancelOutcome.ok);
    await tester.tap(find.text(keyCancelEntry));
    await tester.pumpAndSettle();
    await tester.tap(find.text(keyCancelNo));
    await tester.pumpAndSettle();
    expect(r.calls, isEmpty, reason: '🔴 他说"先算了"，一个字节都不该动');
    expect(r.loggedOut, isEmpty, reason: '也不该把他踢出去');
  });

  testWidgets('「确定取消」+ 服务端说好了 ⇒ 调**一次**，而且回登录页', (tester) async {
    final r = await _pump(tester, CancelOutcome.ok);
    await tester.tap(find.text(keyCancelEntry));
    await tester.pumpAndSettle();
    await tester.tap(find.text(keyCancelYes));
    await tester.pumpAndSettle();
    expect(r.calls.length, 1, reason: '只调一次（两次就是投两张申请）');
    expect(r.loggedOut.length, 1, reason: '收掉了 ⇒ 回登录页（令牌已经被撤了）');
  });

  testWidgets('🔴 服务端说"还没接上" ⇒ 说那一句，而且**不许**把人踢回登录页', (tester) async {
    final r = await _pump(tester, CancelOutcome.noHelper);
    await tester.tap(find.text(keyCancelEntry));
    await tester.pumpAndSettle();
    await tester.tap(find.text(keyCancelYes));
    await tester.pumpAndSettle();
    expect(find.text(keyCancelNoHelper), findsOneWidget, reason: '要说清是"我们这边还没接上"');
    expect(r.loggedOut, isEmpty, reason: '🔴 没收成就把人踢出去 = 假话（他还登着、那台还在）');
  });

  testWidgets('几种"不行"**各说各的**（不混成一句）', (tester) async {
    for (final (outcome, word) in [
      (CancelOutcome.protectedOne, keyCancelProtected),
      (CancelOutcome.local, keyCancelLocal),
      (CancelOutcome.noTenant, keyCancelNone),
      (CancelOutcome.failed, keyCancelFailed),
    ]) {
      await _pump(tester, outcome);
      await tester.tap(find.text(keyCancelEntry));
      await tester.pumpAndSettle();
      await tester.tap(find.text(keyCancelYes));
      await tester.pumpAndSettle();
      expect(find.text(word), findsOneWidget, reason: '$outcome 该说「$word」');
    }
  });

  testWidgets('不传 onCancel ⇒ **入口不出现**（单看这一屏的测试不受影响）', (tester) async {
    await _pump(tester, CancelOutcome.ok, withCancel: false);
    expect(find.text(keyCancelEntry), findsNothing);
  });

  testWidgets('🔴 那几句里不许出现内部词', (tester) async {
    for (final w in [keyCancelEntry, keyCancelTitle, keyCancelWhat, keyCancelNo, keyCancelYes,
                     keyCancelOk, keyCancelNoHelper, keyCancelProtected, keyCancelLocal,
                     keyCancelNone, keyCancelFailed]) {
      for (final bad in ['模型', '工作区', '口令', '客户端', '云端', '服务器', '调度器', '时间线', '作用域', '会话', '搜索', '上下文', '系统提示']) {
        expect(w.contains(bad), isFalse, reason: '「$w」里有内部词「$bad」');
      }
    }
  });
}
