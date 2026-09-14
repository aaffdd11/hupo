/**
 * Handoff 接管调度（混合模式，按你选的方案）：
 *
 *   主 agent 正在说话        → steer   （半路改口，最贴近原意）
 *   主 agent 正在调工具      → inject  （排队，绝不把工具调用切碎）
 *   主 agent 已空闲          → followup（开新轮补发，最安全）
 *
 * 另外两条纪律：
 *   1) 只交付一次：同一轮里已交付过的结论不再重复说。
 *   2) 超时必降级：Cortex 到 deadline 还没出结论，就用当前最优产物接管，绝不死等。
 */

/**
 * 决定接管方式。
 *
 * 三路基本策略之外，还有几个可选的"节奏"配置（默认关闭）：
 *   deferWhileThinking：主 agent 连一个字都还没吐（本质是模型还在想）时不抢话，
 *     等它开口或开始调工具再交付 —— 更自然，但用户要多等一会儿。
 *   always-inject / always-steer / safe-followup：强制走某一路，便于对比与压测。
 */
export function planHandoff({
  hostStatus,
  mode = 'hybrid',
  hasResult = true,
  alreadyDelivered = false,
  spokenChars = 0,
  options = {},
}) {
  if (!hasResult) return { action: 'none', reason: '深层结论尚未就绪' }
  if (alreadyDelivered) return { action: 'none', reason: '本轮已交付过结论，不重复' }

  if (mode === 'always-steer') return { action: 'steer', reason: '配置强制半路接管' }
  if (mode === 'safe-followup') return { action: 'followup', reason: '配置强制说完再补一条' }
  if (mode === 'always-inject') return { action: 'inject', reason: '配置强制排队注入' }

  // 主 agent 还没开口 → 它还在"想"，这时插话会显得突兀，推迟到下一个边界
  if (options.deferWhileThinking && hostStatus === 'running-text' && spokenChars === 0) {
    return { action: 'none', reason: '主 agent 尚未开口（模型还在想），推迟到边界再交付' }
  }

  switch (hostStatus) {
    case 'running-text':
      return { action: 'steer', reason: '主 agent 正在说话，在下一个边界改口接着说' }
    case 'running-tools':
      return { action: 'inject', reason: '主 agent 正在调工具，排队注入避免切碎工具调用' }
    default:
      return { action: 'followup', reason: '主 agent 已空闲，开新轮补发结论' }
  }
}

/**
 * 执行接管。
 * @param {import('./host.js').HostAdapter} host
 * @param {import('./types.js').Synthesis} synthesis
 * @param {{mode?: string, delivered?: Set<string>, options?: object}} [options]
 */
export async function handoff(host, synthesis, options = {}) {
  const key = synthesis?.dedupeKey ?? synthesis?.oneLiner ?? ''
  const delivered = options.delivered ?? new Set()
  const plan = planHandoff({
    hostStatus: host.status(),
    mode: options.mode,
    hasResult: Boolean(synthesis?.oneLiner),
    alreadyDelivered: key ? delivered.has(key) : false,
    spokenChars: (host.spokenText() ?? '').length,
    options: options.options ?? {},
  })

  if (plan.action === 'none') return { ...plan, delivered: false }

  const text = composeText(withLead(synthesis, plan.action))
  const payload = { text, reason: plan.reason, synthesis }

  if (plan.action === 'steer') await host.steer(payload)
  else if (plan.action === 'inject') await host.inject(payload)
  else await host.followup(payload)

  if (key) delivered.add(key)
  return { ...plan, delivered: true, text }
}

/** 把提炼产物拼成"主 agent 会说的那句话"。 */
export function composeText(synthesis) {
  const parts = []
  if (synthesis?.lead) parts.push(synthesis.lead)
  parts.push(synthesis.oneLiner)
  if (Array.isArray(synthesis?.bullets) && synthesis.bullets.length) {
    parts.push(synthesis.bullets.map((b, i) => `${i + 1}. ${b}`).join('\n'))
  }
  if (synthesis?.nextAction) parts.push(synthesis.nextAction)
  return parts.filter(Boolean).join('\n')
}

/**
 * ⚠ 已废弃的固定承接语（保留仅为兼容旧调用方）。
 *
 * 三轮评审一致指出这是**真 bug**（PM 在 `DEBATE-pm-vs-arch.md` 里逐行指出）：
 * 这三句是**写死的台词**，其中两句正是 `ARCHITECTURE-seamless.md` §4.2 明令禁止的
 * 断裂式开头（"另外，关于你刚才的问题，我已经有结论了：" / "补一句，关于你刚才说的那件事："），
 * 而且**逐轮重复** ⇒ 必然变成口头禅。
 *
 * 正确做法：**承接短语由反馈层自己生成**（它的上下文里有接收层已输出全文 + 语气样本），
 * 控制器只负责把"必须承接"作为约束下发，不负责写台词。
 * 见 `ARCHITECTURE-seamless.md` §2「承接不是拼装出来的，是生成出来的」。
 */
const DEPRECATED_LEADS = {
  followup: '补一句，关于你刚才说的那件事：',
  inject: '另外，关于你刚才的问题，我已经有结论了：',
  steer: '想到答案了：',
}

/**
 * 给结论加承接语。
 *
 * **默认不再注入任何固定短语**（返回原样），把承接交给反馈层生成。
 * 只在显式传入 `allowScriptedLead: true` 时（仅用于回归对比测试）才使用旧台词。
 */
export function withLead(synthesis, action, { allowScriptedLead = false } = {}) {
  if (!synthesis) return synthesis
  if (!allowScriptedLead) return synthesis
  return { ...synthesis, lead: DEPRECATED_LEADS[action] ?? '' }
}
