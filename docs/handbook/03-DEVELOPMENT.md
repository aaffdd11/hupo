# 03 · 开发文档

> **这份文档回答：代码长什么样、往哪改、改完谁守。**
>
> 它**不回答**"先做什么后做什么"（`04-ROADMAP.md`）、
> **不回答**"产品要什么"（`01-PROJECT.md` / `05-DECISIONS.md`）。
>
> **防过期的纪律**：
> - 本文只写**结构 + 契约**——文件放哪、谁依赖谁、字段什么意思、状态怎么转。**这些变得慢。**
> - ⚠️ **不写数值**——阈值、超时、容量只住在代码里。**写在这里必过期。**
> - 冲突时**以代码为准，然后回来改本文**。
>
> **标记约定**：**【现状】** = 已在代码里（带文件:行）｜**【目标】** = 要做成的样子｜**【不做】** = 明确不建

---

## 〇、目录

| 节 | 内容 |
|---|---|
| **一** | **仓库地图**：有什么、多少行 |
| **二** | **模块依赖**：谁依赖谁、三条禁令、怎么强制 |
| **三** | **协议 v2**（唯一有硬时点的一节） |
| **四** | **状态机与数据模型** |
| **五** | **接口契约**（服务端内部） |
| **六** | **测试地图**：哪一层归哪道闸 |
| **七** | **文件级改动总索引** |

---

## 一、仓库地图

```
v2/apps/mobile/       Flutter 客户端（L1 终端）——**线上的界面就是它**
v2/services/core/     Node.js 调度器（L2）——常驻进程，听 127.0.0.1:8020
scripts/              构建 / 部署 / 推送 / 判据 脚本
docs/INDEX.md         **L0 路由**：要问什么读哪一份（只放指针，不放结论）
docs/handbook/        本手册（要什么、为什么；唯一权威）
docs/dev/             这一批怎么实现、怎么验的（证据层，随代码长）
```

> 🔴 **2026-09-22 更正**：这里原来画的是**上一代的树**（`apps/mobile/`、`services/core/`、
> `packages/protocol/`）。**那三处已经删掉了**（2026-09-21），仓库里**只有 `v2/`**。
> 要翻旧实现的原文：`git show f93f296:<路径>`。
>
> ⚠️ **别把根目录的 `package.json` 当成入口**（它指向的 v1 原型早没了）。
> **当前服务是 `v2/services/core/`**，入口 `src/serve.js`。

> 📌 **规模、文件分布、测试条数这类"现状"一律不写在这里**（纪律 1：**不写数值**）。
> 要现状就**跑一遍**：条数看 `docs/dev/00-PROGRESS.md`，文件分布看树本身。
> 写死在这里的那一刻，它就开始过期 —— 这份清单原来那份就是活证据。

---

## 二、模块依赖

### 2.1 依赖方向（**硬规则，反了就重构**）

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

### 2.2 ⚠️ 现状与这张图**不一样**（评审实测，两处）

| # | 现状 | 说明 |
|---|---|---|
| **1** | **`widgets → apps` 倒挂** | `widgets/app_desktop.dart:12` 与 `widgets/mini_app_container.dart:11` 都 `import '../apps/mini_app.dart'`（要 `MiniApp` 类型）⇒ **今天 `apps/` 与 `widgets/` 是双向依赖**，不是图上那个单向。**【目标】** 把 `MiniApp` **接口**下沉到 `models/`，`widgets/` 只认接口 |
| **2** | **禁令 3 今天就已经被违反** | `apps/conversations_app.dart:11` `import '../screens/conversation_list_screen.dart'`。而且"只通过 `MiniAppEnv` 拿能力"这一条**在 5 处被违反**：`mini_app.dart:15`、`weather_app.dart:14-15`、`about_app.dart:8-9`、`dev_mode_app.dart:10-11`、`conversations_app.dart:12` |

⇒ **禁令不是"要保持的现状"，是"要先付的债"。**
落地它会**拆掉「会话」应用那半页**（它现在整个是把 `ConversationListScreen` 包了一层），
所以**必须排进批次、给出口**（`04-ROADMAP.md` 批 3）。

### 2.3 三条禁令

| # | 禁令 | 现状 |
|---|---|---|
| 1 | `models/` **不许** `import 'package:flutter/material.dart'`（只许 `foundation`） | ✅ 今天成立 |
| 2 | `widgets/` **不许** `import '../services/xxx_transport.dart'` 这类——只能通过 controller | ✅ 今天成立（唯一引用是 `dev_card.dart:16` 拿 `chat_controller`，属允许） |
| 3 | `apps/` **不许** `import '../screens/'` | ❌ **已在违反** |

### 2.4 ⚠️ 这三条**怎么强制**

`analysis_options.yaml` 是 `flutter_lints` 模板，**加不了 import 禁令** ——
写在文档里就是**没有闸**。

**【目标】一条「楼层闸」**：`test/unit/import_rules_test.dart` ——
**读 `lib/` 下的源文件、按目录断言 import 方向**（纯 Dart，不需要 `pump`，**进硬闸**）。

> 这是"禁令有约束力"与"禁令只是口号"的**唯一区别**。

### 2.5 ⚠️ `chat_screen.dart` 的三个结构性欠账

