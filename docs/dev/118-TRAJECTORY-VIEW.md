# 118 · 聊天窗口重做（第三批）：**轨迹**那一屏 —— 同一条会话的第二个视图

> **主人 2026-09-26 原话**：*"首先全部开放，聊天窗口的设计也要重做。"*
>
> 这是那一批的**第三刀**（第一刀 [`116`](116-CHAT-OPEN-AND-REDESIGN.md)：工具行 / 系统提示词 /
> 每轮用量 / 过程折叠；第二刀 [`117`](117-QUEUE-VISIBLE.md)：排队看得见、撤得掉）。
> 这一刀做的是 DSH 窗口顶上的**第二个 tab**：把同一条会话**摊成一张表**。
>
> 形状的依据：研究 [`115-DSH-WINDOW-PARITY.md`](115-DSH-WINDOW-PARITY.md) §一.4
> ＋ 原始证据 [`115-raw/B-render.md`](115-raw/B-render.md) §1.5（`dsh-client-ui-trajectory`
> 那一节：列 / 行种类 / 分组 / 顶部时间直方图 / `Duration`·`Turns`·`Calls` 开关 /
> `Search` / `Load earlier history`；以及那条**最要紧的诚实规矩**：
> *"进行中时 Time 保持空白"* —— `timeSeconds: number | null`，`null` 就留白，**绝不编时长**）。
>
> **这一批一个服务端字节都没动**（`v2/services/` 没碰）：轨迹是**同一份**
> `ChatController.items` 的第二个视图。

---

## 〇、一句话

聊天那一屏是**琥珀在说话**；轨迹那一屏是**把这条会话摊开给你看**：
一条记录一行，按 `(seq, tie)` 排、按**记录自己带的轮号**分组，
每一行能点回去（跳回聊天里的那一条）。

🔴 **这一批的灵魂是"不编"**：DSH 那张表上的 `Model` / `Input` / `Duration` / `Search` /
`Load earlier history` 我们**只做收得到的那些**；收不到的一格都不许出现（§六 逐条列出）。

---

## 一、视图切换器：标题行上两个 tab（聊天 / 轨迹）

| # | 规矩 | 为什么 |
|---|---|---|
| 1 | 形状照 DSH：标题行上 `role="tablist"` ＋ 每个视图一个 `role="tab"`（`115-raw/B-render.md` L65：`view.chat`＝`聊天`、`view.trajectory`＝`轨迹`） | 那是主人说的"长得几乎跟 DSH 的窗口一样"里最显眼的一处 |
| 2 | **切换是瞬时的、不重连** | 换的只是浮窗里那一块画什么；那条流住在 `ChatController` 里，一个字节都不动 |
| 3 | 🔴 **切回来时聊天那一屏的滚动位置一点都不能动** | "切过去看一眼再切回来"的命门。做法见 §1.2 |
| 4 | 选择**按设备存**（`ChatViewStore`，键 `hupo_chat_view`，认不出来 ⇒ 聊天） | 照 `process_levels.dart` / `process_level_store.dart` 那一对，**不另造一套** |
| 5 | 当前那一档**也按得动**（空动作），不做成 disabled | 切换器里不该有死键；可访问性那道硬闸也要量到它 |

### 1.1 落点

| 文件 | 是什么 |
|---|---|
| `lib/models/chat_view.dart`（新） | `ChatView{chat, trajectory}`：`wire`（存盘那个 token，**冻结**）＋ `tab`（那两个字）＋ `chatViewOf`（认不出来 ⇒ 默认）。照 `process_levels.dart` |
| `lib/services/chat_view_store.dart`（新） | 按设备存那一个字符串。三条纪律照 `process_level_store.dart`：**坏了一律当默认、读不出来不抛、它按设备不按账号** |
| `lib/widgets/chat_tabs.dart`（新） | 那两颗 `TextButton`（选中那条 0.5px 指示线；命中区 ≥44）。`chatTabKey(view)` 是判据用的 key |
| `lib/widgets/chat_floater.dart`（改） | 标题行多一个可选 `tabs`；标题那行**从"不弹性"改成 `Flexible` + 省略号**（加了 tab 之后窄屏 + 大字号会横向溢出 —— 地方够时位置与大小一字不变） |

