#!/usr/bin/env bash
# 造**产品层**（契约 `docs/dev/45-TENANT-UPDATE.md`）。
#
# 用法：
#   bash scripts/build-tenant-code.sh                 # 造一份新的（不翻转）
#   bash scripts/build-tenant-code.sh --verify [指纹] # 拿一次性容器真跑一遍，要它自己报这个指纹
#   bash scripts/build-tenant-code.sh --publish [指纹]# 翻 current（记账一行）
#   bash scripts/build-tenant-code.sh --list          # 有哪些版本、现在是哪个
#   bash scripts/build-tenant-code.sh --rollback 指纹 # 翻回某一版（也记账）
#   bash scripts/build-tenant-code.sh --prune --yes   # 只留 current 与上一版（默认只看）
#   bash scripts/build-tenant-code.sh --current       # 只打印当前指纹（给别处读）
#
# ── 它是什么 ────────────────────────────────────────────────
#   产品（调度器 `src/` + 人格 + 能力 + 代理 patch）**从镜像里搬出来**，
#   住进宿主上一个目录，**只读挂进容器** `/app/code`。
#   ⇒ 改进产品 = **写文件 + 让容器重开一次**，不用重造 404 MB 镜像、
#     不用 `podman load`、不用重建容器、**不需要 root**。
#
# ── 四条纪律 ────────────────────────────────────────────────
#   ① 🔴 **翻转之前先证明这一版起得来**（`--verify` 真跑一个容器）。
#      没有它，一次手滑就是**所有租户的助手一起起不来** ——
#      2026-09-21 我已经把自己的服务这样送死过两次。
#   ② **每次翻转记账**（`ledger.jsonl` 一行，写清 from/to/为什么/谁）——
#      主人拍板"归 deploy、可以自己翻转"时点名的就是这一条。
#   ③ **指纹只由内容决定**：同一份内容两次算出来必须**一模一样**；
#      改一个字节必须变。算它的地方**只有这一处**。
#   ④ **回滚用的旧版本不许顺手删**（删是显式的 `--prune`）——
#      删掉的那一刻，"翻回去"这条路就没了。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# ⚠️ `HUPO_CORE` 是给**判据**用的：它要拿一份**改过一两个字节的副本**去验
#    "内容变了指纹必须变"（不许为了测这个去动真仓库）。
CORE="${HUPO_CORE:-$ROOT/v2/services/core}"
CODE_ROOT="${HUPO_CODE_ROOT:-/srv/hupo/tenant-code}"
IMG="${HUPO_TENANT_IMAGE:-localhost/hupo-tenant:local}"
PODMAN="${PODMAN_BIN:-/usr/bin/podman}"
NODE="${NODE_BIN:-$(command -v node || true)}"

# ⚠️ **产品层要装哪几样**：只有这一处名单。
#    加东西要同时想清楚"它是不是按人不同的" —— 按人不同的东西**不许**放进来
#    （那会把"改一次"变成"改 N 次"，而且没有一处能看全）。契约 §四。
INPUTS=(src package.json hupo-persona.yml hupo-capabilities.yml hupo-model-proxy.yml)

say()  { echo "  $1"; }
plan() { echo "▶ $1"; }
bad()  { echo "✗ $1" >&2; }

MODE=build
FP=""
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --verify)   MODE=verify; FP="${2:-}"; shift ;;
    --publish)  MODE=publish; FP="${2:-}"; shift ;;
    --rollback) MODE=rollback; FP="${2:-}"; shift ;;
    --list)     MODE=list ;;
    --prune)    MODE=prune ;;
    --current)  MODE=current ;;
    --yes)      YES=1 ;;
    --root)     CODE_ROOT="$2"; shift ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
    *) bad "不认识的参数：$1"; exit 2 ;;
  esac
  shift
done

[ -n "$NODE" ] && [ -x "$NODE" ] || { bad "找不到 node"; exit 2; }
[ -d "$CORE" ] || { bad "找不到 $CORE"; exit 2; }

# ── 目录（**一次性由 root 建**：`/srv` 是 root 的）────────────────
#   ⚠️ 为什么不自己 `install -d`：`deploy` **建不了 `/srv/hupo`**（那是 root 的）。
#      建它那一步在 `create-tenant-pool.sh --yes`（root）里 —— 那是"把机器准备好给租户容器"
#      的同一件事，放一起才不会漏。
if [ ! -d "$CODE_ROOT" ]; then
  bad "没有 $CODE_ROOT —— 它要 root 建一次："
  echo "    sudo bash $ROOT/scripts/create-tenant-pool.sh --yes" >&2
  echo "  或（只建目录）：" >&2
  echo "    sudo install -d -o $(id -un) -g $(id -gn) -m 0755 $CODE_ROOT" >&2
  exit 2
