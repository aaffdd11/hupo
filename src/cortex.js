/**
 * Cortex 皮层：深度思考流水线。
 *
 *   Router（分类：领域 / 大类 / 子类）
 *     → Taxonomy 归一化（不在树里就提议长新叶）
 *     → Ledger 召回经验（子类 → 大类 → 领域 → 全局，父子继承）
 *     → Specialist 深研（按需取证；可并行多专家）
 *     → Synthesizer 提炼（一句结论 + ≤3 要点 + 一个下一步动作）
 *
 * 两条纪律：
 *   1) **有经验就少调模型**：同一子类二次提问走"经验直出"，把 3–8 倍成本压回接近 1 次。
 *   2) **超时必降级**：整个皮层受 deadline 约束，到点交付当前最优结论。
 */

import { classifyByKeyword } from './llm.js'

const ROUTER_SYSTEM = [
  '[[ROUTER]] 你是意图分类器。只输出 JSON，不要任何解释文字。',
  '字段：domain（领域，如 技术/写作/生活/事务/通用）、category（大类）、subcategory（子类，尽量具体）、',
  'confidence（0..1，你对分类的把握）、needTools（布尔，是否需要查资料/跑代码/取证）、',
  'needsClarify（布尔）、restated（一句话复述用户真正想解决的问题）。',
  'needsClarify 只在"用户没说清要做什么、缺关键信息就无法动手"时为 true；',
  '只要诉求清楚（哪怕执行细节不全），一律为 false，不要动不动就让用户补充信息。',
].join('\n')

const EXPERT_SYSTEM = [
  '[[EXPERT]] 你是某个品类的专家，负责给出可直接执行的判断，不寒暄、不铺垫。',
  '要求：只输出 3 条以内的要点，每条一句、不超过 40 字，必须具体可验证；有前提假设就写出来。',
].join('\n')

const SYNTH_SYSTEM = [
  '[[SYNTHESIZER]] 你是提炼器。把专家要点压缩成人能一眼看懂、能直接照做的话。',
  '只输出 JSON：{"oneLiner": "一句话结论（≤50字，不要以「结论：」开头）",',
  '"bullets": ["要点，≤3条，每条≤30字"], "nextAction": "下一步动作（没有就空字符串）", "confidence": 0..1}',
  '硬要求：必须是一句话就能说明白的结论，不许写"这取决于…""建议先做最小验证"这类空话。',
].join('\n')

