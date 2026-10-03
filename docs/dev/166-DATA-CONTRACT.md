# 166 · **数据契约：声明过边界 ＋ 按命名空间隔离**（`D4.24` · **D1** · 2026-10-03 主人定）

> **一句话**：**契约＝一份能核的声明**（A1 的 `data-shape.json`：要取的那一格必须在里面
> 被声明过，否则 **fail-closed**、理由看得见）；**取用＝一次判定**——「谁（app ＋ 包）」
> 要「谁（app ＋ 包）」的数据，**允许当且仅当两者逐字相同**，而这次判定
> **只有一处定义**（`src/data-namespace.js`），取／写／列**三条路**都只走它。
> ⇒ 同 app 跨包取不到、跨 app 取不到、越界尝试**盘上零残留**、自己取自己照旧通、
> 没有数据格的 app 照旧打包。
>
> **依据**：`docs/handbook/05-DECISIONS.md` **D4.24**（**D1 = 框架＝代码 ＋ 数据契约**）·
> 签字页 [`docs/dev/161-OWNER-DECISIONS-11.md`](161-OWNER-DECISIONS-11.md) D1 ·
> `docs/dev/85-FRAMEWORK.md` §四·1（原话：*每个 app 在它工作区里有一份**声明过边界的数据**，
> 平台按**命名空间**隔离*）· `docs/dev/90-APP-CONTRACT.md` §3.2／§3.3 Q3.1／Q3.2／Q3.6 ·
> `docs/dev/91-TRIPLE-CONTRACT.md` §2.1（判层只看路径）／§2.3.3（声明缺失 ⇒ 不算那一层）／§3.2／§8.1 ·
> `docs/dev/92-TRIPLE-PLAN.md` §② · 上一批 A1 [`docs/dev/165-DATA-SHAPE-FORK.md`](165-DATA-SHAPE-FORK.md)。
>
> 🔴 纪律：**阈值/上限只住代码**（本文不写）· **读不出就报 `不可算` 并记失败** ·
> **每条判据都有负向对照** · **不伪造一致**。

---

## 〇、动手前的事实

- 本轮开工时 `git status --short` **干净**；`HEAD = b151e1b`（`D4.24`·A1 落地）。
- **A1 已经铺好了哪一半**：载体有了 —— 制品内固定名文件 `data-shape.json`（**只描述形状、值一字节不装**，
  随 `rootHash` 冻结、随 fork／装上复制）；值住 `<scope>/.data/<pack>/`；
  而且**出去那一侧**（打包／上架）已经钉死：盘上有数据格却没声明 ⇒ 拒。
- 🔴 **A1 之后仍然缺的那一半**：**"数据契约"只回答了「能不能出去」，没有回答「谁能取到哪一格」**。
  翻遍 `src/`（本轮实测 `grep`）：
  - `outbound.js` 判的是「**能不能出去**」（上架／交付／制品口）；
  - `data-shape.js` 判的是「**那份声明是不是一份能核的声明**」；
  - `workspace.js` 只把 `.data/` 当作"盘上有哪几格"（`dataNamespacesOnDisk`），**不解析某一格归谁**；
  - `app-live.js` 的活地址白名单**拒一切 `.` 开头的段**（⇒ `.data/` 根本进不了页面）;
  - `apps.js` 的读侧 `refuseHiddenRelPath` 同理（⇒ `.data/` 进不了制品口）。
  ⇒ **没有任何一处回答"这一格归谁、谁能取"** —— 那正是 D1 缺的那一层。
  这一批就补它，并且**只补一次**。

---

## 一、数据契约落在哪、谁读它、隔离靠什么保证

### 1.1 一句话 ＋ 证据

