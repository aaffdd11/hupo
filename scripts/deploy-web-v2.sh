#!/usr/bin/env bash
# 出 Web 产物并部署到线上那个服务（本机 8020 → w.stalkerai.cn）。
#
# 用法：
#   scripts/deploy-web.sh                # 构建 + 部署 + 重启 + 公网验证
#   scripts/deploy-web.sh --no-build     # 不重新构建，直接部署现有的 build/web
#
# ── 为什么要有"给入口文件加指纹"这一步 ──────────────────────
# 踩过的坑（2026-09-21）：服务端原先给**除入口外的一切**发 `immutable`（一年），
# 而 Flutter web 的产物**文件名里没有指纹**（`main.dart.js`、`flutter_bootstrap.js`）。
# ⇒ 浏览器把旧的那份当成"一年内不用再问"，
#   **于是每次部署对已经来过的人等于没部署**（主人平板上看不到新按钮）。
#
# 修法两层：
#   ① 服务端：**只有名字里带指纹的才长缓存**，其余一律 `no-cache`（+ Last-Modified/304）
#      —— 见 `v2/services/core/src/server.js` 的 `cacheControlFor`
#   ② **这里**：部署时给那两个入口文件**起一个带指纹的名字**，并改写引用
#      ⇒ 名字变了，浏览器就一定会去取新的；而**名字没变时可以直接命中缓存**（不用往返）
#
# ⚠️ 这一步还是"一次性解药"：老访客浏览器里存着**旧的 immutable 响应**，
#    换响应头改不了它已经存下的东西 —— 但 `index.html` 一直是 `no-cache`，
#    所以它会取到新的 HTML，而新的 HTML 指向一个**新名字** ⇒ 自动绕开旧缓存。
#
# ── 为什么还有一道"引用图检查" ──────────────────────────────
# 改名是 `sed` 出来的：**漏一处 ⇒ 线上白屏**，而**构建和单测都还是绿的**
# （它们守的是 Dart 源码，碰不到产物里的路径）。
# ⇒ 重启之前先跑 `scripts/check-web-refs.mjs`：从 `index.html` 出发顺着引用
#   把每个被引用的文件都找到，**一个 404 都不许有**。这是"页面能不能开"的唯一本地判据。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/v2/apps/mobile"
CORE="$ROOT/v2/services/core"
WEB="$CORE/web"
FLUTTER="${FLUTTER_BIN:-$HOME/sdk/flutter/bin/flutter}"
DO_BUILD=1
[ "${1:-}" = "--no-build" ] && DO_BUILD=0

command -v "$FLUTTER" >/dev/null || { echo "✗ 找不到 flutter（设 FLUTTER_BIN）"; exit 2; }

if [ "$DO_BUILD" = "1" ]; then
  echo "▶ 构建 Web（release，不带 Service Worker）"
  ( cd "$APP" && "$FLUTTER" build web --release --pwa-strategy=none ) || {
    echo "✗ 构建失败，没有部署（线上仍是上一版：**宁可不变，也不要变坏**）"; exit 1; }
else
  echo "▶ --no-build：直接用现有的 $APP/build/web"
fi

BUILD_WEB="$APP/build/web"
[ -f "$BUILD_WEB/main.dart.js" ] || { echo "✗ $BUILD_WEB 里没有 main.dart.js"; exit 2; }

# 指纹按**入口文件的字节**算：内容不变 ⇒ 名字不变 ⇒ 缓存照样命中
STAMP="$(cat "$BUILD_WEB/main.dart.js" "$BUILD_WEB/flutter_bootstrap.js" | sha256sum | cut -c1-12)"
echo "▶ 入口指纹 $STAMP"

echo "▶ 给入口文件改名并改写引用"
rm -rf "$WEB" && mkdir -p "$WEB"
cp -r "$BUILD_WEB/." "$WEB/"

