#!/usr/bin/env bash
# **钥匙怎么进来那条路的判据**（契约 `docs/dev/46-KEY-DELIVERY.md` §五）。
#
# 用法：
#   bash scripts/check-key-delivery.sh                  # 全套（下面那些"盒内"的会真跑一次性容器）
#   sudo bash scripts/check-key-delivery.sh --live      # 再看一眼**真机器**那两台
#
# ── 判据（每条都带**负向对照**）──────────────────────────────
#   ① 钥匙文件在**卷**里（`/data/creds.yaml`）、`0600 root`
#   ② 🔴 **agent(uid 1000) 读不到** ⇒ 必须 `EACCES`（**挑一个存在的路径**，不许拿
#      `ENOENT` 糊过去）；正对照：**root 读得到**
#   ③ **agent 写不进去**（它换不掉自己那把钥匙的来源）
#   ④ 盒内 `put-key`：好钥匙 ⇒ 写进去且 0600；空 / 不可打印 ⇒ 拒
#   ⑤ 投递名：`../`、没后缀、认不出 ⇒ 拒绝并**留证据**；三种正常名字都认得
#   ⑥ 🔴 **送到才删**：那台还没确认 ⇒ 文件必须还在
#   ⑦ 日志与账本里**不出现钥匙**
#
# ⚠️ ①~④ 要一个真容器（rootless podman 在 **deploy** 的存储里）⇒ **不要以 root 跑**。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
PODMAN="${PODMAN_BIN:-/usr/bin/podman}"
IMG="${HUPO_TENANT_IMAGE:-localhost/hupo-tenant:local}"
LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  for c in /home/deploy/.nvm/versions/node/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "✗ 找不到 node"; exit 2; }

pass=0; fail=0; skipped=0
ok()   { echo "  ✓ $1"; pass=$((pass + 1)); }
bad()  { echo "  ✗ $1"; fail=$((fail + 1)); }
skip() { echo "  · $1"; skipped=$((skipped + 1)); }

if [ "$(id -u)" = "0" ] && [ "$LIVE" != "1" ]; then
  echo "✗ 这个判据要在 deploy 身份下跑（rootless podman 的镜像在他存储里，root 看不见）。"
  echo "  要看真机那一眼：sudo bash $0 --live"
  exit 2
fi

