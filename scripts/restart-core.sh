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
# ⚠️ 同一条也写在 `scripts/start-tunnels.sh` 顶上（那几条隧道由 `hupo-frpc-*` 单元管）。
#
# ── ★ 两条路，按 `systemctl --user is-active hupo-core` 选 ─────────
#    （2026-09-25 加；口径写在 `deploy/systemd/README.md` §六）
#
#    · **单元在跑** ⇒ 走 **systemd 那条路**：
#        - 停/起都只点**这个具体单元**（`systemctl --user stop/start hupo-core`）；
#        - **不看也不写 `serve.pid`**（systemd 不写它，老脚本因此会再起一个抢 8020 ⇒ EADDRINUSE）；
#        - 真指纹用 drop-in `~/.config/systemd/user/hupo-core.service.d/10-hupo-build-id.conf`
#          递进去再 `daemon-reload`（systemd **不做命令替换**，`Environment=` 只能来自文件）。
#
#    · **单元没在跑**（`is-active` 假：退回手动之后 / 开发机上）⇒ **原样走手动那条路**：
#        `serve.pid` → `SIGTERM` → 自己 `node src/serve.js`，行为**一个字节都不改**。
#
#    开机自启归 `hupo-core.service`（`deploy/systemd/`）；本脚本只管"现在重启成新的那一版"。
#
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

# ── 0.1) ★ 判：这次走哪条路（**认单元 / 手动**）──────────────────
# 判据只有一条：`systemctl --user is-active --quiet hupo-core`。
# ⚠️ **只问这一个具体单元**：不许写裸 `systemctl --user stop`（不带单元）——
#    那会顺手清掉 DSH 的 scope，把别的会话一起杀掉（`AGENTS.md` §一，本项目真出过事）。
# ⚠️ 没有 systemctl / 没有 user manager 时（老环境）也当"没单元"，走手动路。
UNIT=hupo-core
USE_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
  USE_SYSTEMD=1
fi

# ★ 把真指纹递给 systemd：**它不做命令替换**，只能写文件。
#   路径：`~/.config/systemd/user/hupo-core.service.d/10-hupo-build-id.conf`（drop-in）。
# ⚠️ 为什么不用 `systemctl --user set-environment`：manager 的环境**不落盘**，
#    机器一重启就没了 —— 而"开机自启"正是这个单元存在的理由 ⇒ 重启之后 `/api/version`
#    又会掉回 `dev`。drop-in 是文件，跟着单元一起活（重启机器也在）。
DROPIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT.service.d"
DROPIN="$DROPIN_DIR/10-hupo-build-id.conf"
write_build_dropin() {
  mkdir -p "$DROPIN_DIR" || return 1
  cat > "$DROPIN" <<EOF
# ⚠️ **这个文件是自动生成的**：scripts/restart-core.sh 每次走 systemd 那条路都会重写它。
# 为什么要有它：systemd **不做命令替换**，而真指纹只能现从 web/index.html / web/main.<指纹>.dart.js 推。
# 手动改指纹（两件都要做，否则改的是文件、跑的还是旧值）：
#   systemctl --user daemon-reload && systemctl --user restart $UNIT
# 改完对着公网核一遍：curl -s https://w.stalkerai.cn/api/version
[Service]
Environment=HUPO_BUILD_ID=$1
EOF
  systemctl --user daemon-reload
}

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

