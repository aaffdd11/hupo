# 116 · 聊天窗口重做（第一批）：**信息全部开放 ＋ 按 DSH 的设计重做**

> **主人 2026-09-26 原话**：
> *"首先全部开放，聊天窗口的设计也要重做。"*
>
> 三条已签的形状（主人当场点的，见 §〇）：
> **① 形态**：桌面与浮窗**留着** —— 重做的是**浮窗里面**；
> **② 技术**：继续 **Flutter**（同一套代码出 Web ＋ iOS ＋ Android）；
> **③ 第一批**：**设计骨架 ＋ 全部开放的工具行 ＋ 过程折叠**。
>
> 依据与研究（DSH 的窗口到底有什么、我们差在哪、三条路的代价）：[`115-DSH-WINDOW-PARITY.md`](115-DSH-WINDOW-PARITY.md)
> （原始证据 `115-raw/`，含六张真机截图）。
> 规范落点：`08-SPEC.md` §2.2（四条新事件）＋ `05-DECISIONS.md` **D1.1·补**（聊天窗口内放开内部词）。

---

## 〇、这三条是谁拍的、在哪拍的

| # | 问题 | 主人选的 |
|---|---|---|
| 1 | 窗口形态 | **乙**：桌面留、浮窗留，**里面的聊天按 DSH 重做**（不是把产品换成三列工作台，也不是"两样都做"） |
| 2 | 客户端技术 | **甲**：**继续 Flutter**（不换成 Web/React） |
| 3 | 第一批交付 | **甲**：**骨架 ＋ 全部开放的工具行/过程折叠**（不是一次做完 transcript＋输入区＋右栏，也不是只出方案） |

**"全部开放"具体指哪几样**（这是那句话的可执行定义）：

| 上屏 | 改前 | 改后 |
|---|---|---|
| 工具名（`bash` / `web_search` / `write` …） | 🔴 结构上**不发**（只发"在查资料/在写"） | ✅ **原样发**（持久事件） |
| 一次调用的**一句话标题** | 无 | ✅ 从入参**现成字段**里取（`description`/`command`/`path`/`query`/`url`），取不到就是 `null` |
| **入参** | 完全不发 | ✅ 有界（`MAX_ARGS_CHARS`），超了截断并如实报 `bytes`/`truncated` |
| **工具输出与成败** | 完全不发 | ✅ 有界摘要（`MAX_EXCERPT_CHARS`）＋ `ok/error` ＋ `bytes`/`truncated` |
| **每轮 token 用量** | 只在服务端账本里 | ✅ `turn/usage`（**不精确就整块不画**） |
| **模型看到的系统提示词** | 一个字节都不发（只在「我自己那台」里能原样看到） | ✅ `system/prompt`（有界 ＋ 如实说截断） |
| 推理原文（`reasoning`） | 按档位、**瞬态** | **不变**（仍然只在"它心里想的"那一档、**一个字节都不落盘**） |
| `step/*`（步骤流水） | 瞬态 | **不变**（瞬态） |

⚠️ 放开的是"**把这条会话摊开给人看**"（`D1.1·补`）—— 产品其余界面（首页/登录/桌面/设置/空态/报错）
**照旧一个内部词都不许有**，那道禁用词闸一个字没删。

---

## 一、服务端：四帧新事件（持久）

形状的**唯一出处**是 `v2/services/core/src/tool-rows.js`（纯函数，另有一份判据逐字钉住）：

```
{"type":"tool/call",     "turn":3,"step":1,"callId":"call_1","name":"bash",
 "title":"把这一半提交掉","args":"{\"description\":…}","bytes":220,"truncated":false}
{"type":"tool/result",   "turn":3,"step":1,"callId":"call_1","ok":true,"error":null,
 "excerpt":"…输出摘要…","bytes":12043,"truncated":true}
{"type":"turn/usage",    "turn":3,"usage":{"input":105,"output":22,
 "cacheRead":11,"cacheWrite":0,"reasoning":6},"complete":true}
{"type":"system/prompt", "turn":3,"step":1,"text":"…","bytes":8431,"truncated":true}
```

四条规矩（每条都有判据）：

| # | 规矩 | 为什么 |
|---|---|---|
| 1 | **持久**（`timeline.emit`：有号、落盘、翻页/重连/切回这一间都拿得到） | 它们是**这条会话发生过的事**，不是"正在做"的过程噪音；DSH 的窗口也是这么做的（`session/follow` 里同样是持久事件） |
| 2 | **有界 ＋ 如实**：`bytes`（原始字节数）与 `truncated` 一起给 | 一次 `bash` 的输出可以几十万字；截了却不说 = 让界面**说假话** |
| 3 | **用量宁可不画，也不给半个**（任何一次尝试没报准 ⇒ `usage:null, complete:false`） | 与 DSH 同一条：`aggregateAttempts` 只要有一次不安全就整块作废 |
| 4 | **`tool/result` 上没有工具名**（DSH 实测）⇒ 靠 `callId` 配回 `tool/call`；配不上就只画结果那一行 | 不猜 |

