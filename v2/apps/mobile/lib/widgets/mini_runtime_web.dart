// **沙箱运行时（Web）**：把制品放进一个 `<iframe sandbox="allow-scripts">` 里跑。
//
// ── 这一份就是 N1 / N2 的落点 ──────────────────────────────
//   🔴 **N1**：`src` 指向**另一个原点**（本机 = 另一个端口；生产 = 另一个域名）
//      ⇒ 制品读不到这个页面的存储、也拿不到壳的令牌。
//   🔴 `sandbox="allow-scripts"` **故意不给 `allow-same-origin`**
//      ⇒ 制品活在一个**不透明原点**里：`parent.document` / `localStorage` / cookie 全都碰不到。
//   🔴 **回话通道只有一条**（乙-4b 才开）：`{kind:'ask', prompt}` ⇒ 壳替它问一句。
//      别的消息**一律不理会**；壳**永远不会**把"能指挥 agent"的东西交给它（N2）。

// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:async';
// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;
import 'dart:ui_web' as ui_web;

import 'package:flutter/widgets.dart';

import '../models/mini_frame.dart';
import '../models/space_words.dart';

/// 已经挂上监听的那些 iframe（按 viewId 记）—— **换掉那一帧时要退订**。
///
/// 🔴 为什么非退订不可（契约 `docs/dev/111-APP-LIVE-UPDATE.md` 判据 U5）：
///    `html.window.onMessage.listen` 是**整页一条**的常驻监听。换一版就多挂一条的话，
///    老那条虽然对着一个已经摘下来的 iframe，**照样会把新页面的"问一句"再送去问一次**
///    —— 那是**多花一次他的额度**，而且他看不到第二次。
/// ⚠️ 退订由 `MiniAppFrame` 在换帧/关掉时叫（`releaseMiniAppView`）。
final Map<String, StreamSubscription<html.MessageEvent>> _subs =
    <String, StreamSubscription<html.MessageEvent>>{};

/// **已经建出来的那些 iframe**（按 viewId 记）—— 只为了一件事：改它的 `pointer-events`。
///
/// 🔴 **2026-09-30 主人报的真缺陷**：*「打开小程序后，点击聊天窗口，聊天就卡死了，
///    小程序我看后面也有影响。需要刷新才能恢复。」*
///    真浏览器读数（手机尺寸）：小程序一开，`document.elementFromPoint()` 在
///    **时间线区 / 小程序区 / 左上角**回的都是 **`IFRAME`** ——
///    Web 上平台视图是**真的 DOM 元素**，它盖在 Flutter 的画布**上面**
///    ⇒ **画在画布上的聊天浮窗一个事件都收不到**（看起来就是"整个界面点了没反应"）。
///    修法就是下面 `setMiniAppsInteractive`。
final Map<String, html.IFrameElement> _frames = <String, html.IFrameElement>{};

/// **这一层现在收不收指针事件**（默认收）。
///
/// 🔴 **为什么必须能关掉**：被盖住那一档（聊天展开了）我们的规矩本来就是
///    *"点可见的那一块 = 收起聊天，而且这一下**不许传给下面的 app**"*
///    （`mini_app_host.dart` 里那个全屏 `Listener`）—— 可 Web 上那个 iframe
///    在 DOM 里**盖在画布上面** ⇒ 那一下既到不了我们的 `Listener`、也到不了聊天浮窗。
///    ⇒ 展开聊天时把它设成 `none`：事件穿过去落到画布上，两件事**一起**对了。
/// ⚠️ **同一时刻壳里只开着一个页面**（本文件顶上那条纪律）⇒ 不必按 id 分。
bool _interactive = true;

/// 让小程序那一层收 / 不收指针事件（Web 专用；别的平台是空操作）。
///
/// 🔴 **真的那一手是一条 CSS 规则（带 `!important`）＋ 挂在 `<html>` 上的一个类名**。
///    为什么不一个一个元素去写 `style`：**引擎会自己重建那一层**
///    （2026-09-30 实测：写完 `flt-platform-view` 之后它又被盖回来 ——
///      `elementFromPoint()` 有时回 `FLT-PLATFORM-VIEW-SLOT`、有时回玻璃板，
///      取决于采样落在动画的哪一帧）⇒ 一次性写死 ＋ `!important` 才跟得上。
void setMiniAppsInteractive(bool on) {
  _interactive = on;
  _ensurePointerStyle();
  final cls = html.document.documentElement?.classes;
  if (cls != null) {
    if (on) {
      cls.remove(coveredClass);
    } else {
      cls.add(coveredClass);
    }
  }
  // ⚠️ 顺手把那几格直接也写一遍（两样都做，代价只是几次属性写）
  final pe = on ? 'auto' : 'none';
  for (final f in _frames.values) {
    f.style.pointerEvents = pe;
  }
  for (final el in html.document.querySelectorAll(
      'flt-platform-view-slot, flt-platform-view, flt-clip')) {
    el.style.pointerEvents = pe;
  }
}

