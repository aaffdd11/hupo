#!/usr/bin/env bash
# 干净地重启 v2 调度器（本机 127.0.0.1:8020）。
#
# 用法：
#   scripts/restart-core.sh               # 重启，**日志留着**（跨重启接记忆靠它）
#   scripts/restart-core.sh --fresh       # 重启并清空日志（从"我们刚认识"开始）
#   HUPO_BUILD_ID=xxx scripts/restart-core.sh
#
# ── 两条纪律，都是踩出来的 ────────────────────────────────────
#
# ⚠️ **不许用 `pkill -f` / `pgrep -f`。** 它们的 `-f` 匹配整条命令行，
#    而运行这条命令的 shell 自己命令行里就带着那个模式 ⇒ **把自己杀掉**。
#    这个坑在本项目里踩过两次。这里按 **PID 文件**走，不按模式。
#
# ⚠️ **不许"看到 dsh 就杀"。** 这台机器是主人的桌面，上面跑着主人自己的
#    别的 dsh 会话（几百个）。杀错了是**毁别人的活**。
#    我们的 agent 是**本服务的子进程**；优雅地 SIGTERM 服务本身，
#    `serve.js` 会 `dispatcher.shutdown()` → `runtime.shutdown()` 把子进程带走。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../v2/services/core" && pwd)"
cd "$DIR" || exit 1

FRESH=0
[ "${1:-}" = "--fresh" ] && FRESH=1

# ── 1) 停 ────────────────────────────────────────────────────
if [ -f serve.pid ]; then
  OLD="$(cat serve.pid)"
  if kill -0 "$OLD" 2>/dev/null; then
    echo "▶ 停掉旧服务（PID $OLD）——走优雅退出，让它把子 agent 一起带走"
    kill -TERM "$OLD" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$OLD" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$OLD" 2>/dev/null; then
      echo "  ⚠️ 它没在 10 秒内退出，硬杀"
      kill -KILL "$OLD" 2>/dev/null
    fi
  else
    echo "▶ serve.pid 里的进程（$OLD）已经不在跑了"
  fi
  rm -f serve.pid
else
  echo "▶ 没有 serve.pid（第一次起？）"
fi

# ── 2) 清 ────────────────────────────────────────────────────
if [ "$FRESH" = "1" ]; then
  # ⚠️ 这一步会**永久删掉**所有说过的话。所以它必须显式要，不能是默认。
  echo "▶ --fresh：删掉 data/main.jsonl（**说过的话会没**）"
  rm -f data/main.jsonl
fi

# ── 3) 起 ────────────────────────────────────────────────────
BUILD="${HUPO_BUILD_ID:-dev}"
PORT="${HUPO_PORT:-8020}"
echo "▶ 起新服务：端口 $PORT，构建指纹 $BUILD"
setsid nohup env \
  HUPO_DATA="$DIR/data" \
  HUPO_PORT="$PORT" \
  HUPO_WEB="$DIR/web" \
  HUPO_BUILD_ID="$BUILD" \
  node src/serve.js > serve.log 2>&1 < /dev/null &
echo $! > serve.pid
sleep 3

# ── 4) 报状态（**报告它现在是什么样，不喊口号**）────────────
if ! kill -0 "$(cat serve.pid)" 2>/dev/null; then
  echo "✗ 没起来。serve.log 末尾："
  tail -20 serve.log
  exit 1
fi
echo "✓ 起来了（PID $(cat serve.pid)）"
grep -E "监听|鉴权|接记忆|界面|构建|时间线" serve.log || tail -20 serve.log
