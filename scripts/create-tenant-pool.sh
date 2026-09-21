#!/usr/bin/env bash
# 建"租户池"（契约 `docs/dev/38-ISOLATION-SPLIT.md` §四 · `39-PERMISSIONS.md` §7.3 第 5 步）。
#
# 用法：
#   bash scripts/create-tenant-pool.sh              # **只看**：把要做的每一件事打印出来，什么都不动
#   sudo bash scripts/create-tenant-pool.sh --yes   # 真做（P2：**主人跑**，助手只写）
#
# ── 为什么要有"池"（而不是"来一个人现建一个"）────────────────
# 服务（`deploy`）**没有特权**，所以它**开不了别人的容器**。
# 两条路：① 给 `deploy` 一把常驻的钥匙（polkit / sudoers）② **事先把池建好**，
# 服务只跟"已经在跑的那个容器"说话。
# ⇒ 这里走 ②：**主人跑一次**，之后**服务一行特权都不需要**
#   （容器由租户**自己的** systemd 用户管理器看着，`Restart=on-failure`）。
#
# ── 这一步动的是**机器状态**，不是代码（所以单独一个脚本）──────
#   ① 卷：`/home/<租户>/tenant` —— 0700、属主是他自己
#   ② `linger`：没有它，租户的 rootless podman 在他没登录时会**整个消失**
#   ③ 镜像进**他自己那份** rootless 存储（每人一份，互不可见）
#
# ── 五条不许破 ────────────────────────────────────────────────
#   1. **幂等**：已经有的跳过并说明（跑两次不会出事）
#   2. **先打印再动手**：不给 `--yes` 就只打印
#   3. ⚠️ **不碰 `welkin`（uid 1000，别人的账号）与 `deploy`**
#   4. ⚠️ **不碰 docker 组**（P2.2 永久否决）
#   5. ⚠️ **`linger` 不是小事**：它让租户的进程**留在机器上**（权限席点名要单独看的面）。
#      这里开它是因为"容器必须一直在跑、等着领配置"这个形状**非要它不可**；
#      但它确实扩大了一点面 —— **如实写在这里，不藏**。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMG="${HUPO_TENANT_IMAGE:-localhost/hupo-tenant:local}"
USERS=(hupo-a hupo-b)
DO=0
[ "${1:-}" = "--yes" ] && DO=1

say()  { echo "  $1"; }
plan() { echo "▶ $1"; }

if [ "$DO" = "1" ] && [ "$(id -u)" != "0" ]; then
  echo "✗ --yes 要 root。请：sudo bash $0 --yes"; exit 2
fi

echo "── 租户池 ──────────────────────────────────────"
echo "  租户：${USERS[*]}"
echo "  镜像：$IMG"
echo "  ⚠️ 不碰：welkin(1000)、deploy(1001)、docker 组"
echo

# ── 🔴 一个要紧的坑：**`podman` 不许以 root 跑** ──────────────
# 镜像住在**造它的那个用户**（`deploy`）的 rootless 存储里
# （`/home/deploy/.local/share/containers`），**不在 root 的存储里**。
# 以 root 跑 `podman image exists` 会得到"没有这个镜像" —— 然后你会以为镜像丢了。
# ⇒ 这个脚本里**每一处 podman 都以它自己的属主身份跑**：
#    造镜像那个人（导出 tar）、以及每个租户（load 进他自己那份）。
OWNER_USER="${SUDO_USER:-deploy}"
# ⚠️ **`cd /tmp` 那一步不能省**（2026-09-21 实测踩了）：
#    `sudo -u` **保留当前工作目录**，而这个脚本体在 `deploy` 的目录里
#    ⇒ 换成租户身份之后 chdir 就 `Permission denied`
#    ⇒ podman 报的是 "cannot chdir to …" + "invalid internal status"，
#      看起来像"权限不对"，其实只是**站在一个他进不去的地方**。
#    同一个坑这个项目**已经记过一次**（`00-PROGRESS.md` 里那条 `sudo -u` 的教训）。
as_user() {  # as_user <user> <cmd...>（自动 cd /tmp 并给对 XDG_RUNTIME_DIR）
  local u="$1"; shift
  sudo -u "$u" -H sh -c 'cd /tmp && exec env XDG_RUNTIME_DIR="/run/user/$(id -u)" "$@"' sh "$@"
}
owner_run() { as_user "$OWNER_USER" "$@"; }
echo "  造镜像的人：$OWNER_USER（podman 一律以他/租户的身份跑，**不以 root**）"

