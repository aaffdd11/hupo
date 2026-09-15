# L1 终端层 · 子架构

> **契约**：`ARCHITECTURE-v7.md` §3（命名与接口）为唯一契约，本文照抄不改；协议规则见
> `packages/protocol/PROTOCOL.md`（R1–R14 继续有效）；UI 细节见 `docs/UI-terminal-floating-chat.md`
> + `docs/ui-terminal.html`；拍板见 `docs/pm-panel/DECISIONS.md`（第 8 条 UI 全做、第 2 条小程序直接做、第 9 条三件前提）。
>
> **范围**：`apps/mobile/`（Flutter：Web / iOS / Android）。不含 L2 调度器与 L3 工作层。
>
> **数值标记**：
> - **【实测】** = 在现有代码里读到的常量 / 真实跑出来的数（引用文件与行）
> - **【沿用】** = 沿用现有实现的数值（可能本身是量出来的，也可能是当时拍定的）
> - **【推定】** = 本文新提出、**尚无实测**，需要实现后用真机量回来

---

## 一、模块与文件布局（到文件级）

### 1.1 目录

```
apps/mobile/lib/
├── main.dart                                  ⚠ 改造
├── screens/
│   ├── chat_screen.dart                       ⚠ 大改（本层核心）
│   ├── conversation_list_screen.dart          ⚠ 改造
│   └── login_screen.dart                      ✅ 保持
├── widgets/
│   ├── app_desktop.dart                       ⚠ 改造（图标来源合并内置 + 已装）
│   ├── mini_app_container.dart                ⚠ 大改（bottomInset / 保持挂载 / 退让）
│   ├── answer_bubble.dart                     ⚠ 改造（scheme 白名单 + 小程序卡片）
│   ├── dev_card.dart                          ✅ 保持
│   └── (新增) mini_app_card.dart              ➕ 新增
├── mini/                                      ➕ 新增目录（契约 §3.6 已定名）
│   ├── runtime.dart                           ➕ 新增
│   ├── manifest.dart                          ➕ 新增
│   ├── store.dart                             ➕ 新增
│   └── bridge.dart                            ➕ 新增
├── services/
│   ├── apps_client.dart                       ➕ 新增
│   ├── chat_controller.dart                   ⚠ 改造
│   ├── websocket_transport.dart               ⚠ 改造
│   ├── transport.dart                         ⚠ 改造（接口）
│   ├── mock_transport.dart                    ⚠ 改造（跟新事件对齐）
│   ├── app_version.dart                       ✅ 保持
│   ├── page_reload.dart / _web / _io          ✅ 保持
│   ├── token_store.dart                       ✅ 保持
│   ├── dev_mode.dart                          ✅ 保持
│   └── weather.dart / city_catalog.dart       ✅ 保持（内置 app 的数据源）
├── models/
│   ├── stream_event.dart                      ⚠ 改造（新增 app/* 与 miniapp/load-failed）
│   ├── timeline.dart                          ⚠ 改造（+ MiniAppCardRef）
│   ├── agent_status.dart                      ✅ 保持
│   └── dev_step.dart                          ✅ 保持
└── apps/
    ├── mini_app.dart                          ⚠ 改造（+ 来源：内置 / H5）
    ├── app_registry.dart                      ⚠ 改造（合并两来源）
    ├── weather_app.dart                       ✅ 保持
    ├── conversations_app.dart                 ⚠ 改造（导出 / 删除入口）
    ├── about_app.dart                         ✅ 保持
    └── dev_mode_app.dart                      ✅ 保持
```

**新增依赖**（`pubspec.yaml`，**当前一条都没有** —— 实测：deps 只有 `http` / `web_socket_channel` / `web` / `url_launcher` / `shared_preferences` / `cupertino_icons`）：
- 原生沙箱：`webview_flutter`（或 `flutter_inappwebview`，二选一；**不引入原生桥**见 §4.3）
- Web 沙箱：不引新依赖，用 Flutter Web 的 platform view + `<iframe>`

### 1.2 每个文件负责什么

| 文件 | 职责 | 关键点 |
|---|---|---|
| `screens/chat_screen.dart` | 浮窗（三档 / 抓手 / 覆盖退让 / 拦截层 / 灰化） | **z 序要改**：浮窗必须移到 `MiniAppContainer` **之后** |
| `mini/runtime.dart` | 沙箱运行时：Web 用 `<iframe sandbox>`；原生用受限 WebView | 统一暴露 `mount / pause / resume / dispose / reload`；**不认识 manifest 之外的任何东西** |
| `mini/manifest.dart` | `MiniAppManifest` 解析 + 校验 | `minShellVersion` 比对、`sha256` 格式、字段白名单；**不合法直接拒** |
| `mini/store.dart` | 本地安装 / 版本目录 / `last-known-good` | 版本目录不可变；回退 = 改指针；清单文件 `no-cache` |
| `mini/bridge.dart` | `postMessage` 编解码 + 来源鉴别 + 容器代发 | **say / 存储都从这里出**；令牌永不下发（N2） |
| `services/apps_client.dart` | 拉 `/api/apps`、下载制品、校验 hash | 走**壳**的 origin 发请求（不是小程序发，见 §4.2） |
| `widgets/mini_app_card.dart` | 对话流里的"小程序卡片"（点开就运行） | 复用 `DispatcherMessage` 的来源通道，不新造消息类型 |

**为什么把 mini 单独开一个目录**：沙箱与协议桥是本层**唯一执行第三方代码**的地方（N1/N2）。
放在一处，审计面就是 4 个文件，而不是散在 UI 里。

---

## 二、Z 序与共存

