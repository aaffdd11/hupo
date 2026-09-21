#!/usr/bin/env bash
# 装/卸/核对**特权侧那一条路**（契约 `docs/dev/43-AUTO-PROVISION.md`）。
#
# 用法：
#   bash scripts/install-provision-helper.sh            # **只看**：要装什么、现在什么样
#   sudo bash scripts/install-provision-helper.sh --yes # 真装（P2：**主人跑**，助手只写）
#   sudo bash scripts/install-provision-helper.sh --uninstall
#   bash scripts/install-provision-helper.sh --check     # 仓库那份 vs 装着那份，逐字节比
#
# ── 🔴 这个脚本存在的**唯一理由**（契约 §三 A9）────────────────
# root 要跑的每一份文件，**必须 root 拥有**。
# 直接让单元去跑仓库里那个脚本是**不行的** —— 仓库属主就是服务自己，
# 一个被攻陷的服务改一行，下次申请触发时那段代码**就是以 root 跑的**。
# ⇒ 所以这里是**拷贝**：仓库里那份是**源码**，装着那份才是**运行的那份**。
#   ⚠️ "改完了 ≠ 生效了" —— 改完仓库里的，要再跑一次这个脚本才会生效（`--check` 会告诉你）。
#
# ── 它装什么（四份 root 拥有的文件 + 三个单元）────────────────
#   /usr/local/libexec/hupo/provision-tenant-request.sh
#   /usr/local/libexec/hupo/create-tenant-users.sh
#   /usr/local/libexec/hupo/create-tenant-pool.sh
#   /etc/hupo/tenant-template.conf
#   /etc/tmpfiles.d/hupo-provision.conf
#   /etc/systemd/system/hupo-provision.{path,service}
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${HUPO_SERVICE_USER:-deploy}"

MODE="show"
INSTALL_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) MODE="install" ;;
    --uninstall) MODE="uninstall" ;;
    --check) MODE="check" ;;
    --root)
      shift
      INSTALL_ROOT="${1:-}"
      [ -n "$INSTALL_ROOT" ] || { echo "✗ --root 后面要跟一个目录"; exit 2; }
      ;;
    '') ;;
    *) echo "✗ 不认识的参数：$1"; exit 2 ;;
  esac
  shift
done

# ── ⚠️ `--root <目录>`：**只给判据用**（契约 `43-AUTO-PROVISION.md` §三 A9）────
# 它把下面每一个目标路径挪到一个**临时根**下，并且**跳过 systemd / tmpfiles**
# （那两个命令没法"装到别处"）。
#
# 🔴 **为什么值得加它**：A9 那四条判据（四份 root 拥有 · 单元指向的是**拷贝**
#    而不是仓库那份 · `--check` 认得出漂移 · 服务那个身份改不动）原来要**等主人
#    签字装完**才验得了 —— 而它们恰恰是"整套模型会不会作废"的那几条。
#    ⇒ 有了它，这四条能在**隔离环境**里先验掉；真装那一步仍然只差签字。
# ⚠️ 它不是"另一种装法"，是**同一段代码换一个目的地** —— 判据打的仍是真那份代码。
TEST_ROOT=""
if [ -n "$INSTALL_ROOT" ]; then
  [ -d "$INSTALL_ROOT" ] || { echo "✗ --root 指的目录不存在：$INSTALL_ROOT"; exit 2; }
  TEST_ROOT="$(cd "$INSTALL_ROOT" && pwd)"
fi
prefix() { if [ -n "$TEST_ROOT" ]; then printf '%s%s' "$TEST_ROOT" "$1"; else printf '%s' "$1"; fi; }

LIBEXEC="$(prefix /usr/local/libexec/hupo)"
ETC_CONF="$(prefix /etc/hupo/tenant-template.conf)"
TMPFILES="$(prefix /etc/tmpfiles.d/hupo-provision.conf)"
UNIT_DIR="$(prefix /etc/systemd/system)"
REQ_DIR="$(prefix /run/hupo-provision)"
REQ_DIR_STATE="$(prefix /run/hupo-provision-state)"

say()  { echo "  $1"; }
plan() { echo "▶ $1"; }

SRC_SCRIPTS=(provision-tenant-request.sh create-tenant-users.sh create-tenant-pool.sh)
SRC_CONF="v2/services/core/tenant-template.conf"

