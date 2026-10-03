# 157 · 出界那条独木桥的闸（92 §③ 阶段 2 → 一条能重复跑的闸）

> **一句话**：把 `92-TRIPLE-PLAN.md` §③ 阶段 2 的判据 **A–E** 落成
> `scripts/check-outbound-bridge.sh`（逐条打 `OK`／`BAD`），并补上判据 D 的一个**真洞** ——
> 原来的源码扫描只认目录名**字面量**，一个用 `published.root` 拼路径的**第二出口**能从它底下绿着过去。
>
> **这一批没有改产品代码**（`v2/services/core/src/**` 零改动）。依据见 §〇。
>
> 依据：`92-TRIPLE-PLAN.md` §②／§③ 阶段 2／§④ · `93-OUTBOUND-USAGE.md` §二／§三 ·
> `98-STAGE3-DEFAULTS.md` §二 · `156-SCOPE-BOUNDARY-GATE.md` ·
> 以及**本轮亲自核过的代码与盘上读数**（每条代码断言给 `文件:行`，读数见 §三）。
>
> 🔴 纪律：**不写数值**（阈值／上限只住代码）· **读不出就报 `不可算` 并记失败** ·
> **每条判据都要有负向对照**（而且脚本要核那条对照真的在）· **不伪造一致**。

---

## 〇、先钉一个事实：**阶段 2 的代码早就在树上了**

动手前先 `git status --short`（**干净**）并查历史，读到：

| commit | 是什么 |
|---|---|
| `5d5179a` | **阶段 2**：出界收成一条独木桥 ＋ 声明带锚（＋ 96 决策登记 ＋ 94／95 付费层契约） |
| `afb0a78` | **阶段 3**：出界闸默认值翻过来（两格都读、按声明判、默认最严、没有自动生效路） |

⇒ `src/outbound.js`（唯一裁决 `assertOutboundAllowed`／`adjudicate`）与
`src/app-outbound.js`（外联申报 A16）**都在**，`src/published.js:124` 的第一件事就是过闸；
`test/outbound-gate.test.js`（阶段 2 的 §2-1…§2-10）与 `test/outbound-defaults.test.js`（阶段 3）
也都在，`npm test` 本轮实测 **1428 通过／0 失败**。

**所以这一批做的不是"再实现一遍阶段 2"**（那只会把已经绿的东西弄坏），而是三件：

1. **把 A–E 变成一条能重复跑的闸** —— 逐条打 `OK`／`BAD`，每条自带负向对照（`scripts/check-outbound-bridge.sh`）；
2. **补判据 D 的一个真洞**（§三·D）：原来只认字面量，绕开字面量的第二出口漏网；
3. **把"今天出界有几条路、各查了什么"这个读数记下来**（§一）。

⚠️ 本批的验收口径是 §③ 阶段 2 的**「做完的标志」**：**出界只一条路；无锚包上不去** ——
这一句从本批起是**机器判**的（闸绿＝成立），不是文档里的一句话。

---

## 一、今天"出界"原来有几条路、每条路上各查了什么

> 🔴 **不许凭直觉列。** 下面是本轮核过的代码事实（`文件:行`）。

### 1.1 真正把字节**写出去**的：**一处**

"出界"＝**别人的东西能拿到你这一格里的字节**。往**共享库**（`<data>/published-apps/`）**写**的
代码，全仓**只有一处**：`src/published.js` 的 `Published.publish()`
（源码扫描读数 `[published.js]`，见 §三·D-③）。

### 1.2 能**走到**那一处的入口：三条，但**共用同一个裁决**

| # | 入口 | 住哪 | 它自己先查什么 | 到写入者之后 |
|---|---|---|---|---|
| ① | 本地域套接字 `op:'publish'` | `src/apps-socket.js:336` 一带 | 先 `snapshotWorkspace`（把"正在改的那一间"打包）⇒ `assertOutboundAllowed`（route=`publish`）⇒ `reviewForPublish`（规则／申报／用量／评审 agent） | 再进 `published.publish` |
| ② | MCP 工具 `app_publish` | `src/mcp-apps-server.mjs` → 域套接字 → 同 ① | 同 ①（**它没有第二道自己的判**） | 同 ① |
| ③ | 直调 `Published.publish` | `src/published.js:124` | —— | 自己第一件事就是过闸 |

⚠️ **三条入口不是三份检查**：①②③ 最后都落在 `published.publish` 的第一行，
而那一行调的**就是** `outbound.assertOutboundAllowed`（`test/outbound-gate.test.js` §2-9 逐条打过：
直调／本地那条口／真 MCP 工具，一条都绕不过）。