### 1.2 切回来为什么滚动位置不动

`chat_screen.dart` 的 `_viewArea` 是**两个 `Offstage`**（不是"换一个孩子"）：

```
Stack(fit: StackFit.expand)
├─ Offstage(offstage: 当前不是聊天, child: 聊天那一块)
└─ Offstage(offstage: 当前不是轨迹, child: 轨迹那一块)   ← 第一次切过去才建
```

* 非当前那一档**留在树里**（只是不画、不接指针、不进无障碍树）⇒
  `ScrollPosition` 与元素都活着 ⇒ 切回来**一个像素都不动**；
* `find.*` 默认**跳过 offstage** ⇒ 两个视图的文案不会互相"撞车"（判据也一样）；
* 轨迹那一档**第一次切过去才建**（`_trajectoryBuilt`）：没看过它的人不该为它每帧算一张表。

---

## 二、轨迹那一屏（一张表）

### 2.1 纯逻辑（`lib/models/trajectory.dart`）

一条记录一行，**来源就是同一份 `ChatController.items`**（聊天那一屏画的是同一份 ⇒
两个视图不会各说各的）。行上的字段：

| 字段 | 从哪来 |
|---|---|
| 轮号 `turn` | **记录自己带的**那个 `turn`（`tool/call` · `system/prompt` · `turn/usage` 有）—— 见 §六·1 |
| 步骤 `step` | 记录自己带的（工具行 / 系统提示词行有） |
| 类别 `kind` | `user` / `assistant` / `tool` / `systemPrompt` / `usage` 五类（`trajectory_words.dart` 给中文词） |
| 摘要 `summary` | 工具行 = **名字 · 人话标题**（**就是 `116` 那一行上的同一份数据**）；消息 / 系统提示词 = 正文的**第一个非空行**；用量 = 折得出才有数，折不出只说一句实话 |
| 时刻 `at` | 服务端 `Timeline.emit` 统一盖的那个 `at`（**这一批新存进 `TimelineItem`**）；没带 ⇒ `null` ⇒ **那一格空着** |
| `turnHead` | 它是不是**这一轮的第一行**（视图在它前面画分组头） |
| `inChat` / `needsUnfold` | 这一条在聊天那一屏画不画得出 / 要不要先展开那一轮（§2.3） |

**每轮计数**：直接调 `ChatController.processOfTurn`（= `TurnProcess.fold`）——
工具 / 消息 / subagent 那三样与"互斥"那条规矩**一条都不重写**（`116` 的，见
[`116`](116-CHAT-OPEN-AND-REDESIGN.md) §二）。

**顶栏合计**（`TrajectoryTotals`）：

| 那一格 | 怎么算 |
|---|---|
| 轮数 | 这一窗里**出现过的轮号个数** |
| 步骤 | 🔴 **恒 `null`**（拿不到 —— §六·4）⇒ 视图**不画它** |
| token | 逐轮走 `foldTurnUsage`，**每一轮都折得出**才加起来；**有一轮折不出 ⇒ 整块 `null`** |
| `complete` | 更早的到底加载完没有 —— 两条真信号：手上最老那一号是 `1`，或者服务端说过没有更早的**且**不是"本机留的页数到顶"（`olderExhausted && !olderCapped`）。**其余一律不说"全部"** |

### 2.2 画在哪（`lib/widgets/trajectory_view.dart`）

