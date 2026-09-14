/**
 * 零依赖 SVG 图渲染器 —— 给架构文档出图（离线可用）。
 *
 * 用法：node scripts/diagrams.mjs
 * 输出：docs/img/*.svg（可直接在浏览器/GUI 打开）
 *
 * 为什么自己写：本机 npm registry 不可达，装 mermaid-cli 需要拉 Chromium，
 * 风险大且要联网。架构图是固定内容，用声明式坐标渲染就够了，还便于版本管理。
 */

import fs from 'node:fs'
import path from 'node:path'

const OUT_DIR = path.join(process.cwd(), 'docs', 'img')

/** 主题 */
const T = {
  bg: '#0f1419',
  boxFill: '#1b2530',
  boxStroke: '#3b4a5a',
  user: { fill: '#1f2d3d', stroke: '#4a90d9' },
  app: { fill: '#1a3028', stroke: '#3fb950' },
  recv: { fill: '#2b2418', stroke: '#d29922' },
  proc: { fill: '#2a1f33', stroke: '#a371f7' },
  feed: { fill: '#1f2a3d', stroke: '#58a6ff' },
  mem: { fill: '#302024', stroke: '#f85149' },
  text: '#e6edf3',
  dim: '#8b949e',
  arrow: '#7d8590',
  ok: '#3fb950',
  warn: '#d29922',
  err: '#f85149',
  lane: '#161d26',
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 简易换行：按 maxChars 断行（中文按字计，英文按空格） */
function wrap(text, maxChars) {
  if (!text) return []
  const lines = []
  for (const raw of String(text).split('\n')) {
    if (raw.length <= maxChars) {
      lines.push(raw)
      continue
    }
    let cur = ''
    for (const ch of raw) {
      cur += ch
      if (cur.length >= maxChars) {
        lines.push(cur)
        cur = ''
      }
    }
    if (cur) lines.push(cur)
  }
  return lines
}

class Svg {
  constructor(width, height, title) {
    this.w = width
    this.h = height
    this.title = title
    this.parts = []
  }

  box({ x, y, w, h, lines = [], color = 'box', title: boxTitle, fontSize = 13, radius = 8, dashed = false }) {
    const c = typeof color === 'string' ? { fill: T.boxFill, stroke: T.boxStroke } : { ...color }
    this.parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"${dashed ? ' stroke-dasharray="6 4"' : ''}/>`,
    )
    let cy = y + 8
    if (boxTitle) {
      cy += fontSize
      this.parts.push(
        `<text x="${x + w / 2}" y="${cy}" fill="${c.stroke}" font-size="${fontSize + 1}" font-weight="700" text-anchor="middle">${esc(boxTitle)}</text>`,
      )
      cy += 6
    }
    for (const line of lines) {
      cy += fontSize + 4
      this.parts.push(
        `<text x="${x + 12}" y="${cy}" fill="${T.text}" font-size="${fontSize}">${esc(line)}</text>`,
      )
    }
  }

  /** 居中多行文本块（不画框） */
  text({ x, y, lines = [], color = T.text, fontSize = 13, anchor = 'start', bold = false }) {
    let cy = y
    for (const line of lines) {
      cy += fontSize + 4
      this.parts.push(
        `<text x="${x}" y="${cy}" fill="${color}" font-size="${fontSize}" text-anchor="${anchor}"${bold ? ' font-weight="700"' : ''}>${esc(line)}</text>`,
      )
    }
    return cy
  }

  arrow({ from, to, label, color = T.arrow, dashed = false, curve = 0, labelOffset = -6 }) {
    const [x1, y1] = from
    const [x2, y2] = to
    let d
    if (curve === 0) {
      d = `M ${x1} ${y1} L ${x2} ${y2}`
    } else {
      const mx = (x1 + x2) / 2 + curve
      const my = (y1 + y2) / 2
      d = `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`
    }
    this.parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"${dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#arrow)"/>`,
    )
    if (label) {
      const mx = (x1 + x2) / 2
      const my = (y1 + y2) / 2 + labelOffset
      const wpx = label.length * 12 + 12
      this.parts.push(
        `<rect x="${mx - wpx / 2}" y="${my - 15}" width="${wpx}" height="20" rx="4" fill="${T.bg}" opacity="0.92"/>`,
        `<text x="${mx}" y="${my}" fill="${T.dim}" font-size="12" text-anchor="middle">${esc(label)}</text>`,
      )
    }
  }

  /** 泳道底纹 */
  lane({ x, y, w, h, label, color = T.lane }) {
    this.parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${color}" stroke="#232c36" stroke-width="1"/>`,
      `<text x="${x + 14}" y="${y + 22}" fill="${T.dim}" font-size="12" font-weight="700">${esc(label)}</text>`,
    )
  }

  note({ x, y, w, lines, color = T.warn }) {
    const h = 16 + lines.length * 17
    this.parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#22201a" stroke="${color}" stroke-width="1.2" stroke-dasharray="4 3"/>`,
    )
    let cy = y + 6
    for (const line of lines) {
      cy += 15
      this.parts.push(`<text x="${x + 10}" y="${cy}" fill="${color}" font-size="12">${esc(line)}</text>`)
    }
  }

  render() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}" font-family="'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Source Han Sans SC','Droid Sans Fallback','DroidSansFallbackFull',system-ui,sans-serif">
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${T.arrow}"/>
  </marker>
  <style>text { dominant-baseline: auto; }</style>
