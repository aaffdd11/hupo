#!/usr/bin/env node
// **静态引用图检查**：从 `index.html` 出发，顺着引用把每个被引用的文件都找到。
//
// ── 为什么要有它 ────────────────────────────────────────────
// "页面能不能开"在本地**没有别的判据**：
//   · `flutter analyze` / `flutter test` 守的是 Dart 源码，**碰不到产物里的路径**；
//   · 构建成功只说明编译过了，**不说明引擎要的那些文件还在**；
//   · 而 Flutter web 的资源路径是**运行时算出来的**（`assetBase` + 一坨字面量），
//     改名脚本（`deploy-web-v2.sh` 的 sed）只要漏一处，线上就是**白屏**。
// ⇒ 这条检查只做一件事：**一个 404 都不许有**。
//
// ⚠️ 它**只看产物**：不读 `lib/`、不读 `pubspec.yaml`、不联网。
//    外部 URL（比如引擎默认去 gstatic 取的 CanvasKit）只列出来，**不当失败**。
//
// 覆盖的链（都是实测出来的形状，见 `docs/dev/15-CACHE.md`）：
//   index.html ─→ flutter_bootstrap.<指纹>.js ─→ main.<指纹>.dart.js
//              └→ icons/ favicon.png manifest.json
//   main.dar.js ─→ <assetBase>FontManifest.json ─→ 字体文件
//                └→ <assetBase>AssetManifest.bin / .json ─→ 清单里的每个资源
//                └→ <assetBase>NOTICES（产物里有这个字面量时才要求它在）
//   <assetBase> 默认是 `assets/`；只有把目录改名加指纹时才会由
//   `initializeEngine({assetBase})` 或（已弃用的）`<meta name="assetBase">` 覆盖。
//
// 退出码：0 = 引用全在 · 1 = 有引用找不到 · 2 = 用法/环境不对

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeProcess from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, '..');

const USAGE = `用法：node scripts/check-web-refs.mjs [产物目录]
  产物目录默认 scripts/../v2/services/core/web（部署脚本暂存出来的那一份）
  想看刚构建的那份：node scripts/check-web-refs.mjs v2/apps/mobile/build/web`;

const webRoot = nodePath.resolve(nodeProcess.argv[2] ?? nodePath.join(REPO, 'v2/services/core/web'));
if (!nodeFs.existsSync(nodePath.join(webRoot, 'index.html'))) {
  console.error(`✗ ${webRoot} 里没有 index.html —— 还没构建，或者指错了目录`);
  console.error(USAGE);
  nodeProcess.exit(2);
}

const missing = [];
const notes = [];
let checked = 0;

/** 协议前缀或协议相对 = 外部，不查。 */
const isExternal = (ref) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref);
const clean = (ref) => ref.split('#')[0].split('?')[0];

/** 把一条引用落成产物目录里的相对路径；外部 / 空 / 纯目录引用返回 null。 */
function localPath(ref, baseHref) {
  const r = clean(ref);
  if (!r || r === '/' || isExternal(r)) return null;
  const joined = r.startsWith('/')
    ? r.slice(1)
    : nodePath.posix.join(baseHref.replace(/^\/+/, ''), r);
  const norm = nodePath.posix.normalize(joined);
  return norm === '.' ? null : norm;
}

/** 文件在不在？不在就进 missing —— 这是这份脚本唯一的判据。 */
function check(rel, note) {
  if (!rel) return false;
  checked += 1;
  const abs = nodePath.join(webRoot, rel);
  const ok = nodeFs.existsSync(abs) && nodeFs.statSync(abs).isFile();
  if (!ok) missing.push({ rel, note });
  return ok;
}

const section = (title) => console.log(`\n  ${title}`);
const okLine = (rel, note) => console.log(`    ✓ ${rel}${note ? `   ← ${note}` : ''}`);
const badLine = (rel, note) => console.log(`    ✗ ${rel}${note ? `   ← ${note}` : ''}   **找不到**`);

console.log(`▶ 引用图检查：${webRoot}`);

// ── ① index.html 自己引的东西 ───────────────────────────────
const html = nodeFs.readFileSync(nodePath.join(webRoot, 'index.html'), 'utf8');
const baseHref = html.match(/<base[^>]*href\s*=\s*["']([^"']*)["']/i)?.[1] || '/';
const htmlRefs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
const htmlLocal = [...new Set(htmlRefs.map((r) => localPath(r, baseHref)).filter(Boolean))];

section('① index.html 直接引用');
const bootstrapRef = htmlLocal.find((p) => /^flutter_bootstrap.*\.js$/i.test(p));
for (const p of htmlLocal) (check(p, 'index.html') ? okLine : badLine)(p, 'index.html');

