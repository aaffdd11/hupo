# 开发文档（目标态）

> **这份文档回答一个问题：改完之后，代码长什么样。**
>
> 它**不回答**"先做什么后做什么"（那是 `R2-MASTER-PLAN.md`）、
> **不回答**"产品要什么"（那是 `R2-DECISIONS.md`）、
> **不回答**"为什么是这样"（那是 `ai-phone-architecture.md` 与 `R2-plan-review.md`）。
>
> **防过期的纪律（重要）**：
> - 本文只写**结构 + 契约**——文件放哪、谁依赖谁、字段什么意思、状态怎么转。**这些变得慢。**
> - **不写实现细节、不写数值**——函数怎么写、阈值取多少，那些只住在代码与 `R2-DECISIONS.md` 里。**写在这里必过期。**
> - 冲突时**以代码为准，然后回来改本文**，而不是反过来。
>
> **标记约定**：**【现状】** = 已在代码里（带文件:行）｜**【目标】** = 要做成的样子｜**【不做】** = 明确不建

---

## 〇、目录

| 节 | 内容 | 谁在用 |
|---|---|---|
| **一** | **模块图**：改完之后文件长什么样、谁依赖谁 | 所有人 |
| **二** | **协议 v2**：客户端 ⇄ 调度器的字段增补（**唯一有硬时点的一节**） | 调度层 / 客户端 |
| **三** | **状态机与数据模型** | 调度层 / 客户端 |
| **四** | **接口契约**：服务端内部模块之间 | 调度层 |
| **五** | **测试地图**：哪一层归哪道闸 | 所有人 |
| **六** | **文件级改动总索引**：七批汇总成一张表 | 排期 / 评估冲突 |

---

## 一、模块图

### 1.1 依赖方向（**硬规则，反了就重构**）

```
models/      纯数据与解析。只依赖 dart:core / foundation，**不许依赖 material**
   ↑
services/    状态与传输。依赖 models。**不许 import widgets/ 或 screens/**
   ↑
widgets/     渲染。依赖 models + services（**只读状态、只发意图**，不自己改状态）
   ↑
screens/     装配。依赖以上全部
   ↑
apps/        内置应用。**只通过 `MiniAppEnv` 拿能力**，不直接摸 screens/
```

**三条禁令**：
1. `models/` **不许** `import 'package:flutter/material.dart'`（除 `foundation`）
2. `widgets/` **不许** `import '../services/xxx_transport.dart'` 这类——只能通过 controller
3. `apps/` **不许** `import '../screens/'`

### 1.2 客户端 `apps/mobile/lib/`（【现状】5791 行）

**【现状】**
```
main.dart                          252
screens/  chat_screen 866 · conversation_list_screen 242 · login_screen 134
widgets/  dev_card 416 · answer_bubble 201 · app_desktop 178 ·
          mini_app_container 165
apps/     weather_app 584 · mini_app 78 · about_app 70 · app_registry 57 ·
          conversations_app 48 · dev_mode_app 22
models/   stream_event 303 · timeline 205 · agent_status 138 · dev_step 50
services/ mock_transport 423 · chat_controller 445 · weather 313 ·
          websocket_transport 310 · city_catalog 83 · transport 89 ·
          token_store 36 · dev_mode 29 · page_reload* 3 个 39 · app_version 15
```

**【目标】结构（按批次）**

| 批 | 新增 | 说明 |
|---|---|---|
| 1 | `services/timeline_store.dart` | 本地缓存最近一屏（B6）。**只缓存，不判断**；必须带 `scopeId + userId` 命名空间 |
| 2 | `models/scope_name.dart` | 命名。**唯一职责：从用户原话里取词**（D1：不许系统造词） |
| 3 | `widgets/system_notice.dart` | **系统说话通道**（R3）。**与聊天气泡是两条不同的通道** |
| 3 | `widgets/panel_geometry.dart` | 从 `chat_screen.dart` 抽出：`_collapsedH` / `_spanFor` / `_panelHeight` / 档位吸附 / 甩判据 / 转屏吸附。**无 State、无 context 的纯函数 + 值类** |
| 3 | `widgets/timeline_pager.dart` | 抽出分页：`_visibleCount` / `_hiddenRows` / `_showOlder` / `_fillViewportIfNeeded` |
| 3 | `widgets/panel_shell.dart` · `panel_header.dart` · `composer.dart` · `user_bubble.dart` | 从 `chat_screen.dart` 拆出。**拆完 `chat_screen.dart` ≤ 300 行** |
| 5 | `services/voice_input.dart` | 语音。**唯一需要新 Flutter 插件的模块** |

