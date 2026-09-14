// 配置：agent 运行时与节奏参数。
//
// 密钥来源优先级：环境变量 > ~/.dsh/.credentials.yaml
// （密钥只在宿主读取，**绝不下发到客户端**）
//
// ⚠ 2026-09-14 架构转向：处理层不再是"四次手搓模型调用"，而是**一个真 DSH agent**。
// 所以这里配的是"怎么起 agent 进程"，不再是"哪个 agent 用哪个模型"。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/// 本模块所在目录（用来定位随代码一起发布的 agent 人格文件）。
const here = path.dirname(fileURLToPath(import.meta.url));

/// 从 dsh 的凭据文件读 DEEPSEEK_API_KEY（agent 进程自己会读，这里只用于健康检查提示）。
function readDshCredential() {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * 找到 dsh 可执行文件。
 *
 * ⚠ 不能只写 `'dsh'`：systemd 起的服务 PATH 很窄，找不到 nvm 里的 bin，
 * 结果 spawn ENOENT（踩过）。这里按"环境变量 → PATH → 常见安装位置"依次找。
 */
function resolveDshBin() {
  const explicit = process.env.CONCIERGE_DSH_BIN;
  if (explicit) return explicit;

  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe'] : ['dsh'];
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'bin'),
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean);

  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* 继续找 */
      }
    }
  }
  return 'dsh'; // 最后兜底：让 spawn 自己报错，我们会如实告诉用户
}

export function loadConfig(overrides = {}) {
  const apiKey =
    overrides.apiKey ||
    process.env.CONCIERGE_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    readDshCredential();

  return {
    apiKey,
    port: Number(overrides.port || process.env.CONCIERGE_PORT || 8091),
    dataDir: overrides.dataDir || process.env.CONCIERGE_DATA_DIR || path.join(process.cwd(), 'data'),
    /** 客户端静态站点根目录（里面会有 client-build.json，用来判断"该刷新了"）。 */
    clientRoot: overrides.clientRoot || process.env.CONCIERGE_CLIENT_ROOT || '/var/www/hupo',

    // ── agent 运行时（一个会话 = 一个真 agent 进程）────────────────────
    /** dsh 可执行文件（自动找，避免 systemd 窄 PATH 导致的 ENOENT）。 */
    dshBin: overrides.dshBin || resolveDshBin(),
    /** 用哪个 profile。`sdk` = 官方 stdio JSON-RPC 运行时。 */
    agentProfile: overrides.agentProfile || process.env.CONCIERGE_AGENT_PROFILE || 'sdk',
    /** 人格覆盖层（随代码发布，产品的一部分）。 */
    personaPath: overrides.personaPath || process.env.CONCIERGE_PERSONA || path.join(here, '..', 'hupo-persona.yml'),
    /** agent 的工作目录：它能读写文件的地方。 */
    agentCwd: overrides.agentCwd || process.env.CONCIERGE_AGENT_CWD || path.join(os.homedir(), 'hupo-workspace'),
    /** agent 跑在哪个 provider / 模型上。 */
    agentProvider: overrides.agentProvider || process.env.CONCIERGE_AGENT_PROVIDER || 'deepseek-official',
    agentModel: overrides.agentModel || process.env.CONCIERGE_AGENT_MODEL || 'deepseek-flash',
    agentEffort: overrides.agentEffort || process.env.CONCIERGE_AGENT_EFFORT || 'low',
    /**
     * 单步输出上限。
     *
     * ⚠ 4000 会真的截断长回答（实测：撞上限时 turn/end 的 reason 是 `max-tokens`，
     * 用户拿到半句话）。长回答 + 思考都要吃这个预算，所以给足。
     */
    agentMaxTokens: Number(process.env.CONCIERGE_AGENT_MAX_TOKENS || 16000),
    /** 起步握手超时：起不来就报错，不要让用户干等。 */
    agentBootTimeoutMs: Number(process.env.CONCIERGE_AGENT_BOOT_MS || 30000),

    // ── 节奏（调度器唯一的职责）─────────────────────────────────────
    /**
     * **运行时**升级阈值：agent 一轮真跑起来超过这个时间，
     * 就当场告诉用户"这件事我单独去做，完了跟你说"，把它挪出当前对话。
     *
     * 依据是用户的原话：判据是**要多久**，不是"简单还是复杂"。
     */
    escalateAfterMs: Number(process.env.CONCIERGE_ESCALATE_MS || 15000),
    /** 单轮整体上限：到点必须收口，不留白。 */
    turnDeadlineMs: Number(process.env.CONCIERGE_TURN_DEADLINE_MS || 180000),
    /**
     * agent 进程空闲多久后回收（毫秒）。0 = 不回收。
     * 默认 30 分钟：一个常驻 agent 约 195MB，而服务 MemoryMax=1G —— 必须回收。
     */
    agentIdleEvictMs: Number(process.env.CONCIERGE_AGENT_IDLE_EVICT_MS || 30 * 60 * 1000),
  };
}