</defs>
<rect width="100%" height="100%" fill="${T.bg}"/>
<text x="24" y="32" fill="${T.text}" font-size="18" font-weight="700">${esc(this.title)}</text>
${this.parts.join('\n')}
</svg>`
  }

  save(file) {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const p = path.join(OUT_DIR, file)
    fs.writeFileSync(p, this.render())
    return p
  }
}

/* ───────────────────────── 图 1：系统总架构 ───────────────────────── */

function diagram1() {
  const W = 1380
  const H = 1000
  const s = new Svg(W, H, '图 1 · 系统总架构：4 角色 + 控制器 + 12 组件')

  // 泳道
  s.lane({ x: 20, y: 50, w: W - 40, h: 150, label: '一、应用层 APP（控制器所在，唯一掌握全局的地方 · 不产生语言）' })
  s.lane({ x: 20, y: 214, w: W - 40, h: 118, label: '二、路由层（只做分类判定，不参与对话）' })
  s.lane({ x: 20, y: 346, w: W - 40, h: 250, label: '三、处理层（多 agent，按类别分工 · 永不直接对用户说话）' })
  s.lane({ x: 20, y: 610, w: W - 40, h: 170, label: '四、对话层（用户唯一能感知到的两个角色 · 共用同一套声音）' })
  s.lane({ x: 20, y: 794, w: W - 40, h: 118, label: '五、记忆层（每用户一份 · 控制器独占写权）' })

  // ── 应用层
  s.box({
    x: 470, y: 78, w: 440, h: 108, color: T.app, title: '控制器 Controller（APP 本身 · 进程）',
    lines: wrap('不生产语言，只决定：谁在什么时候说 / 记什么 / 拦什么', 40).concat([
      '① 双通道分路拦截（按 source 标记）  ② 优先级队列',
      '③ 事实源 + 角色视图投影             ④ 上下文预算与整块重建调度',
    ]),
  })
  const aux = [
    ['进度估算 ETA', '快说完 / 还要一会 / 还很久'],
    ['心跳续话 KeepAlive', '话题耗尽即降级，无次数上限'],
    ['一致性守卫', 'agree / extend / conflict'],
    ['降级兜底 Fallback', '四种终态，绝不留白'],
    ['衔接改写器 ⚠新增', '把结论改写成接得上上文的话'],
    ['任务队列 + 轮次归属 ⚠新增', '未完成任务跨轮存活'],
  ]
  aux.forEach(([t, d], i) => {
    const x = 60 + i * 212
    s.box({ x, y: 116, w: 196, h: 70, lines: wrap(d, 12), title: t, fontSize: 11, color: T.app })
  })

  // ── 路由层
  s.box({
    x: 470, y: 240, w: 440, h: 74, color: T.mem, title: '常驻分类器（一次性调用，不进对话）',
    lines: ['输出：大类 / 中类 / 小类 + 置信度', '纪律：一次只唤醒一个，绝不扇出'],
  })

  // ── 处理层
  const procs = ['技术类处理 agent', '写作类处理 agent', '生活类处理 agent', '事务类处理 agent', '通用处理兜底（未分类时）']
  procs.forEach((t, i) => {
    s.box({
      x: 70 + i * 258, y: 384, w: 230, h: 96, color: T.proc, title: t, fontSize: 12,
      lines: ['· 独立会话 / 独立窗口', '· 独立经验包', '· 品类方法论进 system（稳定）'],
    })
  })
  s.note({
    x: 70, y: 494, w: 1230, color: T.warn,
    lines: [
      '⚠ 上下文按品类隔离：换品类 = 换窗口，成本不随总轮数增长（架构本身消掉了大部分刷新压力）',
      '⚠ 并发池上限 2：Q1 深研期间 Q2 到达 → 起第二个通用处理会话，任务结束即回收',
    ],
  })

  // ── 对话层
  s.box({
    x: 130, y: 642, w: 420, h: 118, color: T.recv, title: '接收层（Receiving）',
    lines: wrap('接收用户信息 + 立刻回应，维持在场感', 30).concat([
      '输入：发言简报 + 记忆简报', '禁区：不给结论 / 不承诺时间 / 不重复',
    ]),
  })
  s.box({
    x: 830, y: 642, w: 420, h: 118, color: T.feed, title: '反馈层（Feedback）',
    lines: wrap('承接已说的话，说出结论（有最终发言权）', 30).concat([
      '输入：结论 + 已输出全文 + 接管点 + 一致性', '禁区：不自己思考 / 不重复已说内容',
    ]),
  })
  s.text({
    x: 700, y: 700, anchor: 'middle', fontSize: 13, color: T.ok, bold: true,
    lines: ['同一个人格', '（共用 voice 段，', '角色指令分开）'],
  })

  // ── 记忆层
  const mems = ['用户档案 Profile', '品类树 Taxonomy', '经验包 Experiences', '指标 Metrics', '证据链 Evidence']
  mems.forEach((t, i) => {
    s.box({ x: 70 + i * 258, y: 828, w: 230, h: 66, color: T.mem, title: t, fontSize: 12, lines: [] })
  })

  // ── 用户
  s.box({ x: 560, y: 928, w: 260, h: 56, color: T.user, title: '用户', lines: ['（只感知对话层，不感知内部编排）'], fontSize: 12 })

  // ── 连接
  s.arrow({ from: [330, 928], to: [330, 762], label: '① 说话' })
  s.arrow({ from: [1040, 762], to: [1040, 928], label: '⑥ 看到一条消息' })
  s.arrow({ from: [550, 762], to: [550, 700], label: '② 捕获' })
  s.arrow({ from: [470, 300], to: [330, 384], label: '③ 分发', dashed: true })
  s.arrow({ from: [910, 300], to: [945, 384], label: '③ 分发', dashed: true })
  s.arrow({ from: [340, 480], to: [340, 642], label: '④ 结论' })
  s.arrow({ from: [690, 186], to: [690, 240], label: '' })
  s.arrow({ from: [330, 116], to: [330, 642], label: '⑤ 简报 / 续话 / 打断', curve: -150, dashed: true })
  s.arrow({ from: [1040, 186], to: [1040, 642], label: '⑤ 接管指令', curve: 150, dashed: true })
  s.arrow({ from: [690, 900], to: [690, 828], label: '读写', dashed: true })
  s.arrow({ from: [470, 186], to: [470, 828], label: '', curve: -260, dashed: true })

  return s.save('01-architecture.svg')
}

/* ─────────────────── 图 2：单轮消息流（含接管判决） ─────────────────── */

function diagram2() {
  const W = 1380
  const H = 900
  const s = new Svg(W, H, '图 2 · 单轮消息流：从用户开口到用户看到一条消息')

  const cols = [
    { x: 40, t: '用户' },
    { x: 300, t: '控制器' },
    { x: 560, t: '接收层' },
    { x: 820, t: '处理层' },
    { x: 1080, t: '反馈层' },
  ]
  cols.forEach((c) => {
    s.box({ x: c.x, y: 56, w: 220, h: 44, color: T.boxFill, title: c.t, fontSize: 13 })
  })

  const steps = [
    { y: 140, from: 40, to: 300, label: '① 用户说话', color: T.user.stroke },
    { y: 176, from: 300, to: 300, label: '', skip: true },
  ]
  // 手动排布时序
  const ev = [
    { y: 132, fx: 150, tx: 410, label: '① 用户输入', c: T.user.stroke },
    { y: 178, fx: 410, tx: 410, label: '', c: T.app.stroke },
    { y: 210, fx: 410, tx: 670, label: '② 发言简报 + 记忆简报', c: T.app.stroke, dashed: true },
    { y: 210, fx: 410, tx: 930, label: '③ 任务 + 上下文快照', c: T.app.stroke, dashed: true },
    { y: 258, fx: 670, tx: 670, label: '', c: T.recv.stroke },
    { y: 300, fx: 670, tx: 410, label: '④ 文本流（逐 chunk）', c: T.recv.stroke },
    { y: 300, fx: 930, tx: 410, label: '⑤ 结论就绪', c: T.proc.stroke },
    { y: 352, fx: 410, tx: 410, label: '', c: T.app.stroke },
    { y: 400, fx: 410, tx: 670, label: '⑥ 续话通知 / 软打断', c: T.app.stroke, dashed: true },
    { y: 448, fx: 670, tx: 670, label: '', c: T.recv.stroke },
    { y: 490, fx: 410, tx: 1190, label: '⑦ 接管指令（承载包：已输出全文 + 接管点 + 一致性 + 结论）', c: T.app.stroke, dashed: true },
    { y: 540, fx: 1190, tx: 410, label: '⑧ 收尾文本流', c: T.feed.stroke },
    { y: 600, fx: 410, tx: 150, label: '⑨ 放行（用户看到一条消息）', c: T.ok },
    { y: 652, fx: 410, tx: 410, label: '', c: T.mem.stroke },
    { y: 700, fx: 410, tx: 410, label: '', c: T.mem.stroke },
  ]
  ev.forEach((e) => {
    if (e.fx === e.tx && !e.skip) {
      // 自持动作：画个小圆点 + 说明
      s.parts.push(`<circle cx="${e.fx}" cy="${e.y}" r="5" fill="${e.c}" />`)
      if (e.label) {
        s.parts.push(`<text x="${e.fx + 12}" y="${e.y + 4}" fill="${T.dim}" font-size="12">${esc(e.label)}</text>`)
      }
      return
    }
    if (!e.skip) s.arrow({ from: [e.fx, e.y], to: [e.tx, e.y], label: e.label, color: e.c, dashed: e.dashed })
  })
  // 补齐自持动作的说明文字
  s.text({ x: 424, y: 172, color: T.dim, fontSize: 12, lines: ['分类（常驻分类器，一次性调用）', '组装两个视图：接收层/处理层各一份', '起优先级队列'] })
  s.text({ x: 684, y: 252, color: T.dim, fontSize: 12, lines: ['接收层开口（首字 0.8–1.5s）', '说的是"这个我熟…"而不是"我听到了"'] })
  s.text({ x: 424, y: 346, color: T.dim, fontSize: 12, lines: ['接管判决：ETA × 时效性 × 打断禁区', '实测常见结果 = 软打断'] })
  s.text({ x: 684, y: 442, color: T.dim, fontSize: 12, lines: ['说完当前句即停（无半截话）'] })
  s.text({ x: 424, y: 646, color: T.dim, fontSize: 12, lines: ['写提案（pending）→ 观察用户反应', '未纠正 → committed / 纠正 → retracted'] })

  s.note({
    x: 900, y: 720, w: 440, color: T.warn,
    lines: [
      '关键实测：处理层常比接收层首字更快',
      '（900ms vs 1200ms）→ 多数轮次是"接收层说一句，',
      '反馈层紧接着接管"，而非"接收层说很久被救场"',
      '推论：处理层先到时，接收层只说简短承接语，',
      '发言预算留给反馈层（否则两次发言说一件事）',
    ],
  })

  s.arrow({ from: [1250, 132], to: [1250, 600], label: '', color: T.dim, dashed: true })
  s.text({ x: 1262, y: 300, color: T.dim, fontSize: 11, lines: ['控', '制', '器', '拦', '截', '点'] })

  return s.save('02-single-turn.svg')
}

/* ────────── 图 3：跨轮 / 并发状态机（补的 8 个缺口所在处） ────────── */

function diagram3() {
  const W = 1380
  const H = 940
  const s = new Svg(W, H, '图 3 · 跨轮与并发状态机：用户插话 / 并发提问 / 品类切换')

  s.lane({ x: 20, y: 50, w: 900, h: 300, label: 'A. 正常轮（处理层后到）' })
  s.lane({ x: 20, y: 366, w: 900, h: 300, label: 'B. 用户在原任务未完成时插话（缺口 5 / 6）' })
  s.lane({ x: 20, y: 682, w: 900, h: 230, label: 'C. 品类切换与恢复（缺口 10）' })

  // A
  let y = 92
  const aSteps = [
    '用户 Q1 ──► 接收层开口 ──► 处理层(Q1) 深研中…',
    '                    │',
    '                    ├─ 用户仍在打字/等待 → 控制器判定"无缺口"，不动作',
    '                    │',
    '                    └─ 处理层就绪 ──► 接管判决 ──► 反馈层说结论 ──► 落账',
  ]
  s.text({ x: 50, y, color: T.text, fontSize: 13, lines: aSteps })
  s.note({ x: 60, y: 250, w: 830, color: T.ok, lines: ['用户打字的时间 = 天然的、用户无感的操作窗口（用于上下文维护与记忆注入）'] })

  // B
  const bSteps = [
    '用户 Q1 ──► 处理层(Q1) 深研中… ──► 用户又发 Q2（此时 Q1 未完成）',
    '                                        │',
    '      ┌─────────────────────────────────┴────────────────────────────────┐',
    '      ▼                                                                  ▼',
    '  路径 B1：接收层立即应 Q2                        路径 B2：Q1 结论到达',
    '  · 任务队列登记 Q2（归属当前轮）                  · 不抢占 Q2 的响应',
    '  · 处理层池起第二个会话跑 Q2（上限 2）             · Q1 结论入队，待 Q2 说完再发',
    '  · Q1 结论若已就绪 → 排队，不打断 Q2              · 两条结论合并成一条说（不连发）',
  ]
  s.text({ x: 50, y: 408, color: T.text, fontSize: 13, lines: bSteps })
  s.note({
    x: 920, y: 400, w: 420, color: T.warn,
    lines: [
      '缺口 5：未完成任务队列 + 轮次归属',
      '缺口 6：用户打断 agent 与控制器',
      '打断 agent 是两套语义，需分别定义',
    ],
  })

  // C
  const cSteps = [
    'Q1 技术类 ──► 用户切到写作类 ──► 用户又切回技术类',
    '   │                                    │',
    '   技术窗口(热)                          恢复方式 = 把技术类摘要【尾部追加】',
    '   写作窗口(冷→热，干净窗口)              ✓ 前缀未动 → 缓存保留',
    '                                          ✓ 经验已 committed → 接收层第一句就能说"这个我熟"',
  ]
  s.text({ x: 50, y: 724, color: T.text, fontSize: 13, lines: cSteps })
  s.note({ x: 60, y: 840, w: 830, color: T.err, lines: ['缺口 10 未定义项：上下文恢复协议（用什么载体、追加到哪、旧窗口怎么回收）'] })

  // 右侧：缺口清单
  s.lane({ x: 940, y: 50, w: 420, h: 862, label: '链路完整性审计：8 个缺口' })
  s.text({
    x: 960, y: 88, fontSize: 12.5, color: T.text, lines: wrap(
      '致命（3 个）', 30,
    ), bold: true,
  })
  s.text({
    x: 960, y: 112, fontSize: 12, color: T.err, lines: wrap(
      '1 无角色间共享事实源：三角色对同一轮认知互不相通，用户说"那个东西"三个角色都在猜\n'
      + '2 结论无法直接说出口：缺"衔接改写"，结论是给控制器的结构化数据，不是给人听的话\n'
      + '3 系统注入污染会话历史：inject 的记忆简报会被记进日志，下一轮读到自己对简报的回应', 34,
    ),
  })
  s.text({
    x: 960, y: 268, fontSize: 12.5, color: T.text, lines: ['重要（3 个）'], bold: true,
  })
  s.text({
    x: 960, y: 292, fontSize: 12, color: T.warn, lines: wrap(
      '4 两角色历史混在一条会话里，需要角色标注 + 各自读不同切片\n'
      + '5 用户在原任务未完成时插话：未完成任务队列 + 归属轮次未定义\n'
      + '6 用户打断 agent：与控制器打断是两套语义，未定义', 34,
    ),
  })
  s.text({ x: 960, y: 424, fontSize: 12.5, color: T.text, lines: ['中等（2 个）'], bold: true })
  s.text({
    x: 960, y: 448, fontSize: 12, color: T.dim, lines: wrap(
      '7 轮际状态载体：上轮说了什么/接管点/一致性，跨轮丢失\n'
      + '8 发言出口采集：账本只记结论，没记"实际对用户说出的话"，纠正的证据链断在这里', 34,
    ),
  })

  s.text({
    x: 960, y: 560, fontSize: 12.5, color: T.text, lines: ['场景覆盖度（12 个必然发生的场景）'], bold: true,
  })
  s.text({
    x: 960, y: 584, fontSize: 12, color: T.dim, lines: wrap(
      '已定义 4 个（正常轮×2、超时、取消）\n'
      + '只提未细化 3 个（处理层先到、续话耗尽、连续同类）\n'
      + '完全未定义 5 个（插话、并发提问、反馈层被打断、品类切换、多结论合并）', 34,
    ),
  })
  s.note({
    x: 960, y: 700, w: 380, color: T.err,
    lines: [
      '规律：现有设计是"单向流水线"，',
      '而真实对话是"有状态的并发系统"。',
      '缺的 8 个里 6 个出于同一原因。',
      '',
      '根 = 缺口 1（共享事实源 + 角色视图），',
      '其余 5 个都挂在它上面。',
    ],
  })

  return s.save('03-cross-turn.svg')
}

/* ────────────── 图 4：记忆与上下文层级 + 注入位置 ────────────── */

function diagram4() {
  const W = 1380
  const H = 880
  const s = new Svg(W, H, '图 4 · 记忆层级、上下文预算与注入位置（实测依据）')

  // 左：记忆层级
  s.lane({ x: 20, y: 50, w: 620, h: 380, label: '记忆层级（每用户一份，控制器独占写权）' })
  const tiers = [
    ['热窗口（每品类独立）', '最近 8–12 轮原文 · 每品类 20–50K', '品类活跃时存在'],
    ['温摘要（每品类一份）', '溢出部分压成摘要 · 5–10K', '会长大，达上限再压'],
    ['冷经验（进记忆库）', '问题模式 → 解法 · 有界', '永久，带置信度衰减'],
  ]
  tiers.forEach(([t, d, life], i) => {
    s.box({
      x: 50, y: 92 + i * 108, w: 560, h: 92, color: T.mem, title: t,
      lines: [d, `生命周期：${life}`],
    })
  })
  s.arrow({ from: [330, 184], to: [330, 200], label: '溢出压缩' })
  s.arrow({ from: [330, 292], to: [330, 308], label: '再压缩' })
  s.note({ x: 50, y: 402, w: 560, color: T.ok, lines: ['上下文按品类隔离 → 成本不随总轮数增长，只随当前品类轮数增长'] })

  // 右上：请求组装顺序
  s.lane({ x: 660, y: 50, w: 700, h: 380, label: '单次请求的组装顺序（顺序固定，不可重排）' })
  const parts = [
    ['system 前缀', 'persona + 角色指令 + 工具说明 + 品类方法论（全静态）', T.ok],
    ['历史消息', '只追加，永不改写（工具结果也放这里）', T.ok],
    ['尾部注入', '记忆简报 / 上下文摘要 / 本轮要点（每轮都变）', T.warn],
    ['本轮用户消息', '用户原话（必须原文进，不能只给摘要）', T.err],
  ]
  parts.forEach(([t, d, c], i) => {
    s.box({ x: 690, y: 92 + i * 82, w: 640, h: 68, color: c, title: t, lines: wrap(d, 46), fontSize: 12 })
  })
  s.arrow({ from: [1010, 160], to: [1010, 174], label: '' })
  s.arrow({ from: [1010, 242], to: [1010, 256], label: '' })
  s.arrow({ from: [1010, 324], to: [1010, 338], label: '' })

  // 下：实测数据
  s.lane({ x: 20, y: 450, w: 1340, h: 190, label: '实测依据：记忆植入位置决定缓存代价（长历史 4128 tokens）' })
  const rows = [
    ['插到最前（system 之后）', '命中 18.5%', '未命中 3383 tokens', '$0.001015', T.err],
    ['追加到最尾', '命中 95.6%', '未命中 184 tokens', '$0.000055', T.ok],
    ['紧接最后一条 assistant（推荐）', '命中 94.4%', '未命中 228 tokens', '$0.000068', T.ok],
  ]
  s.text({ x: 60, y: 494, fontSize: 12, color: T.dim, lines: ['植入位置                                   缓存命中        未命中量              成本'] })
  rows.forEach(([pos, hit, miss, cost, c], i) => {
    const yy = 520 + i * 34
    s.parts.push(`<rect x="50" y="${yy - 16}" width="1280" height="30" rx="5" fill="#1a1f26"/>`)
    s.parts.push(`<text x="64" y="${yy + 4}" fill="${c}" font-size="12.5">${esc(pos)}</text>`)
    s.parts.push(`<text x="530" y="${yy + 4}" fill="${T.text}" font-size="12.5">${esc(hit)}</text>`)
    s.parts.push(`<text x="720" y="${yy + 4}" fill="${T.text}" font-size="12.5">${esc(miss)}</text>`)
    s.parts.push(`<text x="1000" y="${yy + 4}" fill="${c}" font-size="12.5">${esc(cost)}</text>`)
  })
  s.text({
    x: 60, y: 640, fontSize: 12, color: T.err,
    lines: ['结论：改前缀中部 = 未命中暴涨 18 倍。任何记忆/摘要只能尾部追加，绝不改写前缀（唯一例外：整块重建）'],
  })

  // 底部：双状态拦截
  s.lane({ x: 20, y: 656, w: 1340, h: 196, label: '双状态分路拦截：用户输入 vs 系统注入（按 source 标记判定，不靠内容猜）' })
  s.box({
    x: 60, y: 700, w: 600, h: 130, color: T.recv, title: '状态一：用户输入触发的回应',
    lines: ['· 入口标记 source = 真实用户提示', '· 出口：放行 → 用户可见', '· 需要回复预算、需要进度估算'],
  })
  s.box({
    x: 720, y: 700, w: 600, h: 130, color: T.mem, title: '状态二：系统注入触发的回应（记忆/上下文/简报）',
    lines: ['· 入口标记 source = inject 合成上下文', '· 出口：拦截，永不外发', '· 不需要回复预算，fire-and-forget，纯静默吸收'],
  })

  return s.save('04-memory-context.svg')
}

/* ────────────── 图 5：iOS/Android + 云端部署架构 ────────────── */

function diagram5() {
  const W = 1380
  const H = 980
  const s = new Svg(W, H, '图 5 · 客户端 + 云端部署：Flutter APP ⇄ 网关 ⇄ DSH 进程池')

  s.lane({ x: 20, y: 50, w: W - 40, h: 210, label: '一、客户端（Flutter，iOS + Android）：只负责接收与反馈，不含任何 agent 逻辑' })
  s.box({
    x: 60, y: 92, w: 400, h: 150, color: T.user, title: 'Flutter App（Dart）',
    lines: [
      '· 聊天界面：输入框 / 消息流 / 流式打字',
      '· 本地持久化会话 ID 映射（三段 ID，见下）',
      '· WebSocket 长连接 + SSE 回退 + 断线重连',
      '· 消息 ID 去重与乱序重排',
      '· 安全存储：令牌放 Keychain / Keystore',
    ],
  })
  s.box({
    x: 490, y: 92, w: 380, h: 150, color: T.user, title: '平台差异（必须分别处理）',
    lines: [
      '· iOS：后台限制严，切后台即断连 → 服务器继续跑',
      '· iOS：APNs 推送；Android：FCM',
      '· 两者都需要"回到前台拉取错过的消息"',
      '· 应用商店审核：需账号删除入口（若有登录）',
      '· 弱网：地铁/电梯场景必须能续传',
    ],
  })
  s.box({
    x: 900, y: 92, w: 420, h: 150, color: T.warn, title: '客户端只管两件事',
    lines: [
      '① 把用户输入送上去（带会话 ID）',
      '② 把服务端推来的内容显示出来',
      '',
      '不做：分类、记忆、进度估算、接管判决',
      '—— 全部在云端，客户端保持"笨"',
    ],
  })

  s.lane({ x: 20, y: 274, w: W - 40, h: 190, label: '二、网关层（自建，公网唯一入口）：DSH 原生没有多用户能力，这一层不可省' })
  const gw = [
    ['鉴权 / 令牌', ['登录、设备令牌、', '令牌轮换与吊销']],
    ['会话 ID 三段映射', ['客户端 convId →', 'DSH sessionId → 角色实例']],
    ['连接管理', ['WebSocket 长连接池、', '心跳、断连恢复、补发']],
    ['用户路由', ['userId → 该用户的', 'DSH 进程 socket']],
    ['限额与熔断', ['每用户 token 配额、', '429 退避、成本上限']],
    ['可观测性', ['轮级 trace（含', '缓存命中率、接管路径）']],
  ]
  gw.forEach(([t, d], i) => {
    s.box({ x: 60 + i * 212, y: 316, w: 196, h: 128, color: T.warn, title: t, lines: d, fontSize: 11 })
  })

  s.lane({ x: 20, y: 478, w: W - 40, h: 268, label: '三、云端 DSH Harness（所有 agent 都在这里）：按用户隔离的进程池' })
  s.box({
    x: 60, y: 520, w: 260, h: 100, color: T.app, title: 'DSH 进程（用户 A）',
    lines: ['DSH_HOME=data/u_A', '独立凭证、独立存储'],
  })
  s.box({
    x: 60, y: 632, w: 260, h: 100, color: T.app, title: 'DSH 进程（用户 B）',
    lines: ['DSH_HOME=data/u_B', '进程级天然隔离'],
  })
  s.box({
    x: 360, y: 520, w: 620, h: 212, color: T.app, title: '单个 DSH 进程内部的角色布局',
    lines: [
      '接收层 agent（快、在场）   处理层 agent × N（按类别，不扇出）   反馈层 agent（承接）',
      '常驻分类器（只判定）        控制器（APP 层逻辑，跑在本进程内）',
      '记忆库：档案 / 品类树 / 经验包 / 指标 / 证据链  ← 每用户一份',
      '',
      '进程内已有能力（已核实存在）：',
      '· 会话持久化 + 按 sessionId 恢复（resumeSessionId）',
      '· session/event 事件流、assistant/chunk（token 级）',
      '· agent.cancel / steer / inject / followup',
      '· WebSocket 下行 + SSE 流式（客户端连接的现成载体）',
      '· SQLite 会话查询（会话列表的来源）',
    ],
    fontSize: 12,
  })
  s.note({
    x: 1000, y: 520, w: 340, color: T.err,
    lines: [
      '⚠ 已核实：DSH 没有多租户身份',
      '· 无登录/令牌体系',
      '· anonymous-user-id 只用于遥测',
      '· authorization 是"工具授权"，不是用户鉴权',
      '· 凭证是每 DSH_HOME 一份（本地）',
      '· webserver 绑定仅 loopback / 全接口',
      '→ 对外暴露必须自建网关 + 反向代理',
    ],
  })

  s.lane({ x: 20, y: 760, w: W - 40, h: 190, label: '四、数据层' })
  const data = [
    ['会话正文', 'DSH 的 session.jsonl + SQLite 索引'],
    ['记忆库', '每用户一份：档案/品类树/经验/指标'],
    ['凭证', '云端保管，绝不下发到客户端'],
    ['配额与账单', '每用户 token 计量、成本上限'],
  ]
  data.forEach(([t, d], i) => {
    s.box({ x: 60 + i * 322, y: 800, w: 300, h: 120, color: T.recv, title: t, lines: wrap(d, 24), fontSize: 12 })
  })

  s.arrow({ from: [690, 242], to: [690, 316], label: '③ 客户端只认网关' })
  s.arrow({ from: [690, 444], to: [690, 520], label: '④ 网关按 userId 转发到对应进程' })

  return s.save('05-deployment.svg')
}

/* ───────────────────────── 主流程 ───────────────────────── */

const files = [diagram1(), diagram2(), diagram3(), diagram4(), diagram5()]
const viewer = buildHtmlViewer(files)
console.log('已生成：')
for (const f of files) console.log('  ' + path.relative(process.cwd(), f))
console.log('  ' + path.relative(process.cwd(), viewer) + '   ← 浏览器打开看全部图')

/* ─────────────── 生成 HTML 查看页（浏览器渲染，不依赖系统字体） ─────────────── */

function buildHtmlViewer(files) {
  const sections = files
    .map((f) => {
      const svg = fs.readFileSync(f, 'utf8').replace(/^<\?xml[^>]*\?>\s*/, '')
      const name = path.basename(f, '.svg')
      return `<section id="${name}"><h2>${name}</h2><div class="fig">${svg}</div></section>`
    })
    .join('\n')
  const nav = files
    .map((f) => {
      const n = path.basename(f, '.svg')
      return `<a href="#${n}">${n}</a>`
    })
    .join('\n')
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>个人 AI 助理 · 架构图</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0f14; color:#e6edf3;
         font-family:'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:9; background:#0f1419ee; backdrop-filter:blur(6px);
           border-bottom:1px solid #232c36; padding:14px 24px; }
  h1 { margin:0 0 8px; font-size:16px; }
  nav a { display:inline-block; margin-right:10px; padding:4px 10px; border-radius:6px;
          background:#1b2530; color:#8b949e; text-decoration:none; font-size:12px; }
  nav a:hover { background:#243040; color:#e6edf3; }
  main { padding:20px 24px 60px; }
  section { margin-bottom:36px; }
  h2 { font-size:13px; color:#8b949e; font-weight:600; margin:0 0 10px; }
  .fig { background:#0f1419; border:1px solid #232c36; border-radius:10px; overflow:auto; padding:6px; }
  .fig svg { display:block; max-width:100%; height:auto; }
</style></head>
<body>
<header>
  <h1>个人 AI 助理 · 架构图（链路完整性视图）</h1>
  <nav>${nav}</nav>
</header>
<main>
${sections}
</main>
</body></html>`
  const p = path.join(process.cwd(), 'docs', 'diagrams.html')
  fs.writeFileSync(p, html)
  return p
}
