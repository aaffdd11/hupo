#!/usr/bin/env node
// **给字体文件名带上内容指纹**（2026-09-24）。
//
// ── 为什么要有这一步 ──────────────────────────────────────
// 主人手机上：*"字都在，只有图标不在"*。图标字体本身是好的（我这边实测 `OTTO` + 字形都在），
// 问题在**缓存**：
//   · 字体 URL 是 `assets/fonts/MaterialIcons-Regular.otf` —— **不带指纹**；
//   · 而它每次发布**内容都会变**（Flutter 按这一版用到的图标 **tree-shake** 出子集）；
//   · 浏览器里若存着一份旧的/坏的副本，`cache-control: no-cache` 只会让它**拿 304 继续用那份旧的**
//     ⇒ 旧子集里没有新图标 ⇒ **图标全空白，字却好好的**（正是他报的那个现象）。
// ⇒ 把内容哈希写进文件名，`FontManifest.json` 同步改：**内容一变 URL 就变**，
//   浏览器只能重新取（和入口文件 `main.<指纹>.dart.js` 是同一条道理，见 `15-CACHE.md`）。
//
// ⚠️ **原名那份要留着**（不改名、只**复制**一份带指纹的）：`assets/AssetManifest.json`
//    与 `assets/AssetManifest.bin`（Flutter 自己那份二进制清单）里也列着字体，
//    它们**不**由我们改写 —— 把原文件删掉就会让那两处变成 404
//    （2026-09-24 第一次上线时**被部署脚本自己的引用检查当场拦下**，就是这条）。
//    ⇒ 物理上两份、各 20KB 左右；**真正被加载的是带指纹那一份**（字体只认 `FontManifest.json`）。
//    代价是那点磁盘，换来的是"任何旧/坏缓存都不会再粘住"。
//
// ⚠️ 它必须跑在**预压缩之前**（`precompress.mjs`）—— 那样 `.br` / `.gz` 才会按新名字生成。
// ⚠️ 只改 `FontManifest.json` 里列出的那些文件（Flutter 是运行时读那份清单的）。

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

const web = process.argv[2];
if (!web) {
  console.error('用法：node scripts/fingerprint-fonts.mjs <web 目录>');
  process.exit(2);
}
const manPath = nodePath.join(web, 'assets', 'FontManifest.json');
if (!nodeFs.existsSync(manPath)) {
  console.log('  （没有 assets/FontManifest.json ⇒ 跳过）');
  process.exit(0);
}

const man = JSON.parse(nodeFs.readFileSync(manPath, 'utf8'));
let changed = 0;
for (const fam of man) {
  for (const f of fam.fonts ?? []) {
    const rel = f.asset; // 形如 `fonts/MaterialIcons-Regular.otf`
    const from = nodePath.join(web, 'assets', rel);
    if (!nodeFs.existsSync(from)) continue;
    const hash = nodeCrypto
      .createHash('sha256')
      .update(nodeFs.readFileSync(from))
      .digest('hex')
      .slice(0, 8);
    const base = nodePath.basename(from);
    const ext = nodePath.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    const to = nodePath.join(nodePath.dirname(from), `${stem}.${hash}${ext}`);
    if (to === from) continue;
    // ⚠️ **复制**（不是改名）：原名那份留给别的清单引用（见文件顶上那段）
    nodeFs.copyFileSync(from, to);
    const dir = nodePath.posix.dirname(rel);
    f.asset = dir === '.' ? nodePath.basename(to) : `${dir}/${nodePath.basename(to)}`;
    changed += 1;
  }
}
nodeFs.writeFileSync(manPath, JSON.stringify(man));
console.log(`  ✓ 字体文件名带上内容指纹：改了 ${changed} 个（FontManifest 已同步）`);
