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
echo "── 判据一·补 🔴 **服务写的名字 vs 助手认的名字**必须逐字一致"
# ══════════════════════════════════════════════════════════════════
# ⚠️ **这一条的来历**（2026-09-22，我自己栽的）：
#    服务侧写的回收申请是 ``${p}.cancel``，而 ``p`` 是 ``<dir>/3.req``
#    ⇒ 落地成了 **``3.req.cancel``**；而助手扫的是 ``*.cancel``、去掉后缀拿到 ``3.req``
#    ⇒ 它把 ``3.req`` 当编号 ⇒ **拒**。
#    现象是：**用户点了"取消注册"、而什么都没发生**（而两边各自的单测都是绿的）。
#    ⇒ 这正是"跨产物一致性"那一类（与租户名那条 T7 同族）。
NODE_BIN2="${HUPO_NODE_BIN:-}"
if [ -z "$NODE_BIN2" ]; then
  for c in /home/deploy/.nvm/versions/node/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -x "$c" ] && NODE_BIN2="$c" && break
  done
fi
if [ -z "$NODE_BIN2" ]; then
  bad "找不到 node ⇒ 这一条**没验**（不是过了）"
else
  tmpd="$(mktemp -d)"
  made="$(cd "$ROOT/v2/services/core" && "$NODE_BIN2" --input-type=module -e "
    import nodeFs from 'node:fs';
    import { ProvisionQueue } from './src/provision.js';
    const q = new ProvisionQueue({ dir: '$tmpd', failedDir: '$tmpd/f' });
    q.cancel('u3');
    process.stdout.write(nodeFs.readdirSync('$tmpd').filter((x) => x.endsWith('.cancel')).join(' '));
  " 2>&1)"
  rm -rf "$tmpd"
  # ① 服务侧产出的名字：**必须就是 `<整数>.cancel`**
  if grep -qE '^[1-9][0-9]{0,2}\.cancel$' <<<"$made"; then
    ok "服务侧写的是「$made」（形状对：<整数>.cancel）"
  else
    bad "🔴 服务侧写出来的名字是「$made」—— **不是「<整数>.cancel」那个形状**，助手会拒它"
  fi
  # ② 助手那一侧：扫的是 `*.cancel`、而且**去掉的就是 `.cancel`**
  if grep -q "name '\*.cancel'" "$ROOT/scripts/provision-tenant-request.sh"; then
    ok "助手扫的是 *.cancel"
  else
    bad "助手扫的不是 *.cancel —— 两边又对不上了"
  fi
  if grep -q 'base%\.cancel' "$ROOT/scripts/provision-tenant-request.sh"; then
    ok "助手去掉的后缀也是 .cancel"
  else
    bad "助手去掉的后缀不是 .cancel"
  fi
  # ③ 两边合起来：**助手拿到的编号必须是一个整数**（这一步才是真正的"对得上"）
  if grep -qE '^[1-9][0-9]{0,2}\.cancel$' <<<"$made"; then
    n_of="$(sed 's/\.cancel$//' <<<"$made")"
    if [ "$n_of" = "3" ]; then ok "助手能从它里面读出编号 3"; else bad "读出来的编号是「$n_of」"; fi
  fi
fi

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
