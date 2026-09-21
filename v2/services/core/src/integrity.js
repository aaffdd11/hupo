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

/**
 * 目录递归时永远不看的**目录名**（依赖、版本库、缓存）。
 *
 * ⚠️ **别把 `sessions` 这类名字加进来**：那是按名字整层跳过，
 *    而同一个名字在不同地方可以是完全不同的东西——
 *    `~/.dsh/sessions/`（40M 运行时流水，本来就不在清单里）
 *    vs `~/.dsh/storages/session_projcache/sessions/*.json`（**在**清单里，1.7M）。
 *    2026-09-21 实测踩到：加了这个名字之后，`storages` 那一条**只算到 1 个文件**，
 *    其余全被静默跳过 —— 也就是"看起来在查、其实没查"。
 *    ⇒ 想排除某个具体路径，就**别把它放进 `protectedPaths()`**，不要按名字连坐。
 */
const ALWAYS_SKIP = new Set(['node_modules', '.git', '.cache']);

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
    // ⚠️ 这两条现在是 `report`（**只报不拦**）—— 这是**主人 2026-09-21 定的取舍**：
    //    开发期代码天天改，要是它们也 strict，助手每改一行主人就得补一条 `sudo`，
    //    否则下次重启服务会拒绝启动。⇒ 先只报，**等收口了再收紧**。
    //    ⚠️ 这是个**刻意的让步**，不是"本来就该这样"：P1.2 的判据（一条路径都不许剩）
    //       在 `src/` 与 `scripts/` 这两条上**今天没有满足**。有一条测试把这个状态钉住，
    //       免得下一个人以为它是 strict 而放松了别的。
    { path: p('v2/services/core/src'), kind: 'dir', mode: 'report', why: '调度器自己的代码：开机就执行（开发期"只报不拦"，收口后应收紧）' },
    { path: p('scripts'), kind: 'dir', mode: 'report', why: '主人会手动跑的脚本（同上，开发期"只报不拦"）' },
    // ② 开机自动喂给 agent 的
    { path: p('v2/services/core/hupo-persona.yml'), mode: 'strict', why: '每开一个新 agent 就喂一遍：改一句就改掉它的性格与纪律' },
    {
      path: p('v2/services/core/hupo-capabilities.yml'),
      mode: 'strict',
      why: '能力层：每开一个新 agent 就挂一次（它决定模型手里有哪些工具）——改它就能给自己加一条新的能力',
    },
    { path: p('AGENTS.md'), mode: 'strict', why: '助手给"下一次的自己"读的说明书' },
    {
      path: d('profiles'),
      kind: 'dir',
      // ⚠️ 只认这两个：它们**就是喂给 agent 的东西**（profile 定义 + 补丁）。
      //    `package.json` / `pnpm-workspace.yaml` 是安装产物，`pnpm install` 会正常改写它们
      //    ⇒ 把它们算进来 = 一次正常安装就让服务再也起不来。
      only: ['cordis.yml', 'cordis.patch.yml'],
      mode: 'strict',
      why: 'agent 的 profile 与补丁——改它就能改自己每轮读到的东西',
    },
    // ⚠️ 下面两条是 **report** 而不是 strict：它们会被**正常运行**改写。
    //    `settings.yaml` 记着"那个提示看过了"这类东西；`.credentials.yaml` 里的令牌会**自己续期**。
    //    拿它们当 strict ⇒ 某天开机**无故拒绝启动**，而主人不在跟前。
    //    ⇒ "看得见它被换过"才是这两条真正能提供的保护。
    { path: d('settings.yaml'), mode: 'report', why: 'agent 的模型与设置：运行时会被写（例如记住提示看过了），所以只报不拦' },
    { path: d('.credentials.yaml'), mode: 'report', why: '密钥：令牌会自己续期 ⇒ 只报不拦，但被换掉必须看得见' },
    // ③ 判据本身
    { path: p('docs/handbook'), kind: 'dir', mode: 'strict', why: '手册就是判据：能随手改判据，任何闸都白设' },
    // 本来就该变的安全数据：只报不拦
    { path: p('v2/services/core/data/auth.json'), mode: 'report', why: '口令与撤销表（主人换口令是正常动作，不该因此起不来，但要知道它动过）' },
    // ⚠️ `~/.dsh/storages/**` **故意不在清单里**（这是一个取舍，写下来免得下一个人以为是漏了）：
    //    · 它是**运行时数据**（会话缓存），agent 每一轮都在写它
    //    ⇒ 放进清单只会有两种结果：
    //      ① strict —— 每轮之后开机都"对不上" ⇒ 服务天天拒绝启动（荒谬）
    //      ② report —— 每次开机都报一句"它动过" ⇒ **每次都响的报警等于没有报警**，
    //         而且会把主人的注意力训练成"忽略这一栏"
    //    ⇒ 取舍：**不进清单**。代价是"有人往 KV 里塞东西"这条路**没有被覆盖**——
    //      真要覆盖它得看**内容**而不是**摘要**（那是另一件事，记在
    //      `docs/dev/00-PROGRESS.md` §六 第 23 条）。
    //    依据：决策 **C1**（"KV 是运行时数据不是源码 ⇒ 判据改成'清单里没有可写路径'"）。
    //
    // ⚠️ **账本（`data/ledger.jsonl`）同样故意不在清单里**（批 4，2026-09-21）：
    //    它是**用户数据**，每一笔都在写它 ⇒ 放进来只会有两种结果：
    //      · strict —— 记一笔账之后开机就"对不上"（荒谬）
    //      · report —— 每次开机都报"它动过"（**每次都响的报警等于没有报警**）
    //    ⇒ 与 `storages` 同一条取舍（C1）。⚠️ 代价也一样：**"有人往账本里塞东西"
    //      这条路没有被清单覆盖** —— 它靠的是"写盘只有服务端那一处"
    //      （MCP 那支进程只能经域套接字提请求，见 `ledger-socket.js`）。
  ];
}