**【目标的 `chat_screen.dart`】**：≤300 行，只做装配（三层 Stack + 把 controller 的数据分发给子组件）。**所有能算的东西都不在这里。**

### 1.3 服务端 `services/core/src/`（【现状】3841 行）

**【现状】**
```
index 53 · server 385 · config 114 · auth 197 · store 117 · conversation 362 ·
session-translate 368 · dispatcher 832 · agent-runtime 423 · debug-agent 648 ·
personality 268 · client-build 74 · auth-cli.mjs
```

**【目标】新增模块（按批次）**

| 批 | 新增 | 职责 | 不许做 |
|---|---|---|---|
| 4 | `capability-registry.js` | **能力登记表**：每个能力声明"叫什么 / 输入 schema / 输出 schema / 有无副作用 / 要不要存东西" | **不许**让模型发明接口 |
| 4 | `worklog.js` | 第一个真数据源（工时账）。**只追加，不原地改** | 不许自动抽取（只认明说的"记一笔"） |
| 6 | `integrity.js` | 完整性校验：读 `scripts/integrity-manifest.json`，逐文件 sha256 | **不许**能改清单自己 |
| 6 | `admission.js` | 准入：内存闸 + **先 LRU 卸载、再谈拒绝** | 不许静默拒绝（必须一句人话） |

**【明确不建】**（v7 列过，但**本轮不在任何批次里**）：
`budget.js`（成本三级）/ `tracer.js`（每轮 trace）/ `policy.js`（来源分级 → 能力档）/
`audit.js`（系统级动作审计）/ `apps.js`（小程序制品库）/ `kv.js`（v7 的记忆 KV）

> ⚠️ **这六个"不建"要写在显眼处**——因为它们**在 v7 里是"➕ 新增"**，
> 读者会以为它们已经有了或即将有。**现实是：一个都没有，而且本轮不排。**

**【目标的 `dispatcher.js`】**：832 行，**本轮的改动集中在四处**——
`say()`（准入 + 焦点）、`#wire`（会话级 cwd + env 白名单）、`#escalate`（收口顺序）、
`devStep → step/*`（D7 的产品事件）。**不做大重构。**

### 1.4 客户端的两个"结构性欠账"

| # | 欠账 | 现状 | 目标 |
|---|---|---|---|
| 1 | **`chat_screen.dart` 866 行管三件事** | 浮窗几何 + 列表分页 + 页面装配混在一起 | 拆成 §1.2 那六件；**几何与分页变成纯逻辑，进 `test/unit` 硬闸** |
| 2 | **`websocket_transport` 是会话级却当单例用** | `_conversationId` / `_sinceSeq` 是单实例字段 | 按会话可实例化，或拆成 `Connection`（重连/令牌）+ `Session`（会话/序号） |

> 第 2 条是**批 0-a 那个决策**要解决的。**没定之前不许动它。**

---

## 二、协议 v2（**唯一有硬时点的一节**）

> **为什么它有时点**：**协议一旦上线就冻结**（旧客户端还在跑）。
> 字段名改一次，就要多背一个兼容分支。
> 这条正是你们自己的纪律：**"当场不记，以后永远补不回来"**。

### 2.1 【现状】九个事件（`packages/protocol/PROTOCOL.md`）

`message/start` · `message/text` · `message/status` · `message/end` · `message/seen` ·
`task/created` · `task/completed` · `user/echo` · `client/reload`（+ `error`）

**R1–R14 继续有效**（不配对 / quick+deep 同一气泡 / status 不进正文 / 中止不擦除 /
seq 去重 / 不断言进度 / 来源不塞正文 / end 的来源权威 / 刷新先说完 / 每次连上对版本 /
每事件有时间戳 / 只回报连上之后 / 灰化不可触达 / 重启由服务端说）。

### 2.2 【目标】增补字段（**现在就定名，之后不许改语义**）

