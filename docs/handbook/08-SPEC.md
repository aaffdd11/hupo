# 08 · 规范细则（从旧架构收敛而来）

> **这份文档为什么存在**：旧架构（`ARCHITECTURE-v7.md` 及其前身）里有一批
> **仍然有效、但新手册没重复**的规范——接口表、继承的不变量、安全模型、成本与可观测性。
>
> 删掉旧文档之前，**这些必须有个家**。这一份就是那个家。
>
> ⚠️ **本文与手册其他部分同等权威。**冲突时以本文为准（它更具体）。
>
> **标记**：**【有效】** = 继续照做｜**【已取代】** = 新计划改了它，**只作历史**｜**【不建】** = 明确不做
>
> **含**：继承的不变量 · 接口契约 · 数据与存储 · 安全模型 · 成本与可观测性 ·
> **界面与浮窗铁律** · 已取代/不建 · iOS 与 Web 构建 · 部署形态与准入

---

## 一、继承的不变量 N1–N11

> 手册 `02-ARCHITECTURE.md` §五 写的是 **N12–N25**。
> 编号从 N1 开始、**这一节是 N1–N11 的正文**——它们**继续有效**。

| # | 不变量 |
|---|---|
| **N1** | 执行第三方代码的东西（小程序）**绝不与持有令牌的原点同源** |
| **N2** | 制品**不能自授权**：小程序拿不到任何"能指挥 agent"的能力 |
| **N3** | **来源分级**：进入 agent 上下文的一切都带来源标签，**能力按来源分级** |
| **N4** | **记忆有出处**：每条带来源与采信度，**无出处不写**；未采信不得作行动依据 |
| **N5** | **可回退**：任何系统改动生效前必须有回退点，且**回退不需要 agent** |
| **N6** | **记忆不是真相源**：事件流才是权威，冲突**以事件流为准** |
| **N7** | **不拿不真实的状态污染记录**（写进记录前先问"这条一直是假的怎么办"） |
| **N8** | **预算先于任务**：一切会 fan-out 的动作都吃**显式预算** |
| **N9** | **可删除**：任何存储都要能回答"**这条怎么删干净**" |
| **N10** | **沉默优于编造**；**超时必须伴随资源回收**（**收气泡 ≠ 停 agent**） |
| **N11** | **拒绝要给人话**：满 / 超预算 / 上游挂，都必须是一句人话 + 可重试，**不是静默** |

### 1.1 更早继承下来的（**继续有效，名义编号**）

| 组 | 内容 |
|---|---|
| **R1–R5** | 记忆隔离三层 ｜ 只追加不改前缀 ｜ 情绪只影响"怎么说" ｜ 默认只对主人回应 ｜ 反馈层上下文含接收层全文 |
| **R11** | 每个事件都有时间戳 |
| **消息不许交叉** | 一条消息开始后，**不许再有别的消息正文写进更早那条**（v6 附九；**已升格为 N22 的"同一时刻最多一条未收口"**） |
| **前端是哑的** | 客户端只按编号排序，不做判断 |
| **协议 R1–R14** | 见 `packages/protocol/PROTOCOL.md`（**那份文件仍然权威**，不在这里重复） |

> ⚠️ **R1–R14 的正文在 `packages/protocol/PROTOCOL.md`**——它**不在被删的文档之列**
> （它在 `packages/` 下，是代码的一部分）。手册 `03-DEVELOPMENT.md` §三 只列了名字。

### 1.2 ⚠️ "来源"这个词指**两个不同的东西**（**别再混**）

这是本项目最容易搞混的一处，**因为它俩同名**：

| | 是什么 | 取值 | 活在哪 | 状态 |
|---|---|---|---|---|
| **taint 来源分级** | 进入 agent 上下文的东西**从哪来**，**决定能力档** | `owner` / `product` / `derived` / `foreign` | **host（调度器）** | ✅ **【有效】**（N3） |
| **协议字段 `message/start.source`** | 曾想表达"这条消息是谁触发的" | —— | 协议线上 | ❌ **【已取代】删掉了**（决策 P-i） |

⇒ **协议侧改用已经在线上的两条轴**：
**`agent`**（谁在说：`agent` / `dispatcher`）+ **`origin`**（为什么开口：`reactive` / `proactive`）。

