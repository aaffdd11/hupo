#!/usr/bin/env bash
# **客户端源码的指纹**（给"线上那份是不是仓库这一版"用 · P1-17 的同族）。
#
# 为什么要有它：上一轮那条"租户产品层**落后于仓库**"的闸救了一次 —— 而那类漂
# **客户端也有一份**：改了 `lib/**` 却没部署，线上还是旧的那一版，
# **没有任何东西会喊**（页面照常打开，只是少了个刚做好的东西）。
#
# 口径：`lib/**` ＋ `pubspec.yaml` ＋ `web/index.html` 的**内容**（按路径排序后一起算），
# 与 git 状态无关 —— 部署是从**工作树**构建的，所以标记也只能按工作树算。
# ⚠️ **不碰** `build/` 与线上 `web/`（它们是被构建出来的，不是源）。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/v2/apps/mobile"
cd "$APP" || exit 3
{ find lib -type f -name '*.dart' | LC_ALL=C sort | xargs sha256sum;
  sha256sum pubspec.yaml web/index.html 2>/dev/null; } | sha256sum | cut -c1-12
