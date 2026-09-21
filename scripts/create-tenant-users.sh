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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 租户模板：**唯一权威**（契约 `docs/dev/43-AUTO-PROVISION.md` §三 A2）────
# ⚠️ 服务侧（JS 的 `tenants.js`）读的是**同一个文件**。两边各写一份常数就一定会漂，
#    而"漂"的表现是"容器起来了、服务却在听另一个通道"（看起来像容器没起来）。
# ⚠️ 路径**可注入**：装到系统里之后，特权侧读的是 **root 自己那一份拷贝**
#    （`/etc/hupo/tenant-template.conf`）—— 读仓库里那份的话，
#    服务（= 仓库属主）能改它 ⇒ 那等于把边界画在一个可写的地方（契约 §三 A9）。
TEMPLATE="${HUPO_TENANT_TEMPLATE:-$ROOT/v2/services/core/tenant-template.conf}"
tpl_get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$TEMPLATE" | head -1; }
NAME_PREFIX="$(tpl_get name_prefix)"
UID_BASE="$(tpl_get uid_base)"
MAX_TENANTS="$(tpl_get max_tenants)"
for pair in "name_prefix=$NAME_PREFIX" "uid_base=$UID_BASE" "max_tenants=$MAX_TENANTS"; do
  [ -n "${pair#*=}" ] || { echo "✗ 租户模板读不出 ${pair%%=*}（$TEMPLATE）"; exit 2; }
done

# ── 要处理哪几个租户 ────────────────────────────────────────
# ⚠️ 默认还是那两台（**这台机器上已经建好的**，名字带字母、uid 是当年手工给的）；
#    `HUPO_TENANT_USERS` 是给"自动开一台"那条路用的（root 侧助手一次只建一个）。
#    ⇒ 名单**不再是写死的两行**，但默认值逐字不变（幂等、跑两次不会出事）。
if [ -n "${HUPO_TENANT_USERS:-}" ]; then
  read -r -a USERS <<< "$(printf '%s' "$HUPO_TENANT_USERS" | tr ',' ' ')"
else
  USERS=(hupo-a hupo-b)
fi
SUBID_COUNT=65536

# 名字 → uid。**只有两处来源**：最早那两台的手工表，和模板推出来的公式。
# ⚠️ 服务侧算的是同一个数（`tenantUidFor`）；`test/provision.test.js` 钉着模板那一半。
uid_for_name() {
  case "$1" in
    hupo-a) printf '%s' 2001 ;;   # ⚠️ 这两台是**手工建的**，uid 不在公式上 ⇒ 明写成表
    hupo-b) printf '%s' 2002 ;;
    "$NAME_PREFIX"*)
      local n="${1#"$NAME_PREFIX"}"
      [[ "$n" =~ ^[1-9][0-9]{0,2}$ ]] || return 1
      [ "$n" -le "$MAX_TENANTS" ] || return 1
      printf '%s' "$((UID_BASE + n))" ;;
    *) return 1 ;;
  esac
}

DO=0
[ "${1:-}" = "--yes" ] && DO=1

say()  { echo "  $1"; }
plan() { echo "▶ $1"; }

if [ "$DO" = "1" ] && [ "$(id -u)" != "0" ]; then
  echo "✗ --yes 要 root。请：sudo bash $0 --yes"; exit 2
fi

echo "── 租户用户清单 ────────────────────────────────"
echo "  要建：${USERS[*]}"
echo "  模板：$TEMPLATE（前缀 $NAME_PREFIX · uid 起点 $UID_BASE · 上限 $MAX_TENANTS）"
echo "  ⚠️ 不碰：welkin(1000)、deploy(1001)、docker 组"
echo "  模式：$([ "$DO" = "1" ] && echo '**真做**' || echo '只看（想真做加 --yes）')"
echo

uid_of() { id -u "$1" 2>/dev/null; }

for u in "${USERS[@]}"; do
  home="/home/$u"
  # 🔴 **认不出的名字一律不建**（不是"猜一个 uid"）：这条同时是 A2 的落点 ——
  #    特权侧的名字必须能从模板推出来，推不出来就说明有人在绕这条路。
  if ! want="$(uid_for_name "$u")"; then
    echo "✗ 不认识这个租户名：$u（只认 hupo-a / hupo-b / ${NAME_PREFIX}<1..${MAX_TENANTS}>）"
    exit 3
  fi
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
  ⚠️ 三条**踩过的**前提，别省：
    ① cd /tmp —— `sudo -u` **保留当前目录**，而租户读不到仓库目录 ⇒ 不换目录会报
       `cannot chdir to …: Permission denied` 然后 `Error: setting up the process`（实测踩过）
    ② `-H` —— 不写它 HOME 可能还是 /root，podman 会去错的存储目录
    ③ 镜像**不共享**：无根镜像在各家自己的存储里，得**各自 load 一次**
       （deploy 侧先 `podman save -o /tmp/hupo-base.tar localhost/hupo-base:local`）

  cd /tmp
  for u in hupo-a hupo-b; do sudo -u $u -H podman load -i /tmp/hupo-base.tar; done

  # ① 正对照：甲在自己那台里能写能读（**不能省** —— 没有它，后面"读不到"可能只是没跑起来）
  sudo -u hupo-a -H podman run --rm -v /home/hupo-a/tenant:/data localhost/hupo-base:local \
       /bin/sh -c 'echo sk-甲的 > /data/key.txt && cat /data/key.txt'

  # ② 乙在宿主上读甲那份 ⇒ 必须 **Permission denied**（⚠️ "No such file" 不算）
  sudo -u hupo-b cat /home/hupo-a/tenant/key.txt

  # ③ 乙的**容器**去挂甲那份 ⇒ podman 退出码必须是 **125**（不是 0）
  sudo -u hupo-b -H podman run --rm -v /home/hupo-a/tenant:/data localhost/hupo-base:local cat /data/key.txt; echo "rc=$?"

  # ④ 对照：乙读**自己**那份必须成功（rc=0）—— 否则 ②③ 的失败说明不了什么
  sudo -u hupo-b -H podman run --rm -v /home/hupo-b/tenant:/data localhost/hupo-base:local \
       /bin/sh -c 'echo sk-乙的 > /data/key.txt && cat /data/key.txt'

  # ⑤ 最关键的一条：**调度器那个身份（deploy）**读得到甲的吗 ⇒ 必须读不到
  cat /home/hupo-a/tenant/key.txt

  # ⑥ 资源上限的前提（实测发现）：新用户**没有 systemd 用户会话** ⇒ podman 回落 cgroupfs。
  #    §10.3 那些 MemoryMax 要用得上，得给每个租户开 linger：
  #      sudo loginctl enable-linger hupo-a
EOF
echo
echo "⚠️ 这一步只是**把边界的地基打好**；容器怎么起、key 怎么进去，见 docs/dev/37-MULTITENANT.md。"
echo "⚠️ 2026-09-21 实测结果（这套命令全跑过）：①②③④⑤ 全部如期 —— 其中 ⑤"
echo "   （连 deploy 都读不到租户的 key）是「key 不经过调度器」在文件系统这一层的落点。"
