// **输入条上那个发送钮的新形态**（主人 2026-09-24 拍板 · `docs/dev/75-CHAT-ROW.md`）。
//
// 主人原话：*"聊天框右侧应该是一个发送按钮。一开始是灰色的。"*
//
// 🔴 这一条**推翻了 2026-09-23 那个"有字才画"**（那也是主人拍的板，见
//    `docs/dev/64-CHAT-REDESIGN.md` §五）——
//    ⇒ 现在它**一直在**：没字（或只有空格）时是**灰的、按不动**，有字时亮起来。
//    ⇒ 但**"位置与宽度固定"这条老规矩照旧**，而且比原来更要紧：
//       它要是随字出现/消失而撑开收窄，输入框会被挤得跳（D4.8 那种"界面自己抖"）。
//
// ⚠️ `test/widget`（**提示档**）—— 当闸的是"五档不溢出 + 命中区 ≥44"（`accessibility_test.dart`，硬闸）。
//    但**"灰的按不动 / 有字就能按"这件事只有这里能钉**（a11y 闸不关心某个按钮的状态）。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/widgets/composer.dart';

Future<void> _pump(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: Composer(onSend: (_) {})),
    ),
  );
  await tester.pump();
}

/// 输入框左边那一端的 x / 宽度（用来验"发送钮亮没亮**没把输入框挤动**"）。
double _fieldLeft(WidgetTester tester) =>
    tester.getTopLeft(find.byType(TextField)).dx;
double _fieldWidth(WidgetTester tester) =>
    tester.getSize(find.byType(TextField)).width;

/// 🔴 **那条真缺陷的结构级判据**（2026-09-29 主人报"文字已经写好了，但是无法发送"）。
///
/// **根因**：发送钮原来住在 `TextField` 的 `suffixIcon` 里。**网页上点不到** ——
/// Flutter web 的输入法那一层是**真的 `<textarea>`**，位置正好是**整个 `TextField` 的矩形**
/// （线上 1280 宽实测：发送钮 `[900,554,52×36]`、那个 textarea `[328,550,630×50]` —— 整个盖住，
/// `document.elementFromPoint(按钮中心)` 回的是 `TEXTAREA`）。
/// ⚠️ 手机上**没有**那层 DOM ⇒ 同一份代码在安卓上是好的；widget 判据里也没有那层 DOM
/// ⇒ **只有这条"结构"判据钉得住它**（别再把它放回 `TextField` 里面）。
void expectButtonsOutsideField(WidgetTester tester) {
  expect(
    find.descendant(of: find.byType(TextField), matching: find.byKey(chatSendKey)),
    findsNothing,
    reason: '★ 发送钮回到 `TextField` 里面了 —— 网页上它会被输入法那层 DOM 盖住、点不到',
  );
  expect(find.byKey(chatMessageBoxKey), findsOneWidget, reason: '消息框那层容器不在了');
  expect(
    find.descendant(of: find.byKey(chatMessageBoxKey), matching: find.byKey(chatSendKey)),
    findsOneWidget,
    reason: '发送钮**还在消息框里**（主人 2026-09-29：*"发送按钮在消息框里面。"*）',
  );
}

/// **发送钮此刻按不按得动**（灰 = `onPressed == null`）。
/// ⚠️ 它**一直在**（在消息框里面）：没话要说时是**灰的**，不是"不见了"。
bool _sendReady(WidgetTester tester) =>
    tester.widget<FilledButton>(find.byKey(chatSendKey)).onPressed != null;

void main() {
  testWidgets('🔴 录音那颗**一直在最右**；「发送」**在消息框里面**（2026-09-29 主人更正）', (tester) async {
    await _pump(tester);
    // 录音那颗：**一点都不能少**（主人原话："录音按钮一直在右侧"）
    expect(find.byKey(chatMicButtonKey), findsOneWidget, reason: '★ 最右该一直是录音');
    // 发送：在**框里**（是那个 `TextField` 的后代），而且一开始就在（灰的）
    expect(find.byKey(chatSendKey), findsOneWidget, reason: '★ 发送该一直在框里（一开始是灰的）');
    // 🔴 结构：**在消息框里**，但**不在输入框里**（后者在网页上点不到 —— 见上面那段）
    expectButtonsOutsideField(tester);
    expect(_sendReady(tester), false, reason: '★ 一开始是灰的、按不动');

    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    expect(_sendReady(tester), true, reason: '有字了 ⇒ 能按');
    // 负向对照：**录音那颗照旧在**（上一版这里被"替换"掉了 —— 那是读错了他的意思）
    expect(find.byKey(chatMicButtonKey), findsOneWidget, reason: '★ 有字也不能把录音那颗顶掉');

    // 打的全是空格 ⇒ **也不算**有话要说（发送要 trim 过）
    await tester.enterText(find.byType(TextField), '   ');
    await tester.pump();
    expect(_sendReady(tester), false, reason: '★ 只有空格不算有话要说');
  });

  testWidgets('🔴 它亮/灰的切换，输入框**一个像素都不许动**（同 D4.8 那种病）', (tester) async {
    // ⚠️ 为什么单钉这条：发送钮的状态一变就撑开/收窄的话，输入框会跟着跳 ——
    //    那是**界面自己抖**，用户正在打字时会很难受。
    //    （2026-09-24 之前它还会"一会儿有一会儿没有"，那条判据原来钉的是"出现/消失"。）
    await _pump(tester);
    final left0 = _fieldLeft(tester);
    final width0 = _fieldWidth(tester);

    await tester.enterText(find.byType(TextField), '在吗');
    await tester.pump();
    expect(_sendReady(tester), true);
    expect(_fieldLeft(tester), left0, reason: '★ 输入框左边不许动');
    expect(_fieldWidth(tester), width0, reason: '★ 输入框宽度不许动');

    // 发出去（框清空）⇒ 发送**变灰**（它还在框里 —— 是灰的，不是没了）
    await tester.tap(find.text(sendWords));
    await tester.pump();
    expect(_sendReady(tester), false, reason: '发完框空了 ⇒ 它该变灰');
    expect(find.byKey(chatSendKey), findsOneWidget, reason: '★ 变灰 ≠ 消失（位置要固定）');
    expect(_fieldLeft(tester), left0, reason: '★ 变灰的时候输入框左边动了');
    expect(_fieldWidth(tester), width0, reason: '★ 变灰的时候输入框宽度动了');
    expect(_fieldLeft(tester), left0, reason: '★ 变灰也不许把输入框挤动');
    expect(_fieldWidth(tester), width0);
  });
}
