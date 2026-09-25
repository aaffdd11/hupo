# 110 · 一个房间一条会话（有且仅有一个对话 ＋ 要有 mapping）

> 主人 2026-09-25 点名的形状：**每一个房间（scope）在 DSH 里只有一条会话，
> 而且每一轮都续用同一条** —— 这样界面里"一个工作区 = 一个对话"，
> 首页派活到那一间的话、和在小程序里说的话，**落在同一条会话里**。
>
> 一句话：**有且仅有一个对话 ＋ 要有 mapping**。

---

## 一、形状

| 谁 | 是什么 | 住在哪 |
|---|---|---|
| **会话 id** | 一个房间**永远同一个**（`main` / `aoshu-bank` …） | 由 `src/dsh-sessions.mjs` 的 `sessionIdFor(scope)` 算，纯函数、稳定、单射 |
| **那份映射** | `{"main":"main","aoshu-bank":"aoshu-bank"}` | **一个用户一份**：`<他的数据目录>/dsh-sessions.json`（原子写 · `0600`） |
| **能 resume 的 SDK server** | 我们自己的 DSH 插件 `src/sdk-server-hupo.mjs` | 由 `hupo-sdk-server.yml` 那一层 patch 挂上（**官方那个同时关掉**） |
| **每一轮** | 客户端**每一轮都给同一个 id** | `agent-runtime.js` 从映射里取，**不再**带 `bootId` / 第几个实例 |

数据流（一条链，四段）：

```
调度器  ──session/prompt{sessionId:"main"}──▶  我们的 SDK server
                                                   │ 先看这条会话在不在
                                       在 ──▶ ctx.agents.resume()
                                       不在 ─▶ ctx.agents.create()
                                                   │
                                            DSH：$DSH_HOME/sessions/<slug>/main/
```

**这就是"一个房间一个对话"的全部机关**：客户端不换 id，服务端在"在 / 不在"上分叉。

## 二、为什么（真机读数，不是推断）

官方那一支 SDK server（`@deepseek-ai/dsh-sdk-jsonrpc-server` 的 `HarnessSdkJsonRpcServer`）
**只能 create、不能 resume**：

- `initialize` / `session/prompt` / `shutdown` 三个方法里**没有 resume**；
- `createSession()` 无条件 `ctx.agents.create({sessionId, …})`；
- 而 DSH 的会话记录**落在 `$DSH_HOME/sessions/` 里、跨进程活着**。

⇒ 同一个 id 第二次进去报 **`session "…" already exists`** ⇒ 旧的调度器只能
**每换一个 agent 进程实例就换一个 id**（`<会话>.<bootId>.<第几个>`，
`agent-runtime.js` 顶上的历史注释就是这件事）。

代价（**真机读数**，主人的盒子 u2）：

| 房间 | 会话条数 |
|---|---|
| `/data/main` | **38** |
| `/data/workspaces/aoshu-bank` | **16** |

⇒ 界面里"一个工作区 = N 个对话"；派活到那一间的话与那一间自己说的话，
**不在同一条会话里**（各自又开新的）。

## 三、已经验过的事实（原话照抄，别重复验）

**父 agent 2026-09-25 在本机（临时 `DSH_HOME=/tmp/probe3` 那种家）验过四条：**

1. **我们自己的插件文件能被 DSH 的 loader 按绝对路径加载** —— patch 写成
   `- insert: [{ id: hupo-session-probe, name: /tmp/probe-plugin.mjs, inject: [sdkAppStartup, loader], config: {} }]`，
   插件形状照 DSH 自己的（`export const name`、`export function apply(ctx, config)`）；
   配置 dump 出来 `name: file:///tmp/probe-plugin.mjs`。
2. **同一个 patch 里可以把官方那个关掉**：`- id: sdk-jsonrpc-server` ＋ `disabled: true`
   （`--dump-config` 里那条确实变成 `disabled: true`）。**这一步必须做** ——
   两个 server 都读 stdin 会互相抢帧。
