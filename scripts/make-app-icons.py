#!/usr/bin/env python3
# **把主人给的一张图做成 app 的图标**（安卓启动图标 ＋ 网页的 favicon / PWA 图标）。
#
# 用法：
#   scripts/make-app-icons.py <源图> [--dry-run]
#
# 契约：`docs/dev/130-APP-ICON.md`。
#
# ── 为什么要有这个脚本（而不是"我手工改那几张 PNG"）────────────
#   ① 图标有**五种密度 ＋ 自适应那一套 ＋ 网页那四张**，手工做必然少一张（少的那张
#      在他手机上就是"别的形状"）；② 下次他再给一张图，重跑一遍就行。
#   ⚠️ 依赖 **Pillow**（本机 `python3 -c "import PIL"` 是好的；这不是 Flutter 那边的依赖）。
#
# ── 三条必须守的 ────────────────────────────────────────────
#   ① 🔴 **源图角上那行"AI 生成"的水印一个像素都不许进图标**：先按**主体（亮部）**裁紧
#      （裁完水印落在框外），再往下做 —— 判据在 `test/unit/app_icon_test.dart`。
#   ② 🔴 **自适应图标要留安全区**：安卓会把前景裁成圆/方/水滴 ⇒ 主体只占画布的 62%
#      （108dp 里那 66dp 的安全区，再留一点余量）；背景用源图里那个深蓝底色。
#   ③ **网页那两张 maskable** 同理（圆形安全区）⇒ 主体也缩到 62%，背景铺满。

import sys
import os

try:
    from PIL import Image, ImageFilter
except ImportError:  # pragma: no cover
    print('✗ 需要 Pillow（python3 -m pip install pillow）', file=sys.stderr)
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANDROID_RES = os.path.join(ROOT, 'v2/apps/mobile/android/app/src/main/res')
WEB = os.path.join(ROOT, 'v2/apps/mobile/web')

# 启动图标五种密度（dp → px 的常规倍数）
DENSITIES = {
    'mdpi': 1.0,
    'hdpi': 1.5,
    'xhdpi': 2.0,
    'xxhdpi': 3.0,
    'xxxhdpi': 4.0,
}
LAUNCHER_DP = 48        # 传统图标的边长（dp）
ADAPTIVE_DP = 108       # 自适应图标的前景画布（dp）
SAFE_RATIO = 0.62       # 主体占画布的比例（安全区 ≈ 66/108，再留一点余量）


def luma(p):
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


def subject_box(im, threshold=120, skip_bottom_right=0.18):
    """主体的包围盒（**排除右下角那一带** —— 水印就住在那里）。"""
    w, h = im.size
    px = im.load()
    minx, miny, maxx, maxy = w, h, 0, 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            # 右下角那一块跳过（水印）
            if x > w * (1 - skip_bottom_right) and y > h * (1 - skip_bottom_right):
                continue
            if luma(px[x, y]) > threshold:
                minx = min(minx, x)
                maxx = max(maxx, x)
                miny = min(miny, y)
                maxy = max(maxy, y)
    return minx, miny, maxx, maxy


def square_crop(im, box, pad_ratio=0.06):
    """按主体裁成正方形（留一点余量，水印在框外）。"""
    minx, miny, maxx, maxy = box
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    side = max(maxx - minx, maxy - miny)
    side = int(side * (1 + pad_ratio * 2))
    left = int(max(0, min(cx - side / 2, im.size[0] - side)))
    top = int(max(0, min(cy - side / 2, im.size[1] - side)))
    return im.crop((left, top, left + side, top + side))


