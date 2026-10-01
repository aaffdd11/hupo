// **桌面** —— **铺满整屏**的那一层（聊天浮窗**后面**那一层）。
//
// ── 形状是谁定的（两次才说清，都记下来）──────────────────
// 主人 2026-09-22 第一句：*"首先，页面底部是一个桌面。聊天窗口是一个左右上下 margin 为 30 的浮窗，有阴影。"*
// 我把它读成了"桌面=屏幕最下面那一条"（并且问过他，他当时也选了那一条）——
// **但那是读错了**。他看了真站点之后更正：*"桌面是全屏的，聊天窗口是在底部的。"*
// ⇒ 正确的形状：**桌面铺满整屏**（它是底图），**聊天浮窗贴在屏幕底部**浮着、四边各 30。
// ⇒ 契约 `docs/dev/52-DESKTOP.md`，手册 `08-SPEC.md` §六 Z4。
//
// ⚠️ **教训（值得留着）**：用户说"底部"时，可能是说**浮窗的位置**，也可能是说**桌面的位置** ——
//    这两个都合理，而选中错的那个，代价是一整套布局返工。
//    下一回遇到"底部/上面"这种词，**先让他看一眼两种摆法的截图**再动手。
//
// 手册里另外三件，这个文件是它们的落点：
//   · **D4.11 手机上第一入口 = 图标墙**（登录之后先看见的是它）；
//   · **一个作用域 = 一个工作区 = 一条会话 = 一个目录 = 桌面上一个图标**（1:1:1:1）；
//   · **点桌面空白 = 收起聊天浮窗**（`08-SPEC.md` §六 交互表）。
//
// ⚠️ 桌面上**只放"真能打开的"**（主人选：先只有「会话」一个）。
//    摆一个"点了没反应"的方块，是这个项目最忌的形状（"看着像有、其实是空的"）。
//
// ⚠️ **不用 `GestureDetector`**：`accessibility_test.dart` 有一条**源码级禁令**，
//    用它就等于让"命中区 ≥44"那份扫描多一个没人检查的缺口。点空白用 `InkWell`。

import 'dart:async';

import 'package:flutter/gestures.dart' show kPrimaryButton;
import 'package:flutter/material.dart';

import 'dart:math' as math;

import '../models/app_tint.dart';
import '../models/desktop_grid.dart';
import '../models/design.dart' as d;
import '../models/space_words.dart';
import '../models/wallpaper.dart';
import 'desktop_icon_menu.dart';

/// **小程序没给图标时用的那个**（主人 2026-09-22：*"设置要给一个默认 icon"*）。
///
/// ⚠️ 它必须是一个**写在代码里的常量**：`flutter build web` 默认会 tree-shake 图标字体，
///    只有**常量**才会被收进那份子集字体；运行时算出来的 `IconData` 会在线上**画不出来**
///    （而测试里是好的 —— 测试不 tree-shake）。⇒ 默认值放这里，别在调用处现造。
const IconData defaultAppIcon = Icons.widgets_outlined;

/// 桌面上一个图标。
///
/// ⚠️ `label` **必须给人看**（D3.8：不许只有一个无字图形）。
class DesktopApp {
  const DesktopApp({
    required this.label,
    required this.onOpen,
    this.icon = defaultAppIcon,
    this.badge = 0,
    this.id,
    this.onRemove,
    this.onRename,
    this.onCopy,
    this.isCreate = false,
  });

  final String label;
  final IconData icon;

  /// **它是谁**（可选）。给"图标要临时藏起来"用：扩开/收回那一格在动的时候，
  /// 桌面上这个图标必须**先消失**（不然两层图标叠在一起，看着像两个）。
  final String? id;

  /// **打开**。参数 = **这个图标在屏幕上的位置**（"从哪里打开，就从哪里扩开"）。
  /// ⚠️ 由图标自己量、自己报 —— 上层不用去猜它在哪儿（猜的话换个排布就错了）。
  final ValueChanged<Rect?> onOpen;

  /// **从桌面上删掉**（`null` = 这一格**不给**这个入口）。
  ///
  /// ★ 2026-09-25（契约 `docs/dev/103-APP-DELETE.md` §一）：
  ///   长按 / 右键 ⇒ 出那个小面板；只有**选了【从桌面上删掉】**才回调它。
  /// 🔴 内置那几格（设置 / 发现 /「我自己那台」）**传 `null`**：
  ///    它们**不在 `/api/apps` 里**，服务端那条路认不出它们 ⇒ 摆一个点下去
  ///    只会 404 的入口，就是"看着像有、其实是空的"（这个项目最忌的形状）。
  final VoidCallback? onRemove;

