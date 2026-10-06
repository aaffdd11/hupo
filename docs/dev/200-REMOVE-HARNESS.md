# 200 · **「我自己那台」从产品里删掉**

> **主人原话**（2026-10-06）：*「「我自己那台」小程序要删掉。」*

---

## 一、删掉了什么（一件一件点名）

| 层 | 东西 |
|---|---|
| **桌面** | 图标墙上那一格（`chat_screen.dart` 里那个 `DesktopApp`）⇒ 桌面上现在只剩 **设置 / 发现 / 创建小程序** ＋ 他自己的小程序 |
| **客户端那一屏** | `widgets/harness_pane.dart`（那一层"终端"）· `services/harness_client.dart`（那三条消息的通道）· `models/harness.dart` · `models/harness_words.dart` |
| **客户端那个次要入口** | 「在浏览器里打开」那一套：`models/dev_harness.dart` · `models/dev_harness_words.dart` · `services/dev_harness_client.dart`（它只住在那一层里） |
| **服务端那条路** | `/api/harness`（WS）· `src/harness-session.mjs`（盒子那侧那个中继：一个连接 = 一个 DSH 进程）· `serve.js` 的接线 · `server.js` 的 `harnessWss` / `onHarness` / 升级分支 / 收尾那两句 |
| **房间** | `worlds.js` 的 `BUILTIN_SCOPES`：`['settings','discover','harness']` → **`['settings','discover']`** |
| **保留 id** | `apps.js` 的 `REFUSED_APP_IDS`：`'harness'` **也跟着收走**（与 `'math'`（奥数题）同一条先例：那一格从产品里去掉 ⇒ 这个名字不再是保留 id）。⇒ 保留名单 = 主线 ＋ 内置那几格这条等式**仍然成立**（判据 S5 钉着） |
| **判据** | 删：`test/unit/harness_test.dart` · `test/unit/dev_harness_test.dart` · `test/widget/harness_test.dart` · 服务端 `harness-{session,route,process,live-check}.test.js` · 那两个假 DSH（`fake-harness-dsh.mjs` / `harness-fake-voice.mjs`）· `scripts/check-harness.mjs`（H9/H10 那条脚本）。改：`accessibility_test`（那几档"从真入口进"的实例一起拿走）· `remote_app_test`（桌面那一格的表：三个内置 → 两个）· `scope_test` / `app_spec_test` / `app_tint_test` / `work_list_test` / `forbidden_words_test`（那边一句话都没有了）· 服务端 `app-create` / `app-workspace` / `app-write-gates` / `room-reclaim` / `route-shape` |
| **手册** | `08-SPEC.md` §2.1：`/api/harness` 那一行搬进"⏳ 今天不存在"那一节（表与代码不许各说各话）· `05-DECISIONS.md` **D4.31** · `CHANGELOG.md` **v2.74** · `AGENTS.md` 的"线上"那一行 |

## 二、⚖️ 有一条**没删**，写清楚（不是漏了）

**开发者模式**（`82-DEV-MODE.md`）：翻标记那条 `/api/dev-mode`、dev 域名那条中继、
房间清单 `/__rooms` —— **一个字节没动**。

* 跟着那一格一起没的，只是**那个入口按钮**（它原来长在「我自己那台」那一层里）；
* 「要一条签名链接」那条端点 `/api/dev-harness` **留着**（服务端那份 ＋ 它那条判据 D6 都还在）——
  它属于开发者模式那套，而"删一格图标"与"删一个能力"是两件事。

⚠️ **后果如实说**：今天 App 里**没有**进开发者模式的按钮了 ⇒ 要进去得**现要一条签名链接**
（那条端点还在，现发一条就行）。要是连这个能力也不要了，说一声，那一次删干净。

## 三、盘上那些老数据

`BUILTIN_SCOPES` 少一个**不碰盘上任何字节**：他那一格里**已经有过**的会话记录
（`scopeId: 'harness'` 那些事件）照旧在 `main.jsonl` 里躺着 —— 与 `math` 那次
（`105-DROP-MATH.md` §二）同一条规矩：**这一刀只改"名字还认不认"，不动历史**。
⇒ 那个房间**不再认得**（`?scope=harness` 会被拒），但它的字一个都没丢。

## 四、读数

| 项 | 读数 |
|---|---|
| 服务端 `npm test` | **1505 过 / 0 挂**（删掉那几份 harness 判据之后从 1539 降下来） |
| 客户端 `check-client.sh` | ✅ **硬闸全过**（见 `00-PROGRESS.md` 那一行） |
| 桌面那一格的表 | `remote_app_test`：`[设置, 发现, 创建小程序]`（多一格 / 少一格 ⇒ 红） |
| `harness` 这个名字 | `isBuiltInScope('harness')` **false** · `isAnAppRoom('harness')` **false** · `REFUSED_APP_IDS` 里**也没有它** |
| 不在的判据 | 服务端那 5 份 harness 判据 ＋ 客户端那 3 份（那一层没了，判据跟着走 —— 留着就是"守着一段不存在的代码"） |

## 五、这一刀没做的事

* **没动**「开发者模式」那套（见 §二）；
* **没动**盒子里那台 DSH 自己（它照旧给琥珀干活；删掉的只是"从 App 里看它原始流"那扇窗）；
* **没动**任何盘上数据（见 §三）。
