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
#   · **`dsh`（agent 本体）** + 一个三行的启动器（见 ②·dsh 那段）
#   · 空目录 `/data`（**数据挂这里**，不放在容器那层可写层里）
#
# ✅ **2026-09-21：`dsh` 进来了**（多租户 ②-1）⇒ 镜像从 130MB 变成 ~435MB。
#    ⚠️ 但**所有租户共用同一份镜像层**（`podman images` 里只有一份），
#       所以"每人一台"并不等于"每人 435MB" —— 每人真正占的是**他自己的卷**。
#    ⚠️ **没有带 profile 模板**：`dsh` 自带 `sdk` profile，空 `DSH_HOME` 就能起
#       （见 ②·dsh 那三条实测）。
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

# ── ②·代理：让模型那条路走盒内的 root 小代理（多租户 ②-3）──
# ⚠️ 这一份是**静态**的：端口写死 8787，和 `model-proxy.mjs` 的默认值一致。
#    为什么不做成模板：它**没有任何按人不同的东西** —— 每个租户一台容器，
#    端口各自独立（容器有自己的网络命名空间）⇒ 一份就够。
cat > "$R/app/hupo-model-proxy.yml" <<'MODELPATCH'
# 让模型那条路走**盒内的 root 小代理**（多租户 ②-3 · `src/model-proxy.mjs`）。
#
# 为什么这样写：决策 ① 要求"**agent 读不到自己的 key**"，可 dsh 调模型必须有 key。
# ⇒ 把"持有"与"使用"分开：明文只在 `/run/hupo/creds.yaml`（tmpfs · root 0600），
#    由 root 小代理持有；agent 那一侧只有一个**占位符**（名字刻意**避开**
#    `_API_KEY` / `_TOKEN` / `_SECRET` / `DEEPSEEK` —— 否则会踩 V4b 的 env 扫描）。
- id: llm-deepseek
  config:
    baseURL: http://127.0.0.1:8787
    apiKeyEnv: HUPO_MODEL_TICKET
MODELPATCH
echo "  模型代理 patch: /app/hupo-model-proxy.yml"
echo "  服务: $(find "$R/app/src" -name '*.js' | wc -l) 个 js + ws"

# ── ②·dsh：**agent 本体**（多租户 ②-1）──
#
# ⚠️ 为什么必须带它：少了它，容器起来了也**没有 agent 可跑** ——
#    服务会 spawn 一个不存在的程序，现象只是"它不理我"（`agent-runtime.js` 里
#    那个 `ENOENT` 还分不清"程序找不到"和"工作目录不存在"）。
#
# ⚠️ **三条实测事实**（2026-09-21，都是先测了才写的）：
#   ① `dsh` 自带 `sdk` profile ⇒ **镜像里不需要带 profile 模板**。
#      空 `DSH_HOME` 直接 `dsh --profile sdk --dump-config` 就出 11178 字节的树；
#      我自己往镜像里塞模板是**多余**的（而且会多一份会漂的东西）。
#      （实测踩过：`--from-default-profile sdk` 会被它自己拒掉 ——
#        "profile sdk is shipped and cannot be a custom profile target"。）
#   ② 起的过程中**不碰任何包管理器 / registry**（实测 grep `pnpm|npm install|registry` = 0）
#      ⇒ 这台机器够不着 Docker Hub 也不影响。
#   ③ `bin.js` 只用 `process.argv.slice(2)`（**不看 argv[1]**），而且
#      **不直接调 shell**（没有 `exec(` / `shell:true` / `/bin/sh` 字面量）
#      ⇒ 可以用一个三行的启动器，也**不需要**往镜像里塞 `/bin/sh`。
#
# ⚠️ **启动器为什么是"改 shebang"而不是"包一层"**（2026-09-21，我两种都真的试了）：
#    镜像里没有 `/usr/bin/env`，而 `bin.js` 的 shebang 正是 `#!/usr/bin/env node`
#    ⇒ 直接执行它一定失败。
#    * ❌ **包一层不行**：写个 `import '.../bin.js'` 的启动器，进程会**静默退出 0、一个字都不输出**。
#      根因在 `bin.js` 最后一行：`if (import.meta.main) await runCli();` ——
#      被 import 时 `import.meta.main` 是 **false**（入口变成了启动器），
#      于是 `runCli()` **一次都没调**。⇒ 这类"包装一下就哑了"的坑正好是这个项目最忌的。
#    * ✅ **改 shebang 可以**：把**拷进来那一份**的第一行换成 `#!/bin/node`，
#      然后 `/bin/dsh` 直接指向它。此时它**仍然是被执行的入口** ⇒ `import.meta.main` 为真、
#      它自己那些**相对路径**的 `import("./plugin-….js")` 也照旧解析（没有搬家）。
DSH_BIN="$(command -v dsh || true)"
if [ -n "$DSH_BIN" ]; then
  DSH_PKG="$(dirname "$(dirname "$(readlink -f "$DSH_BIN")")")"
  if [ -d "$DSH_PKG/node_modules" ]; then
    mkdir -p "$R/app/node_modules/@deepseek-ai"
    echo "  dsh:  $DSH_PKG（$(du -sh "$DSH_PKG" | cut -f1)）—— 拷进去要一会儿"
    cp -r "$DSH_PKG" "$R/app/node_modules/@deepseek-ai/dsh"
    DSH_ENTRY="$R/app/node_modules/@deepseek-ai/dsh/lib/bin.js"
    sed -i '1s|^#!/usr/bin/env node$|#!/bin/node|' "$DSH_ENTRY"
    # ⚠️ **判据要卡在"真换了没有"上**：sed 没匹配上会**静默不改**，而那种镜像
    #    照样能 commit（现象是容器里 `dsh` 起不来）。
    [ "$(head -1 "$DSH_ENTRY")" = '#!/bin/node' ] \
      || { echo "✗ dsh 的 shebang 没换成 /bin/node —— 镜像里没有 /usr/bin/env，它一定跑不动"; exit 4; }
    chmod 755 "$DSH_ENTRY"
    ln -sf /app/node_modules/@deepseek-ai/dsh/lib/bin.js "$R/bin/dsh"
    echo "  dsh:  已放进 /app/node_modules + /bin/dsh（shebang 换成 /bin/node）"
  else
    echo "  ⚠️ dsh 的 node_modules 不在 $DSH_PKG —— 跳过了（agent 会在容器里起不来）"
  fi
