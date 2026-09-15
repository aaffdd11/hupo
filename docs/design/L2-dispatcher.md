# L2 调度层 · 子架构（`services/core`）

> **契约来源**：`ARCHITECTURE-v7.md` §3（本文出现的标识符一律照抄它，不一致以它为准）、
> §4 时序、§6 不变量、§9 容量与准入、§10 安全模型、§11 成本、§12 可观测性、§13 分期。
> **拍板依据**：`docs/pm-panel/DECISIONS.md`（第 3/4/5/10/11 条直接决定本文的准入、预算、续做、备份）。
> **本文只写 L2**。L1（终端）与 L3（工作层/知识层）各有一份，边界在 §1 末尾写清。
>
> 数值一律标注：**实测**（本机量出来的）／**推定**（有依据但没量）／**沿用**（沿用现有代码或配置）。

---

## 一、模块与文件布局

`services/core/src/`，全部为 ESM。状态标记：✅ 保持 ｜ ⚠️ 改造 ｜ ➕ 新增。

| 文件 | 状态 | 一句话职责 | 导出 |
|---|---|---|---|
| `index.js` | ⚠️ 改造 | 入口：读配置 → 起服务 → 启动横幅 → 信号处理 | *(无导出，顶层执行)* |
| `server.js` | ⚠️ 改造 | HTTP 路由 + WS 升级 + 鉴权前置 + 刷新令 | `createServer(cfg)` |
| `config.js` | ⚠️ 改造 | 全部配置的**唯一来源**（§12 是它的全表） | `loadConfig(overrides)` |
| `auth.js` | ⚠️ 改造 | scrypt 口令 + HMAC 无状态令牌 + 限速 + **fail-closed** | `Auth`、`tokenFromRequest`、`WS_AUTH_PROTOCOL`、`passwordProblem` |
| `store.js` | ⚠️ 改造 | 事件流落盘（**写失败必须上抛**） | `Store`、`toTranscript`、`renderTranscript` |
| `conversation.js` | ✅ 保持 | 会话日志 / `MessageWriter` / 时间线流水 / 分段器 | `Conversation`、`restoreConversation`、`MessageWriter`、`makeSegmenter`、`timelineContext`、`newId` |
| `session-translate.js` | ✅ 保持 | agent 事件 → 产品事件（含非正常收尾识别） | `TurnTranslator`、`looksLikeUnsourcedClaim`、`plainText` |
| `dispatcher.js` | ⚠️ 改造 | 节奏 + 账本 + 对账续做 + 准入/预算/策略的**调用方** | `Dispatcher`、`recapPrompt` |
| `agent-runtime.js` | ⚠️ 改造 | 进程池 + spawn 契约 + LRU 回收 + 遥测 | `AgentSession`、`AgentRuntime`、`readRssBytes` |
| `debug-agent.js` | ✅ 保持 | 监控层：计量（免费）+ 语义判断（花钱）+ 任务簿 | `DebugAgent`、`TaskBook`、`computeTimeliness`、`ruleFindings`、`stuckTasks`、`THRESHOLDS` |
| `personality.js` | ✅ 保持 | 主人说话画像（纯统计）与舒适度检测 | `PersonalityStore`、`profileFromRows`、`comfortFindings`、`personalityBlock` |
| `client-build.js` | ✅ 保持 | 整包构建指纹（决定要不要让客户端刷新） | `ClientBuild` |
| **`admission.js`** | ➕ 新增 | 内存闸（§4）+ 拒绝话术 | `Admission` |
| **`budget.js`** | ➕ 新增 | 成本三级状态机 + 轮内计数（§5） | `Budget`、`BUDGET_LEVELS` |
| **`policy.js`** | ➕ 新增 | 来源分级 → 能力档；taint 状态（**只在 host 清**） | `Policy`、`SOURCE_LEVELS`、`ROLES` |
| **`tracer.js`** | ➕ 新增 | 每轮 trace + 周期采样 + 健康快照（§11） | `Tracer` |
| **`audit.js`** | ➕ 新增 | 系统级动作审计（**root 属主 append-only**） | `Audit` |
| **`apps.js`** | ➕ 新增 | 制品库：清单 / 上传（特权口）/ 版本指针 / hash | `AppStore` |
| **`kv.js`** | ➕ 新增（S4） | `facts` 表（带 `source` / `trust`） | `KvStore` |

**保持不动的运维探针**（不属于 L2 运行时，但会因接口变更而受影响，见 §13）：
`watch.mjs`、`browser-check.mjs`、`e2e.mjs`、`probe-login.mjs`、`auth-cli.mjs`、`reload-probe.mjs`、`smoke.mjs`、`listen-demo.mjs`、`cmp.mjs`、`sdk-spike.mjs`。

**模块依赖方向（单向，不许反向）**

```
index.js → server.js → { dispatcher, auth, client-build }
                          dispatcher → { admission, budget, policy, tracer, audit, apps, kv,
                                         conversation, session-translate, agent-runtime, debug-agent, store }
                          agent-runtime → { policy(只读 role→patch 映射), tracer(采样) }
```
⚠ 反向依赖会让 §13 的门禁跑不起来（`admission`/`budget`/`policy` 必须能单测，不许 require `dispatcher`）。

**与 L1 / L3 的边界**

| 边界 | 谁定 | 本文管到哪 |
|---|---|---|
| `L1 ⇄ L2` 的 HTTP/WS | v7 §3.2 / §3.3 | 路由、鉴权、事件构造（§10、§11）；**不管**客户端渲染 |
| `L2 ⇄ L3` 的 stdio JSON-RPC | v7 §3.4 | spawn 契约、role、env 白名单（§6）；**不管** agent 内部循环 |
| 制品 | v7 §4.4 | 清单/上传/版本/指针/审计（§9）；**不管** L1 的沙箱与下载 |
| `facts` | v7 §4.5 | 读写接口与采信过滤（§14 提到的 S4）；**不管** 装配进 prompt 的具体文本（L3） |

---

## 二、启动序列

`index.js` 到 `server.listen()` 之间是**串行十步**。每一步都写清失败怎么办。

