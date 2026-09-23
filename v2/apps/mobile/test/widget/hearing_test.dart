// **语音那一块（真开麦）** · 主人 2026-09-23 定案 + **2026-09-24 收成一行** ·
// 契约 `docs/dev/71-MIC-ASR.md` / `docs/dev/75-CHAT-ROW.md`。
//
// 🔴 **2026-09-24 的形状改了**（主人：*"语音按钮放在聊天框内部的右侧"*）：
//    话筒从**左边那颗切换键**变成**框里右边那颗**；**"语音档"没有了** ——
//    按一下就开始听、字**直接落进这个框**、再按一下结束、发送钮由他按。
//    ⇒ 这一份跟着重写：原来那些"进语音档/退回键盘档"的断言，钉的已经不是产品了。
//
// 现在钉八件（都是"屏幕上到底有没有说真话"）：
//   ① 🔴 **开不了麦 ⇒ 话筒照样在**，点它只说一句白话（不装开麦）
//   ② 闲的时候：点一下**真的把动作交出去**
//   ③ 正在听 ⇒ `● 正在听` 那一行在、听到的字**进了框**、**发送钮按不动**
//   ④ ⚠️ **没配钥匙** ⇒ 那句人话出来；话筒**也在**
//      （2026-09-23 主人问过"为什么录音的 icon 没有" ⇒ "藏起来"改成"摆着 + 说清为什么"）
//   ⑤ 没拿到权限 ⇒ 人话 + 话筒还在（他能再按一次去放权限）
//   ⑥ ★ **说完了 ⇒ 字落在输入框里、发送钮亮起来**（主人："然后将文字展示出来。
//      用户可以选择发送。"—— 🔴 **不自动发送**，D5.4）
//   ⑦ 一句都没听到 ⇒ 屏幕上说清楚（`hearNothing`），话筒还在
//   ⑧ 命中区 ≥44（D3.6）· 2.0 倍字号不溢出（D3.5 那一族）
//
// ⚠️ 测试环境里 `canHear` 是假（`services/hearing_stub.dart`），所以这里把
//    `canHear`/`hearing`/`onMicToggle` **注入**进去，并且用 `ValueNotifier`
//    驱动 —— **照真实时序走**（先"在听"，再一句一句来字，最后收尾），
//    不然测的就不是那条路（"照着记忆里的老做法测"正是本项目最贵的错法）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hearing_session.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/widgets/composer.dart';

/// 把 Composer 绑在一个会变的 `Hearing` 上（＝真实那条路：状态从外面来）。
class _Harness extends StatelessWidget {
  const _Harness({
    required this.hearing,
    this.canHear = true,
    this.onMicToggle,
    this.scale = 1.0,
  });

  final ValueNotifier<Hearing> hearing;
  final bool canHear;
  final VoidCallback? onMicToggle;
  final double scale;

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(textScaler: TextScaler.linear(scale)),
      child: Scaffold(
        body: ValueListenableBuilder<Hearing>(
          valueListenable: hearing,
          builder: (context, h, _) => Composer(
            onSend: (_) {},
            canHear: canHear,
            hearing: h,
            onMicToggle: onMicToggle,
          ),
        ),
      ),
    ),
  );
}

Future<ValueNotifier<Hearing>> pump(
  WidgetTester tester, {
  Hearing start = const Hearing(),
  bool canHear = true,
  VoidCallback? onMicToggle,
  double scale = 1.0,
}) async {
  final n = ValueNotifier<Hearing>(start);
  await tester.pumpWidget(
    _Harness(
      hearing: n,
      canHear: canHear,
      onMicToggle: onMicToggle,
      scale: scale,
    ),
  );
  await tester.pumpAndSettle();
  return n;
}

/// **话筒**（框里右边那颗）：闲的时候是 `mic_none`，在听的时候是"停"。
Finder micIdle() => find.byIcon(Icons.mic_none);
Finder micLive() => find.byIcon(Icons.stop_circle_outlined);

/// **发送钮此刻按不按得动**（主人 2026-09-24：它**一直在**，没字时是灰的）。
/// ⚠️ 判据要看"能不能按"，不是"在不在"—— 在不在已经永远是"在"。
bool sendReady(WidgetTester tester) {
  final b = tester.widget<IconButton>(
    find.ancestor(
      of: find.byIcon(Icons.arrow_upward),
      matching: find.byType(IconButton),
    ),
  );
  return b.onPressed != null;
}