/// 挂在 `<html>` 上那个类名（下面那条 CSS 规则靠它开关）。
const coveredClass = 'hupo-chat-covered';

const _styleId = 'hupo-mini-pointer-style';

/// **一次性**把那条规则注进去（幂等）。
///
/// 🔴 **为什么要它**（契约 `docs/dev/145-MINIAPP-EATS-POINTERS.md`）：
///    Web 上平台视图是**真的 DOM 元素**、盖在画布上面。小程序开着的时候，
///    `document.elementFromPoint()` 在时间线区/小程序区/左上角回的都是那个
///    `IFRAME` ⇒ **画在画布上的聊天浮窗一个事件都收不到**
///    （主人 2026-09-30 报的"点了聊天窗口整个界面点了没反应，要刷新"）。
///    被盖住那一档我们的规矩本来就是"这一下**不许传给下面的 app**"
///    （`mini_app_host.dart` 里那个全屏 `Listener`）—— 这条规则让它成真。
void _ensurePointerStyle() {
  if (html.document.getElementById(_styleId) != null) return;
  final st = html.StyleElement()..id = _styleId;
  st.text = 'html.$coveredClass flt-platform-view-slot,'
      'html.$coveredClass flt-platform-view,'
      'html.$coveredClass flt-clip,'
      'html.$coveredClass iframe { pointer-events: none !important; }';
  html.document.head?.append(st);
}

