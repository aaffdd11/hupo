#!/usr/bin/env bash
# **窄闸**：只跑"这次改动真正该跑"的那几条，迭代期用它。
#
# 用法：
#   scripts/gate-quick.sh <改动路径…>        # 挑出来、跑掉
#   scripts/gate-quick.sh --list <改动路径…> # 只说要跑什么，不跑
#
# ── 为什么要有它（读数 `docs/dev/212` · 契约 `docs/dev/213`）──────────
#   全闸（`npm test` / `check-client.sh`）一次 **8~16 分钟**；而"改一个纯函数"
#   真正需要的常常只是**那一个测试文件**。契约 `213` 第二条：
#   **迭代期只跑窄闸，全闸只在收尾跑一次**。
#
# 🔴 **映射只有一处 —— 在 `scripts/test-map.mjs`**（它**现算**依赖图，不落死表）。
#   这一份只是它的薄壳：挑 → 打印 → 跑。要改挑法，去改那个 `.mjs`，**别在这儿写 case**。
#   （旧版就是在这儿手写 `case`：同名约定不成立时**退回全闸** —— 而"退回全闸"正是要消掉的事。）
#
# 🔴 **三条不许破**：
#   ① **它不当全闸用**：结尾一定会写一句"收尾还要跑全闸"；
#   ② **认不出就如实说"认不出"**（退回全闸），**绝不悄悄放过**；
#   ③ 映射住 `scripts/test-map.mjs`，这一份不重复一份。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "✗ 找不到仓库根目录"; exit 1; }

LIST=0
if [ "${1:-}" = "--list" ]; then LIST=1; shift; fi
if [ "$#" = "0" ]; then
  echo "用法：scripts/gate-quick.sh [--list] <改动的路径…>" >&2
  exit 2
fi

CMDS="$(node scripts/test-map.mjs --for "$@" 2>/tmp/gate-quick-note.$$)" || {
  echo "✗ 挑闸失败（test-map.mjs 出错）—— 退回去跑全闸" >&2
  cat /tmp/gate-quick-note.$$ >&2; rm -f /tmp/gate-quick-note.$$; exit 1
}
NOTE="$(cat /tmp/gate-quick-note.$$ 2>/dev/null)"; rm -f /tmp/gate-quick-note.$$

echo "▶ 窄闸（只跑这次改动该跑的；全闸留给收尾）"
if printf '%s\n' "$CMDS" | grep -qx 'FULL'; then
  echo "  🔴 有路径认不出 ⇒ **退回全闸**（不许当窄闸蒙过去）："
  echo "     服务端 scripts/gate-server.sh · 客户端 scripts/check-client.sh"
  [ -n "$NOTE" ] && printf '%s\n' "$NOTE" | sed 's/^/  /'
  exit 3
fi
if [ -z "${CMDS// /}" ]; then
  echo "  （一条都没挑出来 —— **如实说**：这次改动今天没有对应测试，不是「过了」）"
  [ -n "$NOTE" ] && printf '%s\n' "$NOTE" | sed 's/^/  /'
  exit 0
fi
printf '%s\n' "$CMDS" | sed 's/^/  · /'
[ -n "$NOTE" ] && printf '%s\n' "$NOTE" | sed 's/^/  /'
[ "$LIST" = "1" ] && exit 0

bad=0
while IFS= read -r c; do
  [ -z "$c" ] && continue
  echo
  echo "▶ $c"
  if bash -c "$c"; then echo "  ✓ 过"; else echo "  ✗ **这条窄闸没过**"; bad=1; break; fi
done <<< "$CMDS"

echo
echo "──────────────────────────────"
if [ "$bad" = "0" ]; then
  echo "✅ 窄闸过了"
  echo "⚠️ 这**不是**收尾：收尾仍要跑全闸（服务端 scripts/gate-server.sh · 客户端 scripts/check-client.sh）"
else
  echo "❌ 窄闸没过（先修它；收尾还要跑全闸）"
fi
exit "$bad"
