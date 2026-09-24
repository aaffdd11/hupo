# 81 · 桌面上的「我自己的那台」入口（甲：原始会话流）

> 主人 2026-09-24 定的形态（原话）：
> 「**增加一个小程序。其实不是小程序，打开后就是这个 docker 的 deepseek harness**」
> →「**嵌在琥珀桌面里**」「**免登**」
> →「**docker 里的 dsh，不可能有任何外部访问，只有它访问外部**……用户打开终端，聊天，是在容器内部的与他专属的 dsh 聊天」
> → **最终拍板（甲）**：「那台 DSH 自己的**原始会话流** —— 它的思考、它调的工具、它吐的字，**原样显示**；
>    我这边只当**显示器 + 键盘**，不做任何包装。用 `sdk` 那条 stdio 就够。」

⚠️ **本篇 §五 之前记的是"把 `dsh web` 那张网页露出来"那条路 —— 已作废**（它等于给那个盒子开一个入口，
与上面那条"只出不进"相反）。**那些事实仍留着**，因为它们正是"为什么不能挂在我们站点的路径下"的证据。

---

## 一、容器里到底有什么（实测，`u2` = 19145526557 = `hupo-tenant-hupo-b`）

| 查什么 | 结果 |
|---|---|
| `/bin/dsh` | ✅ → `/app/node_modules/@deepseek-ai/dsh/lib/bin.js`，版本 `0.1.5-rc.1` |
| `dsh --version` / `dsh web --help` | ✅ 真安装；`web` 是 `--profile web` 的别名 |
| 平时怎么用它 | 壳用 `dsh --profile sdk` 起**长驻**子进程、stdio **换行分隔 JSON-RPC 2.0** 一问一答（`agent-runtime.js:315-341,392-393,500-507`）——琥珀的对话走的就是它 |
| 它对外 | **只出不进**：无根 podman、**无 `-p`**、宿主到它只有我们自己的一条域套接字；模型请求发给**盒内** `127.0.0.1:8787` |

## 二、🔴 为什么"挂在我们站点路径下"不成立（三重证据，别再试）

| 事实 | 证据 |
|---|---|
| 前端把 API 算在 **`location.origin` 根**上 | `dsh-client-connection/lib/client.js:6206`（`new URL(\`${channel}/${endpoint}\`, resolveBase())`）、`:6252-6256` |
| **没有任何外部覆盖钩子** | 无 `apiBase`/`baseHref`/`__DSH_API*`；否则落到假 origin `http://dsh.internal`（`:6185`） |
| 没有 `--base-path` 开关 | `dsh web --help` 只有 `--host/--port/--trusted-host/--no-open` |
| 页面里绝对+相对路径混用 | 容器内带 cookie `GET /`（**200**、27724 字节）里既有 `/plugins/??@deepseek-ai/…` 也有 `./assets/…` |

⇒ 那条网页**必须独占一个 origin 的根**。**主人否掉了这条路**（它要开一个入口）⇒ 作废，不再讨论。

## 三、鉴权机制（留作证据，甲用不到）

`/?token=<进程令牌>` → **303 + `Set-Cookie: dsh-auth-…`**；不带令牌 `GET /` **401**；
`/api` 那道 browser-trust 栅栏：`Host` 必须回环或声明过，`Origin` 异源 / Sec-Fetch-Site cross-site ⇒ **403**（正反例都实测过）。

## 四、甲为什么成立（实测的原始流）

在容器里**真驱动了一次裸 DSH**（`--profile sdk` + **只挂模型那条 patch**，独立 HOME，cwd `/data`）：

```
命令行: --profile sdk --patch /app/code/hupo-model-proxy.yml
← 响应#1 {"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}
← session.event  permission/preset · sandbox/mode · approval/policy · agent/inbox/spliced
                 turn/start · step/start · system/message · user/message
                 request/header（★ 这一轮的工具清单就在里面）
                 request/context · session/title · assistant/message · step/end · turn/end
← session.status running → idle
它回的话：「我是 DeepSeek Harness 驱动的 AI 编码助手。」   ← ★ DSH 本人，不是琥珀
```

四条关键事实：
1. **不挂人格/能力层也照样能用**（模型那条 patch 必须有，否则它没有模型 —— 真 key 在盒内 8787 那个小代理手上）。
2. **`HUPO_MODEL_TICKET=hupo-local-model-proxy` 是镜像里烘死的 env**（`build-tenant-image.sh:315`）⇒ 不用我们给。
3. **不会卡在审批上**：SDK 协议 README 原文 —— *"Server→client requests are a dead capability — the transport supports them, but the server never sends one"*。
4. **"放弃一轮"就是关进程**：同上 *"No cancel or session-close methods — a client abandons a turn by closing the runtime process"*。

