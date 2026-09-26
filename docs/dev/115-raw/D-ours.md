# D-ours · 琥珀/hupo **我们自己的聊天窗口** —— 精确清单

> 用途：拿这一份与 DSH 浏览器窗口逐项对照。
> 方法：**只读**遍历仓库 `/home/deploy/proj/hupo`（HEAD `e9eb590`，手册最新 v1.85 / 2026-09-26）。
> 未运行任何东西，未修改任何文件。所有标识符、字符串、中文术语**逐字引用**自源码与文档。
> 客户端入口：`v2/apps/mobile/lib/screens/chat_screen.dart`（1791 行）。

---

## 1. 聊天窗口的布局

### 1.1 树与两层 `Stack`

`_ChatScreenState.build()`（`screens/chat_screen.dart:388-596`）返回：

```
PopScope(onPopInvokedWithResult: (_, _) => c.dismissNotice())     // 596 行之后
└── Stack                                    ← 外层：① sheet ② 通知浮窗
    ├── Scaffold(backgroundColor: d.paper)   ← "sheet"
    │   └── Stack                            ← 内层：4 层（按 children 顺序 = 由下到上）
    │       ├── Positioned.fill  AppDesktop                ① 桌面（整页底图）
    │       ├── Positioned.fill  MiniAppHost               ①.5 小程序容器
    │       ├── Positioned(top:0,left:0,right:0) SafeArea(bottom:false) PlanStrip   ①.8 计划条
    │       └── Positioned(left/right/bottom = FloaterMetrics.margin) ChatFloater    ② 聊天浮窗
    └── if (notice != null) Positioned(top:0,left:0,right:0) NoticeOverlay
```

- **桌面是整页 `Positioned.fill`**（不是"下面那一条"）。主人 2026-09-22 更正过一次，代价是整套布局返工，原话与教训在 `widgets/app_desktop.dart:1-23` 与 `docs/dev/52-DESKTOP.md:16-22`。
- **浮窗贴底、四边 30**：`FloaterMetrics.margin = 30`（`widgets/chat_floater.dart:56`）。可用高度 = `mq.size.height - mq.padding.top - FloaterMetrics.margin * 2`（`chat_screen.dart:411`）。
- ⚠️ **不用 `Column`**：通知浮窗与主界面是 `Stack` 的两层，"否则新增通知会把下面整块内容往下推"（D4.8：高度变化 = 0px）—— 注释在 `chat_screen.dart:399-409`，闸在 `test/widget/notice_overlay_test.dart`。
- ⚠️ `Positioned` 必须是 `Stack` 的**直接孩子**；浮窗可用高度从 `MediaQuery` 算，**不在 `Positioned` 里套 `LayoutBuilder`**（`chat_screen.dart:407-409`）。
- 浮窗**不给 `height`**：收起档高度**由内容算**（D3.5，`chat_floater.dart:204-217`）。

### 1.2 z 序规则（手册 `08-SPEC.md` §6.1，`chat_screen.dart` 逐条对上）

| # | 铁律 | 代码落点 |
|---|---|---|
| **Z1** | 聊天浮窗**永远**在 z 序最上，任何页面（含小程序）都盖不住它 | 浮窗是内层 `Stack` 最后一项 ⇒ 最后绘制 |
| **Z2** | 被盖住的小程序**不销毁、不重建、不 reload** | `MiniAppHost` 一直在树上（`mini_app_host.dart:139-141` 只在"没开 **且** 收回动画播完"时返回 `SizedBox.shrink()`） |
| **Z3** | **盖住不是铺满**：四边永远留边距 | `FloaterMetrics.margin = 30` |
| **Z4** | **桌面铺满整屏**；浮窗贴屏幕底部浮着，四边同一个边距 | `Positioned.fill` + `Positioned(bottom: 30)` |
| **Z5** | 桌面底图是装饰：不许接输入 / 不许说话 / 不许改排布 | 现在桌面直接是 `AppDesktop`（水面背景 2026-09-23 已删） |

**实际 z 序（由下到上）**：桌面 → 小程序容器 → 计划条 → 聊天浮窗 → 通知浮窗。
**例外/边界**：`PlanStrip` 内部是 `IgnorePointer`（`plan_strip.dart:44`）⇒ 点它**穿透到桌面**，"点桌面空白 = 收起聊天"在那块**照样有效**（不是死区）。
**"点浮窗自己不许漏到下面"** 靠 `Listener(behavior: HitTestBehavior.opaque)`（`chat_floater.dart:327-333`）——注释点名 `deferToChild` 挡不住。

### 1.3 聊天浮窗内部

`ChatFloater`（`widgets/chat_floater.dart`）：

```
ConstrainedBox(maxHeight: maxH)                       // maxH ≥ dragFloor(56)
└── SizedBox(height: h)                               // collapsed ⇒ h = null（内容算）
    └── DecoratedBox(BoxShadow: d.ink α0.45, blur 32, offset(0,-6))
        └── ClipRRect(radius: d.radiusCard = 18)
            └── Listener(opaque)                       // 只挡指针，不接手势
                └── Material(color: d.card)
                    └── Column(mainAxisSize: collapsed ? min : max)
                        ├── Listener(onPointerDown/Move/Up)   // 手势**只绑抓手这一行**
                        │   └── Padding(top:2) → _handle(collapsed)
                        ├── if (!collapsed)  标题行：Text('助手', titleMedium) + Spacer
                        │                   + Flexible(SingleChildScrollView(horizontal, reverse:true,
                        │                        child: Row(trailing)))    // 回收站/导出/过程
                        │                   + IconButton(Icons.keyboard_arrow_down, tooltip:'收起')
                        │   + Divider(height:1, d.line) + Expanded(child) + composer
                        └── if (collapsed)  只画 composer        // 时间线**根本不建**
```

- **抓手**（主人 2026-09-24 原话见 `docs/dev/75-CHAT-ROW.md:3-6`）：`TextButton(key: chatHandleKey)`，`minimumSize: Size(96,44)`，图形 = `CustomPaint(size: Size(26,7), _FlatChevron)` + 一条 `44×4` 圆角杠；**单击 = 收起 ⇄ 展开**（`_lastOpen`），**双击那套已拿掉**；竖向拖 = 跟手改高。tooltip/无障碍名 `'展开'` / `'收起'`（`chat_floater.dart:440-481`）。
- **三档**：`FloaterTier { collapsed, half, full }`；`halfRatio = 0.55`、`dragFloor = 56`、`snapSlack = 40`、`flingVelocity = 700`、`flingDistance = 60`、`flingMaxMs = 300`、`debounceMs = 400`（`chat_floater.dart:36-79`）。
- **触发规则**：用户按发送 → `maximize()`（`chat_screen.dart:1274-1278`）；只有状态变化 → **不动**（D4.8）；点桌面空白 → `collapse()`；点收起态输入框 → `expand()`（同一条路）。
- **收起档 = 抓手行 + 输入条**；**展开态才有**标题行与时间线。上下两态用**同一个 `Composer` 实例**（`chat_screen.dart:1186-1189`；否则"打了一半再展开"会丢字）。

### 1.4 聊天区（`_sheetBody`，`chat_screen.dart:1190-1239`）

