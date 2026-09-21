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
# ── 产品层那条只读挂载（2026-09-21 加 · `docs/dev/45-TENANT-UPDATE.md`）──
#   容器跑的那套东西（调度器 + 人格 + 能力 + 代理 patch）**不在镜像里**，
#   而是宿主上一个目录**只读**挂进去的（`/srv/hupo/tenant-code/current` → `/app/code`）。
#   ⇒ 改进产品 = 写文件 + 让容器重开一次，**不用重造镜像、不用 load、不用重建容器**。
#   ⚠️ **`/srv/hupo` 要 root 建一次**（`/srv` 是 root 的）——建它就在这个脚本里，
#      因为"把机器准备好给租户容器"是同一件事，分两处一定会漏一处。
#   ⚠️ **还没发布过产品层时，这条挂载不写进单元**：
#      `podman` 会把**不存在的挂载源建成一个空目录**（套接字那个坑的同族，
#      `43-AUTO-PROVISION.md` §8.1 记过）⇒ 之后 `current` 那个软链就别想再翻了。
#      那时那一台照旧用镜像里那份**兜底**（版本会自报 `dev`，宿主会如实说）。
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
# 产品层目录（`--env HUPO_CODE_ROOT` 可覆盖；测试用 `HUPO_CODE_ROOT`）
CODE_ROOT="${HUPO_CODE_ROOT:-/srv/hupo/tenant-code}"
# ── 要管哪几台 ──────────────────────────────────────────────
# ⚠️ 默认还是那两台（**已建好在跑的**，逐字不变）；`HUPO_TENANT_USERS` 是给
#    "自动开一台"那条路用的（root 侧助手一次只建一个）。
# ⚠️ **名单只有这一处**：自动那条路**不许**自己长出一套平行的建法 ——
#    它调的就是这个脚本（契约 `43-AUTO-PROVISION.md` §八）。
if [ -n "${HUPO_TENANT_USERS:-}" ]; then
  read -r -a USERS <<< "$(printf '%s' "$HUPO_TENANT_USERS" | tr ',' ' ')"
else
  USERS=(hupo-a hupo-b)
fi
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
# ⚠️ 三个来源，**优先级写在这里**：显式给的 > `sudo` 记住的那个人 > 默认 deploy。
#    `HUPO_OWNER_USER` 是给"自动开一台"那条路用的 —— 它由 **systemd** 拉起，
#    没有 `SUDO_USER`（那时候默认 deploy 也对，但**显式**比"碰巧对"好）。
OWNER_USER="${HUPO_OWNER_USER:-${SUDO_USER:-deploy}}"
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

# ── 产品层目录（**只有 root 建得了**：`/srv` 是 root 的）────────
#   ⚠️ 幂等：已经有了就只看一眼属主/权限（那一条也判，因为**属主错了就等于发布不了**）。
echo
echo "── 产品层目录 ─────────────────────────────────"
if [ -d "$CODE_ROOT" ]; then
  say "已有：$CODE_ROOT（$(stat -c '%a %U:%G' "$CODE_ROOT")）"
  [ "$(stat -c '%U' "$CODE_ROOT")" = "$OWNER_USER" ] \
    || echo "  ⚠️ 它不是 $OWNER_USER 的 ⇒ $OWNER_USER **发布不了**产品层（要 $OWNER_USER 才写得进去）"
else
  plan "建 $CODE_ROOT（0755 $OWNER_USER:$OWNER_USER）"
  [ "$DO" = "1" ] && install -d -o "$OWNER_USER" -g "$OWNER_USER" -m 0755 "$CODE_ROOT"
fi

# **当前是哪一版**（软链；没发布过就是空 —— 见文件头那条：那时不写挂载）
CODE_SRC=""
if [ -e "$CODE_ROOT/current" ]; then
  CODE_SRC="$(readlink -f "$CODE_ROOT/current" 2>/dev/null || true)"
  say "当前产品层：$CODE_SRC"
else
  echo "  ⚠️ 还没发布过产品层（$CODE_ROOT/current 不在）⇒ 容器先用镜像里那份兜底。"
  echo "     发布（以 $OWNER_USER 身份，不需要 root）："
  echo "       bash scripts/build-tenant-code.sh && bash scripts/build-tenant-code.sh --verify && bash scripts/build-tenant-code.sh --publish"
fi

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
  img_changed=0
  code_changed=0
  HIS_ID="$(as_user "$u" podman image inspect "$IMG" --format '{{.Id}}' 2>/dev/null | head -1)"
  if [ -n "$HIS_ID" ] && [ "$HIS_ID" = "$SRC_ID" ]; then
    say "他自己的存储里已是最新的镜像"
  else
    img_changed=1
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
  # ⚠️ **产品层那条挂载**：只有**真发布过**才写进单元（见文件头那条：
  #    挂载源不存在时 `podman` 会把它建成一个**空目录**，于是 `current` 那个软链
  #    以后就别想再翻了）。变量自带结尾那个 `\`，所以空的时候整行就"少一行"。
  CODE_MOUNT=""
  CODE_ENV=""
  if [ -n "$CODE_SRC" ]; then
    CODE_MOUNT="  -v $CODE_SRC:/app/code:ro \\
"
    CODE_ENV="  --env HUPO_CODE_DIR=/app/code \\
