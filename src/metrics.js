/**
 * Telemetry 指标：没有这几个数就无法判断"快层是否留住用户、深层是否真的解决问题"。
 *
 * 必测四项：
 *   reflexLatency  快层延迟（模板档目标 < 300ms）
 *   deepLatency    深层结论延迟（目标 p50 < 5s）
 *   handoffRate    接管成功率（三路接管里成功送达的比例）
 *   correctionRate 用户纠正率（越低越好；由 recordFeedback 喂入）
 */

import fs from 'node:fs'
import path from 'node:path'

export class Metrics {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'metrics.jsonl')
    /** @type {Array<object>} */
    this.samples = []
  }

  record(sample) {
    const row = { at: Date.now(), ...sample }
    this.samples.push(row)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`)
    } catch {
      // 指标落盘失败不该影响主流程
    }
    return row
  }

  summary(window = 50) {
    const rows = this.samples.slice(-window)
    const turns = rows.filter((r) => typeof r.deepLatencyMs !== 'undefined' || r.handoffAction)
    const rated = rows.filter((r) => typeof r.feedback === 'string')
    const pick = (key) => turns.map((r) => r[key]).filter((v) => typeof v === 'number')
    return {
      turns: turns.length,
      reflexLatency: percentiles(pick('reflexLatencyMs')),
      deepLatency: percentiles(pick('deepLatencyMs')),
      reflexTemplateHitRate: rate(turns, (r) => r.reflexSource === 'template'),
      handoffRate: rate(turns.filter((r) => r.deepReady !== false), (r) => r.handoffDelivered === true),
      degradeRate: rate(turns, (r) => r.synthesisMode === 'degraded'),
      experienceHitRate: rate(turns, (r) => (r.experienceHits ?? 0) > 0),
      /** 纠正率只在"用户给过反馈的轮次"里算，否则会被未评价的轮次稀释成假低值。 */
      correctionRate: rate(rated, (r) => r.feedback === 'correction'),
      ratedTurns: rated.length,
    }
  }
}

function percentiles(values) {
  if (!values.length) return { p50: null, p90: null, max: null, n: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1], n: sorted.length }
}

function rate(rows, predicate) {
  if (!rows.length) return null
  return Number((rows.filter(predicate).length / rows.length).toFixed(3))
}
