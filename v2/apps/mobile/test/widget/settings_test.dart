// **「配置」页**（主人 2026-09-24 定的**四个 tab**）· 契约 `docs/dev/79-CREDS-TABS.md`。
//
// 主人原话：*"配置页用来配置模型，语言大模型apikey，语音大模型，图片生成，视频生成。"*
//
// 这一份钉的是**形状与话**（`72-UI-PASS.md` 那几条继续有效，见下面 ⑦⑧）：
//   ① 四个 tab 都在，而且**顺序就是主人说的那样**
//   ② 🔴 **每一屏都要说清"这一样管什么"**
//   ③ 🔴 **图片/视频/语音那一屏必须说清"收下了 ≠ 现在就生效"**（P1-1 的边界句）
//   ④ 语音那一屏是**三样**（三样齐了才算有）；图片/视频是一串
//   ⑤ 提交**一次把那一屏写完**（语音三样不许分三次写）
//   ⑥ `localOnly`（主人自己那一份）**也能填**（2026-09-24 他选的那一档）
//   ⑦ 关于 / 退出登录还在（第一屏底下）；退出登录**仍然是红的**
//   ⑧ 分区标题是"黑 + 加粗"，不是强调色（原来像警告）

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/widgets/cred_form.dart';
import 'package:hupo_app/widgets/key_form.dart';

/// 记下"哪一屏被提交了什么"（判据只看这个 —— 不碰网络）。
class Sent {
  String? tab;
  Map<String, String>? values;
  int n = 0;
}