| # | 欠账 | 现状 | 目标 |
|---|---|---|---|
| 1 | **866 行管三件事** | 浮窗几何 + 列表分页 + 页面装配混在一起 | 拆成七件；**几何与分页变成纯逻辑，进 `test/unit` 硬闸** |
| 2 | **传输层是会话级却当单例用** | `_conversationId` / `_sinceSeq` 是单实例字段 | 见 **P-e**：拆 `Connection` + 每会话一个 `Session` |
| **3** | ★ **退出一个会话会打死全站连接**（**今天就在咬人**） | 见下 | **P-e 已拍板，可动手** |

#### ★ 欠账 3 的完整链条

```
main.dart:114            只造一个 transport
  ├── :116  给主 controller
  └── :195  给 ChatScreen → chat_screen.dart:223 MiniAppEnv
              → app_registry.dart:34 → conversation_list_screen.dart:81
                            ↑ 同一个实例（broadcast 声明在 :48-50）

用户退出那个会话时：
  conversation_list_screen.dart:88   controller.dispose()
    → chat_controller.dart:442       _transport.dispose()
      → websocket_transport.dart:306-308   关掉 _events / _devSteps / _agentSnaps
        → _disposed = true ⇒ _open():155 永不重连
```

⇒ **进「会话」应用、退出来，主屏从此一条消息都收不到，而且不自恢复。**

#### 【目标】拆分后的客户端结构

| 层 | 新增文件 | 说明 |
|---|---|---|
| models | `panel_geometry.dart` | 几何 / 档位吸附 / 甩判据。**无 State、无 context 的纯函数 + 值类** |
| models | `timeline_pager.dart` | 分页（可见条数 / 隐藏行 / 显示更早） |
| models | `message_state.dart` | 四态转移的纯函数 |
| models | `mini_app.dart` | 从 `apps/mini_app.dart` **只把接口下沉**（解 §2.2 的倒挂） |
| models | `scope_name.dart` | ⚠️ **只做展示裁剪**（长度/省略号），**取词口径同服务端 `title`**，不许造第二套命名规则 |
| services | `timeline_store.dart` | 本地缓存最近一屏。**只缓存，不判断**；必须带 `scopeId + userId` 命名空间 |
| services | `voice_input.dart` | 语音。**唯一需要新 Flutter 插件的模块** |
| widgets | `system_notice.dart` | **系统说话通道**。**与聊天气泡是两条不同的通道** |
| widgets | `panel_shell` / `panel_header` / `composer` / `user_bubble` / `message_list` | 从 `chat_screen.dart` 拆出 |

> ⚠️ **`panel_geometry` / `timeline_pager` 放 `models/` 而不是 `widgets/`**：
> `widgets/` 现有 4 个文件**全都 import material**，而这两个是**无 material 的纯逻辑**。
> ⚠️ **要 ≤300 行必须抽第七件 `message_list`**（六件只能抽走约 308 行，剩约 385 代码行）。
> ⚠️ **"转屏吸附"是新功能，不是重构**——`chat_screen` 里**原本没有转屏代码**。

---

## 三、协议 v2（**唯一有硬时点的一节**）

> **为什么它有时点**：**协议一旦上线就冻结**（旧客户端还在跑）。
> 字段名改一次，就要多背一个兼容分支。
> 这条是你们自己的纪律：**"当场不记，以后永远补不回来"**。

### 3.1 【现状】九个事件

`message/start` · `message/text` · `message/status` · `message/end` · `message/seen` ·
`task/created` · `task/completed` · `user/echo` · `client/reload`（+ `error`）

**R1–R14 继续有效**（不配对 / quick+deep 同一气泡 / status 不进正文 / 中止不擦除 /
seq 去重 / 不断言进度 / 来源不塞正文 / end 的来源权威 / 刷新先说完 / 每次连上对版本 /
每事件有时间戳 / 只回报连上之后 / 灰化不可触达 / 重启由服务端说）。

### 3.2 【目标】增补字段

| 字段 | 加在哪 | 类型 | 谁填 | 什么意思 |
|---|---|---|---|---|
| **`scopeId`** | `message/start`、`user/echo`、`task/*` | string | 调度器 | 这条属于哪个作用域（= 一条 DSH 会话）。**客户端 v1 可以不显示，但字段必须在** |
| **`reRefs[]`** | `message/start` | `[{scopeId, seq}]` | 调度器 | 回跳指针 |
| **`catchUp`** | 任何补发的帧 | bool | 调度器 | `true` = 这是断线补发的历史，不是刚发生的 |
| **`timeline/marker`** | 新事件 | `{kind: 'away'\|'enter'\|'leave', label?}` | 调度器 | 时间线上的分隔。**不进消息列表，占一个位置** |
| **`step/summary`** | 新事件 | `{text}` | 调度器 | D7 默认档「在做什么」：一句人话。**必须是人话，不许出现内部名** |
| **`step/detail`** | 新事件 | `{tool, target, ms, ok}` | 调度器 | 老 `steps` 档的步骤流水（⚠️ 2026-09-26 起**只为老客户端存在**，新客户端收了也不画 —— [`dev/122`](../dev/122-TWO-PROCESS-LEVELS.md) §四） |
| **`step/reasoning`** | 新事件 | `{text}` | 调度器 | D7「推理原文」：**只给主人，默认关** |
| **`focus`**（**客户端 → 服务端**那一帧） | 新帧 | `{t:'focus', scope, sinceSeq?}` | 客户端 | ★ **切焦点、不重连**（`84` §四 · F2）。`sinceSeq` 省了 = 只切、不补发；认不出的帧**安静忽略**（协议只加不改）。`?scope=` 从此只当**初始焦点** |
| **`focus`**（`client/hello` 上的可选字段） | 服务端 → 客户端 `client/hello` | string | 调度器 | **加**一个可选字段：这条连接现在的焦点是谁（老客户端不认识它，照旧） |
| **`client/focus`** | 新事件（服务端 → 客户端） | `{ok, scope, error?, text?, at}` | 调度器 | 对 `focus` 帧的确认：`ok:true` = 生效；`ok:false` = 没这个房间（**焦点不动**，不悄悄退回主线） |