## 五、契约（甲 · 两侧照它写，**字段冻结**）

### 5.1 传输：新增一条 WS 路径 `/api/harness`（主机 origin）

照 `/api/asr` 那套现成做法（`ASR_PATH`，`src/asr.js:24`；宿主 WS 白名单在 `src/server.js:1297-1298`，
租户升级转发在 `:1335-1343`）：

- 客户端连 `wss://<主机 origin>/api/harness?…`（**令牌按 `/api/stream` 现有的那一套**，不许新造）；
- 远端用户 ⇒ 宿主经 `proxyFor(tenant)` **升级进容器**（现有那条）；
- 容器侧 `handleUpgrade(req, socket, head, trusted)` 接住；
- 🔴 **公网口（`trusted === false`）一律拒**（同 `handleRequest` 的闸门，`src/server.js:403`）。

### 5.2 线上消息（**只有这三种，别加字段**）

| 方向 | 消息 | 含义 |
|---|---|---|
| 客户端→容器 | `{"t":"say","text":"…"}` | 说一句 |
| 客户端→容器 | `{"t":"stop"}` | 放弃这一轮（= **关掉那个 DSH 进程**，协议没别的办法）|
| 容器→客户端 | `{"t":"state","s":"booting"\|"ready"\|"gone","why":"人话"}` | 进程状态；`why` 只在 `gone` 时给原因 |
| 容器→客户端 | `{"t":"raw","m":<对象>}` | **DSH stdout 的每一条 JSON-RPC 消息，原样**（不裁剪、不改名、不丢字段）|

🔴 **容器不许做投影**：它只起进程、喂 stdin、把 stdout 整条丢过来。**"这是什么意思"全部在客户端解**。

### 5.3 容器那一侧（`serve.js`，只在 `trusted === true` 时）

- **一个 WS 连接 = 一个 DSH 进程**：连接建立 ⇒ 起
  `dsh --profile sdk --patch <modelPatch>`（**不挂人格、不挂能力层**），cwd = `cfg.agentCwd`，
  env 照 `agent-runtime` 那套（**`childEnv()` 摘掉密钥之后再给**）；`initialize`（参数照 `agent-runtime.js:432-439`）
  成功 ⇒ `state:ready`；进程退出 ⇒ `state:gone`。
- `say` ⇒ `session/prompt`（`sessionId` 用 `crypto.randomUUID()`，`contentBlocks:[{type:'text',text}]`，照 `agent-runtime.js:454-465`）。
- `stop` / 连接断开 ⇒ **杀掉进程、收干净**（不许留孤儿）。
- ⚠️ **与琥珀自己那条路完全隔离**：另一个进程、不带人格/能力 patch；**不许复用、不许干扰** `agent-runtime` 的实例与 LRU。

### 5.4 客户端那一侧

- 桌面磁贴沿用已定的 id `harness` 与标签 **「我自己那台」**（过禁词闸）。
- 点开 = 桌面上一个**终端层**（`MiniAppHost` 那一层，不 push 新页面）：一个滚动区 + 一个输入框。
- **已知事件画成人话**（`session.event` 里 `params.event.type`；探针见过的 14 种都要有落点）：
  `turn/start`·`step/start`·`step/end`·`turn/end` = 结构行；`system/message`·`user/message`·`assistant/message` = 文本；
  `request/header` = 工具清单（折起/摘要）；`request/context`·`session/title`·`permission/preset`·`sandbox/mode`·
  `approval/policy`·`agent/inbox/spliced` = 一行说明。
- 🔴 **未知事件不许隐藏**：画成「类型 + 一小段 JSON」⇒ "原样"这条才有判据。
- 断线/`gone` ⇒ 一句普通话 + 「重来」（重连 = 重起进程）。
- ⚠️ **"工具名"那道闸的张力（已知、有意为之）**：站规禁"内部词/工具名上屏"（`AGENTS.md` §六·4），
  而甲要"**它调的工具原样显示**" ⇒ 折中是：
  **我们写的字面量一个工具名都不许有**（禁词闸管的是这个），
  **它自己吐出来的内容（含未知事件的 JSON）原样上屏**（这正是甲的本意）。
  `request/header` 是**"这一轮可用"**的工具清单（不是"调用过的"）⇒ **只报件数**。
  真正的调用会在未知事件里**原样**出现（探针那一轮没调工具，所以事件名未验，靠 H8 的兜底显示）。

## 六、判据（每条都要能反着验）

