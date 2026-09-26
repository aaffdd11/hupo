# 121 · 展开之后那一窗：**发得出去、历史滑得动**（四条根因）

> **主人 2026-09-26 原话**：
> *"聊天窗口的发送按钮有bug，展开时无法发送。另外聊天历史展开时也无法滑动。"*
>
> 线上那一版客户端是 `cb3c68fb118f`（第五批右栏也在里面），所以这不是"理论上的"。
> 这一份记的是：**四条根因**（三条是我复现出来的、一条没复现）、**判据与读数**、
> 以及**没能验到的那一块**（§五）。逐批的账在
> [`116`](116-CHAT-OPEN-AND-REDESIGN.md) 结项那一节；右栏那一栏的形状在
> [`120-FILE-PANEL.md`](120-FILE-PANEL.md)（这一份改了它的一条：§3.1 的"挤"）。

---

## 〇、一句话

两条症状里，**"历史滑不动"查实了**（两条独立的根因，都能复现）；
**"发不出去"没查实**（真浏览器 ＋ 五档状态都没复现出来，如实记在 §五）。
顺手修掉的是**第四个**：右栏在手机宽度上把聊天挤成 30 像素（第五批带进来的，
[`120`](120-FILE-PANEL.md) §3.1 那条"够宽就挤"缺了**另一半**判断）。

| # | 根因 | 在哪 | 症状 | 状态 |
|---|---|---|---|---|
| A | **"用户自己翻走了"只认"拖"**（滚轮/触控板/滚动条/键盘都不算） | `chat_screen.dart` 的 `_userScrolledAway` | ② 滑不动（桌面：滚轮是唯一手段） | ✅ 复现 ＋ 修 ＋ 判据 |
| B | **展开那一下的补帧会"停在半路"**，以后随便哪一帧再醒过来 | `chat_screen.dart` 的 `_jumpToLatest` | ② 滑不动（刚翻上去就被拽回底部） | ✅ 复现 ＋ 修 ＋ 判据 |
| C | **键盘那一段被算了两遍** ⇒ 时间线被挤成 **0 高**、浮窗顶出屏幕上沿 | `_sheetBody` 里第一版留下的一格 `SizedBox` ＋ `maxH` 按整屏算 | ② 滑不动（手机：没有东西可滚）；① 的可疑机制之一 | ✅ 复现 ＋ 修 ＋ 判据 |
| D | **右栏"挤"只判了它自己放不放得下** | `_panelDocked` / `dshRightPanelFits` | 手机上聊天只剩 30 像素 ＋ 气泡横向溢出 | ✅ 复现 ＋ 修 ＋ 判据 |
| — | **"展开了就发不出去"** | ? | ① | ❌ **没复现**（§五） |

---

## 一、根因 A：`_userScrolledAway` 只认得"拖"

`models/scroll_follow.dart` 那条纯函数的规矩是对的（"用户自己翻走了就别打断他"），
**错的是"谁算用户自己翻的"**：

```
ScrollStart/UpdateNotification.dragDetails != null  ⇒  只有"按住拖"那一种
```

而滚轮 / 触控板 / 滚动条 / 键盘翻页 **都不带 `dragDetails`**
（它们走 `ScrollPosition.pointerScroll()`，只拨 `userScrollDirection`）。
⇒ 桌面浏览器上（Flutter 默认**不给鼠标拖拽当滚动设备**：
`ScrollBehavior.dragDevices` 里没有 mouse ⇒ **滚轮是唯一手段**）用户翻上去之后
那个标志仍是假 ⇒ 之后**任何**一帧控制器变化（流式回答的每一条 `message/text`、
工具行、`queue/changed`）都会走 `scrollFollowAction(userScrolledAway: false)`
的"永远跟到底"那一支，把用户刚翻上去的一屏**硬跳回底部**。

**真浏览器读数**（线上那一版 `cb3c68fb118f` ＋ 临时核心 ＋ 假 harness ＋ 60 轮历史；
`--eval` 里派 `WheelEvent`、语义树读"现在看得见哪几轮"）：

```
滚轮翻上去        → visible turns: 42@-52,43@150,44@352,45@554,46@756
点一下发送（真发出去）→ visible turns: 60@-74          ← 被拽回底部
```