| 问 | 答 | 证据（可复核） |
|---|---|---|
| **落在哪** | **声明**＝制品内固定名文件 `data-shape.json`（A1 建的）；**取用规则**＝`src/data-namespace.js`（本批新建） | `src/data-shape.js:DATA_SHAPE_FILENAME` · `src/data-namespace.js` 整篇 |
| **谁读它** | **三条路**（`dataNamespaceRead` / `dataNamespaceWrite` / `dataNamespaceList`）都只调**一个**解析口 `resolveDataNamespace()`；里面那**一次** `adjudicateDataAccess()` 说了算 | `src/data-namespace.js` · S5a 源码扫描 |
| **契约＝声明靠什么** | 调 `data-shape.shapeCarrierOf()`（**同一处规则**，不另写声明判据）：要取的那一格没在 `data-shape.json` 里被声明过 ⇒ **抛**（fail-closed），理由**点名哪一格、缺哪个文件** | 判据 S1（含负向对照） |
| **命名空间隔离靠什么** | `callerPack !== targetPack` ⇒ 拒（"跨命名空间取不到"） | 判据 S2（取／写／列三条路全拒 ＋ 反向也拒 ＋ 自己取自己过） |
| **跨 app 隔离靠什么** | `callerApp !== targetApp` ⇒ 拒（"跨 app 取不到"）；落点**永远**是 `workspaces.dirFor(id) ＋ outbound.DATA_DIRNAME ＋ pack` ⇒ 结构上出不了那一间房 | 判据 S3（`bbb→aaa` 与 `aaa→bbb` 两个方向都拒） |
| **越界零残留靠什么** | 三条路都是**先过闸、后动盘**（读第一个字节 / 建第一个目录之前）；`..` 那类路径复用 `apps.checkRelPath` | 判据 S4（5 种越界尝试全拒，整棵树逐文件 sha256 复原） |
| **规则只住一处靠什么** | 边界判定本体只有一份；格名只从 `outbound.DATA_DIRNAME` 取、包名形状只从 `data-shape.checkPackName` 取、路径形状只从 `apps.checkRelPath` 取 | 判据 S5a（源码级）＋ S5b（**变异**） |

### 1.2 一次取用的形状（**这就是那一处判定**）

```
一次取用 = 「谁」（caller：callerApp ＋ callerPack） 要 「谁」（target：targetApp ＋ targetPack）的数据

允许  ⟺  callerApp === targetApp  且  callerPack === targetPack
        （caller 不给时默认 = target，即"自己取自己"）
```

⇒ 三个后果，逐条都有判据：

| # | 后果 | 判据 |
|---|---|---|
| **②** | **同 app 跨 pack 取不到** —— 一个包只许取自己那一格 | S2 |
| **③** | **跨 app 取不到** —— `<scope>/.data/` 只归那一个 app | S3 |
| **⑥** | **不过度拒** —— 自己取自己照旧通；没有数据格的 app 照旧打包（这一侧不碰它） | S6 |

### 1.3 三条路与它们的落点

| 路 | 函数 | 落点 | 拒在哪一步之前 |
|---|---|---|---|
| **取** | `dataNamespaceRead` | `<scope>/.data/<pack>/<rel>` 的字节 | **读第一个字节之前** |
| **写** | `dataNamespaceWrite` | 同上（原子写：临时文件 ＋ `rename`） | **建第一个目录之前** |
| **列** | `dataNamespaceList` | 同上那一格的相对路径（排序） | **`readdir` 之前** |

⚠️ **三条路的落点永远在同一间房里**：`workspaces.dirFor(app)`（app 名字走 `apps.checkAppId`）
＋ `outbound.DATA_DIRNAME` ＋ `data-shape.checkPackName(pack)` —— 三个名字各只有一处定义。

---

## 二、判据读数（每条含**负向对照**；S5 含**变异**）

跑法：

```bash
cd v2/services/core && node --test test/data-namespace.test.js   # D1–D6（6 条）
bash scripts/check-data-contract.sh                              # S1–S6（9 条读数）
```

本轮读数（2026-10-03 本机，**只碰临时目录**，不碰线上、不碰真数据目录）：

