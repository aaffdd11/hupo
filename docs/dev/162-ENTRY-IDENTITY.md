# 162 · 制品入口 URL 去掉明文身份 ＋ 审计换凭据哈希（D4.24 · A3／A3·补）

> **一句话**：入口 URL 从 `?u=<sub>&e=…&s=…` 改成 **`?e=…&s=…`** —— 人**只绑在签名里**，
> URL 上一个字都不露；服务端要认人，就拿**这台部署登记过的人**逐个试那条签名
> （试中谁就是谁）。审计账里的身份从中文明文换成**带键的凭据哈希**（稳定、可对账、推不回）。
>
> **口径是拍过板的，不是本文设计的**：`docs/handbook/05-DECISIONS.md` **D4.24**（2026-10-03 定，
> 签字页 `161-OWNER-DECISIONS-11.md`）；原始问题与建议在
> `docs/dev/90-APP-CONTRACT.md` **§9.2·1** 与 **§10.1·⑤**（§10.2 的第 5、8 条是同一件事）。
>
> 依据：`90-APP-CONTRACT.md` §5.3／§9.2·1／§10.1·⑤／§10.2 · `157-OUTBOUND-BRIDGE-GATE.md` §六 ·
> `158-RESIDENT-OUTBOUND-ASSERT.md` §五 · 以及**本轮亲自核过的代码与盘上读数**（见 §三／§附）。
>
> 🔴 纪律：**不写数值**（阈值只住代码）· **读不出就报 `不可算` 并记失败** ·
> **每条判据都要有负向对照**（脚本要核那条对照真的在）· **不伪造一致** · **旧行不改写**。

---

## 〇、先钉口径（照拍板的原话，不重新设计）

D4.24 里与本批有关的两格：

- **A3**：制品入口 URL **去掉明文 `sub`**（绑人绑进签名；审计里换**凭据哈希**）。
- **A3·补**（`90` §10.1·⑤ 的建议原文）：*"入口 URL 只带签名与到期，**绑人绑在签名里而不写在 URL 里**
  ……**审计里的原始 `sub` 换成凭据哈希**（顺带修 §9.2·1）"*。

⇒ 本批就落这两件。**没有**顺手改"署名／下架凭据"（那是 B1／`90` 的 Q5.4·Q5.5，另一笔账，见 §五）。

---

## 一、身份现在从哪儿来（URL → 签名 → 服务端怎么验）

| 那一步 | 现在是什么 |
|---|---|
| **签**（`app-serve.js` 的 `entryUrl()`／`liveEntryUrl()`） | 签名 payload **一个字没改**（`signPayload`：`sub\|id\|version\|exp`）—— 人**仍然绑在签名里**；只是 URL 上**只拼 `e`（到期）与 `s`（签名）**，不再拼 `u=<sub>` |
| **传**（壳 → 制品页） | 页面照旧从头 `location.search` 里能拿到 `e`／`s`；**没有 `u` 了**（老页面多报一个 `u` 也无所谓，见下） |
| **验**（`resolveEntrySub()`，两条路共用一处） | 拿 `subsOf()` 给的**已知的人**逐个算一遍 `signEntry`：**试中谁 ⇒ 这是谁**；一个都不中 ⇒ `null` ⇒ **403**（fail-closed） |
| **名单从哪来**（`serve.js`） | `subsOf: () => [OWNER_ID, ...users.ids()]` —— 与开机 `worlds.warmUp([OWNER_ID, ...users.ids()])` 那份**逐字同源**（登记过的人就是这些人）；**现取**（新登记的人当场生效） |
| **`/db` · `/ask` · `/agent`**（app 原点那几条口） | 同一个 `resolveEntrySub`（`appTicketOf` 走它）—— `id`/`v` 从正文来，**人从签名来**；老页面正文里那个 `u` 今天**被忽略** |

**一句话**：**URL 只带"到期 + 签名"；人绑在签名里；服务端拿"登记过的人"逐个试签名认出来。**

### 1.1 为什么不做"URL 带一个不透明 handle"

