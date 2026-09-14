/**
 * Orchestrator：把 Reflex / Cortex / Handoff / Ledger / Metrics 串成一次闭环。
 *
 * 一轮的时序（关键：两条流水线同时起跑，谁都不等谁）：
 *
 *   1. 抓到用户原话 → 立刻算 Reflex 话术（模板档 ~0ms / 小模型档 300–800ms）
 *   2. 主 agent 用**自己的口吻**说出这句确认（单一声音，GUI 只有一条回复流）
 *   3. Cortex 同时在跑：分类 → 品类 → 召回经验 → 专家深研 → 提炼成一句结论
 *   4. 结论就绪 → Handoff 按混合策略接管：
 *        主 agent 正在说话 → steer（半路改口）
 *        主 agent 正在调工具 → inject（排队，不切碎工具调用）
 *        主 agent 已空闲    → followup（开新轮补发）
 *   5. Ledger 双写：对话记忆 + 品类经验；Metrics 记一笔四项指标
 */

import { createClient, classifyByKeyword } from './llm.js'
import { reflex } from './reflex.js'
import { analyze } from './cortex.js'
import { handoff } from './handoff.js'
import { Ledger } from './ledger.js'
import { Metrics } from './metrics.js'
import { Taxonomy } from './taxonomy.js'

export class Concierge {
  /**
   * @param {object} cfg loadConfig() 的结果
   * @param {object} [deps]
   * @param {import('./host.js').HostAdapter} [deps.host]
   */
  constructor(cfg, deps = {}) {
    this.cfg = cfg
    this.client = deps.client ?? createClient(cfg)
    this.host = deps.host ?? null
    this.taxonomy = deps.taxonomy ?? new Taxonomy()
    this.ledger = deps.ledger ?? new Ledger(cfg.dataDir)
    this.metrics = deps.metrics ?? new Metrics(cfg.dataDir)
    this.turnNo = 0
    /** 已交付的结论指纹，避免同轮重复说 */
    this.delivered = new Set()
  }

