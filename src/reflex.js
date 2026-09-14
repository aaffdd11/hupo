/**
 * Reflex 快层：亚秒级确认话术。
 *
 * 两档：
 *   1. 模板档（~0ms，不调模型）：问候、确认、致谢、催促、极短输入等高频场景直接出话。
 *   2. 小模型档：其余情况交给轻量模型，给出一句"我收到了 + 我理解你在说什么"。
 *
 * 重要：Reflex **不产出 assistant 消息**，它只产出「话术 + 时机」，
 * 由主 agent 用自己的口吻说出，从而保持"一个声音"。
 */

/** 模板档规则：命中即零延迟返回。 */
const TEMPLATES = [
  { id: 'greet', test: (t) => /^(你好|您好|hi|hello|在吗|哈喽|嗨)[!！。~\s]*$/i.test(t), reply: () => '在的，你说。' },
  { id: 'thanks', test: (t) => /(谢谢|多谢|感谢|thanks|thx)/i.test(t), reply: () => '不客气，接着说。' },
  { id: 'ok', test: (t) => /^(好的?|行|可以|嗯|ok|okay|明白|收到)[!！。~\s]*$/i.test(t), reply: () => '收到。' },
  { id: 'bye', test: (t) => /(再见|拜拜|先这样|回头聊)/i.test(t), reply: () => '好，随时叫我。' },
  { id: 'wait', test: (t) => /(等一下|稍等|等着|还在吗)/i.test(t), reply: () => '我在，你说完我就接。' },
  { id: 'urge', test: (t) => /(快点|怎么还没|急)/i.test(t), reply: () => '马上给你，正在收尾。' },
  { id: 'tooShort', test: (t) => t.trim().length <= 3, reply: (t) => `收到「${t.trim()}」，你想让我具体做什么？` },
]

/**
 * 生成反射话术。
 * @param {object} params
 * @param {string} params.text 用户原话
 * @param {object} [params.client] LLM 客户端（模板档未命中时使用）
 * @param {object} [params.cfg]
 * @param {boolean} [params.needsClarify] Router 已判定需要先澄清
 * @returns {Promise<import('./types.js').ReflexResult>}
 */
export async function reflex({ text, client, cfg, needsClarify = false }) {
  const started = Date.now()
  const normalized = String(text ?? '').trim()

  if (cfg?.reflexTemplateFirst !== false) {
    for (const rule of TEMPLATES) {
      if (rule.test(normalized)) {
        return { text: rule.reply(normalized), source: 'template', rule: rule.id, latencyMs: Date.now() - started }
      }
    }
  }

  if (!client) {
    return {
      text: `收到，你说的「${short(normalized)}」我记下了，正在想。`,
      source: 'template',
      rule: 'fallback',
      latencyMs: Date.now() - started,
    }
  }

  const system = [
    '[[REFLEX]] 你是助手的第一反射层，唯一职责是"让用户知道他刚才说的话被完整接住了"。',
    '规则：',
    '1) 只输出一句话，不超过 30 字，绝不解答问题本身。',
    '2) 必须包含"确认收到"，并复述你听到的核心诉求（不要照抄原话，不要带引号复述整句）。',
    '3) 只有诉求确实模糊时才反问，反问也只问一个最关键的问题。',
    '4) 不要客套开场白，不要 emoji，不要分点，不要换行。',
    '5) 不要输出""（空字符串），任何情况下都要有实质内容。',
  ].join('\n')

  const prompt = needsClarify
    ? `用户说：${normalized}\n注意：这条信息不足以直接动手，你的这句话里要包含一个最关键的反问。`
    : `用户说：${normalized}`

  try {
    const { text: out } = await client.chat({
      model: cfg?.fastModel,
      system,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens: 160,
      // 快层的命门：必须关掉思考。实测 reasoning_effort='none' 时 reasoning tokens=0，
      // 输出延迟显著低于带思考的档位。
      reasoningEffort: 'none',
    })
    const cleaned = out.trim()
    if (!cleaned) throw new Error('反射层返回空内容')
    return { text: cleaned, source: 'model', latencyMs: Date.now() - started }
  } catch (error) {
    return {
      text: `收到，你说的「${short(normalized)}」我记下了，正在想。`,
      source: 'template',
      rule: 'error-fallback',
      error: String(error?.message ?? error),
      latencyMs: Date.now() - started,
    }
  }
}

function short(text) {
  const s = String(text).replace(/\s+/g, ' ')
  return s.length > 20 ? `${s.slice(0, 20)}…` : s
}
