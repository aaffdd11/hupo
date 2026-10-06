#!/usr/bin/env bash
# **窄闸**：只跑"这次改动真正该跑"的那一两条，迭代期用它。
#
# 用法：
#   scripts/gate-quick.sh <改动的路径…>        # 挑出来、跑掉
#   scripts/gate-quick.sh --list <改动路径…>   # 只说要跑什么，不跑
#
# ── 为什么要有它（读数在 `docs/dev/212` · 契约 `docs/dev/213`）────────
#   全闸（`npm test` / `check-client.sh`）一次 **8~16 分钟**；而"改一个纯函数"
#   真正需要的常常只是**那一个测试文件**（10 秒内）。契约 `213` 的第二条：
#   **迭代期只跑窄闸，全闸只在收尾跑一次**。
#
# 🔴 **三条不许破**：
#   ① **它不当全闸用**：结尾一定会写一句"收尾还要跑全闸"（不许拿它冒充收尾）；
#   ② **认不出就如实说"认不出"**（退回"跑全闸"），**绝不悄悄放过**；
#   ③ **映射只有这一处**（改哪块 → 跑哪条）。别处的纪律都指向这个脚本。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
APP="$ROOT/v2/apps/mobile"
FLUTTER="${FLUTTER_BIN:-$HOME/sdk/flutter/bin/flutter}"

LIST=0
if [ "${1:-}" = "--list" ]; then LIST=1; shift; fi
if [ "$#" = "0" ]; then
  echo "用法：scripts/gate-quick.sh [--list] <改动的路径…>" >&2
  exit 2
fi

CMDS=()          # 每条：'<在哪跑>|<命令>'
UNKNOWN=()       # 认不出的路径（要如实报）

add() { # add <cwd> <命令…>
  local cwd="$1"; shift
  local line="$cwd|$*"
  for c in "${CMDS[@]:-}"; do [ "$c" = "$line" ] && return; done
  CMDS+=("$line")
}

for p in "$@"; do
  rel="${p#"$ROOT"/}"
  case "$rel" in
    # ── 服务端：`src/<名字>.js` ⇒ `test/<名字>.test.js`（同名约定）──────────
    v2/services/core/src/*.js|v2/services/core/src/*.mjs)
      base="$(basename "$rel")"; base="${base%.*}"
      if [ -f "$CORE/test/$base.test.js" ]; then
        add "$CORE" "node --test test/$base.test.js"
      else
        add "$CORE" "npm test"   # 找不到同名判据 ⇒ 退回全闸（宁可慢，不许漏）
      fi
      ;;
    v2/services/core/test/*.test.js)
      add "$CORE" "node --test ${rel#"v2/services/core/"}"
      ;;
    v2/services/core/package.json|v2/services/core/hupo-*.yml)
      add "$CORE" "npm test"
      ;;
    # ── 客户端：先 analyze（硬闸），再那个文件对应的 unit / widget 判据 ──────
    v2/apps/mobile/lib/*.dart|v2/apps/mobile/lib/*/*.dart|v2/apps/mobile/lib/*/*/*.dart)
      add "$APP" "$FLUTTER analyze"
      stem="$(basename "$rel" .dart)"
      [ -f "$APP/test/unit/${stem}_test.dart" ] && add "$APP" "$FLUTTER test test/unit/${stem}_test.dart"
      [ -f "$APP/test/widget/${stem}_test.dart" ] && add "$APP" "$FLUTTER test test/widget/${stem}_test.dart"
      case "$rel" in v2/apps/mobile/lib/services/*|v2/apps/mobile/lib/models/*)
        [ -f "$APP/test/unit/${stem}_test.dart" ] || echo "  ⚠️ $rel 没有同名 unit 判据 ⇒ 建议收尾跑一次全闸" ;;
      esac
      ;;
    v2/apps/mobile/test/unit/*_test.dart|v2/apps/mobile/test/widget/*_test.dart)
      add "$APP" "$FLUTTER test ${rel#"v2/apps/mobile/"}"
      ;;
    # ── 文档 / 人格 / 能力层 ─────────────────────────────────────────
    *.md|docs/*|AGENTS.md|v2/services/core/hupo-persona.yml|v2/services/core/hupo-capabilities.yml)
      add "$ROOT" "node scripts/check-docs.mjs"
      [ "$rel" = "v2/services/core/hupo-persona.yml" ] && add "$ROOT" "bash scripts/check-persona.sh"
      ;;
    # ── 脚本本身：只有语法闸（它们没有别的判据）──────────────────────
    scripts/*.sh)
      add "$ROOT" "bash -n $rel"
      ;;
    scripts/*.mjs)
      add "$ROOT" "node --check $rel"
      ;;
    *) UNKNOWN+=("$rel") ;;
  esac
done

echo "▶ 窄闸（只跑这次改动该跑的；全闸留给收尾）"
if [ "${#CMDS[@]}" = "0" ]; then
  echo "  （一条都没挑出来）"
else
  for c in "${CMDS[@]}"; do
    echo "  · ${c%%|*} \$ ${c#*|}"
  done
fi
if [ "${#UNKNOWN[@]}" != "0" ]; then
  echo "  ⚠️ 认不出这几条路径 ⇒ **如实说**，请自己判断要不要跑全闸："
  for u in "${UNKNOWN[@]}"; do echo "     · $u"; done
fi
[ "$LIST" = "1" ] && exit 0

bad=0
for c in "${CMDS[@]}"; do
  cwd="${c%%|*}"; cmd="${c#*|}"
  echo
  echo "▶ $cmd"
  if ( cd "$cwd" && eval "$cmd" ); then echo "  ✓ 过"; else echo "  ✗ **这条窄闸没过**"; bad=1; break; fi
done

echo
echo "──────────────────────────────"
if [ "$bad" = "0" ]; then
  echo "✅ 窄闸过了"
  echo "⚠️ 这**不是**收尾：收尾仍要跑全闸（服务端 scripts/gate-server.sh · 客户端 scripts/check-client.sh）"
else
  echo "❌ 窄闸没过（先修它；收尾还要跑全闸）"
fi
exit "$bad"
