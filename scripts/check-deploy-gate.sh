#!/usr/bin/env bash
# **变异验证**：部署前那道硬闸**真的挡得住**吗（P0-8）。
#
# 做法：把「客户端闸」换成一条一定失败的命令 ⇒ 部署必须
#   ① 非零退出；② 输出里明说"不部署"；③ **一个字节都不许动**（index.html 与入口文件清单不变）。
# 为什么要有它：2026-09-24 之前这个脚本**一道闸都不跑**，所以"闸绿"与"上线的东西"之间
# 没有任何强制关系 —— 一个子 agent 就这么把没验过的代码推上了生产。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/v2/services/core/web"

before_html="$(md5sum "$WEB/index.html" 2>/dev/null | cut -d' ' -f1)"
before_entries="$(ls -1 "$WEB"/main.*.dart.js 2>/dev/null | wc -l)"

out="$(HUPO_GATE_CLIENT=false bash "$ROOT/scripts/deploy-web-v2.sh" 2>&1)"; code=$?

after_html="$(md5sum "$WEB/index.html" 2>/dev/null | cut -d' ' -f1)"
after_entries="$(ls -1 "$WEB"/main.*.dart.js 2>/dev/null | wc -l)"

bad=0
say() { printf '  %s %s\n' "$1" "$2"; }
[ "$code" -ne 0 ] && say "✓" "闸红了 ⇒ 部署非零退出（退出码 $code）" || { say "✗" "闸红了居然还继续（退出码 0）"; bad=1; }
echo "$out" | grep -q "客户端闸红了 ⇒ \*\*不部署\*\*" && say "✓" "输出里明说「不部署」（线上仍是上一版）" || { say "✗" "没说「不部署」"; bad=1; }
[ "$before_html" = "$after_html" ] && say "✓" "index.html 一个字节没动" || { say "✗" "index.html 被动过了"; bad=1; }
[ "$before_entries" = "$after_entries" ] && say "✓" "入口文件数没变（$after_entries）" || { say "✗" "入口文件被动过"; bad=1; }
[ "$bad" = "0" ] && echo "✅ 部署前那道闸**挡得住**（变异验证过）" || echo "❌ 这道闸挡不住"
exit "$bad"