| 字段 | 加在哪 | 类型 | 谁填 | 什么意思 |
|---|---|---|---|---|
| **`scopeId`** | `message/start`、`user/echo`、`task/*` | string | 调度器 | 这条属于哪个作用域（= 一条 DSH 会话）。**客户端 v1 可以不显示，但字段必须在**（N23） |
| **`source`** | `message/start` | enum | 调度器 | `user` / `dispatcher` / `agent:<scopeId>`。**不只是显示用——它同时是权限判据** |
| **`reRefs[]`** | `message/start` | `[{scopeId, seq}]` | 调度器 | 回跳指针。⚠️ **不许改 `re` 的类型**（现在是 `List<String>`，改了旧客户端解析会崩） |
| **`catchUp`** | 任何补发的帧 | bool | 调度器 | `true` = 这是断线补发的历史，不是刚发生的 |
| **`timeline/marker`** | 新事件 | `{kind: 'away' \| 'enter' \| 'leave', label?}` | 调度器 | 时间线上的分隔（"你不在的时候" / "进入「小升初」"）。**不进消息列表，占一个位置** |
| **`step/summary`** | 新事件 | `{text}` | 调度器 | D7 默认档：一句人话（"在查资料"）。**必须是人话，不许出现内部名** |
| **`step/detail`** | 新事件 | `{tool, target, ms, ok}` | 调度器 | D7 第三档：步骤流水 |
| **`step/reasoning`** | 新事件 | `{text}` | 调度器 | D7 第四档：**只给主人，默认关**（含系统提示片段的风险） |

### 2.3 三条语义规则（**必须写进 PROTOCOL.md**）

| # | 规则 |
|---|---|
| **P-1** | **全局 `seq` 与 `sinceSeq` 不是一回事**：全局 `seq` 是"这条时间线上的排队号"，**只增不减**；`sinceSeq` 是"我上次收到哪一条"的续传游标。**两者在协议里要分开写**，不许混成一个词 |
| **P-2** | **同一时刻最多一条未收口的消息**（X1.4）。⚠️ **这条只作用于"实时可见"的那一段，不作用于补发段**——否则历史永远排不进队 |
| **P-3** | **`seq` 可选**：瞬态事件（`client/reload`、本地应声）**不占号**。所以 `tryParse` 必须容忍 `seq` 缺失，**客户端排序要有兜底键**（否则会按到达序排，与"显示发生时刻"打架） |

### 2.4 兼容规则

| 情况 | 怎么办 |
|---|---|
| 客户端收到**不认识的类型** | 忽略（现在的 `tryParse` 已是这个行为，保持） |
| 客户端收到**不认识的字段** | 忽略 |
| **旧客户端遇到新全局 seq** | ⚠️ **这是批 0-b 那个决策**。现网 APK 的 `seq <= lastSeq` 会对新号**盲目丢事件** ⇒ **上线瞬间屏幕全白**。要么先让服务端对旧客户端降级，要么先强制刷新一次 |
| `dev=1` | **永远是附加通道，不是替代**（v7 已定；有回归测试守） |

---

## 三、状态机与数据模型

### 3.1 一条消息的状态（【现状】一个 `pending` bool →【目标】四态）

```
queued ──→ sent ──→ confirmed        （服务端 message/start 到达）
   └──────────────→ failed           （网络错 / 发送失败）
```

| 态 | 界面表现 | 谁能让它转 |
|---|---|---|
| `queued` | 一个**确定的**"已交出去"标记（**不是转圈**——转圈=不知道） | 本地按下发送 |
| `sent` | 同上 | 请求成功 |
| `confirmed` | 标记消失 | `message/start` 到达 |
| `failed` | **必须有自己的长相** + **重发入口**，**收起态也要显示** | 网络错 / 超时 |

**三条硬规则**：
1. **失败与成功必须视觉可区分**（【现状】失败时连小转圈都消失 ⇒ 看着就是发出去了）
2. **重发必须带服务端去重**——⚠️【现状】`/api/say` **没有 messageId 去重** ⇒ **现在重发 = agent 干两遍**。**要么加去重，要么不许重发同一 id**
3. **200ms 本地应声必须先判 `connected`**——否则无网时先出"在处理"、2 秒后出"失败"，**正是 09 最恨的形态**

### 3.2 作用域（【目标】，批 0-a 定完之后才动）

```
一条可见时间线（客户端只认它）
  └── 作用域栈：[主目录] → [工作区] → …
        · 每个作用域 = 一个 workspace（目录）+ 一条 DSH 会话
        · 同时只有一个"焦点"作用域
```

