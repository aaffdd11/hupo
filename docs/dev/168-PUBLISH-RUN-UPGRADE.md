# 168 · **发布真跑一次（分级）＋ 升级分级派 ＋ 升级粒度**（`D4.24` · **A2／C1／C3** · 2026-10-03 主人定）

> **一句话**：发布那条路上多一道**最小真跑**（A2）——入口那一份的脚本在一个最小壳里
> **真编译、真执行**，跑的是一个真 JS 引擎、带**硬时间预算**：**入口必崩 ⇒ 拒**（理由点名哪个文件哪一行），
> **不做全量回归**；升级多一处**唯一判定**（C1）——**契约版本变了才请 AI 重写**，
> 「契约版未变 ⇒ 重写计数 = 0」是一条**能反着验**的读数（含源码级"只住一处"＋**变异**）；
> 升级粒度（C3）**默认按用户整体跟**，某一个可以**显式留旧版**，而且"跟／不跟、留在哪一版"**看得见**。
>
> **依据**：`docs/handbook/05-DECISIONS.md` **D4.24**（A2／C1／C3）·
> 签字页 [`docs/dev/161-OWNER-DECISIONS-11.md`](161-OWNER-DECISIONS-11.md) A2／C1／C3 ·
> `docs/dev/85-FRAMEWORK.md` §四·2／§五 F1–F4 · `docs/dev/90-APP-CONTRACT.md` §7.1 Q7.3／§7.2／§10.1 ②④ ·
> `docs/dev/92-TRIPLE-PLAN.md` §② · 上一批 [`docs/dev/167-APP-STORAGE-RULE.md`](167-APP-STORAGE-RULE.md)。
>
> 🔴 纪律：**阈值/上限只住代码**（本文不写）· **读不出就报 `不可算` 并记失败** ·
> **每条判据都有负向对照** · **不伪造一致**。

---

## 〇、动手前的事实

- 本轮开工时 `git status --short` **干净**；`HEAD = 25bad38`（`D4.26` 拍板 ＋ `D4.25` 收口）。
- 开工时**没有**"发布前真跑"这个东西：`published.publish()` 的闸是**声明 ↔ 字节**
  （`assertOutboundBytes` · 92 §③ 阶段 6）与**出界申报**（`assertOutboundAllowed` · 阶段 2），
  它们判的是"**这一版能不能出去**"，**一个字节的脚本都没执行过**。
- 开工时**没有**"升级"这个东西：`apps-socket.js` 的 `install` 只做**装**（快照／刷新／分叉），
  没有任何一处回答"**这一次该不该请 AI 重写**"，也没有"重写计数"可读。
- 开工时**没有**"升级粒度"这个东西：`apps.shapeVersion()`／`noteLineage()` 都在，
  但**没有一处**会说"这个 app 跟不跟新版"。

---

## 一、三件各落在哪、默认值是什么

| 代号 | 落在哪（文件／函数） | 一句话 | 默认值 / 反着验的读数 |
|---|---|---|---|
| **A2** | **新** `src/app-run.js`：`runEntryOnce()`（**唯一判定**）· `extractScripts()` · `describeRunFailure()` · `EntryRunError` · `RUN_FAILURES` | 入口那一份的脚本**真编译、真执行**（`node:vm`，带 `timeout`）；语法错／顶层抛／超时／入口或本地脚本缺失 ⇒ **拒** | 每段脚本一个**硬预算**（`RUN_TIMEOUT_MS`，住代码）· 外链脚本／`type=module`／JSON 数据块**不跑也不拦**（分级） |
| **A2** | 改（**小改**）`src/published.js`：`publish()` 在**写第一个字节之前**调 `runEntryOnce`，把 `ran:{ok,entry,scripts,executed,skipped,ms}` 写进 `index.json` 与审计 | 发出去的每一版都有**一条"跑过"的凭据** | 失败 ⇒ `EntryRunError`，**共享库零字节** |
| **A2** | 改（**小改**）`src/apps-socket.js`：`case 'publish'` 把 `EntryRunError` 翻成**分开的拒绝码** `entry-would-crash` | 驳回理由**看得见**（跟"包太大／形状没声明"分开） | — |
| **C1** | **新** `src/app-upgrade.js`：`decideUpgrade()`（🔴 **唯一判定**）· `planUpgrade()` · `UpgradeBook` | **契约版本变了才请 AI 重写**；未变 ⇒ `byte-swap`（整版换字节 ＋ 保数据） | `UPGRADE_KINDS = none／held／byte-swap／ai-rewrite` · 读不出契约版 ⇒ **抛**（`不可算`，不猜） |
| **C1** | 改（**小改**）`src/apps-socket.js`：`case 'install'` 装成之后调 `ctx.upgrade.plan(...)`，把决定记进账本并回在回执里 | 装／升级那条**真路**上也读得出"这一次要不要请 AI" | 没接那本账（`ctx.upgrade` 不给）⇒ **什么都不做**（既有调用方一字不变） |
| **C3** | **新** `src/app-upgrade.js`：`UpgradePolicy` · `DEFAULT_UPGRADE_MODE` | **默认按用户整体跟**（`mode='user'`）；某一个 **`pin(id, version)`** ⇒ **留旧版** | 盘上 `<用户那一格>/upgrade-policy.json`；`state(id)` = `{mode, follows, pinnedVersion}`（**看得见**） |
| **C3** | 改（**小改**）`src/worlds.js`：apps 的 ctx 多一格 `upgrade: new UpgradeBook({ dir: t.dir })` | 那本账住**他那一格** | 账本 `<用户那一格>/upgrade-ledger.jsonl`（**只在真有升级决定时**才建） |