⇒ **taint 那一套没有取消**，它活在 host 侧，与协议字段无关。

---

## 二、接口契约

### 2.1 `L1 ⇄ L2`（HTTP + WebSocket）**【有效】**

| 接口 | 方法 | 暴露面 | 说明 |
|---|---|---|---|
| `/api/auth`、`/api/login` | GET / POST | 公开 | 登录；**没设口令时 fail-closed（503）** |
| `/api/version` | GET | 公开 | `buildId` + `serverNow`（客户端据此判断要不要刷新） |
| `/api/health` | GET | 需令牌 | 结构化健康：disk / store / agents / memory / upstream / cert |
| `/api/health/local` | GET | **只监听 `127.0.0.1`** | 给本机监控用（**nginx 不转发** ⇒ 不违反"不做本机免鉴权"） |
| `/api/say` | POST | 需令牌 | `{conversationId, messageId, text, clientAt}`；⚠️ 原表还有一个 `source`，**已取代删掉** |
| `/api/receipt` | POST | 需令牌 | 客户端回报"我看到了"（**用客户端自己的钟**） |
| `/api/message/:id/cancel` | POST | 需令牌 | **校验归属** |
| `/api/conversations`、`/:id/events`、`/:id/export` | GET | 需令牌 | 列表 / 事件 / 导出（`md` 或 `jsonl`） |
| `/api/conversations/:id` | DELETE | 需令牌 | 进回收站（**墓碑**），**到期真删** |
| `/api/apps` | GET | 需令牌 | 小程序清单：`id` / `name` / `icon` / `version` / `sha256` / `permissions` / `minShellVersion` |
| `/api/apps`、`/api/apps/:id/rollback` | POST | 需令牌（rollback）/ **特权口**（上传） | **上传不在公网路径上** |
| `/api/stream` | WS | 需令牌（子协议 `['bearer', token]`） | 下行事件；`sinceSeq` 续传；**`dev=1` 是附加通道不是替代** |
| `/api/debug/report` · `/api/debug/tasks` · `/api/debug/analyze` | GET/POST | 需令牌 | 监控出口；⚠️ **`analyze` 的 `force` 参数已删**（它绕过冷却，可无限刷） |

### 2.2 `L2 → L1` 事件（**新增的那些**）**【有效】**

| 事件 | 说明 |
|---|---|
| `app/installed` · `app/update-available` · `app/error` | 小程序生命周期。**每个"进行中"都要有配对收口 + 超时** |
| `miniapp/load-failed` | 容器 hash 校验失败并回退 `last-known-good` |
| `audit/notice` | **只在开发者通道推**：刚发生一次"改系统"档动作（**不进用户流**） |

> ⚠️ 协议 v2 要加的字段（作用域标识 / 补发标记 / 步骤事件）见 `03-DEVELOPMENT.md` §三。

### 2.3 `L2 ⇄ L3`（stdio JSON-RPC）**【有效】**

| 方向 | 方法 | 说明 |
|---|---|---|
| L2→L3 | `initialize` | `{cwd, provider, model, reasoningEffort, maxTokens}` |
| L2→L3 | `session/prompt` | `{sessionId, contentBlocks}`；未知 sessionId **惰性新建** |
| L3→L2 | `session.event` | 完整会话日志事件（**按 step 整段到达，无 token 级 delta**） |
| L3→L2 | `session.status` | `running` / `idle` |
| L3→L2 | `subagent.*` | 子 agent 起落 |

**spawn 契约**：
```
dsh --profile sdk --patch <role-patch-路径>
env: { 白名单 env（去掉 *_API_KEY / *_TOKEN / *_SECRET）
       DSH_PERMISSION_MODE: read-only | workspace-write
       DSH_HOME }
cwd: agentCwd
```

**role 三类**：`owner`（默认，全权但受 taint 约束）/ `untrusted`（只读档）/ `monitor`（只读档）。

> ⚠️ **env 的落地口径见 `03-DEVELOPMENT.md` §5.4**（**先做减法**，严格白名单随后）。

### 2.4 服务端模块清单（`services/core/src/`）**【有效】**

