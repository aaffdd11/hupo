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
> **标记约定**：**【现状】** = 已在代码里（带文件:行）｜**【目标】** = 要做成的样子｜**【不做】** = 明确不建｜**【待裁决】** = 还没拍板，**不许照它动手**
>
> ---
>
> ## ⚠️ 本文经过一轮独立评审（三席），结果是"方向对、细节错了一批"
>
> 评审记录在 **`R2-ENGINEERING-review.md`**。本版已按它改了 **20 处**：
> 5 处凭空写错、4 处"说必须写死却没写"、9 类漏掉的文件、1 处批次顺序错、1 处自相矛盾。
> **凡是评审没核过的段落，都还没被证实**——读的时候请保持同样的怀疑。
>
> 评审另外挖出**两个今天就在咬人的 bug**（§1.4 与 §四），它们**不属于文档错误**，是代码里的坑。

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
| **七** | 三条最容易忘的 | 所有人 |
| **八** | 本次评审改了哪些、还剩哪些待裁决 | 排期 |

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

#### ⚠️ 现状与这张图**不一样**（评审实测，两处）

| # | 现状 | 说明 |
|---|---|---|
| **1** | **`widgets → apps` 倒挂** | `widgets/app_desktop.dart:12` 与 `widgets/mini_app_container.dart:11` 都 `import '../apps/mini_app.dart'`（要 `MiniApp` 类型）⇒ **`apps/` 与 `widgets/` 今天是双向依赖**，不是图上那个单向。**【目标】** 把 `MiniApp` 这个**接口**下沉到 `models/`，`widgets/` 只认接口 |
| **2** | **禁令 3 今天就已经被违反** | `apps/conversations_app.dart:11` `import '../screens/conversation_list_screen.dart'`。而且"只通过 `MiniAppEnv` 拿能力"这一条**在 5 处被违反**：`mini_app.dart:15`、`weather_app.dart:14-15`、`about_app.dart:8-9`、`dev_mode_app.dart:10-11`、`conversations_app.dart:12` |

⇒ **禁令不是"要保持的现状"，是"要先付的债"。**
落地它会**拆掉「会话」应用那半页**（它现在整个是把 `ConversationListScreen` 包了一层），
所以**必须排进批次、给出口**，不能只写在规则里。

#### 三条禁令

| # | 禁令 | 现状 |
|---|---|---|
| 1 | `models/` **不许** `import 'package:flutter/material.dart'`（只许 `foundation`） | ✅ 今天成立 |
| 2 | `widgets/` **不许** `import '../services/xxx_transport.dart'` 这类——只能通过 controller | ✅ 今天成立（唯一引用是 `dev_card.dart:16` 拿 `chat_controller`，属允许） |
| 3 | `apps/` **不许** `import '../screens/'` | ❌ **已在违反**（见上表） |

#### ⚠️ 这三条**怎么强制**（评审指出的缺口）

`analysis_options.yaml` 是 `flutter_lints` 模板，**加不了 import 禁令** —— 写在这里就是**没有闸**。

**【目标】** 一条**楼层闸**：`test/unit/import_rules_test.dart` ——
**读 `lib/` 下的源文件、按目录断言 import 方向**（纯 Dart，不需要 `pump`，进硬闸）。
这是"禁令有约束力"与"禁令只是口号"的唯一区别。

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

> 📌 **`services/transport.dart`（89 行）是抽象接口**，`mock_transport.dart`（423 行）是它的实现——
> **四态 / 401 / resend 全都过这个接口**，所以**改接口必动这两个**。评审发现我上一版**把它们整个漏了**。

**【目标】结构（按批次）**

| 批 | 新增 | 楼 | 说明 |
|---|---|---|---|
| 1 | `services/timeline_store.dart` | services | 本地缓存最近一屏（B6）。**只缓存，不判断**；必须带 `scopeId + userId` 命名空间 |
| **1.5** | `models/panel_geometry.dart` | **models** | 从 `chat_screen.dart` 抽出：`_collapsedH` / `_spanFor` / `_panelHeight` / 档位吸附 / 甩判据。**无 State、无 context 的纯函数 + 值类** |
| **1.5** | `models/timeline_pager.dart` | **models** | 抽出分页：`_visibleCount` / `_hiddenRows` / `_showOlder` / `_fillViewportIfNeeded` |
| **1.5** | `models/message_state.dart` | **models** | 四态转移（§3.1）的纯函数 |
| 1.5 | `models/mini_app.dart` | models | 从 `apps/mini_app.dart` **只把接口下沉**（解 §1.1 的倒挂） |
| 2 | `models/scope_name.dart` | models | 命名（D1：不许系统造词）。⚠️ **见下方"与 `title` 的关系"** |
| 3 | `widgets/system_notice.dart` | widgets | **系统说话通道**（R3）。**与聊天气泡是两条不同的通道** |
| 3 | `widgets/panel_shell.dart` · `panel_header.dart` · `composer.dart` · `user_bubble.dart` | widgets | 从 `chat_screen.dart` 拆出 |
| 3 | `widgets/message_list.dart` | widgets | ⚠️ **评审补的第七件**——见下 |
| 5 | `services/voice_input.dart` | services | 语音。**唯一需要新 Flutter 插件的模块** |

#### ⚠️ 三处被判错的（评审）

| # | 我上一版写的 | 改 |
|---|---|---|
| **1** | "拆完 `chat_screen.dart` **≤ 300 行**"，只列了六件 | ❌ **不成立**：六件只能抽走 ≈308 行，**剩 ~385 代码行 / ~500 总行**。要 ≤300 **必须再抽第七件 `message_list`**（`:466-502` + `:592-690` + `:691-745` ≈ 160 行） |
| **2** | `panel_geometry` / `timeline_pager` 放 **`widgets/`** | ❌ **找错楼层**：`widgets/` 现有 4 个文件**全都 import material**，而这两个是**无 material 的纯逻辑**。⇒ 移到 **`models/`**（它才是不许依赖 material 的那层）。⚠️ 另：它们只有 **30–60 代码行**，比现有最小非桩文件 `transport.dart`（89 行）还碎——**抽不抽要认这个代价** |
| **3** | 把"转屏吸附"写成"从 `chat_screen` 抽出" | ❌ **`chat_screen` 里根本没有转屏代码**（无 `didChangeMetrics` / `Orientation` / `MediaQuery`）⇒ **转屏吸附是新功能，不是重构**。冒充重构会让排期失真 |

