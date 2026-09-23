#!/usr/bin/env bash
# **按磁盘算出"最多开几台"，并可写回模板**（欠账 #35 · 2026-09-23）。
#
# ── 它修的是哪句话 ───────────────────────────────────────────
# 模板 `v2/services/core/tenant-template.conf` 里那个 `max_tenants` 原来是个
# **人写的常数**，而它旁边那句注释自称"这个数按磁盘算" —— **那是句假话**。
# ⇒ 现在这个数是**可以算出来的**，而且**算它和装机时报"放得下几台"用的是同一处口径**
#    （`scripts/lib/tenant-capacity.sh`）。
#
# ── 用法 ────────────────────────────────────────────────────
#   bash scripts/set-tenant-limit.sh                  # 只看：镜像多大、盘多大、算出多少、模板现在是多少
#   bash scripts/set-tenant-limit.sh --write          # 写回模板（只改 max_tenants 那一行）
#   bash scripts/set-tenant-limit.sh --force --write   # 就算算出来比"现有的台数"还少也照写
#
# 判据用的开关（**不改真模板**）：
#   --template <路径> --avail-bytes <n> --image-bytes <n> --tenants <n>
#
# ── 三条纪律 ────────────────────────────────────────────────
#   ① 🔴 **算不出来就不写**（读不到镜像大小 / 读不到可用空间 ⇒ 只说不做，**不许猜一个数**）；
#   ② 🔴 **不许悄悄缩小到比现有租户还少**（那等于"这台机器不该有这些人"，
#      而它只是算错/盘被占满 ⇒ 要显式 `--force`，并且把后果写出来）；
#   ③ **只改那一行**（其余字节逐字不动 —— 那个模板是两套语言的共同输入）。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/tenant-capacity.sh
. "$ROOT/scripts/lib/tenant-capacity.sh"

OWNER_USER="${HUPO_OWNER_USER:-deploy}"
SERVICE_USER="${HUPO_SERVICE_USER:-deploy}"
TEMPLATE="${HUPO_TEMPLATE:-$ROOT/v2/services/core/tenant-template.conf}"
IMG="${HUPO_TENANT_IMAGE:-localhost/hupo-tenant:local}"
AVAIL_OVERRIDE=""
IMAGE_OVERRIDE=""
TENANTS_OVERRIDE=""
WRITE=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --write) WRITE=1 ;;
    --force) FORCE=1 ;;
    --template) TEMPLATE="${2:-}"; shift ;;
    --avail-bytes) AVAIL_OVERRIDE="${2:-}"; shift ;;
    --image-bytes) IMAGE_OVERRIDE="${2:-}"; shift ;;
    --tenants) TENANTS_OVERRIDE="${2:-}"; shift ;;
    -h | --help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "不认识的参数：$1（--help 有用法）" >&2
      exit 2
      ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }

# ── 读模板里现在那个值 ────────────────────────────────────
tpl_get() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$TEMPLATE" 2>/dev/null | head -1
}
[ -f "$TEMPLATE" ] || {
  echo "✗ 找不到模板：$TEMPLATE" >&2
  exit 2
}
CUR="$(tpl_get max_tenants)"

# ── 镜像多大 ──────────────────────────────────────────────
if [ -n "$IMAGE_OVERRIDE" ]; then
  IMG_SZ="$IMAGE_OVERRIDE"
else
  IMG_SZ="$(sudo -u "$OWNER_USER" -H sh -c 'cd /tmp && exec env XDG_RUNTIME_DIR="/run/user/$(id -u)" podman image inspect "$0" --format "{{.Size}}"' "$IMG" 2>/dev/null | head -1)"
fi

# ── 盘多大 ────────────────────────────────────────────────
if [ -n "$AVAIL_OVERRIDE" ]; then
  AVAIL="$AVAIL_OVERRIDE"
  HOME_DIR="（判据给的）"
else
  HOME_DIR="$(getent passwd "$OWNER_USER" | cut -d: -f6)"
  AVAIL="$(capacity_avail_bytes "$HOME_DIR")"
fi

# ── 现有几台 ──────────────────────────────────────────────
if [ -n "$TENANTS_OVERRIDE" ]; then
  TENANTS="$TENANTS_OVERRIDE"
else
  TENANTS="$(getent passwd 2>/dev/null | cut -d: -f1 | grep -c '^hupo-' || true)"
fi

say "── 这台机器的容量 ──────────────────────────────"
say "租户镜像   $IMG（$(awk -v b="${IMG_SZ:-0}" 'BEGIN{printf "%.0f", b/1048576}') MB）"
say "盘（$HOME_DIR）可用 $(awk -v b="${AVAIL:-0}" 'BEGIN{printf "%.1f", b/1073741824}') GB"
say "现有租户   ${TENANTS:-0} 个"

FITS="$(capacity_fits "$AVAIL" "$IMG_SZ" 2>/dev/null || true)"
LIMIT="$(capacity_limit "$AVAIL" "$IMG_SZ" 2>/dev/null || true)"
say "模板现值   max_tenants=${CUR:-（读不出）}（$(printf '%s' "$TEMPLATE" | sed "s|$ROOT/||")）"

