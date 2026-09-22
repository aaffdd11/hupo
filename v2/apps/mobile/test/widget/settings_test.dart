// **「配置」那一屏**（契约 `docs/dev/48-SETTINGS-KEY.md`）。
//
// 主人 2026-09-22：*"用户可以在页面唤起配置。配置上可以输入 apikey"*。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 顶栏**真的**有那个入口（而且没给回调时不显示 —— 老测试不受影响）；
//   ② 🔴 **现状如实**：三种状态（有 / 没填过 / 填过但被判无效）说的话**不一样**——
//      "填过但被拒"的人**不许**被告知"还没有填"；
//   ③ 交钥匙走的是**同一条路**（`onSendKey`），换成功之后叫一声 `onKeyChanged`；
//   ④ **「关于」能从配置里进去**（它从顶栏搬进来了）；
//   ⑤ 每一句都过禁用词表（界面词表是硬闸）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/settings_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';

ChatController _controller() => ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

Future<void> _pumpChat(
  WidgetTester tester, {
  required bool hasKey,
  required bool keyBad,
  required Future<KeySend> Function(String) onSendKey,
  VoidCallback? onKeyChanged,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      // ⚠️ **默认收起档 = 真实路径**：桌面看得见、点得到「设置」。
      //    传 `full` 的话浮窗把桌面盖住，点图标会点到浮窗上（2026-09-22 实测）。
      home: ChatScreen(
        controller: _controller(),
        onLoggedOut: () {},
        space: SpaceInfo(kind: 'tenant', state: 'ready', hasKey: hasKey, keyBad: keyBad),
        onSendKey: onSendKey,
        onKeyChanged: onKeyChanged,
      ),
    ),
  );
  await tester.pump();
}

Future<void> _pumpSettings(
  WidgetTester tester, {
  required bool hasKey,
  required bool keyBad,
  required Future<KeySend> Function(String) onSendKey,
  VoidCallback? onKeyChanged,
  bool localOnly = false,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: SettingsScreen(
        hasKey: hasKey,
        keyBad: keyBad,
        localOnly: localOnly,
        onSubmit: onSendKey,
        onKeyChanged: onKeyChanged,
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('桌面那个「设置」入口在（没接上回调时**不在** —— 老测试不受影响）', (tester) async {
    // ⚠️ **入口变了**（主人 2026-09-22）：设置从聊天抓手行搬到了**桌面上那个小程序**。
    //    ⇒ 这里也走真实路径（默认收起档 ⇒ 桌面看得见、点得到）。
    await _pumpChat(tester, hasKey: false, keyBad: false, onSendKey: (_) async => KeySend.ok);
    expect(find.text(settingsAppLabel), findsOneWidget);

    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(controller: _controller(), onLoggedOut: () {})),
    );
    await tester.pump();
    expect(find.text(settingsAppLabel), findsNothing, reason: '没接上那条路就不该画一个按不动的入口');
  });

  testWidgets('🔴 三种现状说的话**不一样**（"填过但被拒"不许被告知"还没有填"）', (tester) async {
    await _pumpSettings(tester, hasKey: true, keyBad: false, onSendKey: (_) async => KeySend.ok);
    expect(find.text(keyStateHas), findsOneWidget);
    expect(find.text(configKeyHint), findsOneWidget, reason: '有一串时要说清"填了会换掉"');

    await _pumpSettings(tester, hasKey: false, keyBad: false, onSendKey: (_) async => KeySend.ok);
    expect(find.text(keyStateNone), findsOneWidget);

    await _pumpSettings(tester, hasKey: false, keyBad: true, onSendKey: (_) async => KeySend.ok);
    expect(find.text(keyStateBad), findsOneWidget);
    expect(find.text(keyStateNone), findsNothing, reason: '他填过 —— 说"还没有填"就是假话');
  });

  testWidgets('从页面唤起配置 ⇒ 填一把 ⇒ 交给同一条路，并叫一声"换好了"', (tester) async {
    final sent = <String>[];
    var changed = 0;
    await _pumpChat(
      tester,
      hasKey: true,
      keyBad: false,
      onSendKey: (k) async {
        sent.add(k);
        return KeySend.ok;
      },
      onKeyChanged: () => changed += 1,
    );

    // 真实路径：桌面上那个「设置」图标 ⇒ 小程序容器里打开设置
    await tester.tap(find.text(settingsAppLabel));
    await tester.pumpAndSettle();
    expect(find.text(configTitle), findsOneWidget, reason: '容器给的顶栏写着「配置」');

    await tester.enterText(find.byType(TextField), 'sk-new-key');
    await tester.tap(find.text(keySubmitChange));
    await tester.pumpAndSettle();

    expect(sent, ['sk-new-key'], reason: '走的就是第一次那条路（没有第二套）');
    expect(changed, 1, reason: '换成功要叫一声，让别处也跟着对');
    expect(find.text(configKeyChanged), findsOneWidget);
  });

  testWidgets('填得不对 ⇒ 逐条说清（而且**不算换成功**）', (tester) async {
    var changed = 0;
    await _pumpSettings(
      tester,
      hasKey: false,
      keyBad: false,
      onSendKey: (_) async => KeySend.blank,
      onKeyChanged: () => changed += 1,
    );
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(find.text(keyBlank), findsOneWidget);
    expect(changed, 0, reason: '没成功就不该叫那一声');
  });

  testWidgets('🔴 「关于」能从配置里进去（它从顶栏搬进来了）', (tester) async {
    await _pumpSettings(tester, hasKey: false, keyBad: false, onSendKey: (_) async => KeySend.ok);
    expect(find.text('关于'), findsOneWidget);
    await tester.tap(find.text('关于'));
    await tester.pumpAndSettle();
    // 关于页会把它自己那句话画出来（这一条只证"真的进去了"）
    expect(find.text(configTitle), findsNothing, reason: '已经从配置页跳走了');
  });

  testWidgets('🔴 "你自己这一份"（本机那种）⇒ **只说实话、不给假输入框**', (tester) async {
    // ⚠️ 主人自己那个号是跑在这台机器上的那一份：**没有容器、钥匙不在这条路上配**。
    //    原来配置页对他照样画一个输入框 + "还没有填" ⇒ 他填了会拿到
    //    "没送过去。是我这边的问题"（**指错方向**）。
    var sent = 0;
    await _pumpSettings(
      tester,
      hasKey: false,
      keyBad: false,
      localOnly: true,
      onSendKey: (_) async {
        sent += 1;
        return KeySend.ok;
      },
    );
    expect(find.text(configLocalOnly), findsOneWidget);
    expect(find.byType(TextField), findsNothing, reason: '不给一个填了会失败（而且说错话）的框');
    expect(find.text(keyStateNone), findsNothing, reason: '对他说"还没有填"也是假话');
    expect(sent, 0);
    // 「关于」照样在（它是配置里的一半）
    expect(find.text('关于'), findsOneWidget);
  });

  test('每一句都过禁用词表（界面词表是硬闸）', () {
    for (final s in [configEntry, configTitle, configKeySection, keyStateHas, keyStateNone, keyStateBad, configKeyHint, configKeyChanged, keySubmitChange, configLocalOnly]) {
      expect(hasForbidden(s), isFalse, reason: s);
    }
  });
}
