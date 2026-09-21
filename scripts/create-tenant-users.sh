#!/usr/bin/env bash
# 建"租户用户"（手册 `02-ARCHITECTURE.md` §二「一人一容器」· 契约 `docs/dev/37-MULTITENANT.md` §四）。
#
# 用法：
#   bash scripts/create-tenant-users.sh              # **只看**：把要做的每一件事打印出来，什么都不动
#   sudo bash scripts/create-tenant-users.sh --yes   # 真做（P2：**主人跑**，助手只写）
#
# ── 为什么是"一人一个 OS 用户" ────────────────────────────────
# 实测：同一个 OS 用户（`deploy`）起的两个容器，**互相进得去**（`podman exec` 实测成功），
# 而且读得到对方的 `/proc/<pid>/environ`（实测 56 条）。
# ⇒ 只在"一个 `deploy`"底下做容器，**甲读得到乙的 API key** —— 而那是**用户自己的钱**。
# ⇒ 边界必须落在 **uid** 上：每租户一个 OS 用户 + 一段独占 subuid + 一个 0700 卷，
#   容器里的 root **只映射到他自己那个 uid**。
#
# ── 五条不许破 ────────────────────────────────────────────────
#   1. **幂等**：已经有的用户/目录/subuid 条目，跳过并说明（跑两次不会出事）
#   2. **先打印再动手**：不给 `--yes` 就只打印
#   3. ⚠️ **不碰 `welkin`（uid 1000，别人的账号）**：脚本只认下面 USERS 里列的名字
#   4. ⚠️ **不碰 docker 组**（P2.2 永久否决；`test/reverse-drift.test.js` 有硬闸盯着 `usermod`）
#   5. 每个用户的卷 **0700、属主是他自己** —— 别人（含 `deploy`）读不到
set -uo pipefail

# 租户名单（要加人，改这一行；前缀固定 `hupo-`）
USERS=(hupo-a hupo-b)
FIRST_UID=2001
SUBID_COUNT=65536

DO=0
[ "${1:-}" = "--yes" ] && DO=1

say()  { echo "  $1"; }
plan() { echo "▶ $1"; }

if [ "$DO" = "1" ] && [ "$(id -u)" != "0" ]; then
  echo "✗ --yes 要 root。请：sudo bash $0 --yes"; exit 2
fi

echo "── 租户用户清单 ────────────────────────────────"
echo "  要建：${USERS[*]}"
echo "  ⚠️ 不碰：welkin(1000)、deploy(1001)、docker 组"
echo "  模式：$([ "$DO" = "1" ] && echo '**真做**' || echo '只看（想真做加 --yes）')"
echo

uid_of() { id -u "$1" 2>/dev/null; }

i=0
for u in "${USERS[@]}"; do
  want=$((FIRST_UID + i)); i=$((i + 1))
  home="/home/$u"
  plan "用户 $u（uid $want）"

  have="$(uid_of "$u")"
  if [ -n "$have" ]; then
    say "已有（uid $have）—— 跳过建用户"
    [ "$have" = "$want" ] || say "⚠️ uid 不是预期的 $want（继续，但记着这件事）"
  elif [ "$DO" = "1" ]; then
    # ⚠️ 不用 `useradd -m` 的默认 home 权限：下面显式 chmod 700
    useradd --uid "$want" --create-home --shell /bin/bash "$u" && say "建好了" || say "✗ 建失败"
  else
    say "会做：useradd --uid $want --create-home --shell /bin/bash $u"
  fi

  # subuid / subgid：容器里 uid 0 要靠它映射成"他自己"
  for f in /etc/subuid /etc/subgid; do
    if grep -q "^$u:" "$f" 2>/dev/null; then
      say "已有 subid 条目（$f）：$(grep "^$u:" "$f")"
    elif [ "$DO" = "1" ]; then
      # 起点按 uid 之后错开，避免和别人（welkin 100000 / deploy 165536）撞
      start=$((want * 100000))
      echo "$u:$start:$SUBID_COUNT" >> "$f" && say "写进 $f：$u:$start:$SUBID_COUNT"
    else
      say "会做：往 $f 追加 $u:$((want * 100000)):$SUBID_COUNT"
    fi
  done

  # 卷：他自己 0700 —— 这是"别人读不到"的那一条
  if [ -d "$home/tenant" ]; then
    say "卷已在：$home/tenant（$(stat -c '%U:%G %a' "$home/tenant")）"
  elif [ "$DO" = "1" ]; then
    mkdir -p "$home/tenant" "$home/.dsh"
    chown -R "$u:$u" "$home/tenant" "$home/.dsh"
    chmod 700 "$home" "$home/tenant" "$home/.dsh"
    say "建好卷：$home/tenant（$u:$u 700）· $home/.dsh（$u:$u 700）"
  else
    say "会做：mkdir -p $home/tenant $home/.dsh && chown $u:$u 之 && chmod 700 home/tenant/.dsh"
  fi
  echo
done

echo "── 建完之后怎么验（**两条都要，缺一条就没意义**）──────────"
cat <<'EOF'
  # 正：甲能在自己那台里干活
  sudo -u hupo-a podman run --rm -v /home/hupo-a/tenant:/data localhost/hupo-base:local \
       /bin/sh -c 'echo A > /data/a.secret && cat /data/a.secret'
  # 反：乙读甲那份 **必须是 Permission denied**
  sudo -u hupo-b cat /home/hupo-a/tenant/a.secret
  # （⚠️ "No such file" 不算 —— 那只说明路径写错了）
  # 反（容器里）：乙的容器挂甲那份，必须非 0 退出
  sudo -u hupo-b podman run --rm -v /home/hupo-a/tenant:/data localhost/hupo-base:local cat /data/a.secret
EOF
echo
echo "⚠️ 这一步只是**把边界的地基打好**；容器怎么起、key 怎么进去，见 docs/dev/37-MULTITENANT.md。"
