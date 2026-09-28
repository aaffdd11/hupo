// **「配置」页**（主人 2026-09-24 定的四样钥匙 ＋ 2026-09-29 改成的**一列分类**）
// · 契约 `docs/dev/79-CREDS-TABS.md` · `docs/dev/131-WALLPAPER.md`。
//
// 主人原话：*"配置页用来配置模型，语言大模型apikey，语音大模型，图片生成，视频生成。"*
// 2026-09-29 又定：*"现在帮我分类，选项有模型设置，点开才是设置模型。
//   其他的也是列表中来做配置。包括壁纸。"*
//
// 这一份钉的是**形状与话**（`72-UI-PASS.md` 那几条继续有效）：
//   ① 顶层是**一列分类**（九个名目都在），点开才是它自己的配置
//   ② 🔴 **每一页都要说清"这一样管什么"**
//   ③ 🔴 **图片/视频/语音那一页必须说清"收下了 ≠ 现在就生效"**（P1-1 的边界句）
//   ④ 语音那一页是**三样**（三样齐了才算有）；图片/视频是一串
//   ⑤ 提交**一次把那一页写完**（语音三样不许分三次写）
//   ⑥ `localOnly`（主人自己那一份）**也能填**（2026-09-24 他选的那一档）
//   ⑦ 关于 / 退出登录 / 注销账号各是一条；退出登录那一条**仍然是红的**
//   ⑧ 子页左上角有「回到设置」，点了真的回到那一列

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/models/key_outcome.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/widgets/cred_form.dart';
import 'package:hupo_app/widgets/key_form.dart';
import 'package:hupo_app/widgets/wallpaper_picker.dart';

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
  bool canCancel = false,
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
          // ⚠️ 注销账号那一条**只有接线了才画**（"不给假按钮"那条纪律）
          //    ⇒ 判据两档都要看：接线了在、没接线不在。
          onCancel: canCancel ? () async => CancelOutcome.ok : null,
          onCancelled: canCancel ? () {} : null,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return sent;
}

/// 切到某一页（像用户那样：**先点那个名目**）。
///
/// ⚠️ 2026-09-29：顶层不再有 tab —— 是一列分类，**点开才是它自己的配置**。
///    所以这个助手要先看"子页开着没有"（左上角那行「回到设置」）：开着就先退回来
///    —— 判据连着走几页时，用户也是这么走的。
/// ⚠️ 四项钥匙里**第一项的名字不是 `credTabChat`**（顶层叫「模型设置」，
///    那一页里的字照旧）—— 映射只在这一处。
Future<void> goTab(WidgetTester tester, String tab) async {
  final back = find.text(settingsBack);
  if (back.evaluate().isNotEmpty) {
    await tester.tap(back);
    await tester.pumpAndSettle();
  }
  await tester.tap(find.text(tab == credTabChat ? settingsRowModel : tab));
  await tester.pumpAndSettle();
}

