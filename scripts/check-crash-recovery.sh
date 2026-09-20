#!/usr/bin/env bash
# 验收：**被硬杀之后重启，它会不会把话收干净、并告诉用户"可能没做完"**。
#
# 用法：scripts/check-crash-recovery.sh
#
# ── 为什么这条必须真起服务、真 kill -9 ──────────────────────
# 这是手册**事故一**的形状：「还有件事在处理」从 15:31 挂到 16:39。
# 它的成因是"进程连同那件活一起被杀，**没人补那个结束**"——
# 这种故障**只有真的杀一次**才复现得出来；在进程内 mock 掉就等于没测。
#
# ⚠️ 它只碰**临时数据目录 + 临时端口**，不碰线上那一份。
# ⚠️ 杀子进程只杀**本服务的孩子**（按 ppid 找），不用 `pkill -f`——
#    那台机器上还有主人自己的几百个会话。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../v2/services/core" && pwd)"
PORT="${HUPO_CHECK_PORT:-8023}"
PASS='yaoshi-9'
DATA="$(mktemp -d /tmp/hupo-crash-XXXX)"
cd "$DIR" || exit 1

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null; done
}
trap cleanup EXIT

start() { # start <buildId> <logfile>
  setsid nohup env HUPO_DATA="$DATA" HUPO_PORT="$PORT" HUPO_WEB="$DIR/web" \
    HUPO_BUILD_ID="$1" node src/serve.js > "$2" 2>&1 < /dev/null &
  echo $!
}

echo "▶ 数据目录 $DATA ｜ 端口 $PORT"

PID="$(start crash-repro "$DATA/serve1.log")"; PIDS+=("$PID"); sleep 3
if ! kill -0 "$PID" 2>/dev/null; then echo "✗ 起不来："; tail -20 "$DATA/serve1.log"; exit 1; fi
printf '%s' "$PASS" | HUPO_DATA="$DATA" node src/auth-cli.mjs set >/dev/null 2>&1
sleep 1.5
TOKEN="$(curl -s -X POST "http://127.0.0.1:$PORT/api/login" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')"
[ -n "$TOKEN" ] || { echo "✗ 登录失败"; exit 1; }

echo "▶ 发一句要跑很久的活（让它把气泡开着）"
curl -s -X POST "http://127.0.0.1:$PORT/api/say" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"messageId":"u_crash_1","text":"用 bash 跑 `sleep 60`，跑完回我三个字：好了。"}' >/dev/null
sleep 10

open_before="$(python3 - "$DATA/main.jsonl" <<'PY'
import json,sys
evs=[json.loads(l) for l in open(sys.argv[1],encoding='utf-8')]
opened={e['messageId'] for e in evs if e['type']=='message/start'}
closed={e['messageId'] for e in evs if e['type']=='message/end'}
print(','.join(sorted(opened-closed)))
PY
)"
echo "▶ 硬杀之前未收口的：${open_before:-（没有）}"
[ -n "$open_before" ] || { echo "✗ 没造出"开着的气泡"这个现场，后面的检查没意义"; exit 1; }

echo "▶ kill -9（模拟 OOM / 断电 / 被硬杀）"
CHILDREN="$(ps -eo pid,ppid --no-headers | awk -v p="$PID" '$2==p {print $1}')"
kill -9 "$PID" 2>/dev/null
for c in $CHILDREN; do kill -9 "$c" 2>/dev/null; done
sleep 1

echo "▶ 重启（同一个数据目录）"
PID2="$(start crash-restart "$DATA/serve2.log")"; PIDS+=("$PID2"); sleep 4

python3 - "$DATA/main.jsonl" "$PASS" <<'PY'
import json,sys
evs=[json.loads(l) for l in open(sys.argv[1],encoding='utf-8')]
opened={e['messageId'] for e in evs if e['type']=='message/start'}
closed={e['messageId'] for e in evs if e['type']=='message/end'}
left=opened-closed
texts=[e['text'] for e in evs if e['type']=='message/text']
# ⚠️ 这个场景用的是 `bash` 跑 sleep —— 而 **`bash` 不在只读白名单里**（D10.2）。
#    所以它**必须**被认成"动过东西"，而且那句话要说清"我没敢自己重来"。
#    （"只读过"那一版走单测 —— 那条路要真 agent 只碰只读工具，不可靠。）
mutated=[e for e in evs if e['type']=='task/mutated']
checks=[
  ('未收口的气泡被收掉了', not left),
  ('对用户说了"可能没做完"', any('可能没做完' in t for t in texts)),
  ('🔴 认出了"这一轮动过东西"（真 agent 的 tool/call 真的到了）', len(mutated)>=1),
  ('🔴 而且那句话是"动过东西"那一版', any('改过东西' in t for t in texts)),
  ('🔴 说清了"我没有自己重来"', any('没有自己重来' in t for t in texts)),
  ('收口理由记成 failed（没善终）', any(e['type']=='message/end' and e.get('reason')=='failed' for e in evs)),
]
bad=0
for name,ok in checks:
    print(('  ✅ ' if ok else '  ❌ ')+name)
    if not ok: bad+=1
