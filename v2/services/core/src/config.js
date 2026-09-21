// 配置。手册 `08-SPEC.md` §15.6。
//
// ⚠️ 只有**一条**纪律要记住：**数值不写死在这儿**的说法不适用于配置源——
//    但**默认值**要写下来，而且**每一项都要能说清为什么是这个值**。
//    说不清的，就别设默认，让它启动时报错。

import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { RECAP_DEFAULTS } from './recap.js';
import { ledgerSocketPath } from './ledger-socket.js';

/**
 * 读一个 uid/gid；**没设、空串、或者不是非负整数 ⇒ `null`**（= 不换手）。
 *
 * ⚠️ **解析不出来要当"没设"，不许当 0**：`0` 是 root，
 *    而"写错了反而变成 root"是这里最坏的失败方向。
 */
function parseIdOrNull(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const dataDir = env.HUPO_DATA ?? nodePath.resolve(cwd, 'data');

  return {
    // ── 服务 ──
    port: Number.parseInt(env.HUPO_PORT ?? '8020', 10),

    /**
     * 监听地址。**默认 `127.0.0.1`——这一条不许松。**
     *
     * ⚠️ 唯一该改成 `0.0.0.0` 的场合：**服务跑在容器里**（租户那台）。
     *    容器内的 `0.0.0.0` 不等于对外——对外那一层是宿主上的端口映射，
     *    而**那个必须只绑 `127.0.0.1`**（实测：容器够得着宿主 `0.0.0.0` 的服务，
     *    所以一旦把租户的口开在 `0.0.0.0`，甲那台就能连乙那台）。
     * ⚠️ 在宿主上把它设成 `0.0.0.0` = **把服务直接递给整个局域网**，横幅会大声喊。
     */
    host: env.HUPO_HOST ?? '127.0.0.1',
    dataDir,
    webRoot: env.HUPO_WEB ?? nodePath.resolve(cwd, 'web'),
    buildId: env.HUPO_BUILD_ID ?? 'dev',

    // ── agent ──
    /** `dsh` 可执行文件。**这台机器上是 nvm 里那个软链。** */
    dshBin: env.HUPO_DSH_BIN ?? 'dsh',

    /**
     * profile 名。`sdk` 是 **dsh 内置模板**（不需要在 `$DSH_HOME/profiles` 下有目录）。
     * 实测：`dsh --profile sdk --dump-default-config` 能出配置树。
     */
    agentProfile: env.HUPO_AGENT_PROFILE ?? 'sdk',

    /**
     * agent 的工作目录。
     * ⚠️ **它必须存在**，否则 spawn 报 ENOENT——
     * 而那个 ENOENT 和"找不到 dsh 程序"**报的是同一句话**，极难查。
     */
    agentCwd: env.HUPO_AGENT_CWD ?? nodePath.join(nodeOs.homedir(), 'hupo-workspace'),

    /** `DSH_HOME`。份内份外：一个用户一份（不变量 N21）。 */
    dshHome: env.DSH_HOME ?? nodePath.join(nodeOs.homedir(), '.dsh'),

    agentProvider: env.HUPO_AGENT_PROVIDER ?? 'deepseek-official',
    agentModel: env.HUPO_AGENT_MODEL ?? 'deepseek-flash',
    agentEffort: env.HUPO_AGENT_EFFORT ?? 'low',
    agentMaxTokens: Number.parseInt(env.HUPO_AGENT_MAX_TOKENS ?? '16000', 10),

    /**
     * 人格 patch。**默认就是仓库里那一份** —— 人格是产品的一部分，不是可选配置。
     *
     * ⚠️ 为什么默认挂上、而且**缺了就当启动失败**（下面 `preflight`）：
     *    没有它的时候，agent 会退化成一个**通用编码助手**——
     *    照样回答、照样能干活、照样没有任何报错。
     *    那种故障看起来只是"它今天说话有点怪"，**没人会去查配置**。
     *    （这正是本仓库反复栽的那个形状：**静默降级**。）
     */
    personaPath: env.HUPO_PERSONA ?? nodePath.resolve(cwd, 'hupo-persona.yml'),

    /**
     * **能力层** patch（批 4 · 契约 `docs/dev/31-LEDGER.md` v2 §7.1）。
     *
     * 它和人格那一份是**同一种东西**：`dsh --patch` 的额外覆盖层（可重复），
     * 挂在 profile 之后 ⇒ **不碰 `~/.dsh/profiles/**` 那几个受保护文件**。
     *
     * ⚠️ 它里面**不许有秘密**：MCP 那头拿到的是一个**域套接字的路径**，
     *    准入靠文件权限（0600）。原因见契约 §7.2（父环境会被清洗、
     *    写进配置就等于把令牌放进仓库）。
     */
    capabilitiesPath: env.HUPO_CAPABILITIES ?? nodePath.resolve(cwd, 'hupo-capabilities.yml'),

    /**
     * 账本那条本地通道（域套接字）。
     *
     * ⚠️ 它跟着 `dataDir` 走：账本日志和这条口是一对。
     * ⚠️ 路径里**没有账号也没有秘密** —— 谁连得上由文件权限说了算。
     */
    ledgerSocketPath: env.HUPO_LEDGER_SOCKET ?? ledgerSocketPath(dataDir),

    /**
     * **临时验证码**（开发期口子 · 契约 `docs/dev/37-MULTITENANT.md` §六）。
     *
     * ⚠️ **默认空 = 关**：不显式设它就**任何码都登不进**。
     * ⚠️ 设了它就等于"**谁都能用任意手机号进去**"（手机号就是账号）⇒
     *    服务端**每次开机都要大声报它开着**（见 `serve.js` 的横幅）。
     * ⚠️ 真短信接上之后，这一段**删掉**，不是"留着备用"。
     */
    devCode: env.HUPO_DEV_CODE ?? '',

    /**
     * **主人自己那个手机号**（可选）。
     *
     * ⚠️ 设了它 ⇒ 开机时把那个号**绑到原来那个账号**（`owner`）。
     *    不设也行：绑一次就落在 `data/users.json` 里了（0600，不进仓库）。
     *    ⚠️ 手机号是个人信息 —— **不许写进仓库、不许打进日志**（横幅只印脱敏形态）。
     */
    ownerPhone: env.HUPO_OWNER_PHONE ?? '',

    /** MCP 服务器那支脚本（绝对路径：spawn 时经环境变量递给 dsh）。 */
    ledgerServerPath: env.HUPO_LEDGER_SERVER ?? nodePath.resolve(cwd, 'src/mcp-ledger-server.mjs'),

    /** 冷启动实测 ~1.1s（initialize），留足余量。 */
    agentBootTimeoutMs: Number.parseInt(env.HUPO_AGENT_BOOT_TIMEOUT_MS ?? '90000', 10),

    /**
     * 一个进程同时留几个 agent。
     * ⚠️ 手册 §10.3 记着**这个默认值有冲突（3 vs 4）**，且没定"它算不算准入判据"。
     *    ⇒ 这里取 4 并**明确**：它只用于淘汰与告警，**不是准入判据**
     *      （准入看内存，见 §15.2）。
     */
    agentMaxProcesses: Number.parseInt(env.HUPO_AGENT_MAX_PROCESSES ?? '4', 10),

    /**
     * **agent 的手以哪个 uid/gid 跑**（多租户 ②-2「换手」· `39-PERMISSIONS.md` §5.2）。
     *
     * ⚠️ **默认 `null` = 不换手**（跟着服务自己那个身份跑）。两条理由：
     *   1. **宿主上必须不换**：本机服务跑在 `deploy` 下，他的 agent 就该是 `deploy`
     *      —— 换手需要特权，而宿主上服务**没有**特权（也不该有）；
     *   2. **容器里必须换**（镜像里设 `HUPO_AGENT_UID=1000`）：
     *      盒内的服务是 root，而 root 带着 `CAP_DAC_OVERRIDE`
     *      ⇒ **agent 是 root 时任何权限位都拦不住它读 key**（决策 ①）。
     *
     * ⚠️ 换不过去要**大声失败**，不许静默退回 root：静默退回 = 边界不在、
     *    而一切看起来正常（这正是本项目最忌的那种失败）。
     */
    agentUid: parseIdOrNull(env.HUPO_AGENT_UID),
    agentGid: parseIdOrNull(env.HUPO_AGENT_GID),

    /**
     * **让模型那条路走盒内的 root 小代理**（多租户 ②-3）。
     *
     * 它是一份 patch 文件（`--patch` 那一层），内容是给 `llm-deepseek` 那一条
     * 设 `baseURL` + `apiKeyEnv` —— 见 `src/model-proxy.mjs` 顶上那段。
     * ⚠️ 默认 `null` = **不改**（宿主上模型直连，行为逐字不变）。
     */
    modelPatchPath: env.HUPO_MODEL_PATCH || null,

    /** 空闲多久可以淘汰。手册说 30 分钟**不够**，但改它要配合准入，先沿用。 */
    agentIdleEvictMs: Number.parseInt(env.HUPO_AGENT_IDLE_MS ?? String(30 * 60 * 1000), 10),

    /** 进程死了要不要在下次说话时重起。 */
    agentRestartOnDemand: true,

    // ── 跨重启接记忆 ──
    // ⚠️ 默认值**住在 `recap.js`**（阈值只该有一个出处），这里只负责能改。
    //    为什么要能改：额度是"记忆多长"的直接旋钮，
    //    而多长合适要看真实使用——不该为了改它去动代码。
    recap: {
      maxEntries: Number.parseInt(env.HUPO_RECAP_MAX_ENTRIES ?? String(RECAP_DEFAULTS.maxEntries), 10),
      maxChars: Number.parseInt(env.HUPO_RECAP_MAX_CHARS ?? String(RECAP_DEFAULTS.maxChars), 10),
      maxEntryChars: Number.parseInt(
        env.HUPO_RECAP_MAX_ENTRY_CHARS ?? String(RECAP_DEFAULTS.maxEntryChars),
        10,
      ),
    },
    /**
     * **单轮硬收口**。手册 `08-SPEC.md` §10.2 给的就是这个数（180s）。
     *
     * 为什么是这个量级：比它短的会切掉正常的慢活（带工具的一轮实测十几秒很正常），
     * 比它长的用户已经在盯着屏幕等——手册事故一里那行"还有件事在处理"挂了 **68 分钟**。
     *
     * ⚠️ 设成 `0` 等于**关掉**（测试与极端排障用）。**生产上不许关**：
     *    关掉之后 agent 一卡就是永远卡，而且它还永远占着一个位置
     *    （`running` 恒真 ⇒ LRU"跑着的不许卸" ⇒ 永不淘汰）。
     */
    turnDeadlineMs: Number.parseInt(env.HUPO_TURN_DEADLINE_MS ?? '180000', 10),
  };
}