`Column(key: chatBodyKey)`：
1. `_StatusStrip(state: c.conn, error: c.lastError)` —— 顶部状态条，**只在"需要用户知道点什么"时出现**，正常时 `SizedBox.shrink()`；
2. `Expanded(Center(ConstrainedBox(maxWidth: 760, Stack[ _body(c), if (_userScrolledAway) Positioned(right:8,bottom:8, FilledButton.tonalIcon('回到最新')) ])))`；
3. `if (_selecting) BubbleSelectBar(...)`；
4. `SizedBox(height: MediaQuery.viewInsetsOf(context).bottom)`（键盘让位）。

`_body(c)`（`chat_screen.dart:1313-1359`）：空且无过程 → `_EmptyState`；否则 `NotificationListener<ScrollNotification>` 包 `ListView.builder(controller: _scroll, padding: EdgeInsets.symmetric(horizontal: 8, vertical: 8), itemCount: header + items.length + (hasProcess?1:0))`：
- `i == 0 && header == 1` ⇒ "更早的"那一行（当**列表第一项**，放外面会压小视口）；
- 中间 ⇒ `_render(item, c)`；
- 末尾 ⇒ `ProcessTail(level: c.level, busyText: c.agentLine, steps: c.steps)`（**算在列表里，会跟着滚**）。

**始终可见**：桌面（底图）、浮窗抓手行、输入条（两档都在）、计划条（有计划且未全做完时）。
**覆盖层/浮层（不进布局）**：`NoticeOverlay`（外层 `Stack` 最上）、`JobAskSheet`（`showModalBottomSheet`）、`BubbleMenu`、`TrashPlanSheet`、`ProcessLevelMenu`、`_RenameDialog`、`AlertDialog`（删小程序二次确认）、桌面图标的 `_TopPanel`（`showGeneralDialog`）、`SnackBar`（`_say`）。
**面板/容器**：`MiniAppHost`（全屏，被浮窗盖住时压暗 `0.55` + 缩 `0.98` + 圆角 16，并加一层吸收点击的 `Listener`，`mini_app_host.dart:154-311`）。

### 1.5 数值（都住代码；`docs/handbook/08-SPEC.md` §十.1 是同一份数的表）

| 项 | 值 | 出处 |
|---|---|---|
| 浮窗四边 margin | `30` | `chat_floater.dart:56` |
| 半开比例 | `0.55` | `chat_floater.dart:59` |
| 浮窗阴影 | blur `32` · α `0.45` · offset `(0,-6)` | `chat_floater.dart:314-323` |
| 圆角 | `radiusCard = 18` · `radiusField = 12` · `radiusChip = 10` | `models/design.dart:64,97,98` |
| 间距 | `gapXs 4` · `gapS 8` · `gapM 16` · `gapL 24` | `design.dart:106-110` |
| 内容列限宽 | 气泡/状态条 `760`；用户气泡 `maxWidth: 520` | `chat_screen.dart:1200,1244`；`bubbles.dart:94,287` |
| 发送钮 | 固定 `48×48` | `composer.dart:422-424` |
| 抓手命中区 | `96×44`（图形 26×7） | `chat_floater.dart:446,454` |
| 桌面图标格 | `desktopIconBox = 64`，列宽 `clamp(64+10, 96)` | `app_desktop.dart:94-101` |
| 小程序动效 | `motionAppOpen = 500ms` + `FarFastCurve(k=4.5)` | `design.dart:133`；`widgets/motion.dart` |
| 色 | `paper #F8F5EE` · `accent #C8452F` · `ink #2B2320` · `muted #7A6E66` · `card #FFFDF9` · `line #E8E0D4` · `accentTint #F7E4DF` · `selectWash 0x2EC8452F` | `design.dart:25-51` |

---

## 2. 窗口能渲染的**全部**东西

### 2.1 时间线上的一行（`TimelineItem`，`models/timeline.dart:19-192`）

| 渲染物 | 长什么样 | 数据字段 | 动作 |
|---|---|---|---|
| **用户气泡** `UserBubble`（`bubbles.dart:52-151`） | 右对齐、`primaryContainer`（失败时 `errorContainer` + 1.5px `error` 边）、圆角 `radiusField`、`maxWidth 520`；**四态各配图标+文字**：`queued` `Icons.schedule`「已交出去」· `sent` `Icons.check`「已送到」· `confirmed` `Icons.done_all`「已收到」· `failed` `Icons.error_outline`「没发出去」 | `UserUtterance{messageId, text, state, seq, tie}` | 失败 ⇒ `TextButton('重发')`（命中区 44）→ `ChatController.resend(同一个 messageId)`；长按 → `_onBubbleLongPress`；多选态 `onTap` 切换选中 |
| **助手气泡** `AnswerBubble`（`bubbles.dart:154-363`） | 左对齐、`surfaceContainerHighest`、`maxWidth 760`；正文 = `message.displayText`（**quick + deep 拼在同一气泡**）；正文为空 ⇒ 一行「在处理…」；正文里的图片地址 → `Image.network` + 「图正在过来…」/「这张图取不回来了（那个地址是临时的，多半过期了）。」+「图是那边临时给的，想要就存下来。」；`sources` 非空 ⇒ `sourcesHeadWords`「它查过这些地方」+ 每行 `Icons.open_in_new` + 标题（最多 `sourcesShown = 3` 条，其余用 `sourcesMoreWords(extra)`「还有 N 处」**如实报数**）；`ended && reason == 'completed'` ⇒ `TextButton.icon`「读一遍」/「别念了」；`ended && reason != null && reason != 'completed'` ⇒「（这条没说完）」 | `AssistantMessage{messageId, quick, deep, sources, ended, reason, catchUp, reasoning}` | 长按 → 菜单；出处行 `onOpenSource(url)`（**平台开不了就只当文字**，不画按不动的按钮）；念/停；多选 `onTap` |
| **推理原文** `ReasoningBlock`（`process_view.dart:125-167`） | **不是气泡**：左边一道 3px 竖线 + `surfaceContainerHigh` 底 + 斜体 + 标题 `reasoningLabel`「它心里想的（还没说出口）」；摆在**它自己那条气泡正下方** | `AssistantMessage.reasoning`（只在 `level == reasoning` 时由 `ChatController.reasoningOf` 交出） | 无（纯文本） |
| **分隔线** `MarkerLine`（`bubbles.dart:406-434`） | `Divider` + 中间一句：`away` ⇒ `label ?? '你不在的时候'`；`enter` ⇒ `进入「…」`；`leave` ⇒ `离开「…」`；认不出的 `kind` ⇒ `label ?? ''` | `TimelineMarker{kind, label, catchUp}` | 无 |
| **系统通知那一条** `NoticeLine`（`widgets/notice.dart:31-44` → `NoticeCard`） | `accentTint` 底 + `line` 描边 + `radiusField`；图标 `warning_amber_outlined`（`crash` / `disk-full`）否则 `info_outline`；**`notice.text` 照抄服务端那句话**；`undo.usable` ⇒ `TextButton(undo.label)`；浮窗那份多一句 `noticeNotKeptLine`「这条留不下来，刷新就看不到了」+ `noticeDismissLabel`「知道了」 | `TimelineNotice{notice{kind,text,at,undo{label,action,messageIds},urgent}, seq, catchUp}`；`NoticeKind` = `resumed`/`not-resumed`/`expiring`/`crash`/`failed`/`disk-full`/`unknown`；`NoticeUndoAction` 今天只有 `trash/restore` | 撤销 → `ChatController.undoNotice(from:)`（**浮窗与时间线同一条路**，约束 3） |
| **步骤流水** `ProcessTail` → `_StepLine`（`process_view.dart:33-114`） | 只在 `level == steps \| reasoning`；每步一行：`Icons.check`（done）或 `Icons.more_horiz` + `processWord(state)`；认不出的 state **跳过**；一步都没有 ⇒ 退回 `BusyLine` | `ProcessStep{turn, step, state, done}` | 无 |
| **「它正在做…」** `BusyLine`（`bubbles.dart:448-467`） | `Icons.more_horiz` + 一行 `hintColor` 小字；**静态、不许无限动画**（注释：转圈 + 并发界面测试会互相饿死 CPU） | `ChatController.agentLine` | 无 |
| **更早的消息那一行**（`chat_screen.dart:1291-1311`） | 居中 `labelSmall`/`muted`；四种**各说各的**：`olderLoadingWords`「正在取更早的…」· `olderFailedWords`「刚才没问上，往上再滑一次试试」· `olderCappedWords`「先到这（这台设备只留最近这些）」· `olderEndWords`「到头了」 | controller 的 `olderLoading/olderFailed/olderCapped/olderExhausted` | 无（滚动触发） |
| **空屏** `_EmptyState`（`chat_screen.dart:1697-1738`） | 主对话：`'说点什么'` + 「记一笔账、问一件事、让它去查个东西。\n它会把做过的事说给你听。」；某个小程序那一间：`roomEmptyTitle`「这里还空着」+ `roomEmptyLine(app)`「在「X」里说的话，会记在这儿。」；**可滚**（地方不够时不溢出） | `_roomAppTitle(c)` | 无。**明令禁止**"你好，我能帮你做什么"（§6.6 空态禁令） |
| **回到最新**（`chat_screen.dart:1210-1221`） | `FilledButton.tonalIcon(Icons.arrow_downward)`「回到最新」，只在 `_userScrolledAway` 时出现，`Positioned` ⇒ 不参与布局 | `_userScrolledAway` | `_backToBottom()` |
| **多选底栏** `BubbleSelectBar`（`bubble_select_bar.dart`） | `Wrap`：`bubbleSelectCount(n)`「已选 N 条」+ `TextButton.icon(copy)`「复制」+「取消」 | `count` | 复制（`bubbleBodiesOf` 按 `items` 顺序、一行一条）/ 取消 |

