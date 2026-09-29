// **录音时那颗话筒上的脉动**（契约 `docs/dev/133-REC-BUTTON-AND-SEND.md`。
//   主人 2026-09-29：*"正在录音，就放到录音按钮上，麦克风logo变成一个在闪动的bar"*）。
//
// 这一份钉三件（每件都带反例）：
//   ① 🔴 **正在录 ⇒ 那颗按钮上是脉动，不是话筒图形**（两态不许叠在一起）；
//   ② 🔴 **不录了就一定要收掉**（"不许假装还在录"那一族的第二处）；
//   ③ 🔴 **那个永不结束的动画必须读总开关**（手册 §6.1.1 M1–M4）：
//      关掉之后判据**不超时**、而且**那一层照旧画**（M3：不动 ≠ 没有）。
//
// ⚠️ 测试里那个开关**是关着的**（`test/flutter_test_config.dart`，M2 说的"只有一处"）
//    ⇒ 这里量到的都是"停在第 0 刻"的样子。要验"它真的会动"就得**在这一份里临时打开**
//      —— 见 ③ 的第二段（打开 → 推帧 → 高度真的变了 → 再关回去）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/hearing_session.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/models/motion_switch.dart';
import 'package:hupo_app/widgets/composer.dart';
import 'package:hupo_app/widgets/rec_pulse.dart';

/// 一个把 `hearing` 钉成某一态的小夹具（状态住上层 ⇒ 用 `ValueNotifier` 推）。
Future<ValueNotifier<Hearing>> _pump(
  WidgetTester tester,
  Hearing start, {
  /// ⚠️ **开着总开关时不许 `pumpAndSettle`**：那个动画永不结束 ⇒ 它转到超时
  ///    （这一份判据第一版就是这么红的 —— 那正是这个开关存在的理由）。
  bool settle = true,
}) async {
  final n = ValueNotifier<Hearing>(start);
  addTearDown(n.dispose);
  // ⚠️ 这一份判据只关心**那一格按钮**（不碰控制器那条真麦）
  //    ⇒ 直接泵一个 `Composer` 并把 `hearing` 钉成某一态。
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ValueListenableBuilder<Hearing>(
          valueListenable: n,
          builder: (context, h, _) => Composer(
            onSend: (_) {},
            hearing: h,
            canHear: true,
            onMicToggle: () {},
            leading: const SizedBox(width: d.barButtonBox, height: d.barButtonBox),
          ),
        ),
      ),
    ),
  );
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
  }
  return n;
}

const _listening = Hearing(phase: HearingPhase.listening);

void main() {
  test('① 🔴 总开关**默认是开的**（M1：默认关的话线上静止、测试全绿，两边都不知道自己错了）', () {
    // ⚠️ 这一条**不许读那个标志的当前值**去断言"测试里它该是关的" ——
    //    判据自己读那个开关 = 自己给自己发答案（手册 §6.1.1 末尾那条教训）。
    //    能钉的是"**默认值**"这件事：源码里那一行写的就是 true。
    expect(hupoAnimationsDefault, true);
  });

  testWidgets('② 正在录 ⇒ 那颗按钮上是**脉动**，话筒图形**不画**', (tester) async {
    await _pump(tester, _listening);
    expect(find.byKey(recPulseKey), findsOneWidget, reason: '★ 正在录却看不到那几根 bar');
    expect(find.byIcon(Icons.mic_none), findsNothing,
        reason: '★ 话筒图形与脉动同时在 ⇒ 两个状态叠在一起');
    // 负向对照：不录的时候**反过来**（话筒在、脉动不在）
    await _pump(tester, const Hearing());
    expect(find.byKey(recPulseKey), findsNothing, reason: '★ 没在录还画着脉动 = 假装在录');
    expect(find.byIcon(Icons.mic_none), findsOneWidget);
  });

  testWidgets('②·补 🔴 正在录时**不许出现一块空板子**（那句话本来就没有）', (tester) async {
    // 这条是**真浏览器截图**抓出来的：`busy` 为真、`notice` 为空时，
    // 原来那个条件会在那一行上面画一块什么都没有的白板（看着像坏了）。
    await _pump(tester, _listening);
    final plates = tester
        .widgetList<Container>(
          find.descendant(of: find.byType(Composer), matching: find.byType(Container)),
        )
        .where((c) => c.constraints?.maxWidth == double.infinity)
        .length;
    expect(plates, 0, reason: '★ 正在录但没话要说 ⇒ 不该有那块"为什么停了"的板子');
    // 反向对照：真有那句话时，板子要出来（不然用户看不到它为什么停了）
    // `notice` 是算出来的：`phase != listening` 时它就是 `why`
    await _pump(tester, const Hearing(phase: HearingPhase.failed, why: hearNothing));
    expect(
      tester
          .widgetList<Container>(
            find.descendant(of: find.byType(Composer), matching: find.byType(Container)),
          )
          .where((c) => c.constraints?.maxWidth == double.infinity)
          .length,
      1,
      reason: '★ 有那句实话时板子不见了',
    );
  });

  testWidgets('③ 🔴 总开关关着 ⇒ 判据**不超时**，而且那一层**照旧画**（M3：不动 ≠ 没有）', (tester) async {
    expect(hupoAnimationsEnabled, false, reason: '测试里那个开关该是关着的（M2 只有一处关它）');
    await _pump(tester, _listening);
    // 不超时（能走到这里就说明 `pumpAndSettle` 出来了）+ 那几根 bar 还在
    expect(find.byKey(recPulseKey), findsOneWidget,
        reason: '★ 关掉开关之后那一层不见了 —— M3 说"不动"与"没有"是两件事');
    final before = tester.getSize(find.byKey(recPulseKey));
    await tester.pump(const Duration(milliseconds: 450));
    expect(tester.getSize(find.byKey(recPulseKey)), before,
        reason: '★ 关着开关它还在动');
  });

  testWidgets('④ 🔴 打开开关 ⇒ 它**真的会动**（拿同一个 widget 的高度量，不看"像在动"）', (tester) async {
    setHupoAnimationsEnabled(on: true);
    addTearDown(() => setHupoAnimationsEnabled(on: false)); // 收尾：还回测试那一档
    await _pump(tester, _listening, settle: false);
    final heights = <double>{};
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 120));
      heights.add(
        tester
            .widgetList<Container>(
              find.descendant(of: find.byKey(recPulseKey), matching: find.byType(Container)),
            )
            .first
            .constraints!
            .maxHeight,
      );
    }
    expect(heights.length, greaterThan(1),
        reason: '★ 开着开关推了 6 帧，那几根 bar 的高度一个数都没变 —— 它根本没在动');
    expect(heights.every((h) => h >= d.recPulseBarMin && h <= d.recPulseBarMax), true);
  });
}
