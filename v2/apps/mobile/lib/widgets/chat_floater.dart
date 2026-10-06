// **聊天浮窗**（手册 `08-SPEC.md` §六 · 契约 `docs/dev/52-DESKTOP.md`）。
//
// 手册那几条铁律就是这个文件存在的理由：
//   · **Z1** 它永远在 z 序最上（任何页面/小程序都盖不住它）；
//   · **Z3** **盖住不是铺满**：四边永远留边距（现在**四边都是 30**，主人 2026-09-22 定）；
//   · **Z4**（新）桌面是**底部一条**，浮窗在它上面浮着、四边留同一个数。
//
// 三档（§6.2）：收起 / 半开 / 最大化。
//   · **用户按下发送** ⇒ 最大化（"发就拉满"）；
//   · **只有状态变化**（它在想/在做）⇒ **不动**（D4.8：新增助手消息触发的高度变化 = 0px）；
//   · 点浮窗外面 / 点桌面空白 ⇒ 收起；双击抓手 ⇒ 收起 ⇄ 回到上次档位；
//   · **400ms 内的连续触发合并成一次**（助手连发多段不该让窗口抖）。
//
// ── 🔴 2026-09-22 重做的那一处（上一版就死在这儿）────────────────
// 上一版把浮窗**高度定死**（`屏高 - 边距`），再把字塞进去 ⇒ 3.1 倍字号下
// 里面的 chrome（抓手行 + 状态条 + 输入条）比容器还高 ⇒ **纵向溢出 798px**。
// 那正好违反 D3.5：**容器跟字算，不是字跟容器**。现在的形状：
//   · **收起档不写死高度**：它就是"抓手行那点内容"，`SizedBox(height: null)` 由内容算；
//   · **半开/最大化用比例**（§6.2 明写"高度用系数表达"），上限 = 父层给的那块地方；
//   · 高度是父层（`LayoutBuilder`）算出来**传进来**的 —— 这里**不碰 `MediaQuery`**，
//     也就不需要在 `Positioned` 里套 `LayoutBuilder`（那个坑见契约 §二）。
//
// ⚠️ **"点浮窗自己不许漏到下面"**（§6.3）用 `Listener(behavior: opaque)` 挡 ——
//    `deferToChild` 挡不住，点空白会**漏到桌面**。
//    ⚠️ **不用 `GestureDetector`**：源码级禁令（`accessibility_test.dart`）。
//    拖拽与双击都走 `Listener`（原始指针）；可点的东西一律是 Material 按钮。
//
// ── ★ 批次 4：浮窗的**面子**换成 DSH 那套 token（契约 `docs/dev/119`）──────
// 底色 / 发丝线 / 标题 / 抓手 / 里面那一整棵 Material 主题，全部跟着
// `AppearanceScope` 的色板走（用户选亮/暗/跟随系统）。三条边界：
//   · **窗口外面一个像素都不动**：桌面图标墙 / 首页 / 登录 / 小程序容器那一圈壳
//     照旧是暖白纸那套（`models/design.dart`）。整机暗色**不是这一批的事**
//     —— 那等于要给暖白纸品牌色**发明**一份暗色版，得主人点头；
//   · **字号那一轴不在这里**：浮窗自己的字号（抓手/标题/动作）跟系统缩放走，
//     用户的 12–17 **只影响聊天内容**（DSH 原话，`115-raw/B-render.md` §3.1）；
//   · **阴影还是从 `d.ink` 来**（`desktop_floater_test` 钉着那个数）：阴影是
//     "压在多亮的底上"那件事，不是窗口自己的面子。

import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/dsh_design.dart';
import '../models/speak_words.dart';
import '../models/space_words.dart';
import 'appearance_scope.dart';
import 'dsh_look.dart';

/// **两档**（手册 §6.2）。
///
/// 🔴 **2026-10-05 主人**：*"展开聊天我希望不要有移动聊天窗口高度的选项，
///   就是完全展开或者完全收起。"* ⇒ 原来的「半开」那一档与"拖着改高度"**一起砍了**。
enum FloaterTier {
  /// 收起：只剩底下那一格（圆圈 ＋ 两颗按钮）。
  collapsed,

  /// 完全展开（时间线 ＋ 输入条）。
  full,
}

/// **抓手那颗按钮的 key**（判据用它量命中区、也用它点/拖 —— 图形上没有字可找）。
const Key chatHandleKey = Key('chat-handle');