**【明确不加的】**

| 字段 | 为什么 |
|---|---|
| **`source`** | ❌ **概念错**：**与 `agent` 重复一半、与 `origin` 混淆一半**。现网已经有**两条轴**：`origin`（`dispatcher.js:549-556` `nextProvenance()`：有 pending 用户消息 = `reactive`，否则 `proactive`）回答"**为什么开口**"；`agent`（`conversation.js:193` 发 `'agent'｜'dispatcher'`，**已经在线上、只是客户端不读**）回答"**谁在说**"。而 `message/start` **永远是助手在说**——`source` 里的 `user` 想表达的其实是 `origin` 的地盘 ⇒ **P-i：删掉，用回这两条** |

### 3.3 三条语义规则（**必须写进 `PROTOCOL.md`**）

| # | 规则 |
|---|---|
| **P-1** | **必须分「现状」与「目标」**：**现状** `seq` 是**每 `conversationId` 一份**（`conversation.js:14`）；**目标 = 每个用户那条可见时间线一个计数器**（X1.1/X1.2 + **P-l 甲：一条日志**），由调度器统一发、= 那条日志已落盘最大 + 1。⇒ **要写死的是「持久事件的 `seq` vs 续传游标 `sinceSeq`」**——客户端有**两个游标**：传输层 `_sinceSeq`（`websocket_transport.dart:59/206`）与 UI 层 `lastSeq`（`chat_controller.dart:52/249`），**两个名字分开写，不许混成一个词** |
| **P-2** | ⚠️ **它是客户端渲染规则，不是服务端规则**：新轮先收旧轮（`session-translate.js:195`），补发只是**重放日志**（`conversation.js:137-141`），**根本没有"条数"概念**。⇒ **【目标】写进客户端**：补发段**只用"历史"长相渲染**，不参与"谁还没收口"的排队 |
| **P-3** | **"不占号" = "不上时间线"**。控制帧（`client/reload`）与 UI 状态（本地应声）**在进入 `timeline` 之前就被消费掉**；**`marker` 是持久事件**（取号、落盘、有位置）。⇒ 好处：`ServerEvent.seq` **保持 `required int`**，**不动基类**、**不破硬闸测试** |

> ⚠️ **P-3 原文自相矛盾**（既说瞬态不占号、又说 marker 占位置）——上面的口径是**定稿**。

### 3.4 兼容规则

| 情况 | 怎么办 |
|---|---|
| 收到**不认识的类型** | 忽略（现在的 `tryParse` 已是这个行为，保持） |
| 收到**不认识的字段** | 忽略 |
| **旧客户端遇到新编号** | ✅ **P-l 甲之后不必做**：编号语义没变，`seq <= lastSeq` 不会误丢 |
| `dev=1` | **永远是附加通道，不是替代**（有回归测试守） |
| **`re` 的类型** | ⚠️ **不许改**。而 `stream_event.dart:61` 用 `'$e'` 强转 ⇒ 正确的写法是「**`re` 只许装字符串**」 |

---

## 四、状态机与数据模型

### 4.1 一条消息的状态（【现状】一个 `pending` bool →【目标】四态）

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
2. **重发必须带服务端去重**——⚠️【现状】`/api/say` **没有 messageId 去重** ⇒ **现在重发 = agent 干两遍**
3. **200ms 本地应声必须先判 `connected`**——否则无网时先出"在处理"、2 秒后出"失败"

**【目标】归属文件**：`models/message_state.dart`（纯函数，进 `test/unit`）。

### 4.2 作用域

```
一条可见时间线（客户端只认它）
  └── 作用域栈：[主目录] → [本子] → …
        · 每个作用域 = 一个 workspace（目录）+ 一条 DSH 会话
        · 同时只有一个"焦点"作用域
```

⚠️ **`scopeId` 今天在服务端与客户端零出现**（已 grep 确认）⇒
**必须先让服务端拥有这个身份**，然后才谈它上协议。

**并行与上屏（别混）**：

| | 什么样 |
|---|---|
| **执行** | 随便并行——非焦点作用域该干活干活 |
| **上屏** | 排队——同一时刻最多一条未收口 |

### 4.3 收起 / 删掉 / 真删（X3）

```
可见（桌面图标）
  │ "收起来"  ← 不动任何数据，无期限，一键恢复
  ▼
已收起
  │ "删掉"    ← 进回收站，默认 30 天；删前必须列清单
  ▼
回收站
  │ ① 到期自动真删（提前一周告）  ② 手动"立刻彻底删"  ③ 账号注销 ⇒ 立刻清空
  ▼
真的没了
```

**"收起来"与"删掉"的唯一区别：有没有期限。**

### 4.4 D7 的两档

