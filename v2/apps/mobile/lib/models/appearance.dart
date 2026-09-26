// **聊天窗口的外观与字号** —— 用户能自己调的那两样
// （契约 `docs/dev/119-APPEARANCE-AND-FONT.md`）。
//
// ── 为什么要有它 ──────────────────────────────────────────
// 主人 2026-09-26：*"首先全部开放，聊天窗口的设计也要重做。"* —— 前四刀把
// **信息**（工具行 / 排队 / 轨迹）与**骨架**（`models/dsh_design.dart` 的两份色板、
// 字号轴 12–17）做出来了，而**用户自己能调的那两样一样都没有**：
// 亮暗跟着 `Theme` 走（今天全站只有亮色）、字号恒走默认档 14。
// ⇒ 这一份是那两样的**身份与取值规则**（纯逻辑，画在 `widgets/` 那一层）。
//
// ── 依据（不是猜的）────────────────────────────────────────
// DSH 真包（`docs/dev/115-raw/E-visual.md` §1.2，逐字）：
// ```js
// const preference = "system"                    // DEFAULT_PREFERENCE
// const systemDark = preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches
// const dark = preference === 'dark' || systemDark
// document.body.style.setProperty('--dsh-content-font-size', "14px")
// ```
// * `THEME_PREFERENCES = ["light","dark","system"]`（`A-layout.md` §470：三档，`system`
//   **由上游按 `prefers-color-scheme` 解析**，界面层只拿到解析之后的结论）；
// * `FONT_SIZE_MIN = 12` · `FONT_SIZE_MAX = 17` · `DEFAULT_FONT_SIZE = 14` · `step(1)`
//   —— 它是 DSH 里**唯一**一个用户能调的视觉维度（`E-visual.md` §1.2 末句）。
//
// ⚠️ **纯逻辑，不许 import `material`**（楼层闸 `test/unit/import_rules_test.dart`）。
//    这里只用 `dart:ui` 之外的东西一个都不用 —— `DshVariant` / `DshContentScale`
//    来自 `dsh_design.dart`（同层，那份也只用 `dart:ui` 的 `Color`）。
//
// ── 🔴 一条纪律：坏值只许退回默认，绝不许抛 ────────────────────
// 这两个值的来源是**本机盘上那一个字符串**（`services/appearance_store.dart`）：
// 它可能是旧版本写的、也可能被别的东西改坏了。坏掉的后果必须只是"回到默认"，
// **绝不能是打不开聊天**（同 `process_levels.dart` 那条）。

import 'dsh_design.dart';

/// 用户选的外观三档（DSH `THEME_PREFERENCES = ["light","dark","system"]`）。
///
/// ⚠️ `wire` 是**存在本机盘上的那个 token**（与 DSH 逐字一致）：
///    改它 = 把用户已经存下来的选择弄丢（协议字段，冻结）。
/// ⚠️ `label` 是设置里给用户看的那两个字/三个字（DSH 那把选择器上的字）。
///    它放这儿而不是放 `screens/`，理由与 `chat_view.dart` 的 `tab`、
///    `process_levels.dart` 的 `title` 逐字相同：**用户会看到的字要进得了硬闸**
///    （禁用词扫描够得着），摆在 widget 里就够不着。
enum ChatAppearance {
  /// 亮：DSH 那边就是"**没有** `data-ds-dark-theme` 那个属性"。
  light(wire: 'light', label: '亮'),

  /// 暗：DSH 那边是 `<body>` 上那个布尔属性在。
  dark(wire: 'dark', label: '暗'),

  /// 跟随系统：**交给设备**（DSH 用 `prefers-color-scheme` 解析）。
  system(wire: 'system', label: '跟随系统');

  const ChatAppearance({required this.wire, required this.label});

  /// 存在盘上的那个 token（**冻结**，见本枚举顶上那段）。
  final String wire;

  /// 设置里显示的那几个字。
  final String label;
}

/// 默认外观 = **跟随系统**（DSH `DEFAULT_PREFERENCE = "system"`，逐字如此）。
const ChatAppearance defaultChatAppearance = ChatAppearance.system;

/// 认一个 token ⇒ 外观档；**认不出来一律当默认（跟随系统）**。
///
/// 🔴 **为什么坏值退回 `system` 而不是 `light`**（派活单点名要一个说法）：
///   1. `system` 是 DSH 的 `DEFAULT_PREFERENCE`（`E-visual.md` §1.2 逐字），
///      也就是这条轴**本来的默认**——坏值退回默认，不额外发明第二个默认；
///   2. `system` 是**唯一一个不会替用户拿主意**的档：它跟着设备走，而设备那一档
///      是用户自己在系统里设的。退回 `light` 的后果是"用户在暗色设备上打开，
///      我们**悄悄把他按回亮色**"——那是页面在违背他刚做过的选择；
///   3. 反过来，退回 `system` 最坏只是"跟着设备"——**没有任何一种设备状态下它是错的**。
///   ⇒ fail-closed 在这里的意思是"**退回一个绝不会说谎的档**"，不是"关掉功能"。
ChatAppearance chatAppearanceOf(Object? wire) {
  for (final a in ChatAppearance.values) {
    if (a.wire == wire) return a;
  }
  return defaultChatAppearance;
}