#### ⚠️ `scope_name.dart` 与 `title` 的关系（评审：命名重复）

> `title` **已经由 `dispatcher.js:701-703` 产出**（用户原话前 24 字）。
> 再加一个"从用户原话取词"的 `scope_name.dart` ⇒ **两套命名规则**。

**【目标】只留一套口径**：`scope_name.dart` **不自己发明取词规则**，
它只做**客户端侧的展示裁剪**（长度 / 省略号 / 与图标名对齐），**词本身来自服务端 `title`**。
⇒ 若将来要"更好的名字"，**改服务端那一处**，不是加第二处。

**【目标的 `chat_screen.dart`】**：≤300 行，只做装配（三层 Stack + 把 controller 的数据分发给子组件）。**所有能算的东西都不在这里。**

### 1.3 服务端 `services/core/src/`（【现状】3914 行）

**【现状】**
```
index 53 · server 385 · config 114 · auth 197 · store 117 · conversation 362 ·
session-translate 368 · dispatcher 832 · agent-runtime 423 · debug-agent 648 ·
personality 268 · client-build 74 · auth-cli.mjs 73
```

> 📌 评审更正：我上一版写 **3841**，**漏算了 `auth-cli.mjs`（73 行）**⇒ 实际 **3914**。

**【目标】新增模块（按批次）**

| 批 | 新增 | 职责 | 不许做 |
|---|---|---|---|
| 4 | `capability-registry.js` | **能力登记表**：每个能力声明"叫什么 / 输入 schema / 输出 schema / 有无副作用 / 要不要存东西" | **不许**让模型发明接口 |
| 4 | `worklog.js` | 第一个真数据源（工时账）。**只追加，不原地改** | 不许自动抽取（只认明说的"记一笔"） |
| 4 | `export.js` | 账本出口：`renderLedgerText()`（一段能粘进微信的话） | 不许画表 |
| 6 | `integrity.js` | 完整性校验：读 `scripts/integrity-manifest.json`，逐文件 sha256 | **不许**能改清单自己 |
| 6 | `admission.js` | 准入：内存闸 + **先 LRU 卸载、再谈拒绝** | 不许静默拒绝（必须一句人话） |

**【明确不建】**（v7 列过，但**本轮不在任何批次里**）：
`budget.js`（成本三级）/ `tracer.js`（每轮 trace）/ `policy.js`（来源分级 → 能力档）/
`audit.js`（系统级动作审计）/ `apps.js`（小程序制品库）/ `kv.js`（v7 的记忆 KV）

> ⚠️ **这六个"不建"要写在显眼处**——因为它们**在 v7 里是"➕ 新增"**，
> 读者会以为它们已经有了或即将有。**现实是：一个都没有，而且本轮不排。**
>
> ⚠️ 评审抓到的**自相矛盾**：§3.5 的 KV 两层我标了"批 4"，**而 `kv.js` 在这里写着"不建"**。
> ⇒ **§3.5 改成【不做/悬空】**（见 §3.5）。

**【目标的 `dispatcher.js`】**：832 行，**本轮的改动集中在四处**——
`say()`（准入 + 焦点）、`#wire`（会话级 cwd）、`#escalate`（收口顺序）、
`devStep → step/*`（D7 的产品事件）。**不做大重构。**

> ⚠️ 评审更正：`#wire`（**`:540` 拿不到 `cfg`**）**不能**负责 env 白名单 —— 那是 `agent-runtime` 的地盘（§四）。

### 1.4 客户端的三个"结构性欠账"

| # | 欠账 | 现状 | 目标 |
|---|---|---|---|
| 1 | **`chat_screen.dart` 866 行管三件事** | 浮窗几何 + 列表分页 + 页面装配混在一起 | 拆成 §1.2 那七件；**几何与分页变成纯逻辑，进 `test/unit` 硬闸** |
| 2 | **`websocket_transport` 是会话级却当单例用** | `_conversationId` / `_sinceSeq` 是单实例字段 | 按会话可实例化，或拆成 `Connection`（重连/令牌）+ `Session`（会话/序号） |
| **3** | ★ **★ 退出一个会话会打死全站连接**（评审挖出来的，**今天就在咬人**） | 见下 | **批 0-a 必须先定** |

> 第 2、3 条是**批 0-a 那个决策**要解决的。**没定之前不许动它。**

#### ★ 欠账 3 的完整链条（**这是评审最有价值的一条**）

```
main.dart:114            只造一个 transport
  ├── :116  给主 controller
  └── :195  给 ChatScreen → chat_screen.dart:223 MiniAppEnv
              → app_registry.dart:34 → conversation_list_screen.dart:81
                            ↑ 同一个实例（事件流是 broadcast，:207）

用户退出那个会话时：
  conversation_list_screen.dart:88   controller.dispose()
    → chat_controller.dart:442       _transport.dispose()
      → websocket_transport.dart:306-308   关掉 _events / _devSteps / _agentSnaps
        → _disposed = true ⇒ _open():155 永不重连
```

⇒ **主屏从此一条消息都收不到，而且不会自己恢复。**
这**不是"设计不干净"**，是**用户会遇到的路径**——它把批 0-a 从"洁癖"变成"必修"。

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

### 2.2 【目标】增补字段

> ⚠️ **评审把这一节砍掉了一半**：八个字段里，**三个填不出、一个概念错**。
> 下表**只留站得住的**；站不住的进 §八 待裁决。