### 2.1 现状（**与目标相反**，实测）

`chat_screen.dart:255-291` 的 `Stack` 自下而上是：

```
① Positioned.fill( GestureDetector(panel-backdrop) → AppDesktop )   ← 桌面
② Positioned(left/right=10, bottom=10, _floatingPanel)              ← 聊天
③ if (open != null) Positioned.fill(MiniAppContainer)               ← 小程序：**盖在最上面**
```

⇒ **打开小程序会把聊天整个盖住**（`chat_screen.dart:10` 的注释也这么写）。目标相反。

### 2.2 目标 Z 序

```
（最上）
  ④ 开发者卡片          ← 只有"开发者模式"这个 app 内部才画（dev_card.dart，实测已不是浮层）
  ③ 聊天浮窗            ← 永远在最上，永远在
  ③′ 拦截层（条件存在）  ← 只在浮窗**展开**时存在；透明；吃掉落在小程序可见区域的点击
  ② 小程序容器          ← 被盖住时**不销毁、不重建**（Z2）
  ① 桌面 / 背景
（最下）
```

`Stack` 的 children 顺序（**唯一的结构改动**）：

```dart
Stack(children: [
  Positioned.fill(child: GestureDetector(key: Key('panel-backdrop'), …, child: AppDesktop(…))),

  // ② 小程序：始终挂载（有 app 打开时），被盖住也不重建
  if (open != null)
    Positioned.fill(child: _miniLayer(open)),          // 见 §2.4

  // ③′ 拦截层：只在浮窗展开时插入
  if (!_collapsed) Positioned.fill(child: _InterceptLayer(onTap: _collapseFromOutside)),

  // ③ 聊天浮窗：**最后** ⇒ z 序最上
  Positioned(left: …, right: …, bottom: 10, child: _floatingPanel(…)),
])
```

### 2.3 三条规则与落地

| # | 规则 | Flutter 落地 |
|---|---|---|
| **Z1** | 聊天永远在最上 | 浮窗是 `Stack` 的**最后一个** child；小程序**不能**再出现在它之后 |
| **Z2** | 被盖住不重建、不 reload | **不用** `Offstage`（它会让小程序不可见，见 §4.4 的取舍）；用 `TickerMode(enabled: false)` 关动画；`Key` 稳定（`ValueKey(appId)`），不许因档位变化改变 widget 树形状 |
| **Z3** | 盖住 ≠ 铺满 | 边距 `左10 / 右10 / 下10 / 上12`【沿用】；最大化时 `top = maxH − 12`，四个角圆 `18`【沿用】 |

⚠ **Z2 的实现陷阱（本文发现）**：UI 稿 §4.2 要求被盖住的小程序**压暗 + 缩小**（⇒ 它仍然**参与 paint**，看得见）。
而 `Offstage` 会跳过 paint/layout ⇒ 二者不能同时成立。
**建议：统一不用 `Offstage`，只用 `TickerMode`**（简单、无跳变，代价是一点 paint 开销）；
当浮窗**最大化**到完全遮住时，可切 `Offstage` 省开销，但那会产生一次视觉跳变 —— **不推荐**。见 §12 第 2 条。

### 2.4 小程序层（`_miniLayer`）

```
┌─ AnimatedScale(0.98 被盖 / 1.0 未被盖, origin: bottomCenter) ─┐
│ ┌─ AnimatedOpacity ─┐                                        │
│ │  MiniAppContainer(                                        │
│ │    bottomInset: 收起高 + 下边距 = 124 + 10 = 134,          │
│ │    ticker: _collapsed ? enabled : (被完全盖住时停)   )      │
│ └───────────────────┘                                        │
│ ┌─ 压暗层（被盖时 alpha .35；**在浮窗之下、小程序之上**）──┐  │
│ └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```
- 圆角：未被盖时**无圆角**（现状，实测 `mini_app_container.dart:46-48` 的 `Material` 没设 `shape`）
  → 被盖时 `16`（【推定】，UI 稿 §4.2 的"圆角 12→16"里那个 `12` 需要先补上：**这是新增的圆角**，不是沿用）
- 压暗 `alpha .35`、`scale → .98`、时长 `180ms easeOutCubic`（【推定】，UI 稿 §4.2）

---

## 三、浮窗状态机

### 3.1 状态

| 维度 | 取值 | 来源 |
|---|---|---|
| 档位 `hFactor` | `0.0` 收起 / `0.5` 半开 / `1.0` 最大化 | 【实测】`chat_screen.dart:344` `stops = [0.0, 0.5, 1.0]` |
| 高度 | `h = 124 + (maxH − 12 − 10 − 124) × hFactor` | 【实测】`:307-312` |
| 收起高度 | `124`（抓手 14 + 标题行 32 + 输入条 + 内边距） | 【实测】`:62` |
| 是否有小程序打开 | `openApp != null` | 【实测】`:89` |
| 是否被盖住 | `openApp != null && !_collapsed` | ➕ 新增 |
| 是否在拖 | `_dragging`（拖时 `duration: 0` 跟手） | 【实测】`:477-479` |

### 3.2 转移（触发规则）

