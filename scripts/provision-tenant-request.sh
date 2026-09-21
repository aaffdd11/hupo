#!/usr/bin/env bash
# **特权侧助手**：把"一张申请"变成"一台真的容器"。
# 契约：`docs/dev/43-AUTO-PROVISION.md`（安全模型 A1–A8）。
#
# ── 它是怎么被叫起来的 ──────────────────────────────────────
# 它**不是守护进程**。`hupo-provision.path` 看着申请目录，一有动静就把它拉起一次，
# 跑完就退 ⇒ **没有常驻的 root 进程**（这是选"申请队列"而不是"常驻守护"的理由之一）。
#
# ── 🔴 它读什么、不读什么（这一节就是整套设计的安全边界）──────
#   **读**：申请文件的**名字**里的那一个整数。
#   **不读**：文件内容（可以是空的）、环境里的路径、任何参数。
#   其余一切（用户名 / uid / home / 卷 / subuid / 单元名）**全从模板推出来**。
#   ⇒ 就算服务整个被攻陷，它能做到的**最多**是："让这台机器上多出第 n 台容器"，
#     而 n 被硬上限夹住（A4）。**它拿不到一条命令执行。**
#
# ── 五条不许破 ──────────────────────────────────────────────
#   1. **只认 `<1..MAX>.req` 这个名字**，别的形状一律拒、并且**删掉它**（防反复触发）；
#   2. **拒也要留痕**（`.failed` 标记 + 日志一行）—— 不然失败的人会在等待屏上
#      **永远**等下去（那就是这次要根治的那个病，不能在新路上重演）；A5
#   3. **符号链接 / 不是服务属主的文件，一律拒**（A3）；
#   4. **幂等**：同一个 n 重复申请，第二次什么都不做（**绝不重建、绝不清空人家数据**）；
#   5. ⚠️ 建东西**只调现成的那两个脚本** —— 自动这条路**不许**自己长出
#      一套平行的建法（契约 §八）。
set -uo pipefail

# ⚠️ **同目录**（不是 `ROOT`）：装到 `/usr/local/libexec/hupo/` 之后，
#    那两个脚本就躺在**它旁边**（A9：root 只跑 root 自己那一份拷贝）。
LIBDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQ_DIR="${HUPO_PROVISION_DIR:-/run/hupo-provision}"
SERVICE_USER="${HUPO_SERVICE_USER:-deploy}"
DRY="${HUPO_PROVISION_DRY_RUN:-0}"

say() { echo "  $1"; }
log() { echo "[$(date '+%F %T')] $1"; }

if [ "$(id -u)" != "0" ]; then
  echo "✗ 这个脚本要以 root 跑（它就是那条特权路）。"; exit 2
fi

# ── 模板：**唯一权威**（与服务侧读同一份**内容**）──────────────
#    ⚠️ 装好之后是 `/etc/hupo/tenant-template.conf`（root:root 0444）——
#       **不是**仓库里那份：那份的属主是服务自己（A9）。
TEMPLATE="${HUPO_TENANT_TEMPLATE:-/etc/hupo/tenant-template.conf}"
export HUPO_TENANT_TEMPLATE="$TEMPLATE"
tpl_get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$TEMPLATE" | head -1; }
NAME_PREFIX="$(tpl_get name_prefix)"
UID_BASE="$(tpl_get uid_base)"
MAX_TENANTS="$(tpl_get max_tenants)"
for pair in "name_prefix=$NAME_PREFIX" "uid_base=$UID_BASE" "max_tenants=$MAX_TENANTS"; do
  [ -n "${pair#*=}" ] || { log "✗ 模板读不出 ${pair%%=*}（$TEMPLATE）—— 一台都不建"; exit 2; }
done
# 🔴 **自己再校一遍**（纵深防御）：这几个值会被拼进用户名/路径/uid。
#    只信"服务侧校过了"是不行的 —— 这条路上**任何一份可写文件都是入口**（A9）。
#    ⚠️ 前缀尤其要紧：它会被拼成 `/home/<前缀><n>`，一个 `../` 就能跑出根外。
case "$NAME_PREFIX" in
  *[!a-z0-9-]*|'') log "✗ 模板里的 name_prefix 不合法（$NAME_PREFIX）—— 一台都不建"; exit 2 ;;
esac
case "$NAME_PREFIX" in
  [a-z]*) : ;;
  *) log "✗ 模板里的 name_prefix 必须以小写字母开头（$NAME_PREFIX）—— 一台都不建"; exit 2 ;;
esac
for v in "$UID_BASE" "$MAX_TENANTS"; do
  case "$v" in ''|*[!0-9]*) log "✗ 模板里的数字不合法（$v）—— 一台都不建"; exit 2 ;; esac
done
if ! { [ "$MAX_TENANTS" -ge 1 ] && [ "$MAX_TENANTS" -le 200 ] && [ "$UID_BASE" -ge 1 ] && [ "$UID_BASE" -le 60000 ]; }; then
  log "✗ 模板里的数越界了（uid_base=$UID_BASE max_tenants=$MAX_TENANTS）—— 一台都不建"
  exit 2
fi