| # | 步骤 | 失败怎么办 |
|---|---|---|
| 1 | `loadConfig()` | 配置本身不合法（端口非数、path 空）⇒ **打日志 + `process.exit(1)`**。systemd 会重启；`hupo-crash-guard`（步 5）会在第二次就发现 |
| 2 | **策略完整性校验**（`policy.verifyPolicy()`） | 人格 / `settings.yaml` / profile patch / 画像 / `AGENTS.md` 的哈希清单（清单放 root-only 路径）任一项不一致 ⇒ **拒绝启动**（`exit(1)`）+ 写 `data/.health.json` + 告警。逃生开关 `CONCIERGE_POLICY_INSECURE=1`（打大字警告，生产禁静默）。依据：v7 §10.2 / N5 |
| 3 | `new Store(dataDir)` | 目录建不出来 / 不可写 ⇒ **立刻失败退出**（不许像现在那样 `catch{}` 静默）。依据：N7——写不进去的记录比没有记录更危险 |
| 4 | `new Auth(dataDir)` + fail-closed 判定 | **口令缺失不再是"全放行"**：`enabled && !hasPassword` ⇒ 服务照起，但除 `/api/auth` `/api/login` `/api/version` 外一律 **503**；`/api/auth` 返回 `{required:true, needsSetup:true}`，界面直接显示"去设置口令"。依据：拍板 S0 + v7 §3.2 |
| 5 | **崩溃守护**（`hupo-crash-guard`，可作为 `ExecStartPre` 或启动第一步） | 读 `data/.crashloop.json`：5 分钟内 ≥3 次启动 **且** `journalctl -u concierge-core -n 50` 里有 `oom-kill` ⇒ 置 `CONCIERGE_SKIP_RESUME=1` + 落 `data/.degraded` + 记一条待发消息。**降级启动**：不续做、不预热，只服务对话。依据：拍板第 1 条 / v7 §4.3 |
| 6 | **恢复事件流** | `store.list()` 改读**尾部 4KB** 取最后时间戳（现状是全量 `read()+parse`，O(会话数×事件数)，与"3 秒自愈"冲突）；逐会话 `restoreConversation()`，内存里只留**最近 2000 条**，更早的在需要时按需分页。单个会话读失败 ⇒ 跳过它 + 记 `dev/step` 错误，**不阻断启动** |
| 7 | **对账续做**（`#reconcileTasks`） | 规则见 §8。任何异常都**不得阻断启动**：`try/catch` 包住，失败就只落 `data/.health.json` 的一条 `resumeError` |
| 8 | 起定时器 | `ClientBuild.start()`（poll 5s）、`startAgentTelemetry(3000)`、`hupo-sampler` 由 systemd timer 管（不在进程内）、空闲回收由 `agent-runtime` 自己 arm |
| 9 | 写 `data/.last-good.json` | **运行满 60 秒且无崩溃**才写（`{commit, startedAt}`）。它是 §8 自动回滚的锚点 |
| 10 | `server.listen(cfg.port, '127.0.0.1')` | 端口被占 ⇒ `exit(1)`（systemd 重启；若反复失败，crash-guard 会进降级） |

**启动横幅要改**：现在是"鉴权未生效"的裸奔警告（`index.js` 19–29 行）。fail-closed 之后**这种情况不再可能进入服务态**，
横幅改成报告状态：`鉴权 fail-closed（未设口令，仅三公开路由）`／`鉴权 ✓`／`降级启动（跳过续做）`／`策略校验 ✗`。

---

## 三、会话与账本

### 3.1 `Conversation` 数据结构

| 字段 | 类型 | 用途 | 不变量 |
|---|---|---|---|
| `id` | string | `u_<userId>:c_<name>`（v7 §3.1；存量 `c_main`/`c_probe` 走兼容映射） | 唯一 |
| `seq` | number | **会话内**单调递增（不是全局） | 严格 +1，任何事件都占一个 |
| `log` | object[] | 完整事件日志（内存） | 只追加；前缀**字节不变**（R2） |
| `subscribers` / `devSubscribers` | Set | 产品订阅 / 开发订阅 | dev 是**附加**，绝不挤掉产品订阅（已有回归测试） |
| `devSteps` | object[] | 后台活动流水 | 上限 60 条（现状）；快照另走 `emitDevSnapshot` |
| `messages` | Map | `messageId → 累积文本`（"用户实际看到了什么"） | 由 `MessageWriter.chunk` 维护 |
| `tasks` | Map | 正在做的事 | `task/created` 建、`task/completed` 消 |
| `queue` / `busy` | array / bool | **声称**"连续发言排队、不并发抢话" | ⚠️ **现状是死代码**（全仓库无读写）。S0 必须真正实现，见 3.4 |

`emit()` 是**唯一**分配 `at` 与 `seq` 的地方（R11）：`{ at: Date.now(), ...event, seq: ++this.seq }`。
调用方自带了 `at`（客户端时钟）就以调用方为准。

四种发送语义（不许混）：

| 方法 | 进日志 | 落盘 | 补发 | 用途 |
|---|---|---|---|---|
| `emit(event)` | ✅ | ✅ | ✅ | 产品事件（正史） |
| `emitTransient(event)` | ❌ | ❌ | ❌ | 只在现场（`client/reload`） |
| `emitDev(event)` | ❌ | ❌ | ✅（`replayDev`） | 开发流水 |
| `emitDevSnapshot(payload)` | ❌ | ❌ | ❌ | 进程状态快照（只有"现在"有意义） |

### 3.2 `MessageWriter` 状态机

```
新建 → started=false, ended=false, blockSeq={quick:0,deep:0}, text=''
chunk(block,text,final) ──► start() 惰性触发（首个 chunk/status/error/end 都会 start）
end(reason)             ──► ended=true（幂等；重复调用无副作用）
```

铁律：
1. **`end()` 里的 `sources` 覆盖 `start()` 里的**（R8）：agent 先说"收到，我去查"时还没有来源。
2. **`start()` 不写正文**：空气泡只在"确实要说话"时才开（`#escalate` 里"没说过话就不收口"就是这条）。
3. `reason` 不是装饰：`session-translate._closeTurn` 依据 agent 的 `turn/end.reason.kind` 决定
   是否补一句（`max-tokens` → `TOO_LONG_LINE`；其他非 `completed` → `INTERRUPTED_LINE`），
   并把 `message/end.reason` 标成 `failed`。**半句绝不冒充完整回答**。

### 3.3 账本：`task/created → completed` 配对

| 规则 | 内容 |
|---|---|
| 建 | `task/created{taskId, messageId, title, prompt, at}`；`title` 面向用户（**用主人自己的话**截 24 字），`prompt` 存**原话**（续做要靠它） |
| 消 | `task/completed{taskId, reason}` |
| 扫描 | `#openTasks(conv)`：遍历 `log`，`created` 进 Map、`completed` 删；`prompt` 缺失时回退到该任务之前最后一条 `user/echo` |
| 收口责任 | **写进状态的人负责写收口**（N7）。三种收口方：`#onTurnEnd`（这一轮结束）、`#reconcileTasks`（开机对账）、`completeTask()`（运维手动） |
| 客户端 | 界面那句"还有件事在处理"是客户端**从事件重建**的 ⇒ 配对破了用户就会一直等 |

### 3.4 「消息不许交叉」怎么被强制

起因（v6 附九，主人报的"你在补齐对话"）：挪走时只发了"我拿去做"、**没有把 agent 手上那条气泡收口**，
于是后续文本写回**更早**的那条 `messageId` ⇒ 上面那条气泡在"我拿去做"之后还继续长 ⇒ 时间倒流。

强制手段三层：
1. **单写者**：一个 `messageId` 只由**一个** `MessageWriter` 写；
2. **先收口再另起**：`dispatcher.#escalate` 第一件事是 `translator.handoff()`——
   `handoff()` 把当前 writer `end('completed')`（没说过话就不 end，免得留空气泡），
   再新建一个 `origin:'proactive'` 的 writer；
