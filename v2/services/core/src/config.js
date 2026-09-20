// 配置。手册 `08-SPEC.md` §15.6。
//
// ⚠️ 只有**一条**纪律要记住：**数值不写死在这儿**的说法不适用于配置源——
//    但**默认值**要写下来，而且**每一项都要能说清为什么是这个值**。
//    说不清的，就别设默认，让它启动时报错。

import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { RECAP_DEFAULTS } from './recap.js';

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const dataDir = env.HUPO_DATA ?? nodePath.resolve(cwd, 'data');

  return {
    // ── 服务 ──
    port: Number.parseInt(env.HUPO_PORT ?? '8020', 10),
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

    /** 人格 patch。给了就挂上；文件不在就不挂（下面会检查并警告）。 */
    personaPath: env.HUPO_PERSONA ?? null,

    /** 冷启动实测 ~1.1s（initialize），留足余量。 */
    agentBootTimeoutMs: Number.parseInt(env.HUPO_AGENT_BOOT_TIMEOUT_MS ?? '90000', 10),

    /**
     * 一个进程同时留几个 agent。
     * ⚠️ 手册 §10.3 记着**这个默认值有冲突（3 vs 4）**，且没定"它算不算准入判据"。
     *    ⇒ 这里取 4 并**明确**：它只用于淘汰与告警，**不是准入判据**
     *      （准入看内存，见 §15.2）。
     */
    agentMaxProcesses: Number.parseInt(env.HUPO_AGENT_MAX_PROCESSES ?? '4', 10),

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
  if (cfg.personaPath && !nodeFs.existsSync(cfg.personaPath)) {
    notes.push(`人格 patch 不存在，将不挂它：${cfg.personaPath}`);
  }
  if (!nodeFs.existsSync(cfg.dshHome)) {
    notes.push(`DSH_HOME 不存在：${cfg.dshHome}（agent 起来时才可能报错）`);
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
  return { problems, notes };
}
