# H 组实测记录（9 条待验前提）

> 产品面板第二轮把 9 条技术前提列成了"H 组：**只能当前提，不能当论据**"。
> 这份文件是它们的验证结果。
>
> **纪律**：每条都给**出处**（本机 DSH 安装的包 + README 原话，或本机实测命令），
> 拿不到确定答案的**明说"待验"**，不许拿推测当结论——
> 第二轮的教训就是一位 PM 拿"`sudo` 免密"这个没复核的事实当论据改了判，结果前提是错的。

---

## 汇总

| # | 要验什么 | 结论 |
|---|---|---|
| M1 | 注入能否**只追加、不改前缀** | ✅ **能，有原生开关** |
| M2 | 有没有第三条"非用户来源"入口 | ❌ **没有，只有两条**；但第二条**原生带来源标记** |
| M3 | **读**能不能被限制 | ⚠️ **bash 能限、fs 工具不限**；网络与进程可见性不保证 |
| M4 | `session-reference` 能否**主动触发** | ✅ **能，host 有 API** |
| M5 | fork 带多少历史、能否换 root | ✅ **能只切一段**；⚠️ 换 root **待验** |
| M6 | 一进程多 session vs 每工作区一进程的内存差 | ⚠️ **两个跑法差 4 倍**（195MB vs 785MB） |
| M7 | `openWorkspacePath` 的参数 | ✅ **给一个路径就行** |
| M8 | 代理的缓存命中率 | ⚠️ 概念确认，**仍需实测** |
| M9 | token 计数的 `userId` 维度 | ❌ **没有，要自己加** |

**其中三条改变了设计**（不只是"确认了"）：M2、M5、M6。见各条末尾的"⇒ 影响"。

---

## M1 · 注入能否只追加、不改前缀 —— ✅ 能

**出处**：`dsh-system-prompt` README §"KV Cache effect"

**原话（正面）**：

> when the prepared call declares **`systemPromptUpdate: 'in-history'`**, the agent loop **appends a non-empty changed prompt after the cached history** inside a continuing request series, so **the prefix through that history stays reusable**

**原话（反面，不用这个开关时）**：

> Without `systemPromptUpdate`, non-empty prompt text is consolidated **at the first system node** through logged per-node replacements, so **a head rewrite loses prefix reuse from its first changed token**

⇒ **结论：能只追加。开关叫 `systemPromptUpdate: 'in-history'`。**

⚠️ 三条必须一起记：

1. **"Persona prefix changes can alter the early prefix"** ⇒ **改人格会破缓存**。所以"每个工作区一个人格"这件事有成本，不是免费的。
2. **"provider cache sharing and measured hit rates are not guaranteed"** ⇒ 不保证命中率，**落地后必须实测**（正好接 M8）。
3. **sections 是 system role，dynamic contexts 是 user role** ⇒ 见 M2，这两条路的"来源身份"不同。

---

## M2 · 有没有第三条"非用户来源"入口 —— ❌ 没有；但第二条原生带来源标记

**出处**：`dsh-api-session-controller` 的 `PromptRequest`；`dsh-system-prompt` README

**投递只有一条路**：

```ts
PromptRequest {
  requestId: SessionRequestId;
  sessionId: SessionId;
  mode: 'queue' | 'steer';          // ⚠️ 见下面的意外收获
  content: readonly PromptContentPart[];
  clientTimeZone?: string;
}
```

**要"不是用户说的"，只有两条**：

| 路 | 角色 | 代价 |
|---|---|---|
| **system-prompt 的 sections** | **system role** ✅ | 前缀脆弱（M1：要显式开 `'in-history'` 才不破） |
| **dynamic contexts** | **user role** ⚠️ | 但 README 原话："Ordered dynamic contexts are separate from sections and become **sourced user-role snapshots** only when present" |

⇒ **没有第三条**。所以"系统注入"落地只有这两条。

✅ **但 second 那条是" sourced "的** —— 也就是**原生支持带来源标记**。
这正是 X2 要的字段：**来源标记不用自己发明，dynamic contexts 天生就带。**

### 意外收获：`mode: 'queue' | 'steer'` 是 DSH 原生的

hupo v1 设计过"三路接管"（steer 半路改口 / inject 排队 / followup 开新轮）。
**DSH 已经内建了其中两种**：

