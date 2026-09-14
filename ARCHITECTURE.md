# 个人 AI 助手 · 双层对话架构设计（v0.1）

> 目标：把「人 ↔ AI 对话」拆成**快层（留住用户）**与**深层（真正解决问题）**两条流水线，
> 并让深层的结论通过「接管（handoff）」回到主对话里，形成闭环。

---

## 0. 一句话结论

架构成立，但**不能有两个 assistant 在同一次生成里抢话说**。
DSH 的一轮（turn）只产出一条主 assistant 回复，所以"接管"必须落在两个合法时机之一：

| 时机 | 机制 | 体验 |
|---|---|---|
| 主 agent 这一步还没结束 | `agent.steer(...)` 在 step 边界注入 | 主 agent 说到一半**改口**接着说深层结论（真正的"半路接管"） |
| 主 agent 这一步已说完，turn 即将关闭 | `agent/turn-stopping` 钩子里 `steer` 拦住关闭 | 主 agent 留下一句"稍等"→ 深层结论作为**同一轮的后续**说出 |
| 主 agent 本轮已完全结束 | `agent.followup(...)` 开新轮 | 深层结论作为**新一条消息**出现（最安全、无阻塞） |

这三条路径由同一个 Handoff 模块按"深层结果是否已就绪 + 主 agent 是否还在跑"自动选择。

---

## 1. 术语映射（你的说法 → 工程名）

| 你的说法 | 本设计模块名 | 说明 |
|---|---|---|
| 主主 agent / 大入口 agent | **Front（前台常驻 agent）** | 就是现在这个对话 agent，人只跟它说话 |
| 主接收 | **Ingress（入口）** | 抓用户消息，不产出语言 |
| 快速简单回答 | **Reflex（反射层）** | 亚秒级确认，不深度思考 |
| 监控主对话框的 agent / 深度判断 | **Cortex（皮层）** | 并行深度思考 |
| 次 agent（分类） | **Router（分类器）** | 判品类 + 大类/子类 |
| 次次 agent（品类深研） | **Specialist（品类专家，可多个）** | 每品类一个，带经验继承 |
| 提炼成几句话 | **Synthesizer（提炼器）** | 压成一句/三句，可执行 |
| 回复的主 agent | **Telepathy → Handoff** | "另一个声音"接管同一条对话 |
| 主 agent 重新学习回复的话 | **Ledger（记忆/经验账本）** | 双写：对话记忆 + 品类经验 |
| 品类几百个、父子继承 | **Taxonomy（品类树）** | 大类经验 → 子类继承 |

---

## 2. 全局时序

```
用户说话
  │
  ├─(A)Ingress 抓取 ──┬────────────────────────────────────────────┐
  │                   │                                            │
  │            (B)Reflex 反射层                        (D)Cortex 皮层（并行）
  │            模板 or 小模型 <300ms                    分类 → 品类 → 深研 → 提炼
  │                   │                                            │
  │                   ▼                                            ▼
  │            ┌──────────────┐                            ┌──────────────┐
  │            │ 主线 agent   │                            │ 一句结论      │
  │            │ 先说"收到…"  │◀────(E)Handoff steer/inject─┤ (可执行)     │
  │            └──────────────┘                            └──────────────┘
  │                   │                                            │
  │                   ├──────────► 用户看到闭环回复 ◀──────────────┘
  │                   │                                            │
  │            (F)Ledger 落账：对话记忆 + 品类经验 + 指标
  │                   │
  └─────────────── 用户继续说 → 回到 (A)（含"主 agent 已记住接管内容"）
```

关键点：**Reflex 与 Cortex 同时起跑，谁都不等谁**。Reflex 负责"被听见"，Cortex 负责"被解决"。

---

## 3. 模块清单

### M1 Ingress（入口抓取）
- 监听 `agent/pre-step`（瀑布，能看到本轮进入 step 的 `messages`）与 `agent/inbox/inserted`。
- 识别"真正的用户输入"：`source.kind === 'user'`，排除插件注入、工具结果、steering 回流。
- 产出 `Utterance { id, sessionId, text, at, turnNo, intentHint }`，投递给 Reflex 与 Cortex 两路。
- **不做语言输出**，纯路由。