3. **不变量测试**：`test/timeline-order.test.js` 把事件流折成每条消息的 `[开始 seq, 结束 seq]`，
   断言**区间两两不重叠**。

### 3.5 落盘与"静默失败"（`store.js` 改造）

现状（**这是 bug，不是设计**）：

```js
append(conversationId, event) { try { fs.appendFileSync(...) } catch { /* 忽略 */ } }
read(conversationId)          { try { ... } catch { return [] } }
```

后果链（违反 N7）：内存 `log` 是全的 ⇒ 运行中毫无征兆 ⇒ 重启后从**残缺记录**恢复 ⇒
`#openTasks` 看到缺了收口的账 ⇒ 把做完的活"接着做" ⇒ 客户端状态与真实不符 ⇒ 监控层基于残缺时间线算出**假时效数字**。

改造后：

| 行为 | 规则 |
|---|---|
| 写失败 | **上抛** + `failCount++` + `lastError`；由 `Conversation.emit` 捕获后交给 `tracer`/`audit` |
| 连续 3 次失败 | 对**当前会话**发 `{type:'error', code:'store-write-failed'}`（客户端显示一条系统提示）+ 写 `data/.health.json{store:{writable:false}}` |
| 关键事件 | `task/created`／`task/completed`／`message/end` 写失败时**降级处理**：宁可当场告诉用户"我这边的记录写不进去了"，也不静默 |
| 恢复时 | 校验文件里最后一条 `seq` 是否连续；不连续 ⇒ **显式报告**（进 `.health.json` + 告警），不许静默使用 |
| `list()` | 读文件名 + **尾部 4KB** 拿最后时间戳（替代全量 `read()+parse`） |
| 轮转 | 单文件 >50MB ⇒ 自动轮转到 `data/archive/`，`Conversation` 记 `archivedBeforeSeq` |

---

## 四、准入：`admission.js`

### 4.1 接口

```js
class Admission {
  check({ conversationId, isNew })  // → { ok:true } | { ok:false, code:'at-capacity', text, retryAfterMs }
  snapshot()                        // → { current, max, ratio, ok }  ← 给 /api/health 与 tracer
}
```

### 4.2 判据：只有内存，没有数字

| 项 | 值 | 依据 |
|---|---|---|
| 阈值 | `memory.current / memory.max ≥ 0.75` 即拒 | 沿用 v7 §9；**0.75 而非 0.9 是推定**——留 25% 给握手峰值（冷启动内存尖峰）与监控 agent |
| 取值来源 | `/sys/fs/cgroup/system.slice/concierge-core.service/memory.current` 与 `memory.max` | **实测**：本机 `memory.max = 1073741824`（1G） |
| 读不到时 | **放行 + 记一条 `dev/step` 警告 + `.health.json{admission:'unavailable'}`** | 见 §14 第 1 条（待审阅） |
| 触发时机 | **每次接受新会话**（首次 WS 连接要做 `warm()` 时 / 首次 `/api/say` 建会话时）；已在池中的会话**不拒** | 启动时没有"新会话"概念，v7 §9 的"开机看"措辞按此修正（见 §15 第 4 条） |
| 不做计数闸 | 拍板第 3 条：**不写承诺数字** | 真实约束是**构建与监控触发频率**，不是会话数（见 4.4） |

### 4.3 拒绝路径（N11：拒绝要给人话）

1. **不建空 jsonl**：判在 `dispatcher.say()` 的 `conversation()` **之前**；
   且 `/api/say` 对未知会话在拒绝时**不调用** `conversation()`（内存会话与文件都别建）。
2. 返回 `429`（新会话）或 `503`（内存已满）。
3. **同时**在已有会话上写一条**真实气泡**（如果这个会话已存在），文案：

   > 「我这边同时在忙几件事，腾出手马上接你这句。」

4. 可重试：客户端保留用户原话、提供重试（`messageId` 幂等，不会重复发言）。
5. 埋点：`tracer` 记一条 `admission_rejected`；**不写进用户流的历史**（除了那条气泡）。

### 4.4 为什么是内存闸而不是"最多 N 个会话"

| 情形 | 内存 | 结论 |
|---|---|---|
| 调度器常驻 | 68 MB | **实测** |
| 1 个活跃会话（产品 agent） | 172 MB | **实测** |
| 监控 agent 触发后（驻留 ≤30 分钟，将改为 review 完即杀） | +172~195 MB | **实测 + 推定** |
| 一次客户端构建（Flutter 工具链） | +846 MB | **实测**（`frontend_server` 392 + `flutter_tester` 299 + 155） |
| **1 个会话 + 一次构建** | **1086 MB > 1024 MB** | **必然 OOM**（近 7 天实测 4 次，受害者每次都是 `dart:frontend_s`） |

⇒ 会话数**推不出**会不会 OOM；`memory.current/max` 能。这也正是拍板第 3 条"不写数字"能成立的前提：
**判据与承诺分离**——承诺是"满了明确告诉你"，判据是实时内存。

---

## 五、预算：`budget.js`

### 5.1 三级状态机（拍板第 5 条）

```
        ┌──────── normal ────────┐   用量 < 75%
        │                        │
   达 75% ▼                        │ 跨天重置 / 新会话
        ┌──────── warn ──────────┐   75%~90%：预警（开发者卡片 + 任务簿），行为不变
        │                        │
   达 90% ▼                        │
        ┌────── degraded ────────┐   90%~100%：**降档但仍给结论**
        │                        │
  达 100% ▼                        │
        ┌────── stopped ─────────┐  ≥100%：**才停**，且必须留一句人话
        └────────────────────────┘
```

| 级 | 触发 | 行为 | 依据 |
|---|---|---|---|
| `warn` | 任一计数 ≥ 75% 软上限 | 不改变行为；进开发者卡片与任务簿 | v7 §11 |
| `degraded` | ≥ 90% | **不再放行新的工具调用**（`policy` 的 `PreToolUse` deny，理由写"预算到上限，把手上结论说清楚"）+ 不再接受新的 `task/created`（这一轮就地收尾） | 陆明："明说停"在办事那一刻最糟 |
| `stopped` | ≥ 100% | 见 5.3「在开口之前停」 | 沈简 |

### 5.2 计数判据（第一版只能用计数）

| 计数 | 软上限 | 来源 | 依据 |
|---|---|---|---|
| `steps` | 12 | agent 的 `step/start` 计数 | 沿用 v7 §11 |
| `toolCalls` | 30 | `tool/call` 按工具名计数 | 沿用 |
| `searches` | 6 | `web_search` / `web_fetch` 计数 | 沿用 |
| `estPromptTokens` | 只记录不判 | `request/header` 字节数估算 | **推定**，标 `estimated:true` |

⚠️ **技术前提（实测）**：DSH 的 session 事件里**没有 token 用量**（`grep usage|cost` 在 `src/` 命中 0），
`turn/end` 只给 `reason.kind`、`step/end` 只给 `{turn,step}` ⇒ **算不出美元** ⇒
**不显示估算美元**（面板第 5 条），`trace.cost.usd` 恒为 `null` 且 `measured:false`。