# 服务那个 uid：**从仓库属主推**（服务就是以他跑的），不写死
SERVICE_UID="$(id -u "$SERVICE_USER" 2>/dev/null || true)"
[ -n "$SERVICE_UID" ] || { log "✗ 找不到服务那个用户（$SERVICE_USER）—— 一台都不建"; exit 2; }

if [ ! -d "$REQ_DIR" ]; then
  log "申请目录不在（$REQ_DIR）—— 没什么可做的（装上那条路：sudo bash scripts/install-provision-helper.sh --yes）"
  exit 0
fi

# ── 限速：两次真跑之间至少隔这么久 ─────────────────────────────
# ⚠️ ⚠️ **这个戳不许放在被监视的那个目录里**：放进去的话，写它这个动作本身
#    就会触发 `.path` 单元，而单元又写它 ⇒ **自己把自己点着的死循环**。
STAMP="${HUPO_PROVISION_STAMP:-/run/hupo-provision.last}"
MIN_INTERVAL="${HUPO_PROVISION_MIN_INTERVAL:-3}"
now="$(date +%s)"
last="$(cat "$STAMP" 2>/dev/null || echo 0)"
case "$last" in ''|*[!0-9]*) last=0 ;; esac
wait_s=$(( MIN_INTERVAL - (now - last) ))
if [ "$wait_s" -gt 0 ]; then
  # ⚠️ **等，而不是"跳过"**：跳过会把申请留在目录里，而 `.path` 单元在
  #    "目录一直非空"时**不会再触发** ⇒ 那张申请就永远躺在那儿了（静默卡死）。
  sleep "$wait_s"
fi
[ "$DRY" = "1" ] || date +%s > "$STAMP"

# 处理完（无论成败）都把申请删掉；失败额外留一个 `.failed` 空标记
finish_fail() {  # finish_fail <文件> <为什么>
  local f="$1" why="$2"
  log "✗ 拒了 ${f##*/}：$why"
  # ⚠️ 标记建**之前**先删申请，顺序反了的话中间那一刻服务会同时看到两个
  [ "$DRY" = "1" ] || { : > "$f.failed" 2>/dev/null || true; }
  [ "$DRY" = "1" ] || rm -f -- "$f"
}

# ⚠️ **用 `find` 而不是 glob**（2026-09-21 判据抓到的）：
#    shell 的 `*` **不匹配点开头的名字** ⇒ 一个叫 `.req` 的垃圾文件会
#    **永远**躺在申请目录里没人处理（而 `.path` 单元每次有动静还是会触发）。
#    它不危险（那种名字一律拒），但"没人清理的垃圾"正是这个项目最忌的形状。
#    ⇒ `find -name '*.req'` 是匹配点文件的，用它。
done_any=0
while IFS= read -r -d '' f; do
  base="${f##*/}"
  n="${base%.req}"
  done_any=1

  # ① 名字必须**就是一个整数**（A1/A2）。其余形状一律拒。
  if ! [[ "$n" =~ ^[1-9][0-9]{0,2}$ ]]; then
    finish_fail "$f" "名字不是 1..${MAX_TENANTS} 的整数（只认 <整数>.req）"; continue
  fi
  # ② 上限（A4）—— 公开口烧资源的最后一道闸
  if [ "$n" -gt "$MAX_TENANTS" ]; then
    finish_fail "$f" "第 $n 号超过上限 $MAX_TENANTS"; continue
  fi
  # ③ 符号链接 / 不是普通文件 ⇒ 拒（A3）
  if [ -L "$f" ]; then finish_fail "$f" "是个符号链接（申请必须是普通文件）"; continue; fi
  if [ ! -f "$f" ]; then finish_fail "$f" "不是普通文件"; continue; fi
  # ④ 属主必须是服务那个 uid（A3）
  owner="$(stat -c %u -- "$f" 2>/dev/null || echo '?')"
  if [ "$owner" != "$SERVICE_UID" ]; then
    finish_fail "$f" "文件属主是 $owner，不是服务那个 uid（$SERVICE_UID）"; continue
  fi

  name="${NAME_PREFIX}${n}"
  uid_want=$((UID_BASE + n))
  log "▶ 第 $n 号 → 建 $name（uid $uid_want）"

  if [ "$DRY" = "1" ]; then
    say "（只验不建：$name 会由 create-tenant-users.sh + create-tenant-pool.sh 建出来）"
    continue
  fi

  # ⑤ 真建：**只调现成的那两个脚本**（名单只有一处 → 不会长出平行的建法）
  if HUPO_TENANT_USERS="$name" bash "$LIBDIR/create-tenant-users.sh" --yes \
       && HUPO_TENANT_USERS="$name" HUPO_OWNER_USER="$SERVICE_USER" bash "$LIBDIR/create-tenant-pool.sh" --yes; then
    log "✓ 第 $n 号建好了（$name）"
    rm -f -- "$f.failed" "$f"
  else
    log "✗ 第 $n 号没建成（$name）—— 上面那几行就是原因"
    : > "$f.failed" 2>/dev/null || true
    rm -f -- "$f"
  fi
done < <(find "$REQ_DIR" -maxdepth 1 -name '*.req' -print0 2>/dev/null)

[ "$done_any" = "1" ] || log "（目录里没有 *.req，白跑一趟）"
exit 0
