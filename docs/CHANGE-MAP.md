# 改动速查卡 · 要改什么 → 碰哪几个文件 → 跑哪条闸

> **这一份只做一件事**：把"我要改个小东西"翻成"打开哪几个文件、跑哪几条命令"。
> 它由 [`INDEX.md`](INDEX.md) 指过来。
> **走了这张卡，就不必读手册全篇**，也不必翻 `dev/` 里那一百多篇
> —— 那些是"凭什么"的证据层，**只在下面某一格点了名的时候才打开**。
>
> ⚠️ **卡上不许有状态、条数、读数。** 一旦写"现在有多少"，它当天就开始漂
> —— 和 `INDEX.md` 同一条纪律（`scripts/check-docs.mjs` 会把这份也一起扫）。
> 卡上只许有三样：**路径 · 命令 · 边界**。
>
> ⚠️ **它不是手册的替代品。** 判据是一句话：
> **这次改动会不会改变"别人依赖的形状"？**
> 不会 ⇒ 走卡；会（协议、人格、`strict` 文件、线上、小程序沙箱）⇒ 停下来读手册（§三）。

---

## 一、闸分两层：**改动中跑窄的，收尾跑全的**

| 改在哪 | 改动中（窄 · 快） | 收尾（全 · **一件都不许省**） |
|---|---|---|
| **任意改动** | `bash scripts/gate-quick.sh <改动的路径…>`（**先 `--list` 只看不跑**）—— 映射**现算**，唯一出处 [`scripts/test-map.mjs`](../scripts/test-map.mjs) | 见下面那张表的分区 |
| 服务端 | 它自己会挑出该跑的那几份 `node --test` | `cd v2/services/core && npm test` ＋ `npm run demo` |
| 客户端 | 它自己会挑出 `flutter analyze` ＋ 对应那几份 `flutter test` | `bash scripts/check-client.sh` |
| 文档 | 它自己会挑出 `node scripts/check-docs.mjs` | 同左（它本来就快） |
| 碰了界面 | 上面那条窄的 | ⚠️ **另加浏览器那条路**：`HUPO_TOKEN=<现发> node scripts/check-web-browser.mjs --shot <图>` |

> 🔴 **它就是"改哪块跑哪条"的映射本身**：改了哪个文件 ⇒ 只有**够得到它的测试**才跑
> （依赖图上的可达性，不是"挑几个跑跑看"）。认不出的路径它**当场退回全闸**（退出码 3）。
> **"改动 → 测试"的完整口径、隔离树、以及它**不**保证什么**：见 [`dev/226-TEST-MAP.md`](dev/226-TEST-MAP.md)。

⚠️ **窄闸只买"改动中"那段时间，它不替收尾。**
收尾四件（两边的硬闸 / 能部署的部署掉 / 文档与账对上 / 推上去 ＋ 给主人一份总结）
是 `AGENTS.md` §五定的顺序，**一件都不能省**。窄闸绿 ≠ 收尾完成。

⚠️ **`test/widget` 里只有一份是硬闸**（`accessibility_test.dart`，决策 `D3.5`），
其余是提示档 —— 但 `check-client.sh` **扫目录**，所以新加的那一份会自己进闸，不必手改脚本。

⚠️ **改了客户端就必须部署**（`scripts/deploy-web-v2.sh`），否则 `w.` 那个站点不会变。

---

## 二、按"我要改什么"找落点

> 一格一行。**先打开第二列那一个文件**；第三列是"改完顺手要看的闸"；
> 第四列**只在有人问"凭什么"时才读**。