| 事件 | 守卫 | 结果 | 现状 |
|---|---|---|---|
| 用户按发送 | 输入非空 | → **最大化** | ✅ `:211-217` |
| 助手**开口**（`latestDispatcherMessage.messageId` 变化） | **非 hydration**（首批历史不拉满） | → **最大化** | ✅ `:139-146` |
| `status` 变化（thinking/working/handoff） | — | **不动** | ✅（`:282-284` 只改 `pendingStatus`） |
| 点浮窗**外面**（桌面空白） | `!_collapsed` | → 收起 | ✅ `:376-382` |
| 点浮窗**内部** | — | **无反应**（`HitTestBehavior.opaque` 挡住） | ✅ `:468-472` |
| 双击抓手 / 点 ⌄ | — | 收起 ⇄ `lastExpandedFactor` | ✅ `:363-373` |
| 拖 / 甩 | 速度 `|vy| > 650`【实测 `:346-349`】 | 下甩收起 / 上甩拉满；否则吸附最近档 | ✅ `:343-361` |
| **打开小程序** | — | → **自动收起**（保留底部条） | ➕ 新增 |
| **小程序开着 + 助手开口** | — | → **升起覆盖** | ➕ 新增（= 上面的"助手开口"，但要有退让动画） |
| 400ms 内连续触发 | — | 合并成一次 | ➕ 新增【推定】 |

**防抖为什么必须有**：助手一条消息可能连续到达多段（`message/text` 的 quick 与 deep 是同一 `messageId`，
实测 `timeline.dart:127` 的 `applyText` 会合并），但 `message/start` 每来一条就触发一次 `_maximize()`。
`400ms`【推定】是把"卡片式抖动"压掉的最小代价。

### 3.3 手势优先级（写死，避免打架）

| 手势 | 命中层 | 结果 |
|---|---|---|
| 竖向拖抓手 / 标题行 | 聊天 | 改高度（跟手 → 松手吸附） |
| 点抓手双击 | 聊天 | 收起 ⇄ 上次档位 |
| 点浮窗内部 | 聊天 | 无 |
| 点收起态底部条 | 聊天 | 展开到上次档位 |
| 点桌面空白 | 桌面层 | 收起（`!_collapsed` 时） |
| **点小程序可见区域（浮窗展开时）** | **拦截层** | **收起聊天，不穿透**（小程序收到点击次数必须为 0） |
| 点小程序按钮（浮窗收起时） | 小程序 | 正常交互（**此时拦截层必须不存在**） |
| 键盘 `Esc` | 全局 | 收起 |
| 键盘 `Cmd/Ctrl+K` | 全局 | 聚焦输入框 |

### 3.4 宽屏裁决（拍板第 8 条采纳陆明纠正）

| 宽度 | 浮窗外壳 | 浮窗内容 | 理由 |
|---|---|---|---|
| `< 600` | 左右各 `10`，跟随屏宽 | 跟随 | 【沿用】现状 |
| `600–900` | 最大宽 `720` 居中 | 同上 | 【推定】横屏行长过宽难读 |
| `> 900` | **收起态：横跨可用宽度**（`left/right = 10`，**不居中限宽**）；展开态：最大宽 `760` 居中 | 抓手 / 标题行 / 输入框限宽 `760` | 陆明："在最底下"是语义；限宽只解决排版 |

**外壳横跨 + 内容限宽**是本文的裁决，不是折中：它分别满足"外壳语义"和"内容排版"两个不同层面的要求。
**不做侧栏 / 停靠**（主人明确要"打开覆盖"）。

⚠ **一处措辞必须精确**：陆明说的"收起态要横跨整宽"**不是**"贴到屏幕边缘"（那会与 Z3「四边永远留边距」冲突），
而是"**不要居中限宽**"——它的症状是"1400 宽的屏上底部出现中间一条、两边空，看起来像居中弹窗"。
所以收起态 = `left:10 / right:10` 占满可用宽度；展开态 = `760` 居中（`>900` 时左右边距 `(W−760)/2 ≥ 70 > 10`）。
**两种形态都满足 Z3**，Z3 的本意是"最大化时不要铺满"，不是"每个形态都必须有 10px 边距"。

⚠ 宽屏下三档高度**按容器高算，不按屏高**（周慎的附加约束，实测现状用的是 `constraints.maxHeight`，
在"浮窗被塞进某个容器"时会超出上沿 ⇒ 最大化断言必须是 `top ≥ 12` 且 `bottom ≥ 10`）。

### 3.5 灰化（服务不可达）

【实测】`:416-457`：`ColorFiltered` + 亮度矩阵（**抽掉颜色，不是调透明度**）+ `IgnorePointer` + 「正在恢复连接…」。

**范围需要明确（本文提出）**：灰化只覆盖**依赖 L2 的对话浮窗**；
本地已安装的小程序**仍然可用**（它不依赖 L2；见 §4.2 的 `connect-src 'none'`）。
若把整屏灰掉，用户会以为"整机坏了"，而其实只是对话断了 —— 这属于 N7（不拿不真实的状态污染）。

---

## 四、小程序运行时

### 4.1 `MiniAppManifest`（`mini/manifest.dart`）

```jsonc
{
  "id": "weather-pro",                 // ^[a-z0-9][a-z0-9-]{0,31}$
  "name": "天气Pro",
  "icon": "icon.png",                  // 只允许相对路径
  "entry": "index.html",               // 只允许相对路径
  "version": "1.0.3",                  // 不可变
  "minShellVersion": "1.0.0",          // 壳太老 ⇒ 提示升级，不白屏
  "sha256": "<64 hex>",                // 客户端加载前校验
  "permissions": [],                   // 本轮**恒为空数组**
  "capabilities": []                   // 本轮**恒为空数组**（见 §5 的 say 状态）
}
```

**校验规则（不合法直接拒，不做"尽力解析"）**：
1. `id` / `version` / `sha256` 缺失或格式不对 ⇒ 拒；
2. `entry` / `icon` 含 `..`、绝对路径、`http(s)://`、`javascript:` ⇒ 拒；
3. `minShellVersion > kShellVersion` ⇒ **不安装**，提示"这个小程序要更新客户端"（不是白屏）；
4. `permissions` / `capabilities` 出现本轮不认识的值 ⇒ **忽略该项**（不是拒整包），并在开发者卡片记一条。