  /// **改个名字 / 复制一个**（契约 `docs/dev/104-APP-MENU.md` §一）。
  ///
  /// ⚠️ 和 [onRemove] 一样：`null` = 这一格不给那一项（内置那三个全传 `null`）。
  /// ⚠️ 三项**共用同一个面板**（按住 / 右键 ⇒ 出三项 + 取消）；只做其中一项
  ///    会得到"面板上有、点下去没反应"那种形状。
  final VoidCallback? onRename;
  final VoidCallback? onCopy;

  /// ★ **这一格是"创建一个小程序"那颗加号**（主人 2026-09-27：
  ///   *"帮我在 home 那边增加一个加号，要比较显著的有 UI 上面的区分，就是一个空心加号"*）。
  ///
  /// 🔴 它**只改长相**（空的、虚线的格子 ＋ 那个加号），**不改任何行为**：
  ///    点它走 [onOpen] 那一条（上层接的是"开那个新建的小程序那一层浮窗"）。
  /// ⚠️ 加号那一格**没有菜单**（不改名/不复制/不删）—— 那三样都由 `null` 挡着。
  final bool isCreate;

  /// 未读小点（`02-ARCHITECTURE.md`：**动作可静默，事实不能静默**）。
  /// `0` = 不画。⚠️ 现在还没有人给它赋值 —— 等真有"未读"这件事时再接。
  final int badge;
}

/// 图标格边长：**≥44** 是 D3.6 的硬要求。
///
/// ★ 2026-09-23（主人：*"先整理整个UI"*）**52 → 64**：目标用户是
///   "不会拼音 / 视力弱"的人（`01-PROJECT.md`），52 那一档在手机上看着像一粒纽扣。
///   判据 `test/widget/desktop_test.dart` 钉住"不许再缩回去"。
const double desktopIconBox = 64;

/// **加号那一格**里那个加号多大（比普通图标大一点：它没有名字可认，全靠形状）。
/// ⚠️ 它量的是**图形**；命中区仍由整个图标格（`desktopIconBox` ≥44）撑着。
const double desktopAddIconSize = 30;

/// 🔴 **两格之间最小间距**（2026-09-29 主人：*"app排布要根据页面宽度等宽排列"*）。
///
/// 布局模型（一句话）：**每行铺满那一条的可用宽** ——
///   · 一行的格数 = `min(放得下几格, 图标个数)`（放得下几格是按**这个最小间距**算的）；
///   · 每一格**等宽** = `(可用宽 − 间距×(格数−1)) / 格数`；
///   · 每格里那个方块**居中** ⇒ 一行从左边缘铺到右边缘，相邻两格之间一样宽。
/// ⚠️ 原来这里是"一格最多 96、按 4 列算" —— 宽屏上六七个图标全挤在左边三分之一
///    （1280 宽实测：右边空着一大半）。
/// ⚠️ **为什么是 20 而不是更小**：这个数决定"一行放得下几格"。取 16 时，
///    390 宽的手机上算出 **5 格**（每格只比图标格宽 1 像素 —— 挤）；
///    取 20 ⇒ **4 格**（每格 ≈82，图标之间留得开），与"手机仍是四列左右"对得上。
const double desktopTileMinGap = 20;

class AppDesktop extends StatelessWidget {
  const AppDesktop({
    super.key,
    required this.apps,
    required this.onTapBlank,
    this.header,
    // ★ 2026-09-24 主人：*"appicon 应该是动效结束后出现。所以打开的时候 appicon 应该是
    //   瞬间消失掉…退回到 app 的时候应该是动效结束的时候 appicon 出现。"*
    this.hideIconId,
    // ★ 2026-09-29：桌面那张**壁纸**（契约 `docs/dev/131-WALLPAPER.md`）。
    //   空串 = 不设（就是原来那张暖纸）；认不出来的 id 也走这一条。
    this.wallpaper = wallpaperNone,
  });

  final List<DesktopApp> apps;