那一版也能让串里搜不到明文，但它仍然是**URL 上一个可关联到人的指针**（第三方制品读一下
`location.search` 就能跨页 join 同一个人）。口径要的是 **URL 只带签名与到期** ——
只有当"人"**一个字都不在 URL 上**时，"URL 里搜不到身份"才是**结构性**的、不是"换了个写法"。
代价也写在明处：一次请求最多算 **`subsOf()` 条数的 HMAC**（今天这台部署的人很少；
真到很大那天要换成"按签名查表"——**判定仍然只在这一处**，不许分叉）。

---

## 二、新增／改了哪些文件（逐条）

| 文件 | 改了什么 |
|---|---|
| `v2/services/core/src/cred-hash.js` | **新**。`credHashOf(sub, key)`：带键 HMAC-SHA256（域前缀 `hupo-cred-v1`）。**为什么不是裸 `sha256`**：`sub` 可枚举（`u1`/`u2`…）⇒ 裸哈希能穷举反推；带键才"推不回"。没接线时退化成一个**常量**键（值仍稳定，但**生产必须接线**，有一条判据钉它） |
| `v2/services/core/src/app-serve.js` | **新** `resolveEntrySub()`（认人只从签名来）；`entryUrl()`／`liveEntryUrl()` **去掉 `u`**；`appTicketOf()` 与制品/活地址那条路改用 `resolveEntrySub`；`createAppServer` 收 `subsOf`（不给 ⇒ 一律拒）。`signEntry`／`verifyEntry`／`signPayload` **一个字没改** |
| `v2/services/core/src/serve.js` | 把 `appsSignKey = loadSignKey(...)` **提前**到 `new Worlds(...)` 之前（审计那把键要用它）；给 `createAppServer` 接上 `subsOf`；给 `Worlds` 接上 `credKey` |
| `v2/services/core/src/worlds.js` | 收 `credKey`，往下传给 `Published`（共享库）与每个人那份 `Apps` |
| `v2/services/core/src/apps.js` | 收 `credKey`；`#audit` 的第一格从 `sub: this.sub`（明文）换成 `sub: credHashOf(this.sub, this.credKey)` |
| `v2/services/core/src/published.js` | 收 `credKey`；`installInto` 的审计从 `by: apps.sub`（明文）换成 `by: credHashOf(apps.sub, this.credKey)` |
| `v2/services/core/test/app-entry-identity.test.js` | **新**。两组判据逐条钉（含负向对照）—— 见 §三 |
| `v2/services/core/test/{apps,app-live,app-agent,app-ask-fetch,app-db,app-inset,app-net,apps-box,app-menu}.test.js` | 跟着改：给测试里的制品口补 `subsOf`；"换一个 `u`"那种负向对照换成"改一个字／拿别人的签名"；审计那两条断言改成**凭据哈希** |
| `scripts/check-app-entry-identity.sh` | **新**。A3／A3·补 两组判据的闸（逐条 `OK`／`BAD`，末尾 `通过 N · 失败 M`） |

**没碰的**：`AGENTS.md` · `v2/apps/mobile/**`（客户端**一个字节没改**）· `docs/handbook/**`（手册
`D4.24` 已经把口径记下了，代码现在与它一致 ⇒ **不需要跟改**）· 三条老闸
（`check-scope-boundary.sh`／`check-outbound-bridge.sh`／`check-edge-kinds.sh`）**一个字节没动**。

---

## 三、判据读数（含负向对照）

### 3.1 本批自己的闸 `scripts/check-app-entry-identity.sh`（**通过 9 · 失败 0**）

