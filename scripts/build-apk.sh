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
start=$(date +%s)
# 🔴 下面这一行**必须**带着 `--dart-define=HUPO_API=`（判据钉着它，见脚本抬头那段）。
"${FLUTTER_BIN:-$HOME/sdk/flutter/bin/flutter}" build apk --release --dart-define=HUPO_API="$HUPO_API"
rc=$?
end=$(date +%s)
if [ "$rc" != "0" ]; then
  echo "✗ 打包失败（退出码 $rc）"
  exit "$rc"
fi

APK="$APP/build/app/outputs/flutter-apk/app-release.apk"
echo
echo "✅ 出包：$APK"
echo "   大小    $(du -h "$APK" | cut -f1)"
echo "   耗时    $((end - start))s（热 build；冷 build 要先下 Gradle 那一坨）"

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