顶栏合计 ＋（就地那句实话）＋ 一轮一组（分组头：轮号 ＋ **`116` 的计数**）＋ 一行行 ＋ 尾句
（"到最早那一条了" / "更早的还没有加载完"）。一行 = 一整颗 `TextButton`（命中区 ≥44）：
类别小格 ＋ 摘要（`Expanded` + 省略号）＋ 时刻（`Flexible`）。
空会话 ⇒ **一句实话**（不编行、也不画合计）。
数值只用 `models/dsh_design.dart` 的 token（0.5px 描边 / 标签色阶 / 字号轴 / 内容列宽
`dshContentWidth`，并**夹到真的那么宽**——它下限是 680，比浮窗宽时照抄就是溢出）。

### 2.3 点一行 ⇒ 跳回聊天里那一条

| 情形 | 做什么 |
|---|---|
| 这一条在聊天里**没有单独的一格**（同一轮里不是最后一条的 `turn/usage`） | 就地**如实说**"这一条在聊天里没有单独一行，过不去" —— **留在原地，不乱滚** |
| 它是一条**被折起来的**工具行 | **先把那一轮展开**（他要看的是那一条，不是折叠控件），再切回聊天、滚过去 |
| 其余 | 切回聊天 ＋ 滚到它 |

滚的做法（`_scrollToItem`）：目标已经在树里 ⇒ `Scrollable.ensureVisible`；
不在（列表是懒加载的）⇒ 拿"这一帧真建出来的那一段"当尺子，在 `[0, maxScrollExtent]`
上**二分**找偏移（一步一帧，最多 16 步）—— 到不了就**说一句**（`trajectoryJumpFailedLine`），
**不假装到了**。

---

## 三、判据

| 文件 | 条数 | 钉什么 |
|---|---|---|
| `test/unit/trajectory_test.dart`（新） | 31 | 排序（`(seq, tie)`，含 tie）· 分组（分组头只在每轮第一行） · 摘要（用户/助手第一行 · 工具名 · 标题 · 空 ⇒ 兜底）· **计数复用 `TurnProcess`**（还核"只问真出现过的轮"）· 空会话 · 合计 token（每轮都折得出才加；**有一轮折不出 ⇒ 整块 null**）· 能不能跳（`inChat` / `needsUnfold`）· 时刻（没带就是 `null`）· **坏数据绝不抛** · **没有钱/百分比/模型名/时长** |
| `test/unit/chat_view_test.dart`（新） | 8 | 两档的 token 与字 · 认不出来 ⇒ 默认 · 存的读的（坏值/别的类型 ⇒ 默认，不抛） |
| `test/widget/trajectory_view_test.dart`（新） | 6 | 两个 tab 真的在标题行上、点了真的换 · 一轮的记录**真的摊成一行行**（类别/摘要/轮号/合计/时刻）· 空会话一句实话 · 🔴 **切回来滚动位置一点没动** · 点一行 ⇒ 回去并展开 · **没有那一格 ⇒ 如实说** |
| `test/widget/accessibility_test.dart`（加） | ＋20 实例 | 五档不溢出（轨迹·有内容 / 空会话）＋ 那条表的行与两个 tab 的**命中区 ≥44** |
| `test/unit/forbidden_words_test.dart`（加名单） | — | 轨迹那几句干净的文案进禁用词扫描（**类别词刻意不进** —— §六·6） |

**负向对照**（每条判据都能反着验）：排序乱序输入 · 分组头不落在消息上 ·
空摘要不许是空白 · 用量没结清时**不许出现任何数字** · 有一轮没账时合计必须是 `null` ·
非最后一条用量 `inChat=false` · 坏值不抛 · 不出现 `%`/钱/模型名。

---

## 四、读数（**跑出来的**）

