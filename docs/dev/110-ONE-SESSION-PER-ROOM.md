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

### 八·补2 · 🔴 那一层 patch 把**开发者入口**弄挂了（`#155·补2` · 2026-09-26 真机）

**现象**：`#155` 落地之后，开发者入口（`dsh<手机号>.stalkerai.cn`）点任何一间 ⇒ **502**。

**读数（盒里日志原话）**：
```
盒里那台 dsh web 没起来（房间 主对话）：read ECONNRESET
```
本机复现（同一条 patch 挂 `--profile web`）⇒ 真原因当场现形：
```
dsh: plugin tree failed to load: dsh: 1 entry did not activate
…/src/sdk-server-hupo.mjs: pending (waiting for service: sdkAppStartup)
```

**根因**：我们的 insert 那条 `inject: [sdkAppStartup, loader]` 是照**官方那支**抄的，
而 `sdkAppStartup` **只有 `sdk` profile 有**（它是那个 app 的启动标记）。
**开发者入口那台是 `--profile web`、挂的却是同一套 patch**（`agentPatchArgs()` 一处出处 · 契约 109 §七）
⇒ 在 web profile 里这个条目**永远 pending** ⇒ DSH 认为"有一条没激活" ⇒ **整棵树加载失败**
⇒ 那台 `dsh web` 打印完端口行就死（所以中继在换 cookie 那一步读到 `ECONNRESET`）⇒ 入口 502。

**修法**：那份 patch 的 `inject` **只留 `loader`**（我们只需要它：`initialize` 里那句
`loader.await()`；`agents` / `sessions` 是**模块级**的 `inject`，与 profile 无关）。
⇒ 同一套 patch 在 **sdk** 与 **web** 两个 profile 下都起得来（本机两个 profile 各验一遍：
sdk 那台照样由我们这份 `serverInfo: hupo-sdk-runtime` 作答；web 那台正常打印端口、活着）。

**判据（两道，都要）**：
- 夹具级：`test/dsh-server-hupo.test.js` 的 **S4**（`inject` 里只许有 `loader`，**不许** `sdkAppStartup`）
  ＋ `test/dev-mode.test.js` 末尾那一条（同一件事的第二道）；
- **真机级**：`scripts/check-dev-mode.mjs` 的 **③c**（"带 cookie 再取 `/` ⇒ 200 且含 `__DSH_BOOT__`"）
  —— **就是它抓到这个 502 的**（夹具全绿、入口全挂 ⇒ 又一次证明"判据要打在被测的那一侧"）。

⚠️ **一条错误的旧断言被这一轮改对**：`dsh-server-hupo.test.js` 的 S4 原来把
`inject: [sdkAppStartup, loader]` **当成正确形状钉住**（写它的人照官方抄的）⇒
修完 patch 之后那条当场红 —— **它钉的是缺陷**。⇒ 教训：判据要写"**为什么**是这个形状"，
不许把"照抄来的形状"当结论。

### 八·补3 · 🔴 **B43 第二版：为什么"等它退"不够 —— 它杀不动**（`#156` · 2026-09-26）

**主人报的原话**：*"dsh19145526557 的 dsh 没有接通 websocket"*。

**现象**：开发者入口那一页能打开、房间清单列得出；**换一间就 502**（于是那一页的
WebSocket 永远连不上 —— 主人看到的就是"没接通 websocket"）。**第一间**（刚重启/刚换版
之后点的第一间）是好的。

**修前真机读数（父 agent 在 u2 的盒子上量的 · 原话）** —— `/tmp/switch3.mjs main aoshu-bank main`：
```
main        选=302 取页=200(有 boot) 升级=101
aoshu-bank  选=302 取页=502          升级=101
main        选=302 取页=502          升级=HTTP 502
换完内存：299MB · oom_kill 8→13（涨 5）
/web 进程两台：pid=3067 rss=286432KB ＋ pid=3124 rss=3348KB
```
⇒ **每换一次 `oom_kill` 就涨、换完之后旧那一台还活着、页是 502**。
（⚠️ 中间那条 `升级=101` 是"重试那次碰巧赶在被杀之前把端口行报出来了"，
不是"好了" —— 同一形状下第一次取页仍然是 502。）

