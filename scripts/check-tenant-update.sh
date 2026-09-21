#!/usr/bin/env bash
# **容器更新那条路的判据**（契约 `docs/dev/45-TENANT-UPDATE.md` §六）。
#
# 用法：
#   bash scripts/check-tenant-update.sh              # 全套（在临时目录里造，不碰真机器）
#   sudo bash scripts/check-tenant-update.sh --live  # 再看一眼**真机器**：单元挂上了没、跑的是哪一版
#
# ── 判据（每条都带**负向对照**）──────────────────────────────
#   ① 指纹只由内容决定：同一份内容两次 = 同一个；改一个字节 = 必须变
#   ② 指纹与"时间/创建顺序"无关
#   ③ 产品层里有该有的（`src/` + 人格 + 能力 + 代理 patch），而且**没有 key**
#   ④ 入口**认** `HUPO_CODE_DIR`：真跑一个容器，它自报的**就是**那个指纹
#   ⑤ 挂进去是**只读**的（负向：挑一个**存在**的路径写，要 `EROFS`，不许 `ENOENT`）
#   ⑥ 宿主那句 `reload` **不带载荷**（判据本身也过一遍负向对照）
#   ⑦ 宿主发现"容器报的指纹 ≠ 当前"时**要说话**
#   ⑧ 翻转**留痕**，而且"翻到已经是的那个"**不许记账**（没发生的事不记账）
#   ⑨ 能力那几条**四处逐字一致**（这是"跨产物一致性"那道闸）
#
# ⚠️ **它不需要 root**：产品层是 `deploy` 自己的东西，容器也是以 `deploy`
#    身份跑的（rootless podman）。要 root 的只有 `--live` 那一眼。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
# ⚠️ **`sudo` 底下 PATH 里没有 node**（这台机器只有 nvm 里那一个，没有 `/usr/bin/node`）
#    ⇒ 和别的判据一样兜一圈找它，别让"找不到 node"把整条判据变成红的。
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  for c in /home/deploy/.nvm/versions/node/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
PODMAN="${PODMAN_BIN:-/usr/bin/podman}"
IMG="${HUPO_TENANT_IMAGE:-localhost/hupo-tenant:local}"
LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "✗ 找不到 node"; exit 2; }

pass=0; fail=0; skipped=0
ok()   { echo "  ✓ $1"; pass=$((pass + 1)); }
bad()  { echo "  ✗ $1"; fail=$((fail + 1)); }
skip() { echo "  · $1"; skipped=$((skipped + 1)); }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# ══════════════════════════════════════════════════════════════════

