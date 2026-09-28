// **配置页「语音」那一屏里的「录一段」（录音 ＋ 回放）**（主人 2026-09-27）·
// 契约 `docs/dev/128-VOICE-RECORD-AND-PLAY.md`。
//
// 这一份走的是**真那一屏**（`SettingsScreen` ＋ 点「语音」那个 tab），只把
// "开录 / 收手 / 放音 / 别放了"四个动作**注入**进去（真那一份要真麦克风，VM 上没有）
// —— 于是钉住的是屏幕上到底有没有说真话：
//   ① 那一块**只在「语音」那一屏**、而且**接线了才画**（不给假按钮）；
//   ② 按一下 ⇒ **真的把动作交出去**（按钮变成"停下"）；再按一下 ⇒ 拿到那一段
//      ⇒ 出现"听一遍" ＋ 那句时长；
//   ③ 放音：按"听一遍" ⇒ 真的放；放完自己回到"听一遍"；按"别放了" ⇒ 停；
//      🔴 正在放的时候按"开始录" ⇒ **先把放音停掉**再开录（不叠在一起）；
//   ④ 每一种失败都有自己的那句话（没权限 / 这里录不了 / 开不起来 / 录下来是空的），
//      而且**录不到东西时不许出现"听一遍"**；
//   ⑤ 这里录不了 ⇒ **照样画那颗按钮**，点下去只说一句白话（**一次都不去开麦**）；
//   ⑥ 命中区 ≥44（D3.6）· 字放到最大不溢出（D3.5 那一族，硬闸在 a11y 那份）。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/voice_record.dart';
import 'package:hupo_app/widgets/voice_record.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';

/// 那个假的"开录 / 收手 / 放音"：把每一次调用记下来（**不碰真麦克风**）。
class FakeRec {
  int starts = 0;
  int stops = 0;
  int plays = 0;
  int stopPlays = 0;

  /// 每一次开录要回的**机器原因**（`null` = 真开起来了）。
  String? startWhy;

  /// 收手时给那一段（`null` = 什么都没录到）。
  RecordedClip? clip;

  /// 放音那一条拿到的地址（判据要核"放的就是刚录的那一段"）。
  String? playedUrl;

  /// 真实现里"放完了"那一下（判据拿它把按钮推回去）。
  void Function()? onEnded;

  /// 这台"设备"录得了音吗（判据用它演"这里录不了"那一档）。
  bool canRecordValue = true;

  /// **那串电平**（主人 2026-09-28 要的"时间轴语音bar"）：判据往里推采样。
  /// `null` = 这一份实现不报电平（那种实现界面上**不许画那条轴**）。
  StreamController<double>? levelOut;
}

Future<FakeRec> pumpRec(
  WidgetTester tester, {
  bool wired = true,
  bool canRecord = true,
  RecordedClip? clip,
  String? startWhy,
}) async {
  final f = FakeRec()
    ..canRecordValue = canRecord
    ..startWhy = startWhy
    ..clip = clip;
  await pumpRecWith(tester, f, wired: wired);
  return f;
}

