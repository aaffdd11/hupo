// **P1：助手不能改自己** —— 开机完整性清单。
//
// 手册依据：`05-DECISIONS.md` **P1.2 / P1.4** · `06-OPERATIONS.md` §3.2 第 4 条 ·
// `04-ROADMAP.md` 批 6 的「P1 能力收回」。
//
// 威胁的真实形态**不是"它干一次坏事"**（那能收拾），是"**坏事能不能留下来**"：
//
//     它读到一段看不见的网页内容 → 被诱导写进自己的配置 →
//     **从今往后每轮开机都读那一段** → 而表面上一切正常。
//
// ⇒ 所以要有一份清单，列出**"开机自动读的东西"**，每次开机核对；
//   而且这份清单**助手碰不到**（`root:root 0444`，在 `/etc/hupo/`）。
//
// ⚠️ **为什么清单路径写死、不走环境变量**（这一点很容易做错）：
//    服务是**助手自己重启**的（`scripts/restart-core.sh`）。如果路径或开关能从环境变量来，
//    那助手只要 `HUPO_INTEGRITY= HUPO_INTEGRITY_ENFORCE=0 scripts/restart-core.sh`
//    就把这道闸整个关掉了——**那就等于给它一个关闸开关**。
//    ⇒ 路径写死；"哪些条目只报不拦"这件事**住在清单文件里**（root 所有 ⇒ 它改不了）。
//    ⇒ 唯一能停用它的动作是主人 `sudo` 把那个文件挪走——那是主人的动作，看得见。
//
// ⚠️ 三种状态都要**如实说话**，尤其"还没建"那一种：
//    `ok`       全对上
//    `tampered` strict 条目对不上 ⇒ **拒绝启动**（手册 P1.4 明写）
//    `absent`   清单不在 ⇒ **保护还没启用**。服务照起，但必须**大声说出来**——
//               悄悄过去就等于"看起来有这道闸"，那比没有更坏。

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

/** 清单文件。**写死**，理由见文件头。 */
export const BASELINE_PATH = '/etc/hupo/integrity.json';

export const BASELINE_VERSION = 1;

/** 目录递归时永远不看的东西（依赖、运行时数据、版本库）。 */
const ALWAYS_SKIP = new Set(['node_modules', '.git', 'sessions', '.cache']);

/**
 * 清单该覆盖哪些路径。
 *
 * 判据（手册 P1.2）：**只要还有一条路径能让助手的写入变成"下次开机自动读"，就没摘够。**
 * ⇒ 三类：
 *   ① **会被执行**的（调度器代码、脚本）
 *   ② **开机自动喂给 agent** 的（人格、`AGENTS.md`、DSH 的 profile 补丁与设置）
 *   ③ **判据本身**（手册 —— 它决定"什么算违规"）
 *
 * `mode`：
 *   * `strict` —— 对不上就**拒绝启动**
 *   * `report` —— 对不上只**大声报**（用在"本来就该变"的安全数据上：口令、撤销表。
 *                改口令是主人的正常动作，不该因此起不来）
 *
 * ⚠️ **`mode` 住在清单文件里**（root 所有）⇒ 助手**改不了**自己那一档。
 */
export function protectedPaths({ repo, home = nodeOs.homedir() }) {
  const p = (...segs) => nodePath.join(repo, ...segs);
  const d = (...segs) => nodePath.join(home, '.dsh', ...segs);
  return [
    // ① 会被执行的
    { path: p('v2/services/core/src'), kind: 'dir', mode: 'strict', why: '调度器自己的代码：开机就执行' },
    { path: p('scripts'), kind: 'dir', mode: 'strict', why: '这些是主人会手动跑的脚本（重启 / 部署 / 应用改动）' },
    // ② 开机自动喂给 agent 的
    { path: p('v2/services/core/hupo-persona.yml'), mode: 'strict', why: '每开一个新 agent 就喂一遍：改一句就改掉它的性格与纪律' },
    { path: p('AGENTS.md'), mode: 'strict', why: '助手给"下一次的自己"读的说明书' },
    { path: d('profiles'), kind: 'dir', mode: 'strict', why: 'agent 的 profile 与补丁（cordis.patch.yml）——改它就能改自己每轮读到的东西' },
    { path: d('settings.yaml'), mode: 'strict', why: 'agent 的默认模型与设置' },
    { path: d('.credentials.yaml'), mode: 'strict', why: '密钥：被换掉 = 别人能进来' },
    // ③ 判据本身
    { path: p('docs/handbook'), kind: 'dir', mode: 'strict', why: '手册就是判据：能随手改判据，任何闸都白设' },
    // 本来就该变的安全数据：只报不拦
    { path: p('v2/services/core/data/auth.json'), mode: 'report', why: '口令与撤销表（主人换口令是正常动作，不该因此起不来，但要知道它动过）' },
    { path: d('storages'), kind: 'dir', mode: 'report', why: '运行时数据，不是指令；被动过要看得见' },
  ];
}

/** 一个文件的 sha256（十六进制）。 */
export function hashFile(file) {
  return nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(file)).digest('hex');
}

/** 把一个条目（文件或目录）展开成"要核对的绝对路径"列表（排好序、去重）。 */
export function filesUnder(entry) {
  if (entry.kind !== 'dir') return [entry.path];
  const out = [];
  const walk = (dir) => {
    let list;
    try {
      list = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不在 ⇒ 交给上层当"缺了"
    }
    for (const e of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ALWAYS_SKIP.has(e.name)) continue;
      const full = nodePath.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  };
  walk(entry.path);
  return out;
}