3. **从我们插件里调 `ctx.agents.create({sessionId, meta:{cwd}, agentOptions:{provider,model}})`
   与 `ctx.agents.resume({resumeSessionId, agentOptions})` 都成功**（第二个是**另起一个进程**
   调的 ⇒ 真的 resume 成功）；会话按**我们给的 id** 落在
   `<DSH_HOME>/sessions/<cwd 的 slug>/<我们的 id>/`（试的 id 是 `probe-one`）。
   ⚠️ **一个陷阱**：插件**加载那一刻**调 create/resume 会报
   `no agent factory registered (load an agent-loop plugin)` —— agent factory 是**稍后**
   才注册上来的 ⇒ server **必须在 `initialize` 之后**才处理帧。
4. **要转发的通知形状**（照官方那份 `lib/index.js` 抄，**客户端一个字都不用改**）：
   `session.event` · `session.status` · `subagent.started`（只在 `header.parentSession` 有值时）·
   `subagent.finished`；方法 `initialize` / `session/prompt` / `shutdown`；
   stdout **只许放协议帧**（日志一律 stderr）；`maxTokensAsSuccess === true` 时
   `stopReason === 'max-tokens'` 判成 `ok`。

**`#155` 这一轮又真机咬出两条（都是父 agent 那四条里没有的，改法已落地）：**

| # | 读数（原话） | 结论 |
|---|---|---|
| **⑤** | `dsh: plugin tree failed to load: failed to import loader entry hupo-sdk-server ([object Object]): name.startsWith is not a function` | 🔴 **`name` 不能走 `!!js`**：loader 只对条目的 **`config`** 做 `!!js` 求值（`interpolate(this.ctx, config)`），**不碰 `name`**。⇒ 插件本体改成**相对这份 patch**写：`name: ./src/sdk-server-hupo.mjs`（DSH 的 `anchorInsertedPluginNames()` 会把 insert 里的相对路径**按 patch 文件所在目录**锚成 `file://`）—— 本机与盒里同一条 patch 都对，**不需要任何 env** |
| **⑥** | `{"code":-32603,"message":"cannot get property \"sessions\" without inject"}` | 🔴 插件的 `inject` 里**必须有 `sessions`**：`ctx.sessions` 是 cordis 的服务访问器，没 inject 就抛（`initialize` 会成功、然后**每一条 `session/prompt`/`session/resume` 都失败**）。官方那支没这个问题 —— 它只用 `ctx.agents` |

## 四、判据 S1–S6（每条都带**必须红**的反例）

判据住 `v2/services/core/test/dsh-server-hupo.test.js`（S2–S6）
与 `test/agent.test.js`（S1/S3 的真 stdio 那一半）。

| # | 判据 | 反例（必须红） | 住哪 |
|---|---|---|---|
| **S1** | 同一个 scope **连续两轮**（中间还换过一次进程）⇒ 送出去的会话 id **一模一样**；重启（新 runtime、同一个 `DSH_HOME`）也还是那一条 | 每次换一个 id（回到 `<会话>.<bootId>.<第几个>`）⇒ 红 | `agent.test.js`（真 spawn，验的是**帧里那个 id**）|
| **S2** | 那条会话**不在** ⇒ 走 `create`；**在** ⇒ 走 `resume`（判据可注入；默认判据问 `sessionPersistence`） | 永远 `create` ⇒ 红 · 永远 `resume` ⇒ 红 | `dsh-server-hupo.test.js`（假 ctx 断言调了哪个）|
| **S3** | 两个不同 scope ⇒ 两个不同 id，不许串；**难看的名字也不许撞**（转义单射） | 不转义 / 每次重算 ⇒ 红 | 同上 ＋ `agent.test.js` |
| **S4** | patch 里**确实把官方那个关了**（`disabled: true`）＋ insert 那条在 ＋ 插件本体是**相对 patch 的路径** | 删掉 `disabled` ⇒ 红 · 改回 `name: !!js …` ⇒ 红 | `dsh-server-hupo.test.js`（读那份 yml 的真条目）|
| **S5** | 映射：**原子写**（先 `.tmp` → `chmod 0600` → `rename`）、认不出/坏掉 ⇒ **不猜**（抛，且**一个字节都不改**）、两间指同一个 id ⇒ 抛 | 坏内容当成"没有" ⇒ 红 · 顺序反了 ⇒ 红 · 坏内容被盖掉 ⇒ 红 | 同上（注入假 fs 记调用序列）|
| **S6** | `agentPatchArgs()` 里**含**新那一层，而且**只有一处出处**（`devWebArgs()` 同源）；插件本体**不许**当 `--patch` 挂 | 不挂 ⇒ 红 · 开发者入口自己再拼一份 ⇒ 红 · 把 `.mjs` 当 patch ⇒ 红 | 同上 |

