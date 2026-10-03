# 167 · **做一个东西（小程序 / app / 游戏）：有存储就一起做、做完要说完成**（`D4.25` · 2026-10-03 主人定）

> **一句话**：主人在对话里说"帮我做一个小程序 / app / 游戏"这类话时，助手被要求**当场动手造内容**
> （不是只聊方案）· **先判断有没有数据要存**（**默认当有**）· **有就一起把存储做进去**
> （运行时 `/db` 那一格 ＋ 数据格 `<它的目录>/.data/<包>/` 配一份形状声明 `data-shape.json`）·
> 做完**桌面要长出那个图标** · 并**明确告诉他"做完了"**；
> 🔴 **四条里哪一条做不到 ⇒ 当场如实说清是哪一条做不到**（不许假装）。
>
> **依据**：`docs/handbook/05-DECISIONS.md` **D4.25** · 主人 2026-10-03 的要求 ·
> 存储那一侧的机制 [`docs/dev/165-DATA-SHAPE-FORK.md`](165-DATA-SHAPE-FORK.md)（A1）与
> [`docs/dev/166-DATA-CONTRACT.md`](166-DATA-CONTRACT.md)（D1）·
> 做小程序那条路 [`docs/dev/59-USER-APPS.md`](59-USER-APPS.md) · 作业指导书 [`docs/dev/149-APP-DEV-STANDARD.md`](149-APP-DEV-STANDARD.md)。
>
> 🔴 纪律：**阈值/上限只住代码**（本文不写）· **读不出就报 `不可算` 并记失败** ·
> **每条判据都有负向对照** · **不伪造一致**。

---

## 〇、动手前的事实

- 本轮开工时 `git status --short` **干净**；`HEAD = cacda2b`（`D4.24`·D1 收口）。
- **已经就绪的**：`app_create` 那条路（造出来就长在他桌面上，D4.18）·
  A1 的形状声明 `data-shape.json`（`src/data-shape.js`）· D1 的取用侧数据契约（`src/data-namespace.js`）。
- **缺的那一条**：翻遍 `hupo-persona.yml` 与 `app_create` 的描述，**没有一处**回答
  "**用户说要做一个小程序 / app / 游戏时，助手到底该怎么做**" ——
  没有"动手造"的触发规矩、没有"默认有存储、有就一起做"、没有"做完要说完成"的研究。
- **为什么现在补（教训）**：2026-09-24 真机那次，主人要一个"天气小程序"，做出来的是一张
  **存不了数据**的卡片，而且**没先明说**"每天定时抓做不到"就先说了一堆。
  ⇒ 这一条防的正是"**造了但存不了 / 做了但没说清**"。

---

## 一、四条行为落在哪

| 条 | 写在哪 | 判据认的关键字 |
|---|---|---|
| **① 触发** | `v2/services/core/hupo-persona.yml`（"小程序"那一节） | `动手造内容` · `游戏` |
| **② 判断存储** | 同上 ＋ `src/mcp-apps-server.mjs` 的 `app_create` 描述 | `默认就当有` · `一起把存储做进去` · `存不了` |
| **③ 上桌面** | `hupo-persona.yml` | `桌面要长出` |
| **④ 报完成** | `hupo-persona.yml` | `做完明确告诉他` |
| **做不到要当场说清** | `hupo-persona.yml` | `当场如实说清是哪一条做不到` |
| **工具侧：建数据格 ＋ `data-shape.json`** | `mcp-apps-server.mjs`（`app_create` 描述） | `建数据格` · `data-shape.json` · `shapeVersion` · `值一个字节都不许进` · `.data/` · `fail-closed` |

### 1.1 `app_create` 描述里那份形状声明长什么样

```
{"schema":1,"packs":[{"pack":"包名","shapeVersion":"这一包自己的号",
  "keys":[{"name":"列名","type":"string|number|boolean|timestamp|object|array",
           "null":"never|allowed","dedup":true}]}]}
```

