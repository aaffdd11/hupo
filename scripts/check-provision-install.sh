#!/usr/bin/env bash
# **A9 的四条判据**（契约 `docs/dev/43-AUTO-PROVISION.md` §三 A9）——
# **在隔离环境里验，不用主人签字、也不碰这台机器一根汗毛**。
#
# 用法：
#   sudo bash scripts/check-provision-install.sh
#
# ── 为什么能有这个脚本 ────────────────────────────────────
# A9 原来写着"要等装完才验得了" —— 而它恰恰是**整套模型会不会作废**的那一条
# （让单元去跑仓库里那个脚本 = 把边界画在一个服务自己写得到的地方）。
# ⇒ 安装器支持 `--root <临时目录>`：**同一段代码换一个目的地**，
#   systemd / tmpfiles 那两步跳过（它们没法"装到别处"）。
#   于是这四条能在真装机之前**先验掉**。
#
# ── 这一份钉四条（每条都有负向对照）────────────────────────
#   ① 四份都必须是 **root 拥有**，权限就是那几个（⚠️ 不是"看着像"）；
#   ② 🔴 单元里的 `ExecStart` 必须指向**装着的那一份拷贝**，
#      **绝不许**出现仓库路径（那正是 A9 的病）；
#   ③ **服务那个身份改不动**它们（`EACCES`）—— 而且**读得到**（对照：
#      证明那个 `EACCES` 是"不许写"，不是"根本进不去"）；
#   ④ **改了仓库那份，`--check` 必须认得出**（"改完了 ≠ 生效了"要看得见）。
#
# ⚠️ 全程在 `mktemp -d` 出来的临时根里；跑完**自证**这台机器上什么都没多出来。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT/scripts/install-provision-helper.sh"
SERVICE_USER="${HUPO_SERVICE_USER:-deploy}"
id "$SERVICE_USER" >/dev/null 2>&1 || SERVICE_USER="$(stat -c %U "$ROOT")"

if [ "$(id -u)" != "0" ]; then
  echo "✗ 这个判据要 root（它要以 root 装到临时根、再以服务身份试改）。请：sudo bash $0"
  exit 2
fi

pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1"; fail=$((fail + 1)); }

TEST="$(mktemp -d /tmp/hupo-prov-install.XXXXXX)"
chmod 0755 "$TEST"
# ⚠️ 让服务那个身份**进得来**（不然下面"改不动"那一条会因为"根本进不去"而假绿 ——
#    那种绿是这个项目最忌的"看着像过了"）。
cleanup() {
  [ -n "${MUTATED:-}" ] && cp -f "$MUTATED.bak" "$MUTATED" 2>/dev/null
  rm -rf "$TEST" "${MUTATED:-}.bak" 2>/dev/null
}
trap cleanup EXIT

REAL_LIBEXEC="/usr/local/libexec/hupo"
REAL_UNITS=("/etc/systemd/system/hupo-provision.path" "/etc/systemd/system/hupo-provision.service")
REAL_TMPFILES="/etc/tmpfiles.d/hupo-provision.conf"
REAL_REQ="/run/hupo-provision"

echo "── 临时根：$TEST"
echo "── 服务那个身份：$SERVICE_USER"
echo

# ══════════════════════════════════════════════════════════════════
echo "① 装到临时根（**同一段代码、换一个目的地**）"
# ══════════════════════════════════════════════════════════════════
out="$(bash "$INSTALLER" --yes --root "$TEST" 2>&1)"
if [ $? -ne 0 ]; then
  bad "装失败了：$(tail -3 <<<"$out")"
  echo "$out" | sed 's/^/    /' | tail -12
else
  ok "装完了"
fi
LE="$TEST/usr/local/libexec/hupo"
CONF="$TEST/etc/hupo/tenant-template.conf"
# ⚠️ 把中间那几层设成可穿过的（**这是判据自己在搭沙箱**，不是在测产品）
chmod 0755 "$TEST/usr" "$TEST/usr/local" "$TEST/usr/local/libexec" 2>/dev/null || true
chmod 0755 "$TEST/etc" "$TEST/etc/hupo" 2>/dev/null || true

