#!/usr/bin/env bash
# **线上那份客户端产物，是不是仓库这一版构建的**（"落后于仓库"那条闸的客户端版）。
#
# 为什么要它：2026-09-24 那条"租户产品层落后于仓库"的闸救了一次 —— 客户端**同族**的漂更长见：
#   改了 `lib/**` 却没部署 ⇒ 线上还是旧那一版，而**页面照常打开**，
#   只是**少了个刚做好的东西**（或者还留着一句已经不真的话）。没有任何东西会喊。
#
# 判法：把**现在工作树**的客户端源码指纹，与**上次部署时记下的**那个比。
#   · 一致   ⇒ 线上就是仓库这一版
#   · 不一致 ⇒ **线上落后**（跑 `bash scripts/deploy-web-v2.sh`）
#   · 没标记 ⇒ **不知道**（不是"一致"！）—— 那是"这道闸还没有基准"，退出码 3
#
# 退出码：0 = 一致 · 1 = 落后（漂了）· 3 = 不知道（没有标记 / 读不出）
#
# ⚠️ **写这个文件时踩的坑，留着当教训**：
#   ① 内层 `<<EOF` 与外层写文件那个 heredoc 的**分隔符撞车** ⇒ 整段被掐断、
#      脚本末尾没了、而且**假绿退出 0**（最坏的那种）。⇒ 这里**一个 heredoc 都不用**。
#   ② 判据自己必须能红 ⇒ 三条路（没标记 / 不匹配 / 对得上）**每条都单独验过**。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$ROOT/v2/services/core/data/deploy-stamp.json"

now="$(bash "$ROOT/scripts/client-source-fingerprint.sh" 2>/dev/null || echo '')"
if [ -z "$now" ]; then echo "✗ 算不出源码指纹（不在仓库里？）"; exit 3; fi

echo "▶ 线上客户端 ⇄ 仓库"

if [ ! -f "$STAMP" ]; then
  echo "  ⚠️ **不知道**：还没有部署标记（$STAMP 不在）"
  echo "     ⇒ 那说明上一版**不是**这份脚本部署的（或者标记被删了）—— **不是「一致」**"
  echo "     ⇒ 部署一次就会有基准：bash scripts/deploy-web-v2.sh"
  exit 3
fi

line="$(sed -n 's/.*"clientSrcFp":"\([^"]*\)".*"buildId":"\([^"]*\)".*"commit":"\([^"]*\)".*/\1 \2 \3/p' "$STAMP" | head -1)"
if [ -z "$line" ]; then
  echo "  ⚠️ **不知道**：标记文件在，但读不出内容（$STAMP）—— **不是「一致」**"
  exit 3
fi
was="${line%% *}"
rest="${line#* }"
bid="${rest%% *}"
commit="${rest#* }"

echo "  线上：源码 $was · 构建指纹 $bid · 提交 ${commit:-（没记）}"
echo "  仓库：源码 $now"
if [ "$was" = "$now" ]; then
  echo "  ✓ 一致（线上就是仓库这一版）"
  exit 0
fi
echo "  ✗ **落后了** —— 客户端源码变了，但那一版还没部署"
echo "     ⇒ 跑：bash scripts/deploy-web-v2.sh（它会先跑两道硬闸，再部署）"
echo "     ⚠️ 在部署之前，线上页面**还是旧那一版**（少一个刚做好的东西，或者还留着一句不真的话）"
exit 1
