# `R2-ENGINEERING.md` 的独立评审（三席）

> **被审对象**：`docs/design/R2-ENGINEERING.md`（目标态工程文档）
> **三席**：契约可执行性 / 协议 v2 可实现性 / 索引完整性与批次一致性
> **标准**：与上一轮相同——**必须去代码里核，不许只读文档**。
>
> **结论一句话**：文档的**方向对，但细节里有一批"凭空写的""漏的""自相矛盾的"**，
> 而且**协议 v2 八个字段里有三个没有数据源**。
> 另外它还漏掉了**两个今天就在咬人的 bug**——那两条比文档里任何一条都急。

---

## 〇、最要紧的两条（**今天就在咬人**，与文档错误无关）

契约席在核 §四 时顺手挖出来的，两条都不是"将来会炸"，是**现在就在炸**：

### ★ 一、退出「会话」应用里的任意一个会话，会打死**全站连接**

```
main.dart:114            只造一个 transport
  ├── :116  给主 controller
  └── :195  给 ChatScreen → chat_screen.dart:223 MiniAppEnv
              → app_registry.dart:34 → conversation_list_screen.dart:81
                            ↑ 同一个实例（事件流是 broadcast，:207）

退出那个会话时：
  conversation_list_screen.dart:88   controller.dispose()
    → chat_controller.dart:442       _transport.dispose()
      → websocket_transport.dart:306-308   关掉 _events / _devSteps / _agentSnaps
        → _disposed = true ⇒ _open():155 永不重连
```

⇒ **主屏从此一条消息都收不到，而且不会自己恢复。**
这是"批 0-a"要解决的那个决策的**最硬理由**——它已经不是"设计不干净"，是**用户会遇到的路径**。

### ★ 二、升格过的轮次，180s 硬收口**彻底失效**

```
session-translate.js:209   this.current = { turn, writer, ... }
session-translate.js:219   this.opts.onTurnStart?.(this.current)
                           ⇒ dispatcher 拿到的 info **就是** translator.current 本身（同一个对象）
dispatcher.js:617          this.turns.set(info.writer.messageId, info)    ← 存的是「当时」的 messageId

handoffTimer（短）先到：
  dispatcher.js:604        this.turns.get(info.writer.messageId) === info  ✅ 匹配
  → #escalate(:700) → handoff()
      session-translate.js:288   cur.writer = new MessageWriter(…newId('m')…)
                                 ↑ cur === this.current === info
                                 ⇒ **info.writer.messageId 被隔着一层改掉了**

deadlineTimer（长）后到：
  dispatcher.js:611        this.turns.get(info.writer.messageId)  ← 现在是**新** id
                           ⇒ undefined !== info ⇒ **直接 return，永不收口**
dispatcher.js:623          this.turns.delete(info.writer.messageId)  ← 删**新** id
                           ⇒ **旧键永久残留**（:792 shutdown 还要遍历）
```

⇒ **N19（挂起必有收尾）与 §3.4（D7 超时收敛）在这条路径上同时落空。**

> **⚠️ 机制的精确说明（我复核代码后的更正）**：不是"两套 id 语义不同"那么简单，
> 而是 **`info` 与 `translator.current` 是同一个对象**，`handoff()` 原地换 `.writer`，
> 于是 **dispatcher 手里的 `info.writer` 在它不知情的情况下变了**。
> 这解释了为什么它藏得住：**dispatcher 全文没有一处给 `info.writer` 赋值**，
> 单看 dispatcher 会以为这个 id 是稳定的。
>
> **因此修法比评审建议的更简单**：不需要"把 `turnMessageId` 变成接口"，
> 直接**用 `info.turn` 当 `this.turns` 的键**——`turn` 号在一轮内**构造上就不会变**，
> `handoff` 也不碰它（`:202` 已随 `info` 一起给出）。
> `turnMessageId` 那个 Map（`:146/:199`，全库只写不读）在这个用途上**根本用不着**。

⚠️ 而我文档里那句"取号通道靠 `current.writer.messageId`"——**照它改只会把这个错键固化**。

---

## 一、文档里**凭空写的 / 写错的**（5 处）

