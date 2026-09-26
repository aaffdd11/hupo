# 122 · 过程**两档**（四档 ⇒ 两档：砍掉「安静」与「步骤流水」）

> **主人 2026-09-26 的裁决（逐字）**：
> *「**名不副实的要去掉**。」*
>
> 这句话是对下面这份分析的回复，**他看过后批准了删除**。
> 这一份是那一刀的**契约**：砍了哪两档、各为什么、保留的两档各是什么、
> **wire 协议怎么处理**、老设备怎么迁移、`step/*` 今天的处境、判据。
>
> 上一版四档的契约是 [`26-PROCESS-LEVELS.md`](26-PROCESS-LEVELS.md)
> （**那一份是历史，别照着它写代码**；它顶上有一条指向本页的更正）。
> 决策原文在 [`05-DECISIONS.md`](../handbook/05-DECISIONS.md) `D7` / `D7·补`。

---

## 〇、一句话

**菜单上只摆两档**：**在做什么**（默认）与**它心里想的**（推理原文）。
另外两档 —— **安静**、**步骤流水** —— **做不到它们名字承诺的事**（§一逐条），
所以从菜单上**去掉**。

🔴 **去掉的是"入口"，不是"协议"**：`?level=quiet|doing|steps|reasoning`
四个 wire token **一个都没改**（§二），服务端那一侧的语义**一个字没动**（§四）。

---

## 一、砍了哪两档、各为什么；留下哪两档、各是什么

| 档 | 名字承诺什么 | 重做之后实际是什么 | 裁决 |
|---|---|---|---|
| **步骤流水** | "一步一步的流水" | **工具行**（`tool/call`：名字 · 人话标题 · 成败 · 展开看入参输出，而且**落盘、切回来还在**）已经把同一件事说得**更准更全** ⇒ 这一档只剩**再多一串粗粒度、而且瞬态（切走就没）的重复行** | ❌ **砍** |
| **安静** | "安静" | 它**只掐掉「它正在做…」那一行**；**工具行不受档位管**（不在服务端的 `PROCESS_TYPES` 里）⇒ 想安静的人**照样看到一串工具行** —— 它做不到它名字说的事 | ❌ **砍** |
| **在做什么** ✅ 默认 | "顺口说一句它正在忙什么" | 一句人话；**屏幕上什么都没有时，它是唯一的"它在动"信号** | ✅ **留** |
| **它心里想的** | "连它还没说出口的那些也给你看" | 推理原文；🔴 **只有这一档服务端才发它** —— 那是隐私闸 `D7.4` | ✅ **留** |

⚠️ **`D7.4` 一条都没有松**：推理原文**只有 `reasoning` 档**才由服务端发出来
（`server.js` 的 `LEVEL_EXTRA_TYPES.reasoning` 才带 `reasoning/delta`）。
**这道闸绝不能挪到客户端判** —— 客户端只是"不显示"，服务端才是"不发"。

---

## 二、协议冻结：四个 token 一个都不许改

`?level=quiet|doing|steps|reasoning` 是**已上线的协议字段**
（手册维护纪律 2：一经上线即冻结）。老客户端还在跑，所以：

| 谁 | 做什么 |
|---|---|
| **服务端** | **一个字不改**：四个 token 照旧认（`PROCESS_LEVELS`）、`quiet`/`steps`/`reasoning` 照旧按那张累加表发（`LEVEL_EXTRA_TYPES`） |
| **新客户端** | **不再发** `quiet` / `steps` —— 这两个入口没了，枚举里也没有它们 |
| **wire 名单** | 客户端 `models/process_levels.dart` 的 `processLevelWires` 把四个 token **显式冻结**在那里（判据钉它逐字） |

> **"不带 = doing"** 这条老规矩也不动（老服务端只认它）。
> 新客户端**永远带上** `level`，只是只会带 `doing` / `reasoning` 两个字面量之一。

---

## 三、客户端落点

| 层 | 改了什么 |
|---|---|
| `models/process_levels.dart` | `ProcessLevel` 只剩 `doing` / `reasoning`；新增 `processLevelWires`（冻结的四个 token）与 `retiredProcessLevelWires`（砍掉的两个）；`processLevelOf()` 把砍掉的两个**归一**到默认档 |
| `widgets/process_level_menu.dart` | 只摆 `ProcessLevel.values`（今天**恰好两项**）；砍掉的**一个都不出现** |
| `widgets/process_view.dart` | `ProcessTail` 只画那行「它正在做…」；**步骤那一串行与 `_StepLine` 删掉** |
| `services/chat_controller.dart` | `agentLine` 不再按档位掐（没有安静档了）；`steps` 那个 getter 删掉；`hasProcess` 只看 `agentLine` |
| `services/process_level_store.dart` | 读出来时走归一（老设备盘上的 `quiet`/`steps` ⇒ `doing`），理由写在文件头 |
| `services/stream_uri.dart` / `services/stream.dart` | 只改注释：地址上仍然永远带 `level`，四个 token 冻结 |

