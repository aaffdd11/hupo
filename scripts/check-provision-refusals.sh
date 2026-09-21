#!/usr/bin/env bash
# **特权侧那条路的判据**（契约 `docs/dev/43-AUTO-PROVISION.md` §五）。
#
# 用法：
#   sudo bash scripts/check-provision-refusals.sh
#
# ── 它验什么、为什么这么验 ──────────────────────────────────
# 契约 §五 把判据分成两半：
#   · "**拒**的那一半"（A2/A3/A4/A5）——**不需要真建东西**就能验，这个脚本全包了；
#   · "真建一台"那一半 —— 要主人签字装完单元之后才验得了（**这里明说：没验**）。
#
# 🔴 **每一条都带负向对照**：光验"坏的被拒了"说明不了什么
#    （一个**什么都拒**的脚本也能全绿）。所以每一组都配一条"合法的那份要过"。
#
# ⚠️ 全程 `HUPO_PROVISION_DRY_RUN=1` 用在**正对照**上（它不会建东西）；
#    **拒**的那几条走真跑 —— 因为它们在"建"那一步**之前**就返回了。
#    ⇒ 本脚本**永远不会**在这台机器上建出任何租户。这一条本身就是判据 ⑨。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT/scripts/provision-tenant-request.sh"
CONF="$ROOT/v2/services/core/tenant-template.conf"
SERVICE_USER="${HUPO_SERVICE_USER:-deploy}"
SERVICE_UID="$(id -u "$SERVICE_USER" 2>/dev/null || true)"

if [ "$(id -u)" != "0" ]; then
  echo "✗ 这个判据要 root（它要验的就是那条特权路）。请：sudo bash $0"; exit 2
fi
[ -n "$SERVICE_UID" ] || { echo "✗ 找不到服务那个用户：$SERVICE_USER"; exit 2; }

WORK="$(mktemp -d /tmp/hupo-prov-check.XXXXXX)"
REQ="$WORK/req"
mkdir -p "$REQ"
chown "root:$SERVICE_USER" "$REQ"
chmod 1733 "$REQ"

pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass + 1)); }
bad()  { echo "  ✗ $1"; fail=$((fail + 1)); }

