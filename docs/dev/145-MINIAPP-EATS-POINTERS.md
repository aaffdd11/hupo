# 145 · **小程序把指针事件吃光了**（"点了聊天窗口，整个界面没反应，要刷新"）

> **主人 2026-09-30 原话**：*「出现了bug，我在打开小程序后，点击聊天窗口，聊天就卡死了，
> 小程序我看后面也有影响。需要刷新才能恢复。」*
> 追问之后他点的：**手机浏览器打开的网页** · **整个界面点什么都没反应（包括小程序）**。

---

## 一、现场（真浏览器 · 手机尺寸 · 手机 UA，`document.elementFromPoint`）

| 什么时候 | 时间线区 | 小程序区 | 左上角 |
|---|---|---|---|
| 小程序开了、聊天还收着 | `IFRAME` | `IFRAME` | `IFRAME` |
| **点了聊天窗口（聊天展开）之后** | 🔴 **`IFRAME`** | 🔴 **`IFRAME`** | 🔴 **`IFRAME`** |

⇒ **整页最上面那一层是那个 `<iframe>`**（小程序的平台视图）。
Web 上平台视图是**真的 DOM 元素**、盖在 Flutter 的**画布上面**
⇒ 画在画布上的**聊天浮窗一个事件都收不到** —— 屏幕上就是"整个界面点了没反应"
（不是主线程卡住：同一趟量的 rAF 帧间隔中位 **16.7ms**，一直是 60fps ✓）。
而"刷新才能恢复"也说得通：刷新之后小程序没了，那一层也就没了。

**DOM 实测**（引擎自己搭的那几层，缩进表示父子）：

```
FLUTTER-VIEW
  FLT-GLASS-PANE                     ← Flutter 收事件的那一层
    #shadow
      FLT-CLIP
        FLT-PLATFORM-VIEW-SLOT   pe=auto   rect 5,7,490×687   ← **真正横着铺满的那一格**
          IFRAME                 pe=auto   （小程序的页面）
  FLT-PLATFORM-VIEW              pe=auto   rect 5,681,490×16
```

⚠️ 两个坑，第一版都踩了：
① 只关 `IFRAME` ⇒ `elementFromPoint()` 改回 **`FLT-PLATFORM-VIEW-SLOT`**，引擎认得出
"这一下落在平台视图里"、**照样不交给 Flutter**；
② 那几格住在 **`FLT-GLASS-PANE` 的 shadow root 里** ⇒ 写在 `document.head` 的 CSS **够不着**、
`document.querySelectorAll` 也**查不到**。

---

## 二、改法（一条 CSS 规则 ＋ 一个类名，关在**所有 root** 里）

`lib/widgets/mini_runtime_web.dart`：

* 往**每一个 root**（`document` ＋ 每个 shadow root）注一条 `<style>`（一次性、幂等）：
  ```
  flt-platform-view-slot, flt-platform-view, flt-clip, iframe { pointer-events: none !important; }
  ```
* `setMiniAppsInteractive(on)`：**开 / 关**那条规则（`style.text = '' / 那条规则`），
  顺手把那几格与 `_frames` 里的 iframe 直接写一遍 `style.pointerEvents`（两样都做）。
* **谁叫它**：`MiniAppHost` 在 `initState` / `didUpdateWidget`（`covered` 变的那一下）/ `dispose`
  各叫一次 —— 也就是**"聊天盖在小程序上面"那一档 ⇒ 让开**。

🔴 **为什么这一条本来就该成立**：被盖住那一档我们的规矩写得很清楚 ——
`mini_app_host.dart` 里那个全屏 `Listener`：*"点可见的那一块 = 收起聊天，
而且这一下**不许传给下面的 app**"*。Web 上那个 `pointer-events: none` 就是让它成真的东西。

⚠️ **Android 那一侧这次没复现**（量在 Web 上）：`mini_runtime_native.dart` 里那份
**是空操作**，而且注释里写明"不许假装做了" —— 真在安卓上撞到再单说。

---

## 三、判据

| # | 判据 | 在哪 | 反例（变红的样子） |
|---|---|---|---|
| P1 | 🔴 三份实现都有 `setMiniAppsInteractive`，**Web 那一份真去改 DOM**，另两份是**空操作** | `test/unit/mini_runtime_test.dart`（源码级 —— VM 上观察不到 DOM，与这一份顶上那两条同一个道理） | Web 那份没改 / 另外两份假装做了 |
| P2 | 🔴 **宿主接了线**（`setMiniAppsInteractive(!widget.covered)`） | 同上 | 函数写好了但没人叫 ⇒ 这一手是死的 |
| P3 | 新帧建出来时**记进 `_frames`**（切档时它才跟得上） | 同上 | 漏记 ⇒ 换一版之后那一档失灵 |
| P4 | （硬闸）三份实现的签名一致 | `test/unit/mini_runtime_test.dart`（既有） | 换平台编不过 |

🔴 **真读数（线上 · 手机尺寸 · 手机 UA · 修后）**：

```
小程序开了、聊天收着   iframe pe=**auto**   点小程序区 ⇒ 命中 **IFRAME**（小程序照常能玩 ✓）
点了聊天窗口（展开）   iframe pe=**none**   点时间线区 ⇒ 命中 **FLT-GLASS-PANE** ✓✓
                                            （修前是 IFRAME）
                      rAF 帧间隔中位 16.7ms（本来就不是主线程卡住）
```

---

## 四、没做的（**明说**）

* **Android 没复现、也没改**（那一侧的空操作里有注释）。这一条量在 Web 上。
* **"点浮窗外面 ⇒ 收起聊天"**这一趟**没验到**：我用来点的那一点在展开档是**满屏**的浮窗
  **里面**（截图：浮窗是 `full` 档、盖满整屏）⇒ 根本没有"外面"可点。那一条是另一件事，
  本来就有它自己的判据（`mini_app_host` 那个全屏 `Listener` ＋ §6.4 规则）。
* **没动沙箱那三条铁律**（另一个原点 / 不给 `allow-same-origin` / 不回话通道）：一个字没碰。
* **收起档的交互没动**：小程序开着、聊天收着时，小程序照常收事件（P4 那条读数）。
