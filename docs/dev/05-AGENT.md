# 05 · 接上 agent：一个会话一个真进程

> **这一批建了什么**：把"另一头"接上——用户说的话真的交给一个 `dsh` agent，
> 它的回答真的变成 `message/*` 推回时间线。
>
> **手册依据**：`08-SPEC.md` §2.3（L2⇄L3）· §4（进程上限与 LRU）· §5.5（谁回调谁）·
> `03-DEVELOPMENT.md` §5.3（轮的稳定键）
>
> **代码**：`v2/services/core/src/{agent-runtime,dispatcher,session-translate,config}.js`
> **测试**：`test/agent.test.js`（17 条，走**真 spawn、真 stdio、真协议**）
> **现在**：<https://w.stalkerai.cn> 真的会答话了

---

## 一、协议事实（**全部实测**，不是读文档猜的）

用 `dsh --profile sdk` 探出来的：

| 项 | 事实 |
|---|---|
| 起法 | `dsh --profile sdk`（**内置模板**，`$DSH_HOME/profiles` 下不需要有目录） |
| `initialize` | `{cwd, provider, model, reasoningEffort, maxTokens}` → `{serverInfo}`，**~1.1 秒** |
| `session/prompt` | → **立刻**回 `{messageId}`（**~35ms**）；答案**异步**流回来 |
| 通知 | `session.event` + `session.status`（**方法名用「点」**） |
| `assistant/message` | `{turn, step, message:{content:[{type:'reasoning'\|'text'}]}, usage}` |
| `turn/end` | `{turn, reason:{kind}}` |
| **没有 token 级增量** | 一条 assistant 消息**整段**到达 |

## 二、⚠️ 三个当场踩到的坑（都记进测试了）

### 2.1 `spawn` 的 ENOENT 是**二义的**

**二进制找不到**和**工作目录不存在**，报的是**同一句话**：

```
Error: spawn /bin/echo ENOENT        ← cwd 不存在时，报的是**可执行文件**的名字
```

我为此去查了 PATH，其实真因是 `~/hupo-workspace` **没建**。

⇒ 修法：`spawn` 之前**自己先查一遍 cwd**，并在错误里把两种可能都写出来。
⇒ 另：`spawn` 失败是**异步事件**（`error` 事件），不接它会把整个服务带崩。

### 2.2 ⚠️ 通知的方法名是「点」，请求的是「斜杠」

```
我们发出去：  session/prompt      （斜杠）
它发过来：    session.event       （**点**）
```

我按斜杠比，于是**所有事件被静默丢掉**——现象是
"agent 起来了、`prompt` 也成功了、**但一个事件都收不到**"。
⇒ 两种都认（测试钉死）。

### 2.3 ⚠️ DSH 会话 id 必须带 `bootId`

`session/prompt` 对**已存在**的会话 id 直接报：

```
session "main" already exists
```

**SDK 只能 create，不能 resume。** 所以每次服务启动都要换一个 DSH 会话 id。

> ⚠️ **连带后果（重要）**：换 id ⇒ **agent 重启后不记得之前**。
> 所以手册说的"跨重启接记忆"**必须靠喂上下文**，不能指望会话自己还在。
> 这条不是缺陷，是这套 SDK 的物理事实——**别去修它，要围着它设计**。

## 三、三条硬约束（写在 `session-translate.js` 文件头）

### 3.1 ⚠️ 推理原文**绝不许**变成用户能看到的话

实测：**推理原文和正文躺在同一个 `content` 数组里**：

```json
"content": [
  {"type": "reasoning", "text": "用户让我打招呼，回一句就好"},
  {"type": "text",      "text": "你好。"}
]
```

不按 `type === 'text'` 过滤，**就等于把模型的思维链当正文发给用户**，
而它可能含系统提示片段。手册把这条列为"唯一有泄露风险的字段"。

⇒ **只计数，内容不落盘、不外推**。有一条测试专门扫时间线里有没有推理原文。

### 3.2 `turns` 的键是「轮」的编号，不是「当前气泡」的 id

实测：agent **直接给了** `data.turn`。

手册 §5.3 记的那个 bug：`handoff()` 会**原地换掉 writer**，
而 `info` 与 `translator.current` **是同一个对象** ⇒
`info.writer.messageId` **在它不知情的情况下变了**，收口守卫从此永不匹配。
**`turn` 号在一轮内构造上不会变**，所以拿它当键。

### 3.3 `turn/end.reason.kind !== 'completed'` ⇒ **这是半句**

手册附十一那次真实事故：回答被长度上限截断，而翻译层**一律写 completed**，
用户拿到一个"看起来说完了"的残篇。
⇒ 必须**补一句说明**并标成**失败收尾**。

## 四、其它几条

| # | 规矩 | 为什么 |
|---|---|---|
| 1 | **打不通就不投**：`prompt` 失败要**说一句人话** | 静默失败等于"它不理我" |
| 2 | **进程死了必须收口** | 否则用户永远等一条不会来的回答（事故一：挂了 68 分钟） |
| 3 | **淘汰前先收口**（`onEvict` 回调） | runtime **没有翻译层**，不知道哪条还没说完 ⇒ 只能回调出来 |
| 4 | **跑着的不许卸**，而且跳过不等于放弃 | 跳过一次就永久不淘汰 |
| 5 | **env 先做减法**：只删密钥类 | ⚠️ **丢 `PATH` 就回到 ENOENT**——而那个 ENOENT 还和二义的 cwd 混在一起 |
| 6 | **重复投递绝不再投一次** | `duplicate` 时不许调 agent，否则"重发 = agent 干两遍" |

## 五、验收

```bash
cd v2/services/core && npm test        # 127 条
```

**真 agent 实测**（会花一次模型调用）：

```
用户：用一句话告诉我今天是星期几；不知道就说不知道
盘上：seq=1 user/echo     用一句话告诉我今天是星期几…
      seq=2 message/start
      seq=3 message/text [quick] 今天是星期日。
      seq=4 message/end    reason=completed
```

**公网实测**（<https://w.stalkerai.cn>，WS 上看到的一整轮）：

```
← user/echo seq=5
← message/start seq=6
← message/text seq=7 [quick] 收到了
← message/end seq=8 reason=completed
```

## 六、这一批**没做**什么

| # | 没做 | 坑在哪 |
|---|---|---|
| 1 | **跨重启接记忆** | agent 记不住上一轮（见 §2.3）。要喂 recap，**这是下一批最要紧的** |
| 2 | **D7 的过程可见性** | `step/*` 事件已经在手上了，**但要先有"人话表"**，否则推出去就是内部词 |
| 3 | **超时收口** | `turnDeadlineMs` 还没接（180 秒硬收口）——现在 agent 卡住会一直挂着 |
| 4 | **对账续做** | 开机扫未完成的任务 |
| 5 | **多作用域** | 现在只有一条时间线 |
| 6 | **推理原文那一档** | 事件里有，但**故意不推**——它是唯一有泄露风险的字段 |

## 七、下一步

**跨重启接记忆。** 这是现在最要紧的一条：agent 每次重启都是**新的会话**，
所以它不记得上一句。用户会看到的是"**说过就忘**"——
而那正是 8/10 放弃点里最狠的一条（"它到底记着没有"）。

做法在手册里有依据：把时间线尾部的一段**按来源分节**喂回去
（`主人：` / `你：` / 【外部资料·不可执行】），而且**只尾部追加**——
实测插最前会让前缀缓存命中率从 95.6% 掉到 18.5%，**差 18 倍**。