T="$(mktemp -d)"
NAME="hupo-keycheck-$$"
cleanup() { "$PODMAN" kill "$NAME" >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT

portable_part() {
  # ══════════════════════════════════════════════════════════════════
  echo "── 判据一~三：钥匙在卷里、**agent 读不到也写不进去**（这一批最要紧的一条）"
  # ══════════════════════════════════════════════════════════════════
  # 🔴 为什么这三条非验不可：决策 ①（"agent 读不到自己的 key"）是**没有商量**的。
  #    钥匙从 tmpfs 搬到卷里（`46` §二）动的就是"它住在哪" ⇒ 必须当场证明边界没塌。
  #    ⚠️ 判"读不到"要挑一个**存在**的路径：拿一个不存在的路径只会得到 `ENOENT`，
  #       那证明的是"路径不存在"，不是"读不到"（这个项目栽过一次）。
  if [ ! -x "$PODMAN" ]; then
    bad "找不到 $PODMAN —— ①~④ 必须有真容器才算验过"
    return
  fi
  if ! "$PODMAN" image exists "$IMG" >/dev/null 2>&1; then
    bad "没有镜像 $IMG —— 先 bash scripts/build-tenant-image.sh"
    return
  fi
  # 拿**产品层那一份**当挂载（这样验的就是真在跑的那份代码）
  CODE="$("$ROOT/scripts/build-tenant-code.sh" --current 2>/dev/null || true)"
  [ -n "$CODE" ] || { bad "还没发布过产品层（先 build/verify/publish）"; return; }
  DATA="$T/data"; mkdir -p "$DATA"
  PORT=""
  for p in $(seq 18170 18195); do ss -ltn 2>/dev/null | grep -q ":$p " || { PORT="$p"; break; }; done
  [ -n "$PORT" ] || { bad "找不到空闲端口"; return; }
  "$PODMAN" run -d --rm --name "$NAME" \
    -p "127.0.0.1:$PORT:8080" -v "$DATA:/data" -v "/srv/hupo/tenant-code/current:/app/code:ro" \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
    --tmpfs /run/hupo:rw,nosuid,nodev,mode=0700 \
    --security-opt=no-new-privileges --cap-drop=ALL \
    --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID --cap-add=FOWNER \
    --pids-limit=512 --memory=768m --memory-swap=768m \
    --env HUPO_CODE_DIR=/app/code "$IMG" >/dev/null 2>&1 || { bad "容器起不来"; return; }
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/version" 2>/dev/null || true)" = "200" ] && break
    sleep 0.5
  done

  # ★ 用**盒内那个入口**真的放一把（这就是判据④的"好钥匙"那一半）
  KEY="$(printf 'sk-judge-%s' "$(date +%s)")"
  OUT="$(printf '%s\n' "$KEY" | "$PODMAN" exec -i "$NAME" /bin/node /app/code/src/put-key.mjs 2>&1)"
  if grep -q '钥匙放好了' <<<"$OUT" && ! grep -qF "$KEY" <<<"$OUT"; then
    ok "盒内 put-key：放进去了，而且**没有回显钥匙**"
  else
    bad "🔴 盒内 put-key 不对劲：$OUT"
  fi
  # ① 位置与权限（**卷里**、0600 root）
  ST="$("$PODMAN" exec "$NAME" /bin/node -e 'const s=require("node:fs").statSync("/data/creds.yaml");process.stdout.write(`${s.uid}:${s.gid}:${(s.mode&0o777).toString(8)}:${require("node:fs").readFileSync("/data/creds.yaml","utf8").includes("HUPO_MODEL_KEY")}`)' 2>&1)"
  if [ "$ST" = "0:0:600:true" ]; then
    ok "钥匙文件在**卷**里：/data/creds.yaml（uid:gid:mode = 0:0:600）"
  else
    bad "🔴 钥匙文件的属主/权限不对（要 0:0:600:true，实为 $ST）"
  fi
  # ①的负向对照：**不许**再落在 tmpfs 上
  if "$PODMAN" exec "$NAME" /bin/node -e 'process.exit(require("node:fs").existsSync("/run/hupo/creds.yaml")?0:1)' 2>/dev/null; then
    bad "🔴 钥匙还在 tmpfs 上（/run/hupo/creds.yaml）—— 那重建容器就丢"
  else
    ok "负向对照：tmpfs 那条老路**没在用**（重建容器不会丢）"
  fi

  # ② 🔴 agent(uid 1000) 读它 ⇒ 必须 **EACCES**（不是 ENOENT）
  READ_AS_AGENT="$("$PODMAN" exec --user 1000 "$NAME" /bin/node -e '
    const fs = require("node:fs");
    const p = "/data/creds.yaml";
    const exists = fs.existsSync(p);            // 注意：existsSync 对 agent 是 false（它连列都列不出来）
    try { fs.readFileSync(p); console.log(`🔴 读到了 ${exists}`); }
    catch (e) { console.log(`【${e.code}】`); }
  ' 2>&1)"
  if grep -q 'EACCES' <<<"$READ_AS_AGENT"; then
    ok "🔴 agent(uid 1000) 读它 ⇒ **EACCES**（决策 ① 没塌）"
  else
    bad "🔴 agent 读那把钥匙的结果不是 EACCES：$READ_AS_AGENT"
  fi
  # ②的**正对照**：root 读得到（不然上面那条可能是"文件根本不存在"）
  if "$PODMAN" exec "$NAME" /bin/node -e 'process.exit(require("node:fs").readFileSync("/data/creds.yaml","utf8").length>0?0:1)' 2>/dev/null; then
    ok "正对照：**root 读得到**（所以上面那条 EACCES 证的是权限，不是"文件不在"）"
  else
    bad "🔴 root 都读不到 —— 那上面的 EACCES 说明不了任何事"
  fi
  # ③ agent 写不进去（换不掉来源）
  WRITE_AS_AGENT="$("$PODMAN" exec --user 1000 "$NAME" /bin/node -e '
    try { require("node:fs").writeFileSync("/data/creds.yaml", "HUPO_MODEL_KEY: sk-evil\n"); console.log("🔴 写进去了"); }
    catch (e) { console.log(`【${e.code}】`); }
  ' 2>&1)"
  if grep -qE 'EACCES|EPERM|EROFS' <<<"$WRITE_AS_AGENT"; then
    ok "🔴 agent **写不进去**（它换不掉自己那把钥匙的来源）"
  else
    bad "🔴 agent 能改那个文件：$WRITE_AS_AGENT"
  fi
  # ③的正对照：root 写得进去（确认上面那条不是"文件系统全只读"）
  if "$PODMAN" exec "$NAME" /bin/node -e '
    const fs=require("node:fs"); fs.writeFileSync("/data/creds.yaml","HUPO_MODEL_KEY: sk-judge-again\n");
    console.log(fs.readFileSync("/data/creds.yaml","utf8").includes("judge-again")?"ok":"no");
  ' 2>/dev/null | grep -q ok; then
    ok "正对照：**root 写得进去**（/data 是卷，不是只读层）"
  else
    bad "🔴 root 都写不进去 —— 那这把钥匙怎么换"
  fi

  # ④ 坏输入一律拒（负向对照在盒内真跑一遍）
  for badkey in '' $'\x07bad'; do
    O="$(printf '%s\n' "$badkey" | "$PODMAN" exec -i "$NAME" /bin/node /app/code/src/put-key.mjs 2>&1)"
    if grep -q '✗' <<<"$O"; then ok "盒内 put-key：坏输入被拒（$(head -c 20 <<<"$O" | tr -d '\n')）"; else bad "🔴 坏输入没被拒：$O"; fi
  done
  # ⚠️ 拒的时候**不许**把好的那把覆盖掉
  if "$PODMAN" exec "$NAME" /bin/node -e 'process.exit(require("node:fs").readFileSync("/data/creds.yaml","utf8").includes("judge-again")?0:1)' 2>/dev/null; then
    ok "坏输入被拒之后，原来那把**还在**（没被清掉）"
  else
    bad "🔴 坏输入把好钥匙弄没了"
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据四·补：**钥匙住哪只有一处出处**，而且盒里的服务真的按它走"
  # ══════════════════════════════════════════════════════════════════
  # ⚠️ 为什么单立一条（2026-09-21 真机当场栽的）：这条规则我先写在**入口**里，
  #    而**入口是镜像里生成的东西**（不属于产品层）⇒ 那次改动**根本没生效**：
  #    盒里那个服务的 env 还是旧的 tmpfs 路径，而 put-key 按新规则写进了卷里 ——
  #    "放钥匙的说放好了、用钥匙的还在看 tmpfs"。
  #    ⇒ 规矩：规则住**产品层**、**只有一处**（`src/key-path.mjs`）。
  if [ "$(grep -rl 'export function keyFileFor' "$CORE/src" | wc -l)" = "1" ] \
    && grep -q 'export function keyFileFor' "$CORE/src/key-path.mjs"; then
    ok "规则只有一处出处：src/key-path.mjs（产品层能改的东西）"
  else
    bad "🔴 keyFileFor 不止一处定义（漂了就会出现"放好了但没用上"）"
  fi
  # 🔴 旧的 tmpfs 路径**不许**再出现在任何**非注释行**里（那是"写回一个重建就没的地方"）
  # ⚠️ 检查器**写成一个函数**，好让负向对照喂它一个坏样本（不然那条对照是空的）。
  LEGACY='run/hupo/creds'
  check_no_legacy() {  # $1 = "文件:行号:内容" 那种文本；**只放行注释行**
    local hits
    hits="$(grep -n "$LEGACY" <<<"$1" 2>/dev/null | grep -vE ':[[:space:]]*//|:[[:space:]]*\*' || true)"
    [ -z "$hits" ]
  }
  if check_no_legacy "$(grep -rn "$LEGACY" "$CORE/src" 2>/dev/null | grep -v 'key-path.mjs' || true)"; then
    ok "产品层里**没有**地方再认那个 tmpfs 路径（非注释行）"
  else
    bad "🔴 还有代码认 tmpfs 那条老路：$(grep -rn "$LEGACY" "$CORE/src" | grep -v key-path.mjs | head -2 | cut -c1-90)"
  fi
  # 负向对照：喂一个**坏的**样本 ⇒ 必须抓得住；再喂一个注释样本 ⇒ 必须放行
  if check_no_legacy "x.js:9:  keyFile = process.env.HUPO_KEY_FILE ?? '/run/hupo/creds.yaml',"; then
    bad "🔴 负向对照没抓住：认旧路径的那种写法被判成干净"
  else
    ok "负向对照：认旧路径的写法 ⇒ 判据抓得住"
  fi
  if check_no_legacy "x.js:9:// 原来住在 /run/hupo/creds.yaml，后来搬了"; then
    ok "正对照：**注释里提到**旧路径 ⇒ 放行（不然没人敢写这段历史）"
  else
    bad "🔴 连注释里提一句都算脏 —— 那样闸会被绕开"
  fi
  # 🔴 **谁也不许再读那条旧 env**（2026-09-21 真机连栽两层）：
  #    第一层是规则写在镜像里的入口里（发布带不动）；第二层是 `tenant-shell` 的
  #    写入路径由**入口传进来**，而入口传的是镜像里那条旧 env
  #    ⇒ 容器日志说"拿到凭据了"，而**卷里没有那个文件**。
  #    ⇒ 闸：`HUPO_KEY_FILE` 这个名字在产品层与入口里**一次都不许出现**（注释除外）。
  OLD_ENV='HUPO_KEY_FILE'
  hits2="$(grep -rn "$OLD_ENV" "$CORE/src" "$ROOT/scripts/build-tenant-image.sh" 2>/dev/null \
    | grep -vE ':[[:space:]]*//|:[[:space:]]*\*' | grep -v 'key-path.mjs' || true)"
  if [ -z "$hits2" ]; then
    ok "没人再读那条旧 env（$OLD_ENV）—— 只有一个出处：key-path.mjs"
  else
    bad "🔴 还有地方读 $OLD_ENV：$(head -2 <<<"$hits2" | cut -c1-90)"
  fi
  # 🔴 **归一必须写在函数体里**（2026-09-21 真机栽的第三层）：
  #    默认值**只在参数是 `undefined` 时**生效，而镜像里的旧入口是**显式**传坏值 ——
  #    只改默认值等于没改（现象：容器日志说"拿到凭据了"，卷里却没有那个文件）。
  n_norm="$(grep -c 'keyFile = adoptKeyFile(keyFile)' "$CORE/src/tenant-shell.mjs" || true)"
  if [ "${n_norm:-0}" -ge 2 ]; then
    ok "归一写在**函数体里**（两个函数的默认值被显式传参绕过也不怕）"
  else
    bad "🔴 只改了默认值（$n_norm 处归一）—— 显式传坏值时会绕过它"
  fi
  # ★ **盒里真解析一遍**：那个跑着的服务按这条规则会去看哪个文件
  RESOLVED="$("$PODMAN" exec "$NAME" /bin/node -e '
    import("/app/code/src/key-path.mjs").then((m) => { process.stdout.write(m.keyFileFor()); });' 2>/dev/null)"
  if [ "$RESOLVED" = "/data/creds.yaml" ]; then
    ok "盒里那个服务按规则看的是 $RESOLVED（**就是刚才放钥匙的地方**）"
  else
    bad "🔴 盒里解析出来是「$RESOLVED」—— 放钥匙和用钥匙不是同一个地方"
  fi
  # 而且**真的**用得上：那个文件在、而且不是 tmpfs
  if "$PODMAN" exec "$NAME" /bin/node -e 'process.exit(require("node:fs").existsSync("/data/creds.yaml")?0:1)' 2>/dev/null; then
    ok "放进去的那把**就在它要读的地方**（不是「放好了、读的却是另一个文件」）"
  else
    bad "🔴 它要读的那个文件不在"
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据五/六：投递那条路（认名字 + **送到才删**）"
  # ══════════════════════════════════════════════════════════════════
  # 这一半是**纯逻辑**，单测里已经逐条钉过（`test/key-drop.test.js`）；
  # 这里跑一遍那组单测，保证"判据红=真坏"，而不是"判据自己写错了"。
  if (cd "$CORE" && "$NODE" --test test/key-drop.test.js >"$T/kd.txt" 2>&1); then
    ok "投递那套单测全绿（$(sed -n 's/^ℹ pass //p' "$T/kd.txt") 条：认名字 / 留证据 / 送到才删）"
  else
    bad "🔴 投递那套单测没过：$(tail -4 "$T/kd.txt")"
  fi
  # 🔴 负向对照：判据**自己**也得能抓"没送到就删"那种写法
  if grep -q 'd.confirmed' "$CORE/test/key-drop.test.js" && grep -q '必须还在' "$CORE/test/key-drop.test.js"; then
    ok "负向对照在：那条单测**真的**在确认之前查了文件还在"
  else
    bad "🔴 那条单测没在验"送到才删""
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据七：**钥匙不进日志**（日志是这套东西最容易漏的地方）"
  # ══════════════════════════════════════════════════════════════════
  # 判据自己合成一条"带钥匙的日志"，拿检查器去照 —— 检查器必须红。
  check_no_key_in_log() { ! grep -qE 'sk-[A-Za-z0-9_-]{8,}' <<<"$1"; }
  if check_no_key_in_log "  🔑 u1 的模型凭据已收下（送给他那台容器；中心不留）"; then
    ok "检查器：干净的那句 ⇒ 放行"
  else
    bad "🔴 检查器把干净的那句也判成脏了"
  fi
  if check_no_key_in_log "  🔑 u1 的模型凭据已收下：sk-abcdefgh12345678"; then
    bad "🔴 检查器抓不住日志里的钥匙"
  else
    ok "负向对照：带钥匙的那句 ⇒ 抓得住"
  fi
  # 拿它去照**真日志**（有就说明真漏了）
  HITS=0
  for f in "$CORE/serve.log" "$ROOT/serve.log" /srv/hupo/tenant-code/ledger.jsonl; do
    [ -f "$f" ] || continue
    grep -qE 'sk-[A-Za-z0-9_-]{8,}' "$f" && { HITS=$((HITS + 1)); bad "🔴 $f 里出现了像钥匙的东西"; }
  done
  [ "$HITS" = "0" ] && ok "真日志与账本里**没有**钥匙（扫了 serve.log 与 ledger.jsonl）"
}

