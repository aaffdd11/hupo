#!/usr/bin/env bash
# **把安装包发到首页**（主人 2026-09-28：*"你帮我放到 w.stalkerai.cn 上，放下载链接。
#   就是用户推出在首页就可以看到下载。"*）。
#
# 用法：
#   scripts/publish-apk.sh --owner-asked   # ★ **主人说了才跑**：打包 + 拷进 web/ + 在线核一遍
#   scripts/publish-apk.sh --no-build       # 只把现有那个包拷回去（不重打）
#
# 🔴 **2026-10-01 主人定的规矩**（原话：*"apk我希望是我告诉你弄，你再打包。不然很浪费时间。"*）：
#    **打包一次好几分钟**（Flutter release build ＋ 签名 ＋ 上传核对），
#    而**大多数改动根本不需要新包**（网页那一半刷新就有）。⇒
#    **只有主人明说要 APK 时才打**；平时收尾**只部署网页**。
#    ⚠️ 这条**不靠"我记着"**：脚本**没有 `--owner-asked` 就直接拒绝**（同 `--spend` 那一族的形状）——
#      要跳过这一道，得**故意**把那个词打出来。
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
# 🔴 **2026-10-05：发出去那个文件名换了**（主人：*「这次是2.0版本了……不要覆盖1.0」*）——
#    2.0 是**另一个 app**（`chat.hupo.hupo_chat`、桌面上叫「琥珀聊天」）⇒ 发在
#    `hupo-chat*.apk`；1.0 那一份（`hupo.apk`）**原样留着**（老链接不许 404、也不许被顶掉）。
#
# ★ **2026-10-06：文件名带版本号**（主人：*「apk命名方式，我们也要用版本号来。就是下载链接
#    也要增加版本号。」*）⇒ 发成 `hupo-chat-<版本>.apk`（如 `hupo-chat-2.0.0-702.apk`），
#    **同时**把稳定名 `hupo-chat.apk` 刷成同一份字节：
#      · 稳定名是**已经装在他手机上的那些老客户端的链接**（冻结契约，不许 404）；
#      · 带版本那份是**留档**（那一条链接永远指向那一版，谁都能回头下）。
#    🔴 **那一版叫什么不住在这里**：`build-apk.sh` 算一次写进 `data/apk-build.json` 的 `file`
#       （`+`→`-` 的换算只在那一处），这里与 `deploy-web-v2.sh` 都**从账里读**。
#    显式覆盖：`HUPO_APK_NAME=xxx.apk scripts/publish-apk.sh …`。
# 稳定名（老客户端那条链接）——除非有人显式指名要发它。
APK_ALIAS="hupo-chat.apk"
PUBLIC="${HUPO_PUBLIC:-https://w.stalkerai.cn}"

# 🔴 **没有主人的话，不许打包**（2026-10-01 定的规矩）——
#    `--no-build`（只把现成的包拷回去）**不需要**那句话（它不花时间）；
#    真要**重打**一个包，必须显式写 `--owner-asked`。
case "${1:-}" in
  --no-build)
    : # 只拷回去：照旧
    ;;
  --owner-asked)
    bash "$ROOT/scripts/build-apk.sh" || exit 1
    ;;
  *)
    echo "⏸ 没有重打包（主人 2026-10-01 的规矩：*\"apk我希望是我告诉你弄，你再打包。不然很浪费时间。\"*）" >&2
    echo "   · 主人明说要 APK ⇒ 跑：scripts/publish-apk.sh --owner-asked" >&2
    echo "   · 只想把**现成的**那个包拷回 web/ ⇒ 跑：scripts/publish-apk.sh --no-build" >&2
    exit 3
    ;;
esac
if [ ! -f "$APK_SRC" ]; then
  echo "✗ 没有这个包：$APK_SRC（先跑 scripts/build-apk.sh）"
  exit 2
fi