### 1.3 写入者内部查了什么（顺序即判据）

`published.publish()`（`src/published.js`）今天是这个顺序：

1. `assertOutboundAllowed()` —— **出界那一条独木桥**（`src/published.js:124`），跑在**任何写盘之前**：
   读 `<scope>/.exp/` 与 `<scope>/.data/` 两格的 `pack.json`，逐条判"`share:true` 有没有锚"；
2. 重名判（id 被别人占了 ⇒ 拒）＋ 读这一版的字节（`apps.read` 逐字节核 hash）；
3. `assertDeclarationAllowed()`（`src/published.js:145`）—— **外联申报 A16**：读制品里的
   `outbound.json`，与代码里扫出来的出网点对照（R1／R2）。也是**写盘之前**；
4. 复制文件 ＋ **逐字节核对 hash** ⇒ 写 `index.json` ⇒ 审计。

### 1.4 另外两条"出去律"今天**不搬字节**（所以不是出口）

| 路 | 今天的事实 | 依据 |
|---|---|---|
| **一对一交付** | 阶段 4 只建**登记面**（请求／同意／交付／撤回四条记录），**不搬字节** | `src/delivery.js` 卷首 ＋ 判据 S4-9 |
| **制品口** | 发的是**制品自己**（`manifest.files`，`workspace.read()` 跳过 `.` 开头的路径）；不是"出给别人" | `src/app-serve.js` · `src/apps.js` 的 `refuseHiddenRelPath` |
| **导出** | 导的是**聊天记录**，与 `.exp／.data` 无关 | `src/export.js` |

⚠️ **组件名对不上的一处**：`outbound.js` 的 `OUTBOUND_ROUTES` **声明了三条口**
（`publish`／`artifact`／`deliver`），但今天 `assertOutboundAllowed` **只被 `publish` 调到**。
今天这不构成洞（上表那两条**不搬字节**），但**阶段 4／5 真搬字节时必须接上** ——
否则"三条口共用一个裁决"就只剩一句话（§六·2 记着这笔）。

**⇒ 一句话读数**：**今天出界只有一条路**（写共享库），**入口三条、检查一处**；
另加一份**同在这条路上的第二份声明**（`outbound.json`，A16）。

---

## 二、收成了什么形状（一处检查叫什么、在哪）

| 件 | 名字 | 住哪 | 谁调 |
|---|---|---|---|
| **唯一裁决** | `assertOutboundAllowed()`（内部是 `adjudicate()`） | `src/outbound.js` | 唯一写入者 `published.publish`（`src/published.js:124`）＋ 上架入口的**前置同一道闸**（`src/apps-socket.js:336`，幂等） |
| **申报读取** | `readPacks()`（两格，fail-closed） | `src/outbound.js` | 上面那个裁决 |
| **第二份声明（A16）** | `assertDeclarationAllowed()` | `src/app-outbound.js` | 同上写入者（`src/published.js:145`）＋ 预审／运营方复评读它 |

**"无锚包上不去"** 落在这三句（都在 `readPacks`／`adjudicate` 里，`src/outbound.js`）：

- 包目录在、`pack.json` 读不到／看不懂／`schema` 认不出／`outbound` 取值认不出 ⇒ **拒**（默认最严）；
- `share:true` 而没有 `anchor` ⇒ **拒**（"说不清来路的东西不出去"）；
- 锚的**形状对但核不出来**，或指回上游而**血缘没有那条边** ⇒ **拒**。

---

## 三、判据 A–E 的读数（每条含**负向对照**）

跑法：

```bash
bash scripts/check-outbound-bridge.sh
```

本轮读数（2026-10-03 本机，**只碰临时目录，不碰线上、不碰真共享库**）：**通过 9 · 失败 0**。

| 判据 | 它问什么 | 读数 |
|---|---|---|
| **A** | `.exp/` 里一份**受版权记录** ＋ `share:true` ＋ **没有锚** ⇒ 上架必须红 | ✓ **红**：`OutboundError：包「notes／notes.md」标了可分享，却没有可核起点（来源 rootHash）—— 说不清来路的东西不出去`；**盘上零残留** |
| **B** | 补上来源 `rootHash`（锚）⇒ **过** | ✓ **过**（正对照，证明闸不是空转）：`rootHash` 逐字带出去，共享库 `versions/1/` 里**真有** `index.html` |
| **C** | 把锚**删掉** ⇒ **又拒**（不是"一次通过就永远通过"） | ✓ **又红**（同一条声明：加锚过、删锚拒，逐字同上那条文案） |
| **E1** | `share:false` ⇒ **该走的走** | ✓ **过**，且那份字节**不进共享库**；**负向对照**：同形状改成 `share:true` 无锚 ⇒ **拒** |
| **E2** | `outbound=one-to-one` ⇒ **永不出**（包级说了算） | ✓ 带出去的条目 **0** 条（逐条写着 `share:true` 也不算数）；**负向对照**：包级改成 `share` ⇒ **拒** |
| **E3** | **未声明**（目录在、`pack.json` 不在）⇒ 拒（默认最严） | ✓ **拒**：`包「notes」没有可读的 pack.json —— 读不到声明就不许出去`；**负向对照**：补一份合法 `never` 声明 ⇒ **过** |

