#!/usr/bin/env bash
# **B46 的真机验收**（契约 `docs/dev/110-ONE-SESSION-PER-ROOM.md` §八·补4）：
# 开发者入口把某一间开着（真 `dsh web` 活着、**并且真的占着那条会话的写租约**）时，
# 从**聊天那条路**往**同一间**说一句 ——
#   · 修后（`yieldRoom` 那一闸）：**必须成功**，而且收完只剩调度器那一台、`oom_kill` 不涨；
#   · 修前（`--expect fail` 的对照层，用修前的 `dev-mode.js`/`dispatcher.js`/`worlds.js`/`serve.js` 造）：
#     那一轮**失败**，原话就是主人遇到的那条 `already owned by an active write handle`。
#
# ── 它做的是什么 ────────────────────────────────────────────
#   起一台**一次性容器**（同镜像、同 cap（**没有 CAP_KILL**）、`--memory=768m`），
#   在盒里：① 用**真** `dsh --profile sdk` 造出这一间的会话；
#   ② 用**真**中继起一台**真** `dsh web` 把那间开着；
#   ③ 让那台 web **真的写开**这条会话（＝浏览器真的在看它；
#      容器里没有浏览器 ⇒ 直接打它自己那条 `/api` RPC：`session/selectModel`
#      第一句就是 `resolveAgent` ⇒ `ctx.agents.resume` ⇒ 真写开）；
#   ④ 再从**真调度器**那条路往同一间说一句，读**这个容器自己的** `/proc` 与 cgroup。
#   ⇒ **不碰任何租户的盒子、不发布、不重启任何东西**。
#
# ── 用法 ────────────────────────────────────────────────────
#   bash scripts/check-room-yield-container.sh --layer /srv/hupo/tenant-code/<指纹>
#   bash scripts/check-room-yield-container.sh --layer /tmp/prefix-layer --expect fail
#
#   造一份产品层（**不要 `--publish`** —— 那要主人签字）：
#     bash scripts/build-tenant-code.sh
#
#   造对照层（修前那四个文件；`<基>` 是上面那一版的目录）：
#     cp -r /srv/hupo/tenant-code/<指纹> /tmp/prefix-layer
#     for f in dev-mode.js dispatcher.js worlds.js serve.js; do
#       git show HEAD:v2/services/core/src/$f > /tmp/prefix-layer/src/$f
#     done
#
# ⚠️ 要 `deploy` 身份跑（rootless podman 的镜像在他自己的存储里）。
# ⚠️ 容器 `--rm`，跑完什么都不留（`/data` 那份临时目录也清掉）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PODMAN="${PODMAN_BIN:-/usr/bin/podman}"
IMG="${HUPO_TENANT_IMAGE:-localhost/hupo-tenant:local}"
LAYER=""
EXPECT="pass"
SCOPE="${B46_SCOPE:-aoshu-bank}"

while [ $# -gt 0 ]; do
  case "$1" in
    --layer)  LAYER="${2:-}"; shift ;;
    --expect) EXPECT="${2:-}"; shift ;;
    --scope)  SCOPE="${2:-}"; shift ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "✗ 不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$LAYER" ] || { echo "✗ 要 --layer <产品层目录>（用 build-tenant-code.sh 造，别 --publish）" >&2; exit 2; }
[ -d "$LAYER" ] || { echo "✗ 产品层不在：$LAYER" >&2; exit 2; }
case "$EXPECT" in pass|fail) ;; *) echo "✗ --expect 只认 pass / fail" >&2; exit 2 ;; esac

WORK="$(mktemp -d /tmp/hupo-b46-XXXXXX)"
DATA="$WORK/data"
mkdir -p "$DATA"
HARNESS="$WORK/run.mjs"
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT

cat > "$HARNESS" <<'HARNESS_EOF'
// **B46 一次性容器夹具**：入口开着某一间（真 `dsh web`，真写租约），
// 再让**真调度器**那条路往同一间说一句；读这个容器自己的 `/proc` 与 cgroup。
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeNet from 'node:net';
import nodeCrypto from 'node:crypto';

const LAYER = process.env.HUPO_CODE_DIR ?? '/app/code';
const SCOPE = process.env.B46_SCOPE ?? 'aoshu-bank';
const EXPECT = process.env.B46_EXPECT ?? 'pass';
const ROOM_CWD = `/data/workspaces/${SCOPE}`;
const relayLog = (m) => console.log(`  [中继] ${m}`);

