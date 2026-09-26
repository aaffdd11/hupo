// **配置页「语音」那一屏那颗「试一下」**（批 7 · 主人 2026-09-26）·
// 契约 `docs/dev/123-VOICE-TEST-BUTTON.md`。
//
// 这一份走的是**真那一屏**（`SettingsScreen` ＋ 点「语音」那个 tab），只把
// "开麦/收手"两个动作**注入**进去（真那一份要真麦克风，VM 上没有）——
// 于是钉住的是屏幕上到底有没有说真话：
//   ① 那颗按钮**只在「语音」那一屏**、而且**接线了才画**（不给假按钮）；
//   ② 按一下 ⇒ **真的把动作交出去**（在听 ＋ 那三个字）；再按一下 ⇒ 收手；
//   ③ 说完了 ⇒ **字落进那个文本框**（真的 `TextField`，能选能复制）；
//   ④ 每一种失败都有自己的那句话（而且**留着字**）；
//   ⑤ 开不了麦 ⇒ 只说明白话，**不装开麦**（与聊天那颗话筒同一条）；
//   ⑥ 命中区 ≥44（D3.6）· 字放到最大不溢出（D3.5 那一族，硬闸在 a11y 那份）。
//
// 🔴 为什么把状态推进去、而不是点一下真等：开麦与识别都在真浏览器/真钥匙那一侧
//    （`services/hearing_web.dart`）。这里注进去的那个假 `start` 只是**把回调收下**，
//    再由判据按**真实时序**喂帧（先 ready、再半句/定稿、最后 end）——
//    不这么走测的就不是那条路。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/voice_try.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/widgets/voice_try.dart' as vt;

/// 那个假的"开麦/收手"：把回调收下、把机器原因回出去（**不碰真麦克风**）。
class FakeHear {
  /// 被交出去的那几个回调（真实现里它们就是 `/api/asr` 那条流上的事件口）。
  final List<void Function(Map<String, dynamic>)> started = [];

  /// 按了几次"停下"。
  int stops = 0;

  /// 下一次开麦要回的**机器原因**（`null` = 真开起来了）。
  String? reason;

  void Function(Map<String, dynamic>)? get last => started.isEmpty ? null : started.last;
}

Future<FakeHear> pumpVoice(
  WidgetTester tester, {
  bool wired = true,
  bool canHear = true,
  bool hasOwn = false,
}) async {
  final f = FakeHear();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SettingsScreen(
          hasKey: true,
          keyBad: false,
          creds: SpaceCreds(voice: hasOwn),
          localOnly: true,
          onSubmit: (k) async => KeySend.ok,
          onSubmitCreds: (t, v) async => KeySend.ok,
          voiceTry: wired
              ? VoiceTryHandlers(
                  start: (onEvent) async {
                    f.started.add(onEvent);
                    return f.reason;
                  },
                  stop: () => f.stops += 1,
                )
              : null,
          canHear: canHear,
          onLogout: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text(credTabVoice));
  await tester.pumpAndSettle();
  return f;
}

/// 那个文本框里现在是什么（**就是屏幕上那一份**）。
String boxText(WidgetTester tester) => tester
    .widget<TextField>(
      find.descendant(of: find.byType(vt.VoiceTry), matching: find.byType(TextField)),
    )
    .controller!
    .text;

