#!/usr/bin/env bash
# 构建 Flutter Web 并部署到 /var/www/hupo（nginx 静态托管）
#
# 用法：scripts/deploy-web.sh
# 环境：FLUTTER_BIN 指定 flutter；HUPO_DEPLOY_ANYWAY=1 跳过测试闸门（应急，会大声警告）
#
# ⚠ 闸门的分级（2026-09-15 改，**有原因，别改回去**）
#
#   静态分析   硬闸 —— 编译都不过的东西绝不能上线
#   单元测试   硬闸 —— 守协议、状态机、时间线不变量；这层坏了是真的坏
#   界面测试   提示 —— **不阻断**
#
# 为什么界面测试不一票否决：它断言的是**布局**（像素坐标、控件 key、
# "开发者卡片贴顶"这类）。界面一重构它们必然过期 —— 而"重构界面"
# 恰恰是主人最常要的改动。
#
# 拿它一票否决的后果（真实事故）：agent 改完桌面重构，卡在 10 个过期的界面
# 测试上出不来 —— 闸门不让部署 ⇒ 主人屏幕上什么都不变 ⇒ 那一轮跑了 6 分钟
# 都没结束（`turn/end` 事件 0 条）⇒ 主人的原话是「卡死并且不会改变」。
#
# 所以：**报出来，但让它过去**。界面是不是真坏了，靠 browser-check.mjs 看屏幕。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/apps/mobile"
TARGET="/var/www/hupo"

export PATH="${FLUTTER_BIN:-$HOME/sdk/flutter/bin}:$PATH"
command -v flutter >/dev/null || { echo "找不到 flutter，请设置 FLUTTER_BIN"; exit 1; }

if [ "${HUPO_DEPLOY_ANYWAY:-0}" = "1" ]; then
  echo "  ⚠⚠ HUPO_DEPLOY_ANYWAY=1：跳过静态分析与测试闸门 —— 出了问题自己担。"
  echo ""
else
  echo "▶ 静态分析（硬闸）"
  if ! (cd "$APP" && flutter analyze); then
    echo ""
    echo "✗ 静态分析没过。编译都不过的东西不上线 —— 先把它弄干净。"
    exit 1
  fi

  echo "▶ 单元测试（硬闸：协议 / 状态机 / 时间线不变量）"
  if ! (cd "$APP" && flutter test test/unit); then
    echo ""
    echo "✗ 单元测试没过。这层守的是协议和状态机 —— 它坏了是真的坏，不部署。"
    exit 1
  fi

  echo "▶ 界面测试（提示：不阻断）"
  if ! (cd "$APP" && flutter test test/widget); then
    echo ""
    echo "  ⚠ 界面测试有失败。"
    echo "    它们断言的是**布局**（坐标 / 控件 key / 哪块贴顶）——"
    echo "    界面一重构本来就会变，所以**不阻断部署**。"
    echo "    但别当没看见：确认不是真坏了 ——"
    echo "      cd services/core && node browser-check.mjs \"冒烟\""
    echo ""
  fi
fi

# ── 客户端构建指纹 ────────────────────────────────────────────
# 按**客户端源码内容**算。内容不变指纹就不变 —— 所以不会有
# "明明没改却一直让用户刷新"这种事；真改了，服务端就能发现并把在线客户端刷掉。
BUILD_ID="$(
  { find "$APP/lib" "$APP/web" -type f; echo "$APP/pubspec.yaml"; } \
    | sort | xargs sha256sum | sha256sum | cut -c1-16
)"
echo "▶ 构建 Web（release，不带 Service Worker）｜构建指纹 $BUILD_ID"
# --pwa-strategy=none 关掉 Service Worker：
# 否则浏览器会一直用缓存的旧 main.dart.js，部署了新版本用户也看不到。
# 开发期必须关；上线稳定后再考虑打开（那时要配合版本化资源名）。
if ! (cd "$APP" && flutter build web --release --pwa-strategy=none --dart-define=HUpo_BUILD_ID="$BUILD_ID"); then
  echo "✗ 构建失败，没有部署。线上仍是上一版（宁可不变，也不要变坏）。"
  exit 1
fi

# 注入"自愈"脚本：注销历史 Service Worker 并清空缓存。
# 为什么需要：浏览器里已注册的旧 SW 不会因为新构建没有 SW 就消失，
# 它会继续用缓存里的旧 main.dart.js —— 用户以为看到的是新版，其实是几小时前的。
# 这段代码在每次加载时主动注销，一次性解决，不需要用户手动清缓存。
echo "▶ 用自毁式 Service Worker 顶掉用户浏览器里的旧 SW"
# --pwa-strategy=none 生成的 SW 是空文件；这里覆盖成"自毁式"：
# 浏览器下次导航会取到它 → 它清空缓存、注销自己、让页面重载 → 从此不再有 SW。
cp "$ROOT/scripts/self-destruct-sw.js" "$APP/build/web/flutter_service_worker.js" || exit 1

echo "▶ 注入 Service Worker 自愈脚本"
node "$ROOT/scripts/inject-sw-cleanup.mjs" "$APP/build/web/index.html" || exit 1

echo "▶ 部署到 $TARGET"
sudo mkdir -p "$TARGET" || exit 1
sudo rsync -a --delete "$APP/build/web/" "$TARGET/" || exit 1

# 把指纹写到站点根目录：服务端盯着这个文件，一变就通知在线客户端刷新自己。
# ⚠ 必须在 rsync **之后**写 —— rsync 带 --delete，写在前面会被删掉。
# ⚠ 顺序也不能换：chown 必须在写完之后，否则这个文件是 root 的，
#   部署脚本自己下次就改不动它了（踩过）。
printf '{"buildId":"%s","builtAt":"%s"}\n' "$BUILD_ID" "$(date -Iseconds)" \
  | sudo tee "$TARGET/client-build.json" >/dev/null || exit 1
sudo chown -R "$(id -un):$(id -gn)" "$TARGET" || exit 1

echo "✅ 完成。站点：https://hupo.stalkerai.cn"
echo "   构建指纹：$BUILD_ID（服务端会据此通知在线客户端刷新）"
