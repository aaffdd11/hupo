# 165 · **形状随 fork 走、值永不随**（`D4.24` · **A1** · 2026-10-03 主人定）

> **一句话**：给小程序加一份**制品内固定名文件**（`data-shape.json`）＝**数据形状声明**，
> 它只描述"这份数据长什么样"（键名／类型／空值口径／去重键），**一个值都不装**；
> 因为它就是制品里的一个普通文件 ⇒ 进 `manifest.files[]` ⇒ **被 `rootHash` 盖住**（随版本冻结）、
> **随 fork／装上一起复制**；而值住在**它自己那一格**（`<scope>/.data/<pack>/`），
> **任何一次上架／装上／分叉都一个字节都不带**。盘上有数据格却没有形状声明 ⇒ **拒**
> （人话、点名哪一格、盘上零残留），**不是安静放过**。
>
> **依据**：`docs/handbook/05-DECISIONS.md` **D4.24**（A1 = **乙**）·
> 签字页 [`docs/dev/161-OWNER-DECISIONS-11.md`](161-OWNER-DECISIONS-11.md) A1 ·
> `docs/dev/90-APP-CONTRACT.md` §3.2／§3.3 Q3.1／Q3.2 · `docs/dev/91-TRIPLE-CONTRACT.md` §3.2／§6.6／§8.1／§2.3.3 ·
> `docs/dev/92-TRIPLE-PLAN.md` §② · [`docs/dev/89-APP-MARKET-FORK.md`](89-APP-MARKET-FORK.md) §⑤（"数据形状声明随 fork 走，值永不随"）·
> **本轮亲自核过的代码与读数**（§二／§附）。
>
> 🔴 纪律：**阈值/上限只住代码**（本文不写）· **读不出就报 `不可算` 并记失败** ·
> **每条判据都有负向对照** · **不伪造一致**。

---

## 〇、动手前的事实

- 本轮开工时 `git status --short` **干净**；`HEAD = 037d402`（读侧断言收口）。
- **A1 的理由（原文）**：选甲（契约与数据打包上架）会让"每次上架都要现场判断这坨数据进不进快照"，
  **错一次就是私密数据发布事故**。⇒ 主人选**乙**：制品先上，形状声明随 fork 走。
- 今天**没有**"形状声明"这个东西；`.data/`／`.exp/` 这两格**只有边界、没有形状**：
  `outbound.js` 判的是"**能不能出去**"，`apps.js` 判的是"**制品里不许有 `.` 开头**"，
  `workspace.js` 只跳过 `.` 开头 —— **没有一处描述"数据长什么样"**。
- 已有的两个"形状"号**都不是它**（91 §8.1「三个号互不代管」）：
  `apps.shapeVersion()` = **能力体那一族**（`manifest.schema`）；`delivery` 的 `shapeVersion` = **交付登记里的一格**。

---

## 一、形状今天长什么样、声明落在哪、fork／装上各走到哪

### 1.1 声明落在哪（**固定名制品文件**，不是 manifest 字段）

| 项 | 是什么 |
|---|---|
| **载体** | `<scope>/data-shape.json`（**非 `.` 开头** ⇒ 进工作区快照）→ `hupo/apps/<id>/versions/<n>/data-shape.json` |
| **为什么是文件不是字段** | `90` Q4.9／`92` §⑥ 那两条拍过板：`manifest.json` 会被下一版覆盖 ⇒ 形状会漂；**固定名文件才被 `rootHash` 盖住** |
| **为什么与 `outbound.json` 同款** | 同一个形状：制品内固定名文件 · `schema` 版本化 · 读不到／认不出 ⇒ **拒**（fail-closed） |
| **顶层封闭** | 只许 `schema`／`packs`；每一包只许 `pack`／`shapeVersion`／`keys`；每一列只许 `name`／`type`／`null`／`dedup` |
| **号是谁算的** | `shapeVersion` = `sha256(canonical({pack, keys}))` 的前若干位 —— **内容地址，不由人填**；号对不上形状 ⇒ **拒** |
| **值住哪** | `<scope>/.data/<pack>/`（`92` §①：任一段以 `.` 开头 ⇒ **不进制品**）—— **它自己那一格** |

⇒ 一张表说清"哪一半随、哪一半不随"：

| | 随版本冻结 | 随 fork／装上 | 装谁的字节 |
|---|---|---|---|
| **形状声明**（`data-shape.json`） | ✅（在 `manifest.files[]` 里） | ✅（`installInto` 复制 `manifest.files[]`） | 制品自己的 |
| **值**（`.data/<pack>/` 里的） | ❌ | ❌ | **留在原处**，别人那份从零开始 |
| **经验**（`.exp/<pack>/`） | ❌ | ❌ | 留在原处 |

### 1.2 fork／装上各走到哪一步

