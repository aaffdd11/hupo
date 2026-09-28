// **选壁纸那一屏**（契约 `docs/dev/131-WALLPAPER.md`）。
//
// 主人 2026-09-29：*"帮我解压缩这个 zip，里面是一些壁纸，你在设置里，帮我增加壁纸的选项。"*
//
// ── 形状 ──────────────────────────────────────────────────
//   一格一格的缩略图（**用 thumbs/ 那份小图**：整图铺 28 格会当场 OOM）·
//   第一格是**不设（默认那张纸）** · 选中的那一格有个勾（**不只靠颜色**：
//   他可能是色盲，也可能在大太阳下看屏 —— D3 那一族）。
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① 🔴 **只是选，不做别的**：这一屏不碰钥匙、不发请求（换壁纸是本机的事）；
//   ② **命中区 ≥44**（D3.6）：每一格的**可点区域**是 72×72 起（缩略图本身按比例画）；
//   ③ **不写死尺寸**：格宽/圆角/间距都住 `design.dart`（同一套外观一处出处）。
//
// ⚠️ 文案进词表（`space_words.dart` 那几条 `wallpaper*`），词表硬闸会扫。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/space_words.dart';
import '../models/wallpaper.dart';

/// 一格的边长（**可点区域**就是它 —— 缩略图按比例画在里面）。
const double wallpaperCell = 72;

/// 那一列（判据用它滚到某一格）。
const Key wallpaperListKey = ValueKey('wallpaperList');

/// 一格的 key（判据指名道姓点某一格 —— 不靠"第 N 个"那种数出来的位置）。
Key wallpaperCellKey(String id) => ValueKey('wallpaper:$id');

class WallpaperPicker extends StatelessWidget {
  const WallpaperPicker({
    super.key,
    required this.wallpaper,
    required this.onPick,
  });

  /// 现在选的是哪一个（`''` = 不设）。
  final String wallpaper;

  /// 选了哪一个 ⇒ 交给上层（它存盘 ＋ 让桌面当场换）。
  final void Function(String id) onPick;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final ids = wallpaperIds;
    return ListView(
      key: wallpaperListKey,
      padding: const EdgeInsets.symmetric(horizontal: d.gapL, vertical: d.gapL),
      children: [
        Text(wallpaperHint, style: t.textTheme.bodyMedium?.copyWith(color: d.muted)),
        const SizedBox(height: d.gapM),
        Wrap(
          spacing: d.gapS,
          runSpacing: d.gapS,
          children: [
            for (final id in ids)
              _cell(context, id, picked: id == wallpaper),
          ],
        ),
      ],
    );
  }

  Widget _cell(BuildContext context, String id, {required bool picked}) {
    final asset = wallpaperThumbOf(id);
    final label = wallpaperLabel(id);
    return Semantics(
      key: wallpaperCellKey(id),
      button: true,
      selected: picked,
      label: label,
      child: Tooltip(
        message: label,
        child: InkWell(
          onTap: () => onPick(id),
          borderRadius: BorderRadius.circular(d.radiusField),
          child: Container(
            width: wallpaperCell,
            height: wallpaperCell,
            decoration: BoxDecoration(
              color: d.paper,
              borderRadius: BorderRadius.circular(d.radiusField),
              border: Border.all(
                // ⚠️ **选中的那一格有勾**（不只靠颜色）；边框只是第二眼
                color: picked ? d.accent : d.line,
                width: picked ? 2 : 1,
              ),
            ),
            child: Stack(
              children: [
                Positioned.fill(
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(d.radiusField - 1),
                    child: asset == null
                        // 「不设」那一格：画一个**暖纸底 + 一枚小图标**（不是空白 ——
                        // 空白看着像"这一格坏了"）
                        ? Center(
                            child: Icon(
                              Icons.description_outlined,
                              size: 22,
                              color: d.muted,
                            ),
                          )
                        : Image.asset(asset, fit: BoxFit.cover),
                  ),
                ),
                if (picked)
                  const Positioned(
                    right: 2,
                    bottom: 2,
                    child: Icon(Icons.check_circle, size: 18, color: Colors.white),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