/**
 * 从 `/etc/passwd` 的内容里取某个 uid 的 home（**纯函数**，好测）。
 * 取不到返回 null。
 */
export function homeFromPasswd(text, uid) {
  for (const line of String(text ?? '').split('\n')) {
    const f = line.split(':');
    if (f.length >= 7 && Number(f[2]) === uid && f[5]) return f[5];
  }
  return null;
}

/**
 * **这份清单该按谁的 home 算。**
 *
 * ⚠️⚠️ 这是 2026-09-21 实测踩出来的一个**静默失效**，值得完整读一遍：
 *
 *   清单是**主人用 `sudo` 建的**，而 `sudo` 下 `os.homedir()` 是 **`/root`**。
 *   于是 `~/.dsh/profiles`、`~/.dsh/settings.yaml`、`~/.dsh/.credentials.yaml`
 *   这三条被算成了 `/root/.dsh/**` —— 而那里**一个文件都没有**
 *   ⇒ `buildBaseline` 把"读不到的文件"**静静跳过** ⇒ **这三条从来没进过清单**。
 *
 *   也就是说：**P1 最核心的那条保护（不许改自己的 profile / 设置 / 密钥）一直是空的**，
 *   而开机横幅照样写"完整性 对上了"。这正是本仓库最忌讳的形状：
 *   **看起来有闸、其实没有。**
 *
 *   ⇒ 修法：清单要按**仓库属主的 home** 算（服务就跑在那个账号下），
 *      **不是**按"现在跑这条命令的人"算。`sudo` 不改变仓库属主。
 */
export function resolveServiceHome({ repo, fallback = null } = {}) {
  try {
    const uid = nodeFs.statSync(repo).uid;
    const passwd = nodeFs.readFileSync('/etc/passwd', 'utf8');
    const home = homeFromPasswd(passwd, uid);
    if (home) return home;
  } catch { /* 读不到就退回调用方给的兜底 */ }
  return fallback ?? nodeOs.homedir();
}

/**
 * **清单漏了哪几条**（P1.2 的判据：一条路径都不许剩）。
 *
 * ⚠️ 为什么非要有这个函数：`verifyBaseline()` 是**按清单里已有的条目**核对的
 *    —— 清单里**没有**的东西，它永远看不见。上面那个 `/root` 的坑就是这么静默过去的。
 *    ⇒ 这里反过来问一句：**"声明要保护的路径，盘上真有东西，而清单里一条都没有"**，
 *      有几个？那几个就是**没被看着的**。
 *
 * 判据刻意不含"盘上本来就没有"的路径（例如这台机器上还没装 dsh）：
 * 那种情况下没什么可保护的，不该报。
 *
 * @returns {{path:string, mode:string, onDisk:number, missing:string[], kind:'path'|'files', why:string}[]}
 */
export function coverageGaps({ repo, home, baseline }) {
  const entries = baseline?.entries ?? {};
  const gaps = [];
  for (const e of protectedPaths({ repo, home })) {
    // ⚠️ `filesUnder()` 对**单文件**那一类是直接把路径给你、**不看它在不在**
    //    ⇒ 这里必须自己过一遍"真的在盘上"。（`buildBaseline` 靠 hash 失败跳过，
    //      所以那边看不出这个差别；这一条要是漏了，就会把"本来就没有的文件"
    //      报成"清单漏了它" —— 假红比漏报好，但假红会把人训练成不看这一栏。）
    const under = filesUnder(e).filter((f) => nodeFs.existsSync(f));
    if (under.length === 0) continue; // 盘上没有 ⇒ 没什么可保护的
    // ⚠️ **落了单的也要报**（2026-09-21 第二次实测踩到）：
    //    `verifyBaseline()` 只遍历清单里**已有**的条目 ⇒ 往 `scripts/` 里
    //    **新加一个文件**，横幅照样写"对上了"。这里把"盘上有、清单里没有"的挑出来。
    const missing = under.filter((f) => !Object.prototype.hasOwnProperty.call(entries, f));
    if (missing.length === 0) continue;
    gaps.push({
      path: e.path,
      mode: e.mode,
      onDisk: under.length,
      missing,
      // `path` = 整条都没核对；`files` = 只是落了单的几个
      kind: missing.length === under.length ? 'path' : 'files',
      why: e.why,
    });
  }
  return gaps;
}