> 另外还有三条"守住这个形状"的：**插件 inject 必须有 `sessions`**（⑥ 那一条）、
> **盒里那份入口把 patch 路径指到产品层**（`entry.mjs` 里那一行 `HUPO_SDK_PATCH`）、
> **`preflight` 在开机就把坏掉的映射拦下来**（不让它拖到"用户正等着答话"那一刻，
> 那时候那一轮只会**说不出话**）—— 三条都带反例（见 §五 M8/M9/M10 与 §六 的真机读数）。
>
> ⚠️ 本契约**没有**"客户端会话 id"那一侧的判据：客户端这一轮**一个字节都没改**
> （它从来就只是把 `session/prompt` 里的 `sessionId` 原样发出去）。

## 五、变异读数（每一刀都真跑过，读数原话）

跑法：`cd v2/services/core && node --test test/agent.test.js`
或 `node --test test/dsh-server-hupo.test.js`（每刀改一处、跑、还原；
还原用 md5 自查，**五份文件全对上**）。

| 刀 | 怎么改 | 读数（原话） |
|---|---|---|
| **M1** | 会话 id 每次换一个（`…+ Date.now() + Math.random()`） | `✖ 🔴★ S1：同一间换实例 / 重启 ⇒ **同一个** DSH 会话 id` ＋ `AssertionError: 会话 id 就是映射给的那个（人看得懂）`；`✖ 🔴★ S1：两轮之间换过一次进程 ⇒ **送出去**的会话 id 一模一样` ＋ `AssertionError: ★ 两轮必须是同一个会话 id` ⇒ **4 红** |
| **M2** | `if (exists)` ⇒ `if (false && exists)`（永远 create） | `✖ 🔴 S2：同一间第一次 ⇒ create；换一个进程再来 ⇒ resume` ＋ `AssertionError: ★ 会话在（持久化里那条）⇒ 必须走 resume` ⇒ **3 红** |
| **M3** | `if (exists)` ⇒ `if (true)`（永远 resume） | `✖ 🔴 S2：…` ＋ `AssertionError: ★ 会话不在 ⇒ 必须走 create` ⇒ **3 红** |
| **M4** | `sessionIdFor` 不转义（非法字符直接留） | `✖ 🔴 S3·补：难看的 scope 名也不许撞（单射）` ＋ `AssertionError` ⇒ **1 红** |
| **M5** | 把官方那条的 `disabled: true` 删掉 | `✖ 🔴 S4` ＋ `AssertionError: ★ 官方那一条必须是 disabled: true` ⇒ **1 红** |
| **M6** | 映射读不动时 `parsed = {}`（"当成没有"） | `✖ 🔴 S5：映射坏掉 ⇒ **抛**，而且**一个字节都不改**` ＋ `AssertionError: Missing expected exception.` ⇒ **1 红** |
| **M7** | `agentPatchArgs()` 里不挂 SDK server 那一层 | `✖ 🔴 S6` ＋ `AssertionError: Expected values to be strictly deep-equal` ⇒ **1 红** |
| **M8** | 插件不 inject `sessions`（真机 ⑥） | `✖ 🔴 插件的形状…` ＋ `AssertionError: ★ 少 sessions ⇒ 每条 prompt/resume 都失败` ⇒ **1 红** |
| **M9** | 开发者入口自己再拼一份 patch（第二个出处） | `✖ 🔴 S6` ＋ `AssertionError: ★ devWebArgs 必须与 agentPatchArgs 同源` ⇒ **1 红** |
| **M10** | `preflight` 里那段"查坏映射"关掉 | `✖ 🔴 S5·补：preflight 在**开机**就把坏掉的映射拦下来` ＋ `AssertionError: ★ 坏映射必须在开机时说，不是等到某一轮说不出话` ⇒ **1 红** |
| **M11**（`#155·补`） | `session-id.mjs` 里把 `/` **加回黑名单**（第一版的错） | `✖ 🔴 T1：…收 **DSH 自己那种 id**（带 `/`）…` ＋ `Error: sessionId 形状不认（含 `/`（变异：把斜杠加回黑名单））："owner/aoshu-bank.muh709vsibnh.1"`；`✖ 🔴 T2：映射里钉的是 **DSH 自己的 id**…` ＋ `Error: 会话映射里 "aoshu-bank" 钉住的 id DSH 收不了（含 `/`（变异…））` ⇒ **2 红** |
| **M12**（`#155·补`） | `readSessions` 里把映射的值**再转义一次**（`id.replaceAll('/','~002F')`） | `✖ 🔴 T2：…` ＋ `AssertionError: Expected values to be strictly deep-equal`：`+ { 'aoshu-bank': 'owner~002Faoshu-bank.muh709vsibnh.1' }` / `- { 'aoshu-bank': 'owner/aoshu-bank.muh709vsibnh.1' }` ⇒ **1 红** |
| **M13**（`#155·补`） | 把 `deliveryFailed` **退回** `forceClose`（投递失败那条路） | `✖ 🔴 T3：…盘上有一条给用户的收口` ＋ `AssertionError: ★ 必须有一条落盘的气泡（真机：一个字都没有）` `0 !== 1`；`✖ 🔴 T3·补：被拒之后这一间照旧活着` ＋ `AssertionError: ★ 每一句被拒的话都有自己的收口` `0 !== 2` ⇒ **2 红** |
| **M14**（`#155·补`） | `session-id.mjs` 里把 `.`/`..` 整段那道闸拆掉 | `✖ 🔴 T1：…` ＋ `AssertionError: Missing expected exception: 这个必须被拒（`..` 整段）：".."`；`✖ ★ 认不出的方法 / 不合法的 id…` ＋ `AssertionError: The input did not match the regular expression /形状不认/u` ⇒ **2 红** |
| **M15**（`#155·补`） | `preflight` 里整段"会话映射"开机检查关掉 | `✖ 🔴 S5·补：preflight 在**开机**…` ＋ `AssertionError: ★ 坏映射必须在开机时说…` `0 !== 1`；`✖ 🔴 T2：…` ＋ `AssertionError: ★ 坏 id 必须在**开机**就拦…` `0 !== 1` ⇒ **2 红** |

