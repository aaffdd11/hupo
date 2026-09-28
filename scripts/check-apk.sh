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
BADGING="$("$AAPT" dump badging "$APK" 2>/dev/null)"
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

# ③ **`RECORD_AUDIO` 现在必须在**（V10）：原生那份录音 2026-09-28 做出来了
#    （`NativeRecorder.kt`，主人："你帮我测试录音能力。"）⇒ 少了这条权限，
#    真机上按「开始录」只会当场失败。⚠️ 而**后台录音仍然一票否决**（②）。
if echo "$PERMS" | grep -q "android.permission.RECORD_AUDIO"; then
  echo "  ✓ 有 RECORD_AUDIO（原生录音要用它 —— 手册 V10 要求必须在）"
else
  echo "  ✗ **缺 RECORD_AUDIO** —— 录音那一份在真机上按下去会当场失败（而屏幕上像'点了没反应'）"
  bad=1
fi

# ④ **图标从包里核**（2026-09-28 主人："用这个做 app 的 icon"）。
#
# 为什么非要从包里核：release 构建里 **AAPT2 会把资源文件改名**（`res/o-.png` 这种），
# 名字上看不出哪个是图标；而且**有了自适应图标之后**，`badging` 那条
# `application-icon-*` 指的是一个**编译过的 XML**（`res/BW.xml`，二进制 AXML），
# 解不出像素来。
# ⇒ 走**资源表**：`aapt2 dump resources` 里资源**名字**还在 ⇒ 从
#    `mipmap/ic_launcher`（xxxhdpi 那一档）拿到真正的 PNG 路径，再解出来数像素。
#    琥珀那张暖色像素占一半上下，Flutter 模板那张是蓝的（≈0%）。
# ⚠️ 实测负向对照（换图标**之前**那一个包）：`res/o-.png` · 192×192 · 暖色 **0.0%** ⇒ 这条闸会红。
if command -v python3 >/dev/null 2>&1 && python3 -c "import PIL" >/dev/null 2>&1; then
  RES_TABLE="$("$AAPT" dump resources "$APK" 2>/dev/null)"
  # ⚠️ `mipmap/ic_launcher$`（行尾锚定）：不锚的话 `mipmap/ic_launcher_foreground` 也会被捞进来
  ICON_PATH="$(echo "$RES_TABLE" | grep -A 8 'mipmap/ic_launcher$' | grep '(xxxhdpi)' | grep -oE 'res/[^ ]+\.png' | head -1)"
  if [ -z "$ICON_PATH" ]; then
    echo "  ✗ 包里找不出图标那一张 PNG（资源表里没有 mipmap/ic_launcher 的 xxxhdpi）"
    bad=1
  else
    TMP_ICON="$(mktemp --suffix=.png)"
    unzip -p "$APK" "$ICON_PATH" > "$TMP_ICON" 2>/dev/null
    RATIO="$(python3 - "$TMP_ICON" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA'); w,h = im.size; px = im.load()
warm=0; tot=0
for y in range(h):
    for x in range(w):
        r,g,b,a = px[x,y]; tot+=1
        if r > b+40 and r > 120: warm+=1
print(f'{warm/tot*100:.1f}')
PY
)" || RATIO=""
    if [ -z "$RATIO" ]; then
      echo "  ✗ 图标解不开（$ICON_PATH）—— 这一条没核成"
      bad=1
    else
      echo "  图标    $ICON_PATH（暖色像素 $RATIO%）"
      if [ "$(python3 -c "print(1 if $RATIO > 25 else 0)")" = "1" ]; then
        echo "  ✓ 图标是主人给的那张（暖色的琥珀气泡，不是 Flutter 模板那张蓝的）"
      else
        echo "  ✗ 包里那张图标**不是**我们那张（暖色只占 $RATIO%）—— 桌面上会是模板的样子"
        bad=1
      fi
    fi
    rm -f "$TMP_ICON"
  fi
else
  echo "  ⚠️ 这台机器没有 python3+PIL ⇒ 图标那一条没跑（没核）"
fi

echo
if [ "$bad" = "0" ]; then
  echo "✅ 通过"
else
  echo "❌ 不通过"
fi
exit "$bad"
