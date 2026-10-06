// **底下那一格**：那颗圆圈的样子 / 在录时的"一明一暗" / 框里那份字 / 字号轴 / 草稿。
//
// 🔴 **2026-10-07 晚推倒重来**（主人：*"原本的语音转文字全套方案都应该推倒重来……
//   我们就是 stream 回来的文字输入到文本框等待发送。"*）：
//   · 那一格现在是一个**真输入框**（识别回来的字直接长在里面、他也能改）；
//   · 那份字**不再画在气泡上** ⇒ 判据读的是框里那份字（`_fieldText`）；
//   · "还没校正"那条下划线**跟着那一层一起删了**。
//
// 这一份钉七件（每件都带反例）：
//   ① 那颗圆圈：**白底 ＋ 一圈琥珀**（图形墨色）；
//   ② 🔴 **正在录 ⇒ 底色真的在变**（拿同一个 widget 的颜色量，不看"像在闪"）；
//   ③ 🔴 **不在录 ⇒ 一个像素都不动**（底色跨帧恒等）；
//   ④ 🔴 **按停（收尾中）⇒ 不闪了，而且当场有反应**（字留着他那份）—— 主人报的
//      "点击停止录音响应很慢"修的就是这一条；
//   ⑤ 那个永不结束的动画必须读总开关（手册 §6.1.1 M1–M4）；
//   ⑥ 🔴 那份字**原样画在框里**（没有"还没校正"那条线，也没有重复）；
//   ⑦ 🔴 框里那份字**跟用户那条字号轴**；打字那条退路的路由（草稿进 / 发送出）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/models/motion_switch.dart';
import 'package:hupo_app/models/voice_words.dart';
import 'package:hupo_app/widgets/appearance_scope.dart';
import 'package:hupo_app/widgets/listening_ripple.dart';
import 'package:hupo_app/widgets/voice_bar.dart';

