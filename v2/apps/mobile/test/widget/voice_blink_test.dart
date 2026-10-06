// **在录时那颗圆圈的"一明一暗"**（主人 2026-10-05：*"录音按钮在激活的时候，
//   要有一个循环的效果，就是颜色一明一暗的闪烁。"*）。
//
// 这一份钉四件（每件都带反例）：
//   ① 🔴 **正在录 ⇒ 底色真的在变**（拿同一个 widget 的颜色量，不看"像在闪"）；
//   ② 🔴 **不录 ⇒ 一个像素都不动**（底色跨帧恒等）；
//   ③ 🔴 **按停（收尾中）⇒ 不闪了，而且屏幕上当场有反应**（有字就留着他那份字，一个字都没说才给提示）
//      —— 主人报的"点击停止录音响应很慢"修的就是这一条；
//   ④ 🔴 **那个永不结束的动画必须读总开关**（手册 §6.1.1 M1–M4）：
//      关掉之后判据**不超时**、而且**那一层照旧画**（M3：不动 ≠ 没有）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/hear_drill.dart';
import 'package:hupo_app/models/hear_words.dart';
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/models/motion_switch.dart';
import 'package:hupo_app/widgets/appearance_scope.dart';
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

/// 那颗圆圈**上层**那 20% 的琥珀（2026-10-06 起底是两层）。
Color _circleWash(WidgetTester tester) {
  final boxes = tester.widgetList<DecoratedBox>(
    find.descendant(of: find.byKey(voiceBarCircleKey), matching: find.byType(DecoratedBox)),
  );
  final hit = boxes.map((b) => b.decoration).whereType<BoxDecoration>()
      .firstWhere((dec) => dec.color == d.accentFace, orElse: () => const BoxDecoration());
  return hit.color ?? const Color(0x00000000);
}

/// 那颗圆圈这一帧的"外圈"（有没有琥珀色描边）。
BorderSide _circleRing(WidgetTester tester) {
  final m = tester.widget<Material>(
    find
        .descendant(of: find.byKey(voiceBarCircleKey), matching: find.byType(Material))
        .first,
  );
  final shape = m.shape;
  expect(shape, isA<CircleBorder>(), reason: '★ 那颗圆圈该是圆的');
  return (shape! as CircleBorder).side;
}