> 🔴 **2026-09-26 更正**（主人原话：*「**名不副实的要去掉**。」*）：**四档 ⇒ 两档**。
> 砍掉的**只是客户端菜单上的两个入口** —— 四个 wire token
> （`quiet` / `doing` / `steps` / `reasoning`）仍然**冻结**、服务端语义**一个字没改**。
> 契约与判据在 [`dev/122`](../dev/122-TWO-PROCESS-LEVELS.md)。

| 档 | 用户看到 | 谁能开 |
|---|---|---|
| **在做什么** ✅ 默认 | 一句人话，**逐个替换**："在查资料" → "在算" | 任何人 |
| **推理原文** | 模型在想什么 | ⚠️ **只有主人，默认关** |

**砍了哪两档、各为什么**（逐字原文在 `dev/122` §一）：

| 档 | 为什么砍 |
|---|---|
| **步骤流水** | 名字承诺"一步一步的流水"，而**工具行**（名字 · 人话标题 · 成败 · 展开看入参输出，而且**落盘、切回来还在**）已经把同一件事说得**更准更全** ⇒ 它只剩一串**粗粒度、瞬态**（切走就没）的重复行 |
| **安静** | 名字承诺"安静"，但它**只掐掉「它正在做…」那一行**；**工具行不受档位管**（不在服务端的 `PROCESS_TYPES` 里）⇒ 想安静的人照样看到一串工具行 —— **它做不到它名字说的事** |

**两条硬约束**：
1. **不承诺时间**（只展示"在做什么"）
2. ⚠️ **必须有乱序保护 + 超时收敛**——否则卡住时**永久停在"在查资料"**，比空白更坏
   （老 `steps` 档那一串行今天不画了，但状态机那一层照旧钉这条）

#### ⚠️ 推理原文的泄露风险（**唯一有风险的字段**）

**推理原文与 `step/*` 一律走不落盘的瞬态通道**（`session-translate.js` 的
`emitTransient()` 那一层），**按连接过滤**在 `server.js`（`levelAllows`）。
两道闸的分工写死在 `08-SPEC.md` §2.2 与契约 `dev/122` §二。

⇒ 🔴 **"只有主人"绝不能靠客户端判**：客户端只是"不显示"，**服务端才是"不发"**
（`LEVEL_EXTRA_TYPES` 里只有 `reasoning` 那一阶带 `reasoning/delta`）。

### 4.5 工时账的字段（**冻结**）

```
事项 / 数量 / 单位 / 单价(可空) / 含税(true｜false｜unknown) / 日期
```
**只追加，不原地改**（改名 = 新增；旧字段永久只读）。
**口径不明**：含税 `unknown` **不进合计**，并明说"1 条未计入"。
**硬闸**：同一句话**隔 7 天**问两次，**逐字段 diff = 0**。
**出口**：`renderLedgerText()` —— **一段能粘进微信的话**，不是表。

### 4.6 记忆 KV（❌ **【本轮不建】**）

```
索引层（常驻上下文，永远精简）= 实体/主题 + 一行 + 指针
详情层（不进上下文，按需检索）= 事实明细 + 原始会话
```

**键 = 实体 / 主题**（不是会话）。每条事实必须带 `source` 指针 + `trust`；
**"不知道"要显式表达**（`trust: unknown`），不许留空。

> ⚠️ **它在这里只作为"无出处不写 / agent 不许直接写 KV"这两条规则的定义保留**，
> **不作为可排期项**（`kv.js` 明确列在"本轮不建"）。
> ⚠️ **批 3 的"记忆清单 + 导出"是指会话/作用域清单，不是 KV**——两者别混。

### 4.7 状态清单（容器里"哪些是用户的状态"）

```
/data/main/                    主目录的文件
/data/workspaces/*/            各作用域的文件
/data/hupo/memory/             记忆索引 KV          ← 本轮不建，路径先留着
/data/hupo/audit/              审计                  ← 本轮不建
$DSH_HOME/sessions/            会话历史（记忆本体）
$DSH_HOME/storages/            投影 / 检查点
$DSH_HOME/.credentials.yaml    ⚠️ 含模型密钥 → 备份必须加密
```
**备份 / 迁移 / 删除 都照这份清单走。** 容器里其他一切可抛弃。

---

## 五、接口契约（服务端内部）

| 接口 | 归谁 | 契约 |
|---|---|---|
| **取号** | `conversation.js` | **只有一个取号函数**，`emit` / `emitTransient` / `restore` 三处都走它。见 §5.1 |
| **`MessageWriter`** | `conversation.js` | 保证 `start → text* → end`；**end 带最终 sources**；**同一时刻最多一个未收口**。⚠️ `chunk()` **必须先查 `ended`**（`:204` 现在不查 ⇒ 持旧 writer 即可破序） |
| **`store.append`** | `store.js` | ⚠️ **失败必须上抛**（现状静默吞，`store.js:22-28`）。**先落盘成功、再推订阅者**。**谁接见 §5.2** |
| **轮的稳定键** | `session-translate.js` | **必须提供「轮」的编号**，`dispatcher` 的 `this.turns` 一律用它作键。见 §5.3 |
| **`AgentRuntime`** | `agent-runtime.js` | spawn 用**白名单 env** + `DSH_HOME` + `cwd = agentCwdFor(session)`。**必须有进程上限与全局 LRU**（现状：全库不存在，TTL 是 30 分钟）。见 §5.4 |
| **淘汰** | `agent-runtime.js` | **只淘汰空闲的**；`running === true` **必须跳过且重新计时**；**先收口再卸**；**绝不删数据**。见 §5.5 |
| **准入** | `admission.js` | 内存闸；**先 LRU 卸载、再谈拒绝**；拒绝必须给一句人话 |
| **记忆出口** | `conversation_list_screen` 那条路 | **写入与出口同批**——"没出口不许登记'要存东西'" |