## 六、真机读数（`#155` · 2026-09-26 · 本机 · **临时 DSH_HOME**）

探针：`/tmp/probe110.mjs`（一个最小 NDJSON 客户端 ＋ 两台 `dsh`）。
参数**就是生产那一套**（`agentArgs()` 产出的四条 `--patch`），env 照 `agentEnv()` 给全；
⚠️ **不碰** `/home/deploy/.dsh`、不用主人的钥匙、**不花一个 token**。

| 步 | 读数（原话/原样） |
|---|---|
| 临时家 | `DSH_HOME=/tmp/probe110-<rand>/dsh`，`cwd=/tmp/probe110-<rand>/ws` |
| 参数 | `--profile sdk --patch <repo>/hupo-sdk-server.yml --patch <repo>/hupo-persona.yml --patch <repo>/hupo-capabilities.yml --patch <repo>/hupo-model-proxy.yml` |
| ① 第一台 `initialize` | `{"result":{"serverInfo":{"name":"hupo-sdk-runtime","version":"0.0.1"}}}` ← **我们那份在答**（官方那个被关了） |
| ② 第一台 `session/resume`（第一次） | `{"error":{"code":-32603,"message":"这条会话不在：probe-room-one\n    ⇒ 它在 DSH_HOME 里没有会话记录（cwd=…）—— 这一条路**只 resume、不 create**"}}` ← **如实说"不在"** |
| ③ 第一台 `session/prompt` | `{"result":{"messageId":"c4e43faa-…"}}` ⇒ 真的跑了一轮：`turn/start … step/start … assistant/attempt … turn/end` |
| ④ 那一轮**没花 token** | `turn/end.reason = {"kind":"error","error":{"message":"llm-deepseek: no API key for provider route \"deepseek-official\"; …","code":"MISSING_CREDENTIAL"}}` —— 临时家里没有凭据、模型那条又指向盒内小代理 ⇒ **一个 token 都没花** |
| ⑤ 落盘（第一台之后） | `sessions/--tmp-probe110-<rand>-ws--/ ⇒ ["probe-room-one"]`（**只有一条**，名字就是我们给的那个 id） |
| ⑥ **第二台**（另一个进程、同一个家）`session/resume` 同一个 id | `{"result":{"sessionId":"probe-room-one","resumed":true,"live":false}}` ← **resume 成功** |
| ⑦ `cwd` 对不上 | `{"error":{…"message":"会话 \"probe-room-one\" 与这次要的工作目录对不上：持久化里是 …/ws，这次是 …/别的目录\n    ⇒ 不硬来…"}}` |
| ⑧ `sessionId` 不合法 | `{"error":{…"message":"sessionId 形状不认（只收 [A-Za-z0-9._~-]、最长 200）：\"../跑出去\"…"}}` |
| ⑨ 最终落盘 | `sessions/--tmp-probe110-<rand>-ws--/ ⇒ ["probe-room-one"]（条数 1）`；目录里 `session.lock session.v3.jsonl.zstd`；**目录名 === 我们给的 id** ⇒ `true` |
| ⑩ 开发者入口那条 profile（`--profile web` ＋ 同一套 patch） | 8 秒后**还活着**、stderr 里**没有** `failed to load` / `name.startsWith` / `Error:`（那一层在那条路上不生效：web profile 里没有 `sdkAppStartup`）|