# ⚠️ 守卫要**显式校验是不是数字**：`[ "abc" -le 0 ]` 只会报错、不会为真，
#    而那条错误被 `2>/dev/null` 一吞，就等于"检查没做"（判据当场抓到了这一点）。
case "${IMG_SZ:-}" in
  '' | *[!0-9]*)
    say "🔴 **算不出来**：读不到镜像大小（或它不是个数字）⇒ **不写**（① 宁可不变，也不许猜一个数）"
    exit 1
    ;;
esac
[ "$IMG_SZ" -gt 0 ] || {
  say "🔴 **算不出来**：镜像大小是 0 ⇒ **不写**（同上）"
  exit 1
}
case "${AVAIL:-}" in
  '' | *[!0-9]*)
    say "🔴 **算不出来**：读不到可用空间（或它不是个数字）⇒ **不写**（同上）"
    exit 1
    ;;
esac
[ "$AVAIL" -gt 0 ] || {
  say "🔴 **算不出来**：可用空间是 0 ⇒ **不写**（同上）"
  exit 1
}

say "物理上限   放得下 **$FITS 台**（可用 ÷ 每台镜像）"
say "策略上限   **$LIMIT 台**（扣掉 $(capacity_reserve_pct)% 余量：卷/日志/可写层都会长）"

if [ "${CUR:-}" = "$LIMIT" ]; then
  say "✅ 模板里就是算出来的那个值 —— **不用改**"
  exit 0
fi

say "建议       max_tenants：${CUR:-（无）} → $LIMIT"

# 🔴 不许悄悄缩小到比现有租户还少
if [ "${TENANTS:-0}" -gt "$LIMIT" ] && [ "$FORCE" != "1" ]; then
  say "🔴 **算出来的（$LIMIT）比现在真有的（$TENANTS）还少** ⇒ **不写**。"
  say "   这多半意味着**盘被占满了**（不是"这些人不该存在"）——"
  say "   写下去会让模板与 /etc/passwd 自相矛盾。腾地方，或者**显式** --force（并说清为什么）。"
  exit 1
fi
if [ "${TENANTS:-0}" -gt "$LIMIT" ]; then
  say "⚠️ **--force**：写下去之后，模板上限（$LIMIT）比现有租户（$TENANTS）少 —— 这是你明确要的。"
fi

if [ "$WRITE" != "1" ]; then
  say "（只看。要写：bash scripts/set-tenant-limit.sh --write）"
  exit 0
fi

# ── 只改那一行 ────────────────────────────────────────────
BEFORE_SHA="$(sha256sum "$TEMPLATE" | cut -c1-16)"
TMP="$(mktemp)"
# ⚠️ 先把"别的行"逐字抄下来，再拼回那一行 —— 不用 `sed -i` 直接改，
#    是为了**能验**"只有那一行变了"。
awk -v want="$LIMIT" '
  /^[[:space:]]*max_tenants[[:space:]]*=/ && !done { print "max_tenants=" want; done=1; next }
  { print }
' "$TEMPLATE" >"$TMP"
grep -q '^max_tenants=' "$TMP" || {
  say "✗ 改完之后那一行不见了 ⇒ 什么都没写（原文件没动）"
  rm -f "$TMP"
  exit 1
}
cat "$TMP" >"$TEMPLATE"
rm -f "$TMP"
NEW="$(tpl_get max_tenants)"

# ★ **拿服务端那个解析器真读一遍**（模板是两套语言的共同输入 ⇒ 写完必须它认）
# ⚠️ 本机**没有系统 node**（`AGENTS.md` §1.1：只有 nvm 里那一个）⇒ 三处找：
#    `HUPO_NODE_BIN` → PATH → nvm 那个绝对路径。一处都找不到就当"验不了"（**如实说**，不假装认过）。
NODE_BIN="${HUPO_NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || NODE_BIN="$HOME/.nvm/versions/node/v24.15.0/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN=""
if [ -z "$NODE_BIN" ]; then
  say "⚠️ 找不到 node ⇒ **服务端解析器那一步没验**（文件已写；要复核就自己跑一次 `npm test`）"
else
  if (cd "$ROOT/v2/services/core" && "$NODE_BIN" -e "
import('./src/tenants.js').then((m) => {
  const fs = require('node:fs');
  const t = m.parseTenantTemplate(fs.readFileSync(process.argv[1], 'utf8'));
  console.log('  ✓ 服务端解析器认了：max_tenants=' + t.maxTenants + ' · 前缀=' + t.namePrefix + ' · uid 起点=' + t.uidBase);
}).catch((e) => { console.error('  ✗ 服务端解析器不认：' + e.message); process.exit(1); });
" "$TEMPLATE"); then
    say "✅ 写好了：max_tenants=${CUR:-（无）} → $NEW（模板 sha ${BEFORE_SHA} → $(sha256sum "$TEMPLATE" | cut -c1-16)）"
  else
    say "✗ 服务端解析器不认刚写下去的那份 ⇒ **请你把它改回去**（上面有它的原话）"
    exit 1
  fi
fi