# 🔴 **名字在这里才读**（`--owner-asked` 那一步刚把新的版本与文件名写进账里）——
#    读早了就会拿着**上一版**的名字去发这一版的字节（判据钉着这个先后）。
STATE_JSON="$ROOT/v2/services/core/data/apk-build.json"
VER_FILE="$( grep -o '"file":"[^"]*"' "$STATE_JSON" 2>/dev/null | cut -d'"' -f4 )"
APK_NAME="${HUPO_APK_NAME:-${VER_FILE:-hupo-chat.apk}}"

echo
echo "▶ 拷进静态根（$WEB/$APK_NAME）"
mkdir -p "$WEB"
cp -f "$APK_SRC" "$WEB/$APK_NAME"
# ★ 稳定名也刷一份（**已装的老客户端**那条链接指着它；冻结契约，不许断）
if [ "$APK_NAME" != "$APK_ALIAS" ]; then
  cp -f "$APK_SRC" "$WEB/$APK_ALIAS"
  echo "  另存稳定名 $APK_ALIAS（老客户端那条链接照旧能用）"
fi

LOCAL_BYTES="$(wc -c < "$APK_SRC")"
LOCAL_SHA="$(sha256sum "$APK_SRC" | cut -d' ' -f1)"
echo "  本地       $LOCAL_BYTES 字节 · sha256 ${LOCAL_SHA:0:12}…"

# ── 🔴 **签名那一笔账**（2026-09-30 补的，起因是真事）────────────────
#   主人那天报「安卓包显示 package is null」：包是好的、下载也是对的，
#   **根因是他手机上装着换签名之前的那个版本**（release keystore 08-29… 见下），
#   另一把签名**叠不上去**。⇒ 从那以后每次发布都记下这把签名的指纹，
#   **变了就当场喊出来**（"已经装了旧版的人必须先卸载"），不再靠记性。
# ⚠️ `apksigner` 是个 java 脚本 ⇒ **要把 JDK 放上 PATH**（本机 `java` 不在 PATH 里）
export JAVA_HOME="${JAVA_HOME:-$HOME/sdk/jdk17}"
export PATH="$JAVA_HOME/bin:$PATH"
APKSIGNER="$(ls -1 "${ANDROID_HOME:-$HOME/sdk/android-sdk}"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
CERT_SHA=""
if [ -n "$APKSIGNER" ]; then
  CERT_SHA="$( "$APKSIGNER" verify --print-certs "$APK_SRC" 2>/dev/null | grep -m1 'Signer #1 certificate SHA-256' | awk '{print $NF}' )"
fi
STATE="$WEB/../data/apk-signing.json"
PREV_CERT=""
if [ -f "$STATE" ]; then
  PREV_CERT="$( grep -o '"certSha256":"[0-9a-f]*"' "$STATE" 2>/dev/null | cut -d'"' -f4 )"
fi
if [ -n "$CERT_SHA" ]; then
  echo "  签名指纹   ${CERT_SHA:0:16}…"
  if [ -n "$PREV_CERT" ] && [ "$PREV_CERT" != "$CERT_SHA" ]; then
    echo
    echo "  🔴 **签名换了！** 上一次发出去那把是 ${PREV_CERT:0:16}…"
    echo "     ⇒ **已经装了旧版的人，必须先卸载再装**（另一把签名叠不上去）——"
    echo "       否则他们看到的就是「package is null」那一类提示（2026-09-30 真事）。"
  fi
  if [ -n "$CERT_SHA" ]; then
    printf '{"sha256":"%s","certSha256":"%s","at":"%s"}\n' "$LOCAL_SHA" "$CERT_SHA" "$(date -Is)" > "$STATE"
  fi
else
  echo "  ⚠️ 核不出签名指纹（没有 apksigner？）⇒ 这一笔没记账"
fi

# ⚠️ **换签名那一次之后，这一句必须说**（别只留在脚本的输出里）：
#    同一个签名的包可以直接覆盖安装；**换过签名**的必须先卸载。
echo "  装法       直接覆盖安装（同一把签名）；⚠️ 换签名那一版要**先卸载**再装"

echo
# 🔴 **两个名字都核**（2026-10-06）：带版本那份是"留档链接"，稳定那份是"老客户端链接" ——
#    哪一条断了都是"页面在说假话"，所以要各拉一遍、各比一次字节。
check_one() {
  local url="$1" label="$2" out="$3"
  local HDR CODE CT CD CL DL_BYTES DL_SHA
  HDR="$(curl -sS -D - -o "$out" "$url" 2>&1)"
  CODE="$(printf '%s' "$HDR" | head -1 | awk '{print $2}')"
  CT="$(printf '%s' "$HDR" | grep -i '^content-type:' | head -1 | cut -d' ' -f2- | tr -d '\r')"
  CD="$(printf '%s' "$HDR" | grep -i '^content-disposition:' | head -1 | cut -d' ' -f2- | tr -d '\r')"
  CL="$(printf '%s' "$HDR" | grep -i '^content-length:' | head -1 | awk '{print $2}' | tr -d '\r')"
  DL_BYTES="$(wc -c < "$out")"
  DL_SHA="$(sha256sum "$out" | cut -d' ' -f1)"
  echo "▶ 在线核一遍（$label）：$url"
  echo "  HTTP       $CODE"
  echo "  类型       ${CT:-（没有）}"
  echo "  附件       ${CD:-（没有）}"
  echo "  长度       ${CL:-（没有）}"
  echo "  下到       $DL_BYTES 字节 · sha256 ${DL_SHA:0:12}…"
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
}

bad=0
check_one "$PUBLIC/$APK_NAME" "带版本那一份" /tmp/hupo-apk-dl.bin
if [ "$APK_NAME" != "$APK_ALIAS" ]; then
  check_one "$PUBLIC/$APK_ALIAS" "稳定名（老客户端那条）" /tmp/hupo-apk-dl-alias.bin
fi

if [ "$bad" = "0" ]; then
  echo "✅ 发出去了：$PUBLIC/$APK_NAME"
  [ "$APK_NAME" != "$APK_ALIAS" ] && echo "   稳定名也刷新了：$PUBLIC/$APK_ALIAS"
  echo "   首页那颗「下载安卓版」指的是构建期那个 --dart-define=HUPO_APK_NAME 文件"
  echo "   （客户端常量在 models/server_address.dart 的 hupoApkPath；名字住 data/apk-build.json 的 file）"
  echo "   ⚠️ 下次跑 deploy-web-v2.sh 之后确认一眼：它会 rm -rf web/（脚本里那一步会再拷回来）"
else
  echo "❌ 没发成（上面那几条红的先修）"
fi
exit "$bad"
