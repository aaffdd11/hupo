# 117 · 排队看得见、撤得掉（DSH 的 QueueDock 那一档）

> **主人 2026-09-26 原话**：*"首先全部开放，聊天窗口的设计也要重做。"*
>
> 这是那一批的**第二刀**（第一刀是 [`116-CHAT-OPEN-AND-REDESIGN.md`](116-CHAT-OPEN-AND-REDESIGN.md)：
> 工具行 / 系统提示词 / 每轮用量 / 过程折叠）。这一刀只做一件事：
> **运行中再发一句 ⇒ 它排着的那一句，屏幕上看得见、而且撤得掉。**
>
> 形状的依据：研究 [`115-DSH-WINDOW-PARITY.md`](115-DSH-WINDOW-PARITY.md) §一.5
> ＋ 原始证据 [`115-raw/B-render.md`](115-raw/B-render.md) §3.3（DSH 的 **QueueDock**）。
> 规范落点：`08-SPEC.md` §2.2（一行：`queue/changed` ＋ 客户端帧 `unsay`）。

---

## 〇、一句话

服务端**早就**排队了 —— 主人在上一件事还没做完时又发一句，
`src/dispatcher.js` 会把它记成一张**票**（`#delivered`；那一处注释里记着 DSH 的实测事实
`agent/inbox/spliced {target:"next-turn"}`），等这一轮结束、下一轮开始时**认领**它。
可屏幕上**一个字都没有**：他既看不见自己还排着什么，也撤不掉。

⇒ 这一批把那本账**如实报出来**（下行 `queue/changed`，瞬态、按房间），
并给一条**撤掉一句**的回程（上行 `{"t":"unsay","messageId":"m_…"}`）。

🔴 **这一批只"报"和"撤一句"，不改调度**：FIFO、票/认领、
`pendingDeliveries`、N19 的排队收口 —— **一个字节都没动**。

---

## 一、服务端 → 客户端：`queue/changed`（瞬态 · 按房间）

```
{"type":"queue/changed",
 "items":[{"messageId":"m_…","text":"他说的那句（截到上限）","at":1790…,"truncated":false}],
 "count":2,
 "scopeId":"那一间"}
```

| # | 规矩 | 为什么 |
|---|---|---|
| 1 | **瞬态**（`emitTransient`：不占号、不落盘、重连**不重放**） | 它是"**现在**还排着什么"，不是"盘上的事实"。判据 Q1 反着验：盘上 `queue/changed` **零行**、帧上**没有 `seq`** |
| 2 | **按房间**（带上 `scopeId`，走 `worlds.js` 的 `#viewFor`） | 实时那一侧按**焦点**路由（`server.js` 的 `eventInScope`）⇒ **只有正开着这一间的那条连接收得到**（判据 Q2 的反例） |
| 3 | `items` = **还没被认领**的那些票，按 **FIFO**（最早投的在前） | 与 `#claimDelivery()` 认领的次序**同一条出处**（都按自增 `seq`）；一处口径，不另推一份 |
| 4 | `text` = **主人自己的原话**，截到**上限**（住 `src/queue.js` 的 `QUEUE_TEXT_MAX`），截了如实标 `truncated:true` | **不发明、不摘要、不翻译**；截了不说 = 页面在说假话。按**码点**截（不劈开 emoji） |
| 5 | 只有带**非空 `messageId`** 的票进得来 | 撤那一帧就是按 `messageId` 认的 —— 报一条撤不掉的，就是画了一个按不动的按钮 |
| 6 | `count` **由 `items` 数出来**（不是另给一个数） | 两边一旦对不上，屏幕上就会出现"N 条排队消息"底下只有两行 —— 那是页面在说假话 |
| 7 | **每一处队列真的变了**都报一次 | 投递进队 · 一轮开始认领 · 投递失败被摘掉 · 超时/失败收掉排队 · 撤掉一句（判据 Q5） |

### 1.1 🔴 它是**进程内**的 —— 这是如实的行为，不是缺陷

队列住在 `Session` 的 `#delivered` 里：**进程 / host 一重启就没了**。
⇒ 刷新 / 断线重连之后，客户端手上那份队列是空的，**唯一**的重建路径是
**`client/hello` 那一刻服务端现发一份当前快照**（`server.js`：紧跟 `client/hello` 之后、
订阅实时之前 —— 那一段是同步的，Node 单线程，中间插不进一条队列变化）。