> ⚠️ **`sources`（出处）的语义**（2026-09-23 定的 · `docs/dev/67-SOURCES.md`）：
> `message/end.sources` = `[{title, url}]`，**空数组 = 没有出处**（这个字段一直在 —— 它是 `end()` 本来就发的）。
> · `title` 是**给人看的名字**：**有标题用标题，没有就用域名**（去掉 `www.`）—— 由**服务端**算好
>   （`src/sources.js` 的 `sourceLabel`），客户端只负责画（同一件事不许两处口径）；
> · **只装 `web_search` 与 `web_fetch` 的结果** —— 读文件、跑命令**不算出处**（说成出处就是让用户以为那句话是从那儿来的）；
> · **`snippet` / 日期 / 工具名 / 查询词一个都不许进**（这条会**画在屏幕上**）；
> · `url` **只认 `http(s)`**：别的协议既不算出处、也不许被点开。

### 5.1 序号契约（**定稿**）

**现状的真相**：取号散在**三处**，**根本不存在 `nextSeq` 函数**——
`conversation.js:42`（`emit`，`seq: ++this.seq`）、`:72`（`emitTransient`，**也发号**）、
`:150`（`restore`，取 max）。

| 事件种类 | 取号 | 落盘 | 上时间线 | 例 |
|---|---|---|---|---|
| **持久事件** | ✅ | ✅ | ✅ | `message/*`、`task/*`、`user/echo`、**`timeline/marker`** |
| **控制帧** | ❌ | ❌ | ❌ | `client/reload`（`server.js:138` 现在走 `emitTransient`） |
| **UI 状态** | ❌ | ❌ | ❌ | 本地应声（`chat_controller.dart:398`） |

⇒ ⭐ **号的归属（P-l 甲）："每个用户的可见时间线" = 一条日志**。
**持久事件的号 = 那条日志已落盘最大 + 1**，写盘成功才推 ⇒ **磁盘无空洞**。
  - **多作用域只是事件上的 `scopeId` 标签**，**不是并列的计数器** ⇒
    "按可见时间线各数各的"（X1.7）与"统一发号"（X1.1）**不再打架**。
  - **落盘结构不用改**：`conversation.js` 那条日志**本来就是**可见时间线；
    DSH 自己的会话历史在 `$DSH_HOME/sessions/`，两者**本来就分开**。
⇒ **瞬态一律不取号** ⇒ "已落盘最大 + 1"不再与它冲突。
⇒ 重启后 `restore` 取 max ⇒ **单调**。

> ⚠️ **今日反例**：`server.js:138` 的 `client/reload` 走 `emitTransient`，
> 而 `emitTransient(:72)` **发号** ⇒ **"磁盘上不得出现空洞"今天就假**。

### 5.2 ★ `store.append` 上抛之后，**谁接**

**为什么这是最急的一条**：`append` 调用点只有 **1 个**，但 **`emit` 调用点 18 个**
（dispatcher 12 / conversation 5 / server 1），**无一处 `try`**。
最狠的路径是 `agent-runtime.js:300` ← `stdout.on('data'):117`、以及 `dispatcher:603/610` 的
`setTimeout` —— **在 Node 里都是未捕获异常**（全库无 `uncaughtException`）
⇒ **盘满 → 进程退出 → 重启 → 再盘满**。

**【目标】三层接住**（缺一不可）：

| 层 | 谁 | 做什么 |
|---|---|---|
| 1 | **调用点** | **不再逐处 try**（18 处会漏）。改在**唯一入口**：`emit` 自己包一层 |
| 2 | **`emit`** | 落盘失败 ⇒ **抛** 给调用方；**订阅者一条都不推** |
| 3 | **进程级** | 装 `uncaughtException` / `unhandledRejection`：**用不落盘的通知通道**发一条人话（盘满也能发出去），然后**有界退出 + 退避重启** |

⇒ **判据**：除了"抛错 + 订阅者零收到"，还要有"**调用点不需要自己 try**"。

### 5.3 ⚠️ 轮的稳定键（**今天就在咬人的 bug**）

```
session-translate.js:209/219   this.current = { turn, writer, … } → onTurnStart(this.current)
                               ⇒ dispatcher 的 info **就是** translator.current（同一对象）
dispatcher.js:617              存键用 info.writer.messageId ← 「当时」的气泡 id

handoffTimer（短）先到 → #escalate(:700) → handoff()
  session-translate.js:288       cur.writer = new MessageWriter(…newId('m')…)
                                 ↑ cur === this.current === info
                                 ⇒ **info.writer.messageId 被隔着一层改掉了**

deadlineTimer（长）后到 → :611 guard 读到**新** id ⇒ undefined !== info ⇒ **永不收口**
:623 delete 也删**新** id ⇒ **旧键永久残留**
```

⇒ **升格过的轮次，硬收口彻底失效** ⇒ **"挂起必有收尾"与 D7 的"超时收敛"同时是假的。**

