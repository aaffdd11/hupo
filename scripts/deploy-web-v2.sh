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
  # ⚠️ `--no-web-resources-cdn`（2026-09-23 加）：默认构建会把 CanvasKit 指向
  #    `https://www.gstatic.com/flutter-canvaskit/<hash>/` —— 国内经常取不到，
  #    页面就卡在那儿等（而**我们自己的 `canvaskit/` 明明已经打进产物了**）。
  #    ⇒ 自托管：从**我们自己的域名**取（配合预压缩，实测 br 后 2.1MB）。
  ( cd "$APP" && "$FLUTTER" build web --release --pwa-strategy=none --no-web-resources-cdn ) || {
    echo "✗ 构建失败，没有部署（线上仍是上一版：**宁可不变，也不要变坏**）"; exit 1; }
else
  echo "▶ --no-build：直接用现有的 $APP/build/web"
fi

BUILD_WEB="$APP/build/web"
[ -f "$BUILD_WEB/main.dart.js" ] || { echo "✗ $BUILD_WEB 里没有 main.dart.js"; exit 2; }

# 指纹按**入口文件的字节**算：内容不变 ⇒ 名字不变 ⇒ 缓存照样命中
PUBLIC_BASE="${HUPO_PUBLIC_BASE:-https://w.stalkerai.cn}"

# ── 🔴 字体回退**自托管**：补丁先打进构建产物，**再**算指纹 ──────────
# 为什么：CanvasKit 遇到**中文**会去 `fonts.gstatic.com` 取**分片字体**（每片约 25KB）。
# 国内那台经常取不到 ⇒ **页面很慢，甚至一个字都不显示**
# （实测：屏掉 gstatic 之后图标在、**中文字全空**；判据见 `check-web-browser.mjs --block-gstatic`）。
# ⇒ 把引擎的 `fontFallbackBaseUrl` 指到我们自己的 `/fonts/`
#   （服务端那边是个**白名单镜像**：只许 fonts.gstatic.com 的字体路径，见 `server.js`）。
#
# ⚠️ **补丁必须打在算指纹之前**（2026-09-23 修）：第一版是"先算指纹、后打补丁"，
#    拿一个 `FONT_PATCH_V` 字符串当替身 —— 那等于**改了补丁正文而名字不变**，
#    浏览器（`immutable`）会一直吃缓存里的**旧补丁**。
#    它已经骗过一次：A/B 两张截图 **sha 一模一样**，因为两次跑的都是旧补丁。
#    ⇒ 现在按**打过补丁的字节**算，替身字符串取消。
#
# ⚠️ **第一版还打错过地方**：塞进 `buildConfig` 的 JSON 里，而生成的尾巴是
#    `_flutter.loader.load();` —— **不带 config** ⇒ `buildConfig` 里的键
#    **根本不会被转发给引擎**（引擎只认 `load({config})` 那一份）。
BOOT_SRC="$BUILD_WEB/flutter_bootstrap.js"
if grep -q '_flutter.loader.load();' "$BOOT_SRC"; then
  # 🔴 **必须是绝对 URL**（第一版写的是相对地址 `/fonts/` —— 引擎**取到了字节却对不上号**，
  #    中文全变成方块；判据是"屏掉 gstatic 看有没有字"，A/B 才把它抓出来）。
  sed -i "s|_flutter.loader.load();|_flutter.loader.load({config:{fontFallbackBaseUrl:\"$PUBLIC_BASE/fonts/\"}});|" "$BOOT_SRC"
fi
grep -q "load({config:{fontFallbackBaseUrl:\"$PUBLIC_BASE/fonts/\"}})" "$BOOT_SRC" || {
  echo "  ✗ 字体回退没送进引擎（产物形状变了？看 `_flutter.loader.load(...)` 那一句）⇒ 没有部署"; exit 1; }
echo "  ✓ 字体回退自托管（fontFallbackBaseUrl=$PUBLIC_BASE/fonts/，**已计入指纹**）"

STAMP="$( { cat "$BUILD_WEB/main.dart.js" "$BOOT_SRC"; } | sha256sum | cut -c1-12)"
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

# ── 🔴 自托管 CanvasKit：产物里**不许**再出现 gstatic（2026-09-23 加）──
# 为什么钉在这儿：默认构建会把 CanvasKit 指向 gstatic，**国内经常取不到 ⇒ 页面卡着等**。
# 而这件事在构建/单测里都看不出来（它们是绿的）⇒ 只能查产物字节。
# ⚠️ **别拿"产物里有没有 gstatic 那个字符串"当判据**（第一版就是这么写的，误报）：
#    那个字符串是**加载器里的分支**（`useLocalCanvasKit` 为假时才走），**永远在**。
#    真正管用的是那面旗：`--no-web-resources-cdn` 会让产物里出现 `"useLocalCanvasKit":true`。
if ! grep -q '"useLocalCanvasKit":true' "$WEB/flutter_bootstrap.$STAMP.js"; then
  echo "  ✗ 产物里没有 useLocalCanvasKit:true ⇒ CanvasKit 还会去 gstatic（国内取不到）⇒ 没有部署"; exit 1
