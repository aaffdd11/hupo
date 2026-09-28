#!/usr/bin/env python3
# **把主人给的一包壁纸收进 app 里**（生成"能上屏的那两份"）。
#
# 用法：
#   scripts/prepare-wallpapers.py <zip 或 目录>
#
# 产物（都在 `v2/apps/mobile/assets/wallpapers/` 下）：
#   wp-01.jpg …        桌面那张**整图**（长边压到 1600 以内、质量 82）
#   thumbs/wp-01.jpg   选壁纸那屏用来**看**的小图（宽 240）
#
# ── 为什么非要生成两份 ──────────────────────────────────────
#   ① 🔴 **选壁纸那一屏是一格一格的缩略图**：直接拿整图去铺 28 格，
#      解码出来是 28 × 上千万像素 ⇒ 手机上当场 OOM（这一条是本仓库最忌的"看起来能跑"）；
#   ② **整图也要压**：原包里最大那张 1200×2400、单张 291 KB，28 张合计 5.5 MB ——
#      压到长边 1600 / q82 之后合计约 2 MB（首屏不背这个，只在**真设上去**时才解码）。
#
# ⚠️ 依赖 Pillow（本机有）。它是个**一次性工具**：下一包壁纸重跑一遍就行。
# ⚠️ 命名用**序号**（`wp-01`…）：源图名是一串哈希（没有名字可读），而序号是稳定的 ——
#    判据与"盘上存的是哪一张"都按 id 认（`docs/dev/131-WALLPAPER.md`）。

import glob
import os
import sys
import zipfile

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print('✗ 需要 Pillow', file=sys.stderr)
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'v2/apps/mobile/assets/wallpapers')
THUMBS = os.path.join(OUT, 'thumbs')

FULL_MAX = 1600      # 长边
FULL_Q = 82
THUMB_W = 240
THUMB_Q = 78


def sources(arg):
    """把入参（zip 或目录）摊成一串图片路径，**按文件名排序**（序号才稳定）。"""
    tmp = None
    if os.path.isdir(arg):
        base = arg
    else:
        tmp = '/tmp/hupo-wallpapers-unzip'
        os.makedirs(tmp, exist_ok=True)
        with zipfile.ZipFile(arg) as z:
            z.extractall(tmp)
        base = tmp
    out = []
    for root, _dirs, files in os.walk(base):
        if '__MACOSX' in root:
            continue
        for f in files:
            if f.startswith('._'):
                continue
            if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
                out.append(os.path.join(root, f))
    return sorted(out)


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    files = sources(sys.argv[1])
    if not files:
        print('✗ 一张图都没找到', file=sys.stderr)
        return 2
    os.makedirs(THUMBS, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, 'wp-*.jpg')) + glob.glob(os.path.join(THUMBS, '*.jpg')):
        os.remove(old)

    total_full = total_thumb = 0
    for i, f in enumerate(files, start=1):
        im = Image.open(f).convert('RGB')
        # 整图：长边压到 FULL_MAX
        full = im.copy()
        full.thumbnail((FULL_MAX, FULL_MAX), Image.LANCZOS)
        p1 = os.path.join(OUT, f'wp-{i:02d}.jpg')
        full.save(p1, quality=FULL_Q, optimize=True)
        # 缩略图：宽 THUMB_W
        h = max(1, round(im.size[1] * THUMB_W / im.size[0]))
        th = im.resize((THUMB_W, h), Image.LANCZOS)
        p2 = os.path.join(THUMBS, f'wp-{i:02d}.jpg')
        th.save(p2, quality=THUMB_Q, optimize=True)
        total_full += os.path.getsize(p1)
        total_thumb += os.path.getsize(p2)
        print(f'  ✓ wp-{i:02d}  {im.size} → {full.size}  {os.path.getsize(p1)//1024} KB  (缩略 {os.path.getsize(p2)//1024} KB)')
    print(f'▶ 共 {len(files)} 张：整图 {total_full//1024} KB ＋ 缩略图 {total_thumb//1024} KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