**为什么它藏得住**：**`dispatcher` 全文没有一处给 `info.writer` 赋值**——
单看那个文件，会以为这个 id 是稳定的。

**【目标】** `this.turns` **一律用「轮」的编号作键**——**五处都改**
（`:604/611/617/623/759`）。轮的编号在一轮内**构造上不会变**，`handoff` 也不碰它。

### 5.4 env 白名单

**owner 定死 = `agent-runtime.js`**（现状就在 `:94/96/144`）。

**为什么不能随手砍**：`dsh` 是 node CLI，
**丢 `PATH` 就回到 ENOENT**（`config.js:32`、`agent-runtime.js:105` 的注释里就是那个坑）；
还需 `HOME`（读 `~/.dsh`）、`TMPDIR`、`LANG`，以及**部署侧注入的 `DSH_*` / 代理变量**。

⇒ **顺序（P-j 定稿）**：**先做减法**——传全部 `process.env`，**只删 `*_API_KEY`/`*_TOKEN`/`*_SECRET`**。
**立即可做、零 ENOENT 风险**，而原本目标（去掉密钥）已经达成。
严格白名单作为**后续收敛**，不阻塞批 6。

⚠️ `DSH_HOME` **当前无处设置**（全库搜不到给它赋值的地方）。

### 5.5 淘汰：**谁回调谁**

| 问题 | 定稿 |
|---|---|
| `agent-runtime` 要"先收口再卸" | 它**全文没有 translator** ⇒ **只能 dispose**。⇒ **必须由 runtime 回调 dispatcher**（`onEvict(sessionId)`），**并把 `dispatcher.js` 排进批 6** |
| **LRU 没有访问序** | `agent():342-354` **不更新顺序**，`Map` 的插入序 **≠ LRU** ⇒ **必须先修访问序** |
| `running === true` 跳过 | **可实现**，但 **`return` 不重新计时** ⇒ **跳过一次 = 永久不淘汰** |

---

## 六、测试地图

### 6.1 三道闸

| 闸 | 现在 | 谁守 |
|---|---|---|
| `flutter analyze` | **硬闸** | 编译 |
| `flutter test test/unit` | **硬闸** ✅（现 **45 条全过**） | **协议 / 状态机 / 纯逻辑** |
| `flutter test test/widget` | **只警告，不阻断** ⚠️（现 **49 条挂 10**） | 布局 |
| `node --test services/core/test/*.test.js` | **硬闸** ✅（现 **72 条全过**） | 调度 / 对账 / 翻译 |

> ⚠️ `test/widget` 的 **49 挂 10** 逐文件分布（**实测**）：
>
> | 文件 | 执行条数 | 失败 |
> |---|---|---|
> | `floating_panel_test.dart` | 8 | **6** |
> | `smoke_test.dart` | **18** | **3** |
> | `panel_interaction_test.dart` | 5 | **1** |
> | `agent_panel` / `login` / `offline` / `weather_app` | 18 | 0 |
> | **合计** | **49** | **10** |
>
> ⚠️ **两个坑**：
> 1. **别把它当成 8 挂 6**——那只是 `floating_panel` 一个文件的数（评审第一版就犯过这个错）。
> 2. **`smoke_test` 静态只有 12 条 `testWidgets`，但实际跑 18 条**——其中一条在**一个 7 项循环里**。
>    ⇒ **数"声明数"会少算 6 条**；要数**执行数**（跑一次，看 `+N`）。

### 6.2 **新验收一律写 `test/unit`**（纪律，不是偏好）

**理由（实测）**：`test/widget/floating_panel_test.dart` **8 条挂 6**——
面板默认收起，测试却断言"默认就最大化""点展开"。
**界面一重构，widget 断言必然过期**——而重构正是接下来最常做的事。

### 6.3 必须写成**纯函数**才能进硬闸的六件

| # | 纯逻辑 | 归属文件 | 进哪 |
|---|---|---|---|
| 1 | `PanelGeometry`（几何 / 档位吸附 / 甩判据） | `models/panel_geometry.dart` | `test/unit/panel_geometry_test.dart` |
| 2 | `TimelinePager`（分页） | `models/timeline_pager.dart` | `test/unit/timeline_pager_test.dart` |
| 3 | `MessageState`（四态转移） | `models/message_state.dart` | `test/unit/message_state_test.dart` |
| 4 | **禁用词扫描** | `models/forbidden_words.dart` | `test/unit/forbidden_words_test.dart` |
| 5 | `renderLedgerText()`（账本导出成一段话） | `services/core/src/export.js` | `test/unit/ledger_export_test.dart` |
| 6 | **楼层闸**（§2.3 三条禁令） | `test/unit/import_rules_test.dart` | 同左 |

**这六件都不需要 `pump`**，正好绕开"widget 测试一过期就没人管"。

### 6.4 每条不变量至少一个盯它的测试