void main() {
  testWidgets('★ 开不了麦 ⇒ 话筒**还在**，点它只说明白话（不装开麦）', (tester) async {
    // 🔴 2026-09-23 改的：原来这一档是**把话筒藏起来**，而主人看到的就是
    //    "为什么录音的 icon 没有？" —— 藏起来等于让用户自己猜。
    await pump(tester, canHear: false);
    expect(micIdle(), findsOneWidget);
    await tester.tap(micIdle());
    await tester.pumpAndSettle();
    expect(find.text(hearCantHere), findsOneWidget); // 说一句白话
    expect(micIdle(), findsOneWidget); // 但**不开麦**（按钮还在，再点还是那句话）
  });

  testWidgets('★ 闲的时候：点一下话筒真的交出去（框里右边那颗）', (tester) async {
    var tapped = 0;
    await pump(tester, onMicToggle: () => tapped += 1);
    expect(micIdle(), findsOneWidget);
    await tester.tap(micIdle());
    await tester.pumpAndSettle();
    expect(tapped, 1);
  });

  testWidgets('★ 正在听：`● 正在听` 在、字进了框、**发送钮按不动**', (tester) async {
    var tapped = 0;
    final n = await pump(
      tester,
      start: const Hearing(phase: HearingPhase.listening, segments: {0: '今天天气'}),
      onMicToggle: () => tapped += 1,
    );
    expect(find.text(hearListening), findsOneWidget); // ● 正在听（录音标记）
    expect(micLive(), findsOneWidget); // 话筒变成"停"
    expect(find.text('今天天气'), findsOneWidget); // 实时那几个字**在框里**
    // 🔴 **正在听的时候按不动发送**（半句话不许被发出去）
    expect(sendReady(tester), false, reason: '半句话不许发出去');
    // 来下一句 ⇒ **屏幕上跟着变**（"实时转化语音成文字"）
    n.value = const Hearing(phase: HearingPhase.listening, segments: {0: '今天天气怎么样'});
    await tester.pumpAndSettle();
    expect(find.text('今天天气怎么样'), findsOneWidget);
    await tester.tap(micLive());
    await tester.pumpAndSettle();
    expect(tapped, 1);
  });

  testWidgets('★ 没配钥匙 ⇒ 出现那句人话，话筒也在（不装开麦）', (tester) async {
    await pump(
      tester,
      start: const Hearing(phase: HearingPhase.unavailable, why: hearUnavailable),
    );
    expect(find.text(hearUnavailable), findsOneWidget);
    // ⚠️ 2026-09-24：这里**不再断言"不画按钮"** —— 那条规矩（"按不动的不许摆"）
    //    被 2026-09-23 主人那句"为什么录音的 icon 没有"取代了：
    //    **摆着 + 一句白话**才对。按下去由上层决定（`onMicToggle`）。
    expect(micIdle(), findsOneWidget);
  });

  testWidgets('★ 没拿到权限 ⇒ 人话 + 话筒还在（他能再按一次去放权限）', (tester) async {
    await pump(
      tester,
      start: const Hearing(phase: HearingPhase.denied, why: hearDenied),
    );
    expect(find.text(hearDenied), findsOneWidget);
    expect(micIdle(), findsOneWidget);
  });

  testWidgets('★ 说完了 ⇒ 字落在输入框里、发送钮**亮起来**（不自动发）', (tester) async {
    final n = await pump(tester);
    expect(sendReady(tester), false, reason: '一开始：没字 ⇒ 灰的、按不动');
    n.value = const Hearing().tapped();
    await tester.pumpAndSettle();
    expect(find.text(hearListening), findsOneWidget);
    // 一句一句来字（实时那一段）
    n.value = n.value.partial('今天天气', index: 0);
    await tester.pumpAndSettle();
    expect(find.text('今天天气'), findsOneWidget);
    // 收尾（对面说整段完了）
    n.value = n.value.finalText('今天天气怎么样').done();
    await tester.pumpAndSettle();
    // 字在框里看得见
    expect(find.text('今天天气怎么样'), findsWidgets);
    // 🔴 **不自动发送**（D5.4）：发送钮亮起来，按不按由他
    expect(sendReady(tester), true, reason: '字到了 ⇒ 发送钮该能按了');
  });

  testWidgets('★ 一句都没听到 ⇒ 屏幕上说清楚（而且话筒还在，能再按一次）', (tester) async {
    final n = await pump(tester);
    n.value = const Hearing().tapped();
    await tester.pumpAndSettle();
    expect(find.text(hearListening), findsOneWidget);
    // 对面说"整段完了"，可一个字都没有
    n.value = n.value.done();
    await tester.pumpAndSettle();
    expect(find.text(hearNothing), findsOneWidget); // 屏幕上说了实话
    expect(micIdle(), findsOneWidget); // 话筒还在（他能再按一次）
  });

  testWidgets('★ 话筒的命中区 ≥44（D3.6）', (tester) async {
    await pump(tester);
    final size = tester.getSize(
      find.ancestor(of: micIdle(), matching: find.byType(IconButton)),
    );
    expect(size.height >= 44, true, reason: '话筒命中区只有 ${size.height}');
    expect(size.width >= 44, true, reason: '话筒命中区只有 ${size.width}');
  });

  testWidgets('★ 发送钮的命中区 ≥44（它是常驻的，更要够大）', (tester) async {
    await pump(tester);
    final size = tester.getSize(
      find.ancestor(
        of: find.byIcon(Icons.arrow_upward),
        matching: find.byType(IconButton),
      ),
    );
    expect(size.height >= 44, true, reason: '发送命中区只有 ${size.height}');
    expect(size.width >= 44, true, reason: '发送命中区只有 ${size.width}');
  });

  testWidgets('放大到 2.0 倍也不溢出（D3.5 那一族的形状）', (tester) async {
    await pump(
      tester,
      start: const Hearing(phase: HearingPhase.listening, segments: {0: '今天天气怎么样'}),
      scale: 2.0,
    );
    expect(tester.takeException(), isNull);
  });
}