### 5.3 「在开口之前停」怎么落地（最容易写错的一处）

100% 到达时，按**这一轮有没有出过正文**分两种：

| 情形 | 处理 | `message/end.reason` |
|---|---|---|
| 已经出过正文（`writer.text.length > 0`） | 不再放行任何工具 → 让本轮自然收尾 → 追加一句降档说明（`deep` 块）→ `end()` | `completed`（**内容完整**） |
| 一个字都没说 | **由 L2 说话**：`#legalClose` 写一句完整的人话 | `failed`，但**正文是完整句**，不是半句 |

**硬规则**：`message/end.reason` **不许**是 `max-tokens` / `failed` 造成的**半句**——
即"reason 可以是 failed，但正文必须是完整的句子"（v7 §11）。

**诚实边界（必须写进文档，不能假装能做到）**：SDK 只能 `session/prompt`，
**没有"往 agent 嘴里插一句"的能力**（再发一个 prompt 只会排到下一轮）。
所以 `degraded` 的"追加收尾指令"实际是**通过拒绝新工具**让它用**已有观察**收尾，
而不是给它一句话。这一条列进 §14 第 2 条待审阅。

### 5.4 跨天重置与防刷

| 项 | 规则 |
|---|---|
| 日界 | 本地日 **00:00**；不在进程内挂 `setTimeout`（跨天时进程可能重启过），而是**每次记账时比较 `dayKey`**，变了就清零 + 记一条 `dev/step` |
| 不做 | 不"补扣"跨天前的欠账；不因重置而重放被拒的请求 |
| `/api/debug/analyze` | **删掉 `force` 参数**（它绕过 60s 冷却 ⇒ 可无限刷）；加**每日 ≤20 次** + 强制 10s 最小间隔；每次调用落 `data/debug/audit.jsonl` |
| 告警 | `warn` 级进卡片/任务簿；`stopped` 级**主动开口**说一句（§11） |

---

## 六、来源与能力：`policy.js`

### 6.1 来源分级（v7 §10.1，两档不是四档）

| 来源 | 含义 | 档位 |
|---|---|---|
| `owner` | 主人原话，经鉴权通道（+ 设备/构建指纹，见 §10.2） | **受信档**：全权 |
| `product` | 固定话术（`HANDOFF_LINE` / `FAILED_LINE`）、画像块、recap 里 `who:"你"` 的部分 | 受信档（本来就不带工具调用） |
| `derived` | 网页搜索结果、子 agent 输出、监控层输出、**未复核** KV | **吃到即降只读档** |
| `foreign` | 小程序输入（`app:<id>`）、制品内容、别的会话/用户写入 | **只读档** |

### 6.2 taint 状态机

```
   clean ──(本轮吃进 derived/foreign)──► tainted
     ▲                                      │
     └────── 只在 host 清：dispatcher.say() 收到 source=owner ──────┘
```

| 事件 | 动作 |
|---|---|
| 置位 | 本轮**首次**出现 `web_search` / `web_fetch` / 子 agent 返回 / 监控层输出 / 未复核 KV 装配 / `foreign` 输入 ⇒ `taint.set(conversationId)` |
| deny 范围 | `bash` / 写文件（工作区外）/ 改系统 / 对外发送（`web_fetch` 任意 URL、`curl`、`ssh`、`git push`）**全部 deny** |
| **不受限** | 只读工具（读文件/glob/grep）与**写工作区**（`~/hupo-workspace` 内）——否则 agent 变废人（周慎） |
| 清除 | **只在 host**：`dispatcher.say()` 收到 `source === 'owner'` 时 `taint.clear()`。**模型碰不到这个调用点** |
| 不做 | **不做**自动衰减（沈简）；**不做**审批 UI / `request_capability`（三人一致砍掉） |
| 问的方式 | 对话里一句**带新信息**的话（"查到了 3.2.1，要我直接升上去吗"），不是弹窗 |
| 触发频率监控 | 目标 ≤1–2 次/天（**推定**）；拦 >3 次/周 或误拦 >0 ⇒ **修人格，不许放松棘轮** |

### 6.3 role → patch：在哪一步做

v7 §3.4 的 spawn 契约：

```
dsh --profile sdk --patch <role-patch-路径>
env: { 白名单 env（去掉 *_API_KEY/*_TOKEN/*_SECRET）,
       DSH_PERMISSION_MODE: read-only | workspace-write, DSH_HOME }
cwd: agentCwd
```

| role | patch | `DSH_PERMISSION_MODE` | 谁用 |
|---|---|---|---|
| `owner` | `policy-owner.yml` | `workspace-write`（**不是** `danger-full-access`） | 产品会话的 agent |
| `untrusted` | `policy-untrusted.yml`（`tool-web.fetch:false`、`tool-bash disabled:true`、`sandbox-policy read-only`） | `read-only` | taint 期间 / `foreign` 触发的轮次 |
| `monitor` | `policy-monitor.yml`（只留读 + 输出 JSON） | `read-only` | `debug:<conv>` 与 `monitor:<conv>` |

**选择点有两个，必须都对**：
1. **spawn 时**：`AgentRuntime.agent(sessionId, { role })` → `_spawn()` 里按 role 拼 `--patch` 并注入 `DSH_PERMISSION_MODE`（**host 强制，不靠模型**）；
2. **轮内**：taint 变化时**不能**换进程（换进程会丢上下文），改用 `PreToolUse` hook 读 taint 标记 ⇒ `deny`。

**为什么监控会话必须 `monitor` role**（v7 §10.1）：
它今天由**同一个 `AgentRuntime`、同一份 cfg** 起，因此同人格、同 `danger-full-access`、同免密 sudo ——
而它的输入是**主 agent 自己的输出**（里面正带着刚抓来的网页正文），产出又回到主 agent 可读的任务簿 ⇒
"网页 → 主 agent → 监控 agent → 任务簿 → 主 agent 执行"是一条完整的旁路。

⚠️ **已知限制（实测，必须写进代码注释）**：`SubagentStart` hook 的 `agent_type` **恒为常量**
（`general-purpose`），所以**不能靠 hook 按角色区分**——role 只能在 **spawn 层**选 patch。

---

## 七、节奏

### 7.1 三个阈值与固定话术

| 项 | 值 | 依据 |
|---|---|---|
| 挪走 | `escalateAfterMs = 15000` | 沿用；判据是"**要多久**"，不是"简单还是复杂" |
| 硬收口 | `turnDeadlineMs = 180000` | 沿用 |
| `HANDOFF_LINE` | 「这件事比我想的久，我单独拿去做，完了跟你说。」 | `dispatcher.js` 顶部；**产品固定话术** |
| `FAILED_LINE` | 「这条我没能给出结论，你再说一次，或者换个说法，我重来。」 | 同上 |

**`dispatcher` 是唯一被允许"说产品固定话术"的地方**——这是 v7 §14 里"控制器不能有表达欲"的**唯一例外**，
写明是为了免得后人误读成"调度器可以说任何话"。