### 2.2 浮窗与容器里的 chrome

| 渲染物 | 内容 | 动作 |
|---|---|---|
| **顶部状态条** `_StatusStrip`（`chat_screen.dart:1661-1683`） | `statusLine(conn, error:)`：`正在连上…` / `网断了，我在等它回来` / `网是通的，只是我还接不上它，在重试` / `登录过期了，重新登录一下` / `这台机器还没设密码` / `你那台刚才没应，我在重试` / `还没连上` + `c.lastError` | 无 |
| **抓手** | 一条杠 + 平的小箭头 | 单击 ⇄ 收起/展开；竖拖改高 |
| **标题行**（展开态） | `'助手'` + 横滚的 `回收站` / `导出` / `过程` + 「收起」 | push `TrashScreen` / `ExportScreen` / `showModalBottomSheet(ProcessLevelMenu)` / `collapse()` |
| **输入条** `Composer`（`composer.dart`） | `[在哪儿说话图标] [TextField（右边里头是 读出来/话筒）] [发送]`；框上方按需出现：**草稿条**（`composeDraftTitle`「你打了一半」+「接着写」/「不用了」）、**一句白话**（如 `hearCantHere`）、**正在听那一行**（`●` + `hearListening`「正在听」/ `hearFinishing`） | 输入框**永不锁**（D5.14，刻意没有 `enabled` 参数）；点框 = 展开；发送 = `maximize()` + 清草稿 + `send(text)`；话筒 = `toggleHearing()`；🔊 = 自动念开关 |
| **在哪儿说话图标** `_scopeBadge`（`chat_screen.dart:724-760`） | `mainScope` ⇒ `Icons.home_outlined` + `chatScopeDesktop`「在桌面上问（全局）」；某个 app ⇒ 它的图标 + `chatScopeInApp(title)`「在「X」里问」；认不出 ⇒ `Icons.forum_outlined` + `chatScopeElsewhere`「在另一处问」 | **只是指示，不是按钮** |
| **计划条** `PlanStrip`（`plan_strip.dart`） | 屏幕上沿卡片：目标一行（`planGoalLabel` + `planPhaseWords[phase]` + `goals`；无目标 ⇒ `planTodoOnlyLabel`）+ 最多 `Plan.shownTodos = 3` 件（在做的那件排最前；`Icons.check_box_outlined` / `radio_button_checked` / `check_box_outline_blank`）+ `planMoreWords(hidden)` **如实报数**；**`p == null \|\| p.allDone` ⇒ 一个像素都不画**；完成的条目**不画删除线**（主人把它读成"删掉了"） | 无（`IgnorePointer`） |
| **小程序容器** `MiniAppHost` | 容器自己的顶栏（`IconButton(Icons.arrow_back, tooltip: miniAppBack「返回」)` + `title`），内容跑在**容器自己的 `Navigator`** 里；打开 = 从图标矩形 `Rect.lerp` 扩开，前半程画"长大中的图标"（`miniAppIconShare`） | 返回（app 内还能退就退，退到底 ⇒ `onClose` → `_openApp = null` + `setScope(mainScope)`）；被盖住时点可见区 = `collapse()` |
| **小程序那一帧** `MiniAppFrame` | 一条 `entryUrl` = 一帧；Web 侧是**另一个原点的 iframe**（N1）；`viewId = miniViewIdOf(entryUrl)`；换版 ⇒ 换 iframe，旧帧 `unhost` + `releaseMiniAppView` | 那条唯一的回话通道 `onAsk(prompt)` → `POST /api/app-ask`（**花的是看的人自己的钥匙**，壳不判） |
| **内置三屏** | `SettingsScreen`（退出登录/注销/换钥匙/四栏 creds/试画一张）、`DiscoverScreen`（只读）、`HarnessPane` | 见 §2.3/2.4 |
| **桌面与图标** `AppDesktop` | 纸底 + `Wrap` 图标（4 列）+ `desktopHint`「点一下图标，就打开它。」；图标格 64×64 + 名字（`bodyMedium`，最多两行）；`badge > 0` ⇒ 一个 10×10 圆点；**按住 / 右键** ⇒ `DesktopIconMenu` | 点图标 = `onOpen(rect)`；点空白 = `onTapBlank()` → `collapse()`；面板 = 改个名字 / 复制一个 / 从桌面上删掉 / 取消 |
| **桌面上的格子** | `设置`（`builtInSettingsId`，`Icons.settings_outlined`）· `发现`（`builtInDiscoverId`，`Icons.travel_explore_outlined`）· `我自己那台`（`builtInHarnessId`，`Icons.computer_outlined`）· `for (final a in _myApps)` 我的小程序（`miniAppIconFor(a.icon)`） | 内置三格**不给**改名/复制/删（传 `null`，服务端认不出它们）；只有"我的小程序"才给面板 |
| **图片** | 回答里认得出图片地址 ⇒ `Image.network(fit: contain)`；配置页 `ImageTry`（提示词框 + 「画一张」+ 有边界的图 + `imageTempLink`） | 无（只显示） |
| **SnackBar** `_say(line)` | 复制/删除/改名/复制小程序/撤销/401 等**如实说一句** | 无 |