fi
LEDGER="$CODE_ROOT/ledger.jsonl"
LAST="$CODE_ROOT/.last"

# ── 指纹 + 拷贝（一个 node 小脚本做完，免得"复制一份名单"）──────
fp_calc() {  # fp_calc <目标目录>  → 打印 {fingerprint, files:[...]}
  "$NODE" - "${CORE}" "$@" <<'JS'
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeCrypto from 'node:crypto';
// argv: [node, core, ...inputs]
const [core, ...inputs] = process.argv.slice(2);
const files = [];
const walk = (p, rel) => {
  const st = nodeFs.statSync(p);
  if (st.isDirectory()) {
    for (const e of nodeFs.readdirSync(p).sort()) walk(nodePath.join(p, e), `${rel}/${e}`);
  } else {
    files.push([rel, p]);
  }
};
for (const i of inputs) {
  const p = nodePath.join(core, i);
  if (!nodeFs.existsSync(p)) continue;
  walk(p, i);
}
files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
// ⚠️ **每个文件先算 32 字节摘要，再把摘要串起来** —— 不是"路径+内容直接拼"：
//    后者在内容里出现 `\0` 时理论上能撞（"两个不同的输入同一个指纹"）。
const h = nodeCrypto.createHash('sha256');
for (const [rel, p] of files) {
  h.update(Buffer.from(rel, 'utf8'));
  h.update(nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(p)).digest());
}
process.stdout.write(JSON.stringify({ fingerprint: h.digest('hex').slice(0, 12), files: files.map((f) => f[0]) }));
JS
}

if [ "$MODE" = "build" ]; then
  MAN="$(fp_calc "${INPUTS[@]}")" || { bad "算指纹失败"; exit 3; }
  FP="$("$NODE" -e 'process.stdout.write(JSON.parse(process.argv[1]).fingerprint)' "$MAN")"
  NFILES="$("$NODE" -e 'process.stdout.write(String(JSON.parse(process.argv[1]).files.length))' "$MAN")"
  DEST="$CODE_ROOT/$FP"
  echo "── 产品层 ──────────────────────────────────────"
  say "输入：${INPUTS[*]}（$NFILES 个文件）"
  say "指纹：$FP"
  if [ -d "$DEST" ] && [ -f "$DEST/manifest.json" ]; then
    say "这一版已经在了：$DEST（内容相同 ⇒ 同一个指纹，**不用重造**）"
  else
    plan "拷进 $DEST"
    rm -rf "$DEST"
    mkdir -p "$DEST"
    # 只拷名单里那几样（**不是**整个 CORE：那里有 test/、data/、node_modules/）
    for i in "${INPUTS[@]}"; do
      [ -e "$CORE/$i" ] || { bad "缺 $CORE/$i"; rm -rf "$DEST"; exit 3; }
      cp -r "$CORE/$i" "$DEST/$i"
    done
    # 🔴 **agent（uid 1000）必须读得到**（2026-09-21 真机栽过：`cp` 把 600 带进去 ⇒
    #    dsh 开机读 `--patch` 那两份 yml 直接 EACCES 退掉，现象只是"它不理我"）。
    #    ⚠️ 这里没有秘密：key 是运行时才进容器 tmpfs 的，**不在产品层**。
    chmod -R a+rX "$DEST"
    "$NODE" -e '
      const fs = require("node:fs");
      const [dest, fp, n, inputs, gitRev] = process.argv.slice(1);
      fs.writeFileSync(`${dest}/manifest.json`, JSON.stringify({
        fingerprint: fp, builtAt: new Date().toISOString(), gitRev,
        inputs: inputs.split(","), files: Number(n),
      }, null, 2) + "\n");
    ' "$DEST" "$FP" "$NFILES" "$(IFS=,; echo "${INPUTS[*]}")" "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    chmod a+r "$DEST/manifest.json"
    rm -f "$DEST/src/mcp-ledger-server.mjs.orig" 2>/dev/null || true
    say "造好了"
  fi
  printf '%s\n' "$FP" > "$LAST"
  echo
  echo "下一步（**顺序别换**）："
  echo "  ① 先证明它起得来：bash $0 --verify $FP"
  echo "  ② 再翻转（记账一行）：bash $0 --publish $FP"
  exit 0
fi

# ── 读当前 ────────────────────────────────────────────────
current_fp() { readlink "$CODE_ROOT/current" 2>/dev/null | sed 's|.*/||'; }

if [ "$MODE" = "current" ]; then
  current_fp; exit 0
