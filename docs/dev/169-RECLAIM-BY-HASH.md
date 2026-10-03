# 169 · 回收留痕 `reclaimed.json` 的"谁删的"换成带键 HMAC（`D4.24 · B1`／`A3·补` 同族 · 账本 `#74`）

> **一句话**：系统收掉一间房／一台盒子时，会在**用户自己那一格**里写一条回收留痕
> （`reclaimed.json`），其中 `by` 原来是 **`sub` 的明文**（`owner`／`u1`／`u2`…，可枚举）。
> 现在写的是 `cred-hash.js` 那套 **带键 HMAC**（域 `hupo-cred-v1`，键 = 制品签名键）——
> 与**审计账**、**共享库作者假名**（`published.js` 的 `authorHashOf`）**同一个函数**。
>
> 🔴 改法是 **"读得出老值、只写新值"**（**不做存量迁移**）：读走 `readReclaimBy`
> （`'cred' | 'legacy' | null`，形状照 `published.js` 的 `readAuthorHash`），
> 写永远走 `reclaimByOf`。这与 [`163-INDEX-AUTHOR-HASH.md`](163-INDEX-AUTHOR-HASH.md)
> 那套**逐字同形**。
>
> **口径是拍过板的**：`docs/handbook/05-DECISIONS.md` **D4.24** 的 **B1**（"真身份不给"，
> 2026-10-03 定），以及主人 **2026-10-03** 对这笔账的"可以的"。
>
> 🔴 纪律：**不写数值** · 读不出就报 **`不可算`** 并记失败 · **每条判据都要有负向对照**
> （**变异实测过**，见 §三）· **存量值一个字节不改**。

---

## 〇、先钉口径（照现成的那一套，别另造）

- 函数**只有一处**：`v2/services/core/src/cred-hash.js` 的 `credHashOf(sub, key)`
  （带键 HMAC-SHA256，域 `hupo-cred-v1`）。本批**不新写哈希**，只**借它**。
- `sub` 是 `users.js` 发的**稳定用户 id**（`owner`／`u1`／`u2`…；手机号 → id 的映射
  住 `data/users.json`，**0600**）。⚠️ **如实说**：这条账原来记作"明文手机号"，
  而盘上实测 `by` 写的是**这个 id**（不是手机号）—— 见 §一与 §五.1。
- 键从哪来：生产由 `serve.js` 把**制品签名键**（`appsSignKey`）接到 `Worlds`；
  `worlds.js` 再把它传进回收上下文。没接线（单测 / 老调用方）⇒ `cred-hash.js` 的
  **退化常量键**（值仍稳定、也不是明文，但常量谁都能知道）⇒ 判据钉这条接线。

---

## 一、它今天谁写、谁读（改法由这一条决定）

改动前读数（`cd v2/services/core && grep -rn "reclaim\|reclaimed" src/`）：

| 面 | 证据 | 说明 |
|---|---|---|
| **写**（唯一一处） | `src/reclaim.js` 的 `reclaimScope()`：`by: sub ?? null` | 两条路都落这里：`Apps.remove()`（有制品）与 `world.reclaimRoom()`（没制品 · B28） |
| **谁把 `sub` 递进来** | `src/server.js`：`w.reclaimRoom(scope, { sub: claim.sub })`（宿主）· 盒里那条内部口 `{ sub: trustedSub }` | `claim.sub` 是令牌里的身份；这是**今天唯一进这一格的明文来源** |
| **读**（今天） | `readReclaimedSeqs()` —— **只读 `takenSeqs`** | 校验器按它解释号洞（N22 的唯一例外）；**不读 `by`** |
| **回给客户端** | `src/server.js` 的宿主 `/api/room-remove`：`sendJson(res, 200, { ok: true, record })`（**整条**，含 `by`）；盒里那条内部口只回 `{scopeId, takenSeqs, items}` | ⚠️ 客户端（`v2/apps/mobile/**`）**不解释 `by`**（全仓 grep 零命中）⇒ **今天没有一个生产读取方解释这一格** |