**修法**（`_isUserScroll`）：三种都认 —— 拖（`dragDetails`）、
非 idle 的 `UserScrollNotification`（滚轮/触控板/滚动条/键盘）、以及原有的拖那两条。
⚠️ **我们自己 `jumpTo` 的那几次不算**：`jumpTo → goIdle()` 会把方向拨回 `idle`；
`animateTo` 走 `DrivenScrollActivity`、**不动**方向 ⇒ 两者都不产生"非 idle"那条。

## 二、根因 B：补帧停在半路

`_jumpToLatest` 连补 4 帧（本意：`ListView` 懒加载，跳一次会**差一条**），
用的是 `addPostFrameCallback` —— 而 **它自己不排帧**（`SchedulerBinding` 只往队列里
放一格）。没人排帧时这一串就**停住**，等到下一次"因为别的原因"来的那一帧才接着跑：

```
DIAG _jumpToLatest left=4 / 3 / 2         ← 展开那一下
（用户滚轮翻到 4415）
DIAG _jumpToLatest left=1                 ← 用户翻上去的那一帧把它叫醒了
（下一帧）→ 4715（又被拉回底部）
DIAG _jumpToLatest left=0
```

**修法**：补帧自己 `scheduleFrame()`（补帧是"这次展开"的事，就在这几帧里跑完）。
⚠️ 这条与 A 是**两条独立的根因**：光修 A，B 仍会在"展开后马上滚"的那 66ms 里咬人；
光修 B，A 仍会在每条流式帧上咬人。**两条都修**，判据也各有一条。

## 三、根因 C：键盘那一段算了两遍

`_sheetBody` 的 Column 末尾原有一格：

```dart
SizedBox(height: MediaQuery.viewInsetsOf(context).bottom),
```

它是 **`a43ec38`（第一版真界面）**留下的 —— 那时**输入条就住在这个 Column 里**
（`… Center(Composer…), SizedBox(viewInsets.bottom)`），用它把输入条顶到键盘上面。
**2026-09-24 起输入条搬去了浮窗**（`ChatFloater.composer`，是这个 Column 的**兄弟**）
⇒ 这一格变成**多算一遍键盘**：`Scaffold`（`resizeToAvoidBottomInset`）已经把身子缩过一次。

**真读数**（390×844 ＋ 键盘 300 ＋ 6 行字）：

```
transcript = Rect.fromLTRB(30, -71.5, 360, -71.5)     ← 高 0，整块在屏幕上方
floater    = Rect.fromLTRB(30, -270,  360, 514)       ← 顶出屏幕上沿 270
Column-[<'chat-body'>]  RenderFlex overflowed by 7.0 pixels on the bottom
```

**没有东西可滚 = "滚不动"**（这就是手机上的②）。
同一个 `maxH` 还让浮窗顶出屏幕上沿：`Positioned(left/right/bottom)` **不给 `top`**
⇒ 它给孩子的约束里**高度是无界的**（`RenderStack.layoutPositionedChild` 只在给了
`height`/`top` 时才 tighten 高度）⇒ 浮窗高度只由 `maxH` 决定，而 `maxH` 当时按
`mq.size.height`（**整屏**，键盘那段只记在 `viewInsets` 里）算。
⇒ 抓手、标题行、两个 tab 全在屏幕上方，**一个都点不到**。

**修法**：删掉那一格（键盘由浮窗自己负责）；`maxH` 减掉 `viewInsets.bottom`。

## 四、根因 D：右栏"挤"只判了一半

[`120`](120-FILE-PANEL.md) §3.1 写的两条路是"**够宽就挤** / 不够宽就盖"，
而"够宽"当时只判了 `dshRightPanelFits(available)` = **这一栏自己放不放得下**（≥300）。
手机那一档（浮窗里那一块 ≈ 屏宽 − 60 ⇒ 330 上下）算出来的栏宽正好 300
⇒ `Row` 里聊天只剩 **30 像素**：

```
RenderFlex overflowed by 41 pixels on the right
  Row  bubbles.dart:141
```

