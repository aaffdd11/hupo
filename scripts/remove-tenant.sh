#!/usr/bin/env bash
# **删掉一台租户**（契约 `docs/dev/43-AUTO-PROVISION.md` · 手册 `05-DECISIONS.md` **X3 第 ④ 条**
# 「注销账号**立刻清空**」的那一半）。
#
# 用法：
#   bash scripts/remove-tenant.sh --n 3              # **只看**：把要做的每一件事打印出来
#   sudo bash scripts/remove-tenant.sh --n 3 --yes   # 真删（P2：**主人跑**）
#   sudo bash scripts/remove-tenant.sh --name hupo-t3 --yes
#
# ── 为什么要有它（两个独立的理由）──────────────────────────
#   ① **产品缺这一条**：手册 X3 ④ 写着"注销账号立刻清空"，而实现里**一条路都没有**
#      ⇒ 用户注销之后，他的 OS 用户 / 一段 subuid / 一个卷 / 一份镜像**会永远留在机器上**。
#   ② **它也是"建坏了"的出路**：一台建到一半的租户（或者失败留下的）没有路可以收拾。
#
# ── 🔴 五条不许破 ──────────────────────────────────────────
#   1. **静态表里那两台（`hupo-a`/`hupo-b`）永远不许删** —— 它们是**老用户正在用的**，
#      删了就是"把人家的世界删了"。这条是**硬拒**，不给任何绕过开关。
#   2. **只认模板推得出来的名字**（`<前缀><1..上限>`）：别的一律拒（防手滑删错东西）。
#   3. **先停服务、再删人**：不停就删，那个用户的管理器会把容器**又拉起来**
#      （而 home 已经被删了 —— 现象是一串看不懂的错）。
#   4. **幂等**：已经删过的再跑一次 ⇒ 说"已经没有了"，然后**照样清残留**
#      （subuid 条目 / 通道目录 / 待办申请 —— 半路失败会留下这些）。
#   5. ⚠️ **它不碰"别人"**：只按名字删，不扫目录、不猜。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${HUPO_TENANT_TEMPLATE:-$ROOT/v2/services/core/tenant-template.conf}"
SERVICE_USER="${HUPO_SERVICE_USER:-deploy}"
CHAN_DIR="${HUPO_CHANNEL_DIR:-/run/hupo-channel}"
REQ_DIR="${HUPO_PROVISION_DIR:-/run/hupo-provision}"
FAILED_DIR="${HUPO_PROVISION_FAILED_DIR:-/run/hupo-provision-state}"
# ⚠️ 静态表里那两台：**永远不许删**（硬拒，没有开关）
PROTECTED=(hupo-a hupo-b)

WANT_N=""
WANT_NAME=""
DO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --n) shift; WANT_N="${1:-}" ;;
    --name) shift; WANT_NAME="${1:-}" ;;
    --yes) DO=1 ;;
    *) echo "✗ 不认识的参数：$1"; exit 2 ;;
  esac
  shift
done

say()  { echo "  $1"; }
plan() { echo "▶ $1"; }

# ── 给主人看的那一笔账（账 #39 · 契约 `43-AUTO-PROVISION.md` §十四）──────
#   🔴 **形状与 JS 那边（`src/audit.js`）逐字一致**：
#        `[YYYY-MM-DD HH:MM:SS] 事件 · 租户 · 用户 · 手机 · 说明`
#      ⚠️ 两边各写一份格式 = **一定会漂**，而漂了账就分成两半。
#         判据里有一条**跨产物**的闸：拿真跑出来的两种行去比形状。
#      ⚠️ **钥匙一个字符都不许有**；**手机号只写掩码**（这一侧压根不知道手机号
#         ⇒ 一律写 `—`：特权侧只知道租户名，**不许去读人家的手机号**）。
#      ⚠️ 写不进去**不许把动作带走** —— 但要说一声（只有 root 时才有资格抱怨：
#         非 root 的"只看"跑不进去是正常的）。
AUDIT="${HUPO_TENANT_AUDIT:-/var/log/hupo/tenant-audit.log}"
audit() {  # audit <事件> <租户名> <用户> <说明>
  local what="$1" tenant="${2:--}" who="${3:--}" detail="${4:--}"
  [ -n "$what" ] || return 0
  mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
  if printf '[%s] %s · %s · %s · %s · %s\n' "$(date '+%F %T')" "$what" "$tenant" "$who" "—" "$detail" >>"$AUDIT" 2>/dev/null; then
    chmod 0644 "$AUDIT" 2>/dev/null || true
  elif [ "$(id -u)" = "0" ]; then
    echo "  ⚠️ 审计那一行没写进去（$AUDIT）—— 这一件**没有留下痕迹**"
  fi
}

