# 170 · 产品名 = 「琥珀聊天」（一处出处 + 静态壳逐字钉住）

> **主人 2026-10-03 原话**：
> *「聊天那个，叫助手。页面在浏览器也成了助手。我们叫琥珀聊天。」*
>
> ⇒ 定案写进手册 `05-DECISIONS.md` **`D1.5`**（升 **v2.37**）：产品名 = **「琥珀聊天」**，
> **浏览器标签页** · **"添加到主屏幕"之后的图标名** · **聊天窗口抬头**三处逐字用它。
> **品牌名「琥珀」不动**（登录页 / 首页那一格，`landingBrand`）—— 两个词不是一个词。

---

## 一、改之前是什么样（不是"设计选择"，是**已经不一致**）

| 那一处 | 原来写的 | 谁看的 |
|---|---|---|
| `lib/main.dart` 的 `MaterialApp.title` | `'助手'` | 浏览器标签页（Flutter web 会用它改 `document.title`） |
| `lib/screens/chat_screen.dart` 浮窗 `title:` | `'助手'` | 聊天窗口抬头 |
| `web/index.html` 的 `<title>` | `助手` | 标签页（首帧、JS 还没跑起来时） |
| `web/index.html` 的 `apple-mobile-web-app-title` | `助手` | iOS 添加到主屏幕后的图标名 |
| `web/manifest.json` 的 `name` / `short_name` | `助手` | Android / 桌面 PWA 的图标名 |
| **登录页 / 首页的标志**（`BrandMark` → `landingBrand`） | **`琥珀`** | 那两屏的抬头、版权行 |

⇒ 上面 5 处与最后一行**本来就不一样**。手册 `01-PROJECT.md` §6.1 的登录页定稿图与
`05-DECISIONS.md` 的 `D2` 定稿文案**也还写着「助手」** —— 那描述的是 2026-09-22
"统一页面风格"**之前**的那一屏（那次登录页改成跟首页共用一个标志）。
**按手册纪律**（代码与手册不一致 ⇒ 先按代码确认事实，再回来改手册）：这两处一起更正。

---

## 二、改成了什么

**一处出处**（新）：

```dart
// lib/models/landing_words.dart
const String landingBrand = '琥珀';      // 品牌名：标志那一格 + 登录页 / 首页抬头
const String appName      = '琥珀聊天';  // 产品名：标签页 / 主屏幕图标名 / 聊天窗口抬头
```

三处 Dart 侧 + 两处静态壳：

| 文件 | 改成 |
|---|---|
| `lib/main.dart` | `title: appName` |
| `lib/screens/chat_screen.dart` | `title: appName` |
| `web/index.html` | `<title>琥珀聊天</title>` ＋ `content="琥珀聊天"` |
| `web/manifest.json` | `"name": "琥珀聊天"` / `"short_name": "琥珀聊天"` |
| `docs/handbook/01-PROJECT.md` §6.1 | 定稿图第一行 `助手` → `琥珀`（＋一行说明两个词） |
| `docs/handbook/05-DECISIONS.md` | 新增 `D1.5`；`D2` 定稿文案那一格 `助手` → `琥珀` |

⚠️ **静态壳那两份是脚手架的字符串，import 不了 Dart** ⇒ 光写 `appName` 管不到它们。
**判据把它们钉回同一个常量**（见下）—— 这是"一处出处"能成立的那一半。

---

## 三、判据

| # | 判据 | 在哪 | 读数 |
|---|---|---|---|
| ① | 静态壳那两份与 `appName` **逐字相同**：`<title>$appName</title>` · `content="$appName"` · `manifest.name` · `manifest.short_name` | `test/unit/web_shell_test.dart`（**硬闸**，`check-client.sh` 会跑） | ✅ 过 |
| ② | 聊天窗口抬头那个字**就是** `appName` | `test/widget/chat_header_test.dart` | ✅ 过 |
| ③ | 浮窗标题那颗 `Text` 的字号仍 ≥16（名字是这一屏的主） | `test/widget/floater_actions_test.dart` | ✅ 过 |
| ④ | 「点浮窗内部不许收起」那条老判据**照旧**（点的是标题那几个字，字变了照样点得中） | `test/widget/desktop_floater_test.dart` | ✅ 过 |
| ⑤ | 五档字号下**不溢出**、命中区 ≥44 | `test/widget/accessibility_test.dart`（硬闸） | ✅ 过（名字从 2 字变 4 字，这一条正是要看它撑不撑得住） |
| ⑥ | 禁用词闸 | `test/unit/forbidden_words_test.dart`（硬闸） | ✅ 过（「琥珀聊天」不在禁用词里） |
| ⑦ | **线上真的是它** | 取 `https://w.stalkerai.cn/` 与 `/manifest.json` | ✅ `<title>琥珀聊天</title>` · `apple-mobile-web-app-title=琥珀聊天` · `manifest.name=琥珀聊天` |
| ⑧ | 浏览器那条路（V13） | `HUPO_TOKEN=… node scripts/check-web-browser.mjs` | ✅ 通（1 条 WebSocket、202 帧、令牌续期） |

**整条硬闸**：`bash scripts/check-client.sh` → **✅ 硬闸全过**（analyze ＋ `test/unit` ＋
`test/widget` 全量 ＋ 可访问性那组）。

---

## 四、没动什么（**明说，免得以为什么都改了**）

| 没动 | 为什么 |
|---|---|
| **登录页 / 首页的品牌名 `琥珀`** | 那是另一格（`landingBrand`）；主人说的是聊天那一格与浏览器那一页 |
| **APK 桌面上的名字（`android:label="琥珀"`）** | 那是安装到手机桌面上的名字，主人没提；`android_manifest_test.dart` 照旧钉着它 |
| **设置 / 发现 / 空态里那些句子里出现的"助手"** | 那些是**句子**（"跟助手说一声就行"），不是**名字**；改它们要另拍 |
| **协议字段、服务端** | 一个字没碰 |

---

## 五、如实说：**没能用浏览器"看"到展开后的抬头**

`scripts/check-web-browser.mjs` 那条路**通了**（页面开得开、流接上、令牌续期），
但它们**驱动不了画布**：合成鼠标/指针事件进不了 `flt-glass-pane`（脚本文件头记着这条限制），
而无障碍语义树在这一版上**只在收起档稳定**（点 `flt-semantics-placeholder` 后
`aria-label` 时有时无，抓不到那个「展开」节点）。

⇒ 所以**"抬头那四个字真的画在屏幕上"** 这一条，今天能给的证据是：
**判据 ②**（widget 层，真建出那个 `Text` 并断言它等于 `appName`）＋
**收起档的截图**（`/tmp/hupo-chat.png`：桌面、展开入口、输入条都在，没有溢出）。

⚠️ **不要**把这段话读成"看过了" —— **展开后的那一屏没人眼确认过**。