### D 🔴 冒出第二个绕过这条检查的出口 ⇒ 红

D 是**源码级**判据，分三读：

| 读 | 它问什么 | 读数 |
|---|---|---|
| **D-①** | 既有那条：写共享库的只许一处（认**字面量**），且必须过闸 | ✓ `test/outbound-gate.test.js` 过 **14** 条／败 0（含负向对照「第二出口」） |
| **D-②** | **加强**：绕开目录名**字面量**的第二出口也要红 | ✓ `test/outbound-single-exit.test.js` 过 **7** 条／败 0（含负向对照 `PLANTED_SECOND_EXIT`） |
| **D-③** | 真树读数：能写共享库的文件 | ✓ `[published.js]` —— **只有一处** |

#### D 原来那个洞（**这是本批改的唯一一处真东西**）

`test/outbound-gate.test.js` §2-10 的扫描认的是正则 `published-apps|PUBLISHED_DIR`。它抓得住
"另开一个文件、自己拼那个目录名"，却**漏掉**这一类 —— 一个字面量都没提：

```js
const d = nodePath.join(published.root, id, 'versions', '1');   // ← published.root 已经拼好了
nodeFs.writeFileSync(nodePath.join(d, 'index.html'), buf);
```

`published.root` 那一半路径**由 `published.js` 自己提供** ⇒ 第二出口可以**完全绕开字面量**。
**实测（植入负向对照，验完即删）**：

| 动作 | D-①（老扫描） | D-②（加强版） | D-③（真树读数） |
|---|---|---|---|
| 干净树 | ✓ 绿 | ✓ 绿 | `[published.js]` |
| 植入 `src/__probe-second-exit.js`（用 `published.root` 写 `versions/1/index.html`） | **✓ 照旧绿**（漏网） | **✗ 红**（`D-1` 败 1 条） | **✗ 红**：`[__probe-second-exit.js,published.js]` |
| 删掉探针 | ✓ 绿 | ✓ 绿 | `[published.js]`（**零残留**） |

⇒ **老扫描放它过去了**，这正是判据 D 原话要防的那件事；加强版（`test/outbound-single-exit.test.js`）
补上那一半：认两种形态 —— **目录名字面量**，或者**拿到 `Published` 的路径访问器
（`root`／`appDir()`／`dir`）再动写盘** —— 外加"裁决只许有**一处定义**"。

#### D 的局限（**如实写**）

扫描是**字符串层面**的，它抓的是"**认得出来的**第二出口"：

- 把目录名拆开拼（`'published-' + 'apps'`）、或绕开 `Published` 直接从 `dir` 硬拼 ⇒ **这一层抓不住**；
- 真正的结构性保证是"**共享库只有一个写入者**"这件事本身（`published.js`），扫描只是**不让它悄悄多出第二个**。

---

## 四、新增／改了哪些文件（逐条）

> **产品代码零改动**（`v2/services/core/src/**` 一个字节没动）。

| # | 路径 | 新／改 | 是什么 |
|---|---|---|---|
| 1 | `scripts/check-outbound-bridge.sh` | **新** | A–E 逐条打 `OK`／`BAD` 的闸；每条自带负向对照；D 复用两份测试 ＋ 真树读数；末尾 `通过 N · 失败 M` |
| 2 | `v2/services/core/test/outbound-single-exit.test.js` | **新** | 判据 D 的**加强版**扫描（字面量 ＋ 路径访问器 ＋ 唯一裁决定义），自带 `PLANTED_SECOND_EXIT` 植入对照与"只读不许误伤"对照 |
| 3 | `docs/dev/157-OUTBOUND-BRIDGE-GATE.md` | **新** | 本文 |
| 4 | `docs/dev/00-PROGRESS.md` | 改 | §〇 顶部加一行（一句话 ＋ 读数） |

**没改**（按纪律）：`docs/handbook/**` · `AGENTS.md` · `v2/apps/mobile/**` ·
`scripts/check-scope-boundary.sh`（阶段 1 那条，**原样**绿）。