### 7.2 挪走（15s）：先收口，再另起

严格顺序（`#escalate`）：

1. `translator.handoff()` —— 把 agent 手上那条 `end('completed')`（**没说过话就不 end**，避免空气泡）；
2. 新建 `MessageWriter` 写 `HANDOFF_LINE`（`agent:'dispatcher'`, `origin:'reactive'`）；
3. `conv.emit({type:'task/created', taskId, messageId, title, prompt: 主人原话, at})`；
4. `info.escalated = true`（`#onTurnEnd` 见到它就补 `task/completed`）。

**顺序不能反**：先发"我拿去做"再收口 ⇒ 时间倒流（§3.4）。

### 7.3 硬收口（180s）

`forceClose('failed')` ⇒ `#legalClose(conv, FAILED_LINE)` ⇒ `dev/step` 记一条 error。

⚠️ **N10 的第二句（v7 §6.2）：超时必须伴随资源回收**。现状只收气泡，**agent 还在后台算完**。
改造要求：180s 到点后不仅收口，还要
① 给该 agent 打 `stale` 标记（本轮结果到达时**丢弃**，不写进任何 `messageId`）；
② 若它空闲，提前触发空闲回收（不必等 30 分钟）；
③ trace 里记 `endReason:'deadline'` + `rssPeakBytes`。

### 7.4 cancel 的诚实边界

| 能做的 | 不能做的 |
|---|---|
| `forceClose('aborted')`——不再把它的话放给用户；`turns.delete()`；已显示的字**不擦除**（R4，只追加说明） | SDK **没有**"取消这一轮"的能力 ⇒ agent 会继续在后台算完 |

文案与埋点：`dev/step` 记「用户中止，agent 后台仍在算完」；`trace.endReason = 'aborted'`。

---

## 八、对账续做

### 8.1 规则表（拍板第 10 条 + v7 §4.3）

| 规则 | 值 | 依据 |
|---|---|---|
| 全局并发 | **1 件**（不是"每会话 2 件"） | 拍板第 10 条。⚠️ 现状 `MAX_RESUME_AT_BOOT = 2` 是**每会话**（`dispatcher.js`），10 个会话开机会起 20 个 agent —— **这是 bug** |
| 时间窗 | 6 小时（`RESUME_WINDOW_MS`） | 沿用 |
| 次数上限 | 同一 `taskId` ≤3 次（`MAX_RESUME_ATTEMPTS`） | 沿用，但**失败分类后要改**（8.2） |
| 前置检查 | `admission.check()` 通过才续做 | 新增（v7 §4.3"先看内存闸"） |
| 间隔 | 同一 `taskId` 两次续做间隔 **≥5 分钟** | 新增 |
| 原话 | `task.prompt` 缺失 ⇒ 回退该任务前最后一条 `user/echo`；都没有 ⇒ 收口 | 沿用 |
| 降级启动 | `CONCIERGE_SKIP_RESUME=1` ⇒ **只收口、不重派**，并说一句真实的话 | 新增（§2 步 5） |
| 收口 | 这一轮结束 = 交回分配器 ⇒ `task/completed`（`#onTurnEnd` 里 `resumed` 那次） | 沿用 |

### 8.2 失败分类（"OOM/上游失败不计额度"的落地）

| 类 | 识别 | 重试策略 | 计入 `attempts`？ |
|---|---|---|---|
| `auth` | 401/403 | **不重试**，直接告警（"密钥失效了"） | ❌ |
| `quota` | 402/429 | **不重试**，标记当日预算耗尽，走 `budget.stopped` | ❌ |
| `upstream` | 5xx / 网络错误 | 退避重试 `1s / 4s / 12s`，最多 2 次 | ❌ |
| `protocol` | 帧错误 / JSON 解析失败 | 重试 1 次 | ❌ |
| **真·被打断** | 进程消失（`exit`，非上面四类） | 重派（≤3 次） | ✅ |

**熔断器状态机**（只对 `upstream`）：

```
closed ──(60s 内 5 次 upstream 失败)──► open(60s)
   ▲                                        │ 60s 到
   └──── 半开：放**一个**试探请求 ◄───────────┘  成功→closed / 失败→open(再 60s)
```
`open` 期间的轮次**快速失败**并如实说"上游不通"（不是"没做完"）。

### 8.3 降级启动的对外表现

| 时刻 | 用户看到 |
|---|---|
| 检测到崩溃环 | 不续做；若已有未完成任务的会话在线，发一条**真实**的话：「刚才我连着重启了几次，先把手上这件事放一放，你现在说什么我都接。」 |
| `data/.degraded` 存在期间 | `/api/health` 的 `degraded:true`；`hupo-alert` 发一条 P0 |
| 恢复 | 连续 10 分钟无崩溃 ⇒ 删除 `.degraded`，下次启动恢复正常续做 |

---

## 九、制品服务：`apps.js`

### 9.1 清单 schema（`GET /api/apps`，需令牌）

```jsonc
[{ "id":"weather-pro", "name":"天气Pro", "icon":"icon.png", "version":"1.0.3",
   "sha256":"…", "permissions":[], "minShellVersion":"1.0.0", "publishedAt":"…" }]
```

### 9.2 目录与版本

```
/var/lib/hupo-apps/<appId>/<version>/     ← 不可变：上传只允许**新建**版本目录，绝不覆盖
/var/lib/hupo-apps/<appId>/current        ← 符号链接（原子切换：ln -sfn）
/var/lib/hupo-apps/<appId>/<version>.json ← 该版本的 manifest + sha256 + 发布审计引用
```

| 项 | 规则 |
|---|---|
| 原子切换 | `ln -sfn <version> current.new && mv -T current.new current`；切换中并发请求不许出现 404 |
| hash | 每个文件算 `sha256`，清单里给整包的 `sha256`；L1 下载后校验，失败 ⇒ 回退 `last-known-good` + 上报 `miniapp/load-failed` |
| 回滚 | `current` 指回上一版（保留最近 3 版）——**一条 `ln -sfn`** |
| 保留 | 更老的版本按配额清理（写进 §12 的 `appsKeepVersions`） |

### 9.3 上传走**特权口**（不在公网 nginx 路径上）

| 方案 | 说明 |
|---|---|
| Unix socket `/run/hupo/apps.sock`（**推荐**） | 只允许本机进程连；`chown` 给专用用户 |
| 或另一个只监听 `127.0.0.1` 且带**独立共享密钥**的端口 | 例如 `8093` |

🔴 **绝不能**把上传挂在公网 nginx 的 `/api/` 下。原因（v6 附十已写明）：
**nginx 把所有外部请求的源地址都变成 `127.0.0.1`** ⇒ 用"是不是本机 IP"判写权**当场失效**。

### 9.4 审计与部署日志