**根因（真机读数，不是推断）**：`dsh web` 是盒里那个服务（**容器 root**）用
`spawnFn(..., { uid: cfg.agentUid, gid: cfg.agentGid })` **换手到 uid 1000** 起的
（安全决策①，不许改）。而那个容器是
```
podman run --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID \
           --cap-add=SETGID --cap-add=FOWNER
```
⇒ 容器 root 的 `CapEff = 0xcb`，**没有 `CAP_KILL`** ⇒ 它给**另一个 uid** 的进程发不了信号：
真机原话 `kill: (14) - Operation not permitted`。
⇒ `killChild()` 里那两个 `c.kill(...)` **静默失败**（被 `try/catch` 吞了）：
"换房间先收旧的"**从来没真的收掉过** —— 旧那台还活着（`/proc` 里 RSS ~390MB），
两台叠在一起 ⇒ 内核杀**新起来的那台** ⇒ 那一间 **502**。

⚠️ **为什么以前看着是好的**：每次发布产品层 ⇒ 容器重建 ⇒ 旧的 `dsh web` 全没了
（干净的第一次）；检查又总是在"刚重建之后"选第一间 ⇒ **全绿**。**主人自己换房间就必挂**
—— "夹具/时机假绿"的又一例。

**修法（守正：不改安全决策①、不改协议、不加新 `/api/…` 路由）**：

| # | 修的是什么 | 落在哪 |
|---|---|---|
| ① | **发信号走"同 uid 的小 helper"**：`spawnSync(process.execPath, ['-e', 'process.kill(Number(process.argv[1]), process.argv[2])', pid, sig], { uid, gid, timeout })` —— 同 uid 之间发信号**不需要** `CAP_KILL` | `makeKillPid(cfg)` ＋ `createDevWebRelay({ killPid })`（**可注入**） |
| ② | **杀完要核实真的死了**（读 `/proc/<pid>`，有上限） | `killChild()` 的 `waitPidGone()` |
| ③ | **没杀掉要如实说**（点名 pid；**不许**静默、不许当"收干净了"） | `killChild()` 里那一句 `⚠️ …没收掉 —— 它还活着` |
| ④ | **起新台之前扫一遍孤儿**（只 `--profile web`、只有盒里那一支才开、不动"现在这一台"） | `sweepOrphanWebs()`；`serve.js` **只在容器那一支**传 `sweepOrphans: true` |
| ⑤ | **内存闸**：余量不够（阈值住代码）就等（有上限），到点还不够 ⇒ **如实 503 ＋ 人话** | `readMemoryHeadroom()` ＋ `waitForMemory()` ＋ `DEV_NO_MEMORY_TEXT` |
| ⑥ | **失败之后的冷却**：入口那条 WebSocket 会自动重连 ⇒ 不冷却就是 **spawn 风暴**（父 agent 在 u2 上清完孤儿又冒出 1/2/3 台，而没人在点房间） | `lastFailure` ＋ `DEV_FAIL_COOLDOWN_MS` ＋ `DEV_FAIL_COOLDOWN_TEXT` |

**"杀不动的时候要不要接着起新台" —— 决定：起，但日志里说清。**
理由（写在代码注释里）：不起的话，只要盒里赖着一台收不掉的孤儿，整条入口就**永远**打不开；
而起是有闸的 —— ⑤ 内存闸会挡住硬起（不够就如实 503）、④ 起之前还会再扫一次孤儿。
**但"杀不动"这句话一定要留下**：不然下一次排查又会以为"是 dsh 起不来"（这一轮修的就是这个）。

**判据（`test/dev-mode.test.js` · 每条都能反着验）**：
- **K1** `killChild()` 走的是**注入的那个 `killPid`**（不是 `child.kill`）；
- **K2** `killPid` 抛错 / 进程没死 ⇒ **如实说一句**（点名 pid），而且**照样起新台**（有闸兜着）；
- **K3** 孤儿清扫**只认 `--profile web`**、**默认关**（宿主那一档一台都不许动）、**不动现在这一台**；
- **K4** 内存不够 ⇒ **503 ＋ 人话**（不硬起、也不说成"没起来"）；读不到 cgroup ⇒ **不挡**（不猜）；
- **K5** 连续请求 ⇒ `spawnFn` **只被叫一次**（并发 3 条也只 1 台 ＋ 失败后有冷却；冷却过了要能再试）；
- **K6** 冷却期内**如实 503 ＋ 那句人话**（HTTP 与升级两条路都是 503）。