| # | 文档写的 | 实际是 |
|---|---|---|
| **W1** | §一 禁令 3："`apps/` **不许** import `'../screens/'`" | ⚠️ **今天就已经违反了**：`apps/conversations_app.dart:11` import `screens/conversation_list_screen.dart`。而且"只通过 `MiniAppEnv` 拿能力"在 **5 处**被违反（`mini_app.dart:15`、`weather_app.dart:14-15`、`about_app.dart:8-9`、`dev_mode_app.dart:10-11`、`conversations_app.dart:12`） |
| **W2** | §一 箭头图把 `apps/` 画在最上 | ⚠️ **漏了一条现存倒挂**：`widgets → apps` —— `app_desktop.dart:12`、`mini_app_container.dart:11` 都 import `'../apps/mini_app.dart'`（要 `MiniApp` 类型）。**是双向依赖，不是单向** |
| **W3** | §一 "拆完 `chat_screen.dart` ≤ 300 行" | ❌ **不成立**。按我列的六件只能抽走 ≈308 行，**剩 ~385 代码行 / ~500 总行**。要 ≤300 必须**再抽第七件 `message_list`**（`:466-502` + `:592-690` + `:691-745` ≈ 160 行），**我没列** |
| **W4** | §一 把"转屏吸附"写成"从 `chat_screen` 抽出" | ❌ **`chat_screen` 里没有任何转屏代码**（无 `didChangeMetrics` / `Orientation` / `MediaQuery`）⇒ **这是新功能，不是重构**。冒充重构会让排期失真 |
| **W5** | §一 §1.2/1.3 的现状数字 | ✅ 5791 / 866 / 客户端 3841 **全对**；但 **`services/core/src` 是 3914 行**（漏算 `auth-cli.mjs` 73 行）。另 `chat_controller.dart:420` 实为 **`:424`** |

### 还有两条"粒度/楼层"问题

- **`panel_geometry`（30 行）与 `timeline_pager`（30-60 行）比现有最小非桩文件还碎**（`transport.dart` 89 行）
- 而且 **`panel_geometry` 被判"无 material"，却要放进 `widgets/`——那个目录 4 个文件全都 import material** ⇒ **会找错楼层**（应放 `models/` 或新建纯逻辑层）

### 一条命名重复

> `title` **已经由 `dispatcher.js:701-703` 产出**（用户原话前 24 字）。
> 我文档里加的 `models/scope_name.dart`（从用户原话取词）**会跟它形成两套命名规则**。
> ⇒ 要么合并，要么写清"哪个是给界面看的、哪个是给列表看的"。

---

## 二、我说"必须写死"却**一个字没写**的（4 处）

| # | 我说必须写死 | 实际状态 |
|---|---|---|
| **Z1** | 全局 `seq` 与 `sinceSeq` 的语义 | ❌ **没写死，而且我写错了**。序号**分配在 3 处**（`conversation.js:42` emit、`:72` emitTransient、`:150` restore 取 max），**根本不存在的 `nextSeq` 函数**。而且"= 已落盘最大 + 1"与 `:72`"占号但不落盘"**直接冲突**：占号⇒磁盘必有空洞；不占号⇒不能叫"已落盘最大 + 1"、得用内存计数器。⇒ **§5.4 那条 N22"磁盘上不得出现空洞"今天就假**（`server.js:138` 的 `client/reload` 正是走 `emitTransient`） |
| **Z2** | P-3 的另一半"`tryParse` 必须容忍 `seq` 缺失" | ❌ **没写成本**。`stream_event.dart:53-54` 是 `if (seq is! int) return null;`，而 **`test/unit/timeline_test.dart:128` 钉着"缺 seq 的事件被拒"，test/unit 是硬闸** ⇒ 改 = 动基类 `final int seq` + **破一条硬闸测试** |
| **Z3** | `MessageWriter` 的契约 | ⚠️ 单 writer 内 `start → text* → end` **成立**（`:184-236`，`end` 幂等 `:225`），`handoff` **不破坏**它（先 `end` 再 `new`）。**但 `chunk()` 不查 `ended`（`:204`）**——持旧 writer 即可破序。现在只靠"没人持有"这个**隐性事实**，不是契约 |
| **Z4** | `current.writer.messageId` 当取号通道 | ❌ **根本错**。我要的是"**一轮**的身份"，给的是"**当前气泡**的 id"，而**这两个恰恰在 handoff 时会分叉**（§〇·二）。现成的 `turnMessageId` Map（`session-translate.js:146/:199`）**全库只写不读**——但**复核后连它都不需要**：直接用 `info.turn`（`:202` 已随 `info` 给出）即可 |

---

## 三、协议 v2：八个字段里，**三个没有数据源**