sys.exit(0 if bad==0 else 1)
PY
[ $? -eq 0 ] || { echo "❌ 重启之后的对账没做成"; exit 1; }

echo "▶ 横幅要报出"上次怎么结束的""
grep -E "上次收尾" "$DATA/serve2.log" | sed 's/^/  /'

echo "▶ 再重启一次（**事故二的教训**：不许每次重启都说一句）"
N_BEFORE="$(wc -l < "$DATA/main.jsonl")"
kill -TERM "$PID2" 2>/dev/null; sleep 2
PID3="$(start crash-restart2 "$DATA/serve3.log")"; PIDS+=("$PID3"); sleep 4
N_AFTER="$(wc -l < "$DATA/main.jsonl")"
if [ "$N_BEFORE" = "$N_AFTER" ]; then
  echo "  ✅ 第三次开机**一个字都没多写**（$N_BEFORE 条 → $N_AFTER 条）"
else
  echo "  ❌ 又写新东西了（$N_BEFORE → $N_AFTER）—— 那就是事故二（每次重启说一句）"
  exit 1
fi
grep -E "上次收尾" "$DATA/serve3.log" | sed 's/^/  /'

echo
echo "════ 第二幕：一件**只读过东西**的活 —— 它应该被自动重做 ════"
echo "（上面那一幕用的是 bash ⇒ 动过东西 ⇒ 只通知。这一幕用只读的活。）"

DATA2="$(mktemp -d /tmp/hupo-resume-XXXX)"
start2() { setsid nohup env HUPO_DATA="$DATA2" HUPO_PORT="$PORT" HUPO_WEB="$DIR/web" \
  HUPO_BUILD_ID="$1" node src/serve.js > "$2" 2>&1 < /dev/null & echo $!; }

P1="$(start2 resume-a "$DATA2/s1.log")"; PIDS+=("$P1"); sleep 3
printf '%s' "$PASS" | HUPO_DATA="$DATA2" node src/auth-cli.mjs set >/dev/null 2>&1; sleep 1.5
T2="$(curl -s -X POST "http://127.0.0.1:$PORT/api/login" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')"

# 造一件"只读过东西、被硬杀"的现场：直接往日志里写（**不花模型调用**）——
# 这条要验的是**调度**，不是模型。形态与真 agent 走只读工具时落下来的完全一样。
python3 - "$DATA2/main.jsonl" <<'PY'
import json, sys, time
now = int(time.time() * 1000)
evs = [
  {"type":"user/echo","messageId":"u_ro","text":"帮我查一下明天的天气","clientAt":None,"seq":1,"at":now-60000},
  {"type":"message/start","messageId":"m_ro","agent":"agent","origin":"reactive","re":[],"seq":2,"at":now-59000},
  {"type":"message/text","messageId":"m_ro","block":"quick","seqInBlock":1,"text":"我查着…","seq":3,"at":now-58000},
]
open(sys.argv[1],"w",encoding="utf-8").write("".join(json.dumps(e,ensure_ascii=False)+"\n" for e in evs))
PY
echo "▶ 现场：只读过东西、开了口没收口（$DATA2/main.jsonl）"
kill -9 "$P1" 2>/dev/null; sleep 1
P2="$(start2 resume-b "$DATA2/s2.log")"; PIDS+=("$P2"); sleep 6

python3 - "$DATA2/main.jsonl" "$DATA2/s2.log" <<'PY'
import json, sys
evs=[json.loads(l) for l in open(sys.argv[1],encoding='utf-8')]
log=open(sys.argv[2],encoding='utf-8').read()
resumed=[e for e in evs if e['type']=='task/resumed']
texts=[e.get('text','') for e in evs if e['type']=='message/text']
checks=[
  ('🔴 落了 `task/resumed`（额度记下来了）', len(resumed)==1),
  ('🔴 归属对：`ref` 就是主人那句话', len(resumed)==1 and resumed[0].get('ref')=='u_ro'),
  ('🔴 说的是"我重新做一遍"（不是"你说一声"）', any('我重新做一遍' in t for t in texts)),
  ('🔴 服务真的去起了 agent 把活派出去', '续做：' in log),
]
bad=0
for n,ok in checks:
    print(('  ✅ ' if ok else '  ❌ ')+n)
    if not ok: bad+=1
sys.exit(0 if bad==0 else 1)
PY
[ $? -eq 0 ] || { echo "❌ 第二幕没过"; exit 1; }
echo "  （日志：$(grep -o '续做：.*' "$DATA2/s2.log" | head -1)）"

echo
echo "✅ 通过：动过东西的只通知；只读过东西的**真的自动重做**，而且额度落盘"