| 模块 | 职责 |
|---|---|
| `index.js` · `server.js` · `config.js` | 启动 / 路由 / 配置 |
| `auth.js` | scrypt + HMAC 无状态令牌 + 限速（**fail-closed**） |
| `store.js` | 事件流落盘（**写失败必须上抛**） |
| `conversation.js` | `Conversation` / `MessageWriter` / 时间线上下文 |
| `session-translate.js` | agent 事件 → 产品事件 |
| `dispatcher.js` | 节奏 + 账本 + 对账续做 |
| `agent-runtime.js` | 进程池 + spawn 契约 + LRU + 遥测 |
| `debug-agent.js` · `personality.js` | 监控层 |
| `client-build.js` | 整包构建指纹 |

**【不建】**：`admission.js` 之外的那六个（见 §六）。

### 2.5 客户端模块清单（`apps/mobile/lib/`）**【部分已取代】**

| 模块 | 职责 | 状态 |
|---|---|---|
| `screens/chat_screen.dart` | **浮窗**（三档 / 抓手 / 覆盖退让 / 拦截层） | ⚠️ **要拆**（见 `03-DEVELOPMENT.md` §2.5） |
| `widgets/app_desktop.dart` | 桌面（浮窗后面那层） | ✅ |
| `widgets/mini_app_container.dart` | 容器壳（标题栏 / 返回栈 / 关闭） | ✅ |
| `widgets/answer_bubble.dart` | 气泡（quick+deep / 来源） | ✅ |
| `mini/runtime.dart` | 沙箱运行时（Web：`sandbox` iframe；原生：受限 WebView） | ❌ **【不建】**（本轮不做小程序运行时） |
| `mini/manifest.dart` | 清单解析 + 校验（含 `minShellVersion` / `sha256`） | ❌ **【不建】** |
| `mini/store.dart` | 本地安装 / 版本目录 / 回退 `last-known-good` | ❌ **【不建】** |
| `mini/bridge.dart` | 容器代发、`postMessage` 校 `event.origin` | ❌ **【不建】** |
| `services/apps_client.dart` | 拉清单 | ❌ **【不建】** |

---

## 三、数据与存储总表 **【有效】**

| 数据 | 位置 | 权威性 | 保留 |
|---|---|---|---|
| **事件流（正史）** | `data/<conv>.jsonl` | **权威** | 长期 + 归档 |
| 归档 | `data/archive/` | 权威 | 30 天或人工 |
| 记忆（`facts`） | `data/kv/<userId>.jsonl` | **派生、可重建** | 带过期时间 |
| 画像 | `data/personality/` | 派生 | 滚动 |
| 任务簿 | `data/debug/tasks.json` | 派生 | 关闭后 90 天 |
| **审计** | `data/audit/<date>.jsonl` | **权威** | **root 属主，append-only** |
| trace / metrics | `data/trace/<date>.jsonl`、`data/metrics.jsonl` | 派生 | N 天 |
| 健康 / 上次良好 | `data/.health.json`、`data/.last-good.json` | 派生 | —— |
| 制品 | `/var/lib/hupo-apps/<appId>/<version>/` | 权威（+hash） | 版本保留，指针回滚 |
| 工作区 | `~/hupo-workspace/` | 草稿 | 配额 |
| 备份 | 本地第二目录（**加密**） | 副本 | N 天 + **演练记录** |
| 令牌 | `data/auth.json`（600）/ `data/revoked.json` / `data/auth-audit.jsonl` | 权威 | —— |

> ⚠️ `data/` 与 `*.jsonl` **不进 git**（`.gitignore` 已排除，**别改**）。
> ⚠️ **容器时代的路径见 `02-ARCHITECTURE.md` §二**（`/data/main`、`/data/workspaces/*`、`/data/hupo/*`）——两者是**同一批数据的两种布局**。

---

## 四、安全模型

### 4.1 来源分级 × 能力档（**两档，不是四档**）**【有效】**

| 来源 | 档位 |
|---|---|
| `owner`（主人原话，经鉴权通道 + 设备/构建指纹） | **受信档**：全权 |
| `product`（固定话术、画像块） | 受信档（**但它本来就不带工具调用**） |
| `derived`（网页 / 子 agent / 监控层 / 未复核记忆） | **吃到即降只读档** |
| `foreign`（小程序输入 / 制品内容 / 别的会话） | **只读档** |