# ⚠️ **拒了也要记账**（"有人想删、没让他删、为什么" —— 那正是最该看见的一行）。
#    所以 `die` 先记一笔再退。`NAME` 可能还没定（比如模板读不出来）⇒ 用 `${NAME:--}`。
die()  { audit "拒了" "${NAME:--}" "${WHO:--}" "$1"; echo "✗ $1"; exit 2; }

tpl_get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$TEMPLATE" 2>/dev/null | head -1; }
NAME_PREFIX="$(tpl_get name_prefix)"
UID_BASE="$(tpl_get uid_base)"
MAX_TENANTS="$(tpl_get max_tenants)"
[ -n "$NAME_PREFIX" ] && [ -n "$UID_BASE" ] && [ -n "$MAX_TENANTS" ] \
  || die "读不出租户模板（$TEMPLATE）—— 一个都不删"

# ── 名字：要么从 --n 推，要么直接给 --name；**只认模板推得出来的那一种** ──
if [ -n "$WANT_N" ]; then
  case "$WANT_N" in
    ''|*[!0-9]*) die "--n 要一个整数（给的是「$WANT_N」）" ;;
  esac
  [ "$WANT_N" -ge 1 ] && [ "$WANT_N" -le "$MAX_TENANTS" ] \
    || die "第 $WANT_N 号超出模板的范围（1..$MAX_TENANTS）"
  NAME="${NAME_PREFIX}${WANT_N}"
elif [ -n "$WANT_NAME" ]; then
  NAME="$WANT_NAME"
else
  die "要给一个要删的租户：--n <编号> 或 --name <名字>（⚠️ 不给就是不给，**没有"删全部"这种参数**）"
fi

# ⚠️ **审计那一行里的"用户"列**：派生的租户，userId 就是 `u<N>`
#    （`tenants.js` 的 `tenantNameFor(u<N>) === <前缀><N>` ⇒ 两边指的是同一台）。
#    静态表那两台没有编号 ⇒ 写 `—`（**不许猜**）。
WHO="—"
[ -n "${WANT_N:-}" ] && WHO="u${WANT_N}"

# ① 🔴 静态表里那两台：**永远不许删**（这一条在任何别的判断之前）
for p in "${PROTECTED[@]}"; do
  if [ "$NAME" = "$p" ]; then
    die "「$NAME」是**静态表里那两台之一** —— 那是老用户正在用的世界，**永远不许删**（没有绕过开关）"
  fi
done
# ② 只认模板推得出来的形状
case "$NAME" in
  "$NAME_PREFIX"*)
    N="${NAME#"$NAME_PREFIX"}"
    case "$N" in
      ''|*[!0-9]*) die "「$NAME」不是模板推得出来的名字（要 ${NAME_PREFIX}<1..$MAX_TENANTS>）" ;;
    esac
    [ "$N" -ge 1 ] && [ "$N" -le "$MAX_TENANTS" ] \
      || die "「$NAME」的编号 $N 超出模板的范围（1..$MAX_TENANTS）"
    WHO="u$N"   # ⚠️ 名字认下来了 ⇒ 审计那一列的"用户"也定下来了
    ;;
  *) die "「$NAME」不是模板推得出来的名字（要 ${NAME_PREFIX}<1..$MAX_TENANTS>）" ;;
esac

WANT_UID=$((UID_BASE + N))
HOME_DIR="/home/$NAME"
VOL="$HOME_DIR/tenant"