/**
 * 按当前磁盘状态**重建**清单。由**主人**跑（`sudo node scripts/verify-integrity.mjs --build`）。
 */
export function buildBaseline({ repo, home, now = Date.now(), builtBy = 'root' }) {
  const entries = {};
  for (const e of protectedPaths({ repo, home })) {
    for (const f of filesUnder(e)) {
      let sha256;
      try {
        sha256 = hashFile(f);
      } catch {
        continue; // 不在的文件不进清单（"缺了"这件事由 verify 那边报）
      }
      entries[f] = { sha256, mode: e.mode, why: e.why };
    }
  }
  return { version: BASELINE_VERSION, builtAt: now, builtBy, entries };
}

/**
 * 核对。返回 `{state, changed, blocked, warnings}`。
 *
 * * `state`：`ok` / `tampered` / `absent`
 * * `changed`：**具体哪几个文件**对不上（说人话给主人看；日志里不出现密钥内容）
 * * `blocked`：strict 里对不上的那些 ⇒ 调用方**拒绝启动**
 * * `warnings`：report 里对不上的那些 ⇒ 只报
 */
export function verifyBaseline({ baseline, exists = true }) {
  if (!exists || !baseline || typeof baseline !== 'object' || !baseline.entries) {
    return { state: 'absent', changed: [], blocked: [], warnings: [], count: 0 };
  }
  // ⚠️ **空清单 = 什么都没在核对**。它要是算"过"，那这道闸就能被一份空文件绕过去。
  if (Object.keys(baseline.entries).length === 0) {
    const item = {
      file: '（清单本身）',
      what: '一个条目都没有 ⇒ 什么都没在核对',
      mode: 'strict',
      why: '空的清单不是"全都对"，是"什么都没查"',
    };
    return { state: 'tampered', changed: [item], blocked: [item], warnings: [], count: 0 };
  }
  const changed = [];
  const blocked = [];
  const warnings = [];
  for (const [file, want] of Object.entries(baseline.entries)) {
    let got = null;
    try {
      got = hashFile(file);
    } catch {
      got = null; // 不在了
    }
    if (got === want.sha256) continue;
    const what = got === null ? '不在了' : '内容变了';
    const item = { file, what, mode: want.mode ?? 'strict', why: want.why ?? '' };
    changed.push(item);
    (item.mode === 'report' ? warnings : blocked).push(item);
  }
  return {
    state: changed.length === 0 ? 'ok' : 'tampered',
    changed,
    blocked,
    warnings,
    count: Object.keys(baseline.entries).length,
  };
}

/**
 * 把清单写到磁盘上：**只读**（`0444`）。
 *
 * ⚠️ 单独拿出来是为了**能测**：`--build` 那段要 root，而本机的 AI 没有 root
 *    （`sudo` 要密码 —— 那正是 P2 安全性的来源）。分开之后，
 *    "写下去的那份东西长什么样"这件事照样进得硬闸。
 */
export function writeBaselineFile(file, baseline) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o755 });
  nodeFs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
  nodeFs.chmodSync(file, 0o444);
  return file;
}

/** 从磁盘读清单并核对（`serve.js` 开机走这条）。 */
export function checkAgainstDisk({ repo, home, baselinePath = BASELINE_PATH }) {
  if (!nodeFs.existsSync(baselinePath)) return verifyBaseline({ exists: false });
  let baseline = null;
  try {
    baseline = JSON.parse(nodeFs.readFileSync(baselinePath, 'utf8'));
  } catch {
    // 清单本身坏了：**不能当"没有"**（那就是悄悄失效）⇒ 当成对不上
    return {
      state: 'tampered',
      changed: [{ file: baselinePath, what: '读不出/不是合法 JSON', mode: 'strict', why: '清单本身' }],
      blocked: [{ file: baselinePath, what: '读不出/不是合法 JSON', mode: 'strict', why: '清单本身' }],
      warnings: [],
    };
  }
  return verifyBaseline({ baseline });
}

/**
 * 给 `config.js` 的 `preflight` 用：变成"问题"与"提醒"。
 *
 * ⚠️ 这里刻意**不抛**——启动路径的规矩是：能提前查的都查出来，一起报（见 `serve.js`）。
 */
export function integrityReport({ repo, home, baselinePath = BASELINE_PATH }) {
  const r = checkAgainstDisk({ repo, home, baselinePath });
  const problems = [];
  const notes = [];

  if (r.state === 'absent') {
    // ⚠️ **不许悄悄过去**：这是"看起来有闸、其实没有"的那一类
    notes.push(
      `开机清单还没建（${baselinePath} 不在）⇒ **P1 那条保护还没启用**。` +
        `建一次：sudo node scripts/verify-integrity.mjs --build`,
    );
  }
  for (const c of r.blocked) {
    problems.push(
      `开机清单对不上：${c.file}（${c.what}；${c.why}）` +
        `\n      ⇒ 拒绝启动（手册 P1.4）。是你自己改的就重建清单：` +
        `sudo node scripts/verify-integrity.mjs --build` +
        `\n      ⇒ 不是你改的：git revert 那一次改动，或把它改回来`,
    );
  }
  for (const c of r.warnings) {
    notes.push(`开机清单里"只报不拦"的条目动过：${c.file}（${c.what}）`);
  }
  return { ...r, problems, notes };
}