### 1.1 一次发布的形状（A2 那一段加在哪）

```
published.publish()：
  ① assertOutboundAllowed（出界申报 · 两格 · 阶段 2）
  ② assertOutboundBytes（声明 ↔ 声明）＋ 读那一版全部字节
  ③ assertOutboundBytes（声明 ↔ 字节）· assertDeclarationAllowed（外联申报）
  ④ parseDataShape（形状声明 · A1）
  ⑤ ★ **runEntryOnce（A2 · 真跑一次 · 最小判据）**   ← 本批新增；**在写盘之前**
  ⑥ 写 versions/<n>/ → 写 index.json（带 ran 凭据）→ 审计
```

### 1.2 一次升级判定的形状（C1／C3 合起来的那一次）

```
planUpgrade({apps, id, fromVersion, toVersion, policy})：
  ① 没有新版 / 就是这一版        ⇒ none        （不过度：一个字节都不写）
  ② policy.follows(id) === false ⇒ held        （C3：显式留旧版；rewrite = false）
  ③ 否则 decideUpgrade({contractFrom, contractTo})   ← 🔴 全仓唯一那一处比较
       契约版逐字相同 ⇒ byte-swap       （整版换字节 ＋ 保数据，**不请 AI**）
       契约版变了     ⇒ ai-rewrite      （请 AI 在那个实例自己的房间走出来 —— 不是 mapping）
       ⚠️ 任一侧读不出 ⇒ **抛**（不可算），既不默认请、也不默认不请
```

---

## 二、判据读数（每条含**负向对照**；⑥ 含**变异**）

跑法：

```bash
cd v2/services/core && node --test test/app-run.test.js test/app-upgrade.test.js   # D1–D6（13 条）
bash scripts/check-publish-run-upgrade.sh                                         # P1–P8（11 条读数）
```

本轮读数（2026-10-03 本机，**只碰临时目录**，不碰线上、不碰真数据目录）：