fi

if [ "$MODE" = "list" ]; then
  CUR="$(current_fp)"
  echo "── 产品层版本（$CODE_ROOT）──────────────"
  for d in "$CODE_ROOT"/*/; do
    [ -f "$d/manifest.json" ] || continue
    v="$(basename "$d")"
    when="$("$NODE" -e 'try{process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).builtAt)}catch{}' "$d/manifest.json" 2>/dev/null)"
    mark=" "; [ "$v" = "$CUR" ] && mark="←"
    echo "  $mark $v  $when"
  done
  echo "  当前：${CUR:-（没有）}"
  exit 0
fi

# ── 翻转（publish / rollback）──────────────────────────────
flip() {  # flip <指纹> <why>
  local to="$1" why="$2" from
  from="$(current_fp)"
  [ -d "$CODE_ROOT/$to" ] || { bad "没有这一版：$to"; return 2; }
  [ -f "$CODE_ROOT/$to/manifest.json" ] || { bad "$to 没有 manifest.json"; return 2; }
  if [ "$to" = "$from" ]; then
    say "current 已经是 $to —— 什么都不用做（**记账也不记**：没发生的事不记账）"
    return 0
  fi
  # ⚠️ **原子换**：先建 `current.new` 再 `mv -T` ——
  #    直接 `ln -sfn` 会先 unlink 再建，中间那一瞬间 `current` **不存在**，
  #    而那一刻正好有容器重开的话，它挂一个不存在的路径 ⇒ 起不来。
  ln -sfn "$CODE_ROOT/$to" "$CODE_ROOT/.current.new"
  mv -T "$CODE_ROOT/.current.new" "$CODE_ROOT/current"
  say "current：${from:-（无）} → $to"
  # 记账（主人点名的"每次都记账"）
  # ⚠️ **一次 node 调用写一行真 JSON**（2026-09-21 判据抓出来的）：
  #    原来是"内层 node 打出 JSON 字符串、外层再 `JSON.stringify` 一次" ——
  #    于是账本里存的是**一个装着 JSON 的字符串**（`"{\"at\":…}"`），
  #    人看着差不多、读它的程序全读不出来。⇒ 别嵌套，直接一次写完。
  "$NODE" -e '
    const fs = require("node:fs");
    const [f, from, to, why, by] = process.argv.slice(1);
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), from: from || null, to, why, by }) + "\n");
  ' "$LEDGER" "$from" "$to" "$why" "$(id -un)"
  say "记了一行账：$LEDGER"
}

if [ "$MODE" = "publish" ] || [ "$MODE" = "rollback" ]; then
  [ -n "$FP" ] || FP="$(cat "$LAST" 2>/dev/null || true)"
  [ -n "$FP" ] || { bad "没说翻到哪一版，而且 $LAST 里也没有（先跑一次不带参数的）"; exit 2; }
  echo "── 翻转 ────────────────────────────────────────"
  flip "$FP" "$MODE" || exit 3
  echo
  echo "  容器会**自己在空闲时**重开一次（宿主发现指纹不同就会叫它）——"
  echo "  不用你重启任何东西，也**不许**用 root 去动别人的容器。"
  exit 0
fi

# ── 真跑一遍（--verify）────────────────────────────────────
if [ "$MODE" = "verify" ]; then
  [ -n "$FP" ] || FP="$(cat "$LAST" 2>/dev/null || true)"
  [ -n "$FP" ] || FP="$(current_fp)"
  DEST="$CODE_ROOT/$FP"
  [ -d "$DEST" ] || { bad "没有这一版：${FP:-（空）}"; exit 2; }
  [ -x "$PODMAN" ] || { bad "找不到 $PODMAN"; exit 2; }
  command -v curl >/dev/null || { bad "找不到 curl"; exit 2; }

  echo "── 验这一版起得来（真跑一个容器）──────────────"
  say "候选：$DEST"
  # ⚠️ 端口挑一个**没在听**的：写死一个口，第二次跑就会撞（而那时候报的是
  #    "起不来"，看起来像产品层坏了 —— 一句指错方向的话比不说更费时间）。
  PORT=""
  for p in $(seq 18092 18120); do
    ss -ltn 2>/dev/null | grep -q ":$p " || { PORT="$p"; break; }
  done
  [ -n "$PORT" ] || { bad "找不到空闲端口（18092-18120）"; exit 3; }
  DATA="$(mktemp -d)"
  NAME="hupo-codecheck-$$"
  say "容器名 $NAME · 口 127.0.0.1:$PORT · 数据 $DATA"
  # 能力那几条与真容器**逐字一致**（`scripts/check-tenant-update.sh` 有一条闸盯着这四处）
  "$PODMAN" run -d --rm --name "$NAME" \
    -p "127.0.0.1:$PORT:8080" -v "$DATA:/data" -v "$DEST:/app/code:ro" \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
    --tmpfs /run/hupo:rw,nosuid,nodev,mode=0700 \
    --security-opt=no-new-privileges \
    --cap-drop=ALL \
    --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID --cap-add=FOWNER \
    --pids-limit=512 --memory=768m --memory-swap=768m \
    --env HUPO_CODE_DIR=/app/code \
    "$IMG" >/dev/null || { bad "容器起不来"; rm -rf "$DATA"; exit 3; }

  GOT=""
  for _ in $(seq 1 30); do
    GOT="$(curl -s "http://127.0.0.1:$PORT/api/version" 2>/dev/null \
      | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).buildId??""))}catch{}})' || true)"
    [ -n "$GOT" ] && break
    sleep 0.5
  done
  echo "  它自报的指纹：${GOT:-（没起来）}"
  echo "  正对照（挂载真只读）：$(  "$PODMAN" exec "$NAME" /bin/node -e 'try{require("node:fs").writeFileSync("/app/code/canary","x");console.log("🔴 写得进去 —— 挂载不是只读")}catch(e){console.log("✅ 【"+e.code+"】")}' 2>/dev/null )"
  # ⚠️ **负对照在别处**：拿一个**旧镜像**跑同一段（那时它报的是 `dev`）——
  #    那一条才证明"这个指纹是**这个挂载**带进去的"。
  #    这里只顺手证明**挂载真挂上了**（读得到那一版的 manifest）。
  echo "  挂载真挂上了吗：$( "$PODMAN" exec "$NAME" /bin/node -e 'const m=JSON.parse(require("node:fs").readFileSync("/app/code/manifest.json","utf8"));process.stdout.write(m.fingerprint)' 2>/dev/null | head -c 20 )"
  "$PODMAN" kill "$NAME" >/dev/null 2>&1
  rm -rf "$DATA"

  if [ "$GOT" = "$FP" ]; then
    echo "✅ 这一版起得来，而且**自己报的就是 $FP**"
    exit 0
  fi
  bad "它报的是「${GOT:-（空）}」，不是「$FP」—— **不许翻转**"
  echo "  （要么镜像还不认 HUPO_CODE_DIR（镜子太旧），要么这一版起不来。两条都要先弄清楚。）" >&2
  exit 4
fi

# ── 收拾（--prune）────────────────────────────────────────
if [ "$MODE" = "prune" ]; then
  CUR="$(current_fp)"
  # 上一版 = 账本里最后一次"翻到当前这一版"之前的 from（回滚目标）
  # ⚠️ **按时间顺序读**（账本是追加的）：找"最后一次翻到当前这一版之前是哪一版"，
  #    那就是回滚目标。**不许 sort** —— 排完序就不是时间顺序了。
  PREV="$("$NODE" -e '
    const fs = require("node:fs");
    const [f, cur] = process.argv.slice(1);
    let out = "";
    let text = "";
    try { text = fs.readFileSync(f, "utf8"); } catch { process.stdout.write(""); process.exit(0); }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let l; try { l = JSON.parse(line); } catch { continue; }
      if (l.to === cur && l.from) out = l.from;
    }
    process.stdout.write(out);
  ' "$LEDGER" "$CUR" 2>/dev/null || true)"
  echo "── 收拾 ────────────────────────────────────────"
  say "要留：current=${CUR:-（无）} 上一版=${PREV:-（无）}"
  KEEP="$CUR $PREV"
  RM=()
  for d in "$CODE_ROOT"/*/; do
    [ -f "$d/manifest.json" ] || continue
    v="$(basename "$d")"
    case " $KEEP " in *" $v "*) say "留 $v" ;; *) RM+=("$v") ;; esac
  done
  if [ "${#RM[@]}" = "0" ]; then say "没有要删的"; exit 0; fi
  for v in "${RM[@]}"; do plan "删 $CODE_ROOT/$v"; done
  if [ "$YES" != "1" ]; then
    echo
    echo "⚠️ 只看。真删：加 --yes"
    echo "⚠️ 还在跑旧版的容器，删掉它挂的那一版之后**一重启就会起不来** ——"
    echo "   先确认没有谁还在旧版上（宿主会如实报每台的指纹）。"
    exit 0
  fi
  for v in "${RM[@]}"; do rm -rf "$CODE_ROOT/$v"; say "删了 $v"; done
  exit 0
fi

bad "没选做事的方式"; exit 2
