#!/usr/bin/env bash
# **仓库那份 nginx 抄本 vs VPS 上真正生效的那份**（对表 · P1-17 的后半 · B7）。
#
# ── 为什么要有它 ──────────────────────────────────────────────
#   公网那一跳（`w.stalkerai.cn`）真正的配置住在 **VPS** 上：
#   `120.26.179.211:/etc/nginx/conf.d/w-stalkerai.conf`。
#   仓库里那份 `deploy/nginx-w-stalkerai.conf` 只是**抄本** —— 它**不会自己同步**，
#   而它又是"唯一写下来的一份" ⇒ **漂了没人会发现**（比如有人手改过线上、或者抄本写错了）。
#   ⇒ 这条命令就是那双眼睛：**不一致就报红，并把差异打出来**。
#
# ── 只读 ──────────────────────────────────────────────────────
#   ⚠️ 它**只 `cat` 那一个文件**，不写、不 reload、不 sudo。改线上是主人的事（P1/P2）。
#
# ── 退出码 ────────────────────────────────────────────────────
#   0 = 对得上 · 1 = **不一致**（差异见输出）· 3 = 环境不具备（ssh 不通 / 读不到那两份）
#
# 用法：`bash scripts/check-nginx-drift.sh`（可加 `--diff` 看完整 diff）

set -uo pipefail

HOST="${HUPO_VPS_HOST:-root@120.26.179.211}"
REMOTE="${HUPO_VPS_NGINX:-/etc/nginx/conf.d/w-stalkerai.conf}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/deploy/nginx-w-stalkerai.conf"
WANT_DIFF=0
[ "${1:-}" = "--diff" ] && WANT_DIFF=1

if [ ! -f "$LOCAL" ]; then
  echo "✗ 仓库里那份抄本不在：$LOCAL"
  echo "  （它应该在 deploy/nginx-w-stalkerai.conf；没有它这条对表就没意义）"
  exit 3
fi

echo "▶ 对表：$HOST:$REMOTE  ⇄  $LOCAL"
REMOTE_TEXT="$(timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "cat $REMOTE" 2>/dev/null || true)"
if [ -z "$REMOTE_TEXT" ]; then
  echo "  ⚠️ 读不到线上那份（ssh 不通 / 路径不对 / 没权限）—— **不是"对得上"**"
  echo "     ⇒ 环境不具备，别把它当成通过（退出码 3）"
  exit 3
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
printf '%s\n' "$REMOTE_TEXT" > "$TMP"

if diff -q "$LOCAL" "$TMP" >/dev/null 2>&1; then
  echo "  ✓ 对得上（线上那份与仓库这份逐字节相同）"
  exit 0
fi

echo "  ✗ **不一致** —— 线上那份与仓库这份不一样了"
echo "     ⚠️ 这意味着其中一份过期了：改过线上没抄回来，或者抄本写错了。"
if [ "$WANT_DIFF" = "1" ]; then
  echo "  ── 差异（仓库那份 → 线上那份）────────────────"
  diff -u "$LOCAL" "$TMP" | head -60 || true
else
  echo "  （想看差异：bash scripts/check-nginx-drift.sh --diff）"
fi
echo '  ⇒ 修法：把线上那份**照实抄回** `deploy/nginx-w-stalkerai.conf`（抄本永远是"抄"的，不是"源"）'
exit 1
