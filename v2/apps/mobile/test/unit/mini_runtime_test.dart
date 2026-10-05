// **沙箱运行时的选路**（乙-5 · 契约 `docs/dev/59-USER-APPS.md` §九 ·
//   2026-09-28 原生那一层落地：`docs/dev/129-NATIVE-ANDROID-BUILD.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **Android 有了、iOS 没有**：`kNativeMiniRuntime == true`、
//      `kNativeMiniRuntimeIOS == false` —— 后者是"iOS 商店版不发布小程序运行时"
//      那条合规约束（`08-SPEC.md` §4.2，Apple 4.7.4）**今天**的样子。
//   ② 🔴 **没装钩子 ⇒ 那句实话**（不许白屏）：VM / iOS / 测试环境都是这一档。
//   ③ 🔴 **装上钩子 ⇒ 走原生那一份**，而且 `releaseMiniAppView` 也会转给它
//      （不然换一版制品就多留一个 WebView）。
//   ④ 🔴 **条件导入只许对 `dart.library.html` 选 Web 实现**（源码级）：
//      写错一个条件，原生上就会去 import `dart:html` ⇒ 编译不过，
//      而那种错**只有真机打包时才会爆**。
//   ⑤ 🔴 **`webview_flutter` 只许从"原生那两份"进来**（源码级）：
//      它一旦进 Web 那条编译链，网页产物就白白变胖（那一份依赖原生平台通道）。
//   ⑥ **三份实现的签名必须一致**（不然换平台就编不过）。
//
// ⚠️ 为什么用"读源码"这种笨办法钉第 ④⑤ 条：条件导入的**选择**在 VM 上观察不到
//    （VM 永远走 stub 那一支）⇒ 只能把那一行本身钉住。

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/app_words.dart';
import 'package:hupo_app/models/mini_frame.dart';
import 'package:hupo_app/widgets/mini_runtime.dart';

/// 读一份源码并**剥掉 `//` 注释**。
///
/// ⚠️ 非剥不可：好几份文件的抬头正写着"不许 import `webview_flutter`"
///    （连这一条的说明本身都写着）⇒ 不剥的话判据会自己把自己判红
///    （`mini_sandbox_test.dart` 里那条"先剥注释"是同一个教训）。
String codeOf(String path) => File(path)
    .readAsStringSync()
    .split('\n')
    .map((l) => l.contains('//') ? l.substring(0, l.indexOf('//')) : l)
    .join('\n');

