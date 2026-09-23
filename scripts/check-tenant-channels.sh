#!/usr/bin/env bash
# **盒子里那两条本地通道（`apps.sock` / `ledger.sock`）到底能不能用** —— 判据。
#
# 用法：
#   bash scripts/check-tenant-channels.sh              # 规则与源码这一半（不需要 root）
#   sudo bash scripts/check-tenant-channels.sh --live  # 再看一眼**真机器**：盒子里以 agent 的 uid 连得上吗
#
# ── 为什么有这一份（2026-09-24 真机事故）─────────────────────
#   主人的号（19145526557 = u2 = hupo-b）在对话里要一个天气小程序，agent 回：
#   「我放了两次，都被同一个错挡回来（EACCES，连接没通）」。
#
#   查下去是这样：**盒子里的服务是 root 起的**（`/app/entry.mjs`，宿主上 uid 2002），
#   干活的 **agent 是 uid 1000**（宿主上看到 297607）。那两条口按"进程自己的 uid + 0600"
#   建出来 ⇒ 属主 root ⇒ agent **连不上**。真机上以 uid 1000 复现过：
#       /data/apps.sock   → EACCES
#       /data/ledger.sock → EACCES
#   ⇒ 盒子里"在对话里造小程序"和"记账"**从来没通过**；主人自己那一格看不出来，
#     因为那边服务与 agent 是同一个 uid（**只有租户才犯的病**，闸全绿也犯）。
#
# ── 判据（每条都带**负向对照**）──────────────────────────────
#   ① 规则只住一处：`src/socket-owner.mjs` 之外**没有第二处** chown 套接字
#   ② 两条口建好之后**都调了** `handSocketToAgent`（源码级：防"哪天被改回去"）
#   ③ 宿主上（没有那两条 env）**一个字节都不动** —— 阴性对照
#   ④ 盒子里（root + 配了）⇒ 交给 1000:1000；**`uid=0` 当"没配"，不许交给 root**
#   ⑤ chown 失败**不抛**，但必须留一句能查的话（不许静默降级）
#   ⑥ `--live`：每个盒子、以**它自己的 agent uid** 连那两条口 ⇒ 连得上
#   ⑦ `--live` 阴性对照：连一个**不存在**的口 ⇒ `ENOENT`（证明探针分得开）
#   ⑧ `--live`：口的**属主就是 agent、权限仍是 0600**（准入没被放宽成 0666）
#   ⑨ `--live`：**真的跑一遍那条 MCP 工具**（`app_list`）⇒ 拿到一条人话回执，不是错误
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  for c in /home/deploy/.nvm/versions/node/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "✗ 找不到 node"; exit 2; }