// ── ② 引擎入口（部署脚本改名的那两个名字）──────────────────
// 取 bootstrap 里**每一处** `main…dart.js` 字面量都要求存在：
// sed 只要漏一处（比如某个 fallback 分支），这里就红 —— 这正是要抓的那个形状。
let bootSource = '';
if (bootstrapRef) bootSource = nodeFs.readFileSync(nodePath.join(webRoot, bootstrapRef), 'utf8');
const entryNames = [...new Set([...bootSource.matchAll(/main(?:\.[0-9a-f]+)?\.dart\.js/gi)].map((m) => m[0]))];

section(`② 引擎入口（${bootstrapRef ?? '没找到 bootstrap'} 里引用的）`);
if (entryNames.length === 0) {
  console.log('    ⚠️ bootstrap 里一处 `main…dart.js` 都没有 —— 加载器形状变了？');
} else {
  for (const n of entryNames) (check(n, bootstrapRef) ? okLine : badLine)(n, bootstrapRef);
  if (!/main\.[0-9a-f]+\.dart\.js/i.test(entryNames.join(' '))) {
    notes.push('入口文件**没有指纹**（还是 `main.dart.js`）—— 部署脚本会给它改名的，这里看到的是原始构建产物');
  }
}
const entryRef = entryNames.find((n) => nodeFs.existsSync(nodePath.join(webRoot, n)));
const entrySource = entryRef ? nodeFs.readFileSync(nodePath.join(webRoot, entryRef), 'utf8') : '';