**只读档** = `bash` / 写文件 / 改系统 / 对外发送**全部 deny**；
**但"只读工具"与"写工作区"不受限**——⚠️ 把文件工具整个禁掉会把"读文件"也一起杀掉，**agent 变废人**。

**清 taint 只在 host**（`dispatcher.say()` 收到 `owner` 时清）——**模型碰不到**。
如果模型能清自己的 taint，"读到网页 → 自己清 → 改系统"就是一条直路。

**无审批 UI**：问的方式是**对话里一句带新信息的话**（"查到了 3.2.1，要我直接升上去吗"）。
⛔ **不做**：审批弹窗、`request_capability` 一键授权、自动衰减。

**监控会话套同一套只读档**——它今天是**同权的第二个全权执行体**，这是要改的。

### 4.2 其他防线 **【有效】**

| 防线 | 内容 |
|---|---|
| **鉴权** | 口令 **fail-closed**（没设口令 ⇒ 除三个公开路由外一律 503）；XFF 取**最后一跳**；登录失败计数**落盘** |
| **密钥** | spawn 用**减法 env**（去掉 `*_API_KEY` / `*_TOKEN` / `*_SECRET`）；`~/.ssh` 与 `data/auth.json` 收权 |
| **自我修改** | 见 **P1**（助手只能提申请，签字的是主人）；策略文件 root 只读 + **开机前完整性校验** + 回退不需要助手 |
| **注入持久化** | 所有"会自动进未来上下文"的落点（人格 / 设置 / profile patch / 画像 / 手册）**都进完整性清单** |
| **制品** | 独立 origin + 沙箱 + hash + **版本不可变** + 发布走特权口 + 不可变审计（可倒查是哪句话生成的） |
| **出网** | 白名单 + 审计。⚠️ **承认防不住"带走它自己推理的结论"**，追求**可发现** |
| **合规** | **iOS 商店版不发布小程序运行时**（Apple 4.7.4 要"提交时冻结的清单"，与"运行时生成"冲突） |

---

## 五、成本与可观测性

### 5.1 成本三级 **【部分已取代】**

**三级：75 / 90 / 100**

| 档 | 行为 |
|---|---|
| 75% | 预警（开发者卡片 + 任务簿） |
| 90% | **降档但仍给结论**（不许静默、不许空白） |
| 100% | **才停**，且**必须留一句人话** |

**必须在开口之前停**（`message/end.reason` 不许是 `max-tokens` / `failed` 造的**半句**）。

**计数判据**：每轮 `steps 12` / `toolCalls 30` / `searches 6`。
**能力约束**：`maxParallelToolCalls 20`、`web-search.maxUses 10`（宿主现值，受上条约束）。

> ⚠️ **美元永不显示**（宁可显示"—"）。理由见 `02-ARCHITECTURE.md` §6.1 第 2 条。
> ⚠️ **`budget.js` 本轮不建** ⇒ 三级**暂时没有实现**，这一段是**目标口径**。

### 5.2 trace 与采样 **【有效】**

每轮落 `data/trace/<date>.jsonl`：

```
{ts, conversationId, bootId, dshSessionId, pid, promptChars, estPromptTokens,
 steps, toolCalls:{name:count}, searches, handoffPath, resumedAttempt,
 firstLineMs, firstSeenMs, gapMaxMs, turnEndMs, endReason,
 rssPeakBytes, exitCode, oomSuspect, cost:{measured:false}}
```

`hupo-sampler.timer`（**30 秒**）→ `data/metrics.jsonl`：
`memory.current/max`、`oom_kill`、`nr_throttled`、`disk freePct`、`agents.count`。

> ⚠️ **`tracer.js` 本轮不建** ⇒ 上面这张 trace 表是**目标口径**，不是现状。

### 5.3 告警 **【有效】**

**复用"调度器主动开口"，不新建通道**：

```
oom_kill > 0                              memory > 0.9×max 持续 5 分钟
节流增速 > 50%                             disk free < 15%
证书剩余 < 21 天                           备份连续 2 天失败
白名单外出站
```

**P0 = 立刻说一句人话**；**P1 = 进卡片 / 任务簿**；
**trace / 审计 / 遥测不进用户流**。

---

## 六、界面与浮窗规格

> ⚠️ **这里不写"长什么样"的数值**——那是代码的事（见 `README.md` 维护纪律 1）。
> **这里只留"铁律"**：那些**代码里查不到意图**、改了就会破坏设计的规则。

