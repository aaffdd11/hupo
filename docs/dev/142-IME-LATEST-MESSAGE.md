# 142 · **输入法一起来，最新那条就看不见了** —— 视口变矮时要重新对一次底

> **主人 2026-09-30 原话**：*「很好，现在OK的，但是输入法打开的时候，页面被覆盖，无法显示最新消息。」*
> （前一句是 `#201` 那条"加载历史卡住"修好之后的回话。）

---

## 一、现场（真浏览器 · 手机 UA · 390 宽 · 键盘 300）

**怎么量出来的**（这一条的关键都在探针里）：

| 装置 | 为什么要这样 |
|---|---|
| `--chrome-arg --user-agent=…Android…` ＋ `--width 390 --height 844` | 引擎"手机"那一支只按 UA / `navigator.platform` 判（`124` §三 的读数） |
| 先**点一下输入条**（`<textarea>` 拿到焦点、`document.activeElement` = `TEXTAREA`） | 引擎只在**正在编辑**时才把键盘算成 `viewInsets`（`EngineFlutterView._didResize`） |
| 🔴 把 **`window.visualViewport` 这个对象自己的 `height` 改小**（`Object.defineProperty` ＋ 在**它**上面派 `resize`） | ⚠️ **换个假对象不行**（我第一版就是这么写的、白跑两趟）：引擎的 `resize` 监听挂在**启动时那个** `visualViewport` 上 —— 换掉属性它收不到；而且它读的是 `DomWindow.visualViewport.height` |

**读数**（同一趟，键盘弹起前后各量一次）：

```
编辑元素（引擎给输入法用的那个 <textarea>）的矩形：
   键盘前  [95, 648, 246×24]
   键盘后  [95, 348, 246×24]      ← 让开了 300（**布局是对的**）
```

**截图为证**（`docs/dev/142-raw/`）：

| 什么时候 | 最下面那条是什么 |
|---|---|
| 键盘弹起**前**（`01-before-ime.png`） | 「**我现在接不上活。你这句话我记下了，等我缓过来再说。**」＝ **最新那条** ✓ |
| 键盘弹起**后**（`02-after-ime-before-fix.png` · **修前**） | 「有一件事你要知道：他们装走的是各自的副本…」＝ **更早的一条** ⇒ 最新那几条**被挤到看得见的地方之外** ✗ |
| 键盘弹起**后**（`03-after-ime-fixed.png` · **修后**） | 「**我现在接不上活。你这句话我记下了，等我缓过来再说。**」＝ **最新那条** ✓ |

⇒ 主人那句"页面被覆盖，无法显示最新消息"**逐字复现**：
**窗口是对的（让开了键盘），是时间线自己没跟到底。**

---

## 二、根因

**两件事各自都对，凑在一起就错**：

1. 视口变矮时，Flutter **不会**替我们把滚动位置收到底 ——
   `maxScrollExtent` 变大了（内容超出得更多），而 `pixels` 还是原来那个数
   ⇒ 原来贴着底的那一屏，只露出上半截（**差的正好是键盘那 300**）。
   widget 层读数：`pixels 4383` vs 新的 `maxScrollExtent 4683`。
2. "跟不跟到底"这件事**只在控制器有变化时**才算
   （`_onChanged` → `_followBottom()` → `models/scroll_follow.dart` 那条纯函数）。
   🔴 **键盘弹起不产生任何新事件** ⇒ 那条路**一次都不走**。

⚠️ 与 `#168`（`121-EXPAND-INPUT-FIX.md`）那三条**不是同一件事**：那三条是
"展开那一下的补帧 / 键盘算了两遍 / 右栏挤"，修的是**布局**；这一条是
**布局对、跟随没跟上**。

---

## 三、修法（一处，复用既有那条规则）

`lib/screens/chat_screen.dart`：

```dart
double? _lastVisibleH;                    // 上一次"看得见的那块地方"有多高

@override
void didChangeDependencies() {            // MediaQuery 一变就跑（键盘/窗口/系统条）
  final mq = MediaQuery.of(context);
  final visibleH = mq.size.height - mq.viewInsets.bottom;
  final was = _lastVisibleH;
  _lastVisibleH = visibleH;
  if (was == null || (visibleH - was).abs() < 0.5) return;
  WidgetsBinding.instance.addPostFrameCallback((_) => _followBottom());   // 下一帧再对
}
```

* **判据还是那一条**（`scrollFollowAction` 纯函数，一个字没改）：
  他自己往上翻过 ⇒ 不动他（只在贴底附近才跟）；从没翻过 ⇒ 钉回最新（`jump`，不带动画）。
* **下一帧再对**：这一刻布局还没按新高度算过（`maxScrollExtent` 还是旧的）。
* 键盘**收起**时走的是同一条路 ⇒ 也自动对一次底 ✓。
* ⚠️ 只在"**高度这个数**变了"时才动 —— `MediaQuery` 的其他变化（主题、字号）也会进这一处，
  不能让它们顺手把时间线拽一次。

---

## 四、判据

| # | 判据 | 在哪 | 反例（变红的样子） |
|---|---|---|---|
| K1 | 🔴 手机 + 键盘弹起 ⇒ **最新那条仍贴着底**（`pixels == maxScrollExtent`） | `test/widget/expand_input_test.dart` | 差 **正好 300**（＝键盘那一段） |
| K2 | 前提一：弹起前本来就贴着底 | 同上 | —— |
| K3 | 前提二：键盘**真的**把视口弄矮了（`maxScrollExtent` 变大） | 同上 | 键盘没生效 ⇒ 这条判据什么都没量到 |
| K4 | 🔴 **对照组**：用户自己翻上去了 ⇒ 键盘弹起**不许**把他拽回底部 | 同上 | 变成了"打断他" |
| K5 | （既有）键盘 ⇒ 时间线不是 0 高、窗口不顶出屏幕、发送点得动 | 同文件 | —— |

🔴 **变异自检（判据自己也要被验一遍）**：把 `didChangeDependencies` 里那一行拿掉再跑 K1 ——
**当场红**，读数 `Expected: within 1 of 4683 · Actual: 4383`（**差的正好是键盘那 300**）。
⇒ 这条判据确实钉在"重新对底"这件事上，不是碰巧绿的。

---

## 五、没做的（**明说**）

* **安卓真机没验**：这一条的量在**手机 UA 的真浏览器**上（引擎同一条
  `computeKeyboardInsets` 逻辑）；**真机（手势条 / 输入法候选栏 / 键盘动画中途）**
  那几种形状没量过 —— 记着。
* **没动布局那一半**（浮窗让开键盘本来是对的；`121` 那三条的判据照旧）。
* **没做"键盘弹起时把窗口自动展开"**：点输入框本来就 `expand()`（既有），这一条只修"跟到底"。
* **没动滚动那条纯函数**（`followSlack` 等一个数都没碰）。