| 不变量 | 测试 |
|---|---|
| N12 界面作用域 = root | 只有一个 controller 时不变量；多作用域接入后补 |
| N13 跨作用域只走摘要与指针 | `scope-summary.test.js` |
| N14 主作用域不许替子作用域编细节 | 同上（两条断言） |
| N15 切换前先收口 | `timeline-order.test.js` 扩：**任意时刻未收口 ≤ 1** |
| N16 转交最多一次、禁回环 | `handoff.test.js`（A→B→A 必须被拒） |
| N19 挂起必有收尾 | 超时后必有 `message/end`——**必须覆盖"升格过的轮次"** |
| N20 事实不能静默 | 桌面新增物件 ⇒ 必有一条 notice |
| N21 一份 `DSH_HOME` | 配置断言（只允许一个 dshHome） |
| N22 `seq` 只增不减、**无空洞**（⚠️ **唯一例外：主动回收**，见 `02-ARCHITECTURE.md` §5.1·补 · 决策 D3.11） | `seq-monotonic.test.js`：重启后取号**单调** + **瞬态不落盘**；回收那一条另配判据（能解释的洞通过 / 解释不了的红） |
| N23 协议带 `scopeId` 与来源 | `protocol-fields.test.js`（**推后到服务端有身份之后**） |
| N24 收起 ≠ 删掉 | 删前必列清单；回收站可恢复 |
| N25 注入不能持久化 | `grep = 0`（含 persona / `AGENTS.md` / settings preset） |
| 先落盘再推 | `store-append.test.js`：盘满时**抛错**且**订阅者零收到** + **调用点不需自己 try** |

> ⚠️ **N17 / N18（KV 的无出处不写、agent 不许直接写 KV）本轮不排测试**——KV 本轮不建。

### 6.5 **不许写**的测试

| 不写 | 为什么 |
|---|---|
| 断言像素坐标、控件 key、"哪块贴顶" | 界面一重构必过期（**49 挂 10** 就是证据） |
| 断言"默认就最大化"这类**行为快照** | 它锁的是当时的实现，不是产品要求 |
| 内部名出现在界面文案上 | 反过来写——**用禁用词闸禁止它出现** |

---

## 七、文件级改动总索引

> 一张表看全部：哪些文件被哪几批碰。**用来评估冲突**。
> **加粗** = 该批的主要工作。

### 7.1 客户端

| 文件 | 批 1 | 批 1.5 | 批 2 | 批 3 | 批 4 | 批 5 |
|---|---|---|---|---|---|---|
| `main.dart` | **装配 + 连接创建** | —— | —— | —— | —— | —— |
| `screens/chat_screen.dart` | **四态界面 + 收起态重发 + 删自动拉满** | 交出几何/分页（变薄） | D3 三样 + 锚 + 分页 | **拆完** | —— | 话筒入口 |
| `screens/login_screen.dart` | —— | —— | **登录页定稿 + 恢复路径** | —— | —— | —— |
| `screens/conversation_list_screen.dart` | —— | —— | —— | **出口 + 收起/回收站** | 账本出口再碰 | —— |
| `services/chat_controller.dart` | **四态 + 应声 + 重发 + 判连通** | —— | —— | D7 档位 + notices | —— | 语音状态 |
| `services/websocket_transport.dart` | **401 + 退避 + 生命周期（P-e）** | —— | —— | —— | —— | —— |
| `services/transport.dart` | **接口若动则必改** | —— | —— | —— | —— | 可能加语音 |
| `services/mock_transport.dart` | **同上（测试全走它）** | —— | —— | —— | —— | —— |
| `services/timeline_store.dart` | **新增** | —— | —— | —— | —— | —— |
| `services/voice_input.dart` | —— | —— | —— | —— | —— | **新增** |
| `models/timeline.dart` | 四态字段 | —— | `scopeId` | —— | 账本条目 | —— |
| `models/stream_event.dart` | —— | —— | `scopeId` | `step/*` + marker | —— | —— |
| `models/panel_geometry.dart` | —— | **新增** | —— | —— | —— | —— |
| `models/timeline_pager.dart` | —— | **新增** | —— | —— | —— | —— |
| `models/message_state.dart` | **新增** | —— | —— | —— | —— | —— |
| `models/forbidden_words.dart` | —— | —— | **新增** | —— | —— | —— |
| `models/mini_app.dart` | —— | **新增（接口下沉）** | —— | —— | —— | —— |
| `models/dev_step.dart` | —— | —— | —— | **提炼** | —— | —— |
| `models/scope_name.dart` | —— | —— | **新增（只做展示裁剪）** | —— | —— | —— |
| `widgets/system_notice.dart` | —— | —— | —— | **新增** | —— | —— |
| `widgets/panel_shell` · `panel_header` · `composer` · `user_bubble` | —— | —— | —— | **新增** | —— | —— |
| `widgets/message_list.dart` | —— | —— | —— | **新增（第七件）** | —— | —— |
| `widgets/answer_bubble.dart` | —— | —— | **限宽 + 来源字体** | —— | —— | —— |
| `widgets/app_desktop.dart` | —— | —— | 列数按宽算 + 命名 | **新图标有动作 + 一句话 + 一键撤销** | —— | —— |
| `widgets/mini_app_container.dart` | —— | **改认 `models/mini_app.dart`** | —— | —— | —— | —— |
| `widgets/dev_card.dart` | —— | —— | —— | **提炼** | —— | —— |
| `apps/conversations_app.dart` | —— | —— | —— | **拆掉那半页（禁令 3 的债）** | —— | —— |
| `apps/about_app.dart` | —— | —— | **明写"不会拼音的人这个版本用不了"** | —— | —— | —— |
| `apps/*.dart` | —— | 文案（去内部词） | —— | —— | —— | —— |
| `pubspec.yaml` | —— | —— | —— | —— | —— | **加 speech 依赖** |
| `AndroidManifest.xml` | —— | —— | —— | —— | —— | **加 `RECORD_AUDIO`** |