| 字段 | 加在哪 | 类型 | 谁填 | 什么意思 | 评审 |
|---|---|---|---|---|---|
| **`scopeId`** | `message/start`、`user/echo`、`task/*` | string | 调度器 | 这条属于哪个作用域（= 一条 DSH 会话）。**客户端 v1 可以不显示，但字段必须在**（N23） | ⚠️ **今天零数据源**（`services/` 与 `apps/` 里 `scopeId` **一次都没出现**）⇒ **必须先让服务端拥有这个身份**，见 §四 |
| **`reRefs[]`** | `message/start` | `[{scopeId, seq}]` | 调度器 | 回跳指针 | ⚠️ **今天填不出**：`re` 装的是 user **messageId**（`dispatcher.js:254-255`），而 `user/echo` 的 seq **被丢了**（`:245` 忽略了 `emit` 的返回值）⇒ 要先存 echo 的 seq |
| **`timeline/marker`** | 新事件 | `{kind: 'away' \| 'enter' \| 'leave', label?}` | 调度器 | 时间线上的分隔（"你不在的时候" / "进入「小升初」"）。**不进消息列表，占一个位置** | ✅ 能加。**必须是持久事件**（见 P-3） |
| **`step/summary`** | 新事件 | `{text}` | 调度器 | D7 默认档：一句人话（"在查资料"）。**必须是人话，不许出现内部名** | ✅ 能加（解析顺序不撞车，`websocket_transport.dart:193/198/204` 是精确 type 匹配） |
| **`step/detail`** | 新事件 | `{tool, target, ms, ok}` | 调度器 | D7 第三档：步骤流水 | ✅ 能加 |
| **`step/reasoning`** | 新事件 | `{text}` | 调度器 | D7 第四档：**只给主人，默认关** | ⚠️ **有泄露风险，见 §四·`step/*` 通道** |

**【删掉的】**

| 字段 | 为什么删 |
|---|---|
| **`source`**（我原写 `user` / `dispatcher` / `agent:<scopeId>`） | ❌ **概念错**：它**与 `agent` 重复一半、与 `origin` 混淆一半**。现网已经有**两条轴**：`origin`（`dispatcher.js:549-556` `nextProvenance()`：有 pending 用户消息 = `reactive`，否则 `proactive`）回答"**为什么开口**"；`agent`（`conversation.js:193` 发 `'agent'｜'dispatcher'`，**已经在线上、只是客户端不读**）回答"**谁在说**"。而 `message/start` **永远是助手在说**——`source` 里的 `user` 想表达的其实是 `origin` 的地盘。⇒ **删掉 `source`，用回 `agent` + `origin`**（进 §八 P-i 供主人确认） |
| **`catchUp`** | ⏸ **降级为待裁决**（§八 P-h）：客户端**已经有** `at >= _serverNowAtConnect` 划线（`chat_controller.dart:298-300`）；而且 `main.dart:79` 的 `connect()` **默认 `resumeFrom = 0`** ⇒ **首次打开也走 replay**，服务端标 `catchUp` 会把**全量历史**标成"断线补发" |

### 2.3 三条语义规则（**必须写进 PROTOCOL.md**）—— 评审逐条改过

| # | 规则（**改后**） |
|---|---|
| **P-1** | ⚠️ **改口径**：`seq` 是**每会话**的（`conversation.js:14`、文件头 `:3`），**不是"全局"**。正确说法是「**会话内 `seq` vs 续传游标 `sinceSeq`**」。客户端确实有**两个游标**：传输层 `_sinceSeq`（`websocket_transport.dart:59/206`）与 UI 层 `lastSeq`（`chat_controller.dart:52/249`）——**协议里要把这两个名字分开写，不许混成一个词** |
| **P-2** | ✅ **服务端已经成立、不需要新写**：新轮先收旧轮（`session-translate.js:195`），补发只是**重放日志**（`conversation.js:137-141`），**根本没有"条数"概念**。⇒ "不作用于补发段"**不是服务端规则，是客户端渲染规则**——**【目标】明确写进客户端**：`catchUp` 段**只用"历史"长相渲染**，不参与"谁还没收口"的排队 |
| **P-3** | ⚠️ **重写**（原文自相矛盾）：原文说"瞬态事件不占号"又说"`timeline/marker` 占一个位置"。**裁决定稿**：**"不占号" = "不上时间线"**。⇒ **控制帧与 UI 状态不算时间线事件**：`client/reload` 是控制帧、本地应声是 UI 状态，二者**在进入 `timeline` 之前就被消费掉**；⇒ **`marker` 是持久事件，取号、落盘、有位置**。⇒ 好处：**`ServerEvent.seq` 可以保持 `required int`**，`test/unit/timeline_test.dart:128`（"缺 seq 被拒"）**继续绿**，**不用动基类、不用破硬闸**（见 §八 P-g 供主人确认） |

### 2.4 兼容规则

| 情况 | 怎么办 |
|---|---|
| 客户端收到**不认识的类型** | 忽略（现在的 `tryParse` 已是这个行为，保持） |
| 客户端收到**不认识的字段** | 忽略 |
| **旧客户端遇到新 `seq`** | ⚠️ **这是批 0-b 那个决策**。现网 APK 的 `seq <= lastSeq` 会对新号**盲目丢事件** ⇒ **上线瞬间屏幕全白**。要么先让服务端对旧客户端降级，要么先强制刷新一次 |
| `dev=1` | **永远是附加通道，不是替代**（v7 已定；有回归测试守） |
| **`re` 的类型** | ⚠️ **不许改**。而且 `stream_event.dart:61` 用 `'$e'` 强转 ⇒ 正确的写法是「**`re` 只许装字符串**」，不是"不许改类型" |

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

**【目标】归属文件**：`models/message_state.dart`（纯函数，进 `test/unit`）。

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

> ⚠️ 评审指出：**这一节在 §六 / 七批里没有任何一批实现它** ⇒ 已在 §六 补上（**批 3**，与 R3 同批，因为它是同一件事的"删"那一半）。

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

> ⚠️ **第四档的实现方式见 §四·`step/*` 通道**——它是**唯一有泄露风险的字段**，不能靠"默认关"这句口头约定。