# ── `--check`：**仓库那份 vs 装着那份**（这是"生效了没有"的唯一判据）──
# ⚠️ 它**不需要 root**（只是读），所以主人随时能自己跑。
if [ "$MODE" = "check" ]; then
  echo "── 装着的那份 vs 仓库里那份 ────────────────────"
  rc=0
  for f in "${SRC_SCRIPTS[@]}"; do
    if [ ! -f "$LIBEXEC/$f" ]; then echo "  ✗ 没装：$LIBEXEC/$f"; rc=1; continue; fi
    if cmp -s "$ROOT/scripts/$f" "$LIBEXEC/$f"; then
      say "一致：$f"
    else
      echo "  ✗ **不一致**：$f —— 仓库改了，但 root 跑的还是旧那份"
      echo "      ⇒ 让改动生效：sudo bash scripts/install-provision-helper.sh --yes"
      rc=1
    fi
  done
  if [ ! -f "$ETC_CONF" ]; then echo "  ✗ 没装：$ETC_CONF"; rc=1;  elif cmp -s "$ROOT/$SRC_CONF" "$ETC_CONF"; then
    say "一致：tenant-template.conf"
  else
    echo "  ✗ **不一致**：tenant-template.conf —— 服务侧读的与 root 侧读的**不是同一份内容**"
    echo "      ⚠️ 这种不一致最难查：容器起来了、服务却在听另一个通道（看起来像容器没起来）"
    rc=1
  fi
  echo
  echo "── 属主与权限（A9：必须 root）──────────────────"
  for f in "$LIBEXEC"/*.sh "$ETC_CONF"; do
    [ -e "$f" ] || continue
    printf '  %-56s %s\n' "${f}" "$(stat -c '%U:%G %a' "$f")"
    case "$(stat -c '%U' "$f")" in root) : ;; *) echo "      ✗ **属主不是 root** —— 这条路不成立"; rc=1 ;; esac
  done
  echo
  [ "$rc" = "0" ] && echo "✅ 一致（root 跑的就是仓库里这一份）" || echo "✗ 有不一致的地方（上面逐条写了）"
  exit "$rc"
fi

echo "── 特权侧那一条路 ──────────────────────────────"
echo "  方式：$MODE"
echo "  服务那个用户：$SERVICE_USER"
echo "  装到：$LIBEXEC  +  $ETC_CONF"
echo "  单元：$UNIT_DIR/hupo-provision.{path,service}"
echo "  申请目录：$REQ_DIR（$( [ "$MODE" = install ] && echo '1733' || echo '1733' ) root:$SERVICE_USER）"
echo "  ⚠️ 只会**建单元**，**一台容器都不会建**（第一台要等真有申请）"
echo

if [ "$MODE" = "uninstall" ]; then
  [ "$(id -u)" = "0" ] || { echo "✗ --uninstall 要 root"; exit 2; }
  plan "停掉并禁用 .path 单元"
  if [ -z "$TEST_ROOT" ]; then
    systemctl disable --now hupo-provision.path >/dev/null 2>&1 || true
  else
    say "（--root 模式：不碰 systemd，只删文件）"
  fi
  plan "删掉单元 / tmpfiles / 装着的那份"
  rm -f "$UNIT_DIR/hupo-provision.path" "$UNIT_DIR/hupo-provision.service" "$TMPFILES"
  rm -rf "$LIBEXEC" "$ETC_CONF"
  if [ -z "$TEST_ROOT" ]; then
    systemctl daemon-reload
    systemctl reset-failed hupo-provision.service >/dev/null 2>&1 || true
  fi
  say "撤干净了（申请目录里剩的东西**没动**：那里面可能有还没处理的申请）"
  exit 0
fi

# ── 🔴 装机前**该看的事实**（只读，什么都不改）────────────────────
# ⚠️ 为什么要有这一段：文档里写着"上限**按磁盘算**"，而模板里其实是一个常数。
#    两者不一致本身就要说清；更要紧的是**这个常数放不放得下** ——
#    装的时候一切正常、等第一个申请来了才失败，是最坏的时机。
#    ⇒ 装机前把这三件**算出来**给人看：镜像在不在 · 每台多大 · 磁盘放得下几台。
OWNER_USER="${HUPO_OWNER_USER:-${SUDO_USER:-deploy}}"
# ⚠️ `IMG` 必须在**用它的第一行之前**定义（脚本有 `set -u`，用未定义的变量会直接退出）
IMG="${HUPO_TENANT_IMAGE:-localhost/hupo-tenant:local}"
IMG_SZ=""
IMG_THERE="?"
as_owner() { sudo -u "$OWNER_USER" -H sh -c 'cd /tmp && exec env XDG_RUNTIME_DIR="/run/user/$(id -u)" "$@"' sh "$@"; }
if id "$OWNER_USER" >/dev/null 2>&1 && command -v podman >/dev/null 2>&1; then
  if as_owner podman image exists "$IMG" 2>/dev/null; then
    IMG_THERE="1"
    IMG_SZ="$(as_owner podman image inspect "$IMG" --format '{{.Size}}' 2>/dev/null | head -1)"
  else
    # ⚠️ 只有"**它明确说没有**"才算没有；查不动（比如没有 /run/user）就当"查不了"
    if as_owner podman image inspect "$IMG" >/dev/null 2>&1; then IMG_THERE="?"; else IMG_THERE="0"; fi
  fi
fi

tpl_get2() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ROOT/$SRC_CONF" 2>/dev/null | head -1; }
MAX_T="$(tpl_get2 max_tenants)"

echo "── 装机前该看的事实 ────────────────────────────"
say "租户镜像   $IMG"
case "$IMG_THERE" in
  1) say "           ✅ 在（$(awk -v b="${IMG_SZ:-0}" 'BEGIN{printf "%.0f", b/1048576}') MB）" ;;
  0) say "           🔴 **不在**（$OWNER_USER 那份 rootless 存储里没有）⇒ 先建：bash scripts/build-tenant-image.sh" ;;
  *) say "           ⚠️ 查不动（podman 起不来？）—— 这一条**没验**，不是过了" ;;
esac
if [ -n "$MAX_T" ] && [ -n "$IMG_SZ" ] && [ "${IMG_SZ:-0}" -gt 0 ]; then
  need=$((MAX_T * IMG_SZ))
  home_dir="$(getent passwd "$OWNER_USER" | cut -d: -f6)"
  avail="$(df -B1 --output=avail "$home_dir" 2>/dev/null | tail -1 | tr -d ' ')"
  if [ -n "${avail:-}" ] && [ "${avail:-0}" -gt 0 ]; then
    fits=$((avail / IMG_SZ))
    printf '  %s\n' "磁盘       $(awk -v b="$need" 'BEGIN{printf "%.1f", b/1073741824}') GB 才够 $MAX_T 台；可用 $(awk -v b="$avail" 'BEGIN{printf "%.1f", b/1073741824}') GB ⇒ **放得下 $fits 台**"
    if [ "$fits" -lt "$MAX_T" ]; then
      say "           ⚠️ **上限（模板里的 max_tenants=$MAX_T）比磁盘放得下的多** —— 第 $((fits + 1)) 个申请会失败。改 ${SRC_CONF} 里的 max_tenants，或腾地方"
    else
      say "           ✅ 放得下（模板里的上限就是 $MAX_T）"
    fi
  else
    say "磁盘       ⚠️ 算不出可用空间（$home_dir）"
  fi
elif [ -z "$MAX_T" ]; then
  say "磁盘       ⚠️ 读不出模板里的 max_tenants ⇒ 这一条**没验**"
else
  say "磁盘       ⚠️ 不知道镜像多大 ⇒ 这一条**没验**"
fi
echo

# ── 装之前先看三件事：服务那个身份不该因为这个脚本变（A6）──────
echo "── 服务那个身份（装完之后这三条必须**逐字相同**）──"
id "$SERVICE_USER" 2>&1 | sed 's/^/  /'
say "sudo 权限：$(sudo -l -U "$SERVICE_USER" 2>&1 | tail -1)"
say "docker 组：$(getent group docker >/dev/null 2>&1 && getent group docker || echo '（没有这个组）')"
echo

if [ "$MODE" != "install" ]; then
  plan "（只看模式）真装：sudo bash scripts/install-provision-helper.sh --yes"
  exit 0
fi

[ "$(id -u)" = "0" ] || { echo "✗ --yes 要 root。请：sudo bash scripts/install-provision-helper.sh --yes"; exit 2; }

# 🔴 **镜像不在就不装**（放在**任何写盘之前** —— 这一步只读，所以拒绝时这台机器一点没动）
# ⚠️ 为什么拒绝而不是"警告一下就算了"：装一个**永远不可能工作**的东西，
#    比当场说清"先把这个建出来"更坏 —— 而且失败会推迟到第一个申请来的时候，
#    那是**最坏的时机**（用户已经在等了）。
# ⚠️ **`--root`（判据用的隔离模式）不受这一条管**：那一档压根不装系统单元、
#    只是把文件摆到一个临时根里给判据看，跟本机有没有镜像没关系。
#    （这不是"给判据开后门"：两者的**副作用**完全不同，所以该管的规矩也不同。）
if [ -z "$TEST_ROOT" ] && [ "$IMG_THERE" = "0" ]; then
  echo
  echo "✗ 不动手：租户镜像不在（$IMG）"
  echo "  这台机器上还没有那一份镜像 ⇒ 装了也建不出任何一台。"
  echo "  先跑这一条，再回来装：bash scripts/build-tenant-image.sh"
  exit 3
fi

# ── ① 四份 root 拥有的文件（A9）──────────────────────────────
plan "拷四份到 root 拥有的位置（仓库那份是源码，这一份才是运行的那份）"
install -d -o root -g root -m 0755 "$LIBEXEC"
install -o root -g root -m 0755 "$ROOT/scripts/provision-tenant-request.sh" "$LIBEXEC/provision-tenant-request.sh"
install -o root -g root -m 0755 "$ROOT/scripts/create-tenant-users.sh" "$LIBEXEC/create-tenant-users.sh"
install -o root -g root -m 0755 "$ROOT/scripts/create-tenant-pool.sh" "$LIBEXEC/create-tenant-pool.sh"
install -d -o root -g root -m 0755 "$(dirname "$ETC_CONF")"
install -o root -g root -m 0444 "$ROOT/$SRC_CONF" "$ETC_CONF"
say "拷好了：$(ls "$LIBEXEC" | tr '\n' ' ')"

# ── ② 申请目录：1733（服务能进能放文件、列不出别人的、替换不掉 root 的）──
plan "写 $TMPFILES（开机把 $REQ_DIR 建出来）"
# ⚠️ **注释走带引号的 heredoc、指令行走 printf**（2026-09-21 签字安装时真踩到）：
#    不带引号的 heredoc **会做命令替换** —— 而我在注释里写了反引号
#    ⇒ `DirectoryNotEmpty=` 与 `failed` 被当命令执行、在文件里替换成**空**。
#    （指令行没事，所以功能没坏 —— 但那是**运气**，不是设计。）
#    ⇒ 规矩：**这几份脚本里不许有不带引号的 heredoc**（判据里有闸）。
{
  cat <<'TPLEOF'
# 琥珀 · 新租户申请的投放口（契约 docs/dev/43-AUTO-PROVISION.md §三 A3）
# ⚠️ 1733 = 服务那个身份能进、能放文件，但**列不出**别人的东西，
#    也**替换不掉** root 放的文件（sticky）。属主是 root ⇒ 他连删别人的都做不到。
#
# ⚠️ **失败标记另放一个目录**（2026-09-21 真机量出来的）：
#    投放口里留下任何东西（标记就是）⇒ `DirectoryNotEmpty=` 会**反复触发**
#    ⇒ 撞上 systemd 的启动限速 ⇒ 单元进 `failed` ⇒ **之后的新申请没人管**。
#    ⇒ 投放口里**只许有待办申请**。
TPLEOF
  printf 'd %s 1733 root %s -\n' "$REQ_DIR" "$SERVICE_USER"
  printf 'd %s 0755 root root -\n' "$REQ_DIR_STATE"
} > "$TMPFILES"
install -d -o root -g "$SERVICE_USER" -m 1733 "$REQ_DIR"
install -d -o root -g root -m 0755 "$REQ_DIR_STATE"
say "目录：$(stat -c '%a %U:%G' "$REQ_DIR")  ← 必须是 1733 root:$SERVICE_USER"

# ── ③ 两个单元 ───────────────────────────────────────────────
# ⚠️ `ExecStart` 指的是 **libexec 里那一份**（root 拥有），**不是**仓库里那份（A9）。
# ⚠️ **先把这个目录建出来**（2026-09-21 判据抓到的）：真机上 `/etc/systemd/system`
#    本来就在，所以以前没露馅；而在"临时根"里（`--root`）它不存在 ⇒ `cat >` 直接失败，
#    而**脚本照样往下走**（单元没写成、后面那几步照样打印）——
#    又是一次"看起来装好了"。⇒ 显式建目录，建不成就不往下走。
install -d -o root -g root -m 0755 "$UNIT_DIR" || { echo "✗ 建不出单元目录：$UNIT_DIR"; exit 3; }
plan "写 $UNIT_DIR/hupo-provision.path"
{
  cat <<'PATHEOF'
[Unit]
Description=琥珀 · 新租户申请（看一眼投放口）
# ⚠️ **两个条件为什么都在**（2026-09-21 真机量过，不是照着文档抄的）：
#   · DirectoryNotEmpty —— **承重的那个**。它管"从空变非空"，也管
#     "起来时目录里已经有待办"（**开机**那一种 —— 那时候没有"变化"可听）。
#     ⚠️ 而且它**会反复触发**：实测投放口里留一个文件不动，服务被拉起 5 次
#     （然后撞上 systemd 的启动限速）。⇒ **投放口里只许有待办申请**。
#   · PathChanged —— **保险**：万一某个 systemd 版本对"从空变非空"不响，
#     它兜住。代价是"删掉申请"那一下也会多跑一次空转（无害）。
#     ⚠️ 我一度以为它是承重的 —— **量完才知道不是**。
[Path]
PATHEOF
  printf 'DirectoryNotEmpty=%s\n' "$REQ_DIR"
  printf 'PathChanged=%s\n' "$REQ_DIR"
  cat <<'PATHEOF2'
Unit=hupo-provision.service

[Install]
WantedBy=paths.target
PATHEOF2
} > "$UNIT_DIR/hupo-provision.path"
plan "写 $UNIT_DIR/hupo-provision.service"
# ⚠️ 同样：注释走带引号的 heredoc、值走 printf（不带引号的 heredoc 会执行注释里的反引号）
{
  cat <<'SVCEOF'
[Unit]
Description=琥珀 · 建一台新租户（受控 · 跑完就退）
# ⚠️ 它**不 Enable**：只在 .path 看见申请时被拉起。**没有常驻 root 进程。**
[Service]
Type=oneshot
# ⚠️ 这里指的是 root 拥有的那一份拷贝 —— 改仓库里的脚本**不会**改到它（A9）。
SVCEOF
  printf 'ExecStart=%s/provision-tenant-request.sh\n' "$LIBEXEC"
  printf 'Environment=HUPO_TENANT_TEMPLATE=%s\n' "$ETC_CONF"
  printf 'Environment=HUPO_SERVICE_USER=%s\n' "$SERVICE_USER"
  printf 'Environment=HUPO_PROVISION_FAILED_DIR=%s\n' "$REQ_DIR_STATE"
  cat <<'SVCEOF2'
# 建一台要 load 镜像（几十秒到几分钟）⇒ 给够；超时也不会留下半个（脚本自己幂等）
TimeoutStartSec=20min
# 同一时刻只跑一个（systemd 的 oneshot 本来就不会并发）⇒ 这就是"串行"那道闸
SVCEOF2
} > "$UNIT_DIR/hupo-provision.service"
chmod 0644 "$UNIT_DIR/hupo-provision.path" "$UNIT_DIR/hupo-provision.service"
say "单元写好了"

# ── ④ 生效 ───────────────────────────────────────────────────
plan "systemd-tmpfiles --create && daemon-reload && enable --now .path"
if [ -z "$TEST_ROOT" ]; then
  systemd-tmpfiles --create "$TMPFILES" 2>&1 | sed 's/^/  /' || true
  systemctl daemon-reload
  systemctl enable --now hupo-provision.path 2>&1 | sed 's/^/  /'
  echo
  say "单元状态：$(systemctl is-active hupo-provision.path 2>&1) / $(systemctl is-enabled hupo-provision.path 2>&1)"
else
  say "（--root 模式：**没有碰 systemd**，只把那些文件摆好了）"
fi

# ── ⑤ 自证：`--check` 那几条现在就该是绿的 ────────────────────
echo
bash "$ROOT/scripts/install-provision-helper.sh" --check | sed 's/^/  /'
echo
echo "⚠️ 现在**一台容器都没建**。真要开一台：让一个新手机号登录，或者"
echo "   手动投一张：sudo -u $SERVICE_USER touch $REQ_DIR/3.req"
echo "⚠️ 撤销这条路：sudo bash scripts/install-provision-helper.sh --uninstall"