/// 把用户设置的字号收进 12–17。
///
/// ⚠️ **绝不抛**：输入可能是旧版本写的数字、也可能是别的类型。规矩逐字照
///    `dsh_design.dart` 的 `dshClampContentFontSize`（那条已经处理了 int /
///    整数 double / 其余一切）——**这里不另写一套**，只在它前面加一层
///    "字符串里的整数也认"（盘上存的是字符串，`"15"` 是合法的历史形态）。
int chatFontSizeOf(Object? setting) {
  if (setting is String) {
    // ⚠️ 只认**一个整数**（`'15'`）；`'14.5'` / `'15px'` / `'abc'` 一律回默认档
    //    —— 半懂不懂地猜一个数，就是拿猜的数上屏。
    //    ⚠️ 唯一的宽容：`int.tryParse` 允许**前后有空白**（`'15 '` ⇒ 15），
    //       那是 Dart 自己的口径，不是我们额外猜的 —— 数字一个不少。
    final n = int.tryParse(setting);
    return dshClampContentFontSize(n);
  }
  return dshClampContentFontSize(setting);
}

/// 用户选的这两样（外观 ＋ 字号），一起往下传。
///
/// ⚠️ 为什么要一个值类、而不是在界面里放两个字段：它们是**同一个设置项的两个轴**
///    （DSH 的 Settings 里就是相邻的两行），而"往下传"这件事必须**一起**发生
///    —— 分开传就会出现"色板换了、字号还是旧的"那一帧（`AppearanceScope` 一条就够）。
class ChatAppearanceSettings {
  const ChatAppearanceSettings({
    this.appearance = defaultChatAppearance,
    this.fontSize = dshContentFontSizeDefault,
  });

  /// 用户选的那一档（可能是 `system` —— 还没跟设备解析过）。
  final ChatAppearance appearance;

  /// 用户选的字号（**已经夹在 12–17**）。
  final int fontSize;

  /// 那条字号轴（聊天里每一行的字号都必须从这里来）。
  DshContentScale get scale => dshContentScale(fontSize);

  /// 把 [appearance] 对着**设备的亮度**解析成一份具体色板（DSH 的 `bootThemeScript`
  /// 那三行逐字：`dark = preference === 'dark' || (preference === 'system' && systemDark)`）。
  DshVariant resolve({required bool platformDark}) => switch (appearance) {
    ChatAppearance.light => DshVariant.light,
    ChatAppearance.dark => DshVariant.dark,
    ChatAppearance.system => platformDark ? DshVariant.dark : DshVariant.light,
  };

  ChatAppearanceSettings copyWith({ChatAppearance? appearance, int? fontSize}) =>
      ChatAppearanceSettings(
        appearance: appearance ?? this.appearance,
        fontSize: fontSize ?? this.fontSize,
      );

  @override
  bool operator ==(Object other) =>
      other is ChatAppearanceSettings &&
      other.appearance == appearance &&
      other.fontSize == fontSize;

  @override
  int get hashCode => Object.hash(appearance, fontSize);

  @override
  String toString() => 'ChatAppearanceSettings(${appearance.wire}, $fontSize)';
}

/// 盘上那一个字符串的**编码**：`"<wire>|<字号>"`（例：`dark|16`）。
///
/// ⚠️ 为什么两样一起存在**一个 key** 里（而不是两个 key）：它们是**一个设置**的
///    两个轴（见 [ChatAppearanceSettings] 那段）；一个 key 意味着"要么两份都是
///    新的、要么两份都退回默认"，不会出现"外观是今天的、字号是上一版留下的"。
/// ⚠️ 编码**不含用户输入**、也不含任何需要转义的东西 ⇒ 不用 JSON（用了反而多一层
///    会失败的解析）。
String chatAppearanceSettingsWire(ChatAppearanceSettings s) =>
    '${s.appearance.wire}|${s.fontSize}';

/// 解盘上那一个字符串 ⇒ 设置；**两个轴各自 fail-closed，绝不抛**。
///
/// 🔴 两个轴**分开退回**（例：`"dark|坏了"` ⇒ 暗 ＋ 默认字号 14）：
///    坏的是哪一半就退回哪一半，不许因为一半坏了把另一半也丢掉
///    —— 那等于"用户刚选的暗色白选了"。
ChatAppearanceSettings chatAppearanceSettingsOf(Object? raw) {
  if (raw is! String) return const ChatAppearanceSettings();
  final parts = raw.split('|');
  return ChatAppearanceSettings(
    appearance: chatAppearanceOf(parts.isEmpty ? null : parts[0]),
    fontSize: chatFontSizeOf(parts.length > 1 ? parts[1] : null),
  );
}
