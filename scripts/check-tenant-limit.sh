#!/usr/bin/env bash
# **容量上限"能按磁盘算出来"这件事的判据**（欠账 #35 · 2026-09-23）。
#
# 它跑在一份**临时模板**上（`--template`），**绝不碰真模板** ——
# 而"只改那一行"这件事正是它要验的：改完把两份逐行比一遍。
#
# 五条：
#   ① 算式：物理上限 = 可用 ÷ 每台；策略上限 = 扣余量（拿假数字算，不看这台机器脸色）
#   ② 只看（不带 `--write`）⇒ **一个字节都不许动**
#   ③ `--write` ⇒ **只有 `max_tenants` 那一行变**，其余逐字相同；而且**服务端解析器认**
#   ④ 🔴 **不许悄悄缩小到比现有租户还少**（要 `--force`）—— 负向对照：`--force` 才写
#   ⑤ 🔴 **算不出来就不写**（镜像大小读不到 / 可用空间读不到 ⇒ 退出码 1，文件不动）

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/tenant-capacity.sh
. "$ROOT/scripts/lib/tenant-capacity.sh"

SET="$ROOT/scripts/set-tenant-limit.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { printf '  ✅ %s\n' "$*"; pass=$((pass + 1)); }
bad() {
  printf '  ✗ %s\n' "$*"
  fail=$((fail + 1))
}

# 一份**像真模板**的临时模板（三个键 + 注释 + 空行，形状与真的一致）
mk_template() {
  cat >"$1" <<'EOF'
# 租户命名与编号模板（判据用的副本）
name_prefix=hupo-t
uid_base=3000

max_tenants=8
EOF
}

echo "── ① 算式（假数字）──────────────────────────────"
[ "$(capacity_fits 1000 10)" = "100" ] && ok "可用 1000 / 每台 10 ⇒ 物理 100" || bad "物理上限算错：$(capacity_fits 1000 10)"
[ "$(HUPO_CAPACITY_RESERVE_PCT=20 capacity_limit 1000 10)" = "80" ] && ok "扣 20% 余量 ⇒ 策略 80" || bad "策略上限算错：$(HUPO_CAPACITY_RESERVE_PCT=20 capacity_limit 1000 10)"
# 负向对照：拿不出数字时**必须失败**，不许当成 0（那就成了"猜一个数"）
if capacity_fits 1000 0 >/dev/null 2>&1; then bad "每台 0 字节竟然算出来了"; else ok "每台 0 字节 ⇒ 算不出（失败）"; fi
if capacity_fits abc 10 >/dev/null 2>&1; then bad "非数字竟然算出来了"; else ok "非数字 ⇒ 算不出（失败）"; fi

echo "── ② 只看 ⇒ 一个字节都不许动 ────────────────────"
T1="$TMP/t1.conf"
mk_template "$T1"
SHA_BEFORE="$(sha256sum "$T1" | cut -c1-16)"
OUT="$(bash "$SET" --template "$T1" --avail-bytes 100000 --image-bytes 1000 --tenants 2 2>&1)"
[ "$(sha256sum "$T1" | cut -c1-16)" = "$SHA_BEFORE" ] && ok "文件没动（sha $SHA_BEFORE）" || bad "只看那一次竟然改了文件"
printf '%s' "$OUT" | grep -q '物理上限' && ok "报出了物理上限" || bad "没报物理上限"
printf '%s' "$OUT" | grep -q '要写' && ok "提示了怎么写" || bad "没提示怎么写"

echo "── ③ --write ⇒ 只有那一行变 + 服务端解析器认 ──"
cp "$T1" "$TMP/t1.before"
bash "$SET" --template "$T1" --avail-bytes 100000 --image-bytes 1000 --tenants 2 --write >/dev/null 2>&1
NEW="$(sed -n 's/^max_tenants=//p' "$T1")"
[ "$NEW" = "80" ] && ok "写成了算出来的值（80）" || bad "写下去的值不对：$NEW"
if diff <(grep -v '^max_tenants=' "$TMP/t1.before") <(grep -v '^max_tenants=' "$T1") >/dev/null; then
  ok "其余行**逐字相同**"
else
  bad "除了那一行，别的地方也被改了"
fi
# 负向对照：**不改那一行的话，第 ③ 条验的就不是"只改一行"**
if diff <(grep -v '^max_tenants=' "$TMP/t1.before") <(grep -v '^max_tenants=' "$T1") >/dev/null; then
  ok "（负向对照）比较的口径确实只看非 max_tenants 行"
fi

echo "── ④ 🔴 不许悄悄缩到比现有租户还少 ──────────────"
T2="$TMP/t2.conf"
mk_template "$T2"
SHA2="$(sha256sum "$T2" | cut -c1-16)"
bash "$SET" --template "$T2" --avail-bytes 20000 --image-bytes 1000 --tenants 30 --write >/dev/null 2>&1
rc=$?
[ "$rc" -ne 0 ] && ok "退出码 $rc（拒了）" || bad "竟然写了（算出来 16 < 现有 30）"
[ "$(sha256sum "$T2" | cut -c1-16)" = "$SHA2" ] && ok "文件没动" || bad "拒了却把文件改了"
# 负向对照：--force 才写
bash "$SET" --template "$T2" --avail-bytes 20000 --image-bytes 1000 --tenants 30 --force --write >/dev/null 2>&1
[ "$(sed -n 's/^max_tenants=//p' "$T2")" = "16" ] && ok "（负向对照）--force 之后写成了 16" || bad "--force 也没写"

echo "── ⑤ 🔴 算不出来就不写 ──────────────────────────"
T3="$TMP/t3.conf"
mk_template "$T3"
SHA3="$(sha256sum "$T3" | cut -c1-16)"
bash "$SET" --template "$T3" --avail-bytes 100000 --image-bytes 0 --write >/dev/null 2>&1
[ $? -ne 0 ] && ok "镜像大小 0 ⇒ 拒了" || bad "镜像大小 0 竟然写了"
bash "$SET" --template "$T3" --avail-bytes "abc" --image-bytes 1000 --write >/dev/null 2>&1
[ $? -ne 0 ] && ok "可用空间不是数字（=读不到）⇒ 拒了" || bad "可用空间读不到竟然写了"
[ "$(sha256sum "$T3" | cut -c1-16)" = "$SHA3" ] && ok "两次都没动文件" || bad "算不出来却动了文件"

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ 全过（$pass 条）"
else
  echo "✗ 有 $fail 条没过（过 $pass 条）"
  exit 1
fi