**不变量**：N12（界面作用域 = session 的 workspace root，不一致就报错）、
N15（切换前必须先收口）、N16（转交一轮最多一次、禁回环、目标必须已存在）、
N19（挂起必有超时 + 合法收尾）。

**并行与上屏（别混）**：
| | 什么样 |
|---|---|
| **执行** | 随便并行——非焦点作用域该干活干活 |
| **上屏** | 排队——同一时刻最多一条未收口 |

### 3.3 收起 / 删掉 / 真删（N24）

```
可见（桌面图标）
  │ "收起来"  ← 不动任何数据，无期限，一键恢复
  ▼
已收起
  │ "删掉"    ← 进回收站，**默认 30 天**；删前必须列清单
  ▼
回收站
  │ ① 到期自动真删（提前一周告）  ② 手动"立刻彻底删"  ③ 账号注销 ⇒ 立刻清空
  ▼
真的没了
```

**"收起来"与"删掉"的唯一区别：有没有期限。**

### 3.4 D7 的四档（展示"在做什么"）

| 档 | 用户看到 | 谁能开 |
|---|---|---|
| **安静** | 只有结论 + 一个"在处理"标记 | 任何人 |
| **在做什么** ✅ 默认 | 一句人话，**逐个替换**："在查资料" → "在算" | 任何人 |
| **步骤流水** | 工具名 / 目标 / 耗时 / 成败（一键展开） | 任何人 |
| **推理原文** | 模型在想什么 | ⚠️ **只有主人，默认关** |

**两条硬约束**：
1. **不承诺时间**（只展示"在做什么"）
2. ⚠️ **必须有乱序保护 + 超时收敛**——否则卡住时**永久停在"在查资料"**，比空白更坏

### 3.5 KV 的两层（【目标】，批 4）

```
索引层（常驻上下文，永远精简）= 实体/主题 + 一行 + 指针
详情层（不进上下文，按需检索）= 事实明细 + 原始会话
```

**键 = 实体 / 主题**（不是会话）。
**每条事实必须带 `source` 指针 + `trust`**；**"不知道"要显式表达**（`trust: unknown`），不许留空。
**N17 / N18**：无出处不写；**agent 不许直接写 KV**（必须过 hupo 的工具 + provenance 校验）。

### 3.6 工时账的字段（批 4，**冻结**）

```
事项 / 数量 / 单位 / 单价(可空) / 含税(true｜false｜unknown) / 日期
```
**只追加，不原地改**（改名 = 新增；旧字段永久只读）。
**口径不明的处理**：含税 `unknown` **不进合计**，并明说"1 条未计入"。
**硬闸**：同一句话**隔 7 天**问两次，**逐字段 diff = 0**。

### 3.7 状态清单（容器里"哪些是用户的状态"）

```
/data/main/                    主目录的文件
/data/workspaces/*/            各工作区的文件
/data/hupo/memory/             记忆索引 KV
/data/hupo/audit/              审计
$DSH_HOME/sessions/            会话历史（记忆本体）
$DSH_HOME/storages/            投影 / 检查点
$DSH_HOME/.credentials.yaml    ⚠️ 含模型密钥 → 备份必须加密
```
**备份 / 迁移 / 删除 都照这份清单走。** 容器里其他一切可抛弃。

---

## 四、接口契约（服务端内部）

| 接口 | 归谁 | 契约 |
|---|---|---|
| **`nextSeq(scopeId)`** | `conversation.js`（**批 0-a 定形态**） | 全局唯一、= **已落盘最大 + 1**、**只增不减**、**只能取号不能回退**。⚠️ 与"按可见时间线各数各的"如何共存**必须写死** |
| **`MessageWriter`** | `conversation.js` | 保证 `start → text* → end`；**end 带最终 sources**；**同一时刻最多一个未收口** |
| **`store.append`** | `store.js` | ⚠️ **失败必须上抛**（现状：静默吞）。**先落盘成功、再推订阅者** |
| **`TurnTranslator`** | `session-translate.js` | 事件翻译。**须提供 `current.writer.messageId`**（`message/status` 的取号靠它——现状发空串） |
| **`AgentRuntime`** | `agent-runtime.js` | spawn 用**白名单 env**（去掉 `*_API_KEY/*_TOKEN/*_SECRET`）+ `DSH_HOME=cfg.dshHome` + `cwd = agentCwdFor(session)`。**必须有 `agentMaxProcesses` 与全局 LRU**（现状：全库不存在，TTL 是 30 分钟） |
| **淘汰** | `agent-runtime.js` | **只淘汰空闲的**；`running === true` **必须跳过**；先收口再卸；**绝不删数据** |
| **准入** | `admission.js`（批 6） | 内存闸；**先 LRU 卸载、再谈拒绝**；拒绝必须给一句人话 |
| **记忆出口** | `conversation_list_screen` 那条路 | **写入与出口同批**——"没出口不许登记'要存东西'" |