| 判据 | 它问什么 | 读数 |
|---|---|---|
| **P1 = ①** 🔴 | A2：真跑过的最小判据**通过 ⇒ 发** | ✓ 发成了（第 1 版）· 登记里 `ran.ok=true`（跑了 1 段、2ms）· **盘上那份 `index.json` 逐字有它** |
| **P2 = ②** 🔴 | A2：**入口必崩 ⇒ 拒**（理由看得见、零残留）；**负向对照**：把崩的那份**修好 ⇒ 过** | ✓ 拒了（`EntryRunError`）· 共享库**逐文件 sha256 逐字复原**（一条都没有）· ★ 那一句抛改成 `var ok=1` ⇒ 同一条路发成了 |
| **P3 = ③** 🔴 | A2：**不做全量回归**（源码级 ＋ 行为级） | ✓ 源码里没有子进程／网络／npm；跑的时候**带硬预算**；`runEntryOnce` 只在 `app-run.js` 定义一次、`publish` 只调它一次 · ★ 死循环入口 **251ms 被截住**（预算 250ms）——**没有跑长** |
| **P4 = ④** 🔴 | A2：驳回理由**看得见**（哪个文件、哪一行、什么错） | ✓ 点名 `index.html#script-0 第 3 行：第三行崩的` · ★ 负向对照：没崩的那一份说的是"**起来了**"，不是"起不来" |
| **P5 = ⑤** 🔴 | C1：**契约版未变 ⇒ 重写计数 = 0**；**负向对照**：**变了 ⇒ > 0** | ✓ 未变：`byte-swap`／计数 **0** · 变了：`ai-rewrite`（契约 `1→2`）／计数 **1** |
| **P6 = ⑥** 🔴 | C1：判定**只有一处**（源码级）＋ **变异** | ✓ 那条比较／那个结论／那个取值**全仓各只一份**；`planUpgrade` 只走它；真路（`apps-socket`）只调 `ctx.upgrade.plan` · **变异**：把 guard 改成"一律请 AI" ⇒ 未变那一次**也重写了**（`UNCHANGED_NO_REWRITE → UNCHANGED_REWRITTEN`，证明那处 guard 承重） |
| **P7 = ⑦** 🔴 | C3：**默认按用户跟**；**负向对照**：**显式留旧版的那一个 ⇒ 不跟**，且状态看得见 | ✓ 默认 `mode=user`／`follows=true` ⇒ 契约变了就请 AI · 留旧版那个：`follows=false`、`pinnedVersion=2`、决定 `held` · 别的 app（`b`）照旧跟 |
| **P8 = ⑧** 🔴 | C3：**不过度**（没升级需求 ⇒ 不动） | ✓ `kind=none`／账本没建／**整棵树逐文件 sha256 逐字不变** · ★ 负向对照：真有升级 ⇒ 账本**真写了一行**、树真变了 |
| **零残留** | 全部：越界／误操作**零残留** | ✓ 真数据目录 **152 个文件逐文件 sha256 逐字复原**（本闸只碰临时目录） |

**全量读数**：`npm test` **1501 通过／0 失败**（改前 **1488**；本批 **+13**）·
新闸 `check-publish-run-upgrade.sh` **通过 11 · 失败 0** ·
**九条老闸一个字节没动、照旧绿**（§四 读数）· `node scripts/check-docs.mjs` 绿。

---

## 三、改了什么（逐条）

| # | 路径 | 新／改 | 是什么 |
|---|---|---|---|
| 1 | `v2/services/core/src/app-run.js` | **新** | **A2 唯一定义处**：`runEntryOnce()`（真编译 ＋ 真执行 ＋ 硬预算）· `extractScripts()` · `normalizeRelPath()` · 最小浏览器壳 · `describeRunFailure()` · `EntryRunError` · `RUN_FAILURES` |
| 2 | `v2/services/core/src/app-upgrade.js` | **新** | **C1／C3 唯一定义处**：`decideUpgrade()`（**唯一判定**）· `planUpgrade()` · `UpgradePolicy`（粒度默认"按用户"）· `UpgradeBook`（重写计数）· `UpgradeError` |
| 3 | `v2/services/core/src/published.js` | 改（**小改**） | `publish()` 写盘之前跑 `runEntryOnce`（拒 ⇒ `EntryRunError`）；`index.json` 与审计多一格 `ran`（"跑过"的凭据） |
| 4 | `v2/services/core/src/apps-socket.js` | 改（**小改**） | ① `case 'publish'`：`EntryRunError` ⇒ 拒绝码 `entry-would-crash`；② `case 'install'`：装成后调 `ctx.upgrade.plan(...)`（没接 ⇒ 什么都不做） |
| 5 | `v2/services/core/src/worlds.js` | 改（**小改**） | apps 的 ctx 多一格 `upgrade`（账本住他那一格） |
| 6 | `v2/services/core/test/app-run.test.js` | **新** | D1–D6 共 7 条（每条带负向对照；D3 源码级 ＋ 行为级） |
| 7 | `v2/services/core/test/app-upgrade.test.js` | **新** | D1–D6 共 6 条（每条带负向对照） |
| 8 | `scripts/check-publish-run-upgrade.sh` | **新** | P1–P8（真代码 ＋ 真盘 ＋ 源码级 ＋ **变异**）＋ 零残留核验，**11 条读数**全带负向对照 |
| 9 | `docs/dev/168-PUBLISH-RUN-UPGRADE.md` | **新** | 本文 |
| 10 | `docs/dev/00-PROGRESS.md` | 改 | §〇 顶部一行 |

### 与既有决定的接口（不新造口径）

- **`90` Q7.3／§7.2**"契约版本变才请 AI；只 `rootHash` 变 ⇒ 整版换字节 ＋ 保数据" ⇒
  `decideUpgrade` 的输入就是 `apps.shapeVersion()`（= 清单里那个 `schema`，**能力体那一族**的号），
  而**不是** `rootHash`、也**不是** `data-shape.json` 里那个包级 `shapeVersion`（`91` §8.1「三个号互不代管」）。