Future<Sent> pump(
  WidgetTester tester, {
  // ⚠️ 默认＝**主人那一份**（真实接线里 `localOnly = !space.isTenant`）——
  //    判据的默认值要跟真实那条路一致，不然"默认就是租户"会让人看错结论。
  bool localOnly = true,
  bool tenant = false,
  SpaceCreds creds = const SpaceCreds(),
  bool hasKey = false,
}) async {
  final sent = Sent();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SettingsScreen(
          hasKey: hasKey,
          keyBad: false,
          creds: creds,
          localOnly: tenant ? false : localOnly,
          onSubmit: (k) async => KeySend.ok,
          onSubmitCreds: (tab, values) async {
            sent.tab = tab;
            sent.values = values;
            sent.n += 1;
            return KeySend.ok;
          },
          onLogout: () {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return sent;
}

/// 切到某一屏（像用户那样**点那个 tab**）。
Future<void> goTab(WidgetTester tester, String tab) async {
  await tester.tap(find.text(tab));
  await tester.pumpAndSettle();
}

/// **像用户那样滚到「这个助手」那一块**（批次 4 起这一步是必须的）。
///
/// ⚠️ 为什么：`lib/screens/settings_screen.dart` 的聊天那一屏上面多了
///    **「这块窗口」那张卡**（外观 / 字号，契约 `docs/dev/119`）⇒
///    「关于 / 退出登录」那一段落到了折叠线以下，而 `ListView`
///    **不会把屏幕外的孩子建出来** ⇒ 不滚的话 `find.text(settingsAboutSection)`
///    一个都找不到（这正是"用户得滚一下才看得见"）。
/// ⚠️ 指名道姓到**那一屏的内容列**（`credTab:聊天` 里的那个 `Scrollable`）：
///    `SettingsScreen` 里第一个 `Scrollable` 是 `TabBar` 自己那一行（横滚）。
Future<void> scrollToAbout(WidgetTester tester) async {
  await tester.scrollUntilVisible(
    find.text(settingsAboutSection),
    240,
    scrollable: find
        .descendant(
          of: find.byKey(const ValueKey('credTab:$credTabChat')),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('① 四个 tab 都在，顺序＝主人说的那样', (tester) async {
    await pump(tester);
    for (final tab in credTabs) {
      expect(find.text(tab), findsOneWidget, reason: '少了这一屏：$tab');
    }
    expect(credTabs, [credTabChat, credTabVoice, credTabImage, credTabVideo]);
  });

  testWidgets('② 每一屏都说清"这一样管什么"', (tester) async {
    await pump(tester);
    for (final tab in credTabs) {
      await goTab(tester, tab);
      expect(find.text(credTabWhat(tab)), findsOneWidget, reason: '$tab 那一屏没说自己管什么');
    }
  });

  testWidgets('③ 🔴 图片/视频/语音那一屏都说清"收下了 ≠ 现在就生效"', (tester) async {
    await pump(tester);
    for (final tab in [credTabVoice, credTabImage, credTabVideo]) {
      await goTab(tester, tab);
      final line = credBoundaryOf(tab)!;
      expect(find.text(line), findsOneWidget, reason: '$tab 那一屏少了边界那句');
      // ⚠️ 那句话的**实质**：说清"什么时候才用它 / 现在为什么还不能用" ——
      //    **要么**"还没填 ⇒ 填上就能用"、**要么**"填好了 ⇒ 现在就能用"、
      //    **要么**"还没接上 / 没做"。🔴 **不许**含糊过去（那才是这一条要守的东西）。
      //
      // 🔴 2026-09-25 更正（这条闸**在 HEAD 上就是红的**，子 agent 查出来的）：
      //    旧断言钉的是 `先收`／`还没接上`，那是**图片接通之前**（2026-09-24 之前）的事实；
      //    图片那条接通之后，那种说法**本身成了假话**（把"能用的那半"也说成不能用 ——
      //    见 `space_words.dart` 里那段"2026-09-24 更正"）⇒ 判据改成"必须落在
      //    这几档**诚实说法**里"，**不是**钉死某一句。守的还是同一件事：
      //    **"收下了"不等于"现在就生效"，页面要把这件事说清**。
      const honest = ['填上', '还没填', '填好', '先收', '还没接', '等你这台', '没做'];
      expect(
        honest.any(line.contains),
        true,
        reason: '边界句要说实话（说清什么时候才生效）：$line',
      );
    }
    // 负向对照：聊天那一屏**没有**这句（它是现在就在用的那一条）
    await goTab(tester, credTabChat);
    expect(find.text(credVoiceBoundaryDefault), findsNothing);
    expect(credBoundaryOf(credTabChat), isNull);
  });

  testWidgets('③ 🔴 语音那一句**跟着事实变**（填了就真用它 / 租户那台还没接上）', (tester) async {
    // ① 主人（本机）**没填** ⇒ 说清"现在用的是机器上配好的那份"
    await pump(tester);
    await goTab(tester, credTabVoice);
    expect(find.text(credVoiceBoundaryDefault), findsOneWidget);

    // ② 主人（本机）**填了** ⇒ 说清"以后就用这三样"
    await pump(tester, creds: const SpaceCreds(voice: true));
    await goTab(tester, credTabVoice);
    expect(find.text(credVoiceBoundaryMine), findsOneWidget);
    expect(find.text(credVoiceBoundaryDefault), findsNothing, reason: '★ 填了还说"用的是别的那份"就是假话');

    // ③ 租户（有自己一台）——**还没接上**：填了也不许说"就用它"
    await pump(tester, localOnly: false, creds: const SpaceCreds(voice: true), tenant: true);
    await goTab(tester, credTabVoice);
    expect(find.text(credVoiceBoundaryTenantHas), findsOneWidget);
    expect(find.text(credVoiceBoundaryMine), findsNothing, reason: '★ 租户那台还没接上，不许承诺');
  });

  testWidgets('④ 语音那一屏是**三样**；图片/视频各一串', (tester) async {
    await pump(tester);
    await goTab(tester, credTabVoice);
    expect(find.byType(CredForm), findsOneWidget);
    for (final label in [credVoiceAppIdLabel, credVoiceSecretIdLabel, credVoiceSecretKeyLabel]) {
      expect(find.text(label), findsOneWidget, reason: '语音少了这一项：$label');
    }
    expect(tester.widget<CredForm>(find.byType(CredForm)).fields.length, 3);

    await goTab(tester, credTabImage);
    expect(tester.widget<CredForm>(find.byType(CredForm)).fields.length, 1);
    await goTab(tester, credTabVideo);
    expect(tester.widget<CredForm>(find.byType(CredForm)).fields.length, 1);
    // 老表单只在聊天那一屏
    await goTab(tester, credTabChat);
    expect(find.byType(KeyForm), findsOneWidget);
    expect(find.byType(CredForm), findsNothing);
  });

  testWidgets('⑤ 🔴 提交**一次把那一屏写完**（语音三样一起送）', (tester) async {
    final sent = await pump(tester);
    await goTab(tester, credTabVoice);
    final boxes = find.byType(TextField);
    expect(boxes, findsNWidgets(3));
    await tester.enterText(boxes.at(0), '1300000001');
    await tester.enterText(boxes.at(1), 'secret-id-x');
    await tester.enterText(boxes.at(2), 'secret-key-y');
    await tester.tap(find.text(keySubmit));
    await tester.pumpAndSettle();

    expect(sent.n, 1, reason: '★ 只许提交一次（三样必须一起写下去，不许分三次）');
    expect(sent.tab, credTabVoice);
    expect(sent.values, {
      'voiceAppId': '1300000001',
      'voiceSecretId': 'secret-id-x',
      'voiceSecretKey': 'secret-key-y',
    });
    // 🔴 值**不许显示回去**（它是密钥；输入框挡着）
    expect(tester.widget<TextField>(find.byType(TextField).at(1)).obscureText, true);
  });

  testWidgets('⑤ 图片那一屏：填一串 ⇒ 送的是 `image` 那一个字段', (tester) async {
    final sent = await pump(tester);
    await goTab(tester, credTabImage);
    await tester.enterText(find.byType(TextField), '  img-key-1  ');
    await tester.tap(find.text(keySubmit));
    await tester.pumpAndSettle();
    expect(sent.tab, credTabImage);
    expect(sent.values, {'image': 'img-key-1'}, reason: '首尾空格要去掉（粘进来常带空格）');
  });

  testWidgets('⑥ 主人自己那一份（localOnly）**也能填**，而且说清写到哪', (tester) async {
    await pump(tester, localOnly: true);
    // ⚠️ 2026-09-24 改口径：他选了"要真能改" ⇒ 这一屏**有**表单
    expect(find.byType(KeyForm), findsOneWidget, reason: '他自己那一份现在也能在这页换钥匙');
    expect(find.text(configLocalOnly), findsOneWidget);
    expect(configLocalOnly.contains('本机'), true);
  });

  testWidgets('⑦ 关于 / 退出登录还在（第一屏底下）；退出登录**仍然是红的**', (tester) async {
    await pump(tester);
    // ⚠️ 批次 4：这一块现在在这一屏的**下面**了 ⇒ 像用户那样先滚过去。
    await scrollToAbout(tester);
    expect(find.text(settingsAboutSection), findsOneWidget);
    expect(find.text('关于'), findsOneWidget);
    expect(find.text(aboutEntryHint), findsOneWidget);
    final icon = tester.widget<Icon>(find.byIcon(Icons.logout));
    expect(icon.color, d.accent, reason: '这一条才是真该醒目的');
  });

  testWidgets('⑧ 分区标题是"黑 + 加粗"，**不是**强调色（那看着像警告）', (tester) async {
    await pump(tester);
    await scrollToAbout(tester);
    final title = tester.widget<Text>(find.text(settingsAboutSection));
    expect(title.style?.color, d.ink, reason: '分区名要稳 —— 红色的意思留给"退出登录"这类事');
    expect(title.style?.color, isNot(d.accent));
    expect(title.style?.fontWeight, FontWeight.w600);
  });

  testWidgets('已经填过的那一屏说"已经有了"（而且提交按钮变成"换好了"）', (tester) async {
    await pump(tester, creds: const SpaceCreds(image: true));
    await goTab(tester, credTabImage);
    expect(find.text(credStateLine(tab: credTabImage, has: true, bad: false)), findsOneWidget);
    expect(find.text(keySubmitChange), findsOneWidget);
    // 负向对照：没填过的那一屏说的是"还没有填"
    await goTab(tester, credTabVideo);
    expect(find.text(credStateLine(tab: credTabVideo, has: false, bad: false)), findsOneWidget);
    expect(find.text(keySubmit), findsOneWidget);
  });

  testWidgets('放大到 2.0 倍也不溢出（D3.5 那一族的形状）', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(textScaler: TextScaler.linear(2.0)),
          child: Scaffold(
            body: SettingsScreen(
              hasKey: false,
              keyBad: false,
              localOnly: true,
              onSubmit: (k) async => KeySend.ok,
              onSubmitCreds: (t, v) async => KeySend.ok,
              onLogout: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
