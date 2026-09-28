#!/usr/bin/env bash
# **打一个能用的安卓包**（原生 Flutter · 主人 2026-09-28 拍板："原生 flutter。我不发布，
#   只安装在自己的设备。"）。
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
# ⚠️ 另外三条（都踩过）：
#   · **先 `source ~/sdk/env.sh`**：不 source 的话 `JAVA_HOME` 没设，
#     Gradle 5 秒就报 "JAVA_HOME is not set"（本机 JDK 是免 sudo 装在 ~/sdk/jdk17 的）；
#   · **签名是这台机器的 debug keystore**（`~/.android/debug.keystore`）——
#     自己装够用；但**同一把签名才能覆盖更新**，那把 keystore 丢了就只能卸载重装；
#   · **权限要从包里核**（`scripts/check-apk.sh`）：源文件对 ≠ 打出来的包对
#     （ManifestMerger 会合并、库 manifest 会注入）。这个坑本仓库踩过两次。
#
# 装法（自己设备）：`adb install -r <apk>`（覆盖安装会**保留数据**）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/v2/apps/mobile"
HUPO_API="${HUPO_API:-https://w.stalkerai.cn}"

echo "▶ 打安卓包（release）"
echo "  服务端地址  $HUPO_API   ← 原生包**必须**带（网页才是同源）"

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
if grep -aq "w.stalkerai.cn" "$APK" || unzip -p "$APK" 'lib/*/libapp.so' 2>/dev/null | grep -aq "w.stalkerai.cn"; then
  echo "  ✓ 包里找得到那个地址（编译期常量进去了）"
else
  echo "  ✗ **包里找不到那个地址** —— 这个包装上去会连不上（先别装）"
  exit 1
fi

echo
echo "装法： adb install -r \"$APK\"    （覆盖安装保留数据；同一把签名才叠得上去）"
echo "⚠️ 还没验到的：**没在真机/模拟器上跑过**（本机没有模拟器、也没有插着的设备）——"
echo "   装上去第一眼要看的是**登录页能不能连上**（那是这次改的那一处）。"
