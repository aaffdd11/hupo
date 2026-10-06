#!/usr/bin/env bash
# **服务端全闸**（`npm test`）＋ **留戳**：同一棵树刚跑过就不重复跑。
#
# 用法：
#   scripts/gate-server.sh            # 跑（同一棵树刚跑过 ⇒ 直接跳过，退出 0）
#   scripts/gate-server.sh --again    # 不管戳，真跑一遍
#
# 🔴 为什么是这一条命令而不是直接 `npm test`（读数 `docs/dev/212` · 契约 `docs/dev/213`）：
#   最贵的那一轮里同一道全闸被跑了两遍（还并行）⇒ 工具时间的 **1,454 秒**没了。
#   `npm test` 本身没法拦（谁都能直接敲），所以**收尾这一条**走这个脚本：
#   它先在 `scripts/gate-stamp.sh` 里问一句"这一版刚跑过吗"，跑完再留戳。
#   ⚠️ **判据一个字没变**（还是 `npm test`）：变的只是"什么时候真的再跑一遍"。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
AGAIN=0
[ "${1:-}" = "--again" ] && AGAIN=1

if [ "$AGAIN" = "0" ]; then
  if bash "$ROOT/scripts/gate-stamp.sh" check server; then exit 0; fi
fi

echo "▶ 服务端全闸（npm test）"
if ( cd "$CORE" && npm test ); then
  bash "$ROOT/scripts/gate-stamp.sh" write server "✅ 服务端 npm test 全过"
  exit 0
fi
echo "✗ **服务端全闸没过**" >&2
exit 1