TAR="/var/tmp/hupo-tenant-image.tar"

if [ "$DO" != "1" ]; then
  plan "检查 $OWNER_USER 的存储里有没有 $IMG，并导出 tar → $TAR"
else
  if ! owner_run podman image exists "$IMG"; then
    echo "✗ $OWNER_USER 的存储里没有 $IMG。先（以 $OWNER_USER 身份）：bash scripts/build-tenant-image.sh"; exit 2
  fi
  say "镜像在（$(owner_run podman images --format '{{.Size}}' "$IMG" | head -1)）"
  # ⚠️ **按"镜像 ID"比，不按"文件在不在"比**（2026-09-21 改）：
  #    镜像每次重建 ID 都变，而 tar 文件一直在 ⇒ 只看文件会**永远用旧的**，
  #    而且**看不出来**（现象是"镜像改了，容器里却没变"）。
  SRC_ID="$(owner_run podman image inspect "$IMG" --format '{{.Id}}' 2>/dev/null | head -1)"
  ID_FILE="$TAR.id"
  TAR_ID="$(cat "$ID_FILE" 2>/dev/null || echo '')"
  echo "  源镜像 ID：${SRC_ID:0:19}…"
  if [ "$SRC_ID" = "$TAR_ID" ] && [ -f "$TAR" ]; then
    say "tar 已是最新（$(du -h "$TAR" | cut -f1)）"
  else
    plan "导出镜像 tar → $TAR（这一下要一会儿）"
    # ⚠️ `podman save -o` **不许覆盖已存在的文件**
    #    （报错是 "docker-archive doesn't support modifying existing images"）
    #    ⇒ 先删。删了再导**不原子**，中途断了会留下半个 tar —— 所以下面用 `&&` 串住，
    #      失败了就直接退出，不让半成品留在那儿被当成"已经导好了"。
    rm -f "$TAR" "$TAR.id"
    owner_run podman save -o "$TAR" "$IMG" >/dev/null || { echo "✗ 导出失败"; exit 3; }
    chmod 0644 "$TAR"
    printf '%s\n' "$SRC_ID" > "$ID_FILE"
    say "导出好了：$(du -h "$TAR" | cut -f1)"
  fi
fi

for u in "${USERS[@]}"; do
  echo
  echo "── $u ────────────────────────────────────────"
  if ! id "$u" >/dev/null 2>&1; then
    echo "  ⚠️ 没有这个用户 —— 先跑 create-tenant-users.sh"; continue
  fi
  uid="$(id -u "$u")"
  home="$(getent passwd "$u" | cut -d: -f6)"
  vol="$home/tenant"
  say "uid=$uid home=$home"

  # ① 卷
  if [ -d "$vol" ]; then
    say "卷已有：$vol（$(stat -c '%a %U:%G' "$vol")）"
  else
    plan "建卷 $vol（0700 $u:$u）"
    [ "$DO" = "1" ] && install -d -o "$u" -g "$u" -m 0700 "$vol"
  fi

  # ② linger
  if [ -f "/var/lib/systemd/linger/$u" ]; then
    say "linger 已开"
  else
    plan "开 linger（让他没登录时 rootless podman 也在）"
    [ "$DO" = "1" ] && loginctl enable-linger "$u"
  fi

  # ③ 镜像进**他自己那份**存储
  #    ⚠️ rootless podman 要 `XDG_RUNTIME_DIR`，而 `sudo` 默认不给 ⇒ 显式传
  HIS_ID="$(as_user "$u" podman image inspect "$IMG" --format '{{.Id}}' 2>/dev/null | head -1)"
  if [ -n "$HIS_ID" ] && [ "$HIS_ID" = "$SRC_ID" ]; then
    say "他自己的存储里已是最新的镜像"
  else
    plan "以 $u 身份 podman load（每人一份，互不可见）${HIS_ID:+（他那份是旧的 ${HIS_ID:0:12}…）}"
    if [ "$DO" = "1" ]; then
      # ⚠️ **等他的 runtime 目录出现**：`linger` 刚开时 systemd 还没把这个用户
      #    的管理器拉起来 ⇒ `/run/user/<uid>` 不在 ⇒ rootless podman 会直接失败
      #    （而那个报错看起来像"权限不对"，其实只是**还没到**）。
      for _ in $(seq 1 30); do [ -d "/run/user/$uid" ] && break; sleep 0.5; done
      if [ ! -d "/run/user/$uid" ]; then
        echo "  ⚠️ /run/user/$uid 还没出现（linger 可能还没生效）—— 稍后再跑一次这个脚本"
        continue
      fi
      # ⚠️ **报错不许吞掉**（我第一版吞了 `2>&1` 到 /dev/null，结果只知道"失败"、
      #    不知道"为什么" —— 那是这个项目最忌的"看起来在跑"）
      if as_user "$u" podman load -i "$TAR" 2>&1 | tail -3; then
        say "load 好了"
      else
        echo "  ⚠️ load 失败 —— 上面那几行就是他自己的报错"
      fi
    fi
  fi
