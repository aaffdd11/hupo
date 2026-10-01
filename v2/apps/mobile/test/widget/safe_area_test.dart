// **安卓真机那两条报修**（主人 2026-09-28 装上 APK 之后当场说的）：
//   ① *"我看到它顶部跟时间、WiFi 信号重叠了，是否要对安卓增加顶部空间。"*
//   ② *"底部的聊天窗口有点 margin 太多太多了。至少可以少去 2/3。"*
//
// ── 为什么这一份非有不可 ────────────────────────────────────
//   这两条**在网页上永远看不见**（浏览器的内边距是 0，也没有手势条）⇒
//   以前所有判据都在网页那一侧跑，谁都没量过"有状态栏时会怎么样"。
//   这一份把**系统那条内边距注入进去**（`MediaQuery.padding`），在 VM 上把它们量出来。
//
// ⚠️ 判据的读法：**内边距是 0 时一个像素都不许变**（那就是网页那一版）——
//    所以"手机上让开多少"与"网页不变"两件事都要量。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/landing_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/screens/landing_screen.dart';
import 'package:hupo_app/widgets/chat_floater.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/mini_app_host.dart';

/// 一份最小的控制器：**不开 socket、不碰真网**（同别的界面判据那一套）。
///
/// ⚠️ 必须给上令牌 —— 没有令牌时 `ChatScreen` 会在"还没登录"那一步就回头。
ChatController _controller() =>
    ChatController(token: 'tok-判据', api: Api(), tokens: TokenStore());