void main() {
  setUp(() {
    // 每一条都从"没装"开始（这一份自己装、自己收）。
    nativeMiniAppView = null;
    nativeMiniAppRelease = null;
  });

  tearDown(() {
    nativeMiniAppView = null;
    nativeMiniAppRelease = null;
  });

  test('🔴 Android 有了原生运行时；**iOS 仍然没有**（合规约束落在这一行）', () {
    expect(kNativeMiniRuntime, true, reason: '★ Android 那一侧 2026-09-28 落地了（WebView，不装桥）');
    expect(kNativeMiniRuntimeIOS, false,
        reason: '★ iOS 商店版不许有它（Apple 4.7.4）—— 要开它得主人单独拍板，不是顺手改的');
  });
  // ── 🔴 2026-09-30：**被盖住时，小程序那一层不许再收指针事件** ──────────
  //
  // 现场（主人报的）：*「打开小程序后，点击聊天窗口，聊天就卡死了……需要刷新才能恢复。」*
  // 真浏览器读数：小程序一开，`document.elementFromPoint()` 在**时间线区/小程序区/左上角**
  // 回的都是 `IFRAME` —— Web 上平台视图是**真的 DOM 元素**、盖在画布上面
  // ⇒ 画在画布上的聊天浮窗**一个事件都收不到**（"整个界面点了没反应"）。
  // 契约：`docs/dev/145-MINIAPP-EATS-POINTERS.md`。
  //
  // ⚠️ 这一条只能在**源码级**钉（VM 上走的是 stub，DOM 观察不到）——
  //    与这一份顶上那两条（④⑤）同一个道理。
  test('🔴 Web 那一份**真去改 `pointerEvents`**；别的两份是空操作（不许假装做了）', () {
    final web = codeOf('lib/widgets/mini_runtime_web.dart');
    expect(web.contains('pointerEvents'), isTrue, reason: '★ Web 那一份得真去改 DOM 的 pointer-events');
    expect(web.contains('setMiniAppsInteractive'), isTrue);
    // 它必须挂在**建 iframe 那一条路**上（新帧一建出来就该跟上当前那一档）
    expect(web.contains('_frames[viewId] = f'), isTrue, reason: '★ 新帧没记账 ⇒ 切档时它漏掉');
    for (final f in ['lib/widgets/mini_runtime_stub.dart', 'lib/widgets/mini_runtime_native.dart']) {
      final code = codeOf(f);
      expect(code.contains('void setMiniAppsInteractive(bool on) {}'), isTrue,
          reason: '★ $f 这份今天该是**空操作** —— 要真做就写清为什么（见 145）');
    }
    // 宿主那一侧：档位一变就跟着切（不然它永远不会被叫）
    final host = codeOf('lib/widgets/mini_app_host.dart');
    expect(host.contains('setMiniAppsInteractive(!widget.covered)'), isTrue,
        reason: '★ 宿主没接线 ⇒ 这一手是死的');
  });


  testWidgets('🔴 没装钩子 ⇒ 拿到的还是**那句实话**（不是白屏）', (tester) async {
    // 负向对照：这一条必须**在钩子为空**的前提下成立（上面 setUp 刚清过）。
    expect(nativeMiniAppView, isNull, reason: '起点：没装');
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: buildMiniAppView(entryUrl: 'http://x/y', title: '随便')),
    ));
    await tester.pump();
    expect(find.text(appRuntimeNotHere), findsOneWidget,
        reason: '★ 跑不起来就说一句人话 —— "点了没反应"是这个项目最忌的形状');
  });

  testWidgets('🔴 装上钩子 ⇒ 走**原生那一份**；收帧时也转给它', (tester) async {
    const url = 'https://apps.stalkerai.cn/w/a/index.html?s=x';
    final built = <String>[];
    final released = <String>[];
    nativeMiniAppView = ({required String entryUrl, required String title, onAsk}) {
      built.add(entryUrl);
      return const Text('原生那一层');
    };
    nativeMiniAppRelease = released.add;

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: buildMiniAppView(entryUrl: url, title: '随便')),
    ));
    await tester.pump();
    expect(find.text('原生那一层'), findsOneWidget, reason: '★ 装了钩子就该用原生那一份');
    expect(find.text(appRuntimeNotHere), findsNothing, reason: '★ 那句话不该再出现');
    expect(built, hasLength(1));

    // 换帧/关掉那一下：`MiniAppFrame` 说的那一句话必须**真的到得了**原生那一层。
    releaseMiniAppView(miniViewIdOf(url));
    expect(released, [miniViewIdOf(url)], reason: '★ 收帧要转给原生那一份（不然 WebView 留在那儿）');
  });

  test('🔴 条件导入只许对 `dart.library.html` 选 Web 实现（源码级）', () {
    final src = File('lib/widgets/mini_runtime.dart').readAsStringSync();
    expect(
      src.contains("if (dart.library.html) 'mini_runtime_web.dart'"),
      true,
      reason: '★ 条件只许是 `dart.library.html`；写错的话**只有真机打包时才会爆**',
    );
    expect(src.contains("export 'mini_runtime_stub.dart'"), true,
        reason: '默认（非 Web）必须是那一份"装了就用原生、没装就给实话"的');
  });

  test('🔴 `webview_flutter` 只许从"原生那两份"进来（不许进 Web 编译链）', () {
    // 允许出现的那两份：原生运行时本体、以及只在非 Web 编的装钩子那一份。
    const allowed = {
      'lib/widgets/mini_runtime_native.dart',
      'lib/widgets/mini_native_boot_io.dart',
    };
    final offenders = <String>[];
    var scanned = 0;
    for (final e in Directory('lib').listSync(recursive: true)) {
      if (e is! File || !e.path.endsWith('.dart')) continue;
      scanned += 1;
      final path = e.path.replaceAll(r'\', '/');
      if (allowed.contains(path)) continue;
      if (codeOf(path).contains('webview_flutter')) offenders.add(path);
    }
    // 负向对照：得真扫到了这些文件，不然这条闸是空转的。
    expect(scanned, greaterThan(100), reason: '★ 只扫到 $scanned 份 —— 这条扫描没在工作');
    expect(offenders, isEmpty,
        reason: '★ 这几份里出现了 `webview_flutter`：它只许住在原生那两份里（网页产物不该带上它）');
    // 负向对照之二：白名单里那两份**本来就该**提到它（说明上面那份白名单不是摆着好看的）。
    expect(codeOf('lib/widgets/mini_runtime_native.dart').contains('webview_flutter'), true);
    expect(codeOf('lib/main.dart').contains('webview_flutter'), false,
        reason: '★ `main.dart`（Web 也编它）不许直接提到它 —— 只许经 `widgets/mini_native_boot.dart`');
  });

  test('三份实现的签名必须一致（不然换平台就编不过）', () {
    for (final name in [
      'lib/widgets/mini_runtime_stub.dart',
      'lib/widgets/mini_runtime_web.dart',
      'lib/widgets/mini_runtime_native.dart',
    ]) {
      final src = File(name).readAsStringSync();
      for (final sig in ['required String entryUrl', 'required String title', 'onAsk']) {
        expect(src.contains(sig), true, reason: '$name 少了「$sig」—— 三份签名必须一样');
      }
      expect(
        src.contains('Widget buildMiniAppView(') || src.contains('Widget buildNativeMiniAppView('),
        true,
        reason: '$name 里找不到起帧那个函数',
      );
      expect(
        src.contains('void releaseMiniAppView(') || src.contains('void releaseNativeMiniAppView('),
        true,
        reason: '$name 里找不到收帧那个函数',
      );
    }
  });

  test('🔴 小程序那一层的底边内缩**不许跟着浮窗当前高度走**（每帧 resize 一个 iframe = 卡死）', () {
    // 2026-10-01 主人报：*「性能变得非常差，开关动效全没了。」* ——
    //   `onHeight` 是**每帧**都会报一次的；那个数一旦成了**平台视图的布局输入**，
    //   真 `<iframe>` 的 DOM 盒子就每帧被 resize 一次（Web 上最贵的一件事），
    //   而"开一个小程序"那一下浮窗自己也在收（两个动画叠着）⇒ 整段动画直接卡没。
    //   ⇒ 钉死：它只许用**只往下记**的 `_barH`，一个字节都不许提到 `_floaterH`。
    final src = File('lib/screens/chat_screen.dart').readAsStringSync();
    // ⚠️ **2026-10-05**：那一处现在是**按平台分的三元**（主人定的"网页不铺满、安卓铺满"）——
    //    **网页**留出底下那一格（录音圆圈由 Flutter 画着露在外面）；
    //    **安卓**是平台视图、在画布**下面** ⇒ 铺满（`0`）。
    //    ⇒ 判据要看**整段表达式**，不是第一行（改口径时别把这条保护丢了）。
    final lines = src.split('\n');
    final at = lines.indexWhere((l) => l.trimLeft().startsWith('bottomInset:'));
    expect(at >= 0, isTrue, reason: '找不到 `bottomInset:` 那一处（这一条判据要跟着它走）');
    final line = lines.sublist(at, at + 4).join(' ');
    expect(line.contains('_floaterH'), false,
        reason: '★ 那一行提到了 `_floaterH` —— 它是**每帧都变**的浮窗高度，'
            '喂给平台视图 = 每帧 resize 一个真 iframe（2026-10-01 那次"动效全没了"就是这么来的）');
    expect(line.contains('_barH'), true, reason: '★ 用的是**收起档那个稳定值**（只往下记）');
    expect(line.contains('kIsWeb'), true,
        reason: '★ 网页那一档必须**留出底下那一格**（`D3.16` 补：不铺满 ⇒ 录音圆圈露在外面，一份实现）');
    expect(line.contains('? (FloaterMetrics.margin + _barH) : 0'), true,
        reason: '★ 网页＝让出那一格；安卓＝铺满（平台视图在画布下面，聊天天然压得住它）');
  });


// ★ 2026-10-04（主人报的"退出按钮有时候没用、小程序里没用"）：
//   真小程序那一屏是**真的 DOM 元素、压在 Flutter 画布上面** ⇒ Flutter 画的那颗
//   **收不到点击**（内置那几屏不是平台视图，所以"有时候"好使）。
//   ⇒ 那一颗必须**也用 DOM 画在 iframe 上面**（`mini_runtime_web.dart`）。
//   ⚠️ 这里只钉**接线在不在**（DOM 的事在 VM 上跑不起来）——
//      真机那一下要靠人在浏览器里点。
test('🔴 拍照那一层门：iframe 的 `allow` 跟着"他授予了"走（没授予就是空串）', () {
  // 主人 2026-10-05：*"给小程序增加拍照功能。"*
  //   网页那一侧就是 iframe 的 `allow` 属性：**授予了才写 `camera`**，没授予是空串
  //   （浏览器自己把镜头挡在门外）—— 与 `net`"关掉 ⇒ 名单不进 CSP"同一个形状。
  final web = File('lib/widgets/mini_runtime_web.dart').readAsStringSync();
  expect(web.contains('allowCamera'), isTrue, reason: '★ Web 那一份没有收下"能不能要镜头"这个入参');
  expect(web.contains("allowCamera ? 'camera' : ''"), isTrue,
      reason: '★ `allow` 那一栏不是"按授予给"的（写死一个 camera 就等于谁都拿得到）');
  // 出参那一侧：那一句话只有一处出处（`chat_screen`），而且是拿 **granted** 判的
  final screen = File('lib/screens/chat_screen.dart').readAsStringSync();
  final line = screen.split('\n').firstWhere((l) => l.contains('allowCamera:'), orElse: () => '');
  expect(line.isNotEmpty, isTrue, reason: '找不到 `allowCamera:` 那一处（判据要跟着它走）');
  expect(line.contains('granted'), isTrue,
      reason: '★ 那句门不是拿"他授予了没有"判的（拿 `permissions` 判 = 声明了就给，那不是这一套规矩）');
  // 安卓那一侧也得在：WebView 那条 `onPermissionRequest`
  final native = File('lib/widgets/mini_runtime_native.dart').readAsStringSync();
  expect(native.contains('setOnPlatformPermissionRequest'), isTrue,
      reason: '★ 安卓那一侧没有那道门（网页与安卓是**同一个道理、两处实现**）');
  expect(native.contains('WebViewPermissionResourceType.camera'), isTrue);
});

test('🔴 Web 那一颗「退出」是**画在 iframe 上面**的（DOM ＋ z-index），不是 Flutter 画的', () {
  final src = File('lib/widgets/mini_runtime_web.dart').readAsStringSync();
  // ⚠️ **2026-10-05：丙（壳）砍掉了**（主人定：安卓走"聊天在最上"、网页走"再画一遍浮层"）
  //   ⇒ 这一条回到"网页那一颗是**用 DOM 画在 iframe 上面**的"（判据随功能走，不是跳过）。
  expect(src.contains('_exits[viewId] = onExit'), isTrue,
      reason: '★ 那一帧的回调要存下来（DOM 按钮点击时才找得到）');
  expect(src.contains('exitBtn.onClick.listen'), isTrue, reason: '★ 点击必须落在 DOM 那一侧');
  expect(src.contains('zIndex'), isTrue, reason: '★ 必须压在 iframe 上面（不然点不到）');
  expect(src.contains('miniAppExitLabel'), isTrue, reason: '★ 那个词只有一处出处（models）');
  expect(src.contains('wrap.children.addAll'), isTrue,
      reason: '★ iframe 与那颗圆圈要在**同一个容器**里（不然定位对不上）');
  // 🔴 **负向对照**（2026-10-05 主人定的"网页不铺满"）：那一层**只许有"退出"一样东西** ——
  //   麦克风圆圈与那行字**搬回 Flutter** 了（底下那一格已经让出来 ⇒ 一份实现）。
  //   它们要是偷偷回来，屏幕上就会**又是两颗**（两颗✕/两颗话筒那一族的老病）。
  for (final gone in ['hupo-mini-mic', 'hupo-mini-words', 'updateMiniAppMic', 'updateMiniAppWords']) {
    expect(src.contains(gone), isFalse,
        reason: '★ 这一层里不该再有 `$gone` —— 网页那颗圆圈由 Flutter 画（`D3.16` 补）');
  }
});
}
