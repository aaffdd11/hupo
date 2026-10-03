# 163 · 共享库 `index.json` 的作者假名换成带键 HMAC（D4.24 · B1／A3·补·二）

> **一句话**：共享库里那一格 `authorHash` 原来是 **`sha256(sub)` 的前 12 位**（裸 sha256 截断），
> 而 `sub` 可枚举（`owner`／`u1`／`u2`…）⇒ **能穷举反推** ⇒ 与 **B1「真身份不给」** 冲突
> （账本 `#73`）。现在换成 `cred-hash.js` 那套 **带键 HMAC**（**同一把键、同一个域**
> `hupo-cred-v1`）—— 与审计账里那个凭据哈希**同一个函数**。
>
> 🔴 **这一格承重**（重名判 / 下架判 / 发现页"哪条是我发的"）⇒ **不许**直接换口径
> （存量 `index.json` 里写的是旧值）⇒ 改法是 **"读得出老值、只写新值"**：
> 读走 `readAuthorHash`（新旧都认，认不出一律 **fail-closed**），写永远走 `authorHashOf`（新口径）。
>
> **口径是拍过板的，不是本文设计的**：`docs/handbook/05-DECISIONS.md` **D4.24** 的 **B1**
> （2026-10-03 定，签字页 [`161-OWNER-DECISIONS-11.md`](161-OWNER-DECISIONS-11.md)）；
> 原始问题与"【要建】"那一格在 [`90-APP-CONTRACT.md`](90-APP-CONTRACT.md) 的 **§5.4 / Q5.4**；
> 上一批（入口 URL 与审计）见 [`162-ENTRY-IDENTITY.md`](162-ENTRY-IDENTITY.md)。
>
> 🔴 纪律：**不写数值** · 读不出就报 **`不可算`** 并记失败 · **每条判据都要有负向对照**
> （变异实测过，见 §三）· **存量值一个字节不改**。

---

## 〇、先钉口径（照拍板的原话，不重新设计）

- **D4.24 · B1**：署名 = **可换可弃的假名** ＋ 血缘公开可查 ＋ **真身份不给**。
- **`#73`**（[`00-PROGRESS.md`](00-PROGRESS.md) §六）：*"`index.json` 里 `authorHash=sha256(sub)[:12]`
  可被枚举反推 —— 与 `D4.24` B1（真身份不给）冲突；修法很清楚：换成 `cred-hash.js` 那套带键
  HMAC（同一个口径已经有实现）"*。
- **`90-APP-CONTRACT.md` · Q5.4**（要建的判据）：*"给定一个公开署名与一个 `sub` 猜测集，**算不出**凭据"*。

⇒ 本批只落这一件：**把那一格的口径换掉**。**没有**顺手改 `authorName` 里其它东西、
也没有动 `reclaim.js` 的明文 `by:<sub>`（那是 **`#74`**，另一笔账）。

---

## 一、它今天被谁用、**承不承重**（改法由这一条决定）

改动前的读数（`cd v2/services/core && grep -rn "authorHash" src/ test/`）：

| 用处 | 证据（改动前） | 承重吗 |
|---|---|---|
| **发布时的重名判**（"这个名字被别人用了"） | `src/published.js` `publish()`：`if (prev && prev.authorHash !== authorHash)` | 🔴 **承重**（判"这是谁的东西"） |
| **下架时的"这一条不是你发的"** | `src/published.js` `unpublish()`：`prev.authorHash !== authorHashOf(authorSub)` | 🔴 **承重**（权限） |
| **发现页"哪条是我发的"** | `src/apps-socket.js` 的 `me:` ＋ `src/mcp-apps-server.mjs` 的 `fromOthers`（`a.authorHash !== r.me`） | 🔴 **承重**（工具据此把"别人的"念给他） |
| **对外昵称**（`用户 xxxx`，会写进 `index.json`） | `src/worlds.js`：`用户 ${authorHashOf(userId).slice(0,4)}` | 只展示，但它**是旧口径推出来的** ⇒ 同样可反推 ⇒ 一起换 |
| HTTP 出参里剥掉它 | `src/server.js`：`list.map(({ authorHash, ...rest }) => rest)` | 不读值 |
| 人格 key（`delivery.js`） | `personaKeyOf(owner)` **复用同一个函数**（今天没有调用方） | 不读 `index.json` |

⇒ **结论：承重。** 所以**不能**"直接把口径换掉就完事" —— 真机上就有一份**旧值**在架
（见 §四），换掉之后那份老条目会变成**没人认领**。

---

## 二、改法（含：**存量怎么保平安**）

**"读得出老值、只写新值"** —— 三样东西分开：