/// 一个把状态钉成某一档的夹具（状态住上层 ⇒ 直接告诉它"在录 / 收尾中 / 框里那份字"）。
Future<void> _pump(
  WidgetTester tester, {
  String text = '',
  bool recording = false,
  bool wrapping = false,
  String note = '',
  bool canHear = true,
  bool settle = true,
  ValueChanged<String>? onChanged,
  ValueChanged<String>? onSend,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: VoiceBar(
          text: text,
          recording: recording,
          wrapping: wrapping,
          note: note,
          canHear: canHear,
          onChanged: onChanged ?? (_) {},
          onMic: () {},
          onSend: onSend ?? (_) {},
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

/// **框里现在那份字**（`EditableText` 那一层才是真拿字的 —— `TextField` 的
/// `find.text` 查不到它）。
String _fieldText(WidgetTester tester) {
  final f = find.descendant(of: find.byType(VoiceBar), matching: find.byType(EditableText));
  if (f.evaluate().isEmpty) return '';
  return tester.widget<EditableText>(f.first).controller.text;
}

/// **这一格现在给他看的那份字**：说话时是那张**卡片**（`voiceBarLiveKey`），
/// 编辑时才是真输入框。
String _shownText(WidgetTester tester) {
  final card = find.byKey(voiceBarLiveKey);
  if (card.evaluate().isNotEmpty) return tester.widget<Text>(find.descendant(of: card, matching: find.byType(Text)).first).data ?? '';
  return _fieldText(tester);
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

/// **他按了停、正等最后那一份字**（手上已经有那句字了）。
({String text, bool recording, bool wrapping}) _wrapping([String said = '帮我看看天气']) =>
    (text: said, recording: true, wrapping: true);

/// [c] 的三个通道是不是都夹在 [a] 与 [b] 之间（颜色插值出来的样子）。
bool _between(Color c, Color a, Color b) {
  bool ok(double v, double x, double y) {
    final lo = x < y ? x : y;
    final hi = x > y ? x : y;
    return v >= lo - 1e-6 && v <= hi + 1e-6;
  }

  return ok(c.r, a.r, b.r) && ok(c.g, a.g, b.g) && ok(c.b, a.b, b.b);
}

/// 那颗圆圈里那个图形（2026-10-06 起它要与那一圈同色）。
Icon _circleGlyph(WidgetTester tester) => tester.widget<Icon>(
  find.descendant(of: find.byKey(voiceBarCircleKey), matching: find.byType(Icon)).first,
);

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
  testWidgets('🔴 那颗圆圈：**白底 ＋ 一圈琥珀色**（图形墨色）', (tester) async {
    // 主人原话（2026-10-05）：*"那个语音按钮呢上外面要加一个边框啊，这个边框就是有那个琥珀色，
    //   就是按下去录音时候的那个颜色，然后……录音按钮和展开按钮他们也都有一个白色的底色"*
    //   ★ **2026-10-06 定案**（主人当天最后一句：*"现在把白色底加上"*）。
    await _pump(tester);
    final ring = _circleRing(tester);
    expect(ring.color, d.accent, reason: '★ 外面那一圈不是琥珀色（按下去录音时的那个颜色）');
    expect(ring.width > 0, isTrue, reason: '★ 那圈边框宽度是 0（等于没画）');
    expect(_circleColor(tester), d.card, reason: '★ 那颗圆圈没有白底（主人 2026-10-06 要的）');
    expect(_circleGlyph(tester).color, d.ink, reason: '★ 圆圈里的图形不是墨色（白底之上该用墨色）');

    // 🔴 **那一颗看得见的圈必须撑满它那一格**（2026-10-07 主人报"那个圈变小了、很丑"）：
    //    我当时把它包进一层 `Stack`，而 `Stack` 默认 `loose` ⇒ 里面那层 `Material`
    //    缩到**图标那么大**（30）⇒ 圈小了。判据直接量"看得见那一层"的尺寸。
    final slot = tester.getSize(find.byKey(voiceBarCircleKey));
    final face = tester.getSize(
      find.descendant(of: find.byKey(voiceBarCircleKey), matching: find.byType(Material)).first,
    );
    expect(face, slot, reason: '★ 看得见那一颗圈没有撑满那一格（$face ≠ $slot）—— 圈变小了');
    expect(slot.width, d.voiceCircleBox, reason: '★ 那一格本身也该是设计里那个尺寸');

    // 负向对照：在录的时候**整颗变琥珀**（那一圈还在）
    await _pump(tester, recording: true, settle: false);
    expect(_circleRing(tester).color, d.accent);
    expect(
      tester.getSize(
        find.descendant(of: find.byKey(voiceBarCircleKey), matching: find.byType(Material)).first,
      ),
      slot,
      reason: '★ 在录那一档也不许变小',
    );
  });

  testWidgets('③ 🔴 按停（收尾中）⇒ **当场**还是他那份字，而且不闪了', (tester) async {
    // 主人 2026-10-05：*"我们录音和停止录音上，点击停止录音响应很慢。"*
    //   ⇒ 这一档是"按下去那一刻"的样子：字还在、底色不再是"在录"那个色。
    final w = _wrapping();
    await _pump(tester, text: w.text, recording: w.recording, wrapping: w.wrapping);
    expect(_shownText(tester), '帮我看看天气',
        reason: '★ 收尾中该看见**他刚说的那份字**（不是把它换成一句提示）');
    expect(_circleColor(tester), d.card,
        reason: '★ 已经不在录了 ⇒ 不许还画着"在录"那个底（该回到白底）');
    expect(find.byIcon(Icons.mic_none_rounded), findsOneWidget);
    expect(find.byIcon(Icons.stop_rounded), findsNothing, reason: '★ 收尾中不许还摆着"停"那个方块');

    // 负向对照：在录那一档**必须**是"停"那个方块
    await _pump(tester, recording: true, settle: false);
    expect(find.byIcon(Icons.stop_rounded), findsOneWidget);

    // ⚠️ 负向对照：**一个字都没说**的收尾中 ⇒ 那句提示要出来（不然屏幕上什么都没有）
    await _pump(tester, recording: true, wrapping: true);
    expect(find.text(voiceWrappingLead), findsOneWidget,
        reason: '★ 一个字都没说的时候，收尾中必须有一句人话');
  });

  testWidgets('② 🔴 不在录 ⇒ 底色跨帧一个字节都不许变（不许自己闪）', (tester) async {
    setHupoAnimationsEnabled(on: true);
    addTearDown(() => setHupoAnimationsEnabled(on: false));
    final w = _wrapping();
    await _pump(tester, text: w.text, recording: w.recording, wrapping: w.wrapping, settle: false);
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
    await _pump(tester, recording: true, settle: false);
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
    await _pump(tester, recording: true);
    expect(find.byKey(voiceBarCircleKey), findsOneWidget,
        reason: '★ 关掉开关之后那颗圆圈不见了 —— M3 说"不动"与"没有"是两件事');
    final before = _circleColor(tester);
    await tester.pump(const Duration(milliseconds: 400));
    expect(_circleColor(tester), before, reason: '★ 关着开关它还在动');
  });

  testWidgets('⑥ 🔴 说话时那一格**从头显示**（一张不滚的卡片），点一下才变成能改的输入框', (tester) async {
    // 🔴 2026-10-07 主人：*"所谓断句就是说着说着，转文字的早期的那部分内容在输入框里没了。"*
    //   量出来的读数：那个真输入框只有 **4 行高**、光标又在末尾 ⇒ 字一多就把
    //   **前面那几行卷出框外**（字一个没丢，但他看不见了）。
    //   ⇒ 说话时给一张**不会滚**的卡片（从头显示、末尾省略号）；**点一下**才换成真输入框。
    TextDecoration? decoOf(WidgetTester t) {
      final f = find.byType(EditableText);
      if (f.evaluate().isEmpty) return null;
      return tester.widget<EditableText>(f.first).style.decoration;
    }

    // ① 在听（字还在长）⇒ **卡片**，而且里面那份字从头开始
    await _pump(tester, text: '第一句在这里。第二句在这里。', recording: true);
    expect(find.byKey(voiceBarLiveKey), findsOneWidget, reason: '★ 说话时该是那张卡片');
    expect(find.byType(EditableText), findsNothing,
        reason: '★ 说话时不许摆那个会滚的输入框（它就是"早期那部分看不见"的来源）');
    expect(_shownText(tester), '第一句在这里。第二句在这里。',
        reason: '★ 他说的那份字要真的长在那一格里');

    // ② 卡片**不会滚**（没有可滚的东西）+ 长了就**末尾**省略（开头永远在）
    // 🔴 它是个**真按钮**（可访问性那道硬闸：自己写的点击区必须被"命中区 ≥44"扫到）
    expect(find.byType(TextButton), findsWidgets, reason: '★ 那一格该是真按钮，不是裸的点击区');
    final cardBox = tester.getRect(find.byType(TextButton).first);
    expect(cardBox.height, greaterThanOrEqualTo(44), reason: '★ 那张卡片太矮 ⇒ 不好点');
    final p = tester.widget<Text>(find.descendant(of: find.byKey(voiceBarLiveKey), matching: find.byType(Text)).first);
    expect(p.maxLines, isNotNull, reason: '★ 卡片要有限行数（不然会顶掉半屏）');
    expect(p.overflow, TextOverflow.ellipsis, reason: '★ 必须是**末尾**省略：开头那几句不许被切掉');

    // ③ **点一下** ⇒ 换成真输入框（能改），而且**一个字都不丢**
    await tester.tap(find.byKey(voiceBarLiveKey));
    await tester.pumpAndSettle();
    expect(find.byType(EditableText), findsOneWidget, reason: '★ 点它就该能改');
    expect(_fieldText(tester), '第一句在这里。第二句在这里。', reason: '★ 换过去时一个字都不许丢');
    expect(decoOf(tester), anyOf(isNull, TextDecoration.none));

    // ④ **空的时候一个像素都不画**（不摆空框、不摆提示）
    await _pump(tester);
    expect(find.byType(EditableText), findsNothing, reason: '★ 空的时候不该摆一个空框在那儿');
    expect(find.byKey(voiceBarLiveKey), findsNothing);
  });

  testWidgets('⑦ 🔴 框里那份字**跟用户那条字号轴**（12/17 都跟着变）', (tester) async {
    // 🔴 2026-10-06 清过期判据时点名的真缺陷：这一行字原来走 `textTheme.bodyLarge`
    //    （与用户那条轴无关）⇒ 设置里把字号从 12 调到 17，时间线会变、
    //    **底下这一格一个像素都不动**。它属于"会话内容"，必须跟轴。
    Future<double> sizeAt(int setting) async {
      await tester.pumpWidget(
        AppearanceScope(
          variant: DshVariant.light,
          scale: dshContentScale(setting),
          child: MaterialApp(
            home: Scaffold(
              body: VoiceBar(
                text: '帮我看看天气',
                recording: true,
                wrapping: true,
                canHear: true,
                onChanged: (_) {},
                onMic: () {},
                onSend: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // 说话时是那张卡片 ⇒ 量卡片里那份字的字号（它也要跟那条轴）
      final card = find.byKey(voiceBarLiveKey);
      if (card.evaluate().isNotEmpty) {
        return tester
            .widget<Text>(find.descendant(of: card, matching: find.byType(Text)).first)
            .style!
            .fontSize!;
      }
      return tester.widget<EditableText>(find.byType(EditableText)).style.fontSize!;
    }

    final s12 = await sizeAt(12);
    final s17 = await sizeAt(17);
    expect(s17, greaterThan(s12),
        reason: '★ 字号调大 ⇒ 底下这一格也得跟着变大（原来它走 textTheme，一个像素都不动）');
  });

  testWidgets('⑨ 🔴 在听的时候，那一圈涟漪**真的在荡**（主人：增加动效，表达正在听）', (tester) async {
    setHupoAnimationsEnabled(on: true);
    addTearDown(() => setHupoAnimationsEnabled(on: false));
    double? tOf(WidgetTester t) => (t.widget<CustomPaint>(find.byKey(listeningRippleKey)).painter
            as ListeningRipplePainter)
        .t;

    await _pump(tester, recording: true, settle: false);
    final seen = <double?>{};
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 130));
      seen.add(tOf(tester));
    }
    expect(seen.length, greaterThan(1),
        reason: '★ 开着开关推了 6 帧，涟漪一个数都没变 —— 它根本没动（$seen）');
    expect(seen.any((v) => v != null), isTrue, reason: '★ 在听的时候该真的画出来');

    // 🔴 负向对照：尺寸/位置一个像素都不许动（动的只是圈外那两条线）
    final box = tester.getSize(find.byKey(voiceBarCircleKey));
    final at = tester.getTopLeft(find.byKey(voiceBarCircleKey));
    await tester.pump(const Duration(milliseconds: 200));
    expect(tester.getSize(find.byKey(voiceBarCircleKey)), box, reason: '★ 圆圈自己在变大小 = 更难按');
    expect(tester.getTopLeft(find.byKey(voiceBarCircleKey)), at, reason: '★ 圆圈自己在挪');
  });

  testWidgets('⑨·补 不在听 / 关着总开关 ⇒ **一圈都不画**（但那一层照旧在树上）', (tester) async {
    ListeningRipplePainter p(WidgetTester t) =>
        t.widget<CustomPaint>(find.byKey(listeningRippleKey)).painter as ListeningRipplePainter;
    // ① 关着总开关（测试里的默认就是关的）：能 `pumpAndSettle` 出来 ⇒ 没超时
    await _pump(tester, recording: true);
    expect(find.byKey(listeningRippleKey), findsOneWidget, reason: 'M3：不动 ≠ 没有');
    expect(p(tester).t, isNull, reason: '★ 关着开关还在画 = 屏幕上多出两圈假的线');
    // ② 不在听（开着开关也一样）
    setHupoAnimationsEnabled(on: true);
    addTearDown(() => setHupoAnimationsEnabled(on: false));
    await _pump(tester);
    expect(p(tester).t, isNull, reason: '★ 没在听就该一个像素都不画');
  });

  testWidgets('⑨·补2 🔴 那一圈涟漪的**算法**（纯函数：喂 t 就有东西、越荡越大越淡、一轮接上）', (tester) async {
    const base = 32.0;
    // ① t = null（不画）那一档在 painter 里（上面那条量的）
    // ② 每一帧那几条圈：一条贴着边、其余在外面（错开均分一轮）
    final a = ListeningRipplePainter.ringsFor(0, base);
    expect(a.length, ListeningRipplePainter.rings, reason: '★ 该是"一圈一圈接着荡"（错开几条）');
    expect(a[0].r, closeTo(base, 0.001), reason: '★ t=0 时里圈正好贴着圆圈边');
    expect(a[1].r, greaterThan(a[0].r), reason: '★ 第二条在外圈（错开半轮）');
    // ③ 同一个圈：t 越大 ⇒ 越往外、越淡
    final b = ListeningRipplePainter.ringsFor(0.5, base);
    expect(b[0].r, greaterThan(a[0].r), reason: '★ 荡出去要越荡越大');
    expect(b[0].opacity, lessThan(a[0].opacity), reason: '★ 越荡越淡');
    // ④ 一轮接上（t=1 就是 t=0）—— 不接上会看到"跳一下"
    final c = ListeningRipplePainter.ringsFor(1, base);
    expect(c[0].r, closeTo(a[0].r, 0.001), reason: '★ 一轮荡完要接回起点（不然每轮跳一下）');
    expect(c[0].opacity, closeTo(a[0].opacity, 0.001));
    // ⑤ **荡得够大**（主人要的"扩散的更大一点"）而且不许荡到看不见的地方去
    var maxR = 0.0;
    for (var i = 0; i <= 10; i++) {
      for (final r in ListeningRipplePainter.ringsFor(i / 10, base)) {
        maxR = r.r > maxR ? r.r : maxR;
        expect(r.r, lessThan(base * 2.1), reason: '★ 荡得太远就该看不见了（但它还在画）');
        expect(r.opacity, greaterThanOrEqualTo(0));
      }
    }
    expect(maxR, greaterThan(base * 1.7),
        reason: '★ 最大那一圈要能荡到将近两倍大（改前只到 1.42 倍，几乎看不出在荡）');
  });

  testWidgets('⑩ 🔴 那句"没听清"**在按钮左边、白底**（不许挂在上方）', (tester) async {
    // 🔴 2026-10-07 主人：*"这句没听清楚，再说一遍不要放在上方。也要放在按钮左侧。
    //   同时也是有白色底的。"*
    const note = '这句我没听清，再说一遍。';
    await _pump(tester, note: note);
    expect(find.text(note), findsOneWidget, reason: '★ 那句要真的画出来');

    final noteBox = tester.getRect(find.byKey(voiceBarNoteKey));
    final circle = tester.getRect(find.byKey(voiceBarCircleKey));

    // ① **左边**：整张卡片都在那颗圆圈的左边缘之外
    expect(noteBox.right, lessThanOrEqualTo(circle.left + 0.5),
        reason: '★ 那句跑到按钮右边/底下去了（它要在**按钮左侧**）');
    // ② **同一行**（这就是"不许放在上方"）：它的中线落在圆圈上下跨度里
    expect(noteBox.center.dy, greaterThan(circle.top));
    expect(noteBox.center.dy, lessThan(circle.bottom));
    // ③ **白底**：那张卡片的底色就是这张纸的白（与时间线上别的卡片同一个色）
    final deco = tester.widget<Container>(find.byKey(voiceBarNoteKey)).decoration! as BoxDecoration;
    expect(deco.color, d.card, reason: '★ 那句没有白色底（主人要的"白色底"）');
    expect(deco.border, isNotNull, reason: '★ 白底之上要有一圈细线，不然压在壁纸上会糊成一片');

    // ④ 负向对照：那句**不在**这一格的上方 —— 整格的高度就是那一行的高度
    final bar = tester.getRect(find.byType(VoiceBar));
    expect(noteBox.top, greaterThanOrEqualTo(bar.top));
    expect(noteBox.bottom, lessThanOrEqualTo(bar.bottom));
    expect(bar.height, lessThan(circle.height + d.gapS * 2 + 2),
        reason: '★ 这一格比"一行"还高 ⇒ 上面又挂了一行东西');
  });

  testWidgets('⑩·补 说到一半断了（框里有字 ＋ 有那句）⇒ **并排**，都在按钮左边', (tester) async {
    await _pump(tester, text: '帮我看看天气', note: '识别那一头出错了，再按一次试试。');
    final field = tester.getRect(find.byKey(voiceBarTypeKey));
    final noteBox = tester.getRect(find.byKey(voiceBarNoteKey));
    final circle = tester.getRect(find.byKey(voiceBarCircleKey));
    expect(noteBox.right, lessThanOrEqualTo(circle.left + 0.5), reason: '★ 那句也要在按钮左边');
    expect(field.right, lessThanOrEqualTo(noteBox.left + 0.5),
        reason: '★ 两个都在时：框在左、那句在右（都在按钮左边）');
    // 两边都在同一行里
    expect((field.center.dy - noteBox.center.dy).abs(), lessThan(2));
  });

  testWidgets('⑧ 🔴 打字那条退路：**上回打了一半的那句填回框里**，发送交出的是框里那份', (tester) async {
    // 🔴 主人 2026-09-22 就定过"草稿也是要记住的"；那一格换成语音之后，
    //    唯一会写草稿的 `composer.dart` 没人实例化了 ⇒ 打了一半刷新就没了
    //    （2026-10-06 清判据时发现的真缺陷）。这一条钉"接回活的这一格"。
    final typed = <String>[];
    final sent = <String>[];
    await _pump(
      tester,
      text: '帮我看一下明天',
      canHear: false,
      onChanged: typed.add,
      onSend: sent.add,
    );
    // ① 存着的那一句**填回框里**（而且这一格是摊开的 —— 不摊开就等于字丢了）
    expect(_fieldText(tester), '帮我看一下明天', reason: '★ 上回打了一半的那句没回来');
    // ② 再敲一下 ⇒ 每一下都喊一声（控制器那边把它存下来）
    await tester.enterText(find.byKey(voiceBarTypeKey), '帮我看一下明天北京的天气');
    expect(typed, isNotEmpty, reason: '★ 敲了字却没喊 onChanged ⇒ 那份草稿还是没人写');
    // ③ 按「发送」⇒ 交出去的是**框里那份字**（清框是控制器那边的事）
    await tester.tap(find.byKey(voiceBarTypedSendKey));
    await tester.pumpAndSettle();
    expect(sent, ['帮我看一下明天北京的天气'], reason: '★ 发出去的是他自己改过的那份字');
  });
}