⚠️ **它们不在 `PROCESS_TYPES` 里** ⇒ 与"安静/在做什么/步骤流水/它心里想的"那四档**无关，每一档都发**
（那四档管的是**过程话多少**，不是"时间线还剩什么"）。

⚠️ **泄漏闸只改了另一半**（`test/process-level.test.js`）：
推理原文与 `step/*` **仍然一个字节都不落盘**；工具名/入参/输出/用量/系统提示词**必须落盘**
（判据是"两件事同时成立"，不是把闸拆了）。

⚠️ **一次真机踩到的坑（已修）**：那两条重放判据里，断言失败会**跳过 `srv.close()`** ⇒
一个挂着的 HTTP server 让整份测试文件**永远不退出**（`npm test` 挂到超时）。
修法：收尾挂到 `t.after()` 上 —— 红了也要关。

---

## 二、客户端：设计骨架 ＋ 工具行 ＋ 折叠（已落地）

### 2.1 文件

| 文件 | 是什么 |
|---|---|
| `lib/models/dsh_design.dart`（新） | DSH 的 token：亮/暗两份色板 · **`0.5px` 描边** · 七级字号 · **字号轴 12–17（默认 14，`calc(N+Δ)`）** · 圆角/间距 · 正文列宽与气泡宽 · 两个有界正文高度（141 / 260，照 DSH 的 141/260） |
| `lib/models/tool_row.dart`（新） | `ToolRow.parse`（认不出 ⇒ `null`，绝不抛）· `ToolRow.parseResultOnly`（结果先到：**只画结果那一行**，名字空着不编）· `TurnProcess.fold` ＋ `dshTurnProcessLabel`（工具/subagent **互斥**、零段省略、全零兜底）· `foldTurnUsage`（**不精确就整块 null**）· `SystemPromptRow.parse` |
| `lib/models/tool_row_words.dart`（新） | 四行新 UI 的**全部文字**（状态词 / 截断那句 / 系统提示词抬头 / 用量桶名 / 折叠文案源）＋ `groupDigits` |
| `lib/widgets/tool_row_view.dart`（新） | `ToolRowView` / `SystemPromptView` / `TurnUsageRowView` / `TurnProcessControl` —— **只用 `dsh_design` 的 token**（新文件里写死尺寸 0 处，那道棘轮闸盯着） |
| `lib/models/timeline.dart`（改） | 三个新条目类型；`apply` 接住四帧；`tool/result` 按 `callId` **就地认领**（行位置仍是调用的 `seq`）；结果先到 ⇒ 挂 pending，调用晚到再合成一行；`closedThrough` 暴露；`reset()` 清干净 + 清 pending |
| `lib/services/chat_controller.dart`（改） | `closedThrough` / `toolRowsOfTurn` / `processOfTurn` / `turnUsage`（**折过才画**） |
| `lib/screens/chat_screen.dart`（改） | `_planSlots`：**收口那一轮的工具行换成 1 个控件**（真的少画，不是 hidden）· `_applyAutoFold` ＋ `_focusInTranscript`（**焦点在时间线里就不折**，FocusManager 监听补做）· 三条渲染分支 |

### 2.2 判据（新 38 条，全部在硬闸里）

| 文件 | 条数 | 钉什么 |
|---|---|---|
| `test/unit/tool_row_plumbing_test.dart` | 21 | 四条事件进日志 / `callId` 认领 / **孤儿结果**（结果先到也画得出来） / `reset` 清干净 / 控制器的三个查询 |
| `test/unit/tool_row_words_test.dart` | 11 | 文案逐字 **且不编数**（没有钱、没有百分比、没有编出来的总数） |
| `test/widget/tool_rows_test.dart` | 6 | **真的画到屏幕上**；含「自动折叠**不许吃掉键盘焦点**」的正反两条 |
| `test/unit/tool_row_test.dart` · `dsh_design_test.dart` | 36 ＋ 27 | 行逻辑与 token 表（含三个真包值：`error` 亮 `#ec1313`/暗 `#f25a5a` · `warn` 亮暗同值 `#f59e0b` · `success` 亮暗同值 `#22c55e`） |
| `test/widget/accessibility_test.dart`（加用例） | ＋35 实例 | 新行在五档字号下不溢出、命中区 ≥44（D3.5/D3.6 **点名要硬闸**） |

