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
//   ④ 语音那一页是**两样**（★ 2026-10-01 换成豆包：App ID ＋ Access Token，两样齐了才算有）；
//      图片/视频是一串 —— ⚠️ 而且**是同一把**（见 ⑨）
//   ⑤ 提交**一次把那一页写完**（语音两样不许分两次写）
//   ⑨ 🔴 **视频那一页不许再说"这条路不做"**（2026-10-01 它已经做完上线了；
//      那句老话是**页面在说假话**）⇒ 要说清"跟图片同一把钥匙"＋"慢、贵"（本文件最后一条）
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
  bool voiceReady = false,
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
          // ★ 语音那屏的边界句分档靠它（见 `SpaceInfo.voiceReady`）
          voiceReady: voiceReady,
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

  testWidgets('③ 🔴 每一屏**只说"填什么"＋"有没有"**，没有别的废话', (tester) async {
    // 主人 2026-10-01：*"设置这里不要写人看不懂的东西……就直白一点填入什么就好了。"*
    // ⇒ 一屏就两行字：① 填什么（`credTabWhat`）② 有没有（`credStateLine`）。
    for (final tab in [credTabVoice, credTabImage, credTabVideo]) {
      await pump(tester);
      await goTab(tester, tab);
      // ① 那一句"填什么"必须在屏幕上
      expect(find.text(credTabWhat(tab)), findsOneWidget, reason: '$tab 那一屏少了"填什么"那句');
      // ② 状态那句也在
      expect(find.text(credStateLine(tab: tab, has: false, bad: false)), findsOneWidget);
      // 🔴 负向对照：以前那一套"边界话"里的字样**一个字都不许剩**
      for (final bad in ['收下了', '生效', '不再用这台机器', '先收着', '边界']) {
        expect(find.textContaining(bad), findsNothing, reason: '★ "$bad" 那套话应当已经删掉了');
      }
    }
    // 没填 ⇒ 状态说"还没有填"；填了 ⇒ 说"已经填了"（两档分得开）
    await goTab(tester, credTabVideo);
    expect(find.text(credStateLine(tab: credTabVideo, has: false, bad: false)), findsOneWidget);
  });

  testWidgets('④ 语音那一屏是**两样**（豆包：App ID ＋ Access Token）；图片/视频各一串', (tester) async {
    await pump(tester);
    await goTab(tester, credTabVoice);
    expect(find.byType(CredForm), findsOneWidget);
    for (final label in [credVoiceAppIdLabel, credVoiceTokenLabel]) {
      expect(find.text(label), findsOneWidget, reason: '语音少了这一项：$label');
    }
    expect(tester.widget<CredForm>(find.byType(CredForm)).fields.length, 2);

    await goTab(tester, credTabImage);
    expect(tester.widget<CredForm>(find.byType(CredForm)).fields.length, 1);
    await goTab(tester, credTabVideo);
    expect(tester.widget<CredForm>(find.byType(CredForm)).fields.length, 1);
    // 老表单只在聊天那一屏
    await goTab(tester, credTabChat);
    expect(find.byType(KeyForm), findsOneWidget);
    expect(find.byType(CredForm), findsNothing);
  });

  testWidgets('⑤ 🔴 提交**一次把那一屏写完**（语音两样一起送）', (tester) async {
    final sent = await pump(tester);
    await goTab(tester, credTabVoice);
    final boxes = find.byType(TextField);
    expect(boxes, findsNWidgets(2));
    await tester.enterText(boxes.at(0), '1300000001');
    await tester.enterText(boxes.at(1), 'access-token-x');
    await tester.tap(find.text(keySubmit));
    await tester.pumpAndSettle();

    expect(sent.n, 1, reason: '★ 只许提交一次（两样必须一起写下去，不许分两次）');
    expect(sent.tab, credTabVoice);
    expect(sent.values, {
      'voiceAppId': '1300000001',
      'voiceAccessToken': 'access-token-x',
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

  testWidgets('⑨ 🔴 视频那一页：直说**不用填**（跟图片同一个 API Key），不许再说"不做"', (tester) async {
    await pump(tester);
    await goTab(tester, credTabVideo);
    final line = credTabWhat(credTabVideo);
    expect(find.text(line), findsOneWidget);
    expect(line.contains('不用填'), true, reason: '视频那屏应当直说"不用填"：$line');
    expect(line.contains('图片'), true, reason: '要说清跟哪一屏共用：$line');
    // 🔴 负向对照（这条就是当初抓到的缺陷）：**不许**有"不做"
    expect(line.contains('不做'), false, reason: '视频早就做完上线了，说"不做"就是页面在说假话');
    expect(find.textContaining('不做'), findsNothing);
  });
}