/** 一个文件的 sha256（十六进制）。 */
export function hashFile(file) {
  return nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(file)).digest('hex');
}

/** 把一个条目（文件或目录）展开成"要核对的绝对路径"列表（排好序、去重）。 */
export function filesUnder(entry) {
  if (entry.kind !== 'dir') return [entry.path];
  // `only`：目录里**只有这几个文件名**算"就是那条指令本身"。
  // ⚠️ 为什么要它：同一个目录里往往混着"指令"与"安装产物"
  //    （`cordis.patch.yml` vs `package.json` / `pnpm-workspace.yaml`），
  //    后者会被 `pnpm install` 这类正常动作改写 ⇒ 拿它当 strict 会**无故拒绝启动**。
  //    ⇒ 要把"会被正常动作改写的"排除掉，而不是把整层降级成 report。
  const only = entry.only ? new Set(entry.only) : null;
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
      else if (e.isFile() && (!only || only.has(e.name))) out.push(full);
    }
  };
  walk(entry.path);
  return out;
}

/**
 * 按当前磁盘状态**重建**清单。由**主人**跑（命令别手打：用 [rebuildCommand] 拼的那种绝对路径写法）。
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
 * **重建清单那一条命令**——按这台机器的实际路径拼出来。
 *
 * ⚠️ 为什么不用 `sudo node scripts/…` 这种写法：本机**没有系统 node**
 *    （`/usr/bin/node` 不存在，node 只在 `~/.nvm/...` 下），而 `sudo` 用的是
 *    **它自己的 PATH**，那里没有 nvm 的目录 ⇒ 主人照着跑会撞上
 *    「**sudo: node：找不到命令**」。
 *    一条跑不通的"修法"就是一句空话 —— 而且是在最需要它的时刻（服务起不来）出现。
 *    ⇒ 用 `process.execPath`（**现在正在跑的这个 node 的绝对路径**）+ 脚本的绝对路径。
 */
export function rebuildCommand({ repo }) {
  return `sudo ${process.execPath} ${nodePath.join(repo, 'scripts/verify-integrity.mjs')} --build`;
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
  // ⚠️ **没给 home 就按"仓库属主"算**（不是 `os.homedir()`）：
  //    清单是用 `sudo` 建的，而 `sudo` 下 homedir 是 `/root`
  //    ⇒ 两边算的必须是同一个 home，否则清单里那几条永远对不上（见 `resolveServiceHome`）。
  const who = home ?? (repo ? resolveServiceHome({ repo }) : nodeOs.homedir());
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
  const r = verifyBaseline({ baseline });
  // ★ **反着查一遍**：声明要保护的路径里，盘上有东西、而清单里一条都没有的
  //   —— 那几条就是"没被看着的"。`verifyBaseline` 永远看不见它们（它只看清单里已有的）。
  r.gaps = repo ? coverageGaps({ repo, home: who, baseline }) : [];
  return r;
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
        `建一次：${rebuildCommand({ repo })}`,
    );
  }
  for (const c of r.blocked) {
    problems.push(
      `开机清单对不上：${c.file}（${c.what}；${c.why}）` +
        `\n      ⇒ 拒绝启动（手册 P1.4）。是你自己改的就重建清单：` +
        `${rebuildCommand({ repo })}` +
        `\n      ⇒ 不是你改的：git revert 那一次改动，或把它改回来`,
    );
  }
  for (const c of r.warnings) {
    notes.push(`开机清单里"只报不拦"的条目动过：${c.file}（${c.what}）`);
  }
  // ★ **漏掉的那几条**（2026-09-21 实测踩到的那一类）。
  //   ⚠️ strict 的那几条**算问题**（拒绝启动）：声明了"对不上就不许起"，
  //      而实际上**根本没在核对** —— 那不是"少一道闸"，是"写着有闸却没有"，
  //      比不设更坏。report 的那几条只提醒。
  for (const g of r.gaps ?? []) {
    const what = g.kind === 'path'
      ? `**整条都没进清单**（盘上有 ${g.onDisk} 个文件，清单里一个条目都没有）`
      : `**有 ${g.missing.length} 个文件没进清单**（这条路径下盘上有 ${g.onDisk} 个）`;
    const line =
      `开机清单**漏了**：${g.path} —— ${what}` +
      (g.kind === 'files' ? `\n      没进清单的是：${g.missing.slice(0, 5).join('、')}${g.missing.length > 5 ? ' …' : ''}` : '') +
      `\n      ⇒ 这等于"**写着有闸、其实没在核对**"（${g.why}）。` +
      `\n      ⇒ 多半是用 ` +
      '`sudo` 建清单时 home 算成了 `/root`，或者建完之后**又加了文件**。重建：' +
      `${rebuildCommand({ repo })}`;
    if (g.mode === 'strict') problems.push(line);
    else notes.push(line);
  }
  return { ...r, problems, notes };
}
