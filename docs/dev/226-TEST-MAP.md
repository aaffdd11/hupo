# 226 · 测试映射与文件隔离树（**改动 → 跑哪些测试 / 不必跑哪些**）

> **主人 2026-10-09 的指令**（原话）：
> *「我们接下来跑测试，不能跑那么多测试了。我们需要做一个 mapping，哪些功能改动，
> 需要做哪些测试，不需要做哪些测试。」* ＋ 同一天定的 3.0 核心三件：
> **① agent 提示词（更精确）② 语音（真正好用）③ agent 对小程序的设计规范**。
>
> ⇒ **工具**：[`scripts/test-map.mjs`](../../scripts/test-map.mjs)（现算依赖图）
> ＋ [`scripts/gate-quick.sh`](../../scripts/gate-quick.sh)（薄壳：挑 → 跑）。
> **映射只有一处** —— 要改挑法就改那个 `.mjs`，**不许在别处再写一份 case**。

---

## 一、怎么用（三条命令）

```bash
# ① 我改了这些文件，该跑什么？（只列，不跑）
bash scripts/gate-quick.sh --list <改动的路径…>
# ② 真正跑（就是上面挑出来的那几条）
bash scripts/gate-quick.sh <改动的路径…>
# ③ 看全貌：隔离树 / 某个文件 / 某份测试为什么被选中
node scripts/test-map.mjs --tree
node scripts/test-map.mjs --file v2/services/core/src/app-lint.js
node scripts/test-map.mjs --why v2/services/core/test/persona.test.js
```

**实测四条**（2026-10-09 现跑）：

| 改什么 | 挑出来几条 |
|---|---|
| `src/app-lint.js`（小程序规范） | **1 条**：`test/app-lint.test.js` |
| `src/asr-doubao.js`（语音上游协议） | **3 条**：`asr-doubao` · `asr-probe` · `asr` |
| `hupo-persona.yml`（提示词） | **2 条**：`check-persona.sh` ＋ `test/persona.test.js` |
| 一条**认不出**的路径 | **退回全闸**（退出码 3，并点名那一条） |

---

## 二、它凭什么敢说"这些不用跑"

🔴 **可达性，不是"挑几个跑跑看"**：

1. 先把每个测试文件**真正够得到的本地文件**算出来 —— 三种边：
   ① `import / export from / require`；② Dart 的 `package:hupo_app/…` 与相对 `import`；
   ③ 测试里**像路径的字符串字面量**（`readFileSync('../../docs/…')` 这类文本读文件）。
2. 再按**距离**分层：
   - **距离 1** ＝ 这个测试**直接** import 了它 ⇒ **必跑**；
   - **距离 ≥2** ＝ 要走中间模块才够得到 ⇒ 记为"**可能**"（**只报数，不出命令**）。
3. 改了某个文件 ⇒ 只有"够得到它的测试"可能被它弄坏。**够不到的，理论上不可能。**

**为什么"可能"那一层不算必跑 —— 这是刻意的取舍，不是偷懒**：

> 本仓库服务端的测试**几乎都 `import server.js`**，而 `server.js` 又 import 了一大片
> ⇒ **传递闭包会退化成"几乎全跑"**（实测：闭包口径下改 `app-lint.js` 会选中 **85 份**；
> 分层之后只跑 **1 份**）。这不是测试写得脏，而是"调度器是一个整体"这件事在依赖图上的样子。
>
> ⇒ **"少跑"的边界只能是过程上的**：
> · **改动中**跑距离 1 那些（秒级~十几秒）；
> · **收尾**跑全闸（[`scripts/gate-server.sh`](../../scripts/gate-server.sh) ·
>   [`scripts/check-client.sh`](../../scripts/check-client.sh)）—— **它才是"可能那一层"的兜底**。
> 🔴 **绝不把改动中当收尾**：那等于拿"页面在说假话"换速度（契约
> [`dev/213-GATES-CHEAPER.md`](213-GATES-CHEAPER.md)）。

---

## 三、文件隔离树（现跑读数；**会变，别抄死**）

跑 `node scripts/test-map.mjs --tree`。它给的是**每个区往里 / 往外粘得紧不紧**：