| 闸 | 命令 | 读数 |
|---|---|---|
| 客户端·编译 | `cd v2/apps/mobile && ~/sdk/flutter/bin/flutter analyze` | **No issues found!** |
| 客户端·单元（硬闸） | `~/sdk/flutter/bin/flutter test test/unit` | **669 过 / 0 挂**（基线 630 ⇒ 我这一刀 **＋39**：`trajectory_test` 31 ＋ `chat_view_test` 8） |
| 客户端·可访问性（硬闸） | `~/sdk/flutter/bin/flutter test test/widget/accessibility_test.dart` | **351 过 / 0 挂**（基线 331 ⇒ ＋20 实例） |
| 客户端·界面全量 | `~/sdk/flutter/bin/flutter test test/widget` | **642 过 / 0 挂**（＋26：新 `trajectory_view_test` 6 ＋ a11y 20） |
| 文档闸 | `cd /home/deploy/proj/hupo && node scripts/check-docs.mjs` | ✅（118 出生即进 RATCHET；INDEX 加一行指针，零数值） |

⚠️ **一处踩到的（改的是真判据，如实记）**：a11y 那条"轨迹那两个 tab"的扫描一开始在
**1.3 倍**下红了一个 `IconButton`（量出来 `Size(48, 11)`）—— 那不是这一批的布局坏了，
而是**测试夹具没先把时间线拉回最上面**：刚滚出视口那一格的语义矩形是**被裁过的**，
读数随滚动位置变（老的那几条扫描都用 `_toTop` 挡这件事）。修法是照老规矩
`await _toTop(tester)`，并把这条写进注释。

⚠️ **顺手收的一处重复**（不改行为）：`DshType → TextStyle` 那一小层原来在
`widgets/tool_row_view.dart` 里是私有的，轨迹表与那两个 tab 也要用 ⇒ 抽进
`widgets/dsh_look.dart`（`tool_row_view` 留两个短别名，行为一字未改，
`116` 那 6 条 widget 判据照绿）。`tool_row_words.dart` 里 `turnUsageLine` 拆出
`turnUsageBucketsLine`（**抬头由调用方给**）：合计那一行与每一轮那一行列的是**同一批桶**
（各写一份 = 两个真相），`turnUsageLine` 的输出**逐字未变**。

---

## 五、明确不做的（**现在就说清，不留"以后"**）

| # | 不做 | 为什么 |
|---|---|---|
| 1 | **顶部时间直方图**（DSH 的 Model / Tools 两条轨道、hover 500ms、滚轮缩放、拖选） | 它画的是**真实开始时间与时长** —— 我们**一条记录都不带耗时**（§六·3）。画一个没有时间轴的时间图就是编 |
| 2 | `Duration` / `Turns` / `Calls` 三个开关 | 同上：没有时长可切，"轮/调用"的展开收起是纯交互糖，这一批不做 |
| 3 | `Search` 框 | 这一批只做"摊开"；搜索是另一个动作（要另立判据） |
| 4 | **`Load earlier history`** | 往前翻那件事**在聊天那一屏**（`older_*` 那一套：滚动触发 + 翻页锚点）。这一屏只**如实说**"更早的还没有加载完"，不另开一条翻页路 |
| 5 | 右栏 / 文件预览 / 逐条展开的 Inspector（DSH 那 14 个 tab） | `115` §六 丙-6 是**下一批** |
| 6 | 编辑 / 删除 / 发送 | 🔴 这一屏**只读**：每一行只有"跳到聊天里那一条"这一个动作 |

---

## 六、🔴 我们**没有收到**、所以**一格都不许出现**的（这一批最要紧的一节）

