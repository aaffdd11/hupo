#!/usr/bin/env bash
# **把安装包发到首页**（主人 2026-09-28：*"你帮我放到 w.stalkerai.cn 上，放下载链接。
#   就是用户推出在首页就可以看到下载。"*）。
#
# 用法：
#   scripts/publish-apk.sh              # 打包 + 拷进 web/ + 在线核一遍
#   scripts/publish-apk.sh --no-build   # 用现有那个包（不重打）
#
# ── 这一步到底做了什么 ────────────────────────────────────
#   ① 打一个**正式签名**的包（`build-apk.sh`：地址 ＋ 权限 ＋ 签名都从包上核）；
#   ② 拷成 `v2/services/core/web/hupo.apk` —— 那个目录就是 `w.stalkerai.cn` 的根
#      （首页那颗「下载安卓版」指向 `/hupo.apk`）；
#   ③ **在线核一遍**：那条 URL 真的 200、`content-type` 是安卓包、
#      `content-disposition` 是 attachment、字节数与本地那个**一模一样**。
#
# 🔴 **为什么必须"在线核一遍"**（V13 那一族）：本地文件放对了**不等于**
#    访客拿得到 —— 静态服务会不会把 `.apk` 当页面回退成 index.html、
#    中间那层会不会改 content-type、隧道会不会截断，只有真请求一次才知道。
#    判据就钉在这条命令的输出上（第 ③ 步任一条不对 ⇒ 非零退出）。
#
# ⚠️ `deploy-web-v2.sh` 会 `rm -rf web/` ⇒ **部署网页之后 APK 会没**。
#    那个脚本里加了一步：只要构建产物还在，它会把包**再拷回去**；
#    保险起见，改完网页跑一次 `scripts/publish-apk.sh --no-build` 也行。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/v2/services/core/web"
APK_SRC="$ROOT/v2/apps/mobile/build/app/outputs/flutter-apk/app-release.apk"
APK_NAME="hupo.apk"
PUBLIC="${HUPO_PUBLIC:-https://w.stalkerai.cn}"

if [ "${1:-}" != "--no-build" ]; then
  bash "$ROOT/scripts/build-apk.sh" || exit 1
fi
if [ ! -f "$APK_SRC" ]; then
  echo "✗ 没有这个包：$APK_SRC（先跑 scripts/build-apk.sh）"
  exit 2
fi

echo
echo "▶ 拷进静态根（$WEB/$APK_NAME）"
mkdir -p "$WEB"
cp -f "$APK_SRC" "$WEB/$APK_NAME"

LOCAL_BYTES="$(wc -c < "$APK_SRC")"
LOCAL_SHA="$(sha256sum "$APK_SRC" | cut -d' ' -f1)"
echo "  本地       $LOCAL_BYTES 字节 · sha256 ${LOCAL_SHA:0:12}…"

echo
echo "▶ 在线核一遍：$PUBLIC/$APK_NAME"
HDR="$(curl -sS -D - -o /tmp/hupo-apk-dl.bin "$PUBLIC/$APK_NAME" 2>&1)"
CODE="$(printf '%s' "$HDR" | head -1 | awk '{print $2}')"
CT="$(printf '%s' "$HDR" | grep -i '^content-type:' | head -1 | cut -d' ' -f2- | tr -d '\r')"
CD="$(printf '%s' "$HDR" | grep -i '^content-disposition:' | head -1 | cut -d' ' -f2- | tr -d '\r')"
CL="$(printf '%s' "$HDR" | grep -i '^content-length:' | head -1 | awk '{print $2}' | tr -d '\r')"
DL_BYTES="$(wc -c < /tmp/hupo-apk-dl.bin)"
DL_SHA="$(sha256sum /tmp/hupo-apk-dl.bin | cut -d' ' -f1)"

echo "  HTTP       $CODE"
echo "  类型       ${CT:-（没有）}"
echo "  附件       ${CD:-（没有）}"
echo "  长度       ${CL:-（没有）}"
echo "  下到       $DL_BYTES 字节 · sha256 ${DL_SHA:0:12}…"

bad=0
[ "$CODE" = "200" ] || { echo "  ✗ 不是 200 —— 访客点那颗按钮拿不到包"; bad=1; }
case "$CT" in
  *vnd.android.package-archive*) echo "  ✓ 类型是安卓包" ;;
  *) echo "  ✗ 类型不对（$CT）—— 有的浏览器会把它当文本打开"; bad=1 ;;
esac
case "$CD" in
  *attachment*) echo "  ✓ 当附件发（点了是下载，不是就地打开）" ;;
  *) echo "  ✗ 少了 content-disposition: attachment"; bad=1 ;;
esac
if [ "$DL_BYTES" = "$LOCAL_BYTES" ] && [ "$DL_SHA" = "$LOCAL_SHA" ]; then
  echo "  ✓ 公网下到的与本地那个**逐字节一样**"
else
  echo "  ✗ 公网那份与本地不一样（$DL_BYTES vs $LOCAL_BYTES）—— 别发"
  bad=1
fi

echo
if [ "$bad" = "0" ]; then
  echo "✅ 发出去了：$PUBLIC/$APK_NAME"
  echo "   首页那颗「下载安卓版」指的就是它（客户端常量在 models/server_address.dart 的 hupoApkPath）"
  echo "   ⚠️ 下次跑 deploy-web-v2.sh 之后确认一眼：它会 rm -rf web/（脚本里那一步会再拷回来）"
else
  echo "❌ 没发成（上面那几条红的先修）"
fi
exit "$bad"