| 名字 | 是什么 | 谁用 |
|---|---|---|
| `authorHashOf(sub, key)` | **当前口径** = `credHashOf(sub, key)`（带键 HMAC，域 `hupo-cred-v1`） | **所有写**（发布时写进 `index.json`、审计、昵称） |
| `legacyAuthorHashOf(sub)` | **旧口径（只读）** = `sha256(sub)[:12]` | 只用来**读**存量 |
| `readAuthorHash(stored, sub, key)` | 读一格：`'cred'`／`'legacy'`／**`null`（读不出来）** | publish 的重名判 · unpublish 的归属判 · discover 的 `mine` |

🔴 **`null` 一律 fail-closed**：既不是新口径写的、也不是旧口径写的 ⇒ 当"**不是他写的**"，
**绝不许**落到"那就是别人"。换一把键时，同一个人的**新值**也读不出来 —— 那正是"换键就换值"。

改了哪些行为：

- `publish()`：重名判改走 `readAuthorHash(...) === null`；写下去的 `authorHash` 是新口径。
- `unpublish()`：归属判改走 `readAuthorHash(...) === null`。
- `discover({sub, key})`：**多收一个可选的"这是谁"**，给了就顺带判出每一格的 **`mine`**
  （走 `readAuthorHash` —— **不许**拿两个哈希直接比：存量那条会被**误判成"别人发的"**）。
  不给 ⇒ 形状与以前**一字不差**（不多那一格）。
- `apps-socket.js`：`ctx` 多接一把 `credKey`（`worlds.js` 给的）；`discover` 把 `sub`／`key` 传下去。
- `mcp-apps-server.mjs`：优先按服务端判好的 `mine` 分"别人的"；老服务端没给这一格时才退回比哈希。
- `worlds.js`：对外昵称改用**同一把键**（`authorHashOf(t.userId, this.#credKey)`）。

**存量保平安的方式（明说，二选一里的哪个）**：选的是 **"读得出老值、只写新值"**
（不是"一次性迁移存量文件"）。理由：① 那一格**承重**，一次性迁移要写脚本去动**所有人共享**的目录
（发布路径是它**唯一**的写入者，第二条写路会被 `check-outbound-bridge.sh` 那条判据扫出来）；
② "只写新值"不需要**任何**停机/批处理：老条目本人照样撤得下来、上新版，别人照样拦得住。

---

## 三、判据与读数（每条都有负向对照；变异实测过）

新闸：[`scripts/check-index-author-hash.sh`](../../scripts/check-index-author-hash.sh)（`通过 4 · 失败 0`）。

| # | 判据 | 负向对照 | 读数 |
|---|---|---|---|
| ① | 新写入的 `index.json` 里搜不到**旧口径的值**、搜不到**旧昵称**、搜不到**身份明文** | 同三个搜索器喂一条"旧口径＋明文"的样本必须抓得住 | ✓ 零命中；口径 = `credHashOf(sub, 键)`（64 位十六进制） |
| ② | 同一身份**稳定**（两次发布同一个值）；**两个人不撞**；**换键就换值**；不是裸 sha256、也不是退化键 | **换一个 `sub` ⇒ 值必须变**；**换一把键 ⇒ 值必须变** | ✓ `993ae0de…` vs `bd8ef92c…` |
| ③ | **存量照旧**：拿**真机那一份** `index.json` 走"**本人撤下 → 上架 → 装上 → 打开**" ⇒ 全程通 | 别人同名上架／别人下架 ⇒ 拒；**把新写的值当老值读 ⇒ 走"读不出来"分支**（`null`），不许误判成别人 | ✓ 打开 **200**（真 HTTP 那条路） |
| ④ | **零残留**：真机 `published-apps/` 跑前跑后**逐文件 sha256 一致**（这条闸全程只读） | 改动一个字节 ⇒ 指纹必须变（证明不是恒等空转） | ✓ **6 个条目不变** |

**变异实测**（证明闸不是空转的；跑完逐字节还原，`sha256sum -c` OK）：

| 把代码改回… | 闸的反应 |
|---|---|
| `authorHashOf` 退回**裸 sha256 前 12 位**（= 改前那一行） | **①②③ 红**，④ 照旧绿（④ 管的是残留，不是口径） |
| `unpublish` 的归属判退回**直接比哈希**（读不出老值） | **③ 红**，读数 `legacyOwnerUnpub=false` |

> ⚠️ 第二条变异是第一版闸**没抓住**的：那时 ③ 只在"已经用新口径重写过之后"才测本人下架 ⇒
> 存量**本人撤下**那条路没人打。补上"上架**之前**先让本人撤一次"之后才红得起来。

单测：`v2/services/core/test/published-author-hash.test.js` **7 条**（同上四组 ＋ 只读不动存量 ＋ 接线源码判据）。

---

## 四、真机上那份**存量**（这一批必须照旧能用）

实测（只读）：