### 2.3 「我自己那台」`HarnessPane`（`widgets/harness_pane.dart`）—— **原始流，不做包装**

- 顶部**看板那句**（滚不走）：`devBoardNotHupo`「在这儿说话的不是琥珀。」+ `devBoardWhyNot`「干的活、记的事都是琥珀那一份；说话的规矩和口气是这台机器自带的。」
- 中间 `ListView.builder`：一行 = `SelectableText(line.text, monospace)` +（可选）`detail`（一小段 JSON）。
- 底部：次要入口那一句 + 可选的「在浏览器里打开」（`devEntryViewOf` 说没按钮就**一个字都不画按钮**）；`Divider`；`_composer`：等宽 `TextField(enabled: ready)` + `harnessRestart`「重来」或 `harnessStop`「停」+ `IconButton(Icons.send)`。
- 状态行也算滚动区里的行：`booting` ⇒ `harnessOpening`「正在打开…」；`gone` ⇒ `harnessGoneLine`「它这边停下了。」+ `harnessWhyPrefix`「它说：」+`why`。
- **发出去的只有两帧**：`harnessSayFrame(text)` = `{"t":"say","text":…}`；`harnessStopFrame` = `{"t":"stop"}`。**收回来两种**：`{"t":"state","s":"booting"|"ready"|"gone","why"?}` 与 `{"t":"raw","m":<DSH stdout 原样>}`（`models/harness.dart:27-101`）。
- **它认识的 DSH `session.event` 类型**（`harness.dart:214-255`，照 DSH 自己的 `SessionEventMap` 抄的）：`turn/start` · `step/start` · `step/end` · `turn/end` · `user/message` · `assistant/message` · `system/message` · `request/header` · `request/context` · `session/title` · `permission/preset` · `sandbox/mode` · `approval/policy` · `agent/inbox/spliced`；另有 `session.status{running|idle}`。`assistant/message` 里 `content[]` 的 `text` / `reasoning` 两种块显示文本，**别的块不藏**，画成「块类型 + 一小段 JSON」。
- 🔴 **未知一律不藏**（判据 H8）：`HarnessLineKind.unknown` ⇒ 「类型 + 一小段 JSON」（`harnessSnippet`，最长 `harnessSnippetMax = 400` 个 rune）。
- ⚠️ `request/header` 的摘要**只报件数，不抄名字**（`harnessHeaderLine`：「它这一轮手上能用的：N 样」）——那一串就是工具名。

### 2.4 其它屏（从聊天窗口进的出口，不属于浮窗本体）

`TrashScreen`（回收站：列表 + 恢复 + 彻底删二次确认，`purgeAt` 由服务端算）、`ExportScreen`（`SelectableText` 成品 + 一键复制，**不做文件下载**）、`DiscoverScreen`（只读；`discoverEmpty`「现在还没有别人发出来的小程序。」）、`SettingsScreen`（退出登录/注销/换钥匙/四类 creds/试画一张）、`AboutScreen`。

---

## 3. 信息处理规则

### 3.1 一条时间线，客户端是哑的

`models/timeline.dart:1-12`：**一条时间线**，按 `(seq, tie)` 排序；**不做配对**（协议 R1）；本地发言走**乐观态**。
- 排序键是 `(seq, tie)`，**不许用时间戳**（客户端钟 vs 服务端钟混钟会乱，`timeline.dart:28-30`）。
- 本地乐观发言借 `_lastSeq`、`tie = 1` ⇒ 排在"已收到的最后一条"之后、"下一条服务端事件"之前（`timeline.dart:508-515`）。
- `user/echo` **认领**本地那条（同一个 `messageId`），**不是再插一条**；已认领过的**不再改它排在哪**（否则从回收站拿回来时用户那句会跳到它自己回答后面，`timeline.dart:632-662`）。
- `TurnGroup` 只回答一个很窄的问题：**长按某一条时该把哪几个 id 交给服务端**（`turnGroupsOf`：只有 `confirmed` 的用户发言才算一轮的头；回答**先到先配**，与服务端 `#turnOwner` 同一条规矩）。**配不上也各自成组**。

### 3.2 去重与流式

- **按 `seq` 去重**：`if (!_seenSeq.add(rawSeq)) return;`（`timeline.dart:546`）。
- **按 `(messageId, block, seqInBlock)` 二次去重**（`AssistantMessage.addChunk`，`timeline.dart:112-142`）：因为"从回收站拿回来"会把同一段正文**按原样重新追加**（新 `seq`），`_seenSeq` 挡不住。`seqInBlock` 认不出来 ⇒ **当新的一段拼上去**（"吞掉一段正文是屏幕少了字，没人看得出来"）。
- **快答 + 深答在同一个气泡**：`block` 只认 `'deep'`，其余当 `'quick'`；`displayText` 中间不加连接词，快答没以 `[。！？!?；;：:…\n]` 结尾时补一个空格。
- **`sources` 以 `message/end` 上那份为权威**（协议 R8，覆盖 `start` 上带的）。
- **流式落盘去抖**：`message/text` 每 `textSaveEvery = 8` 条写一次；一轮开始/收口/`user/echo`/分隔线**立刻写**（`chat_controller.dart:1311-1361`）。

### 3.3 瞬态 vs 持久（决策 P-g）

- **没有 `seq` 的事件 = 瞬态**：`_applyTransient`，**只改已有条目的状态，绝不新增条目**（`timeline.dart:537-543,664-693`）。
- 瞬态清单：`message/status` · `step/*` · `reasoning/delta` · `error` · `notice/urgent`。
- `notice/urgent` 那一支**故意什么都不做**，注释写明"不是漏了"——它只在浮窗里喊一声。

### 3.4 过程四档（D7，`models/process_levels.dart`）

| 档 | `wire`（协议 token，冻结） | 标题 | 提示 | 屏幕上有什么 |
|---|---|---|---|---|
| `quiet` | `'quiet'` | 安静 | 只说它要说的话 | **连「它正在做…」也没有**（`ProcessTail` 直接 `SizedBox.shrink()`；`ChatController.agentLine` 也在这一层掐掉） |
| `doing`（**默认**） | `'doing'` | 在做什么 | 顺口说一句它正在忙什么 | 一行 `processWord(state)` 或 `busyFallback`「它正在做这件事…」 |
| `steps` | `'steps'` | 步骤流水 | 把做了哪几步一条条摆出来 | `_StepLine` 列表 |
| `reasoning` | `'reasoning'` | 它心里想的 | 连它还没说出口的那些也给你看 | 步骤 **+** 气泡下面的 `ReasoningBlock` |

- 地址上不带 `level` = `doing`（`process_levels.dart:57-61`）；认不出来的 token **一律回默认档，绝不抛**（`:63-73`）。
- `level` 是**连接级**的 ⇒ **换档要重连**（`ChatController.setLevel`，`chat_controller.dart:594-614`）；`setScope`（换房间）**不重连**，只发一帧 `focus`。
- `agentLine` 的三条边界（`timeline.dart:374-394`）：`_agentDead` ⇒ `null`；`_stale`（本机缓存画的那一屏，服务端还没开口）⇒ `null`（"沉默优于编造"）；否则 `processWord(_turnState) ?? (_hasOpenAssistant ? busyFallback : null)`。
- **`reasoning/delta` 只在内存里、挂在气泡上**（`timeline.dart:86-99,749-770`）：一个字节都不许进存储；一轮收口**不清它**；`reset()`（重放/退出登录）**必须清**。服务端侧铁律：**绝不许走 `emit()`**（`session-translate.js:28-40,699-711`，有两条泄露闸）。