| # | 没有的东西 | 事实（不是猜） |
|---|---|---|
| 1 | **消息属于第几轮** | `user/echo` 与 `message/*` **都不带 `turn`**（服务端 `say.js` / `message-writer.js` 逐字如此）⇒ 客户端**算不出**。按"第几个用户发言 = 第几轮"去数是**拿猜的数上屏**。⇒ 那几行的轮号那一格**空着**；分组头只出现在**记录自己带轮号**的那些行上 |
| 2 | **模型名** | 任何一条记录里都没有它（`turn/usage` 上也没有）⇒ 那一列**不存在** |
| 3 | **时长 / 开始时间 / 首 token 延迟** | 服务端**一条记录都不带耗时**（DSH 的 `timeSeconds` 是 `null` 就留白；我们连那个字段都没有）⇒ **没有时长格**，也就没有直方图 |
| 4 | **"这一轮一共几步"** | `step/*` 是**瞬态**、一个字节都不落盘（决策 P-g）；工具行上那个 `step` 号只能证明"这一步有工具调用"，证明不了整轮几步 ⇒ `TrajectoryTotals.steps` **恒 `null`**，视图不画 |
| 5 | **钱 / 缓存命中百分比** | DSH 全树只有 token；命中率是拿两个桶算出来的 —— **我们不算**。合计那一行只用**同一批 token 桶**（`turnUsageBucketsLine`） |
| 6 | 类别词里的 `工具` / `系统提示词` | 它们**就是** `forbidden_words.dart` 里的词。主人 2026-09-26 已在聊天窗口内放开（`D1.1·补`），而**词表这一批一个字都不许改** ⇒ 与 `tool_row_words.dart` 同一处境：那几个词**故意没进**禁用词那道"必须干净"的清单，其余几句进了 |
| 7 | **日期**（时刻只有 `HH:mm:ss`） | 服务端给的是 epoch 毫秒，我们按**本机时区**画到秒；跨天的会话看不出是哪天 —— 这是**有意**的（那一格窄，它只用来看先后）。要改就一起改这一条 |
| 8 | 分隔线（`timeline/marker`）与系统通知（`notice`）**不成行** | 它们**不是那五类记录**：前者是一条装饰性的线、后者是"它替你做的决定"。这一批**有意**不把它们摊进这张表（不是漏了） |

⚠️ **顺带如实说**：轨迹那一屏**没有**"更早的还没加载完"之外的进度提示；
`at` 缺失（本地乐观发言还没被认领）时那一格**空着**，绝不拿设备时钟补一个。

---

## 七、真机与部署

🚧 **这一批没有部署、没有真机读数**（派活单点名：不部署、不重启、不推；父 agent 做）。
客户端改了 ⇒ 要 `scripts/deploy-web-v2.sh`。屏幕上的那一眼（浮窗展开 + 点一下 tab）
仍受与 `116`/`117` 同一条限制：Flutter 画布里的合成手势送不进去，
所以它由 `test/widget/trajectory_view_test.dart`（6 条，真渲染树）与
`test/widget/accessibility_test.dart`（＋20 实例，五档）兜着。

---

## 附：**"屏幕那一张图"到底怎么才能拍到**（三次尝试的负结果，2026-09-26 记）

批 1/2/3 都欠同一张图（浮窗展开后的那一屏）。这一轮把能试的都试了，**都没成**，记下来免得下一个人重走：

| # | 办法 | 结果 |
|---|---|---|
| 1 | 打开无障碍语义树后，对 `aria-label` 含「展开」的 `flt-semantics` 调 `el.click()` | 报"点了"，**屏幕逐像素不变**（两张 PNG 同 sha） |
| 2 | `--click-at 578,453`（真 CDP 鼠标事件，打在手抓那条杠上） | 截图仍是收起态 |
| 3 | 对同一个节点补 `pointerdown/pointerup/mousedown/mouseup/click` 一整串 | 语义树里**仍然只有「展开」「发送」两个节点** ⇒ 没有展开 |

⇒ **结论**：Flutter web 画布**只收滚轮**（本仓库早就记过：`flt-glass-pane` 上派 `WheelEvent` 有效、指针无效）。
要拿到那张图，只有两条路：**（甲）**给客户端加一个"启动时展开"的调试开关（要改产品代码，得主人点头）；
**（乙）**在探针里用 CDP 的 `Input.dispatchKeyEvent`/`Input.dispatchTouchEvent` 走真浏览器输入（本仓库的
`check-web-browser.mjs` 今天只封装了 `--eval` 与 `--click-at`，要扩）。
⚠️ 在那之前，这一屏的渲染继续由 **widget 判据**（真渲染树、五档字号）兜着 —— 那不是"看过一眼"，**不许当成看过**。