/** 安全解析模型返回的 JSON（容忍 ```json 包裹与前后噪声）。 */
export function parseJson(text) {
  if (typeof text !== 'string') return null
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

/** 包装客户端调用，记录每次模型调用的耗时与 token 用量（用于定位延迟）。 */
function instrument(client, calls) {
  if (!client) return client
  return {
    mode: client.mode,
    async chat(options) {
      const started = Date.now()
      try {
        const result = await client.chat(options)
        calls.push({
          role: (options.system?.match(/\[\[(\w+)\]\]/) ?? [])[1] ?? 'UNKNOWN',
          model: options.model,
          ms: Date.now() - started,
          reasoning: options.reasoningEffort ?? '(default)',
          completionTokens: result.usage?.completion_tokens ?? null,
        })
        return result
      } catch (error) {
        calls.push({
          role: (options.system?.match(/\[\[(\w+)\]\]/) ?? [])[1] ?? 'UNKNOWN',
          model: options.model,
          ms: Date.now() - started,
          error: String(error?.message ?? error).slice(0, 80),
        })
        throw error
      }
    },
  }
}

/** Router：分类。经验足够时跳过模型调用（这就是"品类经验省钱"的关键）。 */
async function classify({ text, client, cfg, ledger, taxonomy, signal }) {
  const keyword = classifyByKeyword(text)

  // 快速路径：同子类已有高置信经验 → 不再调分类模型
  const existing = ledger.recall(keyword.subcategory ? `${keyword.domain}/${keyword.category}/${keyword.subcategory}` : '', { limit: 3 })
  const strongExperience = existing.find((e) => e.level === 'subcategory' && e.score >= 0.75)
  if (strongExperience && keyword.confidence >= 0.6) {
    const classification = {
      ...keyword,
      confidence: Math.min(0.95, keyword.confidence + 0.2),
      needsClarify: false,
      restated: `（经验命中，跳过分类模型）${text.slice(0, 40)}`,
      fastPath: true,
    }
    return classification
  }

  if (!client) return { ...keyword, fastPath: false }

  try {
    const { text: out } = await client.chat({
      model: cfg.fastModel,
      system: ROUTER_SYSTEM,
      messages: [{ role: 'user', content: `用户说：${text}` }],
      temperature: 0,
      maxTokens: 200,
      json: true,
      signal,
      // 分类也不需要思考：关掉以压低延迟
      reasoningEffort: 'none',
    })
    const parsed = parseJson(out)
    if (!parsed) throw new Error('分类输出无法解析')
    return {
      domain: parsed.domain || keyword.domain,
      category: parsed.category || keyword.category,
      subcategory: parsed.subcategory || keyword.subcategory,
      confidence: clamp01(parsed.confidence ?? 0.6),
      needTools: Boolean(parsed.needTools),
      needsClarify: Boolean(parsed.needsClarify),
      restated: parsed.restated || text.slice(0, 60),
      fastPath: false,
    }
  } catch (error) {
    return { ...keyword, fastPath: false, error: String(error?.message ?? error) }
  }
}

/** Specialist：深研。needTools 时才真的开专家（原型里是并行模型调用，插件化后可换成子 agent）。 */
async function research({ text, classification, experiences, client, cfg, signal }) {
  const inherited = experiences.map((e) => `- [${e.level}] ${e.pattern} → ${e.solution}`).join('\n')

  if (!classification.needTools && !client) {
    return { notes: '', usedExperience: inherited, experts: 0 }
  }

  const expertPrompt = [
    `用户的问题：${text}`,
    `已判定品类：${classification.domain}/${classification.category}/${classification.subcategory}`,
    inherited ? `可复用的既有经验（继承自父类/子类，优先复用，不要重复造轮子）：\n${inherited}` : '没有可复用的既有经验。',
    '请给出你的专业判断要点。',
  ].join('\n\n')

  // 需要取证时开两个视角并行，不需要时单视角；这样成本和延迟都可控
  const anglePool = classification.needTools ? ['可行性视角', '风险与边界视角'] : ['直接判断视角']
  const angles = anglePool.slice(0, Math.max(1, cfg.expertAngles ?? 2))
  const started = Date.now()
  const results = await Promise.all(
    angles.map(async (angle) => {
      try {
        const { text: out } = await client.chat({
          model: cfg.deepModel,
          system: `${EXPERT_SYSTEM}\n本次视角：${angle}`,
          messages: [{ role: 'user', content: expertPrompt }],
          temperature: 0.3,
          maxTokens: 300,
          signal,
          reasoningEffort: cfg.expertReasoningEffort ?? 'medium',
        })
        return `【${angle}】${out.trim()}`
      } catch (error) {
        return `【${angle}】专家调用失败：${String(error?.message ?? error).slice(0, 120)}`
      }
    }),
  )

  return { notes: results.join('\n'), usedExperience: inherited, experts: angles.length, latencyMs: Date.now() - started }
}

/** Synthesizer：提炼成"一句话就能说明白"的结论。 */
async function synthesize({ text, classification, experiences, researchResult, client, cfg, signal, degraded }) {
  const inheritedHint = experiences.length
    ? `可复用经验：${experiences.map((e) => e.solution).filter(Boolean).join('；').slice(0, 200)}`
    : ''

  if (client) {
    try {
      const { text: out } = await client.chat({
        model: cfg.synthModel ?? cfg.deepModel,
        system: SYNTH_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              `用户原话：${text}`,
              `品类：${classification.domain}/${classification.category}/${classification.subcategory}`,
              `用户真正想解决：${classification.restated}`,
              inheritedHint,
              `专家要点：\n${researchResult.notes || '（无）'}`,
              degraded ? '注意：深层研究未完全完成，请基于现有信息给出当前最优结论，并说明这是初步结论。' : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
        temperature: 0.3,
        maxTokens: 400,
        json: true,
        signal,
        reasoningEffort: cfg.synthReasoningEffort ?? 'medium',
      })
      const parsed = parseJson(out)
      if (parsed?.oneLiner) {
        return {
          oneLiner: normalizeOneLiner(parsed.oneLiner),
          bullets: (parsed.bullets ?? []).slice(0, 3).map((b) => String(b).slice(0, 60)),
          nextAction: String(parsed.nextAction ?? ''),
          confidence: clamp01(parsed.confidence ?? 0.7),
          mode: degraded ? 'degraded' : 'full',
        }
      }
      throw new Error('提炼输出无法解析')
    } catch (error) {
      // 落到下面的兜底
      return {
        oneLiner: `（初步结论）${text.slice(0, 40)}：先把问题缩到一次可复现的最小场景，再逐层排除。`,
        bullets: ['把现象变成可复现的最小样例', '一次只改一个变量，否则无法归因'],
        nextAction: '把最近一次出问题的原始输入给我，我直接给定位顺序。',
        confidence: 0.5,
        mode: 'degraded',
        error: String(error?.message ?? error),
      }
    }
  }

  return {
    oneLiner: `（初步结论）${text.slice(0, 40)}：先做一次最小验证，再决定是否放大投入。`,
    bullets: ['把现象变成可复现的最小样例', '一次只改一个变量，否则无法归因'],
    nextAction: '给我一个原始样例，我直接给出可执行方案。',
    confidence: 0.55,
    mode: degraded ? 'degraded' : 'full',
  }
}

/** 去掉模型爱加的前缀，保证结论干净、不出现"结论：结论："。 */
function normalizeOneLiner(text) {
  return String(text)
    .trim()
    .replace(/^(一句话结论|结论|答案|总结)\s*[:：]\s*/, '')
    .trim()
}

/**
 * 表面相似度闸门：判断"新问题"和"已沉淀的经验"是不是同一类问题。
 *
 * 用两个信号的加权混合，而不是单一算法：
 *   coverage = |交集| / min(|A|,|B|)  —— 覆盖率，短句是大句子集时也能识别为同类
 *   jaccard  = |交集| / |并集|        —— 精确率，防止长短句因为"包含"就误判
 *   score    = 0.6 * coverage + 0.4 * jaccard
 *
 * 标点与常见虚词先剔除，只留实义片段（中文二元组 + 数字/英文词）。
 * 教训：单用 Jaccard 会把"我的接口偶发 500，日志…"和"接口又偶发 500 了"判为不相似（0.17），
 * 导致明明同一类问题却拒绝复用经验。混合后同类可达 0.5+，不相干问题仍低于 0.3。
 */
const STOP_GRAMS = new Set(['一下', '帮我', '一个', '怎么', '什么', '这个', '那个', '可以', '现在', '我的', '你的', '就是', '还是'])

export function similarity(a, b) {
  const grams = (s) => {
    const t = String(s ?? '')
      .replace(/[\s，。、！？：；,.!?:;"'（）()【】\[\]]/g, '')
      .replace(/[0-9]+|[a-zA-Z]+/g, '')
    const set = new Set()
    for (let i = 0; i < t.length - 1; i += 1) {
      const g = t.slice(i, i + 2)
      if (!STOP_GRAMS.has(g)) set.add(g)
    }
    // 数字/英文关键词单独计入，避免"500""sql"这类实体被丢掉
    const entities = new Set(String(s ?? '').toLowerCase().match(/[0-9]+|[a-z]{3,}/g) ?? [])
    for (const e of entities) set.add(e)
    if (!set.size && t.length === 1) set.add(t)
    return set
  }
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter += 1
  const coverage = inter / Math.min(A.size, B.size)
  const jaccard = inter / (A.size + B.size - inter)
  return 0.6 * coverage + 0.4 * jaccard
}

/**
 * 皮层主入口。
 * @param {object} params
 * @param {import('./types.js').Utterance} params.utterance
 * @param {object} params.client
 * @param {object} params.cfg
 * @param {import('./taxonomy.js').Taxonomy} params.taxonomy
 * @param {import('./ledger.js').Ledger} params.ledger
 * @param {(stage: string, info?: object) => void} [params.onStage]
 * @returns {Promise<{classification: import('./types.js').Classification & {path: string, isNewLeaf?: boolean}, synthesis: import('./types.js').Synthesis, timings: object, experts: number}>}
 */
export async function analyze({ utterance, client, cfg, taxonomy, ledger, onStage = () => {} }) {
  const timings = {}
  /** 每次模型调用的明细，用于定位延迟来源 */
  const calls = []
  const callLog = instrument(client, calls)
  const deadline = utterance.at + cfg.cortexDeadlineMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, deadline - Date.now()))
  const { signal } = controller

  try {
    let t = Date.now()
    const classification = await classify({ text: utterance.text, client: callLog, cfg, ledger, taxonomy, signal })
    timings.classifyMs = Date.now() - t
    onStage('classified', classification)

    const normalized = taxonomy.normalize(classification)
    const path = normalized.path
    onStage('taxonomy', normalized)
    // 把归一化结果并回分类对象，让编排层知道"是否借用/是否该长新叶/建议的新叶是什么"
    Object.assign(classification, {
      path,
      isNewLeaf: normalized.isNew,
      borrowed: Boolean(normalized.borrowed),
      how: normalized.how,
      proposed: normalized.proposed,
      proposedParts: normalized.proposedParts,
    })

    t = Date.now()
    const experiences = ledger.recall(path, { limit: 5, query: utterance.text, similarity })
    timings.recallMs = Date.now() - t
    onStage('recall', { count: experiences.length, top: experiences[0] ?? null })

    // 请求澄清分支：信息不足时不硬猜，交给主 agent 反问
    if (classification.needsClarify) {
      const synthesis = {
        oneLiner: `我需要先确认一件事：你说的「${utterance.text.slice(0, 30)}」具体是想达成什么结果？`,
        bullets: [],
        nextAction: '给我一个例子或约束条件，我立刻给方案。',
        confidence: 0.4,
        mode: 'clarify',
      }
      return {
        classification: { ...classification, path },
        synthesis: { ...synthesis, lead: '', categoryPath: path, dedupeKey: `clarify:${utterance.id}` },
        timings,
        calls,
        experts: 0,
      }
    }

    // 经验直出：只在高置信 + 真子类命中 + 与当前问题的**表面相似度**达标时启用。
    // 教训（真模型实测暴露）：曾出现"跟客户解释延期"复用"失眠"经验的错案——
    // 因为分类落到通用兜底，而经验命中的正是同一个兜底路径。经验复用必须带相似度闸门。
    const strong = experiences.find(
      (e) =>
        e.level === 'subcategory' &&
        e.score >= 0.75 &&
        !e.path.includes('通用/问答') &&
        similarity(e.pattern, utterance.text) >= 0.18,
    )
    if (strong && !classification.needTools) {
      t = Date.now()
      const synthesis = {
        oneLiner: `按上次验证过的做法：${strong.solution}`,
        bullets: experiences.slice(1, 3).map((e) => e.solution),
        nextAction: strong.pitfall ? `注意别踩：${strong.pitfall}` : '',
        confidence: Math.min(0.95, strong.score),
        mode: 'full',
        fromExperience: true,
      }
      timings.researchMs = 0
      timings.synthMs = Date.now() - t
      onStage('synthesis', synthesis)
      return {
        classification: { ...classification, path },
        synthesis: { ...synthesis, categoryPath: path, dedupeKey: `exp:${strong.id}` },
        timings,
        calls,
        experts: 0,
      }
    }

    t = Date.now()
    const researchResult = await research({ text: utterance.text, classification, experiences, client: callLog, cfg, signal })
    timings.researchMs = Date.now() - t
    onStage('researched', { experts: researchResult.experts })

    t = Date.now()
    const synthesis = await synthesize({
      text: utterance.text,
      classification,
      experiences,
      researchResult,
      client: callLog,
      cfg,
      signal,
      degraded: signal.aborted,
    })
    timings.synthMs = Date.now() - t
    onStage('synthesis', synthesis)

    return {
      classification: { ...classification, path },
      synthesis: { ...synthesis, categoryPath: path, dedupeKey: hash(`${path}|${synthesis.oneLiner}`) },
      timings,
      calls,
      experts: researchResult.experts,
    }
  } catch (error) {
    // 超时/异常一律降级交付，绝不让一轮对话挂死
    const timedOut = String(error?.name ?? '') === 'AbortError' || signal.aborted
    const fallback = {
      oneLiner: timedOut
        ? `这条我还没想透（超过 ${Math.round(cfg.cortexDeadlineMs / 1000)} 秒），先给当前最好的判断：${utterance.text.slice(0, 30)}——把它缩到一个最小可复现场景，我来逐层排除。`
        : `（初步结论）${utterance.text.slice(0, 40)}：先做一次最小验证，再决定是否放大。`,
      bullets: [],
      nextAction: '如果这条不对，告诉我哪里偏了，我重算。',
      confidence: 0.35,
      mode: 'degraded',
    }
    return {
      classification: { path: '通用/问答/问答·通用', domain: '通用', category: '问答', subcategory: '问答·通用', confidence: 0.3, needTools: false, needsClarify: false, restated: utterance.text },
      synthesis: { ...fallback, categoryPath: '通用/问答/问答·通用', dedupeKey: `degraded:${utterance.id}` },
      timings,
      calls,
      experts: 0,
      error: String(error?.message ?? error),
    }
  } finally {
    clearTimeout(timer)
  }
}

function clamp01(value) {
  const n = Number(value)
  if (Number.isNaN(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

function hash(text) {
  let h = 0
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}
