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

# 剩下的界面测试是提示档（D3.5 之外的那些，断言的是"**有没有画到屏幕上**"）。
# ⚠️ **按目录动态取，不写死文件名。** 写死的话，**以后新加的 widget 测试会永远不跑**——
#    而"新加的那一份"恰恰是最该跑的那一份。实测漏过两次：
#    `process_levels_test.dart`（批 3 过程四档加的）与 `scroll_follow_test.dart`（第 24 条加的）
#    都从没进过任何一道闸。⇒ 改成扫目录，漏一个在**结构上不可能**。
#    `accessibility_test.dart` 已经在上面当过硬闸了，这里排掉，免得同一份跑两遍。
HINT_FILES=()
for f in test/widget/*_test.dart; do
  case "$f" in
    *accessibility_test.dart) ;;
    *) HINT_FILES+=("$f") ;;
  esac
done
if [ "${#HINT_FILES[@]}" = "0" ]; then
  echo "✗ test/widget 下一个测试文件都没有 —— 这一档成了空转，先修它"
  exit 2
fi
run "其余界面测试（提示）" "提示" -- "$FLUTTER" test "${HINT_FILES[@]}"

echo "──────────────────────────────"
if [ "$bad" = "0" ]; then echo "✅ 硬闸全过"; else echo "❌ 有硬闸没过"; fi
exit "$bad"