"
  fi

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
# ⚠️ **`/tmp` 的 `mode=1777` 不能省**（2026-09-21 真机抓到的）：
#    不写它的时候盒里 `/tmp` 是 `775 root` ⇒ **uid 1000（agent）写不进去**
#    ⇒ dsh 起手就报 `EACCES: permission denied, mkdtemp '/tmp/dsh-spill-XXXXXX'`
#    （它要一个临时目录来放"溢出到磁盘"的东西）。
#    现象同样极难查：界面上只是"它不理我"。
# ⚠️ **`--replace` 不能省**（2026-09-21 实测）：systemd 重启时先把旧的 SIGTERM 掉，
#    而 `--rm` **不保证**把那个停下来的容器清掉 ⇒ 下一次 `podman run --name` 直接报
#    "the container name ... is already in use"（**退出码 125**），
#    现象是"容器起不来，但上一次的日志是好的"。
ExecStart=/usr/bin/podman run --replace --rm --name hupo-tenant-$u \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --tmpfs /run/hupo:rw,nosuid,nodev,mode=0700 \
  -v $vol:/data \
$CODE_MOUNT  -v $(dirname $chan):/run/hupo-host \
$CODE_ENV  --security-opt=no-new-privileges \
  --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID --cap-add=FOWNER \
  --pids-limit=512 --memory=768m --memory-swap=768m \
  --env HUPO_CHANNEL=/run/hupo-host/channel.sock \
  --env HUPO_CHANNEL_WAIT_MS=60000 \
  $IMG
# ⚠️ **`always`，不是 `on-failure`**（2026-09-21 改 · `45-TENANT-UPDATE.md` §三）：
#    重开去拿新的一版是**自己 `exit(0)`**（那是成功退出）——`on-failure` 会让它
#    **停在那儿再也不起来**。而 `stop` 是显式的，systemd 不会因为 `always` 就又拉起它。
Restart=always
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

  # ⚠️ **第三种形态**（2026-09-21 第三次被这个坑住）：
  #    `podman load` 说"已是最新"（存储里确实是最新的），而**跑着的那台还是 load 之前那个镜像的**
  #    —— 容器是**创建那一刻的快照**，换掉存储里的镜像**不影响已经在跑的它**。
  #    现象：改了容器里的代码、行为一点没变，而日志说"已是最新"。
  #    ⇒ 判据只能是"**跑着的那个用的是哪个镜像 ID**"，跟"存储里最新的是哪个"是两件事。
  RUN_ID="$(as_user "$u" podman inspect "hupo-tenant-$u" --format '{{.Image}}' 2>/dev/null | head -1)"
  if [ -n "$RUN_ID" ] && [ -n "$SRC_ID" ] && [ "$RUN_ID" != "$SRC_ID" ]; then
    img_changed=1
    say "⚠️ 跑着的那台用的是**旧镜像**（${RUN_ID:0:19}…）⇒ 要重启"
  fi

  # ⚠️ **同一个坑的第三种形态**（2026-09-21 · `45-TENANT-UPDATE.md`）：产品层也一样 ——
  #    翻 `current` **不影响已经在跑的那台**（挂载源是**创建那一刻**定下来的）。
  #    ⇒ 判据只能是"**它挂的是哪一份**"，跟"当前是哪一份"是两件事。
  #    ⚠️ 宿主那边也会**自己发现**这件事（容器自报版本 ⇒ 不一致就叫它重开），
  #      所以这一条不是唯一的防线 —— 但它是"跑完这个脚本就一定是新的"那一条。
  RUN_CODE="$(as_user "$u" podman inspect "hupo-tenant-$u" \
    --format '{{range .Mounts}}{{if eq .Destination "/app/code"}}{{.Source}}{{end}}{{end}}' 2>/dev/null | head -1)"
  if [ -n "$CODE_SRC" ]; then
    if [ "$RUN_CODE" != "$CODE_SRC" ]; then
      code_changed=1
      say "⚠️ 跑着的那台挂的是**另一版产品层**（${RUN_CODE:-没挂} ⇒ 当前 $CODE_SRC）⇒ 要重启"
    fi
  elif [ -n "$RUN_CODE" ]; then
    say "· 它挂着产品层（$RUN_CODE），但宿主这边现在读不到 current —— **不动它**"
  fi

  # 让**他自己的** systemd 认这个单元并启用（linger 已开 ⇒ 开机就会起）
  if [ "$DO" = "1" ]; then
    as_user "$u" systemctl --user daemon-reload >/dev/null 2>&1 || true
    if [ "$unit_changed" = "1" ] || [ "$img_changed" = "1" ] || [ "$code_changed" = "1" ]; then
      # ⚠️ **镜像换了也要重启**（2026-09-21 第二次被这个坑住）：
      #    `podman load` 只是把新镜像放进他的存储，**跑着的那个还是旧的**
      #    （现象：改了容器里的代码，行为一点没变 —— 而日志说"load 好了"）。
      WHY_RESTART="$([ "$img_changed" = 1 ] && echo 镜像换了 || echo 单元变了)"
      [ "$code_changed" = 1 ] && WHY_RESTART="$([ "$img_changed" = 1 ] && echo '镜像换了 + 产品层换了' || echo 产品层换了)"
      plan "重启这一台（$WHY_RESTART）"
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
