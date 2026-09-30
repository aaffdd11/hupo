// **「配置」** —— 页面上随时能唤起的那一屏（契约 `docs/dev/48-SETTINGS-KEY.md`）。
//
// 主人 2026-09-22：*"用户可以在页面唤起配置。配置上可以输入 apikey"*。
//
// ── 为什么要有它 ──────────────────────────────────────────
// 钥匙原来**只有**第一次那条流程能填：填过之后就再也回不去那一屏了
// （只有"被判无效"之后刷新页面才碰巧回得去 —— 那是欠账 #34）。
// ⇒ 换一把钥匙、或者"我到底有没有填过"，用户**没有地方可去**。
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① **现状要如实**：有三种状态（有 / 没填过 / 填过但被判无效），
//      它们必须**分得开**（`keyStateLine`）—— 混成一句就是页面在说假话；
//   ② **换掉要说清**：已经有一串时，上面明说"填一串新的就会把它换掉"；
//   ③ **不新增第二份真相**：表单就是 `widgets/key_form.dart` 那一块，
//      和第一次进来那一屏**用的是同一个东西**。
//
// ⚠️ 界面上**没有** `模型` / `工具` / `客户端` 这些词（词表硬闸会拦）。

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';

import '../models/app_spec.dart';
import '../models/appearance.dart';
import '../models/design.dart' as d;
import '../models/dsh_design.dart';
import '../models/image_outcome.dart';
import '../models/space.dart';
import '../models/space_words.dart';
import '../models/voice_record.dart';
import '../models/voice_try.dart';
import '../models/wallpaper.dart' show wallpaperLabel;
import '../services/api.dart';
import '../widgets/app_grants_card.dart';
import '../widgets/cancel_account.dart';
import '../widgets/cred_form.dart';
import '../widgets/dsh_look.dart';
import '../widgets/image_try.dart';
import '../widgets/key_form.dart';
import '../widgets/voice_record.dart';
import '../widgets/voice_try.dart';
import '../widgets/wallpaper_picker.dart';
import 'about_screen.dart';

/// 顶层那一列的 key（判据要"像用户那样滚这一列"，不许靠 `.first` 撞）。
///
/// ⚠️ 设置改成列表之后，页面上**有不止一个** `Scrollable`（子页各自还有一列）
///    ⇒ 判据必须指名道姓到**顶层这一列**。
const ValueKey<String> settingsListKey = ValueKey('settings:list');