```
作者那一间：workspaces/<id>/  ──snapshotWorkspace()──▶  hupo/apps/<id>/versions/<n>/
   ▲ 闸①（打包侧）：盘上每一格数据（.data/<pack>/）都必须在这一版里有声明，否则拒（动盘之前）
   ▲ 闸②（写侧）：data-shape.json 认不出／想塞值 ⇒ apps.create 拒（动盘之前）
上架：published.publish()  ── 复制 manifest.files[] ──▶  published-apps/<id>/versions/<n>/
   ▲ 闸③（上架侧）：再 parse 一次（同一处规则），把形状指纹写进审计（declared / digest / packs）
装上：published.installInto()  ── 复制 manifest.files[] ──▶  他自己的 hupo/apps/<id>/versions/<n>/
      └─ mirrorArtifactIntoWorkspace()  ── 只写 manifest.files[] ──▶  他的 workspaces/<id>/
   ⇒ **形状跟着到了；`.data/` 那一格根本没参与**（读取侧跳过 `.` 开头是唯一机制，91 §2.1）
```

**判层规则没改**（`92` §②）：硬边界**只看路径**，任一段以 `.` 开头 ⇒ 不进制品。
所以"值永不随"**不是**靠新增一道过滤，而是**结构性的**：值那一格的字节**从来不进 `manifest.files[]`**。
本批新增的是**形状那一半**（它必须进制品），以及**没声明就没收据**那条最严的闸。

---

## 二、判据读数（每条含**负向对照**；S4 含**变异**）

跑法：

```bash
cd v2/services/core && node --test test/data-shape.test.js   # D1–D5（5 条）
bash scripts/check-data-shape.sh                            # S1–S5（8 条）
```

本轮读数（2026-10-03 本机，**只碰临时目录**，不碰线上、不碰真数据目录）：

| 判据 | 它问什么 | 读数 |
|---|---|---|
| **S1 = ①** 🔴 | 把「值」塞进形状声明 ⇒ **拒**（顶层 `values`／包级 `rows`／列级 `sample` 三种塞法逐个试）＋ **盘上零残留**；**负向对照**：只写形状 ⇒ **过** | ✓ 3/3 拒（"值一个字节都不许进来"）· 拒时 `hupo/apps` **一个目录都没建** · 负向对照过，且声明真进了 `manifest.files[]` |
| **S2 = ②** 🔴 | 只改数据的值 ⇒ 形状的号**逐字不变**；改形状**不改号** ⇒ **拒**（零残留）；改形状且号跟着 ⇒ **必变**；旧那一版的形状照旧冻结 | ✓ 只改值：号 `84629b6c9011` 与指纹逐字不变、`rootHash` 也相同 · 改形状不改号 ⇒ `DataShapeError` · 改形状＋改号 ⇒ `84629b6c9011 → 784a8013664a` · 旧版指纹没动 |
| **S3 = ③** 🔴 | **真跑一次「发布 → 装上 → 镜像」＋一次真 `fork`** ⇒ 新那一份整个目录树搜源那份的值 **零命中**，而**形状在**（两边指纹逐字相同）；**负向对照**：值不许被误判成"形状" | ✓ 共享库／装上那份／分叉那份**零命中** · 两边指纹 `fcb2db0216ca…` 相同 · `forked=true` · 负向对照：值不在声明里，塞进去当场拒 · 正对照：源那份的值原本真在 |
| **S4 = ④** 🔴 | **规则只住一处**：固定名与判据本体只在 `data-shape.js`；`apps.js`／`workspace.js`／`published.js` 只 import 它。**变异**：拔掉写侧那道调用 ⇒ 值**塞得进**；把"最严"那处改坏 ⇒ 没声明也**放过去** | ✓ 源码级扫过（`'data-shape.json'` 字面 `[data-shape.js]` · `parseDataShape` 定义 1 份 · 三个枚举各 1 份 · 三条写路都 import）· 变异 A `VALUES_ACCEPTED`、变异 B `UNDECLARED_PASSED` ⇒ **两处接线都真的承重** |
| **S5 = ⑤** 🔴 | 盘上有数据格而没有声明 ⇒ **拒**，理由**看得见**（点名 `news` 与缺的那个文件）＋ **零残留**；**负向对照**：补上只写形状的声明 ⇒ **过**；根本没有数据格 ⇒ **不拦** | ✓ 拒时版本目录 **0 个** · 补上 ⇒ 过（`carried=[news]`，值照旧不进制品）· 没有数据格那一份如实记 `declared:false` 且不拦 |