### 6.1 z 序三条铁律

| # | 铁律 | 为什么 |
|---|---|---|
| **Z1** | 聊天浮窗**永远**在 z 序最上，**任何页面（含小程序）都不能盖住它** | 主人的原话：**悬浮于一切之上** |
| **Z2** | 被盖住的小程序**不销毁、不重建、不 reload** | "被盖住"不等于"被杀"；**reload 会丢用户正在做的事** |
| **Z3** | **盖住不是铺满**：四边永远留边距 | 留着边缘才看得出"**它浮着**""下面还有东西" |

**Z2 的落地**：保持容器**挂载**（`Offstage` / `IndexedStack`），只关 Ticker 省电。

> **验收**：小程序打开后，对浮窗中心坐标做 hit test ⇒ 命中**聊天**，不是小程序。

### 6.2 三档与触发规则

**三档**：收起 / 半开 / 最大化。高度用**系数**表达（具体值在代码里）。

| 事件 | 结果 |
|---|---|
| **用户按下发送** | → **最大化**（发就拉满） |
| **只有状态变化**（thinking / working） | **不动**——状态不是"开口"，否则每次状态跳变都抽动窗口 |
| 点浮窗外面 / 点桌面空白 | → 收起 |
| 双击抓手 | 收起 ⇄ 回到上次档位 |
| **400ms 内的连续触发** | **合并成一次**（防抖：助手连发多段不该让窗口抖） |

> ⚠️ **【已取代】** 旧规格里还有一条"**助手开口说话（有新的一条调度器消息）→ 最大化**"。
> 它被 **D4.8 推翻**：**新增助手消息触发的高度变化必须 = 0px**
> ——"每说一句每收一句桌面就被抹掉一次"是**平板用户的主要放弃点**。
> ⇒ **只有"用户主动说话"才拉满。**

### 6.3 手势优先级（写死，避免打架）

| 手势 | 结果 |
|---|---|
| 竖向拖抓手 / 标题行 | 改高度（**跟手**，松手吸附） |
| 甩 | 下甩收起 / 上甩拉满。⚠️ **判据已改**（D3.7）：**速度 + 位移 + 时长三个都要满足**，且**要能关** |
| 双击抓手 | 收起 ⇄ 上次档位 |
| 点浮窗**内部** | **无反应，不许漏到下面** |
| 点收起态底部条 | 展开到上次档位 |
| 点桌面空白 | 收起 |

> ⚠️ **"点浮窗自己不该有任何反应"是靠 `HitTestBehavior.opaque` 挡的**——
> **这条必须保留**：`deferToChild` 挡不住，点空白会**漏到桌面**。

### 6.4 小程序 × 聊天共存（**小程序本轮不建，但规则是它的前提**）

| # | 规则 |
|---|---|
| 1 | **收起时不许压住小程序里可点的东西**：小程序内容**整体抬高**（`contentPadding.bottom = 收起高度 + 下边距`）。**是内缩，不是简单覆盖**——否则最后一行**永远点不到** |
| 2 | **展开时小程序被盖住，且要看得出来被盖住**：压暗 + 轻微缩小（`origin: bottomCenter`）+ 圆角加大 |
| 3 | **半开时，点小程序可见区域 = 收起聊天**，且**不把这次点击传给小程序**（用户的意图是"回到小程序"，不是"点某个按钮"） |
| 4 | **被盖住期间照常运行**（不许 pause 逻辑；"被盖住"≠"退到后台"），**回到可见不许重建**：滚动位置、表单内容、正在进行的请求**都要还在** |
| 5 | **打开小程序 ⇒ 聊天自动收起**（把屏幕让给小程序），但**仍在最下面那条** |

### 6.5 无障碍（**硬要求**）

| 项 | 要求 |
|---|---|
| **对比度** | 正文与浮窗底色 **≥ 4.5:1**；**来源小字**与底色 **≥ 4.5:1** |
| **触控目标** | **≥ 44**（视觉可以小，用透明 padding 撑命中区——D3.6） |
| **字号** | 容器**跟字算**（不是字跟容器），**不封顶**，五档硬闸（D3.5） |
| **收起态** | **必须有带字的展开入口**（不是 40px 无字箭头——D3.8） |

