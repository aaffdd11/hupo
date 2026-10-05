// **在录时那颗圆圈的"一明一暗"**（主人 2026-10-05：*"录音按钮在激活的时候，
//   要有一个循环的效果，就是颜色一明一暗的闪烁。"*）。
//
// 这一份钉四件（每件都带反例）：
//   ① 🔴 **正在录 ⇒ 底色真的在变**（拿同一个 widget 的颜色量，不看"像在闪"）；
//   ② 🔴 **不录 ⇒ 一个像素都不动**（底色跨帧恒等）；
//   ③ 🔴 **按停（收尾中）⇒ 不闪了，而且屏幕上当场换成那句"收下了，正在整理……"**
//      —— 主人报的"点击停止录音响应很慢"修的就是这一条；
//   ④ 🔴 **那个永不结束的动画必须读总开关**（手册 §6.1.1 M1–M4）：
//      关掉之后判据**不超时**、而且**那一层照旧画**（M3：不动 ≠ 没有）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/hear_drill.dart';
import 'package:hupo_app/models/hear_words.dart';
import 'package:hupo_app/models/motion_switch.dart';
import 'package:hupo_app/widgets/voice_bar.dart';

/// 一个把状态钉成某一档的夹具（状态住上层 ⇒ 直接给它一份 `HearDrill`）。
Future<void> _pump(WidgetTester tester, HearDrill flow, {bool settle = true}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: VoiceBar(
          flow: flow,
          canHear: true,
          onMic: () {},
          onTyped: (_) {},
        ),
      ),
    ),
  );
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
  }
}

/// 那颗圆圈这一帧的底色（拿的是**它自己**那个 `Material`，不是外面那层）。
Color _circleColor(WidgetTester tester) {
  final m = tester.widget<Material>(
    find
        .descendant(of: find.byKey(voiceBarCircleKey), matching: find.byType(Material))
        .first,
  );
  return m.color!;
}

HearDrill _listening() => const HearDrill().startListening();
HearDrill _wrapping() =>
    const HearDrill().startListening().event({'type': 'asr/final', 'text': '帮我看看天气'}).stopListening();

/// [c] 的三个通道是不是都夹在 [a] 与 [b] 之间（颜色插值出来的样子）。
bool _between(Color c, Color a, Color b) {
  bool ok(double v, double x, double y) {
    final lo = x < y ? x : y;
    final hi = x > y ? x : y;
    return v >= lo - 1e-6 && v <= hi + 1e-6;
  }

  return ok(c.r, a.r, b.r) && ok(c.g, a.g, b.g) && ok(c.b, a.b, b.b);
}

void main() {
  testWidgets('③ 🔴 按停（收尾中）⇒ **当场**换成那句话，而且不闪了', (tester) async {
    // 主人 2026-10-05：*"我们录音和停止录音上，点击停止录音响应很慢。"*
    //   ⇒ 这一档是"按下去那一刻"的样子：字换了、底色不再是"在录"那个红。
    await _pump(tester, _wrapping());
    expect(find.text(hearDrillWrappingLead), findsOneWidget,
        reason: '★ 按停之后屏幕上必须当场有一句话（不然就是"点了没反应"）');
    expect(_circleColor(tester), d.card, reason: '★ 已经不在录了 ⇒ 不许还画着"在录"那个底色');
    expect(find.byIcon(Icons.mic_none_rounded), findsOneWidget);
    expect(find.byIcon(Icons.stop_rounded), findsNothing, reason: '★ 收尾中不许还摆着"停"那个方块');

    // 负向对照：在录那一档**必须**是"停"那个方块 + 不是白底
    await _pump(tester, _listening());
    expect(find.byIcon(Icons.stop_rounded), findsOneWidget);
    expect(find.text(hearDrillWrappingLead), findsNothing, reason: '★ 没按停就不许说"收下了"');
  });

  testWidgets('② 🔴 不在录 ⇒ 底色跨帧一个字节都不许变（不许自己闪）', (tester) async {
    setHupoAnimationsEnabled(on: true);
    addTearDown(() => setHupoAnimationsEnabled(on: false));
    await _pump(tester, _wrapping(), settle: false);
    final seen = <Color>{};
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 120));
      seen.add(_circleColor(tester));
    }
    expect(seen.length, 1, reason: '★ 没在录却在变色 = 假装还在录（$seen）');
  });

  testWidgets('④ 🔴 打开总开关 ⇒ 正在录时底色**真的在变**', (tester) async {
    setHupoAnimationsEnabled(on: true);
    addTearDown(() => setHupoAnimationsEnabled(on: false));
    await _pump(tester, _listening(), settle: false);
    final seen = <Color>{};
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      seen.add(_circleColor(tester));
    }
    expect(seen.length, greaterThan(1),
        reason: '★ 开着开关推了 8 帧，底色一个数都没变 —— 它根本没在闪');
    for (final c in seen) {
      // ⚠️ **只在"暗"与"亮"这两头之间**走（不许闪成别的颜色）——
      //   逐通道比区间（三个通道各自夹在两头的闭区间里）。
      expect(_between(c, d.accent, d.accentLit), isTrue, reason: '闪出了两头之外的颜色：$c');
    }
    expect(seen.contains(d.accent) || seen.contains(d.accentLit), isTrue);
    // 🔴 负向对照：**尺寸/位置一个像素都不许动**（动的只是颜色）
    final box = tester.getSize(find.byKey(voiceBarCircleKey));
    await tester.pump(const Duration(milliseconds: 200));
    expect(tester.getSize(find.byKey(voiceBarCircleKey)), box,
        reason: '★ 圆圈自己在跳 = 更难按（主人要的只是颜色在变）');
  });

  testWidgets('④·补 🔴 总开关关着 ⇒ 判据不超时，而且那一层照旧画（M3：不动 ≠ 没有）', (tester) async {
    expect(hupoAnimationsEnabled, false, reason: '测试里那个开关该是关着的（M2 只有一处关它）');
    // 关着也能 `pumpAndSettle` 出来（能走到这儿就说明没超时）
    await _pump(tester, _listening());
    expect(find.byKey(voiceBarCircleKey), findsOneWidget,
        reason: '★ 关掉开关之后那颗圆圈不见了 —— M3 说"不动"与"没有"是两件事');
    final before = _circleColor(tester);
    await tester.pump(const Duration(milliseconds: 400));
    expect(_circleColor(tester), before, reason: '★ 关着开关它还在动');
  });
}