| 落点 | 内容 |
|---|---|
| `data/audit/<date>.jsonl`（root 属主 append-only） | 每次发布一条**不可变**记录：`{at, appId, version, sha256, conversationId, messageId}` ⇒ **"哪个小程序是哪句话生成的"可倒查** |
| `data/deploy.log` | **整包**部署日志：`{at, buildId, gatesSkipped, prevBuildId, exitCode}`（`HUPO_DEPLOY_ANYWAY=1` 的每一次绕过都在这里留痕） |

### 9.5 与整包的关系

| 线 | 机制 | 谁触发 |
|---|---|---|
| **整包**（Flutter Web 壳） | `client-build.json` 指纹 → `client/reload`（`emitTransient`，只在现场） | `deploy-web.sh` 写文件，L2 poll 5s 发现 |
| **单应用**（制品） | `current` 指针 → `app/update-available` | 上传成功后由 `apps.js` 发事件 |

⚠️ 部署整包**必须** `rsync --exclude=/apps/`（现有脚本是 `rsync -a --delete`，会把制品目录连基线一起抹掉，**而且不报错**）。

---

## 十、鉴权：`auth.js` 改造

| # | 改造 | 现状 | 依据 |
|---|---|---|---|
| 1 | **fail-closed** | `active = enabled && hasPassword`，为假时**全部放行**（`server.js` 205 行 `if (auth.active && …)` 短路） | S0。`enabled && !hasPassword` ⇒ 除 `/api/auth` `/api/login` `/api/version` 外 **503**；`/api/auth` 返回 `{required:true, needsSetup:true}` |
| 2 | **XFF 取最后一跳** | `clientIp()` 取 `split(',')[0]`，而 nginx 用 `$proxy_add_x_forwarded_for`（把真实 IP 追加在**最后**）⇒ 攻击者自填第一跳即可绕过限速 | S0。改 `xff.split(',').pop()`，或直接用 `req.socket.remoteAddress`（一定来自 nginx）；nginx 侧加 `X-Real-IP` |
| 3 | **失败计数落盘** | `_fails` 只在内存，服务天天重启 ⇒ 锁定随时归零 | `data/auth-fails.json`（0600），启动时加载 |
| 4 | **可吊销** | payload 是 `{v, exp, jti}`，`jti` **无人使用** ⇒ 泄漏后 30 天无法作废 | `POST /api/logout` 把 `jti` 写进 `data/revoked.json`（保留 31 天）；`verifyToken` 查表 |
| 5 | **加 `sub`** | payload 无身份字段 | `{v:2, sub:'owner', exp, jti}`；`v:1` 旧令牌按 `owner` 兼容（v7 §3.1 要求 `userId`） |
| 6 | **归属校验** | `/api/message/:id/cancel`、`/api/conversations/<id>/*` **不校验归属**（`cancel` 甚至用 messageId 反查会话） | 校验 `sub` 与 `conversationId` 归属；**不匹配返回 404 而不是 403**（避免枚举） |
| 7 | **改口令即全量失效** | 换口令不会让旧令牌失效 | 把 `password.setAt` 混进 HMAC 输入 |
| 8 | **登录审计** | 无 | `data/auth-audit.jsonl`：`{at, result, ip}` |
| 9 | **保留**（别动） | 令牌只走 `Authorization: Bearer` 与 WS 子协议 `['bearer', token]`；**刻意不看查询串**（会被 nginx 写进 access.log）；scrypt + `timingSafeEqual` 实现是对的 | — |

---

## 十一、可观测性：`tracer.js`

### 11.1 每轮 trace（`data/trace/<date>.jsonl`，一行一轮）

```jsonc
{ "ts":…, "conversationId":"u_owner:c_main", "bootId":"…", "dshSessionId":"…", "pid":…,
  "promptChars":…, "estPromptTokens":…, "estimated":true,      // ← 估算必须自曝
  "steps":…, "toolCalls":{"web_search":2}, "searches":2,
  "handoffPath":"direct|escalated|resumed", "resumedAttempt":0,
  "firstLineMs":…, "firstSeenMs":…, "gapMaxMs":…, "turnEndMs":…, "endReason":"completed",
  "rssPeakBytes":…, "exitCode":null, "oomSuspect":false,
  "cost":{ "usd":null, "measured":false },                     // ← DSH 无 usage，恒为 null
  "admission":"ok|rejected", "budgetLevel":"normal|warn|degraded|stopped", "taint":false }
```

### 11.2 周期采样（`hupo-sampler.timer`，30s）

`data/metrics.jsonl` 追加一行：`memory.current/max`、`memory.events.oom_kill`、`nr_throttled`、
`disk freePct`、`agents.count`。**纯追加**，一天约 2.9k 行。

### 11.3 健康快照（`data/.health.json`）

```jsonc
{ "at":…, "ok":true, "degraded":false,
  "disk":{"freePct":28,"inodesFreePct":…}, "store":{"writable":true,"lastError":null},
  "agents":{"count":1,"rssBytes":…}, "memory":{"current":…,"max":…,"ratio":0.11},
  "admission":"ok|unavailable", "upstream":"ok|auth-failed|quota|down",
  "cert":{"notAfter":"2026-12-11","daysLeft":87}, "restartCount":…, "resumeSkipped":false,
  "lastGoodCommit":"…" }
```

### 11.4 `/api/health` 与 `/api/health/local`

| 接口 | 鉴权 | 内容 | 谁能访问 |
|---|---|---|---|
| `/api/health` | **需令牌** | 上面那份（**不含任何用户内容**） | 你 / 客户端 / 外部监控（带令牌） |
| `/api/health/local` | 无令牌 | 同结构，但去掉 `lastGoodCommit` 等运维细节 | 本机工具 |

⚠️ **这两条的可达性在现状下没有差别**（8091 本来就只绑 `127.0.0.1`），而且"本机免鉴权"这条捷径
**不能通过 IP 判定**（nginx 反代后源地址恒为 `127.0.0.1`）。落地方式见 §15 第 1 条（这是本文发现的一处真冲突）。

### 11.5 告警：复用"调度器主动开口"

| 级 | 条件 | 怎么告诉主人 |
|---|---|---|
| **P0 立刻** | `oom_kill>0` ｜ `memory > 0.9×max` 持续 5 分钟 ｜ 节流增速 >50% ｜ `disk free <15%` ｜ 证书剩余 <21 天 ｜ 备份连续 2 天失败 ｜ 白名单外出站 | **主动消息**（`origin:'proactive'`）一句人话 + 一句可选的处理建议 |
| P1 汇总 | 成本进 `warn`/`degraded`、监控抓到的新问题 | 开发者卡片 / 任务簿；主人问起能查 |
| 不进用户流 | trace / metrics / audit / 遥测 | 只在开发者通道 |

⚠️ 与 N7 的关系：告警也是**写进对话记录的状态** ⇒ 只在**真实发生**时发，不发"可能有问题"。

---

## 十二、配置全表（`config.js`）

