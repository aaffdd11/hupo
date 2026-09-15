# 个人 AI 助理 · 总架构 v7（定稿）

> **本文取代 `ARCHITECTURE-v6.md` 成为唯一权威版本**，但**只取代被 11 条拍板改动过的地方**（清单见 §15）。
> v6 里未被取代的部分（产品纪律、叙事、踩坑记录、附一至附十一的历史）**继续有效**，本文不重复。
>
> 输入：
> - `docs/ARCHITECTURE-three-layers.draft.md` v0.4 —— 三层深化 + 51 条风险 + 6 条事故链
> - `docs/pm-panel/` —— 三方 PM 面板（`SYNTHESIS.md`）+ **`DECISIONS.md`（11 条拍板，最高优先）**
> - `docs/UI-terminal-floating-chat.md` —— 终端 UI 设计稿
> - `packages/protocol/PROTOCOL.md` —— 客户端 ⇄ 调度器协议
>
> 细则见 `docs/design/`（细架构四份 + 索引）。本文只定**是什么、为什么、边界在哪**。

---

## 〇、一句话定义

> **一个会自己动手把事情办完的私人助理。**
> 终端是一条**永远浮在最上面**的聊天层；它说一句，调度器决定**现在答还是拿去做**；
> 真正干活的是**一个会话一个真 agent**，它会自己查、自己派活、把结论说回来。

---

## 一、三层 + 旁路（大图）

```
┌─ L1 终端层（Flutter：Web / iOS / Android）──────────────────────────────┐
│  壳：一条有序时间线（按 seq 排，**绝不配对**）                            │
│      quick + deep 同气泡 ｜ status 与正文不互转 ｜ 来源独立通道            │
│      服务重启抽色灰化 + 不可触达 + 自动恢复 ｜ 自动刷新 ｜ 发送失败可重试    │
│  容器：小程序运行时（H5 / 沙箱 / 独立 origin / 清单 / 版本 / 回滚）        │
│  桌面：图标墙（浮窗后面那一层；点空白 = 收起聊天）                         │
│  **只上报事实，不做判断**                                                │
└───────────────────────────┬────────────────────────────────────────────┘
              HTTPS + WebSocket（Bearer 令牌，WS 走子协议）
┌───────────────────────────▼────────────────────────────────────────────┐
│ L2 调度层（services/core，永续，systemd concierge-core:8091）           │
│  入口：/api/say（幂等）｜/api/stream（WS，sinceSeq 续传）｜/api/receipt   │
│  账本：conversation / message / task 三段 ID；created→completed          │
│        ↳ 重启对账：接着做完（**全局 ≤1 件** / 6h / ≤3 次）                │
│  节奏：15s 挪走 ｜ 180s 硬收口 ｜ cancel ｜ 失败必有合法收尾              │
│  策略：**内存闸准入 0.75**｜**成本三级 75/90/100**｜能力两档（按来源）     │
│        ｜审计 ｜trace ｜鉴权 fail-closed                                  │
│  制品：清单 / 静态（独立 origin）/ 上传（特权口，公网不可达）/ 版本         │
│  **不能有表达欲**（唯一例外：产品固定话术）                                │
└───────────────────────────┬────────────────────────────────────────────┘
                    stdio JSON-RPC（`dsh --profile sdk --patch <role>`）
┌───────────────────────────▼────────────────────────────────────────────┐
│ L3 工作层（可死可重启：一个会话 = 一个真 agent 进程）                     │
│  主 agent：人格 / 工具 / 上下文装配 / 跨重启接记忆 / 说话画像              │
│  子 agent：（后做）类型登记表 + spawn + 记账收口                          │
│  知识层：（后做）KV `facts` —— 只给主 agent 做装配简报                    │
│  工作区 ~/hupo-workspace：产物草稿                                        │
│  **永不直接对用户说话**（话由主 agent 出口）                              │
└─────────────────────────────────────────────────────────────────────────┘
        ▲ 旁路：监控层（独立 `debug:<会话>` 进程，**只读档**）
          时效（每轮免费计量）→ 机械规则 → 语义判断（60s 冷却）
          → 按**类别**立项的任务簿 → 修完关掉
```