## 七、明确**不做**的

1. 🔴 **旧的会话文件一个都不动。** 那些是**数据**（真机读数 38 / 16 那两批）。
   "取最新一条当正本、其余带留痕收起来"是**父 agent 另走一步**——
   这一轮只给出**可被调用的函数**（`readSessions` / `writeSessions` / `sessionIdFor` /
   `dshSessionIdFor`：映射里钉住的那个 id **优先于**按名字算出来的，见 §四 S5 的最后一条）。
2. **不动客户端**（这一轮 `v2/apps/mobile/**` 一个字节都没改）。
3. **不动人格**（`hupo-persona.yml` 的语义照旧）。
4. **不给 `session/prompt` 加图片内容块的支持**：这一份只收**文本**块
   （我们的客户端只发文本）。收到别的类型 ⇒ **如实拒绝**，不猜一个空块。
   ⚠️ 这是**如实说的缺口**：官方那份会走 `attachments` 把图片落成引用，我们这份 import 不了
   那个包（插件是自足的）。
5. **不写数值进文档**（阈值住代码：`SCOPE_ID_MAX`、`factoryWaitMs` 都在源码里）。

## 八、与 102 / 108 / 109 的关系

| 契约 | 关系 |
|---|---|
| **102**（派活到某一间） | 派活会在**那一间**里开一条会话 —— 那一条现在就是**这一间唯一的那条**；同一间再来活，续用它（不再是"每派一次多一个对话"）|
| **108**（派活那四步 / B39） | 子进程"接着说"那类问题受**会话身份**影响：同一间一条会话 ⇒ 续写落在同一条上（判据仍在 108）|
| **109**（开发者入口同源） | 那一层 patch 也在 `agentPatchArgs()` 里 ⇒ **开发者入口那台跟着一起拿到**（判据 D1/D7′ 已扩成四条 patch）。⚠️ 在 `--profile web` 下这一层**不生效**（那个 profile 没有 `sdkAppStartup`），参数同源是为了"不许两处各拼一份"|