// ── ① `/data` 铺好（与真 `entry.mjs` 同一套布局与属主）──────────────
try {
  for (const n of nodeFs.readdirSync('/data')) nodeFs.rmSync(`/data/${n}`, { recursive: true, force: true });
} catch {
  /* 空目录 / 清不动都不影响这一条 */
}
nodeFs.mkdirSync('/data', { recursive: true, mode: 0o700 });
for (const d of ['/data/main', '/data/workspaces', ROOM_CWD, '/data/dsh', '/data/hupo']) {
  nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 });
}
const own = (p, u, g, mode) => {
  try {
    nodeFs.chownSync(p, u, g);
    nodeFs.chmodSync(p, mode);
  } catch (err) {
    console.log(`  ⚠️ chown/chmod ${p} 没成：${err?.code ?? err}`);
  }
};
own('/data', 0, 0, 0o711);
for (const d of ['/data/main', '/data/workspaces', ROOM_CWD, '/data/dsh', '/data/hupo']) own(d, 1000, 1000, 0o700);

// ── ② 环境：照 `entry.mjs` 那几行（产品层指到挂进来的那一份）──────────
process.env.HUPO_PERSONA ??= `${LAYER}/hupo-persona.yml`;
process.env.HUPO_CAPABILITIES ??= `${LAYER}/hupo-capabilities.yml`;
process.env.HUPO_MODEL_PATCH ??= `${LAYER}/hupo-model-proxy.yml`;
process.env.HUPO_SDK_PATCH ??= `${LAYER}/hupo-sdk-server.yml`;
process.env.HUPO_LEDGER_SERVER ??= `${LAYER}/src/mcp-ledger-server.mjs`;
process.env.HUPO_NODE_BIN ??= process.execPath;
process.env.HUPO_DATA ??= '/data';
process.env.DSH_HOME ??= '/data/dsh';
process.env.HUPO_AGENT_UID ??= '1000';
process.env.HUPO_AGENT_GID ??= '1000';
process.env.HUPO_SDK_SERVER ??= `${LAYER}/src/sdk-server-hupo.mjs`;
process.env.HUPO_SESSION_MAP ??= '/data/dsh-sessions.json';
process.env.HUPO_AGENT_CWD ??= ROOM_CWD;
process.env.HUPO_DSH_BIN ??= 'dsh';

const { loadConfig } = await import(`${LAYER}/src/config.js`);
const { createDevWebRelay } = await import(`${LAYER}/src/dev-mode.js`);
const { AgentRuntime } = await import(`${LAYER}/src/agent-runtime.js`);
const { Dispatcher } = await import(`${LAYER}/src/dispatcher.js`);
const { Store } = await import(`${LAYER}/src/store.js`);
const { Timeline } = await import(`${LAYER}/src/timeline.js`);

const cfg = loadConfig();
cfg.agentCwd = ROOM_CWD; // 这一间
cfg.dshHome = '/data/dsh';
cfg.sessionMapPath = '/data/dsh-sessions.json';