done

# ════════════════════════════════════════════════════════════
# ②-6b **用户单元 + 通道目录**：让容器真的跑起来，等着领配置
#
# ⚠️ **为什么容器要"一直跑着等"，而不是"来了新用户再起"**：
#    服务（`deploy`）**没有特权**，开不了别人的容器。两条路：给 `deploy` 一把常驻的
#    钥匙（polkit/sudoers），或者**事先起好、让它等着**。⇒ 走后者：
#    **服务一行特权都不需要**，容器由租户**自己的** systemd 用户管理器看着。
# ════════════════════════════════════════════════════════════
CHAN_DIR="/run/hupo-channel"
TMPFILES="/etc/tmpfiles.d/hupo-channel.conf"
echo
echo "── 通道目录（宿主侧）──────────────────────────"
# ⚠️ `/run` 是 root 的 ⇒ **deploy 建不了它**，而它每次重启都会没
#    ⇒ 交给 `tmpfiles.d`（开机自动重建），而不是靠"谁记得手动建"
if [ -f "$TMPFILES" ]; then
  say "tmpfiles 已有：$TMPFILES"
else
  plan "写 $TMPFILES（开机把 $CHAN_DIR 建出来，0755 属主 $OWNER_USER）"
  if [ "$DO" = "1" ]; then
    printf 'd %s 0755 %s %s -\n' "$CHAN_DIR" "$OWNER_USER" "$OWNER_USER" > "$TMPFILES"
    say "写好了"
  fi
fi
if [ -d "$CHAN_DIR" ]; then
  say "目录已在：$(stat -c '%a %U:%G' "$CHAN_DIR")"
else
  plan "现在就建一次 $CHAN_DIR"
  [ "$DO" = "1" ] && install -d -o "$OWNER_USER" -g "$OWNER_USER" -m 0755 "$CHAN_DIR"
fi

for u in "${USERS[@]}"; do
  echo
  echo "── $u 的容器单元 ──────────────────────────────"
  id "$u" >/dev/null 2>&1 || { echo "  ⚠️ 没这个用户，跳过"; continue; }
  uid="$(id -u "$u")"
  home="$(getent passwd "$u" | cut -d: -f6)"
  vol="$home/tenant"
  unit_dir="$home/.config/systemd/user"
  unit="$unit_dir/hupo-tenant.service"
  chan="$CHAN_DIR/$u/channel.sock"

  # 🔴 **不许"有了就跳过"**（2026-09-21 就是被这个坑住的）：
  #    模板改了之后，**已经落盘的那份不会跟着改** —— 而现象是
  #    "某一台容器的隧道一直连不上"，**单元自己不报错**（它只是在等一个不会出现的套接字）。
  #    ⇒ 改成**每次都按模板重写**（内容一样就是幂等；不一样就说明它该更新了），
  #      并且**重写之后重启那台**（不然跑着的还是旧的）。
  unit_changed=0
  if [ -f "$unit" ]; then
    say "单元已有：$unit（**按模板核对**）"
  else
    plan "写单元 $unit"
  fi
  if [ "$DO" = "1" ]; then
    if [ -f "$unit" ]; then cp -f "$unit" "$unit.bak"; fi
      install -d -o "$u" -g "$u" -m 0700 "$unit_dir"
      cat > "$unit" <<UNIT