---

## 五、测试地图（**哪一层归哪道闸**）

### 5.1 三道闸

| 闸 | 现在 | 谁守 |
|---|---|---|
| `flutter analyze` | **硬闸** | 编译 |
| `flutter test test/unit` | **硬闸** ✅（现 **45 条全过**） | **协议 / 状态机 / 纯逻辑** |
| `flutter test test/widget` | **只警告，不阻断** ⚠️（现 **8 条挂 6**） | 布局 |
| 服务端 `node --test test/*.test.js` | **硬闸** ✅（现 **72 条全过**） | 调度 / 对账 / 翻译 |

### 5.2 **新验收一律写 `test/unit`**（这是纪律，不是偏好）

**理由（评审实测）**：`test/widget/floating_panel_test.dart` **8 条挂 6**——
面板默认 `_hFactor=0.0`（收起），测试却断言"默认就最大化""点 `expand_more`"。
**界面一重构，widget 断言必然过期**——而重构正是接下来最常做的事。

### 5.3 必须写成**纯函数**才能进硬闸的五件（批 3 的重构直接为这个服务）

| # | 纯逻辑 | 进哪 |
|---|---|---|
| 1 | `PanelGeometry`（几何 / 档位吸附 / 甩判据 / 转屏吸附） | `test/unit/panel_geometry_test.dart` |
| 2 | `TimelinePager`（分页） | `test/unit/timeline_pager_test.dart` |
| 3 | `MessageState`（四态转移） | `test/unit/message_state_test.dart` |
| 4 | **禁用词扫描** | `test/unit/forbidden_words_test.dart` |
| 5 | `export.renderLedgerText()`（账本导出成一段话） | `test/unit/ledger_export_test.dart` |

**这五件都不需要 `pump`**，正好绕开"widget 测试一过期就没人管"。

### 5.4 每条不变量至少一个盯它的测试

| 不变量 | 测试 |
|---|---|
| N12 界面作用域 = root | 只有一个 controller 时不变量；多作用域接入后补 |
| N15 切换前先收口 | `timeline-order.test.js` 扩：**任意时刻未收口 ≤ 1** |
| N19 挂起必有收尾 | 超时后必有 `message/end`（不许留下永远"马上说完"） |
| N20 事实不能静默 | 桌面新增物件 ⇒ 必有一条 notice |
| N22 `seq` 只增不减 | `seq-global.test.js`：**磁盘上不得出现空洞**；重启后取号**单调** |
| N24 收起 ≠ 删掉 | 删前必列清单；回收站可恢复 |
| N25 注入不能持久化 | `grep = 0`（**含 KV / AGENTS.md / persona / settings preset**） |
| 先落盘再推 | `store-append.test.js`：盘满时 `emit` **抛错**且**订阅者一条都没收到** |

### 5.5 **不许写**的测试

| 不写 | 为什么 |
|---|---|
| 断言像素坐标、控件 key、"哪块贴顶" | 界面一重构必过期（现在 8 挂 6 就是证据） |
| 断言"默认就最大化"这类**行为快照** | 它锁的是当时的实现，不是产品要求 |
| 内部名出现在界面文案上 | 反过来写——**用禁用词闸禁止它出现** |

---

## 六、文件级改动总索引

> 一张表看全部：哪些文件被哪几批碰。**用来评估冲突**（同一个文件被多批碰，就要注意顺序）。

### 6.1 客户端