const readOrNull = (p) => {
  try {
    return nodeFs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
};

/** 这个容器里所有 dsh 进程（**自己写的一份判据**，不借被测代码；探针自己先排除）。 */
function dshProcs() {
  const out = [];
  let names = [];
  try {
    names = nodeFs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^\d+$/u.test(n)) continue;
    if (Number(n) === process.pid) continue; // ⚠️ 探针自己（`pgrep -f` 那个老坑）
    let raw;
    try {
      raw = nodeFs.readFileSync(`/proc/${n}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    const args = raw.split('\0').filter((a) => a !== '');
    if (args.length === 0) continue;
    let profile = null;
    for (let i = 0; i + 1 < args.length; i += 1) if (args[i] === '--profile') profile = args[i + 1];
    const isDsh = args.some((a) => /(^|\/)dsh$/u.test(a));
    if (profile === null && !isDsh) continue;
    const rssKb = Number.parseInt(/VmRSS:\s+(\d+)/u.exec(readOrNull(`/proc/${n}/status`) ?? '')?.[1] ?? '0', 10);
    out.push({ pid: Number(n), profile, rssKb, cmd: args.slice(0, 4).join(' ') });
  }
  return out;
}

function boxState() {
  const ev = readOrNull('/sys/fs/cgroup/memory.events');
  const cur = readOrNull('/sys/fs/cgroup/memory.current');
  return {
    oom_kill: ev === null ? null : Number.parseInt(/oom_kill\s+(\d+)/u.exec(ev)?.[1] ?? '-1', 10),
    mem_current_mb: cur === null ? null : Math.round(Number.parseInt(cur, 10) / 1048576),
    procs: dshProcs(),
  };
}

// ── ③ 先**造出**这一间的会话（调度器那条路来一次；做完收掉，把租约放开）──
const store = new Store({ dataDir: '/data/hupo', fsync: false });
const timeline = new Timeline({ id: 'main', store });
const mkRuntime = () => new AgentRuntime({ cfg });
let runtime = mkRuntime();
let dispatcher = new Dispatcher({ timeline, runtime, store, scopeId: SCOPE, agentKey: `owner/${SCOPE}` });
const first = await dispatcher.deliver('先开一条会话', { messageId: 'u_0' });
console.log(`▶ ① 造会话（真 dsh --profile sdk）：delivered=${first.delivered} err=${String(first.error ?? '').slice(0, 160)}`);
await dispatcher.shutdown().catch(() => {});
await runtime.shutdown().catch(() => {});
await new Promise((r) => setTimeout(r, 300));
console.log(`   会话映射：${readOrNull('/data/dsh-sessions.json')}`);

// ── ④ 入口把这一间开着（真 `dsh web`）──────────────────────────────
const relay = createDevWebRelay({
  cfg,
  rooms: () => [{ id: SCOPE, name: SCOPE, cwd: ROOM_CWD }],
  // ⚠️ 与生产那一支逐字一样：盒里才开扫孤儿（`serve.js` 的 `devContainer`）
  sweepOrphans: true,
  log: relayLog,
});
const front = nodeHttp.createServer((req, res) => relay.handle(req, res, req.url.replace(/^\/h/u, '') || '/'));
front.on('upgrade', (req, sock, head) => relay.handleUpgrade(req, sock, head, req.url.replace(/^\/h/u, '') || '/'));
await new Promise((r) => front.listen(0, '127.0.0.1', r));
const PORT = front.address().port;
const base = `http://127.0.0.1:${PORT}/h`;
const sel = await fetch(`${base}/?room=${encodeURIComponent(SCOPE)}`, { redirect: 'manual' });
const page = await fetch(`${base}/`, { redirect: 'manual' });
const html = await page.text();
// 真升一次级（浏览器真的会连上来 —— 与 B43 那条同一个做法）
const upgrade = await new Promise((resolve) => {
  const key = nodeCrypto.randomBytes(16).toString('base64');
  const s = nodeNet.connect(PORT, '127.0.0.1');
  let buf = '';
  let done = false;
  const fin = (v) => {
    if (done) return;
    done = true;
    clearTimeout(t);
    try {
      s.destroy();
    } catch {
      /* 已经没了 */
    }
    resolve(v);
  };
  const t = setTimeout(() => fin('超时'), 30000);
  s.on('connect', () =>
    s.write(
      `GET /h/api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ),
  );
  s.on('data', (d) => {
    buf += d.toString('latin1');
    if (buf.includes('\r\n\r\n')) fin(buf.slice(0, buf.indexOf('\r\n')).trim());
  });
  s.on('error', (err) => fin(`错：${err?.code ?? err?.message}`));
  s.on('close', () => fin('关掉了（没拿到响应头）'));
});
console.log(`▶ ② 入口开着 ${SCOPE}：选=${sel.status} 取页=${page.status} boot=${/__DSH_BOOT__/u.test(html)} 升级=${upgrade}`);
const afterEntry = boxState();
console.log(`   入口开着时的 dsh 进程：${JSON.stringify(afterEntry.procs)}；oom_kill=${afterEntry.oom_kill} mem=${afterEntry.mem_current_mb}MB`);

// ── ⑤ 让入口那台**真的写开**这条会话（＝浏览器真的在看它）──────────
// DSH 的 web 只在"有人要看这条会话"时才写开它（真机那次就是主人开着页面）。
// 容器里没有浏览器 ⇒ 直接打它自己那条 `/api` RPC：`session/selectModel`
// 第一句就是 `resolveAgent` ⇒ `ctx.agents.resume` ⇒ **真的写开**（拿住那把写租约）。
// ⚠️ 那一帧**回什么都不要紧**（盒里没有模型 ⇒ `session/model-unavailable`）——
//    要紧的是"写开"这一步已经发生了：**这就是主人那次现场**。
const rpcId = nodeCrypto.randomUUID();
const rpcBody = JSON.stringify({
  type: 'client-request',
  rpcId,
  method: 'session/selectModel',
  payload: { args: { request: { sessionId: SCOPE, provider: 'deepseek', model: 'deepseek-chat' } } },
});
let resumeResp = null;
try {
  const r = await fetch(`${base}/api/session/selectModel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rpcBody,
  });
  resumeResp = { status: r.status, body: (await r.text()).slice(0, 300) };
} catch (err) {
  resumeResp = { status: null, body: `错：${err?.message ?? err}` };
}
console.log(`▶ ②′ 让入口写开这条会话：${JSON.stringify(resumeResp)}`);

// ── ⑥ 调度器那条路往**同一间**说一句 ──────────────────────────────
runtime = mkRuntime();
dispatcher = new Dispatcher({
  timeline,
  runtime,
  store,
  scopeId: SCOPE,
  agentKey: `owner/${SCOPE}`,
  // 🔴 修后那一层：`serve.js` 把中继的 `yieldRoom` 接到这儿；
  //    修前那一层没有这个入参（传了也不认）⇒ 不会让开。
  yieldRoom: (scope) => relay.yieldRoom(scope),
});
const said = await dispatcher.deliver('怎么题库还是没有？', { messageId: 'u_1' });
console.log(`▶ ③ 调度器往同一间说一句：delivered=${said.delivered}`);
console.log(`    err=${String(said.error ?? '（无）').slice(0, 240)}`);

const after = boxState();
const webs = after.procs.filter((p) => p.profile === 'web');
const sdks = after.procs.filter((p) => p.profile === 'sdk');
console.log(`▶ ④ 说完之后：oom_kill=${after.oom_kill}（入口时 ${afterEntry.oom_kill}）mem=${after.mem_current_mb}MB`);
console.log(`   /proc 里的 dsh 进程：${JSON.stringify(after.procs)}`);
console.log(`   其中 --profile web=${webs.length} 台；--profile sdk=${sdks.length} 台`);

const summary = {
  layer: LAYER,
  scope: SCOPE,
  expect: EXPECT,
  sel: sel.status,
  page: page.status,
  upgrade,
  resumeResp,
  firstDelivered: first.delivered === true,
  saidDelivered: said.delivered === true,
  saidError: String(said.error ?? ''),
  oomBefore: afterEntry.oom_kill,
  oomAfter: after.oom_kill,
  webs: webs.length,
  sdks: sdks.length,
  procs: after.procs,
};

await dispatcher.shutdown().catch(() => {});
await runtime.shutdown().catch(() => {});
relay.shutdown();
await new Promise((r) => front.close(r));

// ── ⑦ 判据（**这一份自己判**，退出码就是读数）────────────────────
let ok = true;
const no = (m) => {
  ok = false;
  console.log(`   ✗ ${m}`);
};
const yes = (m) => console.log(`   ✓ ${m}`);
if (!summary.firstDelivered) no('① 那一间连会话都没造出来 —— 这一条验不了（先看上面那条读数）');
else yes('① 这一间的会话造出来了（真 dsh）');
if (summary.oomAfter !== null && summary.oomBefore !== null && summary.oomAfter > summary.oomBefore) {
  no(`oom_kill 涨了（${summary.oomBefore} → ${summary.oomAfter}）`);
} else {
  yes(`oom_kill 没涨（${summary.oomBefore} → ${summary.oomAfter}）`);
}
if (EXPECT === 'pass') {
  if (summary.saidDelivered) yes('② 那一轮**成功**了（让开真的发生）');
  else no(`② 那一轮没成功：${summary.saidError.slice(0, 200)}`);
  if (summary.webs === 0) yes('③ 收完 `--profile web` = 0 台');
  else no(`③ 收完还剩 ${summary.webs} 台 \`--profile web\``);
  if (summary.sdks >= 1) yes(`③ 只剩调度器那一台（--profile sdk = ${summary.sdks}）`);
  else no('③ 调度器那一台也不在（不该）');
} else {
  if (!summary.saidDelivered && /already owned by an active write handle/u.test(summary.saidError)) {
    yes('② 那一轮**失败**，原话就是主人遇到的那条（写租约）');
  } else {
    no(`② 期望"被写租约拒"，实际：delivered=${summary.saidDelivered} err=${summary.saidError.slice(0, 200)}`);
  }
}

console.log(`\n════ 汇总 ════`);
console.log(JSON.stringify(summary, null, 2));
console.log(ok ? `\n✅ B46（--expect ${EXPECT}）：读数对上了` : `\n❌ B46（--expect ${EXPECT}）：读数对不上`);
process.exit(ok ? 0 : 1);
HARNESS_EOF

echo "▶ 一次性容器 ｜ 产品层 $LAYER ｜ 期望 $EXPECT ｜ 房间 $SCOPE ｜ 镜像 $IMG"
echo "  （不发布、不重启、不碰任何租户的盒子）"
"$PODMAN" run --rm --name "hupo-b46-$$" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --tmpfs /run/hupo:rw,nosuid,nodev,mode=0700 \
  -v "$DATA":/data \
  -v "$LAYER":/app/code:ro \
  -v "$HARNESS":/harness/run.mjs:ro \
  --env HUPO_ROLE=tenant \
  --env HUPO_CODE_DIR=/app/code \
  --env B46_SCOPE="$SCOPE" \
  --env B46_EXPECT="$EXPECT" \
  --security-opt=no-new-privileges \
  --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID --cap-add=FOWNER \
  --pids-limit=512 --memory=768m --memory-swap=768m --cpus=4 \
  "$IMG" /bin/node /harness/run.mjs
RC=$?
echo "▶ 容器退出码：$RC"
exit "$RC"