**席二的结论（逐条核过代码）**：

| 字段 | 能不能加 |
|---|---|
| `catchUp` | ✅ **能**，且改动小（`server.js:110-119`，补发唯一出口是 `:119`，包一层即可） |
| `step/summary` · `step/detail` · `step/reasoning` · `timeline/marker`（4 个新事件名） | ✅ **能**（`websocket_transport.dart:193/198/204` 的解析顺序**不撞车**——前两者是精确 type 匹配） |
| **`scopeId`** | ❌ **填不出**：在 `services/` 与 `apps/` **零出现**（`grep` 过）。现网身份只有 `conversationId`（`dispatcher.js:243`）与 `agent` 名（`conversation.js:193`） |
| **`source`** | ❌ **填不出，而且概念是错的**（见下） |
| **`reRefs[]`** | ❌ **填不出**：`re` 装的是 user **messageId**（`dispatcher.js:254-255`），`user/echo` 的 seq 被丢（`:245` 忽略 `emit` 返回值）⇒ 要 `{scopeId, seq}` 得先造 scopeId、再存 echo 的 seq |

### ★ `source` 与 `provenance`：**我把两个轴揉成了一个**

现网其实有**三条轴**：

| 轴 | 现状 | 回答什么 |
|---|---|---|
| **`origin`** | `nextProvenance()`（`dispatcher.js:549-556`）：有 pending 用户消息 = `reactive`、否则 = `proactive` | **为什么开口** |
| **`agent`** | `conversation.js:193` 发 `agent: 'agent'｜'dispatcher'`（`session-translate.js:203` vs `dispatcher.js:389/517/705`）——**已经在线上，只是客户端不读** | **谁在说** |
| **`source`**（我新加的） | 无 | ？ |

**席二的判断（我采纳）**：

> **`source` 与 `agent` 重复一半、与 `origin` 混淆一半。**
> `source` 枚举把 `user` 与 `dispatcher` 并列，可 `message/start` **永远是助手在说**；
> `user` 想表达的是"这条**替/回应用户**"——**那是 `origin` 的地盘**。

⇒ 要么**删掉 `source`**、用回 `agent` + `origin` 两条轴；
要么写清 `source` **替换** `agent` 还是**并存**，且 **`origin` 不许并进 `source`**。

### 三条规则（P-1/P-2/P-3）的裁决

| 规则 | 裁决 |
|---|---|
| **P-1** | ❌ **措辞错**。`seq` 是**每会话**的（`conversation.js:14`、文件头 `:3`），**不是"全局"**。正确的说法是"**会话内 seq vs 续传游标**"（客户端确有两个游标：`websocket_transport.dart:59/206` 的 `_sinceSeq`、`chat_controller.dart:52/249` 的 `lastSeq`） |
| **P-2** | ⚠️ **服务端已经成立、不需要新写**：`session-translate.js:195` 新轮先收旧轮；补发只是**重放日志**（`conversation.js:137-141`），**没有"条数"概念**。⇒ "不作用于补发段"**不是服务端规则，是客户端渲染规则**——**而我没写客户端怎么做** |
| **P-3** | ❌ **落不了，而且要动的最多**。`emit`/`emitTransient` **都强制发号**；`ServerEvent.seq` 是 `required int`，改可空会波及 `websocket_transport.dart:206`、`chat_controller.dart:249/376` 与**全部事件构造**。⇒ 而且 **P-3 与 `timeline/marker` 自相矛盾**：marker 要"占一个位置"（我 §2.2 写的），**无 seq 就没位置** |

### 还有三条我没写死的

1. **无 seq 事件的排序兜底键**。⚠️ **别顺手用 `at`**：本地发言的 `at` 是**客户端钟**（`chat_controller.dart:401`）、服务端事件是**服务端钟**（`conversation.js:42`），**混钟当排序键会乱**，而现网是**刻意避免混钟**的（`chat_controller.dart:71-77`）
2. **`step/reasoning` 的"默认关"怎么实现** —— 这是**唯一有泄露风险的字段**。
   现在唯一的开关是 `dev`（`server.js:96/116`），而 **`emit` 是落盘的**（`conversation.js:43-44`）⇒
   **reasoning 一旦进日志，之后任何新连接 `replay` 都会拿到，含系统提示片段。**
   ⇒ **必须 `emitTransient` + 按连接过滤，或单开通道**——"默认关"不能靠口头约定