⇒ **结论**：这一格**不承重**（没有人拿它判权限 / 判归属）。所以改法是**最轻的那一种**：
**只换写入口径 ＋ 留一个定义好的读法**，老记录一个字节不改。
（与 `#73` 不同：那一格承重，所以要更小心地"读得出老值、只写新值"—— 本批照抄它的形状。）

---

## 二、改法（三样分开，别混）

| 名字 | 是什么 | 谁用 |
|---|---|---|
| `reclaimByOf(sub, key)` | **当前口径** = `credHashOf(sub, key)`（带键 HMAC，域 `hupo-cred-v1`） | **所有写**（`reclaimScope` 写 `by`） |
| `legacyReclaimBy(sub)` | **旧口径（只读）** = `sub` 的**明文** | 只用来**读**存量 |
| `readReclaimBy(stored, sub, key)` | 读一格：`'cred'`／`'legacy'`／**`null`（读不出来）** | 给"将来真读它的人"的**唯一读法** |

🔴 **`null` 一律 fail-closed**：既不是新口径写的、也不是旧口径写的 ⇒ 当"**认不出是谁**"，
**绝不许**落到"那就是某个人"。换一把键时同一个人的**新值**也读不出来 —— 那正是"换键就换值"。

**接线（一处实现，两处调用都走它）**：

- `src/worlds.js` 的 `reclaimCtx()` 多带 `credKey: this.#credKey` —— `world.reclaimRoom()`
  那条路**只走它**（没有 `Apps` 可问）。
- `src/apps.js` 的 `remove()` 里把 `credKey: this.credKey` **显式**给 `reclaimScope()`
  （与 `sub` 同一条理由：以 `Apps` 自己那份为准）。
- `src/reclaim.js` 的 `reclaimScope()` 多收一个 `credKey = null`，`by` 改走 `reclaimByOf`。

**存量保平安的方式（明说，二选一里的哪个）**：选的是 **"读得出老值、只写新值"**
（**不是**"一次性迁移存量文件"）。理由：① 这一格虽然**不承重**，但存量文件散在
**每一格**的 `.removed/` 下面，一次性迁移要写脚本去动**用户自己那一格**；
② "只写新值"**不需要任何停机 / 批处理**，老记录照旧躺在那里、照旧读得出来。

---

## 三、判据与读数（每条都有负向对照；变异实测过）

新闸：[`scripts/check-reclaim-by-hash.sh`](../../scripts/check-reclaim-by-hash.sh)（`通过 4 · 失败 0`）。

| # | 判据 | 负向对照 | 读数 |
|---|---|---|---|
| ① | 新写入的 `reclaimed.json` 里搜不到**身份明文**（`owner`／`u2`）与**手机号形状的明文**；写的是 `credHashOf(sub, 键)`（64 位十六进制） | 同一个搜索器喂一份**老留痕**（明文 `by`）与一份**手机号形状**的明文必须**抓得住** | ✓ 零命中；`by=993ae0de37fe86db…`；负向对照 `detector=true` |
| ② | 同一身份**稳定**（两次写入同值）· **两个人不撞**（换 `sub` ⇒ 换值）· **换键就换值**；不是裸 `sha256`、也不是退化键；**生产接线真把键传下去** | **换一个 `sub` ⇒ 值必须变**；**换一把键 ⇒ 值必须变**；**拔掉接线 ⇒ `wired=false`** | ✓ `993ae0de37fe…` vs `bd8ef92c41da…`；`wired=true` |
| ③ | **存量照旧**：把**真机那一份**老 `reclaimed.json` **逐字节**拷进临时目录，跑**今天的读路**（`readReclaimedSeqs` ＋ `verifyMonotonic`）⇒ 照旧读得出、不抛；老那一格**本人认得出**（`legacy`）、**别人认不出来**（`null`） | 不带留痕判 ⇒ **必须红**（证明洞是真的）；**读不出来**的情形（坏 JSON / 垃圾值 / 空 / 缺格 / 换键）⇒ **如实 `null`**、坏的那一份**跳过**（既不猜成某个人，也不当成"没有洞"） | ✓ 真机 `app-0yegxgx1-1790698835185`（`by=owner` · `takenSeqs=[130…135]`）；本人 `legacy` / 别人 `null`；`failsClosed=true` |
| ④ | **零残留**：真机 `data/hupo/apps/.removed/` 跑前跑后**逐文件 sha256 一致**（这一条闸全程只读） | 改一个字节 ⇒ 指纹必须变（证明不是恒等空转） | ✓ **111 个条目不变** |

