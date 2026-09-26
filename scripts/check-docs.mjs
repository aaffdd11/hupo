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
  // ⚠️ 2026-09-26：111 **出生就进名单**（同一条纪律）。
  //    它定的是"制品换了一版 ⇒ 正开着它的那一屏自己换上"那个**正在承重**的形状
  //    （新事件 `app/update-available` 的两半 ＋ 那本 viewId 账 ＋ "没做成要说话"）。
  'docs/dev/111-APP-LIVE-UPDATE.md',
  // ⚠️ 2026-09-26：112 **出生就进名单**（同一条纪律）。
  //    它定的是"桌面那一格打开的是他正在改的那一份（活的工作区）"这个**正在承重**的形状
  //    （活地址 `/w/` 的签名与白名单 ＋ `app/workspace-changed` 那条瞬态通知 ＋ 看着盘的那个人）。
  'docs/dev/112-OWN-APP-IS-LIVE.md',
  // ⚠️ 2026-09-26：113/114 **出生就进名单**（同一条纪律）。
  //    113 记的是主人原话与形状（"版本快照只在市场中存在"），114 是它在代码上的落点
  //    —— "用户端不查尺寸/文件数、不落版本快照"这条**正在承重**的规矩
  //    （`workspace.js` 的 `write()` ＋ `apps.js` 的 `register()/meta()` 都按它写）。
  'docs/dev/113-APP-SHAPE-LIVE.md',
  'docs/dev/114-APP-USER-SIDE-NO-LIMIT.md',
  // ⚠️ 2026-09-26：115 **出生就进名单**（同一条纪律）。
  //    它是"聊天窗口对齐 DSH 的窗口"那一件事的**研究规格**（DSH 有什么 / 我们差在哪 / 三条路与代价）
  //    —— 下一批动手的人如果读的是一个断链的 115，就会去猜 DSH 的窗口长什么样。
  'docs/dev/115-DSH-WINDOW-PARITY.md',
  // ⚠️ 2026-09-26：116 **出生就进名单**（同一条纪律）。
  //    它是「信息全部开放 ＋ 窗口按 DSH 重做」这一批的**契约**（四帧新事件 ＋ 客户端那一半）。
  'docs/dev/116-CHAT-OPEN-AND-REDESIGN.md',
  // ⚠️ 2026-09-26：117 **出生就进名单**（同一条纪律）。
  //    它是聊天窗口重做**第二批**的契约（排队看得见、撤得掉：那一帧的形状与出口
  //    ＋ 客户端帧 `unsay` ＋ 两边的判据）—— 下一批动输入区的人如果读的是断链的 117，
  //    就会去猜"排队走哪条流、撤一句有没有错误面、刷新之后靠什么重建"。
  'docs/dev/117-QUEUE-VISIBLE.md',
  // ⚠️ 2026-09-26：118 **出生就进名单**（同一条纪律）。
  //    它是聊天窗口重做**第三批**的契约（轨迹那一屏：两个 tab ＋ 那张表的纯逻辑与判据
  //    ＋ **我们收不到的那八样**）。
  //    ⚠️ **同一天晚些时候：这一屏按主人决定删掉了**（*「聊天和轨迹有选项，我决定不要轨迹。」*）——
  //    名单这一条**不变**：它现在是"当时长什么样"的记录（顶上那条横幅写明删了什么 / 留了什么），
  //    而下一批想知道"为什么以前有聊天/轨迹两档"的人，读的如果是一个断链的 118，就会去别处猜。
  'docs/dev/118-TRAJECTORY-VIEW.md',
  // ⚠️ 2026-09-26：119 **出生就进名单**（同一条纪律）。
  //    它是聊天窗口重做**第四批**的契约（外观亮/暗/跟随系统 ＋ 聊天字号 12–17）——
  //    它同时写清了**这一批只重做聊天窗口**（哪些面跟着走、哪些故意留在暖白纸那套，
  //    以及"整机暗色要主人先拍一句"）与那条刀刃一样的既存脆弱（`_toTop` 与 `followSlack`）。
  //    下一批动"外观 / 字号 / 输入条高度"的人如果读的是断链的 119，就会去猜边界。
  'docs/dev/119-APPEARANCE-AND-FONT.md',
  // ⚠️ 2026-09-26：120 **出生就进名单**（同一条纪律）。
  //    它是聊天窗口重做**第五批**的契约（右栏那一栏：这一窗动过哪些文件）——
  //    它写清了三件承重的事：**路径只从入参 JSON 里取（不猜）**、
  //    **"改过"与"看过"要分开**、以及**我们收不到、所以一个字都不许出现**的那几样
  //    （增删行数 / 文件现在的内容 / 工作目录 / 模型名）。
  //    下一批动"右栏 / 文件那一栏"的人如果读的是断链的 120，就会去猜这些边界。
  'docs/dev/120-FILE-PANEL.md',
  // ⚠️ 2026-09-26：121 **出生就进名单**（同一条纪律）。
  //    它是主人报的那两条（"展开时无法发送 / 聊天历史无法滑动"）的**根因账**：
  //    · "用户自己翻走了"要认哪几种滚动（滚轮/触控板也算，不能只看 `dragDetails`）；
  //    · 展开那一下的补帧**不排帧** ⇒ 会停在半路、以后再把用户拽回底部；
  //    · **键盘那一段只许算一遍**（算两遍 ⇒ 时间线被挤成 0 高、浮窗顶出屏幕）；
  //    · 右栏"挤"要给聊天留一条能用的宽度（这一条改了 120 §3.1）。
  //    以及**没复现出来的那一条**（"发不出去"）—— 下一批动"滚动跟随 / 键盘 / 右栏宽度"
  //    的人如果读的是断链的 121，就会把这四条账重新踩一遍。
  'docs/dev/121-EXPAND-INPUT-FIX.md',
  // ⚠️ 2026-09-26：122 **出生就进名单**（同一条纪律）。
  //    它是「过程四档 ⇒ 两档」那一刀的契约（主人原话「名不副实的要去掉。」）：
  //    · 砍了哪两档、**各为什么**（安静掐不住工具行 / 步骤流水被工具行说得更准更全）；
  //    · 留下两档各是什么（在做什么 / 推理原文，D7.4 一条没松）；
  //    · **四个 wire token 仍然冻结**、服务端语义一个字不改；
  //    · 老设备盘上的旧档**归一到默认档**；`step/*` 今天只为老客户端的 `steps` 档存在。
  //    下一批动"过程档位 / 过程菜单 / 推理原文 / `step/*`"的人如果读的是断链的 122，
  //    就会以为"那两档还在"、或者顺手把协议改掉。
  'docs/dev/122-TWO-PROCESS-LEVELS.md',
  // ⚠️ 2026-09-26：123 **出生就进名单**（同一条纪律）。
  //    它是配置页「语音」那颗「试一下」的契约（主人原话「点击后会录音，会转文字，
  //    并写入一个文本框」）：**钥匙只有一条路**（那颗按钮不碰钥匙，走 `/api/asr`，
  //    服务端按验过签的身份现取 —— 就是上面那个表单写进去的那一份）、
  //    **一条失败一个原因**（没配／没权限／连不上／没听到／没额度／读不懂分开说）、
  //    以及 §六 那份**名不副实（待主人定）**的账（视频那一屏同一屏上两句话互相打脸…）。
  //    下一批动"配置页 / 语音测试 / 视频那一栏 / 钥匙生效不生效"的人如果读的是断链的 123，
  //    就会把这些边界重新踩一遍。
  'docs/dev/123-VOICE-TEST-BUTTON.md',
  // ⚠️ 2026-09-26：124 **出生就进名单**（同一条纪律）。
  //    它是触屏那一类回归的账（主人报的三条：滑不动 / 按钮点不开 / 收起才能发送）：
  //    **根因是"手按住 500ms ⇒ 弹一层带 barrier 的底部单子 ⇒ 整个窗口失去输入能力"**
  //    （而收起的窗口里没有气泡可长按 ⇒ 只有它正常 —— 那正是主人那句"收起才能发送"）。
  //    还有一条**没结的账**（390 宽下那一排动作排在视口外、a11y 矩形挂在 tab 的坐标上）
  //    与**没复现的两条**（平时的拖/甩、键盘弹着时发送都验过是好的）。
  //    下一批动"气泡长按 / 浮窗标题行 / 弹层（`showModalBottomSheet`）"的人如果读的是
  //    断链的 124，就会把这三条账重新踩一遍（尤其是"瞬点判据看不见长按"这一条）。
  'docs/dev/124-TOUCH-REGRESSION.md',
  // ⚠️ 2026-09-27：125 **出生就进名单**（同一条纪律）。
  //    它是"租户账号里填了语音那三样、却从来没送进他那台盒子"那一笔账
  //    （主人 2026-09-27 在手机上按了 8 下、盒子里 8 条"有人来了，但这台没配凭据"）：
  //    **根因是推送的触发**（只有带 `model` 的那一拍才推）——不是产品层、也不是钥匙本身。
  //    下一批动"`/api/creds` / 盒子那条通道 / 语音或图片那几屏的边界话"的人
  //    如果读的是断链的 125，就会把"填了到底送不送得进去"这件事重新搞错一遍。
  'docs/dev/125-TENANT-VOICE-CREDS.md',
  // ⚠️ 2026-09-27：126 **出生就进名单**（同一条纪律）。
  //    它记的是"小程序容器那条顶栏撤掉、出口搬到聊天条那颗 home"那一刀，
  //    以及撤顶栏**露出来**的那个真缺陷（收起那一帧内缩还是展开时的高度 ⇒ 页面被压成 30 像素）。
  //    下一批动"小程序容器 / 那颗 home / 输入条那一条"的人如果读的是断链的 126，
  //    就会把那条时序问题重新踩一遍（它以前被顶栏挡着，**看不见**）。
  'docs/dev/126-MINIAPP-NO-HEADER-HOME.md',
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