| 键 | 默认 | 环境变量 | 依据 | 状态 |
|---|---|---|---|---|
| `apiKey` | 从 `~/.dsh/.credentials.yaml` 读 | `CONCIERGE_API_KEY` / `DEEPSEEK_API_KEY` | 沿用 | ✅ |
| `port` | `8091` | `CONCIERGE_PORT` | 沿用 | ✅ |
| `dataDir` | `<cwd>/data` | `CONCIERGE_DATA_DIR` | 沿用 | ✅ |
| `clientRoot` | `/var/www/hupo` | `CONCIERGE_CLIENT_ROOT` | ⚠️ 改指向 `current` 符号链接 | ⚠️ |
| `dshBin` | 自动找（PATH → nvm → 常见位置） | `CONCIERGE_DSH_BIN` | **实测**：systemd 窄 PATH 会 ENOENT | ✅ |
| `agentProfile` | `sdk` | `CONCIERGE_AGENT_PROFILE` | 沿用 | ✅ |
| `personaPath` | `<repo>/services/core/hupo-persona.yml` | `CONCIERGE_PERSONA` | 沿用；**进完整性清单** | ✅ |
| `agentCwd` | `~/hupo-workspace` | `CONCIERGE_AGENT_CWD` | 沿用；将来按用户派生 | ✅ |
| `agentProvider` / `agentModel` / `agentEffort` | `deepseek-official` / `deepseek-flash` / `low` | `CONCIERGE_AGENT_*` | 沿用 | ✅ |
| `agentMaxTokens` | `16000` | `CONCIERGE_AGENT_MAX_TOKENS` | **实测**：4000 会截断成长半句 | ✅ |
| `agentBootTimeoutMs` | `30000` | `CONCIERGE_AGENT_BOOT_MS` | 沿用 | ✅ |
| `escalateAfterMs` | `15000` | `CONCIERGE_ESCALATE_MS` | 沿用 | ✅ |
| `turnDeadlineMs` | `180000` | `CONCIERGE_TURN_DEADLINE_MS` | 沿用 | ✅ |
| `agentIdleEvictMs` | `1800000`（30 分钟） | `CONCIERGE_AGENT_IDLE_EVICT_MS` | 沿用；监控会话改为**用完即杀** | ✅ |
| **`memoryGateRatio`** | `0.75` | `CONCIERGE_MEMORY_GATE_RATIO` | 拍板第 4 条；**推定** | ➕ |
| **`cgroupPath`** | `/sys/fs/cgroup/system.slice/concierge-core.service` | `CONCIERGE_CGROUP_PATH` | **实测** | ➕ |
| **`maxAgents`** | `4`（软上限，仅用于 LRU 与告警，**不是准入判据**） | `CONCIERGE_MAX_AGENTS` | 拍板第 3 条：准入只看内存 | ➕ |
| **`maxStepsPerTurn`** | `12` | `CONCIERGE_MAX_STEPS` | v7 §11 | ➕ |
| **`maxToolCallsPerTurn`** | `30` | `CONCIERGE_MAX_TOOL_CALLS` | v7 §11 | ➕ |
| **`maxSearchesPerTurn`** | `6` | `CONCIERGE_MAX_SEARCHES` | v7 §11 | ➕ |
| **`warnRatio` / `degradeRatio` / `stopRatio`** | `0.75` / `0.90` / `1.00` | `CONCIERGE_BUDGET_*` | 拍板第 5 条 | ➕ |
| **`rolePatchDir`** | `<repo>/services/core/policies/` | `CONCIERGE_ROLE_PATCH_DIR` | v7 §3.4 | ➕ |
| **`policyLockPath`** | `/etc/hupo/policy.lock.json` | `CONCIERGE_POLICY_LOCK` | v7 §10.2（root-only） | ➕ |
| **`appsRoot`** | `/var/lib/hupo-apps` | `CONCIERGE_APPS_ROOT` | v7 §7（**不在站点根下**） | ➕ |
| **`appsSocket`** | `/run/hupo/apps.sock` | `CONCIERGE_APPS_SOCKET` | §9.3（**不在公网路径**） | ➕ |
| **`appsKeepVersions`** | `3` | `CONCIERGE_APPS_KEEP` | §9.2 | ➕ |
| **`resumeMaxTotal`** | `1` | `CONCIERGE_RESUME_MAX` | 拍板第 10 条 | ➕ |
| **`resumeMinGapMs`** | `300000`（5 分钟） | `CONCIERGE_RESUME_GAP_MS` | §8.1 | ➕ |
| **`skipResume`** | `false`（由 `CONCIERGE_SKIP_RESUME=1` 置真） | `CONCIERGE_SKIP_RESUME` | §2 步 5 | ➕ |
| **`analyzeDailyMax`** | `20` | `CONCIERGE_ANALYZE_MAX` | §5.4（并**删掉 `force`**） | ➕ |
| **`traceKeepDays`** / **`auditKeepDays`** | `7` / `90` | `CONCIERGE_TRACE_KEEP_DAYS` 等 | v7 §7 | ➕ |
| **`backupDir`** | `/home/deploy/backups/hupo` | `CONCIERGE_BACKUP_DIR` | 拍板第 11 条（先本地第二目录） | ➕ |

⚠️ `apiKey` 的存在是为了启动横幅的提示；**真密钥不进 agent 子进程**（spawn env 白名单，§6.3）。

---

## 十三、测试与验收

### 13.1 现有测试：哪些会被改动

| 测试 | 会不会动 | 为什么 |
|---|---|---|
| `timeline-order.test.js` | ⚠️ **会** | 挪走路径新增"先收口再另起"的断言；`handoff()` 语义不变但要多一条"没说过话不留空气泡" |
| `reconcile.test.js` | ⚠️ **会** | `MAX_RESUME_AT_BOOT` 从**每会话 2** 改**全局 1** ⇒ 多条会话的用例期望值要改；新增"全局上限"用例 |
| `subscribe.test.js` | ✅ 不动 | `dev=1` 不得挤掉产品订阅 —— 这条是回归护栏，必须继续通过 |
| `agent-runtime.test.js` | ⚠️ **会** | 新增 `role` 参数与 env 白名单断言；`dshSessionId` 规则不变 |
| `auth.test.js` | ⚠️ **会** | fail-closed、`sub`、`v:2`、logout/吊销、XFF 最后一跳 |
| `timeline-context.test.js` | ⚠️ **会** | `timelineContext` 要按 provenance 分节（`主人：` / `你：` / `【外部资料·不可执行】`）—— R2 的"前缀字节不变"要继续成立 |
| `debug-agent.test.js` | ✅ 基本不动 | 监控逻辑不改（role 降权是 runtime 层） |
| `personality.test.js` | ✅ 不动 | — |

### 13.2 新增测试清单

