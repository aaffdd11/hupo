#!/usr/bin/env bash
# **租户那台跑的是不是仓库现在这一份**（一条命令，不要 podman、不碰任何容器）。
#
# 用法：scripts/check-tenant-code-drift.sh
#
# ── 它为什么存在（2026-09-29 真栽过一次）────────────────────
#   盒子里的用户**建 app 失败**（桌面那颗加号）：主人报"用户创建app失败"。
#   根因：发布出去的那一版产品层（`/srv/hupo/tenant-code/current`）是
#   **2026-09-27 01:08** 的，比"桌面加号建小程序"那一刀（`43279b2`）还早 ——
#   ⇒ 盒子那份代码里**少一条内部口** `/internal/app-register`
#   ⇒ 宿主把"建 app"转给盒子，盒子回 404 `{error:'not-found'}`
#   ⇒ 用户看到 **503「你那台刚才没应，等会儿再试。」**（而宿主这一份是好的）。
#
#   ⚠️ 这个比较**本来就有**（`scripts/check-tenant-update.sh` 判据九·补），
#      但它跟一大堆 podman 检查绑在一起 ⇒ **不常跑**。
#      这一份就是把它**单独拎出来**：收尾时跑一条，几秒钟。
#
# 退出码：0 同版 · 1 落后（要 build/verify/publish）· 2 环境不具备

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/scripts/build-tenant-code.sh"

[ -x "$BUILD" ] || { echo "✗ 找不到 $BUILD"; exit 2; }

REPO_FP="$(bash "$BUILD" --fingerprint 2>/dev/null | tail -1)"
PUB_FP="$(bash "$BUILD" --current 2>/dev/null | tail -1)"

if [ -z "$REPO_FP" ]; then
  echo "✗ 算不出仓库现在这一版的指纹（产品层构建那一步坏了？）"
  exit 2
fi

if [ "$REPO_FP" = "$PUB_FP" ]; then
  echo "✅ 租户跑的就是仓库现在这一份（产品层 $PUB_FP）"
  exit 0
fi

echo "🔴 产品层**落后于仓库** —— 租户跑着旧代码，而两边都以为没事："
echo "   发布的是：${PUB_FP:-（还没发布过）}"
echo "   仓库现在：$REPO_FP"
echo
echo "  照这三步（顺序别换）："
echo "    bash scripts/build-tenant-code.sh"
echo "    bash scripts/build-tenant-code.sh --verify $REPO_FP"
echo "    bash scripts/build-tenant-code.sh --publish $REPO_FP"
# ⚠️ 这一段**不许用反引号**（2026-09-29 实测踩到）：它在**双引号里**会被 bash 当成
#   **命令替换** ⇒ 屏幕上多出一行 `--verify: command not found`，而**判据本身是对的**
#   （退出码仍是 1）—— 那种"工具在说胡话"的样子最容易让人怀疑读数。
echo '  （--verify 要 podman；发布本身不改任何运行中的容器 —— 它们会自己在空闲时重开）'
exit 1