| 区 | 往外依赖 | 读法 |
|---|---|---|
| `client:models` | **不出区 —— 完全隔离** | 纯逻辑层，改它只跑它自己的判据（最便宜的一块） |
| `server:identity` | **不出区 —— 完全隔离** | 凭据/鉴权那一族 |
| `server:ledger` · `server:media` · `server:voice` · `server:supply` · `server:jobs` | 各只往外一两个区 | 基本隔离，改动的面小 |
| `client:services` · `client:widgets` · `client:screens` | 大量指向 `client:models` | 单向：**models 是它们的地基**（改 models 要跑一大片） |
| `server:core`（64 个文件） | 指向 apps / identity / supply / ledger | **最粘的一块**：`server.js` 是所有测试的入口 |
| `server:apps`（22 个文件） | 少量指向 core / identity | 相对隔离 |

**全库枢纽**（改它们"必跑"的面最大 —— 现跑前几名）：
`lib/services/api.dart` · `lib/services/chat_controller.dart` · `lib/services/token_store.dart` ·
`src/apps.js` · `src/auth.js` · `src/server.js`。

⇒ **这就是"文件隔离树"要告诉你的那件事**：**要少跑测试，先看这个文件在不在枢纽上。**
枢纽上动一刀，收尾那一趟全闸就不能省；叶子上的改动，天天只跑它那一两条。

---

## 四、3.0 那三件核心改动，各自该跑什么

| 3.0 核心 | 改哪几处 | 窄闸会挑出什么 |
|---|---|---|
| **① agent 提示词（更精确）** | `v2/services/core/hupo-persona.yml`（`strict`）· 必要时 `session-translate.js` 的话术 · `work-words.js` / `notice.js` | `bash scripts/check-persona.sh` ＋ `test/persona.test.js`；⚠️ **人格是 `strict`** ⇒ 收尾要**重建开机清单**（[`dev/225`](225-V3-HANDBOOK-PLAN.md) §四） |
| **② 语音（真正好用）** | 服务端 `src/asr.js` · `src/asr-doubao.js` · `src/asr-creds.js`；客户端 `lib/services/hearing*.dart` · `lib/models/hearing_session.dart` · `lib/models/pcm16.dart` · `lib/widgets/voice_bar.dart` | 服务端 `asr*` 三份；客户端 `flutter analyze` ＋ `hearing_session` / `voice_*` 那几个 `_test`；⚠️ **语音那条链在盒子里跑** ⇒ 改服务端那半要发产品层（[`dev/216`](216-SENTENCE-SPLIT-LOSS.md) §二·补5） |
| **③ agent 对小程序的设计规范** | `src/app-lint.js`（制品自查）· `src/hupo-app-agent.yml`（限定档）· 作业指导书本身（`handbook-v3/09-APPS.md` §七） | `test/app-lint.test.js`（**1 条**）· 改了 yml ⇒ `npm test`；⚠️ `hupo-app-agent.yml` 是 `strict`（改它能给自己加手） |

---

## 五、它**不**保证什么（**如实说**，这一节最重要）

1. **只认那三种边。** 认不出的边 ⇒ 那个测试**不会**被选中 ⇒ **漏跑**。
2. 🔴 **认不出的改动路径一律退回全闸**（`gate-quick.sh` 退出码 **3** 并点名），**绝不悄悄放过**。
3. **309 / 552 个文件"任何测试都够不到"**（现跑）—— 改它们时映射会**照实说"一条都没有"**。
   那是**实话**，不是"过了"：那一栏里的东西**今天根本没有判据**。
4. **它不管"测试跑不跑得过"**，也不保证"改了之后新加的测试"—— 新测试一落盘就进图（**现算**），这条自动成立。
5. **它不是收尾**：收尾仍要全闸。它买的只是"改动中"那段时间。
6. ⚠️ **它不替 `strict` 那一层**：改了人格 / `AGENTS.md` / `docs/handbook*/**` ⇒ 还要**重建开机清单**。

---

## 六、为什么它不落成一张死表

**上一版 `gate-quick.sh` 是手写 `case`**（`src/x.js` ⇒ `test/x.test.js`），两个毛病：
① 同名约定不成立时**退回全闸**（正是要消掉的那件事）；② 表会**漂**（新文件没人补）。

⇒ 这一版**每次现算**：解析 552 个文件、1776 条边、282 份测试，**毫秒级**。
新增一个源文件 / 一份测试，**下一次调用就自动进图**，不需要任何人改表。
（这也是 `docs/CHANGE-MAP.md` §四那条纪律的形状：**卡 ≠ 判据；能现算的就别写死**。）