[Unit]
Description=琥珀 · 租户容器（$u）
After=default.target

[Service]
Type=simple
# ⚠️ **等通道的套接字出现再起**：套接字不在时 podman 会把那个路径
#    **建成一个目录**，然后容器连它连不上，而报错看不出原因。
#    超时是防"宿主服务一直没起来"时在这里无限等（等不到就让 systemd 重试，
#    重试链上有 Restart=on-failure 顶着）。
ExecStartPre=/usr/bin/timeout 300 /bin/sh -c 'until [ -S $chan ]; do sleep 1; done'
# ⚠️ **`--replace` 不能省**（2026-09-21 实测）：systemd 重启时先把旧的 SIGTERM 掉，
#    而 `--rm` **不保证**把那个停下来的容器清掉 ⇒ 下一次 `podman run --name` 直接报
#    "the container name ... is already in use"（**退出码 125**），
#    现象是"容器起不来，但上一次的日志是好的"。
ExecStart=/usr/bin/podman run --replace --rm --name hupo-tenant-$u \
  --read-only --tmpfs /tmp --tmpfs /run/hupo:rw,nosuid,nodev,mode=0700 \
  -v $vol:/data \
  -v $(dirname $chan):/run/hupo-host \
  --security-opt=no-new-privileges \
  --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID --cap-add=FOWNER \
  --pids-limit=512 --memory=768m --memory-swap=768m \
  --env HUPO_CHANNEL=/run/hupo-host/channel.sock \
  --env HUPO_CHANNEL_WAIT_MS=60000 \
  $IMG
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
      chown "$u:$u" "$unit"
      chmod 0644 "$unit"
      if [ -f "$unit.bak" ] && ! cmp -s "$unit.bak" "$unit"; then
        unit_changed=1
        say "⚠️ 单元**变了**（旧模板）⇒ 要重启这一台"
      fi
      rm -f "$unit.bak"
      say "写好了"
  fi

  # 让**他自己的** systemd 认这个单元并启用（linger 已开 ⇒ 开机就会起）
  if [ "$DO" = "1" ]; then
    as_user "$u" systemctl --user daemon-reload >/dev/null 2>&1 || true
    if [ "$unit_changed" = "1" ]; then
      plan "重启这一台（让新的挂载生效）"
      as_user "$u" systemctl --user daemon-reload
      as_user "$u" podman rm -f "hupo-tenant-$u" >/dev/null 2>&1
      as_user "$u" systemctl --user restart --no-block hupo-tenant.service
    elif as_user "$u" systemctl --user is-enabled hupo-tenant.service >/dev/null 2>&1; then
      say "单元已启用"
    else
      # ⚠️ **不能 `--now`**（2026-09-21 实测）：`ExecStartPre` 在**等通道的套接字**，
      #    而套接字要等宿主服务起来才有 ⇒ `enable --now` 会**一直阻塞**（等满 300 秒）。
      #    ⇒ 只 `enable`（开机由他自己的 user manager 拉起来）+ `start --no-block`
      #      （现在就开始等着，套接字一出现就往下走）。
      plan "enable + start --no-block（它会等着通道的套接字）"
      as_user "$u" systemctl --user enable hupo-tenant.service >/dev/null 2>&1
      as_user "$u" systemctl --user start --no-block hupo-tenant.service 2>&1 | tail -2
    fi
  else
    plan "以 $u 身份 systemctl --user daemon-reload && enable --now"
  fi
done

echo
echo "── 下一步（②-4b）──────────────────────────────"
echo "  服务侧：worldFor(sub) → 认这台容器 + 把容器状态回给客户端"
echo
if [ "$DO" != "1" ]; then
  echo "（这是**只看**。真做：sudo bash $0 --yes）"
fi
