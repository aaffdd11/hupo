#!/usr/bin/env bash
# 开发者入口"换房间"那条路的**真机验收**（B43 第二版 · 契约 `docs/dev/110-ONE-SESSION-PER-ROOM.md` §八·补3）。
#
# ── 它做的是什么 ────────────────────────────────────────────
#   起一台**一次性容器**（同镜像、同 `--cap-drop=ALL` 那五条、`--memory=768m`、
#   `--pids-limit=512`），挂一份**产品层**，在盒里**真起 `dsh web`**、**真换房间**，
#   读**这个容器自己的** `/proc` 与 cgroup（`oom_kill` / `memory.max` / `--profile web` 的 cwd）。
#   ⇒ 真内核、真 cgroup、真 dsh、真换手 —— 但 **不碰任何租户的盒子、不发布、不重启任何东西**。
#
# ── 用法 ────────────────────────────────────────────────────
#   bash scripts/check-dev-mode-container.sh --layer /srv/hupo/tenant-code/<指纹>
#   … 房间序列（默认 main,aoshu-bank,main,aoshu-bank = 换 3 次）：
#   bash scripts/check-dev-mode-container.sh --layer <指纹> --seq ghost,ghost,ghost,ghost
#     ⚠️ `ghost` 是一间 **cwd 故意不存在**的房间 ⇒ 量"失败之后会不会反复起"（spawn 风暴）。
#
# 造一份产品层（**不要 `--publish`** —— 那要主人签字）：
#   bash scripts/build-tenant-code.sh     # 打印指纹，落在 /srv/hupo/tenant-code/<指纹>
#
# ⚠️ 要 `deploy` 身份跑（rootless podman 的镜像在他自己的存储里）。
# ⚠️ 容器 `--rm`，跑完什么都不留（`/data` 那份临时目录也清掉）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PODMAN="${PODMAN_BIN:-/usr/bin/podman}"
IMG="${HUPO_TENANT_IMAGE:-localhost/hupo-tenant:local}"
LAYER=""
SEQ="main,aoshu-bank,main,aoshu-bank"

while [ $# -gt 0 ]; do
  case "$1" in
    --layer) LAYER="${2:-}"; shift ;;
    --seq)   SEQ="${2:-}"; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "✗ 不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$LAYER" ] || { echo "✗ 要 --layer <产品层目录>（用 build-tenant-code.sh 造，别 --publish）" >&2; exit 2; }
[ -d "$LAYER" ] || { echo "✗ 产品层不在：$LAYER" >&2; exit 2; }

WORK="$(mktemp -d /tmp/hupo-devcheck-XXXXXX)"
DATA="$WORK/data"
mkdir -p "$DATA"
HARNESS="$WORK/run.mjs"
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT

cat > "$HARNESS" <<'HARNESS_EOF'
// **一次性容器里的真机验收**（B43 第二版）：真起 `dsh web`、真换房间、
// 读**这个容器自己的** `/proc` 与 cgroup（`oom_kill` / `memory.max`）。
//
// ⚠️ 这不是夹具：跑在 `localhost/hupo-tenant:local` 的**真容器**里，参数照
//    `create-tenant-pool.sh` 抄（`--cap-drop=ALL` 只加回五条 ⇒ **没有 CAP_KILL**、
//    `--memory=768m`、`--pids-limit=512`），dsh 是镜像里那支真的，uid 换手也是真的。
//
// 用法（容器里）：node /harness/run.mjs "main,aoshu-bank,main,aoshu-bank"
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import nodeNet from 'node:net';
import nodeCrypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SEQ = String(process.argv[2] ?? 'main,aoshu-bank,main,aoshu-bank').split(',');
const LAYER = process.env.HUPO_CODE_DIR ?? '/app/code';
const said = [];
const relayLog = (m) => {
  said.push(String(m));
  console.log(`  [中继] ${m}`);
};