"挤"的本意是"**还看得见一条边**"（与 DSH 的三轨同一个形状）；
只剩 30 像素不是"看得见"，是把聊天弄坏了。
⇒ 加第三个条件 `dshRightPanelLeavesRoomForChat`：**两根柱子各自都要有一块能用的宽度**
（聊天也要 ≥ 那个同源的 `dshRightPanelChatMinWidth`；不够就改走"盖" ——
栏照旧滑进来、聊天一个像素都不动）。

⚠️ **顺带记一条没修的**（不属于这两条症状）：同一档宽度下 **3.1 倍字号**时
**标题行**自己会溢出 41 像素（`chat_floater.dart:409` 那个 Row）——
a11y 硬闸跑的是 800×600，量不到这个宽度。它不影响发送/滚动，**没有动它**（见 §五）。

---

## 五、🔴 没复现出来的那一条（"展开时无法发送"）

**如实说：我没能让它红。** 试过的地方（都走真入口）：

| 环境 | 状态 | 读数 |
|---|---|---|
| widget（`test/widget/expand_input_test.dart`） | 右栏关 · 右栏开 · **有折叠控件** · **有工具行** · 暗色 ＋ 用户字号 17 | 五条**都发得出去、而且恰好一句**（修之前也是绿的） |
| widget | 收起档先在输入框打字 ⇒ 点发送 ⇒ 自动最大化 ⇒ 再发第二句 | 两句都到服务端 |
| widget | 点输入框展开（`onFocused`）· 抓手拖到半开 · 有过程尾巴（`hasProcess`） | 都发得出去 |
| widget | 手机竖屏 390×844 ＋ 键盘 300（含 6 行字、3 条排队） | 发得出去（顺带查出根因 C） |
| 真浏览器（线上那一版 `cb3c68fb118f` ＋ 临时核心 ＋ 假 harness） | 展开后：鼠标点发送 / 触屏点发送 / 右栏开着点发送 | `user/echo` ＋ 一整轮都到了服务端（`aria-disabled` 从 null 变 true = 框被清空） |

起疑过、逐个排掉的：

* **右栏盖住输入条** —— 不可能：那一栏住在 `Expanded` 里面（聊天区），
  输入条是 `_sheetBody` 的**兄弟**，量出来的矩形从不重叠（§四的溢出也不是它）；
* **`_jumpToLatest`／`_followBottom` 的 post-frame 把发送吃掉** —— 没有：
  发送只走 `Composer._submit → onSend → controller.send`，与滚动条那条路不相干；
* **`canSend` 卡在假**（`hearing.busy` / 框里没字） —— 判据里显式核过
  `_sendReady == true` 才点，五档状态都亮着；
* **无障碍那层 DOM 把点击吃掉** —— 语义树开着时，发送钮那颗节点
  `pointer-events: all`、`role=button`，而**整屏那个容器节点是 `pointer-events: none`**
  ⇒ 真实的鼠标点击落在按钮自己那颗节点上（Flutter 的语义动作那条路），不是被盖住。
  ⚠️ **但这一条我没能用"真·可信输入"验穿**：CDP 的 `Input.dispatchMouseEvent`
  在无头 Chrome 里**送不到 Flutter**（实测：点抓手，窗口纹丝不动），
  所以"真鼠标点上去到底走哪条路"我只能**推**（`pointer-events` ＋ `elementsFromPoint`），
  不能**证**。

⇒ **"发不出去"这条账我留着**（不假装修好了）。最可能的方向，按可能性排：
① **手机浏览器不报键盘高度**（`viewInsets == 0`）⇒ 输入条被压在键盘底下
（那与根因 C 是同一处账：键盘那一段算不算、算几遍）——
这一条要一台**真手机 ＋ 真键盘**才验得穿；
② 语音那一档卡在"正在听"（`hearing.busy` 恒真 ⇒ 发送钮一直是灰的）——
那要一条真 ASR 才验得穿。

---

## 六、判据（新 `test/widget/expand_input_test.dart`，12 条）

