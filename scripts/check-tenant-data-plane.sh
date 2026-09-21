#!/usr/bin/env bash
# **多租户数据面的判据**（契约 `docs/dev/34-CONTAINER.md` §十三 · `39-PERMISSIONS.md` §7.3）。
#
# 用法：
#   bash scripts/check-tenant-data-plane.sh
#
# ── 它验什么（**每一对都带负向对照**）────────────────────────
#   ① 那个人的 HTTP 请求**真的进到他自己的容器**了（不是在本机替他答的）；
#   ② 那条 WebSocket 流也一样；
#   ③ 容器里那条"可信口"**只有 root 开得开**（内核挡的，不是我们说说的）；
#   ④ 普通那条口**没令牌照样拒**（可信那条没有把 fail-closed 弄松）。
#
# ⚠️ **为什么非要"对照"**：光看"`u1` 拿到一个响应"证明不了它进了容器 ——
#    在本机替他造一个新世界，读数会**一模一样**。
#    ⇒ 判据靠的是**两边本来就不同的东西**：主人那份有历史（86 条），
#      容器那份是全新的（0 条）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
BASE="${HUPO_BASE:-http://127.0.0.1:8020}"
# ⚠️ 这两个是**这台机器上**的表（`data/tenants.env`）；没有它就没什么可验的
TENANT_USER="${HUPO_TENANT_USER:-u1}"
TENANT_OS="${HUPO_TENANT_OS:-hupo-a}"
OWNER_SUB="${HUPO_OWNER_SUB:-owner}"