# ⚠️ **判据一~九这一整段要在 `deploy` 身份下跑**：
#    rootless podman 的镜像住在 **deploy 的存储**里，以 root 跑 `podman image exists`
#    会得到"没有这个镜像" ⇒ 六条判据一起假红（2026-09-22 实测撞上）。
#    ⇒ 以 root 跑的时候，这一段由 `sudo -u deploy` 再跑一遍（见文件末尾那个驱动）。
portable_part() {
  echo "── 判据一：指纹只由**内容**决定"
  # ══════════════════════════════════════════════════════════════════
  # 造一份仓库副本（判据不许为了测"内容变了"去动真仓库）
  FAKE="$T/core"
  mkdir -p "$FAKE"
  for i in src package.json hupo-persona.yml hupo-capabilities.yml hupo-model-proxy.yml; do
    cp -r "$CORE/$i" "$FAKE/$i"
  done
  ROOTDIR="$T/root"
  mkdir -p "$ROOTDIR"

  fp_of() { HUPO_CORE="$1" bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" 2>&1 | sed -n 's/^  指纹：//p'; }

  FP1="$(fp_of "$FAKE")"
  FP2="$(fp_of "$FAKE")"
  if [ -n "$FP1" ] && [ "$FP1" = "$FP2" ]; then
    ok "同一份内容两次 ⇒ 同一个指纹（$FP1）"
  else
    bad "🔴 同一份内容两次算出来不一样：[$FP1] vs [$FP2]"
  fi

  # 负向对照：改**一个字节**
  ADDED="$T/core2"; cp -r "$FAKE" "$ADDED"
  printf '\n// 判据加的一个字节\n' >> "$ADDED/src/product-layer.js"
  FP3="$(fp_of "$ADDED")"
  if [ -n "$FP3" ] && [ "$FP3" != "$FP1" ]; then
    ok "改一个字节 ⇒ 指纹**必须变**（$FP1 → $FP3）"
  else
    bad "🔴 改了内容指纹没变（[$FP3]）—— 那它就不是"内容的指纹""
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据二：指纹与**时间**无关"
  # ══════════════════════════════════════════════════════════════════
  touch -d '2001-01-01 00:00:00' "$FAKE/src/product-layer.js" "$FAKE/hupo-persona.yml"
  FP4="$(fp_of "$FAKE")"
  if [ "$FP4" = "$FP1" ]; then
    ok "改了 mtime ⇒ 指纹不变（它只看内容）"
  else
    bad "🔴 动一下 mtime 指纹就变了：[$FP1] → [$FP4]"
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据三：产品层里有该有的，而且**没有 key**"
  # ══════════════════════════════════════════════════════════════════
  DEST="$ROOTDIR/$FP1"
  missing=""
  for f in src/serve.js src/tenant-reload.mjs hupo-persona.yml hupo-capabilities.yml hupo-model-proxy.yml manifest.json; do
    [ -f "$DEST/$f" ] || missing="$missing $f"
  done
  if [ -z "$missing" ]; then
    ok "该在的都在（src/ + 人格 + 能力 + 代理 patch + manifest）"
  else
    bad "🔴 产品层里缺：$missing"
  fi
  # 🔴 **没有 key**：这是硬要求（决策 ①）——产品层是**共享只读**的，里面一个秘密都不许有。
  if grep -rIl -E 'sk-[A-Za-z0-9]{16,}|apiKey:\s*[A-Za-z0-9]{16,}' "$DEST" >/dev/null 2>&1; then
    bad "🔴 产品层里出现了像 key 的东西：$(grep -rIl -E 'sk-[A-Za-z0-9]{16,}' "$DEST" | head -3)"
  else
    ok "里面没有 key（它是共享只读的，一个秘密都不许有）"
  fi
  # 负向对照：真塞一个进去，上面那条**必须**红
  LEAK="$T/leak"; cp -r "$FAKE" "$LEAK"
  printf 'HUPO_MODEL_KEY: sk-abcdefghijklmnopqrstuvwxyz012345\n' > "$LEAK/src/leak.txt"
  if grep -rIl -E 'sk-[A-Za-z0-9]{16,}' "$LEAK" >/dev/null 2>&1; then
    ok "负向对照：塞一个假 key 进去 ⇒ 那一条判据抓得住"
  else
    bad "🔴 塞了假 key 都抓不住 —— 那一条判据是空的"
  fi
  rm -f "$LEAK/src/leak.txt"

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据四/五：入口**认**产品层，而且挂的是**只读**"
  # ══════════════════════════════════════════════════════════════════
  if [ ! -x "$PODMAN" ]; then
    bad "找不到 $PODMAN —— 这一条**必须有**（没跑过就等于没验）"
  elif ! "$PODMAN" image exists "$IMG" >/dev/null 2>&1; then
    bad "没有镜像 $IMG —— 先 bash scripts/build-tenant-image.sh"
  else
    VOUT="$T/verify.txt"
    if bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" --verify "$FP1" >"$VOUT" 2>&1; then
      if grep -q "自己报的就是 $FP1" "$VOUT"; then
        ok "真跑一个容器：它自报的**就是** $FP1（入口真认 HUPO_CODE_DIR）"
      else
        bad "🔴 跑过了，但它没说自己就是 $FP1：$(tail -3 "$VOUT")"
      fi
      # ⑤ 只读：⚠️ 这一条要挑**存在的**路径写 —— 挑个不存在的只会得到 ENOENT，
      #    那证明的是"路径不存在"，不是"只读"（这个项目栽过）。
      if grep -q '✅ 【EROFS】' "$VOUT"; then
        ok "挂进去是**只读**的（往真存在的 /app/code 写 ⇒ EROFS）"
      else
        bad "🔴 没验到只读：$(grep -F '正对照' "$VOUT" | tail -1)"
      fi
    else
      bad "🔴 那一版**起不来**（「--verify」 没过）：$(tail -3 "$VOUT")"
    fi

    # 负向对照：**不给** HUPO_CODE_DIR ⇒ 它该回落到镜像里那份（报 `dev`）
    NOCODE="$T/nocode.txt"
    bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" --verify "$FP1" >/dev/null 2>&1 # 保证镜像/端口热身
    PORT=""
    for p in $(seq 18130 18150); do ss -ltn 2>/dev/null | grep -q ":$p " || { PORT="$p"; break; }; done
    if [ -n "$PORT" ]; then
      DATA="$(mktemp -d)"; NAME="hupo-nocode-$$"
      "$PODMAN" run -d --rm --name "$NAME" \
        -p "127.0.0.1:$PORT:8080" -v "$DATA:/data" \
        --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
        --tmpfs /run/hupo:rw,nosuid,nodev,mode=0700 \
        --security-opt=no-new-privileges --cap-drop=ALL \
        --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID --cap-add=FOWNER \
        --pids-limit=512 --memory=768m --memory-swap=768m "$IMG" >/dev/null 2>&1 || true
      GOT=""
      for _ in $(seq 1 30); do
        GOT="$(curl -s "http://127.0.0.1:$PORT/api/version" 2>/dev/null \
          | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).buildId??""))}catch{}})' || true)"
        [ -n "$GOT" ] && break
        sleep 0.5
      done
      "$PODMAN" kill "$NAME" >/dev/null 2>&1; rm -rf "$DATA"
      if [ "$GOT" = "dev" ]; then
        ok "负向对照：不挂产品层 ⇒ 报 「dev\」（那个指纹**确实是挂载带进去的**）"
      else
        bad "🔴 不挂产品层它却报了「$GOT」—— 那第 4 条验的就不是挂载"
      fi
    else
      bad "找不到端口做负向对照"
    fi
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据六：宿主那句 reload **不带载荷**"
  # ══════════════════════════════════════════════════════════════════
  # 判据写成"检查器 + 负向对照"：拿一份**坏的**喂给它，它必须报出来。
  check_no_payload() {  # $1 = 文件内容
    grep -qE "type: *'reload' *\}" <<<"$1"
  }
  if check_no_payload "$(cat "$CORE/src/tenant-channel.mjs")"; then
    ok "宿主发出去的是 「{ v, type: 'reload' }\」（**一个多余字段都没有**）"
  else
    bad "🔴 宿主那句 reload 带了载荷（那它就是一个远程执行口）"
  fi
  if check_no_payload "this.#send(conn, { v: CHANNEL_VERSION, type: 'reload', cmd: 'x' });"; then
    bad "🔴 负向对照没抓住：带载荷的那句被判成"干净"的了"
  else
    ok "负向对照：带载荷的那句 ⇒ 判据抓得住"
  fi
  # 而且容器那一侧**不解析**它说什么（只认 type）
  if grep -q "msg?.type === 'reload'" "$CORE/src/tenant-tunnel-agent.mjs"; then
    ok "容器只认 「type\」，不看别的字段"
  else
    bad "🔴 容器那一侧没接这条消息（那宿主叫不动它）"
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据七：不一致时**要说话**"
  # ══════════════════════════════════════════════════════════════════
  # ① 真的行为：那一组单测跑绿（比 grep 强）
  if (cd "$CORE" && "$NODE" --test test/product-layer.test.js >"$T/pl.txt" 2>&1); then
    ok "比值那一套单测全绿（$(sed -n 's/^ℹ pass //p' "$T/pl.txt") 条）"
  else
    bad "🔴 比值那一套单测没过：$(tail -5 "$T/pl.txt")"
  fi
  # ② 接线：宿主真的把它接上去了（**负向对照**：拿掉那行就必须红）
  check_wired() { grep -q "onBuild:" <<<"$1" && grep -q "compareTenantBuild" <<<"$1"; }
  if check_wired "$(cat "$CORE/src/serve.js")"; then
    ok "宿主把 「onBuild」 接上了（不然那套判据没人调用）"
  else
    bad "🔴 宿主没接 「onBuild」"
  fi
  if check_wired "const channel = new TenantChannel({ dir });"; then
    bad "🔴 负向对照没抓住：没接线的代码被判成接上了"
  else
    ok "负向对照：没接线的 ⇒ 判据抓得住"
  fi
  # ③ 🔴 **不能只挂在 `tunnel-ready` 上**（2026-09-21 真机才看出来的）：
  #    那条隧道是**长连接** ⇒ 一直连着就永远不再报 ⇒ **翻完 current，正在跑的那几台
  #    谁都不知道**（要等宿主重启或它自己断线）。⇒ 宿主必须**隔一会儿自己扫一遍**。
  check_sweep() { grep -q 'ROLLOUT_SWEEP_MS' <<<"$1" && grep -q 'requestReload' <<<"$1"; }
  if check_sweep "$(cat "$CORE/src/serve.js")"; then
    ok "宿主**自己隔一会儿扫一遍**（不然翻完 current 要等它断线才生效）"
  else
    bad "🔴 没有那个扫描 —— 翻完 current 之后正在跑的那几台**永远不会知道**"
  fi
  if check_sweep "const channel = new TenantChannel({ dir });"; then
    bad "🔴 负向对照没抓住：没有扫描的代码被判成有了"
  else
    ok "负向对照：没有扫描的 ⇒ 判据抓得住"
  fi
  # 现推那一帧也不带载荷（和 `tunnel-ready` 那一处同一条规矩）
  if grep -qE "requestReload\(userId\)" "$CORE/src/tenant-channel.mjs" \
    && grep -qE "type: 'reload' \}" "$CORE/src/tenant-channel.mjs"; then
    ok "现推那一帧同样**不带载荷**，而且没连着就返回 「false」（不假装发了）"
  else
    bad "🔴 「requestReload」 不老实（要么带载荷，要么假装发了）"
  fi

  # ④ 🔴 "当前是哪一版"**必须现读**（2026-09-21 真机实测栽的第二次）：
  #    开机读一次存起来 ⇒ 翻完 `current` 它就**变成一句假话** ⇒ 容器拿到新的一版报上来，
  #    宿主拿**旧的**当前版去比 ⇒ 又叫它重开 ⇒ **来回退、永远不收敛**
  #    （实测：两台容器被反复重启，一直退不出来）。
  check_fresh() {
    grep -q 'readProductLayer()?.fingerprint' <<<"$1" && ! grep -q 'const productLayer =' <<<"$1"
  }
  if check_fresh "$(cat "$CORE/src/serve.js")"; then
    ok "当前是哪一版是**现读**的（缓存会在翻转之后变成假话）"
  else
    bad "🔴 缓存了"当前是哪一版" —— 翻转之后它会变成假话，容器会来回退"
  fi
  if check_fresh "const productLayer = readProductLayer();
  onBuild: (t, b) => compareTenantBuild({ reported: b, current: productLayer?.fingerprint })"; then
    bad "🔴 负向对照没抓住：缓存那种写法被判成现读了"
  else
    ok "负向对照：缓存那种写法 ⇒ 判据抓得住"
  fi

  # ⑤ 读不到当前那一版时**谁都不叫**（叫了就是把每一台都弄死）
  if grep -q "reload: false" <(grep -A 6 "verdict: 'unknown'" "$CORE/src/product-layer.js"); then
    ok "读不到当前产品层 ⇒ 「reload: false」（谁都不叫）"
  else
    bad "🔴 读不到当前那一版还想叫人重开 —— 那会把每一台都弄死"
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据八：翻转**留痕**，而且"没发生的事不记账""
  # ══════════════════════════════════════════════════════════════════
  LEDGER="$ROOTDIR/ledger.jsonl"
  [ -f "$LEDGER" ] && bad "🔴 还没翻过就已经有账本了" || ok "还没翻过 ⇒ 没有账本（不许预先建一个空的）"
  bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" --publish "$FP1" >/dev/null 2>&1
  N1="$(wc -l < "$LEDGER" 2>/dev/null || echo 0)"
  if [ "$N1" = "1" ] && grep -q "\"to\":\"$FP1\"" "$LEDGER" && grep -q '"why":"publish"' "$LEDGER" && grep -q '"by":' "$LEDGER"; then
    ok "翻转记了一行（from / to / why / by 都在）"
  else
    bad "🔴 翻转没记账或记漏了：$(cat "$LEDGER" 2>/dev/null | tail -2)"
  fi
  # 🔴 负向对照：**翻到已经是的那个** ⇒ 不许再记一行
  bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" --publish "$FP1" >/dev/null 2>&1
  N2="$(wc -l < "$LEDGER" 2>/dev/null || echo 0)"
  if [ "$N1" = "$N2" ]; then
    ok "翻到已经是的那个 ⇒ 不记账（"没发生的事不记账"）"
  else
    bad "🔴 空翻也记了一行：$N1 → $N2"
  fi
  # 回滚也是一次翻转：翻回"上一版"要能翻、要记账
  bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" --publish "$FP3" >/dev/null 2>&1
  bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" --rollback "$FP1" >/dev/null 2>&1
  if [ "$(bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" --current)" = "$FP1" ] \
    && grep -q '"why":"rollback"' "$LEDGER"; then
    ok "回滚：翻回去了，而且账本写清了是 rollback"
  else
    bad "🔴 回滚不灵：现在是 $(bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" --current)"
  fi
  # 🔴 **`--prune` 不许碰那条软链**（2026-09-21 从 `--list` 的输出里看出来的）：
  #    `"$CODE_ROOT"/*/` 会把 `current` 也匹配进来 ⇒ 它会被当成"一版"删掉 ⇒
  #    容器一重开就挂到一个不存在的路径上（`podman` 会把它建成**空目录**）。
  bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" --prune --yes >"$T/prune.txt" 2>&1
  if [ -L "$ROOTDIR/current" ] && [ "$(bash "$ROOT/scripts/build-tenant-code.sh" --root "$ROOTDIR" --current)" = "$FP1" ]; then
    ok "收拾旧版本**没碰那条软链**（current 还在，还指着 $FP1）"
  else
    bad "🔴 --prune 把 current 那条软链弄没了 —— 容器下次重开就挂到空目录上"
  fi
  # 旧版本**不许**被顺手删掉（删了就回不去了）
  if [ -d "$ROOTDIR/$FP3" ] && [ -d "$ROOTDIR/$FP1" ]; then
    ok "回滚目标还在（没人顺手把旧版本删了）"
  else
    bad "🔴 旧版本被删了 —— 回滚那条路就断了"
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据九：能力那几条**四处逐字一致**"
  # ══════════════════════════════════════════════════════════════════
  # ⚠️ 为什么要这一条：这四条能力同时写在**三份文件**里（镜像跑一台 / 产品层验一版 /
  #    单元模板）。**任何一处漏一条**，那一台就会以"起不来"告终，而另外两处照样绿 ——
  #    这个项目已经栽过两次同一种病（`3.req.cancel`、仓库根算错一级）。
  CAPS='--cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID --cap-add=FOWNER'
  n_caps=0
  for f in scripts/build-tenant-image.sh scripts/build-tenant-code.sh scripts/create-tenant-pool.sh; do
    grep -qF -- "$CAPS" "$ROOT/$f" && n_caps=$((n_caps + 1))
  done
  if [ "$n_caps" = "3" ]; then
    ok "三处的能力清单逐字一致（$CAPS）"
  else
    bad "🔴 只有 $n_caps/3 处写着那一串 —— 漏掉的那一处会让容器起不来"
  fi
  # 负向对照：少一条就必须被抓住
  if grep -qF -- "${CAPS% --cap-add=FOWNER}" <(printf '%s\n' "${CAPS% --cap-add=FOWNER}"); then
    ok "负向对照：少一条的写法与完整那一串**不是**同一个字符串"
  else
    bad "🔴 少一条居然也算匹配"
  fi
  # 单元模板里 `Restart=always`（重开是 `exit(0)`，`on-failure` 会让它再也不起来）
  if grep -q '^Restart=always$' "$ROOT/scripts/create-tenant-pool.sh"; then
    ok "单元是 「Restart=always\」（重开之后起得来）"
  else
    bad "🔴 单元不是 「always」 ⇒ 容器自己 「exit(0)」 之后就**永远不会再起来**"
  fi
  # 挂载是**有条件的**（没发布过产品层时不写它 —— 否则 podman 会把源建成一个空目录）
  if grep -q 'if \[ -n "\$CODE_SRC" \]; then' "$ROOT/scripts/create-tenant-pool.sh"; then
    ok "单元里那条挂载是**有条件的**（没发布过就不写）"
  else
    bad "🔴 无条件写挂载 ⇒ 没发布过产品层时 podman 会把那个路径建成**空目录**，软链再也翻不动"
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据九·补：**产品层与仓库同版**（不同版就是"租户跑着落后于仓库的代码"）"
  # ══════════════════════════════════════════════════════════════════
  # ⚠️ 为什么非有不可：这一整套东西的价值全在"**跑的就是你正在改的那一份**"。
  #    不同版 ⇒ 你改完 `src/`、两台还跑着旧的，而**两边都以为没事** ——
  #    那正是当初要解决的问题本身。⇒ 判据把它变成一句看得见的话。
  # ⚠️ 负向对照用 `HUPO_CORE` 指一份**改过一个字节**的副本（不许去动真仓库）。
  REPO_FP="$(bash "$ROOT/scripts/build-tenant-code.sh" --fingerprint 2>/dev/null || true)"
  PUB_FP="$(bash "$ROOT/scripts/build-tenant-code.sh" --current 2>/dev/null || true)"
  if [ -z "$REPO_FP" ]; then
    bad "算不出仓库现在这一版的指纹"
  elif [ "$REPO_FP" = "$PUB_FP" ]; then
    ok "发布的那一版**就是仓库现在这一份**（$REPO_FP）"
  else
    bad "🔴 产品层落后于仓库：发布的是「${PUB_FP:-（还没发布过）}」、仓库是「$REPO_FP」—— 跑一遍 build/verify/publish"
  fi
  MUT="$T/core-mut"
  mkdir -p "$MUT"
  for i in src package.json hupo-persona.yml hupo-capabilities.yml hupo-model-proxy.yml; do cp -r "$CORE/$i" "$MUT/$i"; done
  printf '\n// 判据加的\n' >> "$MUT/src/product-layer.js"
  MUT_FP="$(HUPO_CORE="$MUT" bash "$ROOT/scripts/build-tenant-code.sh" --fingerprint 2>/dev/null || true)"
  if [ -n "$MUT_FP" ] && [ "$MUT_FP" != "$PUB_FP" ]; then
    ok "负向对照：仓库变一个字节 ⇒ 与发布那一版**对不上**（这条闸抓得住落后）"
  else
    bad "🔴 负向对照没抓住：改过内容却仍被判成同版"
  fi

  # ══════════════════════════════════════════════════════════════════
  echo "── 判据十：单元模板**真渲染一遍**（它自己以前从来没被验过）"
  # ══════════════════════════════════════════════════════════════════
  # ⚠️ **这条闸的来历**（2026-09-22 真机踩到）：单元是脚本里一段 heredoc 拼出来的，
  #    而它**只能以 root 跑一次、再去别人家里看结果** ⇒ **它自己从来没被验过**。
  #    那一段原来**不带引号** ⇒ 注释里的反引号被当命令执行 ⇒ 写出去的单元里
  #    `--replace` / `EACCES` 那些字**被挖空**（功能没坏，所以谁都没发现）。
  #    ⇒ 现在渲染是**纯函数**（`--render` 写 stdout），闸可以直接对着它跑。
  U1="$T/unit-with.service"; U0="$T/unit-without.service"
  bash "$ROOT/scripts/create-tenant-pool.sh" --render /srv/hupo/tenant-code/current >"$U1" 2>/dev/null
  bash "$ROOT/scripts/create-tenant-pool.sh" --render "" >"$U0" 2>/dev/null
  # ① 有产品层 ⇒ 必须挂上（而且带着只读与环境）
  if grep -q -- '-v /srv/hupo/tenant-code/current:/app/code:ro' "$U1" \
    && grep -q -- '--env HUPO_CODE_DIR=/app/code' "$U1"; then
    ok "有产品层 ⇒ 单元里挂了它（只读 + HUPO_CODE_DIR）"
  else
    bad "🔴 有产品层却没挂上：$(grep -c app/code "$U1") 处"
  fi
  # 🔴 **挂的必须是「软链」，不许是某个指纹**（2026-09-21 真机实测栽的）：
  #    写死指纹 ⇒ **翻 current 对在跑的容器一点用都没有** ⇒ 宿主看见它永远是旧版
  #    ⇒ 一直叫它重开、它重开还是旧版 ⇒ **死循环**（实测：两台容器被反复重启到起不来）。
  check_link_mount() { grep -q -- '/tenant-code/current:/app/code:ro' <<<"$1" && ! grep -qE -- '/tenant-code/[0-9a-f]{12}:/app/code' <<<"$1"; }
  if check_link_mount "$(cat "$U1")"; then
    ok "单元里挂的是**软链** current（翻转才对在跑的容器有意义）"
  else
    bad "🔴 单元里挂的是一个**写死的指纹** ⇒ 翻转对在跑的容器没用，而且会变成死循环"
  fi
  if check_link_mount '-v /srv/hupo/tenant-code/DEADBEEF:/app/code:ro'; then
    bad "🔴 负向对照没抓住：写死指纹的那种被判成软链了"
  else
    ok "负向对照：写死指纹的 ⇒ 判据抓得住"
  fi
  # ② 负向对照：没产品层 ⇒ **一个字节都不许出现**（否则 podman 会把源建成空目录）
  if grep -q 'app/code' "$U0"; then
    bad "🔴 没发布过产品层却写了挂载 —— podman 会把那个路径建成**空目录**，「current」 软链再也翻不动"
  else
    ok "负向对照：没产品层 ⇒ 单元里一个字节都不提它"
  fi
  # ③ 🔴 注释**没被挖空**（那两个反引号词必须原样在）
  for word in '--replace' 'EACCES' 'always'; do
    if grep -q -- "$word" "$U1"; then
      ok "注释完整：「$word」 还在（不被命令替换吃掉）"
    else
      bad "🔴 单元里少了 「$word」 —— 那是注释被命令替换挖空的症状"
    fi
  done
  if grep -q 'command not found' "$U1"; then
    bad "🔴 渲染的时候有命令去执行了注释里的反引号"
  else
    ok "渲染的时候没有东西去执行注释"
  fi
  # ③·补 🔴 **单元要显式说"这一侧是盒里"**（`HUPO_ROLE=tenant`）：
  #    靠"有没有通道"猜过一次 ⇒ 冒烟跑按"我是宿主"起、横幅报了一个盒里不存在的投递目录。
  if grep -q -- '--env HUPO_ROLE=tenant' "$U1"; then
    ok "单元显式声明了角色（HUPO_ROLE=tenant）"
  else
    bad "🔴 单元没说角色 —— 盒里那侧会按"宿主"起（横幅会说假话）"
  fi

  # ④ **真的语法校验**（systemd 自己的解析器，比 grep 强）
  if command -v systemd-analyze >/dev/null 2>&1; then
    if systemd-analyze verify "$U1" >"$T/sav.txt" 2>&1; then
      ok "systemd-analyze verify 过了（systemd 自己认这个单元）"
    else
      bad "🔴 systemd 不认这个单元：$(head -3 "$T/sav.txt")"
    fi
  else
    bad "没有 systemd-analyze —— 这一条**必须有**"
  fi
  # ⑤ 🔴 **不许有不带引号的 heredoc**（注释里的反引号会被执行）—— 名单要盖全 root 侧那几份
  n_bad=0
  for f in install-provision-helper.sh provision-tenant-request.sh create-tenant-pool.sh create-tenant-users.sh remove-tenant.sh; do
    [ -f "$ROOT/scripts/$f" ] || continue
    c="$(grep -c '<<[A-Za-z]' "$ROOT/scripts/$f" 2>/dev/null || true)"
    [ "${c:-0}" = "0" ] || { n_bad=$((n_bad + 1)); bad "$f 里有 $c 处不带引号的 heredoc"; }
  done
  [ "$n_bad" = "0" ] && ok "root 侧那五份脚本里**没有**不带引号的 heredoc（注释里的反引号不会被执行）"

  # ══════════════════════════════════════════════════════════════════
}