**全量读数**：`npm test` **1481 通过／0 失败**（改前 1476；本批 **+5**）·
新闸 `check-data-shape.sh` **通过 8 · 失败 0** ·
**六条老闸一个字节没动、照旧绿**：`check-outbound-bridge.sh` **13/0** ·
`check-edge-kinds.sh` **8/0** · `check-read-side-assert.sh` **10/0** · `check-scope-boundary.sh` **6/0**
（它自己打印"有跳过的"——跳过的**不是**过的）· `check-app-entry-identity.sh` **9/0** ·
`check-index-author-hash.sh` **4/0** · `node scripts/check-docs.mjs` 绿。

---

## 三、改了什么（逐条）

| # | 路径 | 新／改 | 是什么 |
|---|---|---|---|
| 1 | `v2/services/core/src/data-shape.js` | **新** | 形状声明的**唯一定义处**：固定名 · 封闭 schema 的 `parseDataShape()` · 内容地址 `shapeVersionOf()`／`dataShapeDigest()` · `buildDataShape()` · `readDataShape()` · `shapeCarrierOf()`／`assertShapeDeclared()`（最严那一条）· `dataNamespacesOnDisk()` |
| 2 | `v2/services/core/src/apps.js` | 改（**小改**） | ① `create()` 的文件循环里，`data-shape.json` **当场 parse**（认不出／想塞值 ⇒ 拒，动盘之前）；② 新增 `dataShape(id, version)` 读那一版带的声明 |
| 3 | `v2/services/core/src/workspace.js` | 改（**小改**） | `snapshotWorkspace()` 在 `apps.create` **之前**跑 `assertShapeDeclared()`（盘上每一格数据都要有声明，否则拒）＋ 返回里多一格 `shape`（留痕：`declared`／`digest`／`carried`／`refused`） |
| 4 | `v2/services/core/src/published.js` | 改（**小改**） | `publish()` 在写盘之前**再核一遍**形状声明（**同一处规则**），并把 `shape:{declared,digest,packs}` 写进审计（如实的"没有"） |
| 5 | `v2/services/core/src/apps-socket.js` | 改（**小改**） | 打包被形状那道闸拒时，回一个**分开的**拒绝码 `shape-not-declared`（不再混进"包太大"）—— 拒绝理由看得见（N11） |
| 6 | `v2/services/core/test/data-shape.test.js` | **新** | D1–D5 各一条（含负向对照与源码级"只住一处"） |
| 7 | `scripts/check-data-shape.sh` | **新** | S1–S5（真代码 ＋ 真盘 ＋ 真 fork ＋ 源码级 ＋ **变异**），每条带负向对照 |
| 8 | `docs/dev/165-DATA-SHAPE-FORK.md` | **新** | 本文 |
| 9 | `docs/dev/00-PROGRESS.md` | 改 | §〇 顶部一行 |

### 与既有决定的接口（不新造口径）

- **D4.22 ⑥**"边界／血缘住登记；制品内只住**固定名文件**里的形状／源描述" ⇒ `data-shape.json` 就是那一个。
- **D4.22 ②**"读不到声明／认不出 ⇒ 拒（默认最严，**不是**"当没有"）" ⇒ `parseDataShape`／`assertShapeDeclared` 逐条照办。
- **D4.22 ⑧**"**存量按能力体豁免**，fail-closed **只对新写的**" ⇒ 本批**没有**回头追溯任何在架制品；
  没有 `.data/` 数据格的那一份**照旧打包得住**（S5 第二条负向对照），既有 1476 条测试**一条没红**。
- **91 §3.3.5**"包名走与 app id 同一条形状" ⇒ `data-shape.js` 的包名正则与 `apps.checkAppId` **逐字相同**
  （**没有**互相 import：`apps.js` 要 import 本模块，反向会成环；判据 D4 钉住这两处同一个正则）。

---

## 四、没做成 / 不确定 / 待办

1. **没部署、没重启**：线上（`w.stalkerai.cn` → 本机 `8020`）跑的仍是**旧代码**。
   本批只改仓库 ＋ 本地判据；要让线上也认这份声明，得走部署那一步（**主人签字**那一档）。
2. ⚠️ **口径我按事实做了两处判断，写在这里备核**（任务允许："若你读完发现口径该是别的形状，
   照事实做并在报告里写清为什么"）：
   - **① 声明是一份"按包分组"的制品文件，不是每包一份**：`91` §3.2 的**数据包那一格**（`.data/<pack>/pack.json`）
     是**本地**声明，**不随 fork**；"随 fork 走的形状"必须在**制品内**。⇒ 做成制品内**一份**文件、
     按 `pack` 分组，**包名与 `.data/` 下的目录名对齐**。
   - **②"改形状 ⇒ 号必变"用内容地址保证，不用"人记得改号"**：若号由人声明，那"数据变了偷偷改形状"
     就拦不住（人可以把号留着不动）。⇒ 号 = 形状的 sha256 前若干位，**号对不上形状当场拒**（S2 反向那条）。
