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

import 'package:flutter/material.dart';

import '../models/appearance.dart';
import '../models/design.dart' as d;
import '../models/dsh_design.dart';
import '../models/image_outcome.dart';
import '../models/space.dart';
import '../models/space_words.dart';
import '../services/api.dart';
import '../widgets/cred_form.dart';
import '../widgets/dsh_look.dart';
import '../widgets/image_try.dart';
import '../widgets/key_form.dart';
import 'about_screen.dart';

/// **分区标题**（设置页这一层就两三个，形状只有一种）。
///
/// 🔴 为什么不用强调色：它原来用 `d.accent`，屏幕上读起来像**警告** ——
///    而它只是"这一块叫什么"。分区名要**稳**，要让红色的意思留给"退出登录"这类事。
/// ⚠️ 字号不写死（跟主题那一档走）；什么时候全站统一，见 `72-UI-PASS.md` 的 E。
class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Text(
      text,
      style: t.textTheme.titleSmall?.copyWith(
        color: d.ink,
        fontWeight: FontWeight.w600,
      ),
    );
  }
}

/// 四个 tab 的名字（**顺序＝主人说的顺序** · `space_words.dart` 里那四个常量）。
const List<String> credTabs = [credTabChat, credTabVoice, credTabImage, credTabVideo];

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    super.key,
    required this.hasKey,
    required this.keyBad,
    required this.onSubmit,
    this.creds = const SpaceCreds(),
    this.onSubmitCreds,
    this.onDrawImage,
    this.localOnly = false,
    this.onCancel,
    this.onCancelled,
    this.onKeyChanged,
    this.onLogout,
    this.appearance = const ChatAppearanceSettings(),
    this.onAppearanceChanged,
    this.onFontSizeChanged,
  });

  /// 现在有没有一串能用的钥匙（服务端说的）。
  final bool hasKey;

  /// **那四样有没有**（主人 2026-09-24：配置页就是配这四样）。
  /// ⚠️ 老服务端不回它 ⇒ 全 `false`（"没有"），四个 tab 里就都会说"还没有填"。
  final SpaceCreds creds;

  /// **画一张图**（P1-27）：图片那一屏下面的「试一张」用它。
  /// ⚠️ `null` ⇒ 不画那一块（这条路没接上时**不给假按钮**）。
  final Future<ImageOutcome> Function(String prompt)? onDrawImage;

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

  @override
  Widget build(BuildContext context) {
    // ⚠️ **没有 `Scaffold` / `AppBar`**：顶上那一条由**小程序容器**给
    //    （`MiniAppHost`）—— 小程序自己画的话，"跳不出容器"这件事就没了保证。
    return Center(
      child: ConstrainedBox(
        // ⚠️ **和首页同一条窄列**（契约 `49-STYLE.md`）：一行太长没人读得下去
        constraints: const BoxConstraints(maxWidth: 640),
        child: DefaultTabController(
          length: credTabs.length,
          child: Column(
            children: [
              // ── 四个 tab（主人 2026-09-24：*"配置页用来配置模型，语言大模型apikey，
              //    语音大模型，图片生成，视频生成"*）──
              // ⚠️ `isScrollable`：字放到最大时**横向能滚**，而不是挤成一团、更不是溢出
              TabBar(
                isScrollable: true,
                tabAlignment: TabAlignment.start,
                tabs: [for (final tab in credTabs) Tab(height: 48, text: tab)],
              ),
              Expanded(
                child: TabBarView(
                  children: [for (final tab in credTabs) _tabBody(context, tab)],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 一屏的内容（**每一屏自己可滚** —— 字放到最大时不许溢出）。
  Widget _tabBody(BuildContext context, String tab) {
    final t = Theme.of(context);
    final has = credsFor(tab);
    // ⚠️ 边界句要看**两件事**：是不是有自己一台（`localOnly` 的反面）、以及**他填过没有**。
    final boundary = credBoundaryOf(tab, isTenant: !localOnly, hasOwn: has);
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
        // ⑤ **这个助手**（关于 / 退出登录）：只在**第一屏**（聊天）底下。
        //    ⚠️ 为什么不放"四屏共用的固定页脚"：字放到 3.1 倍时那个页脚会把
        //      上面挤爆（D3.5 那道硬闸当场判红）。放进可滚列里就永远滚得到。
        //
        // ★ 批次 4：这一组上面还有**「这块窗口」**（外观 / 字号）—— 同一条理由
        //   （它是关于**聊天这一扇窗**的设置，不属于那四样钥匙）⇒ 也只在第一屏底下。
        if (tab == credTabChat) ...[
          const SizedBox(height: d.gapL),
          _appearanceCard(context),
          const SizedBox(height: d.gapL),
          _aboutCard(context),
        ],
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
          CredField(key: 'voiceAppId', label: credVoiceAppIdLabel),
          CredField(key: 'voiceSecretId', label: credVoiceSecretIdLabel),
          CredField(key: 'voiceSecretKey', label: credVoiceSecretKeyLabel),
        ],
      credTabImage => const [CredField(key: 'image', label: credOneKeyLabel)],
      credTabVideo => const [CredField(key: 'video', label: credOneKeyLabel)],
      _ => const <CredField>[],
    };
    final draw = onDrawImage;
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
  Widget _appearanceCard(BuildContext context) {
    final t = Theme.of(context);
    final scale = appearance.scale;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _SectionTitle(settingsAppearanceSection),
        const SizedBox(height: d.gapS + 2),
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
                      _shownAppearance,
                    })
                      _appearanceChoice(a, shown: _shownAppearance),
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
                      onPressed: appearance.fontSize > dshContentFontSizeMin &&
                              onFontSizeChanged != null
                          ? () => onFontSizeChanged!(appearance.fontSize - 1)
                          : null,
                      tooltip: settingsFontSizeSmaller,
                      icon: const Icon(Icons.remove),
                    ),
                    // 现在是多少号字（**当前值**，不是"默认值"）
                    Text(
                      '${appearance.fontSize}',
                      style: t.textTheme.titleMedium?.copyWith(
                        color: d.ink,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    IconButton(
                      // 17 时按不动
                      onPressed: appearance.fontSize < dshContentFontSizeMax &&
                              onFontSizeChanged != null
                          ? () => onFontSizeChanged!(appearance.fontSize + 1)
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

  /// **现在这一屏真的在用哪一档**（摆出来、打勾都用它 —— 不是盘上那个偏好）。
  ///
  /// 🔴 2026-09-26：`system` 现在**一律解成亮**（暗色那一套没做完，见
  /// `models/appearance.dart` 顶上那段）⇒ 设置里就**不该**在「跟随系统」上打勾
  /// （窗口明明是亮的）。盘上那份偏好**一个字都不动**（他没点过就不改他的盘）。
  ChatAppearance get _shownAppearance =>
      appearance.appearance == ChatAppearance.system
      ? ChatAppearance.light
      : appearance.appearance;

  /// 外观三档里的一颗（**选中带勾 ＋ 字更实**：不许只靠颜色）。
  ///
  /// ⚠️ [shown] 是"屏幕上真的在用的那一档"（见 [_shownAppearance]）——
  ///    打勾打的是它，不是盘上那个偏好。
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

  /// **这个助手**那张卡（关于 / 退出登录）。
  ///
  /// ⚠️ 主人 2026-09-24 定的四个 tab 全是**配钥匙**的；"关于/退出登录"不属于其中任何一样
  ///    ⇒ 它挂在**第一屏**（聊天）的可滚内容底下，不做成固定页脚（理由见 `_tabBody` 第 ⑤ 条）。
  Widget _aboutCard(BuildContext context) {
    final t = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // ★ 2026-09-23：这两条原来**光秃秃挂在最下面**（一页三块读不出结构）
        //   ⇒ 加分区标题，并把两条收进**同一张卡**（中间一条分隔线）。
        const _SectionTitle(settingsAboutSection),
        const SizedBox(height: d.gapS + 2),
        Card(
          child: Column(
            children: [
              // ⚠️ **关于搬进来了**（见 `space_words.dart` 那段）：
              //    顶栏再加一个图标就是 7 个 —— 手机上那一条会挤成一团。
              ListTile(
                leading: const Icon(Icons.info_outline),
                title: const Text('关于'),
                // ★ 加一句小字：光"关于"两个字，读不出这一页管什么
                subtitle: Text(
                  aboutEntryHint,
                  style: t.textTheme.bodySmall?.copyWith(color: d.muted),
                ),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => const AboutScreen()),
                ),
              ),
              // ── **退出登录**（主人 2026-09-22：设置里管"退出登录 / 注销账号 / 改钥匙"）──
              // ⚠️ 它原来挂在**聊天抓手行**上 —— 那一行是"聊天"的地方，退出登录不是聊天的事。
              if (onLogout != null) ...[
                Divider(height: 1, color: d.line),
                ListTile(
                  leading: Icon(Icons.logout, color: d.accent),
                  title: Text(
                    settingsLogout,
                    style: t.textTheme.bodyLarge?.copyWith(color: d.ink),
                  ),
                  onTap: onLogout,
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
