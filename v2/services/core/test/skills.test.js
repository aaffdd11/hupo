// **技能层**（产品那一套「按需加载的作业指导书」）· 契约 `docs/dev/233-SKILLS-PRODUCT.md`
//
// 它守四件事（每一件都有反向对照）：
//   ① 🔴 **接线**：`config.js` 有默认值 · `agentPatchArgs()` 真挂那一层 ·
//      `agentEnv()` 真把目录递进子进程（少一样 = 助手看不到任何技能，而且**不会报错**）；
//   ② 🔴 **那份 patch 只动"配置"**：`- id: skill-filesystem`（服务提供者**不许**关）——
//      关错成 `- id: skill` 会让整台 dsh 起不来（`app-agent-ro.test.js` 的 `L1·补` 是那一课）；
//   ③ 🔴 **DSH 自己那个 provider 真能列出技能**（拿它的 `FileSystemSkillProvider` 直接跑，
//      不用模型、不用容器）＋ **反向对照**：目录换成空的 ⇒ 一条都列不出；
//   ④ 🔴 **技能本体的契约**：`name` kebab-case、与目录同名、`description` 非空，
//      而且解析过程**一条 warn 都没有**（DSH 是"不合规就静默忽略、只 warn 一行"）。
//
// ⚠️ 这一份**不验**"模型真的会去加载它" —— 那要一次真模型调用（本机判据里不跑）。
//    所以另外两条兜底：人格里必须点名那个技能（⑥）；DSH 的目录是模型每一轮都看得见的
//    （`dsh-tool-skill` 的会话目录）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeChildProcess from 'node:child_process';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from '../src/config.js';
import { agentArgs, agentEnv } from '../src/agent-runtime.js';

const CORE = nodePath.resolve(nodePath.dirname(new URL(import.meta.url).pathname), '..');
const cfgHere = () => loadConfig({}, CORE);

/** DSH 那个包**真的落在哪**（`bin/dsh` 是个软链 ⇒ 先 realpath，否则会指到 node 那一格）。 */
function dshPackageRoot() {
  const bin = cfgHere().dshBin;
  const real = nodeFs.realpathSync(bin); // <pkg>/lib/bin.js
  return nodePath.dirname(nodePath.dirname(real));
}

/**
 * 拿 **DSH 自己那个 provider** 列一遍技能（不启动 dsh、不叫模型）。
 *
 * ⚠️ 为什么值得这么做：这个 provider 是**产品真正用的那一份**（`dsh-base` 挂的就是它）
 *    ⇒ 它列得出来 = "盒子里那台也会列得出来"，比我们自己写个扫目录的判据强得多。
 * @param {string} dir 技能根目录
 * @returns {Promise<{names: string[], bodies: Record<string,string>, warns: string[]}>}
 */
async function listSkillsWithDsh(dir) {
  const pkg = nodePath.join(
    dshPackageRoot(),
    'node_modules',
    '@deepseek-ai',
    'dsh-skill-filesystem',
    'lib',
    'index.js',
  );
  assert.ok(nodeFs.existsSync(pkg), `找不到 DSH 的技能 provider：${pkg}（DSH 布局变了？）`);
  const mod = await import(pathToFileURL(pkg).href);

  const warns = [];
  const ctx = {
    get: () => undefined,
    logger: { warn: (...a) => warns.push(a.map(String).join(' ')), info() {}, debug() {}, error() {} },
    effect: (fn) => {
      const d = fn?.();
      return { dispose: () => d?.() };
    },
    on: () => () => {},
  };
  const ac = new AbortController();
  const p = new mod.FileSystemSkillProvider(ctx, { signal: ac.signal, invalidate() {} }, {
    customSkillDirs: [dir],
    includeDefaultRoots: false, // 只量我们给的那个目录（不然会扫到 ~/.dsh、~/.agents）
    watch: false,
  });
  const got = await p.list({ cwd: dir });
  const candidates = Array.isArray(got) ? got : got.candidates;
  const bodies = {};
  for (const c of candidates) {
    const full = await p.get(c, { cwd: dir });
    bodies[c.name] = full?.content ?? '';
  }
  ac.abort();
  return { names: candidates.map((c) => c.name), bodies, warns };
}

// ── ① 接线 ────────────────────────────────────────────────────

test('① 🔴 接线：config 有默认值 · agent 挂得上那一层 · 目录递进了子进程', () => {
  const c = cfgHere();
  assert.ok(c.skillsPath, 'skillsPath 是空的 ⇒ 技能那一层挂不上（而且不会报错）');
  assert.ok(c.skillsDir, 'skillsDir 是空的 ⇒ 那一层会拿到一个空目录');
  assert.equal(c.skillsPath, nodePath.join(CORE, 'hupo-skills.yml'), '默认值要指向仓库里那一份');
  assert.equal(c.skillsDir, nodePath.join(CORE, 'skills'), '默认值要指向仓库里那一份');
  assert.ok(nodeFs.existsSync(c.skillsPath), `那一层 patch 不在：${c.skillsPath}`);

  const args = agentArgs(c);
  assert.ok(args.includes(c.skillsPath), '`dsh` 命令行里没有技能那一层 ⇒ 技能永远加载不上');
  // ⚠️ 顺序：`--patch` 必须写在 `--profile` 后面（`dsh --help`：它是全局选项）
  assert.equal(args[0], '--profile', '`--patch` 跑到了 `--profile` 前面');
  assert.ok(args.includes('--patch'));

  const env = agentEnv(c);
  assert.equal(env.HUPO_SKILLS_DIR, c.skillsDir, '子进程环境里没有技能目录 ⇒ 那份 patch 会拿到空数组');
});