# 跑一次助手。**REQ_DIR 指向临时目录**，MIN_INTERVAL=0（判据不该因为限速而假绿）。
run_helper() {
  local dry="$1"
  env HUPO_PROVISION_DIR="$REQ" HUPO_PROVISION_STAMP="$WORK/.last" \
      HUPO_PROVISION_MIN_INTERVAL=0 HUPO_PROVISION_DRY_RUN="$dry" \
      HUPO_TENANT_TEMPLATE="$CONF" HUPO_SERVICE_USER="$SERVICE_USER" \
      bash "$HELPER" 2>&1
}
reset_req() { rm -rf "${REQ:?}"/*; }

echo "── 申请目录：$REQ（$(stat -c '%a %U:%G' "$REQ")）"
echo "── 服务那个 uid：$SERVICE_UID（$SERVICE_USER）"
echo

# ══════════════════════════════════════════════════════════════════
echo "① 正对照：**合法**的那一份必须过（不然下面"被拒了"什么都说明不了）"
# ══════════════════════════════════════════════════════════════════
reset_req
: > "$REQ/3.req"; chown "$SERVICE_USER" "$REQ/3.req"
out="$(run_helper 1)"
if grep -q '▶ 第 3 号 → 建 hupo-t3' <<<"$out"; then
  ok "合法申请 ⇒ 认了（会建 hupo-t3）"
else
  bad "合法申请居然没过：$(tail -1 <<<"$out")"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "② 名字不是那个形状 ⇒ 全拒（A1/A2）"
# ══════════════════════════════════════════════════════════════════
# ⚠️ 这些名字是**路径穿越 / 注入 / 越界**的入口，一个都不能过
for nm in '..%2f..%2fetc.req' '3.req.req' '0.req' '01.req' 'a.req' '1;id.req' '$(id).req' '.req' '9.req'; do
  reset_req
  f="$REQ/$nm"
  : > "$f" 2>/dev/null || continue
  chown "$SERVICE_USER" "$f"
  out="$(run_helper 0)"
  if grep -q '▶ 第' <<<"$out"; then
    bad "「$nm」被当成合法申请了"
  elif [ -e "$f" ]; then
    # A5：拒了就必须**删掉**，不然 `.path` 单元会反复触发它
    bad "「$nm」被拒了，但**申请没删**（会反复触发）"
  elif [ ! -e "$f.failed" ]; then
    bad "「$nm」被拒了，但**没留 `.failed` 标记**（那个人会在等待屏上永远等）"
  else
    ok "「$nm」⇒ 拒 + 删 + 留标记"
  fi
done

# ══════════════════════════════════════════════════════════════════
echo
echo "③ 符号链接冒充申请 ⇒ 拒，而且**链接指的地方一个字都没被动**（A3）"
# ══════════════════════════════════════════════════════════════════
reset_req
victim="$WORK/victim.txt"; echo '本来是这样' > "$victim"
ln -s "$victim" "$REQ/3.req"
out="$(run_helper 0)"
if grep -q '▶ 第' <<<"$out"; then bad "符号链接被当成合法申请了"; else ok "符号链接 ⇒ 拒"; fi
if [ "$(cat "$victim")" = '本来是这样' ]; then ok "链接指的那个文件**没被动过**"; else bad "被写穿了"; fi

# ══════════════════════════════════════════════════════════════════
echo
echo "④ 属主不是服务那个 uid ⇒ 拒（A3）"
# ══════════════════════════════════════════════════════════════════
reset_req
: > "$REQ/3.req"          # 这一份是 **root** 拥有的
out="$(run_helper 0)"
if grep -q '▶ 第' <<<"$out"; then bad "root 拥有的那一份被认了"; else ok "属主不对 ⇒ 拒"; fi

# ══════════════════════════════════════════════════════════════════
echo
echo "⑤ 🔴 申请内容是一串命令 ⇒ **一个字都不许被执行**（A1 的核心）"
# ══════════════════════════════════════════════════════════════════
reset_req
PWN="$WORK/PWNED"
printf 'touch %s\n' "$PWN" > "$REQ/3.req"
printf 'rm -rf /tmp/hupo-prov-check.*\n' >> "$REQ/3.req"
chown "$SERVICE_USER" "$REQ/3.req"
out="$(run_helper 1)"     # 正对照那种情形：名字合法 ⇒ 会走到"建"（干跑）
if grep -q '▶ 第 3 号' <<<"$out"; then ok "名字合法 ⇒ 照常处理（内容不参与判断）"; else bad "合法名字没过"; fi
if [ -e "$PWN" ]; then bad "🔴 申请里的命令**被执行了** —— 边界破了"; else ok "申请里的命令**一个字都没执行**"; fi

# ══════════════════════════════════════════════════════════════════
echo
echo "⑥ 超上限 ⇒ 拒（A4），而且**一台都不许建**"
# ══════════════════════════════════════════════════════════════════
reset_req
: > "$REQ/9.req"; chown "$SERVICE_USER" "$REQ/9.req"   # 模板里 max_tenants=8
out="$(run_helper 0)"
if grep -q '超过上限' <<<"$out"; then ok "第 9 号 ⇒ 拒（超过上限）"; else bad "超上限的居然过了：$(tail -1 <<<"$out")"; fi

# ══════════════════════════════════════════════════════════════════
echo
echo "⑦ 模板被换成坏值 ⇒ **一台都不建**（A2/A9 的纵深防御）"
# ══════════════════════════════════════════════════════════════════
for bad_line in 'name_prefix=../../etc' 'name_prefix=Hupo_T' 'uid_base=-1' 'max_tenants=99999' 'max_tenants=abc'; do
  c="$WORK/bad.conf"
  { grep -v "^${bad_line%%=*}" "$CONF"; echo "$bad_line"; } > "$c"
  out="$(env HUPO_PROVISION_DIR="$REQ" HUPO_PROVISION_STAMP="$WORK/.last" HUPO_PROVISION_MIN_INTERVAL=0 \
        HUPO_PROVISION_DRY_RUN=1 HUPO_TENANT_TEMPLATE="$c" HUPO_SERVICE_USER="$SERVICE_USER" \
        bash "$HELPER" 2>&1)"
  if grep -q '一台都不建' <<<"$out"; then ok "模板「$bad_line」⇒ 拒"; else bad "模板「$bad_line」居然过了"; fi
done

# ══════════════════════════════════════════════════════════════════
echo
echo "⑧ 非 root 跑 ⇒ 拒（这条路本身就该只有 root 走得通）"
# ══════════════════════════════════════════════════════════════════
out="$(sudo -u "$SERVICE_USER" -H env HUPO_PROVISION_DIR="$REQ" HUPO_TENANT_TEMPLATE="$CONF" \
      bash "$HELPER" 2>&1 || true)"
if grep -q '要以 root 跑' <<<"$out"; then ok "服务那个身份跑 ⇒ 拒"; else bad "非 root 居然跑起来了"; fi

# ══════════════════════════════════════════════════════════════════
echo
echo "⑨ 这一趟**没有真建出任何租户**（判据脚本自己不许有副作用）"
# ══════════════════════════════════════════════════════════════════
if id hupo-t3 >/dev/null 2>&1; then
  bad "跑判据把 hupo-t3 建出来了 —— 这套判据有副作用"
else
  ok "没有多出任何租户用户"
fi

rm -rf "$WORK"
echo
echo "──────────────────────────────"
if [ "$fail" = "0" ]; then
  echo "✅ 全过（$pass 条）—— **但只验了"拒"的那一半**"
  echo "⚠️ "真建一台"要主人签字装完单元之后才验得了（契约 §五 末尾那句）。"
  exit 0
else
  echo "✗ $fail 条没过（过 $pass 条）"
  exit 1
fi
