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
 *   · **默认全进**（2026-10-01 反转）：扫到的都判红，只有 `EXEMPT` 里那几份放过。
 *     原来是手写 include 名单 —— 每写一篇新文档就得来加一行，实测漏过 91 份。
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

/** ① 必须干净的文件：**默认全进**（2026-10-01 反转）
 *
 * 原来是一张**手写的 include 名单**：每写一篇新文档，就要来这个文件加一行
 * （300 次提交里它被改了 **65** 次，`docs/INDEX.md` 被改了 **60** 次）。
 * 那笔"注册税"本身就是"小需求也要长时间分析阅读"的一个来源 ——
 * 更要命的是：**新文档出生时没人记得来登记，它就静静落在闸外**（实测漏过 91 份）。
 *
 * ⇒ 现在反过来：**扫到的都判红**，真判不了的进下面这张 `EXEMPT`（**必须写清为什么**）。
 *   · 新文档**出生就进闸**，写文档的人不必记得改这个文件；
 *   · `EXEMPT` **只许变小**：哪一份清干净了，就把它从这儿删掉。
 */
const EXEMPT = [
  {
    test: /^docs\/dev\/115-raw\//,
    why: '逐字抄来的**原始材料**（DSH 的渲染/视觉规格原文）—— 改它的排版就是改证据',
  },
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
const exemptOf = (file) => EXEMPT.find((e) => e.test.test(file));
const add = (file, kind, msg) => {
  // 豁免的那些**照样算**，只是进 `other`（--report 才打）——
  // ⇒ "这份豁免到底藏了什么"始终看得见，不是黑箱。
  (exemptOf(file) ? problems.other : problems.ratchet).push(`${file}:${kind} ${msg}`);
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
    // ⚠️ 带 **任何** `scheme:` 的都不是仓内相对路径（原来只列了 http/mailto/tel/data，
    //    于是 `dsh-session:…` 那种**伪链接**被当成路径 ⇒ 假红 3 处）。
    if (/^[a-z][a-z0-9+.-]*:/i.test(l.target) || (!target && !anchor)) continue;
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
const exemptCount = FILES.map(rel).filter((f) => exemptOf(f)).length;
line(`文档闸：扫了 ${FILES.length} 份 .md；**必须干净 ${FILES.length - exemptCount} 份**；豁免 ${exemptCount} 份`);
for (const e of EXEMPT) line(`  ⚪ 豁免 /${e.test.source}/ —— ${e.why}`);

// ⚠️ 2026-10-01：`--report` 原来**只给条数、不给内容** ⇒ 想清干净的人还得自己再找一遍。
//    现在它是"**豁免名单里还藏着什么**"的窗口 —— 清单要能直接当待办用。
if (REPORT && problems.other.length) {
  line(`\n—— 豁免的那些里还剩这些（只提示，不拦）——`);
  for (const p of problems.other) line(`  ${p}`);
}

if (problems.ratchet.length) {
  line(`\n❌ 有 ${problems.ratchet.length} 处：`);
  for (const p of problems.ratchet) line(`  ${p}`);
  line(`\n修法：把指针改对（链接指向真文件、#锚点抄目标文件的真标题）。`);
  line(`      确实是"不许改的原始材料"，就把它加进 EXEMPT 并写清为什么。`);
  process.exit(1);
}
line(`\n✅ ${FILES.length - exemptCount} 份指针都对得上。`);