**变异读数（每一刀都真跑过 · 只改 `src/dev-mode.js` 一处 · 跑完逐字节还原 md5 一致）**：

| 刀 | 改回什么 | 读数 |
|---|---|---|
| M1 | `killChild` 改回 `child.kill` | K1 **红** |
| M2 | 杀完不核实、不吭声（`if (!reallyGone)` 关掉） | K2 **红** |
| M3 | 孤儿判据放宽成"带 `--profile` 就算" | K3 纯 **＋** K3 行为 **两条红** |
| M4 | 不跳过"现在这一台" | K3 行为 **红** |
| M5 | 孤儿清扫默认改成开（= 宿主上也扫） | K3 行为 **红** |
| M6 | 起新台前不扫孤儿 | K3 行为 **红** |
| M7 | 内存闸关掉（硬起） | K4 **红** |
| M8 | 冷却去掉 | K5 **＋** K6 **两条红** |
| M9 | 冷却期照样回 502"没起来" | K6 **红** |

**真机读数（`#156` · 2026-09-26 · 一次性容器 · 真内核/真 cgroup/真 dsh）**：
镜像 `localhost/hupo-tenant:local`，参数照 `create-tenant-pool.sh` 抄
（`--cap-drop=ALL` 只加回五条、`--memory=768m`、`--pids-limit=512`），
挂一份**未发布**的产品层；盒里真起 `dsh web`、真换房间。**不碰 u2、不发布、不重启任何东西。**

⚠️ **这一套是能重跑的**（脚本进了仓库，跑完什么都不留）：
```bash
bash scripts/build-tenant-code.sh                       # 造一份**未发布**的产品层，打印指纹
bash scripts/check-dev-mode-container.sh --layer /srv/hupo/tenant-code/<指纹>
bash scripts/check-dev-mode-container.sh --layer <修前那一份> --seq main,aoshu-bank,main,aoshu-bank
bash scripts/check-dev-mode-container.sh --layer <指纹> --seq ghost,ghost,ghost,ghost   # spawn 风暴那一件
```
（修前那一份怎么来：把 `src/dev-mode.js` 换成 `git show HEAD:…` 的副本，再用
`HUPO_CORE=<那份副本> bash scripts/build-tenant-code.sh` 造一格 —— **仍然不 publish**。）

先量**根因那一句**（同一个容器）：
```
容器 root 的 CapEff： 00000000000000cb          ← 与真盒里 /app/entry.mjs 逐位一样（没有 CAP_KILL）
① 容器 root process.kill(14, SIGTERM) ⇒ EPERM；它还活着=true      ← 生产里 c.kill(...) 走的就是这条
② 同 uid helper process.kill(14, SIGKILL) ⇒ status=0；它还活着=false ← 修法
```

**换 3 次房间（`main ⇄ aoshu-bank`，共 4 次进入）**：

| | 选 | 取页 | 升级 | 换完之后盒里的 `--profile web` | `oom_kill` |
|---|---|---|---|---|---|
| **修前**（`git show HEAD` 那份 `dev-mode.js`） | 302 | 200 → **502 → 502 → 502** | 101 → **502 → 502 → 502** | **永远 1 台，而且是旧那台**：`pid 14 · cwd /data/main`（四次都一样） | **0 → 2 → 4 → 6** |
| **修后**（这一次这一版） | 302 | **200 · 200 · 200 · 200**（都有 `__DSH_BOOT__`） | **101 · 101 · 101 · 101** | **每换一次只剩 1 台，而且 cwd 就是新那一间**：`14:/data/main` · `61:/data/workspaces/aoshu-bank` · `108:/data/main` · `155:/data/workspaces/aoshu-bank` | **0 → 0 → 0 → 0** |

⚠️ **cwd 是怎么读到的（如实说）**：容器 root **没有 `CAP_SYS_PTRACE`** ⇒ 直接
`readlink /proc/<pid>/cwd` 是 **EACCES**；用的是**同 uid 的小 helper** 读的
（`via: uid1000-helper`）—— 与修法①同一个道理。**读不到就会如实写"读不到"**（不走内存推算）。

**"失败之后会不会反复起"（spawn 风暴那一件，同一个容器）**：连点 **4 次**一间起不来的房间
（cwd 不存在 ⇒ 起台必失败）：