### M2 Reflex（反射层 · 亚秒确认）
- 双档：**0 延迟模板档**（问候/确认/等待/追问类，正则+意图规则，直接出话，~1ms）→ **小模型档**（复杂句用 `ctx.llm.stream()` 低 effort 小模型，300–800ms）。
- 输出风格：确认收到 + 复述要点 + 预告（"我听到你在问 X，我在想，稍等一句"）。
- 与主 agent 的关系：Reflex 的话**不新增 assistant 消息**（否则会话日志会出现两条主回复），而是作为 **steering/context 提示**喂给主线 agent，让主线 agent 用**自己的声音**说出这句确认。
  - 这样 GUI 只有一条回复流，保持"一个人的声音"。

### M3 Cortex（皮层 · 深度思考流水线）
三段串行、且可并行展开：
1. **Router 分类器**：输出 `{domain, category, subcategory, confidence, needTools, risk}`；低置信度 → 走"澄清问句"分支（此时 Reflex 的第二档会产出反问）。
2. **Taxonomy 检索**：从品类树取回该 `subcategory` 的既有经验 + 继承自 `category` 的经验 + 跨品类通用经验。
3. **Specialist 深研**：按 `needTools` 决定要不要开子 agent（`ctx.subagents.start`）并行取证；单品类单专家，可多专家并行再汇总。
4. **Synthesizer 提炼**：把深研结果压成 **1 句结论 +（可选）≤3 条要点 + 1 个下一步动作**，并给出"置信度 / 依赖假设"。

### M4 Handoff（接管合成）
- 输入：`Synthesized{oneLiner, bullets?, nextAction?, confidence, categoryPath}`。
- 决策表（自动选路）：
  - 主 agent `status === 'running'` → `agent.steer()`（半路接管，最贴近你的原意）
  - 主 agent 已 idle 但 turn 未关 → 在 `agent/turn-stopping` 里 `steer()`（拦截关闭）
  - 已 idle 且 turn 已关 → `agent.followup()`（新一条消息）
  - 超时（>N 秒未就绪）→ 只保留 Reflex 的"我还在算"，结论改用 followup 补发
- **防打断**：主 agent 正在调工具/写文件时不 steer，改为 `inject()` 排队，避免把工具调用切碎。
- 超时保护：Cortex 有 deadline（默认 8s），到点就用当前最优结论接管，绝不无限等。

### M5 Ledger（记忆与经验账本）
- **双重写**：
  1. *对话记忆*：本轮 `用户原话 → Reflex 确认 → 深层结论 → 用户后续反应`，作为主 agent 下一轮的上下文（对应你说的"主 agent 在听的时候就在重新学习"）。
  2. *品类经验*：按 `categoryPath` 落库 `{问题模式, 有效解法, 无效尝试, 耗时, 满意度}`，带**父子继承**与**置信度衰减**。
- 存储：JSON/SQLite 落盘（`~/.dsh/storages/` 或工作区 `data/`），与 session 日志分离，可被人审阅、可清空。

### M6 Telemetry（指标）
- 必测四项：`reflexLatency`（目标 p50 < 300ms）、`deepLatency`（p50 < 5s）、`handoffRate`（接管成功率）、`correctionRate`（用户纠正率，越低越好）。
- 没有这四项就无法判断"快层是否真的留住了用户、深层是否真的解决了问题"。

### M7 UI 观察窗（可选但推荐）
- 右侧栏插件面板（照抄 `dsh-imagegen` 的 client 双半结构）：实时显示 反射话术 / 分类结果 / 专家进度 / 生成中的一句结论 / 指标曲线。
- 开关：`reflexMode`（模板·小模型·关闭）、`handoffMode`（steer·followup·手动确认）、`cortexDeadlineMs`、品类树编辑器。

### M8 品类树（Taxonomy）
- 结构：`domain(10) → category(≈60) → subcategory(≈300)`，叶子上挂经验条目。
- 继承规则：子类先取子类经验 → 补父类经验 → 补全局通用经验；冲突时子类优先。
- 冷启动：先用 LLM 生成初始树（几百个叶子），再由真实对话**自动长新叶**（低置信度分类时提议新子类，人工确认后落库）。