echo "── 删一台租户 ──────────────────────────────────"
echo "  名字：$NAME（uid $WANT_UID）"
echo "  家目录 / 卷：$HOME_DIR ／ $VOL"
echo "  方式：$([ "$DO" = "1" ] && echo '**真删**' || echo '只看（想真删加 --yes）')"
echo "  🔴 **不可逆**：他的对话、账本、回收站、那份镜像 —— 一起没"
echo

if [ "$DO" = "1" ] && [ "$(id -u)" != "0" ]; then
  die "--yes 要 root（它要删用户、改 /etc/subuid）。请：sudo bash $0 --name $NAME --yes"
fi

# ── 它现在什么样（先如实报，再动手）──
if id "$NAME" >/dev/null 2>&1; then
  say "这个用户现在在：uid=$(id -u "$NAME")  家目录 $(stat -c '%a %U:%G' "$HOME_DIR" 2>/dev/null || echo 不在)"
  if [ "$DO" = "1" ]; then
    say "家目录占用：$(du -sh "$HOME_DIR" 2>/dev/null | cut -f1)"
  fi
else
  say "查无此人 —— 但**残留照清**（半路失败会留下 subuid 条目 / 通道目录 / 待办申请）"
  audit "真收掉了" "$NAME" "$WHO" "本来就查无此人 —— 清残留"
fi

as_user() {  # 以那个租户身份跑（CD /tmp 不能省；sudo -u 会保留当前目录）
  sudo -u "$1" -H sh -c 'cd /tmp && exec env XDG_RUNTIME_DIR="/run/user/$(id -u)" "$@"' sh "${@:2}"
}

# ══════════════════════════════════════════════════════════════════
# 真删：五步，**顺序是死的**（先停、再删人、最后清残留）
# ══════════════════════════════════════════════════════════════════
if [ "$DO" != "1" ]; then
  echo
  plan "① 停掉并禁用他自己的那个单元（systemctl --user disable --now hupo-tenant.service）"
  plan "   ⚠️ 必须先停：不停就删 ⇒ 他的管理器会把容器**又拉起来**，而 home 已经没了"
  plan "② 掐掉他所有的进程（loginctl terminate-user $NAME）"
  plan "③ 关掉 linger（loginctl disable-linger $NAME）"
  plan "④ userdel -r $NAME（连同家目录 —— 镜像也在那里面，约 400M+）"
  plan "⑤ 清残留：/etc/subuid 与 /etc/subgid 里那两行 · $CHAN_DIR/$NAME · $REQ_DIR/$N.req · $FAILED_DIR/$N.req.failed"
  echo
  say "⚠️ 删完还要**重启一次宿主服务**（不然它会一直替一个不存在的租户听着）：scripts/restart-core.sh"
  echo
  echo "▶ （只看模式）真删：sudo bash $0 --name $NAME --yes"
  exit 0
fi

echo
plan "① 停掉并禁用他自己的那个单元"
# ⚠️ `%s` 不能在 systemd 单元里裸写 —— 这里是命令行，没问题
if as_user "$NAME" systemctl --user disable --now hupo-tenant.service >/dev/null 2>&1; then
  say "停掉了（disable --now）"
else
  say "（停不了 —— 多半是它本来就没在跑，或者这个用户的管理器已经没了；**继续**）"
fi
# 容器万一还在，直接删掉（同样是"先停"的意思）
as_user "$NAME" podman rm -f "hupo-tenant-$NAME" >/dev/null 2>&1 && say "容器也删了" || true

plan "② 掐掉他所有的进程"
if loginctl terminate-user "$NAME" >/dev/null 2>&1; then say "掐了（loginctl terminate-user）"; else say "（没有他的会话）"; fi
# 给它一点时间真的退干净 —— 不退干净 `userdel` 会留下目录
for _ in $(seq 1 20); do pgrep -u "$NAME" >/dev/null 2>&1 || break; sleep 0.5; done

plan "③ 关掉 linger"
if [ -f "/var/lib/systemd/linger/$NAME" ]; then
  loginctl disable-linger "$NAME" >/dev/null 2>&1 && say "关了" || say "⚠️ 没关成"