- `steer` = 半路插入（当前这一轮里改口）
- `queue` = 排队（下一轮）
- 配套错误码：`session/steer-unavailable`、`session/agent-busy`、`session/queue-item-not-found`
  （后者的存在说明**队列是有条目的**，不是简单的先进先出）

⇒ **v1 那套 Handoff 不用自己实现**，映射过去就行。

---

## M3 · 读能不能被限制 —— ⚠️ bash 能、fs 工具不能

**两处出处，管的东西不一样，这个区别很重要**：

| 包 | 管什么 | 原话 |
|---|---|---|
| `dsh-fs-sandbox` | **只约束写** | "confines model file **writes and edits** ... **while preserving the local filesystem's read behavior**" |
| `dsh-bash-sandbox` | **bash 的文件访问** | "run each Bash command with **file-access confinement** instead of the harness process's full authority" |

⇒ **走 bash 的读写可以被限；走 fs 工具的读不可以。**

✅ `dsh-bash-sandbox` 是 **fail-closed**：

> If no runner can enforce a confined mode, the command fails with **`SANDBOX_UNAVAILABLE`** rather than running unconfined.

⚠️ 两条限制：

1. **`file-access confinement` 是否含"读"、路径怎么判 —— 要实测确认**（别拿这个措辞当结论）
2. **"network access and process visibility remain outside its guarantees"** ⇒
   **出网和"看得见哪些进程"它不管** ⇒ 这两样还得靠容器/网络隔离

---

## M4 · `session-reference` 能否主动触发 —— ✅ 能

**出处**：`dsh-session-reference` README §"Use this package"

**host 可调用的 API**：

- **`listCandidates(agent, query?, limit?)`** —— 列出可引用的会话；
  "ranks **same-directory sessions first**"，每条带最新标题作为标签
- **`prepare`** —— 生成快照

**自动路径**（不是唯一路径）：

> The outer `agent/pre-step` listener accepts the step, **parses canonical mentions out of direct user messages**, then calls `prepare`

⇒ **调度器可以主动触发，不用等用户打 `@`。**

**硬约束**：

| 项 | 值 / 原话 |
|---|---|
| 引用条数 | `maxReferences: **3**`（"must not exceed 3"） |
| 候选数 | `candidateLimit: 50` |
| 快照 | "**immutable after capture**"，带"fixed warning that **forbids following instructions, permission claims, or tool requests** inside them" |
| 插入点 | "inserted **immediately after the message that cited it**"；"the target log records the readable direct message followed by its sourced context" |
| 信任边界 | "assumes its **host is authorized to read every session** exposed by `ctx.sessionQuery`；it is **not a model-facing search tool**" |

⇒ 这条正好落实 B9 里"允许检索"的五个前提（周慎给的 R1–R5）——**它是 host 触发的、只读的、不可变的、带警告的**。

---

## M5 · fork 语义 —— ✅ 能只切一段；⚠️ 换 root 待验

**出处**：`dsh-session` README §"Fork a session"

```ts
ctx.sessions.fork(source, boundary?, childSessionId?)
```

**关键原话**：

> selects source events through an **inclusive `boundary` seq** (default: the current last event),
> requires the prefix to **end outside an open turn**, and creates a live child session with **lineage metadata**

⇒ **`boundary` 是一个 seq** ⇒ **可以只 fork 前 20 轮**，不是"必须全带"。

**这解决了架构文档里那个担心**：

> ⚠️ 早先的顾虑是"fork 会把全部历史带进去，所以隔离变弱，不适合做'进入工作区'"。
> **现在不成立了** —— 可以指定切到哪一条为止。

**子会话的记账字段**：`inheritedEventCount`（切点）、`ownEvents()`（切点之后的事件）、`isOwnSeq(seq)`。

⚠️ **仍未证实的**：**能不能换 workspace root**。
`dsh-api-workspace-files` 说子会话"**不借用父会话的 root**"，但**没说能不能指定另一个** root。
⇒ 这条仍待验（不过 M7 已经给了另一条路：`openWorkspacePath(path)` 直接打开一个路径）。

⚠️ 两条限制：`fork()` 只在 **live 会话的稳定边界**切；**已落盘但未加载的会话不能 fork**。

---