| 我要改什么 | 先打开 | 顺手的闸 | 凭什么（按需） |
|---|---|---|---|
| **全站那套暖白纸的底**（首页 / 登录 / 设置那几屏）的颜色、圆角、间距 | `v2/apps/mobile/lib/models/design.dart` | `test/unit/design_tokens_test.dart`（棘轮：只紧不松） | [`dev/49-STYLE.md`](dev/49-STYLE.md) |
| **聊天窗口**的配色 / 字号 / 行高 / 间距 | `lib/models/dsh_design.dart` | `test/unit/dsh_design_test.dart` | [`dev/119-APPEARANCE-AND-FONT.md`](dev/119-APPEARANCE-AND-FONT.md) |
| **某一屏上说的那句话** | `lib/models/<那一屏>_words.dart`（各屏一份；没有就找 `about_facts.dart`） | `test/unit/forbidden_words_test.dart`（内部词不许上界面）· `test/unit/space_test.dart`（不许假进度） | [`dev/56-PLAIN.md`](dev/56-PLAIN.md) |
| **`models` 层谁 import 谁** | 那一份 model | `test/unit/import_rules_test.dart`（楼层闸：models 不许 import material） | [`handbook/03-DEVELOPMENT.md`](handbook/03-DEVELOPMENT.md) §二 |
| **一个永不结束的动画** | `lib/models/motion_switch.dart`（总开关；**关它的地方只有一处**） | `test/widget/rec_pulse_test.dart` | [`dev/133-REC-BUTTON-AND-SEND.md`](dev/133-REC-BUTTON-AND-SEND.md) |
| **服务端一条口的行为** | `v2/services/core/src/server.js` | 那一份 `test/<名>.test.js` | [`handbook/03-DEVELOPMENT.md`](handbook/03-DEVELOPMENT.md) §五（接口契约） |
| **轮的序号 / 收口 / 升格** | `src/dispatcher.js` | `test/harness-process.test.js` | [`handbook/03-DEVELOPMENT.md`](handbook/03-DEVELOPMENT.md) §5.3 ⚠️ **根因不明显，先读它再改** |
| **失败时跟他说哪句话** | 说话的那一处 | 那一份测试 | [`dev/62-FAILURE-CLASSES.md`](dev/62-FAILURE-CLASSES.md) |
| **小程序沙箱 / CSP / 那两条窄口** | `src/app-serve.js` · `src/apps-socket.js` | `test/app-lint.test.js` | [`dev/147-APP-SQLITE.md`](dev/147-APP-SQLITE.md) · [`dev/148-APP-FULL-SET.md`](dev/148-APP-FULL-SET.md) · [`dev/150-APP-FULLBLEED.md`](dev/150-APP-FULLBLEED.md) |
| **加一个小程序图标** | [`dev/70-APP-ICONS.md`](dev/70-APP-ICONS.md) 里点名的那两处 | `test/unit/app_icon_test.dart` | [`dev/70-APP-ICONS.md`](dev/70-APP-ICONS.md)（唯一出处） |
| **给做小程序的 agent 的规矩** | `src/app-lint.js` | `test/app-lint.test.js` | [`dev/149-APP-DEV-STANDARD.md`](dev/149-APP-DEV-STANDARD.md) |
| **人格** ⚠️ **strict** | `v2/services/core/hupo-persona.yml` | `bash scripts/check-persona.sh` | [`dev/09-PERSONA.md`](dev/09-PERSONA.md) · [`dev/97-PERSONA-V0.md`](dev/97-PERSONA-V0.md) |
| **加一样小程序能力 / 改沙箱边界** | ⚠️ **先读手册再动手**，别直接改 | — | [`dev/146-MINIAPP-REDESIGN.md`](dev/146-MINIAPP-REDESIGN.md) |
| **一条协议事件 / 一个 wire token** ⚠️ **冻结** | **先看它落在哪**：`scripts/where.sh 'message/text'`（服务端 / 客户端 / 文档 / 测试分组列出来） | 两边一起改 ＋ 补判据 | [`handbook/03-DEVELOPMENT.md`](handbook/03-DEVELOPMENT.md) §三 · [`handbook/08-SPEC.md`](handbook/08-SPEC.md) |

**找不到对应的一格 ⇒ 加一格，而不是回去通读手册。**（怎么加见 §四）

> ⚠️ **协议这一格为什么要先跑 `where.sh`**：2026-10-01 实测，一条事件**平均散在 45–90 个文件**里
> （`message/text` 落在 **73 个文件 / 168 处**：服务端 67 · 客户端 59 · 文档 30）。
> 手册里**没有**"它落在哪"这张表，所以每次都要重新考古 —— 这就是"小改动也要长时间阅读"的一个大头。
>
> ⚠️ **为什么没有"协议两边一致"的自动闸**（我试过，故意没做）：
> 静态提取抓不全**发点**（事件名有 `type:` 赋值、模板串、常量、共用 helper 多种写法）
> ⇒ 拿它判红会**误报**（实测把 `turn/start` 这种服务端明明在发的事件判成"客户端单方认的"）。
> **会撒谎的闸比没有闸更坏**（`scripts/check-docs.mjs` 的头注就是这么写的）——
> 所以这一格给的是**查落点的工具**，不是判据。

---

## 三、这张卡**不管用**的时候（这几样必须先读手册）

| 你要动 | 先读 |
|---|---|
| **协议字段**（一旦上线就冻结） | [`handbook/03-DEVELOPMENT.md`](handbook/03-DEVELOPMENT.md) §三 · [`handbook/08-SPEC.md`](handbook/08-SPEC.md) |
| **人格 · `AGENTS.md` · `docs/handbook/**` · `~/.dsh/profiles/*/cordis*.yml`** ⚠️ **`strict`** | [`handbook/06-OPERATIONS.md`](handbook/06-OPERATIONS.md)。改完**要请主人补一条重建命令**（命令照 `verify-integrity.mjs` 打出来的那条粘），并在 [`dev/00-PROGRESS.md`](dev/00-PROGRESS.md) 留一行痕 |
| **线上**（部署 / 重启 / 租户盒子 / 供给） | [`handbook/06-OPERATIONS.md`](handbook/06-OPERATIONS.md) · [`handbook/08-SPEC.md`](handbook/08-SPEC.md) §九 |
| **"这地方怎么这么怪"** | [`handbook/07-APPENDIX.md`](handbook/07-APPENDIX.md)（缺陷清单 / 术语 / 评审史） |
| **要判"做完了没有"** | [`handbook/08-SPEC.md`](handbook/08-SPEC.md)（判据总表） |

---

## 四、这张卡自己怎么不漂

| 纪律 | 为什么 |
|---|---|
| **只写路径 · 命令 · 边界**，不写状态与读数 | 数值写进来的那天就开始过期（`AGENTS.md` 纪律一） |
| **一格指到的文档改名 / 挪家 ⇒ 文档闸变红** | 这份在 `scripts/check-docs.mjs` 的棘轮名单里，出生就进 |
| **改完顺手补一格**，超了就拆 | 卡一长就没人查表了 —— 而"没人查表"正是当初每次都要通读的起点 |
| **卡 ≠ 判据** | 判据只住在 `handbook/08-SPEC.md` 与 `test/`；卡只负责**把人领到门口** |