**旁路为什么单独画**：它是**第二个执行体**，而且它的输入是主 agent 的输出（可被网页污染）。
所以它拿**只读档**，产出不许进"指令位"。

---

## 二、角色与职责矩阵

| 角色 | 定位 | 绝不做的 |
|---|---|---|
| **L1 终端** | 渲染一条有序时间线；装小程序；上报事实 | 不做任何判断（该不该刷新、这句合不合理，都不是它的事） |
| **L2 调度器** | 节奏、任务账本、协议翻译、对账续做、准入与预算、制品分发 | **不能有表达欲**（唯一例外：产品固定话术——"我单独拿去做"、"我没能给出结论"） |
| **L3 主 agent** | 先应一声 → 去查/去做 → 说结论；决定要不要派子 agent | **永不直接对用户说话**的例外：它就是说话的那个（L2 只帮它管节奏） |
| **L3 子 agent** | 按类型定义干专门活，输出回主 agent | 不许直接对用户说话；不许越过自己的工具档 |
| **L3 知识层** | 存/取 `facts`（带出处与采信） | 不是真相源（事件流才是）；无出处不写 |
| **监控层** | 审对话的时效/合理性/个性适配/（后做）越权与成本 | 不碰用户会话；产出不许进"指令位" |

---

## 三、命名与接口契约（**细架构必须照抄这一节**）

> 这一节是本文与 `docs/design/*` 之间的契约。四份细架构文档里出现的任何标识符，
> 都必须与这里一致；不一致的以本文为准。

### 3.1 身份标识

| 标识 | 形态 | 现状 |
|---|---|---|
| `userId` | 字符串，当前恒为 `owner` | ➕ 新增（现在没有） |
| `conversationId` | `u_<userId>:c_<name>`；存量 `c_main` / `c_probe` 走兼容映射 | ⚠ 形态变更 |
| `messageId` | `u_*`（客户端生成）｜`m_*`（服务端生成） | ✅ 已有 |
| `taskId` | `task_*` | ✅ 已有 |
| `appId` / `appVersion` | 小程序标识与版本（版本不可变） | ➕ 新增 |
| `agentType` | 子 agent 类型名（登记表里的 key） | ➕ 新增 |
| `source` / `provenance` | **来源分级**（见 §10）：`owner` / `product` / `derived` / `foreign` | ➕ 新增 |

### 3.2 L1 ⇄ L2（HTTP + WS）

| 接口 | 方法 | 暴露面 | 说明 |
|---|---|---|---|
| `/api/auth`、`/api/login` | GET / POST | 公开 | 登录；**没设口令时 fail-closed（503）** |
| `/api/version` | GET | 公开 | `buildId` + `serverNow`（客户端据此判断要不要刷新） |
| `/api/health` | GET | 需令牌 | 结构化健康：disk / store / agents / memory / upstream / cert |
| `/api/health/local` | GET | **只监听 127.0.0.1** | 给本机监控用（nginx 不转发 ⇒ 不违反"不做本机免鉴权"） |
| `/api/say` | POST | 需令牌 | `{conversationId, messageId, text, clientAt, source}`；**source 由服务端覆盖** |
| `/api/receipt` | POST | 需令牌 | 客户端回报"我看到了"（客户端自己的钟） |
| `/api/message/:id/cancel` | POST | 需令牌 | **校验归属** |
| `/api/conversations`、`/:id/events`、`/:id/export` | GET | 需令牌 | 列表 / 事件 / 导出（`md` 或 `jsonl`） |
| `/api/conversations/:id` | DELETE | 需令牌 | 墓碑 + 移入 `data/.trash/`，30 天后真删 |
| `/api/apps` | GET | 需令牌 | 小程序清单：`id/name/icon/version/sha256/permissions/minShellVersion` |
| `/api/apps`、`/api/apps/:id/rollback` | POST | 需令牌（rollback）/ **特权口**（上传） | 上传**不在公网路径上** |
| `/api/stream` | WS | 需令牌（子协议 `['bearer', token]`） | 下行事件；`sinceSeq` 续传；`dev=1` **是附加通道不是替代** |
| `/api/debug/report`、`/api/debug/tasks`、`/api/debug/analyze` | GET/POST | 需令牌 | 监控出口；**`analyze` 删掉 `force` 参数** + 每日次数上限 |

