# 个人 AI 助手 · 双层对话架构原型

把你描述的架构做成**可跑的闭环原型**：一个主 agent 负责"留住用户"，另一条流水线负责"真正解决问题"，
两条线同时起跑，深层结论再通过**接管**回到同一条对话里。

设计文档见 [`ARCHITECTURE.md`](ARCHITECTURE.md)（含与 DSH 宿主扩展点的映射）。

```
用户说话
  │
  ├─(A)Ingress 抓取 ──┬──────────────────────────────────────────┐
  │                   │                                          │
  │            (B)Reflex 快层                      (D)Cortex 皮层（并行）
  │            模板 ~0ms / 小模型 ~0.9s             分类 → 品类 → 召回经验 → 专家深研 → 提炼
  │                   │                                          │
  │                   ▼                                          ▼
  │            ┌──────────────┐                          ┌──────────────┐
  │            │  主 agent    │◀──(E)Handoff 接管─────────┤ 一句结论      │
  │            │ 先确认"收到" │   steer/inject/followup   │ （可执行）    │
  │            └──────────────┘                          └──────────────┘
  │                   │
  │            (F)Ledger 双写：对话记忆 + 品类经验（父子继承）
  └─────────── 用户继续说 → 回到 (A)
```

## 快速开始

```bash
cd /home/deploy/projects/assistant

npm run demo:fake     # 离线跑通闭环，看三种接管方式（推荐先跑这个）
npm run demo          # 接真模型（自动读 ~/.dsh/.credentials.yaml 里的密钥）
npm test              # 18 个单元 + 集成测试
node scripts/bench-real.js   # 真模型对拍：快层 vs 深层延迟
```

零依赖（只用 Node 内置能力），Node ≥ 20。

## 实测数据（deepseek 官方接口，2026-09 本机）

### 快层 vs 深层：双层架构到底值不值

| 项目 | 延迟 | 说明 |
|---|---|---|
| Reflex 模板档 | **~0ms** | 问候/确认/致谢/催促/极短输入，不调模型 |
| Reflex 小模型档 | **0.75–1.35s**（多次对拍 p50 0.80–0.98s） | `deepseek-flash` + `reasoning_effort=none` |
| Cortex 深层 | **p50 7.2–7.9s** | 分类 + 专家深研 + 提炼 |
| 多层复用后 | **~1.5s** | 同名/同类问题走经验直出，0 位专家 |
| 倍数 | **~9x** | 这就是"两层"存在的理由 |

关键发现：**`reasoning_effort: "none"` 能完全关掉思考**（reasoning tokens = 0）。
快层必须用它；实测带思考的档位反而更慢且会产出空 content。

### 提炼阶段用什么模型：本原型最值钱的一条调参结论

4 条真实问题对拍：

| 配置 | 提炼单次 | 流水线 p50 | 交付结果 |
|---|---|---|---|
| 提炼 = `deepseek-v4-pro` / medium | ~5.5s | 12.0s | **4/4 全部超时降级** |
| 提炼 = `deepseek-flash` / none | ~1.3s | **6.5s** | **4/4 全部满质量** |

提炼是"压缩"任务而不是"推理"任务，用快模型反而更稳。默认配置已按此设定。

### 经验复用：把重复问题的成本压回去

同一个问题问第三次（改述版）：

| 轮次 | 延迟 | 经验命中 | 专家数 | 路径 |
|---|---|---|---|---|
| 第一次问 | 6.5s | 0 | 2 位 | 全流水线 |
| 第二次问（原话） | 7.7s | 1 | 2 位 | 全流水线（只是带着经验去问） |
| 第三次问（改述） | **1.5s** | 1 | **0 位** | 经验直出 |

品类树从 55 个叶子自动长出 `技术/编程/接口故障排查` 这类真实叶子，之后同类问题直接命中。
**这就是把 3–8 倍成本压回接近 1 次调用的关键。**

### 接管路径在真实时序下的发生条件

`hybrid` 模式的规则很简单：**跑着就 steer、调工具就 inject、空闲就 followup**。
但实测有个反直觉的点：

> 皮层（~0.9s）常常**比主 agent 说出第一个字还快**——
> 主 agent 首 token 本身就要 0.8–1.5s。所以绝大多数轮次走的是 **steer**。

`inject` 路径要真正发生，需要主 agent 已经在调工具（判定到第二个 token 之前就进工具、或工具调用较长）。
因此本原型提供两个可选的"节奏"配置：

- `deferWhileThinking`：主 agent 还没开口时不抢话，等它开口/进工具再交付（更自然，用户多等一会儿）
- `handoffMode: always-inject / always-steer / safe-followup`：强制走某一路，便于对比与压测

## 配置