/// 起一个沙箱 iframe。
///
/// ⚠️ `entryUrl` 是**带签名**的（绑人 + 绑版本 + 短时效）—— 制品口只认签名，不认登录态。
/// ⚠️ `onAsk` 是那条**唯一**的回话通道：页面说"我要问一句"，壳去替他问（**用看的人的钥匙**）。
///    拿回来的话，壳用 `postMessage` 回给**这一个** iframe。
/// 🔴 **换版本 ⇒ 换 URL ⇒ 换 `viewId` ⇒ 换一个 iframe**（`MiniAppFrame` 负责换）：
///    这一份只管"照 URL 建那一帧"，**不认识版本**。
Widget buildMiniAppView({
  required String entryUrl,
  required String title,
  Future<String> Function(String prompt)? onAsk,
  void Function()? onExit,
  // ★ **2026-10-05：拍照**（主人：*"给小程序增加拍照功能。"*）——
  //   授予了才把 iframe 那道门放开（`allow="camera"`），没授予就是一个字都不给。
  bool allowCamera = false,
}) {
  // 🔴 **viewId 的算法只有一处**（`models/mini_frame.dart`）——
  //    `MiniAppFrame` 记账用的是同一个函数。
  final viewId = miniViewIdOf(entryUrl);
  // ⚠️ **同一个 viewType 只许注册一次**（重复注册当场抛）⇒ 这本账只增不减。
  if (miniViewLedger.register(viewId)) {
    ui_web.platformViewRegistry.registerViewFactory(viewId, (int _) {
      // ★ **2026-10-05（丙 · `184`）：嵌的是"我们自己的壳"** —— 浮层（麦克风 / ✕ / 那行字）
      //   由壳里画（一份实现、天然在小程序之上）；旧那套"在壳外面再画一遍"由 `_useShell` 关掉。
      //   ⚠️ **开关留在这儿**：万一壳那一层不对劲，把它改成 `false` 就回到原来那一版（一行）。
      final f = html.IFrameElement()
        ..src = entryUrl
        ..title = title
        // 🔴 **只给 allow-scripts**：给了 allow-same-origin 就等于把壳的存储和它共享
        ..setAttribute('sandbox', 'allow-scripts')
        ..setAttribute('referrerpolicy', 'no-referrer')
        // ★ **2026-10-05：`allow` 那一栏只放"他点头了的那一样"** ——
        //   授予了 `camera` 才写 `allow="camera"`（页面里 `getUserMedia` 才起得来）；
        //   没授予就是空串（浏览器自己把镜头挡在门外，与 `net`"关掉⇒名单不进 CSP"同形）。
        //   ⚠️ 麦克风/定位这些**仍然一个都不给**（小程序用不上）。
        ..setAttribute('allow', allowCamera ? 'camera' : '');
      f.style.border = 'none';
      // ⚠️ 绝对定位、四边贴 0（比 `width/height:100%` 更硬：不受行内基线/盒模型影响）
      f.style.position = 'absolute';
      f.style.top = '0';
      f.style.left = '0';
      // 🔴 **2026-10-06：右侧那条"1 物理像素的缝"就修在这一行**。
      //
      //   成因（拿真浏览器量出来的，不是猜的）：真机的 CSS 视口宽常常是**分数**
      //   （物理宽 ÷ 像素比，例如 1619 ÷ 3 ≈ 539.67）⇒ 这一帧最右边那一列物理像素
      //   **只被盖住一部分**，露出来的就是它后面的那张**纸**（白）⇒ 一条白线。
      //   实测读数（主人 2026-10-05 那张截图 · 1619×2590）：最右一列 `(244,234,255)`
      //   = 纸色与小程序底色的**半盖**，左边那一列同样的位置**没有**这条线。
      //
      //   ⚠️ **为什么不能挂在那个 wrapper 上**（原来写的是 `right:-2px`）：
      //   Flutter 会把**那个 wrapper 的尺寸写死成"这一格的矩形"** —— 真读数
      //   （`--eval` 量 DOM）：wrapper 量出来是 1281×512，与槽**一模一样**，
      //   那两个 `-2px` **一个像素都没生效**。而 **iframe 的尺寸是我们说了算**
      //   （它是 wrapper 的孩子）⇒ 多出来的那 2 像素只能挂在它身上。
      //   `overflow:hidden`（wrapper 上那个）会把超出去的部分裁掉 ⇒
      //   底下那条聊天条**不会被压到**，只是这一帧实际画得比看得见的地方宽 2 像素。
      f.style.width = 'calc(100% + 2px)';
      f.style.height = '100%';
      f.style.display = 'block';
      f.style.background = 'transparent';
      // 🔴 **小程序那一屏是真的 DOM 元素、压在 Flutter 画布上面**
      //    （`docs/dev/183` §一那段注释）：Flutter 画的按钮**盖不住它、也收不到点击**
      //    ⇒ 2026-10-04 主人报的"退出按钮有时候没用、小程序里没用"就是这一条。
      //    ⇒ 这一个"退出"必须**也用 DOM 画**，而且 z-index 比 iframe 高（就是微信那个样子：
      //      半透明的圆圈浮在页面右上角）。Flutter 那一颗留给**内置那几屏**
      //      （它们不是平台视图，Flutter 自己就收得到点击）。
      // ★ **2026-10-05（主人定的"网页不铺满"）：这一层只剩"退出"这一颗。**
      //   底下那颗录音圆圈与它左边那句字**改回 Flutter 画**（那一格已经从平台视图的
      //   矩形里让出来了 ⇒ 看得见也点得到，**两端同一份实现**）——
      //   原来那套 DOM 的麦克风/字（`D3.14` 甲）跟着一起删了。
      //   ⚠️ **"退出"必须留在这里**：它在**右上角**，那一角仍然被平台视图盖着。
      _exits[viewId] = onExit;
      // 🔴 **2026-10-06 主人截图（右侧一条白边）那条的真相**：真浏览器量出来的
      //    读数 —— **这一格（wrapper）的尺寸是 Flutter 写死的**（= 这一格的矩形，
      //    量到 1281×512，与槽逐像素相同）⇒ 在这里写 `right/bottom:-2px`
      //    **一个像素都不生效**（那两行是白写的，2026-10-06 已删）。
      //    ⇒ "多铺 2 像素"这件事改挂在 **iframe** 身上（见上面那一行 `width`）。
      final wrap = html.DivElement()
        ..style.position = 'absolute'
        ..style.top = '0'
        ..style.left = '0'
        // ⚠️ **裁掉超出去的那一点**：小程序那一帧比这一格宽 2 像素 ⇒
        //    超出这一格的部分不许露到下面那条聊天条上。
        ..style.overflow = 'hidden';
      final exitBtn = html.ButtonElement()
        ..className = 'hupo-mini-exit'
        ..text = '✕'
        ..title = miniAppExitLabel
        ..setAttribute('aria-label', miniAppExitLabel);
      // ⚠️ 样式**内联**写（不由外面那张表管）：它在 iframe 上面，不跟着 Flutter 的主题走
      exitBtn.style
        ..position = 'absolute'
        ..top = '10px'
        ..right = '10px'
        ..zIndex = '2147483647'
        ..width = '36px'
        ..height = '36px'
        ..padding = '0'
        ..border = 'none'
        ..borderRadius = '50%'
        ..background = 'rgba(0,0,0,.38)'
        ..color = '#fff'
        ..fontSize = '17px'
        ..lineHeight = '36px'
        ..cursor = 'pointer';
      exitBtn.onClick.listen((_) {
        final fn = _exits[viewId];
        if (fn != null) fn();
      });
      wrap.children.addAll(<html.Element>[f, exitBtn]);
      // ⚠️ 新建的这一帧也要立刻跟上当前那一档（展开着的时候它一建出来就该是 `none`）
      _frames[viewId] = f;
      // ⚠️ 槽可能**刚**建出来 ⇒ 建完这一帧再统一设一次（同一个函数，一处口径）
      setMiniAppsInteractive(_interactive);

      if (onAsk != null && !_subs.containsKey(viewId)) {
        // ⚠️ **按 `source` 认人**，不是按 origin：沙箱页面是**不透明原点**（origin 是 "null"），
        //    拿 origin 判等于谁都放进来。只有"这一条 iframe 自己"发来的才算。
        final sub = html.window.onMessage.listen((e) async {
          // 🔴 **这一帧已经换掉了/关掉了 ⇒ 一个字都不理**（`MiniAppFrame` 销的号）。
          //    少了这一句，摘下来的那一帧还会替新页面把话再问一遍。
          if (!miniViewLedger.isHosted(viewId)) return;
          final win = f.contentWindow;
          if (win == null) return;
          // 🔴 **认"不透明原点"**，不是认 `source`：
          //    · 沙箱页面（`sandbox="allow-scripts"` 且**不给** allow-same-origin）
          //      的 origin 恰好是字符串 `"null"` —— 这是外面伪装不出来的；
          //    · 而 Dart 那边 `identical(e.source, f.contentWindow)` **不可靠**
          //      （跨语言包装对象不保证同一实例）—— 2026-09-22 实测：用它判，
          //      页面发过来的消息**一条都进不来**（服务端那时一次都没被调用）。
          // ⚠️ 再加两条保险：页面的 CSP 是 `default-src 'none'`（**它嵌不了自己的 iframe**
          //    来冒充），而且同一时刻壳里只开着一个页面。
          final origin = e.origin;
          if (origin != 'null' && origin != '') return;
          final data = e.data;
          if (data is! Map || data['kind'] != 'ask') return; // 🔴 只认这一种
          final prompt = data['prompt'];
          if (prompt is! String || prompt.trim().isEmpty) return;
          Map<String, Object?> reply;
          try {
            final text = await onAsk(prompt);
            reply = {'kind': 'hupo-reply', 'text': text};
          } catch (err) {
            // ⚠️ 失败也要**回一句话**（不然页面会一直等；"点了没反应"最忌）
            reply = {'kind': 'hupo-error', 'error': '$err'};
          }
          win.postMessage(reply, '*');
        });
        _subs[viewId] = sub;
        // 页面加载完 ⇒ 告诉它"壳在、这一条路开着"（页面自己决定要不要用）
        f.onLoad.listen((_) {
          if (!miniViewLedger.isHosted(viewId)) return;
          f.contentWindow?.postMessage({'kind': 'hupo-ready'}, '*');
        });
      }
      return wrap;
    });
  }
  return HtmlElementView(viewType: viewId);
}

/// 每一帧那颗"退出"要调的回调（`viewId → 回调`）。
///
/// ⚠️ 它住在**这一层**（DOM 那一侧）：圆圈是 DOM 画的，点击也在 DOM 上发生
///    （见上面那段注释 —— 平台视图压着画布，Flutter 那一条收不到）。
/// ⚠️ **2026-10-05 起这一层只有它一样东西**（麦克风与那行字搬回 Flutter —— 见上）。
final Map<String, void Function()?> _exits = <String, void Function()?>{};

/// **这一帧换掉了 / 关掉了 ⇒ 收干净**（由 `MiniAppFrame` 在换帧与 `dispose` 时叫）。
///
/// 🔴 退的是**消息监听**；平台那边注册过的那个 viewType **不退** ——
///    `registerViewFactory` 同一个 id 只许注册一次，销了号再注册会当场抛
///    （见 `models/mini_frame.dart` 的 `MiniViewLedger`）。
/// ⚠️ 非 Web 那一侧是**空操作**（`mini_runtime_stub.dart`）。
void releaseMiniAppView(String viewId) {
  final sub = _subs.remove(viewId);
  if (sub != null) sub.cancel();
  _exits.remove(viewId);
  _frames.remove(viewId);
}