> DSH 自己的文档也写着：它那个控制面基线**不能跨宿主重启重建**。
> 我们这一份同理 —— 这一帧只能说"**我现在手上有什么**"，不是"你关机时留着什么"。

---

## 二、客户端 → 服务端：`{"t":"unsay","messageId":"m_…"}`

| # | 规矩 | 为什么 |
|---|---|---|
| 1 | **走 `/api/stream` 那条流回去**（与 `focus` / `job-answer` 同一条路） | 排队那一帧本来就是这条流上的；**不新开 HTTP 路由**（路由表的权威是 `08-SPEC.md` §2.1，一个动作一个家） |
| 2 | **只在"还没被认领"时**摘得掉 | 票被认领之后就从 `#delivered` 里拿走了（那一轮正用着）⇒ 结构上找不到它 |
| 3 | 已经被认领 / 不认识 ⇒ **什么都不做**，而且**没有错误面** | "那句已经在跑了"不是错误 —— 不回错、不回一句我们编的话 |
| 4 | 两种情形都回一份**新快照** | 客户端手上那份可能是旧的 ⇒ 让它**收敛**（认领/不认识那一档由 `server.js` 按当前焦点现发） |
| 5 | 认不出的帧 ⇒ **安静忽略** | 与焦点 / `job-answer` 同一条纪律（判据 Q7：连接照旧活着、之后照常能撤） |

---

## 三、服务端落点

| 文件 | 是什么 |
|---|---|
| `v2/services/core/src/queue.js`（新） | 那一帧的**形状与认法**（`queueChangedEvent` / `parseUnsayFrame` / `clipQueueText` / `queueItemOf`）—— **唯一出处**（同 `app-events.js` / `tool-rows.js` 那条纪律） |
| `v2/services/core/src/dispatcher.js`（改） | `Session.queueItems`（FIFO ＋ 截断 ＋ 只取带 id 的）· `#noteQueueChanged()` 出口 · `Session.unsay()` / `hasQueued()` · 每一处队列变化调一次出口；外层 `Dispatcher.queueItemsOf(scope)` / `unsay(messageId)` |
| `v2/services/core/src/worlds.js`（改） | 把出口接到**那一间的视图**上（`#viewFor(…).emitTransient(queueChangedEvent(…))`，与 `emitLiveChange` / `onInstalled` 同一处接线） |
| `v2/services/core/src/server.js`（改） | 认那一帧"撤一句"（在 `job-answer` 之后、`focus` 之前）＋ `client/hello` 那一刻现发一份快照 |

---

## 四、客户端落点（Flutter · `v2/apps/mobile`）

| 文件 | 是什么 |
|---|---|
| `lib/models/chat_queue.dart`（新） | `ChatQueue` / `ChatQueueItem`：认那一帧（**fail-closed，绝不抛**）；身份认不出的条目**丢掉**；`count` 数出来 |
| `lib/models/queue_words.dart`（新） | 那条横条的**全部文字**（计数抬头 / 撤掉 / 展开收起）—— 集中一处，进禁用词那道闸 |
| `lib/widgets/queue_strip.dart`（新） | 那条横条：**一条 ⇒ 一行内联**；**两条以上 ⇒ 折在计数抬头后面**（点开/收起）；每行 = 原话一行省略号 ＋ 撤掉按钮（命中区 ≥44）；**空队 ⇒ 什么都不画**；上边一条 `dshHairline`；数值只用 `dsh_design.dart` 的 token |
| `lib/models/timeline.dart`（改） | `Timeline.queue`（一间一份的瞬态快照；`_applyTransient` 整份换掉）—— **不进 `items`**（瞬态不是时间线条目） |
| `lib/services/chat_controller.dart`（改） | `queue` 读 ＋ `unsay(messageId)` 写（**不做乐观删除**：等新快照回来那一行才消失）；`SayBusy` 那条注释写清"内存准入闸 ≠ 排队" |
| `lib/services/stream.dart`（改） | `unsay()`（与 `answerJob` 同一个形状：没连着 ⇒ `false`，绝不假装撤掉了） |
| `lib/screens/chat_screen.dart`（改） | 把那条横条画在**输入条上面、浮窗里面**（`_composer` 里包一层 `Column`） |

---

## 五、判据