// ── ③ 资源目录（assetBase）──────────────────────────────────
// 引擎取值优先级：initializeEngine({assetBase}) > <meta name="assetBase"> > 默认 "assets/"。
const cfgAssetBase = bootSource.match(/assetBase\s*:\s*["']([^"']*)["']/)?.[1];
const metaAssetBase =
  html.match(/<meta[^>]*name\s*=\s*["']assetBase["'][^>]*content\s*=\s*["']([^"']*)["']/i)?.[1] ??
  html.match(/<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']assetBase["']/i)?.[1];
const assetBaseRaw = cfgAssetBase ?? metaAssetBase ?? 'assets/';
const assetBase = `${assetBaseRaw.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
const assetBaseFrom = cfgAssetBase != null ? 'bootstrap 的 engine config'
  : metaAssetBase != null ? 'index.html 的 <meta>（已弃用）'
  : '引擎默认';

section(`③ 资源（assetBase = ${assetBase}；来源：${assetBaseFrom}）`);
// ⚠️ `.bin` 与 `FontManifest.json` 是**引擎开机会读**的两个文件 —— **必须有**：
//    "目录改了名但 assetBase 没跟着改"这个形状，就是在这儿红的。
//    `AssetManifest.json` 是旧形状（新引擎读 `.bin`），将来的版本可能不再出，所以只列不判。
for (const m of ['AssetManifest.bin', 'FontManifest.json']) {
  const rel = assetBase + m;
  check(rel, '引擎清单') ? okLine(rel, '引擎清单') : badLine(rel, '引擎清单');
}
{
  const rel = assetBase + 'AssetManifest.json';
  if (nodeFs.existsSync(nodePath.join(webRoot, rel))) okLine(rel, '引擎清单（旧形状）');
  else console.log(`    · ${rel}（这份产物没有，旧形状，不判）`);
}

// FontManifest.json：字体文件在一个文本清单里，能一条条对
const fontManifestRel = assetBase + 'FontManifest.json';
if (nodeFs.existsSync(nodePath.join(webRoot, fontManifestRel))) {
  try {
    for (const fam of JSON.parse(nodeFs.readFileSync(nodePath.join(webRoot, fontManifestRel), 'utf8'))) {
      for (const f of fam.fonts ?? []) {
        const rel = assetBase + f.asset;
        check(rel, `FontManifest.json（${fam.family}）`) ? okLine(rel, `FontManifest.json（${fam.family}）`) : badLine(rel, `FontManifest.json（${fam.family}）`);
      }
    }
  } catch (e) {
    missing.push({ rel: fontManifestRel, note: `JSON 读不动：${e.message}` });
  }
}

// AssetManifest.json：老形状，键就是资源相对路径（新引擎读 .bin，但两个都在产物里）
const assetJsonRel = assetBase + 'AssetManifest.json';
if (nodeFs.existsSync(nodePath.join(webRoot, assetJsonRel))) {
  try {
    for (const key of Object.keys(JSON.parse(nodeFs.readFileSync(nodePath.join(webRoot, assetJsonRel), 'utf8')))) {
      const rel = assetBase + key;
      check(rel, 'AssetManifest.json') ? okLine(rel, 'AssetManifest.json') : badLine(rel, 'AssetManifest.json');
    }
  } catch (e) {
    missing.push({ rel: assetJsonRel, note: `JSON 读不动：${e.message}` });
  }
}

// AssetManifest.bin：二进制，路径是明文串在里面的 —— 尽力抽出来对一遍（抽不到就只验它存在）
const binRel = assetBase + 'AssetManifest.bin';
if (nodeFs.existsSync(nodePath.join(webRoot, binRel))) {
  const bytes = nodeFs.readFileSync(nodePath.join(webRoot, binRel));
  const strings = bytes.toString('latin1').match(/[\x20-\x7e]{4,}/g) ?? [];
  for (const s of new Set(strings)) {
    if (!s.includes('/') || !/\.[a-z0-9]+$/i.test(s)) continue; // `asset` 这类键，不是路径
    const rel = assetBase + s;
    if (!nodeFs.existsSync(nodePath.join(webRoot, rel))) continue; // 二进制里的非路径串，别误报
    okLine(rel, 'AssetManifest.bin（内嵌）');
  }
}

// NOTICES：引擎在产物里用字面量引用它 —— 有字面量就要求文件在
if (entrySource.includes('NOTICES')) {
  const rel = assetBase + 'NOTICES';
  check(rel, `${entryRef} 里的字面量`) ? okLine(rel, `${entryRef} 里的字面量`) : badLine(rel, `${entryRef} 里的字面量`);
}

// ── ④ 外部（列出来，不当失败）────────────────────────────────
section('④ 外部（不检查）');
const ckCfg = bootSource.match(/canvasKitBaseUrl\s*:\s*["']([^"']+)["']/)?.[1];
if (ckCfg && !isExternal(ckCfg)) {
  // 真去本地取 CanvasKit 的配置（`--no-web-resources-cdn` 或手写的 config）
  const base = `${ckCfg.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
  for (const f of ['canvaskit.js', 'canvaskit.wasm']) {
    const rel = base + f;
    check(rel, 'canvasKitBaseUrl') ? okLine(rel, 'canvasKitBaseUrl') : badLine(rel, 'canvasKitBaseUrl');
  }
} else if (ckCfg) {
  console.log(`    · CanvasKit → ${ckCfg}（bootstrap 的 canvasKitBaseUrl）`);
} else if (/"useLocalCanvasKit"\s*:\s*true/.test(bootSource)) {
  // `--no-web-resources-cdn`：加载器**不去 gstatic**，直接从产物里的 `canvaskit/` 取。
  // ⚠️ 第一版这里打印过"本地产物里的 canvaskit/ **不在取用链上**"—— **2026-09-23 实测那是反的**：
  //    屏掉 gstatic **冷启动**（`check-web-browser.mjs --block-gstatic`）页面能开，靠的正是它。
  //    ⇒ 这一支也要**逐个查文件在不在**（跟上面 `canvasKitBaseUrl` 那一支同等对待）。
  console.log('    · CanvasKit → 本地产物 canvaskit/（bootstrap 里 `useLocalCanvasKit:true`）');
  for (const f of ['canvaskit.js', 'canvaskit.wasm']) {
    const rel = `canvaskit/${f}`;
    check(rel, 'useLocalCanvasKit') ? okLine(rel, 'useLocalCanvasKit') : badLine(rel, 'useLocalCanvasKit');
  }
} else {
  const gstatic = bootSource.match(/https:\/\/www\.gstatic\.com\/flutter-canvaskit\/[0-9a-f]+/)?.[0];
  console.log(`    · CanvasKit → ${gstatic ?? 'https://www.gstatic.com/flutter-canvaskit/<engineRevision>'}（引擎默认）`);
  console.log('      ⇒ ⚠️ **这是要 gstatic 的那一支**：国内经常取不到（页面会卡着等）—— 见 `61-WEB-PERF.md`');
}

// ── ⑤ 提示 ─────────────────────────────────────────────────
const swPath = nodePath.join(webRoot, 'flutter_service_worker.js');
if (nodeFs.existsSync(swPath)) {
  const size = nodeFs.statSync(swPath).size;
  notes.push(size === 0
    ? 'Service Worker 文件是**空的**（`--pwa-strategy=none` 的预期形态，不会被注册）'
    : `⚠️ Service Worker 文件非空（${size} 字节）—— 缓存结论要重算，见 docs/dev/15-CACHE.md §五`);
}

section('⑤ 提示');
for (const n of notes) console.log(`    · ${n}`);

// ── 结论 ───────────────────────────────────────────────────
console.log('');
if (missing.length === 0) {
  console.log(`✅ 引用全在：对了 ${checked} 个文件，0 个 404`);
  nodeProcess.exit(0);
}
for (const m of missing) console.error(`✗ ${m.rel}${m.note ? `   ← ${m.note}` : ''}   **找不到**`);
console.error(`\n❌ 有 ${missing.length} 个引用找不到（对了 ${checked} 个）—— 页面会白屏，不许部署`);
nodeProcess.exit(1);