// ── ① `/data` 铺好（与真 `entry.mjs` 同一套布局与属主）──────────────
// ⚠️ 先**清空**（容器 root 有 DAC_OVERRIDE ⇒ 上一轮 uid 1000 留下的东西也删得掉）
try {
  for (const n of nodeFs.readdirSync('/data')) nodeFs.rmSync(`/data/${n}`, { recursive: true, force: true });
} catch (err) {
  console.log(`  ⚠️ /data 没清干净：${err?.code ?? err}`);
}
nodeFs.mkdirSync('/data', { recursive: true, mode: 0o700 });
for (const d of ['/data/main', '/data/workspaces', '/data/workspaces/aoshu-bank', '/data/dsh', '/data/hupo']) {
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
for (const d of ['/data/main', '/data/workspaces', '/data/workspaces/aoshu-bank', '/data/dsh', '/data/hupo']) {
  own(d, 1000, 1000, 0o700);
}

// ── ② 环境：照 `entry.mjs` 那几行（**产品层指到挂进来的那一份**）──────
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

const { loadConfig } = await import(`${LAYER}/src/config.js`);
const { createDevWebRelay } = await import(`${LAYER}/src/dev-mode.js`);
const cfg = loadConfig();

const ROOMS = [
  { id: 'main', name: '主对话', cwd: '/data/main' },
  { id: 'aoshu-bank', name: 'aoshu-bank', cwd: '/data/workspaces/aoshu-bank' },
  // ⚠️ 这一间**故意不存在**：用它量"失败之后会不会反复起"（父 agent 在 u2 上看到的 spawn 风暴）
  { id: 'ghost', name: 'ghost', cwd: '/data/workspaces/ghost' },
];

const relay = createDevWebRelay({
  cfg,
  rooms: () => ROOMS,
  // ⚠️ 与生产那一支逐字一样：盒里才开扫孤儿（`serve.js` 的 `devContainer`）
  sweepOrphans: true,
  log: relayLog,
});

// ── ③ 一条**真 HTTP** 前门（生产里那是容器里那条 `0600` UDS）────────
const front = nodeHttp.createServer((req, res) => {
  relay.handle(req, res, req.url.replace(/^\/h/u, '') || '/');
});
front.on('upgrade', (req, sock, head) => {
  relay.handleUpgrade(req, sock, head, req.url.replace(/^\/h/u, '') || '/');
});
await new Promise((r) => front.listen(0, '127.0.0.1', r));
const PORT = front.address().port;

// ── ④ 读数：这个容器自己的 `/proc` 与 cgroup（**不用被测代码**）──────
const readOrNull = (p) => {
  try {
    return nodeFs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
};

/** `/proc/<pid>/cwd`：容器 root 没有 CAP_SYS_PTRACE ⇒ 用**同 uid 的小 helper** 读。 */
function cwdOf(pid) {
  try {
    return { via: 'root', cwd: nodeFs.readlinkSync(`/proc/${pid}/cwd`) };
  } catch {
    /* 试同 uid 的 helper */
  }
  const r = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(require("fs").readlinkSync("/proc/"+process.argv[1]+"/cwd"))', String(pid)],
    { uid: 1000, gid: 1000, encoding: 'utf8', timeout: 3000 },
  );
  if (r.status === 0 && r.stdout) return { via: 'uid1000-helper', cwd: String(r.stdout).trim() };
  return { via: '读不到', cwd: null, why: String(r.stderr ?? '').trim().slice(0, 120) };
}

/** 这个容器里所有 `--profile web`（**自己写的一份判据**，不借被测代码）。 */
function webProcs() {
  const out = [];
  let names = [];
  try {
    names = nodeFs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^\d+$/u.test(n)) continue;
    let raw;
    try {
      raw = nodeFs.readFileSync(`/proc/${n}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    const args = raw.split('\0').filter((a) => a !== '');
    let web = false;
    for (let i = 0; i + 1 < args.length; i += 1) {
      if (args[i] === '--profile' && args[i + 1] === 'web') web = true;
    }
    if (!web) continue;
    const pid = Number.parseInt(n, 10);
    const rssKb = Number.parseInt(/VmRSS:\s+(\d+)/u.exec(readOrNull(`/proc/${n}/status`) ?? '')?.[1] ?? '0', 10);
    out.push({ pid, rssKb, ...cwdOf(pid) });
  }
  return out;
}

function boxState() {
  const ev = readOrNull('/sys/fs/cgroup/memory.events');
  const cur = readOrNull('/sys/fs/cgroup/memory.current');
  const max = readOrNull('/sys/fs/cgroup/memory.max');
  return {
    oom_kill: ev === null ? null : Number.parseInt(/oom_kill\s+(\d+)/u.exec(ev)?.[1] ?? '-1', 10),
    mem_max_mb: max === null ? null : Math.round(Number.parseInt(max, 10) / 1048576),
    mem_current_mb: cur === null ? null : Math.round(Number.parseInt(cur, 10) / 1048576),
    webs: webProcs(),
    relay: relay.state(),
  };
}

/** 真升级一次 `/api/remote.mux`（裸 WS 握手 —— 只看状态行）。 */
function upgrade(port, path) {
  return new Promise((resolve) => {
    const key = nodeCrypto.randomBytes(16).toString('base64');
    const s = nodeNet.connect(port, '127.0.0.1');
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
    s.on('connect', () => {
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) fin(buf.slice(0, buf.indexOf('\r\n')).trim());
    });
    s.on('error', (err) => fin(`错：${err?.code ?? err?.message}`));
    s.on('close', () => fin('关掉了（没拿到响应头）'));
  });
}

const base = `http://127.0.0.1:${PORT}/h`;
const rows = [];
const before = boxState();
console.log(`▶ 开跑（产品层 ${LAYER}）：${SEQ.join(' → ')}`);
for (const id of SEQ) {
  const sel = await fetch(`${base}/?room=${encodeURIComponent(id)}`, { redirect: 'manual' });
  const page = await fetch(`${base}/`, { redirect: 'manual' });
  const html = await page.text();
  const up = await upgrade(PORT, '/h/api/remote.mux');
  const box = boxState();
  rows.push({
    room: id,
    sel: sel.status,
    page: page.status,
    boot: /__DSH_BOOT__/u.test(html),
    bytes: html.length,
    ...(page.status === 200 ? {} : { pageText: html.replace(/\s+/gu, ' ').trim().slice(0, 80) }),
    upgrade: up,
    box,
  });
  console.log(
    `▶ ${id}：选=${sel.status} 取页=${page.status}${/__DSH_BOOT__/u.test(html) ? '(有 boot)' : ''} ` +
      `升级=${up} ｜ web 进程 ${box.webs.length} 台 ｜ oom_kill=${box.oom_kill} mem=${box.mem_current_mb}MB`,
  );
}

const after = boxState();
const spawnAttempts = said.filter((m) => /dsh web 没起来/u.test(m)).length;
console.log(`\n════ 汇总 ════`);
console.log(JSON.stringify({ layer: LAYER, seq: SEQ, before, rows, after, spawnAttempts, relayLog: said }, null, 2));
relay.shutdown();
await new Promise((r) => front.close(r));
process.exit(0);
HARNESS_EOF

echo "▶ 一次性容器 ｜ 产品层 $LAYER ｜ 序列 $SEQ ｜ 镜像 $IMG"
echo "  （不发布、不重启、不碰任何租户的盒子）"
"$PODMAN" run --rm --name "hupo-devcheck-$$" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --tmpfs /run/hupo:rw,nosuid,nodev,mode=0700 \
  -v "$DATA":/data \
  -v "$LAYER":/app/code:ro \
  -v "$HARNESS":/harness/run.mjs:ro \
  --env HUPO_ROLE=tenant \
  --env HUPO_CODE_DIR=/app/code \
  --security-opt=no-new-privileges \
  --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID --cap-add=FOWNER \
  --pids-limit=512 --memory=768m --memory-swap=768m --cpus=4 \
  "$IMG" /bin/node /harness/run.mjs "$SEQ"
RC=$?
echo "▶ 容器退出码：$RC"
exit "$RC"
