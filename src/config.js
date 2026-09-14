/**
 * 全局配置与凭据解析。
 *
 * 凭据优先级：环境变量 CONCIERGE_API_KEY > DEEPSEEK_API_KEY > ~/.dsh/.credentials.yaml
 * 端点/模型可用环境变量覆盖，默认对接 DeepSeek 官方 OpenAI 兼容接口。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** 从 ~/.dsh/.credentials.yaml 读取 DEEPSEEK_API_KEY（只读 refs 段，不落盘不回显）。 */
function readDshCredential() {
  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
  ]
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m)
      if (m) return m[1]
    } catch {
      // 没有这个文件就走下一个来源
    }
  }
  return ''
}

/** 解析出一次运行的完整配置。 */
export function loadConfig(overrides = {}) {
  const apiKey =
    overrides.apiKey ??
    process.env.CONCIERGE_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    readDshCredential()

  return {
    baseUrl: overrides.baseUrl ?? process.env.CONCIERGE_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey,
    /** 快层（Reflex 第二档 / Router 分类）用的轻量模型。 */
    fastModel: overrides.fastModel ?? process.env.CONCIERGE_FAST_MODEL ?? 'deepseek-flash',
    /** 深层（Specialist）用的强模型。 */
    deepModel: overrides.deepModel ?? process.env.CONCIERGE_DEEP_MODEL ?? 'deepseek-v4-pro',
    /** 专家模型的思考强度：high 质量好但每次 4–6s，low/medium 显著更快。 */
    expertReasoningEffort: overrides.expertReasoningEffort ?? process.env.CONCIERGE_EXPERT_EFFORT ?? 'low',
    /**
     * 提炼阶段单独配模型。实测（4 条真实问题对拍，见 README「实测数据」）：
     *   提炼=pro/medium → 单次 ~5.5s，流水线 p50 12.0s，4/4 全部超时降级
     *   提炼=flash/none → 单次 ~1.3s，流水线 p50  6.5s，4/4 全部满质量交付
     * 提炼是"压缩"任务而非"推理"任务，用快模型反而更稳——这是本原型最值钱的一条调参结论。
     */
    synthModel: overrides.synthModel ?? process.env.CONCIERGE_SYNTH_MODEL ?? 'deepseek-flash',
    /** 提炼阶段的思考强度。 */
    synthReasoningEffort: overrides.synthReasoningEffort ?? process.env.CONCIERGE_SYNTH_EFFORT ?? 'none',
    /** 需要取证时并行的专家视角数（1=只开一个，最省时）。 */
    expertAngles: Number(overrides.expertAngles ?? process.env.CONCIERGE_EXPERT_ANGLES ?? 2),
    /** 皮层总超时：到点必须交付当前最优结论，绝不无限等。 */
    cortexDeadlineMs: Number(overrides.cortexDeadlineMs ?? process.env.CONCIERGE_CORTEX_DEADLINE_MS ?? 25000),
    /** Reflex 第一档（模板）命中时不再调模型。 */
    reflexTemplateFirst: overrides.reflexTemplateFirst ?? true,
    /** 接管策略：hybrid = 跑着 steer / 调工具时 inject / 空闲 followup。 */
    handoffMode: overrides.handoffMode ?? process.env.CONCIERGE_HANDOFF_MODE ?? 'hybrid',
    /**
     * 可选节奏策略：主 agent 还没开口（模型还在想）时不抢话，等它开口再接管。
     * 默认关闭——关闭时才可能出现"在模型思考期间就把结论插进去"的抢话观感。
     */
    deferWhileThinking: overrides.deferWhileThinking ?? process.env.CONCIERGE_DEFER_THINKING === '1',
    /** 是否强制使用假模型（离线演示 / 测试）。 */
    fake: overrides.fake ?? false,
    /** 数据目录（账本、指标落盘）。 */
    dataDir: overrides.dataDir ?? path.join(process.cwd(), 'data'),
    ...overrides,
  }
}