/// **右侧那颗「收起聊天」按钮**的 key（判据用它点它 —— 字与 tooltip 都可能有别的同名）。
const Key chatCollapseKey = Key('chat-collapse');

/// **那一行最右那颗「播放语音」**的 key（开启 / 关停；判据用它点它、也用它读状态）。
const Key chatSpeakKey = Key('chat-speak');

/// 浮窗自己的几条常量（**不散在代码里**）。
class FloaterMetrics {
  const FloaterMetrics._();

  /// **四边留的边距**（Z3 + Z4：盖住不是铺满）。
  ///
  /// ⚠️ 表在手册 `08-SPEC.md` §10.1（阈值总表），改这里就要改那儿并升版本。
  /// 🔴 **2026-09-28 改成 10**（主人在安卓真机上定的：*"底部的聊天窗口有点 margin
  ///    太多太多了。至少可以少去 2/3"* —— 30 的三分之一就是 10）。
  /// ⚠️ 它是**四边共用**的一个数：手机上左右也跟着窄了（390 宽下原来左右各吃 30，
  ///    现在各吃 10）—— 网页桌面那一版也一起变（同一个常量，没有按平台分叉）。
  static const double margin = 10;

  /// 松手吸附的判定带宽（拖到离某一档多近就吸过去）。
  static const double snapSlack = 40;

  /// 拖拽时的**视觉下限**。
  /// ⚠️ 它**不是**收起档的高度 —— 收起档由内容算（见文件头那条）。它只管"拖到多小"。
  static const double dragFloor = 56;

  /// **甩**的判据（D3.7：速度 + 位移 + 时长**三个都要满足**）。
  static const double flingVelocity = 700; // px/s
  static const double flingDistance = 60; // px
  static const int flingMaxMs = 300; // 一次动作不超过这么久

  /// 连续触发的**合并窗口**（§6.2：400ms 内合并成一次）。
  static const int debounceMs = 400;

  // ⚠️ 原来这里有一个 `doubleTapMs`（双击抓手的判定窗）。2026-09-24 起抓手是
  //    **单击 = 收起 ⇄ 展开**（主人：*"展开用一条杠"*）⇒ 双击那套拿掉：
  //    留着它只会让"点两下"变成"展开又收起"（看起来就是点了没反应）。
}

class ChatFloater extends StatefulWidget {
  const ChatFloater({
    super.key,
    required this.maxHeight,
    required this.title,
    required this.child,
    required this.composer,
    this.initialTier = FloaterTier.collapsed,
    this.onTier,
    this.onHeight,
    this.speakOn = false,
    this.onToggleSpeak,
  });

  /// **父层量好给它的可用高度**（父层是 `LayoutBuilder`）。
  /// ⚠️ 传进来而不是自己算，是为了**不碰 `MediaQuery`**、也不在 `Positioned` 里套 `LayoutBuilder`。
  final double maxHeight;

  /// 抓手行上那两个字（收起态那条也用它）。
  final String title;

  /// 浮窗里那一整块（状态条 + 时间线）。**不含输入条** —— 见 [composer]。
  final Widget child;

  /// **输入条**。⚠️ **收起态也要它**（主人 2026-09-22：*"助手那个聊天窗口，
  /// 收缩的时候也有一个输入框。"*）⇒ 而且上下两态用的是**同一个实例**，
  /// 不然"打了一半再展开"会换一个 `State`、**框里的字就丢了**。
  final Widget composer;

  // ⚠️ 2026-09-24：原来这里有一个 `leading`（标题前面那个"在哪儿说话"的图标）。
  //    聊天窗口收成**一行**之后，它搬到了输入条那一行的最前面
  //    （主人：*"homeicon 放在聊天窗口左边"*）⇒ 浮窗不再认识它，
  //    由 `screens/chat_screen.dart` 直接交给 `Composer`。

  /// 一进来是哪一档。**默认收起**（主人 2026-09-22 定：先看见桌面）。
  final FloaterTier initialTier;

  /// **换档了**（上层拿它算"小程序被盖住了没有" —— §6.4 规则 2/3）。
  final ValueChanged<FloaterTier>? onTier;

  /// **我现在占多高**（上层拿它给小程序内容做底部内缩 —— §6.4 规则 1）。
  /// ⚠️ 收起档的高度是**内容算出来**的（D3.5）⇒ 只能**画完再报**，
  ///    所以它在 post-frame 里回调；上层自己判"变了没有"再 setState（免得抖）。
  final ValueChanged<double>? onHeight;

