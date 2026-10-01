# 拆哪几个文件 · **按"改动次数 × 体量"排**（不是按行数排）

> 这一篇只回答一件事：**下一次要拆文件，先拆哪个、接缝在哪。**
> 判据不是"谁最长"，是"**谁最常被改**"—— 长但不动的文件不咬人，短但每次都要动的才咬人。
>
> 数据：`git log -300 --numstat`，只算生产代码（`v2/services/core/src/**` ＋ `v2/apps/mobile/lib/**`）。

## 一、排名（改动次数 × 当前行数）

| 排名 | 文件 | 改动次数 | 当前行数 | 为什么它在前面 |
|---|---|---|---|---|
| 1 | `v2/apps/mobile/lib/screens/chat_screen.dart` | 56 | 2833 | **手册 §2.5 早就点名要拆**（那时它是 866 行 —— 计划没还，涨了 3 倍多） |
| 2 | `v2/services/core/src/server.js` | 40 | 3659 | 路由 / 静态 / WebSocket / 装配堆在一起；每条新口都往这儿加 |
| 3 | `v2/services/core/src/serve.js` | 32 | 1562 | 接线层：每加一样能力都要改它一次 |
| 4 | `v2/services/core/src/dispatcher.js` | 15 | 2865 | 改动次数不算高，但**体量最大**、且 §5.3 那条根因不明显 |
| 5 | `v2/services/core/src/worlds.js` | 28 | 1377 | 每加一样"按人存的东西"都要动 |
| 6 | `v2/apps/mobile/lib/services/chat_controller.dart` | 21 | 1733 | 状态机 ＋ 落盘去抖 ＋ 流处理混在一起 |
| 7 | `v2/services/core/src/apps.js` | 18 | 1610 | 小程序那一族每次都在长 |
| 8 | `v2/apps/mobile/lib/models/space_words.dart` | 36 | 665 | **最短但改动最勤的一批**：改一句界面话就动它（见下） |
| 9 | `v2/apps/mobile/lib/services/api.dart` | 16 | 1277 | 每条新口一个方法 |
| 10 | `v2/services/core/src/apps-socket.js` | 23 | 637 | 小程序那条窄口 |

> 注：`dev-mode.js`（2145 行）只被改 **6** 次、`session-translate.js`（1243 行）**8** 次 ——
> **它们长但不咬人**，排在后面。这就是"按改动次数排"和"按行数排"的区别。

## 二、按什么接缝拆（**别按行数砍**）

| 文件 | 接缝（往哪切） | 硬要求 |
|---|---|---|
| `chat_screen.dart` | **手册 `03-DEVELOPMENT.md` §2.5 已经写好了七件**（`panel_geometry` / `timeline_pager` / `message_state` / `panel_shell` / `panel_header` / `composer` / `message_list`）—— **照它拆，别重新设计** | 几何与分页要变成**无 State、无 context 的纯函数**，进 `test/unit` 硬闸 |
| `server.js` | 按 **API 前缀**切（`/api/apps*` / `/api/creds` / `/api/asr` / `/api/admin*`…），`server.js` 只留**装配与静态** | 拆完的判据：**加一条口只打开一个 <300 行的文件** |
| `serve.js` | 按**接线对象**切（worlds / apps / asr / 供给），`serve.js` 只做 `createServer(...)` 的装配 | 同上 |
| `space_words.dart` | ⚠️ **不要为了行数拆它** —— 它是**一个概念一处出处**（`test/unit/space_test.dart` 与 `forbidden_words_test.dart` 都按它整份扫）。它改动勤是因为**界面话本来就常改**（那是产品在跑，不是结构坏） | 真要动：按**屏**分成 `lib/models/words/<屏>.dart`，且**闸要跟着扫目录**（照 `check-client.sh` 扫 `test/widget` 那个做法） |
| `dispatcher.js` | 先读 §5.3（`turns` 的稳定键）—— **那处根因不明显，照直觉拆会拆错地方** | 拆之前先把 `turns` 那条判据补齐 |

## 三、顺序与判据

```
① server.js / serve.js  →  ② chat_screen.dart（照 §2.5）→  ③ worlds.js / apps.js
```

**每一刀的判据（缺一条就不算拆完）**：

1. **闸全绿**（服务端 `npm test`、客户端 `check-client.sh`、文档闸）；
2. **对外行为一个字节没变**（协议冻结；`check-web-drift.sh` 那类产物读数照旧）；
3. **"改一处只碰一个文件"这条能量出来** —— 拿 `scripts/where.sh <符号>` 比拆之前后的落点数；
4. **不新增手工索引**（新文件不该要求谁去改 `check-docs.mjs` —— 那条税 2026-10-01 已经拆掉了）。

## 四、⚠️ 这一篇**只是排序，不是做完了**

我没有在写这一篇的同时动任何一个源文件，理由写在 `04-ROADMAP.md` §十一：
**"做一半比不做更坏"** —— 拆 `chat_screen.dart`（2833 行、56 次改动、牵动 5 组 widget 判据）
是一整批的活：要拆、要补 `test/unit` 纯逻辑判据、要跑客户端三道闸（约两分钟）、要部署、要收尾。
**它必须自己走一遍完整的 §5.0**，不能夹在别的批次里顺手做。

⇒ 这一篇的作用是：**下一次有人要拆的时候，不必再量一遍、也不必争论先拆哪个。**