- 🔴 **号是这一包形状自己的内容地址**（`sha256(canonical({pack,keys}))` 前 12 位）——
  **别自己瞎填**：用 `src/data-shape.js` 的 `buildDataShape()` 算出来再写
  （判据 `self`：号对不上形状 ⇒ **当场拒**，契约见 `165`）。
- 🔴 **值一个字节都不许进这份文件**（多写 `rows` / `values` / `sample` 这种词 ⇒ 当场拒）；
  值住**数据格** `<它的目录>/.data/<包>/`（不进制品）。
- 🔴 盘上有数据格、而这一版**没有**声明 ⇒ **打包当场拒**（fail-closed）。
- ⚠️ **运行时存取**是另一层：`/db`（每个小程序天生就有一格自己的库，不用声明、不用他点头）——
  两层别混（见 `149` §4.1 与 `147`）。

---

## 二、判据读数

跑法：

```bash
cd v2/services/core && npm test
bash scripts/check-persona.sh
bash scripts/check-data-shape.sh
node scripts/check-docs.mjs
bash scripts/check-app-storage-rule.sh
```

读数（2026-10-03 本机实测）：

- `test/persona.test.js`：新规矩的判据就住在那里（和那 11 条硬规则**同一套写法**）。
- **新闸** `scripts/check-app-storage-rule.sh`：**17/0** —— ①人格四条（8 条读数）·
  ②工具描述（7 条读数）· ③负向对照（删掉规矩 ⇒ ①红）· ④负向对照（删掉描述 ⇒ ②红）。
- `npm test`：**1488/0**（改前 1487；多出来的 1 条就是本批新加的那条人格判据）。
- `check-persona.sh`：**通过**（人格真的进了模型上下文）。
- `check-data-shape.sh`：**8/0**（**一个字节没动**）。
- `node scripts/check-docs.mjs`：**184 份指针都对得上**。

### 2.1 为什么**新开一条**闸（而不是塞进已有那八条）

已有那八条各管一件事：人格"真的进了模型上下文吗"（`check-persona.sh`）·
数据形状随不随 fork（`check-data-shape.sh`）· 数据契约与命名空间（`check-data-contract.sh`）……
**没有一条**问"用户在对话里说要做一个小程序 / app / 游戏时，助手到底被要求怎么动手"。
这一条问的是**行为**那一层（触发 ⇒ 造内容 · 判存储 · 上桌面 · 报完成），
判据、机制、会坏的方式都不一样 ⇒ **新开一条**，老八条**一个字节不动**。

---

## 三、没做到 / 不确定（如实记）

1. **本批是"源码级"判据**：`check-app-storage-rule.sh` 读的是人格文件与工具描述的字面。
   **没有**另起一个真 dsh 来验"这四条真的进了模型上下文"（`check-persona.sh` 只验它已有的那几样）。
   ⇒ "进了上下文"这件事，本批**没验**（如实记）。
2. **人格与工具描述是"指令"，不是硬闸**：模型真照不照做，本批没有端到端验收。
   要变成"硬拦"得另外做产品路（今天没有）。
3. **没有部署 / 没有重启**：线上仍是旧代码（人格与工具描述的改动要下次起服务才生效）。
4. **没有改** `AGENTS.md` · `v2/apps/mobile/**` · 其余八条闸。

---

## 四、需要父 agent 做的

- ⚠️ **手册这次动了**（`docs/handbook/05-DECISIONS.md` ＋ `CHANGELOG.md`）
  —— `docs/handbook/**` 是开机完整性的 **`strict`** 条目
  ⇒ **要重建 `/etc/hupo/integrity.json`**，否则**下次重启拒绝启动**。
  本批**没有自己重建**（那要 root 口令）⇒ **需要父 agent 重建**。
- （可选）要让它**线上生效**，得部署 / 重启 `hupo-core`；本批**没做**。