### 3.3 L2 → L1 事件（均在 `PROTOCOL.md`，此处只列新增）

| 事件 | 说明 |
|---|---|
| `message/start.source` | 这条回应的触发来源（`owner` / `app:<id>`）—— 让"来自小程序"在界面上可见 |
| `app/installed`、`app/update-available`、`app/error` | 小程序生命周期（**每个"进行中"都要有配对收口 + 超时**） |
| `miniapp/load-failed` | 容器校验 hash 失败并回退 `last-known-good` |
| `audit/notice` | **只在开发者通道推**：刚发生一次"改系统"档动作（不进用户流） |

### 3.4 L2 ⇄ L3（stdio JSON-RPC）

| 方向 | 方法 | 说明 |
|---|---|---|
| L2→L3 | `initialize` | `{cwd, provider, model, reasoningEffort, maxTokens}` |
| L2→L3 | `session/prompt` | `{sessionId, contentBlocks}`；未知 sessionId **惰性新建** |
| L3→L2 | `session.event` | 完整会话日志事件（**按 step 整段到达，无 token 级 delta**） |
| L3→L2 | `session.status` | `running` / `idle` |
| L3→L2 | `subagent.*` | 子 agent 起落 |

**spawn 契约**（细架构 L3 落地）：
```
dsh --profile sdk --patch <role-patch-路径>
env: { 白名单 env（去掉 *_API_KEY/*_TOKEN/*_SECRET）, DSH_PERMISSION_MODE: read-only|workspace-write,
       DSH_HOME(将来按用户) }
cwd: agentCwd
```
**role**：`owner`（默认，全权但受 taint 约束）/ `untrusted`（只读档）/ `monitor`（只读档）。

### 3.5 L2 内部模块（`services/core/src/`）

| 模块 | 职责 | 状态 |
|---|---|---|
| `index.js` / `server.js` / `config.js` | 启动、路由、配置 | ✅ |
| `auth.js` | scrypt + HMAC 无状态令牌 + 限速（**fail-closed**） | ⚠ 改造 |
| `store.js` | 事件流落盘（**写失败必须上抛**） | ⚠ 改造 |
| `conversation.js` | `Conversation` / `MessageWriter` / 时间线上下文 | ✅ |
| `session-translate.js` | agent 事件 → 产品事件 | ✅ |
| `dispatcher.js` | 节奏 + 账本 + 对账续做 | ✅ |
| `agent-runtime.js` | 进程池 + spawn 契约 + LRU + 遥测 | ⚠ 改造 |
| `debug-agent.js` / `personality.js` | 监控层 | ✅ |
| `client-build.js` | 整包构建指纹 | ✅ |
| **`admission.js`** | 内存闸（`memory.current/max ≥ 0.75` 即拒）+ 拒绝话术 | ➕ 新增 |
| **`budget.js`** | 成本三级 + 计数（steps / toolCalls / searches） | ➕ 新增 |
| **`tracer.js`** | 每轮 trace + 周期采样 | ➕ 新增 |
| **`policy.js`** | 来源分级 → 能力档；taint 状态（**只在 host 清**） | ➕ 新增 |
| **`audit.js`** | 系统级动作审计（root 属主 append-only） | ➕ 新增 |
| **`apps.js`** | 制品库：清单 / 上传（特权口）/ 版本指针 / hash | ➕ 新增 |
| **`kv.js`** | `facts` 表（带 source/trust） | ➕ 新增（后做） |