| 项 | 读数 |
|---|---|
| 目录 | `v2/services/core/data/published-apps/`（`HUPO_DATA` 指的就是它） |
| 在架制品 | **一件**：`coin`（掷硬币）；`index.json` 的 `authorHash` = `4c1029697ee3` = `sha256("owner")[:12]`；`authorName` = `用户 4c10` |
| 审计 | `published-apps/audit.jsonl` 第 1 行也是 `"authorHash":"4c1029697ee3"`（**旧行，不改写**） |
| 流水 | `coin/versions/1/index.html` |

闸里那条 ③ 用的就是**真机那一份的字节**（逐字节拷进临时目录当夹具）⇒ 走的是
"本人先撤下（旧值读得出）→ 再上架（写新值）→ 乙装上 → 乙打开（200）"。

**为什么不直接拿真机那份改**：发布路径是共享库**唯一**的写入者，而这一批**不做部署/重启**
（线上仍跑旧代码）⇒ 真机上**只读**；零残留那条判据就是把这件事量出来。

**顺带核过的一条**（免得留隐患）：`delivery.js` 的 `personaKeyOf` 复用的就是这个函数 ⇒ 它的值
**跟着口径一起变**。实测真机上 `delivery/*` 记录 **0 条**（`grep -rho "delivery/[a-z]*"` 全仓 `*.jsonl` 零命中）
⇒ **没有存量可伤**；今天它也没有生产调用方。

---

## 五、没做的 / 待定（明说，不许静默留着）

1. 🔴 **手册里有一句现在与代码不一致**：`docs/handbook/05-DECISIONS.md` **D4.16** 写着
   *"共享库里**不存作者身份**（只存 `sha256(sub)` 前 12 位；对外只给昵称）"*
   （〔`CHANGELOG.md`](../handbook/CHANGELOG.md) 里也有一句同款）。
   **本批没有动手册**：`docs/handbook/**` 是开机完整性的 **`strict`** 条目
   （实测 `/etc/hupo/integrity.json` 里 10 条 strict 全在手册／`AGENTS.md`／人格里），
   改了就要**主人重建清单**，否则下次重启**拒绝启动** ⇒ 按硬约束"不自己重建"，
   留给主人一句话决定（改口径升版 ＋ 重建）。
2. `docs/dev/90-APP-CONTRACT.md` 的 **§5.4 / Q5.4** 等行写的是**当时的盘上事实**（旧口径）
   —— 它是**证据**，不回去改；本批正是把 Q5.4「【要建】」那一格建起来。
3. **`#74`**（`reclaim.js` 往 `reclaimed.json` 写明文 `by:<sub>`）**仍在账上**，本批没碰。
4. **没有部署、没有重启**：线上（`w.stalkerai.cn` → 本机 `8020`）跑的仍是**旧代码**；
   本批只改仓库 ＋ 本地判据。⇒ 要生效得走部署那一步（那是主人的签字那一档）。
5. `delivery` 的 persona key **没有接生产那把键**（今天无调用方）⇒ 它落的是退化键的值；
   将来真要用它时，接线要想存量迁移（与 `#74` 同族）。

**要不要重建开机清单**：**不需要**（实测，不是推测）—— `/etc/hupo/integrity.json` 里
`v2/services/core/src/**` 与 `scripts/**` 全是 **`report`**（只报不拦），`docs/dev/**` 与
`v2/services/core/test/**` **根本不在清单里**；本批**没碰**任何 `strict` 条目（手册／`AGENTS.md`／人格／`cordis*.yml`）。

---

## 六、文件清单

| 文件 | 改了什么 |
|---|---|
| `v2/services/core/src/published.js` | `authorHashOf(sub, key)` 换新口径；新增 `legacyAuthorHashOf`／`readAuthorHash`；`publish`／`unpublish` 改走 `readAuthorHash`；`discover({sub,key})` 多判 `mine` |
| `v2/services/core/src/apps-socket.js` | `ctx.credKey` 接进来；`discover` 把"这是谁"传下去；`me` 同键 |
| `v2/services/core/src/mcp-apps-server.mjs` | 工具侧按 `mine` 分"别人发的"（老形状退回比哈希） |
| `v2/services/core/src/worlds.js` | app 口那条 `ctx` 带 `credKey`；对外昵称改用同一把键 |
| `v2/services/core/src/delivery.js` | 只改注释（点明 `personaKeyOf` 现在也是带键口径、这一处没接生产键） |
| `v2/services/core/test/published-author-hash.test.js` | 新增（7 条） |
| `scripts/check-index-author-hash.sh` | 新增（4 条判据，各带负向对照） |
| `docs/dev/00-PROGRESS.md` | §〇 记一笔；§六 的 `#73` 按规矩**搬走** |
| `docs/dev/PROGRESS-HISTORY.md` | §六 收下 `#73` 那笔（"怎么还的"） |

**未动**：`AGENTS.md` · `v2/apps/mobile/**` · 现存四条 `check-*.sh` · `docs/handbook/**`（理由见 §五.1）。