def corner_color(im):
    """背景色（取左上角那一块的中位数 —— 源图的底色）。"""
    w, h = im.size
    px = im.load()
    rs, gs, bs = [], [], []
    for y in range(0, max(2, h // 20)):
        for x in range(0, max(2, w // 20)):
            p = px[x, y]
            rs.append(p[0]); gs.append(p[1]); bs.append(p[2])
    rs.sort(); gs.sort(); bs.sort()
    mid = len(rs) // 2
    return (rs[mid], gs[mid], bs[mid])


def cutout(im, lo=60.0, hi=150.0):
    """把主体从底色里抠出来（**按亮度做一条软的 alpha 斜坡**）。

    ⚠️ 底色是深蓝（亮度 ≈ 13）、主体是亮黄（≈ 240）⇒ 这条斜坡把它们分开；
       中间那段是光晕与描边（半透明），留着反而自然。
    """
    out = im.convert('RGBA')
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            a = (luma((r, g, b)) - lo) / (hi - lo)
            a = 0.0 if a < 0 else (1.0 if a > 1 else a)
            px[x, y] = (r, g, b, int(round(a * 255)))
    return out


def paste_center(canvas, art):
    cw, ch = canvas.size
    aw, ah = art.size
    canvas.alpha_composite(art, ((cw - aw) // 2, (ch - ah) // 2))


def scaled(im, ratio, canvas_px):
    """把 art 缩到画布的 ratio 那么大。"""
    side = int(canvas_px * ratio)
    return im.resize((side, side), Image.LANCZOS)


def main():
    if len(sys.argv) < 2:
        print(__doc__ or 'usage: make-app-icons.py <源图>', file=sys.stderr)
        return 2
    src = sys.argv[1]
    im = Image.open(src).convert('RGB')
    box = subject_box(im)
    crop = square_crop(im, box)
    bg = corner_color(crop)
    art = cutout(crop)
    print(f'▶ 源图 {im.size}  主体框 {box}  裁成 {crop.size}  底色 #{bg[0]:02x}{bg[1]:02x}{bg[2]:02x}')

    # ── ① 传统启动图标（五种密度）──────────────────────────────
    for name, mult in DENSITIES.items():
        px = int(round(LAUNCHER_DP * mult))
        out = crop.resize((px, px), Image.LANCZOS).convert('RGBA')
        path = os.path.join(ANDROID_RES, f'mipmap-{name}', 'ic_launcher.png')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        out.save(path)
        print(f'  ✓ {os.path.relpath(path, ROOT)}  {px}×{px}')

    # ── ② 圆形那一套（每个密度一张 PNG）：会要圆图标的启动器（安卓 7 那代）用它 ──
    for name, mult in DENSITIES.items():
        px = int(round(LAUNCHER_DP * mult))
        out = crop.resize((px, px), Image.LANCZOS).convert('RGBA')
        # 圆外透明（`roundIcon` 那边期望的就是这个形状）
        mask = Image.new('L', (px, px), 0)
        from PIL import ImageDraw
        ImageDraw.Draw(mask).ellipse((0, 0, px - 1, px - 1), fill=255)
        out.putalpha(mask)
        path = os.path.join(ANDROID_RES, f'mipmap-{name}', 'ic_launcher_round.png')
        out.save(path)
        print(f'  ✓ {os.path.relpath(path, ROOT)}  {px}×{px}（圆形）')

    # ── ③ 自适应图标：前景（抠出来的主体，缩到安全区）＋ 背景色 ──
    for name, mult in DENSITIES.items():
        px = int(round(ADAPTIVE_DP * mult))
        canvas = Image.new('RGBA', (px, px), (0, 0, 0, 0))
        paste_center(canvas, scaled(art, SAFE_RATIO, px))
        path = os.path.join(ANDROID_RES, f'mipmap-{name}', 'ic_launcher_foreground.png')
        canvas.save(path)
        print(f'  ✓ {os.path.relpath(path, ROOT)}  {px}×{px}')
    values = os.path.join(ANDROID_RES, 'values', 'ic_launcher_background.xml')
    os.makedirs(os.path.dirname(values), exist_ok=True)
    with open(values, 'w', encoding='utf-8') as f:
        f.write(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<!-- 自适应图标的底色：**从主人给的那张图里取的**（脚本取的左上角中位数）。\n'
            '     生成器：scripts/make-app-icons.py（契约 docs/dev/130-APP-ICON.md）。 -->\n'
            '<resources>\n'
            f'    <color name="ic_launcher_background">#{bg[0]:02X}{bg[1]:02X}{bg[2]:02X}</color>\n'
            '</resources>\n'
        )
    print(f'  ✓ {os.path.relpath(values, ROOT)}  #{bg[0]:02X}{bg[1]:02X}{bg[2]:02X}')
    anydpi = os.path.join(ANDROID_RES, 'mipmap-anydpi-v26')
    os.makedirs(anydpi, exist_ok=True)
    for fn in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        with open(os.path.join(anydpi, fn), 'w', encoding='utf-8') as f:
            f.write(
                '<?xml version="1.0" encoding="utf-8"?>\n'
                '<!-- 自适应图标（安卓 8+）：前景 + 我们的底色。\n'
                '     生成器：scripts/make-app-icons.py。 -->\n'
                '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                '    <background android:drawable="@color/ic_launcher_background"/>\n'
                '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
                '</adaptive-icon>\n'
            )
        print(f'  ✓ {os.path.relpath(os.path.join(anydpi, fn), ROOT)}')

    # ── ④ 网页那几张（favicon ＋ PWA 的普通/可蒙版）─────────────
    fav = crop.resize((64, 64), Image.LANCZOS).convert('RGBA')
    fav.save(os.path.join(WEB, 'favicon.png'))
    print(f'  ✓ {os.path.relpath(os.path.join(WEB, "favicon.png"), ROOT)}  64×64')
    for size in (192, 512):
        plain = crop.resize((size, size), Image.LANCZOS).convert('RGBA')
        plain.save(os.path.join(WEB, 'icons', f'Icon-{size}.png'))
        # maskable：底色铺满 + 主体缩到安全区（浏览器会按圆/方裁）
        canvas = Image.new('RGBA', (size, size), (bg[0], bg[1], bg[2], 255))
        paste_center(canvas, scaled(art, SAFE_RATIO, size))
        canvas.save(os.path.join(WEB, 'icons', f'Icon-maskable-{size}.png'))
        print(f'  ✓ web/icons/Icon-{size}.png ＋ Icon-maskable-{size}.png')
    return 0


if __name__ == '__main__':
    sys.exit(main())