**还欠的（如实记，别当成做完了）：**

1. ⚠️ **回收那一条**：`prune.js` 会按"新近保护窗 / 保底条数 / 容量"清 `$DSH_HOME/sessions/`。
   现在"一间一条会话"是**正本**（不再是一次性记录）——
   **同一个 cwd 分组里只有一条**时它一定落在保底条数内（不会被清），
   但**如果**父 agent 那一手把正本钉到一条**旧的**（`<scope>.<bootId>.<n>`）上，
   而那个分组里还有更旧的记录，这一条就有被清掉的**可能**。
   ⇒ 迁移那一步必须**同时想清"这条正本怎么不被清"**（例如把它的 mtime 顶新、
   或者给 `planPrune` 加一份"绝不删"的名单）。**这一轮不动 `prune.js`。**
2. ⚠️ **同一个 cwd 上两个进程会不会抢那份会话（D4，109 §五）** 还没在真机上验 ——
   这一份只验了"一个进程关掉、另一个再 resume"。
3. ⚠️ **盒里还没落地**：这一版要重新发布产品层（`hupo-sdk-server.yml` 已进
   `build-tenant-code.sh` 的 INPUTS）＋ 重启容器，那一步要主人签字。

### 八·补 —— 真机第一版挂死（2026-09-26 · `#155·补`）：根因 · 回滚 · 修法

**现场**：这一版的产品层发布到主人的盒子之后，**任何一句话都没有答复** ——
那台 DSH 一直活着、什么都不说。`/api/say` 回 200，之后**五分钟里一个新事件都没有**
（盘上像那句话没发生过）。⇒ **回滚**到上一版（盒子上跑的是回滚版）。

**根因 A（真根因）：形状判据把 DSH 自己的会话 id 判成非法。**
映射里（§七 那一手"取最新一条当正本"）钉的是 **DSH 自己的 id**
`owner/aoshu-bank.muh709vsibnh.1`（**带一个 `/`**），而第一版的
`SESSION_ID_SHAPE = /^[A-Za-z0-9._~-]{1,200}$/` **不收 `/`** ⇒ 服务端如实回（原话）：

```
{"id":2,"error":{"code":-32603,"message":"sessionId 形状不认（只收 [A-Za-z0-9._~-]、最长 200）：
 \"owner/aoshu-bank.muh709vsibnh.1\" ⇒ 不猜、也不替它换一个 —— 请用映射（dsh-sessions.mjs）产出的那个 id"}}
```

⚠️ **那个 `/` 是 DSH 自己的写法**：**注册表 / 会话头里的 `id` 是原始形式**，
**目录名才是转义形式** —— DSH 的持久化层（`dsh-session-persistence-jsonl` 的
`encodeSegment`）把整个 id 当**一个**路径段转义：`/` ⇒ `~002F`，`.` / `..` 整段 ⇒
`~002E` / `~002E~002E`。⇒ 判据必须是"**DSH 自己收什么**"（`sessions.create(id)`
只要求"非空字符串 / 不重复"），**不是我们自己拍脑袋**。
⚠️ 也别把映射里钉住的值**再转义一次**（`sessionIdFor` 的转义是给"我们自己算出来的 id"用的）。

