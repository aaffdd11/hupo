#!/usr/bin/env bash
# **删租户那条路的判据**（契约 `docs/dev/43-AUTO-PROVISION.md` · 手册 X3 ④）。
#
# 用法：
#   sudo bash scripts/check-tenant-removal.sh                        # 只验"拒"的那一半
#   sudo bash scripts/check-tenant-removal.sh --throwaway hupo-t3    # 再把一台**真删掉**并验干净
#
# ── 为什么"真删"要显式给名字 ────────────────────────────────
# 🔴 **它是不可逆的**。判据自己**不许**挑一台来删 —— 名字由人给，
#    而且只认模板推得出来的形状（`<前缀><1..上限>`）+ 静态表那两台**硬拒**。
#    不给 `--throwaway` ⇒ 只验"拒"的那一半，并**明写"跳过"**（跳过的不是过的）。
#
# ── 判据（每条都带负向对照）────────────────────────────────
#   ① 静态表那两台（`hupo-a`/`hupo-b`）⇒ **硬拒**（它们是老用户正在用的）；
#   ② 推不出来的名字（`../` / 越界 / 空 / 非数字）⇒ 拒；
#   ③ 不给目标 ⇒ 拒（**没有"删全部"这种参数**）；
#   ④ 非 root 跑 `--yes` ⇒ 拒；
#   ⑤ 真删一台 ⇒ 用户 / 家目录 / subuid / subgid / 通道 / linger **一样不剩**，
#      而且**别的租户一台都没被碰**（负向对照）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${HUPO_TENANT_TEMPLATE:-$ROOT/v2/services/core/tenant-template.conf}"
SERVICE_USER="${HUPO_SERVICE_USER:-deploy}"
CHAN_DIR="${HUPO_CHANNEL_DIR:-/run/hupo-channel}"
REMOVER="$ROOT/scripts/remove-tenant.sh"
THROWAWAY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --throwaway) shift; THROWAWAY="${1:-}" ;;
    *) echo "✗ 不认识的参数：$1"; exit 2 ;;
  esac
  shift
done

if [ "$(id -u)" != "0" ]; then
  echo "✗ 这个判据要 root（它要真删一台来看看清没清干净）。请：sudo bash $0"; exit 2
fi

pass=0; fail=0; skipped=0
ok()   { echo "  ✓ $1"; pass=$((pass + 1)); }
bad()  { echo "  ✗ $1"; fail=$((fail + 1)); }
skip() { echo "  · $1"; skipped=$((skipped + 1)); }

# 跑一次删租户脚本，把"最后一行"取出来（拒的时候它就是那句理由）
try() { bash "$REMOVER" "$@" 2>&1 | tail -1; }

# ══════════════════════════════════════════════════════════════════
echo "── 判据一：**拒**的那一半（一次都不许动手）"
# ══════════════════════════════════════════════════════════════════
# ① 🔴 静态表那两台：**硬拒**（这一条最要紧 —— 删了就是把人家的世界删了）
for p in hupo-a hupo-b; do
  out="$(try --name "$p")"
  if grep -q '永远不许删' <<<"$out"; then
    ok "「$p」⇒ 硬拒（$([ -d "/home/$p" ] && echo '而且它还在' || echo '⚠️ 它本来就不在'))"
  else
    bad "🔴 「$p」没被拒：$out"
  fi
done
# ② 推不出来的名字
for bad_name in '../../etc' 'hupo-t0' 'hupo-t99' 'hupo-x' '' 'hupo-t3/x'; do
  out="$(try --name "$bad_name")"
  if grep -qE '不许删|超出模板|不是模板推得出来|要给一个要删的租户' <<<"$out"; then
    ok "「${bad_name:-（空）}」⇒ 拒"
  else
    bad "「${bad_name:-（空）}」没被拒：$out"
  fi