| 判据 | 它问什么 | 读数 |
|---|---|---|
| **S1 = ①** 🔴 | 要取的那一格没被 `data-shape.json` 声明过 ⇒ **三条路全拒**（fail-closed），理由**看得见**（点名 `news` 与缺的 `data-shape.json`）；**负向对照**：补上一份**只写形状**的声明 ⇒ **过**；声明里没有的那一包照旧拒 | ✓ 3/3 拒 · 理由两点名 · 补上 ⇒ 真读到值 · 声明外那一包照旧拒 |
| **S2 = ②** 🔴 | 同 app 里一个包取另一个包 ⇒ **取／写／列三条路全拒**（理由说"跨命名空间"）；反向也拒；**负向对照**：自己取自己 ⇒ **过**，读到的**是自己那一格**的值 | ✓ 3/3 拒 · 反向拒 · 自己取自己读到自己那一格 |
| **S3 = ③** 🔴 | `bbb→aaa` 与 `aaa→bbb` **两个方向都拒**（理由说"跨 app"）；**负向对照**：同一个 app 自己的数据照旧读得到 | ✓ 两个方向都拒 · aaa／bbb 各读到自己的值 |
| **S4 = ④** 🔴 | 跨 app／跨包／`..` 五种越界尝试逐个拒，跑完**整棵树逐文件 sha256 复原**、零新文件；**负向对照**：一次**合法写**必须真的改动盘 | ✓ 5/5 拒 · 复原逐字相同 · 对照真的改了盘 |
| **S5 = ⑤** 🔴 | **规则只住一处**：源码级（判定本体 1 份 · 解析口 1 份 · 两条比较各 1 处 · 三条路都走它 · 格名／包名形状只复用）；**变异**：拔掉跨 app／跨包那两条判定 ⇒ 越界进得去；拔掉"契约＝声明"那一条 ⇒ 没声明也取得到 | ✓ 真代码 `SELF_OK｜CROSSPACK_REFUSED｜CROSSAPP_REFUSED｜UNDECLARED_REFUSED`；变异后 `CROSSPACK_ALLOWED｜CROSSAPP_ALLOWED｜UNDECLARED_ALLOWED` ⇒ **那处 guard 真的承重** |
| **S6 = ⑥** 🔴 | **不过度拒**：没有数据格的 app 照旧打包（如实记 `declared:false`）；干净只读的场景照旧通（列两次结果一致）；**负向对照**：不许"一律拒" | ✓ 不拦 · 只读无副作用 · 自己取自己那份判定 ⇒ 过 |

**全量读数**：`npm test` **1487 通过／0 失败**（改前 1481；本批 **+6**）·
新闸 `check-data-contract.sh` **通过 9 · 失败 0** ·
**七条老闸一个字节没动、照旧绿**：`check-data-shape.sh` **8/0** ·
`check-outbound-bridge.sh` **13/0** · `check-read-side-assert.sh` **10/0** · `node scripts/check-docs.mjs` 绿。

---

## 三、改了什么（逐条）

| # | 路径 | 新／改 | 是什么 |
|---|---|---|---|
| 1 | `v2/services/core/src/data-namespace.js` | **新** | 数据契约**取用侧的唯一定义处**：`adjudicateDataAccess()`（**唯一那一次**边界判定）· `resolveDataNamespace()`（唯一解析口：名字形状 → 边界 → 契约＝声明 → 落点）· `readDeclarationBytes()` · **三条路** `dataNamespaceRead`／`dataNamespaceWrite`／`dataNamespaceList` · `DataNamespaceError`／`isDataNamespaceRefusal()` · `NAMESPACE_ROUTES` |
| 2 | `v2/services/core/src/data-shape.js` | 改（**小改**） | 多导出 `checkPackName()` —— 包名形状**唯一入口**（复用同一个 `PACK_NAME_RE` 与 `MAX_PACK_NAME_CHARS`），给命名空间那道闸调；`parseDataShape`／`shapeCarrierOf` 一个字没动 |
| 3 | `v2/services/core/test/data-namespace.test.js` | **新** | D1–D6 各一条（每条带负向对照；D4 逐文件 sha256 复原；D5 源码级） |
| 4 | `scripts/check-data-contract.sh` | **新** | S1–S6（真代码 ＋ 真盘 ＋ 源码级 ＋ **变异**），**9 条读数**全带负向对照 |
| 5 | `docs/dev/166-DATA-CONTRACT.md` | **新** | 本文 |
| 6 | `docs/dev/00-PROGRESS.md` | 改 | §〇 顶部一行 |

### 与既有决定的接口（不新造口径）

- **D4.24 · D1** 原文"框架＝代码 ＋ 数据契约；每个 app 在它工作区里有一份**声明过边界的数据**，
  平台按**命名空间**隔离" ⇒ 声明那一半是 A1 的 `data-shape.json`，命名空间那一半是本文的
  `data-namespace.js`。两半**都不新造**：声明判据调 `data-shape`，路径形状调 `apps`，格名调 `outbound`。
