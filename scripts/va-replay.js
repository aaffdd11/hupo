/**
 * V-A 离线重放 v2（真数据）：用 session.jsonl 的 `text-chunks` 事件（含逐 chunk 的 dt 数组）
 * 重建真实生成时间线，量出：
 *   ① 生成速率（字/秒）与 chunk 间隙
 *   ② 首 token 等待 TTFT（相对 step/start）
 *   ③ 自然首句长度（第一个硬边界的位置）分布 —— 直接检验"首句 ≤14 字"纪律的可行性
 *   ④ 三套边界规则下"首单元就绪延迟"（相对首 token）：
 *        R1 纯标点 ；R2 +25字上限 ；R3 +25字上限+600ms 兜底
 *   ⑤ 首单元长度分布、强制切分比例
 *
 * 用法：node scripts/va-replay.js [--root DIR] [--min-cjk 0.5] [--min-chars 40]
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'

const A = process.argv.slice(2)
const getArg = (k, d) => (A.includes(k) ? A[A.indexOf(k) + 1] : d)
const root = getArg('--root', join(homedir(), '.dsh', 'sessions'))
const minCjk = Number(getArg('--min-cjk', '0.5'))
const minChars = Number(getArg('--min-chars', '30'))

const HARD = new Set(['。', '！', '？', '；', '…', '!', '?', ';', '\n'])
const SOFT = new Set(['，', '、', ','])

function walk(dir, out = []) {
  let e = []
  try { e = readdirSync(dir) } catch { return out }
  for (const x of e) {
    const p = join(dir, x)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (x === 'session.jsonl.zstd') out.push(p)
  }
  return out
}
const cjkRatio = (s) => {
  if (!s) return 0
  let c = 0
  for (const ch of s) if (ch >= '\u4e00' && ch <= '\u9fff') c++
  return c / [...s].length
}
const pct = (arr, p) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]
}

function parseJson(line, keys) {
  for (const k of keys) if (line.includes(k)) return true
  return false
}

async function scanFile(file) {
  const steps = new Map() // "turn/step" -> {startTime}
  const streams = new Map() // "turn/step/index" -> [{seq0,time0,dt,texts}]
  const msgs = [] // 最终 assistant/message 文本（用于完整性校验）
  const child = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] })
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"step/start"') && !line.includes('"text-chunks"') && !line.includes('"assistant/message"')) continue
    if (line.includes('"type":"step/start"')) {
      try { const o = JSON.parse(line); steps.set(`${o.data?.turn}/${o.data?.step}`, o.time) } catch {}
      continue
    }
    if (line.includes('"type":"text-chunks"')) {
      let o
      try { o = JSON.parse(line) } catch { continue }
      const d = o.data
      if (!d || !Array.isArray(d.texts)) continue
      const key = `${d.turn}/${d.step}/${d.index ?? 0}`
      if (!streams.has(key)) streams.set(key, [])
      streams.get(key).push({ seq0: o.seq0 ?? 0, time0: o.time0 ?? o.time, dt: d.dt ?? [], texts: d.texts })
      continue
    }
    if (line.includes('"type":"assistant/message"')) {
      let o
      try { o = JSON.parse(line) } catch { continue }
      const c = o.data?.message?.content
      if (Array.isArray(c)) for (const b of c) if (b?.type === 'text') msgs.push(String(b.text ?? ''))
    }
  }
  await new Promise((r) => child.on('close', r))
  return { steps, streams, msgs }
}

const rows = []
let fileCount = 0

for (const file of walk(root)) {
  let parsed
  try { parsed = await scanFile(file) } catch { continue }
  fileCount++
  const { steps, streams } = parsed
  for (const [key, evs] of streams) {
    const [turn, step, index] = key.split('/')
    const stepStart = steps.get(`${turn}/${step}`) ?? null
    // 按 seq0 排序并拼接；要求大致连续（seq0 递增）
    const evs2 = [...evs].sort((a, b) => a.seq0 - b.seq0)
    const chunks = []
    for (const e of evs2) {
      let t = e.time0
      for (let i = 0; i < e.texts.length; i++) {
        if (i > 0) t += Number(e.dt[i - 1] ?? 0)
        chunks.push({ t, text: String(e.texts[i] ?? '') })
      }
    }
    if (chunks.length < 4) continue
    const text = chunks.map((c) => c.text).join('')
    const nChar = [...text].length
    if (nChar < minChars) continue
    if (cjkRatio(text) < minCjk) continue
    const t0 = chunks[0].t
    const tEnd = chunks[chunks.length - 1].t
    const span = tEnd - t0
    if (span <= 0) continue

    const rate = nChar / (span / 1000)
    // 逐字累计时间线
    const timeline = [] // {ch, t}
    for (const c of chunks) for (const ch of [...c.text]) timeline.push({ ch, t: c.t })

    const idxHard = timeline.findIndex((x) => HARD.has(x.ch))
    const idxSoft = timeline.findIndex((x) => SOFT.has(x.ch))
    const naturalFirst = idxHard >= 0 ? idxHard + 1 : null // 第一个硬边界处的首句长度

    // 三套规则的首单元就绪时刻
    const unitAt = (maxLen, fallbackMs) => {
      let cum = 0
      for (const x of timeline) {
        cum++
        if (HARD.has(x.ch)) return { len: cum, delay: x.t - t0, why: 'hard' }
        if (maxLen && cum >= maxLen) {
          // 软切点回退：最近 8 字内的逗号；没有就原地切
          let cut = cum
          for (let b = Math.max(0, cum - 8); b < cum; b++) if (SOFT.has(timeline[b].ch)) cut = b + 1
          return { len: cut, delay: timeline[cut - 1].t - t0, why: 'cap' }
        }
        if (fallbackMs && x.t - t0 >= fallbackMs) {
          let cut = cum
          for (let b = Math.max(0, cum - 8); b < cum; b++) if (SOFT.has(timeline[b].ch)) cut = b + 1
          return { len: cut, delay: timeline[cut - 1].t - t0, why: 'time' }
        }
      }
      return null
    }
    const r1 = unitAt(0, 0)
    const r2 = unitAt(25, 0)
    const r3 = unitAt(25, 600)
    if (!r3) continue

    const gaps = []
    for (let i = 1; i < chunks.length; i++) gaps.push(chunks[i].t - chunks[i - 1].t)

    rows.push({
      file: file.split('/sessions/')[1]?.split('/')[0],
      turn, step, index,
      nChar, rate,
      ttft: stepStart ? t0 - stepStart : null,
      naturalFirst,
      firstSoft: idxSoft >= 0 ? idxSoft + 1 : null,
      r1len: r1?.len ?? null, r1delay: r1?.delay ?? null,
      r2len: r2?.len ?? null, r2delay: r2?.delay ?? null, r2why: r2?.why,
      r3len: r3.len, r3delay: r3.delay, r3why: r3.why,
      timeTo14: timeline[13] ? timeline[13].t - t0 : null,
      timeTo25: timeline[24] ? timeline[24].t - t0 : null,
      gapP50: pct(gaps, 50), gapP90: pct(gaps, 90), gapMax: Math.max(...gaps),
      span,
    })
  }
}

const N = rows.length
const nums = (f) => rows.map(f).filter((v) => v != null && Number.isFinite(v))
const line = (name, arr, unit = '') => {
  if (!arr.length) return console.log(`${name}: (无样本)`)
  console.log(`${name}: n=${arr.length} p10=${pct(arr, 10)} p50=${pct(arr, 50)} p90=${pct(arr, 90)} p99=${pct(arr, 99)} max=${Math.max(...arr).toFixed(0)}${unit}`)
}
const share = (fn) => `${((rows.filter(fn).length / N) * 100).toFixed(1)}%`

console.log(`\n=== V-A 离线重放（真数据：text-chunks 逐 chunk dt 重建） ===`)
console.log(`扫描 ${fileCount} 个会话文件；可用文本流样本 n=${N}（≥${minChars} 字、CJK ≥${minCjk}、≥4 chunk）\n`)

console.log('--- ① 生成速率（字/秒） ---')
line('rate', nums((r) => r.rate))

console.log('\n--- ② chunk 到达间隙（ms，真实节奏） ---')
line('gapP50', nums((r) => r.gapP50)); line('gapP90', nums((r) => r.gapP90)); line('gapMax', nums((r) => r.gapMax))

console.log('\n--- ③ TTFT（首 chunk 相对 step/start，ms） ---')
line('ttft', nums((r) => r.ttft))

console.log('\n--- ④ 自然首句长度（到第一个硬边界，字） ---')
line('naturalFirst', nums((r) => r.naturalFirst))
console.log(`   ≤14 字的比例: ${share((r) => r.naturalFirst != null && r.naturalFirst <= 14)}`)
console.log(`   ≤18 字的比例: ${share((r) => r.naturalFirst != null && r.naturalFirst <= 18)}`)
console.log(`   ≤25 字的比例: ${share((r) => r.naturalFirst != null && r.naturalFirst <= 25)}`)
console.log(`   >25 字（必须上限强切）的比例: ${share((r) => r.naturalFirst != null && r.naturalFirst > 25)}`)
console.log(`   整段无硬边界（无法按句投递）的比例: ${share((r) => r.naturalFirst == null)}`)

console.log('\n--- ⑤ 首单元就绪延迟（相对首 chunk，ms） ---')
line('R1 纯标点  ', nums((r) => r.r1delay)); line('R2 +25字上限', nums((r) => r.r2delay)); line('R3 +600ms兜底', nums((r) => r.r3delay))
console.log('\n--- ⑥ 首单元长度（字） ---')
line('R1 纯标点  ', nums((r) => r.r1len)); line('R2 +25字上限', nums((r) => r.r2len)); line('R3 +600ms兜底', nums((r) => r.r3len))
console.log(`\n--- ⑦ 首单元切分原因 ---`)
console.log(`   R3 硬边界: ${share((r) => r.r3why === 'hard')} / 25字上限: ${share((r) => r.r3why === 'cap')} / 600ms兜底: ${share((r) => r.r3why === 'time')}`)

console.log('\n--- ⑧ 到达 14 字 / 25 字的时间（相对首 chunk，ms） ---')
line('to14', nums((r) => r.timeTo14)); line('to25', nums((r) => r.timeTo25))

console.log('\n--- 明细（前 25 条） ---')
for (const r of rows.slice(0, 25)) {
  console.log(`${r.file} ${r.turn}/${r.step}/${r.index} ${r.nChar}字 ${r.rate.toFixed(1)}字/s ttft=${r.ttft ?? '-'} 自然首句=${r.naturalFirst ?? '无'} R3就绪=${r.r3delay}ms(${r.r3len}字,${r.r3why}) gapP50=${r.gapP50}`)
}