### 3.5 KV 的两层（❌ **【不做/悬空】**）

```
索引层（常驻上下文，永远精简）= 实体/主题 + 一行 + 指针
详情层（不进上下文，按需检索）= 事实明细 + 原始会话
```

**键 = 实体 / 主题**（不是会话）。
**每条事实必须带 `source` 指针 + `trust`**；**"不知道"要显式表达**（`trust: unknown`），不许留空。
**N17 / N18**：无出处不写；**agent 不许直接写 KV**（必须过 hupo 的工具 + provenance 校验）。

> ⚠️ **评审抓到的自相矛盾**：我上一版标它"批 4"，而 `kv.js` 又列在 §1.3 的"**本轮不建**"。
> ⇒ **裁决定稿：KV 本轮不建**。它在这里只作为**N17/N18 的定义**保留，
> **不作为可排期项**。**而"批 3 的记忆清单 + 导出"是指会话/工作区清单，不是 KV**（评审认为上一版把两者混了）。

### 3.6 工时账的字段（批 4，**冻结**）

```
事项 / 数量 / 单位 / 单价(可空) / 含税(true｜false｜unknown) / 日期
```
**只追加，不原地改**（改名 = 新增；旧字段永久只读）。
**口径不明的处理**：含税 `unknown` **不进合计**，并明说"1 条未计入"。
**硬闸**：同一句话**隔 7 天**问两次，**逐字段 diff = 0**。
**【目标】出口**：`export.js` 的 `renderLedgerText()` —— **一段能粘进微信的话**，不是表。

### 3.7 状态清单（容器里"哪些是用户的状态"）

```
/data/main/                    主目录的文件
/data/workspaces/*/            各工作区的文件
/data/hupo/memory/             记忆索引 KV          ← ⚠️ KV 本轮不建，路径先留着
/data/hupo/audit/              审计                  ← ⚠️ audit.js 本轮不建
$DSH_HOME/sessions/            会话历史（记忆本体）
$DSH_HOME/storages/            投影 / 检查点
$DSH_HOME/.credentials.yaml    ⚠️ 含模型密钥 → 备份必须加密
```
**备份 / 迁移 / 删除 都照这份清单走。** 容器里其他一切可抛弃。

> ⚠️ 评审：这一节**无测试、无文件、无批次** ⇒ **它是"容器（批 6）的输入"**，在 §六 里挂在批 6。

---

## 四、接口契约（服务端内部）

| 接口 | 归谁 | 契约 |
|---|---|---|
| **`nextSeq(sessionId)`** | `conversation.js`（**批 0-a 定形态**） | ⚠️ **评审：原文"= 已落盘最大 + 1"与"瞬态占号不落盘"直接冲突**。**定稿见下方 §4.1** |
| **`MessageWriter`** | `conversation.js` | 保证 `start → text* → end`；**end 带最终 sources**；**同一时刻最多一个未收口**。⚠️ **评审补**：单 writer 内 `:184-236` 成立、`end` 幂等（`:225`）、`handoff` 不破坏它（先 `end` 再 `new`）；**但 `chunk()` 不查 `ended`（`:204`）** ⇒ 持旧 writer 即可破序。**【目标】`chunk()` 必须先查 `ended`** |
| **`store.append`** | `store.js` | ⚠️ **失败必须上抛**（现状静默吞，`store.js:22-28`）。**先落盘成功、再推订阅者**。**但★"谁接"必须写死，见 §4.2** |
| **`TurnTranslator`** | `session-translate.js` | ⚠️ **评审改正**：`current.writer.messageId` **不是 dispatcher 需要的东西**（见 §4.3）。**须提供"一轮的稳定标识" = `turn`**，它随 `info` 一起给出；`this.turns` 一律用它作键 |
| **`AgentRuntime`** | `agent-runtime.js` | spawn 用**白名单 env** + `DSH_HOME` + `cwd = agentCwdFor(session)`。**必须有 `agentMaxProcesses` 与全局 LRU**（现状：全库不存在，TTL 是 30 分钟）。⚠️ **白名单是什么、owner 是谁，见 §4.4** |
| **淘汰** | `agent-runtime.js` | **只淘汰空闲的**；`running === true` **必须跳过**；**先收口再卸**；**绝不删数据**。⚠️ **谁回调谁见 §4.5** |
| **准入** | `admission.js`（批 6） | 内存闸；**先 LRU 卸载、再谈拒绝**；拒绝必须给一句人话 |
| **记忆出口** | `conversation_list_screen` 那条路 | **写入与出口同批**——"没出口不许登记'要存东西'" |

### 4.1 序号契约（**评审推翻了我的写法，这是定稿**）

**现状的真相**：取号散在**三处**，**根本不存在 `nextSeq` 函数**——
`conversation.js:42`（`emit`，`seq: ++this.seq`）、`:72`（`emitTransient`，**也发号**）、
`:150`（`restore`，取 max）。

**定稿**：

| 事件种类 | 取号 | 落盘 | 上时间线 | 例 |
|---|---|---|---|---|
| **持久事件** | ✅ | ✅ | ✅ | `message/*`、`task/*`、`user/echo`、**`timeline/marker`** |
| **控制帧** | ❌ | ❌ | ❌ | `client/reload`（`server.js:138` 现在走 `emitTransient`） |
| **UI 状态** | ❌ | ❌ | ❌ | 本地应声（`chat_controller.dart:398`） |

⇒ **只有一个取号函数**，`emit` / `emitTransient` / `restore` 三处都走它。
⇒ **持久事件的号 = 该会话已落盘最大 + 1**，写盘成功才推 ⇒ **磁盘无空洞**（N22 成立）。
⇒ **瞬态一律不取号** ⇒ "已落盘最大 + 1"不再与它冲突。
⇒ 重启后 `restore` 取 max ⇒ **单调**。