/// 喂一帧进去（＝真那一侧来了一条）。
Future<void> frame(WidgetTester tester, FakeHear f, Map<String, dynamic> e) async {
  f.last!(e);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('① 那颗按钮在「语音」那一屏，**别的屏没有**', (tester) async {
    await pumpVoice(tester);
    expect(find.text(voiceTryTitle), findsOneWidget);
    expect(find.text(voiceTryStart), findsOneWidget);
    // 负向对照：切到别的屏 ⇒ 那一块不在（免得它在哪儿都画）
    await tester.tap(find.text(credTabImage));
    await tester.pumpAndSettle();
    expect(find.text(voiceTryTitle), findsNothing);
    await tester.tap(find.text(credTabVideo));
    await tester.pumpAndSettle();
    expect(find.text(voiceTryTitle), findsNothing);
  });

  testWidgets('① 没接线 ⇒ **不画**（不给假按钮）', (tester) async {
    await pumpVoice(tester, wired: false);
    expect(find.text(voiceTryTitle), findsNothing);
    expect(find.text(voiceTryStart), findsNothing);
  });

  testWidgets('② 框一开始是**空但有标签**（一个字都不许编）', (tester) async {
    await pumpVoice(tester);
    expect(boxText(tester), '');
    expect(find.text(voiceTryBoxLabel), findsOneWidget, reason: '空着也要挂标签');
  });

  testWidgets('★ 按一下 ⇒ 真的开、屏幕上说在听；再按一下 ⇒ 交回去收手', (tester) async {
    final f = await pumpVoice(tester);
    await tester.tap(find.text(voiceTryStart));
    await tester.pumpAndSettle();
    expect(f.started.length, 1, reason: '★ 按一下必须真的把开麦交出去');
    expect(find.text(voiceTryStop), findsOneWidget, reason: '按钮变成"停下"');
    expect(find.text(hearListening), findsOneWidget, reason: '要明说在听（而且只在真在听时）');
    await tester.tap(find.text(voiceTryStop));
    await tester.pumpAndSettle();
    expect(f.stops, 1);
    expect(find.text(voiceTryWorking), findsOneWidget, reason: '收尾中那一下也要说出来');
  });

  testWidgets('★ 说完了 ⇒ **字落进那个文本框**（真的 `TextField`，能选能复制）', (tester) async {
    final f = await pumpVoice(tester);
    await tester.tap(find.text(voiceTryStart));
    await tester.pumpAndSettle();
    // 实时那半句
    await frame(tester, f, {'type': 'asr/partial', 'text': '今天', 'index': 0});
    expect(boxText(tester), '今天');
    await frame(tester, f, {'type': 'asr/partial', 'text': '今天天气', 'index': 0});
    expect(boxText(tester), '今天天气', reason: '同一段是替换，不是接上去');
    // 用户按停 ⇒ 等最后一句
    await tester.tap(find.text(voiceTryStop));
    await tester.pumpAndSettle();
    await frame(tester, f, {'type': 'asr/end', 'text': '今天天气怎么样', 'index': 0});
    expect(boxText(tester), '今天天气怎么样');
    expect(find.text(voiceTryStart), findsOneWidget, reason: '停了 ⇒ 按钮回到"试一下"');
    // ⚠️ 那个框**真的是输入框**（不是一段只读文字）—— 能选、能复制
    //    （`enabled`/`readOnly` 的默认值都是 `null`，所以判"没被关掉"而不是判 `true`）
    final box = tester.widget<TextField>(
      find.descendant(of: find.byType(vt.VoiceTry), matching: find.byType(TextField)),
    );
    expect(box.enabled, isNot(false), reason: '它是一个真的文本框（主人要能选中、复制）');
    expect(box.readOnly, isNot(true), reason: '不许改成只读 —— 他要能选、能复制');
  });

  testWidgets('★ 自己动过那个框之后，迟到的定稿**不再覆盖**', (tester) async {
    final f = await pumpVoice(tester);
    await tester.tap(find.text(voiceTryStart));
    await tester.pumpAndSettle();
    await frame(tester, f, {'type': 'asr/partial', 'text': '今天', 'index': 0});
    await tester.tap(find.text(voiceTryStop));
    await tester.pumpAndSettle();
    // 他自己改了一下（收尾那一句还没回来）
    await tester.enterText(
      find.descendant(of: find.byType(vt.VoiceTry), matching: find.byType(TextField)),
      '我自己改的',
    );
    await tester.pumpAndSettle();
    await frame(tester, f, {'type': 'asr/end', 'text': '今天天气怎么样', 'index': 0});
    expect(boxText(tester), '我自己改的', reason: '他的手比收尾那句快 ⇒ 不许覆盖他');
  });

  group('③ 每一种失败都有自己的那句话，而且**留着字**', () {
    testWidgets('没拿到麦克风权限', (tester) async {
      final f = await pumpVoice(tester);
      f.reason = 'denied';
      await tester.tap(find.text(voiceTryStart));
      await tester.pumpAndSettle();
      expect(find.text(hearDenied), findsOneWidget);
    });

    testWidgets('这条连接没接上（与"开不了麦克风"分开说）', (tester) async {
      final f = await pumpVoice(tester);
      f.reason = 'no-entry';
      await tester.tap(find.text(voiceTryStart));
      await tester.pumpAndSettle();
      expect(find.text(hearNoEntry), findsOneWidget);
      expect(find.text(hearFailed), findsNothing, reason: '两句混成一句就是页面在说假话');
    });

    testWidgets('开不了麦克风', (tester) async {
      final f = await pumpVoice(tester);
      f.reason = 'failed';
      await tester.tap(find.text(voiceTryStart));
      await tester.pumpAndSettle();
      expect(find.text(hearFailed), findsOneWidget);
    });

    testWidgets('★ 没配钥匙 ⇒ 说清"上面那三样就是它要用的"', (tester) async {
      final f = await pumpVoice(tester);
      f.reason = 'not-configured';
      await tester.tap(find.text(voiceTryStart));
      await tester.pumpAndSettle();
      expect(find.text(voiceTryNoKeyEmpty), findsOneWidget);
      // 负向对照：上面那三样**填过**时说另一句（去填 vs 等接好）
      final f2 = await pumpVoice(tester, hasOwn: true);
      f2.reason = 'not-configured';
      await tester.tap(find.text(voiceTryStart));
      await tester.pumpAndSettle();
      expect(find.text(voiceTryNoKeyFilled), findsOneWidget);
      expect(find.text(voiceTryNoKeyEmpty), findsNothing);
    });

    testWidgets('没额度（4004）⇒ 它自己那句', (tester) async {
      final f = await pumpVoice(tester);
      await tester.tap(find.text(voiceTryStart));
      await tester.pumpAndSettle();
      await frame(tester, f, {
        'type': 'asr/error',
        'reason': 'engine',
        'code': 4004,
        'message': '资源包耗尽',
      });
      expect(find.text(hearNoQuota), findsOneWidget);
    });

    testWidgets('到点了（`asr/capped`）⇒ 它自己那句，字留着', (tester) async {
      final f = await pumpVoice(tester);
      await tester.tap(find.text(voiceTryStart));
      await tester.pumpAndSettle();
      await frame(tester, f, {'type': 'asr/final', 'text': '说了很久', 'index': 0});
      await frame(tester, f, {'type': 'asr/capped'});
      expect(find.text(hearCapped), findsOneWidget);
      expect(boxText(tester), '说了很久', reason: '到点了也要把已经听到的留着');
    });

    testWidgets('一个字都没听到 ⇒ 说出来（不是静默的空白框）', (tester) async {
      final f = await pumpVoice(tester);
      await tester.tap(find.text(voiceTryStart));
      await tester.pumpAndSettle();
      await frame(tester, f, {'type': 'asr/end', 'index': 0});
      expect(find.text(hearNothing), findsOneWidget);
      expect(boxText(tester), '');
    });
  });

  testWidgets('★ 这里开不了麦 ⇒ 只说一句白话，**不装开麦**', (tester) async {
    final f = await pumpVoice(tester, canHear: false);
    expect(find.text(voiceTryStart), findsOneWidget, reason: '按钮照画（藏起来等于让他自己猜）');
    await tester.tap(find.text(voiceTryStart));
    await tester.pumpAndSettle();
    expect(find.text(hearCantHere), findsOneWidget);
    expect(f.started, isEmpty, reason: '★ 开不了就不许去开（更不许出假字）');
    expect(find.text(hearListening), findsNothing);
  });

  testWidgets('★ 还在听的时候走开（这一块被拆掉）⇒ **把麦交回**', (tester) async {
    // ⚠️ 这一块没有一个"一直在"的位置提醒他还在录（与聊天那颗话筒不同）——
    //    留着它就会一直采到服务端那个到点为止，而他什么都看不见。
    final f = await pumpVoice(tester);
    await tester.tap(find.text(voiceTryStart));
    await tester.pumpAndSettle();
    expect(f.started.length, 1);
    // 像"切走 / 关掉这一屏"那样把这一棵树拆掉
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox())));
    await tester.pumpAndSettle();
    expect(f.stops, 1, reason: '★ 走开时必须收手（不然麦克风留在手里）');
  });

  testWidgets('命中区 ≥44（D3.6）', (tester) async {
    await pumpVoice(tester);
    final size = tester.getSize(find.widgetWithText(FilledButton, voiceTryStart));
    expect(size.height >= 44, true, reason: '那颗按钮只有 ${size.height} 高');
    expect(size.width >= 44, true, reason: '那颗按钮只有 ${size.width} 宽');
  });

  testWidgets('字放到 3.1 倍也不溢出（D3.5 那一族的形状）', (tester) async {
    final f = FakeHear();
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(textScaler: TextScaler.linear(3.1)),
          child: Scaffold(
            body: SettingsScreen(
              hasKey: true,
              keyBad: false,
              creds: const SpaceCreds(voice: true),
              localOnly: true,
              onSubmit: (k) async => KeySend.ok,
              onSubmitCreds: (t, v) async => KeySend.ok,
              voiceTry: VoiceTryHandlers(start: (e) async { f.started.add(e); return null; }, stop: () {}),
              canHear: true,
              onLogout: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text(credTabVoice));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text(voiceTryStart), findsOneWidget);
  });
}