全部可用环境变量覆盖（默认值已是实测最优）：

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `CONCIERGE_API_KEY` | `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY` | API 密钥 |
| `CONCIERGE_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点 |
| `CONCIERGE_FAST_MODEL` | `deepseek-flash` | 快层（Reflex / Router） |
| `CONCIERGE_DEEP_MODEL` | `deepseek-v4-pro` | 专家模型 |
| `CONCIERGE_EXPERT_EFFORT` | `low` | 专家思考强度（high 更慢） |
| `CONCIERGE_SYNTH_MODEL` | `deepseek-flash` | 提炼模型 |
| `CONCIERGE_SYNTH_EFFORT` | `none` | 提炼思考强度 |
| `CONCIERGE_EXPERT_ANGLES` | `2` | 并行专家视角数（1 最省时） |
| `CONCIERGE_CORTEX_DEADLINE_MS` | `25000` | 皮层硬超时，到点降级交付 |
| `CONCIERGE_HANDOFF_MODE` | `hybrid` | `hybrid` / `always-steer` / `always-inject` / `safe-followup` |
| `CONCIERGE_DEFER_THINKING` | `0` | 置 1 开启"不抢话"节奏 |

## 四个核心指标

`data/metrics.jsonl` 每轮落一笔，`npm run demo` 末尾汇总：

| 指标 | 目标 | 为什么测它 |
|---|---|---|
| `reflexLatency` | 模板档 < 300ms | 快层是否真的"留住用户" |
| `deepLatency` | p50 < 7s | 深层是否在用户忍耐范围内 |
| `handoffRate` | 越高越好 | 深层结论是否真的送达 |
| `correctionRate` | 越低越好 | 深层是否真的**答到点上**（只在有反馈的轮次里算） |

## 模块结构

| 文件 | 职责 |
|---|---|
| `src/reflex.js` | 快层：模板档 + 小模型档，只产话术不产消息 |
| `src/cortex.js` | 皮层：Router 分类 → 品类归一化 → 经验召回 → 专家深研 → 提炼 |
| `src/taxonomy.js` | 品类树（domain/category/subcategory），含三级兜底与父子继承 |
| `src/ledger.js` | 账本：对话记忆 + 品类经验，带置信度衰减与加固 |
| `src/handoff.js` | 接管决策与拼装（三路 + 两个节奏策略） |
| `src/host.js` | 宿主抽象：`FakeHost` 用定时器模拟主 agent 说话 |
| `src/orchestrator.js` | 把上面串成一轮闭环，产出四指标 |
| `src/metrics.js` | 指标采集与分位数汇总 |
| `src/llm.js` | OpenAI 兼容客户端 + 可离线假模型 |

## 实测中踩到并修掉的坑

这些都是真模型跑出来的，不是设计时想到的：

1. **经验张冠李戴**：问"跟客户解释延期"复用了"失眠"的答案。
   根因：分类掉到通用兜底路径，而经验命中的正是同一个兜底路径。
   修法：① 通用兜底路径的经验**不沉淀**；② 品类树加领域/大类级的模糊兜底，不再一不匹配就掉全局；
   ③ 经验复用前必须过**表面相似度闸门**（覆盖率 0.6 + Jaccard 0.4 的混合，阈值 0.18）。
2. **经验复用链整条失效**：品类树里没有任何经验（`experiences: 0`），重复问题永远走全流水线。
   根因：分类器输出 `技术/后端开发/接口故障排查`（把握 0.95），树里只有 `技术/编程/…`，
   "不精确匹配就掉全局兜底"把分类器的高把握判断整个丢掉了。
   修法：品类树加 5 级兜底（精确叶子 → 精确大类 → 大类名模糊 → 领域已知时取最相近大类 → 全局）。
3. **沉淀路径与召回路径不一致**：第二次问同类问题仍然召回 0 条。
   根因：本次只能"借用"已有叶子，经验记在借用路径上，而新叶登记的是另一个路径，两边对不上。
   修法：**先把新叶登记好，再把经验记到新叶路径上**。
4. **降级率 100%**：提炼阶段用 pro/medium 单次 ~5.5s，整条流水线撞上超时。
   修法：提炼换 flash/none，p50 12.0s → 6.5s，降级率归零。
5. **指标被稀释**：纠正率的分母混进了没有用户反馈的轮次，算出假低值。
   修法：纠正率只在"用户给过反馈的轮次"里算。

## 下一步（插件化路径）

原型刻意把"宿主"抽象成 `HostAdapter`，插件化时只需替换这一层的实现：

| 本原型 | DSH 插件里的写法 |
|---|---|
| `host.status()` | `agent.status === 'running'` |
| `host.steer()` | `agent.steer(createUserMessage({ content, source: { kind: 'plugin', plugin: 'concierge' } }))` |
| `host.inject()` | `agent.inject(...)` |
| `host.followup()` | `agent.followup(...)` |
| 抓用户输入 | `agent/pre-step` 瀑布 + `agent/inbox/inserted` |
| 轮末拦截 | `agent/turn-stopping` 内 `steer`，拦住 turn 关闭 |
| 专家深研 | `ctx.subagents.start(...)` 换成真子 agent（现在是并行模型调用） |
| 快层小模型 | `ctx.llm.stream()`（现在是直连 fetch） |
| UI 面板 | `dsh.client` 双半插件，与 `@dickpy/dsh-imagegen` 同构 |

分阶段：P0 骨架+Reflex → P1 Cortex+Handoff → P2 Ledger+品类树 → P3 面板+指标 → P4 多专家并行+权限策略。