done
# ③ 不给目标 ⇒ 拒（**没有"删全部"这种参数**）
out="$(try)"
if grep -q '要给一个要删的租户' <<<"$out"; then ok "不给目标 ⇒ 拒（没有"删全部"这种参数）"; else bad "不给目标居然过了：$out"; fi
# ④ 非 root 跑 --yes ⇒ 拒
out="$(sudo -u "$SERVICE_USER" -H bash "$REMOVER" --name hupo-t3 --yes 2>&1 | tail -1 || true)"
if grep -q '要 root' <<<"$out"; then ok "非 root 跑 --yes ⇒ 拒"; else bad "非 root 居然跑起来了：$out"; fi
# ⑤ 🔴 上面这一整轮**不许动任何东西**（负向对照：真机上那两台还在）
for p in hupo-a hupo-b; do
  if id "$p" >/dev/null 2>&1; then ok "「$p」**还在**（拒的那些一个都没动手）"; else bad "🔴 「$p」不见了 —— 拒的那条没挡住"; fi
done

# ══════════════════════════════════════════════════════════════════
echo
echo "── 判据二：**真删一台**（要显式给名字；它是**不可逆**的）"
# ══════════════════════════════════════════════════════════════════
if [ -z "$THROWAWAY" ]; then
  skip "没给 --throwaway ⇒ 这一半**没验**（不是过了）"
else
  T="$THROWAWAY"
  # 负向对照的基线：**别人**一台都不许少
  others_before="$(getent passwd | awk -F: '/^hupo-/{print $1}' | grep -v "^$T$" | sort | tr '\n' ' ')"
  if ! id "$T" >/dev/null 2>&1; then
    skip "「$T」本来就不在 ⇒ 这一半没验（它是幂等的：留下的是"清残留"那几步）"
  else
    echo "  删之前：$(id "$T")  家目录 $(stat -c '%a' "/home/$T" 2>/dev/null || echo 不在)"
  fi
  out="$(bash "$REMOVER" --name "$T" --yes 2>&1)"
  rc=$?
  # 逐样验"一样不剩"
  gone=1
  id "$T" >/dev/null 2>&1 && { bad "用户 $T 还在"; gone=0; }
  [ -d "/home/$T" ] && { bad "家目录还在：/home/$T"; gone=0; }
  grep -q "^$T:" /etc/subuid 2>/dev/null && { bad "/etc/subuid 里还有 $T"; gone=0; }
  grep -q "^$T:" /etc/subgid 2>/dev/null && { bad "/etc/subgid 里还有 $T"; gone=0; }
  [ -d "$CHAN_DIR/$T" ] && { bad "通道目录还在：$CHAN_DIR/$T"; gone=0; }
  [ -d "/var/lib/systemd/linger/$T" ] && { bad "linger 还在"; gone=0; }
  [ "$gone" = "1" ] && ok "「$T」⇒ 用户 / 家目录 / subuid / subgid / 通道 / linger **一样不剩**"
  # 脚本自己也得说清（它的退出码 + 自证那段）
  [ "$rc" = "0" ] && ok "脚本自己报成功（退出码 0）" || bad "脚本退出码是 $rc：$(tail -2 <<<"$out")"
  # 幂等：再跑一次不该出错、也不该报"又删了"
  out2="$(bash "$REMOVER" --name "$T" --yes 2>&1)"; rc2=$?
  if [ "$rc2" = "0" ] && grep -q '查无此人' <<<"$out2"; then
    ok "再跑一次 ⇒ 幂等（说"查无此人"、照样清残留、退出码 0）"
  else
    bad "再跑一次不对劲（rc=$rc2）：$(tail -2 <<<"$out2")"
  fi
  # 🔴 负向对照：**别人一台都没少**
  others_after="$(getent passwd | awk -F: '/^hupo-/{print $1}' | grep -v "^$T$" | sort | tr '\n' ' ')"
  if [ "$others_before" = "$others_after" ]; then
    ok "别的租户**一台都没少**（$others_after）"
  else
    bad "🔴 别的租户变了：之前 [$others_before] 现在 [$others_after]"
  fi
fi

echo
echo "──────────────────────────────"
if [ "$fail" = "0" ]; then
  echo "✅ 全过（过 $pass、跳过 $skipped）"
  [ "$skipped" != "0" ] && echo "⚠️ **有跳过的**（上面写了）—— 跳过的**不是**过的。"
  [ -n "$THROWAWAY" ] && echo "⚠️ 真删过东西 ⇒ **重启一次宿主服务**：scripts/restart-core.sh"
  exit 0
else
  echo "✗ 没过 $fail 条（过 $pass、跳过 $skipped）"
  exit 1
fi
