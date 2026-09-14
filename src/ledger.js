/**
 * Ledger 账本：双写记忆。
 *
 * 1) 对话记忆（conversation memory）：本轮「用户原话 → 反射话术 → 深层结论 → 用户后续反应」，
 *    供主 agent 下一轮带上上下文。对应你说的"主 agent 在听的时候就在重新学习"。
 * 2) 品类经验（experience）：按品类路径落库，带父子继承与置信度衰减。
 *    对应你说的"大类有大类经验，子类有子类经验，子类也能继承大类的经验"。
 *
 * 存储：data/ledger.json（可人工审阅、可清空），不依赖 DSH 会话日志。
 */

import fs from 'node:fs'
import path from 'node:path'

const HALF_LIFE_DAYS = 30

/** 置信度随时间衰减：两周没被验证过的经验自然降权。 */
function decay(confidence, updatedAt, now = Date.now()) {
  const days = (now - updatedAt) / 86_400_000
  if (days <= 0) return confidence
  return confidence * 0.5 ** (days / HALF_LIFE_DAYS)
}

export class Ledger {
  /**
   * @param {string} dataDir 落盘目录
   * @param {{maxMemoryTurns?: number}} [options]
   */
  constructor(dataDir, options = {}) {
    this.file = path.join(dataDir, 'ledger.json')
    this.maxMemoryTurns = options.maxMemoryTurns ?? 40
    /** @type {Array<object>} 对话记忆 */
    this.memory = []
    /** @type {Map<string, object>} 经验条目：key = path + '|' + pattern */
    this.experiences = new Map()
    this.load()
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.memory = raw.memory ?? []
      this.experiences = new Map(Object.entries(raw.experiences ?? {}))
    } catch {
      // 首次运行没有文件是正常的
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(
      this.file,
      JSON.stringify({ version: 1, memory: this.memory, experiences: Object.fromEntries(this.experiences) }, null, 2),
    )
  }

  /** 写入一轮对话记忆。 */
  rememberTurn({ sessionId, turnNo, utterance, reflex, classification, synthesis, handoff, feedback = null }) {
    this.memory.push({
      sessionId,
      turnNo,
      at: Date.now(),
      user: utterance,
      reflex: reflex?.text ?? '',
      categoryPath: classification?.path ?? synthesis?.categoryPath ?? '',
      answer: synthesis?.oneLiner ?? '',
      nextAction: synthesis?.nextAction ?? '',
      handedOffVia: handoff?.action ?? '',
      feedback,
    })
    if (this.memory.length > this.maxMemoryTurns * 4) {
      this.memory = this.memory.slice(-this.maxMemoryTurns * 2)
    }
  }

  /** 记录用户对上一轮的反应（用于"是否真的解决了问题"的信号）。 */
  recordFeedback(sessionId, kind) {
    for (let i = this.memory.length - 1; i >= 0; i -= 1) {
      if (this.memory[i].sessionId === sessionId) {
        this.memory[i].feedback = kind
        return this.memory[i]
      }
    }
    return null
  }

  /**
   * 按品类路径取经验，含父子继承。
   * 返回按"离叶子越近越优先、置信度越高越优先"排序的条目，并标注来源层级。
   *
   * @param {string} path 品类路径
   * @param {object} [options]
   * @param {number} [options.limit]
   * @param {string} [options.query] 当前问题原文。给了它就会做**相似度过滤**：
   *   同类目下的经验未必是同一个问题，不过滤会把别的问题的答案当"可复用经验"喂给专家
   *   （实测踩过：向客户解释延期的问题召回并引用了失眠的经验）。
   * @param {(a: string, b: string) => number} [options.similarity] 相似度函数（调用方注入，避免循环依赖）
   * @param {number} [options.minSimilarity]
   */
  recall(path, { limit = 5, now = Date.now(), query, similarity, minSimilarity = 0.18 } = {}) {
    const [domain, category] = String(path ?? '').split('/')
    const levels = [
      { level: 'subcategory', prefix: `${domain}/${category}/` , exact: path },
      { level: 'category', prefix: `${domain}/*/` },
      { level: 'domain', prefix: `${domain}/*/*` },
      { level: 'global', prefix: '*/*/*' },
    ]

    const picked = []
    for (const { level, prefix, exact } of levels) {
      for (const entry of this.experiences.values()) {
        const match = exact ? entry.path === exact : entry.path.startsWith(prefix)
        if (!match) continue
        if (query && typeof similarity === 'function' && similarity(entry.pattern, query) < minSimilarity) continue
        const score = decay(entry.confidence, entry.updatedAt, now) * (level === 'subcategory' ? 1 : level === 'category' ? 0.8 : level === 'domain' ? 0.6 : 0.45)
        picked.push({ ...entry, level, score })
      }
    }
    return picked.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** 沉淀一条经验；已存在同模式条目则加固（hits+1、置信度提升）。 */
  learn({ path, pattern, solution, pitfall = '', confidence = 0.6 }) {
    const key = `${path}|${normalizePattern(pattern)}`
    const existing = this.experiences.get(key)
    if (existing) {
      existing.hits += 1
      existing.confidence = Math.min(0.98, existing.confidence + 0.12)
      existing.updatedAt = Date.now()
      if (solution) existing.solution = solution
      if (pitfall) existing.pitfall = pitfall
      return existing
    }
    const entry = {
      id: `exp-${this.experiences.size + 1}`,
      path,
      pattern: normalizePattern(pattern),
      solution,
      pitfall,
      hits: 1,
      confidence,
      updatedAt: Date.now(),
    }
    this.experiences.set(key, entry)
    return entry
  }

  /** 取最近 N 轮对话记忆，拼成主 agent 的上下文块。 */
  recentContext(sessionId, turns = 3) {
    return this.memory.filter((m) => m.sessionId === sessionId).slice(-turns)
  }

  stats() {
    return {
      memoryTurns: this.memory.length,
      experiences: this.experiences.size,
      avgConfidence: this.experiences.size
        ? Number(
            (
              [...this.experiences.values()].reduce((sum, e) => sum + decay(e.confidence, e.updatedAt), 0) /
              this.experiences.size
            ).toFixed(3),
          )
        : 0,
    }
  }
}

/** 模式归一化：只做保守处理（去空白、统一标点），保留语义以免误合并不同问题。 */
function normalizePattern(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[!！?？。，,；;：:]+/g, '')
    .slice(0, 40)
}