# ══════════════════════════════════════════════════════════════════
echo
echo "② 四份都在、并且**是 root 拥有**、权限就是那几个（A9 第一半）"
# ══════════════════════════════════════════════════════════════════
want() {  # want <路径> <期望权限>
  local f="$1" m="$2"
  if [ ! -f "$f" ]; then bad "不在：$f"; return; fi
  local owner mode
  owner="$(stat -c '%U:%G' "$f")"
  mode="$(stat -c '%a' "$f")"
  if [ "$owner" != "root:root" ]; then bad "$(basename "$f") 属主是 $owner（必须 root:root）"; return; fi
  if [ "$mode" != "$m" ]; then bad "$(basename "$f") 权限是 $mode（期望 $m）"; return; fi
  ok "$(basename "$f") ⇒ root:root $mode"
}
want "$LE/provision-tenant-request.sh" 755
want "$LE/create-tenant-users.sh" 755
want "$LE/create-tenant-pool.sh" 755
want "$CONF" 444

# ══════════════════════════════════════════════════════════════════
echo
echo "③ 🔴 单元指向的是**装着的那一份**，而且**没有仓库路径**（A9 的第二半，最要紧）"
# ══════════════════════════════════════════════════════════════════
svc="$TEST/etc/systemd/system/hupo-provision.service"
if [ ! -f "$svc" ]; then
  bad "单元不在：$svc"
else
  if grep -q "^ExecStart=$LE/provision-tenant-request.sh" "$svc"; then
    ok "ExecStart 指向 root 拥有的那份拷贝"
  else
    bad "ExecStart 没指向拷贝：$(grep '^ExecStart' "$svc")"
  fi
  # 🔴 这一条是负向对照：**仓库路径一个都不许出现**
  if grep -q "$ROOT" "$svc"; then
    bad "🔴 单元里出现了仓库路径 —— A9 那个病又回来了"
    grep -n "$ROOT" "$svc" | sed 's/^/      /'
  else
    ok "单元里**一个仓库路径都没有**"
  fi
  if grep -q "^Environment=HUPO_TENANT_TEMPLATE=$CONF" "$svc"; then
    ok "模板也指向装着的那一份（两份内容不一致就白搭）"
  else
    bad "模板那一行没指对：$(grep '^Environment' "$svc")"
  fi
fi
# 申请投放口：1733（服务能放、列不出别人的、替换不掉 root 的）
req="$TEST/run/hupo-provision"
if [ -d "$req" ]; then
  m="$(stat -c '%a %U:%G' "$req")"
  if [ "$m" = "1733 root:$SERVICE_USER" ]; then ok "申请投放口 ⇒ $m"; else bad "投放口是 $m（期望 1733 root:$SERVICE_USER）"; fi
else
  bad "投放口没建：$req"
fi
# ⚠️ **失败标记住另一个目录**（真机量出来的：留在投放口里会让 .path 反复触发）
state="$TEST/run/hupo-provision-state"
if [ -d "$state" ]; then
  ms="$(stat -c '%a %U:%G' "$state")"
  # ⚠️ `stat -c %a` 给的是 `755`，**没有前导零**（我第一次把期望值写成 `0755` 就假红了一次）
  if [ "$ms" = "755 root:root" ]; then ok "标记目录 ⇒ $ms（在投放口**外面**）"; else bad "标记目录是 $ms（期望 755 root:root）"; fi
else
  bad "标记目录没建：$state"
fi
if grep -q "^Environment=HUPO_PROVISION_FAILED_DIR=$state" "$svc" 2>/dev/null; then
  ok "单元里把标记目录指对了"
else
  bad "单元里没把标记目录指对：$(grep 'FAILED_DIR' "$svc" 2>/dev/null || echo 无)"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "④ 🔴 服务那个身份**读得到、但改不动**（A9 第三半；读了才算对照）"
# ══════════════════════════════════════════════════════════════════
as_user() { sudo -u "$SERVICE_USER" -H sh -c 'cd /tmp && exec "$@"' sh "$@"; }
if as_user cat "$LE/provision-tenant-request.sh" >/dev/null 2>&1; then
  ok "**读得到**（对照：说明下面那个 EACCES 是"不许写"，不是"进不去"）"
else
  bad "**读不到** —— 那下面"改不动"就说明不了什么（沙箱没搭对）"
fi
if as_user sh -c "echo x >> '$LE/provision-tenant-request.sh'" 2>/dev/null; then
  bad "🔴 服务那个身份**改得动** root 要跑的脚本 —— A9 破了"
else
  ok "**改不动**（EACCES）"
fi
if as_user sh -c "rm -f '$LE/create-tenant-pool.sh'" 2>/dev/null && [ ! -f "$LE/create-tenant-pool.sh" ]; then
  bad "🔴 服务那个身份**删得掉**它"
