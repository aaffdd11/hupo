// **桌面那张壁纸**（主人 2026-09-29 给了一包，28 张）。
//
// 原话：*"帮我解压缩这个 zip，里面是一些壁纸，你在设置里，帮我增加壁纸的选项。"*
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① 🔴 **它是桌面（底图）那一张，不是聊天窗口的背景** —— 聊天浮窗照旧是
//      `design.dart` 里那张暖纸（改它要动的是另一件事）。
//   ② 🔴 **Z5 那三个"不许"照旧**（`08-SPEC.md` §6.1）：壁纸是**装饰**——
//      **不许接输入**（`IgnorePointer`）· **不许说话**（一个字都不画）·
//      **不许改排布**（图标墙的命中区与位置一毫米不动）。
//   ③ **认不出来就用默认**（`''` = 不设）——偏好读坏了最多是"回到那张纸"，
//      **绝不能因此让桌面打不开**（同 `appearance.dart` 那一条）。
//
// ── 为什么 id 是 `wp-01` 这种序号 ────────────────────────────
//   源图名是一串哈希（没有名字可读）。序号是**稳定**的：盘上存的就是它，
//   判据也按它认（`docs/dev/131-WALLPAPER.md`）。
//   ⚠️ **换一包壁纸** = 重跑 `scripts/prepare-wallpapers.py` ＋ 改下面那个上限；
//      盘上存的老 id 认不出来 ⇒ 自动回默认（不会白屏、也不会报错）。
//
// ⚠️ 纯逻辑（住 `models/`）：不 import flutter / services ⇒ 判据在 VM 上直接量。
//    ⚠️ 界面那两句（"不设（默认那张纸）" / "壁纸 "）住在 `space_words.dart`
//      —— 词表那一层管界面用词，那儿才进得了禁用词扫描。

import 'space_words.dart';

/// **不设壁纸**（默认那张暖纸 —— `design.dart` 的 `paper`）。
const String wallpaperNone = '';

/// 现有多少张（`wp-01` … `wp-28`）。
///
/// ⚠️ 这个数**跟着 `assets/wallpapers/` 里的文件走**：判据会数一遍文件，
///    对不上就红（免得"库里说 28 张、盘上只有 20 张"这种事悄悄发生）。
const int wallpaperCount = 28;

/// 全部可选的那些（**第一个是"不设"**）。
List<String> get wallpaperIds => <String>[
  wallpaperNone,
  for (var i = 1; i <= wallpaperCount; i++) 'wp-${i.toString().padLeft(2, '0')}',
];

/// 这一串是不是一个**认得出来**的 id（认不出来 ⇒ 当"不设"，见纪律 ③）。
bool wallpaperKnown(String id) => wallpaperIds.contains(id);

/// 读盘那个字符串 ⇒ 一个认得的 id（认不出来就是 [wallpaperNone]）。
String wallpaperOf(String? raw) {
  final s = (raw ?? '').trim();
  return wallpaperKnown(s) ? s : wallpaperNone;
}

/// 桌面那张**整图**的资源路径（不设 ⇒ `null`：那张暖纸是画出来的，不是图）。
String? wallpaperAssetOf(String id) =>
    wallpaperKnown(id) && id != wallpaperNone ? 'assets/wallpapers/$id.jpg' : null;

/// 选壁纸那屏里那一格用的**缩略图**（整图直接铺 28 格会当场 OOM）。
String? wallpaperThumbOf(String id) =>
    wallpaperKnown(id) && id != wallpaperNone ? 'assets/wallpapers/thumbs/$id.jpg' : null;

/// 那一格在屏幕上怎么念（读屏用；也给判据认"这是第几张"）。
/// ⚠️ 说"第 N 张"而不是编一个名字：源图本来就没有名字，编一个就是假话。
/// 🔴 **认不出来的一律念成"默认那一格"**（`wp-99` 不许念成"壁纸 99" ——
///    那会让人以为盘上真有第 99 张。**这条是判据当场抓出来的**）。
String wallpaperLabel(String id) {
  if (!wallpaperKnown(id) || id == wallpaperNone) return wallpaperDefaultLabel;
  final n = int.tryParse(id.substring(3));
  return n == null ? wallpaperDefaultLabel : '$wallpaperLabelPrefix$n';
}


// ── ★ 2026-10-04：壁纸**跟着账号走**（主人拍板 · 契约 `docs/dev/183`）──────────
//
// 原来它跟"亮暗 / 字号"一样**按设备存** ⇒ 换一台设备登录就回到默认那张纸。
// 主人看到文稿里的截图当场问出这件事，并定了：**跟账号走**。
//
// ⇒ 下面这两个东西是**纯逻辑**（不 import flutter / services ⇒ 判据在 VM 上直接量）：
//    服务端那一份**怎么读**、它和本机这一份**怎么合**。

/// **服务端那一份回答**。
///
/// 🔴 `wallpaper == null` 与 `wallpaper == ''` **是两件事**：
///    · `null` = **账号里从没记过**这一格（⇒ 要拿本机那份顶上去，见 [resolveWallpaper]）；
///    · `''`   = 他**明确选了"不设"**（默认那张暖纸）——这是他的选择，不许被本机那份盖掉。
class WallpaperRemote {
  const WallpaperRemote(this.wallpaper);

  /// `null` = 账号里没记录；`''` = 明确不设；`'wp-07'` = 就那一张。
  final String? wallpaper;
}

/// 合出来之后该怎么办。
class WallpaperResolved {
  const WallpaperResolved({required this.value, required this.pushUp});

  /// 最后该铺哪一张（已归一化：认不出来 ⇒ `''`）。
  final String value;

  /// 要不要把**本机这一份**写回账号（只有"账号里没记录"那一种会要）。
  final bool pushUp;
}

/// **账号那一份 ＋ 本机这一份 ⇒ 该铺哪一张、要不要往上顶**。
///
/// 三条规矩（别的都不许加）：
///   ① **没问上**（`remote == null`，网络不通 / 非 200 / 读不懂）⇒ **本机这一份照旧**
///      （什么都不写、什么都不动 —— 网不通不等于"他改了"）；
///   ② **账号里没记录**（`null`）⇒ 本机有就**往上顶**（老用户升级上来的第一下：
///      他设备上挑过的那张不该被"没记录"抹成默认）；本机也没有 ⇒ 不设；
///   ③ **账号里有记录**（含 `''`）⇒ **听账号的**（这就是"跟着账号走"）。
WallpaperResolved resolveWallpaper({WallpaperRemote? remote, required String local}) {
  final mine = wallpaperOf(local);
  if (remote == null) return WallpaperResolved(value: mine, pushUp: false);
  if (remote.wallpaper == null) {
    return WallpaperResolved(value: mine, pushUp: mine != wallpaperNone);
  }
  return WallpaperResolved(value: wallpaperOf(remote.wallpaper), pushUp: false);
}
