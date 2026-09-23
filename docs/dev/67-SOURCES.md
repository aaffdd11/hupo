# 67 · 出处（「它替你查过的东西，是哪来的」）

> **哪来的需求**：`04-ROADMAP.md` §十二 第 2 条 ——*"用户要『点开看是哪来的』；
> **成本是一句话 + 一个字段**"*；主人 **2026-09-23** 在功能清单里选了它当第一件
> （原话：*"现在先要实现功能，性能问题我们相对放宽一些。"*）。
>
> **产品原则 2**（`64-CHAT-REDESIGN.md` §二）：**看不见的东西等于不存在** ——
> 助手说的话如果**查不到出处**，用户就只能"信它"。

---

## 一、动手之前的样子（**能力在、显示在、数据永远空**）

这是它值得先做的真正理由 —— 它是一条**暗**缺陷：

| 那一层 | 状态 |
|---|---|
| 协议字段 | ✅ **早就有**：`message-writer.js` 的 `end()` 一直发 `sources`（协议 **R8**） |
| 客户端显示 | ✅ **早就画**：`bubbles.dart` 会画最多 5 条 |
| **谁往里填** | ❌ **产品那条路上一个都没有**（只有 `src/index.js` 那个演示夹具给过） |
| 真机读数 | ❌ `message/end.sources` **实测 `[]`** —— 那个字段一直是空的 |

⇒ 换句话说：**屏幕上那一段永远不会出现**，而代码读起来像"这条功能已经做了"。

---

## 二、原料在哪（**上游早就给了，我们没接**）

dsh 的工具事件里就有（实测 `@deepseek-ai/dsh-tool-web` 的输出 schema 与事件类型）：

| 事件 | 形状 |
|---|---|
| `tool/call` | `{turn, step, callId, name, arguments}` —— **工具名在这条上** |
| `tool/result` | `{turn, step, message, error?, meta?}` —— **这条上没有工具名**；出处就在 `meta` 里 |

- `web_search` 的 `meta` = `{sources: [{url, title?, snippet?, publishedAt?}], truncated, answer?}`
- `web_fetch` 的 `meta` = `{url, statusCode, truncated}`（**没有 title**）

⚠️ 所以"哪件工具"要**自己配**：`tool/result` 上没名字 ⇒ 用 `turn:step` 去 `tool/call` 那一侧取
（`session-translate.js` 的 `#stepTools`）。

---

## 三、形状（**定下来的**）

| 项 | 定成什么 | 为什么 |
|---|---|---|
| 数据字段 | 还是那两个：`sources: [{title, url}]`（**协议不动**） | 字段本来就冻结了；客户端也早就在读它 |
| 谁算"名字" | **服务端**（`sources.js` 的 `sourceLabel`）：**有标题用标题，没有就用域名**（去掉 `www.`） | 与 dsh 自己那条规矩同口径 ⇒ 同一个来源不会有两个名字 |
| 认哪几件工具 | **只认 `web_search` 与 `web_fetch`** | 读本机文件、跑一条命令**不是"出处"** ⇒ 说成出处就是让用户以为那句话是从那儿来的 |
| 不带出去的 | `snippet` / `publishedAt` / `answer` / `statusCode` / 工具名 / 查询词 | 协议只冻结了 `{title, url}`；而且这条会**画在屏幕上**（不许内部词） |
| 坏载荷 | **空**（宁可不显示） | N10：不许猜 |
| 条数 | 服务端最多 **8** 条（`MAX_SOURCES`）· 客户端画前 **3** 条 + **如实报"还有 N 处"** | 与计划条"还有 N 件"同一条规矩：**宁可少画，不许少说** |
| 能点开吗 | **平台开得了才画按钮**（`services/links.dart` 的 `canOpenLinks`）；开不了 ⇒ **只当文字** | 界面上不许出现**按不动**的东西 |
| 打开方式 | 网页 = `window.open(url, '_blank')`；**只认 `http(s)`** | `javascript:` / `data:` / `file:` 一律不开（出处是模型查回来的东西） |

---

## 四、落在哪几个文件

| 层 | 文件 | 干了什么 |
|---|---|---|
| 服务端 · 纯函数 | `src/sources.js`（新） | `MAX_SOURCES` · `sourceLabel` · `sourcesFromToolResult` |
| 服务端 · 接线 | `src/session-translate.js` | `case 'tool/result'` · `#stepTools`（`turn:step` → 工具名）· 每轮攒 `rec.sources` · **收口时统一写进** `message/end`（`#endWriter`） |
| 客户端 · 字 | `lib/models/source_words.dart`（新） | 抬头"它查过这些地方" · `sourcesShown = 3` · "还有 N 处" |
| 客户端 · 画 | `lib/widgets/bubbles.dart` | `AnswerBubble` 新增 `onOpenSource`；能点就画按钮（命中区 ≥44），不能点就纯文字 |
| 客户端 · 平台 | `lib/services/links{,_web,_stub}.dart`（新） | 网页能开、别处开不了（**零新依赖**，与 `mini_runtime.dart` 同一条条件导出） |
| 客户端 · 装配 | `lib/screens/chat_screen.dart` | `onOpenSource: canOpenLinks ? openExternal : null` |

---

## 五、判据（**这一批 +19 条**）

**服务端 `test/sources.test.js`（12 条）**

- 纯函数：`web_search` 多条（有标题用标题、没标题用域名）· `web_fetch` 一条 ·
  **只认那两件工具**（别的工具喂进来一条都不算）· **坏载荷 ⇒ 空**（含 `javascript:`/`file:`）·
  同页去重 · 条数封顶 · 🔴 **只带 `title`/`url` 两个字段**