| | 起台尝试次数 | 四次的状态 |
|---|---|---|
| **修前** | **8** | 取页 502 · 502 · 502 · 502 ＋ 每次升级再 502（**一次点击 = 两次起台**） |
| **修后** | **1** | 取页 **502**（真失败）→ **503 · 503 · 503**（冷却期那句人话「那一间刚没起来，等一会儿再试。」；升级那条也是 503） |

**还欠什么（如实说）**：
- **u2 的盒子里那三条后修读数，是父 agent 做的**（要先 `--publish` ＋ 让容器重开 ——
  子 agent 不许发布/重启）。这一节里的真机读数全部来自**一次性容器**；
- 孤儿清扫**只在这个一次性容器里验过"只动 `--profile web`、不动现在这一台"**
  （夹具 K3 是注入式的那一半）——**u2 上真有一台 `--profile sdk` 在跑时的读数还没打**；
- 内存闸那一档在容器里**没被逼到过**（换房间时余量一直够）——夹具 K4 是注入式的读数。

### 八·补3·u2 · ✅ 发布后的**真机读数**（父 agent 打 · 2026-09-26 · u2 的盒子 · 产品层 `af752e466843`）

一次性容器里那两条读数（修前 502×3 ＋ `oom_kill` 0→2→4→6 ／ 修后四次全 200/101 ＋ `oom_kill` 0→0）
在**主人的盒子**上复现并验通了：

```
── 换 4 次（main ⇄ aoshu-bank），宿主侧：选一间 ⇒ 取页 ⇒ 真升一次级 ──
  main         选=302 取页=200(有 boot) 升级=101
  aoshu-bank   选=302 取页=200(有 boot) 升级=101
  main         选=302 取页=200(有 boot) 升级=101
  aoshu-bank   选=302 取页=200(有 boot) 升级=101
── 换完 ──
  内存 396MB · oom_kill 0 → 0（**没涨**）
  /proc 里 --profile web 的进程：**只有一台** pid=145 rss=385764KB
  它现在是哪一间：pid=145 cwd=**/data/workspaces/aoshu-bank**（＝最后点的那一间）
```

⚠️ **读数里两个坑，如实记**（都是探针自己的）：
1. 容器 root **没有 `CAP_SYS_PTRACE`** ⇒ `readlink /proc/<pid>/cwd` 是 EACCES ⇒ 要用**同 uid（1000）的 helper** 去读；
2. 那个 helper 的**命令行里也有 "profile web" 这串字** ⇒ 第一版探针**把自己认成了目标**（读到 `pid=201 cwd=/app`）——
   这就是 `pgrep -f` 那个老坑的同一形状：**探针要先把自己排除**（`/tmp/cwd.cjs` 里的 `Number(d)===process.pid` 那一行）。

### 八·补4 · 🔴 **D4 的答案（终于验到了）：同一间，两个进程**不能同时**用那份会话**

**做法（真机 · u2 的盒子 · 产品层 `af752e466843`）**：先让开发者入口把 `aoshu-bank` 开着（`dsh web` 活着，pid 145 · cwd 就是那一间），
再从聊天那条路往**同一间**说一句。

**读数**：
- 盒里两台并存：`dsh --profile web` 392MB ＋ `dsh --profile sdk` 179MB；内存 562MB/768MB；**`oom_kill = 0`**（不是内存问题）；
- 那一轮**没答上**，用户看到的是我们 `#155·补` 新加的那句诚实话：
  **「我现在接不上活。你这句话我记下了，等我缓过来再说。」**（**有气泡了** —— 这条修复本身生效了）；
- 我拿手动驱动把**原话**打出来了：
  ```
  session "owner/aoshu-bank.muh709vsibnh.1" is already owned by an active write handle
  ```
  ⇒ DSH 的持久化层对每条会话有一把**写租约**（`session.lock`，flock；源码原话
  *"a second acquirer's zero-timeout wait times out"* ⇒ `SessionAlreadyOwnedError`）——
  **第二个进程直接被拒**。

⇒ **"一间一条会话"的必然推论**：**开发者入口把某一间开着的时候，那一间的聊天会被挡住**（反过来也一样）。
⚠️ 只影响**那一间**：别的房间、以及"入口没开那一间"时，聊天照旧（我前面几次真机都是好的）。
⚠️ **这是产品要处理的形状**，不是可以忽略的边角：
- 现在那条话（"我现在接不上活…"）是**诚实的**，但**没说清原因**（主人会以为它坏了）；
- 该做的（等主人拍）：把"这一间正开着"**单独说一句人话**（например「这一间你正开着看，先把它关掉（或换一间）再说话」），
  或者入口那边的房间在"有人聊"时**让开**（收掉那台 `dsh web`），或者给聊天那条路一小段**重试**。
