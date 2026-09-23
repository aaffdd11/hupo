// **老消息往上翻**那条 UI（批 C · `docs/dev/64-CHAT-REDESIGN.md` §三）。
//
// 钉两件（都是"没画出来就等于没做"）：
//   ① 用户往上翻走之后，**「回到最新」那颗按钮真的出现**；点一下 ⇒ 消失（他回到最新了）
//   ② 那颗按钮**有字**、命中区 ≥44（D3.6/D3.8）—— 可访问性硬闸也会扫它，这里是就近一眼

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/chat_floater.dart';

ChatController _controller() => ChatController(
  api: Api(base: 'http://127.0.0.1:1'),
  tokens: TokenStore(),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  SharedPreferences.setMockInitialValues(<String, Object>{});

  testWidgets('🔴 往上翻走 ⇒ 「回到最新」出现；点它 ⇒ 消失', (tester) async {
    final c = _controller();
    // 塞满一屏（不然那条列表根本滚不动，"翻走"这件事发生不了）
    for (var i = 1; i <= 40; i += 1) {
      c.ingest({
        'type': 'user/echo',
        'seq': i,
        'messageId': 'm$i',
        'text': '第 $i 句',
        'at': 1700000000000 + i * 1000,
      });
    }
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(
          // ⚠️ **必须展开着进场**：收起态只画"抓手行 + 输入条"（§6.2），
          //    时间线**根本不画** ⇒ 拿不到 ListView（第一版就是这么空手而归的）。
          initialTier: FloaterTier.full,
          controller: c,
          onLoggedOut: () {},
          space: const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true),
          onSendKey: (_) async => KeySend.ok,
        ),
      ),
    );
    await tester.pump();

    expect(
      find.text(backToLatestWords),
      findsNothing,
      reason: '刚打开时就在最新 ⇒ 不该有那颗按钮',
    );

    // 往上翻（手指往下拖 = 看更早的）
    // ⚠️ **别用 `tester.drag(find.byType(ListView))`**：它按那个 widget 的**中心**落点，
    //    而列表中心被**底部那条聊天浮窗**盖着 ⇒ 那一下根本没落到列表上（第一版就这么栽的）。
    //    ⇒ 从列表**上部**一个明确在浮窗之外的点拖。
    final listTop = tester.getTopLeft(find.byType(ListView));
    await tester.dragFrom(
      listTop + const Offset(120, 40),
      const Offset(0, 400),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      find.text(backToLatestWords),
      findsOneWidget,
      reason: '★ 他翻走了 ⇒ 得有回去的路',
    );

    // 命中区 ≥44（D3.6）
    // ⚠️ 用 `ButtonStyleButton`（`FilledButton` 的基类）找：`FilledButton.tonalIcon`
    //    建出来的那个是它的子类，按具体类型找会**扑空**（第一版就这么扑的）。
    // ⚠️ **`find.byType` 只认精确的运行时类型** ⇒ 拿基类 `ButtonStyleButton` 去找
    //    一个 `FilledButton` 是找不到的（第一版就是 0 个）。要用**谓词**（`is` 认子类）。
    final btn = find
        .ancestor(
          of: find.text(backToLatestWords),
          matching: find.byWidgetPredicate((w) => w is ButtonStyleButton),
        )
        .first;
    final size = tester.getSize(btn);
    expect(size.height >= 44, true, reason: '命中区要 ≥44（实测 ${size.height}）');

    await tester.tap(find.text(backToLatestWords));
    await tester.pump();
    expect(find.text(backToLatestWords), findsNothing, reason: '点了就回到最新 ⇒ 收起');
  });
}