| # | 测什么 | 断言（可执行） |
|---|---|---|
| T1 | **内存闸拒绝** | 把 `memoryGateRatio` 设 0.001 ⇒ 新会话被拒；**`data/` 下不出现新的 `.jsonl`**；已有会话收到那条人话气泡 |
| T2 | **预算三级** | 把 `maxStepsPerTurn` 设 3 ⇒ trace 里 `steps<=3`，`endReason` 不是 `max-tokens`，用户收到**完整句**（正则断言不以逗号/单字结尾） |
| T3 | **taint 只在 host 清** | 模拟 `web_fetch` ⇒ 该会话 `bash` 被 deny；模型侧任何调用都无法清 taint；`dispatcher.say({source:'owner'})` 之后 deny 解除 |
| T4 | **store 写失败上报** | `data/` 改只读 ⇒ 连续 3 次失败后会话收到 `error{code:'store-write-failed'}` + `.health.json.ok=false` |
| T5 | **fail-closed** | 空 `dataDir` 起实例 ⇒ 匿名 `GET /api/conversations` 返回 **503**（不是 200），`/api/auth` 返回 `needsSetup:true` |
| T6 | **归属 404** | 用 `sub:'other'` 的令牌访问 `u_owner:c_main/events` ⇒ **404**（不是 403） |
| T7 | **对账全局 1** | 造 3 个会话各有 1 件未完成任务 ⇒ 开机只重派 **1** 件 |
| T8 | **失败分类不计额度** | 连续 3 次 `upstream` 失败 ⇒ `attempts` 仍为 0；第 4 次真·被打断才 +1 |
| T9 | **store seq 连续性** | 手工删掉中间一行 ⇒ 恢复时 `.health.json` 报 `seqGap`，不静默使用 |
| T10 | **制品版本不可变** | 往已存在的 version 目录再上传 ⇒ 拒绝；`current` 切换期间并发 200 次请求无 404 |
| T11 | **HANDOFF 不交叉** | 低阈值跑一轮挪走 ⇒ 消息区间两两不重叠（复用 `timeline-order` 的折叠断言） |
| T12 | **非法命名** | 所有 `/api/*` 路由的 `conversationId` 走 `u_<userId>:c_<name>` 校验；`c_main` 走兼容映射仍可用 |

### 13.3 门禁（每期共同）

新增功能点必须带验收判据；**红队用例只增不减**；
文档里不许留互相矛盾的数字（`8–12 人` 已删，实测基线一律标"非承诺"）。

---

## 十四、需要你审阅的点

| # | 议题 | 选项 | 我的建议 | 代价 |
|---|---|---|---|---|
| 1 | **cgroup 文件读不到时**（本地开发、非 Linux、权限错） | (a) 放行 + 告警 ｜ (b) 拒绝一切新会话 | **(a)** | 本地开发不被拦；代价是"生产上文件突然不可读"会静默放行——用 `.health.json{admission:'unavailable'}` + 告警兜底 |
| 2 | **`degraded` 的"追加收尾指令"做不到**（SDK 只能 `session/prompt`，插不进话） | (a) 只 deny 新工具，让它用已有观察收尾 ｜ (b) 允许 L2 提前收口并替它说一句 ｜ (c) 接受"降档 = 只截断新工具" | **(a)**，并把 (b) 留给 `stopped` | (a) 的代价：agent 可能用不完整的信息给结论——但比"静默变慢"好 |
| 3 | **180s 超时的"资源回收"做到哪一步** | (a) 只打 `stale` 标记（结果丢弃）｜ (b) 标记 + 提前空闲回收 ｜ (c) 直接 `dispose()` 杀进程 | **(b)** | (c) 最干净但会连带杀掉"其实马上要答完"的轮次 |
| 4 | **熔断阈值**（60s 内 5 次 `upstream`） | (a) 保持 ｜ (b) 3 次就打开 ｜ (c) 10 次 | **(a)**，先用一周 trace 校准 | 阈值太松 ⇒ 白烧额度；太紧 ⇒ 上游抖一下就不说话 |
| 5 | **归属不匹配返回 404 还是 403** | (a) 404（v7 §3.1 旁注）｜ (b) 403 | **(a)** | 探针脚本（`watch.mjs` / `e2e.mjs`）用的是裸 `c_main`/`c_probe`，兼容映射必须一起做，否则它们全 404 |
| 6 | **`/api/conversations/:id/summary` 保留吗** | (a) 保留（监听着要读总结）｜ (b) 删掉（v7 §3.2 表里没有它） | **(a)**，并在 v7 §3.2 补一行 | 不补就是"实现超出契约"，下一个人会以为它是死接口 |

---

## 十五、与 v7 的冲突（**没有自行修改，只列出来**）

| # | 冲突 | 为什么说不通 | 处理建议 |
|---|---|---|---|
| **1** | **`/api/health/local` 的"只监听 127.0.0.1"落不了地** | v7 §3.2 说它"只监听 127.0.0.1，nginx 不转发"。但 8091 **本来就只绑 `127.0.0.1`**（实测），`/api/health` 与它在可达性上**完全一样**——"本地专用"没有实际含义。而真要按 IP 判"是不是本机"，会**直接踩 v6 附十的坑**：nginx 反代后源地址恒为 `127.0.0.1` ⇒ 那等于给公网开了免鉴权口 | 二选一：**(a)** 取消 `/api/health/local`，只保留需令牌的 `/api/health`（最简单）；**(b)** 真给它**另一个端口**（如 `8092`，进程内再起一个 http server），nginx **绝不**反代它。**建议 (a)** |
| **2** | **`message/start.source` 没有生产来源** | v7 §3.3 要求 `message/start.source`，但 `MessageWriter` 的构造参数只有 `{messageId, agent, origin, re, interrupts, sources}`，**没有 `source`** ⇒ 契约里的字段无处产生 | 扩 `MessageWriter` 加 `source`（值来自 §6 的 `policy.sourceOf(conv)`）；`PROTOCOL.md` 补一行；**不改 v7** |
| **3** | **制品清单与下载跨 origin，但没定义 CORS** | v7 §3.2 把 `/api/apps`（清单）放在**需令牌的主 origin**，§10/N1 又要求制品在**独立 origin** ⇒ L1 拿清单要同源鉴权、下载制品要跨域，两件事在两个 origin 上，**谁都没说清单能不能跨域读** | 建议：清单**同时**发布到制品 origin 的静态 `/<appId>/manifest.json`（无鉴权、无隐私、只含 id/名字/版本/hash）；L2 只负责**发布**，不负责被跨域读。**需要 v7 加一句** |
| **4** | **准入的触发时机写成"开机看"** | v7 §9 说"开机看 `memory.current/max`"，但"拒绝"这个动作只在**接受新会话**时才有意义（开机时没有"新会话"）。照字面实现会做出一个启动时就判一次的假闸 | 改成"**每次接受新会话时**判"。**需要 v7 改一处措辞** |
| **5** | **`estPromptTokens` 与"不显示估算美元"口径不一致** | v7 §12 的 trace 字段里有 `estPromptTokens`，§11 又说"算不出美元 ⇒ 不显示估算"。同一个"估算"一个留一个砍，容易被后人当成真数用 | 保留字段但**必须带 `estimated:true`**，并在 v7 §12 加一句"估算字段一律自曝" |

> 以上 5 条**只在本文记录**。按契约要求，**没有改动 `ARCHITECTURE-v7.md`**；
> 其中第 1、3、4 条会影响 L1 与运维的实现，建议先定这三条再开工 S1/S2。