---

## 五、为什么不扩 `check-scope-boundary.sh`（阶段 1 那条）

那一条管的是 `92` §④ 的**「真机」那一列**（真上架一次、碰真共享库、跑完**逐字节复原审计账** ＋
再搜一遍哨兵核零残留）；这一条管的是**「离线」那一列里属于阶段 2 的那几行** ——
临时目录里造声明、真调 `published.publish`，**不碰线上、不碰真共享库**。

两列判据、**两种风险**（一个会动真盘、一个不会）。混成一条脚本，会让"**这条脚本能不能随便跑**"
这件事变模糊 —— 而"别把会动真盘的闸当定时任务跑"（`156` §五·4）正是要靠这个区分守住的。
⇒ **新开一条**，并在脚本头部写明为什么不扩。

---

## 六、没做成 / 不确定 / 需要主人拍板

1. **没做成的**：**无**（阶段 2 的「做完的标志」＝"出界只一条路；无锚包上不去"—— 本批起由闸机器判，**绿**）。
2. **不确定（工程上的，记给下一批）**：`OUTBOUND_ROUTES` 里 `artifact`／`deliver` **今天没接线**
   （今天它们不搬字节 ⇒ 不构成洞）。**阶段 4／5 真搬字节时，`assertOutboundAllowed` 必须被接上** ——
   建议那时**同时**把闸里的 D-③ 真树读数扩成"**每一条声明出去的口都必须调到那个裁决**"，
   否则"三条口共用一处检查"会退化成一句注释。
3. **不确定（判据强度的取舍，未拍）**：今天 D 认的是"**文件级写入者 + 裁决定义处**"。
   要不要再收紧到"`Published` 的**每一个能写共享库的方法**都必须过闸"？那需要把写盘收敛成
   一个带闸的私有方法（**结构性重构**，会动 `src/published.js`）。本批**没动** ——
   它是取舍，不是缺陷。
4. **需要主人拍板的**：**本阶段没有卡在主人身上的决定**。
   ⚠️ 相邻两处**别人的**待拍仍在 `92` §⑥（一对一交付通道 · 可分享的声明**粒度**）
   与 `90` §10.1／§10.2 —— 它们**不影响**阶段 2 的结论，本文一条都不替它们定案。
5. **手册不一致（照代码记，不改手册）**：
   - `92` §⑤·1 那句"**闸只在脏树上**"**已过期**（阶段 1 已在 `3b5eceb` 提交，`93` §九·1 已指出）；
   - `92` §⑤·4 那句"`.exp/notes.json` 放受版权记录 ＋ `share:true` ⇒ **今天全绿**"**已过期** ——
     本批判据 **A** 就是它的反着验，今天**必须红**（读数见 §三）。
   - 本批**没改** `docs/handbook/**`；要升版的是 `08-SPEC.md`（§14 两格载体与两道边界）那一簇，
     按 `92` §⑦ 一次升上去，等 §⑥ 拍完再写。

---

## 附：本文核过的代码与盘上事实（清册）

| 文件 | 核到的关键行 |
|---|---|
| `v2/services/core/src/outbound.js` | `:53,56` 两格名 · `:63` `PACK_DIRNAMES` · `:143` `readPacks`（fail-closed） · `:217` `adjudicate`（唯一裁决） · `:287` `assertOutboundAllowed` |
| `v2/services/core/src/published.js` | `:124` **第一件事过闸** · `:145` 外联申报闸 · `:147` 起才写盘 |
| `v2/services/core/src/apps-socket.js` | `:336` 上架入口的前置同一道闸 |
| `v2/services/core/src/app-outbound.js` | `:263` `assertDeclarationAllowed`（A16） |
| `v2/services/core/src/delivery.js` | 卷首：**只写登记、不搬字节**（S4-9） |
| `v2/services/core/test/outbound-gate.test.js` | `:447` §2-10 老扫描（只认字面量） |
| `v2/services/core/test/outbound-single-exit.test.js` | 本批新增（加强版扫描 ＋ 植入对照） |

**盘上／仓库事实（本轮实测）**：`git status --short` 开工时**干净** ·
`npm test` **1435 通过／0 失败**（改前 1428；本批 +7）· `check-scope-boundary.sh`（portable）
**通过 6 · 失败 0**（照旧绿，未改）· 本闸 **通过 9 · 失败 0** · 植入第二出口的探针文件**已删、零残留** ·
`src/pack.js` **不存在**（本仓没有这个文件）· `docs/dev/91-EXPERIENCE-LAYERS.md` **不存在**。