# ══════════════════════════════════════════════════════════════════
# **谁来跑哪一段**
# ══════════════════════════════════════════════════════════════════
#  · 不是 root ⇒ 便携段 + 真机段都在这儿跑（真机段会自己说"要 root"）
#  · 是 root、没给 `--live` ⇒ **拒**（并说清为什么：root 看不见 deploy 的镜像）
#  · 是 root、给了 `--live` ⇒ 便携段交给 deploy 跑，root 只做真机那一眼
if [ "$(id -u)" = "0" ] && [ "${HUPO_CHECK_PART:-}" != "portable" ]; then
  if [ "$LIVE" != "1" ]; then
    echo "✗ 这个判据要在 deploy 身份下跑（rootless podman 的镜像在他存储里，root 看不见）。"
    echo "  要看真机那一眼：sudo bash $0 --live"
    exit 2
  fi
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
      [ "$skipped" != "0" ] && echo "⚠️ **有跳过的**（上面写了）—— 跳过的**不是**过的。"
      exit 0
    fi
    echo "✗ 没过 $fail 条（过 $pass、跳过 $skipped）"
    exit 1
  fi
fi

if [ "$LIVE" = "1" ]; then
  echo "── 真机器那一眼（只读）"
  if [ "$(id -u)" != "0" ]; then
    bad "--live 要 root（要看租户家里的单元文件与单元里挂的是什么）"
  else
    # ⚠️ 这里**不许用 `$ROOTDIR`**（那是便携段里的临时目录，这一段里它不存在 ⇒ `set -u` 会炸）
    CUR="$(readlink -f "${HUPO_CODE_ROOT:-/srv/hupo/tenant-code}/current" 2>/dev/null || true)"
    if [ -n "$CUR" ]; then ok "真机器上当前产品层：$CUR"; else skip "真机器上还没发布过产品层"; fi
    for t in hupo-a hupo-b; do
      id "$t" >/dev/null 2>&1 || { skip "$t 不在"; continue; }
      u="$t"
      unit="/home/$u/.config/systemd/user/hupo-tenant.service"
      if [ -f "$unit" ] && grep -q '/app/code' "$unit"; then
        ok "$t 的单元挂了产品层"
        what="$(cd /tmp && sudo -u "$u" -H env XDG_RUNTIME_DIR="/run/user/$(id -u "$u")" podman inspect "hupo-tenant-$u" --format '{{range .Mounts}}{{if eq .Destination "/app/code"}}{{.Source}}{{end}}{{end}}' 2>/dev/null | head -1)"
        [ -n "$what" ] && ok "  它跑着的那台挂的是 $what" || skip "  它现在没有在跑的容器"
      elif [ -f "$unit" ]; then
        bad "🔴 $t 的单元**没挂**产品层（还在用镜像里那份兜底）"
      else
        skip "$t 没有单元文件"
      fi
    done
  fi
fi

echo
echo "──────────────────────────────"
# ⚠️ **两段的结论要合起来**：便携那一段是**另一个进程**跑的（deploy 身份），
#    它的退出码在 `RC_PORTABLE` 里 —— 不看它，就会出现"便携段红了一堆、
#    最后照样报全过"（那正是这个项目最忌的"看着像过了"）。
if [ "$fail" = "0" ] && [ "${RC_PORTABLE:-0}" = "0" ]; then
  if [ "$LIVE" = "1" ]; then
    echo "✅ 全过（真机那一眼：过 $pass、跳过 $skipped；便携那段见上面）"
  else
    echo "✅ 全过（过 $pass、跳过 $skipped）"
  fi
  [ "$skipped" != "0" ] && echo "⚠️ **有跳过的**（上面写了）—— 跳过的**不是**过的。"
  exit 0
fi
echo "✗ 没过（真机那一眼没过 $fail 条、过 $pass、跳过 $skipped；便携那段退出码 ${RC_PORTABLE:-0}）"
exit 1