# ── 0) 🔴 **先问一句：新服务起得来吗**（起不来就别把旧的弄下去）──────
# ⚠️ **为什么加这一步**（2026-09-22，我自己撞的）：
#    我改了 `docs/handbook/**`（那是 `strict`），**忘了先重建开机清单**，
#    然后就跑了部署 —— 而部署会重启服务 ⇒ **新服务拒绝启动**（清单对不上），
#    旧的又已经被停了 ⇒ **整站 502**（大约两分钟）。
#    而这条规矩手册里**明写着**（`AGENTS.md` §八：「改完这几步之后要重建」）——
#    说明"靠人记得"不够。⇒ 让**工具**来拦：**知道它起不来，就别动旧的**。
#    ⚠️ 这条预检**只读**：查一遍清单，对不上就打印**那一条补救命令**然后退出，
#      留下的还是**活着的**旧服务（"停在那里"比"整站下线"好得多）。
if [ "${HUPO_SKIP_PREFLIGHT:-0}" != "1" ]; then
  # ⚠️ **不许在这儿自己再算一遍路径**（2026-09-22 栽了）：这一段的 cwd 早就被
  #    上面的 `cd "$DIR"` 换掉了，而 `$(dirname "${BASH_SOURCE[0]}")` 是**相对当时 cwd**
  #    解析的 ⇒ 算出来是 `…/v2/services/core`（于是预检**静默跳过**、我又把服务停下去送死一次）。
  #    ⇒ 用脚本**在 `cd` 之前**就算好的那个 `$DIR`（它就是服务目录，往上是仓库根）。
  # ⚠️ **`$DIR` 是服务目录（`…/v2/services/core`）⇒ 到仓库根要往上三级**
  #    （我第一版写两级 ⇒ 算成 `…/hupo/v2` ⇒ 预检**又静默跳过**。
  #     **同一个"往上几级"我今天数错两次** —— 一次在 `serve.js`、一次在这儿。）
  PRE="$(cd "$DIR/../../.." && pwd)"
  NODE_PRE="${HUPO_NODE_BIN:-}"
  if [ -z "$NODE_PRE" ]; then
    for c in "$(command -v node 2>/dev/null || true)" /home/deploy/.nvm/versions/node/*/bin/node; do
      [ -x "$c" ] && NODE_PRE="$c" && break
    done
  fi
  if [ -n "$NODE_PRE" ] && [ -f "$PRE/scripts/verify-integrity.mjs" ]; then
    # ⚠️ **只看退出码 2**（= 会拒绝启动）。那个脚本的退出码是有区分的：
    #    0 = 干净 · 1 = **只有"只报不拦"的条目动过**（服务照常起）· 2 = **会拒绝启动**。
    #    ⚠️ 我第一版写的是 `if ! ...`（非零就拦）⇒ 那会把**每一次改 `src/` 之后的重启**
    #       都拦下来（而改 `src/` 是天天在做的事）——**一道会误报的闸很快就会被绕开**。
    "$NODE_PRE" "$PRE/scripts/verify-integrity.mjs" >/dev/null 2>&1
    PRE_RC=$?
    if [ "$PRE_RC" = "2" ]; then
      echo "▶ 预检：**新服务起不来**（开机清单对不上）—— 那就**不停旧的**"
      echo
      "$NODE_PRE" "$PRE/scripts/verify-integrity.mjs" 2>&1 | sed 's/^/  /'
      echo
      echo "  ⇒ 是你自己（或主人）改的就照上面那条命令重建清单，再跑一次本脚本"
      echo "  ⇒ 想强行跳过预检：HUPO_SKIP_PREFLIGHT=1 bash $0"
      exit 3
    elif [ "$PRE_RC" = "0" ]; then
      echo "▶ 预检：清单对得上（新服务起得来）"
    else
      echo "▶ 预检：只有「只报不拦」的条目动过（服务照常起）"
    fi
  else
    echo "▶ 预检：跳过（找不到 node 或那个脚本）"
  fi
fi

# ── 0.9) ★ 算真指纹（**两条路都要，systemd 那条路要在"起"之前用**）────
# ⚠️ 指纹**不许**默认成 `dev`：那样 `/api/version` 报的就是一句假话
#    ——"我是哪个版本"和磁盘上真正在服务的产物对不上。
#    （2026-09-21 实测踩到：手动重启一次，线上指纹就从 `54a882e213e9` 掉成 `dev`。）
#    ⇒ 没显式给（`HUPO_BUILD_ID`）就**从 index.html 真正引用的那份产物**里读：
#      部署时入口文件叫 `main.<指纹>.dart.js`，index.html 引的是
#      `flutter_bootstrap.<指纹>.js`（同一个指纹）——这才是浏览器真正拿到的那一版。
#    ⇒ index.html 读不到（没出过 Web 产物 / 还是没指纹的老办法）再退回 `ls web/main.*`，
#      都读不到才算 `dev`。
BUILD="${HUPO_BUILD_ID:-}"
if [ -z "$BUILD" ] && [ -f web/index.html ]; then
  BUILD="$(grep -o 'flutter_bootstrap\.[0-9a-f]*\.js' web/index.html 2>/dev/null | head -1 \
    | sed -E 's/^flutter_bootstrap\.(.+)\.js$/\1/')"
fi
if [ -z "$BUILD" ]; then
  ENTRY="$(ls "$DIR"/web/main.*.dart.js 2>/dev/null | head -1 || true)"
  if [ -n "$ENTRY" ]; then
    BUILD="$(basename "$ENTRY" | sed -E 's/^main\.(.+)\.dart\.js$/\1/')"
  else
    BUILD="dev"
  fi
fi

# ── 1) 停 ────────────────────────────────────────────────────
if [ "$USE_SYSTEMD" = "1" ]; then
  # ★ systemd 那条路：线上服务活在 `$UNIT` 的 cgroup 里（`…/app.slice/hupo-core.service`），
  #   **它不写 `serve.pid`** ⇒ 决不能再去按 PID 停（那会看不见它、然后自己再起一个抢 8020）。
  # 🔴 只点**这个具体单元**：`systemctl --user stop hupo-core`。
  #    **不许**写裸 `systemctl --user stop`（不带单元）—— 那会顺手清掉 DSH 的 scope。
  # ⚠️ 这里用 stop（而不是 restart），因为 `--fresh` 要在**停了之后、起之前**删日志文件；
  #    不 fresh 时紧接着就 `start`，与 restart 等价。stop 是有意的 ⇒ `Restart=always` 不会抢跑。
  echo "▶ 线上服务归系统单元管（$UNIT 在跑）—— 用 systemctl 停/起，**不看 serve.pid**"
  systemctl --user stop "$UNIT" || {
    echo "✗ 停不下 $UNIT；**什么都没动**，先看：systemctl --user status $UNIT --no-pager"
    exit 1
  }
  # 手动时代留下的 pid 文件清掉（留着它，下次回退手动路会拿一个死 PID 去 kill）
  rm -f serve.pid
else
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
fi

# ── 2) 清 ────────────────────────────────────────────────────
# ★ 这一条**两条路口径一样**（README §六·2）：systemd 那条路也照删
#   —— 因为上面刚把单元停掉，删文件是真的删（服务没开着那个句柄）。
if [ "$FRESH" = "1" ]; then
  # ⚠️ 这一步会**永久删掉**所有说过的话。所以它必须显式要，不能是默认。
  echo "▶ --fresh：删掉 data/main.jsonl（**说过的话会没**）"
  rm -f data/main.jsonl
fi

# ── 3) 起 ────────────────────────────────────────────────────
PORT="${HUPO_PORT:-8020}"
if [ "$USE_SYSTEMD" = "1" ]; then
  # ★ **systemd 唯一认可的递法**：写 drop-in 再 `daemon-reload`（它不做命令替换）。
  # ⚠️ 端口以**单元里的** `HUPO_PORT` 为准（`Environment=HUPO_PORT=8020`）——
  #    这里把它读出来照实报，别拿 caller 的环境说假话。
  UNIT_PORT="$(systemctl --user show "$UNIT" -p Environment 2>/dev/null \
    | tr ' ' '\n' | sed -n 's/^HUPO_PORT=//p' | head -1)"
  echo "▶ 起新服务（systemd 单元 $UNIT）：端口 ${UNIT_PORT:-（见单元里的 HUPO_PORT）}，构建指纹 $BUILD"
  if [ -n "${HUPO_PORT:-}" ] && [ -n "$UNIT_PORT" ] && [ "$HUPO_PORT" != "$UNIT_PORT" ]; then
    echo "  ⚠️ 你设了 HUPO_PORT=$HUPO_PORT，而**单元**里是 $UNIT_PORT ⇒ systemd 这条路以**单元**为准"
  fi
  write_build_dropin "$BUILD" || { echo "✗ 指纹 drop-in 写不下去：$DROPIN"; exit 1; }
  echo "   （指纹已写进 $DROPIN，并 daemon-reload 过了）"
  systemctl --user start "$UNIT" || { echo "✗ systemctl --user start $UNIT 失败"; exit 1; }
  sleep 3
else
  # ── 手动那条路（**原样保留**：退回 systemd 之后 / 开发机上还要用）──────
  echo "▶ 起新服务：端口 $PORT，构建指纹 $BUILD"
# ⚠️ **这一段 2026-09-23 修过**，原来长这样：
#       setsid nohup env \
#         HUPO_DATA="$DIR/data" \
#         HUPO_PORT="$PORT" \
#         HUPO_WEB="$DIR/web" \
#       <紧跟一条注释>
#    而它后面那条注释**结束了这个命令** ⇒ 那其实是一条**没有命令的 `env`**：
#      ① 它把**整个环境打印一遍**（环境里但凡有密钥，就当场印在屏幕上/日志里）；
#      ② `HUPO_DATA / HUPO_PORT / HUPO_WEB` **根本没传给服务** —— 服务一直在用默认值，
#         而脚本却照着变量 echo「端口 $PORT」⇒ 谁改了 `HUPO_PORT`，**脚本就在说假话**。
#    ⇒ 改成显式 `export`：**一个字节都不打印**，而值真的进到服务里。
#    ⚠️ **起进程那一段没动**（没有加 `setsid`）：手动路的 cgroup 是 DSH 的 subprocess scope
#       （`AGENTS.md` §一 记着这件事），换 detach 方式会动到它。
export HUPO_DATA="$DIR/data"
export HUPO_PORT="$PORT"
export HUPO_WEB="$DIR/web"
# ★ **机器本地的环境**（可选，**不进仓库**）：`data/tenants.env`。
#   多租户那张 `userId → 租户名` 的表住在那儿 —— 它是**这台机器的状态**
#   （谁在哪台容器里），不是代码。⚠️ 显式一张表、**不许从手机号推**（权限席点名）。
# ⚠️ 没有这个文件也照常起（这台部署没开多租户）。
if [ -f data/tenants.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./data/tenants.env
  set +a
  echo "   （读到了 data/tenants.env）"
fi

# ★ **语音那三样凭据**（可选，**不进仓库**）：`data/asr.env`（**0600**）。
#   一行一个：`TENCENT_APPID` / `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`
#   （引擎名可用 `TENCENT_ASR_ENGINE` 覆盖；`HUPO_ASR_URL` 是取证时换上游用的，
#    **生产里不许设** —— 设了就等于拿桩当真的。）
#   ⚠️ 它在**启动之前** source，而上面那条"打印整个环境"的坑已经拆掉
#      ⇒ 这三个值不会出现在任何输出里。
if [ -f data/asr.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./data/asr.env
  set +a
  # ⚠️ **只说"齐没齐"，不打印值、也不打印长度**
  have() { if [ -n "${!1:-}" ]; then echo "有"; else echo "没有"; fi; }
  echo "   （读到了 data/asr.env：APPID $(have TENCENT_APPID) · SECRET_ID $(have TENCENT_SECRET_ID) · SECRET_KEY $(have TENCENT_SECRET_KEY)）"
  unset -f have
fi

  HUPO_BUILD_ID="$BUILD" \
  node src/serve.js > serve.log 2>&1 < /dev/null &
echo $! > serve.pid
sleep 3
fi

# ── 4) 报状态（**报告它现在是什么样，不喊口号**）────────────
if [ "$USE_SYSTEMD" = "1" ]; then
  UNIT_PID="$(systemctl --user show "$UNIT" -p MainPID 2>/dev/null | cut -d= -f2)"
  if ! systemctl --user is-active --quiet "$UNIT" || [ -z "$UNIT_PID" ] || [ "$UNIT_PID" = "0" ]; then
    echo "✗ $UNIT 没起来。systemctl status（末 20 行）与 serve.log 末尾："
    systemctl --user status "$UNIT" --no-pager -n 20 2>&1 | sed 's/^/  /'
    tail -20 serve.log
    exit 1
  fi
  echo "✓ 起来了（systemd 单元 $UNIT，PID $UNIT_PID）"
else
  if ! kill -0 "$(cat serve.pid)" 2>/dev/null; then
    echo "✗ 没起来。serve.log 末尾："
    tail -20 serve.log
    exit 1
  fi
  echo "✓ 起来了（PID $(cat serve.pid)）"
fi
# ⚠️ **整段横幅照原样打出来，不许挑词过滤**（2026-09-21 改）：
#    原来是 `grep -E "监听|鉴权|接记忆|..."`，而那个词表**漏了 `完整性` 与 `准入`** ——
#    正好是**两道闸**那一行。⇒ 主人跑重启脚本时，**看不到"完整性有没有对上"**
#    （实测：横幅 20 行，被过滤成 12 行）。
#    这种"新加一行横幅就悄悄看不见"的缺陷**会复发**，所以不补词，改成**按形状取**：
#    从**横幅头**打到**收尾那条纯 `─` 规则线**为止。横幅长什么样就报什么，加多少行都不会漏。
#    ⚠️ 终止条件不能用 `/^─/` —— **头行自己就以 `─` 开头**（`── 琥珀 · 调度器…`），
#       那样会在头行就停下（我第一次就是这么写的，实测只打出 1 行）。必须是"全破折线"。
#    ⚠️ **而且要从"最后一个横幅头"开始取，不是从文件第 1 行**（2026-09-25 修）：
#       单元用 `StandardOutput=append:` ⇒ `serve.log` **不再被截断**，
#       而 `awk '/^─+$/'` 这个全破折线条件在本机的 **mawk** 下**匹配不上**
#       （实测：它一路打到 EOF）⇒ 旧写法会把**历史几个横幅**一起打出来
#       （含旧的 `构建 dev`）—— 那正是这个项目最恨的"脚本在说假话"。
#       ⇒ 取最后一个横幅头（形如 `^── `）到它后面那条**非空全破折线**为止。
#         手动路那边 `serve.log` 是刚截断的、只有一个横幅，取出来与原意一致。
BAN_START="$(grep -n '^── ' serve.log 2>/dev/null | tail -1 | cut -d: -f1)"
BAN_END="$(grep -n -x '[─]\+' serve.log 2>/dev/null | tail -1 | cut -d: -f1)"
if [ -n "$BAN_START" ] && [ -n "$BAN_END" ] && [ "$BAN_END" -ge "$BAN_START" ]; then
  sed -n "${BAN_START},${BAN_END}p" serve.log
else
  tail -20 serve.log
fi
