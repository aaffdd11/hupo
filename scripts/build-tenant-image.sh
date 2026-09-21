#!/usr/bin/env bash
# 造**租户镜像**（契约 `docs/dev/37-MULTITENANT.md` §4 · `38-ISOLATION-SPLIT.md` §一）。
#
# 用法：
#   bash scripts/build-tenant-image.sh          # 造镜像（不联网）
#   bash scripts/build-tenant-image.sh --run    # 造完顺手跑一台、验它能起来
#
# ── 这个镜像里有什么（初步版）────────────────────────────────
#   node（宿主的那个，连同它依赖的动态库）· 调度器本体（`v2/services/core/src` + `ws`）
#   · 人格层 / 能力层那两份 yml · MCP 服务器那支脚本
#   · 空目录 `/data`（**数据挂这里**，不放在容器那层可写层里）
#
# ⚠️ **还不含 `dsh`（agent 本体）**：那是下一步（它连同 node_modules 很大）。
#    所以这一版能证明的是"**整套服务的形状**能装进容器、能以容器身份起来"，
#    不能证明"agent 能在里面干活"。
#
# ── 三条纪律 ──────────────────────────────────────────────
#   ① **不联网、不拉镜像**：这台机器够不着 Docker Hub（实测），
#      所以 rootfs 全靠**宿主已有的文件**拼（`buildah from scratch`）；
#   ② **容器内绑 `0.0.0.0`，宿主只绑 `127.0.0.1`**：容器里不绑 0.0.0.0，
#      宿主那个回环口就**转不进去**；而宿主那边**必须只绑回环**
#      （实测：容器够得着宿主 `0.0.0.0` 的服务 ⇒ 开在 0.0.0.0 就是把甲的口递给乙）；
#   ③ **数据在卷里**：`/data` 是挂载点 ⇒ **容器可以随时重建**，用户的东西不丢。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
IMG="${HUPO_TENANT_IMAGE:-localhost/hupo-tenant:local}"
DO_RUN=0
[ "${1:-}" = "--run" ] && DO_RUN=1

BUILDAH="${BUILDAH_BIN:-/usr/bin/buildah}"
PODMAN="${PODMAN_BIN:-/usr/bin/podman}"

for b in "$BUILDAH" "$PODMAN"; do
  [ -x "$b" ] || { echo "✗ 找不到 $b"; exit 2; }
done

NODE="$(command -v node || true)"
[ -x "$NODE" ] || { echo "✗ 找不到 node"; exit 2; }

R="$(mktemp -d)"
trap 'rm -rf "$R"' EXIT
echo "▶ 拼 rootfs（$R）"

mkdir -p "$R"/{bin,proc,sys,tmp,dev,etc,data,app}

# ── ① node + 它的动态库（连同 loader）──
cp "$NODE" "$R/bin/node"
echo "  node: $NODE"
ldd "$NODE" | while read -r line; do
  case "$line" in
    *"=>"*) lib="${line##*=> }"; lib="${lib%% *}" ;;
    /*)     lib="${line%% *}" ;;
    *)      continue ;;
  esac
  [ -f "$lib" ] || continue
  mkdir -p "$R$(dirname "$lib")"
  cp -n "$lib" "$R$lib" 2>/dev/null || true
done
echo "  库: $(find "$R" -name '*.so*' | wc -l) 个"

# ── ② 调度器本体 ──
cp -r "$CORE/src" "$R/app/src"
cp "$CORE/package.json" "$R/app/package.json"
mkdir -p "$R/app/node_modules"
# ⚠️ 只带**真正用到的那一个依赖**（`ws`）—— 不带整个 node_modules（那会把 dev 依赖也搬进去）
if [ -d "$CORE/node_modules/ws" ]; then cp -r "$CORE/node_modules/ws" "$R/app/node_modules/ws"; fi
# 人格层 + 能力层 + MCP 那支脚本（服务开机 preflight 会查它们在不在）
cp "$CORE/hupo-persona.yml" "$R/app/hupo-persona.yml"
[ -f "$CORE/hupo-capabilities.yml" ] && cp "$CORE/hupo-capabilities.yml" "$R/app/hupo-capabilities.yml"
[ -f "$CORE/src/mcp-ledger-server.mjs" ] && cp "$CORE/src/mcp-ledger-server.mjs" "$R/app/src/mcp-ledger-server.mjs"
echo "  服务: $(find "$R/app/src" -name '*.js' | wc -l) 个 js + ws"

# ── ②′ 入口：先把卷里的目录建出来，再起服务 ──
# ⚠️ 为什么不能在镜像里建 `/data/hupo-workspace`：`/data` 是**挂载卷**
#    ⇒ 镜像里那一层会被卷**盖住**（第一次跑就是个空卷）。
#    所以"开机建目录"这件事必须由一个**入口**来做，而 scratch 里没有 shell
#    ⇒ 用一个 30 行的 node 入口（node 本来就在镜像里）。
cat > "$R/app/entry.mjs" <<'ENTRY'
import nodeFs from 'node:fs';

// 卷里的目录：镜像建不了（会被挂载盖住），只能开机建。
// ⚠️ 布局照 `02-ARCHITECTURE.md` §2.1：`main` 与 `workspaces/` **必须平行**
//    （否则主目录的 agent 会写进子工作区——"算错一个相对路径"就发生）。
//    ⚠️ 主目录 root **不是 home**（§2.2 规则 1）：home 当 root ⇒
//       agent 读得到自己的 key、写得进 `.bashrc` = 持久化代码执行。
const data = process.env.HUPO_DATA ?? '/data';
const dirs = [
  data,
  `${data}/main`,
  `${data}/workspaces`,
  `${data}/hupo`,
];
for (const d of dirs) {
  try { nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* 已存在 */ }
}
// 属主照权限席给的：`/data` 是 root `0711`（能穿过去、列不出别人），
// 里面那三样归 **agent(1000) `0700`** —— 服务(root)读得到，别的租户读不到。
for (const d of [`${data}/main`, `${data}/workspaces`, `${data}/hupo`]) {
  try { nodeFs.chownSync(d, 1000, 1000); nodeFs.chmodSync(d, 0o700); } catch { /* 尽力 */ }
}
try { nodeFs.chmodSync(data, 0o711); } catch { /* 尽力 */ }