/// 用**已经造好的**那个假的泵一次（判据要先设好 `levelOut` 再泵）。
Future<void> pumpRecWith(WidgetTester tester, FakeRec f, {bool wired = true}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SettingsScreen(
          hasKey: true,
          keyBad: false,
          creds: const SpaceCreds(voice: false),
          localOnly: true,
          onSubmit: (k) async => KeySend.ok,
          onSubmitCreds: (t, v) async => KeySend.ok,
          voiceRecord: wired
              ? VoiceRecordHandlers(
                  canRecord: f.canRecordValue,
                  start: () async {
                    f.starts += 1;
                    return f.startWhy;
                  },
                  stop: () async {
                    f.stops += 1;
                    return f.clip;
                  },
                  play: (url, onEnded) {
                    f.plays += 1;
                    f.playedUrl = url;
                    f.onEnded = onEnded;
                  },
                  stopPlay: () => f.stopPlays += 1,
                  levels: f.levelOut?.stream,
                )
              : null,
          canHear: false,
          onLogout: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await goTab(tester, credTabVoice);
}

const _clip = RecordedClip(url: 'blob:local-1', ms: 4200);

/// 往那串电平里推一个采样，并把它**渲染出来**
/// （⚠️ 流是异步的：一次 `pump` 只把事件送到、第二次才画出来 —— 少一次就会看到"没画"）。
Future<void> pushLevel(WidgetTester tester, StreamController<double> c, double v) async {
  c.add(v);
  await tester.pump();
  await tester.pump();
}

/// **先把它滚进视口再点**：设置那一屏是可滚的，而这一块在 800×600 的判据面上
/// 会落到折叠线以下 —— 不滚就点，`tap()` 会"点了个空"（而且只给一条 warning，
/// **判据会假装过了**：这正是这个仓库最恨的那种形状）。
Future<void> tapVisible(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
}

/// **切到设置里某一页**（2026-09-29：顶层改成"一列分类"之后，子页要**先回来**才能换）。
Future<void> goTab(WidgetTester tester, String tab) async {
  final back = find.text(settingsBack);
  if (back.evaluate().isNotEmpty) {
    await tester.tap(back);
    await tester.pumpAndSettle();
  }
  final row = find.text(tab == credTabChat ? settingsRowModel : tab);
  if (row.evaluate().isEmpty) {
    // ⚠️ 顶层那一列**是懒加载的**：滚过之后就找不到上面那几行了
    //    ⇒ 像用户那样滚回去（`ensureVisible` 对"还没建出来"的东西会当场抛）。
    await tester.scrollUntilVisible(
      row,
      200,
      scrollable: find
          .descendant(of: find.byKey(settingsListKey), matching: find.byType(Scrollable))
          .first,
    );
    await tester.pumpAndSettle();
  }
  expect(row, findsOneWidget, reason: '★ 顶层那一列里找不到「$tab」⇒ 这一条量错了地方');
  await tester.tap(row);
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('🔴 那一块只在「语音」那一屏：抬头、那句怎么用、那颗大按钮', (tester) async {
    await pumpRec(tester);
    expect(find.text(voiceRecTitle), findsOneWidget);
    expect(find.text(voiceRecHint), findsOneWidget, reason: '★ 要说清这段留在哪儿');
    expect(find.text(voiceRecStart), findsOneWidget);
    // 手里没东西 ⇒ **不画"听一遍"**（不给假按钮）
    expect(find.text(voiceRecPlay), findsNothing);

    // 换到"聊天"那一屏 ⇒ 那一块不在（它只属于语音那一屏）
    await goTab(tester, credTabChat);
    expect(find.text(voiceRecTitle), findsNothing, reason: '★ 别的屏上不许有它');
  });

  testWidgets('★ 没接线（`voiceRecord == null`）⇒ 那一块一个像素都不画', (tester) async {
    await pumpRec(tester, wired: false);
    expect(find.text(voiceRecTitle), findsNothing);
    expect(find.text(voiceRecStart), findsNothing);
  });

  testWidgets('🔴 按一下 ⇒ 真的开录（按钮变"停下"）；再按一下 ⇒ 拿到那一段 ＋ 时长', (tester) async {
    final f = await pumpRec(tester, clip: _clip);
    await tapVisible(tester, find.text(voiceRecStart));
    expect(f.starts, 1, reason: '★ 真把"开录"交出去了');
    expect(find.text(voiceRecStop), findsOneWidget, reason: '★ 录着的时候按钮是"停下"');

    await tapVisible(tester, find.text(voiceRecStop));
    expect(f.stops, 1);
    expect(find.text(voiceRecPlay), findsOneWidget, reason: '★ 手里有一段 ⇒ 出现"听一遍"');
    expect(find.text(voiceRecLength(4200)), findsOneWidget, reason: '★ 时长那句');
  });

  testWidgets('🔴 听一遍 ⇒ 真的放那一段；放完自己回到"听一遍"；"别放了"也停得住', (tester) async {
    final f = await pumpRec(tester, clip: _clip);
    await tapVisible(tester, find.text(voiceRecStart));
    await tapVisible(tester, find.text(voiceRecStop));

    await tapVisible(tester, find.text(voiceRecPlay));
    expect(f.plays, 1);
    expect(f.playedUrl, _clip.url, reason: '★ 放的就是刚录的那一段（本机那条地址）');
    expect(find.text(voiceRecPlayStop), findsOneWidget, reason: '★ 放着的时候那颗按钮是"别放了"');

    // 它自己放完了 ⇒ 按钮回到"听一遍"
    f.onEnded!();
    await tester.pumpAndSettle();
    expect(find.text(voiceRecPlay), findsOneWidget);

    // 再放一次，然后按"别放了"
    await tapVisible(tester, find.text(voiceRecPlay));
    await tapVisible(tester, find.text(voiceRecPlayStop));
    expect(f.stopPlays, greaterThanOrEqualTo(1));
    expect(find.text(voiceRecPlay), findsOneWidget, reason: '★ 停了就回到"听一遍"');
  });

  testWidgets('★ 正在放的时候按"开始录" ⇒ **先把放音停掉**再开录（不叠在一起）', (tester) async {
    final f = await pumpRec(tester, clip: _clip);
    await tapVisible(tester, find.text(voiceRecStart));
    await tapVisible(tester, find.text(voiceRecStop));
    await tapVisible(tester, find.text(voiceRecPlay));

    await tapVisible(tester, find.text(voiceRecStart));
    expect(f.stopPlays, greaterThanOrEqualTo(1), reason: '★ 放音先停');
    expect(f.starts, 2, reason: '★ 然后才开录（第二次）');
    expect(find.text(voiceRecStop), findsOneWidget);
  });

  testWidgets('🔴 录下来是空的 ⇒ 明说，而且**不出现"听一遍"**', (tester) async {
    await pumpRec(tester, clip: null);
    await tapVisible(tester, find.text(voiceRecStart));
    await tapVisible(tester, find.text(voiceRecStop));
    expect(find.text(voiceRecEmpty), findsOneWidget, reason: '★ 一个声音都没有也要说出来');
    expect(find.text(voiceRecPlay), findsNothing, reason: '★ 没有东西可放就别摆那颗按钮');
  });

  testWidgets('🔴 开不起来 ⇒ 说明白并收场（不装还在录）', (tester) async {
    await pumpRec(tester, startWhy: 'denied');
    await tapVisible(tester, find.text(voiceRecStart));
    expect(find.text(hearDenied), findsOneWidget, reason: '★ 没权限那一句（与话筒同一句）');
    expect(find.text(voiceRecStart), findsOneWidget, reason: '★ 收场了：按钮回到"开始录"');
    expect(find.text(voiceRecStop), findsNothing, reason: '★ 绝不假装还在录');
  });

  testWidgets('🔴 这里录不了 ⇒ 照样画按钮，点它**只说白话、一次都不去开录**', (tester) async {
    final f = await pumpRec(tester, canRecord: false);
    expect(find.text(voiceRecStart), findsOneWidget, reason: '★ 藏起来等于让他自己猜');
    await tapVisible(tester, find.text(voiceRecStart));
    expect(f.starts, 0, reason: '★ 一次都不该去开麦（负向对照）');
    expect(find.text(hearCantHere), findsOneWidget);
  });

  testWidgets('★ 命中区 ≥44（D3.6）', (tester) async {
    await pumpRec(tester, clip: _clip);
    final main = tester.getSize(find.widgetWithText(FilledButton, voiceRecStart));
    expect(main.height, greaterThanOrEqualTo(44), reason: '★ 大按钮（实测 $main）');
    await tapVisible(tester, find.text(voiceRecStart));
    await tapVisible(tester, find.text(voiceRecStop));
    final play = tester.getSize(find.widgetWithText(OutlinedButton, voiceRecPlay));
    expect(play.height, greaterThanOrEqualTo(44), reason: '★ 回放那颗（实测 $play）');
  });

  // ── ★ 2026-09-28：录的时候那条**音量轴**（主人："录音时，可以检测收到语音，
  //    并且给出一个录音时候的那种时间轴语音bar吗？"）────────────────────

  testWidgets('🔴 录着的时候：推电平 ⇒ 出现那条轴 ＋「听得到声音」＋ 走时', (tester) async {
    final f = FakeRec()..levelOut = StreamController<double>.broadcast();
    addTearDown(f.levelOut!.close);
    await pumpRecWith(tester, f);
    await tapVisible(tester, find.text(voiceRecStart));
    expect(find.byKey(voiceLevelAxisKey), findsNothing, reason: '起点：还没采到读数 ⇒ **不画**（不许编一个 0.0 秒）');
    await pushLevel(tester, f.levelOut!, 0.9);
    expect(find.byKey(voiceLevelAxisKey), findsOneWidget, reason: '★ 采到读数才画那条轴');
    expect(find.text(voiceRecHearing), findsOneWidget, reason: '★ 有声音就如实说"听得到声音"');
    expect(find.textContaining('已录'), findsOneWidget, reason: '★ 走时那句');
  });

  testWidgets('★ 很安静 ⇒ 说"这边很安静"（不带迟滞的话会来回跳）', (tester) async {
    final f = FakeRec()..levelOut = StreamController<double>.broadcast();
    addTearDown(f.levelOut!.close);
    await pumpRecWith(tester, f);
    await tapVisible(tester, find.text(voiceRecStart));
    for (var i = 0; i < 10; i++) {
      await pushLevel(tester, f.levelOut!, 0.0);
    }
    expect(find.text(voiceRecQuiet), findsOneWidget);
    expect(find.text(voiceRecHearing), findsNothing);
  });

  testWidgets('🔴 这一份实现**不报电平** ⇒ 那条轴与走时一个字都不出现', (tester) async {
    // 负向对照（`levels: null`，就是桩那一档）：不许凭空画一条 0 的轴出来。
    await pumpRec(tester, startWhy: null);
    await tapVisible(tester, find.text(voiceRecStart));
    expect(find.byKey(voiceLevelAxisKey), findsNothing);
    expect(find.textContaining('已录'), findsNothing);
    expect(find.text(voiceRecHearing), findsNothing);
    expect(find.text(voiceRecQuiet), findsNothing);
  });

  testWidgets('★ 录完（按停下）⇒ 那条轴与走时都收干净', (tester) async {
    final f = FakeRec()
      ..levelOut = StreamController<double>.broadcast()
      ..clip = _clip;
    addTearDown(f.levelOut!.close);
    await pumpRecWith(tester, f);
    await tapVisible(tester, find.text(voiceRecStart));
    await pushLevel(tester, f.levelOut!, 0.8);
    expect(find.byKey(voiceLevelAxisKey), findsOneWidget);
    await tapVisible(tester, find.text(voiceRecStop));
    expect(find.byKey(voiceLevelAxisKey), findsNothing, reason: '★ 停了就不该还留着那条轴');
    expect(find.textContaining('已录'), findsNothing);
    expect(find.text(voiceRecPlay), findsOneWidget, reason: '★ 该出现的是"听一遍"');
  });

  testWidgets('★ 3.1 倍字号下：录着 ＋ 有那条轴，也不许溢出（D3.5）', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 3.1;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final f = FakeRec()..levelOut = StreamController<double>.broadcast();
    addTearDown(f.levelOut!.close);
    await pumpRecWith(tester, f);
    await tapVisible(tester, find.text(voiceRecStart));
    await pushLevel(tester, f.levelOut!, 0.7);
    expect(find.byKey(voiceLevelAxisKey), findsOneWidget);
    expect(tester.takeException(), isNull, reason: '★ 3.1 倍下不许溢出');
  });

  testWidgets('★ 走开（这一块被拆掉）⇒ 把声音停掉、正在录就收手（不给对面留个孤儿）', (tester) async {
    final f = await pumpRec(tester, clip: _clip);
    await tapVisible(tester, find.text(voiceRecStart));
    // 换到别的 tab ⇒ 这一块被拆掉
    await goTab(tester, credTabChat);
    expect(f.stops, greaterThanOrEqualTo(1), reason: '★ 走开的时候麦要关掉');
  });
}