> ⚠️ **走查原稿里没有任何对比度数值**，**4.5:1 是这条规格自己给的要求**（它符合通用无障碍底线）。

### 6.6 空态禁令

**不许写"你好，我能帮你做什么"**——**人格硬规则禁止留客式追问**。
收起条显示"助手"；展开显示**一句引导**（不是邀请式提问）。

### 6.7 实现约束（都踩过）

| # | 约束 |
|---|---|
| 1 | 点浮窗自己**必须**用 `HitTestBehavior.opaque` 挡住 |
| 2 | **跟手拖拽期间动画 = 0ms**（手指按下的东西必须跟着手指） |
| 3 | **"还有件事在处理"的小标在收起态必须留着**——不能被浮窗吃掉 |
| 4 | 小程序容器要保持**挂载**（Z2） |

---

## 七、明确"已取代"与"不建"的（**别再照它们做**）

### 7.1 【已取代】旧的分期 S0–S7

旧架构把工程分成 **S0 止损 → S1 三件 → S2 小程序 → S3 其余地基 → S4 KV → S5 子 agent → S6 监控扩展 → S7 多用户**。

> ⚠️ **它被 `04-ROADMAP.md` 的批 0–6 取代**。
> 主要差别：**小程序运行时本轮不做**（旧 S2 是本轮主体）；
> **止损那一条已经并入批 1**（S1/S7/S8/S9/S10 五件就是"止损"）；
> **容器从"最后"变成"第二个用户的开门条件"**。

**只作历史，不要照它排期。**

### 7.2 【不建】**六个模块**

| 模块 | 原本要干什么 |
|---|---|
| `budget.js` | 成本三级 + 计数 |
| `tracer.js` | 每轮 trace + 周期采样 |
| `policy.js` | 来源分级 → 能力档；taint 状态 |
| `audit.js` | 系统级动作审计 |
| `apps.js` | 制品库：清单 / 上传 / 版本指针 / hash |
| `kv.js` | 记忆（`facts` 表） |

> ⚠️ **这六个一个都没有，而且本轮不排。**
> ⇒ 凡是要引用它们的段落（包括本文 §五），**先确认它还在不在本轮范围里**。
>
> ⚠️ **但它们的"规则"仍有效**：来源分级（N3）、记忆有出处（N4）、
> 可删除（N9）、拒绝给人话（N11）——**规则不因为模块没建而失效**，
> 只是**暂时没有实现载体**。

### 7.3 【不建】小程序运行时（本轮）

`mini/*` 四件 + `apps_client.dart` + 制品管线（独立 origin / 清单 / hash / 回滚）。

> ⚠️ **但 N1 / N2 仍然有效**（如果将来做，这两条是前提）。
> ⚠️ **内置图标不撤**（决策 D4.10）——它与小程序运行时是两回事。

### 7.4 【仍悬空】旧的悬空清单（**复核后的状态**）

| # | 旧悬空项 | 现在 |
|---|---|---|
| 1 | **uid 隔离：agent 仍挂 `danger-full-access` + 免密 sudo** | ⚠️ **部分已定**：**P1** 解决"助手能不能改自己"（选 B：提申请）、**P2** 解决"特权从哪来"（手动执行）。**但"容器还没做"** ⇒ 见 `04-ROADMAP.md` 批 6 |
| 2 | 对象存储凭据（备份升级） | ⏳ 仍悬空 |
| 3 | 续做上限是否升到 2 | ⏳ 仍悬空（现口径"全局 1"） |
| 4 | 记忆之外的 KV | ❌ **不建**（本轮） |
| 5 | 每会话独立 slice | ⏳ 并入批 6（容器） |
| 6 | 多用户 | ⏳ 批 6 |

> ⚠️ **第 1 项要单独记一笔**：P1 解决的是"**网页借 agent 的手**"；
> **"agent 自己的手有多大"**在容器做出来之前**只多了一道 taint 闸**。

---

## 八、iOS 与 Web 的构建发布

### 8.1 iOS 构建（**在 Mac 上编译**）**【有效】**

iOS 工程已经在 `apps/mobile/ios/`。**仓库里只放源码**；
Xcode 生成的机器相关文件（Podfile、Generated.xcconfig、ephemeral/）**在 Mac 首次构建时自动生成**。