单测：[`v2/services/core/test/reclaim-by-hash.test.js`](../../v2/services/core/test/reclaim-by-hash.test.js) **4 条**
（R1 明文零命中 ＋ 负向对照 · R2 稳定／不撞／换键／不是裸 sha256 · R3 老留痕照旧读得出 ＋ 读不出如实 `null` ·
R4 接线：`serve.js` → `worlds.js` 的 `reclaimCtx` / `apps.js` 都真把 `credKey` 传下去）。
另外改了 [`test/app-reclaim.test.js`](../../v2/services/core/test/app-reclaim.test.js) 的 **S8** 一条断言：
`rec.by === 'owner'` ⇒ 改成 `readReclaimBy(rec.by, 'owner') === 'cred'` ＋ 别人读 `null` ＋ 格子里无明文。

**变异实测**（证明闸不是空转的；跑完逐字节还原，`sha256sum` 一致）：

| 把代码改回… | 闸的反应 |
|---|---|
| `by: reclaimByOf(sub, credKey)` 退回 **`by: sub ?? null`**（= 改前那一行） | **①② 红**（`通过 2 · 失败 2`）；新测试 **3 条红**；③ ④ 照旧绿（③ 管"读老值"、④ 管残留） |
| `worlds.js` 的 `reclaimCtx` **拔掉 `credKey`** | **② 红**（`通过 3 · 失败 1`，读数 `wired=false`）；新测试 **R4 红** |
| `readReclaimBy` 的 `return null` 退回 **`return 'legacy'`**（不再 fail-closed） | **③ 红**（`通过 3 · 失败 1`，读数 `other=legacy failsClosed=false`） |

> ⚠️ 第二条变异是**第一版判据没抓住**的：那时 ② 只拿 `KEY` 自己造记录 ⇒ 接线断不断它都绿；
> R4 的第一版正则又**误配**了后面 `new Apps({… credKey: this.#credKey …})` 里同名的格
> ⇒ 拔掉 `reclaimCtx` 的键它照旧绿。修法两处：① 把"生产接线"并进 **闸的 ②**；
> ② R4 只截 `reclaimCtx` **那一个对象字面量**（到它自己的 `});` 为止）。

---

## 四、真机上那份**存量**（这一批必须照旧能用）

实测（只读）：

| 项 | 读数 |
|---|---|
| 目录 | `v2/services/core/data/hupo/apps/.removed/`（`HUPO_DATA` 指的就是 `data/`） |
| 在架留痕 | **9 格**；`by` 全部是 `"owner"`（明文）；其中 `app-0yegxgx1-1790698835185` 的 `takenSeqs=[130…135]`、`probe-full-1790748366536` 的 `takenSeqs=[136…149]` |
| 闸里那条 ③ 用的 | 就是**真机那一份的字节**（逐字节拷进临时目录）⇒ 走的是"今天的读路照旧解释得了它的号洞" |
| 零残留 | 跑前跑后 **111 个条目**逐文件 sha256 一致（**这一批没做部署 / 重启**，线上仍跑旧代码） |

**为什么不当场改真机上那 9 份**：存量迁移**不做**（§二）；而且这一格**不承重**，
没有任何功能依赖它 ⇒ 让它照旧躺着是最省、最不会坏的选择。