| # | 判据 | 在哪验 |
|---|---|---|
| H1 | **公网口**（`trusted=false`）升级 `/api/harness` ⇒ **拒** | 服务端 unit（闸门反例）|
| H2 | 不带令牌升级 ⇒ **拒** | 服务端 unit |
| H3 | 连上 ⇒ 先 `state:booting`，`initialize` 成 ⇒ `state:ready`；进程退 ⇒ `state:gone` + 人话 | 容器 unit |
| H4 | `say` 一句 ⇒ 回流的 `raw` 里**出现过** `params.event.type === 'assistant/message'` | 容器 unit（假 stdout 注入）|
| H5 | 🔴 **它是 DSH 本人**：`system/message` 含 DSH 那句固定开场、**不含琥珀人格的特征串** | 容器 unit（反例：挂了人格 patch 就必须红）|
| H6 | 连接断开 / `stop` ⇒ **子进程收干净**（没有孤儿）| 容器 unit |
| H7 | **隔离**：harness 那一路不动琥珀自己的实例（另一个进程、另一个 profile 实例）| 容器 unit |
| H8 | 客户端渲染：14 种已知事件各有落点；**未知事件画出类型 + JSON**（不隐藏）| 客户端 unit |
| H9 | **真图**：对活系统连 WS、发一句、收到 `assistant/message`；且流里**没有琥珀人格** | `scripts/check-harness.mjs` |
| H10 | 反例：无令牌 / 从公网口连 ⇒ 拒 | 同 H9 脚本 |
| H11 | 界面上：磁贴真在、点开真进去、**截图说** | 浏览器那条路 + `--shot` |

## 七、复用的现成管道

| 事 | 落点 |
|---|---|
| 桌面磁贴 | `lib/screens/chat_screen.dart:290-323`（清单）、`:597-607`（`_openMiniApp`）、`:472-485`（`_appView`）|
| 客户端 WS 与地址算法 | **`lib/services/stream_uri.dart`**（`ws://` vs `wss://` 那个老 bug 的落点，见 `docs/dev/16-STREAM.md`）⚠️ **`links.dart` 只管"打开外部链接"，不是算 WS 地址那一份**（我一开始指错了，客户端 agent 按实质要求做对了）|
| 宿主 WS 白名单 / 租户转发 | `src/server.js:1297-1298`、`:1335-1343`、`proxyUpgrade` `:1394-1420` |
| 容器侧升级接住 | `handleUpgrade(req, socket, head, trusted)` `src/server.js:1295` |
| SDK 协议（照抄）| `src/agent-runtime.js:392-393`（读行）、`:500-507`（发请求）、`:432-439`（initialize）、`:454-465`（prompt）|
| 盒内模型代理 | `entry.mjs:131-132`（起在 8787）、`model-proxy.mjs:40` |
| 模型 patch | `hupo-model-proxy.yml`（`apiKeyEnv: HUPO_MODEL_TICKET`）|

## 八、明确**不做**的事（写了就是不做，不是"以后再说"）

1. **不给那个盒子开任何入口**：不露 `dsh web`、不新增公开 origin、不碰 VPS、不动 nginx/frp。
2. **不做 TUI**（乙）：盒里没有 TTY 支持，验都没验；主人选了甲。
3. **不给它挂人格/能力层**：它是"那台 DSH 本人"，不是琥珀。挂了就变成丙了（判据 H5 钉着）。
4. **不改 `dsh web` 相关的任何东西**（第一节那些事实只作证据留着）。

---

## 九、落地结果（2026-09-24 收尾）

### 9.1 部署了什么

| 事 | 结果 |
|---|---|
| 产品层（盒里那半边） | `d3930b0451d2` → **`e55d10ef3e83`**（`--verify` 真跑一个容器验过才翻转，记账一行）；盒里实测已是新版、`harness-session.mjs` 在位 |
| 中心（宿主那半边） | 重启过（`restart-core.sh`）；`server.js` 里那条路由与"公网口一律拒"那道闸才会生效 |
| 客户端 | 入口指纹 **`bf57c74a2d9d`** 上线，部署后浏览器自检过 |
| **VPS 一行**（**主人 2026-09-24 签字**） | `deploy/nginx-w-stalkerai.conf` 的 WS location：`^/api/(stream\|asr)$` → **`^/api/(stream\|asr\|harness)$`**。⚠️ **不改它，`Upgrade` 头不转发 ⇒ 从 `w.` 连必然 401**（本地直连 8020 却是好的——这类"本地好、公网不通"最容易误判成令牌问题）。线上已改 + `nginx -t` + reload + 备份；仓库抄本**逐字节同步**（`check-nginx-drift.sh` ✓）。顺手修掉那个脚本第 59 行**没转义的反引号**（它会把抄本当命令执行，报一句 "Permission denied"） |