**为什么归一而不是"清掉"**：盘上存着的老档**不是坏值**，是"已经被砍掉的档"；
如果读出来留着它，菜单里**没有任何一项是选中的** —— 那等于页面在说假话
（它看起来像"用户还没选过"，其实用户选过）。归一到默认档之后，
**菜单上永远有一项是选中的**，而且那正是"最不会替用户拿主意"的那一档。

---

## 四、`step/*` 今天的处境

- 服务端**照旧**为老客户端的 `?level=steps` 发 `step/*`（瞬态、不占号、不落盘）；
  **`reasoning` 那一阶也照旧放行它**（累加的梯子）。
- 🔴 **今天这条通道只为老客户端的 `steps` 档存在**：新客户端已经不发 `steps`，
  所以它**收不到**（`doing` 档不发步骤）；就算收得到（`reasoning` 档）也
  **不再消费、界面一个像素都不画**。
- **状态机那一层照旧认它**（`models/timeline.dart` 的 `_steps`）：协议不许破，
  老客户端的状态机行为一个字不改；`test/unit/process_steps_test.dart` 仍然钉它
  （乱序保护 / 收口即清）。
  ⇒ **收得到 ≠ 画出来**。
- 代码注释里写清这件事的三处：`v2/services/core/src/server.js`（`PROCESS_LEVELS`
  上面那段）、`src/session-translate.js`（文件头 ④ 与 `#emitStep`）、
  `v2/apps/mobile/lib/models/process_levels.dart`（文件头）。

---

## 五、老设备迁移（**一句话**）

老设备盘上存着 `steps` / `quiet` ⇒ **读出来是 `doing`**，
菜单上「在做什么」是选中的那一项。**不迁移、不写盘、不弹任何话** ——
用户下一次换档时自然写成新的两档之一。

---

## 六、判据（**先红后绿**，每条带负向对照）

| # | 判据 | 在哪 | 负向对照 |
|---|---|---|---|
| 1 | 菜单里**恰好两项**（`ListTile` × 2）；「安静」「步骤流水」**一个都不出现** | `test/widget/process_levels_test.dart` · `test/widget/accessibility_test.dart` | 改回 `ProcessLevel.values` 四档 ⇒ 数量与"不出现"当场红 |
| 2 | 盘上存 `steps` ⇒ 读出来 `doing`，且菜单上「在做什么」**是选中的那一项** | `test/unit/process_level_store_test.dart` · `test/widget/process_levels_test.dart` | 去掉归一 ⇒ `_tile(...).selected == false`，红 |
| 3 | 盘上存 `quiet` ⇒ 同上 | 同上 | 同上 |
| 4 | 盘上存 `reasoning` ⇒ 照旧选中「它心里想的」 | `test/widget/process_levels_test.dart` | 把归一写成"一律 doing" ⇒ 这一条红 |
| 5 | 服务端收到 `?level=steps` **仍然发 `step/*`**（老客户端不许坏） | `v2/services/core/test/process-level.test.js`（原样，一条没改） | 把 `steps` 从 `LEVEL_EXTRA_TYPES` 删掉 ⇒ 端到端那条红 |
| 6 | 界面上 `reasoning` 档下**不再画步骤流水**，**推理原文照旧画** | `test/widget/process_levels_test.dart` · a11y「推理原文拉满」 | 把 `ProcessTail` 的步骤分支加回来 ⇒ 红 |
| 7 | 不认识的 token ⇒ 默认档、**绝不抛**、菜单照开 | `test/unit/process_levels_test.dart` · `test/widget/process_levels_test.dart` | 改成抛 / 返回 null ⇒ 红 |
| 8 | 四个 wire token **逐字冻结** | `test/unit/process_levels_test.dart` · `test/unit/stream_uri_test.dart` | 改一个字母 ⇒ 红 |

**闸（读数见 [`00-PROGRESS.md`](00-PROGRESS.md) `#170`）**：
`flutter analyze` 干净 · `flutter test test/unit` · `flutter test test/widget`（全量）·
`test/widget/accessibility_test.dart`（**硬闸**）· `cd v2/services/core && npm test` ·
`node scripts/check-docs.mjs`。

---

## 七、明确不做 / 如实说

- ⚠️ **服务端那一侧这一批一个语义字节都没改**（只动了注释）：砍的是客户端入口。
- ⚠️ **`step/*` 没有删**：删它就会让还在跑的老客户端**静默少一档**
  （协议纪律 2）。要删也得等"老客户端不再存在"那一天，**那一天不是今天**。
- ⚠️ **`models/timeline.dart` 的 `_steps` 没有删**：同上 —— 收得到 ≠ 画出来。
- ⚠️ **`docs/dev/26-PROCESS-LEVELS.md` 那一份没有被重写**：
  它是 L3 历史证据（当年四档怎么落的），只在顶上加了指向本页的更正。
- ⚠️ **`ProcessTail` 保留**（虽然今天只剩一行）：它是"尾巴上那一块过程"的落点，
  真删掉的话下一次要往尾巴上放东西的人会**另起一个组件**。