pass=0; fail=0; skipped=0
ok()   { echo "  ✓ $1"; pass=$((pass + 1)); }
bad()  { echo "  ✗ $1"; fail=$((fail + 1)); }
skip() { echo "  · $1"; skipped=$((skipped + 1)); }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# ══════════════════════════════════════════════════════════════════
# 判据一~五：规则那一半（**不需要 root**）
portable_part() {
  echo "── 判据一：规则只住一处"
  local hits unexpected
  hits="$(grep -rl "chownSync" "$CORE/src" 2>/dev/null | xargs -n1 basename | sort | tr '\n' ' ')"
  unexpected="$(grep -rl "chownSync" "$CORE/src" 2>/dev/null | xargs -n1 basename | grep -vE '^(socket-owner\.mjs|entry\.mjs)$' | tr '\n' ' ')"
  if [ -z "$unexpected" ] && echo "$hits" | grep -q "socket-owner.mjs"; then
    ok "chown 只住在 socket-owner.mjs 与 entry.mjs（$hits）"
  else
    bad "chown 跑到别处去了：$unexpected（现有：$hits）"
  fi

  echo "── 判据二：两条口建好之后都调了 handSocketToAgent"
  for f in apps-socket.js ledger-socket.js; do
    if grep -q "handSocketToAgent(this.#path" "$CORE/src/$f"; then
      ok "$f 调了"
    else
      bad "$f **没调** —— 盒子里 agent 又会连不上（EACCES）"
    fi
    # 负向：不许有人把它删掉只留 import
    if grep -q "^import { handSocketToAgent }" "$CORE/src/$f"; then
      ok "$f 的 import 在"
    else
      bad "$f 少了 import"
    fi
  done

  echo "── 判据三~五：纯规则（假 fs，一个真文件都不碰）"
  cat > "$T/rule.mjs" <<'JS'
import assert from 'node:assert/strict';
// ⚠️ 用**动态 import**：静态 `import … from <变量>` 是语法错误（第一版就栽在这儿）
const { agentOwnerFromEnv, handSocketToAgent, shouldHandToAgent } = await import(process.env.SO_MOD);
const calls = [];
const mkfs = (boom) => ({ chownSync(p, u, g) { calls.push([p, u, g]); if (boom) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } });
const BOX = { HUPO_AGENT_UID: '1000', HUPO_AGENT_GID: '1000' };

// ③ 宿主：没有 env ⇒ 一个字节都不动（阴性对照）
let fs = mkfs();
assert.equal(handSocketToAgent('/x/apps.sock', { env: {}, uid: 0, fs }).done, false);
assert.equal(calls.length, 0, '宿主上居然 chown 了');
// ④ 盒子：root + 配了 ⇒ 交给 1000:1000
fs = mkfs();
assert.equal(handSocketToAgent('/x/apps.sock', { env: BOX, uid: 0, fs }).done, true);
assert.deepEqual(calls, [['/x/apps.sock', 1000, 1000]]);
// ④ 负向：uid=0 是"没配"，**不许**把口交给 root
assert.equal(agentOwnerFromEnv({ HUPO_AGENT_UID: '0', HUPO_AGENT_GID: '0' }), null);
assert.equal(shouldHandToAgent({ env: { HUPO_AGENT_UID: '0', HUPO_AGENT_GID: '0' }, uid: 0 }).hand, false);
// ④ 负向：不是 root ⇒ 不许动
calls.length = 0;
assert.equal(handSocketToAgent('/x/apps.sock', { env: BOX, uid: 1001, fs }).done, false);
assert.equal(calls.length, 0);
// ⑤ chown 失败：不抛，但要说一句
const said = [];
assert.equal(handSocketToAgent('/x/l.sock', { env: BOX, uid: 0, fs: mkfs(true), log: (m) => said.push(m) }).done, false);
assert.equal(said.length, 1);
assert.match(said[0], /EACCES|连不上/);
console.log('RULE_OK');
JS
  if SO_MOD="$CORE/src/socket-owner.mjs" "$NODE" "$T/rule.mjs" 2>&1 | grep -q RULE_OK; then
    ok "宿主不动 · 盒子里交给 1000 · uid=0 不算配 · 非 root 不动 · 失败要说话"
  else
    bad "纯规则有红（跑 $NODE $T/rule.mjs 看）"
  fi
}