> ⚠️ **今日反例**：`server.js:138` 的 `client/reload` 走 `emitTransient`，
> 而 `emitTransient(:72)` **发号** ⇒ **N22"磁盘上不得出现空洞"今天就假**。这是要修的第一件事之一。

### 4.2 ★ `store.append` 上抛之后，**谁接**（评审：我只写了一半）

**为什么这是最急的一条**：`append` 调用点只有 **1 个**，但 **`emit` 调用点 18 个**
（dispatcher 12 / conversation 5 / server 1），**无一处 `try`**。
最狠的路径是 `agent-runtime.js:300` ← `stdout.on('data'):117`、以及 `dispatcher:603/610` 的
`setTimeout` —— **在 Node 里都是未捕获异常**（全库无 `uncaughtException`）
⇒ **盘满 → 进程退出 → 重启 → 再盘满**，变成重启风暴。

**【目标】三层接住**（三处都要，缺一不可）：

| 层 | 谁 | 做什么 |
|---|---|---|
| 1 | **调用点** | **不再逐处 try**（18 处会漏）。改在**唯一入口**：`emit` 自己包一层 |
| 2 | **`emit`** | 落盘失败 ⇒ **抛** 给调用方；**订阅者一条都不推**（这正是 V-a 断言的行为） |
| 3 | **进程级** | 装 `process.on('uncaughtException')` / `unhandledRejection`：**记一条人话 notice（走 `emitTransient`，它不落盘 ⇒ 盘满也能发出去）**，然后**有界退出**且**退避重启**，不许立刻再起 |

⇒ **判据补一条**：`store-append.test.js` 除了"抛错 + 订阅者零收到"，
还要有"**调用点不需要自己 try**"（否则 18 处里漏一处就回到原点）。

### 4.3 ⚠️ `turns` 的键必须是一轮的稳定 id（**§〇 那两个今天在咬人的 bug 之一**）

**定稿：`this.turns` 用 `info.turn` 作键**（不是 `messageId`，也不是新造 id）。

**为什么**（我复核代码后的精确机制）：

```
session-translate.js:209/219   this.current = { turn, writer, … } → onTurnStart(this.current)
                               ⇒ dispatcher 的 info **就是** translator.current（同一对象）
dispatcher.js:617              存键用的是 info.writer.messageId ← 「当时」的气泡 id

handoffTimer（短）先到 → #escalate(:700) → handoff()
  session-translate.js:288       cur.writer = new MessageWriter(…newId('m')…)
                                 ↑ cur === this.current === info
                                 ⇒ **info.writer.messageId 被隔着一层改掉了**

deadlineTimer（长）后到 → dispatcher.js:611 guard 读到**新** id
  ⇒ undefined !== info ⇒ **直接 return，永不收口**
dispatcher.js:623              delete 也删**新** id ⇒ **旧键永久残留**
```

⇒ **升格过的轮次，180s 硬收口彻底失效** ⇒ **N19 与 §3.4"超时收敛"同时落空**。

**为什么 `info.turn` 是对的**：`turn` 号在一轮内**构造上不会变**，`handoff()` 也不碰它
（它已经随 `info` 一起给出，`session-translate.js:202`）。
⇒ **不需要**"把 `turnMessageId` 变成接口"——那个 Map（`:146/:199`，全库只写不读）
在这个用途上根本用不着；它要么删掉，要么另作他用。

⚠️ **我上一版那句"取号通道靠 `current.writer.messageId`"只会把这个错键固化。**
⚠️ 同一处还有 `cancel()` 的 `:759 this.turns.delete(cur.writer.messageId)`，**同样要改。**

### 4.4 env 白名单（评审：我说了"白名单"却**没列白名单**）

**owner 定死 = `agent-runtime.js`**（现状就在 `:94/96/144`；
§1.3 曾写进 `dispatcher.#wire` —— **`:540` 拿不到 `cfg`，是错的**）。

**为什么不能随手砍**：`dsh` 是 node CLI，
**丢 `PATH` 就回到 ENOENT**（`config.js:32`、`agent-runtime.js:105` 的注释里就是那个坑）；
还需 `HOME`（读 `~/.dsh`）、`TMPDIR`、`LANG`，以及**部署侧注入的 `DSH_*` / 代理变量**。

⚠️ **前置动作**：**仓库里没有 `.service` 文件，所以"到底有哪些变量"现在不知道**
⇒ **必须先盘点生产机的 unit 文件**，再写白名单。
另：`DSH_HOME` **当前无处设置**（只在 docs 与 `scripts/diagrams.mjs:585` 出现过）。

⇒ **顺序**：**先盘点 → 再写死白名单 → 再砍 `*_API_KEY/*_TOKEN/*_SECRET`**。
不许先砍后盘点（会 ENOENT）。

### 4.5 淘汰：**谁回调谁**（评审：我只写了"只淘汰空闲的"）

| 问题 | 定稿 |
|---|---|
| `agent-runtime` 要"先收口再卸" | 它**全文没有 translator** ⇒ **只能 dispose**。⇒ **必须由 runtime 回调 dispatcher**（新增一个 `onEvict(sessionId)` 回调），**并把 `dispatcher.js` 排进批 6**（上一版 §6.2 漏了） |
| **LRU 没有访问序** | `agent():342-354` **不更新顺序**，`Map` 的插入序 **≠ LRU** ⇒ **必须先修访问序**，否则"LRU"名不副实 |
| `running === true` 跳过 | **可实现**，但 **`return` 不重新 `arm`** ⇒ **跳过一次 = 永久不淘汰**。⇒ **跳过时必须重新 `arm`** |

---

## 五、测试地图（**哪一层归哪道闸**）

### 5.1 三道闸（**评审更正了两处数**）

| 闸 | 现在 | 谁守 |
|---|---|---|
| `flutter analyze` | **硬闸** | 编译 |
| `flutter test test/unit` | **硬闸** ✅（现 **45 条全过**） | **协议 / 状态机 / 纯逻辑** |
| `flutter test test/widget` | **只警告，不阻断** ⚠️（现 **49 条挂 10**） | 布局 |
| 服务端 `node --test test/*.test.js` | **硬闸** ✅（现 **72 条全过**） | 调度 / 对账 / 翻译 |

