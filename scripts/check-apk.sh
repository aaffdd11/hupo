#!/usr/bin/env bash
# 从**打出来的 APK** 里核权限。手册 `08-SPEC.md` §13.3 的 V10 就是这一类。
#
# 用法：
#   scripts/check-apk.sh [apk路径]
# 默认：v2/apps/mobile/build/app/outputs/flutter-apk/app-release.apk
#
# ── 为什么非要从**包**里读，而不是读源文件 ──────────────────────
# 源文件对，**不等于**打出来的包对。权限会被 ManifestMerger 合并、
# 会被库 manifest 注入、也会被 `tools:node` 覆盖。
# **交付出去的是包，不是源文件**——所以判据必须落在包上。
# （源文件那一层另有 `test/unit/android_manifest_test.dart` 守着，
#   那条快、每次都能跑；这条慢，发版前跑。）
#
# ── 为什么要单独一条命令 ────────────────────────────────────
# 这个坑在本仓库里**踩过两次**（旧 app 一次、v2 重建一次）。
# 而两次的现象都是"装上去停在登录页，且**不报权限错**"——
# 从现象根本猜不到是权限。所以它值得一条会红的检查。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK="${1:-$ROOT/v2/apps/mobile/build/app/outputs/flutter-apk/app-release.apk}"

# 按需加载 JDK / Android SDK 的路径（这套环境是免 sudo 装在 ~/sdk 的）
# shellcheck disable=SC1090
[ -f "$HOME/sdk/env.sh" ] && source "$HOME/sdk/env.sh"

AAPT="$(ls -1 "${ANDROID_HOME:-$HOME/sdk/android-sdk}"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1)"
if [ -z "$AAPT" ]; then
  echo "✗ 找不到 aapt2（在 \$ANDROID_HOME/build-tools/*/ 下）"
  exit 2
fi
if [ ! -f "$APK" ]; then
  echo "✗ 没有这个包：$APK"
  echo "  先出包： cd v2/apps/mobile && source ~/sdk/env.sh && flutter build apk --release"
  exit 2
fi

echo "▶ 核 $APK"
echo "  用 $AAPT"
PERMS="$("$AAPT" dump permissions "$APK" 2>/dev/null)"
if [ -z "$PERMS" ]; then
  # ⚠️ 负向对照：读不到任何东西时**不能当成"通过"**——
  #    那可能只是 aapt 用错了、或者包根本不是个包。
  #    （手册 §13.1 把"负向对照不能省"写死了，这里是同一个道理。）
  echo "✗ 一条权限都没读出来 —— 这**不能**算通过。先确认这个包是不是好的。"
  "$AAPT" dump permissions "$APK" 2>&1 | head -5
  exit 1
fi
echo "$PERMS" | sed 's/^/    /'

bad=0

# ① 必需项：没有它，release 包装上去**没有网**
if echo "$PERMS" | grep -q "android.permission.INTERNET"; then
  echo "  ✓ INTERNET 在"
else
  echo "  ✗ **缺 INTERNET** —— release 包会停在登录页，而且不会报权限错"
  bad=1
fi

# ② 一票否决：拿着它可以**在用户不知道的时候录音**
if echo "$PERMS" | grep -q "RECORD_BACKGROUND_AUDIO"; then
  echo "  ✗ **有后台录音权限** —— 一票否决（手册 §13.3 V10）"
  bad=1
else
  echo "  ✓ 没有后台录音权限"
fi

# ③ 批 5（语音）之前不该有 RECORD_AUDIO；做了语音之后这一条要反过来要求
if echo "$PERMS" | grep -q "android.permission.RECORD_AUDIO"; then
  echo "  ⚠️ 有 RECORD_AUDIO —— 说明语音那批已经做了，把这条断言反过来（V10 要求它必须在）"
else
  echo "  · 没有 RECORD_AUDIO（语音是批 5；到那时 V10 要求它**必须**在）"
fi

echo
if [ "$bad" = "0" ]; then
  echo "✅ 通过"
else
  echo "❌ 不通过"
fi
exit "$bad"