test('①·补 不配（或配空）时**不硬塞**：`skillsPath: null` ⇒ 命令行里没有它', () => {
  const args = agentArgs({ agentProfile: 'sdk', skillsPath: null });
  assert.equal(args.some((a) => String(a).includes('hupo-skills.yml')), false);
  assert.equal(agentEnv({}).HUPO_SKILLS_DIR, undefined, '没配目录时不许塞一个 undefined 进去');
});

// ── ② 那份 patch 只动"配置" ───────────────────────────────────

test('② 🔴 只动 `skill-filesystem` 的配置：**不许关服务提供者**（关错 = 整台 dsh 起不来）', () => {
  const src = nodeFs.readFileSync(cfgHere().skillsPath, 'utf8');
  assert.match(src, /- id:\s*skill-filesystem/, '要按 id 定点改 `skill-filesystem`');
  assert.match(src, /customSkillDirs/, '要设 `customSkillDirs`');
  // 🔴 两条禁：`- id: skill`（服务提供者）与 `- id: tool-skill`（模型那个工具）都不许出现在这一份里
  for (const bad of ['- id: skill\n', '- id: tool-skill', 'disabled: true']) {
    assert.equal(src.includes(bad), false, `这一份里出现了「${bad.trim()}」——那会把树弄挂或把技能关掉`);
  }
  // ⚠️ 路径**从环境来**（宿主与盒子两个 checkout，路径不一样）
  assert.match(src, /process\.env\.HUPO_SKILLS_DIR/, '路径不许写死：要从 HUPO_SKILLS_DIR 来');
});

// ── ③ DSH 自己那个 provider 真的列出技能 ───────────────────────

test('③ 🔴 DSH 自己的 provider 能列出我们的技能（＋反向对照：空目录 ⇒ 一条都没有）', async () => {
  const dir = cfgHere().skillsDir;
  const { names, bodies, warns } = await listSkillsWithDsh(dir);
  assert.ok(names.length >= 1, `一条技能都没列出来（dir=${dir}）`);
  assert.ok(names.includes('mini-app'), `没有 mini-app（列出来的是：${names.join(', ')}）`);
  assert.ok(bodies['mini-app'].length > 3000, 'mini-app 的正文太短 —— 八成被截了或文件坏了');
  assert.deepEqual(warns, [], `解析时有 warn（那是"被忽略了"的信号）：\n${warns.join('\n')}`);

  // 反向对照：换一个空目录 ⇒ 必须一条都列不出来（证明上面那条不是恒真）
  const empty = nodeFs.mkdtempSync(nodePath.join(nodeFs.realpathSync(nodeFs.mkdtempSync('/tmp/hupo-skill-')), '-'));
  const blank = await listSkillsWithDsh(empty);
  assert.deepEqual(blank.names, [], '空目录居然也列出了技能 —— 这条判据量错了地方');
});

// ── ④ 技能本体的契约 ──────────────────────────────────────────

test('④ 🔴 每个技能的 `name` 是 kebab-case、与目录同名、`description` 非空', () => {
  const dir = cfgHere().skillsDir;
  assert.ok(nodeFs.existsSync(dir), `技能目录不在：${dir}`);
  const entries = nodeFs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(entries.length >= 1, '技能目录里一个子目录都没有');
  for (const e of entries) {
    const file = nodePath.join(dir, e.name, 'SKILL.md');
    assert.ok(nodeFs.existsSync(file), `${e.name}/ 里没有 SKILL.md`);
    const src = nodeFs.readFileSync(file, 'utf8');
    const m = /^---\n([\s\S]*?)\n---/.exec(src);
    assert.ok(m, `${e.name}/SKILL.md 没有 YAML frontmatter（DSH 会**静默忽略**它）`);
    const fm = m[1];
    const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    const desc = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    assert.equal(name, e.name, `name 与目录名不一致（${name} vs ${e.name}）—— 叫不出这个名字`);
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `name 不是 kebab-case：${name}`);
    assert.ok(desc && desc.length > 10, `${e.name} 的 description 太短/没有（目录里就靠它认人）`);
  }
});

// ── ⑤ 产品层带着它走 ──────────────────────────────────────────