mv "$WEB/main.dart.js" "$WEB/main.$STAMP.dart.js"
mv "$WEB/flutter_bootstrap.js" "$WEB/flutter_bootstrap.$STAMP.js"
# flutter_bootstrap.js 里那几处 `main.dart.js` 是字面量，直接换
sed -i "s|main\.dart\.js|main.$STAMP.dart.js|g" "$WEB/flutter_bootstrap.$STAMP.js"
# index.html 里引的是 bootstrap
sed -i "s|flutter_bootstrap\.js|flutter_bootstrap.$STAMP.js|g" "$WEB/index.html"
# 老加载器（flutter.js）不在链上，但留着的引用也要对得上，免得排障时误导人
[ -f "$WEB/flutter.js" ] && sed -i "s|main\.dart\.js|main.$STAMP.dart.js|g" "$WEB/flutter.js"

for f in "main.$STAMP.dart.js" "flutter_bootstrap.$STAMP.js"; do
  [ -f "$WEB/$f" ] || { echo "✗ 改名之后找不到 $f"; exit 1; }
done
grep -q "flutter_bootstrap.$STAMP.js" "$WEB/index.html" || { echo "✗ index.html 没改写成功"; exit 1; }
grep -q "main.$STAMP.dart.js" "$WEB/flutter_bootstrap.$STAMP.js" || { echo "✗ bootstrap 没改写成功"; exit 1; }
echo "  ✓ 改完了"

# ── 自证：从 index.html 出发，顺着引用把每个文件都找一遍（**一个 404 都不许有**）──
# 为什么放在**重启之前**：改名是 sed 出来的，漏一处线上就是白屏，而构建/单测都还是绿的。
# 这是"页面能不能开"的**唯一本地判据**；对不上就**根本不部署**（沿用上面"宁可不变"那条纪律）。
NODE_BIN="${NODE_BIN:-$(command -v node)}"
[ -n "$NODE_BIN" ] || { echo "✗ 找不到 node（这条引用图检查要它；设 NODE_BIN）"; exit 2; }
echo "▶ 引用图检查（本地，0 个 404 才继续）"
"$NODE_BIN" "$ROOT/scripts/check-web-refs.mjs" "$WEB" | sed 's/^/  /' || {
  echo "✗ 引用图里有找不到的文件 ⇒ 没有部署（线上仍是上一版）"; exit 1; }

echo "▶ 重启服务（构建指纹 $STAMP）"
HUPO_BUILD_ID="$STAMP" bash "$ROOT/scripts/restart-core.sh" 2>&1 | grep -E "构建|监听|上次退出" | sed 's/^/  /'

echo "▶ 公网验证"
sleep 1
VER="$(curl -s https://w.stalkerai.cn/api/version)"
echo "  /api/version → $VER"
echo "$VER" | grep -q "\"$STAMP\"" || { echo "  ✗ 线上构建指纹不是 $STAMP"; exit 1; }

for f in "main.$STAMP.dart.js" "flutter_bootstrap.$STAMP.js"; do
  CC="$(curl -sI "https://w.stalkerai.cn/$f" | grep -i '^cache-control' | tr -d '\r')"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://w.stalkerai.cn/$f")"
  echo "  $f → $CODE ｜ $CC"
  echo "$CC" | grep -q immutable || { echo "  ✗ 带指纹的产物**应该**长缓存"; exit 1; }
done

# ⚠️ 入口那个 HTML **必须** no-cache —— 这正是这一整套要修的那个 bug
ENTRY_CC="$(curl -sI https://w.stalkerai.cn/index.html | grep -i '^cache-control' | tr -d '\r')"
echo "  index.html → $ENTRY_CC"
echo "$ENTRY_CC" | grep -q 'no-cache' || { echo "  ✗ 入口必须 no-cache"; exit 1; }
echo "  ✓ 入口 no-cache（老访客每次都会取到新的 HTML，从而指向新名字）"

echo
echo "✅ 完成：https://w.stalkerai.cn ｜ 入口指纹 $STAMP"