| 判据 | 读数 |
|---|---|
| **A3-①** 真入口 URL 里搜不到身份 | 制品 ＋ 活地址两种都：`u=`／`sub=`／`u1` **零命中**；查询串**只剩 `e`/`s`**；而 `verifyEntry` 证明**身份确实绑在签名里**（不然判据空转）。**负向对照**：同两个搜索器喂一条 `…&u=u1` 的样本**抓得住** |
| **A3-②** 照旧能打开（正对照） | 真 URL ⇒ **200**，正文对（`<p>甲的一版</p>`） |
| **A3-③** 拿别人的签名 / 改一个字 ⇒ 拒 | 改签名一个字／u9（没登记）的签名／换版本／换 app／过期／没签名 ⇒ **6/6 全 403** |
| **A3-③·核心负向对照** | 往真 URL 上挂 `&u=u2` ⇒ **仍以 u1 的身份打开**（拿到的是甲的内容）—— **旧攻击面已经不存在**（认人只看签名） |
| **A3-③·补** 盘上零残留 | 跑前跑后逐文件 sha256：`9` 个条目**一个不变**（被拒的请求连盘都不碰） |
| **A3-④** 客户端不用改 | 老页面正文里 `u=u2` 想冒充 ⇒ 认出来还是 **u1**；把签名换成 u2 的 ⇒ 认出来 **u2**（不是恒回 u1）；且 `app-serve.js`（去注释后）**不再有**读 URL 上 `u` 的地方 |
| **A3·补-①** 新审计行无明文 | 每人那份 ＋ 共享库 `install` 行都搜不到明文身份；`install.by` = `credHashOf('u2', 键)`。**负向对照**：搜索器喂明文样本抓得住 |
| **A3·补-②** 同一人对得上、两人不撞 | 同一个人的两行**相等**；两个人**不等**；**换键就换值**（键不对算不出同一串）；**不是裸 `sha256`** 也不是退化键 |
| **A3·补-③** 旧行逐字节没被动 | 先摆一条旧形状行（明文 `"sub":"u1"`），再触发新写入 ⇒ 旧 `59B` **逐字节原样**，新行**追加**在后面 |

### 3.2 四条既有闸（照任务要求跑，读数抄这里）

| 闸 | 读数 |
|---|---|
| `cd v2/services/core && npm test` | **1463 通过 · 0 失败**（改前 **1457**；本批 **+6**，全是新判据那份） |
| `bash scripts/check-scope-boundary.sh` | **通过 6 · 失败 0**（portable；真机那几条照旧要 `--live`） |
| `bash scripts/check-outbound-bridge.sh` | **通过 13 · 失败 0** |
| `bash scripts/check-edge-kinds.sh` | **通过 8 · 失败 0** |

### 3.3 真机（**只读**，本轮没部署、没重启）

| 盘上事实 | 读数 |
|---|---|
| `data/published-apps/audit.jsonl`（共享库审计） | **1 行**（`publish` 那条，本来就**没有** `by`）⇒ 现存**零明文 `by`** |
| `data/hupo/apps/audit.jsonl`（主人自己那份） | **32 行**，是**旧形状**的 `"sub":"…"` —— **历史，按口径不动**；**新写入的行**（部署之后）才会是哈希 |

---

## 四、为什么不扩那三条老闸

`check-scope-boundary.sh`（92 §④ 真机那一列）· `check-outbound-bridge.sh`（92 §③ 阶段 2 出界独木桥）·
`check-edge-kinds.sh`（92 §③ 阶段 5 三条登记边）—— 各自管一条**不相交**的阶段线，
与"入口 URL 里有没有身份 / 审计里写的是谁"**没有重叠**。混进去会让"这一条红了该找谁"变模糊。
⇒ **新开一条**（`scripts/check-app-entry-identity.sh`），三条老闸**一个字节没动**。

---

## 五、没做成 / 不确定 / 需要父 agent 的

1. **没部署、没重启**（照硬约束）：**线上那个进程还在跑旧代码**，`data/` 上现在不会多出哈希行。
   ⇒ 要让线上生效得由父 agent 走既有的重启/发布那条路。
2. **需要父 agent 重建开机清单** —— ⚠️ **但本轮实测的口径是"不需要"**，两条都如实记：
   - 我**没碰**任何 `strict` 条目（`AGENTS.md`／`docs/handbook/**`／那几个 `*.yml`）；
   - `/etc/hupo/integrity.json` 里 `docs/dev/**` 的条目数 = **0**，`v2/services/core/src` 与 `scripts`
     是 **`report`（只报不拦）** ⇒ 我新加的 `cred-hash.js` / `check-app-entry-identity.sh` /
     `162-*.md` **不在清单的覆盖范围内**，不会让下次开机拒绝启动。
   ⇒ 若父 agent 的收尾纪律是"每次收尾都重建"，那就重建（那要 root 口令，我这边没有）。
