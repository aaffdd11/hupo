// **小程序图标那一格的底色**（主人 2026-09-29：*"所有小程序的icon都需要一个背景颜色。
//   不同的背景颜色。"*）。
//
// ── 三条规矩 ──────────────────────────────────────────────
//   ① 🔴 **按 app 的身份算，不按它在桌面上的位置**（主人当场选的）：
//      同一个 app **永远**同一色、换位置/前后加东西都不变；
//      代价如实认下：**两个 app 可能撞成同一个颜色**（不保证彼此不同）。
//      ⇒ 判据只钉"同一个 id 永远同色"，**不**钉"两两不同"（那正是这一档选不了的）。
//   ② **底色只是装饰**：图标本身还是**墨色**（`design.dart` 的 `ink`）画的 ——
//      这一族底色都够浅、够低饱和，墨色压在上面读得出来（与桌面同一套暖色）。
//   ③ **认不出来/没有 id ⇒ 也有一个色**（拿名字兜底）：桌面上不许出现"没底"的一格。
//
// ── 为什么住 `models/`（不是 `widgets/`）────────────────────
// 它是**纯函数 ＋ 一串色值**，判据在 VM 上直接量（同 `wallpaper.dart` 那一条）；
// `models` 层不许 import material，而 `Color` 在 `dart:ui` 里 ⇒ 只用那一个。
//
// ⚠️ 底色**不许**跟着主题（亮/暗）变：它是"这个 app 长什么样"，
//    不是"这块屏现在什么档"（换档时整片桌面颜色翻一遍不是他要的东西）。

import 'dart:ui' show Color;

/// 图标底那一族色（暖、浅、低饱和）。
///
/// 🔴 **加一条要连着看两件事**：① 墨色（`ink` #2B2320）压上去还读得出来；
///    ② 跟桌面那张纸（`paper` #F8F5EE）与壁纸罩色放在一起不脏。
/// ⚠️ 顺序**不要动**：`appTintFor` 是按"哈希落在第几格"取的 ⇒ 重排 = 所有人换色。
const List<Color> appTints = <Color>[
  Color(0xFFF0D9A8), // 麦
  Color(0xFFE9C9A8), // 陶
  Color(0xFFDCC7E3), // 藕
  Color(0xFFC3DAC6), // 苔
  Color(0xFFC6D6E8), // 雾蓝
  Color(0xFFF0C9C3), // 珊瑚
  Color(0xFFE6D6B4), // 沙
  Color(0xFFCCD6B2), // 橄榄
  Color(0xFFDCCBB4), // 麻
  Color(0xFFCDD2DE), // 灰蓝
  Color(0xFFF1D2D9), // 藕粉
  Color(0xFFBFD9D5), // 湖水
];

/// 这个身份该用哪一色。**同一个字符串永远同一个色**（见文件头 ①）。
///
/// ⚠️ 哈希是**我们自己定的**（FNV-1a 32 位）：不引依赖、跨平台/跨版本稳定
///    （`String.hashCode` 在 Dart 里**不保证**跨版本稳定 ⇒ 不许拿它当身份）。
Color appTintFor(String key) => appTints[_fnv1a(key) % appTints.length];

/// FNV-1a（32 位）。空串也有一个确定的值（不会走到负数取模那种坑）。
int _fnv1a(String s) {
  var h = 0x811c9dc5;
  for (final c in s.codeUnits) {
    h ^= c;
    h = (h * 0x01000193) & 0xFFFFFFFF;
  }
  return h;
}