---

## 五、没做的 / 待定（明说，不许静默留着）

1. ⚠️ **"明文手机号"这个说法与盘上事实不符 —— 如实记**：这条账（`#74`）的原文是
   "写明文 `by:<sub>`（明文手机号）"。盘上实测（`data/users.json` ＋ 9 份真留痕）：
   `sub` 是 **`users.js` 发的稳定 id**（`owner`／`u1`／`u2`…），`by` 写的是**这个 id**，
   **不是手机号**；手机号只住在 `data/users.json`（0600）。⇒ 本批按**实际泄漏的东西**
   （可枚举的稳定 id）来修；判据 ① 的搜索器**照样**把"手机号形状"当泄漏（合成号
   `13900000000` 只出现在闸脚本与测试的**负向对照**里，**任何真手机号都没进仓库**）。
2. **手册没动，也判定不需要动**（与 `#73` 不同）：`docs/handbook/02-ARCHITECTURE.md`
   第 342 行只说留痕记着"哪一间、哪些号、什么时候、**谁删的**"——**没写口径**；
   `08-SPEC.md` 第 179 行那条 `/api/room-remove` 回执本来就只列 `{scopeId, takenSeqs, items}`
   （盒里那条内部口 `server.js` 也确实是这么回的）⇒ **手册里没有一句现在变成假话**。
   ⇒ 不动 `docs/handbook/**` ⇒ **不需要重建开机清单**（实测 `/etc/hupo/integrity.json` 里
   `docs/dev`／`PROGRESS` **零命中**；本批只碰了 `report` 档的 `src/**`／`scripts/**` 与
   不在清单里的 `test/**`／`docs/dev/**`）。
3. **这一格今天没有生产读取方**（§一）：`readReclaimBy` 是为"将来真读它的那个人"留的
   **唯一读法**，**不是**为了今天某个调用方。⇒ 别把它读成"已经有人拿它判权限了"。
4. **没部署、没重启**：线上（`w.stalkerai.cn` → 本机 `8020`）跑的仍是**旧代码**；
   本批只改仓库 ＋ 本地判据。要生效得走部署那一步（那是主人的签字那一档）。
5. **网关那条路（宿主 `/api/room-remove` 回整条 `record`）今天会把 `by` 原样回给
   用户自己那一侧** —— 值现在是假名，行为未改；客户端也不解释它（§一）。没动协议字段。

---

## 六、文件清单

| 文件 | 改了什么 |
|---|---|
| `v2/services/core/src/reclaim.js` | `reclaimScope()` 多收 `credKey`，`by` 改走 `reclaimByOf()`；新增 `legacyReclaimBy`／`reclaimByOf`／`readReclaimBy`（**小改**） |
| `v2/services/core/src/worlds.js` | `reclaimCtx()` 带上 `credKey: this.#credKey`（**小改**） |
| `v2/services/core/src/apps.js` | `remove()` 里把 `credKey: this.credKey` 显式传给 `reclaimScope()`（**小改**） |
| `v2/services/core/test/reclaim-by-hash.test.js` | 新增（4 条 R1–R4） |
| `v2/services/core/test/app-reclaim.test.js` | S8 那一条断言按新口径改（不再断言明文） |
| `scripts/check-reclaim-by-hash.sh` | 新增（4 条判据，各带负向对照 ＋ 变异实测） |
| `docs/dev/00-PROGRESS.md` | §〇 记一笔；§六 的 `#74` 按规矩**搬走** |
| `docs/dev/PROGRESS-HISTORY.md` | §六 收下 `#74` 那笔（"怎么还的"） |

**未动**：`AGENTS.md` · `v2/apps/mobile/**` · `docs/handbook/**`（理由见 §五.2）·
`scripts/check-index-author-hash.sh` 等**已有那些闸**（一个字节没碰）· 真机数据（只读，零残留）。
