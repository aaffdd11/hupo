# 26 · 过程四档（**D7 的出口**）

> **这一篇是契约，先写死再动手**（这个项目的规矩：不许猜）。
>
> **手册依据**：`05-DECISIONS.md` **D7 / D7.1–D7.5** · `08-SPEC.md` §6.2（D4.8 那条）
> · `04-ROADMAP.md` 批 3「过程四档」· 不变量 **N10**（沉默优于编造）
> **代码**：服务端 `src/timeline.js`（`emitTransient` 已有）· `src/session-translate.js` ·
> `src/server.js`（连接级选项）；客户端 `lib/models/process_words.dart`（人话表已有）·
> `lib/screens/chat_screen.dart` · `lib/services/stream.dart`

---

## 一、四档是什么（D7 原文）

| 档 | 屏幕上 | 默认 |
|---|---|---|
| **安静** | 只有"它说的话"（连「在做什么」也不显示） | |
| **在做什么** | 一句**人话**（`web_search` → **"在查资料"**） | ✅ **默认** |
| **步骤流水** | 一句句步骤（"在查资料" → "在写" → …） | |
| **推理原文** | 它的**思考原文** | ⚠️ **只有主人，默认关** |

四条不许破：**D7.1** 默认档文案必须人话且进禁用词扫描（`process_words.dart` 已有、有闸）·
**D7.2 不承诺时间**（不许出现"N 秒后/马上好"）· **D7.3 展示过程不替代速度**（别拿它当性能借口）·
**D7.4 推理原文只给主人**。

## 二、⚠️ 那条硬约束：**推理原文不许落盘**

`emit()` 会**落盘**（这是"可见时间线"的地基），而**新连接会 replay 全部历史** ⇒
一份走了 `emit()` 的推理原文，**以后每一个连上来的人都能拿到**（并且它可能含**系统提示词片段** ⇒ D7.4 说的核心资产）。

⇒ 铁律三条：

1. **`step/*` 与 `reasoning/*` 一律走 `emitTransient()`**（不占号、不落盘 —— 决策 P-g 已经定过"瞬态不占号"）；
2. **`level` 是连接级的**（每条 WS 连接各自一份，不是全局开关；`server.js` 现在从 query 取 `dev`，照那个形状扩展）；
3. **泄露闸**：一条测试断言 —— **新连接 `sinceSeq=0` 重放，一个推理字节都收不到**，
   而且**日志文件里 grep 不到**推理内容。

## 三、契约（v1，**这就是"两边要对齐"的那份**）

客户端连流时带 **`level`**：

```
wss://<host>/api/stream?sinceSeq=<n>&level=quiet|doing|steps|reasoning
（不带 = doing）
```

服务端按连接发：

| level | 发什么 |
|---|---|
| `quiet` | 只发 `message/start` / `message/text` / `message/end`（**连 `message/status` 都不发**） |
| `doing`（默认） | 上面那些 + `message/status`（`process_words.dart` 翻成人话） |
| `steps` | 上面那些 + **`step/start` / `step/end`**（瞬态） |
| `reasoning` | 上面那些 + **`reasoning/delta`**（瞬态）+ steps |

事件形状（**新增，不动既有字段的语义** —— 协议字段一旦上线就冻结）：

```jsonc
{"type":"step/start","turn":3,"step":1,"state":"searching"}   // state 走人话表
{"type":"step/end",  "turn":3,"step":1,"reason":"completed"}
{"type":"reasoning/delta","turn":3,"text":"…"}                 // ⚠️ 瞬态，永不落盘
```

⚠️ **乱序保护 + 超时收敛**（路线图点名要的两条，都落在客户端）：

* 步骤帧带 `turn`/`step` ⇒ 客户端**丢掉"已收口那一轮"的迟到步骤**（照 H4 那条既有规矩：迟到的旧轮不许把提示点回来）；
* **收敛**靠服务端的硬收口：每条开过的轮都有 `turn/end`（超时也补）⇒ 客户端收到 `message/end` / 轮收口即**清掉该轮的步骤**（不许留成"永远在查资料"）。

## 四、谁做什么（**两个 agent 并行，互不碰对方的树**）

| | 服务端（`v2/services/core/**`） | 客户端（`v2/apps/mobile/**`） |
|---|---|---|
| 1 | `level` 从 query 解析（沿 `dev` 那条现有的形状），**按连接持有** | 把 `level` 带进流地址（`stream_uri.dart` 的纯函数扩展 + 单测） |
| 2 | `steps`/`reasoning` 走 `emitTransient`，`reasoning/delta` 只在 `level=reasoning` 时发 | 四档的**本地设置**（存哪、默认 `doing`） |
| 3 | **泄露闸**（重放拿不到、日志 grep 不到）+ 既有 `dev=1` 不许被弄坏 | 渲染三样：步骤流水 / 推理原文（**视觉上要和"它说的话"分得开**）/ 安静档不显示 |
| 4 | 既有闸全绿（**325**） | 既有闸全绿（unit **129** + widget 44）+ 新档的测试 |

⚠️ **两边的验收都必须包含**：`level=quiet` 时**没有** `message/status`（安静档要真的安静）。

## 五、还没定的（**留给主人**）

* **四档的切换入口放哪**：`关于` 页？长按？还是别处。→ 这一批**先只做"能切"**（一个最小的入口），
  入口位置**等主人看**过再定 —— 它不是契约的一部分。
