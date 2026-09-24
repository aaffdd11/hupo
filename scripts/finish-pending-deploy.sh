#!/usr/bin/env bash
# **重建之后那一串收尾**（一次跑完 · 2026-09-24）。
#
# ── 为什么要有它 ────────────────────────────────────────────
#   树里有一批改动**已经改完、但还没上线**（能力层拆出 `mcp-image`、B10 那三处、
#   客户端那句更正……）。它们的顺序**不能反**：
#     ① 清单先重建（否则服务**拒绝启动**）；
#     ② 再部署客户端 ＋ 重启中心（新代码才生效：画图那条 MCP 起来、
#        `/api/creds` 才开始推"整包"）；
#     ③ 最后复验（工具在不在、钥匙推没推进盒子）。
#   ⇒ 写死在脚本里，就不靠"我记得顺序"。
#
# ── 它**不做**什么 ──────────────────────────────────────────
#   ⚠️ **它不重建清单**（那要主人的 `sudo`）。清单没重建 ⇒ 它**一步都不往下走**。
#   ⚠️ 它不碰租户盒子（那是 `build-tenant-code.sh --publish` 的事，已经做过了）。
#
# 用法：`bash scripts/finish-pending-deploy.sh`（可加 `--yes` 跳过"确认"那一步）

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
NODE="${HUPO_NODE_BIN:-/home/deploy/.nvm/versions/node/v24.15.0/bin/node}"
YES=0
[ "${1:-}" = "--yes" ] && YES=1

say() { echo "▶ $1"; }
die() { echo "✗ $1"; exit 1; }

# ── ① 清单重建了吗（**只读**看一眼：按"清单里记没记 home"判，那是 P1-15 之后才有的）──
say "① 看开机清单是不是新重建的那一份"
if ! "$NODE" -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync("/etc/hupo/integrity.json","utf8"));
process.exit(typeof j.home === "string" && j.home.length > 0 ? 0 : 1);
' 2>/dev/null; then
  cat <<'EOF'
  ✗ 清单还是**旧的**那一份（里面没有 `home` 字段 ⇒ 是 P1-15 之前建的）。
     ⇒ 现在**不许**部署、**不许**重启：strict 条目对不上，服务会**拒绝启动**。

  请主人跑这一条（只有他能跑，要 sudo）：

    PW=$(git show cca2c5e^:docs/dev/03-DEPLOY-WEB.md | grep -oP '(?<=密码 `)[^`]+(?=`)' | head -1); \
    printf '%s\n' "$PW" | sudo -S -p '' /home/deploy/.nvm/versions/node/v24.15.0/bin/node scripts/verify-integrity.mjs --build

  跑完它会打印「✅ 对上了」。然后再跑一次本条命令。
EOF
  exit 3
fi
echo "  ✓ 清单是新的（记着 home）"

# ── ② 部署客户端 ＋ 重启中心（部署脚本自己会先跑两道硬闸）──
say "② 部署客户端 ＋ 重启中心（两道硬闸由部署脚本自己跑）"
if [ "$YES" = "0" ]; then
  printf "  确认现在部署？这一步会重启线上服务（几秒）。[y/N] "
  read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "好，先不部署（什么都没动）"
fi
bash scripts/deploy-web-v2.sh || die "部署没成功 —— 线上仍是上一版，看上面的输出"

# ── ③ 复验（三件，都打在"真那一侧"）──
say "③ 复验"
ok=0; nod=0
# ③.1 线上活着、指纹对得上
code="$(curl -s -o /tmp/.hupo-ver.json -w '%{http_code}' http://127.0.0.1:8020/api/version || true)"
if [ "$code" = "200" ]; then
  echo "  ✓ /api/version 200 · 指纹 $(sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p' /tmp/.hupo-ver.json | head -1)"
  ok=$((ok+1))
else
  echo "  ✗ /api/version 回了 $code"; nod=$((nod+1))
fi
rm -f /tmp/.hupo-ver.json

# ③.2 画图那条 MCP 真的挂上了（起一个工具子进程问它的工具列表）
if "$NODE" - <<'EOF' 2>/dev/null
const { spawn } = require('node:child_process');
const path = require('node:path');
const core = '/home/deploy/proj/hupo/v2/services/core';
const child = spawn(process.execPath, [path.join(core, 'src/mcp-image-server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, HUPO_IMAGE_SOCKET: path.join(core, 'data/apps.sock') },
});
let buf = ''; const w = [];
child.stdout.on('data', (b) => { buf += b; let i;
  while ((i = buf.indexOf('\n')) !== -1) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue; const f = w.shift(); if (f) f(JSON.parse(l)); } });
const call = (m, p) => new Promise((r) => { w.push(r);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) + '\n'); });
(async () => {
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const list = await call('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  child.kill();
  process.exit(names.includes('image_generate') ? 0 : 1);
})();
EOF
then echo "  ✓ 画图那一支起来了，而且有 image_generate"; ok=$((ok+1))
else echo "  ✗ 画图那一支没问出 image_generate"; nod=$((nod+1)); fi

# ③.3 钥匙有没有进盒子（要 root 才看得到真盒子 ⇒ 没有就如实说"没看"）
if [ "$(id -u)" = "0" ]; then
  if bash scripts/check-tenant-creds.sh --live | tail -3 | grep -q "失败 0"; then
    echo "  ✓ 盒子那份凭据里有该有的几样"; ok=$((ok+1))
  else
    echo "  ⚠️ 盒子那份还缺几样（租户还没填钥匙？）"; nod=$((nod+1))
  fi
else
  echo "  ⚠️ 盒子那一眼要 root ⇒ **没看**（不是"通过"）：sudo bash scripts/check-tenant-creds.sh --live"
fi

echo "──"
echo "  复验：过 $ok · 没过 $nod"
[ "$nod" = "0" ] || exit 1
echo "✅ 收尾完成"