### 3.5 一轮（turn）的地址与乱序保护

- `message/status` **按轮寻址**，不按气泡（`turn` 是那个"稳定键"；DSH 的 `session.status` 落在消息生命周期之外，按 `messageId` 根本挂不上——`dispatcher.js:780-805`）。
- `_seenTurn` 挡"旧轮"；`_closedThrough` 挡"收口之后又飘回来的那几帧"；`_isLate(turn) => turn < _seenTurn || turn <= _closedThrough`（`timeline.dart:772-776`）。收口事件里**没有 `turn`**（`message/end`），所以只能按"见到的最大轮号"收（`:789-801`）。
- 步/推理**共用同一个号**（同一处 `_seenTurn`），各记各的一定会漂。
- 每次新轮开始 `_openTurn` 只清**步骤**和"还没挂上去的那段推理"，**不清气泡上的推理**。

### 3.6 轮内四个"消失/保留"规则（`_closeTurn` / `_openTurn` / `reset`）

| 事件 | 步骤流水 | 气泡上的 reasoning | 说明 |
|---|---|---|---|
| `message/end` | **清空** | **保留** | 不许留成"永远在查资料" |
| `error`（瞬态） | **清空** + `_agentDead = true` | **保留** | 它断了 ⇒ 不会再有收尾；不许"永久停在它正在做"（H4） |
| 新轮开始 | **清空** | 保留（上一轮的） | |
| `reset()` | 清空 | **终点**（重放 / 退出登录都走它） | |

### 3.7 隐藏 / 恢复 / 真删（回收站）

- `turn/deleted` / `turn/restored` / `turn/purged` **都取号、落盘**（重启后客户端才知道谁被删过；`timeline.dart:613-625`）。
- 被删的 id 进 `_hiddenIds` —— **藏起来，不销毁**；`items` 只给画得出来的 ⇒ "藏起来"这件事**只有一处**。`_visible()` 对没有 `messageId` 的分隔线**永远画**。
- 删除的单位是**一轮**（`turnMessageIds` 由 `turnGroupsOf` 算）；算不出（如还没发出去那句）⇒ **连长按菜单都不给**。
- 删成功之后**立刻就地藏 + 清本机**，不等 `turn/deleted`（"断线时那一帧永远不会来，那时就是屏幕在说假话"）。
- `_forgetTurn` 三件一起做：藏/丢内存 + `withoutMessages(_facts)` + **立刻写盘** + 重算草稿。

### 3.8 历史分页

- `GET /api/timeline?before=<seq>&limit=<n>&scope=<id>`；一页 `olderPageSize = 50`，本机最多留 `olderMaxPages = 10` 页（`chat_controller.dart:474-476`）。
- 更早那几页**不进 `_facts`、不进本机缓存**（否则缓存裁剪会把刚取回来的又丢掉）。
- 取回来走**同一套** `Timeline` 规则（去重/分组/墓碑/隐藏），按 `seq` 再筛一次。
- **视觉锚点**：滚到顶 `_olderTriggerPx = 32` 触发；取之前记 `maxScrollExtent`，取完把偏移加上"长出来的那一段"；**只有真插进了内容才钉锚点**（`chat_screen.dart:1361-1400`）。
- 四种情形**各说各的**：没问到 ≠ 到头了 ≠ 本机留满了（`_olderLine`）。
- 跟随到底部的判定是纯函数 `scrollFollowAction(pixels, maxScrollExtent, userScrolledAway)`（`models/scroll_follow.dart`）；**只有手指拖出来的滚动**才算"用户自己翻走了"。

### 3.9 本地乐观 vs 服务端权威

- 四态 `MessageState { queued, sent, confirmed, failed }` + `allowedTransitions`（`models/message_state.dart`）：`queued → sent|confirmed|failed`（`confirmed` **必须能从 `queued` 直接到**——回执会比 HTTP 响应先到）；`sent → confirmed|failed`；`confirmed` 是**终态**（**不许退回 `failed`**）；`failed → queued`（只有"重发"能推回去）。不允许的转移**原样返回，不抛**。
- 重发**必须用同一个 `messageId`**（否则服务端当成新的一句，agent 干两遍）。
- `_deliver` 的九种结果各有各的话（`chat_controller.dart:1404-1464`）：`SayOk`/`SayUnauthorized`/`SayNotSetup`/`SayLocked`/`SayBusy`「它现在忙不过来，过一会儿再发一次」/`SayRejected`「没收下：…」/`SayAsk`（C 期反问，**原样用服务端那句**）/`SayNetworkError`「网没通，这条没发出去」。
- **存档只存"已发未被认领"的那几句**（`draft_store.dart`，与 `_facts` 各存各的、不许重叠）；`sent` 存进去时降成 `failed`（刷新后回执不会再来，屏幕上必须有「重发」那条路）。

### 3.10 通知（契约 29-NOTICE）

- `notice`（带号）⇒ **两个落点**：① `timeline.apply` 进列表；② **浮窗**喊一声。`notice/urgent`（无号）⇒ **只在浮窗**。
- **`shouldPopNotice(catchUp, readingHistory)`**：补发的、以及"这条连接还在读首屏那段历史"时的通知**只进时间线、不喊浮窗**（起因是主人报的"每次登录都弹一条很久以前的崩溃通知"，`models/notice.dart:178-196`）。
- 浮窗自己消失：`noticeLinger = Duration(seconds: 6)`，**时长不许写进任何给用户看的话**（契约 §一 第 4 条：不承诺时间）。
- `undo` **fail-closed**：认不出的 `action`、或 id 清单为空 ⇒ **不给入口**。

### 3.11 房间（scope）与「派活」

- `_rooms: Map<String, _Room>`，**一间一份内存**（时间线 + `_facts` + 往上翻的页）。切房间**不重连**，只发 `{"t":"focus","scope":…,"sinceSeq":…}`；客户端**再挡一道** `eventInScope(e, _scope)`（甲房的话不许落进乙房）。
- `reset` 时**只清服务端来的**；用户自己还有没确认的话**原样留着**（"清掉它们等于把用户打好的字弄丢了"）。
- `scope/open`（瞬态）⇒ 界面自己切过去；**客户端不许自己切房间**（两个裁判会切两次）。
- **「接着往下」**：切过去之后那一屏**先看得见他那句原话**，但只是**内存里的视图**（`_carried`），盘上不多一个字。
- `job/ask` ⇒ 出 `JobAskSheet`（「这件事怎么做」+ 服务端那句问话 + `jobAskWhyLine(why)`「你说的是：…」+ 两个按钮 `jobAskHere`「就在这儿做」/ `jobAskNewPlace`「另开一处做」）；**同一笔只弹一次**；他滑掉（`null`）⇒ **什么都不答**。答话只发一帧 `job-answer`，**只认号相同的回执**。
- `app/open` ⇒ 做完自动把那个小程序打开（**只在"正开着那一间"且那个名字真在他清单里**）；那句总结只在浮窗旁边留一句，**不在那一间落第二份**。

### 3.12 缓存与命名空间

