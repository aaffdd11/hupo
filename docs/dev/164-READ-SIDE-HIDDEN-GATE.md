# 164 · **读侧那道闸**（`D4.24` · 主人 2026-10-03 点头「加」）

> **一句话**：把写侧那道"制品里不许有 `.` 开头的路径"（`refuseHiddenRelPath`）**加到读侧** ——
> 唯一那条取字节的路 `Apps.read()` 在**读第一个字节之前**过同一个函数；
> 拒的时候**带 `code = 'hidden-path'`**，制品口回一条**能查的明确理由**
> （谁拒的 · 拒的哪条路径 · 为什么 · 该怎么办）＋ 一条**审计**；
> **不是白屏、不是假 404**。
>
> **来由**：`docs/dev/158-RESIDENT-OUTBOUND-ASSERT.md` **§五·1** 明写"阶段 6 只在**写侧**加了断言，
> **读侧没加**"，理由是"老租户包里已有的隐藏路径会从那天起读不出来（那是**悄悄弄坏**）"。
> ⇒ 主人 2026-10-03 已点头：**加**（回答的正是"读侧要不要也加那道断言"）。
> 那个"弄坏"的代价**他接受了**；本批的硬要求是 **"弄坏"必须变成"看得见的拒绝"**。
>
> 依据：`docs/handbook/05-DECISIONS.md` **D4.24** · `08-SPEC.md` §14.7 ·
> `docs/dev/{92,157,158,161,162,163}` · 以及**本轮亲自核过的代码与读数**（见 §二／§四）。
>
> 🔴 纪律：**不写数值**（阈值/上限只住代码）· **读不出就报 `不可算` 并记失败** ·
> **每条判据都有负向对照** · **不伪造一致**。

---

## 〇、动手前的事实

- 本轮开工时 `git status --short` **干净**；`HEAD = b5f10be`（#73 收口）。
- 读侧那条路**当时确实没有**这道闸：`Apps.read()`（`src/apps.js`）的顺序是
  `checkAppId` → `checkRelPath`（允许 `.data/` 这类）→ 读清单 → 找记录 → 读盘 → 核 sha256。
  ⇒ 一个**老包里存在**的 `.data/a.json`，只要它进了清单，**制品口取得到**。
  写侧 `create()` 早在 S4 就有 `refuseHiddenRelPath`，所以"老包"里的隐藏路径只能来自那道闸之前
  （或绕过 `create()` 直接落盘）。
- `08-SPEC.md` §14.7 末尾**逐字**写着「今天还没做的：**读侧**（`apps.read` / 制品口）**没有**这条断言」
  ⇒ 本批要动**手册**（升版见 §四）。

---

## 一、闸落在哪、拒的时候说什么

| 项 | 是什么 |
|---|---|
| **落在哪（规则）** | `src/apps.js` 的 **`refuseHiddenRelPath()`** —— **一个字节没改规则**，只是给它的 `AppsError` 多带一个 `code`（`HIDDEN_PATH_CODE = 'hidden-path'`） |
| **落在哪（读侧）** | `Apps.read(id, version, rel)`：**先认这一版在不在**（"没有这一版"是真话），再 `refuseHiddenRelPath(rel)`，**然后才**读第一个字节。**读侧只有这一处**（§二 R2） |
| **为什么是这个形状** | 写侧拦的是"**造**一个带隐藏路径的包"；读侧拦的是"**取**一条隐藏路径的字节"。两处拦的**不是同一件事**，但**用的是同一条规则** —— 所以复用同一个函数，不另抄 |
| **拒的时候** | 抛 `AppsError`（`code='hidden-path'`，`message` 就是那条规则的原文）＋ 一条审计 `{what:'hidden-path-refused', id, version, path}` |
| **制品口回什么** | `src/app-serve.js` 的 `denyRefusedPath()`：**HTTP 403**（不是 404）＋ `x-hupo-refusal: hidden-path` ＋ 正文（**逐字见下**） |
| **租户那条路** | 字节在他**盒子里** ⇒ 盒子内部口（`server.js` `/internal/artifact`）认这条 code，回**专码 403 ＋ 理由**；宿主的盒代理（`apps-box.js`）把它还原成 `code='hidden-path'` ⇒ 制品口同样回那条看得见的 403（**不许过一趟隧道就变回假 404**） |
| **审计谁能查** | 每人一份：`<world>/hupo/apps/audit.jsonl`（与 `create`/`grant`/`hash-mismatch` 同一个追加账；身份那格是 `credHashOf`，不是明文）。主人那份在 `data/hupo/apps/audit.jsonl`（`deploy` 可读） |