3. **本批只做 A1**（任务范围）：`D1`（框架 = 代码 ＋ 数据契约）是**另一件**，由父 agent 另开；
   本批只为它铺好了"形状住哪、怎么随版本冻结、怎么 fail-closed"这半边。
4. **没有真机验收**：本批判据全在临时目录里跑（`npm test` ＋ 闸脚本），**没有**在线上机真上架一次。
   要真机读数，得走部署 ＋ 真装一次（同上，主人签字那一档）。
5. **`data-shape.json` 这个名字没有走手册**：`91` §6.6 只说"制品内一份固定名文件"、没点名字。
   本批**没动手册**（D4.24 已记口径；名字属于实现细节，不写进手册 —— 手册纪律①"不写数值/实现细节"）。
   若将来要冻这个名字，那是一次手册升版。
6. ⚠️ **一处如实的连带代价**：那道最严的闸住在 `snapshotWorkspace()` 里 ⇒ 它同时盖住
   **"上架前打包"**与**"装／升级前留底"**（`snapshotBeforeInstall` 走的是同一条路）。
   ⇒ 盘上有数据格而没声明的那一份，**在补上声明之前打不成包、也升不了级**（拒绝话看得见）。
   这是"默认最严"的本意；**今天的实际影响面是 0** —— 本机 `data/workspaces/` 下**没有任何 `.data/` 目录**
   （本轮实测；`92` §③ 也核过"`.data/`／`.exp/` 今天全仓未使用"）。若将来要在"只留底、不出去"
   那条路上放宽，那是一次**新的口径决定**，不在本批里偷偷改。

---

## 五、文件清单 ＋ 需要谁做什么

**新增**：`src/data-shape.js` · `test/data-shape.test.js` · `scripts/check-data-shape.sh` · 本文。
**改动**：`src/{apps,workspace,published,apps-socket}.js` · `docs/dev/00-PROGRESS.md`。
**未动**：`AGENTS.md` · `v2/apps/mobile/**`（客户端**不需要改**：这份声明不新增任何协议字段、
不上屏、不参与桌面渲染）· `docs/handbook/**` · 现存六条 `check-*.sh` · 任何别人的改动。

**需要父 agent 做的**：
1. ✅ **不需要重建开机清单**：本批**没碰** `docs/handbook/**`（它是 `strict`），也没碰 `AGENTS.md`／人格。
   `docs/dev/00-PROGRESS.md` **不在** strict 清单里（`src/integrity.js` 里没有它）。
2. 🔴 **`D1` 由父 agent 另开**（任务原话）：框架 = 代码 ＋ 数据契约那一半（每个 app 一份"声明过边界的数据"）。
   本批的 `data-shape.json` 就是那份契约的**载体**，可以直接往上接。
3. （可选）若要把线上也切到新代码：部署/重启（**主人签字**那一档，本批不做）。

---

## 附：本文核过的代码与盘上事实（清册）

| 文件 | 核到的关键行 |
|---|---|
| `v2/services/core/src/data-shape.js` | `DATA_SHAPE_FILENAME` · `DATA_SHAPE_SCHEMA` · `SHAPE_TYPES` · `NULL_POLICIES` · `canonicalJson()` · `shapeVersionOf()` · `dataShapeDigest()` · `parseDataShape()`（**唯一判据**）· `buildDataShape()` · `readDataShape()` · `shapeCarrierOf()` · `assertShapeDeclared()` · `dataNamespacesOnDisk()` |
| `v2/services/core/src/apps.js` | `import { DATA_SHAPE_FILENAME, parseDataShape, readDataShape }` · `create()` 循环里那一道 parse · `dataShape(id, version)` |
| `v2/services/core/src/workspace.js` | `snapshotWorkspace()` 里 `assertShapeDeclared({...})`（在 `apps.create` **之前**）· 返回多一格 `shape` |
| `v2/services/core/src/published.js` | `publish()` 里 `parseDataShape(files[...])` ＋ 审计 `shape:{declared,digest,packs}` |
| `v2/services/core/src/apps-socket.js` | `case 'publish'` 的 catch：`DataShapeError` ⇒ `refused:'shape-not-declared'` |
| `v2/services/core/src/outbound.js` | `DATA_DIRNAME`（数据那一格的名字 —— `workspace.js` 从这里取，不另抄）· `readPacks()`（"能不能出去"那一道，**本批没动**） |

**盘上／仓库事实（本轮实测）**：`git status --short` 开工时**干净** · `HEAD = 037d402` ·
`npm test` **1481/0**（改前 **1476**）· 新闸 **8/0** · 六条老闸 **13/0** · **8/0** · **10/0** · **6/0** · **9/0** · **4/0** ·
`check-docs.mjs` 绿 · `docs/dev/` 现有最大编号 = **164**（本文 = **165**）·
**手册没动**（不改 `CHANGELOG`）· **没部署／没重启**。