### 5.1 服务端（`v2/services/core/test/queue.test.js`，Q1–Q7）

| # | 判据 | 反例 |
|---|---|---|
| **Q1** | 形状对（`type/items/count`，item 四个字段）＋ **瞬态**：帧上**没有 `seq`**、盘上 `queue/changed` **零行** | 换成 `emit` ⇒ 盘上多行 ⇒ 红 |
| **Q2** | **只有正开着这一间**的那条连接收得到 | 焦点在别间的连接收到这一间的排队 ⇒ 红 |
| **Q3** | `text` 裁到上限、是**原话的前缀**、截了标 `truncated`；正好到上限的不动 | 摘要/改写/没截却标截断 ⇒ 红 |
| **Q4** | `items` 是 **FIFO**（最早投的在前） | 反序 ⇒ 红 |
| **Q5** | 撤得掉**还没被认领**的；**已经被认领**的撤不动、而且**没有错误面**；两种都回新快照 | 撤掉正在跑的那句 / 回一条报错 ⇒ 红 |
| **Q6** | **`client/hello` 那一刻现发一份快照**（含**空队**那一份），次序在 `hello` 之后 | 不发 / 发在 hello 之前 / 空队不发 ⇒ 红 |
| **Q7** | 认不出的帧（坏 JSON / 别的 `t` / 缺 `messageId`）**安静忽略**：连接照旧、不回话；之后照常能撤 | 回一句 / 把连接踹了 ⇒ 红 |

### 5.2 客户端

| 文件 | 条数 | 钉什么 |
|---|---|---|
| `test/unit/chat_queue_test.dart` | 10 | 认帧（FIFO / 原话不改）· 截断如实保留 · 空队 · **fail-closed**（坏 `items` ⇒ 空队、坏身份 ⇒ 丢条、**绝不抛**）· **不编数**（服务端另给的 `count` 不参与） |
| `test/widget/queue_strip_test.dart` | 7 | **空队什么都不画** · 一条内联 · 两条折着/点开/收起 · **按"不发了"只发一帧、发的是那一行自己的号**、而且**不做乐观删除** · 服务端说没了就消失 · 坏帧不打崩屏幕 |
| `test/widget/accessibility_test.dart`（加用例） | ＋25 实例 | 那条横条在**五档字号**下不溢出（一条 / 三条折着 / 三条展开）＋ 撤掉按钮与抬头的**命中区 ≥44** |
| `test/unit/forbidden_words_test.dart`（加名单） | — | 那条横条那几句话进禁用词扫描（这一批最容易混进来的就是内部词） |

### 5.3 读数（**跑出来的**）

| 闸 | 命令 | 读数 |
|---|---|---|
| 服务端 | `cd v2/services/core && npm test` | **1277 过 / 0 挂**（基线 1270 ⇒ 我这一刀 **＋7**：新 `test/queue.test.js`） |
| 客户端·编译 | `cd v2/apps/mobile && ~/sdk/flutter/bin/flutter analyze` | **No issues found!** |
| 客户端·单元（硬闸） | `~/sdk/flutter/bin/flutter test test/unit` | **630 过 / 0 挂**（基线 620 ⇒ ＋10：新 `chat_queue_test.dart`） |
| 客户端·可访问性（硬闸） | `~/sdk/flutter/bin/flutter test test/widget/accessibility_test.dart` | **331 过 / 0 挂**（基线 306 ⇒ ＋25 实例） |
| 客户端·三道闸一条命令 | `bash scripts/check-client.sh` | **✅ 硬闸全过**（analyze 干净 · unit **630** · a11y **331** · 其余界面测试 **285**，提示档也全过） |
| 文档闸 | `node scripts/check-docs.mjs` | ✅（117 出生即进 RATCHET；INDEX 加一行指针，零数值） |

⚠️ **一处踩到的坑（改的是老代码，如实记）**：`_EmptyState` 里
`BoxConstraints(minHeight: cons.maxHeight - 64)` —— 分到的高度不足 64 时它是**负数**，
而 `BoxConstraints` 一收到负的 `minHeight` 当场抛（`negative minimum height`）。
这一批把它暴露出来了（3.1 倍字号 ＋ 那条横条展开 ⇒ 空屏那一块只分到 37.5 像素）。
修法是**夹到 ≥0**（"地方不够就滚"照旧成立）。