- **`90` Q7.5**"假造一次契约 `N→N+1`" ⇒ 判据就是照这条验的（只改清单里那个号）。
- **`85` §六**"不做 N×N mapping／不许静默" ⇒ `decideUpgrade` **只回两类**（换字节／请 AI），
  没有"从旧形状到新形状的映射表"；每一次决定落账本（**不静默**）。
- **`90` Q5.3**"登记里有一条**可核的'跑过'凭据**" ⇒ `index.json` 里的 `ran`（盘上可复核）。

---

## 四、九条老闸的读数（**一个字节没动**）

| 闸 | 读数 |
|---|---|
| `npm test` | **1501 / 0**（改前 1488；本批 +13） |
| `scripts/check-outbound-bridge.sh` | **13 / 0** |
| `scripts/check-data-contract.sh` | **9 / 0** |
| `scripts/check-data-shape.sh` | **8 / 0** |
| `scripts/check-app-storage-rule.sh` | **17 / 0** |
| `scripts/check-edge-kinds.sh` | **8 / 0** |
| `scripts/check-app-entry-identity.sh` | **9 / 0** |
| `scripts/check-index-author-hash.sh` | **4 / 0** |
| `scripts/check-read-side-assert.sh` | **10 / 0** |
| `scripts/check-scope-boundary.sh` | **6 / 0**（它自己打印"有跳过的"—— 跳过的**不是**过的） |
| `node scripts/check-docs.mjs` | 绿 |
| **本批新闸** `check-publish-run-upgrade.sh` | **11 / 0** |

---

## 五、没做成 / 不确定 / 待办

1. **"请 AI 重写"那一执行器今天不存在**：本批交的是**那一处判定 ＋ 那本账 ＋ 判据**。
   账本记的是"**这一次决定要请 AI**"，不是"AI 真的重写完了一遍"。要它真承重，得有那条执行路
   （实例房间里跑一轮 AI 写脚本、真跑、过判据）—— 那是 `85` §五 **F3** 的另一半，
   不在本批里偷偷做。⇒ 如实说：**"重写计数"今天读的是"决定计数"**。
2. **最小真跑替不了真浏览器**：它证的是"**能起来 / 入口必崩**"，不是"在主人屏幕上是什么样"。
   真机那一侧仍归 `scripts/check-web-browser.mjs`（V13）。**没有真机验收**（本批判据全在临时目录里跑）。
3. **`type="module"` 的入口今天只"跳过、不误拒"**：最小壳里没有模块加载器 ⇒ 如实记 `skipped: module`。
   这不是"验过了"，是"这一档不可算"（写在 `app-run.js` 文件头与 `RUN_FAILURES` 旁边）。
4. **`data-shape.js` 的 `shapeVersion` 与 `apps.shapeVersion()` 不是一回事**：本批的"契约版本"
   只用后者（清单 `schema`）。若将来"契约"要连**数据形状**一起算，那是一次**新的口径决定**。
5. **没部署、没重启**：线上（`w.stalkerai.cn` → 本机 `8020`）跑的仍是**旧代码**。
6. **没动手册**：`D4.24` 已记口径（A2／C1／C3），实现形状属于实现细节 ⇒
   按手册纪律①（不写实现细节/数值）**不写进手册**。⇒ **不需要重建开机清单**
   （`docs/handbook/**`／`AGENTS.md`／人格／`~/.dsh/profiles/**` 一个字节没动；
   `docs/dev/00-PROGRESS.md` **不在** `strict` 清单里）。

---

## 六、文件清单 ＋ 需要谁做什么

**新增**：`src/app-run.js` · `src/app-upgrade.js` · `test/app-run.test.js` · `test/app-upgrade.test.js` ·
`scripts/check-publish-run-upgrade.sh` · 本文。
**改动**：`src/{published,apps-socket,worlds}.js` · `docs/dev/00-PROGRESS.md`。
**未动**：`AGENTS.md` · `v2/apps/mobile/**`（客户端**不需要改**：本批不新增任何协议字段、不上屏）·
`docs/handbook/**` · 现存九条 `check-*.sh` · 任何别人的改动。

**需要父 agent 做的**：
1. ✅ **不需要重建开机清单**（没碰 `strict` 那几样）。
2. （可选）若要把线上切到新代码：部署／重启（**主人签字**那一档，本批不做）。
3. 🔴 **F3 的另一半**（AI 重写执行器）**没有落地** ⇒ 若要把 C1 做成"真仪式"，那是下一批。