- **`91` §2.3.3**"声明缺失 ⇒ 不算那一层（fail-closed）" ⇒ S1 逐条照办（没声明 ⇒ 三条路全拒）。
- **`92` §②**"目录名不承重、声明承重"`⇒ 这一份判的是"
  **包名（声明里的那个名字）**，不是目录名 —— 目录落点是从包名拼出来的。
- **`91` §2.1**"判层只看路径，不读内容" ⇒ 边界判定只看**身份与名字**，一个字节的数据内容都没读。

### ⚠️ 一处口径我按事实做了判断（任务允许："若形状该是别的，照事实做并写清为什么"）

**① 今天没有一条"按包名取数据"的**产品路**，所以这一批交的是"那一处判定 ＋ 三条路"，
不是"接在某条已有 HTTP 口上"。** 逐条核过（§〇 那一串 `grep`）：

- 页面（跑第三方代码的沙箱）**够得着的存储只有 `/db`**（`app-db.js`：**一个 app 一个 SQLite**，
  按 app 隔离，不是按 pack）—— 页面**没有**一个"我要第几包"的身份；
- 活地址（`app-live.js`）与制品口（`apps.js`）**都拒一切 `.` 开头的段** ⇒ `.data/` 进不去；
- 替 app 跑的那一轮 agent（`app-agent.js`）cwd 就是那间工作区 ⇒ 它用**直接文件系统**读写，
  不经过我们的任何函数。

⇒ **我没有去改协议**（`/db`、活地址、签名都不动 —— 协议字段一旦上线就冻结）。
本批的形状是：**把"哪一格归谁"落成一处可被调用的判定 ＋ 三条路 ＋ 判据**，
任何将来要真服务 pack 级数据的路，**必须**走这一处（判据 S5a／S5b 把这一点钉住）。
**代价如实认下**：在那条路建起来之前，这一份是**框架的入口**，不是"线上已经按 pack 隔离"。

---

## 四、没做成 / 不确定 / 待办

1. **没有产品调用方**：见上面 §三 那一处判断。`data-namespace.js` 今天**没有**被 `serve.js`／
   `server.js`／`app-serve.js` 接线（本批**故意不接线**：接一条真的 pack 级数据口需要
   "这一格归哪个调用方"的身份，而那个身份今天不存在 —— 页面只有一个 app 身份、没有 pack 身份）。
   ⇒ 要它真正承重，得先定"**pack 身份从哪来**"（一次新的口径决定，不在本批里偷偷做）。
2. ⚠️ **agent 的直接文件系统那条路没盖住**：替 app 跑的那一轮 agent 的 cwd 就是那间工作区，
   它 `read`／`write .data/<任何包>/…` **不经过**这一处判定。要盖住得靠 profile（只读档）
   或把数据格挪出 cwd —— 那是另一件事（`app-agent.js` 顶上那段批注已经如实写了同一件事）。
   **不夸口**：本批判据覆盖的是**平台路**，不是 agent 的直接 fs。
3. **没部署、没重启**：线上（`w.stalkerai.cn` → 本机 `8020`）跑的仍是**旧代码**。
   本批只改仓库 ＋ 本地判据。
4. **没动手册**：`D4.24` 已记口径（"框架＝代码 ＋ 数据契约／按命名空间隔离"），
   命名空间判定的**实现形状**属于实现细节 ⇒ 按手册纪律①（不写实现细节/数值）**不写进手册**。
   ⇒ **不需要重建开机清单**（`docs/handbook/**`／`AGENTS.md`／人格／`~/.dsh/profiles/**` 一个字节没动；
   `docs/dev/00-PROGRESS.md` 不在 `strict` 清单里）。
5. **没真机验收**：本批判据全在临时目录里跑（`npm test` ＋ 闸脚本），**没有**在线上机真取一次。
   要真机读数，得先有第 1 条那条产品路。
6. **`pack` 名字与"包"的语义**：本文里的"包"＝`data-shape.json` 里那个 `pack`（一个数据命名空间），
   不是 npm 那种包。判据 S5a 钉住"包名形状只从 `data-shape.checkPackName` 取"。