| 需要 | 说明 |
|---|---|
| Xcode 15+ | 含模拟器 / 真机支持 |
| Flutter（stable） | 与仓库同代（本项目用 **3.35.1** 生成） |
| CocoaPods | 首次构建自动生成 Podfile 后用到 |

```bash
cd apps/mobile
flutter pub get
flutter run                 # 插上 iPhone，选设备

flutter build ios --release # 生成 Runner.app
flutter build ipa           # 上架/分发用的 .ipa
```

**签名（一次性）**：`open ios/Runner.xcworkspace` → Runner → **Signing & Capabilities**
→ 勾 **Automatically manage signing** → 选 Team。
**Bundle Identifier 默认 `com.hupo.app`**（RunnerTests 是 `com.hupo.app.RunnerTests`）。

**iOS 上的行为**：

| 行为 | 说明 |
|---|---|
| 连哪个服务器 | 见 §8.2 的域名 |
| 首次打开 | **登录页**（口令只在服务器上存哈希） |
| 登录后 | 令牌存本机，下次打开不用再输 |
| 开发者模式 | **默认关** |
| 切后台 / 断网 | 回来自动重连、自动补齐错过的消息 |

**已知边界（如实说）**：

- ⚠️ **没有推送通知**。iOS 会把后台 app 挂起 ⇒ 长任务做完时如果你没开着 app，**不会弹通知**；
  打开后自动补齐。**推送是下一步的事。**
- **图标还是 Flutter 默认占位**。替换：把全套尺寸的图换进
  `ios/Runner/Assets.xcassets/AppIcon.appiconset/`（**1024 那张必须有**）。
- **ATS 无需配置**（全链路 HTTPS）。
- 会申请**联网**权限；**不申请**相册 / 通讯录 / 定位 / 麦克风。

**常见坑**：

| 现象 | 处理 |
|---|---|
| `Podfile not found` | **不是问题**——首次 `flutter run` / `build ios` 会自动生成 |
| 报 `Generated.xcconfig` 缺失 | 同上，flutter 自动重建 |
| 签名失败 | 去 Xcode 里选 Team |
| `CocoaPods could not find compatible versions` | `cd ios && pod repo update && pod install` |

> ⚠️ **iOS 商店版不发布小程序运行时**（§4.2 合规那一条）。

### 8.2 Web 部署 **【有效】**

| 项 | 值 |
|---|---|
| **主域名** | **`https://hupo.stalkerai.cn`** |
| 备用域名 | `http://hupo.chat`（**仅 HTTP**，原因见下） |
| 静态根目录 | `/var/www/hupo` |
| nginx 配置 | `/etc/nginx/conf.d/hupo-stalkerai.conf`（+ `hupo-chat.conf`） |
| HTTPS | Let's Encrypt，certbot 自动续期（90 天） |

```bash
# 一条命令：静态分析 → 测试 → 构建 → 部署
scripts/deploy-web.sh
```

⚠️ **部署脚本会先跑 `flutter analyze` 与 `flutter test`，任一失败即中止**，
不会把坏构建推上线。**这就是"硬闸"的执行者。**

**首次部署（换机器）**：

```bash
# 1. 装 Flutter（约 1.44G 下载、2.4G 解压，注意磁盘）
mkdir -p ~/sdk && cd ~/sdk
curl -L -o flutter.tar.xz https://storage.flutter-io.cn/flutter_infra_release/releases/stable/linux/flutter_linux_3.35.1-stable.tar.xz
tar xf flutter.tar.xz && rm flutter.tar.xz
export PATH="$HOME/sdk/flutter/bin:$PATH"

# 2. 建目录与 nginx vhost
sudo mkdir -p /var/www/hupo /var/www/certbot

# 3. 部署 + 启 HTTPS
scripts/deploy-web.sh
scripts/enable-https.sh hupo.stalkerai.cn
```

**证书**：

```bash
sudo certbot certificates | grep -A3 hupo.stalkerai.cn
sudo certbot renew --dry-run --cert-name hupo.stalkerai.cn
```

⚠️ **certbot 同一时间只能跑一个实例**；报 `Another instance of Certbot is already running`
就等前一个跑完，**不要强行中断**（可能留下锁）。