⚠️ **那条横条的高度上限**：DSH 的 QueueDock 列表是 `max-height:180px`；
这里 **不写死 180** —— 上限取 `min(180, 屏高 × 那个比例常量)`（两个常量都住 `dsh_design.dart`）。
理由：只用 180 的话，3.1 倍字号下这一块会把聊天区挤没（硬闸当场红 23 像素）。
⚠️ DSH 那个 **`row height:36px` 故意没搬**：我们的行里有一个命中区 ≥44 的撤掉按钮，
把行写死 36 就夹住了字（D3.5：容器跟字算）。

---

## 六、如实说（这一批**没做到** / 明确的边界）

1. **不做 Edit / Steer**。DSH 的 QueueDock 每行还有"编辑"与"插话发送"两个动作 ——
   `115` §六 把它们列在**后面几期**（丙-4 的其余部分）。这一批只做"**看得见 ＋ 撤得掉**"。
2. **切焦点不补一份快照**（只认 `client/hello`）。协议那一份点名要的是 hello 那一条；
   这一批**不即兴扩**发帧的时机。⇒ 他**切到另一间**时，那一间排着什么要等
   **下一次变化**（或一次重连）才看得见。这是**已知缺口**，不是"忘了"。
3. **队列不落盘**（进程重启就没了）—— 见 §1.1：这是**如实的行为**，
   不是这一批偷懒（票据本来就在内存里，落盘会让"重启后一份谁都撤不掉的幽灵队列"存在）。
4. **不做优先级 / 重排 / 多条一起撤**：一次只撤一句（一帧一个 `messageId`）。
5. **收起来的浮窗里也画那条横条**（收起档 = 抓手行 ＋ 输入条 ＋ 它）——
   那一档本来是"就一行"；横条只在**真有排队**时才占那一点高度（空的时候零像素）。
   ⚠️ 这一条是**我的判断**，不是主人拍的：要是他觉得收起态应该保持"只有一行"，
   那就该只在展开档画它（一行改动）。
6. **`text` 截的是"字符数"**（服务端按码点算）；界面上那一行还会再按宽度省略一次 ——
   两个是**不同的**裁剪，谁也不冒充谁（`truncated` 说的是**服务端那个**）。

---

## 真机读数（2026-09-26 · 不花一个 token）

临时核心（`HUPO_DATA=/tmp/hupo117/data`、`HUPO_PORT=18778`、另一个 `DSH_HOME`）＋ 一个**挂着不结束**的假 agent
（`FAKE_SCENARIO=hang`，真 stdio）＋ **真 `/api/say`** ＋ **真 WebSocket**（真令牌）。读完按 pid 精确收掉
（线上那台没碰：收完只剩 1 个 `serve.js`，`/api/health` 照旧活着）。

| 步 | 读数 |
|---|---|
| ① 第一句（这一轮会挂着） | 已投递 |
| ② 它还在忙时发第二句 | **已投递**（不是 429；改前那句"它现在忙不过来"是**内存准入闸**，另一回事） |
| ③ 客户端收到 `queue/changed` | `{"type":"queue/changed","items":[{"messageId":"m_117_b","text":"第二句：排队等着","at":1790410271479,"truncated":false}],"count":1,"at":1790410271479}` |
| ④ 撤掉第二句之后 | `{"type":"queue/changed","items":[],"count":0,"at":1790410272984}` |
| ⑤ 负向对照：先发一帧垃圾，再撤一句**已经在跑**的 | **连接还活着**（状态 1）· 最后一份队列视图 `{"items":[],"count":0,"scopeId":"main"}` · **没有 error/notice** |
| ⑥ 盘上数 `queue/changed` | **0 行** ⇒ 瞬态、不落盘（与契约一致） |

⚠️ **如实记一处观察**：③④ 那两帧来自调度器那个出口（**不带** `scopeId`），⑤ 那一帧来自 `server.js` 对
`unsay` 的直答（**带** `scopeId:"main"`）。客户端两侧都收（`eventInScope` 认），但**同一个事件两种形状**
是个小瑕疵 —— 记在这儿，下一次动这一块时对齐。

⚠️ **还欠**：屏幕上的那一眼（浮窗默认收起、Flutter 画布手势送不进去 —— 与批 1 同一条限制）；
`queue_strip` 的渲染由 widget 判据（7 条，含空队零像素、一次点击只发一帧、不做乐观删除）在真渲染树上兜着。