**根因 B（把一个错误变成一次静默挂死）：投递失败那条路不给人话。**
现状（改前）：`deliver()` 的 `catch` 只做三件 —— **从 `#delivered` 摘票**、
**记 `#lastError`**、发一条**瞬态** `error`；收口那句是
`forceClose('failed', {line: AGENT_UNAVAILABLE_LINE})`。
而 `forceClose` 收的是 `#turns` 里**已经开过的轮**（由 `turn/start` 建账）——
`session/prompt` 被拒时 DSH **一轮都没开**（`turn/start` 永远不来）⇒
`forceClose` 收 **0** 轮 ⇒ **一个字都没写**；而那条瞬态 `error`
**客户端今天不渲染**（`dispatcher.js` 里自己的注释）⇒ 用户**什么都看不到**。
同一形状还有 `handoffDelivery()` 那个 `catch`。

**修法**：

1. **一处判据**：新 `src/session-id.mjs`（`sessionIdProblem` / `isSessionIdShape` /
   `assertSessionId`）。为什么是**新小模块**而不是"从插件里 import"：
   `dsh-sessions.mjs` 是核心服务（`config.js` / `agent-runtime.js` 都 import 它），
   让核心服务去 import 一个**DSH 插件文件**是反向依赖；而插件又必须保持
   "能被 DSH 按绝对路径加载"的自足性 ⇒ 两边都 import 这个中立小模块最干净。
   判据：**收 `/`**；明确拒 空 / 超长（常量 `SESSION_ID_MAX` 住代码）/ 控制字符 · NUL /
   `.`、`..` **整段**（真穿越 —— 含 `/` 本身**不是**穿越，DSH 会转义整个 id）。
2. `sdk-server-hupo.mjs` **只 re-export**（不再自己写一份形状）；
   `dsh-sessions.mjs` 的 `readSessions` 用**同一个函数**逐条校验映射里的值。
3. `config.js` 的 `preflight`：开机**逐个 id 过一遍那个形状函数**，不过就**硬拦**
   （与"坏映射拦下来"同一处、同一条纪律）。
4. `SessionTranslator.deliveryFailed(reason, {line})`：先走**既有的失败收口**
   （`forceClose`），**一轮都没开**时再**主动落一条**给用户的话（`MessageWriter`，
   落盘 ⇒ 看得见）；`dispatcher.js` 的 `deliver` 与 `handoffDelivery` 两处都改走它。
   ⚠️ 文案是人话、**不许出现内部词**（工具 / 会话 / 连接 / 服务 / 超时）。

**真机读数**（本机 · 临时 `DSH_HOME` · 不碰 `/home/deploy/.dsh` · **不花一个 token**）：
`session/prompt` 带 `owner/aoshu-bank.muh709vsibnh.1` ⇒
`{"result":{"messageId":"9c154181-…"}}`（**收下了**，不再是形状错误）；
那一轮 `turn/end.reason = {"kind":"error","code":"MISSING_CREDENTIAL"}`（没花 token）；
落盘目录名 = `owner~002Faoshu-bank.muh709vsibnh.1`（**原始 id 带 `/`、目录名转义** —— 上面那条事实的读数）；
另一个进程 `session/resume` 同一个 id ⇒ `{resumed:true}`；`../跑出去` 与 cwd 对不上照旧**如实拒**。

**判据**：`test/dsh-server-hupo.test.js` 的 **T1 / T2** ＋ 新 `test/deliver-failed.test.js` 的 **T3**；
变异读数见 §五 **M11–M15**（每刀都真跑过、md5 自查还原）。