**拒的时候，制品口回的正文（原话，`denyRefusedPath()` 里那一份）**：

```
这个文件被拦下了。
谁拦的：琥珀的制品口
拦的是什么：<id> 里的「<rel>」
为什么：<apps.js 那条规则的原文>
这不是「没有这个文件」，也不是签名不对 —— 是这一条路径按规矩不许从制品口取。
怎么办：把它从制品里去掉（数据放它自己那一格存储，别放进制品），重新发一版。
```

⚠️ 其中"为什么"那一句由 `refuseHiddenRelPath` 现算，**不另写一份文案**（两处规则不可能漂）。

---

## 二、判据读数（每条含**负向对照**）

跑法：

```bash
cd v2/services/core && node --test test/app-read-hidden.test.js   # ① ② ③ ④（6 条）
bash scripts/check-read-side-assert.sh                            # R1–R4（10 条）
```

本轮读数（2026-10-03 本机，**只碰临时目录 + 真机只读盘查**，不碰线上、不改任何人的东西）：

| 判据 | 它问什么 | 读数 |
|---|---|---|
| **R1** 🔴 | 隐藏路径 ⇒ 真 HTTP **403** ＋ 点名理由（谁/什么/为什么/怎么办）＋ 可查审计；**负向对照**：同一个包的干净入口 ＋ 另一个干净包 ⇒ **都 200** | ✓ **403** ＋ `x-hupo-refusal: hidden-path` ＋ 四句理由齐；`audit.jsonl` 读到 `hidden-path-refused`（`id=dice` · `path=.data/a.json`）；负向对照 **200 / 200** |
| **R2a** 🔴 | 读侧**只有一处**：唯一"版本目录 + rel"的拼法在 `Apps.read()`，闸在它里面、跑在 `readFileSync` 之前 | ✓ 源码级：`read()` 里 `refuseHiddenRelPath` 一处；`versionDir(...), rel` 全仓 **1** 处 |
| **R2b** 🔴 | **变异**：临时副本里把 `read()` 那处调用拔掉 ⇒ 隐藏路径**照旧读得出** | ✓ 正对照：真代码里被拒（`hidden-path`）；变异后 `NOT_REFUSED` ⇒ **那道调用真的承重** |
| **R3** 🔴 | **与写侧同规则**：写侧 `create()` 拒的话 === 读侧 `read()` 拒的话；**负向对照**：路径改合法（`.data/`→`data/`）⇒ 放行 | ✓ 逐字相同（同一个 `refuseHiddenRelPath`）；负向对照读回来逐字节一致 |
| **R4** 🔴 | **零残留**：真机只读盘查跑前跑后**逐文件 sha256 一致**；**负向对照**：指纹函数改一个字节 ⇒ 必须变 | ✓ **2 个根全部复原**；负向对照 sha256 会变（不是恒真） |

`test/app-read-hidden.test.js` 那 6 条把上面同样的事各钉一条（另加：**读（含被拒那一次）不改制品字节**、
租户那条路的拒绝**过隧道也看得见**）。

### 真机只读盘查的数字（主人要看影响面）

```
可读制品库 2 个 · 在架制品 1 个 · 回收站 5 个 · **受影响 0 个**
```

- **可读的那两个根**：主人的 `data/hupo/apps`（在架 **0 个版本** —— 活的那份只有 `main`）＋
  共享库 `data/published-apps`（在架 **1 个**：`coin@1`，文件只有 `index.html`，**干净**）。
- **回收站 5 个**（`data/hupo/apps/.removed/*`，**不算在架**）：逐份看过，路径全是 `index.html`，**零隐藏路径**。
- **受影响的一次性清单**：**空**（可读范围内**没有任何**在架制品的清单里有隐藏段）。
- ⚠️ **租户盒子 3 台**（`/home/hupo-{a,b,t3}/tenant`，`0700`，本机没有 docker、`sudo -n` 要口令）
  ⇒ 那几台的字节**读不到**，它们那部分盘查**`不可算`**（本闸如实打印；见 §四·3）。
  ⚠️ **只列不改**：本批**没有删/改任何人的东西**（零残留那条判据就在量这件事）。