⇒ 记 **B46**。

### 八·补4·修 · ✅ **B46 修法与真机**（`#157` · 2026-09-26）

**两条一起做**（都在**那一个**服务进程里：没新开 HTTP 路由、没改协议字段、没让调度器碰中继的内部变量）：

1. 🔴 **让开（首选）** —— 聊天那条路在某一间**起一轮之前**先问开发者中继"这一间你开着吗"；
   开着 ⇒ 走 `dev-mode.js` 里**已有的** `dropCurrent()`/`killChild()` 那条路收掉那台 `dsh web`
   （**不另写第二套收台逻辑**），并**如实记一句**（哪一间、为什么收）。
   **接缝就是已有的那个形状**：`worlds.js` 把中继的**一个动作**（`yieldRoom`）传给调度器 ——
   与 `onUsage` / `onEgress` / `scopeExists` **同一条路**；调度器只知道"有个动作可以叫"，
   中继内部长什么样它一概不看。三条守卫：**只收"正开着的那一间"**（别的房间一台都不许动）·
   **宿主侧没有那个中继 ⇒ 一次都不问**（不抛）· 收台失败**不许挡着人说话**（那一刻还有下面那一条兜底）。
   ⚠️ **代价是明说的**：收掉之后那个窗口会断开、入口回房间清单页 —— 那页上本来就写着"一次只开一间"。
2. 🔴 **说不清就说明白（兜底）** —— 万一还是撞上写租约（时序 / 别的进程）：
   `session/prompt` 回来的错误里**点名写租约**（`already owned by an active write handle`）⇒ 换成那条能指路的人话
   **「这一间你正开着看，先把它关掉、或者换一间，再跟我说话。」**（**一个内部词都没有**，走 `forbidden_words_test.dart` 那张表）。
   **别的失败照旧**走原来那句 —— 两档混成一个，用户就再也分不清"是我开着那个窗口"还是"它真坏了"。

🔴 **真机读数（一次性容器 · 同镜像/同 cap（**没有 `CAP_KILL`**）/`--memory=768m`/`--pids-limit=512` ·
挂**未发布**的新产品层 `14503d3f1e3e` · **不碰 u2、不发布、不重启**）** —— 脚本 `scripts/check-room-yield-container.sh`：

```
① 用真 dsh --profile sdk 造出这一间的会话（会话映射 {"aoshu-bank":"aoshu-bank"}）
② 真中继起一台真 dsh web 把那间开着：选=302 取页=200(有 boot) 升级=101
   /proc：{pid:47, profile:web, rssKb:~390000}；oom_kill=0
②′ 让那台 web 真的写开这条会话（＝浏览器真的在看它）
   —— 打它自己那条 /api/session/selectModel（第一句 resolveAgent ⇒ ctx.agents.resume）
   回的是 {"code":"session/model-unavailable"} ⇒ 盒里没有模型；不要紧，写开那一步已经发生了

③ 真调度器往同一间说一句
   修后（新产品层）  ：delivered=true   中继日志：开发者入口正开着「aoshu-bank」这一间 ⇒ 收掉那台 dsh web…
   对照层（修前那四个文件）：delivered=false  session "aoshu-bank" is already owned by an active write handle
④ 修后：/proc 里 --profile web=0 台 / --profile sdk=1 台（pid 91）· oom_kill 0→0 · mem 387MB→188MB
   对照层：--profile web 照旧 1 台（pid 47 没死）
```

⚠️ **如实说（两条）**：
- 容器里没有浏览器 ⇒ 让 `dsh web` **写开**这条会话用的是它自己那条 `/api` RPC
  （`session/selectModel` 第一句就是 `resolveAgent`）；**真机那次是主人把那一间的页面开着**，
  两者在"写租约被谁拿着"这件事上是同一个形状（对照层的读数就是证据）；
- u2 盒里的后修读数**还没打**（要先发布产品层 ＋ 让他那台容器重开 —— 那一步是**父 agent** 的，子 agent 不许）。

⇒ **B46 的账在 `77-BLOCKERS.md`（已修）与 `00-PROGRESS.md` `#157`。**
