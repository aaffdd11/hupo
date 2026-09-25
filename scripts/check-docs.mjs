#!/usr/bin/env node
/**
 * check-docs.mjs —— 文档闸（分层文档的**指针**由它守）
 *
 * 它查三件事：
 *   ① 本地链接**可达**（相对路径的文件真的在）
 *   ② `#锚点` **可解析**（目标文件里真有那个标题）
 *   ③ L0（路由层）**不许出现数值** —— 结论/读数只许住在下层
 *   ④ 同一份文件里**不许有重名标题**（重名 = 锚点只有一个能到）
 *
 * 为什么这么设计（重要）：
 *   · **只对 RATCHET 名单里的文件判红。** 全仓旧文档里本来就有断链，
 *     一上来就全红 ⇒ 这种闸会被绕过（本项目已经栽过"会误报的闸很快被绕开"）。
 *   · 名单是**棘轮**：新写的分层文件进名单；旧的哪天顺手清干净了，也加进来。
 *     ⇒ 只紧不松，纸面上不会退化。
 *   · 它**只保证"指针没断"**，不保证"内容还对"。内容对不对只有硬闸知道。
 *     所以任何"现状"都不许写死：**写命令，不写数字。**
 *
 * 跑法：node scripts/check-docs.mjs        （--report 连非名单文件的问题也列出来）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPORT = process.argv.includes('--report');

/** ① 必须干净的文件（棘轮：只增不减） */
const RATCHET = [
  'docs/INDEX.md',
  'docs/dev/00-PROGRESS.md',
  'docs/dev/PROGRESS-HISTORY.md',
  // 新写的分层文档从出生就进名单（只增不减：旧的哪天清干净了也加进来）
  'docs/dev/51-VS-CHAT.md',
  'docs/dev/52-DESKTOP.md',
  'docs/dev/53-MOTION.md',
  'docs/dev/54-COMPOSE-DRAFT.md',
  'docs/dev/55-VOICE-DEMO.md',
  'docs/dev/56-PLAIN.md',
  'docs/dev/57-MATH.md',
  'docs/dev/58-CREATE-APP.md',
  'docs/dev/59-USER-APPS.md',
  'docs/dev/61-WEB-PERF.md',
  // ⚠️ 2026-09-23：新写的分层文档**从出生就进名单**（这一条纪律原来漏了三批：62/63/64）
  'docs/dev/62-FAILURE-CLASSES.md',
  'docs/dev/63-OWNER-DECISIONS.md',
  'docs/dev/64-CHAT-REDESIGN.md',
  'docs/dev/65-ALIGNMENT-2026-09-23.md',
  'docs/dev/66-NEXT-STEPS.md',
  'docs/dev/67-SOURCES.md',
  'docs/dev/68-SPEAK.md',
  'docs/dev/69-ASR-ROUTES.md',
  'docs/dev/70-APP-ICONS.md',
  'docs/dev/71-MIC-ASR.md',
  'docs/dev/72-UI-PASS.md',
  'docs/dev/73-MOTION-APP.md',
  'docs/dev/74-ACCEPTANCE.md',
  'docs/dev/75-ACCEPTANCE.md',
  'docs/dev/76-PLAN.md',
  'docs/dev/77-BLOCKERS.md',
  'docs/dev/78-OUT-OF-REPO.md',
  // ⚠️ 2026-09-26：90/91 两份契约**出生就进名单**（91 §11.4·⑦ 点名的那一条）——
  //    它们定义的是"装／升级前必拍快照""三层边界"这些**正在承重**的规矩，
  //    指针一断就等于规矩读不到 ⇒ 必须拦。
  'docs/dev/90-APP-CONTRACT.md',
  'docs/dev/91-TRIPLE-CONTRACT.md',
  // ⚠️ 2026-09-26：92/93 **出生就进名单**（92 §⑦ 点名"92 出生即进 RATCHET"；
  //    93 照同一条纪律）。它们定的是"出界只许一条路""外联要申报"这些**要承重**的规矩。
  'docs/dev/92-TRIPLE-PLAN.md',
  'docs/dev/93-OUTBOUND-USAGE.md',
  // ⚠️ 2026-09-26：110 **出生就进名单**（同一条纪律）。
  //    它定的是"一个房间一条会话 ＋ 那份 mapping"这个**正在承重**的形状
  //    （`agent-runtime.js` / `dsh-sessions.mjs` / `sdk-server-hupo.mjs` 三处都按它写）。
  'docs/dev/110-ONE-SESSION-PER-ROOM.md',
];