- `TimelineStore.isPersistable(event)` 才进 `_facts`/落盘；**墓碑事件自己不许清**（它是"谁被删过"的唯一凭据）。
- 命名空间 = `cacheNamespaceOf(token)`（租户隔离）+ `scopedCacheNamespace(ns, scope)`（**一间一份**）；`levels` **故意不绑**（设备级偏好）。
- `_invalidateLocal()` 一次清五样 + `clearAllNamespaces()`（共用设备：只清自己那份等于没清）。

### 3.13 用词与"重新配音"

- **界面上出现内部词 = 缺陷**（不是文风）。硬表 `models/forbidden_words.dart`：`工作区`/`口令`/`暗号`/`客户端`/`云端`/`服务器`/`调度器`/`时间线`/`作用域`/`会话`/`工具`/`搜索`/`上下文`/`系统提示`/`模型`/`web_search`/`web_fetch`/`tool-fs`/`bash`/`subagent`/`正在听`（只在**真的在录音**时合法，唯一落点是 `hearing_words.dart` 的 `hearListening`）/`第 1 个`/`第 2 个`/`序号`。
- **内部状态名 → 人话**只有一张表（`models/process_words.dart`，单向）：`started` → `busyFallback`「它正在做这件事…」· `searching`「在查资料」· `reading`「在读东西」· `writing`「在写」· `running`「在动手做」· `thinking`「在琢磨」。**认不出来 ⇒ `null` ⇒ 一个像素都不画**（N10：沉默优于编造）。
- 今天的真实生产者：服务端每一轮只发 `state:'started'`（`dispatcher.js:792-805`）；步骤的类别由随后的 `tool/call` 补（`TOOL_STEP_STATE`：`web_search`/`web_fetch`→`searching`；`read`/`glob`/`grep`/`read_image`→`reading`；`write`/`edit`→`writing`；`bash`/`job_*`→`running`；其余→`thinking`），**工具名绝不出去**。
- **服务端给的整句一律照抄、客户端一个字都不重写**：`notice.text`、`notice.undo.label`、`job/ask.text`、`job/answer-ack.text`、`SayAsk.question`、小程序那一屏的失败话（`image_try.dart:10-11`）。
- 助手回答里的**内部词由人格层管**（§12.4 第 6 条），不是客户端能改的。

---

## 4. 我们**实际收到**的线缆词汇

### 4.1 聊天那条流 `/api/stream`（WebSocket；令牌走子协议 `['bearer', token]`）

**服务端 → 客户端：持久事件**（有 `seq`、落盘、重连/切焦点会补发；`models/timeline.dart` + `services/chat_controller.dart` 两个 `switch`）

| `type` | 生产者 | 关键字段 | 客户端落点 |
|---|---|---|---|
| `user/echo` | `say.js:86` | `messageId, text, seq, at` | `timeline.dart:553` `_applyEcho` |
| `message/start` | `message-writer.js:107` | `messageId, sources?, seq, scopeId` | `timeline.dart:555` |
| `message/text` | `message-writer.js:142` | `messageId, block('quick'\|'deep'), seqInBlock, text, seq` | `timeline.dart:568` |
| `message/end` | `message-writer.js:196` | `messageId, reason, sources, seq` | `timeline.dart:580`（+ 自动念 / `_readingHistory` 两个门） |
| `message/handoff` | `message-writer.js:178` | — | ⚠️ **客户端没有这一支** ⇒ 静默忽略 |
| `task/mutated` | `dispatcher.js:496-507` | `ref, turn` | ⚠️ 无处理（静默忽略） |
| `task/resumed` | `resume-plan.js:36`（`serve.js:1152` emit） | `ref, attempt` | ⚠️ 无处理 |
| `timeline/marker` | **今天服务端没有生产者**（只在 `export.js:79` 的排除表与 `timeline.js:6` 的注释里） | `kind('away'\|'enter'\|'leave'), label` | `timeline.dart:596` → `MarkerLine` |
| `notice` | `notice.js:307,347` | `kind, text, at, undo{label,action,messageIds}, seq` | `timeline.dart:609` + 浮窗（Go 条件：`shouldPopNotice`） |
| `turn/deleted` | `trash.js:20` | `messageIds[]` | `timeline.dart:620` `hideMessages` |
| `turn/restored` | `trash.js:21` | `messageIds[]` | `timeline.dart:622` `showMessages` |
| `turn/purged` | `trash.js:22` | `messageIds[]` | `timeline.dart:624` `purgeMessages` |
| `plan/updated` | `plan.js:23` | `goal{text,phase}\|null, todos[{text,now,done}], doneCount, total, more` | `chat_controller.dart:554-561` → `PlanStrip` |
| `app/update-available` | `app-events.js:18`（`generate` 于 `app-events.js:36`） | `id, version, at`（`scopeId` = 那个 app） | `chat_controller.dart:1040-1045` → `_onAppUpdate` |
| `job/start` | `job.js:43` | 派到哪一处 + 为什么 | ⚠️ **客户端没有这一支** ⇒ 静默忽略 |
| `job/report` | `job.js:44` | 人话总结 | ⚠️ 同上（那句总结的家只在主进程那条日志上） |

**服务端 → 客户端：瞬态事件**（没有 `seq`，不落盘、重连不重放）

| `type` | 生产者 | 字段 | 客户端落点 |
|---|---|---|---|
| `message/status` | `dispatcher.js:800` | `turn, state:'started'` | `timeline.dart:667` `_applyStatus`（**按轮**） |
| `step/start` | `session-translate.js:656,690` | `turn, step, state` | `timeline.dart:669` `_applyStepStart`（同 `(turn,step)` **覆盖**） |
| `step/end` | 同上 | `turn, step, reason:'completed'` | `timeline.dart:671` `_applyStepEnd`（**只标完成，不新增**） |
| `reasoning/delta` | `session-translate.js:711` | `turn, text` | `timeline.dart:673` `_applyReasoning` |
| `error` | `process-guard.js:57` · `dispatcher.js:1240`(`kind:'agent-exit'`) · `dispatcher.js:1360`(`kind:'agent-unavailable'`) | `kind, text, detail?` | `timeline.dart:675`：**只用来撤"它正在做"并标 `_agentDead`**；⚠️ `text` **不上屏**（服务端注释自己写着"客户端今天不渲染"，`dispatcher.js:1224`） |
| `notice/urgent` | `notice.js:397` | `kind:'disk-full', text` | `chat_controller.dart:1143` → 只在**浮窗**；`timeline.dart:684` 那一支故意什么都不做 |
| `app/installed` | `worlds.js:748` | `appId, title` | `chat_controller.dart:1006` → `appsRevision += 1` → 重拉 `/api/apps` |
| `app/workspace-changed` | `app-live.js:137`（`worlds.js:1083`） | `id, at`（`scopeId` = 那一间） | `chat_controller.dart:1021` → `appWorkspaceRevision += 1` |
| `scope/open` | `job.js:155` | `scope, at`（**不带 `scopeId`**） | `chat_controller.dart:1060` → `setScope(to)` |
| `job/ask` | `job.js:169` | `id, where, why, text, at` | `models/job_ask.dart:46` → `JobAskSheet` |
| `job/ask-expired` | `job.js:180` | `id, text, at` | `job_ask.dart:66`（**只认号相同**） |
| `job/answer-ack` | `job.js:128` | `id, ok, yes?, error?, text?` | `job_ask.dart:105` |
| `app/open` | `job.js:191` | `app, text, at`（带 `scopeId`） | `job_ask.dart:78` + `chat_controller.dart:1122` |