### 4.2 沙箱实现（`mini/runtime.dart`）

**Web（Flutter Web）**

```
<iframe
  src="https://apps.<域>/<appId>/<version>/<entry>"
  sandbox="allow-scripts allow-forms"      ← ⚠ 绝不能出现 allow-same-origin
  referrerpolicy="no-referrer"
  allow=""                                  ← 一个能力都不给
></iframe>
```

- **不给 `allow-same-origin`** ⇒ opaque origin ⇒ **`localStorage` 直接抛 `SecurityError`**（N1 的落地）。
- 制品在**独立 origin**（`apps.<域>`，只静态、**绝不反代 `/api/`**，契约 §八）。
- **制品下载由壳发起**：`apps_client.dart` 从宿主 origin 拉 `/api/apps` 与制品，
  **不是小程序自己去拉**。所以"小程序不联网"与"要能装"不矛盾：
  - 小程序**文档**的 CSP：`connect-src 'none'`（契约 §10、拍板第 2 条）——它自己发不出任何请求；
  - **壳**（宿主 origin）负责清单、下载、校验 —— 这是唯一能出网的一侧。
  > ⚠ 契约 §4.4 的措辞是"L1 收到 `app/update-available` → 下载"，没写明是**壳**下载。见 §13 第 2 条。

**原生（iOS / Android）**

| 平台 | 关键 flag | 说明 |
|---|---|---|
| Android | `setAllowFileAccess(false)`、`setAllowUniversalAccessFromFileURLs(false)`、`setAllowFileAccessFromFileURLs(false)`、`setDomStorageEnabled(false)` | 【推定】具体 API 名随插件而定 |
| iOS | 独立 `WKWebsiteDataStore`（非 default） | 【推定】与宿主存储隔离 |

🔴 **不得写原生桥**（`addJavascriptInterface` / `WKScriptMessageHandler` / `JavaScriptChannel`）：
既是 R-SEC-1 的另一种开法，也正好撞 Apple 4.7.2（契约 §10.2）。**S2 门禁之一：`grep` 命中必须为 0。**

### 4.3 生命周期状态机

```
requested ──► downloading ──► installed ──► running ⇄ background ──► closed
    │              │             │            │
    └──────────────┴─────────────┴────────────┴──► failed{code} + 一句人话
```

| 状态 | 谁拥有 | 进入条件 | 超时 | 收口（N7：每个"进行中"必须有收口） |
|---|---|---|---|---|
| `requested` | L1 本地 | 用户点了卡片 / 图标 | — | — |
| `downloading` | L1 本地 | 清单里有该版本且本地没有 | **30s**【推定】 | 超时 ⇒ `failed{download-timeout}` + 可重试；**配对收口必须写** |
| `installed` | L1 本地（**权威在本地**，见 §13 第 3 条） | `sha256` 校验通过 | — | — |
| `running` | L1 本地 | `mount` 完成且收到 `ready` | **5s**【推定】等 `ready` | 超时 ⇒ 显示"打开失败"，**不是白屏**；触发 `last-known-good` 回退 |
| `background` | L1 本地 | 浮窗升起、小程序被盖住 | — | 不销毁、不 reload（Z2） |
| `closed` | L1 本地 | 用户关闭 / 崩溃 | — | 保留 `installed`（下次打开不用重下） |
| `failed` | L1 本地 | 上述任一失败 | — | **一句人话 + 可重试**（N11） |

**崩溃隔离**：小程序加载失败/脚本崩溃**不能带走壳**。Web 侧靠 iframe 天然隔离；
原生侧 WebView 崩溃回调 ⇒ `failed` + 重启一次（**只重试一次**，再失败就报错，避免死循环）。

### 4.4 存储隔离 / 离线 / 版本与回退

| 项 | 设计 | 标记 |
|---|---|---|
| 存储隔离 | Web：opaque origin ⇒ **没有任何本地存储**；需要跨次保存就走**容器代管**（§5 的 `storage` 消息，本轮**未启用**）。原生：独立 `WKWebsiteDataStore` | 【推定】 |
| 离线 | `installed` 即可用：制品已缓存，断网也能打开**上次的版本**；**有更新也不自动跳版本**（避免"装了一半"） | 【推定】 |
| 版本校验 | 打开前校验 `sha256`（`manifest.sha256` vs 本地文件） | 【推定】 |
| 回退 | 失败 ⇒ 切 `last-known-good` 指针 + 上报 `miniapp/load-failed`（契约 §3.3） | 【推定】 |
| 目录 | `installed` 版本目录**不可变**；回退 = 改指针；清单文件 `no-cache` | 【推定】 |

⚠ 周慎主张"不做离线/版本"，而 v7 §3.6 保留了 `mini/store.dart`（版本目录 + 回退 `last-known-good`）、
§3.3 保留了 `miniapp/load-failed`。**本文按契约写**，冲突记在 §13 第 6 条。

### 4.5 `bottomInset` 让位规则

收起态底部条浮在小程序之上 ⇒ 小程序内容必须让位：`bottomInset = 124 + 10 = 134`【沿用+算术】。

- 实现：`MiniAppContainer` 接 `bottomInset`，把它交给内容侧做 `padding.bottom`；
- 同时给滚动区一个**安全区**：滑到底时最后一条能停在浮窗上沿（看得见"它浮在上面"）；
- **判据**：小程序里**最后一个可点元素**的 rect 与浮窗 rect **不相交**（进 §11 测试）。

