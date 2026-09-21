#!/usr/bin/env bash
# **给主人看的那一笔账** —— 把两边（服务 · 特权侧）的行并起来按时间打出来。
#
# 用法：
#   bash scripts/show-audit.sh            # 全都打出来
#   bash scripts/show-audit.sh --tail 20  # 只看最后 20 条
#   bash scripts/show-audit.sh --since 2026-09-22
#
# ── 🔴 为什么要"两边两份文件" ────────────────────────────────
# 服务（`deploy`）与特权侧（root）**谁也写不了对方的文件** ⇒
# **谁也不能伪造对方的行** —— 这正是"账"该有的样子。
# 这一支只是把它们**按时间并起来**给人看（不改内容、不删任何一行）。
#
# ── 契约 ──────────────────────────────────────────────────
# `docs/dev/43-AUTO-PROVISION.md` §十四。行的形状（两边**逐字一致**）：
#     `[YYYY-MM-DD HH:MM:SS] 事件 · 租户 · 用户 · 手机(掩码) · 说明`
# ⚠️ 输出的每一行前面加一个**来源标签**（`服务` / `特权`）—— 标签是这一支加的，
#    文件里那一行**不带**标签（形状只有一处出处）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_AUDIT="${HUPO_SERVICE_AUDIT:-$ROOT/v2/services/core/data/audit.log}"
TENANT_AUDIT="${HUPO_TENANT_AUDIT:-/var/log/hupo/tenant-audit.log}"

TAIL_N=""
SINCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tail) shift; TAIL_N="${1:-}" ;;
    --since) shift; SINCE="${1:-}" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "✗ 不认识的参数：$1"; exit 2 ;;
  esac
  shift
done

echo "── 谁把哪一台收掉了（给主人看的那一笔账）──────────"
echo "  服务那侧：$SERVICE_AUDIT"
echo "  特权那侧：$TENANT_AUDIT"
echo

missing=0
for f in "$SERVICE_AUDIT" "$TENANT_AUDIT"; do
  [ -f "$f" ] || { echo "  ⚠️ 还没有这个文件：$f"; missing=$((missing + 1)); }
done
if [ "$missing" = "2" ]; then
  echo
  echo "（两边都还没有文件 ⇒ **到现在为止没有发生过"注销/回收"这类事**。这不是错误。）"
  exit 0
fi

# ⚠️ **标签要插在时间戳之后**（`[时间] [来源] 事件 · …`），**不能加在最前面** ——
#    加在最前面的话，整行排序会被中文前缀决定（"服务"永远排在"特权"前面），
#    时间顺序就没了。我第一版就是这么错的，一跑就露出来了（04:08 的行排在 04:06 后面）。
tag() {  # tag <标签> <文件>
  [ -f "$2" ] || return 0
  sed "s/^\(\[[^]]*\]\) /\1 [$1] /" "$2"
}
{
  tag "服务" "$SERVICE_AUDIT"
  tag "特权" "$TENANT_AUDIT"
} | { [ -n "$SINCE" ] && grep -F "$SINCE" || cat; } | sort | { [ -n "$TAIL_N" ] && tail -n "$TAIL_N" || cat; }

echo
echo "⚠️ 读法：同一次注销会有**两行**（服务记"收到请求/拒了"，特权侧记"真收掉了/没收成"）——"
echo "   它们对得上才说明**真的收了**；只有服务那一行 ⇒ 特权侧还没动（或者没动成）。"
