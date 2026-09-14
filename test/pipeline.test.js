/**
 * 单元测试：跑 `npm test`。
 *
 * 重点覆盖三件事：
 *   1. 接管决策（三路 + 两个节奏策略）在给定宿主状态下选对动作；
 *   2. 品类树归一化 + 经验父子继承（子类 → 大类 → 领域 → 全局）确实生效；
 *   3. 经验复用的**安全闸门**：不相关的问题绝不能套用别人的答案（实测踩过的坑）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { planHandoff } from '../src/handoff.js'
import { Taxonomy } from '../src/taxonomy.js'
import { Ledger } from '../src/ledger.js'
import { similarity } from '../src/cortex.js'
import { classifyByKeyword, detectRole, createClient } from '../src/llm.js'
import { loadConfig } from '../src/config.js'
import { reflex } from '../src/reflex.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'concierge-test-'))

test('接管决策：三路基本策略', () => {
  assert.equal(planHandoff({ hostStatus: 'running-text' }).action, 'steer')
  assert.equal(planHandoff({ hostStatus: 'running-tools' }).action, 'inject')
  assert.equal(planHandoff({ hostStatus: 'idle' }).action, 'followup')
  assert.equal(planHandoff({ hostStatus: 'running-text', mode: 'safe-followup' }).action, 'followup')
  assert.equal(planHandoff({ hostStatus: 'idle', mode: 'always-steer' }).action, 'steer')
})

test('接管决策：结论未就绪或已交付过时不动作', () => {
  assert.equal(planHandoff({ hostStatus: 'running-text', hasResult: false }).action, 'none')
  assert.equal(planHandoff({ hostStatus: 'running-text', alreadyDelivered: true }).action, 'none')
})

test('接管决策：不抢话策略在主 agent 未开口时推迟', () => {
  const plan = planHandoff({
    hostStatus: 'running-text',
    spokenChars: 0,
    options: { deferWhileThinking: true },
  })
  assert.equal(plan.action, 'none')
  assert.match(plan.reason, /推迟/)

  // 已经开口了就不再推迟
  assert.equal(
    planHandoff({ hostStatus: 'running-text', spokenChars: 12, options: { deferWhileThinking: true } }).action,
    'steer',
  )
})

test('品类树归一化：命中真子类 / 不命中时落到通用兜底并提议新叶', () => {
  const taxonomy = new Taxonomy()
  const hit = taxonomy.normalize({ domain: '技术', category: '编程', subcategory: '调试排错' })
  assert.equal(hit.path, '技术/编程/调试排错')
  assert.equal(hit.isNew, false)

  // 库里没有的叶子 → 借用同一大类下的已有叶子承载大类经验，并回报"建议新叶"。
  // 关键：绝不能直接掉到全局兜底，否则不同大类的问题会挤在同一条路径上互相污染。
  const miss = taxonomy.normalize({ domain: '技术', category: '编程', subcategory: '依赖冲突排查' })
  assert.equal(miss.path, '技术/编程/调试排错')
  assert.equal(miss.isNew, true)
  assert.equal(miss.proposed, '技术/编程/依赖冲突排查')
  assert.equal(miss.borrowed, true)

  const unknown = taxonomy.normalize({ domain: '不存在', category: '不存在', subcategory: '不存在' })
  assert.equal(unknown.path, '通用/问答/问答·通用')
})

test('经验继承：子类 > 大类 > 领域 > 全局，且都带层级标注', () => {
  const ledger = new Ledger(tmpDir())
  ledger.learn({ path: '技术/编程/调试排错', pattern: '接口偶发 500', solution: '子类解法', confidence: 0.9 })
  ledger.learn({ path: '技术/*/通用', pattern: '技术类通用', solution: '大类解法', confidence: 0.9 })
  ledger.learn({ path: '*/*/*', pattern: '全局通用', solution: '全局解法', confidence: 0.9 })

  const recalled = ledger.recall('技术/编程/调试排错')
  const levels = recalled.map((e) => e.level)
  assert.deepEqual(levels.slice(0, 3), ['subcategory', 'category', 'global'])
  assert.equal(recalled[0].solution, '子类解法')
  // 子类经验得分必须高于同置信度的大类经验
  assert.ok(recalled[0].score > recalled.find((e) => e.level === 'category').score)
})