---

## 五、容器 ↔ 小程序接口（`mini/bridge.dart`）

### 5.1 消息表

| 方向 | 消息 | 载荷 | 本轮状态 |
|---|---|---|---|
| 壳 → 小程序 | `mount` | `{appId, version, theme, locale, safeArea, bottomInset}` | ✅ 启用 |
| 壳 → 小程序 | `pause` / `resume` | `{}` | ✅ 启用（被盖住 / 回前台） |
| 壳 → 小程序 | `theme` | `{brightness, seed}` | ✅ 启用（跟随宿主主题） |
| 小程序 → 壳 | `ready` | `{appId, version}` | ✅ 启用（`running` 的进入条件） |
| 小程序 → 壳 | `error` | `{code, message?}` | ✅ 启用 ⇒ `app/error` |
| 小程序 → 壳 | `resize` | `{height}` | ✅ 启用（内容变高通知壳） |
| 小程序 → 壳 | `say` | `{text}` | ⚠️ **接口保留、本轮不启用**（见下） |
| 小程序 → 壳 | `storage.get` / `storage.set` | `{key, value?}` | ⚠️ **本轮不启用**（无契约端点，见 §13 第 5 条） |

**`say` 的三方冲突（本文显式上交，不自行改）**：
- 拍板第 2 条（陆明/周慎）明确：**不许小程序反向给对话发话**（"它是个回路"，"别绕这个弯"）；
- 但契约 §3.1 的 `source` 取值含 `app:<id>`、§3.3 的 `message/start.source` 要显示"来自小程序"；
- 本任务书 §5 也要求写出 `say` 的容器代发形状。

**处理**：**保留消息形状、把能力位设为 `false`**。容器收到 `say` 时**直接回 `error{code:'capability-disabled'}`**，
不发任何上行请求。启用前提（建议写进 S6）：来源降档（`foreign` ⇒ 只读档）已上线 + 监控面已有小程序行为审查。
`source: app:<id>` 的渲染路径**先按契约实现**（先只用于显示，不产生上行）。
**不许**因为"接口已经写了"就顺手打开 —— 它是一条提权回路。

### 5.2 来源鉴别（**这里有实现陷阱**）

- **壳 → 小程序**：用 `postMessage(msg, <制品 origin>)` 指定目标 origin（壳知道自己的目标域）。
- **小程序 → 壳**：⚠ 因为 iframe 是 `sandbox` **不带 `allow-same-origin`**，
  它的 origin 是 **opaque**，`event.origin` 会是字符串 `"null"` ⇒ **不能拿域名做字符串比较**。
  鉴别改用两条（合起来足够）：
  1. **只在自己创建的 iframe 的 `contentWindow` 上监听**（不监听全局 `message`，
     也不接受来自别的 window 的消息）；
  2. **一次性 nonce**：`mount` 时把 nonce 交给小程序，之后每条消息必须带同一个 nonce；
     nonce 只在对应用户打开的那次会话里有效，关闭即废。
- 原生侧：同样的 nonce 逻辑，走 `runJavaScript` / JS channel（**但不得加原生桥**，见 §4.2）。

**明确不给**（写进代码注释，免得后来者"顺手加上"）：
令牌 · 任意 HTTP · 父窗口 DOM / `window.top` · 宿主路由 · 剪贴板 · 通知 · 相机 · 文件选择 ·
剪贴板读取 · 打开外部链接（本轮连 `url_launcher` 都不暴露给它）。

---

## 六、协议实现（客户端侧）

### 6.1 六条既有规则（R1–R6 + 来源通道），现状与保持

| # | 规则 | 现状 | 落地 |
|---|---|---|---|
| 1 | **一条有序时间线，不做任何配对** | ✅【实测】`chat_controller.dart:39`、`_sortTimeline` `:375-376`（`seq` 主键 + `tie` 次键） | 保持 |
| 2 | `quick` + `deep` **同一个气泡** | ✅【实测】`timeline.dart:114-120` `displayText` 拼接、`answer_bubble.dart:44-48` | 保持 |
| 3 | `status` 与 `text` **不互转** | ✅【实测】`timeline.dart:101` 独立字段；`answer_bubble.dart:50-53,166-201` | 保持 |
| 4 | 中止**不擦除** | ✅【实测】`timeline.dart:161-167` `abort()` 只标记；`answer_bubble.dart:63-67` 追加"（已停下）" | 保持 |
| 5 | `seq` 去重 + `sinceSeq` 续传 | ✅【实测】传输层游标 `websocket_transport.dart:206`；控制器去重 `chat_controller.dart:249`；块内去重 `timeline.dart:128-130` | 保持 |
| 6 | 来源**独立通道**、空则一字不显示 | ✅【实测】`answer_bubble.dart:57-60`、最多 3 条 `:98` | 保持 + **新增 scheme 白名单** |

### 6.2 需要新增/改造的