fi
echo "  ✓ CanvasKit 自托管（useLocalCanvasKit:true）"

# ── 字体回退那条口：**补丁在算指纹之前就打了**（见上面），这里只复核一遍 ──
# 复核值得留着：从打补丁到部署出去，中间还有 `cp -r`、两次改名、三处 `sed`，
# 任何一步把 bootstrap 覆盖了都会**静默**丢掉这个补丁。
BOOT="$WEB/flutter_bootstrap.$STAMP.js"
grep -q "load({config:{fontFallbackBaseUrl:\"$PUBLIC_BASE/fonts/\"}})" "$BOOT" || {
  echo "  ✗ 复制/改名之后补丁不见了 ⇒ 没有部署"; exit 1; }
echo "  ✓ 字体回退自托管（复核过：改名后的产物里补丁还在）"

# ── 🔴 预压缩（2026-09-23 加）──────────────────────────────────
# 实测：这条路的上行只有 ~3.4Mbps，而 main.dart.js 2.7MB / canvaskit.wasm 6.9MB
# 原本是**原样发**的（响应头里没有 content-encoding）⇒ 首屏几十秒。
# 预压之后 br 只剩 23% / 31%（实测），而且只有预压才用得上 brotli。
# ⚠️ 必须在**改名之后**压（压的就是改名后那一份）；⚠️ 压不动不许挡住上线。
NODE_BIN="${NODE_BIN:-$(command -v node)}"
echo "▶ 预压缩（br + gz，放在原文件旁边）"
"$NODE_BIN" "$ROOT/scripts/precompress.mjs" "$WEB" | sed 's/^/  /' || {
  echo "  ⚠️ 预压缩没做成 ⇒ **照常部署**（只是首屏慢一点），不许因为它挡住上线"
}

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

# ── 🔴 预压缩到底生效没有（只有**带上 Accept-Encoding 问一句**才看得出来）──
CE="$(curl -sI -H 'Accept-Encoding: br' https://w.stalkerai.cn/canvaskit/canvaskit.wasm | tr -d '\r' | grep -iE '^(content-encoding|content-length)' | tr '\n' ' ')"
echo "  canvaskit.wasm（带 br 问）→ $CE"
echo "$CE" | grep -qi 'content-encoding: br' || { echo "  ✗ 预压缩没生效（线上还是原样发）"; exit 1; }
CHECK_VARY="$(curl -sI https://w.stalkerai.cn/index.html | tr -d '\r' | grep -i '^vary')"
echo "  index.html 的 vary → ${CHECK_VARY:-（缺）}"
echo "$CHECK_VARY" | grep -qi 'accept-encoding' || { echo "  ✗ 缺 vary: accept-encoding（缓存可能发错那一份）"; exit 1; }

# ── 🔴 字体镜像那条口（白名单之外一律 404；它是个代理，必须挡住）──
FONT_OK="$(curl -s -o /dev/null -w '%{http_code}' 'https://w.stalkerai.cn/fonts/notosanssc/v37/不存在的.woff2')"
FONT_BAD="$(curl -s -o /dev/null -w '%{http_code}' 'https://w.stalkerai.cn/fonts/evil/v37/x.woff2')"
echo "  字体镜像：白名单内(不存在)=$FONT_OK ｜ 家族不在白名单=$FONT_BAD"
[ "$FONT_BAD" = "404" ] || { echo "  ✗ 白名单没挡住（$FONT_BAD）"; exit 1; }
# ⚠️ 穿越那一条**不能拿状态码判**：nginx 会先把 `..` 规范化掉，请求最后落到
#    SPA 的 index.html ⇒ 200 是**正常回退**（第一版就是这么误报的）。
#    该验的是：**它没有被当成字体发出去，也没有把那个文件的内容漏出来**。
TRAV_CT="$(curl -sI 'https://w.stalkerai.cn/fonts/notosanssc/../../../etc/passwd' | tr -d '\r' | grep -i '^content-type' | head -1)"
TRAV_BODY="$(curl -s 'https://w.stalkerai.cn/fonts/notosanssc/../../../etc/passwd' | grep -c '^root:' || true)"
echo "  字体镜像·穿越：$TRAV_CT ｜ body 里 root: 行数=$TRAV_BODY"
echo "$TRAV_CT" | grep -qi 'font/woff2' && { echo "  ✗ 穿越路径被当成字体发了"; exit 1; }
[ "$TRAV_BODY" = "0" ] || { echo "  ✗ 那个文件的内容漏出来了"; exit 1; }

# ⚠️ 入口那个 HTML **必须** no-cache —— 这正是这一整套要修的那个 bug
ENTRY_CC="$(curl -sI https://w.stalkerai.cn/index.html | grep -i '^cache-control' | tr -d '\r')"
echo "  index.html → $ENTRY_CC"
echo "$ENTRY_CC" | grep -q 'no-cache' || { echo "  ✗ 入口必须 no-cache"; exit 1; }
echo "  ✓ 入口 no-cache（老访客每次都会取到新的 HTML，从而指向新名字）"

echo
echo "✅ 完成：https://w.stalkerai.cn ｜ 入口指纹 $STAMP"
