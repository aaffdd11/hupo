// **浮窗头部那一排动作**（主人 2026-09-23：*"先整理整个UI"* 的第二块）· 契约 `docs/dev/72-UI-PASS.md`。
//
// 这一份钉三件（都是"手机上看不看得懂"）：
//   ① 🔴 右侧那一颗**必须有中文**（原来只有图标 + tooltip，而手机上没法 hover ⇒ 只能瞎点）
//   ② 标题**比原来大**（`titleSmall` → `titleMedium`：它是这一屏的名字）
//   ③ 「读一遍」的字跟着变大（原来 `bodySmall`）且命中区 ≥44（D3.6）

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/landing_words.dart';
import 'package:hupo_app/models/speak_words.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/bubbles.dart';
import 'package:hupo_app/widgets/chat_floater.dart';

ChatController _controller() =>
    ChatController(api: Api(base: 'http://127.0.0.1:1'), tokens: TokenStore());

Future<void> _pump(WidgetTester tester, {FloaterTier tier = FloaterTier.full}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        initialTier: tier,
        controller: _controller(),
        onLoggedOut: () {},
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('★ 展开态右侧那颗**带字**：就写「收起聊天」', (tester) async {
    await _pump(tester);
    // 🔴 2026-10-03：原来这儿钉的是"回收站/导出/过程三颗都要有中文"。
    //    主人当天说那三样不要了，右侧改成**一颗带字的收起按钮**
    //    （原话：*"让收起聊天变成右侧的一个按钮，就叫收起聊天。"*）。
    expect(
      find.text(chatCollapse),
      findsWidgets,
      reason: '右侧那颗要有字 —— 手机上没法 hover，光一个箭头没人敢点',
    );
    expect(find.byKey(chatCollapseKey), findsOneWidget, reason: '那颗按钮不在树里');
  });

  testWidgets('★ 标题比原来大：>= 16（它是这一屏的名字）', (tester) async {
    await _pump(tester);
    final title = tester.widget<Text>(find.text(appName));
    expect(
      title.style?.fontSize,
      greaterThanOrEqualTo(16),
      reason: 'titleSmall(≈14) 和旁边那排图标一样大，主次不分',
    );
  });

  testWidgets('★ 右侧那颗「收起聊天」的命中区 ≥44（D3.6）', (tester) async {
    await _pump(tester);
    final size = tester.getSize(find.byKey(chatCollapseKey));
    expect(size.height, greaterThanOrEqualTo(44), reason: '「$chatCollapse」太矮了点不准');
    expect(size.width, greaterThanOrEqualTo(44), reason: '「$chatCollapse」太窄了点不准');
  });

  testWidgets('★ 「读一遍」的字跟着变大（>= 14）且命中区 ≥44', (tester) async {
    final m = AssistantMessage(messageId: 'm1', seq: 1)
      ..quick = '北京今天多云。'
      ..ended = true
      ..reason = 'completed';
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: AnswerBubble(message: m, onSpeak: () {}),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final label = tester.widget<Text>(find.text(speakOnceWords));
    expect(
      label.style?.fontSize,
      greaterThanOrEqualTo(14),
      reason: '原来 bodySmall(≈12) —— 又小又淡，主人自己都点不出来',
    );
    final size = tester.getSize(
      find
          .ancestor(
            of: find.text(speakOnceWords),
            matching: find.byWidgetPredicate((w) => w is TextButton),
          )
          .first,
    );
    expect(size.height, greaterThanOrEqualTo(44));
  });
}
