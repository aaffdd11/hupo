#!/usr/bin/env bash
# **打一个能用的安卓包**（原生 Flutter · 主人 2026-09-28 拍板："原生 flutter。我不发布，
#   只安装在自己的设备。"；同日又拍板："先建一把正式 keystore，再用它签" ——
#   因为这个包要**挂到首页给人下载**）。
#
# 用法：
#   scripts/build-apk.sh                 # 用默认地址 https://w.stalkerai.cn
#   HUPO_API=https://别的地址 scripts/build-apk.sh
#
# ── 为什么非要有这个脚本（不是"多一层封装"）────────────────────
# 🔴 客户端**没有"服务端地址"这个概念**：网页上一切请求都是**同源**的相对路径
#    （地址栏那个就是它）。而**原生包上没有地址栏** —— 实测（2026-09-28）：
#        Uri.base = file:///…  ·  Uri.parse('/api/version') 没有 host
#    ⇒ 不带地址打出来的包，装上去**一直连不上**，而且**不会报错**、**每道闸都是绿的**。
#    ⇒ 所以地址只许从**这一条命令**进（`--dart-define=HUPO_API=…`），
#      判据钉着这一行（`test/unit/server_address_test.dart`）——
#      **结构上让"打出一个连不上的包"变得不可能**。
#
# 🔴 **签名同理**：正式签名只在 `~/.hupo/release-signing.env`（0600、仓库外）里，
#    这个脚本 source 它再 export 给 Gradle；**没有它就直接停**
#    （缺了的话 Gradle 也会当场抛 —— 两处都拦，免得打出一个 debug 签名的包挂到公网）。
#
# ⚠️ 另外三条（都踩过）：
#   · **先 `source ~/sdk/env.sh`**：不 source 的话 `JAVA_HOME` 没设，
#     Gradle 5 秒就报 "JAVA_HOME is not set"（本机 JDK 是免 sudo 装在 ~/sdk/jdk17 的）；
#   · **权限要从包里核**（`scripts/check-apk.sh`）：源文件对 ≠ 打出来的包对
#     （ManifestMerger 会合并、库 manifest 会注入）。这个坑本仓库踩过两次；
#   · **签名也要从包里核**（这个脚本最后那一步）：签错了整条更新链就断了。
#
# 装法（自己设备）：`adb install -r <apk>`（覆盖安装会**保留数据**）。
# 给别人下载：`scripts/publish-apk.sh`（它调这个脚本，再把包装进 `web/hupo.apk`）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/v2/apps/mobile"
HUPO_API="${HUPO_API:-https://w.stalkerai.cn}"
SIGN_ENV="${HUPO_SIGN_ENV:-$HOME/.hupo/release-signing.env}"

echo "▶ 打安卓包（release）"
echo "  服务端地址  $HUPO_API   ← 原生包**必须**带（网页才是同源）"

if [ ! -f "$SIGN_ENV" ]; then
  echo "✗ 没有正式签名那份：$SIGN_ENV"
  echo "  ⇒ release 包必须用**正式**签名（debug 签名是公开的，不能往外发）。"
  echo "  生成一把（一次性；口令只落在这个文件里、不进仓库）："
  echo "    mkdir -p ~/.hupo && chmod 700 ~/.hupo"
  echo "    PW=\"\$(openssl rand -base64 32 | tr -d '/+=' | head -c 28)\""
  echo "    HUPO_STORE_PASSWORD=\"\$PW\" HUPO_KEY_PASSWORD=\"\$PW\" \\"
  echo "      ~/sdk/jdk17/bin/keytool -genkeypair -keystore ~/.hupo/hupo-release.jks \\"
  echo "        -alias hupo -keyalg RSA -keysize 4096 -validity 10950 \\"
  echo "        -storepass:env HUPO_STORE_PASSWORD -keypass:env HUPO_KEY_PASSWORD \\"
  echo "        -dname 'CN=Hupo, OU=hupo, O=hupo, C=CN'"
  echo "    # 再把 HUPO_STORE_FILE / HUPO_STORE_PASSWORD / HUPO_KEY_ALIAS / HUPO_KEY_PASSWORD"
  echo "    # 写进 $SIGN_ENV（chmod 600）"
  exit 2
fi
# shellcheck disable=SC1090
source "$SIGN_ENV"
for v in HUPO_STORE_FILE HUPO_STORE_PASSWORD HUPO_KEY_ALIAS HUPO_KEY_PASSWORD; do
  if [ -z "${!v:-}" ]; then echo "✗ $SIGN_ENV 里少了 $v"; exit 2; fi
done
export HUPO_STORE_FILE HUPO_STORE_PASSWORD HUPO_KEY_ALIAS HUPO_KEY_PASSWORD
if [ ! -f "$HUPO_STORE_FILE" ]; then echo "✗ 找不到 keystore：$HUPO_STORE_FILE"; exit 2; fi