3. **`catchUp` 是线上字段还是客户端推导**（客户端**已经有** `at >= _serverNowAtConnect` 划线，`chat_controller.dart:298-300`）
   ⚠️ 另：`main.dart:79` 的 `connect()` **默认 `resumeFrom=0`** ⇒ **首次打开也走 `replay`**，
   所以 `catchUp` 会**标全量历史**，不止"断线补发"

---

## 四、§六 那张索引表：**凭空、漏、错**

### 凭空写错的

| # | 我写的 | 实际 |
|---|---|---|
| **X1** | `docs/design/L1/L2/L3-*.md` | ❌ **不存在**——真名是 `L1-terminal.md` / `L2-dispatcher.md` / `L3-worker.md`，**没有 `L1/` 目录** |
| **X2** | `main.dart` 批 1 挂"B1 未知态" | ❌ 挂错：B1 在 `websocket_transport.dart:95`（`_noteUnauthorized`）/ `:105`；`main.dart:37/51` 只是装配 |
| **X3** | `websocket_transport.dart` 批 1 挂"B1 真根 WS 401" | ❌ **401 判定只在 HTTP `authStatus()`**（`:105/:110`）；**WS 握手失败走 `channel.ready.catchError`（`:170` 空 catch）+ `onError`（`:175`）**。MASTER-PLAN 引的 `:216` **实为 `_attempt++`** |
| **X4** | §五 "`test/widget` 现 **8 条挂 6**" | ❌ 实测是 **49 条挂 10**（我只是把 `floating_panel_test` 一个文件的数当成了全部）。逐文件：`floating_panel` 8挂6、`smoke_test` 12挂3、`panel_interaction` 5挂1 |
| **X5** | §五 引用 `store-append.test.js` / `seq-global.test.js` | ❌ **这两个文件不存在**（现有 8 个测试文件里没有） |

### 漏的（**存在且必改**）

| 漏了什么 | 为什么它必须进表 |
|---|---|
| §一 自列的批 3 那 **4 个 widget**（`panel_shell` / `panel_header` / `composer` / `user_bubble`） | **§六 一字没有**——自己在 §一 承诺了却在索引里丢了 |
| `widgets/dev_card.dart`(416) · `models/dev_step.dart`(50) | MASTER-PLAN 明改（D7），§六 无 |
| **`services/core/src/server.js`**(385) | `warm():99`、`/api/say:264`、**`emitTransient:138`（WS 401 根也在这条链上）**——准入/连接上限只能落这 |
| **`services/transport.dart`**(89) · **`mock_transport.dart`**(423) | **四态 / 401 / resend 都过 `Transport` 接口** ⇒ 改接口必动这两个 |
| `apps/app_registry.dart`(57) | `MiniAppEnv` 的装配点（W1 的修法落在这） |
| `apps/about_app.dart`(70) | 批 2 要写"不会拼音用不了"，被我含糊成 `apps/*.dart` |
| **§五 全部 7 个新测试文件** | **§六 0 处**——"新验收写 test/unit"是纪律，但索引里没落点 |
| `services/core/src/personality.js` · `debug-agent.js` | §六 无 |
| 批 6 的容器文件（Dockerfile / slice / cgroup） | §6.3 无 |

### 批次的**顺序错了**

> **`chat_screen.dart` 被批 1/2/3/5 碰，而我让批 3 才拆。**
> 但 **批 2 的验收要 `panel_geometry_test.dart`**（MASTER-PLAN 自己写的），
> **而 `PanelGeometry` 的抽取在批 3** ⇒ **顺序反了**。
>
> ⇒ **建议：纯函数拆分提到批 1 之后、批 2 之前**（或与批 2 合并）。
> 它还是"新验收能进 `test/unit` 硬闸"的**唯一出路**（widget 已 49 挂 10）。

**另外五处批次冲突**（§六 没写先后）：
| 冲突 | 建议 |
|---|---|
| `conversation_list_screen.dart`：批 3 加记忆清单、**批 4 账本出口还要碰**（§六 无批 4 格） | 补批 4 格 |
| `dispatcher.js`：批 4 能力接线 与 批 6 准入 **同落 `say()`** | 写死先后 |
| **env 白名单两个 owner**：§1.3 说 `dispatcher.#wire`、§四 说 `agent-runtime` | **以 `agent-runtime` 为准**（见 §五·炸点 3） |
| `models/timeline.dart`：批 1/2/4 三批碰 | 不互斥，但**批 4 客户端只这一格、没有任何账本界面/出口文件** ⇒ 补 |
| `auth.js`：批 1 TTL + 批 2 续期 | 写"**先 TTL、后续期**" |