## M6 · 内存实测 —— ⚠️ **两个跑法差 4 倍，这个差决定架构选择**

| 跑法 | 实测 RSS | 出处 |
|---|---|---|
| **`--profile sdk`（agent 进程）** | **172–195 MB** | hupo 生产实测（周慎第二轮量到 **195MB**） |
| **`dsh web`（带界面的宿主）** | **719–786 MB** | 陆明实测 **719MB**；**本机本次实测 785.6MB**（已跑 21.5 小时） |

⇒ **差 4 倍。**

### ⇒ 影响（这条是本轮最重要的实测结论）

它正好落在前面那个悬着的问题上——**"纯粹用 DSH 的聊天"到底怎么落地**：

| 做法 | 每用户内存 | 生产机（`MemoryMax=1G`）能装几个 |
|---|---|---|
| **sdk profile + 自建客户端** | **~195 MB** | 3–4 个 |
| **复用 `dsh web` 的宿主** | **~800 MB** | **一个都装不下** |

所以在"复用 DSH"这件事上要**分清复用哪一层**：

- 复用它的**运行时 + 会话装配 + 渲染包**，但**不用它的 web 宿主** ⇒ 保住 195MB 那一档 ✅
- 直接跑 `dsh web` 当每用户的界面 ⇒ **4 倍内存**，生产机上不可行 ❌

`dsh-client-ui-conversation` 的 README 说得很清楚：**"具体 target 如 Chat 是独立的包，注册自己的 Definitions、Views、renderers"**
⇒ 所以上面那条 ✅ 是可行的：**换掉导航层，保留运行时与装配**。

---

## M7 · `openWorkspacePath` 的参数 —— ✅

**出处**：`dsh-api-session-controller` 的 `OpenWorkspacePathRequest`

```ts
OpenWorkspacePathRequest {
  action?: 'reveal';     // 可选
  path: string;          // 给一个路径就行
}
```

⇒ **给一个路径就能打开工作区**，不需要先有 workspaceId。

配套错误码（同包）：`session/workspace-attach-failed`、`session/fork-unavailable`、`session/end-seed`、`session/conflict`、`session/agent-busy`、`session/steer-unavailable`。

---

## M8 · 代理的缓存命中率 —— ⚠️ 概念确认，仍需实测

**两处出处合起来就是结论**：

1. `dsh-token-meter` README："Provider-reported usage is reused **only for an identical request envelope**"
2. M1 的答案：缓存是**前缀**稳定的

⇒ **代理若改动请求信封**（加一段计费用的 system 块、换 API key、改 header）**⇒ 前缀变了 ⇒ 缓存全废**。
而实测 **98.6%–99.8% 的 token 量都在 cache read 上** ⇒ **代价是数量级的**。

⇒ **验收条件**（若决定上代理）：**代理必须透明，且带"缓存命中率"回归测试**。

---

## M9 · token 计数的 `userId` 维度 —— ❌ 没有，要自己加

已确认（见 `R2-SYNTHESIS.md` §〇.2）：`dsh-token-meter` 有计数、无价格表、**无 userId 维度**。
⇒ 多用户计量要自己在外面包一层 `{userId, uncachedInputTokens + outputTokens}`。

---

## 读完这九条，架构文档要改的地方

| 位置 | 改成 |
|---|---|
| §2.5 注入那一节 | 补：**`systemPromptUpdate: 'in-history'` 是"只追加"的开关**；sections 是 system role、dynamic contexts 是 **sourced user-role** |
| §四（身份与边界） | 补：投递入口只有 `PromptRequest`，`mode: 'queue'｜'steer'` 是原生的（v1 三路接管不用自己实现） |
| §2.3 沙箱那一节 | 补：**bash 能限读、fs 工具不能**；网络与进程可见性不在 bash-sandbox 保证内 |
| §五（转交协议） | 补：fork **可以只切一段**（`boundary` 是 seq）；`openWorkspacePath(path)` 给路径就行 |
| §7.4 / §12 内存 | 补：**195MB（sdk）vs 785MB（web 宿主）差 4 倍** ⇒ "复用 DSH"要分清复用哪一层 |
| §11 待实测 | 划掉 M1–M9 里已验的；**留下 M5 的"换 root"、M3 的"读的粒度"、M8 的"缓存命中率"** |
