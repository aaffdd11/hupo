#!/usr/bin/env bash
# 客户端的三道闸，一条命令跑完。
#
# 用法：scripts/check-client.sh
#
# ── 为什么要有这个脚本 ──────────────────────────────────────
# 因为**没人会记得敲三条命令**。而 `test/widget` 在别的项目里是"提示档"，
# 在这个项目里却有**一条硬闸**（决策 D3.5 点名要的），很容易被漏掉。
#
# ⚠️ 一条命令一条命令地跑，**不用 `&&` 串**：串起来的话第一条挂了后面就都不跑，
#    而"哪几条挂了"比"第一条挂了"有用得多。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/v2/apps/mobile"
FLUTTER="${FLUTTER_BIN:-$HOME/sdk/flutter/bin/flutter}"

command -v "$FLUTTER" >/dev/null || { echo "✗ 找不到 flutter（设 FLUTTER_BIN）"; exit 2; }
cd "$APP" || exit 2

bad=0
run() { # run <说明> <硬闸/提示> -- <命令...>
  local name="$1" kind="$2"; shift 3
  echo "▶ $name（$kind）"
  if "$@"; then
    echo "  ✓ 过"
  else
    if [ "$kind" = "硬闸" ]; then echo "  ✗ **硬闸没过**"; bad=1; else echo "  ⚠️ 提示档挂了（不拦，但别当没看见）"; fi
  fi
  echo
}

run "静态分析（编译都不过的东西不能上线）" "硬闸" -- "$FLUTTER" analyze
run "单元测试（协议 / 状态机 / 纯逻辑）" "硬闸" -- "$FLUTTER" test test/unit

# ⚠️ 这一份是**硬闸**，不是提示档 —— 决策 D3.5 原话："改成**硬闸**：五档 pump 无溢出"。
#    手册的通用规矩（"test/widget 只是提示"）在这儿被一条**具体决策**覆盖了。
run "可访问性（五档不溢出 + 命中区 ≥44 + 不封顶）" "硬闸" -- \
  "$FLUTTER" test test/widget/accessibility_test.dart

# 剩下的界面测试是提示档（D3.5 之外的那些，断言的是布局细节）
run "其余界面测试（提示）" "提示" -- \
  "$FLUTTER" test test/widget/busy_line_test.dart

echo "──────────────────────────────"
if [ "$bad" = "0" ]; then echo "✅ 硬闸全过"; else echo "❌ 有硬闸没过"; fi
exit "$bad"