> ⚠️ **更正**：我上一版写"`test/widget` 现 **8 条挂 6**"——**那是 `floating_panel_test` 一个文件**的数，
> 我把它当成了全部。**实测 49 条挂 10**：`floating_panel` 8挂6、`smoke_test` 12挂3、`panel_interaction` 5挂1。

### 5.2 **新验收一律写 `test/unit`**（这是纪律，不是偏好）

**理由（评审实测）**：`test/widget/floating_panel_test.dart` **8 条挂 6**——
面板默认 `_hFactor=0.0`（收起），测试却断言"默认就最大化""点 `expand_more`"。
**界面一重构，widget 断言必然过期**——而重构正是接下来最常做的事。

### 5.3 必须写成**纯函数**才能进硬闸的六件（**批 1.5 的重构直接为这个服务**）

| # | 纯逻辑 | 归属文件 | 进哪 |
|---|---|---|---|
| 1 | `PanelGeometry`（几何 / 档位吸附 / 甩判据） | `models/panel_geometry.dart` | `test/unit/panel_geometry_test.dart` |
| 2 | `TimelinePager`（分页） | `models/timeline_pager.dart` | `test/unit/timeline_pager_test.dart` |
| 3 | `MessageState`（四态转移） | `models/message_state.dart` | `test/unit/message_state_test.dart` |
| 4 | **禁用词扫描** | `models/forbidden_words.dart` | `test/unit/forbidden_words_test.dart` |
| 5 | `export.renderLedgerText()`（账本导出成一段话） | `services/core/src/export.js` | `test/unit/ledger_export_test.dart` |
| 6 | **楼层闸**（§1.1 的三条禁令） | `test/unit/import_rules_test.dart` | `test/unit/import_rules_test.dart` |

**这六件都不需要 `pump`**，正好绕开"widget 测试一过期就没人管"。

> ⚠️ 评审：上一版 §五 里 **`MessageState` / 禁用词扫描 / `renderLedgerText()` 在 §一 全无归属文件** ⇒ 已补（上表第 3–5 行的"归属文件"列）。

### 5.4 每条不变量至少一个盯它的测试

| 不变量 | 测试 | 评审 |
|---|---|---|
| N12 界面作用域 = root | 只有一个 controller 时不变量；多作用域接入后补 | ✅ |
| N13 跨作用域只走摘要与指针 | `scope-summary.test.js`（新增） | ⚠️ **上一版缺** |
| N14 主作用域不许替子作用域编细节 | 同上（同一测试的两条断言） | ⚠️ **上一版缺** |
| N15 切换前先收口 | `timeline-order.test.js` 扩：**任意时刻未收口 ≤ 1** | ✅ |
| N16 转交最多一次、禁回环 | `handoff.test.js`（新增：A→B→A 必须被拒） | ⚠️ **上一版缺** |
| N17 无出处不写 KV | `kv-provenance.test.js` —— ⚠️ **KV 本轮不建** ⇒ **测试推后** | ⚠️ **改为不排** |
| N18 agent 不许直接写 KV | 同上 ⇒ **推后** | ⚠️ **改为不排** |
| N19 挂起必有收尾 | 超时后必有 `message/end`（**必须覆盖"升格过的轮次"**——见 §4.3） | ⚠️ **必须补升格路径** |
| N20 事实不能静默 | 桌面新增物件 ⇒ 必有一条 notice | ✅ |
| N21 一份 `DSH_HOME` | 配置断言（`config.js` 只允许一个 dshHome） | ⚠️ **上一版缺** |
| N22 `seq` 只增不减、**无空洞** | `seq-monotonic.test.js`：重启后取号**单调** + **瞬态不落盘** ⇒ 无空洞 | ⚠️ **上一版引的 `seq-global.test.js` 不存在**，改名 |
| N23 协议带 `scopeId` 与来源 | `protocol-fields.test.js`：九事件全带 `scopeId`（**推后到服务端有身份之后**） | ⚠️ **上一版缺** |
| N24 收起 ≠ 删掉 | 删前必列清单；回收站可恢复 | ✅（**并补进批 3**，见 §六） |
| N25 注入不能持久化 | `grep = 0`（**含 KV / AGENTS.md / persona / settings preset**） | ✅ |
| 先落盘再推 | `store-append.test.js`：盘满时 `emit` **抛错**且**订阅者一条都没收到** + **调用点不需自己 try** | ✅（**判据已加**，见 §4.2） |

### 5.5 **不许写**的测试

| 不写 | 为什么 |
|---|---|
| 断言像素坐标、控件 key、"哪块贴顶" | 界面一重构必过期（现在 49 挂 10 就是证据） |
| 断言"默认就最大化"这类**行为快照** | 它锁的是当时的实现，不是产品要求 |
| 内部名出现在界面文案上 | 反过来写——**用禁用词闸禁止它出现** |

---

## 六、文件级改动总索引

> 一张表看全部：哪些文件被哪几批碰。**用来评估冲突**（同一个文件被多批碰，就要注意顺序）。
>
> ⚠️ **评审指出这张表漏了 9 类文件、错了 5 处、批次顺序反了 1 处** —— 本版全部改过。
> **加粗** = 该批的主要工作。

### 6.1 客户端