void main() {
  testWidgets('🔴 那颗圆圈：**边框色 + 80% 透明的底 ＋ 一圈琥珀色**（主人 2026-10-06 定的）', (tester) async {
    // 主人原话（2026-10-05）：*"那个语音按钮呢上外面要加一个边框啊，这个边框就是有那个琥珀色，
    //   就是按下去录音时候的那个颜色，然后……录音按钮和展开按钮他们也都有一个白色的底色"*
    // ★ **2026-10-06 改口径**（主人：*"按钮这个不好看，我们就用边框颜色加80%透明度"*）：
    //   "白底"那一句作废 ⇒ 现在是 `accentFace` = **那一圈琥珀本身 ＋ 80% 透明度**。
    await _pump(tester, const HearDrill());
    final ring = _circleRing(tester);
    expect(ring.color, d.accent, reason: '★ 外面那一圈不是琥珀色（按下去录音时的那个颜色）');
    expect(ring.width > 0, isTrue, reason: '★ 那圈边框宽度是 0（等于没画）');
    // 底是**两层**（2026-10-06）：下层纸色 @80%（保证深色壁纸下图形看得见）＋ 上层琥珀 @20%
    expect(_circleColor(tester), d.faceBase, reason: '★ 那颗圆圈的下层不是那层纸（深色壁纸下图形会没）');
    expect(_circleWash(tester), d.accentFace,
        reason: '★ 那颗圆圈上层不是"边框色 + 80% 透明"（主人 2026-10-06 要的）');
    expect(_circleColor(tester), isNot(d.card),
        reason: '★ 又变回那张纸的白了 —— 主人要的是"边框色的透明版"');

    // 负向对照：在录的时候**整颗变琥珀**（那一圈还在，只是与底同色了）
    await _pump(tester, _listening());
    expect(_circleRing(tester).color, d.accent);
  });

  testWidgets('③ 🔴 按停（收尾中）⇒ **当场**换成那句话，而且不闪了', (tester) async {
    // 主人 2026-10-05：*"我们录音和停止录音上，点击停止录音响应很慢。"*
    //   ⇒ 这一档是"按下去那一刻"的样子：字换了、底色不再是"在录"那个红。
    // ⚠️ **2026-10-05 改了口径**（主人：*"第一步是把直白的语音转文字写出来……
    //   不要直接结束"*）：收尾中**说的是他刚说的那份字**（带下划线），
    //   **不再拿"收下了，正在整理……"把字盖掉** —— 那句只在他一个字都没说时才出来。
    await _pump(tester, _wrapping());
    expect(find.text('帮我看看天气'), findsOneWidget,
        reason: '★ 收尾中该看见**他刚说的那份字**（不是把它换成一句提示）');
    expect(_circleWash(tester), d.accentFace,
        reason: '★ 已经不在录了 ⇒ 不许还画着"在录"那个底色（上层该回到那 20% 的琥珀）');
    expect(find.byIcon(Icons.mic_none_rounded), findsOneWidget);
    expect(find.byIcon(Icons.stop_rounded), findsNothing, reason: '★ 收尾中不许还摆着"停"那个方块');

    // 负向对照：在录那一档**必须**是"停"那个方块 + 不是白底
    await _pump(tester, _listening());
    expect(find.byIcon(Icons.stop_rounded), findsOneWidget);
    // ⚠️ 负向对照：**一个字都没说**的收尾中 ⇒ 那句提示要出来（不然屏幕上什么都没有）
    await _pump(tester, const HearDrill().startListening().stopListening());
    expect(find.text(hearDrillWrappingLead), findsOneWidget,
        reason: '★ 一个字都没说的时候，收尾中必须有一句人话');
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

  testWidgets('⑥ 🔴 第一步那份"直白的字"**带下划线**，校正回来才去掉（主人 2026-10-05）', (tester) async {
    // 主人原话：*"第一步是把直白的语音转文字写出来，然后是语义校正。通用的办法是
    //   第一步给下划线，第二步转换才去掉下划线。"*
    TextDecoration? decoOf(WidgetTester t) {
      final texts = t.widgetList<Text>(find.byType(Text)).toList();
      for (final x in texts) {
        final d = x.style?.decoration;
        if (d != null) return d;
      }
      return null;
    }

    // ① 在听（字还在长）⇒ **带下划线**
    await _pump(tester, const HearDrill().startListening().utterance('帮我看一下明天北京的天气予报'),
        settle: true);
    // ⚠️ `utterance` 会把它推进 `thinking`（那也是"还没校正"那一档）
    expect(decoOf(tester), TextDecoration.underline, reason: '★ 还没校正的那份字没有下划线');

    // ② 收尾中（他按了停、还没等到对面）⇒ **还是带下划线**
    await _pump(tester, _wrapping());
    expect(decoOf(tester), TextDecoration.underline, reason: '★ 收尾中那份字该还是"没校正"的样子');

    // ③ 校正回来了（可以发了）⇒ **下划线去掉**
    final ready = const HearDrill()
        .startListening()
        .utterance('帮我看一下明天北京的天气预报')
        .heardBack(ok: true, heard: '帮我看一下明天北京的天气预报');
    await _pump(tester, ready);
    expect(decoOf(tester), isNot(TextDecoration.underline),
        reason: '★ 校正回来了下划线还在 ⇒ 他分不出"这一步过了没有"');

    // 负向对照：它在问那一档 ⇒ 也**不带**下划线（那一句是它问的，不是他说的那份字）
    final asking = const HearDrill()
        .startListening()
        .utterance('那个东西弄一下')
        .heardBack(ok: true, heard: '那个东西弄一下', ask: '哪个东西？');
    await _pump(tester, asking);
    expect(decoOf(tester), isNot(TextDecoration.underline));
  });

  testWidgets('⑦ 🔴 底下那一行字**跟用户那条字号轴**（12/14/17 都跟着变）', (tester) async {
    // 🔴 2026-10-06 清过期判据时点名的真缺陷：这一行字原来走 `textTheme.bodyLarge`
    //    （16/24，与用户那条轴无关）⇒ 设置里把字号从 12 调到 17，时间线会变、
    //    **底下这一行一个像素都不动**。它属于"会话内容"，必须跟轴。
    Future<double> sizeAt(int setting) async {
      await tester.pumpWidget(
        AppearanceScope(
          variant: DshVariant.light,
          scale: dshContentScale(setting),
          child: MaterialApp(
            home: Scaffold(
              body: VoiceBar(
                flow: _wrapping(),
                canHear: true,
                onMic: () {},
                onTyped: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return tester.getSize(find.text('帮我看看天气')).height;
    }

    final h12 = await sizeAt(12);
    final h17 = await sizeAt(17);
    expect(h17, greaterThan(h12),
        reason: '★ 字号调大 ⇒ 底下这一行也得跟着变大（原来它走 textTheme，一个像素都不动）');
  });

  testWidgets('⑧ 🔴 打字那条退路：**上回打了一半的那句还在**，发出去才清掉', (tester) async {
    // 🔴 主人 2026-09-22 就定过"草稿也是要记住的"；而那一格换成语音之后，
    //    唯一会写草稿的 `composer.dart` **没人实例化了** ⇒ 打了一半刷新就没了
    //    （2026-10-06 清判据时发现的真缺陷）。这一条钉"接回活的这一格"。
    final typed = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: VoiceBar(
            flow: const HearDrill(),
            canHear: false,
            onMic: () {},
            onTyped: (_) {},
            draft: '帮我看一下明天',
            onDraft: typed.add,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    // ① 存着的那一句**填回框里**（而且这一格是摊开的 —— 不摊开就等于字丢了）
    expect(find.text('帮我看一下明天'), findsOneWidget, reason: '★ 上回打了一半的那句没回来');
    // ② 再敲一下 ⇒ 每一下都喊一声（存的那一份跟着变）
    await tester.enterText(find.byKey(voiceBarTypeKey), '帮我看一下明天北京的天气');
    expect(typed, isNotEmpty, reason: '★ 敲了字却没喊 onDraft ⇒ 那份草稿还是没人写');
    // ③ 发出去 ⇒ 喊一声空的（那一份清掉）
    await tester.tap(find.byKey(voiceBarTypedSendKey));
    await tester.pumpAndSettle();
    expect(typed.last, '', reason: '★ 发出去了那份草稿还留着 ⇒ 下次回来又冒出一句他已经发过的话');
  });
}
