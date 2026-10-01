#!/usr/bin/env bash
# **一个词落在哪** —— 一条命令列出全部落点（服务端 / 客户端 / 文档 / 测试分组）。
#
# 用法：
#   scripts/where.sh 'message/text'          # 一个协议 token
#   scripts/where.sh 'toolRow'               # 一个符号名
#   scripts/where.sh 'asr/' --count          # 只数条数
#
# ── 为什么要有它 ─────────────────────────────────────────
# 实测（2026-10-01）：**一条协议事件平均散在 45–90 个文件里**
# （`message/text` = 72 个：服务端 29 · 客户端 26 · 文档 17）。
# 手册里没有"它落在哪"这张表 —— 每次改协议相关的东西都要**重新考古一遍**，
# 而这就是"小需求也要长时间分析阅读"的一个大头。
#
# ⇒ 把考古变成**一条命令**。它**只列落点、不下结论**：
#    · 结论（字段语义、为什么冻结）在 `docs/handbook/03-DEVELOPMENT.md` §三 与 `08-SPEC.md`；
#    · "改完跑哪条闸"在 `docs/CHANGE-MAP.md`。
#
# ⚠️ 协议字段**一旦上线就冻结**（`AGENTS.md` §六 第 2 条）——
#    看到落点很多不等于"可以随便改"，只等于"改之前先知道会碰到谁"。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

usage() {
  cat <<'EOF'
用法：scripts/where.sh <词> [--count] [--limit N]

  <词>        要查的字符串（协议 token、符号名、路径片段…）。**原样传给 grep -F**，
              所以 `message/text` 里的 `/` 不用转义。
  --count     只打条数，不打文件名（落点很多时用）
  --limit N   每个分组最多列几行（默认全部）

例子：
  scripts/where.sh 'message/text'
  scripts/where.sh 'unsay'
  scripts/where.sh 'voiceReady' --count
EOF
}

if [ $# -eq 0 ]; then usage >&2; exit 2; fi
case "${1:-}" in -h|--help) usage; exit 0 ;; esac

NEEDLE=""
COUNT_ONLY=0
LIMIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --count) COUNT_ONLY=1; shift ;;
    --limit) LIMIT="${2:-0}"; shift 2 ;;
    -*) echo "✗ 不认识的参数：$1" >&2; usage >&2; exit 2 ;;
    *) NEEDLE="$1"; shift ;;
  esac
done
[ -z "$NEEDLE" ] && { echo "✗ 要给一个词" >&2; usage >&2; exit 2; }

# 扫哪些：源码 + 测试 + 文档（跳过构建产物与 node_modules）
SCAN_DIRS=(v2/services/core/src v2/services/core/test v2/apps/mobile/lib v2/apps/mobile/test docs scripts)

# grep -rn 一次，按路径分类
hits="$(grep -rnF --binary-files=without-match -- "$NEEDLE" "${SCAN_DIRS[@]}" 2>/dev/null || true)"

if [ -z "$hits" ]; then
  echo "▶ '$NEEDLE'：**一个落点都没有**"
  echo "  （要么拼错了，要么它住在别的目录 —— 换一个词试试）"
  exit 1
fi

classify() {   # 读 stdin 的行，返回分组名
  awk -F: '{
    p=$1
    if (p ~ /^v2\/services\/core\/src\//) print "服务端（src）";
    else if (p ~ /^v2\/services\/core\/test\//) print "服务端测试";
    else if (p ~ /^v2\/apps\/mobile\/lib\//) print "客户端（lib）";
    else if (p ~ /^v2\/apps\/mobile\/test\//) print "客户端测试";
    else if (p ~ /^docs\//) print "文档";
    else if (p ~ /^scripts\//) print "脚本";
    else print "其他";
  }'
}

total=$(printf '%s\n' "$hits" | wc -l)
n_js=$(printf '%s\n' "$hits" | grep -c '^v2/services/core/\(src\|test\)/' || true)
n_dart=$(printf '%s\n' "$hits" | grep -c '^v2/apps/mobile/\(lib\|test\)/' || true)
n_md=$(printf '%s\n' "$hits" | grep -c '^docs/' || true)
n_files=$(printf '%s\n' "$hits" | cut -d: -f1 | sort -u | wc -l)

echo "▶ '$NEEDLE'：**$total 处**，落在 **$n_files 个文件**里（服务端 $n_js · 客户端 $n_dart · 文档 $n_md）"

if [ "$COUNT_ONLY" = "1" ]; then
  echo "  （--count：只报数，不列文件）"
  exit 0
fi

for g in "服务端（src）" "客户端（lib）" "服务端测试" "客户端测试" "文档" "脚本" "其他"; do
  rows="$(printf '%s\n' "$hits" | awk -F: -v want="$g" '
    { p=$1
      if (want=="服务端（src）"      && p ~ /^v2\/services\/core\/src\//)  print
      else if (want=="客户端（lib）" && p ~ /^v2\/apps\/mobile\/lib\//)    print
      else if (want=="服务端测试"    && p ~ /^v2\/services\/core\/test\//) print
      else if (want=="客户端测试"    && p ~ /^v2\/apps\/mobile\/test\//)   print
      else if (want=="文档"          && p ~ /^docs\//)                     print
      else if (want=="脚本"          && p ~ /^scripts\//)                  print
      else if (want=="其他"          && p !~ /^(v2|docs|scripts)\//)        print
    }')"
  [ -z "$rows" ] && continue
  n=$(printf '%s\n' "$rows" | wc -l)
  echo
  echo "── $g（$n 处）──"
  if [ "$LIMIT" != "0" ] && [ "$n" -gt "$LIMIT" ]; then
    printf '%s\n' "$rows" | head -"$LIMIT" | sed 's/^/  /'
    echo "  … 还有 $((n - LIMIT)) 处（--limit 0 看全部）"
  else
    printf '%s\n' "$rows" | sed 's/^/  /'
  fi
done

echo
echo "⚠️ 落点多 ≠ 可以随便改：**协议字段一旦上线就冻结**（`AGENTS.md` §六 第 2 条）。"
echo "   改之前读 `docs/handbook/03-DEVELOPMENT.md` §三；改完跑哪条闸看 `docs/CHANGE-MAP.md`。"