else
  say "（本来就没开）"
fi

plan "④ 删掉这个用户（连同他的家目录 —— 镜像也在那里面）"
if id "$NAME" >/dev/null 2>&1; then
  if userdel -r "$NAME" >/dev/null 2>&1; then
    say "删了（userdel -r）"
  else
    # ⚠️ `userdel -r` 在"家目录里有别的挂载/进程还占着"时会失败。
    #    这时**不能**说"删好了"—— 分开做，并如实说哪一半没成。
    say "⚠️ userdel -r 没成 —— 分两步：先删用户，再删目录"
    userdel "$NAME" >/dev/null 2>&1 && say "用户删了" || say "⚠️ 用户没删成"
    if [ -d "$HOME_DIR" ]; then
      rm -rf "$HOME_DIR" && say "家目录删了" || say "⚠️ 家目录没删成：$HOME_DIR"
    fi
  fi
else
  say "（本来就查无此人）"
fi
# 兜底：家目录还在就删（上面那条路失败时留下的）
if [ -d "$HOME_DIR" ]; then
  rm -rf "$HOME_DIR" && say "家目录（残留）删了" || say "⚠️ 家目录还在：$HOME_DIR"
fi

plan "⑤ 清残留（这几样**半路失败会留下**）"
tmp="$(mktemp)"
if grep -q "^$NAME:" /etc/subuid 2>/dev/null; then
  grep -v "^$NAME:" /etc/subuid > "$tmp" && cat "$tmp" > /etc/subuid && say "从 /etc/subuid 删了一行"
else
  say "（/etc/subuid 里没有它）"
fi
if grep -q "^$NAME:" /etc/subgid 2>/dev/null; then
  grep -v "^$NAME:" /etc/subgid > "$tmp" && cat "$tmp" > /etc/subgid && say "从 /etc/subgid 删了一行"
else
  say "（/etc/subgid 里没有它）"
fi
rm -f "$tmp"
if [ -d "$CHAN_DIR/$NAME" ]; then
  rm -rf "$CHAN_DIR/$NAME" && say "通道目录删了：$CHAN_DIR/$NAME" || say "⚠️ 通道目录没删成"
else
  say "（通道目录本来就不在）"
fi
for f in "$REQ_DIR/$N.req" "$FAILED_DIR/$N.req.failed"; do
  if [ -e "$f" ]; then rm -f "$f" && say "清了待办/标记：$f"; fi
done

# ══════════════════════════════════════════════════════════════════
echo
echo "── 自证：它**真的一点都不剩** ──────────────────"
left=0
id "$NAME" >/dev/null 2>&1 && { echo "  ✗ 用户还在"; left=1; }
[ -d "$HOME_DIR" ] && { echo "  ✗ 家目录还在：$HOME_DIR"; left=1; }
grep -q "^$NAME:" /etc/subuid 2>/dev/null && { echo "  ✗ /etc/subuid 里还有"; left=1; }
grep -q "^$NAME:" /etc/subgid 2>/dev/null && { echo "  ✗ /etc/subgid 里还有"; left=1; }
[ -d "$CHAN_DIR/$NAME" ] && { echo "  ✗ 通道目录还在"; left=1; }
[ -d "/var/lib/systemd/linger/$NAME" ] && { echo "  ✗ linger 还在"; left=1; }
if [ "$left" = "0" ]; then
  echo "  ✓ 用户 / 家目录 / subuid / subgid / 通道 / linger —— **一样都不剩**"
  audit "真收掉了" "$NAME" "$WHO" "用户/家目录/subuid/subgid/通道/linger 都不剩"
else
  echo "  ⚠️ 上面那几样**没清干净** —— 再跑一次这个脚本（它是幂等的）"
  audit "没收成" "$NAME" "$WHO" "有残留没清干净 —— 再跑一次（脚本是幂等的）"
fi
echo
echo "⚠️ **还有一步**：重启一次宿主服务，让它别再替一个不存在的租户听着："
echo "     scripts/restart-core.sh"
exit $([ "$left" = "0" ] && echo 0 || echo 1)