  /// **桌面现在铺的是哪一张**（`''` = 不设 —— `models/wallpaper.dart`）。
  ///
  /// 🔴 它是**底图**，不是聊天窗口的背景：浮窗还是 `design.dart` 那张纸。
  /// 🔴 Z5 那三个"不许"照旧：**不接输入**（`IgnorePointer`）· **不说话**（一个字都不画）·
  ///    **不改排布**（图标墙的位置与命中区一毫米不动 —— 壁纸只在下面那一层）。
  final String wallpaper;

  /// **点空白**（不是点图标）⇒ 上层拿它收起聊天浮窗。
  final VoidCallback onTapBlank;

  /// 顶上一行（不参与点击 —— 它也是"点空白"的安全区）。
  final Widget? header;

  /// **哪一格的图标现在要藏起来**（`null` = 都正常画）。
  final String? hideIconId;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // ★ 2026-09-29：**壁纸在下面那一层**（`Stack` 底），图标墙与点击照旧在上面。
    //   🔴 `IgnorePointer`：底图**不接任何输入**（Z5 第一条）—— 点空白仍然是
    //      `InkWell` 那一条路，壁纸就算铺满了也抢不走一下点击。
    return Stack(
      children: [
        Positioned.fill(
          child: IgnorePointer(child: _WallpaperBackdrop(wallpaper)),
        ),
        Material(
          // 透明：底图那一层已经画了纸色（不设壁纸时就是原来那张暖纸）
          color: Colors.transparent,
          child: InkWell(
        // ⚠️ 点空白 = 收起聊天（§六 交互表）。splash 关掉：整屏闪一下不是反馈，是噪声。
        onTap: onTapBlank,
        splashColor: Colors.transparent,
        highlightColor: Colors.transparent,
        child: SafeArea(
          bottom: false, // 浮窗贴底 ⇒ 下面那条安全区由浮窗自己管
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (header != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    d.gapL,
                    d.gapM,
                    d.gapL,
                    d.gapS,
                  ),
                  child: header,
                ),
              Expanded(
                // ⚠️ 图标多了要能滚（窄屏 + 大字号下这一条是唯一稳的摆法）
                child: SingleChildScrollView(
                  // ★ 主人 2026-09-22：*"桌面排布好一点，我看小程序图标顶部 Margin 可以增加一些。"*
                  //   ⇒ 顶部留白从 8 提到 **48**（`gapL * 2`），横向仍是 24，图标之间给足间距。
                  padding: EdgeInsets.fromLTRB(
                    d.gapL,
                    d.gapL * 2,
                    d.gapL,
                    d.gapL,
                  ),
                  // ★ 2026-09-29：**一行铺满那一条的可用宽**（见 `gridFor`）。
                  //   `LayoutBuilder` 量的就是"padding 里面那一条"（横向两边各 `gapL`）。
                  child: LayoutBuilder(
                    builder: (context, cons) {
                      // ⚠️ 规矩本身住 `models/desktop_grid.dart`（纯函数，VM 上直接量）
                      final grid = desktopGridFor(
                        width: cons.maxWidth,
                        count: apps.length,
                        iconBox: desktopIconBox,
                        minGap: desktopTileMinGap,
                      );
                      final rows = <Widget>[];
                      for (var i = 0; i < apps.length; i += grid.columns) {
                        final end = math.min(i + grid.columns, apps.length);
                        final row = apps.sublist(i, end);
                        rows.add(
                          Padding(
                            padding: const EdgeInsets.only(bottom: d.gapL),
                            child: Row(
                              // 🔴 **2026-10-01 改成贴左**（主人：「app 都有位置。要模拟苹果的
                              //   桌面排布。」）—— 满行时"贴左"与"居中"是同一件事
                              //   （`cols*slot + (cols-1)*gap == 可用宽`，一行正好铺满）；
                              //   末行不满时，苹果是**从左边接着排**，不是把那一组摆到中间。
                              //   ⚠️ 列数现在只由屏幕定（`desktop_grid.dart`）⇒ 加一个 app
                              //     已有的那几个**一格都不动**。
                              mainAxisAlignment: MainAxisAlignment.start,
                              children: [
                                for (var k = 0; k < row.length; k++) ...[
                                  if (k > 0)
                                    const SizedBox(width: desktopTileMinGap),
                                  _DesktopIcon(
                                    app: row[k],
                                    width: grid.slot,
                                    // 正在扩开/收回的那一格：**图标先消失**
                                    //（占位留着，界面不跳）
                                    hideIcon: row[k].id != null &&
                                        row[k].id == hideIconId,
                                  ),
                                ],
                              ],
                            ),
                          ),
                        );
                      }
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          ...rows,
                          // ★ 2026-09-23：桌面上原来**一句引导都没有** ——
                          //   第一次进来的人看到的是几个陌生图标 + 一片空白。
                          //   ⚠️ 只说"点一下会怎样"，**不许承诺任何做不到的事**。
                          Text(
                            desktopHint,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: d.muted,
                            ),
                          ),
                        ],
                      );
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
      ],
    );
  }
}

/// **桌面那张底图**（用户挑的那一张；不设 = 原来那张暖纸）。
///
/// 三条纪律（`docs/dev/131-WALLPAPER.md` §一）：
///   ① **不设 / 认不出来 / 图读不出来** ⇒ 一律回到那张暖纸 —— **桌面绝不打不开**；
///   ② **上面罩一层纸色**（`d.wallpaperScrim`）：壁纸是用户自己挑的（深的、花的都有），
///      而图标名是墨色画的 ⇒ 没这层罩字会掉进图里；
///   ③ **一个字都不画**（Z5 第二条）：这一层只有图 ＋ 罩色。
class _WallpaperBackdrop extends StatelessWidget {
  const _WallpaperBackdrop(this.wallpaper);

  final String wallpaper;

  @override
  Widget build(BuildContext context) {
    final asset = wallpaperAssetOf(wallpaper);
    if (asset == null) return const ColoredBox(color: d.paper);
    return ColoredBox(
      // 图还没解码出来 / 读坏了：底下那一层先顶上（不会闪白）
      color: d.paper,
      child: Stack(
        fit: StackFit.expand,
        children: [
          Image.asset(
            asset,
            // 换一张 ⇒ 建一个新的（否则 `Image` 会把上一张的帧留住）
            key: ValueKey<String>(asset),
            fit: BoxFit.cover,
            // 读不出来 ⇒ 静默回默认底（这里**不弹**任何东西：桌面不该因为一张图报错）
            errorBuilder: (_, _, _) => const ColoredBox(color: d.paper),
          ),
          const ColoredBox(color: d.wallpaperScrim),
        ],
      ),
    );
  }
}

class _DesktopIcon extends StatefulWidget {
  const _DesktopIcon({
    required this.app,
    required this.width,
    this.hideIcon = false,
  });

  final DesktopApp app;
  final double width;

  /// 图标藏起来（**只藏图标**：格子、阴影、标签都留着 —— 位置一个像素都不动）。
  final bool hideIcon;

  @override
  State<_DesktopIcon> createState() => _DesktopIconState();
}

/// **按住多久算"按住"**（契约 `104` §二）。
///
/// ⚠️ **刻意比平台那个 `kLongPressTimeout`（500ms）短**：主人 2026-09-25 在手机浏览器上
///    实测"按住反而把它点开了" —— 真手指那一下常常按不满 500ms，而**一失手就算点了一下**。
/// ⚠️ 数值**住代码**（手册纪律 1：阈值不写文档）。
const Duration _holdFor = Duration(milliseconds: 420);

/// 按住期间**手指最多许挪多少**（逻辑像素）还能算"按住"。
///
/// ⚠️ **刻意比 `kTouchSlop`（18）宽**：真手指按住时是会挪的；挪出这条线就当"他在划"，
///    把计时器撤掉（那时候松手就是普通一下 —— 交回 `InkWell` 那套）。
/// ⚠️ 数值**住代码**。
const double _holdSlop = 28;

class _DesktopIconState extends State<_DesktopIcon> {
  Timer? _hold;
  Offset? _downAt;

  /// **这一次按已经"按住过"了** ⇒ 松手那一下不许再当"点开"（见 `onTap` 里那一挡）。
  bool _heldOnce = false;

  /// 这一格给不给那个面板（三项里**任意一项**给了就给）。
  bool get _hasMenu =>
      widget.app.onRename != null ||
      widget.app.onCopy != null ||
      widget.app.onRemove != null;

  @override
  void dispose() {
    _hold?.cancel();
    super.dispose();
  }

  /// 按下：**只认主键/手指**（右键那一路走 `onSecondaryTap`，别在这儿也起一个计时器）。
  void _onDown(PointerDownEvent e) {
    if (!_hasMenu) return;
    if (e.buttons != kPrimaryButton) return;
    _downAt = e.position;
    _hold?.cancel();
    _hold = Timer(_holdFor, () {
      _heldOnce = true;
      if (mounted) _askMenu(context);
    });
  }

  /// 按住期间挪出容差 ⇒ 他是在划，不是在按。
  void _onMove(PointerMoveEvent e) {
    final at = _downAt;
    if (at == null) return;
    if ((e.position - at).distance > _holdSlop) {
      _hold?.cancel();
      _hold = null;
    }
  }

  void _onUp(PointerEvent e) {
    _hold?.cancel();
    _hold = null;
    _downAt = null;
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final app = widget.app;
    final width = widget.width;
    final hideIcon = widget.hideIcon;
    // 🔴 **图标 + 它下面那行字，一起可点**（2026-09-22 实测抓到的）：
    //    第一版把 `InkWell` 只包在图标格上，**字在外面** ⇒ 点字落到了"点桌面空白"上
    //    （于是"点设置"变成"收起聊天"，而且判据还照样绿 —— 扫的是桌面，不是设置那一屏）。
    //    ⚠️ 字才是人第一眼看到的靶子，它必须能点。
    return Listener(
      // ⚠️ `deferToChild`（默认）：只有落在这一格上才算 —— 桌面空白处不受影响
      onPointerDown: _onDown,
      onPointerMove: _onMove,
      onPointerUp: _onUp,
      onPointerCancel: _onUp,
      child: SizedBox(
        width: width,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
          onTap: () {
            // 🔴 **按住过 ⇒ 这一下不算"点开"**（契约 `104` §二）：
            //    不吞掉的话，手机上"按住了 600ms"最后仍会把小程序打开 ——
            //    那正是主人报的那个形状。
            if (_heldOnce) {
              _heldOnce = false;
              return;
            }
            // ★ **"从哪里打开"**：把图标此刻在屏幕上的矩形报上去
            final box = context.findRenderObject() as RenderBox?;
            final rect = (box != null && box.hasSize)
                ? box.localToGlobal(Offset.zero) & box.size
                : null;
            app.onOpen(rect);
          },
          // ★ 2026-09-25（契约 `docs/dev/104-APP-MENU.md` §二）：
          //   **按住（手机 / 网页）与右键（桌面端）走同一个面板**。
          // 🔴 **按住那一半不再交给 `InkWell.onLongPress`** —— 主人 2026-09-25 在**手机**
          //    上实测：*"长按没有别（被）劫持，而是点开小程序了。"*
          //    根因：`onLongPress` 要"按住满 500ms **且**手指不挪出 18 逻辑像素"，
          //    真手指两样都容易失手 ⇒ **一失手，松手就照旧算"点了一下"**（于是把小程序点开了）。
          //    ⇒ 改成**自己按住**（`Listener` + 计时器 + 更宽的容差，见 [_DesktopIconState]），
          //    到点出面板，并把松手那一下**吞掉**。
          // ⚠️ 仍然用 `InkWell` 接"点一下"与右键，**不许**引入裸 `GestureDetector`：
          //    `test/widget/accessibility_test.dart` 有一条源码级硬闸
          //    （裸 GestureDetector = 命中区 ≥44 那道扫描多一个没人检查的缺口）。
          onSecondaryTap: _hasMenu ? () => _askMenu(context) : null,
          borderRadius: BorderRadius.circular(d.radiusCard),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // 图标格：**永远是那个小方块**（`desktopIconBox`，≥44 见 D3.6）
              Container(
                width: desktopIconBox,
                height: desktopIconBox,
                decoration: BoxDecoration(
                  // ★ 加号那一格：**空的 + 一圈虚线** ⇒ 一眼看出"这是个空位，点它能加"
                  //   （主人要的"比较显著的 UI 区分"）；其余那几格照旧是阴影。
                  // ★ 2026-09-29 主人：*"所有小程序的icon都需要一个背景颜色。不同的背景颜色。"*
                  //   ⇒ 底色**按这个 app 的身份算**（`appTintFor`，同一个 app 永远同一色；
                  //     没有 id 的用名字兜底 —— 桌面上不许出现"没底"的一格）。
                  //   ⚠️ 图标本身还是**墨色**（下面那行），底色那一族都够浅（见 `app_tint.dart`）。
                  color: app.isCreate ? Colors.transparent : appTintFor(app.id ?? app.label),
                  borderRadius: BorderRadius.circular(d.radiusCard),
                  // ★ 主人 2026-09-22：*"小程序图标要有阴影。"*
                  //   浅一点（图标是一小块，用浮窗那种 α.45 会脏）
                  // ⚠️ 这三个数**住 `design.dart`**（`tileShadow*`）：小程序扩开那一层
                  //    的**起点就是它**，两处必须是同一份（主人 2026-09-23 报的"没有阴影"）。
                  boxShadow: app.isCreate
                      ? const <BoxShadow>[]
                      : [
                          BoxShadow(
                            color: d.ink.withValues(alpha: d.tileShadowAlpha),
                            blurRadius: d.tileShadowBlur,
                            offset: const Offset(0, d.tileShadowDy),
                          ),
                        ],
                ),
                child: Stack(
                  children: [
                    Center(
                      child: Opacity(
                        opacity: hideIcon ? 0 : 1,
                        child: Icon(
                          app.icon,
                          color: app.isCreate ? d.muted : d.ink,
                          // 加号那一格：**大一点**（它没有名字可认，全靠形状）
                          size: app.isCreate ? desktopAddIconSize : null,
                        ),
                      ),
                    ),
                    if (app.badge > 0)
                      Positioned(
                        top: d.gapS,
                        right: d.gapS,
                        child: Container(
                          width: 10,
                          height: 10,
                          decoration: const BoxDecoration(
                            color: d.accent,
                            shape: BoxShape.circle,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 6),
              // ⚠️ **带字的**（D3.8：图标不许只有图形）
              Text(
                app.label,
                // ★ 2026-09-23：`bodySmall`(≈12) → `bodyMedium`(≈14)；
                //   **最多两行**：名字长了不许把格子撑破（同 D4.8"界面自己抖"那一族）。
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: t.textTheme.bodyMedium?.copyWith(color: d.ink),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
      ),
    );
  }

  /// **按住 / 右键 ⇒ 出那个小面板**（契约 `104` §一）。
  ///
  /// ★ 2026-09-25 主人：*"我建议弹窗从页面上方跳出。"* ⇒ **从上面下来**
  ///   （原来是底栏那个 `showModalBottomSheet`）。
  ///
  /// ⚠️ 这一层**只问"选了哪一项"**：发请求、重拉清单、失败时怎么说，全在 `screens/`
  ///    那一层（`widgets` 是傻组件，**不许**碰 `services` —— 楼层闸）。
  /// ⚠️ 用户点了面板外面 / 系统返回键 ⇒ 回 `null` ⇒ 什么都不做
  ///    （"取消"和"点外面"是同一件事，这是这一层的既有语义）。
  Future<void> _askMenu(BuildContext context) async {
    final action = await showGeneralDialog<DesktopIconAction>(
      context: context,
      barrierDismissible: true,
      // 无障碍：读屏要知道"这层遮罩点一下就关"
      barrierLabel: MaterialLocalizations.of(context).modalBarrierDismissLabel,
      barrierColor: Theme.of(context).colorScheme.scrim.withValues(alpha: 0.4),
      transitionDuration: d.motionPage,
      pageBuilder: (_, _, _) => const _TopPanel(child: DesktopIconMenu()),
      transitionBuilder: (_, anim, _, child) => SlideTransition(
        // ⚠️ `-1` = 从屏幕上方外面滑进来（主人要的就是这个"跳出来"的方向）
        position: Tween<Offset>(
          begin: const Offset(0, -1),
          end: Offset.zero,
        ).animate(anim),
        child: child,
      ),
    );
    switch (action) {
      case DesktopIconAction.rename:
        widget.app.onRename?.call();
      case DesktopIconAction.copy:
        widget.app.onCopy?.call();
      case DesktopIconAction.remove:
        widget.app.onRemove?.call();
      case null:
        break; // 点外面 / 返回键 = 取消
    }
  }
}

/// **贴着页面上边那一层**（主人 2026-09-25：*"我建议弹窗从页面上方跳出。"*）。
///
/// ⚠️ 只圆下面两个角（上面是屏幕边）；`SafeArea` 让出刘海/状态栏那一条。
class _TopPanel extends StatelessWidget {
  const _TopPanel({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.topCenter,
      child: Material(
        color: cs.surface,
        borderRadius: const BorderRadius.vertical(
          bottom: Radius.circular(d.radiusCard),
        ),
        child: SafeArea(bottom: false, child: child),
      ),
    );
  }
}