| 文件 | 批 1 | 批 2 | 批 3 | 批 4 | 批 5 |
|---|---|---|---|---|---|
| `main.dart` | B1（未知态不落盘/不进登录页） | —— | —— | —— | —— |
| `screens/chat_screen.dart` | **R1 界面 + 收起态重发 + 删 `_maximize()`** | D3 三样 + R2 锚 + R5 | **拆成 ≤300 行** | —— | 话筒入口 |
| `screens/login_screen.dart` | —— | **D2 定稿 + 恢复路径** | —— | —— | —— |
| `screens/conversation_list_screen.dart` | —— | —— | **两处"（待接入）"→ 记忆清单 + 导出** | —— | —— |
| `services/chat_controller.dart` | **四态 + 应声 + resend + 判 connected** | —— | D7 档位 + notices | —— | 语音状态 |
| `services/websocket_transport.dart` | **B1 真根（WS 401）+ B5 退避** | —— | —— | —— | —— |
| `services/timeline_store.dart` | **新增（B6）** | —— | —— | —— | —— |
| `services/voice_input.dart` | —— | —— | —— | —— | **新增** |
| `models/timeline.dart` | 四态字段 | `scopeId`/`source` | —— | 账本条目 | —— |
| `models/stream_event.dart` | —— | `scopeId`/`source` | `step/*` + marker | —— | —— |
| `models/scope_name.dart` | —— | **新增** | —— | —— | —— |
| `widgets/panel_geometry.dart` | —— | —— | **新增（从 chat_screen 抽）** | —— | —— |
| `widgets/timeline_pager.dart` | —— | —— | **新增** | —— | —— |
| `widgets/system_notice.dart` | —— | —— | **新增** | —— | —— |
| `widgets/answer_bubble.dart` | —— | **限宽 560→760 + 来源字体** | —— | —— | —— |
| `widgets/app_desktop.dart` | —— | `_columns` 按宽算 + 命名 | **新图标有动作 + 一句话 + 一键撤销** | —— | —— |
| `apps/*.dart` | —— | 文案（去"客户端/云端"） | —— | —— | —— |
| `pubspec.yaml` | —— | —— | —— | —— | **加 speech 依赖** |
| `android/.../AndroidManifest.xml` | —— | —— | —— | —— | **加 `RECORD_AUDIO`** |

### 6.2 服务端

| 文件 | 批 1 | 批 2 | 批 3 | 批 4 | 批 6 |
|---|---|---|---|---|---|
| `store.js` | **`append` 上抛** | —— | —— | —— | —— |
| `conversation.js` | **落盘成功才推** | —— | —— | —— | —— |
| `dispatcher.js` | **`message/status` 取号** | —— | `step/*` 产品事件 | 能力登记接线 | 准入 |
| `session-translate.js` | **提供 `writer.messageId`** | —— | 步骤事件翻译 | —— | —— |
| `agent-runtime.js` | —— | —— | —— | —— | **env 白名单 + DSH_HOME + `agentMaxProcesses` + LRU** |
| `config.js` | —— | —— | —— | —— | **`agentCwdFor()` + 淘汰阈值** |
| `auth.js` | **TTL 30→180** | 令牌续期 | —— | —— | —— |
| `capability-registry.js` | —— | —— | —— | **新增** | —— |
| `worklog.js` | —— | —— | —— | **新增** | —— |
| `integrity.js` / `admission.js` | —— | —— | —— | —— | **新增** |

### 6.3 文档与脚本

| 文件 | 谁改 | 什么时候 |
|---|---|---|
| `packages/protocol/PROTOCOL.md` | **增补 §二 那几个字段** | **动工前**（唯一有硬时点的） |
| `AGENTS.md` | 改掉"直接动手 / 免密 sudo" | 批 6（**必须与 P1 能力收回同批**） |
| `services/core/hupo-persona.yml` | 同上（"主人让你改这个系统时"整段） | 批 6 |
| `scripts/integrity-manifest.json` | 新增；**由主人 `sudo` 手动重建** | 批 6 |
| `scripts/verify-integrity.mjs` · `apply-change.sh` · `rollback.sh` | 新增 | 批 6 |
| `docs/design/L1/L2/L3-*.md` | **不改**——保留"单用户那一代"的原样（可追溯） | —— |
| 本文件 | 结构变了才改 | 随时 |

---

## 七、三条最容易忘的（放在最后，因为最常被绕过）

1. **`test/unit` 是硬闸，`test/widget` 只是提示。**
   新验收写错楼层 = 写了也没人守（现在 8 挂 6 就是证据）。

2. **协议字段一旦上线就冻结。**
   §二 那张表**动工前定完**，之后只加不改语义。

3. **数值不在这份文档里。**
   阈值、超时、容量——**只住在 `R2-DECISIONS.md` 与代码里**。
   本文写数值的那一刻，它就开始过期了。