**服务端 → 客户端：控制帧**（不占号、不上时间线；`services/stream.dart:231-260` 就地消费）

| `type` | 含义 | 客户端动作 |
|---|---|---|
| `client/ping` | 心跳 | `return`（只重置看门狗） |
| `client/hello` | 补发到此为止（`maxSeq`，可选 `focus`） | 内部合成 `{'type':'__caught_up__'}` |
| `client/focus` | 切焦点已生效（`ok`） | 内部合成 `{'type':'__focus_ready__'}` |
| `client/reset` | 你的号跑到我前面了 | 内部合成 `{'type':'__reset__'}` → `timeline.reset()` + 清缓存 |
| `client/reload` | 只在 `index.js` 的 demo 里出现 | 客户端不处理 |

**客户端 → 服务端（同一条流）**：`{"t":"focus","scope":…,"sinceSeq":…}`（`stream.dart:94`）· `{"t":"job-answer","id":…,"yes":…}`（`stream.dart:114`）。认不出的帧**安静忽略**。

### 4.2 另外两条 socket（各自独立，不动 `/api/stream`）

- **语音 `/api/asr`**（`asr.js`）：`asr/ready{engine}` · `asr/partial{text,index}` · `asr/final{text,index}` · `asr/end{text}` · `asr/capped` · `asr/error{reason,message,code?}` · `asr/unavailable{reason}`；上行二进制 = 16k 单声道 PCM，文本帧 `asr/start`/`asr/stop`。
- **「我自己那台」`/api/harness`**：见 §2.3（`state` / `raw`；上行 `say` / `stop`）。
- ⚠️ `ledger/*`（`ledger.js:29-32` 的 `ledger/entry` / `ledger/deleted` / `ledger/restored` / `ledger/purged`）**走另一条独立日志**（`worlds.js:567` 新建 `ledgerTimeline`，`LEDGER_TIMELINE_ID`）⇒ **到不了这个聊天窗口**。

### 4.3 聊天窗口用到的 HTTP 面（`services/api.dart`）

`POST /api/say{messageId,text,clientAt,scope?}` · `GET /api/timeline?before&limit&scope` · `GET /api/health` · `POST /api/renew` · `GET /api/space` · `GET /api/apps` · `POST /api/app-ask` · `POST /api/app-remove` · `POST /api/app-rename` · `POST /api/app-copy` · `POST /api/image` · `POST /api/trash/plan|remove|restore|purge` · `GET /api/trash` · `GET /api/export` · `GET /api/discover` · `POST /api/model-key` · `POST /api/creds` · `POST /api/cancel` · `GET /api/version`。

---

## 5. 我们的窗口**明确不显示 / 不做**的

| 不显示 / 不做 | 依据（原话或注释） |
|---|---|
| **不写"你好，我能帮你做什么"** —— 不许留客式追问 | `08-SPEC.md` §6.6；`chat_screen.dart:1685` 空屏注释 |
| **服务端瞬态 `error` 的 `text` 不上屏** —— 只用来撤"它正在做" | `timeline.dart:675-683`；`dispatcher.js:1224`「下面那条瞬态 `error` 客户端今天**不渲染**」 |
| **`message/handoff` / `task/mutated` / `task/resumed` / `job/start` / `job/report` 都不画** | `Timeline.apply` 的 `default:` 安静忽略（`timeline.dart:626-628`），全仓 grep 无客户端处理 |
| **`ledger/*` 到不了这里** | `worlds.js:567` 独立 `ledgerTimeline` |
| **认不出的 `type` 安静忽略**（向前兼容），**不新增条目** | `timeline.dart:532,626-628` |
| **认不出的 `state` 不上屏**（N10 沉默优于编造） | `process_words.dart:61-62`；`process_view.dart:76-78` |
| **认不出的 `notice.kind` ⇒ 只降级分类，那句话照显示**；**认不出的 `undo.action` ⇒ 按钮不画** | `notice.dart:55-61,66-83,102-106` |
| **`plan/updated` 认不出 / 空 ⇒ 一个像素都不画**；**全做完也收起来**；**完成条目不许画删除线** | `plan.dart:71-72,130-134`；`plan_strip.dart:28-33,109-111` |
| **没有计划就不摆空壳**（§6.6 空态禁令） | 同上 |
| **计划条 / 浮窗里不许出现 `todo_write` / `create_goal` / 工具名** | `64-CHAT-REDESIGN.md:23`；服务端侧 `26-PROCESS-LEVELS.md:180` |
| **工具名 / callId / 原始入参一律不发** | `session-translate.js:44-50`；`harness_words.dart` 的 `harnessHeaderLine`「只报件数，不抄名字」 |
| **开不了的外链只当文字，不画按不动的按钮**；**念不了就不画那个按钮** | `bubbles.dart:178-188`；`services/links.dart` 的 `canOpenLinks` |
| **`request/header` 的摘要不抄工具名** | `harness_words.dart`「🔴 **只报件数，不抄名字**」 |
| **推理原文（第 ④ 档）一个字节都不许进存储** | `timeline.dart:86-99`；`session-translate.js:28-40`（**绝不许走 `emit()`**） |
| **`reasoning/delta` 只有 `level=reasoning` 的连接收得到** | `server.js` 档位闸；`session-translate.js:699-711` |
| **安静档连「它正在做…」也不显示** | `process_levels.dart:17-22`；`ChatController.agentLine` |
| **打字框永远不许锁**（`Composer` 刻意没有 `enabled` 参数） | `composer.dart:24-26`（D5.14） |
| **聊天框那个「粘贴」按钮 2026-09-24 砍了** | `composer.dart:186-195`（理由：手机上系统键盘自带；钥匙那一屏的粘贴留着） |
| **网页上关掉了浏览器自带右键菜单** ⇒ 聊天输入框里**右键粘贴没有了**（`Ctrl+V` 照旧） | `08-SPEC.md` §6.7 第 8 条 + 下面那段 ⚠️ |
| **收起态不画标题行**（"一行"就是那一行） | `75-CHAT-ROW.md:25` |
| **收起态不画时间线**（它**根本不建** —— 免得被压成一条时还在偷偷布局） | `chat_floater.dart:412-420` |
| **点浮窗内部无反应，不许漏到桌面** | `chat_floater.dart:327-333` |
| **被盖住期间不许 pause 逻辑**；点可见区**不把这次点击传给小程序** | `mini_app_host.dart:15-19,303-311` |
| **收起时不许压住小程序里可点的东西**（是内缩，不是简单覆盖） | `mini_app_host.dart:505-508`（`bottomInset`） |
| **拖动时间线不许改窗口高度**（手势只绑抓手/标题行） | `chat_floater.dart:326-333`；`docs/dev/52-DESKTOP.md:86-95` |
| **`turn/deleted` 之后那一轮的内容不许被"翻出来"**（墓碑 + 本机两份一起清） | `chat_controller.dart:1172-1206` |
| **锚点没插进内容就一个像素都不动** | `chat_screen.dart:1394-1399` |
| **没有"假进度"**（只有"到哪一步了"三个状态，没有百分比） | `models/space.dart:11-13` |
| **不许说"3 秒后消失"这类承诺** | `notice_words.dart:26-31`；`chat_controller.dart:325-329` |
| **导出不做文件下载** | `docs/dev/30-EXPORT.md` §一（`export_screen.dart:10-11`） |
| **不设"永不结束"的动画**（会挂死 `pumpAndSettle`；转圈还会互相饿死 CPU） | `08-SPEC.md` §6.1.1；`bubbles.dart:443-446` |
| **小程序自己不许画 `AppBar`**（顶栏由容器给，跑在容器的 `Navigator` 里） | `mini_app_host.dart:23-25` |
| **内置那三格不给改名/复制/删**（服务端认不出它们 ⇒ 摆了就是"看着像有、其实是空的"） | `app_desktop.dart:69-82`；`chat_screen.dart:461-470` |
| **没接上那条路就不摆一个"按不动"的图标** | `chat_screen.dart:426-427`；`app_desktop.dart:18-21` |
| **明说没做的**：Z2「回到可见不许重建」**没有判据** · 甩 / 400ms 防抖**实现了但没判据** · 平板上的样子只在 800×600 与桌面浏览器看过 | `08-SPEC.md` §6.4；`docs/dev/52-DESKTOP.md:183-190` |