**读数**：`flutter analyze` 干净 · `flutter test test/unit` **620 过 / 0 挂** · `test/widget/accessibility_test.dart` **306 过 / 0 挂** ·
`test/widget` 全量 **584 过** · `bash scripts/check-client.sh` **四档全 ✓**（exit 0）。

### 2.3 如实说：这一批**没做到**的六件（都在代码注释里写了）

| # | 缺口 | 为什么 / 要补什么 |
|---|---|---|
| 1 | **没有实现 DSH 的「`hasMore` 就不折」** | 我们这一侧**没有权威的 hasMore**（`olderExhausted` 只在用户往上翻过一次之后才有意义）⇒ 不拿它当闸。要补：服务端给一个权威的"这一轮之前还有没有" |
| 2 | 折叠标签里的**「N 条消息」恒不出现** | `message/*` 不带 `turn`/`step` ⇒ 客户端算不出"严格早于答案那一步"的那几条。**宁可不显示，不编** |
| 3 | 折叠控件插在**该轮第一条过程行**上，不是 DSH 的"答案边界" | 客户端今天认不出"哪一步是最终答案" |
| 4 | **删一轮之后，那一轮的工具行还在屏幕上** | 墓碑只带 `messageIds`，而工具行没有 `messageId`、也没有 message↔turn 映射（`hideMessages` 里有注释） |
| 5 | `tool/call` 的**入参**截断报不出来 | 服务端发了 `args` 的 `bytes`/`truncated`，而 `ToolRow` 这一版只存结果那一半 ⇒ 界面只说"结果被截" |
| 6 | 新文案里有 `工具` / `subagent` / `系统提示词` —— 正是禁用词表里的词 | 主人已在「聊天窗口」内放开（`D1.1·补`），**但词表与本批按规矩不许动** ⇒ 这几个常量**故意没**进 `forbidden_words_test` 的"必须干净"清单，`forbidden_words.dart` 一个字没改。**这一条要主人拍一句**（见 §五·2） |

⚠️ **本批明确不做**（第二批起，见 `115` §六·丙-5…丙-8）：
左栏房间/会话树 · 右栏文件与预览 · **Trajectory** 视图 · **Queue / Steer** 两档输入语义 ·
亮/暗主题开关与字号设置（token 与轴已经就位）· 待办/目标的显示位置调整。

---

## 三、真机读数（2026-09-26 · 临时核心 ＋ 真跑一个 agent ＋ 真浏览器）

**这一趟不花一个 token**：用一个**临时核心**（`HUPO_DATA=/tmp/hupo116/data`、`HUPO_PORT=18777`、
`HUPO_WEB=` 已构建的客户端、`DSH_HOME=/tmp/hupo116/dsh`）＋ 一个**真被 spawn 的假 harness**
（`test/fake-agent.mjs`，`FAKE_SCENARIO=tool-write`，走真 stdio JSON-RPC）＋ **真 `/api/say`** ＋
**真浏览器**（`scripts/check-web-browser.mjs`）。读完即收（那个临时核心按 pid 精确收掉 —— **线上那台没碰**）。

| 读数 | 值 |
|---|---|
| 一轮下来的事件序列（盘上） | `user/echo · tool/call · task/mutated · message/start · message/text · turn/usage · message/end` |
| `tool/call` 那一帧原话 | `{"type":"tool/call","turn":1,"step":1,"callId":"call_write_3","name":"write","title":null,"args":"{}","bytes":2,"truncated":false,"seq":2}` |
| `turn/usage` 那一帧原话 | `{"type":"turn/usage","turn":1,"usage":{"input":10,"output":5,"cacheRead":85,"cacheWrite":null,"reasoning":null},"complete":true,"seq":6}` |
| 浏览器 | 那条流 **1 条 socket / 断 0 次**；收到 **8 帧**；**客户端认出的类型里含 `tool/call` 与 `turn/usage`**（说明新接线在真浏览器里真的活了，不只是单测） |
| 反例（正对照） | 推理原文**没有**出现在盘上/重放里（同一条判据在 `test/process-level.test.js` 里逐字钉着） |

⚠️ **还欠一个"像素级"读数**：浮窗默认是**收起态**，而 Flutter 画布里的手势**送不进去**
（本仓库早就记过：合成指针事件对 `flt-glass-pane` 无效；只有无障碍语义节点能点）。
语义树里只找得到「展开」「发送」两个节点，点「展开」那一下在这一次没把浮窗打开
⇒ **"展开后的那一屏长什么样"这张图我没拍到**。它由 `test/widget/tool_rows_test.dart`（6 条，含
五档字号下的真实布局）与 `test/widget/accessibility_test.dart`（＋35 实例）在**真渲染树**上兜着；
**屏幕上的那一眼**要等一次真人会话（或者下一个人补一个能点开浮窗的探针）。