### §三 的状态机里，**没有测试归属的**

| 状态机 | 状况 |
|---|---|
| **3.3 收起 / 回收站 / 真删（N24）** | ⚠️ **§六 / 七批里没有任何一批实现它** —— §三 写了，计划里没有 |
| **3.5 KV 两层** | ❌ **自相矛盾**：§3.5 标"批 4"，但 §1.3 把 `kv.js` 列进"**本轮不建**" |
| 3.4 D7 四档 | §五 无测试；H4"乱序保护 + 超时收敛"也无 |
| 3.6 工时账硬闸（隔 7 天 diff=0） | §五 未列 |
| 3.7 状态清单（备份/迁移/删） | **无测试、无文件、无批次** |
| §5.4 自称"每条不变量至少一个测试" | 实际**缺 N13/N14/N16/N17/N18/N21/N23** |

**反向**：§五 的五件纯函数里，**`MessageState` / 禁用词扫描 / `export.renderLedgerText()` 在 §一 全无归属文件**。

---

## 五、按这份文档改，会在哪炸（**契约席给的排序**）

| # | 炸点 | 为什么 | 文档的毛病 |
|---|---|---|---|
| **1** | **`store.append` 上抛 = 服务崩** | `append` 调用点 **1 个**，但 **`emit` 调用点 18 个**（dispatcher 12 / conversation 5 / server 1），**无一处 try**。最狠的路径是 `agent-runtime.js:300` ← `stdout.on('data'):117`，以及 `dispatcher:603/610` 的 `setTimeout`——**Node 里都是未捕获异常**（全库无 `uncaughtException`）⇒ **盘满 → 退出 → 重启 → 再盘满** | 我只写了"必须上抛"，**没写谁接** |
| **2** | **`turns` 键随 handoff 变**（见 §〇·二） | 收口彻底失效 | 我那句"靠 `current.writer.messageId`"**只会固化错键** |
| **3** | **env 白名单会漏** | `dsh` 是 node CLI，**丢 `PATH` 就回到 ENOENT**（`config.js:32`、`agent-runtime.js:105` 的注释里就是那个坑）；还需 `HOME`（读 `~/.dsh`）、`TMPDIR`、`LANG`，以及**部署侧注入的 `DSH_*` / 代理**——**仓库里没有 `.service` 文件，我也不知道有哪些，得先盘点**。另：`DSH_HOME` **当前无处设置**（只在 docs 与 `scripts/diagrams.mjs:585`） | 我说"白名单"却**没列白名单**；而且 §1.3 把它写进 `dispatcher.#wire`（**`:540` 拿不到 `cfg`**）——**与 §四 自相矛盾** |
| **4** | **淘汰缺接口** | `agent-runtime` 全文**没有 translator**，`_armEviction` 只能 `dispose`；"**先收口再卸**"必须由 runtime **回调 dispatcher**，而 §6.2 **没把 dispatcher 排进批 6**。**LRU 缺访问序**（`agent():342-354` 不更新顺序，`Map` 插入序 ≠ LRU）。`running === true` 跳过**可实现**，但 **return 不重新 `arm`** ⇒ **跳过一次 = 永久不淘汰** | 我只写了"只淘汰空闲的"，**没写谁回调谁** |
| **5** | **批 3 的出口早于批 4 的入口** | §6.1 把两处"（待接入）"改成"记忆清单 + 导出"，但 `kv.js` **明确不建**、`worklog` 在批 4 ⇒ **§四 的"写入与出口同批"被我自己的 §六 违反**。而且**今天根本没有面向用户的记忆写入点** | 自相矛盾 |
| **6** | **三条禁令无闸** | `analysis_options.yaml` 是 `flutter_lints` 模板，**加不了 import 禁令**；文档也没给闸。而禁令 3 落地**会拆掉「会话」应用那半页**（W1） | 写了规则，没写怎么强制 |

---

## 六、三席各自"只保三件"的交集

三席各给了三件，**交集非常清楚**：

