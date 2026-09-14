/**
 * LLM 客户端：OpenAI 兼容 chat/completions，外加一个可离线的假模型。
 *
 * - `createClient(cfg)` 返回 { chat, mode }
 * - chat({ model, system, messages, temperature, maxTokens, json, signal })
 * - 假模型（fake）按 system 里的角色标记返回结构化样例，保证无网络也能跑通闭环。
 */

const ROLE_MARKERS = ['REFLEX', 'ROUTER', 'SYNTHESIZER', 'EXPERT', 'MAIN']

/** 从 system 文本里认出调用方角色，供假模型分派。 */
function detectRole(system = '') {
  for (const marker of ROLE_MARKERS) {
    if (system.includes(`[[${marker}]]`)) return marker
  }
  return 'UNKNOWN'
}

/** 从对话里抽出"用户原话"（假模型据此做粗糙的规则匹配）。 */
function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return String(messages[i].content ?? '')
  }
  return ''
}

/** 离线假模型：确定性的、够用的结构化输出。 */
function fakeChat({ model, system, messages }) {
  const role = detectRole(system)
  const user = lastUserText(messages)

  if (role === 'REFLEX') {
    // 只取"用户说："之后的第一行，避免把指令文字一起回显
    const said = ((user.match(/用户说：([\s\S]*?)(?:\n注意：|$)/) ?? [])[1] ?? user).trim()
    return `收到，你在说「${clip(said, 22)}」这件事，我先应一声，正在想。`
  }

  if (role === 'ROUTER') {
    const guess = classifyByKeyword(user)
    return JSON.stringify({
      domain: guess.domain,
      category: guess.category,
      subcategory: guess.subcategory,
      confidence: guess.confidence,
      needTools: guess.needTools,
      needsClarify: user.trim().length < 6,
      restated: `用户想解决：${clip(user, 40)}`,
    })
  }

  if (role === 'SYNTHESIZER') {
    // 从 prompt 里抽出"用户原话"与专家要点，产出像样的压缩结论（而不是回显 prompt）
    const goal = (user.match(/用户原话：(.+)/) ?? [])[1]?.trim() ?? ''
    const notes = (user.match(/专家要点：\n([\s\S]*?)(?:\n\n|$)/) ?? [])[1]?.trim() ?? ''
    const points = notes
      .split('\n')
      .map((l) => l.replace(/^【[^】]*】/, '').replace(/^\d+[).]\s*/, '').trim())
      .filter((l) => l.length > 4)
      .slice(0, 2)
    const core = clip(goal || user, 34)
    return JSON.stringify({
      oneLiner: `结论：${core}——先按「最小验证 → 看偏差 → 再决定是否放大」推进，不要一上来就大改。`,
      bullets: points.length >= 2 ? points : ['先把现象变成可复现的最小样例', '再逐层排除，一次只改一个变量'],
      nextAction: '把最近一次出问题的原始输入给我，我直接给出定位顺序。',
      confidence: notes ? 0.74 : 0.62,
    })
  }

  if (role === 'EXPERT') {
    const angle = (system.match(/本次视角：(.+)/) ?? [])[1] ?? '直接判断'
    const core = clip(user.replace(/[\s\S]*用户的问题：/, '').split('\n')[0], 30)
    return [
      `要点：针对「${core}」，从${angle}看：`,
      `1) 先固定变量范围，把问题缩小到一次可复现的动作；`,
      `2) 排除法优先——一次只改一个条件，否则无法归因；`,
      `3) 有历史经验就复用，不重复造轮子。`,
    ].join('\n')
  }

  // MAIN：主 agent 的"声音"。Reflex 的话术由主线用自己的口吻说出。
  return `（主 agent 口吻）${clip(user, 60)}`
}

/** 极简关键词分类：假模型与真实模型的兜底都要用到。 */
export function classifyByKeyword(text) {
  const t = text.toLowerCase()
  const rules = [
    ['技术', '编程', ['代码', 'bug', '报错', '函数', '接口', 'api', '部署', '性能', '重构', '测试']],
    ['技术', '数据', ['数据', '统计', '分析', '图表', 'sql', '指标', '报表']],
    ['写作', '小说', ['小说', '章节', '剧情', '人物', '伏笔', '文风', '续写']],
    ['写作', '文案', ['文案', '标题', '宣传', '营销', '朋友圈', '推文']],
    ['生活', '健康', ['睡', '失眠', '健身', '饮食', '运动', '体检', '减肥']],
    ['生活', '财务', ['预算', '记账', '花钱', '理财', '报销', '税']],
    ['事务', '日程', ['日程', '会议', '提醒', '安排', '计划', '排期']],
    ['事务', '沟通', ['回复', '邮件', '消息', '沟通', '解释', '说服']],
  ]
  for (const [domain, category, words] of rules) {
    if (words.some((w) => t.includes(w))) {
      return {
        domain,
        category,
        subcategory: `${category}·通用`,
        confidence: 0.66,
        needTools: domain === '技术' && category === '编程',
      }
    }
  }
  return { domain: '通用', category: '问答', subcategory: '问答·通用', confidence: 0.4, needTools: false }
}

function clip(text, n) {
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 真模型：OpenAI 兼容 chat/completions。 */
async function realChat(cfg, { model, system, messages, temperature = 0.4, maxTokens = 800, json = false, signal, reasoningEffort }) {
  const body = {
    model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    temperature,
    max_tokens: maxTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    // 实测（deepseek 官方接口）：reasoning_effort='none' 可完全关掉思考（reasoning tokens = 0），
    // 快层必须用它；深层用 'high' 换质量。思考 token 数与端到端延迟强相关。
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  }

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`)
  }

  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('LLM 返回内容为空')
  return { text: content, usage: data.usage ?? null }
}

/** 创建客户端。未配置密钥时自动退回假模型，保证原型永远能跑。 */
export function createClient(cfg) {
  const useFake = cfg.fake || !cfg.apiKey
  const mode = useFake ? (cfg.fake ? 'fake(forced)' : 'fake(no-api-key)') : 'real'

  return {
    mode,
    async chat(options) {
      if (useFake) {
        // 假模型按角色给一个贴近真实的延迟，便于观察接管时序
        // （实测真模型：关掉思考的快层 ~0.9s，带思考的深层 2.5–18s——这条差异正是双层架构存在的理由）
        const role = detectRole(options.system)
        const defaultLatency =
          role === 'REFLEX' || role === 'ROUTER' ? 90 : role === 'EXPERT' ? 420 : 260
        await new Promise((r) => setTimeout(r, options.latencyMs ?? defaultLatency))
        return { text: fakeChat({ ...options, model: options.model }), usage: null }
      }
      if (options.model === undefined) throw new Error('chat() 需要 model')
      return realChat(cfg, options)
    },
  }
}

export { fakeChat, detectRole }