/// 四个 tab 的名字（**顺序＝主人说的顺序** · `space_words.dart` 里那四个常量）。
const List<String> credTabs = [credTabChat, credTabVoice, credTabImage, credTabVideo];

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    super.key,
    required this.hasKey,
    required this.keyBad,
    required this.onSubmit,
    this.creds = const SpaceCreds(),
    this.voiceReady = false,
    this.onSubmitCreds,
    this.onDrawImage,
    this.voiceTry,
    this.voiceRecord,
    this.canHear = false,
    this.localOnly = false,
    this.onCancel,
    this.onCancelled,
    this.onKeyChanged,
    this.onLogout,
    this.appearance = const ChatAppearanceSettings(),
    this.onAppearanceChanged,
    this.onFontSizeChanged,
    this.wallpaper = '',
    this.onWallpaperChanged,
    this.appearanceLive,
    this.wallpaperLive,
    this.apps = const [],
    this.onGrant,
    this.onClear,
  });

  /// 现在有没有一串能用的钥匙（服务端说的）。
  final bool hasKey;

  /// **那四样有没有**（主人 2026-09-24：配置页就是配这四样）。
  /// ⚠️ 老服务端不回它 ⇒ 全 `false`（"没有"），四个 tab 里就都会说"还没有填"。
  final SpaceCreds creds;

  /// ★ **语音这条路现在能不能用**（他自己的两样 **或** 这台机器上那份）。
  /// 🔴 语音那一屏的边界句靠它分档：能用 ⇒"先收着（机器上那份在用）"；
  ///    不能用 ⇒"还没有填，填上这两样我才能听懂你说话"。⚠️ 缺省 `false`（不吹牛）。
  final bool voiceReady;

  /// **画一张图**（P1-27）：图片那一屏下面的「试一张」用它。
  /// ⚠️ `null` ⇒ 不画那一块（这条路没接上时**不给假按钮**）。
  final Future<ImageOutcome> Function(String prompt)? onDrawImage;

  /// ★ **试一下语音**（批 7 · 主人 2026-09-26）：语音那一屏那颗按钮用它。
  ///
  /// 🔴 **钥匙只有一条路**（这一批的硬要求）：这颗按钮**不碰任何钥匙**，
  ///    它只把麦克风那段音频送到 `/api/asr`（和聊天里那颗话筒**同一个地址、
  ///    同一个服务**：`services/hearing.dart`）。服务端按**验过签的身份**
  ///    现取凭据（`v2/services/core/src/asr-creds.js` 的 `voiceCredsFor`），
  ///    读的就是**上面这个表单写进去的那一份**（`/api/creds` ⇒
  ///    `data/creds/<他>.yaml`）。⇒ 这里**不许**再存一份钥匙、也不许另算一个地址。
  ///
  /// ⚠️ `null` ⇒ 不画那一块（这条路没接上时**不给假按钮**）。
  final VoiceTryHandlers? voiceTry;

  /// ★ **录一段（录音 ＋ 回放）**（主人 2026-09-27）：只有"语音"那一屏、而且接线了才给。
  /// ⚠️ 它与 [voiceTry] **刻意不同**：这一块**一个字节都不往外发**
  ///    （录下来只在这台设备上放），所以它**不关心有没有钥匙**。
  final VoiceRecordHandlers? voiceRecord;

  /// 这个页面**开得了麦吗**（`services/hearing.dart` 的 `canHear`）。
  /// ⚠️ 假 ⇒ 那颗按钮**照画**，点下去只说一句白话（不装开麦 —— 同聊天那颗话筒）。
  final bool canHear;

  /// **某一屏填好了要送出去**（tab 的名字 ＋ 那一屏的值）。
  ///
  /// ⚠️ 与 `onSubmit`（聊天那一把的老路）分开：老路只写语言那一把，
  ///    而这一条**一次能写一屏的字段**（语音那三样必须一起写）。
  final Future<KeySend> Function(String tab, Map<String, String> values)? onSubmitCreds;

  /// 有没有"填过、但上游说它不灵"（服务端说的）。
  final bool keyBad;

  final Future<KeySend> Function(String key) onSubmit;
  final Future<CancelOutcome> Function()? onCancel;
  final VoidCallback? onCancelled;

  /// 🔴 **"你自己这一份"那种（没有单独一台）** ⇒ 不给钥匙表单，只说实话。
  final bool localOnly;

  /// 换成功之后叫一声（上层去重问一次状态，让别处也跟着对）。
  final VoidCallback? onKeyChanged;

  /// **退出登录**（主人 2026-09-22：*"桌面上应当有一个设置的小程序，用来退出登录，
  /// 注销账号，修改 apikey。"*）
  /// ⚠️ 它**原来挂在聊天抓手行上**（一个 logout 图标）—— 现在搬进来了：
  ///    那一行是"聊天"的地方，而退出登录不是聊天的事。
  final VoidCallback? onLogout;

  // ── ★ 批次 4：「这块窗口」那两行（契约 `docs/dev/119`）──────────────

  /// 现在选的是哪一档外观 ＋ 多大的字。
  /// ⚠️ 状态**不住在这儿**（住 `ChatScreen`）：这一屏只是那两行的入口 ——
  ///    两份状态 = 迟早会漂（同一件事两个真相是这个项目的老毛病）。
  final ChatAppearanceSettings appearance;

  /// 换了外观 / 换了字号 ⇒ 交给上层（它写盘 ＋ 让聊天面当场跟着变）。
  /// ⚠️ `null` = 这一条路没接上（单看这一屏的判据）⇒ 那两颗控件**按不动**，
  ///    但**不许**因此画一个假的当前值（见 `_formFor` 那条同一条纪律）。
  final ValueChanged<ChatAppearance>? onAppearanceChanged;
  final ValueChanged<int>? onFontSizeChanged;

  /// 桌面现在用的是哪一张壁纸（`''` = 不设 —— `models/wallpaper.dart`）。
  final String wallpaper;

  /// 换了壁纸 ⇒ 交给上层（它写盘 ＋ 让桌面当场换）。
  /// ⚠️ `null` = 这一条路没接上 ⇒ 壁纸那一页**照样画**（选不了才怪），
  ///    但**不假装已经换了**（`onPick` 里只有接了线才回调）。
  final ValueChanged<String>? onWallpaperChanged;

  // ── ★ 2026-09-29：**子页要看"现在是多少"**（不是推出去那一刻的）──────────
  //
  // 🔴 子页是 `push` 出来的**新路由** —— 它们**不在**上层那个 `setState` 的子树里，
  //    只拿一份快照的话会**按着旧值算**：实测「字号」那两步 14 →大一点→ 15，
  //    再按小一点 ⇒ **13**（而页面上那个数字还写着 14）—— 那正是"页面在说假话"。
  // ⇒ 这两条是可选的：接上了就**订阅**（`ValueListenableBuilder`），
  //    没接上（判据直接泵这一屏）就照字段里那份画。

  /// **会通知的那一份外观 ＋ 字号**（见上面那段）。
  final ValueListenable<ChatAppearanceSettings>? appearanceLive;

  /// **会通知的那一份壁纸**（同上）。
  final ValueListenable<String>? wallpaperLive;

  // ── ★ 2026-09-30：**注册制那张卡**（契约 `docs/dev/147-APP-SQLITE.md`）────────
  //
  // 主人原话：*「注册制，在设置里可以看到也可以关闭」*。
  // ⚠️ 清单就是 `/api/apps` 那一份（`permissions`＝它想要什么 · `granted`＝你给了没有）；
  //    这一屏**不自己拉** —— 状态住上面（同外观 / 壁纸那条：两份状态迟早会漂）。
  // ⚠️ 一个声明了东西的小程序都没有 ⇒ 那张卡**一个像素都不画**（`AppGrantsCard` 里判）。

  /// 「我的小程序」那一份清单（空 = 没有 / 还没拿到）。
  final List<MiniApp> apps;

  /// **答应它 / 现在不给**那一下（`POST /api/app-grant`）。
  /// ⚠️ `null` = 这条路没接上 ⇒ 卡上的开关**不给**（同"不给假按钮"那条纪律）。
  final Future<GrantOutcome> Function(String id, String permission, bool allow)?
  onGrant;

  /// ★ **清空它存下来的东西**那一下（`POST /api/app-db-clear` · 2026-10-01）。
  /// ⚠️ `null` = 这条路没接上 ⇒ 那颗按钮**不给**（同"不给假按钮"那条纪律）。
  final Future<ClearOutcome> Function(String id)? onClear;

  @override
  Widget build(BuildContext context) {
    // ⚠️ **没有 `Scaffold` / `AppBar`**：顶上那一条由**小程序容器**给
    //    （`MiniAppHost`）—— 小程序自己画的话，"跳不出容器"这件事就没了保证。
    // ★ 2026-09-29：**这一屏改成"一列分类"**（主人：*"现在帮我分类，选项有模型设置，
    //   点开才是设置模型。其他的也是列表中来做配置。包括壁纸。"*）
    //   顶层只有名目（每一项一行字 ＋ 一句小字），点开才是它自己的配置；
    //   子页左上角一行「回到设置」把人送回来。
    //   ⚠️ **没有 `Scaffold` / `AppBar`**（这一屏住在小程序容器里，同原来那条注释）；
    //      sub-page 也一样 —— 返回那一行是这一屏**自己画**的（容器不画顶栏）。
    return Center(
      child: ConstrainedBox(
        // ⚠️ **和首页同一条窄列**（契约 `49-STYLE.md`）：一行太长没人读得下去
        constraints: const BoxConstraints(maxWidth: 640),
        child: ListView(
          key: settingsListKey,
          padding: const EdgeInsets.symmetric(horizontal: d.gapL, vertical: d.gapL),
          children: [
            // ① 四把钥匙（**分开四项** —— 主人 2026-09-29 当场选的形状）
            _row(
              context,
              icon: Icons.key_outlined,
              label: settingsRowModel,
              hint: credStateLine(tab: credTabChat, has: hasKey, bad: keyBad),
              open: () => _open(context, credTabChat, settingsRowModel),
            ),
            _row(
              context,
              icon: Icons.mic_none_outlined,
              label: credTabVoice,
              hint: credStateLine(tab: credTabVoice, has: creds.voice, bad: false),
              open: () => _open(context, credTabVoice, credTabVoice),
            ),
            _row(
              context,
              icon: Icons.image_outlined,
              label: credTabImage,
              hint: credStateLine(tab: credTabImage, has: creds.image, bad: false),
              open: () => _open(context, credTabImage, credTabImage),
            ),
            _row(
              context,
              icon: Icons.movie_outlined,
              label: credTabVideo,
              hint: credStateLine(tab: credTabVideo, has: creds.video, bad: false),
              open: () => _open(context, credTabVideo, credTabVideo),
            ),
            // ② 壁纸（行上小字就说"现在用的是哪一张"）
            _row(
              context,
              icon: Icons.wallpaper_outlined,
              label: settingsRowWallpaper,
              hint: wallpaperLabel(wallpaper),
              open: () => _openWallpaper(context),
            ),
            // ③ 这块窗口
            _row(
              context,
              icon: Icons.tune,
              label: settingsAppearanceSection,
              hint: settingsAppearanceHint,
              open: () => _openPlain(
                context,
                settingsAppearanceSection,
                // 🔴 **订阅那一份"活的"**（子页不在上层 `setState` 的子树里）：
                //    不然步进器会按旧值算、上面那个数字也不再变。
                // ⚠️ `page` 是**这一条路由自己的** `context`（见 `_open` 那段批注）。
                (page) => _live<ChatAppearanceSettings>(
                  appearanceLive,
                  appearance,
                  (a) => _appearanceCard(page, a),
                ),
              ),
            ),
            // ④ ★ 2026-09-30：**注册制那张卡**（契约 `docs/dev/147-APP-SQLITE.md`）。
            //    ⚠️ 位置在"这块窗口"之后、"这个助手"那一组之前 —— 它是**小程序那一类**
            //       的配置，不是"关于/退出登录"那一类。
            //    ⚠️ 一个声明了东西的小程序都没有时它自己画零个像素（卡片内部判）。
            AppGrantsCard(apps: apps, onGrant: onGrant, onClear: onClear),
            const SizedBox(height: d.gapL),
            // ⑤ 关于 / 退出登录 / 注销账号（各是一条 —— 同一次定的形状）
            _row(
              context,
              icon: Icons.info_outline,
              label: aboutEntryTitle,
              hint: aboutEntryHint,
              open: () => _openAbout(context),
            ),
            _row(
              context,
              icon: Icons.logout,
              label: settingsLogout,
              hint: settingsLogoutHint,
              danger: true,
              open: () {
                onLogout?.call();
                Navigator.of(context).popUntil((r) => r.isFirst);
              },
            ),
            if (onCancel != null || onCancelled != null)
              _row(
                context,
                icon: Icons.delete_outline,
                label: settingsCancelAccount,
                hint: settingsCancelAccountHint,
                danger: true,
                open: () => _openPlain(
                  context,
                  settingsCancelAccount,
                  (page) => _cancelAccountCard(page),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// 一列里的一行（**可点区域 ≥44**：整行都是热区 —— D3.6）。
  Widget _row(
    BuildContext context, {
    required IconData icon,
    required String label,
    required String hint,
    required VoidCallback open,
    bool danger = false,
  }) {
    final t = Theme.of(context);
    final color = danger ? d.accent : d.ink;
    return Padding(
      padding: const EdgeInsets.only(bottom: d.gapS),
      child: Card(
        child: InkWell(
          onTap: open,
          borderRadius: BorderRadius.circular(d.radiusCard),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: d.gapM, vertical: d.gapM),
            child: Row(
              children: [
                Icon(icon, color: color),
                const SizedBox(width: d.gapM),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        label,
                        style: t.textTheme.titleMedium?.copyWith(
                          color: color,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        hint,
                        style: t.textTheme.bodySmall?.copyWith(color: d.muted),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                Icon(Icons.chevron_right, color: d.muted),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 某个分类那一页（**左上角一行"回到设置"** —— 容器不画顶栏，所以这一行必须自己画）。
  ///
  /// ⚠️ **这一页自己带一层 `Material`**（透明那一种）：它是 `push` 出来的**一条新路由**，
  ///    而路由是 `Navigator` 的孩子 —— **不在**原来那个 `Scaffold` 的 `Material` 里面
  ///    （实测：壁纸那 28 格的 `InkWell` 在这里当场报 "No Material widget found"）。
  ///    没有它，子页里所有按钮的水波都没了（debug 下还会直接断言失败）。
  ///    透明：底还是容器那一层，这一层只为"按钮有纸可印"。
  Widget _subPage(BuildContext context, String title, Widget body) {
    final t = Theme.of(context);
    return Material(
      type: MaterialType.transparency,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(d.gapS, d.gapS, d.gapL, 0),
            child: Row(
              children: [
                TextButton.icon(
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(Icons.arrow_back, size: 20),
                label: const Text(settingsBack),
                style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
              ),
              const SizedBox(width: d.gapS),
              Expanded(
                child: Text(
                  title,
                  style: t.textTheme.titleSmall?.copyWith(color: d.muted),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              ],
            ),
          ),
          Expanded(child: body),
        ],
      ),
    );
  }

  /// **订阅一份"活的"值**（接上了订阅，没接上就用手里那份快照画）。
  ///
  /// ⚠️ 子页是新路由 —— 它们看不到上层 `setState` 的重建（见 [appearanceLive] 那段）。
  Widget _live<T>(ValueListenable<T>? live, T snapshot, Widget Function(T) build) {
    if (live == null) return build(snapshot);
    return ValueListenableBuilder<T>(
      valueListenable: live,
      builder: (_, v, _) => build(v),
    );
  }

  // 🔴 **子页一律用"这一条路由自己的 `context`"建**（`builder: (page) => ...`）。
  //    原来传的是**列表那一页的** `context`：那一页被拆掉（小程序关掉 / 判据收尾）
  //    之后路由还会重建一次，而 `Theme.of(那个已经失效的 context)` 会当场抛
  //    "Looking up a deactivated widget's ancestor is unsafe"（实测抓到的）。
  //    ⇒ 谁的孩子就用谁的 `context`，这是 Flutter 那条规矩本身。
  void _open(BuildContext context, String tab, String title) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (page) => _subPage(page, title, _tabBody(page, tab)),
    ));
  }

  void _openPlain(BuildContext context, String title, Widget Function(BuildContext) body) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (page) => _subPage(
        page,
        title,
        ListView(
          padding: const EdgeInsets.symmetric(horizontal: d.gapL, vertical: d.gapM),
          children: [body(page)],
        ),
      ),
    ));
  }

  void _openWallpaper(BuildContext context) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (page) => _subPage(
        page,
        settingsRowWallpaper,
        // 🔴 同「这块窗口」：那一格"打勾的是哪一张"必须跟着**现在**那张走。
        _live<String>(
          wallpaperLive,
          wallpaper,
          (w) => WallpaperPicker(
            wallpaper: w,
            onPick: (id) {
              onWallpaperChanged?.call(id);
              // 选完就回去（他刚做完一件事；留在这一页反而要多按一次）
              Navigator.of(page).pop();
            },
          ),
        ),
      ),
    ));
  }

  void _openAbout(BuildContext context) {
    // ⚠️ 「关于」那一页**自带** `Scaffold` ＋ 顶栏（它有自己的一列事实，
    //    与这一列子页不是一种形状）—— 照旧整页 push，不套 `_subPage`。
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => const AboutScreen(),
    ));
  }

  /// **「注销账号」那一页**：先把"会没掉什么"写在这儿（不是只藏在确认框里），
  /// 再摆那一个按钮 —— 它自己还带一次确认框（`widgets/cancel_account.dart`）。
  Widget _cancelAccountCard(BuildContext context) {
    final t = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(d.gapM),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              keyCancelWhat,
              style: t.textTheme.bodyMedium?.copyWith(color: d.ink),
            ),
            const SizedBox(height: d.gapM),
            CancelAccountEntry(
              label: settingsCancelAccount,
              danger: true,
              onCancel: onCancel!,
              onCancelled: onCancelled!,
            ),
          ],
        ),
      ),
    );
  }

  /// 一屏的内容（**每一屏自己可滚** —— 字放到最大时不许溢出）。
  Widget _tabBody(BuildContext context, String tab) {
    final t = Theme.of(context);
    final has = credsFor(tab);
    // ⚠️ 边界句要看**两件事**：是不是有自己一台（`localOnly` 的反面）、以及**他填过没有**。
    final boundary = credBoundaryOf(tab, isTenant: !localOnly, hasOwn: has, voiceReady: voiceReady);
    return ListView(
      // ⚠️ **给每一屏一个指名道姓的 key**（`credTab:<名字>`）：`TabBarView` 自己
      //    也是一个 `Scrollable`（横向翻页那一个），而且排在**前面**
      //    ⇒ 判据想"像用户那样滚内容"就必须指得到**这一列**，不能靠 `.first`。
      //    （2026-09-24 判据当场抓到的：滚错了对象 ⇒ "关于"永远滚不出来。）
      key: ValueKey('credTab:$tab'),
      padding: const EdgeInsets.symmetric(horizontal: d.gapL, vertical: d.gapL),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(d.gapM),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // ① 这一屏**管什么**
                Text(
                  credTabWhat(tab),
                  style: t.textTheme.bodyMedium?.copyWith(color: d.ink),
                ),
                const SizedBox(height: d.gapXs),
                // ② 现在**有没有**（三种状态分开说，见 `credStateLine`）
                Text(
                  credStateLine(tab: tab, has: has, bad: tab == credTabChat && keyBad),
                  style: t.textTheme.bodyMedium?.copyWith(color: d.ink),
                ),
                if (has && tab == credTabChat) ...[
                  const SizedBox(height: d.gapXs),
                  Text(configKeyHint, style: t.textTheme.bodySmall?.copyWith(color: d.muted)),
                ],
                // ③ 🔴 **这一批的边界**（图片/视频/语音：收下了 ≠ 现在就生效）
                if (boundary != null) ...[
                  const SizedBox(height: d.gapXs),
                  Text(boundary, style: t.textTheme.bodySmall?.copyWith(color: d.muted)),
                ],
                const SizedBox(height: d.gapM),
                // ④ 填的那一块
                ..._formFor(context, tab),
              ],
            ),
          ),
        ),
        // ⚠️ 2026-09-29：原来挂在这里的**「这块窗口」与「关于/退出登录」两张卡
        //    搬去**顶层那一列**当独立的两项了（主人要"分类、点开才是配置"）。
        //    ⇒ 这一页现在**只有这一样东西的配置**（它自己那几行 ＋ 表单）。
      ],
    );
  }

  /// 某一屏现在有没有（**聊天那一把看老字段**，其余三样看 `creds`）。
  bool credsFor(String tab) {
    return switch (tab) {
      credTabVoice => creds.voice,
      credTabImage => creds.image,
      credTabVideo => creds.video,
      _ => hasKey,
    };
  }

  /// 每一屏各自的表单。**聊天那一屏是老表单**（它带着粘贴与"取消注册"）。
  List<Widget> _formFor(BuildContext context, String tab) {
    if (tab == credTabChat) {
      return [
        if (localOnly) ...[
          // 🔴 **本机那一份**：2026-09-24 起**也能在这页填**
          //    （主人选了"要真能改"：语言那一把会写进他本机那份凭据里）。
          Text(
            configLocalOnly,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: d.muted),
          ),
          const SizedBox(height: d.gapS),
        ],
        KeyForm(
          // ⚠️ 换成功之后**顺手叫一声**（上层拿它去重问一次状态）——
          //    不然用户回到聊天页时，别处可能还挂着"没有钥匙"那句旧话。
          onSubmit: (k) async {
            final r = await onSubmit(k);
            if (r == KeySend.ok && context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text(configKeyChanged)),
              );
              onKeyChanged?.call();
            }
            return r;
          },
          onCancel: onCancel,
          onCancelled: onCancelled,
          submitLabel: hasKey ? keySubmitChange : keySubmit,
        ),
      ];
    }
    final send = onSubmitCreds;
    if (send == null) {
      // ⚠️ 没接线 ⇒ **不给假输入框**（宁可不画）：那条路不在，
      //    画一个填了没用的框就是"页面在说假话"。
      return [
        Text(keyFailed, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: d.muted)),
      ];
    }
    final fields = switch (tab) {
      credTabVoice => const [
          // ★ 豆包那两样（App ID ＋ Access Token）—— 控制台上就是这两个名字
          CredField(key: 'voiceAppId', label: credVoiceAppIdLabel),
          CredField(key: 'voiceAccessToken', label: credVoiceTokenLabel),
        ],
      credTabImage => const [CredField(key: 'image', label: credOneKeyLabel)],
      credTabVideo => const [CredField(key: 'video', label: credOneKeyLabel)],
      _ => const <CredField>[],
    };
    final draw = onDrawImage;
    final vt = voiceTry;
    final vr = voiceRecord;
    return [
      CredForm(
        fields: fields,
        submitLabel: credsFor(tab) ? keySubmitChange : keySubmit,
        onSubmit: (values) => send(tab, values),
      ),
      // ★ **画一张试试**（P1-27）：只有"图片"那一屏、而且**填了钥匙**时才给。
      //   ⚠️ 没接上线（`onDrawImage == null`）就不画 —— 不给假按钮。
      if (tab == credTabImage && draw != null && credsFor(tab))
        ImageTry(onDraw: (prompt) => draw(prompt)),
      // ★ **试一下语音**（批 7 · 主人 2026-09-26）：只有"语音"那一屏、而且接线了才给。
      //   🔴 **和上面那个表单是同一份钥匙**：这里不传任何钥匙进这一块 ——
      //      音频走 `/api/asr`，服务端按他验过签的身份现取（见本类顶上那段）。
      //   ⚠️ 没接线（`voiceTry == null`）就不画 —— 不给假按钮。
      //   ⚠️ **填没填都画**：这一档要能当场告诉他"还没配好、上面那三样就是它要用的"
      //      （图片那块不同：它没有"没配好"这一档，所以只在填了之后才画）。
      // ★ **录一段（录音 ＋ 回放）**（主人 2026-09-27）：与上面那个表单**无关** ——
      //   它不碰钥匙、不走上游：**只验这台设备的麦克风**。
      //   ⚠️ 排在「试一下」**前面**："先能成功把录音录下来"是更基础的那一件事。
      if (tab == credTabVoice && vr != null) VoiceRecord(handlers: vr),
      if (tab == credTabVoice && vt != null)
        VoiceTry(handlers: vt, hasOwn: credsFor(tab), canHear: canHear),
    ];
  }

  /// **这块窗口**那张卡：外观（三选一）＋ 字号（12–17，带**实时预览**）。
  ///
  /// 形状的依据：DSH 的设置里跟外观有关的只有这两样
  /// （`115-raw/A-layout.md` §470：*"color scheme + content font size
  /// (integer 12–17px, default 14px, stepper)"*）。
  ///
  /// 🔴 三条不许破：
  ///   ① **当前值看得出来，而且不只靠颜色**：选中那一档除了字更实，还带一个勾
  ///      （色盲 / 屏幕反光下颜色是最不可靠的通道 —— 同 `bubbles.dart` 四态那条）；
  ///   ② **预览是真的**：那一行字**就按当前字号画**（`dshContentScale` 那条轴），
  ///      不写死、也不是一张图 —— 改一下立刻看得见；
  ///   ③ **到边界就按不动**（12 时"小一点"、17 时"大一点"是灰的）：
  ///      夹住不许假装还能再小，也不许画一个按了没反应的键。
  ///      ⚠️ 这与"界面上不许出现按不动的东西"不冲突：那是"做不到的事不许摆出来"，
  ///      这里是**做得到但已经到头了**（发送键没字时也是灰的，同一条）。
  Widget _appearanceCard(BuildContext context, ChatAppearanceSettings now) {
    final t = Theme.of(context);
    final scale = now.scale;
    // ⚠️ **这一页用的是传进来那一份**（订阅到的那份"活的"），不是字段里那份快照
    //    —— 见 [appearanceLive] 那段（步进器连按两下会按错值就是那么来的）。
    final shown = now.appearance == ChatAppearance.system ? ChatAppearance.light : now.appearance;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // ⚠️ 2026-09-29：这一页顶上已经有「这块窗口」那行标题了（子页自己的抬头）
        //    ⇒ 这张卡里**不再重复一遍**分区名。
        Card(
          child: Padding(
            padding: const EdgeInsets.all(d.gapM),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // ── ① 外观（**2026-09-26 起只摆「亮」**）────────────
                Text(
                  settingsAppearanceLabel,
                  style: t.textTheme.titleSmall?.copyWith(
                    color: d.ink,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: d.gapS),
                // ⚠️ `Wrap`：3.1 倍字号下几个选项一定放不下 ⇒ 折行，**绝不横向溢出**
                //    （D3.5 那道硬闸）。
                //
                // 🔴 **为什么只摆「亮」**（`models/appearance.dart` 顶上那段是根因）：
                //    暗色那一套只做了一半（暗底换上了、里面的气泡/通知条/计划条还是
                //    暖白纸那套 ⇒ 暗色手机上就是"黑底 ＋ 淡粉条 ＋ 字读不出来"，
                //    主人 2026-09-26 的截图）。**没做完的样子不许摆出来给人按**
                //    —— 手册纪律 4：要砍就明说砍了（下面那句
                //    `settingsAppearanceDarkNotReady` 就是那句"明说"）。
                //    ⚠️ 三档的 token 与暗色 token 一个字节都没删（以后做完再放出来）。
                //
                // ⚠️ **摆出来的那一档 = 屏幕上真的在用的那一档**（`shown`）：
                //    盘上可能还存着老版本写的 `system`（它现在**一律解成亮**），
                //    那就在「亮」上打勾 —— 不能在「跟随系统」上打勾（窗口明明是亮的，
                //    那样是"页面在说假话"）。
                // ⚠️ 反过来：盘上真存着 `dark`（他以前点过）时，那一档也照实摆出来
                //    （`∪ 当前档`）—— 不然会出现"窗口是暗的、而设置里一个选中的都没有"。
                //    两种情形都留着一键点回「亮」的出口。
                Wrap(
                  spacing: d.gapS,
                  runSpacing: d.gapS,
                  children: [
                    for (final a in <ChatAppearance>{
                      ChatAppearance.light,
                      shown,
                    })
                      _appearanceChoice(a, shown: shown),
                  ],
                ),
                const SizedBox(height: d.gapXs),
                Text(
                  settingsAppearanceHint,
                  style: t.textTheme.bodySmall?.copyWith(color: d.muted),
                ),
                Text(
                  settingsAppearanceDarkNotReady,
                  style: t.textTheme.bodySmall?.copyWith(color: d.muted),
                ),
                Divider(height: d.gapL, color: d.line),
                // ── ② 字号（12–17，步进器）────────────────────────
                Text(
                  settingsFontSizeLabel,
                  style: t.textTheme.titleSmall?.copyWith(
                    color: d.ink,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: d.gapS),
                Row(
                  children: [
                    IconButton(
                      // 12 时按不动（已经到头了）
                      onPressed: now.fontSize > dshContentFontSizeMin &&
                              onFontSizeChanged != null
                          ? () => onFontSizeChanged!(now.fontSize - 1)
                          : null,
                      tooltip: settingsFontSizeSmaller,
                      icon: const Icon(Icons.remove),
                    ),
                    // 现在是多少号字（**当前值**，不是"默认值"）
                    Text(
                      '${now.fontSize}',
                      style: t.textTheme.titleMedium?.copyWith(
                        color: d.ink,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    IconButton(
                      // 17 时按不动
                      onPressed: now.fontSize < dshContentFontSizeMax &&
                              onFontSizeChanged != null
                          ? () => onFontSizeChanged!(now.fontSize + 1)
                          : null,
                      tooltip: settingsFontSizeBigger,
                      icon: const Icon(Icons.add),
                    ),
                  ],
                ),
                const SizedBox(height: d.gapXs),
                // 🔴 **实时预览**：这一行**就按当前那条字号轴画**。
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: d.gapM,
                    vertical: d.gapS,
                  ),
                  decoration: BoxDecoration(
                    color: d.paper,
                    borderRadius: BorderRadius.circular(d.radiusField),
                    border: Border.all(color: d.line),
                  ),
                  child: Text(
                    settingsFontSizePreview,
                    style: dshTextStyle(scale.content, d.ink),
                  ),
                ),
                const SizedBox(height: d.gapXs),
                Text(
                  settingsFontSizeHint,
                  style: t.textTheme.bodySmall?.copyWith(color: d.muted),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// 外观三档里的一颗（**选中带勾 ＋ 字更实**：不许只靠颜色）。
  ///
  /// ⚠️ [shown] 是"屏幕上真的在用的那一档"（`system` 现在一律解成亮 —— 见
  ///    `models/appearance.dart` 顶上那段；打勾打的是它，不是盘上那个偏好）。
  Widget _appearanceChoice(ChatAppearance a, {required ChatAppearance shown}) {
    final on = a == shown;
    return TextButton(
      // D3.6：命中区下限 44（视觉可以小，命中区不许小）
      style: TextButton.styleFrom(
        minimumSize: const Size(44, 44),
        foregroundColor: on ? d.ink : d.muted,
        padding: const EdgeInsets.symmetric(horizontal: d.gapM),
      ),
      onPressed: onAppearanceChanged == null ? null : () => onAppearanceChanged!(a),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (on) ...[
            const Icon(Icons.check, size: 18),
            const SizedBox(width: d.gapXs),
          ],
          Text(
            a.label,
            style: TextStyle(
              color: on ? d.ink : d.muted,
              fontWeight: on ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ],
      ),
    );
  }

  /// **这个助手**那一组（关于 / 退出登录 / 注销账号）。
  ///
  /// ⚠️ 2026-09-29：这几条**各自成了顶层那一列的一项**（主人要"分类、点开才是配置"）
  ///    ⇒ 原来那张把"关于 ＋ 退出登录"合在一起的卡没了。
  ///    现在：「关于」是整页（自带顶栏）；「退出登录」点一下就走；
  ///    「注销账号」是这一列里的一个子页（`_cancelAccountCard`）。

}