| # | 钉什么 | 修之前 | 修之后 |
|---|---|---|---|
| 1–5 | **展开后发送 ⇒ 恰好交给服务端一句**（右栏关 / 右栏开 / 有折叠控件 / 有工具行 / 暗色＋字号 17） | ✅ 绿（**没复现**，见 §五） | ✅ 绿 |
| 6 | 🔴 **滚轮往上翻 ⇒ 后面来的新事件不许把它拽回底部** | 🔴 **红**（`Expected < 4615, Actual 4715`） | ✅ 绿 |
| 7 | 对照组：**手指拖**上去 ⇒ 新事件也不许动它 | ✅ 绿（一直是对的） | ✅ 绿 |
| 8 | 🔴 **展开那一下的补帧不许停在半路、以后把用户拽走** | 🔴 **红** | ✅ 绿 |
| 9 | 🔴 **手机竖屏 ＋ 键盘 ⇒ 时间线不许是 0 高、浮窗不许顶出屏幕** | 🔴 **红**（`floater.top = -270`） | ✅ 绿 |
| 10 | 对照组：没有键盘 ⇒ 时间线本来就该有一大块 | ✅ 绿 | ✅ 绿 |
| 11 | 🔴 **手机宽度 ＋ 右栏开 ⇒ 不溢出、聊天还剩得下** | 🔴 **红**（4 处溢出异常） | ✅ 绿 |
| 12 | 对照组：够宽时**还是"挤"**（聊天真的变窄） | ✅ 绿 | ✅ 绿 |

**读数**：修之前 **8 过 / 4 红**（红的正好是 6/8/9/11）· 修之后 **12 过 / 0 红**。
每条 🔴 都配一条负向对照（7/10/12），免得"闸打在了替代的那一侧"（V13 那一族）。

**闸（改完之后跑）**：`flutter analyze` 干净 · `test/unit` **735 过 / 0 挂**（一条都没动）·
`test/widget` 全量 **698 过 / 0 挂**（基线 686 ⇒ 我这一份 **＋12**）·
`accessibility_test.dart`（**硬闸**）**382 过 / 0 挂**（一个实例都没动）。

## 七、改了什么（文件）

| 文件 | 改了什么 |
|---|---|
| `lib/models/dsh_design.dart` | ＋`dshRightPanelChatMinWidth`（与 `dshRightPanelNarrowWidth` **同源**）＋`dshRightPanelLeavesRoomForChat`（"挤完还剩不剩得下"） |
| `lib/screens/chat_screen.dart` | ①`_isUserScroll`（三种"用户自己翻的"）＋ `NotificationListener` 改用它；②`_jumpToLatest` 补帧自己排帧；③`maxH` 减 `viewInsets.bottom`；④删掉 `_sheetBody` 里第一版留下的那格 `SizedBox(viewInsets.bottom)`；⑤`_panelDocked` 加第三个条件 |
| 新 `test/widget/expand_input_test.dart` | 上面那 12 条（含 3 条负向对照） |
| `docs/dev/120-FILE-PANEL.md` | §3.1 补一句"够宽"的**另一半**（只看这一栏放得下是不够的）＋ 指针到这一份 |
| `scripts/check-docs.mjs` · `docs/INDEX.md` · `docs/dev/00-PROGRESS.md` | 121 出生就进 RATCHET · L0 加一行指针（零数值）· 进度加一行 |

## 八、如实说

1. **"发不出去"没复现**（§五）。我没有动发送那条链子 —— 没有证据就改它
   只会把"本来好的"改坏（`04-ROADMAP.md` §十一）。
2. **真浏览器那一趟是"合成事件 ＋ 语义树"**：`--click-at` 派的 `PointerEvent`
   直接落在 `flt-glass-pane` 上（能进），而 CDP 的**真·可信输入送不到 Flutter**
   （实测），所以"真鼠标/真手指"这一层只到"推理 ＋ `pointer-events` 读数"。
3. **手机上那一趟只有 widget 读数**（真手机要主人那台设备）。键盘那一档的
   `viewInsets` 是测试里注进去的（`tester.view.viewInsets`），真浏览器报多少没验。
4. **3.1 倍字号 ＋ 手机宽度的标题行溢出**（41 像素）**没修**：它不属于这两条症状，
   也没有判据盯着那个宽度（a11y 硬闸跑 800×600）。记在这儿，别当它不存在。
5. **没有部署、没有重启、没有推**（主人自己做）。客户端改了 ⇒ 要
   `scripts/deploy-web-v2.sh`，上线之后仍建议用真手机把键盘那一档看一眼。