---

## 6. 后续工程师必须读的文件 / 行段

**客户端（窗口本体）**
- `v2/apps/mobile/lib/screens/chat_screen.dart` —— **全 1791 行**。重点：`build()` 388-596（布局/z 序）· `_maybeAskJob` 299-320 · `_onChanged` 242-286 · `_appView` 629-686 · `_scopeIcon/_scopeWords/_scopeBadge` 724-760 · `_composer` 1242-1282 · `_body` 1313-1359 · `_olderLine` 1291-1311 · `_render` 1428-1447 · `_answer` 1485-1509 · `_onBubbleLongPress` 1522-1543 · `_copyOne/_copySelected` 1554-1606 · `_deleteTurn` 1623-1651 · `_EmptyState` 1697-1738 · `_StatusStrip` 1661-1683。
- `widgets/chat_floater.dart`（全 523 行）· `widgets/bubbles.dart`（全 468）· `widgets/composer.dart`（全 495）· `widgets/process_view.dart`（全 168）· `widgets/plan_strip.dart`（全 137）· `widgets/notice.dart`（全 194）· `widgets/job_ask_sheet.dart`（全 75）· `widgets/bubble_menu.dart` · `widgets/bubble_select_bar.dart` · `widgets/trash_plan_sheet.dart` · `widgets/process_level_menu.dart` · `widgets/image_try.dart` · `widgets/harness_pane.dart`（全 400）· `widgets/mini_app_host.dart`（全 314）· `widgets/mini_app_frame.dart` · `widgets/app_desktop.dart`（全 468）· `widgets/desktop_icon_menu.dart` · `widgets/motion.dart`。
- `services/chat_controller.dart`（全 1631 行）：`_bindNamespace` 109-115 · `_Room` 1600-1631 · `setLevel` 602-614 · `setScope` 637-668 · `_ensureStream` 912-953 · **`ingest()` 963-1207（唯一入口，逐支）** · `_saveDrafts` 880-885 · `send/_deliver` 1373-1464 · 删除/回收站 1473-1575 · `_maybeSave` 1354-1361。
- `services/stream.dart`（全 367 行；控制帧 231-268、退避 337-350、`focus` 83-98、`answerJob` 109-121）。
- `models/timeline.dart`（全 874 行：`apply` 533-630、`_applyTransient` 664-693、`reset` 817-849、`TurnGroup` 233-302）。
- `models/`：`message_state.dart` · `process_levels.dart` · `process_words.dart` · `notice.dart` · `plan.dart` · `job_ask.dart` · `harness.dart`（214-353 是 DSH 类型表）· `space.dart` · `design.dart` · `forbidden_words.dart` · `scroll_follow.dart` · `conn_state.dart` · `notice_words.dart`/`trash_words.dart`/`job_words.dart`/`desktop_words.dart`/`harness_words.dart`（**所有上屏的字**）。
- `services/api.dart`（1135 行；`say` 193-225、`older` 449-480、`appsOrNull` 292-321）。

**服务端（词汇与归一）**
- `v2/services/core/src/timeline.js`（`emit` 166-184 / `emitTransient` 185-192 / `ScopeView.#tagged` 296-304）· `message-writer.js:107,142,178,196` · `session-translate.js`（**文件头 1-73 的三条铁律**、`TOOL_STEP_STATE` 212-230、`#emitStepCategory` 651-661、`#emitStep` 678-696、`#emitReasoning` 706-712）· `dispatcher.js:496-512`（`task/mutated`）· `792-805`（`message/status`）· `1352-1366`（`error`）· `1445-1460`（`noteProduct`/`noteTransient`）· `notice.js:39-41,307,347,397` · `plan.js:23` · `trash.js:20-22` · `job.js:43-44,59-72,123-191` · `app-events.js:18,36` · `app-live.js:124,137` · `worlds.js:544-568,748,1083` · `process-guard.js:57` · `resume-plan.js:36` · `asr.js:106-285` · `focus.js` · `server.js`（`DEFAULT_PROCESS_LEVEL='doing'`、档位闸、`client/hello`/`client/focus` 顺序）。

**规范（唯一权威在 `docs/handbook/`）**
- `docs/handbook/08-SPEC.md`：**§六 439-627**（6.1 444-454 · 6.2 497-527 · 6.2.1 529-546 · 6.3 548-563 · 6.4 565-582 · 6.5 584-593 · 6.6 595-598 · 6.7 600-625）· **§2.2 221-237** · §2.1 162-219（接口表）· §10.1 883-909（阈值总表）· §12.4 1190-1218（人格硬规则 11 条）。
- `docs/dev/64-CHAT-REDESIGN.md`（全 162 行）· `docs/dev/75-CHAT-ROW.md`（全 63 行）· `docs/dev/52-DESKTOP.md`（全 282 行）。
- 契约（被上面点名）：`docs/dev/29-NOTICE.md` · `28-DELETE.md` · `106-CHAT-SELECT.md` · `26-PROCESS-LEVELS.md`（:180 工具名不许发）· `67-SOURCES.md` · `30-EXPORT.md` · `71-MIC-ASR.md` · `68-SPEAK.md` · `81-HARNESS-ENTRY.md` · `82-DEV-MODE.md` · `83-APP-WORKSPACE.md` · `84-DISPATCHER-FOCUS.md` · `102-APP-BIRTH-SCOPE.md` · `103-APP-DELETE.md` · `104-APP-MENU.md` · `108-JOB-ASK-FLOW.md` · `109-DEV-ENTRY-IS-YOURS.md` · `111-APP-LIVE-UPDATE.md` · `112-OWN-APP-IS-LIVE.md` · `17-LOCAL-FIRST.md` · `27-SCROLL.md` · `49-STYLE.md`。
- 闸：`v2/apps/mobile/test/widget/accessibility_test.dart`（硬闸：五档不溢出 + 命中区 ≥44 + 源码级禁裸 `GestureDetector`）· `notice_overlay_test.dart`（D4.8：高度变化 0px）· `desktop_floater_test.dart` · `mini_app_test.dart` · `busy_line_test.dart` · `process_levels_test.dart` · `scroll_follow_test.dart` · `chat_scope_icon_test.dart`；`test/unit/forbidden_words_test.dart` · `process_words_test.dart` · `import_rules_test.dart` · `design_tokens_test.dart` · `motion_curve_test.dart` · `stream_retry_test.dart`。