  /**
   * 跑一轮完整闭环。
   * @param {object} params
   * @param {string} params.text 用户原话
   * @param {string} [params.sessionId]
   * @param {object} [params.mainScript] 假宿主的主 agent 行为脚本
   * @param {boolean} [params.awaitDeep] 是否等深层结论交付完（子 agent 模式下为 false）
   * @param {(event: object) => void} [params.onEvent] 事件流（demo 渲染用）
   */
  async tick({ text, sessionId = 'demo-session', mainScript, awaitDeep = true, onEvent = () => {}, handoffMode, deferWhileThinking }) {
    this.turnNo += 1
    const started = Date.now()
    // 本轮生效的接管策略：允许按轮覆盖，便于对比不同策略的观感
    const effectiveMode = handoffMode ?? this.cfg.handoffMode
    const effectiveDefer = deferWhileThinking ?? this.cfg.deferWhileThinking
    /** @type {import('./types.js').Utterance} */
    const utterance = {
      id: `utt-${this.turnNo}-${started.toString(36)}`,
      sessionId,
      text,
      at: started,
      turnNo: this.turnNo,
    }

    onEvent({ kind: 'user', turnNo: this.turnNo, text })

    // ── 阶段 1：Reflex 快层（先跑，主 agent 要立刻有话说）────────────────
    const reflexStarted = Date.now()
    // 先做一次廉价关键词分类，让 Reflex 知道"要不要反问"；失败不影响主流程
    let quickClassification = null
    try {
      quickClassification = classifyByKeyword(text)
    } catch {
      quickClassification = null
    }
    const reflexResult = await reflex({
      text,
      client: this.client,
      cfg: this.cfg,
      // 短输入 + 低分类把握 = 信息不足，反射层顺带问一个最关键的问题
      needsClarify: (quickClassification?.confidence ?? 1) < 0.45 && text.trim().length < 12,
    })
    onEvent({ kind: 'reflex', turnNo: this.turnNo, ...reflexResult })

    // ── 阶段 2：Cortex 深层流水线（与主 agent 说话并行）─────────────────
    const cortexStarted = Date.now()
    /** @type {object|null} */
    let pendingSynthesis = null
    let synthesisMode = 'pending'
    let deepLatencyMs = null
    let experienceHits = 0
    let experts = 0
    let classification = null
    let cortexTimings = {}
    /** 每次模型调用明细（角色/模型/耗时/token），用于定位延迟来源 */
    let cortexCalls = []

    const cortexPromise = analyze({
      utterance,
      client: this.client,
      cfg: this.cfg,
      taxonomy: this.taxonomy,
      ledger: this.ledger,
      onStage: (stage, info) => {
        if (stage === 'classified') classification = info
        if (stage === 'recall') experienceHits = info.count ?? 0
        if (stage === 'researched') experts = info.experts ?? 0
        if (stage === 'synthesis') synthesisMode = info.mode
        onEvent({ kind: `cortex:${stage}`, turnNo: this.turnNo, stage, info })
      },
    })
      .then((result) => {
        classification = { ...(classification ?? {}), ...result.classification }
        pendingSynthesis = result.synthesis
        synthesisMode = result.synthesis.mode
        experts = result.experts
        cortexTimings = result.timings
        cortexCalls = result.calls ?? []
        deepLatencyMs = Date.now() - cortexStarted
        onEvent({ kind: 'cortex:done', turnNo: this.turnNo, latencyMs: deepLatencyMs, synthesis: result.synthesis })
        return result
      })
      .catch((error) => {
        synthesisMode = 'degraded'
        onEvent({ kind: 'cortex:error', turnNo: this.turnNo, error: String(error?.message ?? error) })
        return null
      })

    // ── 阶段 3：主 agent 说话（用 Reflex 的话术，保持一个声音）──────────────
    let handoffResult = { action: 'none', delivered: false, reason: '深层结论未就绪' }
    let reflectedOnSpokenText = ''

    if (this.host) {
      const tokens = mainScript?.tokens ?? [reflexResult.text]
      let mainRunSettled = false
      const mainRun = this.host.runMainAgent({ ...mainScript, tokens })

      // 边跑边等深层结论：就绪即接管，不等主 agent 说完
      // 边跑边等深层结论：就绪即接管，不等主 agent 说完。
      // 硬性 wall-clock 上限：即使皮层与主 agent 都异常卡住，这个循环也不能无限空转。
      const deliveryDeadline = Date.now() + cfgDeliveryCap(this.cfg)
      const delivery = (async () => {
        while (true) {
          if (pendingSynthesis) {
            handoffResult = await handoff(this.host, pendingSynthesis, {
              mode: effectiveMode,
              delivered: this.delivered,
              options: { deferWhileThinking: effectiveDefer },
            })
            if (handoffResult.delivered) {
              onEvent({ kind: 'handoff', turnNo: this.turnNo, ...handoffResult })
              return handoffResult
            }
            // 被推迟（主 agent 还没开口）：继续等下一个边界再试
          }
          if (Date.now() > deliveryDeadline) {
            handoffResult = {
              action: 'none',
              delivered: false,
              reason: `接管窗口超时（${Math.round(cfgDeliveryCap(this.cfg) / 1000)}s）`,
            }
            onEvent({ kind: 'handoff', turnNo: this.turnNo, ...handoffResult })
            return handoffResult
          }
          if (mainRunSettled && synthesisMode !== 'pending') {
            // 主 agent 这一轮已经结束：兜底检查是否还有未交付的结论
            if (pendingSynthesis && !this.delivered.has(pendingSynthesis.dedupeKey ?? pendingSynthesis.oneLiner)) {
              handoffResult = await handoff(this.host, pendingSynthesis, {
                mode: effectiveMode === 'hybrid' ? 'safe-followup' : effectiveMode,
                delivered: this.delivered,
              })
              onEvent({ kind: 'handoff', turnNo: this.turnNo, ...handoffResult, late: true })
              return handoffResult
            }
            handoffResult = handoffResult.delivered
              ? handoffResult
              : { action: 'none', delivered: false, reason: `深层未产出可用结论（${synthesisMode}）` }
            onEvent({ kind: 'handoff', turnNo: this.turnNo, ...handoffResult })
            return handoffResult
          }
          await sleep(40)
        }
      })()

      const mainResult = await mainRun.finally(() => {
        mainRunSettled = true
      })
      reflectedOnSpokenText = mainResult.text

      if (awaitDeep) await delivery
      else delivery.catch(() => {})
    } else {
      // 没有宿主：只出产物，不模拟对话（供集成方自取）
      await (awaitDeep ? cortexPromise : Promise.resolve())
    }

    // ── 阶段 4：账本双写 + 指标 ────────────────────────────────────────
    const finalSynthesis = pendingSynthesis ?? {
      oneLiner: '（深层结论仍在生成，稍后补发）',
      bullets: [],
      nextAction: '',
      confidence: 0,
      mode: 'degraded',
      categoryPath: classification?.path ?? '',
      dedupeKey: `late:${utterance.id}`,
    }

    // ── 先长叶，再按新叶路径沉淀经验 ────────────────────────────────────
    // 顺序很重要（实测踩过）：分类器给出的叶子（如"技术/编程/接口故障排查"）树里没有时，
    // 本次只能借用已有叶子（如"技术/编程/调试排错"）。若先把经验记在借用路径上，
    // 而新叶登记的是另一个路径，下一次问同类问题时按新叶路径召回就会是 0 条——
    // 经验复用链直接断掉。所以必须"先登记新叶，再把经验记到新叶上"。
    let newLeaf = null
    let effectivePath = finalSynthesis.categoryPath || classification?.path || ''
    if (classification?.isNewLeaf && classification?.proposedParts) {
      const { domain: d, category: c, subcategory: sub } = classification.proposedParts
      if (d && c && sub && !String(effectivePath).includes('通用/问答')) {
        effectivePath = this.taxonomy.add(d, c, sub, true)
        newLeaf = effectivePath
      }
    }

    // 品类经验沉淀：只在真的产出了结论、不是澄清分支、且路径**不是全局兜底**时才记。
    // 只有 `通用/问答/…` 是"什么都往里塞"的兜底路径，记在那里必然污染召回。
    // 注意：不要再额外排除 `xxx·通用`（大类级兜底叶）——那是真实的大类经验，有价值；
    // 防张冠李戴的职责交给召回时的**表面相似度闸门**，而不是靠不记（实测踩过这个坑：
    // 曾把大类级兜底叶一并排除，导致假模型路径下经验账本永远是 0 条、复用链失效）。
    const isSpecificPath = Boolean(effectivePath) && !effectivePath.includes('通用/问答')
    if (pendingSynthesis && synthesisMode !== 'clarify' && isSpecificPath && pendingSynthesis.confidence >= 0.65) {
      this.ledger.learn({
        path: effectivePath,
        pattern: text,
        solution: finalSynthesis.oneLiner,
        pitfall: finalSynthesis.bullets?.[0] ?? '',
        confidence: finalSynthesis.confidence,
      })
    }

    this.ledger.rememberTurn({
      sessionId,
      turnNo: this.turnNo,
      utterance,
      reflex: reflexResult,
      classification: { ...classification, path: finalSynthesis.categoryPath || classification?.path },
      synthesis: finalSynthesis,
      handoff: handoffResult,
    })
    this.ledger.save()

    const metricsRow = this.metrics.record({
      turnNo: this.turnNo,
      sessionId,
      text: text.slice(0, 80),
      // 口径说明：reflexLatencyMs = 从收到用户输入到快层话说出口（真模型档会让主 agent 稍晚开口）；
      // deepLatencyMs = 从收到用户输入到深层结论就绪。totalMs 含演示脚本的刻意停留，不代表真实响应时长。
      reflexLatencyMs: reflexResult.latencyMs,
      reflexSource: reflexResult.source,
      deepLatencyMs,
      synthesisMode,
      handoffAction: handoffResult.action,
      handoffDelivered: handoffResult.delivered,
      experienceHits,
      experts,
      categoryPath: finalSynthesis.categoryPath || classification?.path || '',
      totalMs: Date.now() - started,
      deepReady: Boolean(pendingSynthesis),
    })

    return {
      utterance,
      reflex: reflexResult,
      classification: { ...classification, path: finalSynthesis.categoryPath || classification?.path },
      synthesis: finalSynthesis,
      handoff: handoffResult,
      timings: {
        reflexMs: reflexResult.latencyMs,
        reflexWallMs: Date.now() - reflexStarted,
        cortexMs: deepLatencyMs,
        cortexStages: cortexTimings,
        cortexCalls,
        mainTurnMs: reflectedOnSpokenText ? Date.now() - started : null,
        totalMs: Date.now() - started,
      },
      ledger: { experienceHits, newLeaf, learned: Boolean(pendingSynthesis) },
      metrics: metricsRow,
      spoken: reflectedOnSpokenText,
    }
  }

  /** 用户对上一轮的反应（用于纠正率）。 */
  feedback(sessionId, kind) {
    this.ledger.recordFeedback(sessionId, kind)
    this.ledger.save()
    this.metrics.record({ feedback: kind, sessionId })
  }

  summary() {
    return { metrics: this.metrics.summary(), ledger: this.ledger.stats(), taxonomyLeaves: this.taxonomy.size }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 接管窗口上限：比皮层超时留一段余量，保证循环一定有终点。 */
function cfgDeliveryCap(cfg) {
  return Math.max(5000, Math.round((cfg.cortexDeadlineMs ?? 25000) * 1.5))
}