3. **不确定（判据强度，未拍）**：认人是"拿名单逐个试签名"，代价是 **O(人数) 次 HMAC/请求**。
   今天人数很少、无感；**人数一多就该换成"按签名查表"** —— 那是取舍，不是缺陷，**本批没做**。
4. **本批没做（另一笔账，如实点出来，别当成"顺手修了"）**：
   - `published.js` 的 `index.json` 里仍然存 `authorHash = sha256(sub)` 前 12 位（**可枚举反推**），
     而且它与"下架凭据"同源 —— 那是 `90` §5.3 的 **Q5.4／Q5.5**（状态【要建】）与 D4.24 **B1**，
     **不属于 A3·补**（A3·补说的是**审计账**）。要修得单独拍。
   - `reclaim.js` 往 `.removed/…/reclaimed.json` 里写 `by: <sub>`（**明文**）—— 那是**每人自己那份**
     的删除留痕，**不是**审计账；本批**没动**（动了会连带改 `app-reclaim` 的断言与一份留痕的形状）。
5. **`90-APP-CONTRACT.md` 的账**：§9.2·1 的冲突 #1 与 §10.1·⑤／§10.2 的第 5、8 条，
   **本批按"改代码"这条路结了**（§9.2·1 自己写着"要么改代码，要么改手册"）。
   我**没有**改 `90`（本轮允许动的只有：`src/**`／`test/**`／`scripts/check-*.sh`／本文／`00-PROGRESS`）
   ⇒ 请父 agent 决定要不要把 `90` 那几格标成"已由代码结掉（见 `162`）"。
6. **客户端改不改**：**不需要**。依据三条：①壳把 `entryUrl` 当**不透明串**透传（`app_spec.dart`
   只认 `entryUrl`/`expiresAt`）；②`v2/apps/mobile/lib/**` 里**搜不到**任何读 `u`/`location.search`
   的地方；③制品页多报一个 `u` 时服务端**忽略**它（老页面照旧能用，判据 A3-④）。

---

## 附：本文核过的代码与盘上事实（清册）

| 文件 | 核到的关键处 |
|---|---|
| `v2/services/core/src/app-serve.js` | `signPayload`／`signEntry`／`verifyEntry`（**未改**）· `resolveEntrySub`（新）· `appTicketOf`（`subsOf`）· `entryUrl`／`liveEntryUrl`（去掉 `u`）· 制品/活地址那条路（`resolveEntrySub`）· `createAppServer({ subsOf })` |
| `v2/services/core/src/cred-hash.js` | `CRED_HASH_DOMAIN` · `credHashOf(sub, key)` |
| `v2/services/core/src/apps.js` | `#audit` 第一格 = `credHashOf(this.sub, this.credKey)` |
| `v2/services/core/src/published.js` | `installInto` 的 `by` = `credHashOf(apps.sub, this.credKey)` |
| `v2/services/core/src/serve.js` | `appsSignKey` 提前读 · `credKey: appsSignKey` · `subsOf: () => [OWNER_ID, ...users.ids()]` |
| `v2/services/core/src/worlds.js` | `#credKey` · `new Published({ dir, credKey })` · `new Apps({ …, credKey })` |
| `v2/services/core/test/app-entry-identity.test.js` | 本批 6 条判据（A3①／②③／④ · A3·补①②／②③ · 接线） |
| `scripts/check-app-entry-identity.sh` | A3／A3·补 两组闸（9 条读数） |

**仓库／盘上事实（本轮实测）**：开工时 `git status --short` **干净** ·
`npm test` **1463 通过／0 失败**（改前 1457）· 三条老闸 **6/0 · 13/0 · 8/0** ·
本批新闸 **9/0** · 真共享库审计 **1 行**（无 `by`）· 主人那份审计 **32 行旧形状**（未动）。