/**
 * 启动前把**能提前查的都查一遍**。
 *
 * 为什么值得：spawn 的失败是**异步**的，而且 ENOENT 是**二义的**。
 * 在这里查清，能把"起不来"变成"启动时就说清楚"。
 */
export function preflight(cfg) {
  const problems = [];
  const notes = [];

  if (!nodeFs.existsSync(cfg.agentCwd)) {
    problems.push(
      `agent 的工作目录不存在：${cfg.agentCwd}\n` +
        `    ⇒ 修：mkdir -p "${cfg.agentCwd}"` +
        `（或设 HUPO_AGENT_CWD）`,
    );
  }
  if (!cfg.personaPath) {
    problems.push(
      'personaPath 是空的 ⇒ 人格挂不上，agent 会退化成一个通用编码助手，而且**不会有任何报错**。\n' +
        '    ⇒ 修：设 HUPO_PERSONA，或者别覆盖它的默认值（默认指向 v2/services/core/hupo-persona.yml）',
    );
  } else if (!nodeFs.existsSync(cfg.personaPath)) {
    // ⚠️ 这是**问题**不是提示：见上面 personaPath 那段注释。
    problems.push(
      `人格 patch 不存在：${cfg.personaPath}\n` +
        `    ⇒ agent 起得来、答得出、但**说话不是它该有的样子**，而且不会报错。\n` +
        `    ⇒ 修：把文件放回去，或设 HUPO_PERSONA 指向别处`,
    );
  }
  if (!nodeFs.existsSync(cfg.dshHome)) {
    notes.push(`DSH_HOME 不存在：${cfg.dshHome}（agent 起来时才可能报错）`);
  }

  // ★ **能力层**（批 4）。同样按人格那条规矩：**缺了要当场说**，
  //   因为"少一个能力"这件事在界面上看起来只是"它今天没记"，没人会去查配置。
  if (!cfg.capabilitiesPath) {
    problems.push(
      'capabilitiesPath 是空的 ⇒ 能力层挂不上，账本那几条工具在模型那一侧根本不存在。\n' +
        '    ⇒ 修：设 HUPO_CAPABILITIES，或者别覆盖它的默认值（默认指向 v2/services/core/hupo-capabilities.yml）',
    );
  } else if (!nodeFs.existsSync(cfg.capabilitiesPath)) {
    problems.push(
      `能力层 patch 不存在：${cfg.capabilitiesPath}\n` +
        `    ⇒ 它照样起得来、照样答得出，但**记不了账**，而且不会报错。\n` +
        `    ⇒ 修：把文件放回去，或设 HUPO_CAPABILITIES 指向别处`,
    );
  }
  if (!cfg.ledgerServerPath || !nodeFs.existsSync(cfg.ledgerServerPath)) {
    problems.push(
      `账本那支 MCP 服务器不在：${cfg.ledgerServerPath}\n` +
        `    ⇒ 能力层会以"起不来"告终（那份 patch 里 failOnStartupError: true），agent 会整个起不来。\n` +
        `    ⇒ 修：把 v2/services/core/src/mcp-ledger-server.mjs 放回去`,
    );
  }

  // 跨重启接记忆的额度：**说不通就起不来**，别让它悄悄生效。
  // ⚠️ `maxEntryChars > maxChars` 时单条上限比总额度还大 ⇒ 额度形同虚设，
  //    而现场看起来只是"它记性好得反常"（其实是把一整条长回答全喂了）。
  const rc = cfg.recap ?? {};
  if (!(rc.maxEntries >= 1)) {
    problems.push(`recap.maxEntries 必须 ≥1，收到 ${rc.maxEntries}`);
  }
  if (!(rc.maxChars >= 1)) {
    problems.push(`recap.maxChars 必须 ≥1，收到 ${rc.maxChars}`);
  }
  if (!(rc.maxEntryChars >= 1) || rc.maxEntryChars > rc.maxChars) {
    problems.push(
      `recap.maxEntryChars 必须在 1..maxChars 之间，收到 ${rc.maxEntryChars}（maxChars=${rc.maxChars}）`,
    );
  }

  // ⚠️ 硬收口可以被设成 0（关掉），但**必须大声说出来**——
  //    关掉之后 agent 卡住就是永远卡住，而现场看起来只是"它今天有点慢"。
  if (!Number.isFinite(cfg.turnDeadlineMs) || cfg.turnDeadlineMs < 0) {
    problems.push(`turnDeadlineMs 必须 ≥0，收到 ${cfg.turnDeadlineMs}`);
  } else if (cfg.turnDeadlineMs === 0) {
    notes.push('⚠️ 单轮硬收口被关掉了（turnDeadlineMs=0）——agent 卡住就不会有收尾。**生产上不该这样。**');
  }
  return { problems, notes };
}

/**
 * 横幅里那一行"**agent 的手是谁**"（多租户 ②-2）。
 *
 * ⚠️ 为什么必须**报出来**：换手失败/没配的时候，一切看起来都正常 ——
 *    而"agent 是不是 root"恰恰决定了决策 ① 的那条边界在不在。
 *    这个项目最忌的就是"看起来有闸、其实没有"，所以它不许静默。
 *
 * ⚠️ 纯函数（给 `test/unit` 钉）。
 */
export function describeAgentIdentity(cfg) {
  const uid = cfg?.agentUid ?? null;
  const gid = cfg?.agentGid ?? null;
  if (uid === null && gid === null) {
    return '跟服务同一个身份（**没换手**：宿主上就该这样；容器里必须有 HUPO_AGENT_UID）';
  }
  if (uid === 0) {
    return '⚠️ **root** —— 决策 ① 的边界**不在**了（root 带着 CAP_DAC_OVERRIDE，任何权限位都拦不住它）';
  }
  const g = gid === null ? '（gid 没设，跟着 uid 走）' : String(gid);
  return `uid ${uid} / gid ${g}（盒子里的"手"；服务自己是 root）`;
}