| 文件 | 批 1 | 批 1.5 | 批 2 | 批 3 | 批 4 | 批 5 |
|---|---|---|---|---|---|---|
| `main.dart` | **装配（B1 未知态）**＋`resume` 语义 | —— | —— | —— | —— | —— |
| `screens/chat_screen.dart` | **R1 界面 + 收起态重发 + 删 `_maximize()`** | 交出几何/分页（变薄） | D3 三样 + R2 锚 + R5 | **拆到 ≤300 行** | —— | 话筒入口 |
| `screens/login_screen.dart` | —— | —— | **D2 定稿 + 恢复路径** | —— | —— | —— |
| `screens/conversation_list_screen.dart` | —— | —— | —— | **两处"（待接入）"→ 记忆清单 + 导出 + 收起/删掉/回收站（N24）** | 账本出口再碰 | —— |
| `services/chat_controller.dart` | **四态 + 应声 + resend + 判 connected** | —— | —— | D7 档位 + notices | —— | 语音状态 |
| `services/websocket_transport.dart` | **401 真根 + 退避 + 生命周期（批 0-a）** | —— | —— | —— | —— | —— |
| **`services/transport.dart`** | **接口若动则必改（四态/401/resend 都过它）** | —— | —— | —— | —— | 可能加语音 |
| **`services/mock_transport.dart`** | **同上（423 行，测试全走它）** | —— | —— | —— | —— | —— |
| `services/timeline_store.dart` | **新增（B6）** | —— | —— | —— | —— | —— |
| `services/voice_input.dart` | —— | —— | —— | —— | —— | **新增** |
| `models/timeline.dart` | 四态字段 | —— | `scopeId` | —— | 账本条目 | —— |
| `models/stream_event.dart` | —— | —— | `scopeId` | `step/*` + marker | —— | —— |
| **`models/panel_geometry.dart`** | —— | **新增** | —— | —— | —— | —— |
| **`models/timeline_pager.dart`** | —— | **新增** | —— | —— | —— | —— |
| **`models/message_state.dart`** | **新增（四态纯函数）** | —— | —— | —— | —— | —— |
| **`models/forbidden_words.dart`** | —— | —— | **新增（禁用词表）** | —— | —— | —— |
| **`models/mini_app.dart`** | —— | **新增（接口下沉，解倒挂）** | —— | —— | —— | —— |
| `models/dev_step.dart` | —— | —— | —— | **提炼成产品步骤事件** | —— | —— |
| `models/scope_name.dart` | —— | —— | **新增（只做展示裁剪，取词口径同 `title`）** | —— | —— | —— |
| `widgets/system_notice.dart` | —— | —— | —— | **新增** | —— | —— |
| `widgets/panel_shell.dart` · `panel_header.dart` · `composer.dart` · `user_bubble.dart` | —— | —— | —— | **新增（从 chat_screen 拆）** | —— | —— |
| **`widgets/message_list.dart`** | —— | —— | —— | **新增（第七件，为 ≤300 行）** | —— | —— |
| `widgets/answer_bubble.dart` | —— | —— | **限宽 560→760 + 来源字体** | —— | —— | —— |
| `widgets/app_desktop.dart` | —— | —— | `_columns` 按宽算 + 命名 | **新图标有动作 + 一句话 + 一键撤销** | —— | —— |
| `widgets/mini_app_container.dart` | —— | **改认 `models/mini_app.dart`** | —— | —— | —— | —— |
| `widgets/dev_card.dart` | —— | —— | —— | **提炼（D7）** | —— | —— |
| **`apps/app_registry.dart`** | —— | —— | —— | —— | —— | —— |
| **`apps/conversations_app.dart`** | —— | —— | —— | **拆掉那半页（禁令 3 的债）** | —— | —— |
| **`apps/about_app.dart`** | —— | —— | **明写"不会拼音的人这个版本用不了"** | —— | —— | —— |
| `apps/*.dart` | —— | 文案（去"客户端/云端"） | —— | —— | —— | —— |
| `pubspec.yaml` | —— | —— | —— | —— | —— | **加 speech 依赖** |
| `android/.../AndroidManifest.xml` | —— | —— | —— | —— | —— | **加 `RECORD_AUDIO`** |

### 6.2 服务端

| 文件 | 批 1 | 批 3 | 批 4 | 批 6 |
|---|---|---|---|---|
| `store.js` | **`append` 上抛** | —— | —— | —— |
| `conversation.js` | **`nextSeq` 收口 + 落盘成功才推 + 瞬态不发号** | —— | —— | —— |
| `server.js` | **`emitTransient` 的 `client/reload` 去号；WS 401 根；`warm()` 上限** | —— | —— | —— |
| `dispatcher.js` | **`turns` 键改 `info.turn`（§4.3，`:604/611/617/623/759` 五处）** | `step/*` 产品事件 | 能力登记接线 | **准入** |
| `session-translate.js` | **`chunk()` 查 `ended`；`turn` 随 `info` 给出（§4.3）** | 步骤事件翻译 | —— | —— |
| `agent-runtime.js` | —— | —— | —— | **env 白名单 + `DSH_HOME` + `agentMaxProcesses` + LRU 访问序 + `onEvict` 回调** |
| `config.js` | —— | —— | —— | **`agentCwdFor()` + 淘汰阈值 + 单一 `dshHome`** |
| `auth.js` | **TTL 30→180** | —— | —— | —— |
| `dispatcher.js`（令牌续期） | —— | —— | —— | —— |
| `capability-registry.js` | —— | —— | **新增** | —— |
| `worklog.js` · `export.js` | —— | —— | **新增** | —— |
| `integrity.js` / `admission.js` | —— | —— | —— | **新增** |
| **`personality.js`** | —— | —— | —— | **（D7 文案表若落这里）** |
| **`debug-agent.js`** | —— | **（D7 提炼的输入）** | —— | —— |

> ⚠️ `auth.js` 的**两次改动必须写先后**：**批 1 先 TTL（30→180），批 2 再续期**。
> ⚠️ `dispatcher.js` 的**两次改动同落 `say()`**：**批 4 能力接线 → 批 6 准入**，不许并行。

### 6.3 测试