### 7.2 服务端

| 文件 | 批 1 | 批 3 | 批 4 | 批 6 |
|---|---|---|---|---|
| `store.js` | **上抛** | —— | —— | —— |
| `conversation.js` | **取号收口 + 落盘成功才推 + 瞬态不发号** | —— | —— | —— |
| `server.js` | **控制帧去号 + 401 根 + 连接上限** | —— | —— | —— |
| `dispatcher.js` | **`turns` 键改「轮」编号（§5.3）** | 步骤事件 | 能力登记接线 | **准入 + `onEvict`** |
| `session-translate.js` | **轮的编号随 info 给出；`chunk()` 查 `ended`** | 步骤事件翻译 | —— | —— |
| `agent-runtime.js` | —— | —— | —— | **env 减法 + `DSH_HOME` + 进程上限 + LRU 访问序 + `onEvict`** |
| `config.js` | —— | —— | —— | **`agentCwdFor()` + 淘汰阈值 + 单一 `dshHome`** |
| `auth.js` | **TTL 30→180 天** | —— | —— | —— |
| `capability-registry.js` | —— | —— | **新增** | —— |
| `worklog.js` · `export.js` | —— | —— | **新增** | —— |
| `integrity.js` / `admission.js` | —— | —— | —— | **新增** |

> ⚠️ `auth.js` 的**两次改动必须写先后**：**批 1 先 TTL，批 2 再续期**。
> ⚠️ `dispatcher.js` 的**两次改动同落 `say()`**：**批 4 能力接线 → 批 6 准入**，不许并行。

### 7.3 测试

| 文件 | 批 | 层 |
|---|---|---|
| `test/unit/import_rules_test.dart`（**新增**：楼层闸） | 1.5 | 硬闸 |
| `test/unit/panel_geometry_test.dart`（**新增**） | 1.5 | 硬闸 |
| `test/unit/timeline_pager_test.dart`（**新增**） | 1.5 | 硬闸 |
| `test/unit/message_state_test.dart`（**新增**） | 1 | 硬闸 |
| `test/unit/timeline_store_test.dart`（**新增**） | 1 | 硬闸 |
| `test/unit/forbidden_words_test.dart`（**新增**） | 2 | 硬闸 |
| `test/unit/ledger_export_test.dart`（**新增**） | 4 | 硬闸 |
| `services/core/test/store-append.test.js`（**新增**） | 1 | 硬闸 |
| `services/core/test/seq-monotonic.test.js`（**新增**） | 1 | 硬闸 |
| `services/core/test/timeline-order.test.js`（扩） | 1 | 硬闸 |
| `services/core/test/handoff.test.js` · `scope-summary.test.js`（**新增**） | 3 | 硬闸 |
| `services/core/test/worklog.test.js`（**新增**） | 4 | 硬闸 |

### 7.4 文档、脚本与容器

> 🔴 **2026-09-22 更正**：下面这张表是**计划期**（批 6）的清单，**路径与文件名多数已经变了**：
> `packages/protocol/PROTOCOL.md` **已随目录删除**（协议现状看 §三）；
> 开机清单**不在 `scripts/`**，在 **`/etc/hupo/integrity.json`**（`root:root 0444`）；
> 人格在 **`v2/services/core/hupo-persona.yml`**。
> ⇒ **把它当"当时打算改哪些"的证据，不要当今天的作业单。**

| 文件 | 谁改 | 什么时候 |
|---|---|---|
| ~~`packages/protocol/PROTOCOL.md`~~（**已删除**） | —— | —— |
| `AGENTS.md` | 改掉"直接动手 / 免密 sudo" | ✅ **已改**（`f12fa88`，见 `docs/dev/23-DEV-VS-DEPLOY.md`） |
| `v2/services/core/hupo-persona.yml` | 同上 | 批 6 |
| `/etc/hupo/integrity.json`（**不是 `scripts/integrity-manifest.json`**） | 由主人 `sudo` 重建 | ✅ **已启用**（`verify-integrity.mjs --build`） |
| `scripts/verify-integrity.mjs` · `apply-change.sh` · `rollback.sh` | 新增 | ✅ 已有 |
| **容器三件**（Dockerfile / slice / 验收脚本） | 新增 | ✅ 已有（`scripts/build-tenant-image.sh` 等，见 `docs/dev/34-CONTAINER.md`） |

| 单用户那一代的子架构（`L1-terminal` / `L2-dispatcher` / `L3-worker`） | **已删除**——仍有效的规范已收敛进 `08-SPEC.md`；原文在 git 历史里 | —— |
| 本手册 | 结构变了才改 | 随时 |

---

## 八、三条最容易忘的

1. **`test/unit` 是硬闸，`test/widget` 只是提示。**
   新验收写错楼层 = 写了也没人守（现在 **49 挂 10** 就是证据）。

2. **协议字段一旦上线就冻结。**
   §三那张表**动工前定完**，之后只加不改语义。
   ⚠️ **但"定完"不等于"想加的都能加"**——评审砍掉了 `source`，因为它与已有的两条轴重复。

3. **数值不在这份文档里。**
   阈值、超时、容量——**只住在代码里**。本文写数值的那一刻，它就开始过期了。