/** ② L0 = 路由层：零事实、零数值、零状态 */
const L0 = ['docs/INDEX.md'];

/** ③ 扫哪些文件 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'build' || e.name === '.dart_tool' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
const FILES = [
  ...walk(path.join(ROOT, 'docs')),
  path.join(ROOT, 'AGENTS.md'),
  path.join(ROOT, 'README.md'),
  ...(fs.existsSync(path.join(ROOT, 'v2')) ? walk(path.join(ROOT, 'v2')) : []),
].filter((f) => fs.existsSync(f));

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** 去掉围栏代码块（代码里的字不算文档内容） */
function stripFences(text) {
  return text.replace(/^```[\s\S]*?^```/gm, (m) => m.replace(/[^\n]/g, ' '));
}

/** GitHub 风格锚点：小写、去标点、空格转连字符 */
function slug(title) {
  return title
    .replace(/<[^>]*>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    // ⚠️ emoji 与变体选择符（U+FE0F 之类）必须一起去掉：只去 ⚠ 而留下 ️，
    //    算出来的锚点会多一个看不见的字符 —— 手写链接永远对不上（我栽过）。
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0E}\u{FE0F}\u{200D}]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/** 取标题：[{level, text, slug}]，重名按 GitHub 规则加 -1/-2 */
function headings(text) {
  const seen = new Map();
  const out = [];
  for (const line of stripFences(text).split('\n')) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    let s = slug(m[2]);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    out.push({ level: m[1].length, text: m[2], slug: s, dup: n ? `${s}-${n}` : null });
  }
  return out;
}

/** 取链接：[{line, text, target}] */
function links(text) {
  const out = [];
  const lines = stripFences(text).split('\n');
  lines.forEach((line, i) => {
    const re = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(line))) out.push({ line: i + 1, text: m[1], target: m[2] });
  });
  return out;
}

/** 显式锚：<a id="s6"></a> —— 手写 slug 会被 ⚠️ / ④ 这类字符搞错，显式锚不会 */
function explicitIds(text) {
  return [...text.matchAll(/<a\s+id="([^"]+)"\s*>/g)].map((m) => m[1].toLowerCase());
}