// 起真正的服务（**同一个进程**，不多一层 shell）
await import('./src/serve.js');
ENTRY
echo "  入口: /app/entry.mjs"

# ── ③ 最小的 /etc（node 与 shell 都要用）──
# ⚠️ 两个身份（容器内权限席的结论）：**服务/终端 = root**（uid0→宿主租户），
#    **agent 的手 = uid 1000**。理由：userns 的 root 有 CAP_DAC_OVERRIDE
#    ⇒ agent 若是 uid0，**任何权限位都拦不住它读 key**。
cat > "$R/etc/passwd" <<'EOF'
root:x:0:0:root:/data:/bin/sh
agent:x:1000:1000:agent:/data/main:/bin/sh
EOF
cat > "$R/etc/group" <<'EOF'
root:x:0:
agent:x:1000:
EOF
echo "127.0.0.1 localhost" > "$R/etc/hosts"
echo "nameserver 10.0.2.3" > "$R/etc/resolv.conf"

# ── ④ 提交成镜像 ──
ctr="$("$BUILDAH" from scratch)"
"$BUILDAH" copy "$ctr" "$R/" / >/dev/null
"$BUILDAH" config \
  --workingdir /app \
  --env HUPO_DATA=/data \
  --env HUPO_PORT=8080 \
  --env HUPO_HOST=0.0.0.0 \
  --env HUPO_WEB=/nonexistent \
  --env HUPO_AGENT_CWD=/data/main \
  --cmd '["/bin/node","/app/entry.mjs"]' \
  "$ctr" >/dev/null
"$BUILDAH" commit "$ctr" "$IMG" >/dev/null
"$BUILDAH" rm "$ctr" >/dev/null
echo "✅ 镜像好了：$IMG（$( "$PODMAN" images --format '{{.Size}}' "$IMG" | head -1)）"

[ "$DO_RUN" = "1" ] || { echo "（想顺手跑一台：加 --run）"; exit 0; }

# ── ⑤ 跑一台，验它能起来（**宿主只绑回环**）──
echo "▶ 跑一台"
PORT="${HUPO_TENANT_PORT:-18090}"
DATA="$(mktemp -d)"
cid="$("$PODMAN" run -d --rm \
    -p "127.0.0.1:$PORT:8080" -v "$DATA:/data" \
    --security-opt=no-new-privileges \
    --cap-drop=ALL \
    --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=FOWNER --cap-add=FSETID \
    --cap-add=SETUID --cap-add=SETGID --cap-add=SETFCAP --cap-add=MKNOD --cap-add=KILL \
    --pids-limit=512 --memory=768m --memory-swap=768m \
    "$IMG" 2>&1 | tail -1)"
echo "  容器 ${cid:0:12} · 数据 $DATA · 口 127.0.0.1:$PORT"
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/version" 2>/dev/null || true)"
  [ "$code" = "200" ] && break
  sleep 0.5
done
echo "  /api/version → ${code:-（没起来）}"
echo -n "  对外开了吗："; ss -ltn 2>/dev/null | grep ":$PORT" | awk '{print $4}' | tr '\n' ' '; echo "（应只有 127.0.0.1）"
echo "  容器里 uid 映射：$(podman exec "$cid" /bin/node -e 'process.stdout.write(require("node:fs").readFileSync("/proc/self/uid_map","utf8"))' 2>/dev/null | tr -s ' ')"
echo "  日志尾巴："; "$PODMAN" logs "$cid" 2>&1 | tail -5 | sed 's/^/    /'
"$PODMAN" kill "$cid" >/dev/null 2>&1
echo "（容器已收，数据留在 $DATA）"