test('⑤ 🔴 产品层带着技能走：`build-tenant-code.sh` 的 INPUTS 里有 skills ＋ 那一层 patch', () => {
  const src = nodeFs.readFileSync(
    nodePath.resolve(CORE, '..', '..', '..', 'scripts', 'build-tenant-code.sh'),
    'utf8',
  );
  const line = src.split('\n').find((l) => l.startsWith('INPUTS=')) ?? '';
  assert.match(line, /\bskills\b/, 'INPUTS 里没有 skills ⇒ 盒子里 `/app/code/skills` 是空的');
  assert.match(line, /hupo-skills\.yml/, 'INPUTS 里没有那一层 patch ⇒ 盒子里的技能目录没人指');
});

// ── ⑥ 人格必须点名 ───────────────────────────────────────────

test('⑥ 🔴 人格里必须**点名**那个技能（不点名 = 模型不知道该去加载它）', () => {
  const persona = nodeFs.readFileSync(nodePath.join(CORE, 'hupo-persona.yml'), 'utf8');
  assert.match(persona, /mini-app/, '人格里那句"动手前先加载技能 mini-app"不见了');
  assert.ok(
    persona.includes('永远要守的边界') || persona.includes('永远要守的边'),
    '人格里那段"永远要守的边界"不见了（搬走的只是做法，边界必须留）',
  );
});

// ── ⑦ 负向对照（这一份自己不是空转）────────────────────────────

test('⑦ 负向对照：把技能目录换成一个不存在的路径 ⇒ 那条"列得出来"的判据会红', async () => {
  const { names } = await listSkillsWithDsh(nodePath.join('/tmp', 'hupo-no-such-skills-dir'));
  assert.deepEqual(names, [], '一条不存在的目录居然列得出技能 —— ③ 量错了');
});

// ── ⑧⑨（2026-10-11 加）：**规范与作业书不许漂** ─────────────────────
//
// 🔴 为什么值得两条判据：现在同一套规矩有**两个读者** ——
//    `docs/dev/149`（**规范**：人看，盒里读不到）与技能（**作业书**：agent 看，自足）。
//    两份靠人手工对齐 ⇒ 迟早漂（"改了规范忘了改技能"是最省事的错）。
//    ⇒ ① 用**同一套 id** 把它们钉在一起（规范里那 30 条，技能一条都不许少、也不许多）；
//      ② 技能里**不许出现"照 `docs/dev/NNN` 抄"**这种在盒里读不到的指令
//         （那是死指令：盒子里根本没有 `docs/`）。

const STD_149 = nodePath.resolve(CORE, '..', '..', '..', 'docs', 'dev', '149-APP-DEV-STANDARD.md');

test('⑧ 🔴 规范（149）与作业书（技能）用同一套 id：30 条，一条都不许少、不许多', () => {
  const std = nodeFs.readFileSync(STD_149, 'utf8');
  const skill = nodeFs.readFileSync(nodePath.join(cfgHere().skillsDir, 'mini-app', 'SKILL.md'), 'utf8');
  const idsOf = (t) => [...new Set([...t.matchAll(/\b([PCDA]\d{1,2})\b/g)].map((m) => m[1]))];

  const ids = idsOf(std);
  assert.equal(
    ids.length,
    30,
    `149 里抽出 ${ids.length} 条 id（该是 30：P1–P11 制品 / C1–C5 能力 / D1–D6 交付 / A1–A8 反模式）—— 编号坏了？`,
  );
  assert.ok(ids.includes('P3') && ids.includes('C1') && ids.includes('D1') && ids.includes('A1'), 'id 分组不成形');

  // ⚠️ 用**词边界**比，不用子串（`C3x` / `C30` 那种不算"有 C3" —— 子串比会放过它们）
  const at = (t, id) => new RegExp(`\\b${id}\\b`).test(t);
  const missing = ids.filter((id) => !at(skill, id));
  assert.deepEqual(missing, [], `技能里少了这些 id（两份漂了）：${missing.join(' ')}`);

  // 反向：技能里也不许有规范没写过的号（多了 = 技能在说规范没定过的事）
  const extra = idsOf(skill).filter((id) => !ids.includes(id));
  assert.deepEqual(extra, [], `技能里有 149 没有的 id：${extra.join(' ')}`);
});

test('⑨ 🔴 技能里不许留"盒里读不到的必读指令"（照 `docs/dev/NNN` 抄）', () => {
  const skill = nodeFs.readFileSync(nodePath.join(cfgHere().skillsDir, 'mini-app', 'SKILL.md'), 'utf8');
  const dead = [...skill.matchAll(/照\s*`?docs\/dev\/\d+[^\n]{0,24}抄/g)].map((m) => m[0].trim());
  assert.deepEqual(dead, [], `技能里还有"照 docs/dev/NNN 抄" —— 盒里没有 docs/，那是死指令：\n${dead.join('\n')}`);
  // 负向对照：这条正则真的抓得住那种句子（不是空转）
  assert.equal(/照\s*`?docs\/dev\/147[^\n]{0,24}抄/.test('（片段照 `docs/dev/147` §3.2 抄）。'), true);
  // 而"开发机上还有更全的"那张表**允许**出现（它明确写了盒里没有）
  assert.match(skill, /盒里没有|盒子里没有|盒里读不到/, '技能里连"盒里没有 docs/"都没交代');
});