---

## 4. 宿主映射（DSH 实体对照）

| 本设计 | DSH 实现载体 |
|---|---|
| Front agent | 现有会话 agent（不用改），我们只挂监听 |
| Reflex 小模型 | `ctx.llm.stream({provider, model, messages, system})`（手搓一次性调用） |
| Specialist | `ctx.subagents.start(...)` / `startContinuable(...)` |
| 抓取用户输入 | `agent/pre-step`（waterfall）+ `agent/inbox/inserted` |
| 半路接管 | `agent.steer(UserMessage)`（source 用 `{kind:'plugin', plugin:'concierge'}`） |
| 轮末拦截接管 | `agent/turn-stopping` 内 `steer` |
| 跨轮补发 | `agent.followup(UserMessage)` |
| 观察生成流 | `llm/stream`（waterfall，可只读） |
| 拿 agent 句柄 | `ctx.agents.get(sessionId)` |
| 配置/密钥/开关 | `installSettingsSection` + Web 设置卡 |
| 面板 UI | `dsh.client` 双半插件（host + `/plugins/<id>/client.js`） |
| 给模型的自我说明 | `systemPrompt` 公告段 |

插件形态：一个本地包 `dsh-concierge`，加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，
宿主半边（exports "."）+ 浏览器半边（exports "./client"），与 `@dickpy/dsh-imagegen` 同构。

---

## 5. 可行性红线（必须先接受的事实）

1. **一轮一条主回复**：无法在同一 turn 里让 Reflex 和 Front 各发一条 assistant 消息（会话日志可重构性约束）。
   → 折中：Reflex 只提供**话术与时机**，仍由 Front agent 用自己的口吻说出。好处是"一个声音"，坏处是快层受主 agent 首 token 速度限制。
2. **首 token 延迟无法被我们消除**：主 agent 仍要过一次大模型。若要求"0.5 秒内必须出现人话"，
   唯一办法是 Reflex 走**独立输出通道**（如 GUI 侧栏气泡 / 系统提示条），这需要新增 client 层渲染，属于"双通道方案"，见第 8 节决策点。
3. **steer 只有边界生效**：正在流式输出的 token 无法被中途替换，只能在下一个 step 边界改口。
4. **Cortex 有超时**：无限等待会锁住一轮对话，必须设 deadline + 降级话术。
5. **成本**：每条消息至少 1 次小模型 + 1 次分类 + N 次专家调用，成本约为朴素对话的 3–8 倍；必须靠品类经验缓存把重复问题降到 ~1 次调用。

---

## 6. 分阶段落地

| 阶段 | 交付 | 可验收效果 |
|---|---|---|
| P0 | 骨架插件 + Ingress + Reflex 模板档 + 设置卡 | 用户消息进来，反射话术立即生效，开关可切 |
| P1 | Cortex（Router + Synthesizer）+ Handoff（steer/followup 三路） | 端到端闭环：确认 → 深度结论接管 |
| P2 | Ledger + Taxonomy 冷启动 + 经验继承 | 重复问题变快；经验可查看可编辑 |
| P3 | UI 面板（进度+指标）+ Telemetry | 可量化调优，能看到接管全过程 |
| P4 | 多专家并行 + 澄清分支 + 风险/权限策略 | 复杂问题质量提升 |

---

## 7. 验收标准（建议）
- 反射延迟 p50 < 300ms（模板档）/ < 900ms（小模型档）
- 深度结论 p50 < 5s，超时率 < 5%
- 接管后用户**连续追问同一问题**的比例下降（说明真的答到点上）
- 同一子类第二次提问的耗时显著低于第一次（经验生效的证据）

---

## 8. 待你拍板的三个点

1. **快层输出通道**：只走主 agent 的口吻（单一声音、首 token 受限）／还是额外开 GUI 侧栏气泡（真 0.5 秒、但两个视觉通道）？
2. **接管策略默认值**：激进（running 就 steer，半路改口）／稳健（先说完再 followup 补一条）／手动确认。
3. **落地形态**：直接做成本机 DSH 插件（和 AI 生图、小说助手并列在侧边栏）／还是先在工作区里做一个可跑的独立原型验证闭环？