### 3.6 L1 内部（`apps/mobile/lib/`）

| 模块 | 职责 | 状态 |
|---|---|---|
| `screens/chat_screen.dart` | **浮窗**（三档 / 抓手 / 覆盖退让 / 拦截层） | ⚠ z 序要改 |
| `widgets/app_desktop.dart` | 桌面（浮窗后面那层） | ✅ |
| `widgets/mini_app_container.dart` | 容器壳（标题栏 / 返回栈 / 关闭） | ⚠ 加 `bottomInset` + 保持挂载 |
| `widgets/answer_bubble.dart` | 气泡（quick+deep / 来源） | ⚠ 链接 scheme 白名单 |
| **`mini/runtime.dart`** | 沙箱运行时（Web：`sandbox` iframe；原生：受限 WebView） | ➕ 新增 |
| **`mini/manifest.dart`** | `MiniAppManifest` 解析 + 校验（含 `minShellVersion`、`sha256`） | ➕ 新增 |
| **`mini/store.dart`** | 本地安装 / 版本目录 / 回退 `last-known-good` | ➕ 新增 |
| **`mini/bridge.dart`** | 容器代发（`say` 打 `source: app:<id>`）、`postMessage` 校 `event.origin` | ➕ 新增 |
| **`services/apps_client.dart`** | 拉 `/api/apps` 清单 | ➕ 新增 |

---

## 四、关键时序

### 4.1 一轮对话（含两块回答）