# shellcheck disable=SC1090
[ -f "$HOME/sdk/env.sh" ] && source "$HOME/sdk/env.sh"
if [ -z "${JAVA_HOME:-}" ]; then
  echo "✗ JAVA_HOME 没设 —— 先 source ~/sdk/env.sh（脚本里已经 source 过一次，看看那个文件在不在）"
  exit 2
fi

cd "$APP" || exit 2

# ── 🔴 **版本号每次打包都要变**（主人 2026-09-30：*「每次打包要修改版本号」*）────
#
# 为什么非要自动算：靠记性手改 `pubspec.yaml` ⇒ 迟早连着两次打同一个号
#   （安卓那边"同号覆盖"看着像成功，而**装的人分不清手上是哪一个包**）。
# 取值三条规矩：
#   ① **单调增**（安卓不许降级安装）：取 `git 提交数` 与"本机那份高水位"里**大的那个** ＋1
#      —— 提交数让"换台机器/重新克隆"也不会倒退，高水位让"同一个提交打两次"也各是各的号；
#   ② **版本名也带它**（`1.0.0+<N>`）：他能在 设置→应用→琥珀 里**看见**手上是哪一个包；
#   ③ 记在 `data/apk-build.json`（gitignore 里，机器本地）—— 和签名那笔账同一个家。
PKG_VER="$(grep -m1 '^version:' pubspec.yaml | awk '{print $2}')"
BASE_NAME="${PKG_VER%%+*}"
COMMITS="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 0)"
STATE="$ROOT/v2/services/core/data/apk-build.json"
PREV="$( grep -o '"buildNumber":[0-9]*' "$STATE" 2>/dev/null | cut -d: -f2 )"
PREV="${PREV:-0}"
HIGH=$(( COMMITS > PREV ? COMMITS : PREV ))
BUILD_NUMBER=$(( HIGH + 1 ))
BUILD_NAME="${BASE_NAME}+${BUILD_NUMBER}"
# ★ **2026-10-06：包名带版本号**（主人：*「apk命名方式，我们也要用版本号来。就是下载链接也要增加版本号。」*）。
#   🔴 **这一条规则只住在这里**（算一次，写进那笔账；发与部署都从账里读 `file`）——
#      绝不在别的脚本里再写一遍 `+`→`-` 的换算（两处就一定漂）。
#   ⚠️ `+` 换成 `-`：`+` 在 URL 路径里虽然合法，但各类下载器/代理对它的处理不一致
#      ⇒ 文件名用 `-`（版本号本身一位不少：`2.0.0-702`）。
APK_FILE="hupo-chat-${BUILD_NAME//+/-}.apk"
echo "▶ 版本号（每次打包都变）"
echo "    pubspec 里写着 $PKG_VER · git 提交数 $COMMITS · 本机高水位 $PREV"
echo "    ⇒ **versionCode=$BUILD_NUMBER · versionName=$BUILD_NAME**"
echo "    ⇒ 发出去的文件名 **$APK_FILE**（另一份稳定名 hupo-chat.apk 照旧刷新，老客户端那条链接不断）"
printf '{"buildNumber":%s,"versionName":"%s","file":"%s","at":"%s"}\n' "$BUILD_NUMBER" "$BUILD_NAME" "$APK_FILE" "$(date -Is)" > "$STATE"

start=$(date +%s)
# 🔴 下面这一行**必须**带着 `--dart-define=HUPO_API=`（判据钉着它，见脚本抬头那段）。
"${FLUTTER_BIN:-$HOME/sdk/flutter/bin/flutter}" build apk --release \
  --build-name="$BUILD_NAME" --build-number="$BUILD_NUMBER" \
  --dart-define=HUPO_API="$HUPO_API" \
  --dart-define=HUPO_APK_NAME="$APK_FILE"
rc=$?
end=$(date +%s)
if [ "$rc" != "0" ]; then
  echo "✗ 打包失败（退出码 $rc）"
  exit "$rc"
fi

APK="$APP/build/app/outputs/flutter-apk/app-release.apk"