| 保什么 | 谁提的 |
|---|---|
| **① 先定批 0-a：把 transport 的生命周期写死** | 契约席第 1、索引席第 1（同一件事：**退会话打死主连接**） |
| **② 序号契约写死（只留一个取号函数；瞬态占不占号二选一并写明后果）** | 契约席第 3、协议席第 1、索引席第 3 |
| **③ 修 `turns` 键：改用 `info.turn`** | 契约席第 2、协议席（隐含：两个 id 分清） |
| **④ `store.append` 上抛 + 先落盘再推** | 索引席第 1（契约席把它列成"必炸"第 1） |
| **⑤ 纯函数拆分**（`panel_geometry` / `timeline_pager`）**提前** | 索引席第 2、契约席第 6 |
| **⑥ 四态 / 失败可见 + 禁用词闸** | 索引席第 3 |

⇒ **修正后的第 1 批应该是这六件**，而不是 MASTER-PLAN 现在的 S1–S6。
**其中 ①②③④ 都是"今天的坑"，不是"将来的功能"。**

---

## 七、这次评审要改的文档

| 文档 | 改什么 |
|---|---|
| `R2-ENGINEERING.md` §一 | 禁令 3 改成"**已在违反，需先修**"；补 `widgets → apps` 倒挂；`≤300` 改成"需再抽 `message_list`"；"转屏吸附"从"抽出"改成"**新增**"；`panel_geometry` 换楼层；命名与 `title` 去重 |
| 同上 §二 | **`source` 删掉**（或写清与 `agent`/`origin` 的关系）；**P-1 改口径为"会话内 seq"**；**P-2 改到客户端**；**P-3 与 `marker` 的矛盾要裁决**；补三条"没写死的" |
| 同上 §四 | `current.writer.messageId` **改成"两个 id 分清"**；`store.append` 补"**谁接**"；env 白名单 **owner 统一到 `agent-runtime`** 并补"**要先盘点有哪些变量**"；淘汰补"**谁回调谁**" |
| 同上 §五 | `test/widget` 改成 **49 挂 10**；删掉两个不存在的测试名；补 §三 缺的测试归属 |
| 同上 §六 | 补 9 类漏掉的文件 + 4 个 widget + **全部 7 个新测试**；修 5 处凭空/写错；补批次冲突的先后 |
| `R2-MASTER-PLAN.md` | 批 1.5（纯函数拆分）**提到批 2 之前**；S6 拆出">900 两栏"到批 2；补 S7/S8/S9/S10 四件；批 6 补供给上限；`test/widget` 49 挂 10；`services/core/src` 3914；B1 落点更正 |
| `R2-DECISIONS.md` | 新增 **P-e … P-k 七条**（其中 **P-e / P-f 对应今天在咬人的两个 bug**）—— ✅ **已全部拍板取甲**；并新增 **P-l**（统一时间线的编号，批 0-a 剩下的另一半） |
| `docs/design/README.md` | 索引加入本文 |

---

## 八、待裁决清单（**从 §〇 到 §五 抽出来的**）—— ✅ **P-e…P-k 已拍板取甲；剩 P-l**

评审过程里浮出来的、**必须主人拍板**的七条。它们已写进 `R2-DECISIONS.md`：

| # | 待裁决 | 为什么现在定 | 推荐 |
|---|---|---|---|
| **P-e** | **transport 生命周期**（批 0-a 的核心） | ★**今天就在咬人**：退一个会话打死全站连接 | 甲：拆 `Connection` + 每会话一个 `Session` |
| **P-f** | **一轮的稳定键**（`turns` 用哪个 id） | ★**今天就在咬人**：升格过的轮次收口失效 | 甲：`this.turns` 改用 **`info.turn`**（`turn` 号构造上不变） |
| **P-g** | **P-3 的定稿口径** | 同时决定"动不动基类 + 破不破硬闸测试" | 甲："不占号 = 不上时间线"（零基类改动） |
| **P-h** | **`catchUp` 线上字段还是客户端推导** | 决定协议要不要多一个字段（且首次打开也走 replay） | 甲：线上字段，只在 `sinceSeq > 0` 时标 |
| **P-i** | **`source` 去留** | 决定协议里是否真有第三条轴 | 甲：删掉，用 `agent` + `origin` |
| **P-j** | **env 白名单的前置盘点** | 不盘点就写白名单 ⇒ **ENOENT** | 甲：先读生产机 unit 文件 |
| **P-k** | **上抛后的进程级策略** | 不接住就是**重启风暴** | 甲：`emit` 统一包一层 + 进程级 notice + 有界退出 + 退避重启 |