else
  echo "  ⚠️ 宿主上没有 dsh —— 跳过了（agent 会在容器里起不来）"
fi

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
// 🔴 **换手**（②-2）：镜像里设了 `HUPO_AGENT_UID/GID=1000` ⇒ 服务（root）
//    spawn agent 时**把身份降到 1000**。理由：userns 的容器 root 带着
//    `CAP_DAC_OVERRIDE` ⇒ **agent 是 root 时任何权限位都拦不住它读 key**（决策 ①）。
//    ⚠️ 所以下面这几格**必须归 1000**，否则换手之后 agent 连自己的东西都写不了。
//    ⚠️ `/data/dsh` 是 **agent 的 `DSH_HOME`**（镜像里 `DSH_HOME=/data/dsh`）：
//       它也得归 agent —— 而且它只能由**入口**建（`/data` 是 root `0711`，
//       uid 1000 自己建不出这一格）。
const owned = [`${data}/main`, `${data}/workspaces`, `${data}/hupo`, `${data}/dsh`];
for (const d of [data, ...owned]) {
  try { nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}
// 属主照权限席给的：`/data` 是 root `0711`（能穿过去、列不出别人），
// 里面那几样归 **agent(1000) `0700`** —— 服务(root)读得到，别的租户读不到。
//
// 🔴 **`chmod` 必须在 `chown` 之前**：反过来的话，文件已经属于 1000 了，
//    root 再 chmod 就需要 `FOWNER`；而运行时**只带 4 条能力**（没有 FOWNER）。
//    实测见 `docs/dev/39-PERMISSIONS.md` §5.4.1 的 E 组与 I 组。
try { nodeFs.chmodSync(data, 0o711); } catch (e) { throw new Error(`entry: chmod ${data} 失败：${e.code}`); }
for (const d of owned) {
  nodeFs.chmodSync(d, 0o700);          // 此刻还是 root 自己的 ⇒ 不需要 FOWNER
  nodeFs.chownSync(d, 1000, 1000);     // 交给 agent
}
// ⚠️ **不许静默**：布局没铺成 ⇒ 边界就不在（而且这条边界是"悄悄失效"型的）。
//    自查一遍，对不上就**拒绝启动**，别让一个"看着像在跑"的盒子起来。
for (const d of owned) {
  const st = nodeFs.statSync(d);
  if (st.uid !== 1000 || st.gid !== 1000 || (st.mode & 0o777) !== 0o700) {
    throw new Error(`entry: ${d} 的属主/权限不对（要 1000:1000 0700，实为 ${st.uid}:${st.gid} 0${(st.mode & 0o777).toString(8)}）—— 拒绝启动`);
  }
}
const ds = nodeFs.statSync(data);
if (ds.uid !== 0 || (ds.mode & 0o777) !== 0o711) {
  throw new Error(`entry: ${data} 应为 root 0711，实为 ${ds.uid} 0${(ds.mode & 0o777).toString(8)} —— 拒绝启动`);
}

// ★ **盒子里的模型代理**（多租户 ②-3）：它**持有**那把 key，而 agent 只有占位符。
//   ⚠️ 在**起服务之前**起它 —— 服务一收请求就可能 spawn agent，
//      那时代理必须已经在听（否则第一句话会撞一个"连接被拒"）。
//   ⚠️ 它自己和 agent 是**两个身份**：代理是 root（这个入口就是 root），
//      agent 是 uid 1000 ⇒ agent 读不到那份 key 文件，但经这个口能用它。
//   ⚠️ 起不来**不许**把整个服务带走（用户还能看到界面，只是模型那条路不通）——
//      但**必须大声说**，不许静默降级。
//   ⚠️ key 文件住在 `/run/hupo`（**tmpfs**，由运行参数挂进来）：
//      它**不在** `/data`（那是卷、会落盘）也**不在** `/home`。
try {
  nodeFs.mkdirSync('/run/hupo', { recursive: true, mode: 0o700 });
} catch { /* 挂载点上建不了是正常的（podman 已经建好了） */ }
// ★ **领配置**（多租户 ②-4）：连回宿主那条通道，把这一台的模型凭据领回来，
//   写进 `/run/hupo/creds.yaml`（tmpfs · root 0600）。
//   ⚠️ **这是主人说的那五步的第 ②③④ 步**：容器起来是个空壳 ⇒ 等着 ⇒ 配置到了才往下走。
//   ⚠️ 领不到**不许**把服务挡住：界面照常起来，只是模型那条路会**如实**说不通
//      （`model-proxy` 没 key 时回 503 而不是去打扰上游）。
//   ⚠️ 宿主上没有 `HUPO_CHANNEL` ⇒ 这一整段不执行（宿主行为逐字不变）。
const channel = process.env.HUPO_CHANNEL ?? '';
if (channel) {
  try {
    const { fetchKeyFromHost } = await import('./src/tenant-shell.mjs');
    await fetchKeyFromHost({
      socketPath: channel,
      keyFile: process.env.HUPO_KEY_FILE ?? '/run/hupo/creds.yaml',
      waitMs: Number.parseInt(process.env.HUPO_CHANNEL_WAIT_MS ?? '120000', 10),
      log: (m) => console.log(m),
    });
  } catch (err) {
    console.error(`  ⚠️ 领配置那一步没做成：${err?.message ?? err}（界面照常，模型那条路会说不通）`);
  }
}

try {
  const { startModelProxy } = await import('./src/model-proxy.mjs');
  await startModelProxy({ log: (m) => console.log(m) }).listen();
} catch (err) {
  console.error(`  ⚠️ 模型代理没起来：${err?.message ?? err} —— 模型那条路会不通（界面照常）`);
}

// 起真正的服务（**同一个进程**，不多一层 shell）
await import('./src/serve.js');
ENTRY
echo "  入口: /app/entry.mjs"

# ── ③ 最小的 /etc（node 与 shell 都要用）──
# ⚠️ 两个身份（容器内权限席的结论）：**服务/终端 = root**（uid0→宿主租户），
#    **agent 的手 = uid 1000**。理由：userns 的 root 有 CAP_DAC_OVERRIDE
#    ⇒ agent 若是 uid0，**任何权限位都拦不住它读 key**。
#
# 🔴 主人 2026-09-21 拍板 ①：**agent 读不到自己的 key**（"原则上就是 agent 读不到"）。
#    ⇒ 由此**推出运行时要带哪几条能力**（实测验出来的，见 39-PERMISSIONS.md §5.4）：
#
#      --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE \
#                     --cap-add=SETUID --cap-add=SETGID --security-opt=no-new-privileges
#
#    · SETUID/SETGID  ：root 服务**把 agent 降权到 1000** 的唯一办法。
#                       实测：全丢 ⇒ 降权 EPERM（边界根本装不上）；补上 ⇒ 成。
#    · CHOWN          ：把 main/workspaces/hupo 交给 1000。实测：没有它 ⇒ chown EPERM。
#    · DAC_OVERRIDE   ：服务要读**用户自己的**话（/data/main 是 1000:0700）。
#                       实测：没有它 ⇒ root 读 main.jsonl 也 EACCES（那是它该读的东西）。
#    · ⚠️ **chmod 要放在 chown 之前** ⇒ 否则还需要 FOWNER（实测：chown 之后再 chmod ⇒ EPERM）。
#    · ❌ **dpkg 那组（FSETID/SETFCAP/MKNOD/KILL/SYS_CHROOT）已经不给了** ——
#      它们原来的理由是"agent 要 apt 装包"，而决定 ① 把这个理由拿掉了
#      （apt = root = 读得到 key，与 ① 不可兼得）。⇒ 10 条收到 4 条。
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
# ⚠️ **`HUPO_DSH_BIN` 要给绝对路径**：scratch 镜像的 PATH 不由我们决定，
#    而 `resolveDshBin()` 默认只是 `dsh` ⇒ 不给这一条就可能 spawn 不到。
# ⚠️ **注释不许写在续行命令中间**（2026-09-21 我真踩了）：`\` 之后那一行的 `#`
#    **不是注释**（那一行已经被拼进同一条命令了）⇒ 整条 `buildah config` 会失败，
#    镜像**没有 Cmd/Env**，而脚本**照样打印"镜像好了"**（因为 commit 还是成功的）。
#    ⇒ 所以注释放在**整条命令之前**。
"$BUILDAH" config \
  --workingdir /app \
  --env HUPO_DATA=/data \
  --env HUPO_PORT=8080 \
  --env HUPO_HOST=0.0.0.0 \
  --env HUPO_WEB=/nonexistent \
  --env HUPO_AGENT_CWD=/data/main \
  --env HUPO_DSH_BIN=/bin/dsh \
  --env HUPO_AGENT_UID=1000 \
  --env HUPO_AGENT_GID=1000 \
  --env DSH_HOME=/data/dsh \
  --env HUPO_MODEL_PATCH=/app/hupo-model-proxy.yml \
  --env HUPO_MODEL_TICKET=hupo-local-model-proxy \
  --env HUPO_KEY_FILE=/run/hupo/creds.yaml \
  --cmd '["/bin/node","/app/entry.mjs"]' \
  "$ctr" >/dev/null || { echo "✗ buildah config 失败 —— 镜像会缺 Cmd/Env，不许往下走"; exit 3; }
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
    --read-only --tmpfs /tmp --tmpfs /run/hupo:rw,nosuid,nodev,mode=0700 \
    --security-opt=no-new-privileges \
    --cap-drop=ALL \
    --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID \
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
# ⚠️ 判据要挑**存在的**路径：scratch 镜像里没有 /usr，拿它试写会得到 ENOENT —
#    那证明的是"路径不存在"，不是"只读"（这就是"看着像过了"）。
echo -n "  根真只读吗（挑存在的 /etc/hosts）："
"$PODMAN" exec "$cid" /bin/node -e 'try{require("node:fs").appendFileSync("/etc/hosts","# canary\n");console.log("🔴 写得进去 —— 根不是只读")}catch(e){console.log("✅ 【"+e.code+"】")}' 2>/dev/null
echo -n "  正对照（/tmp 与 /data 该能写）："
"$PODMAN" exec "$cid" /bin/node -e 'const fs=require("node:fs");const o=[];for(const p of ["/tmp/canary","/data/canary"]){try{fs.writeFileSync(p,"y");o.push(p+" ✓")}catch(e){o.push(p+" 【"+e.code+"】")}}console.log(o.join(" | "))' 2>/dev/null
echo "  日志尾巴："; "$PODMAN" logs "$cid" 2>&1 | tail -5 | sed 's/^/    /'
"$PODMAN" kill "$cid" >/dev/null 2>&1
echo "（容器已收，数据留在 $DATA）"
