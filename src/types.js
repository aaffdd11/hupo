/**
 * 领域模型的 JSDoc 类型定义（纯注释，运行时无副作用）。
 *
 * @typedef {object} Utterance 一次用户输入
 * @property {string} id
 * @property {string} sessionId
 * @property {string} text          用户原话
 * @property {number} at            时间戳
 * @property {number} turnNo        第几轮
 *
 * @typedef {object} ReflexResult Reflex 快层产物
 * @property {string} text          确认话术（会交给主 agent 用它自己的口吻说出）
 * @property {'template'|'model'} source
 * @property {number} latencyMs
 *
 * @typedef {object} Classification Router 分类产物
 * @property {string} domain        领域
 * @property {string} category      大类
 * @property {string} subcategory   子类
 * @property {number} confidence    0..1
 * @property {boolean} needTools    是否需要工具/取证
 * @property {boolean} needsClarify 是否信息不足、应先澄清
 * @property {string} restated      一句话复述用户意图
 *
 * @typedef {object} Synthesis Synthesizer 提炼产物
 * @property {string} oneLiner      一句话结论
 * @property {string[]} bullets     可选要点（≤3）
 * @property {string} nextAction    下一步动作（可为空）
 * @property {number} confidence
 * @property {string} categoryPath  domain/category/subcategory
 * @property {'full'|'degraded'|'clarify'} mode  full=专家结论 / degraded=超时降级 / clarify=先澄清
 *
 * @typedef {object} Experience 一条品类经验
 * @property {string} id
 * @property {string} path          归属品类路径
 * @property {string} pattern       问题模式
 * @property {string} solution      有效解法
 * @property {string} [pitfall]     无效尝试 / 坑
 * @property {number} hits          命中次数
 * @property {number} confidence    0..1（随命中上升、随时间衰减）
 * @property {number} updatedAt
 *
 * @typedef {object} HandoffPlan Handoff 决策
 * @property {'steer'|'inject'|'followup'} action
 * @property {string} reason
 *
 * @typedef {object} Tick 一轮完整闭环的结果
 * @property {Utterance} utterance
 * @property {ReflexResult} reflex
 * @property {Classification} classification
 * @property {Synthesis} synthesis
 * @property {HandoffPlan} handoff
 * @property {object} timings      各阶段耗时
 * @property {object} ledger       账本命中情况
 */

export {}
