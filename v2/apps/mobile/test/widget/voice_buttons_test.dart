// **录音圆圈右边那两颗按钮**（主人 2026-10-05：*"语音按钮的右侧，需要两个按钮。
//   一个是展开聊天，一个是播放语音。所谓播放语音，就是开启和关停的状态，如果开启，
//   会将对 agent 的回复进行语音转换和实时播报。如果关闭，则不播报。"*）。
//
// 这一份钉四件（每件都带反例）：
//   ① 🔴 收起档那一行**从左边数**是：（他的话 ＋ 圆圈）→ **展开** → **播放语音**；
//   ② 🔴 播放那颗**看得出开 / 关**，点一下就翻过去；
//   ③ 🔴 这台**念不出来** ⇒ 那颗**一个像素都不许画**（`canSpeak` 假时调用处传 `null`）；
//   ④ 🔴 两颗的命中区都 ≥44（D3.6 硬闸）。

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/widgets/chat_floater.dart';

/// 直接泵浮窗（收起档）—— **不经过 `chat_screen`**，因为那颗播放按钮画不画
/// 由**调用处**那一句 `canSpeak ? … : null` 决定（判据 ③ 单独钉那一句）。
Future<void> _pumpFloater(
  WidgetTester tester, {
  bool speakOn = false,
  VoidCallback? onToggleSpeak = _noop,
  FloaterTier tier = FloaterTier.collapsed,
}) async {
  // ⚠️ **先清一次**：同一个 `ChatFloater` 连着泵两次会**复用同一个 State**
  //    （`initialTier` 只在 `initState` 读一次）⇒ 第二次那一档根本没换。
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
              maxHeight: 600,
              initialTier: tier,
              title: '琥珀聊天',
              speakOn: speakOn,
              onToggleSpeak: onToggleSpeak,
              // ⚠️ 一个"假输入条"：这一份判据只管那两颗按钮摆对了没有
              composer: const SizedBox(key: _fakeComposerKey, width: 300, height: d.voiceCircleBox),
              child: const SizedBox.shrink(),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void _noop() {}

/// 假输入条那一格（真的那一格里**最右是那颗录音圆圈**）。
const Key _fakeComposerKey = Key('fake-composer');

void main() {
  testWidgets('① 🔴 收起档：展开与播放两颗都在，而且播放那颗在**最右**', (tester) async {
    await _pumpFloater(tester);
    expect(find.byKey(chatHandleKey), findsOneWidget, reason: '★ 展开那颗不见了');
    expect(find.byKey(chatSpeakKey), findsOneWidget, reason: '★ 播放那颗不见了');
    expect(find.byTooltip('展开'), findsOneWidget);
    // 位置：那两颗在**录音那一格的右边**，而且**竖着叠成一列**（展开在上、播放在下）
    //   —— 主人 2026-10-05：*"是一列的。就是上下关系。展开在上，开启关闭在下。"*
    final micRow = tester.getRect(find.byKey(_fakeComposerKey));
    final expand = tester.getRect(find.byKey(chatHandleKey));
    final speak = tester.getRect(find.byKey(chatSpeakKey));
    expect(micRow.right <= expand.left + 0.5, true,
        reason: '★ 那一列跑到录音那一格上去了（主人要的是"语音按钮的右侧"）');
    expect((expand.center.dx - speak.center.dx).abs() < 0.5, true,
        reason: '★ 两颗不在同一条竖线上（${expand.center.dx} vs ${speak.center.dx}）—— 该是一列');
    expect(expand.center.dy < speak.center.dy, true,
        reason: '★ 上下关系反了：展开该在**上**（${expand.center.dy} vs ${speak.center.dy}）');
    expect(expand.bottom <= speak.top + 0.5, true, reason: '★ 两颗叠在一起了（该是上下两格）');

    // 🔴 **两颗都是"长方形 ＋ 一圈轮廓 ＋ 有底色"**（主人 2026-10-05：
    //   *"他们都要有一个长方形的按钮轮廓"* + *"需要底色的"*）
    //   ⚠️ 看得见的那一块在**按钮里面**（外面那一格是透明的、只撑命中区 ≥44）——
    //      所以这里量的是里面那块 `Container`。
    for (final (name, k) in [('展开', chatHandleKey), ('播放', chatSpeakKey)]) {
      final face = tester.widget<Container>(
        find.descendant(of: find.byKey(k), matching: find.byType(Container)).first,
      );
      final box = face.decoration! as BoxDecoration;
      expect(box.color, isNotNull, reason: '★ $name 那颗没有底色');
      expect(box.border, isNotNull, reason: '★ $name 那颗没有轮廓');
      expect(box.border!.top.width > 0, isTrue, reason: '★ $name 那颗的轮廓宽度是 0（等于没画）');
      expect(box.borderRadius, isNotNull, reason: '★ $name 那颗不是长方形（圆角矩形）');
      // 看得见的那一块**要比手势那一格小**（D3.6：视觉仍小、命中区撑够）
      final r = tester.getSize(find.descendant(of: find.byKey(k), matching: find.byType(Container)).first);
      final hit = tester.getSize(find.byKey(k));
      expect(r.width < hit.width || r.height < hit.height, isTrue,
          reason: '★ $name 那颗"缩小"没生效（看得见那块 $r vs 命中区 $hit）');
    }

    // 🔴 命中区 ≥44（D3.6 硬闸）—— 两颗都要
    for (final r in [expand, speak]) {
      expect(r.height >= 44, true, reason: '命中区只有 ${r.height}');
      expect(r.width >= 44, true, reason: '命中区只有 ${r.width}');
    }
  });

  testWidgets('② 🔴 播放那颗看得出开 / 关，点一下就翻过去（回调带的是"要变成什么"）', (tester) async {
    var taps = 0;
    await _pumpFloater(tester, speakOn: false, onToggleSpeak: () => taps += 1);
    expect(find.byIcon(Icons.volume_off_rounded), findsOneWidget, reason: '★ 关着的时候样子不对');
    expect(find.byIcon(Icons.volume_up_rounded), findsNothing);
    await tester.tap(find.byKey(chatSpeakKey));
    await tester.pump();
    expect(taps, 1, reason: '★ 点了没反应');

    // 开着的时候：**另一个样子**（不是同一个图标）
    await _pumpFloater(tester, speakOn: true, onToggleSpeak: () => taps += 1);
    expect(find.byIcon(Icons.volume_up_rounded), findsOneWidget, reason: '★ 开着的时候看不出来');
    expect(find.byIcon(Icons.volume_off_rounded), findsNothing,
        reason: '★ 开与关必须是两个样子（不然他不知道现在是哪一档）');
  });

  testWidgets('③ 🔴 这台念不出来 ⇒ 那颗**一个像素都不许画**（负向对照）', (tester) async {
    await _pumpFloater(tester, onToggleSpeak: null);
    expect(find.byKey(chatSpeakKey), findsNothing,
        reason: '★ 按不动的按钮不许摆在屏幕上（`speech.dart` 纪律 ②）');
    // 负向对照之二：**展开那颗照旧在**（不是整行都没了）
    expect(find.byKey(chatHandleKey), findsOneWidget);
  });

  test('③·补 🔴 那一句门在**调用处**：`chat_screen` 传 `onToggleSpeak` 时必须看 `canSpeak`', () {
    // ⚠️ 这一条只能源码级钉：VM 上 `canSpeak` 恒假（那一份是桩）⇒ 界面判据量不到"能念"那一档。
    final src = File('lib/screens/chat_screen.dart').readAsStringSync();
    final line = src.split('\n').firstWhere((l) => l.contains('onToggleSpeak:'), orElse: () => '');
    expect(line.isNotEmpty, isTrue, reason: '找不到 `onToggleSpeak:` 那一处（判据要跟着它走）');
    expect(line.contains('canSpeak'), isTrue,
        reason: '★ 那句门不见了：念不出来的设备上会摆出一颗按不动的按钮');
  });

  testWidgets('④ 🔴 打开聊天窗口那一下，**语音那颗一个像素都不许动**（主人当场看出来的那件事）', (tester) async {
    // 主人 2026-10-05：*"打开聊天历史窗口后，我发现按键变了。语音按键位置改变了。"*
    //   根子：那两颗原来**只画在收起档** ⇒ 打开窗口那一下外面少了 ~96 像素
    //   ⇒ 圆圈与它左边那句字整块往右跳。⇒ 现在两档同一个形状（那一格留着）。
    await _pumpFloater(tester, tier: FloaterTier.collapsed);
    final closedMicRow = tester.getRect(find.byKey(_fakeComposerKey));
    final closedSpeak = tester.getRect(find.byKey(chatSpeakKey));
    final closedExpand = tester.getRect(find.byKey(chatHandleKey));

    await _pumpFloater(tester, tier: FloaterTier.full);
    final openMicRow = tester.getRect(find.byKey(_fakeComposerKey));
    final openSpeak = tester.getRect(find.byKey(chatSpeakKey));

    expect(openMicRow.right, closeTo(closedMicRow.right, 0.5),
        reason: '★ 打开窗口之后录音那一格挪了（${closedMicRow.right} → ${openMicRow.right}）—— 那颗圆圈跟着跳');
    expect(openSpeak.left, closeTo(closedSpeak.left, 0.5),
        reason: '★ 播放那颗在两档里不在同一个位置');
    expect(openSpeak.top, closeTo(closedSpeak.top, 0.5));

    // ★ **展开档那一颗不挪窝，只是"翻个方向"**（主人 2026-10-05：
    //   *"把它变成展开以后是变成缩小窗口的按钮啊，所以它位置就不变"*）：
    //   它还在原处、还是同一个 key，只是**朝下**、按下去 = 收起。
    final openHandle = tester.getRect(find.byKey(chatHandleKey));
    expect(openHandle.center, closedExpand.center,
        reason: '★ 展开之后那颗挪位置了（${closedExpand.center} → ${openHandle.center}）');
    expect(find.byTooltip(chatCollapse), findsWidgets,
        reason: '★ 展开档那一颗该是「收起」（标题行那颗也还在）');
    // 点它 ⇒ 收回收起档
    await tester.tap(find.byKey(chatHandleKey));
    await tester.pumpAndSettle();
    expect(find.byTooltip(chatCollapse), findsNothing, reason: '★ 点它没收起来');
    expect(closedExpand.width >= 44, true);
  });

  testWidgets('⑤ 🔴 三颗是**一体的**：那一列两块合起来 = 录音那颗的高度（上下也对齐）', (tester) async {
    // 主人 2026-10-05：*"Chat按钮，展开聊天，播放语音，他们是一体的……他们高度不同。
    //   就是展开关闭，播放语音两个合起来，高度应该和录音按钮是一样的。他们风格也应该统一。"*
    await _pumpFloater(tester, onToggleSpeak: () {});
    final expand = tester.getRect(find.byKey(chatHandleKey));
    final speak = tester.getRect(find.byKey(chatSpeakKey));
    Rect faceOf(Key k) => tester.getRect(
          find.descendant(of: find.byKey(k), matching: find.byType(Container)).first,
        );
    final f1 = faceOf(chatHandleKey);
    final f2 = faceOf(chatSpeakKey);

    // ① 两块 + 中间那条缝 = 那颗圆圈的直径（公式在 `design.dart` 里被钉过）
    expect(f1.height + d.voiceAuxGap + f2.height, d.voiceCircleBox,
        reason: '★ 两块合起来不是 ${d.voiceCircleBox}（${f1.height} + ${d.voiceAuxGap} + ${f2.height}）');
    // ② 那一列的两块**首尾相接、中间就是那条缝**
    expect(f2.top - f1.bottom, d.voiceAuxGap, reason: '★ 两块之间的缝不是 ${d.voiceAuxGap}');
    // ③ 手指能打到的仍是两颗各 ≥44（D3.6：视觉可以小，命中区不许小）
    for (final r in [expand, speak]) {
      expect(r.height >= 44 && r.width >= 44, true, reason: '★ 命中区只有 $r');
    }
    // ④ 风格统一：两颗的面与录音那颗圆圈**同一圈琥珀、同粗细**
    for (final k in [chatHandleKey, chatSpeakKey]) {
      final box = tester.widget<Container>(
        find.descendant(of: find.byKey(k), matching: find.byType(Container)).first,
      ).decoration! as BoxDecoration;
      expect(box.border!.top.color, d.accent, reason: '★ 那一圈的顔色与录音那颗不一致');
      expect(box.border!.top.width, d.voiceCircleRing, reason: '★ 那一圈的粗细与录音那颗不一致');
      expect(box.color, d.card, reason: '★ 底色与录音那颗不一致（该是同一张纸的白）');
    }
  });
}