/** L0 的数量检查：先减去"标识"（文件名 / §节号 / 提交号 / ID / 日期 / 层名），剩下的数字就是数值 */
function quantities(text) {
  let t = stripFences(text)
    .replace(/`[^`]*`/g, ' ')                                  // 行内代码
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')                     // 链接（含目标路径）
    .replace(/https?:\/\/\S+/g, ' ')                            // URL
    .replace(/\S*\.(md|js|mjs|dart|yml|yaml|sh|json|lock|png|apk)\b/g, ' ') // 文件名
    .replace(/§\s?[0-9一二三四五六七八九十.．·]+/g, ' ')          // 节号
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')                        // 提交号
    .replace(/\b[DNT][0-9]+(\.[0-9]+)*\b/g, ' ')                // 判据/决策 ID
    .replace(/\bv[0-9]+(\.[0-9]+)*\b/g, ' ')                    // 版本号
    .replace(/\bL[0-9]+\b/g, ' ')                               // 层名 L0…L4
    .replace(/\bV[0-9]+\b/g, ' ')                               // 人格那套层名 V0…V3（2026-09-25 起）
    .replace(/\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b/g, ' ');           // 日期
  const hits = [];
  const re = /[^\n]{0,28}\d[^\n]{0,28}/g;
  let m;
  while ((m = re.exec(t))) hits.push(m[0].trim());
  return hits;
}

const problems = { ratchet: [], other: [] };
const add = (file, kind, msg) => {
  const bucket = RATCHET.includes(file) ? problems.ratchet : problems.other;
  bucket.push(`${file}:${kind} ${msg}`);
};

for (const abs of FILES) {
  const file = rel(abs);
  const raw = fs.readFileSync(abs, 'utf8');
  const text = stripFences(raw);
  const hs = headings(raw);

  // ④ 重名标题 / 重名显式锚（重名 = 锚点只有一个能到）
  for (const h of hs) if (h.dup) add(file, '重名标题', `「${h.text}」→ #${h.dup}`);
  const ids = explicitIds(raw);
  for (const id of new Set(ids)) {
    if (ids.filter((x) => x === id).length > 1) add(file, '重名锚', 'id=' + id + ' 出现了不止一次');
  }

  // ①② 链接与锚点
  for (const l of links(raw)) {
    const [target, anchor] = l.target.split('#');
    if (/^(https?|mailto|tel|data):/.test(l.target) || (!target && !anchor)) continue;
    if (l.target.startsWith('<')) continue;
    if (!target) continue;               // 纯 #锚点 = 本页
    const dest = path.resolve(path.dirname(abs), decodeURIComponent(target));
    if (!fs.existsSync(dest)) {
      add(file, `第${l.line}行`, `链接指不到：${target}`);
      continue;
    }
    if (anchor && fs.existsSync(dest) && fs.statSync(dest).isFile() && dest.endsWith('.md')) {
      const want = decodeURIComponent(anchor).toLowerCase();
      const targetRaw = fs.readFileSync(dest, 'utf8');
      const got = headings(targetRaw);
      const wantIds = explicitIds(targetRaw);
      const ok = wantIds.includes(want) || got.some((h) => h.slug === want || h.dup === want);
      if (!ok) {
        const bare = (s) => s.replace(/[^\p{L}\p{N}]/gu, '');
        const wantB = bare(want);
        const near = [...wantIds, ...got.map((h) => h.slug)]
          .filter((s) => { const b = bare(s); return b.startsWith(wantB.slice(0, 4)) || wantB.startsWith(b.slice(0, 4)); })
          .slice(0, 3);
        add(file, `第${l.line}行`, `锚点不存在：#${anchor}${near.length ? `（像这几个？${near.map((s) => '#' + s).join(' · ')}）` : ''}`);
      }
    }
  }

  // ③ L0 不许有数值
  if (L0.includes(file)) {
    for (const q of quantities(raw)) add(file, 'L0 出现数值', `「${q}」—— 结论/读数只许住在下层`);
  }
}

const line = (s) => console.log(s);
line(`文档闸：扫了 ${FILES.length} 份 .md；必须干净的 ${RATCHET.length} 份`);
for (const f of RATCHET) {
  const n = problems.ratchet.filter((p) => p.startsWith(f + ':')).length;
  line(`  ${n === 0 ? '✅' : '❌'} ${f}${n ? ` （${n} 处）` : ''}`);
}
if (REPORT && problems.other.length) {
  line(`\n—— 非名单文件（只提示，不拦；清了就可以加进名单）——`);
  const byFile = new Map();
  for (const p of problems.other) {
    const f = p.split(':')[0];
    byFile.set(f, (byFile.get(f) ?? 0) + 1);
  }
  for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) line(`  · ${f} —— ${n} 处`);
}
if (problems.ratchet.length) {
  line(`\n❌ 必须干净的这几份有 ${problems.ratchet.length} 处：`);
  for (const p of problems.ratchet) line(`  ${p}`);
  line(`\n修法：把指针改对（链接指向真文件、#锚点抄目标文件的真标题）。`);
  process.exit(1);
}
line(`\n✅ 指针都对得上。`);