# ⚠️ **以 root 跑的时候：便携那段交给 deploy**（rootless podman 的镜像在他存储里，
#    root 跑 `podman image exists` 会得到"没有这个镜像" ⇒ 一串假红）。
if [ "$(id -u)" = "0" ] && [ "${HUPO_CHECK_PART:-}" != "portable" ]; then
  echo "（便携那一段交给 deploy 跑；root 只做下面真机那一眼）"
  sudo -u deploy -H env HUPO_CHECK_PART=portable NODE_BIN="$NODE" bash "$0"
  RC_PORTABLE=$?
else
  portable_part
  if [ "${HUPO_CHECK_PART:-}" = "portable" ]; then
    echo
    echo "──────────────────────────────"
    if [ "$fail" = "0" ]; then
      echo "✅ 全过（过 $pass、跳过 $skipped）"
      exit 0
    fi
    echo "✗ 没过 $fail 条（过 $pass、跳过 $skipped）"
    exit 1
  fi
fi

if [ "$LIVE" = "1" ]; then
  echo "── 真机器那一眼（只读）"
  if [ "$(id -u)" != "0" ]; then
    bad "--live 要 root（要看租户容器里的那个文件）"
  else
    CODE_DIR="${HUPO_CODE_ROOT:-/srv/hupo/tenant-code}/current"
    if [ -L "$CODE_DIR" ]; then ok "当前产品层：$(readlink -f "$CODE_DIR")"; else bad "真机器上没有 current 软链"; fi
    for t in hupo-a hupo-b; do
      id "$t" >/dev/null 2>&1 || { skip "$t 不在"; continue; }
      if ! cd /tmp || ! sudo -u "$t" -H env XDG_RUNTIME_DIR="/run/user/$(id -u "$t")" podman container exists "hupo-tenant-$t" 2>/dev/null; then
        skip "$t 现在没有在跑的容器"
        continue
      fi
      key="$(cd /tmp && sudo -u "$t" -H env XDG_RUNTIME_DIR="/run/user/$(id -u "$t")" podman exec "hupo-tenant-$t" /bin/node -e '
        const fs=require("node:fs"); const p="/data/creds.yaml";
        try { const s=fs.statSync(p); process.stdout.write(`${s.uid}:${(s.mode&0o777).toString(8)}`); }
        catch { process.stdout.write("none"); }' 2>/dev/null)"
      case "$key" in
        0:600) ok "$t：钥匙在卷里（0:600）" ;;
        none)  ok "$t：现在没有钥匙（也对 —— 主人还没投/网页上还没填）" ;;
        *)     bad "🔴 $t 的钥匙文件不对劲：$key" ;;
      esac
      # 🔴 **边界那一条要真验**，而且**只在本来没有钥匙时才动它**（有真钥匙就绝不碰）：
      #    没有 ⇒ 先放一把假的、验完删掉（**恢复原状**）；有 ⇒ 直接读（不许覆盖主人的钥匙）。
      MADE=0
      if [ "$key" = "none" ]; then
        printf 'sk-judge-live-%s\n' "$(date +%s)" | (cd /tmp && sudo -u "$t" -H env XDG_RUNTIME_DIR="/run/user/$(id -u "$t")" \
          podman exec -i "hupo-tenant-$t" /bin/node /app/code/src/put-key.mjs) >/dev/null 2>&1
        MADE=1
      fi
      ro="$(cd /tmp && sudo -u "$t" -H env XDG_RUNTIME_DIR="/run/user/$(id -u "$t")" podman exec --user 1000 "hupo-tenant-$t" /bin/node -e '
        try { require("node:fs").readFileSync("/data/creds.yaml"); console.log("READABLE"); }
        catch (e) { console.log(e.code); }' 2>/dev/null | tail -1)"
      if [ "$ro" = "EACCES" ]; then
        ok "  🔴 agent 读它 ⇒ EACCES（真机上也没塌${MADE:+，而且是拿一把临时的验的}）"
      else
        bad "🔴 真机上 agent 的读结果是：$ro"
      fi
      # ⚠️ 验完**恢复原状**（临时那把删掉 —— 主人的钥匙一个字节都没碰过）
      if [ "$MADE" = "1" ]; then
        cd /tmp && sudo -u "$t" -H env XDG_RUNTIME_DIR="/run/user/$(id -u "$t")" podman exec "hupo-tenant-$t" \
          /bin/node -e 'try{require("node:fs").unlinkSync("/data/creds.yaml")}catch{}' >/dev/null 2>&1
        ok "  验完把临时那把删掉了（恢复原状）"
      fi
    done
  fi
fi

echo
echo "──────────────────────────────"
if [ "$fail" = "0" ] && [ "${RC_PORTABLE:-0}" = "0" ]; then
  echo "✅ 全过（真机那一眼：过 $pass、跳过 $skipped；便携那段见上面）"
  [ "$skipped" != "0" ] && echo "⚠️ **有跳过的**（上面写了）—— 跳过的**不是**过的。"
  exit 0
fi
echo "✗ 没过（真机那一眼没过 $fail 条；便携那段退出码 ${RC_PORTABLE:-0}）"
exit 1