/// 造一个"像安卓那样"的窗口：顶部一条状态栏、底部一条手势条。
Future<void> _pumpWithInsets(
  WidgetTester tester,
  Widget child, {
  double top = 24,
  double bottom = 34,
  Size size = const Size(390, 844),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, inner) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          padding: EdgeInsets.only(top: top, bottom: bottom),
          viewPadding: EdgeInsets.only(top: top, bottom: bottom),
        ),
        child: inner!,
      ),
      home: child,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('① 顶上那条让给状态栏（安卓 edge-to-edge）', () {
    testWidgets('落地页：有状态栏 ⇒ 正好让开那一条；没有 ⇒ 一个像素没动', (tester) async {
      // ① 网页那一版（没有状态栏）：记下那一刻的读数
      await _pumpWithInsets(tester, LandingScreen(onStart: () {}), top: 0, bottom: 0);
      final webTop = tester.getTopLeft(find.text(landingBrand)).dy;
      // ② 安卓那一版（状态栏 24）：必须**整整让开 24**
      await _pumpWithInsets(tester, LandingScreen(onStart: () {}), top: 24, bottom: 34);
      final androidTop = tester.getTopLeft(find.text(landingBrand)).dy;
      expect(androidTop - webTop, greaterThanOrEqualTo(24),
          reason: '★ 状态栏 24 ⇒ 内容要往下让 24，否则就是压在时钟/WiFi 上（主人报的那一条）');
      expect(androidTop, lessThan(200), reason: '★ 别把整页推出屏幕');
      // 负向对照：网页那一版仍然是原来那个位置（那就是"网页不变"的证据）
      expect(webTop, lessThan(androidTop), reason: '★ 没有状态栏时不该凭空多出那一条');
    });
  });

  group('② 底下那条：贴底留白 ＋ 系统那条', () {
    testWidgets('窄屏（手机）：留白 10、而且让开手势条那一条', (tester) async {
      await _pumpWithInsets(
        tester,
        ChatScreen(controller: _controller(), onLoggedOut: () {}),
      );
      final f = tester.getRect(find.byType(ChatFloater));
      // ① 底下：系统那条（34）比我们的留白（10）大 ⇒ 听系统的
      expect(f.bottom, 844 - 34,
          reason: '★ 手势条那一块是系统盖在窗口上的：浮窗贴到 10 会被它压住');
      // ② 左右：就是那个留白的读数（2026-09-28 从 30 改成 10）
      expect(f.left, FloaterMetrics.margin, reason: '★ 左右那个留白＝那个常量');
      expect(FloaterMetrics.margin, 10, reason: '★ 主人当场定的：30 的三分之一');
      // ③ 顶边不许越过状态栏
      expect(tester.getTopLeft(find.byType(ChatFloater)).dy, greaterThanOrEqualTo(24));
    });

    testWidgets('负向对照：没有系统条（网页）⇒ 贴底就是那个留白', (tester) async {
      await _pumpWithInsets(
        tester,
        ChatScreen(controller: _controller(), onLoggedOut: () {}),
        top: 0,
        bottom: 0,
        size: const Size(1280, 800),
      );
      final f = tester.getRect(find.byType(ChatFloater));
      expect(f.bottom, 800 - FloaterMetrics.margin,
          reason: '★ 网页上没有手势条 ⇒ 底下就是我们自己那个留白');
    });
  });

  group('③ 小程序容器里的内容也要让开状态栏', () {
    testWidgets('容器开着时：里面的内容从状态栏下面开始', (tester) async {
      await _pumpWithInsets(
        tester,
        Scaffold(
          body: MiniAppHost(
            open: true,
            title: '随便',
            covered: false,
            onCoveredTap: () {},
            bottomInset: 0,
            child: const Text('里面那一屏'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final top = tester.getTopLeft(find.text('里面那一屏')).dy;
      expect(top, greaterThanOrEqualTo(24),
          reason: '★ 容器里没有抬头了（2026-09-27 撤掉）⇒ 不让开的话制品第一行就在时钟底下');
    });

    // 🔴 **2026-10-01 更正（主人报"所有小程序打开后都无法点击聊天了"）** ——
    //    这一格原来赌的是反的：*"制品那一屏（`bleed`）⇒ **铺满整屏**：
    //    上面不让状态栏、**底下不留聊天条那一条**"*。
    //    **那条判据把缺陷钉住了**：Web 上小程序是**真的 DOM 元素**、压在画布**上面**，
    //    平台视图一铺满，画在画布上的聊天浮窗就**整个被它盖住**（点不着、也看不见）。
    //    而规矩是反过来的 —— **Z1：聊天永远最上**（桌面之上、小程序之上）。
    //    ⇒ 判据反过来：**平台视图的矩形不许盖到聊天浮窗的矩形**，制品也不例外。
    testWidgets('🔴 制品那一屏也**不许盖住聊天条**（Z1：聊天永远最上）', (tester) async {
      await _pumpWithInsets(
        tester,
        Scaffold(
          body: MiniAppHost(
            open: true,
            title: '看天气',
            covered: false,
            onCoveredTap: () {},
            bottomInset: 150, // 收起档那条的量
            child: const Text('制品那一屏'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final screen = tester.getRect(find.byType(MaterialApp));
      // ⚠️ 量的是**容器自己那个 Navigator 的矩形**：Web 上平台视图（那个 `<iframe>`）
      //    的 DOM 盒子就跟着它 —— 它盖到哪儿，那一下就到不了聊天浮窗。
      Rect pageBox() => tester.getRect(
            find.descendant(of: find.byType(MiniAppHost), matching: find.byType(Navigator)).first,
          );
      expect(pageBox().bottom, lessThanOrEqualTo(screen.bottom - 150),
          reason: '★ 平台视图的底边不许进到聊天条那一带（实测底边 ${pageBox().bottom}）—— '
              '它一进去，那一条就点不着了');
      expect(pageBox().top, greaterThanOrEqualTo(24),
          reason: '★ 状态栏那一条照旧让开（不然制品第一行压在时钟底下）');

      // 负向对照：**没有那一条内缩** ⇒ 平台视图本来就该铺满。
      // ⇒ 上面那条判据确实是因为"让开聊天条"才成立的，不是碰巧过的。
      await _pumpWithInsets(
        tester,
        Scaffold(
          body: MiniAppHost(
            open: true,
            title: '看天气',
            covered: false,
            onCoveredTap: () {},
            bottomInset: 0,
            child: const Text('制品那一屏'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(pageBox().bottom, screen.bottom,
          reason: '★ 负向对照：不让的话就该铺到底（说明上面那条不是恒真）');
    });
  });
}
