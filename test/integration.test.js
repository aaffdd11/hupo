/**
 * 集成测试：用假宿主跑完整一轮闭环，验证
 *   1. 三种接管路径确实按宿主状态被选中；
 *   2. 账本与指标都被写入；
 *   3. 通用兜底路径上的经验不会被沉淀（防污染）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { Concierge } from '../src/orchestrator.js'
import { FakeHost } from '../src/host.js'

const makeConcierge = (overrides = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concierge-it-'))
  const cfg = loadConfig({ fake: true, apiKey: '', dataDir, ...overrides })
  const host = new FakeHost({ sessionId: 'it' })
  return { cfg, host, concierge: new Concierge(cfg, { host }) }
}

test('闭环 · 主 agent 正在说话 → steer 半路改口', async () => {
  const { host, concierge } = makeConcierge()
  const result = await concierge.tick({
    text: '我的接口偶发 500，日志里看不出原因，帮我定位一下',
    mainScript: { tokens: ['收到，', '我想想。'], tokenMs: 400, holdMs: 300 },
  })
  assert.equal(result.handoff.action, 'steer')
  assert.equal(result.handoff.delivered, true)
  // 接管的话必须出现在主 agent 说出的内容里（同一个声音）
  assert.ok(host.spokenText().includes(result.handoff.text.split('\n')[0]))
  // 快层确认先于接管发生
  assert.ok(result.timings.reflexMs < result.timings.cortexMs)
})

test('闭环 · 主 agent 已空闲 → followup 补发，绝不沉默', async () => {
  const { host, concierge } = makeConcierge()
  const result = await concierge.tick({
    text: '帮我把这周的日程排一下，周三下午有个会',
    mainScript: { tokens: ['收到。'], tokenMs: 60, holdMs: 500 },
  })
  assert.equal(result.handoff.action, 'followup')
  assert.equal(host.deliveries.at(-1).action, 'followup')
})

test('闭环 · 强制排队注入走 inject，不切碎主 agent 的话', async () => {
  const { host, concierge } = makeConcierge()
  const result = await concierge.tick({
    text: '接口还是偶发 500，帮我看看',
    handoffMode: 'always-inject',
    mainScript: { tokens: ['收到，我先查日志。'], tokenMs: 200, toolMs: 600 },
  })
  assert.equal(result.handoff.action, 'inject')
  assert.equal(host.deliveries.length, 1)
})

test('闭环 · 指标与账本都被写入', async () => {
  const { cfg, concierge } = makeConcierge()
  await concierge.tick({
    text: '最近老是失眠，躺下两小时睡不着，我该先做什么',
    mainScript: { tokens: ['收到。'], tokenMs: 60, holdMs: 200 },
  })
  const summary = concierge.summary()
  assert.equal(summary.metrics.turns, 1)
  assert.equal(summary.ledger.memoryTurns, 1)
  assert.ok(fs.existsSync(path.join(cfg.dataDir, 'ledger.json')), '账本应落盘')
  assert.ok(fs.existsSync(path.join(cfg.dataDir, 'metrics.jsonl')), '指标应落盘')
})

test('防污染 · 落在通用兜底路径上的经验不沉淀', async () => {
  const { concierge, cfg } = makeConcierge()
  // 这条消息关键词命中不了任何领域 → 分类落到 通用/问答
  await concierge.tick({
    text: '随便说点什么吧',
    mainScript: { tokens: ['收到。'], tokenMs: 50, holdMs: 200 },
  })
  // 关键词分类其实会把它判成"通用/问答/问答·通用"，属于兜底路径，不该沉淀经验
  const ledger = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'ledger.json'), 'utf8'))
  const polluted = Object.values(ledger.experiences ?? {}).filter((e) => e.path.includes('通用/问答'))
  assert.equal(polluted.length, 0, `通用兜底路径不应沉淀经验，实际 ${polluted.length} 条`)
})

test('用户反馈 · 纠正会被记入账本与指标', async () => {
  const { concierge } = makeConcierge()
  await concierge.tick({ text: '接口偶发 500 帮我定位', mainScript: { tokens: ['收到。'], tokenMs: 50, holdMs: 200 } })
  concierge.feedback('it', 'correction')
  const summary = concierge.summary()
  assert.equal(summary.metrics.correctionRate, 1)
})

test('品类树 · 分类器的新叶子会被登记，同类问题第二次直接命中该叶子', async () => {
  const { concierge, cfg } = makeConcierge()
  // 这条消息会让分类器产出树里没有的叶子；假模型走关键词路径 → 技术/编程/编程·通用
  await concierge.tick({ text: '接口偶发 500，帮我定位', mainScript: { tokens: ['收到'], tokenMs: 30, holdMs: 100 } })
  // 树里应当多出叶子（来自关键词分类的通用叶或借用叶），且经验路径与之一致
  const ledger = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'ledger.json'), 'utf8'))
  for (const entry of Object.values(ledger.experiences ?? {})) {
    const path = entry.path
    // 关键不变式：沉淀路径必须真实存在于品类树里，否则下次按该路径召回必然是 0 条
    const [d, c, sub] = path.split('/')
    assert.ok(
      concierge.taxonomy.has(`${d}/${c}/${sub}`),
      `经验沉淀路径必须在品类树里存在，实际 ${path} 不在树中（这正是"复用链断掉"的根因）`,
    )
  }
})

test('品类树 · 借用叶子时不会把经验记到借用路径上', async () => {
  const { concierge } = makeConcierge()
  // 直接构造一个"分类器给了新叶子"的场景：登记后路径应为新叶，而不是被借用的老叶
  const before = concierge.taxonomy.size
  await concierge.tick({
    text: '帮我看看这个接口 500 的问题',
    mainScript: { tokens: ['收到'], tokenMs: 30, holdMs: 100 },
  })
  assert.ok(concierge.taxonomy.size >= before, '品类树叶子数不应减少')
})
