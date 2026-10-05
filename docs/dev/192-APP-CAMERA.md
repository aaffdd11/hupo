# 192 · 小程序拍一张照片

> **主人 2026-10-05 原话**：*「给小程序增加拍照功能。」*
> ⇒ 手册 **`D4.30`**（升 `v2.65`）。

---

## 一、这一样跟别几样**不一样**（先记住这一条）

| | 别的几样（`ask` / `net` / `agent` / `tasks`） | **拍照（`camera`）** |
|---|---|---|
| 谁执行 | **我们**（页面发一个请求回来，服务端那条口去做） | 🔴 **浏览器 / WebView 自己**（镜头直接给页面） |
| 我们做什么 | 收请求、过闸、去做、回话 | **只做两件**：① **要他点头**；② **按授予放开那一层门** |
| 没授予会怎样 | 服务端那条口回一句人话的拒 | **门是关的**：页面里 `getUserMedia` 当场被那一层拒掉 |
| 我们碰不碰数据 | 碰（那是我们的口） | 🔴 **不碰**：不替它拍、不落盘、不进聊天记录 |

⇒ 所以这一批**没有新的服务端口**（`/ask`、`/db` 那些一个没动）；改的是
**权限那一套**（认得这个名字）＋ **两处"门"**（网页一处、安卓一处）。

---

## 二、落点

| 在哪 | 干什么 |
|---|---|
| `src/apps.js` | 权限白名单加 **`camera`**（`CAMERA_PERMISSION`）|
| `src/mcp-apps-server.mjs` | `app_create` 的说明里加这一样（助手才知道**要声明**，而且知道"他不点头时页面会被拒，要如实说"）|
| 客户端 `models/app_grants.dart` ＋ `space_words.dart` | 人话「**想拍一张照片**」（协议名 `camera` 不许上屏）；进 `knownWants`（那张卡／那张弹窗才摆得出来）|
| `widgets/mini_runtime_web.dart` | iframe 的 `allow` 由**写死空串**改成 `allowCamera ? 'camera' : ''` |
| `widgets/mini_runtime_native.dart` | WebView 那条 `onPlatformPermissionRequest`：**只认摄像头**（麦克风照样拒）、**只认授予过的那个小程序** |
| `widgets/mini_app_frame.dart` / `screens/chat_screen.dart` | 把"他授予了没有"（`granted` 里有 `camera`）一路传下去 |
| `android/.../AndroidManifest.xml` | 加 `CAMERA` ＋ `uses-feature(camera, required=false)` |

---

## 三、判据（都带负向对照）

| # | 钉什么 | 在哪 |
|---|---|---|
| G1 | `camera` 进了权限白名单；认不出来的名字**照样拒** | `test/apps.test.js`（+1） |
| G2 | 人话是「想拍一张照片」；**协议名 / "摄像头 / 权限 / Camera" 一个都不许出现在那句话里** | `test/unit/app_grants_test.dart`（+1） |
| G3 | 认得的**五样与顺序**（问一句 → 上网 → **拍照** → 跟助手说话 → 按点跑） | 同上（那条老判据跟着改） |
| G4 | 沙箱那条：`allow` **只许**写成 `allowCamera ? 'camera' : ''`（写死 camera、或顺手加麦克风 ⇒ 红） | `test/unit/mini_sandbox_test.dart`（负向对照加到 4 条） |
| G5 | Web 收下了那个入参、安卓有那条 `onPermissionRequest`、`chat_screen` 那一行是拿 **`granted`** 判的 | `test/unit/mini_runtime_test.dart`（+1） |
| G6 | 清单里有 `CAMERA`，而且 `uses-feature` **不是** `required="true"` | `test/unit/android_manifest_test.dart`（+1） |

---

## 四、如实说

* 🔴 **真机那一下我这儿验不了**：拍不拍得出来要**他拿安卓机试**。
  我这条机器上没有摄像头，浏览器那条路也只能验"门开了没有"（`allow` 属性和权限门）。
* **第一次打开会多问一次**（"想拍一张照片"）：那是 `unanswered` 那条老路，跟他点头 `net` 一模一样。
  他点了同意之前，页面里那句 `getUserMedia` **会被拒**——助手写的页面要**如实说**
  （不许转圈假装在拍），这一句我写进 `app_create` 的说明了。
* **旧的小程序不会自动有这个能力**：要拍照就得**重新声明一版**（跟 `net` 加站同一条规矩）。
* **麦克风仍然不给小程序**（这一批只放了摄像头那一样）。
