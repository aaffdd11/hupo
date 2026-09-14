/**
 * 宿主抽象层：把「主 agent」抽象成 HostAdapter，原型与 DSH 插件共用同一套 Handoff 逻辑。
 *
 * 真实 DSH 侧的映射（插件化时替换本文件的实现即可）：
 *   isRunning() → agent.status === 'running'
 *   steer()     → agent.steer(createUserMessage({ content, source: { kind: 'plugin', plugin: 'concierge' } }))
 *   inject()    → agent.inject(...)
 *   followup()  → agent.followup(...)
 *
 * 假宿主（FakeHost）用定时器模拟一条"主 agent 正在说话"的流，用来在无 DSH 环境下
 * 验证接管的时机与观感：跑着 → steer 半路改口；调工具 → inject 排队；空闲 → followup 开新轮。
 */

/** 宿主适配器接口（JSDoc 契约）。 */
export class HostAdapter {
  /** @returns {'idle'|'running-tools'|'running-text'} */
  status() {
    throw new Error('not implemented')
  }

  /**
   * 主 agent 已经说出口的正文。
   *
   * ⚠ 真实宿主里这个方法今天**没有生产来源**（基类返回空串，只有 FakeHost 有实现）——
   * 这是三轮评审共同指出的地基缺口。正确的定义是
   * `emittedText := 控制器已放行的文本`（见 `DEBATE-arch-vs-pm.md`），必须逐轮落盘。
   */
  spokenText() {
    return ''
  }

  /** 半路接管：在下一个 step 边界注入，主 agent 用它自己的口吻接着说。 */
  async steer(_payload) {
    throw new Error('not implemented')
  }

  /** 排队注入：不打断当前工具调用，下一个 step 再交给主 agent。 */
  async inject(_payload) {
    throw new Error('not implemented')
  }

  /** 开新轮补发：最安全，绝不打断也绝不死锁。 */
  async followup(_payload) {
    throw new Error('not implemented')
  }
}

/**
 * 假宿主：模拟主 agent 的一次回复。
 * 用 `script` 描述这轮主 agent 的行为，例如：
 *   { tokens: ['收到，', '我看看…'], tokenMs: 120, toolMs: 0 }
 *   { tokens: ['我先查一下…'], tokenMs: 100, toolMs: 1500 }  // 中途调工具
 */
export class FakeHost extends HostAdapter {
  constructor({ sessionId = 'demo-session', log = () => {} } = {}) {
    super()
    this.sessionId = sessionId
    this.log = log
    this.state = 'idle'
    this.text = ''
    this.turns = 0
    /** @type {Array<object>} 交付记录 */
    this.deliveries = []
  }

  status() {
    return this.state
  }

  spokenText() {
    return this.text
  }

  /**
   * 跑一轮"主 agent"回复。
   * @param {object} script
   * @param {string[]} script.tokens 主 agent 会说的话（先说的部分）
   * @param {number} script.tokenMs 每个 token 的间隔（模拟首 token 与流式延迟）
   * @param {number} [script.toolMs] 说完之后进入工具调用的时长
   * @param {number} [script.holdMs] 工具结束后、turn 关闭前继续等待的时长
   * @param {AbortSignal} [script.signal]
   */
  async runMainAgent(script) {
    const { tokens = ['收到，', '我先应一声…'], tokenMs = 120, toolMs = 0, holdMs = 0, signal } = script
    this.turns += 1
    const turnNo = this.turns
    this.text = ''
    this.state = 'running-text'
    const said = []

    for (const token of tokens) {
      await sleep(tokenMs, signal)
      this.text += token
      said.push(token)
      this.log({ kind: 'main-token', turnNo, token, text: this.text })
    }

    if (toolMs > 0) {
      this.state = 'running-tools'
      this.log({ kind: 'main-tool-start', turnNo })
      await sleep(toolMs, signal)
      this.log({ kind: 'main-tool-end', turnNo })
      this.state = 'running-text'
    }

    if (holdMs > 0) await sleep(holdMs, signal)
    this.state = 'idle'
    this.log({ kind: 'main-turn-close', turnNo, text: this.text })
    return { turnNo, said, text: this.text }
  }

  /**
   * 半路接管：主 agent 改口，把结论接着说出来（模拟 step 边界注入）。
   *
   * ⚠ 两个已知偏差（三轮评审指出，原型阶段保留但必须在文档里写明）：
   * ① 真实宿主的 steer 只在 **step 边界**被消费（`dsh-agent/README.md`：next step boundary），
   *    而本方法在任意时刻都能插入 ⇒ 原型里的"半句切换"是模拟产物，不是真实行为；
   * ② 追加的内容应当由**同一个 agent 重新生成**（带着已输出全文），而不是把控制器
   *    写好的字符串直接拼接 —— 后者等于控制器在写台词。
   * 生产实现必须以"step 边界投递 + 反馈层生成"为准。
   */
  async steer({ text, reason }) {
    const record = {
      action: 'steer', text, reason, at: Date.now(), spokenBefore: this.text, turnNo: this.turns,
      simulated: true,
    }
    this.deliveries.push(record)
    this.text += text
    this.log({ kind: 'handoff-steer', turnNo: this.turns, text, spokenBefore: record.spokenBefore, reason })
    return record
  }

  /** 排队注入：当前工具调用不被打断，等下一个边界再交给主 agent。 */
  async inject({ text, reason }) {
    const record = {
      action: 'inject', text, reason, at: Date.now(), spokenBefore: this.text, turnNo: this.turns,
      simulated: true,
    }
    this.deliveries.push(record)
    this.text += text
    this.log({ kind: 'handoff-inject', turnNo: this.turns, text, reason })
    return record
  }

  /** 开新轮补发。 */
  async followup({ text, reason }) {
    const record = { action: 'followup', text, reason, at: Date.now(), turnNo: this.turns + 1, simulated: true }
    this.deliveries.push(record)
    this.log({ kind: 'handoff-followup', turnNo: this.turns + 1, text, reason })
    return record
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}