/// **像用户那样滚到顶层那一列的某一行**（窄屏 / 大字号下它在折叠线以下）。
///
/// ⚠️ `ListView` **不会把屏幕外的孩子建出来** ⇒ 不滚的话 `find.text` 一个都找不到
///    （这正是"用户得滚一下才看得见"）。⚠️ 指名道姓到**顶层那一列**
///    （`settingsListKey`）：子页里各自也有 `Scrollable`，靠 `.first` 会滚错东西。
Future<void> scrollToRow(WidgetTester tester, String label) async {
  await tester.scrollUntilVisible(
    find.text(label),
    240,
    scrollable: find
        .descendant(
          of: find.byKey(settingsListKey),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('① 顶层是**一列分类**：四把钥匙分开 ＋ 壁纸 ＋ 这块窗口 ＋ 关于那三件', (tester) async {
    await pump(tester, canCancel: true);
    // ⚠️ 名目的顺序就是主人 2026-09-29 当场定的那样（四把钥匙分开、壁纸跟在后面）。
    for (final row in [
      settingsRowModel,
      credTabVoice,
      credTabImage,
      credTabVideo,
      settingsRowWallpaper,
      settingsAppearanceSection,
      aboutEntryTitle,
      settingsLogout,
      settingsCancelAccount,
    ]) {
      await scrollToRow(tester, row);
      expect(find.text(row), findsOneWidget, reason: '顶层少了这一项：$row');
    }
    // 🔴 **负向对照：顶层只是"名目"** —— 子页里那些话一句都不许出现在这一列上
    //    （主人要"点开才是设置模型"）。没这一条的话，"分类"可能只是换了个样子，
    //    实际还是把每一页的正文全堆在一屏里。
    expect(find.text(credTabWhat(credTabChat)), findsNothing,
        reason: '★ 顶层把子页的正文也摆出来了 ⇒ 那不是"点开才是配置"');
    expect(find.byType(WallpaperPicker), findsNothing);
  });

  testWidgets('①·补 子页左上角那一行「回到设置」**真的回得去**', (tester) async {
    await pump(tester);
    await goTab(tester, credTabVoice);
    expect(find.text(settingsBack), findsOneWidget, reason: '子页少了回程那一行');
    // 负向对照：**真到了子页**（不是还停在列表上）
    expect(find.text(credTabWhat(credTabVoice)), findsOneWidget);
    await tester.tap(find.text(settingsBack));
    await tester.pumpAndSettle();
    expect(find.text(credTabWhat(credTabVoice)), findsNothing, reason: '★ 没回去');
    expect(find.text(settingsRowModel), findsOneWidget, reason: '★ 回到的不是那一列');
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
    // ⚠️ 2026-09-29：顶层是名目 ⇒ 表单在「模型设置」那一页里（判据走真路径点进去）
    await goTab(tester, credTabChat);
    // ⚠️ 2026-09-24 改口径：他选了"要真能改" ⇒ 这一页**有**表单
    expect(find.byType(KeyForm), findsOneWidget, reason: '他自己那一份现在也能在这页换钥匙');
    expect(find.text(configLocalOnly), findsOneWidget);
    expect(configLocalOnly.contains('本机'), true);
  });

  testWidgets('⑦ 关于 / 退出登录 / 注销账号都在；退出登录那一条**仍然是红的**', (tester) async {
    await pump(tester, canCancel: true);
    await scrollToRow(tester, aboutEntryTitle);
    expect(find.text(aboutEntryHint), findsOneWidget);
    await scrollToRow(tester, settingsLogout);
    expect(find.text(settingsLogoutHint), findsOneWidget);
    final icon = tester.widget<Icon>(find.byIcon(Icons.logout));
    expect(icon.color, d.accent, reason: '这一条才是真该醒目的');
    // 注销账号那一格：图标也是红的（不可逆那件事不许画得跟普通项一样）
    await scrollToRow(tester, settingsCancelAccount);
    expect(find.text(settingsCancelAccountHint), findsOneWidget);
    final del = tester.widget<Icon>(find.byIcon(Icons.delete_outline));
    expect(del.color, d.accent);
  });

  testWidgets('⑦·补 没接线 ⇒ **不画**「注销账号」那一条（不给假入口）', (tester) async {
    await pump(tester); // 默认不接线
    expect(find.text(settingsCancelAccount), findsNothing,
        reason: '★ 这条路没接上，就不许摆一个点了没用的入口');
  });

  testWidgets('⑧ 🔴 注销账号那一页：**先把会没掉什么写在页面上**，再是那颗按钮', (tester) async {
    // 依据：手册 X3 ② —— **先说清删什么，再动手**；而且这句话不许只藏在确认框里
    //（藏起来的话，用户是"点开这一页才知道"，而在这一页上他还没做任何决定）。
    await pump(tester, canCancel: true);
    await scrollToRow(tester, settingsCancelAccount);
    await tester.tap(find.text(settingsCancelAccount));
    await tester.pumpAndSettle();
    expect(find.text(keyCancelWhat), findsOneWidget, reason: '★ 这一页没把"会没掉什么"说出来');
    expect(find.text(keyCancelEntry), findsNothing,
        reason: '★ 独立那一页上写的是「注销账号」，不是表单底下那一条小字');
    await tester.tap(find.text(settingsCancelAccount).last);
    await tester.pumpAndSettle();
    // 点下去**先弹确认框**（这两句就是那个框，缺一句都算"没先问"）
    expect(find.text(keyCancelTitle), findsOneWidget);
    expect(find.text(keyCancelWhat), findsWidgets);
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
