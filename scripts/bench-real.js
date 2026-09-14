/**
 * 真模型对拍：量化"快层 vs 深层"的真实延迟差，验证双层架构到底值不值。
 *
 * 用法：
 *   node scripts/bench-real.js              # 用 ~/.dsh/.credentials.yaml 里的密钥
 *   node scripts/bench-real.js --fake       # 假模型（只验证脚本本身）
 *
 * 输出：每条消息的 快层延迟 / 深层延迟 / 接管路径，以及 p50 汇总。
 */

import { loadConfig } from '../src/config.js'
import { Concierge } from '../src/orchestrator.js'
import { FakeHost } from '../src/host.js'
import { createClient } from '../src/llm.js'
import { reflex } from '../src/reflex.js'

const args = new Set(process.argv.slice(2))
const cfg = loadConfig({ fake: args.has('--fake') ? true : undefined, dataDir: `${process.cwd()}/data-bench` })

const cases = [
  '我的接口偶发 500，日志里看不出原因，帮我定位一下',
  '这份周报的标题怎么写更抓人？给我三个方向',
  '最近老是失眠，躺下两小时睡不着，我该先做什么',
  '下周要跟客户解释延期，怎么开口比较合适',
]

const client = createClient(cfg)
console.log(`\n模型通道：${client.mode}`)
console.log(`快层模型：${cfg.fastModel}   深层模型：${cfg.deepModel}\n`)

const concierge = new Concierge(cfg, { host: null, client })

const rows = []
for (const text of cases) {
  // 快层单独计时（只测生成确认话术这一步，不含后续）
  const r = await reflex({ text, client, cfg })
  // 深层整体流水线
  const started = Date.now()
  const result = await concierge.tick({ text, sessionId: 'bench', host: null, awaitDeep: true })
  const deepMs = Date.now() - started

  rows.push({ text, reflexMs: r.latencyMs, reflexSource: r.source, deepMs, synthesis: result.synthesis })
  console.log(`· ${text.slice(0, 24)}…`)
  console.log(`    快层 ${String(r.latencyMs).padStart(5)}ms（${r.source}）：${r.text.slice(0, 40)}`)
  console.log(`    深层 ${String(deepMs).padStart(5)}ms  结论：${result.synthesis.oneLiner.slice(0, 60)}`)
  console.log(`    分段：分类 ${result.timings.cortexStages.classifyMs ?? '-'}ms / 召回 ${result.timings.cortexStages.recallMs ?? '-'}ms / 深研 ${result.timings.cortexStages.researchMs ?? '-'}ms / 提炼 ${result.timings.cortexStages.synthMs ?? '-'}ms  （模式 ${result.synthesis.mode}）`)
  for (const call of result.timings.cortexCalls ?? []) {
    console.log(`      · ${call.role.padEnd(12)} ${String(call.model).padEnd(18)} ${String(call.ms).padStart(6)}ms  effort=${call.reasoning}${call.completionTokens != null ? `  tokens=${call.completionTokens}` : ''}${call.error ? `  ERR=${call.error}` : ''}`)
  }
}

const p50 = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]
console.log(`\n快层 p50：${p50(rows.map((r) => r.reflexMs))}ms`)
console.log(`深层 p50：${p50(rows.map((r) => r.deepMs))}ms`)
console.log(`倍数：${(p50(rows.map((r) => r.deepMs)) / Math.max(1, p50(rows.map((r) => r.reflexMs)))).toFixed(1)}x\n`)
