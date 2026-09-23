#!/usr/bin/env bash
# **容量算式只有这一处**（欠账 #35 · 2026-09-23）。
#
# ── 为什么要有这个文件 ────────────────────────────────────────
# "最多开多少台"这件事原来有**两处口径**：
#   · 模板里那个 `max_tenants`：**人写的常数**（模板注释还自称"按磁盘算"，其实不是）；
#   · 装机脚本里那句"磁盘放得下 N 台"：脚本里**现算的除法**。
# 两处数字 = 一定会漂（这个项目的纪律：`AGENTS.md` §四）。
# ⇒ 装机脚本与 `set-tenant-limit.sh` **都调这里**，改口径只改这一个文件。
#
# ── 两个数不是一回事（写清楚，免得下次又各算各的）────────────
#   · `capacity_fits`  = 可用字节 / 每台镜像字节 —— **物理上限**（原样除）。
#     它就是装机时报给你的那个"放得下 N 台"。
#   · `capacity_limit` = 物理上限扣掉**余量** —— **策略上限**（写进模板的那个）。
#     ⚠️ 为什么要留余量：每台不只是一份镜像，还有**一个卷 + 日志 + 容器可写层**，
#        它们都会长。把盘填满之后坏掉的不是"新租户开不出来"，
#        而是**已经在跑的那些**（这个项目里"最贵的事故"都是这一类）。
#
# ⚠️ 本文件**只做算术**、不碰磁盘也不碰 podman —— 拿假数字进来也能算（判据要用）。

# 可用字节（`df` 那一列）。取不到 ⇒ 打空行（调用方据此说"算不出"，**不许猜**）。
capacity_avail_bytes() {
  df -B1 --output=avail "$1" 2>/dev/null | tail -1 | tr -d ' '
}

# 余量（百分比）。住代码里可调，**不写进文档**（手册纪律 1）。
capacity_reserve_pct() {
  echo "${HUPO_CAPACITY_RESERVE_PCT:-20}"
}

# 物理上限：`ceil` 不取，**整除**（半台不算一台）。
capacity_fits() {
  local avail="$1" image="$2"
  case "$avail" in '' | *[!0-9]*) return 1 ;; esac
  case "$image" in '' | *[!0-9]*) return 1 ;; esac
  [ "$image" -gt 0 ] || return 1
  echo $((avail / image))
}

# 策略上限（写进模板的值）。
capacity_limit() {
  local fits
  fits="$(capacity_fits "$1" "$2")" || return 1
  local keep
  keep="$(capacity_reserve_pct)"
  case "$keep" in '' | *[!0-9]*) return 1 ;; esac
  [ "$keep" -lt 100 ] || return 1
  echo $((fits * (100 - keep) / 100))
}