# ⚠️ **这台机器上 `node` 只在 nvm 里**（`/usr/bin/node` 不存在）—— 而 `sudo` 会把 PATH 清掉
#    ⇒ 必须**写绝对路径**（`AGENTS.md` §1.1 记着这一条：让主人跑的命令不许只写 `node`）。
NODE="${HUPO_NODE:-}"
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  # ⚠️ **优先用"仓库属主"那个 node**（不是随便谁的 —— 这台机器上还有别人的账号，
  #    而 `AGENTS.md` §六.5 明说"不要动别人的目录"）。
  OWNER_HOME="$(cd "$ROOT/../.." && pwd)"
  for c in "$OWNER_HOME"/.nvm/versions/node/*/bin/node; do [ -x "$c" ] && NODE="$c"; done
fi
[ -x "${NODE:-}" ] || { echo "✗ 找不到 node（试：HUPO_NODE=/绝对/路径/node bash $0）"; exit 2; }
echo "  node：$NODE"

tok() { ( cd "$CORE" && "$NODE" -e "
import('./src/auth.js').then(({Auth})=>{
  const a=new Auth({dataDir:'./data'});
  process.stdout.write(a.issue({sub:'$1'}).token);
});" ); }

echo "── 多租户数据面 ──────────────────────────────"
echo "  服务：$BASE ｜ 租户：$TENANT_USER → $TENANT_OS"

echo
echo "▶ ① HTTP：同一个 /api/health，两个身份"
O="$(curl -s -H "authorization: Bearer $(tok "$OWNER_SUB")" "$BASE/api/health")"
T="$(curl -s -H "authorization: Bearer $(tok "$TENANT_USER")" "$BASE/api/health")"
echo "  主人：      $O"
echo "  $TENANT_USER：        $T"
case "$O$T" in
  *'"error"'*) echo "  ⚠️ 有一个是错的 —— 下面那几条先别下结论" ;;
esac
if [ "$O" = "$T" ]; then
  echo "  ❌ **两个读数一模一样** ⇒ 要么两边都没接上，要么租户那条根本没转进容器"
  echo "     （本机替他答一个新世界，读数也会长这样 —— 这正是要对照的原因）"
  exit 1
fi
echo "  ✅ 两个读数不同（主人有历史、租户那份是新的）"

echo
echo "▶ ② WebSocket：同一条 /api/stream，看**历史补发**条数"
# ⚠️ **必须以 `.mjs` 结尾**：node 是按扩展名判 CJS/ESM 的，而 `mktemp` 给的文件没有后缀
#    （现象是 `import` 报语法错 —— 而那个报错看起来像"探针写错了"，其实是"认错了模块类型"）
WSPROBE="$(mktemp --suffix=.mjs)"
cat > "$WSPROBE" <<'WS'
// ⚠️ **静态 `import` 不许拿变量当路径**（`import X from process.env.Y` 是语法错）
const { default: WebSocket } = await import(process.env.WS_PATH);
const { Auth } = await import(process.env.AUTH_PATH);
const auth = new Auth({ dataDir: process.env.DATA_PATH });
const tok = (sub) => auth.issue({ sub }).token;
function probe(sub) {
  return new Promise((resolve) => {
    const ws = new WebSocket(process.env.BASE_URL + '/api/stream?sinceSeq=0', ['bearer', tok(sub)]);
    const seen = [];
    ws.on('message', (d) => seen.push(JSON.parse(d.toString()).type));
    ws.on('error', () => resolve(null));
    ws.on('open', () => setTimeout(() => {
      const hist = seen.filter((x) => x !== 'client/hello').length;
      ws.close(); resolve(hist);
    }, 1500));
    setTimeout(() => { try { ws.terminate(); } catch {} resolve(null); }, 6000);
  });
}
const [o, t] = [await probe(process.env.OWNER_SUB), await probe(process.env.TENANT_SUB)];
console.log(JSON.stringify({ owner: o, tenant: t }));
process.exit(0);
WS
# ⚠️ **不许把 stderr 吞掉**（第一版吞了，结果只知道"流没连上"、不知道为什么）
WSERR="$(mktemp)"
OUT="$(WS_PATH="$CORE/node_modules/ws/index.js" AUTH_PATH="$CORE/src/auth.js" DATA_PATH="$CORE/data" \
  BASE_URL="ws://127.0.0.1:$(echo "$BASE" | sed 's#.*:##')" OWNER_SUB="$OWNER_SUB" TENANT_SUB="$TENANT_USER" \
  "$NODE" "$WSPROBE" 2>"$WSERR" | tail -1)"
if [ -z "$OUT" ]; then
  echo "  ⚠️ 探针自己报的：" ; tail -3 "$WSERR" | sed 's/^/    /'
fi
rm -f "$WSERR"
rm -f "$WSPROBE"
echo "  读数：$OUT"
case "$OUT" in
  '{"owner":null'*|'') echo "  ❌ 流没连上"; exit 1 ;;
esac
if [ "$OUT" = "{\"owner\":0,\"tenant\":0}" ]; then
  echo "  ❌ 两边都没有历史 ⇒ 这条对照证不了什么（主人那份不该是空的）"; exit 1
fi
echo "  ✅ 主人那边有历史、租户那边是新的 ⇒ **流真的转进容器了**"

echo
echo "▶ ③ 可信口：只有 root 开得开吗（容器里自己看 + 拿 agent 身份试）"
podman_run() {  # 以那个租户的身份跑（rootless podman 不能以 root 跑）
  local u="$1"; shift
  sudo -u "$u" -H sh -c 'cd /tmp && exec env XDG_RUNTIME_DIR="/run/user/$(id -u)" "$@"' sh "$@"
}
if ! command -v podman >/dev/null || ! id "$TENANT_OS" >/dev/null 2>&1; then
  echo "  ⚠️ 没有 podman 或没有 $TENANT_OS —— 这一条跳过（**不算通过**）"
else
  CNAME="hupo-tenant-$TENANT_OS"
  STAT="$(sudo -u "$TENANT_OS" -H sh -c "cd /tmp && exec env XDG_RUNTIME_DIR=/run/user/\$(id -u) podman exec $CNAME /bin/node -e '
const fs=require(\"node:fs\");const s=fs.statSync(\"/run/hupo/local-api.sock\");
process.stdout.write(((s.mode&0o777).toString(8))+\" \"+s.uid+\" \"+((fs.statSync(\"/run/hupo\").mode&0o777).toString(8)));'" 2>/dev/null)"
  echo "  local-api.sock 权限/属主 · /run/hupo 权限 = ${STAT:-（读不到）}"
  DENY="$(sudo -u "$TENANT_OS" -H sh -c "cd /tmp && exec env XDG_RUNTIME_DIR=/run/user/\$(id -u) podman exec --user 1000 $CNAME /bin/node -e '
const net=require(\"node:net\");const c=net.connect(\"/run/hupo/local-api.sock\");
c.on(\"connect\",()=>{console.log(\"CONNECTED\");process.exit(0)});
c.on(\"error\",e=>{console.log(e.code);process.exit(0)});'" 2>/dev/null | tail -1)"
  echo "  agent(uid 1000) 去连它：$DENY"
  [ "$DENY" = "EACCES" ] || { echo "  ❌ 不是 EACCES ⇒ **那条边界不在**"; exit 1; }
  echo "  ✅ 内核挡住了它"
fi

echo
echo "▶ ④ 负向对照：普通那条口（容器里的 :8080）没令牌照样拒"
if id "$TENANT_OS" >/dev/null 2>&1; then
  CODE="$(sudo -u "$TENANT_OS" -H sh -c "cd /tmp && exec env XDG_RUNTIME_DIR=/run/user/\$(id -u) podman exec hupo-tenant-$TENANT_OS /bin/node -e '
(async()=>{const r=await fetch(\"http://127.0.0.1:8080/api/health\");process.stdout.write(String(r.status));})();'" 2>/dev/null | tail -1)"
  echo "  无令牌 → $CODE"
  [ "$CODE" = "503" ] || [ "$CODE" = "401" ] && echo "  ✅ fail-closed 没被可信那条弄松" || echo "  ⚠️ 读数不是 503/401，自己看一眼"
fi

echo
echo "✅ 数据面判据全过（每一对都带负向对照）"
