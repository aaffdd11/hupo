/**
 * 演示脚本：用假宿主跑通闭环，观察三种接管方式与"经验复用变快"。
 *
 * 用法：
 *   node scripts/demo.js            # 自动选模型（有密钥走真模型，否则假模型）
 *   node scripts/demo.js --fake     # 强制假模型，离线可跑
 *   node scripts/demo.js --real     # 强制真模型（需要 ~/.dsh/.credentials.yaml）
 */

import { loadConfig } from '../src/config.js'
import { Concierge } from '../src/orchestrator.js'
import { FakeHost } from '../src/host.js'

const args = new Set(process.argv.slice(2))
const cfg = loadConfig({
  fake: args.has('--fake') ? true : undefined,
  dataDir: args.has('--clean') ? `${process.cwd()}/data-demo` : `${process.cwd()}/data-demo`,
})

// --clean 先清空上一次的账本，便于观察"第一次 vs 第二次"的差异
if (args.has('--clean')) {
  const fs = await import('node:fs')
  fs.rmSync(cfg.dataDir, { recursive: true, force: true })
}

const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`
const dim = (s) => c(90, s)
const bold = (s) => c(1, s)
const cyan = (s) => c(36, s)
const green = (s) => c(32, s)
const yellow = (s) => c(33, s)
const magenta = (s) => c(35, s)

const host = new FakeHost({
  sessionId: 'demo-session',
  log: (e) => {
    // 主 agent 的说话过程只打一行，避免刷屏
    if (e.kind === 'main-token' && e.token !== undefined) {
      process.stdout.write(dim('·'))
    }
  },
})

const concierge = new Concierge(cfg, { host })

console.log(bold('\n═══ 个人 AI 助手 · 双层对话闭环演示 ═══'))
console.log(dim(`模型通道：${concierge.client.mode}  接管模式：${cfg.handoffMode}  皮层超时：${cfg.cortexDeadlineMs}ms`))
console.log(dim(`快层模型：${cfg.fastModel} ｜ 专家模型：${cfg.deepModel}(${cfg.expertReasoningEffort}) ｜ 提炼模型：${cfg.synthModel}(${cfg.synthReasoningEffort})`))
console.log(dim(`品类树叶子：${concierge.taxonomy.size} 个   数据目录：${cfg.dataDir}\n`))

/** 场景定义：每个场景说明这一轮想演示什么。 */
const scenarios = [
  {
    label: '场景 A · 主 agent 正在说话 → steer 半路改口（默认混合策略）',
    text: '我的接口偶发 500，日志里看不出原因，帮我定位一下',
    mainScript: { tokens: ['收到，你说的接口报错我记下了，', '我先应一声，', '正在想。'], tokenMs: 900, holdMs: 600 },
  },
  {
    label: '场景 B · 强制排队注入（always-inject）→ 不切碎主 agent 的话',
    text: '同样的问题又出现了，接口还是偶发 500',
    handoffMode: 'always-inject',
    mainScript: { tokens: ['收到，我先查一下日志。'], tokenMs: 1200, toolMs: 2500, holdMs: 300 },
  },
  {
    label: '场景 C · 主 agent 已空闲 → followup 开新轮补发（最安全的兜底）',
    text: '帮我把这周的日程排一下，周三下午有个会',
    mainScript: { tokens: ['收到。'], tokenMs: 100, holdMs: 300 },
  },
  {
    label: '场景 D · 开启「不抢话」节奏策略 → 主 agent 还在想时不抢话，等它开口再交付',
    text: '帮我弄一下',
    deferWhileThinking: true,
    mainScript: { tokens: ['收到，你说的这件事我要先确认一下——'], tokenMs: 1500, holdMs: 300 },
  },
  {
    label: '场景 E · 同子类再次提问 → 带着上次经验重走深研',
    text: '接口又偶发 500 了，还是老毛病，给我个定位步骤',
    mainScript: { tokens: ['收到，这次我带着上次的经验看。'], tokenMs: 900, holdMs: 300 },
  },
]

for (const scenario of scenarios) {
  console.log(bold(`\n─── ${scenario.label} ───`))
  console.log(`${cyan('用户')}：${scenario.text}`)

  const result = await concierge.tick({
    text: scenario.text,
    sessionId: 'demo-session',
    mainScript: scenario.mainScript,
    handoffMode: scenario.handoffMode,
    deferWhileThinking: scenario.deferWhileThinking,
    onEvent: (event) => {
      if (event.kind === 'cortex:classified') {
        console.log(dim(`  [皮层] 分类：${event.info.domain}/${event.info.category}/${event.info.subcategory}（把握 ${Math.round((event.info.confidence ?? 0) * 100)}%${event.info.fastPath ? '，命中经验捷径' : ''}）`))
      }
      if (event.kind === 'cortex:recall' && event.info.count > 0) {
        console.log(dim(`  [皮层] 召回经验 ${event.info.count} 条，最高来自 ${event.info.top.level} 层：${String(event.info.top.solution).slice(0, 40)}…`))
      }
      if (event.kind === 'cortex:researched') {
        console.log(dim(`  [皮层] 展开专家 ${event.info.experts} 位并行深研`))
      }
    },
  })

  const leadByAction = { steer: '半路改口', inject: '排队注入', followup: '新轮补发' }
  console.log(`${green('主 agent')}（${leadByAction[result.handoff.action] ?? '未接管'}）：`)
  console.log(`  ${dim('① 快层确认')}（${result.timings.reflexMs}ms）：${yellow(result.reflex.text)}`)
  if (result.handoff.delivered) {
    console.log(`  ${dim(`② ${result.handoff.action}`)}（${result.timings.cortexMs}ms 时接管）：${yellow(result.handoff.text?.replace(/\n/g, '\n     ') ?? '')}`)
  } else {
    console.log(`  ${dim('② 未交付')}：${result.handoff.reason}`)
  }
  console.log(`  ${magenta('接管路径')}：${result.handoff.action} ${dim(`— ${result.handoff.reason}`)}`)
  console.log(`  ${dim('一句话结论')}：${result.synthesis.oneLiner}`)
  if (result.synthesis.bullets?.length) console.log(`  ${dim('要点')}：${result.synthesis.bullets.join(' / ')}`)
  console.log(
    dim(
      `  口径：快层 ${result.timings.reflexMs}ms ｜ 深层结论就绪 ${result.timings.cortexMs ?? '-'}ms` +
        ` ｜ 主 agent 整轮 ${result.timings.mainTurnMs ?? '-'}ms（含演示脚本停留，非架构开销）` +
        ` ｜ 经验命中 ${result.ledger.experienceHits} ｜ 专家 ${result.metrics.experts}`,
    ),
  )
  if (result.ledger.newLeaf) console.log(dim(`  [品类树] 新增长叶子：${result.ledger.newLeaf}`))
}

// 指标汇总
const summary = concierge.summary()
console.log(bold('\n═══ 指标汇总 ═══'))
console.log(`  轮次：${summary.metrics.turns}`)
console.log(`  反射延迟 p50/p90：${summary.metrics.reflexLatency.p50}ms / ${summary.metrics.reflexLatency.p90}ms（模板档占比 ${summary.metrics.reflexTemplateHitRate}）`)
console.log(`  深层延迟 p50/p90：${summary.metrics.deepLatency.p50}ms / ${summary.metrics.deepLatency.p90}ms`)
console.log(`  接管成功率：${summary.metrics.handoffRate}   降级率：${summary.metrics.degradeRate}`)
console.log(`  经验命中率：${summary.metrics.experienceHitRate}`)
console.log(`  账本：${summary.ledger.memoryTurns} 轮记忆 / ${summary.ledger.experiences} 条经验（平均置信 ${summary.ledger.avgConfidence}）`)
console.log(`  品类树叶子：${summary.taxonomyLeaves}`)
console.log(dim(`\n数据落盘：${cfg.dataDir}/ledger.json、${cfg.dataDir}/metrics.jsonl\n`))
