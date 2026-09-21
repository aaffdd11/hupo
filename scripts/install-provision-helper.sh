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
LIBEXEC="/usr/local/libexec/hupo"
ETC_CONF="/etc/hupo/tenant-template.conf"
TMPFILES="/etc/tmpfiles.d/hupo-provision.conf"
UNIT_DIR="/etc/systemd/system"
REQ_DIR="/run/hupo-provision"
SERVICE_USER="${HUPO_SERVICE_USER:-deploy}"

MODE="show"
case "${1:-}" in
  --yes) MODE="install" ;;
  --uninstall) MODE="uninstall" ;;
  --check) MODE="check" ;;
  '') MODE="show" ;;
  *) echo "✗ 不认识的参数：$1"; exit 2 ;;
esac

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
  systemctl disable --now hupo-provision.path >/dev/null 2>&1 || true
  plan "删掉单元 / tmpfiles / 装着的那份"
  rm -f "$UNIT_DIR/hupo-provision.path" "$UNIT_DIR/hupo-provision.service" "$TMPFILES"
  rm -rf "$LIBEXEC" "$ETC_CONF"
  systemctl daemon-reload
  systemctl reset-failed hupo-provision.service >/dev/null 2>&1 || true
  say "撤干净了（申请目录里剩的东西**没动**：那里面可能有还没处理的申请）"
  exit 0
fi

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
cat > "$TMPFILES" <<EOF
# 琥珀 · 新租户申请的投放口（契约 docs/dev/43-AUTO-PROVISION.md §三 A3）
# ⚠️ 1733 = 服务（$SERVICE_USER）能进、能放文件，但**列不出**别人的东西，
#    也**替换不掉** root 放的文件（sticky）。属主是 root ⇒ 他连删别人的都做不到。
d $REQ_DIR 1733 root $SERVICE_USER -
EOF
install -d -o root -g "$SERVICE_USER" -m 1733 "$REQ_DIR"
say "目录：$(stat -c '%a %U:%G' "$REQ_DIR")  ← 必须是 1733 root:$SERVICE_USER"

# ── ③ 两个单元 ───────────────────────────────────────────────
# ⚠️ `ExecStart` 指的是 **libexec 里那一份**（root 拥有），**不是**仓库里那份（A9）。
plan "写 $UNIT_DIR/hupo-provision.path"
cat > "$UNIT_DIR/hupo-provision.path" <<EOF
[Unit]
Description=琥珀 · 新租户申请（看一眼投放口）
# ⚠️ 两个触发条件都要：
#   · DirectoryNotEmpty 管"从空变成非空"那一瞬；
#   · PathChanged 管"已经有东西了、又来了一个"（只有前者的话，第二次申请不会触发）。
[Path]
DirectoryNotEmpty=$REQ_DIR
PathChanged=$REQ_DIR
Unit=hupo-provision.service

[Install]
WantedBy=paths.target
EOF

plan "写 $UNIT_DIR/hupo-provision.service"
cat > "$UNIT_DIR/hupo-provision.service" <<EOF
[Unit]
Description=琥珀 · 建一台新租户（受控 · 跑完就退）
# ⚠️ 它**不 Enable**：只在 .path 看见申请时被拉起。**没有常驻 root 进程。**
[Service]
Type=oneshot
# ⚠️ 这里指的是 root 拥有的那一份拷贝 —— 改仓库里的脚本**不会**改到它（A9）。
ExecStart=$LIBEXEC/provision-tenant-request.sh
Environment=HUPO_TENANT_TEMPLATE=$ETC_CONF
Environment=HUPO_SERVICE_USER=$SERVICE_USER
# 建一台要 load 镜像（几十秒到几分钟）⇒ 给够；超时也不会留下半个（脚本自己幂等）
TimeoutStartSec=20min
# 同一时刻只跑一个（systemd 的 oneshot 本来就不会并发）⇒ 这就是"串行"那道闸
EOF
chmod 0644 "$UNIT_DIR/hupo-provision.path" "$UNIT_DIR/hupo-provision.service"
say "单元写好了"

# ── ④ 生效 ───────────────────────────────────────────────────
plan "systemd-tmpfiles --create && daemon-reload && enable --now .path"
systemd-tmpfiles --create "$TMPFILES" 2>&1 | sed 's/^/  /' || true
systemctl daemon-reload
systemctl enable --now hupo-provision.path 2>&1 | sed 's/^/  /'
echo
say "单元状态：$(systemctl is-active hupo-provision.path 2>&1) / $(systemctl is-enabled hupo-provision.path 2>&1)"

# ── ⑤ 自证：`--check` 那几条现在就该是绿的 ────────────────────
echo
bash "$ROOT/scripts/install-provision-helper.sh" --check | sed 's/^/  /'
echo
echo "⚠️ 现在**一台容器都没建**。真要开一台：让一个新手机号登录，或者"
echo "   手动投一张：sudo -u $SERVICE_USER touch $REQ_DIR/3.req"
echo "⚠️ 撤销这条路：sudo bash scripts/install-provision-helper.sh --uninstall"