| 项 | 设计 | 契约依据 |
|---|---|---|
| **来源 scheme 白名单** | `answer_bubble.dart:100-111` 现在直接 `Uri.parse(url)` + `launchUrl`。改成：只允许 `https`（必要时 `http`），其余**丢弃并提示"链接被拦截"** | 契约 §3.6 标了"⚠ 链接 scheme 白名单" |
| **`message/start.source` 渲染** | 在气泡上显示"来自「天气Pro」"小标（`DispatcherMessage` 增加 `source` 字段） | 契约 §3.3 |
| **小程序卡片** | 对话流里给已发布的 `appId` 渲染一个可点卡片 ⇒ 点开运行 | 契约 §4.4、§3.6 `mini_app_card.dart` |
| **`app/*` 事件** | `app/installed` / `app/update-available` / `app/error` 三个新分支进 `stream_event.dart` 的 `tryParse` | 契约 §3.3 |
| **`miniapp/load-failed`** | 本地事件 + 上报（见 §13 第 4 条的命名问题） | 契约 §3.3 |
| **`audit/notice`** | **只在 `dev=1` 通道**（现有 `websocket_transport.dart:74` 的 `dev` 参数已经在做附加订阅） | 契约 §3.3 |
| **`/api/apps` 与 export/DELETE** | `apps_client.dart` 拉清单；`transport.dart` 加 `exportConversation` / `deleteConversation`，入口放"会话"app | 契约 §3.2 |
| **灰化不可触达** | ✅ 已有 `:421-429`；**保持**并明确只覆盖对话浮窗（§3.5） | 协议 R13 |
| **自动刷新护栏** | ✅ 已有：`chat_controller.dart:85-91` 纯函数 + `page_reload_web.dart` 的 `sessionStorage` key `hupo_reloaded_for_build`；`20s` 宽限【实测 `:78`】 | 协议 R9/R10 |
| **发送失败保留可重试** | ✅ 已有 `chat_controller.dart:417-421`（`pending=false`，留在时间线上）；**增加界面上的重试入口** | 协议 R4 |
| **`message/seen` 只报连上之后** | ✅ 已有：`_serverNowAtConnect` 划线 + `isLive` 判定（`:298-309`）——**拿不到服务端钟就不报** | 协议 R12 |
| **`conversationId` 形态** | 现在硬编码 `c_main`（`main.dart:176-179`，可被 `?conv=` 覆盖）⇒ 要迁到 `u_<userId>:c_<name>` | 契约 §3.1（见 §13 第 7 条） |
| **未知事件忽略** | ✅ 已有 `websocket_transport.dart:205`；**新事件必须同样"不认识就跳过"** | 向前兼容 |

---

## 七、状态与文案

| 状态 | 界面 | 文案 | 依据 |
|---|---|---|---|
| 空（无消息） | 收起条显示"助手"；展开显示一句引导 | ✅ 现有 `:536-539` 与 `:716-730`（"说点什么"） | **不许**写"你好，我能帮你做什么"（v6 人格硬规则禁止留客式追问） |
| 通着 | 正常 | — | — |
| 服务重启中 | **抽色变灰**（亮度矩阵）+ `IgnorePointer` + 一句说明 | 「正在恢复连接…」 | 【实测 `:421-449`】 |
| 恢复后 | 自动变回 | 「我已经升级好了。」 | 服务端判定（协议 R14），客户端只说服务端让它说的 |
| 有任务在跑 | 展开：整条"还有件事在处理"；**收起：标题行 `⏱N` 小标** | 不显示百分比 | 【实测 `:615-648`、`:558-574`】R6 |
| 发送失败 | 气泡留在时间线上 + 重试入口 | 保留原话 | 【实测 `:417-421`】 |
| 截断 / 失败收尾 | **作为正常气泡**显示 | 「这条我没能给出结论」 | 【实测 `answer_bubble.dart:70-81`】 |
| 助手主动打断 | 升起覆盖（含小程序场景） | 话术由服务端给 | 【实测 `answer_bubble.dart:47` 注释】 |
| 小程序装/更 | 卡片上的小标 | 「已装好」/「有新版本」 | ➕ 新增 |
| 小程序加载失败 | 卡片内提示 + 可重试 | 「打开失败，我换成上一版再试」 | ➕ 新增（N11） |

---

## 八、无障碍与键盘

| 项 | 设计 | 标记 |
|---|---|---|
| 语义标签 | 抓手 = "调整聊天窗口高度"；收起条 = "展开对话"；任务小标 = "还有 N 件事在处理"；小程序卡片 = "打开<名字>" | 【推定】 |
| **触控 ≥ 44×44** | 视觉仍 `20`（现状 `iconSize:20 + VisualDensity.compact`，实测 `:847-859`），**用透明 padding 撑命中区到 44** | UI 稿 §七 ⚠ |
| 对比度 | 正文与浮窗底色 ≥ 4.5:1；来源（11px）与底色 ≥ 4.5:1 | 【推定】 |
| 键盘 | `Esc` 收起 / `Cmd·Ctrl+K` 聚焦输入 / `Enter` 发送 / `Shift+Enter` 换行 | 【推定】 |
| 字号放大 | 系统 1.3× 时收起高度**按内容撑开**：`_collapsedH` 由 `const 124` 改为 `124 × clamp(textScale,1.0,1.3)` | ⚠ 与现有 `const` 冲突（见 §13 第 8 条） |
| 减少动效 | `MediaQuery.disableAnimations == true` ⇒ 全部瞬时切换 | 【推定】 |

**⚠ 与现有测试的关系**：把 `_collapsedH` 从常量改成函数后，`floating_panel_test.dart` 的
"收起后明显变矮"（`:103-122`）仍成立，但**"高度 = 124"这类硬断言今后不许写**（会被字号缩放打破）。

---

## 九、三种屏幕形态

| 形态 | 宽度 | 浮窗 | 小程序 | 理由 |
|---|---|---|---|---|
| 手机竖屏 | `< 600` | 左右 10，跟随屏宽 | 整页（浮窗之下） | 【沿用】 |
| 手机横屏 / 小窗 | `600–900` | 最大宽 `720` **居中** | 整页 | 【推定】 |
| 桌面 / 网页 | `> 900` | 收起态**外壳横跨**；展开态最大宽 `760` 居中；内容限宽 `760` | 整页 | 【推定】+ 拍板第 8 条 |