- 真跑翻译层：查过 ⇒ `message/end.sources` 真的有（带 `seq`）·
  🔴 **负向对照**：没查过 ⇒ **空的**（字段一直在，是 `MessageWriter.end()` 本来就带的）·
  🔴 **工具名 / 查询词 / callId 一个字节都不进那条事件** ·
  🔴 **第二轮不许继承第一轮的出处** · 查完才断的轮**照样带出处**

**客户端 `test/widget/sources_test.dart`（7 条）**

- 有出处 ⇒ 抬头 + 那几行（标题优先）· 🔴 **点一下真的把那个地址交出去** ·
  🔴 **开不了的时候不许画按钮**（负向对照）· 🔴 没有出处 ⇒ 抬头一个字都不画（负向对照）·
  超过三处 ⇒ 画三处 + **如实报数** · 3.1 倍不溢出 · 服务端没给标题时用地址兜底

**可访问性硬闸（`test/widget/accessibility_test.dart`，+2 条 × 五档）**

- 「出处那几行拉满」的主界面在 **1.0/1.3/1.75/2.0/3.1 倍**下都不溢出
- 能点开时那两行的**命中区 ≥44**（D3.6）——⚠️ 测试环境里 `canOpenLinks` 是假，
  所以这一条**把回调注入进气泡**直接量（见下）

**变异验证**：把 `case 'tool/result'` 那行注释掉 ⇒ `test/sources.test.js` **3 条红**；
还原 ⇒ 12 条全过。

---

## 五·补、**真机验证**（2026-09-23 · 拿测试租户 `u2` 真跑）

| 验的什么 | 怎么验的 | 读数 |
|---|---|---|
| 上游的出处**真的接进来了** | 给 `u2` 发一句真问题（*"帮我查一下今天北京的天气，并且告诉我你是从哪儿看到的"*）→ 读**他那一份**时间线 | `message/end.sources` = **4 条真 URL**（`weather.com.cn` ×2 · `wttr.in` ×2）——⚠️ 上游这次**没给标题** ⇒ 按设计显示**域名**（那是实话，见 §七） |
| 屏幕上**真的画出来** | 真浏览器打开 `w.stalkerai.cn`（`u2` 的令牌）→ 展开浮窗 → 滚到底 → **读无障碍语义树** | 树里出现 **「它查过这些地方 还有 1 处」** —— 4 条只画 3 条 + **如实报数**，与设计逐字一致 |

🔴 **这一趟顺手把"看一眼"这条路修好了**（`scripts/check-web-browser.mjs`）：
· **合成鼠标/指针事件送不进 Flutter 的画布**（pointer 与 mouse 都在 `flt-glass-pane` 上派过，**页面逐像素不变**）
  ⇒ 原来 `--click-at` 那一套在"展开浮窗"这种地方**是无效的**（我试了四次，每次截图 sha 都一样）；
· ✅ **打开无障碍语义树之后 DOM 里就有字了**：`flt-semantics-placeholder` 一点，
  `flt-semantics-host` 的 `innerText` 就是屏幕上的字（**近似** —— 它含**没在视口里**的列表条目，
  所以"在树里" ≠ "在屏幕上"，看屏幕仍然要看截图），而且语义节点**收得住 `click()`**（浮窗就是这么展开的）；
· ✅ **滚轮事件有效**（`flt-glass-pane` 上派 `WheelEvent`）。
⇒ 新加了一个 `--eval "<js>"`（可多次，结果打出来）；三条经验都写进了脚本头。
⚠️ **"Flutter web 的 DOM 里没有文本"这句话从现在起要加个前提**：**默认**没有，
  **打开无障碍树之后有**。

---

## 六、⚠️ 顺手修好的：**命中区那道闸自己的一个洞**

量命中区那个 `sweep()` 原来这么找按钮：

```dart
for (final type in <Type>[IconButton, TextButton, FilledButton, ElevatedButton]) {
  for (final e in find.byType(type).evaluate()) { … }
```

🔴 **`find.byType` 只认"精确类型"**，而 `TextButton.icon(...)` / `FilledButton.tonalIcon(...)`
造出来的是**子类**（`_TextButtonWithIcon`…）⇒ **那些带图标的按钮从来没被这道闸量过**。
它为什么一直没人发现：`sweep()` 结尾有一条"一个都没扫到就红"的负向对照，
而**顶栏那几个图标永远在** ⇒ `checked > 0` 恒成立 —— 这正是"**闸在替自己作假**"的形状
（判据 **V13** 的那一族：闸打在替代物那一侧）。

**修法**：改成 `find.byWidgetPredicate((w) => w is ButtonStyleButton)`（子类也认）。
修完**没有抓到既有的违规**（说明别处那几`.icon`按钮本来就合格），
而**新加的出处那几行真的被量到了**（修之前那一条是 `checked == 0`）。

---

## 七、这一版**没做**的（**明说**）

| 没做 | 为什么 |
|---|---|
| 不显示 `snippet` / 日期 | 协议只冻结了 `{title, url}`；要加先改协议（那是另一件事） |
| 不做"正文里的 `[1][2]` 引用角标" | 那要在**回答正文**里插锚点，等于改协议的形状；先做"下面列出来" |
| 不在站内打开（内置浏览器） | 网页上没有这个出口；开新标签页是最不意外的那种 |
| 不按站点分组 / 不显示"查了几次" | 用户要的是"哪来的"，不是统计 |

⚠️ **上游给不出标题时**（有些搜索提供方不给 `title`）⇒ 显示域名。
**那是实话**（"这一条来自 weather.com.cn"），不是缺陷；但**如果长期都是域名**，
说明那份搜索源该换 —— 那时候再说。