else
  ok "**删不掉**"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "⑤ --check：没改时说「一致」"
# ══════════════════════════════════════════════════════════════════
out="$(bash "$INSTALLER" --check --root "$TEST" 2>&1)"; rc=$?
if [ "$rc" = "0" ] && grep -q '✅ 一致' <<<"$out"; then
  ok "一致（退出码 0）"
else
  bad "--check 说不上一致（rc=$rc）：$(tail -2 <<<"$out")"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "⑥ 🔴 **改了仓库那份 ⇒ --check 必须认得出**（A9 第四半／改完了 ≠ 生效了）"
# ══════════════════════════════════════════════════════════════════
MUTATED="$ROOT/scripts/create-tenant-pool.sh"
cp -f "$MUTATED" "$MUTATED.bak"
printf '\n# 判据故意加的一行（这一行跑完会被撤掉）\n' >> "$MUTATED"
out="$(bash "$INSTALLER" --check --root "$TEST" 2>&1)"; rc=$?
if [ "$rc" != "0" ] && grep -q '不一致' <<<"$out"; then
  ok "认出来了（退出码非 0），而且它说清了是哪一份：$(grep '不一致' <<<"$out" | head -1 | cut -c1-60)"
else
  bad "🔴 仓库改了、「--check」 还说一致（rc=$rc）—— 那这道核对就是摆设"
fi
cp -f "$MUTATED.bak" "$MUTATED"; rm -f "$MUTATED.bak"; MUTATED=""
out="$(bash "$INSTALLER" --check --root "$TEST" 2>&1)"
if grep -q '✅ 一致' <<<"$out"; then ok "还原之后又一致了"; else bad "还原之后还是不一致"; fi

# ══════════════════════════════════════════════════════════════════
echo
echo "⑦ 撤得干净（一条命令）"
# ══════════════════════════════════════════════════════════════════
bash "$INSTALLER" --uninstall --root "$TEST" >/dev/null 2>&1
if [ ! -e "$LE" ] && [ ! -e "$CONF" ] && [ ! -e "$svc" ]; then
  ok "装进去的那几样都没了"
else
  bad "撤完还剩东西"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "⑧ 🔴 **自证：这一趟在这台机器上什么都没多出来**（"隔离"要验它真的隔离了）"
# ══════════════════════════════════════════════════════════════════
stray=0
[ -e "$REAL_LIBEXEC" ] && { bad "多出来了：$REAL_LIBEXEC"; stray=1; }
for u in "${REAL_UNITS[@]}"; do [ -e "$u" ] && { bad "多出来了：$u"; stray=1; }; done
[ -e "$REAL_TMPFILES" ] && { bad "多出来了：$REAL_TMPFILES"; stray=1; }
[ -e "$REAL_REQ" ] && { bad "多出来了：$REAL_REQ"; stray=1; }
[ "$stray" = "0" ] && ok "真机上那几处**一处都没动**（$REAL_LIBEXEC / 单元 / tmpfiles / 投放口）"
# ⚠️ 顺带确认真机上**没装**（这正是"等主人签字"那个状态）
if systemctl is-active hupo-provision.path >/dev/null 2>&1; then
  bad "真机上那个 .path 单元居然是 active —— 有人装过了？"
else
  ok "真机上那条路**没启用**（等主人签字）"
fi
if command -v git >/dev/null 2>&1; then
  # ⚠️ **只查被变异的那一份**（2026-09-21 判据自己抓到的）：
  #    原来这里查的是整个 `scripts/` ⇒ 本脚本自己（新加的、还没提交的）
  #    也会让它报"脏" ⇒ **假警报**。那种闸很快就会被下一个人绕开。
  if git -C "$ROOT" diff --quiet -- scripts/create-tenant-pool.sh 2>/dev/null; then
    ok "被变异的那一份**原样**（还原干净了）"
  else
    bad "scripts/create-tenant-pool.sh 还是脏的 —— 变异没收干净"
  fi
fi

echo
echo "──────────────────────────────"
if [ "$fail" = "0" ]; then
  echo "✅ 全过（$pass 条）—— A9 那四条**在隔离环境里验掉了**"
  echo "⏳ 还差的仍然只有"真建一台"与"装完之后服务身份不变"那两条（要主人签字）。"
  exit 0
else
  echo "✗ $fail 条没过（过 $pass 条）"
  exit 1
fi
