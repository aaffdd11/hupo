#!/usr/bin/env bash
# 干净地重启 v2 调度器（本机 127.0.0.1:8020）。
#
# 用法：
#   scripts/restart-core.sh               # 重启，**日志留着**（跨重启接记忆靠它）
#   scripts/restart-core.sh --fresh       # 重启并清空日志（从"我们刚认识"开始）
#   scripts/restart-core.sh --now         # 不等它说完，立刻重启（**会切掉正在说的那一轮**）
#   HUPO_BUILD_ID=xxx scripts/restart-core.sh
#
# ★ **默认等它把手上的话说完**（手册 `06-OPERATIONS.md` §8.3）：
#   直接重启会把正在说话的那一轮连同回答一起杀掉，用户看到话说一半没了。
#   服务每秒把"手上还有没有没说完的话"写进 `data/status.json`（`src/turn-status.js`），
#   这里就等那个文件变成"不忙"再动手。
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
NOW=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --now) NOW=1 ;;
    -h|--help)
      # ⚠️ 不用 `sed "$0"`：这时已经 `cd` 进服务目录了，`$0` 是相对路径、读不到。
      cat <<'USAGE'
用法：
  scripts/restart-core.sh           重启，**日志留着**（跨重启接记忆靠它）
  scripts/restart-core.sh --fresh   重启并清空日志（从"我们刚认识"开始）
  scripts/restart-core.sh --now     不等它说完，立刻重启（**会切掉正在说的那一轮**）
  HUPO_BUILD_ID=xxx scripts/restart-core.sh

默认会先等它把手上的话说完（服务每秒钟把这件事写进 data/status.json）。
等太久（上限见脚本里的 MAX_WAIT_SEC）就照样重启，并把这件事说出来。
USAGE
      exit 0
      ;;
    *) echo "✗ 不认识的选项：$arg" >&2; exit 2 ;;
  esac
done

# 等它说完的两个量：**轮询间隔**与**最长等多久**。
# ⚠️ 为什么有上限：**等一个已经死掉的服务 = 重启脚本永远卡住**，那比切一轮话更坏。
#    上限到了就照常重启，并把这件事**说出来**。
POLL_SEC=2
MAX_WAIT_SEC=180

# ── 0.5) **先等它把手上的话说完**（默认；`--now` 跳过）────────
STATUS="$DIR/data/status.json"
if [ "$NOW" = "1" ]; then
  echo "▶ --now：不等了（**正在说的那一轮会被切掉**）"
elif [ ! -f "$STATUS" ]; then
  echo "▶ 没有 $STATUS（服务没在写状态？）——不等，直接重启"
else
  waited=0
  while [ "$waited" -lt "$MAX_WAIT_SEC" ]; do
    grep -q '"busy"[[:space:]]*:[[:space:]]*true' "$STATUS" 2>/dev/null || break
    # ⚠️ 还要看这行状态是不是**陈的**：服务已经死了的话没人再更新它，
    #    拿一句旧话永远等下去 = 脚本卡死。
    UPD="$(sed -n 's/.*"updatedAt"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$STATUS" 2>/dev/null | head -1)"
    NOWMS="$(date +%s%3N)"
    if [ -n "$UPD" ] && [ "$((NOWMS - UPD))" -gt 5000 ]; then
      echo "▶ 状态已经 $(( (NOWMS - UPD) / 1000 )) 秒没更新（服务可能已经不在了）——不等了"
      break
    fi
    [ "$waited" = "0" ] && echo "▶ 它手上还有话，等它说完（最多 ${MAX_WAIT_SEC} 秒）…"
    sleep "$POLL_SEC"
    waited=$((waited + POLL_SEC))
  done
  if [ "$waited" -gt 0 ]; then
    if [ "$waited" -ge "$MAX_WAIT_SEC" ]; then
      echo "⚠️ 等了 ${waited} 秒还没说完 ⇒ **照样重启**（等一个卡住的服务更坏）"
    else
      echo "✓ 它说完了（等了 ${waited} 秒）"
    fi
  fi
fi

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
# ⚠️ 指纹**不许**默认成 `dev`：那样 `/api/version` 报的就是一句假话
#    ——"我是哪个版本"和磁盘上真正在服务的产物对不上。
#    （2026-09-21 实测踩到：手动重启一次，线上指纹就从 `54a882e213e9` 掉成 `dev`。）
#    ⇒ 没显式给就从**真正部署的那份产物**里读：部署时入口文件叫 `main.<指纹>.dart.js`。
#    ⇒ 读不到（没出过 Web 产物 / 还是没指纹的老办法）才算 `dev`。
BUILD="${HUPO_BUILD_ID:-}"
if [ -z "$BUILD" ]; then
  ENTRY="$(ls "$DIR"/web/main.*.dart.js 2>/dev/null | head -1 || true)"
  if [ -n "$ENTRY" ]; then
    BUILD="$(basename "$ENTRY" | sed -E 's/^main\.(.+)\.dart\.js$/\1/')"
  else
    BUILD="dev"
  fi
fi
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
grep -E "监听|鉴权|接记忆|人格|能力层|账本|卡住|上次收尾|上次退出|续做|界面|构建|时间线" serve.log || tail -20 serve.log