**全量读数**：`npm test` **1476 通过／0 失败**（改前 **1470**；本批 **+6**）·
新闸 `check-read-side-assert.sh` **通过 10 · 失败 0** ·
四条老闸**未改**、照旧绿：`check-outbound-bridge.sh` **13/0** · `check-app-entry-identity.sh` **9/0** ·
`check-index-author-hash.sh` **4/0** · `check-edge-kinds.sh` **8/0** ·
`check-scope-boundary.sh`（portable）**6/0** · `node scripts/check-docs.mjs` 绿。

---

## 三、改了什么（逐条）＋ 一处**必要的连带小改**

| # | 路径 | 新／改 | 是什么 |
|---|---|---|---|
| 1 | `v2/services/core/src/apps.js` | 改 | 新增 `HIDDEN_PATH_CODE`／`isHiddenPathRefusal()`；`AppsError` 多一个 `code`；`refuseHiddenRelPath` 抛的错带那个 code；**`read()` 在读第一个字节之前跑同一个函数**，被拒时写审计 |
| 2 | `v2/services/core/src/app-serve.js` | 改 | 新增 `denyRefusedPath()`（**403 ＋ 看得见的理由**）；制品口那条读字节的路（同步 catch ＋ 异步 rejection）先认 `isHiddenPathRefusal` ⇒ **不再落进假 404** |
| 3 | `v2/services/core/src/server.js` | 改 | 盒子内部口 `/internal/artifact` 认那条 code ⇒ 回 `BOX_PATH_REFUSED_STATUS` ＋ 理由（**不许过隧道变回 404**） |
| 4 | `v2/services/core/src/apps-box.js` | 改 | 新增 `BOX_PATH_REFUSED_STATUS`（**两侧共用一处数**）；盒代理 `read()` 认得它 ⇒ 抛 `code='hidden-path'` 的 `AppsError` |
| 5 | `v2/services/core/src/published.js` | 改（**连带小改**，见下） | `publish()` 把 `assertOutboundBytes` 的**声明那一半**提到读字节之前 |
| 6 | `v2/services/core/test/app-read-hidden.test.js` | **新** | ①②③④ 各钉一条（含审计、真 HTTP、**租户那条路**、读不改盘） |
| 7 | `scripts/check-read-side-assert.sh` | **新** | R1–R4（真 HTTP ＋ 源码级 ＋ **变异** ＋ 真机只读盘查/零残留），每条带负向对照 |
| 8 | `docs/dev/164-READ-SIDE-HIDDEN-GATE.md` | **新** | 本文 |
| 9 | `docs/dev/00-PROGRESS.md` | 改 | §〇 顶部一行 |
| 10 | `docs/handbook/08-SPEC.md` | 改 | §14.7 那句"读侧没有这条断言"**改口径**（＋ 表里补一行"读侧的同一道闸"） |
| 11 | `docs/handbook/CHANGELOG.md` | 改 | 顶上 **v2.34** |

### 为什么 `published.js` 也必须跟着动（**不是偷偷改了写侧**）

读侧那道闸加在 `Apps.read()` 里 —— 而**出界那条断言读字节时走的正是这条路**
（`publish()` 里 `files[f.path] = apps.read(...)`）。⇒ 一份声明了 `.data/…` 的清单会
**在读第一个字节时就被读侧拒掉**，`check-outbound-bridge.sh` 判据 **F1**（它钉的是
"**发布路径自带**的那条断言必须是第一现场"）就再也看不见 `OutboundError` 了。
⇒ 把 `assertOutboundBytes` 的**声明 ↔ 声明**那一半提到读字节之前：**同一个函数、不是第二处规则**，
下面那次带字节的照旧再核一遍"声明 ↔ 字节"。位置刻意在 `assertOutboundAllowed`（两格申报那条闸）**之后**
—— 无锚的 `share:true` 仍然第一个拒，既有报错顺序与话**一个字没变**（`check-outbound-bridge.sh` 13/0 为证）。

---

## 四、没做成 / 不确定 / 待办

1. **没部署、没重启**：线上（`w.stalkerai.cn` → 本机 `8020`）跑的仍是**旧代码**；
   本批只改仓库 ＋ 本地判据。要让**线上**也"拒得响亮"，得走部署那一步（那是主人的签字那一档）。
   在部署之前，线上那台对老包里的隐藏路径**仍然是读得出来的**（旧代码）。