- **不做侧栏/停靠**（主人明确要"覆盖"）。
- 桌面/网页上 `Esc` / `Cmd+K` 生效；手机上位移动端手势（双击抓手）。
- 键盘弹出时：现有实现靠 `Scaffold.body` 自动上移（实测 `:248` 注释），**保持**。

---

## 十、错误与降级

| 情形 | 表现 | 收口 |
|---|---|---|
| **断网 / WS 断线** | 整块灰 + 不可触达 + 「正在恢复连接…」；重连**不限次数**、退避封顶 `8s`【实测 `websocket_transport.dart:26-28`】 | 恢复即自动变回；不需要用户做任何事 |
| **令牌失效** | 传输层清令牌 + 抛 `unauthorized`【实测 `:95-99`】⇒ 控制器回登录页【`chat_controller.dart:224-228`】 | 未登录时**只显示登录页**，一个字的对话都不露（`main.dart` 注释） |
| **版本太老**（`minShellVersion`） | **不安装**，卡片提示"这个小程序要更新客户端" | 不是白屏；不阻塞其他小程序 |
| **hash 校验失败** | 拒绝加载 + 切 `last-known-good` + 上报 `miniapp/load-failed` | 一句人话（"打开失败，我换成上一版再试"） |
| **小程序崩溃** | Web：iframe 天然隔离，壳不受影响；原生：回调 ⇒ `failed` + **只重试一次** | 再失败就报错（不死循环） |
| **制品下载失败/超时** | `failed{download-timeout}` + 可重试 | `30s`【推定】超时 |
| **`ready` 超时** | 视作打开失败 | `5s`【推定】 |
| **`/api/version` 问不到** | **不刷新**（实测 `:286` "绝不因为一次网络抖动把用户的页面刷掉"） | 保持 |
| **刷新护栏命中** | 停在"版本对不上"，不自刷 | 实测 `shouldSkipReload` |

---

## 十一、测试与验收

### 11.1 现有测试必须继续成立

| 文件 | 断言 | 为什么不能掉 |
|---|---|---|
| `test/widget/floating_panel_test.dart` | ① 最大化高度 `> 屏高 × 0.8` 且**四边留边距**（左右对称）；② 阴影 **≥2 层** + 圆角非空；③ 助手一开口也拉满 | 这是"它是个浮窗、不是整屏"的唯一证据 |
| 同文件 | 点标题行能收起/展开、收起后输入条还在 | R6（状态不被浮窗吃掉） |
| 同文件 `:170-189` | 收起态不显示整条状态栏，但**有 `Icons.schedule` 小标** | R6 |
| `test/widget/panel_interaction_test.dart` | 点浮窗**里面**不收起 / 点外面才收起 / 只收不放 / 只铺 10 条 / 上滑放更早 | 手势与分页 |
| `test/widget/offline_test.dart` | 灰化 = **真抽色**、不可触达、恢复自动、"我已经升级好了" | R13/R14 |
| `test/widget/agent_panel_test.dart` | 开发卡片（进程/内存/重启次数）、关掉开发者模式不订阅 | 遥测 |

### 11.2 新增测试（**每条都要能跑**）

| # | 测试 | 断言 | 为什么重要 |
|---|---|---|---|
| 1 | **聊天永远在最上** | 打开小程序后，对浮窗中心坐标做 hit test，命中的是**聊天**而不是小程序 | Z1（"悬浮于一切之上"） |
| 2 | **被盖住不重建** | 小程序里放自增计数器 State；浮窗展开→收起，计数**不变** | Z2（reload 会丢用户正在做的事） |
| 3 | **收起态不压住可点元素** | 小程序最后一个按钮 rect 与浮窗 rect **不相交** | `bottomInset` 的正确性 |
| 4 | **收起前后输入框 byte 一致** | 输入未发送文本 → 自动收起 → 文本仍在（`String` 级相等） | 周慎附加约束 B |
| 5 | **拦截层收起时必须消失** | 收起态下小程序按钮可点（计数器能自增）；展开态下点可见区域 ⇒ 计数不变且浮窗收起 | "最容易写错的一处" |
| 6 | **命中区 ≥44 且高度仍 124 且 RenderFlex 回归通过** | `tester.getRect` 量命中区；`_collapsedH == 124`（1.0 字号下）；不出现 overflow | 两个约束打架（v6 附五踩过 `overflowed by 6.5 pixels`） |
| 7 | **覆盖退让数值** | 展开时小程序层 `scale ≈ 0.98`、压暗 `alpha ≈ 0.35` | UI 稿 §4.2 |
| 8 | **令牌不出现在小程序侧** | 静态扫 `hupo_auth_token|Bearer|Authorization` 在 `mini/` 命中 0；运行时探针拿不到令牌 | N1/N2 |
| 9 | **scheme 白名单** | `javascript:` / `data:` / `vbscript:` / `file:` 一律不 launch，且提示被拦 | 现有线上路径 |
| 10 | **manifest 校验** | 缺 `sha256` / 路径穿越 / `minShellVersion` 过高 ⇒ 各自被拒且提示不同 | §4.1 |
| 11 | **`connect-src 'none'`** | 小程序内 `fetch(...)` 失败；壳仍能下载制品 | §4.2 |
| 12 | **崩溃隔离** | 小程序抛异常 ⇒ 壳仍可交互、浮窗仍在 | §4.3 |

---

## 十二、需要你审阅的点