| 文件 | 批 | 层 |
|---|---|---|
| `test/unit/import_rules_test.dart`（**新增**：楼层闸） | 1.5 | 硬闸 |
| `test/unit/panel_geometry_test.dart`（**新增**） | 1.5 | 硬闸 |
| `test/unit/timeline_pager_test.dart`（**新增**） | 1.5 | 硬闸 |
| `test/unit/message_state_test.dart`（**新增**） | 1 | 硬闸 |
| `test/unit/timeline_store_test.dart`（**新增**：B6 冷启动） | 1 | 硬闸 |
| `test/unit/forbidden_words_test.dart`（**新增**） | 2 | 硬闸 |
| `test/unit/ledger_export_test.dart`（**新增**） | 4 | 硬闸 |
| `services/core/test/store-append.test.js`（**新增**） | 1 | 硬闸 |
| `services/core/test/seq-monotonic.test.js`（**新增**，取代我上一版瞎写的 `seq-global.test.js`） | 1 | 硬闸 |
| `services/core/test/timeline-order.test.js`（扩） | 1 | 硬闸 |
| `services/core/test/handoff.test.js` · `scope-summary.test.js`（**新增**） | 3 | 硬闸 |
| `services/core/test/worklog.test.js`（**新增**） | 4 | 硬闸 |

### 6.4 文档、脚本与容器

| 文件 | 谁改 | 什么时候 |
|---|---|---|
| `packages/protocol/PROTOCOL.md` | **增补 §二 那几个字段 + §2.3 三条规则** | **动工前**（唯一有硬时点的） |
| `AGENTS.md` | 改掉"直接动手 / 免密 sudo" | 批 6（**必须与 P1 能力收回同批**） |
| `services/core/hupo-persona.yml` | 同上（"主人让你改这个系统时"整段） | 批 6 |
| `scripts/integrity-manifest.json` | 新增；**由主人 `sudo` 手动重建** | 批 6 |
| `scripts/verify-integrity.mjs` · `apply-change.sh` · `rollback.sh` | 新增 | 批 6 |
| **容器三件**（Dockerfile / cgroup slice / 12 条验收脚本） | 新增 | 批 6 |
| **`docs/design/L1-terminal.md` · `L2-dispatcher.md` · `L3-worker.md`** | **不改**——保留"单用户那一代"的原样（可追溯） | —— |
| 本文件 · `R2-ENGINEERING-review.md` | 结构变了才改 | 随时 |

> ⚠️ **更正**：我上一版写 `docs/design/L1/L2/L3-*.md` —— **那个 `L1/` 目录不存在**。
> 真名是 `L1-terminal.md` / `L2-dispatcher.md` / `L3-worker.md`。

---

## 七、三条最容易忘的（放在最后，因为最常被绕过）

1. **`test/unit` 是硬闸，`test/widget` 只是提示。**
   新验收写错楼层 = 写了也没人守（现在 **49 挂 10** 就是证据）。

2. **协议字段一旦上线就冻结。**
   §二 那张表**动工前定完**，之后只加不改语义。⚠️ **但"定完"不等于"想加的都能加"**——
   评审砍掉了 `source`，并把 `catchUp` 降为待裁决，因为**它们没有数据源**。

3. **数值不在这份文档里。**
   阈值、超时、容量——**只住在 `R2-DECISIONS.md` 与代码里**。
   本文写数值的那一刻，它就开始过期了。

---

## 八、本次评审改了什么、还剩什么

### 8.1 已改（20 处）

**凭空写错 5**：禁令 3 其实已在违反｜`widgets → apps` 倒挂｜`≤300` 不成立（缺第七件）｜"转屏吸附"是新功能不是重构｜`services/core/src` 是 **3914** 不是 3841，`chat_controller.dart:420`→**`:424`**

**"说必须写死却没写" 4**：序号契约（§4.1）｜`tryParse` 容忍缺 seq 的成本（§2.3 P-3）｜`MessageWriter` 的 `chunk()` 不查 `ended`（§四）｜**`turns` 的键必须是一轮的稳定身份**（§4.3，**复核后改用 `info.turn`**）

**漏掉的文件 9 类**：4 个 widget｜`message_list`｜`transport.dart`/`mock_transport.dart`｜`app_registry.dart`｜`server.js`/`personality.js`/`debug-agent.js`｜`dev_card.dart`/`dev_step.dart`｜`about_app.dart`｜**全部 7 个新测试**｜容器三件

**批次错 1**：纯函数拆分 **提到批 1.5**（它原来在批 3，而**批 2 的验收就要 `panel_geometry_test`**）

**自相矛盾 1**：`KV 两层` 说批 4 vs `kv.js` 说不建 ⇒ **裁为"本轮不建"**

### 8.2 待裁决（**不许照它动手** —— 进 `R2-DECISIONS.md`）

| # | 待裁决 | 为什么现在必须定 | 推荐 |
|---|---|---|---|
| **P-e** | **transport 生命周期**（批 0-a 的核心） | ★**今天就在咬人**：退一个会话打死全站连接（§1.4） | **甲：拆成 `Connection` + 每会话一个 `Session`**（见 `R2-DECISIONS.md` P-e） |
| **P-f** | **一轮的稳定键**（`turns` 用哪个 id） | ★**今天就在咬人**：升格过的轮次收口失效（§4.3） | **甲：`this.turns` 改用 `info.turn`**（见 `R2-DECISIONS.md` P-f） |
| **P-g** | **P-3 的定稿口径** | 它同时决定"要不要动基类 + 要不要破硬闸测试" | **甲：§2.3 那个"不占号 = 不上时间线"**（零基类改动、硬闸测试保持绿） |
| **P-h** | **`catchUp` 是线上字段还是客户端推导** | 它决定协议要不要多一个字段（且**首次打开会走 replay**） | **甲：线上字段，且服务端只在 `sinceSeq > 0` 时标** |
| **P-i** | **`source` 去留** | 它决定协议里是不是真有第三条轴 | **甲：删掉 `source`，用 `agent` + `origin`** |
| **P-j** | **env 白名单的前置盘点** | 不盘点就写白名单 ⇒ **ENOENT**（§4.4） | **甲：先读生产机 unit 文件，再定白名单**（需要主人给一份 unit） |
| **P-k** | **`store.append` 上抛后的进程级策略** | 不接住就是**重启风暴**（§4.2） | **甲：`emit` 统一包一层 + 进程级 notice + 有界退出 + 退避重启** |