# 🔴 **强制三样签名（v1+v2+v3）**（2026-09-30）：
#    AGP 在 `minSdk >= 24` 时会**跳过 v1（JAR 签名）** —— 而 v1 正是
#    "老一点的解析器 / 某些厂商安装器"唯一认得的那一份（我们把
#    `enableV1Signing = true` 写进 Gradle 里，实测**没生效**）。
#    ⇒ 打完再用 apksigner 补签一次：三样都开。代价是包大几百 KB。
APKSIGNER="${APKSIGNER:-$(ls -1 "${ANDROID_HOME:-$HOME/sdk/android-sdk}"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)}"
export JAVA_HOME="${JAVA_HOME:-$HOME/sdk/jdk17}"
export PATH="$JAVA_HOME/bin:$PATH"
if [ -n "$APKSIGNER" ]; then
  echo
  echo "▶ 补签：v1+v2+v3 三样都开（AGP 在 minSdk>=24 时只给 v2/v3）"
  "$APKSIGNER" sign \
    --ks "$HUPO_STORE_FILE" --ks-pass "pass:$HUPO_STORE_PASSWORD" \
    --ks-key-alias "$HUPO_KEY_ALIAS" --key-pass "pass:$HUPO_KEY_PASSWORD" \
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
    "$APK" || { echo "  ✗ 补签失败"; exit 1; }
  "$APKSIGNER" verify --verbose "$APK" 2>/dev/null | grep -E "Verified using v[123]" | sed 's/^/    /'
fi

echo
echo "✅ 出包：$APK"
echo "   大小    $(du -h "$APK" | cut -f1)"
echo "   耗时    $((end - start))s（热 build；冷 build 要先下 Gradle 那一坨）"

echo
echo "▶ 从**包里**核版本号（我们要的那个号，真的进了包没有）"
AAPT="$(ls -1 "${ANDROID_HOME:-$HOME/sdk/android-sdk}"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1)"
if [ -n "$AAPT" ]; then
  APK_VC="$( "$AAPT" dump badging "$APK" 2>/dev/null | sed -n "s/^package:.*versionCode='\([0-9]*\)'.*/\1/p" | head -1 )"
  APK_VN="$( "$AAPT" dump badging "$APK" 2>/dev/null | sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p" | head -1 )"
  echo "    包里写着   versionCode=$APK_VC · versionName=$APK_VN"
  if [ "$APK_VC" != "$BUILD_NUMBER" ]; then
    echo "  ✗ **包里的号不是我们要的那个**（要 $BUILD_NUMBER）—— 这个包别发"
    exit 1
  fi
  echo "  ✓ 与打包时算的那个号一致"
else
  echo "  ⚠️ 找不到 aapt2 ⇒ 这一步没跑（版本号没核）"
fi

echo
echo "▶ 从**包里**核权限与地址（源文件对 ≠ 包对）"
bash "$ROOT/scripts/check-apk.sh" "$APK" || exit 1

# 🔴 **地址真的进了包**：`HUPO_API` 是编译期常量 ⇒ 它会出现在产物里。
#    这一步是"V13 那一族"的落点：**客户端自己算的东西，验在客户端这一侧**。
if unzip -p "$APK" 'lib/*/libapp.so' 2>/dev/null | grep -aq "w.stalkerai.cn" || grep -aq "w.stalkerai.cn" "$APK"; then
  echo "  ✓ 包里找得到那个地址（编译期常量进去了）"
else
  echo "  ✗ **包里找不到那个地址** —— 这个包装上去会连不上（先别装）"
  exit 1
fi

# 🔴 **签名是从包里核的**（不是"我看了一眼 Gradle 文件"）：签错了，整条更新链就断了。
APKSIGNER="$(ls -1 "${ANDROID_HOME:-$HOME/sdk/android-sdk}"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
if [ -n "$APKSIGNER" ]; then
  echo
  echo "▶ 核签名（必须是正式那把，不是 debug）"
  "$APKSIGNER" verify --print-certs "$APK" 2>/dev/null | grep -E "Signer #1 certificate DN|Signer #1 certificate SHA-256" | sed 's/^/    /'
  SIGNED_FP="$( "$APKSIGNER" verify --print-certs "$APK" 2>/dev/null | grep -m1 'Signer #1 certificate SHA-256' | awk '{print $NF}' )"
  DEBUG_FP="$( ~/sdk/jdk17/bin/keytool -list -v -keystore "$HOME/.android/debug.keystore" -alias androiddebugkey -storepass android -keypass android 2>/dev/null | grep -m1 'SHA256:' | tr -d ' ' | cut -d: -f2- )"
  if [ -n "$DEBUG_FP" ] && [ "$DEBUG_FP" = "$SIGNED_FP" ]; then
    echo "  ✗ **这个包是 debug 签名** —— 不许往外发"
    exit 1
  fi
  echo "  ✓ 不是 debug 那把（正式签名在 $HUPO_STORE_FILE）"
else
  echo "  ⚠️ 找不到 apksigner ⇒ 这一步没跑（签名没核）"
fi

echo
echo "装法： adb install -r \"$APK\"    （覆盖安装保留数据；同一把签名才叠得上去）"
echo "发到首页： scripts/publish-apk.sh  （打好的包拷进 web/hupo.apk 并在线核一遍）"