| # | 决策点 | 选项 | 我的建议 | 代价 |
|---|---|---|---|---|
| 1 | **拦截层的覆盖范围** | (a) 全屏覆盖（除浮窗）(b) 只覆盖小程序露出的区域 | **(a)** —— 实现简单，且浮窗在其中之上，语义清楚 | 展开态时桌面点击也被吃掉（但那时桌面本来就看不见） |
| 2 | **被盖住的小程序：保留可见还是省开销** | (a) 保留 paint（压暗+缩小，**看得见退让**）(b) `Offstage` 省 paint（**看不见退让**） | **(a)** —— 主人要的是"覆盖"的观感；`Offstage` 会让 UI 稿 §4.2 失效 | 一点 paint 开销（一个 WebView/iframe 仍在渲染） |
| 3 | **`say` 通道本轮开不开** | (a) 关（照拍板）(b) 开（照任务书 §5 的形状） | **(a) 关** —— 它是一条提权回路；形状保留、能力位 `false` | 小程序暂时不能"跟助手说话"，只能单向被生成 |
| 4 | **iOS 商店版不发运行时** | (a) 编译期 flag（`--dart-define`）(b) 运行期开关 | **(a)** —— 运行期开关在审核眼里仍是"有这个功能" | 需要多一套构建参数 |
| 5 | **字号 1.3× 与 124** | (a) 按 `textScale` 缩放收起高 (b) 用测量结果撑开 | **(a)** —— 简单、无跳变；上限 `1.3` 封顶 | 极端字号下可能仍偏紧，靠上限兜住 |
| 6 | **小程序"不联网"的表述** | (a) 写成"小程序文档不能发请求、壳可以下载" (b) 笼统写"不联网" | **(a)** —— 否则实现者会以为连制品都不能拉 | 需要在文案上多解释一句 |

---

## 十三、与 v7 的冲突（**我没有自行改，列在这里**）

| # | 冲突 | 双方说法 | 我的处理与建议 |
|---|---|---|---|
| 1 | **`source` 同一字段两套取值域** | §3.1：`source`/`provenance` 是 `owner/product/derived/foreign`；§3.3：`message/start.source` 是 `owner` / **`app:<id>`** | 若按 §3.1 的四值，小程序的输入只能是 `foreign` ⇒ **界面拿不到"是哪个小程序"**。建议：把两处拆成两个字段 —— `provenance`（四值，决定能力档）+ `originApp`（`appId`，只用于显示）。**需要契约确认** |
| 2 | **制品由谁下载** | §4.4 写"L1 收到 `app/update-available` → 下载"；但 §10/拍板要求小程序 `connect-src 'none'` | 不冲突，但措辞会被误读成"小程序自己下载"。建议 §4.4 明确写"**壳**下载"。本文按"壳下载"实现 |
| 3 | **`app/installed` 的权威方** | §3.3 把 `app/installed` 列为 **L2 → L1** 事件；但"装好了"是**客户端本地事实**（服务端不可能知道） | 建议：`installed` / `error` 是**本地状态机**事件（不上行、不进正史）；L2 只发 `app/update-available`。若 S6 要做"小程序行为面"，需要**新增上行端点**（如 `POST /api/app/report`）—— **契约里没有，需补** |
| 4 | **`miniapp/load-failed` 命名不一致** | 现有事件前缀是 `message/ task/ user/ client/ app/ error`；`miniapp/` 是新的第四个家族 | 建议统一为 `app/load-failed`（与 `app/*` 同族）。**改动需契约确认**，本文先按契约写 `miniapp/load-failed` |
| 5 | **`/api/miniapp/*` 端点缺失** | 任务书 §5 要求 `storage`（容器代管）；但 §3.2 的接口表里**没有** `/api/miniapp/<id>/kv`（也没有 `say`/`proxy`） | 本轮 `storage` / `say` 都不启用 ⇒ 暂时不需要端点。**建议明确写进契约**："本轮不提供 `/api/miniapp/*`"，否则实现者会去找它 |
| 6 | **"不做离线/版本" vs 契约保留** | 周慎主张砍掉版本/离线；但 §3.6 保留 `mini/store.dart`（版本目录 + `last-known-good`）、§3.3 保留 `miniapp/load-failed` | 本文**按契约实现**（因为"回退"是 N5 可回退的一部分）。建议在 §13 S2 的"内容"里补一句"含版本校验与回退"，免得与周慎的裁断混淆 |
| 7 | **`conversationId` 迁移落点未定** | §3.1 要求 `u_<userId>:c_<name>`；客户端现在硬编码 `c_main`（`main.dart:176`）、支持 `?conv=`、测试与 mock 用 `c_test`、探针用 `c_probe`，而 §3.1 说"存量走兼容映射" | **谁负责规范化？** 若客户端拼，`?conv=` 与测试都要跟着改；若服务端兼容映射，客户端可以晚点动。建议：**客户端提供 `userId`，服务端做一次映射并回写规范 id**（客户端把服务端返回的 id 存下来）。**需要拍板** |
| 8 | **灰化范围未定义** | 协议 R13 说"下行不通时界面变灰且不可触达"；但本层有"本地已装小程序"这个不依赖 L2 的部分 | 建议明确："**灰化只覆盖对话浮窗**；已安装的小程序仍可用"。否则一次 WS 抖动会让整机看起来死了（违反 N7） |

---

## 十四、一句话

**这一层的全部新增风险只有一个来源：它要执行 agent 写出来的代码。**
所以本文的所有取舍都指向同一件事 —— **让那块代码拿不到任何东西**：
不同源、不给令牌、不给原生桥、不给网络、不给权限、被盖住也不重建。
其余部分（浮窗三档、协议六条、灰化、刷新护栏）都是**已经跑通**的东西，本层只做"挪一层 + 补五件"。