2. **老包的代价已生效（本机/部署后）**：读侧加闸之后，真机上**凡是清单里有隐藏路径的老包**，
   从那天起**取不出那几条**（这是主人点头接受的"弄坏"）；换来的是**拒绝看得见、查得到**。
   可读范围内本轮**一个都没有**（§二）。
3. ⚠️ **租户盒子那份盘查 `不可算`**（如实说）：`/home/hupo-{a,b,t3}/tenant` 是 `0700`，
   本机没有 docker（`deploy` 不在 docker 组）、`sudo -n` 要口令。⇒ 本闸报的是
   **本机可读范围**的数字；那 3 台盒子里的制品**没有量到**。要量得由父 agent / 主人在
   有权限的那一侧跑同一条闸（闸脚本认 `HUPO_DATA`）。
4. **没有改那五条老闸**：`check-scope-boundary`／`check-outbound-bridge`／`check-edge-kinds`／
   `check-app-entry-identity`／`check-index-author-hash` **一个字节没动**（读数照旧，见 §二）。
5. **`/w/`（活地址）那条路不动**：它取的是**工作区**里的活文件，白名单住
   `app-live.js` 的 `checkLiveRel`（本来就拒 `.` 开头），与制品库里那条规则**不是同一条**
   （那条住在 `apps.js`）。⇒ 本批**没碰**它，也不该把它读成"第二处规则"。
6. **手册动了 ⇒ 需要父 agent 重建开机清单**：`docs/handbook/**` 是开机完整性的 **`strict`** 条目
   （`AGENTS.md` §八），改了就要重建 `/etc/hupo/integrity.json`，否则**下次重启拒绝启动**。
   ⚠️ **本批没有自己重建**（要 root 口令）⇒ 见 §五。

---

## 五、文件清单 ＋ 需要谁做什么

**新增**：`test/app-read-hidden.test.js` · `scripts/check-read-side-assert.sh` · 本文。
**改动**：`src/{apps,app-serve,server,apps-box,published}.js` · `docs/dev/00-PROGRESS.md` ·
`docs/handbook/{08-SPEC.md,CHANGELOG.md}`。
**未动**：`AGENTS.md` · `v2/apps/mobile/**` · 现存五条 `check-*.sh`。

**需要父 agent 做的**：
1. 🔴 **重建开机清单**（本轮改了 `docs/handbook/**` = `strict`）—— 命令照
   `scripts/verify-integrity.mjs` / `AGENTS.md` §八 打出来的那一条粘
   （**别手打**，里面是绝对路径；本机没有系统 `node`）。
2. 部署/重启线上（如果主人要线上也生效）—— 那是**主人签字**那一档，不是本批能自己做的。

---

## 附：本文核过的代码与盘上事实（清册）

| 文件 | 核到的关键行 |
|---|---|
| `v2/services/core/src/apps.js` | `HIDDEN_PATH_CODE` · `isHiddenPathRefusal()` · `refuseHiddenRelPath()`（**唯一规则**）· `read()`（闸在 `readFileSync` 之前） |
| `v2/services/core/src/app-serve.js` | `denyRefusedPath()` · 读字节那条路的两个 catch（同步 ＋ Promise rejection） |
| `v2/services/core/src/apps-box.js` | `BOX_PATH_REFUSED_STATUS` · 盒代理 `read()` 认它 ⇒ `AppsError(code='hidden-path')` |
| `v2/services/core/src/server.js` | `/internal/artifact` 认 `isHiddenPathRefusal` ⇒ 专码 ＋ 理由（不是 404） |
| `v2/services/core/src/published.js` | `publish()`：`assertOutboundAllowed` → **声明那一半** → 读字节 → 带字节那一半 |
| `scripts/check-outbound-bridge.sh` | 判据 **F1** 钉的就是"发布路径自带那条断言是第一现场"（本批让它照旧绿） |

**盘上／仓库事实（本轮实测）**：`git status --short` 开工时**干净** ·
`npm test` **1476/0**（改前 1470）· 新闸 **10/0** · 老闸 **13/0** · **9/0** · **4/0** · **8/0** · **6/0** ·
`check-docs.mjs` **181 份指针**（改前 180，本文 +1）·
`docs/dev/` 现有最大编号 = **163**（本文 = 164）· 手册顶上原来是 **v2.33**（本批升 **v2.34**）·
真机可读制品库 **2** 个 · 在架 **1** · 回收站 **5** · **受影响 0** · 租户盒子 **3** 台**不可算**。