  /// ★ **2026-10-05 主人**：*"语音按钮的右侧，需要两个按钮。一个是展开聊天，
  ///   一个是播放语音。"*
  ///
  /// ⇒ 收起档那一行现在是：**（他说的话 ＋ 那颗圆圈）＋ 展开 ＋ 播放语音**。
  ///    展开那颗就是原来"录音圆圈上方"那颗（同一个 key、同一个形状，只是**挪到了右边**）。
  ///
  /// 播放语音 = **开启 / 关停**那一个状态（`speakOn`）：开着 ⇒ 它新说的话会被念出来。
  /// ⚠️ 念不出来的设备（`services/speech.dart` 的 `canSpeak`）**一个按钮都不许画** ——
  ///    屏幕上不许出现按不动的东西；那种设备上 `onToggleSpeak` 传 `null`。
  final bool speakOn;
  final VoidCallback? onToggleSpeak;

  @override
  State<ChatFloater> createState() => ChatFloaterState();
}

class ChatFloaterState extends State<ChatFloater> {
  late FloaterTier _tier;

  /// 上一次**自动**换档的时间（防抖：400ms 内合并成一次）。
  int _lastAutoMs = 0;

  @override
  void initState() {
    super.initState();
    _tier = widget.initialTier;
    // 初始档位也报一次（不然上层以为"还没展开"而屏幕上已经展开了）
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onTier?.call(_tier);
    });
  }

  int _nowMs() => DateTime.now().millisecondsSinceEpoch;

  /// 换档（**带防抖**：§6.2 的"400ms 内合并成一次"）。
  void _setTier(FloaterTier t, {bool auto = true}) {
    if (t == _tier) return;
    final now = _nowMs();
    if (auto && now - _lastAutoMs < FloaterMetrics.debounceMs) return;
    if (auto) _lastAutoMs = now;
    setState(() => _tier = t);
    widget.onTier?.call(t);
  }

  /// **外面叫它拉满**（"用户按下发送 ⇒ 最大化" · §6.2）。
  /// ⚠️ **不受防抖限制**：用户主动的动作不该被合并掉。
  void maximize() {
    _lastAutoMs = _nowMs(); // 顺手把防抖窗推后，免得紧接着的状态变化又来动窗口
    setState(() => _tier = FloaterTier.full);
    widget.onTier?.call(FloaterTier.full);
  }

  /// 外面叫它收起（点桌面空白时用）。
  void collapse() => _setTier(FloaterTier.collapsed, auto: false);

  /// **展开**（点那颗箭头、或点输入框走同一条路 —— 两处各写一套迟早会分叉）。
  ///
  /// 🔴 **2026-10-05 主人**：*"展开聊天我希望不要有移动聊天窗口高度的选项，
  ///   就是完全展开或者完全收起。"* ⇒ 展开**只有一档**（拉满），
  ///   没有"半开"、也没有"拖着改高度"。
  void expand() => _setTier(FloaterTier.full, auto: false);

  /// 现在哪一档（闸用）。
  FloaterTier get tier => _tier;

  bool get _collapsed => _tier == FloaterTier.collapsed;

  /// 某一档的高度。**收起档返回 `null`** ⇒ 交给内容自己算（D3.5）。
  double? _heightFor(double max) =>
      _tier == FloaterTier.collapsed ? null : max;

  @override
  Widget build(BuildContext context) {
    // ★ 批次 4：这一屏的面子（色板）从 `AppearanceScope` 来；没有 scope
    //   （单看这一块的判据）就退回"跟着 Theme 的亮暗"，与原来逐字一致。
    final scope = AppearanceScope.maybeOf(context);
    final variant =
        scope?.variant ??
        (Theme.of(context).brightness == Brightness.dark
            ? DshVariant.dark
            : DshVariant.light);
    final p = variant.palette;
    final maxH = math.max(widget.maxHeight, FloaterMetrics.dragFloor);
    final h = _heightFor(maxH);
    final collapsed = _collapsed;
    if (widget.onHeight != null) {
      // 画完再报（收起档的高度只有画完才知道 —— D3.5）
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final h = context.size?.height;
        if (mounted && h != null) widget.onHeight!(h);
      });
    }
    return Theme(
      // 🔴 **窗口里面那一整棵**换成这一档的 Material 主题（见 `appearance_scope.dart`
      //    里 `chatThemeOf` 顶上那段：不这么做，里面那些读 `Theme` 的控件
      //    ——气泡、输入框、状态条——会把近黑的字压在近黑的底上，而判据照样全绿）。
      data: chatThemeOf(variant),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxH),
        // ⚠️ 收起档 `h == null` ⇒ `SizedBox` 不约束高度 ⇒ 由内容算（D3.5）
        child: SizedBox(
          height: h,
          child: DecoratedBox(
            // 阴影照手册 §10.1 阈值总表：外 blur 32 · α.45 · offset(0,-6)
            // ★ **2026-10-04 主人：*"语音按钮下面的平台不需要了……不需要底下那个框了。"***
            //   ⇒ **收起档不再画那个框**（阴影 / 圆角 / 磨砂 / 蒙版全撤），底下只剩那颗圆圈浮在桌面上；
            //   ⚠️ **展开档一个字不动**（它是聊天记录那个窗口，白底不透明那一条照旧）。
            //   ⚠️ widget 的**形状**仍然一样（`DecoratedBox` / `ClipRRect` / `BackdropFilter`
            //      / `Container` 都在，只是收起档给"什么都没画"的值）——
            //      这样两档来回切不会重建子树（这是当年"字不丢"那条判据的由来）。
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(collapsed ? 0 : d.radiusCard),
              boxShadow: collapsed ? const <BoxShadow>[] : [
                BoxShadow(
                  // ★ 2026-09-29 主人：*"……我想用白色透明，不用黑色透明。"*
                  //   ⇒ 影的颜色从"墨色 α.45 的黑"换成**白**（`floaterShadowColor`）。
                  //   ⚠️ 模糊与下移照旧（手册 §10.1 那两个数没动）。
                  color: d.floaterShadowColor,
                  blurRadius: 32,
                  offset: const Offset(0, -6),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(d.radiusCard),
              // ★ 2026-09-29 主人：*"对话框底部透明度再次增加。模仿mac的工具栏。"*
              //   ⇒ **收起档**那条 bar 是**磨砂玻璃**：底下先糊一层（`BackdropFilter`），
              //     上面再压一层很淡的白（`barVeilAlpha`）。
              //   🔴 **展开档不糊**：那一档里面是时间线 —— 糊它既没用（白底）又白算。
              //   ⚠️ `ClipRRect` 在**外面**：模糊被圆角裁住（不然会糊到浮窗外那一圈）。
              // 🔴 **两种档位都得是同一个 widget 形状**（`BackdropFilter` 常在）：
              //    收起 ⇄ 展开时若整棵子树的**类型**变了，输入条会被**重建**
              //    ⇒ 打了一半的字就没了（判据"字不丢"当场红，实测抓到的）。
              //    ⇒ 展开档把 sigma 设成 **0**（等于没糊）—— 形状不变、状态就活着。
              //    ⚠️ 展开档为什么本来就不该糊：那一档里面是时间线，糊它既没用（白底）又白算。
              child: BackdropFilter(
                filter: ImageFilter.blur(
                  sigmaX: 0,
                  sigmaY: 0,
                ),
                child: _barSurface(collapsed, p),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 浮窗那一层底 ＋ 它里面那一列（抽出来只因为上面那个 `BackdropFilter` 要包一层）。
  Widget _barSurface(bool collapsed, DshPalette p) {
    return Listener(
                // 🔴 **点浮窗自己不许漏到下面**（§6.3）：opaque 吃掉所有指针事件。
                // ⚠️ 这里**不接手势**（没有 onPointerXxx）—— 它只负责"挡住"。
                //    手势绑在抓手那一行（见下），否则会把**时间线的滚动**吃掉：
                //    2026-09-22 实测，第一版把 `_onMove` 挂在整块浮窗上，
                //    于是"往上拖时间线"被当成"把窗口拉高"，`重发`那条判据当场红。
                behavior: HitTestBehavior.opaque,
                child: Material(
                  // ★ 窗口的底 = DSH 的 `bg-layer-1`（亮色就是纯白，暗色 #232324）。
                  // ★ 2026-09-29 主人：*"底部的聊天组件我想要首先一个半透明的bar……
                  //   这些按钮就不是透明的了。"*
                  //   ⇒ **收起档那一条**的底是**半透明**的（桌面/壁纸透过来一点），
                  //     而 bar 上那三样（home / 输入框 / 话筒）各自是不透明实底
                  //     （那颗 home 已于 `D3.15` 取消；出口今天在每个 app 右上角）。
                  //   🔴 **展开档必须维持不透明**：那一档里面是时间线，
                  //     底透了就变成"字压在壁纸上"，读不了（这一条不许顺手改）。
                  color: collapsed
                      ? const Color(0x00000000)
                      : p.bgLayer1,
                  child: Column(
                    mainAxisSize: collapsed ? MainAxisSize.min : MainAxisSize.max,
                    children: [
                      // ── 抓手（主人 2026-09-24）────────────────────────
                      //   原话：*"展开用一条杠，杠上面有一个小箭头，箭头比较平，
                      //   所以不会显得那么突兀，放在上边框的正中央"*
                      //
                      // 🔴 **一根杠 + 一个"平"的小箭头**，**永远在上边框正中央**
                      //    （收起、展开都在同一个位置 —— 位置不动，只有箭头朝上/朝下）。
                      //   · **点它 = 收起 ⇄ 展开**（单击就够）；
                      //   · **竖向拖它 = 跟手变高**（§6.3 的手势表）。
                      //
                      //   ⚠️ **命中区 96×44（D3.6）**，图形只有 26×7 —— 好点，但不显眼。
                      //   ⚠️ 它**没有可见的字**（主人这次的原话就是"一条杠 + 小箭头"）：
                      //      D3.8 那条"必须带字"由这一版**改掉**（手册同日改），
                      //      字改挂在 tooltip 与无障碍名上（`展开` / `收起`）。
                      //   ⚠️ 手势**只绑在这一行**（§6.3）：绑在整块浮窗上会把时间线的滚动吃掉
                      //      —— 那正是上一版没暴露的 bug。
                      // 🔴 2026-09-29 主人：*"展开对话那一小排的占地空间太大。我不要那根杠了。"*
                      //   ＋ 他点的办法：*"展开后右上角有个收起按钮。"*
                      //   ⇒ ① **展开态不再单独占一行**（那一行整条撤掉 —— 收起来的出口
                      //        是标题行右端那颗「收起」）；
                      //     ② **收起态仍然留着**（那是唯一的展开入口），但里面**只剩那颗平箭头**
                      //        （那根 44×4 的杠删掉）。
                      //   ⚠️ 拖动（§6.3：竖向拖 = 改高度）跟着这一行走：
                      //      收起态绑在抓手这一行、**展开态绑在标题行**（下面那个 `Listener`）。
                      // ★ **2026-10-05（主人定的最终形状）**：*"语音按钮的右侧，需要两个按钮。
                      //   一个是展开聊天，一个是播放语音。"*
                      //   ⇒ 收起档那一行 = **（他说的话 ＋ 那颗圆圈）＋ 展开 ＋ 播放语音**。
                      //     ⚠️ 展开那颗**不再是"圆圈上方那一行"**（那一行整条撤掉：省下的正是
                      //        主人一直在嫌的那点占地），它只是**挪到了右边**（同一个 key/形状）。
                      //     🔴 **2026-10-05：不再有"拖着改高度"**（主人：*"我希望不要有
                      //        移动聊天窗口高度的选项，就是完全展开或者完全收起。"*）
                      //        ⇒ 那两层 `Listener`（以及跟手那一套）整段删了。
                      if (collapsed) _bottomRow(p, collapsed: true),
                      // ── 展开态：标题行（**收起态不画它** —— 那一档就是"一格"）──
                      if (!collapsed)
                        Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: d.gapS,
                            vertical: 2,
                          ),
                          child: Row(
                            children: [
                              const SizedBox(width: d.gapS),
                              // 标题：**这一行里唯一会伸缩的那一格**（地方不够就截字）。
                              Expanded(
                                child: Text(
                                  widget.title,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  // ★ 批次 4：字色跟色板走（暗色下 `d.ink` 是黑字）。
                                  // ★ 2026-10-02（契约 `154` §2.1）：改用 `DshTypes.title`
                                  //   （20 / **600** / 28）—— 一处 token，不就地 copyWith。
                                  style: dshTextStyle(DshTypes.title, p.labelPrimary),
                                ),
                              ),
                              const SizedBox(width: d.gapS),
                              // 🔴 **右侧那一颗就是出口**（主人 2026-10-03：
                              //    *"让收起聊天变成右侧的一个按钮，就叫收起聊天。"*）
                              //    —— **带字的按钮**，不再是那颗只有图形的箭头。
                              // ⚠️ 同一天更早一句（*"回收站，导出，过程，我们也不需要。"*）：
                              //    这一行右边原来还有一串动作 ＋ 一条**横滚**
                              //    （`chatActionsStripKey`）⇒ **整条删了**。
                              //    读数与"那条账怎么结的"见 `docs/dev/172-HEADER-TRIM.md`。
                              Tooltip(
                                message: chatCollapse,
                                child: TextButton(
                                  key: chatCollapseKey,
                                  onPressed: () => _setTier(
                                    FloaterTier.collapsed,
                                    auto: false,
                                  ),
                                  // ⚠️ 命中区 ≥44（D3.6）；字用主题里那一档（**不写死字号**）。
                                  style: TextButton.styleFrom(
                                    minimumSize: const Size(44, 44),
                                    padding: const EdgeInsets.symmetric(horizontal: 10),
                                    foregroundColor: p.labelTertiary,
                                  ),
                                  child: const Text(chatCollapse),
                                ),
                              ),
                            ],
                          ),
                        ),
                      // 收起态那一行**上面已经画过了**（`Row` 里那一个 `Expanded`）——
                      // 这一支只剩"展开态"要补的东西。
                      if (!collapsed) ...[
                        // ★ 批次 4：发丝线（0.5，不是 1.0）＋ 这一档的描边色。
                        Divider(
                          height: 1,
                          thickness: dshHairline,
                          color: p.borderL3,
                        ),
                        Expanded(child: widget.child),
                        // ★ **2026-10-05**：展开档那一行**跟收起档同一个形状**
                        //   （圆圈 ＋ 那两颗**占着同一个位置**）—— 见 `_bottomRow` 的注释：
                        //   不然打开聊天窗口那一下，语音那颗会**往右跳 44**，
                        //   主人当场就看出来了（*"打开聊天历史窗口后……语音按键位置改变了"*）。
                        _bottomRow(p, collapsed: false),
                      ],
                    ],
                  ),
                ),
              );
  }

  /// **底下那一行**（两个档**同一个形状**）：`（他说的话 ＋ 圆圈）＋ 右边那一列两颗`。
  ///
  /// 🔴 **2026-10-05 晚些时候 · 主人定的最终形状**：*"语音按钮右侧，展开聊天窗口和
  ///   开启关闭语音，是一列的。就是上下关系。展开在上，开启关闭在下。然后他们都要有
  ///   一个长方形的按钮轮廓。"*
  ///   ⇒ 那两颗**竖着叠成一列**（在录音圆圈的右边），**每颗都是长方形 ＋ 一圈轮廓**。
  ///
  /// 🔴 **两个档同一个形状**（他当天早些时候报过一次"打开聊天历史窗口后语音按键位置改变了"）：
  ///   那一列**一直在**，展开那颗只在收起档**画**（展开档留一个等大的空格）
  ///   ⇒ 语音圆圈与它左边那句字**一个像素都不动**。
  ///   ⚠️ 收起来的出口**仍然只有**标题行右端那颗「收起」（不新造第二条路）。
  Widget _bottomRow(DshPalette p, {required bool collapsed}) => Row(
        children: [
          Expanded(child: widget.composer),
          // ★ **那一列：两块合起来正好跟录音那颗圆圈一样高**（主人 2026-10-05：
          //   *"展开关闭，播放语音两个合起来，高度应该和录音按钮是一样的。"*）
          //   做法：外面那两格仍是 44 高（手指打得到，D3.6），但**看得见的面**贴着
          //   内沿（上面那颗贴下沿、下面那颗贴上沿）⇒ 两块 + 中间那条缝 = 64。
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // ★ **上下两颗里上面那颗：位置永远不动，只是"翻个方向"**
              //   （主人 2026-10-05：*"那个展开窗口，你要帮我把它变成展开以后是变成缩小窗口的
              //   按钮啊，所以它位置就不变"*）—— 收起档是「展开」（平箭头朝上）；
              //   展开档就它自己变成「收起」（朝下，点一下收回去）。
              _handle(p, collapsed: collapsed, alignBottom: true),
              const SizedBox(height: d.voiceAuxGap),
              // 念不出来的设备**一个按钮都不画**（`onToggleSpeak` 传 null）——
              // ⚠️ 但**那一格留着**：不留的话这一列会矮一半 ⇒ 上面那颗面与圆圈
              //    对不齐（"他们是一体的"就散了）。位置恒定比省那 44 像素重要。
              if (widget.onToggleSpeak != null)
                _speakButton(p)
              else
                const SizedBox(width: d.voiceAuxW, height: d.voiceAuxH),
            ],
          ),
          const SizedBox(width: d.gapS),
        ],
      );

  /// 那一列里每颗按钮的**共同样子**：外面是**透明的一格**（只撑命中区 ≥44），
  /// 里面那块**看得见的长方形**由 [_auxFace] 画（**有底色 ＋ 一圈轮廓**）。
  ///
  /// ⚠️ 尺寸住 `design.dart`：`voiceAuxW/H` = 手势能打到的那一格（D3.6 硬闸量的就是它），
  ///    `voiceAuxFaceW/H` = 看得见的那一块（主人 2026-10-05："可以缩小一些，然后需要底色的"）。
  ButtonStyle _auxStyle() => TextButton.styleFrom(
        minimumSize: const Size(d.voiceAuxW, d.voiceAuxH),
        padding: EdgeInsets.zero,
        // ⚠️ Material 默认 `padded` 会把盒子撑到 48 ⇒ 与"空位"那一格差 4 像素
        //    （2026-10-05 判据当场量到 506 vs 510）⇒ shrinkWrap 让它就是那个尺寸
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      );

  /// **看得见的那一块**：长方形 ＋ 底色（开着的时候是琥珀底白图形，关着是"边框色的透明版"墨图形）。
  ///
  /// 🔴 它必须**小于**外面那一格 —— 这是 D3.6 那条"视觉仍小、命中区撑够"的落点。
  Widget _auxFace(DshPalette p, {required bool lit, required Widget child}) => Container(
        width: d.voiceAuxFaceW,
        height: d.voiceAuxFaceH,
        decoration: BoxDecoration(
          // ★ 底色（主人 2026-10-05 要的"要底色"；2026-10-06 定"边框色 + 80% 透明"）：
          //   两层 —— **纸色 @80%**（下层，理由见 `design.dart` 的 `accentFace` 那段：
          //   没有它，深色壁纸下墨色图形会看不见）＋ **琥珀 @20%**（上层，见下面那个孩子）。
          //   开着时整块变琥珀 —— 状态一眼看得出。
          color: lit ? d.accent : d.faceBase,
          borderRadius: BorderRadius.circular(d.voiceAuxRadius),
          // 🔴 **风格统一**（主人 2026-10-05）：与录音那颗圆圈**同一圈琥珀色、同一个粗细**
          //   —— 三颗长得是同一套东西，只是形状（圆 / 长方）不同。
          border: Border.all(color: d.accent, width: d.voiceCircleRing),
        ),
        child: DecoratedBox(
          // 上层那 20% 的琥珀（开着时整块已经是琥珀了 ⇒ 不再叠）
          decoration: BoxDecoration(
            color: lit ? const Color(0x00000000) : d.accentFace,
            borderRadius: BorderRadius.circular(d.voiceAuxRadius),
          ),
          child: Center(child: child),
        ),
      );

  /// **上面那一颗**：收起档是「展开」（箭头朝上），展开档是「收起」（箭头朝下）。
  ///
  /// 🔴 **2026-10-05 主人**：*"那个展开窗口，你要帮我把它变成展开以后是变成缩小窗口的按钮啊，
  ///   所以它位置就不变"* ⇒ **同一颗按钮**（同一个 key、同一个位置、同一个样子），
  ///   只是**朝上/朝下**、**按下去做的事**跟着这一档换。
  ///   ⚠️ 展开档**不再留空格**了（那正是他说的"变成缩小窗口的按钮"）。
  /// ⚠️ **单击 = 一次拉满 / 一次收起**（不再有"半开"、也不再有"拖着改高度"）。
  /// ⚠️ 字挂在 `Tooltip`（web 上悬停看得见）＋ 无障碍名上。
  Widget _handle(DshPalette p, {required bool collapsed, bool alignBottom = false}) {
    final button = TextButton(
      key: chatHandleKey,
      onPressed: collapsed ? expand : collapse,
      style: _auxStyle(),
      // ⚠️ **高度要写死成那一格**（44）：外面那一列的高度是**无界**的，
      //    单摆一个 `Align` 会被框架自己那层 `Align(center)` 居中（实测：面与面之间
      //    变成 18 而不是 4）⇒ 给一个**确定高度**的盒子，面才真的贴住内沿。
      child: SizedBox(
        height: d.voiceAuxH,
        child: Align(
        // ⚠️ 上面那一颗的面**贴着下沿**（这样两块 + 那条缝才 = 圆圈那么高）
        alignment: alignBottom ? Alignment.bottomCenter : Alignment.topCenter,
        child: _auxFace(
          p,
          lit: false,
          child: CustomPaint(
            size: const Size(22, 6),
            // ★ 2026-10-06 主人：*「颜色风格要统一一下」* ⇒ 三颗的图形**同一个墨色**。
            //   ⚠️ 原来这里与下面那颗喇叭都是 `labelTertiary`（#81858C）—— 压在新的
            //     **那个浅色底**（`accentFace`）上只有 **2.85:1**（灰得发虚，放大看就是"洗过"）。
            //     换 `d.ink` ⇒ **11.8:1**，与录音那颗图形一个色。
            painter: _FlatChevron(color: d.ink, up: collapsed),
          ),
        ),
        ),
      ),
    );
    return Tooltip(
      message: collapsed ? '展开' : chatCollapse,
      child: Semantics(
        button: true,
        label: collapsed ? '展开' : chatCollapse,
        child: button,
      ),
    );
  }

  /// **播放语音**那一颗（**下面那颗** · 主人 2026-10-05）：*"所谓播放语音，就是开启和关停
  ///   的状态，如果开启，会将对 agent 的回复进行语音转换和实时播报。如果关闭，则不播报。"*
  ///
  /// * 开 = 实心喇叭 ＋ **琥珀色轮廓**（状态一眼看得出）；关 = 划掉的喇叭 ＋ 弱色轮廓；
  /// * 命中区 ≥44（D3.6 硬闸）；
  /// * 🔴 **念不出来的设备根本不画它**（调用处 `onToggleSpeak` 传 `null`）；
  /// * 字挂在 `Tooltip` 与无障碍名上（`models/speak_words.dart` 一处出处）。
  Widget _speakButton(DshPalette p) {
    final on = widget.speakOn;
    return Tooltip(
      message: on ? speakAutoHintOn : speakAutoHintOff,
      child: Semantics(
        button: true,
        toggled: on,
        label: speakAutoOnWords,
        child: TextButton(
          key: chatSpeakKey,
          onPressed: widget.onToggleSpeak,
          style: _auxStyle(),
          child: SizedBox(
            height: d.voiceAuxH,
            child: Align(
            // ⚠️ 下面那一颗的面**贴着上沿**（同上）
            alignment: Alignment.topCenter,
            child: _auxFace(
              p,
              lit: on,
              child: Icon(
                on ? Icons.volume_up_rounded : Icons.volume_off_rounded,
                size: d.voiceAuxIcon,
                // ★ 同上：关着的时候也是**墨色**（"关"这件事已经由底色与那条斜杠说清了，
                //   而 `labelTertiary` 压在这个底上只有 2.85:1 —— 发虚）
                color: on ? d.card : d.ink,
              ),
            ),
            ),
          ),
        ),
      ),
    );
  }
}

/// **一个"平"的小箭头**（浅角的 V 字那一笔）。
///
/// ⚠️ 为什么自己画：`Icons.keyboard_arrow_up` 那个角**太尖**，摆在一条杠上显得突兀
///    （主人原话：*"箭头比较平，所以不会显得那么突兀"*）
///    ⇒ 26×7 的框、2px 圆头笔画，画出来是很浅的一笔。
class _FlatChevron extends CustomPainter {
  const _FlatChevron({required this.color, required this.up});

  final Color color;

  /// 收起态朝上（"往上拉就能展开"），展开态朝下。
  final bool up;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;
    final w = size.width;
    final h = size.height;
    final path = Path();
    if (up) {
      path.moveTo(0, h);
      path.lineTo(w / 2, 0);
      path.lineTo(w, h);
    } else {
      path.moveTo(0, 0);
      path.lineTo(w / 2, h);
      path.lineTo(w, 0);
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _FlatChevron old) =>
      old.color != color || old.up != up;
}