test('经验加固：同模式再次学习会提升置信度与命中次数', () => {
  const ledger = new Ledger(tmpDir())
  const first = ledger.learn({ path: '写作/小说/剧情结构', pattern: '第二章节奏太慢', solution: '压缩过场', confidence: 0.6 })
  const firstSnapshot = { ...first } // learn() 是原地加固，比较前必须先快照
  const again = ledger.learn({ path: '写作/小说/剧情结构', pattern: '第二章节奏太慢！', solution: '压缩过场', confidence: 0.6 })
  assert.equal(again.id, firstSnapshot.id, '同一模式应加固同一条经验，而不是新建一条')
  assert.equal(again.hits, firstSnapshot.hits + 1)
  assert.ok(again.confidence > firstSnapshot.confidence, '加固后置信度应上升')
  assert.equal(ledger.stats().experiences, 1)
})

test('经验安全闸门：相似度能区分"同一类问题"和"不相干问题"', () => {
  const a = '我的接口偶发 500，日志里看不出原因，帮我定位一下'
  const b = '接口又偶发 500 了，还是老毛病'
  const c = '最近老是失眠，躺下两小时睡不着'
  const THRESHOLD = 0.18
  assert.ok(similarity(a, b) > THRESHOLD, `同类改述应达标，实际 ${similarity(a, b).toFixed(3)}`)
  assert.ok(similarity(a, c) < THRESHOLD, `不相干问题应低于阈值，实际 ${similarity(a, c).toFixed(3)}`)
})

test('Reflex 模板档：高频场景零模型调用即可命中', async () => {
  const cfg = loadConfig({ fake: true, apiKey: '' })
  const cases = [
    ['你好', 'greet'],
    ['谢谢', 'thanks'],
    ['好的', 'ok'],
    ['等一下', 'wait'],
  ]
  for (const [text, rule] of cases) {
    const result = await reflex({ text, client: null, cfg })
    assert.equal(result.source, 'template')
    assert.equal(result.rule, rule)
    assert.ok(result.latencyMs < 50, `模板档应当近乎零延迟，实际 ${result.latencyMs}ms`)
  }
})

test('Reflex 模板档不拦长句：长诉求交给小模型或兜底', async () => {
  const cfg = loadConfig({ fake: true, apiKey: '' })
  const result = await reflex({ text: '帮我把下周三的客户会议安排一下', client: null, cfg })
  assert.equal(result.rule, 'fallback')
  assert.ok(result.text.includes('帮我把下周三'))
})

test('关键词分类能把常见诉求落到对应品类', () => {
  assert.equal(classifyByKeyword('这段代码报错了').domain, '技术')
  assert.equal(classifyByKeyword('帮我改小说第三章').category, '小说')
  assert.equal(classifyByKeyword('最近总是失眠').category, '健康')
  assert.equal(classifyByKeyword('随便说点什么').domain, '通用')
})

test('未配置密钥时自动退回假模型，原型永远能跑', () => {
  const client = createClient(loadConfig({ apiKey: '', fake: false }))
  assert.match(client.mode, /fake\(no-api-key\)/)
})

test('假模型按角色分派，且被 system 标记识别', () => {
  assert.equal(detectRole('[[ROUTER]] 你是意图分类器'), 'ROUTER')
  assert.equal(detectRole('[[SYNTHESIZER]] 你是提炼器'), 'SYNTHESIZER')
  assert.equal(detectRole('没有标记'), 'UNKNOWN')
})