### 9.2 判据的真读数

- **H9/H10（对活系统）**：`HUPO_TOKEN=<u2 的令牌> node scripts/check-harness.mjs` ⇒ **4 通 · 0 没通 · 0 没验到**
  （握手上、`state:ready`、说一句收到 `assistant/message`、**流里没有琥珀人格**；不带令牌 ⇒ 401；公网口 ⇒ 404）。
  它回的原话：「你好！我是 DeepSeek 驱动的 AI 编程助手，可以帮你阅读和修改代码…」⇒ **是那台 DSH 本人**。
- **H11（真浏览器）**：`check-web-browser.mjs --shot` + 语义节点点击 ⇒ 截图里就是那个终端层：
  一行 `它应了一声` + **原样的** `{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}`，
  下面是「说一句」和「停」。页面里 **2 条 WebSocket、断过 0**。
- 服务端 **872 全过**（839 原有 + 33 新）· 客户端三道硬闸全过（unit 424 / a11y 206）。

### 9.3 🔴 事故记录（**我自己造成的，必须留痕**）

**做了什么**：我在盒子里做可行性探针时，有一次是用 **root** 跑的，而且 `DSH_HOME` **继承了容器真实的 `/data/dsh`**
（不是我给探针准备的那个临时目录）。

**后果**：那次 root 启动在**租户真实的 DSH home 里留下了 17 个 root 属主的文件**（`.credentials.yaml`、
`storages/session_projcache`、`storages/workspace.json`、`profiles/web/*`、一个 session 目录…）。
而 agent 是以 **uid 1000** 跑的（"换手"那条安全设计）⇒ **此后 uid 1000 起不来任何新的 DSH**：

```
EACCES: permission denied, open '/data/dsh/.credentials.yaml'
failed to apply loader entry credentials (@deepseek-ai/dsh-credentials-local)
```

⇒ 表现是**那台盒子里新开的会话会失败**（长驻的老进程还活着，所以**不特意看是发现不了的**）。
第一次 H9 报的 `cannot create effect on inactive context` 也是这条根因的另一种表现。

**怎么发现**：H9 报错 → 照中继的形状（换手到 uid 1000）复现 → 拿到 `EACCES` → 才回头看属主。

**怎么修的**：先确认 **DSH home 里没有任何真钥匙**（无 `refs`、无 `DEEPSEEK_API_KEY`；`.credentials.yaml` 只有 161 字节、
是 DSH 自己那个凭据库的随机 secret），再把**属主不是 1000 的那 17 个条目改回 1000:1000**（最小动作，逐个列出后才改）。
复验：甲那条 `initialize ✅ 通了`。
> ⚠️ 顺带排除了一个假怀疑：**琥珀自己那组 patch**在我的探针里**也**起不来，但那是**探针环境不全**（能力层那条
> `mcp-ledger` 塞的是 `!!js process.env.HUPO_NODE_BIN` / `HUPO_LEDGER_SERVER`，那两个是运行时才设的）；
> **不是盒子坏了**。判据：真进程的 env 里没有这两个名字（它们是 `entry.mjs`/`serve.js` 跑起来才补的）。

**教训（已记进 `00-PROGRESS.md` §九）**：
🔴 **在租户盒子里探针，永远用自己准备的 `HOME` 与 `DSH_HOME`，永远不许用 root 起 DSH** ——
"我只看看"和"我把别人家写坏了"之间只差一个环境变量。

### 9.4 还欠的（**明说，不藏**）

1. **没有"属主被写坏"的闸**：这次是靠人肉看出来的。该有一条闸定期读每个盒子的 `/data/dsh` 属主
   （像 `check-tenant-creds.sh` 那样经 `runuser` + `podman exec`），root 属主一出现就报。**记在 `77-BLOCKERS.md`。**
2. **背压没做**：客户端慢的时候 `ws.send` 会堆内存（"原样"这条要求不许丢帧）。要收紧得先定规则。
3. **主人自己那个号走不到这条路**：`owner` 是 `local`（没有盒子），公网口按 H1 一律拒 ⇒ 他在自己账号上点开会看到
   "它这边停下了"。要用就得用**有盒子的号**（例如 `u2`）。要给主人也开，那是另一件事（`82-DEV-MODE.md` 那条更合适）。
4. **H9 只对着 `u2` 那台盒子验过**（`u1`/`hupo-a` 没有钥匙，验不了模型那条）。