# ══════════════════════════════════════════════════════════════════
# 判据六~九：真机器那一眼（**要 root**）
live_part() {
  # ⚠️ **先离开仓库目录**（2026-09-24 实测）：`runuser`/`sudo -u` 会**先 chdir 到当前目录**，
  #    而租户用户读不了 `/home/deploy/...` ⇒ 报 `cannot chdir to …: Permission denied`，
  #    看起来像"盒子没在跑"（**假红**，正是这一节第一版的样子）。
  #    ⇒ 之后一律用绝对路径（`$CORE` 就是绝对的）。
  cd /tmp || return 0
  local map
  map="$(sed -n 's/^HUPO_TENANT_MAP=//p' "$CORE/data/tenants.env" 2>/dev/null | head -1)"
  [ -n "$map" ] || { skip "没有 HUPO_TENANT_MAP —— 这台机器上还没有静态映射的租户"; return; }

  local pair user tid name uid
  for pair in ${map//,/ }; do
    user="${pair#*=}"; name="$user"
    tid="$(id -u "$user" 2>/dev/null || true)"
    [ -n "$tid" ] || { skip "$user 这个用户不在"; continue; }
    local cname
    cname="$(runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$tid" podman ps --format '{{.Names}}' 2>/dev/null | head -1)"
    [ -n "$cname" ] || { skip "$user 的盒子没在跑"; continue; }

    # agent 的 uid：从盒子里那个 entry 进程的 env 读（**事实**，不猜 1000）
    uid="$(for p in $(pgrep -f '/app/entry.mjs' || true); do tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | sed -n 's/^HUPO_AGENT_UID=//p'; done | sort -u | head -1)"
    [ -n "$uid" ] || uid=1000

    echo "── 判据六~八：$name（盒子 $cname，agent uid $uid）"
    local out
    out="$(runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$tid" podman exec --user "$uid" -e WANT_UID="$uid" "$cname" /bin/node -e '
      const net=require("net"), fs=require("fs");
      const want = Number(process.env.WANT_UID);
      const paths=["/data/apps.sock","/data/ledger.sock"];
      const bad="/data/definitely-not-there.sock";
      let out=[];
      for (const p of paths) {
        let st=null; try { st=fs.statSync(p); } catch {}
        const mode = st ? "0"+(st.mode & 0o777).toString(8) : "??";
        out.push(["owner", p, st ? st.uid : -1, mode, want].join(" "));
      }
      let n=paths.length+1;
      const done=()=>{ if(--n===0) { console.log(out.join("\n")); process.exit(0); } };
      setTimeout(()=>{ console.log(out.join("\n")); process.exit(0); }, 2500);
      for (const p of paths.concat([bad])) {
        const s=net.connect(p);
        s.on("error",e=>{ out.push(["conn",p,e.code].join(" ")); done(); });
        s.on("connect",()=>{ out.push(["conn",p,"OK"].join(" ")); s.end(); done(); });
      }
    ' 2>&1 || true)"

    if echo "$out" | grep -q "conn /data/apps.sock OK" && echo "$out" | grep -q "conn /data/ledger.sock OK"; then
      ok "$name：以 uid $uid 两条口都连得上"
    else
      bad "$name：连不上 —— $(echo "$out" | grep "^conn" | tr '\n' ' ')"
    fi
    if echo "$out" | grep -q "conn /data/definitely-not-there.sock ENOENT"; then
      ok "$name：阴性对照对（不存在的口 = ENOENT，探针分得开）"
    else
      bad "$name：阴性对照不对 —— $(echo "$out" | grep "not-there" )"
    fi
    local owners
    owners="$(echo "$out" | grep '^owner /data/' | awk '{print $3}' | sort -u | tr '\n' ' ')"
    if [ "$owners" = "$uid " ]; then
      ok "$name：两条口的属主就是 agent（$uid）"
    else
      bad "$name：属主不对：$owners（要 $uid）"
    fi
    if echo "$out" | grep '^owner /data/' | awk '{print $4}' | grep -qv '^0600$'; then
      bad "$name：权限被放宽了（准入是 0600）—— $(echo "$out" | grep '^owner' | tr '\n' ' ')"
    else
      ok "$name：权限仍是 0600（准入没放宽）"
    fi

    echo "── 判据九：$name 真的跑一遍那条 MCP 工具（app_list）"
    local b64 mcp
    b64="$(printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"1"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"app_list","arguments":{}}}' | base64 -w0)"
    mcp="$(runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$tid" podman exec --user "$uid" \
      -e HUPO_APPS_SOCKET=/data/apps.sock -e PAYLOAD="$b64" "$cname" /bin/node -e '
        const {spawn}=require("child_process");
        const c=spawn("/bin/node",["/app/code/src/mcp-apps-server.mjs"],{stdio:["pipe","inherit","inherit"]});
        c.stdin.write(Buffer.from(process.env.PAYLOAD,"base64"));
        setTimeout(()=>c.stdin.end(),800);
      ' 2>&1 || true)"
    if echo "$mcp" | grep -q '"id":2'; then
      if echo "$mcp" | grep -q '"isError":false'; then
        ok "$name：工具回执拿到了（$(echo "$mcp" | grep -o '"text":"[^"]*"' | head -1 | cut -c9-40)…）"
      else
        bad "$name：工具回了错：$(echo "$mcp" | grep -o '"text":"[^"]*"' | head -1)"
      fi
    else
      bad "$name：工具没有回执 —— $mcp"
    fi
  done
}

# ══════════════════════════════════════════════════════════════════
if [ "$LIVE" = 1 ] && [ "$(id -u)" = 0 ]; then
  # 规则那一半要以 deploy 跑（同一个 repo，root 跑也对，但保持与别的判据一致）
  sudo -u deploy bash "$0" || true
  live_part
else
  portable_part
  [ "$LIVE" = 1 ] && echo "⚠️  --live 要 root（盒子在租户自己的 rootless podman 里）"
fi

echo "──"
echo "  通过 $pass · 失败 $fail · 跳过 $skipped"
[ "$fail" = 0 ] || exit 1