#### ⚠️ 已知问题：`hupo.chat` 无法签发证书（**域名级拦截**）

**现象**：Let's Encrypt 验证持续 403；同一台机器、同一 nginx、同一插件的另一个域名
却 `dry run successful`。**唯一变量是域名。**

**排查到的证据**：

| 观察 | 结果 |
|---|---|
| LE 的请求是否到达本机 nginx | ✅ 是（访问日志有 `23.178.112.x`） |
| nginx 对 LE 的响应 | `200` 但 **0 字节** |
| 同一 URL 本机访问 | `200`、87 字节（正常） |
| 挑战文件状态（钩子自检） | 644、87 字节 ✅ |
| 换子域 | ❌ 同样 403 |
| 换域名 | ✅ **一次签成** |

**结论**：`hupo.chat` 存在**域名级拦截**。本机在**大陆**节点上，
80/443 对外提供服务的域名需要 **ICP 备案**——`*.stalkerai.cn` 已备案所以正常，
`hupo.chat` 大概率未备案。

**处理**：主域名用 `hupo.stalkerai.cn`。
若要用 `hupo.chat`，需先在云厂商完成备案（或确认没有配 CDN/WAF 拦截）。

#### 接入服务端

服务端就绪后，在 `hupo-stalkerai.conf` 的 443 server 块里放开 **API 反代**
（配置里已写好注释模板），客户端用 `WebSocketTransport` 而不是 mock。

协议见 `packages/protocol/PROTOCOL.md` —— **改协议先改那份**。

#### 运维备忘

- **磁盘**：部署前检查剩余空间（Flutter 构建缓存增长快；**曾因磁盘 92% 触发 `No space left on device`**）
- **清理构建缓存**：`cd apps/mobile && flutter clean`
- **静态产物带 hash**，可长缓存；`index.html` 与 `flutter_service_worker.js` **不缓存**

---

## 九、部署形态与服务单元 **【有效，数字待复核】**

```
Flutter App / Web
   │ HTTPS + WSS
   ▼
nginx
   ├─ 主域            → 壳（/var/www/hupo/current）+ /api/ 反代 127.0.0.1:8091
   │                    + 安全头（nosniff / XFO / HSTS）+ limit_req + limit_conn
   ├─ apps.<域>       → 制品，**只静态，绝不反代 /api/**
   └─ hupo.chat       → 301 到主域
   ▼
systemd
   ├─ concierge-core.service   MemoryHigh=640M  MemoryMax=1G  MemorySwapMax=0
   │                           OOMPolicy=continue  OOMScoreAdjust=-500  MemoryMin=256M
   │                           StartLimitIntervalSec=300  StartLimitBurst=6
   ├─ concierge-agents.slice   MemoryMax=700M（agent 子进程走 systemd-run --scope）
   ├─ build.slice              构建独立，CPUQuota=300%  CPUWeight=20
   └─ timer/service            hupo-backup / hupo-disk-guard / hupo-sampler
                               hupo-alert@ / hupo-cert-check
```

**端口纪律**：**nginx 只反代 `/api/` 到 8091；其他本地端口一律不进任何 server 块**
（写进配置文件顶部注释）。

⚠️ **上面这些数字来自"单用户那一代"的运维文档，本机未复核**——
用前先在生产机上核一遍（见 `06-OPERATIONS.md` §1.3）。

### 9.1 准入与容量 **【有效】**

**实测基线（运维观察值，不是承诺）**：

| 情形 | 内存 |
|---|---|
| 调度器常驻 | ≈ 80MB |
| 1 个活跃会话（产品 agent） | 195MB |
| 监控 agent 触发后 | +195MB（**将改为 review 完即杀**） |
| 一次客户端构建（Flutter 工具链） | +846MB |
| `dsh web` 宿主 | **866–872MB**（**区分复用哪一层**） |

**准入**：看内存占用比，**≥ 0.75 即拒新会话**（留 25% 给握手峰值与监控 agent）。
**拒绝必须**：一句人话 + 可重试 + **不建空 jsonl 文件**。

**没有计数闸**（不给数字，所以判据只能是内存）。

⚠️ **硬要求：构建必须移出主 cgroup**——
`1 会话 + 一次构建 = 1086MB > 1024MB`，**必然 OOM**（曾在一周内实测 4 次）。