```
t=0      主人说话
t≈10ms   L2：幂等 → 内存闸 → 写 user/echo（带 source）→ 交给该会话的 agent
t≈1.1s   L3 主 agent 第一段文本（"先应一声"，**与工具调用同一轮**）→ quick
t≈1.5s   （如需要）它自己 web_search / web_fetch —— **此刻置 taint**
t≈6-14s  工具跑完 → 最终文本 → deep（**同一个气泡**，第一句天然承接）
         └ 来源走 `message/*.sources` 通道；没联网就传空数组，界面一个字都不显示
t≈end    L2 收口 → 落账 → 监控层计量（免费）→ 规则触发才叫 debug agent（花钱，60s 冷却）
```

### 4.2 "这件事要很久"

```
15s 还没完 → L2 说 HANDOFF_LINE（固定话术）→ **先收口当前气泡**，再另起一条
           → task/created（存**主人原话**）→ 不再占用当前对话
做完      → agent 主动开口（proactive，必要时 interrupts: true）报结果
```
⚠ **消息不许交叉**（v6 附九的不变量）：一条消息开始后，不许再有别的消息正文写进更早那条。

### 4.3 被打断 → 接着做完

```
开机 → 扫未完成任务（task/created 无配对 completed）
     → **全局最多 1 件**、>6h 放弃、同一件 ≤3 次、**先看内存闸**
     → 说一句"之前那件事我接着做完"→ 重派（原话 + 工作区真实状态，不靠内存）
     → 这一轮结束 = 交回分配器 ⇒ 收口
⚠ 上游失败 / OOM **不计入** 3 次额度（否则主人收到的是假话）
⚠ 崩溃环时（5 分钟内 ≥3 次启动且上次日志有 oom-kill）⇒ **降级启动**：不续做、只服务对话
```

### 4.4 小程序交付闭环（本轮新增）

```
主人：「帮我做个能筛选的表」
  → L3 写 H5（工作区）→ 生成 manifest（含 sha256）
  → 传制品（**特权口**，不在公网路径）→ 版本目录不可变 + 审计落一条
  → 清单更新 → L1 收到 app/update-available（或下次开桌面时拉）
  → 下载 → **校验 sha256** → installed
  → 主人点开 → running（沙箱 / 无令牌 / `connect-src 'none'` / 独立 origin）
  → agent 主动开口报结果
⚠ 部署整包**不许**动制品（`rsync --exclude`）；被盖住的小程序**不重建**
```

### 4.5 记忆读出口

```
本轮 → 只读 `facts` 里与本轮相关的条目（**尾部追加**，前缀字节不变）
     → 作为主 agent 的"装配简报"（用来决定派哪个子 agent / 要不要新建）
❌ 本轮不给"KV 直接出话"出口（快答由主 agent 第一段文本承担）
```

---

## 五、11 条决定的落点（映射表）

| 决定 | 落在哪 |
|---|---|
| 1 止损六条 + 顺手四行 | §14 S0；细架构「运维与安全」 |
| 2 小程序直接做最小形态 | §4.4；细架构「L1 终端」+「运维与安全」的制品部分 |
| 3 容量**不写数字** | §11（只有内存闸，无计数闸；实测基线标注**非承诺**） |
| 4 只一道内存闸 0.75 | §11；细架构「L2 调度器」的 `admission.js` |
| 5 成本三级 75/90/100 | §12；细架构「L2 调度器」的 `budget.js` |
| 6 两档 + 无审批 UI + 监控降权 | §10；`policy.js` + role patch |
| 7 只建 `facts` | §四·4.5；`kv.js` |
| 8 UI 全做 | 细架构「L1 终端」（Z1 是前提） |
| 9 止损 → 三件 → 开工 | §14 顺序 |
| 10 续做全局 1 | §4.3 |
| 11 备份先本地第二目录 | 细架构「运维与安全」 |

---

## 六、不变量（继承 v6 + 本次新增）

### 6.1 继承（不改）

R1 记忆隔离三层 ｜ R2 只追加不改前缀 ｜ R3 情绪只影响"怎么说" ｜ R4 默认只对主人回应 ｜
R5 反馈层上下文含接收层全文 ｜ R11 每个事件都有时间戳 ｜ 消息不许交叉 ｜ 前端是哑的 ｜
协议 R1–R14（客户端六条 + 来源通道 + 刷新护栏 + 灰化不可触达）

### 6.2 新增

| # | 不变量 |
|---|---|
| **N1** | 执行第三方代码的东西（小程序）**绝不与持有令牌的原点同源** |
| **N2** | 制品**不能自授权**：小程序拿不到任何"能指挥 agent"的能力 |
| **N3** | **来源分级**：进入 agent 上下文的一切都带来源标签，能力按来源分级 |
| **N4** | **记忆有出处**：KV 每条带 `source`/`trust`，无出处不写；未采信不得作行动依据 |
| **N5** | **可回退**：任何系统改动生效前必须有回退点，且回退**不需要 agent** |
| **N6** | **KV 不是真相源**：事件流才是权威，冲突以事件流为准 |
| **N7** | **不拿不真实的状态污染记录**（写进记录前先问"这条一直是假的怎么办"） |
| **N8** | **预算先于任务**：一切会 fan-out 的动作都吃显式预算 |
| **N9** | **可删除**：任何存储都要能回答"这条怎么删干净" |
| **N10** | **沉默优于编造**；**超时必须伴随资源回收**（收气泡 ≠ 停 agent） |
| **N11** | **拒绝要给人话**：满/超预算/上游挂，都必须是一句人话 + 可重试，不是静默 |

---

## 七、数据与存储

| 数据 | 位置 | 权威性 | 保留 |
|---|---|---|---|
| 事件流（正史） | `data/<conv>.jsonl` | **权威** | 长期 + 归档 |
| 归档 | `data/archive/` | 权威 | 30 天或人工 |
| `facts` | `data/kv/<userId>.jsonl` | 派生、可重建 | 带 `expiresAt` |
| 画像 | `data/personality/` | 派生 | 滚动 |
| 任务簿 | `data/debug/tasks.json` | 派生 | 关闭后 90 天 |
| **审计** | `data/audit/<date>.jsonl` | 权威 | N 天（**root 属主 append-only**） |
| **trace / metrics** | `data/trace/<date>.jsonl`、`data/metrics.jsonl` | 派生 | N 天 |
| 健康 / 上次良好 | `data/.health.json`、`data/.last-good.json` | 派生 | — |
| 制品 | `/var/lib/hupo-apps/<appId>/<version>/` | 权威（+hash） | 版本保留，指针回滚 |
| 工作区 | `~/hupo-workspace/` | 草稿 | 配额 |
| 备份 | `/home/deploy/backups/`（本地第二目录，加密） | 副本 | N 天 + 演练记录 |
| 令牌 | `data/auth.json`(600) / `data/revoked.json` / `data/auth-audit.jsonl` | 权威 | — |

⚠ `data/` 与 `*.jsonl` **不进 git**（`.gitignore` 已排除，别改）。

---

## 八、部署形态

```
Flutter App / Web
   │ HTTPS + WSS
   ▼
nginx
   ├─ hupo.stalkerai.cn  → 壳（/var/www/hupo/current）+ /api/ 反代 127.0.0.1:8091
   │                        + 安全头（nosniff / XFO / HSTS）+ limit_req + limit_conn
   ├─ apps.<域>          → 制品（/var/lib/hupo-apps）**只静态，绝不反代 /api/**
   └─ hupo.chat          → 301 到主域（现在它是明文且共用同一棵根）
   ▼
systemd
   ├─ concierge-core.service   MemoryHigh=640M MemoryMax=1G MemorySwapMax=0
   │                           OOMPolicy=continue  OOMScoreAdjust=-500  MemoryMin=256M
   │                           StartLimitIntervalSec=300  StartLimitBurst=6
   ├─ concierge-agents.slice   MemoryMax=700M（agent 子进程走 systemd-run --scope）
   ├─ build.slice              构建（flutter）独立，CPUQuota=300% CPUWeight=20
   └─ timer/service            hupo-backup / hupo-disk-guard / hupo-sampler
                               hupo-alert@ / hupo-cert-check
   ▼
数据：事件流 + facts + 审计 + trace + 制品 + 备份
```

端口纪律：**nginx 只反代 `/api/` 到 8091；其他本地端口一律不进任何 server 块**（写进配置文件顶部注释）。

---

## 九、容量与资源（**不写承诺数字**）

实测基线（**运维观察值，不是承诺**——随构建与监控触发波动）：

| 情形 | 内存 |
|---|---|
| 调度器常驻 | 68 MB |
| 1 个活跃会话（产品 agent） | 172 MB |
| 监控 agent 触发后（驻留 ≤30 分钟，**将改为 review 完即杀**） | +172~195 MB |
| 一次客户端构建（Flutter 工具链） | +846 MB |

**准入**：开机看 `memory.current / memory.max`，**≥ 0.75 即拒新会话**（留 25% 给握手峰值与监控 agent）。
拒绝必须：一句人话 + 可重试 + **不建空 jsonl 文件**。
**没有计数闸**（不给数字，所以判据只能是内存）。
**硬要求**：构建必须移出主 cgroup——`1 会话 + 一次构建 = 1086MB > 1024MB`，**必然 OOM**（近 7 天实测 4 次）。

---

## 十、安全模型

### 10.1 来源分级 × 能力档（**两档**，不是四档）

| 来源 | 档位 |
|---|---|
| `owner`（主人原话，经鉴权通道 + 设备/构建指纹） | **受信档**：全权 |
| `product`（固定话术、画像块） | 受信档（但它本来就不带工具调用） |
| `derived`（网页 / 子 agent / 监控层 / 未复核 KV） | **吃到即降只读档** |
| `foreign`（小程序输入 / 制品内容 / 别的会话） | **只读档** |

**只读档** = `bash` / 写文件 / 改系统 / 对外发送 全部 deny（**只读工具与"写工作区"不受限**，否则 agent 变废人）。
**清 taint 只在 host**（`dispatcher.say()` 收到 `owner` 时清）——**模型碰不到**。
**无审批 UI**：问的方式是对话里一句带新信息的话（"查到了 3.2.1，要我直接升上去吗"）。
**监控会话套同一套只读档**（它今天是同权的第二个全权执行体）。

### 10.2 其他防线（S0/S1 落地）

| 防线 | 内容 |
|---|---|
| 鉴权 | 口令 **fail-closed**（没设口令 ⇒ 除三个公开路由外一律 503）；XFF 取**最后一跳**；登录失败计数落盘 |
| 密钥 | spawn 用**白名单 env**（去掉 `*_API_KEY`/`*_TOKEN`/`*_SECRET`）；`~/.ssh`、`data/auth.json` 收权 |
| 自我修改 | 策略文件 root 只读 + **spawn 前完整性校验**（不一致就拒绝启动 + 告警）+ 单向往回退点管线 |
| 注入持久化 | 所有"会自动进未来上下文"的落点（人格 / 设置 / profile patch / 画像 / 手册）都进完整性清单 |
| 制品 | 独立 origin + 沙箱 + hash + 版本不可变 + **发布走特权口** + 不可变审计（可倒查是哪句话生成的） |
| 出网 | 白名单 + 审计（承认防不住"带走它自己推理的结论"，追求**可发现**） |
| 合规 | **iOS 商店版不发布小程序运行时**（Apple 4.7.4 要"提交时冻结的清单"，与"运行时生成"冲突 ⇒ 分工） |

---

## 十一、成本模型

**三级 75 / 90 / 100**：
- 75% 预警（开发者卡片 + 任务簿）
- 90% **降档但仍给结论**（不许静默、不许空白）
- 100% **才停**，且必须留一句人话
- **必须在开口之前停**（`message/end.reason` 不许是 `max-tokens` / `failed` 造的半句）

**判据（第一版只能用计数）**：`maxStepsPerTurn 12` / `maxToolCallsPerTurn 30` / `maxSearchesPerTurn 6`。
⚠ **技术前提**：DSH 的 session 事件**没有 token 用量** ⇒ 算不出美元 ⇒ **不显示估算美元**（宁可显示"—"）。
**删掉** `/api/debug/analyze` 的 `force`（它绕过 60s 冷却，可无限刷）。

---

## 十二、可观测性

每轮落 `data/trace/<date>.jsonl`：
`{ts, conversationId, bootId, dshSessionId, pid, promptChars, estPromptTokens, steps,
  toolCalls:{name:count}, searches, handoffPath, resumedAttempt, firstLineMs, firstSeenMs,
  gapMaxMs, turnEndMs, endReason, rssPeakBytes, exitCode, oomSuspect, cost:{measured:false}}`

`hupo-sampler.timer`（30s）→ `data/metrics.jsonl`：`memory.current/max`、`oom_kill`、`nr_throttled`、`disk freePct`、`agents.count`。

**告警**（复用"调度器主动开口"，不新建通道）：`oom_kill>0` ｜ `memory > 0.9×max` 持续 5 分钟 ｜
节流增速 >50% ｜ `disk free <15%` ｜ 证书剩余 <21 天 ｜ 备份连续 2 天失败 ｜ 白名单外出站。
**P0 立刻说一句人话**；P1 进卡片/任务簿；trace/审计/遥测**不进用户流**。

---

## 十三、分期

| 期 | 内容 | 门禁 |
|---|---|---|
| **S0 止损**（小时级） | OOMPolicy=continue ｜ StartLimit 收紧 ｜ 构建出 cgroup ｜ 续做全局 1 + 内存闸 ｜ 失败分类不计额度 ｜ 鉴权 fail-closed ｜（顺手四行）XFF 最后一跳 / rsync --exclude / data chmod 600 / 安全响应头 | 灌内存后调度器仍 active、用户收到一句人话、`Scheduled restart job` 不增加 |
| **S1 只补三件** | 独立 origin ｜ 制品搬出站点根 + `--exclude` ｜ 发布走特权管线 | 跑一次部署后制品**逐字节不变**；公网不可写；回滚一条命令 |
| **S2 小程序最小形态**（+ UI 同批） | agent 写 H5 → 上传 → 容器能开能用；不联网 / 无权限生态 / 不许反向发话；iOS 不发运行时；**Z1 + 拦截层 + 覆盖退让** | 说完到能点开 ≤1 轮 + 1 次刷新；读不到令牌；对浮窗中心 hit test 命中聊天；被盖住不重建 |
| **S3 其余地基**（与 S2 并行） | 密钥收权 / 完整性校验 / 审计根属主 / 备份本地第二目录 + 演练 / 准入闸 / 成本三级 + trace / slice 分层 | 恢复演练真跑过一次；红队用例进 CI 全绿 |
| **S4 KV `facts`** | 带出处与采信；只给主 agent 装配简报 | 投毒用例全绿；KV 可重建 |
| **S5 子 agent** | 类型登记表 + `spawn_agent` + 记账收口 + `toolFilter`/`maxDepth` | 派活的"进行中"有配对不变量 |
| **S6 监控扩展** | 小程序行为 / 越权动作 / 成本 / 回归 + **监控角色降权** | 监控会话跑 `bash` 必须被拒 |
| **S7 多用户** | 条件触发 | 两个 `sub` 交叉读不到 |

---

## 十四、与 v6 的差异裁决（本文**取代**这些条目）

| v6 说 | 本文改成 | 依据 |
|---|---|---|
| "单机同时在线 **8–12 人**" | **删掉，不写数字**（只有内存闸 + "满了明确拒绝"） | 拍板第 3 条 |
| 控制器"不能有表达欲" | 保留，但**明写唯一例外**：产品固定话术 | 现状本来就是例外，写明免得被误读 |
| 交付形态 T1–T4，T3/T4 H5 容器 | **本轮只做最小形态**（不联网/无权限/不反向发话）；iOS 不发运行时 | 拍板第 2 条 |
| 记忆 = 事件流 + DSH 会话持久化 | **新增 L3 知识层，但只建 `facts`**；KV 是派生数据不是真相源 | 拍板第 7 条 |
| 分阶段 P0–P5 | **改成 S0–S7**（先止损、再开工、地基并行） | 拍板第 1/9 条 |
| 级联 / 说话人识别 / 被动模式（P5） | **仍不做**（不在本轮 S0–S7 内） | 未变 |
| 控制器"只剩节奏" | 扩容：**准入 + 预算 + 来源策略 + 制品分发**也是它的 | 本轮新增 |

**v6 里继续有效的部分**（本文不重复）：四条角色定位与纠偏、五条纪律 R1–R5、四档交付形态的定义、
主/被动对话、情绪与前提、工程红线、附一至附十一（含三起真实的"页面在说假话"事故与修法）。

---

## 十五、仍然悬空的（不阻塞本轮）

| # | 悬空项 | 何时处理 |
|---|---|---|
| 1 | **uid 隔离**：agent 现在仍挂 `danger-full-access` + **免密 sudo** | ⚠ 见下 |
| 2 | 对象存储凭据（备份升级） | 你给出后 |
| 3 | 续做上限是否升 2 | 观察一周 |
| 4 | `facts` 之外的 KV（`experience` / `taxonomy`） | 子 agent 体系落地后 |
| 5 | 每会话独立 systemd slice | S3（它是"内存闸变准"的前提） |
| 6 | 多用户 | S7 |

> ⚠ **第 1 项要单独记一笔**：拍板第 6 条解决的是"**网页借 agent 的手**"，
> 没有解决"**agent 自己的手有多大**"。只要它还挂着免密 sudo，
> 一次成功注入（或一次被诱导的主人原话轮次）仍能改系统——现在只是**多了一道 taint 闸**。
> 这一条留到下一轮拍板。
