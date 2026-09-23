#!/usr/bin/env node
// **把 web 产物预先压好**（br + gz），放在原文件旁边（`x.js.br` / `x.js.gz`）。
//
// ── 为什么必须预压缩，而不是"服务端现场压" ────────────────
// 实测（2026-09-23）：这条路的上行大约 **3.4 Mbps**
// （`main.dart.js` 2.73MB 走了 6.5s、`canvaskit.wasm` 6.8MB 走了 16s），
// 而两个文件都是**原样发**的（响应头里没有 `content-encoding`）。
// ⇒ 与"省下的传输时间"相比，压缩那点 CPU 不值一提；而且预压还能用 **brotli**
//   （比 gzip 再小一截），现场压就只能用 gzip 了。
//
// ⚠️ **只压会走网络的那些类型**；`.symbols`（调试符号，1.5MB+）与
//    `skwasm*`（我们没建 `--wasm`，取不到）**既不压也不删** ——
//    不压是因为白花时间，不删是因为"删"有风险而收益只是磁盘。
//
// ⚠️ **增量**：目标比源新就跳过（部署脚本每次都会调它）。
//
// 用法：node scripts/precompress.mjs <目录> [--quiet]

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeProcess from 'node:process';
import nodeZlib from 'node:zlib';

/** 值得压的扩展名（按"它会走网络吗"挑）。 */
const TYPES = new Set(['.js', '.mjs', '.html', '.json', '.css', '.wasm', '.otf', '.ttf', '.svg', '.txt', '.bin']);

/** 跳过这些（调试符号 / 我们已经不发的渲染器变体）。 */
const SKIP = [/\.symbols$/u, /\.map$/u, /\.br$/u, /\.gz$/u];

const root = nodeProcess.argv[2];
const quiet = nodeProcess.argv.includes('--quiet');
if (!root) {
  console.error('用法：node scripts/precompress.mjs <目录> [--quiet]');
  nodeProcess.exit(2);
}
if (!nodeFs.existsSync(root)) {
  console.error(`✗ 目录不在：${root}`);
  nodeProcess.exit(2);
}

let n = 0;
let raw = 0;
let br = 0;
let gz = 0;
let skipped = 0;

function walk(dir) {
  for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    const ext = nodePath.extname(e.name).toLowerCase();
    if (!TYPES.has(ext)) continue;
    if (SKIP.some((re) => re.test(e.name))) continue;
    const st = nodeFs.statSync(p);
    const outBr = `${p}.br`;
    const outGz = `${p}.gz`;
    const fresh = (o) => nodeFs.existsSync(o) && nodeFs.statSync(o).mtimeMs >= st.mtimeMs;
    if (fresh(outBr) && fresh(outGz)) {
      skipped += 1;
      continue;
    }
    const buf = nodeFs.readFileSync(p);
    // ⚠️ brotli 的 11 是最小体积；大文件（wasm 6.8MB）会花几秒，但部署时花一次
    const b = nodeZlib.brotliCompressSync(buf, {
      params: {
        [nodeZlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [nodeZlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
    const g = nodeZlib.gzipSync(buf, { level: 9 });
    nodeFs.writeFileSync(outBr, b);
    nodeFs.writeFileSync(outGz, g);
    n += 1;
    raw += buf.length;
    br += b.length;
    gz += g.length;
    if (!quiet && buf.length > 200 * 1024) {
      const pct = (100 - Math.round((b.length / buf.length) * 100));
      console.log(`   ↓ ${nodePath.relative(root, p)}：${(buf.length / 1024).toFixed(0)}KB → br ${(b.length / 1024).toFixed(0)}KB（省 ${pct}%）`);
    }
  }
}

walk(root);
if (!quiet) {
  const pct = raw > 0 ? Math.round((br / raw) * 100) : 100;
  console.log(
    `▶ 预压缩：压了 ${n} 个（跳过 ${skipped} 个已经是最新的）`
    + (raw > 0 ? `；这些文件原本 ${(raw / 1048576).toFixed(1)}MB ⇒ br ${(br / 1048576).toFixed(1)}MB（只剩 ${pct}%）/ gz ${(gz / 1048576).toFixed(1)}MB` : ''),
  );
}
