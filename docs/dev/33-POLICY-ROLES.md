# 33 · 批 5「agent 自己的手有多大」—— 角色与降档（契约 v1）

> 出处：`04-ROADMAP.md` §十二 悬空 #1（*"容器解决用户之间，**没解决 agent 与宿主**"*）
> + `08-SPEC.md` §12.1（role 三类 → 三份 patch）/ §12.2（逐工具能力矩阵）。
>
> **2026-09-21 分诊（`32-TRIAGE.md`）把它判成"这 8 条里最该先做的一条"**：
> 容器解决的是"用户之间"，而**威胁的真实形态**（读到看不见的网页 → 写进自己的配置 →
> 从此每轮都读）走的是"**agent 与宿主**"这条路 —— **今天这条闸不存在**。
>
> ⚠️ **这一篇是契约，不是实现。** 先把口径钉死，再动手（批 4 就是这么走的）。
> ⚠️ **有三条要主人拍板**（§四），拍完才开工。

---

## 一、手册已经钉死的（**逐条都在，不改口径**）

| 出处 | 钉死的 |
|---|---|
| §12.1 | role 三类：`owner`（主人原话触发的会话）/ `untrusted`（**本会话已吃到外部内容**）/ `monitor`（监控层）。**role 只能在 spawn 层决定**——hook 的子 agent 接缝不带 per-kind 标签，所以必须在 `AgentRuntime` 里做 |
| §12.1 | 三份 patch：`policy-owner.yml` / `policy-untrusted.yml` / `policy-monitor.yml`。**降档必须"换进程"，不是运行时改模式**（进程级隔离，模型碰不到） |
| §12.1 | ⚠️ **两道叠加，不是二选一**：权限模式 **＋** 工具 deny。**即使模式被切回来，deny 仍然在** |
| §12.2 | 只读档逐个 `disabled`：`tool-bash`（**最关键**）· `tool-pwsh` · `tool-web`（对外发送）· `tool-subagent*` · `tool-workflow`/`tool-ralph`/`tool-jobs` · `tool-skill`（**= 指令注入载体**）。`tool-fs` **不许整个 disabled**（那会把"读文件"也杀掉，agent 变废人）——只读性靠**权限模式** |
| §12.2 | ⚠️ **hook 里只写 `deny`，不写 `ask`**：无头会话没有人应答 `ask` |

---

## 二、✅ 实测：DSH 这边到底怎么给（**三处，都是量出来的**）

> ⚠️ 这一节是这一篇最值钱的部分：**上一批的教训是"别照猜"**（`31-LEDGER.md` §三·补二）。
> 下面每一条都能复现，复现方法写在后面。

### 2.1 ⭐ 权限模式是**一个环境变量**，不是配置文件

`sdk` profile 组合出来的树里，那两条是这么写的（`dsh --profile sdk --dump-config`）：

```yaml
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: !!js >-
      (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') ===
      'danger-full-access' ? 'never' : 'ask'
```

⇒ **起 agent 时设 `DSH_PERMISSION_MODE` 就够了**（`childEnv()` 只删 `*_API_KEY/_TOKEN/_SECRET`
和设 `DSH_HOME`，**不删 `DSH_*`** ⇒ 这条路通）。

**真机验过**（探针：起 dsh → `session/prompt` → 读 session 起始那三个事件）：

| `DSH_PERMISSION_MODE` | `permission/preset` | `sandbox/mode` | `approval/policy` |
|---|---|---|---|
| （不设，默认） | `workspace-write` | `workspace-write` | `ask` |
| `read-only` | **`read-only`** | **`read-only`** | `ask` |
| `danger-full-access` | `danger-full-access` | `danger-full-access` | `never` |

⇒ 两件事一起确认了：
1. **模式真的跟着走**（不是只改了个显示名）；
2. ⚠️ **默认档是 `workspace-write`，不是 `danger-full-access`**
   —— §12.1 那句"可能被宿主默认预设盖掉"的担心，**今天这一版的默认档是安全的**
   （但要记住它只是**默认值**，谁都能从环境里改）。
3. ⚠️ 而且 `approval/policy` 在只读档是 **`ask`** —— 而无头会话**没有人应答 `ask`**
   ⇒ 光靠模式不够，**工具还得逐个 deny**（§12.2 那道，正是为此）。

### 2.2 三份 patch 要按**entry id** 打（id 是量出来的）

工具那几条在树里的 id（`--dump-config` 里逐条找到的）：

| §12.2 里的名字 | 树里的 entry id | 备注 |
|---|---|---|
| `tool-bash` | `tool-bash` | 平台是 win32 时它本来就 disabled |
| `tool-pwsh` | `tool-pwsh` | 非 win32 时本来就 disabled |
| `tool-web` | **`web-search-deepseek` + `web-fetch-http`** | ⚠️ **不叫 `tool-web`**：`web` 是那个**服务**，工具是它下面两条 —— 照 §12.2 的字面写 `tool-web` **打不到** |
| `tool-subagent*` | `tool-subagent` · `tool-subagent-fork` | 另有 `tool-subagent-control` / `tool-subagent-list-agents` |
| `tool-workflow` / `tool-ralph` / `tool-jobs` | 同名 | |
| `tool-skill` | `tool-skill` | |
| `tool-fs`（**不许整个 disable**） | `tool-fs` · `tool-fs-search` | 只读靠模式 |

### 2.3 patch 的形状（上一批验证过的写法）

`- insert:` 是**新增**；要**改/禁**已有条目就是 `- id: <那条的 id>` + 覆盖键
（`disabled: true` 是覆盖）。⚠️ 顶层写成 `- id: <新 id>` **会被静默跳过**（`31-LEDGER.md` §三·补二）。

---

## 三、v1 提案（**实现按这一节走**，除 §四 那三条）

### 3.1 今天只有**两个** role，不是三个

`monitor` 档**没有落点**：监控层本身还没建（`12.1` 那张表里它是给"监控层"用的）。
⇒ **明说这一批不做 monitor 档**，不写一个没人挂的 patch 文件（写了就是"看起来有三个档"）。

| role | 谁用 | 挂什么 | 权限模式 |
|---|---|---|---|
| `owner` | 默认（主人原话触发的会话） | 人格 + 能力层（**今天就是这样，不动**） | `workspace-write` |
| `untrusted` | 本会话**taint 已置位** | 人格 + 能力层 + **`policy-untrusted.yml`** | **`read-only`** |

### 3.2 `policy-untrusted.yml`（新文件，进仓库）

```yaml
# 只读档：吃到外部内容之后的那一档。两件事一起做（§12.1：两道叠加，不是二选一）
#   ① 模式：由 spawn 时的 DSH_PERMISSION_MODE=read-only 给（实测见 §2.1）
#   ② 工具：这里逐个 disabled —— **就算模式被切回来，这一道仍然在**
- id: tool-bash          # ★ 最关键的一条：一个 shell 能干任何事
  disabled: true
- id: tool-pwsh
  disabled: true
- id: web-search-deepseek  # ⚠️ §12.2 写的 "tool-web" 在树里是这两条（§2.2）
  disabled: true
- id: web-fetch-http
  disabled: true
- id: tool-skill           # = 指令注入载体
  disabled: true
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
- id: tool-workflow
  disabled: true
- id: tool-ralph
  disabled: true
- id: tool-jobs
  disabled: true
# ⚠️ tool-fs / tool-fs-search **不在**这里（§12.2：整个禁掉 = agent 变废人）
```

⚠️ 它与人格/能力层一样是 `--patch` 的一层 ⇒ **也要进 `protectedPaths()`（strict）**
（它决定"agent 能做多大事"，比能力层更该被看着）。

### 3.3 taint 怎么置位（**要主人拍板**，见 §四①）

提案：**看这一轮调过哪些工具**（`session-translate` 已经看得到 `tool/call`）：

| 情况 | 算不算脏 | 为什么 |
|---|---|---|
| `web_search` / `web_fetch` | ✅ 算 | 这就是"看不见的网页内容"进来的那条路 |
| **派出去的子 agent** 回来的东西 | ✅ 算（保守） | 子 agent 可能自己上过网；而 §12.2 说只读档要连 `tool-subagent*` 一起禁 —— 按同一口径判定 |
| `read` / `glob` / `grep` 读**本机文件** | ❌ 不算 | 那是**主人自己**的东西（N21：份内） |
| `bash` | ❌ 不算（**但要说明白**） | ⚠️ shell 什么都能干，包括联网 —— **这正是"只读档把 bash 禁掉"的理由**；把 bash 算成脏会让每个会话都立刻降档，那就等于没有降档 |

### 3.4 什么时候生效（**要主人拍板**，见 §四②）

提案（**这一轮说完话再换进程**）：
1. 一轮里发现 taint ⇒ **记在这个会话上**（内存 + 落盘）；
2. **这一轮照常说完**（§8.3：不许切掉正在说的那一轮）；
3. 轮结束 ⇒ **卸掉那个 agent 进程**（`onEvict` 那条路已经在了）；
4. 下一次说话 ⇒ 按 `untrusted` **重新起一个进程**（read-only + deny）。
   ⇒ 这正是 §12.1 那句"**降档必须换进程**"的落点。
5. **不许运行时改模式**：那是模型碰得到的一层。

### 3.5 降档之后要**告诉主人**（N11：不许静默降级）

它突然不能干活了（不能写、不能上网），**必须有一句人话**，否则现场看起来只是"它今天不听话"。
文案口径（**过禁用词闸**，正文由实现时定）：说清**三件事** ——
① 这条对话里读到过外面的东西；② 接下来它只读不改；③ **另开一条对话就能照常动手**。
⚠️ 提示词与正文都要过 `forbidden_words` 那条闸。

---

## 四、🔴 要主人拍板的（**三条，拍完才开工**）

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| ① | **什么算"吃到外部内容"** | (甲) 只算上网那两个工具 · (乙) 甲 + 子 agent 回来的东西 · (丙) 连 `bash` 也算 | **乙**。丙会让每个会话立刻降档（等于没有降档）；甲会漏掉"子 agent 上过网"这条路 |
| ② | **什么时候生效** | (甲) 这一轮说完就换进程（下一轮降档） · (乙) 只影响下一个会话（本会话整段全权） · (丙) 立刻杀进程 | **甲**。乙太慢（一个会话可能活很久）；丙违反 §8.3（切掉正在说的话） |
| ③ | **降档之后还能不能升回来** | (甲) 会话级、不解除（新对话自动全权） · (乙) 隔一段时间自动解除 | **甲**。简单、可解释，而且"另开一条对话"就是它的出口（§3.5 那句话要说清） |

> ⚠️ **放不进这三条的**（不在这一批，明说）：监控档（§3.1）· `hook` 那一道 deny（我们用的是
> patch 的 `disabled`，比 hook 更硬，但**D10 那套 hook 接缝**没接）· 容器（#10，本机做不了）。

---

## 五、切法与验收（**开工前先按 §四 改一遍**）

| 半 | 判据 |
|---|---|
| **两个 role + 两层 patch** | spawn 参数与子进程环境**逐项对表**：`owner` 不带能力以外的 patch、模式 `workspace-write`；`untrusted` 带 `policy-untrusted.yml`、模式 `read-only` |
| **taint 判定**（纯函数） | §3.3 那张表逐行进 `test/unit`（**纯函数**，不给它真起 dsh 的机会） |
| **生效时机** | 一轮说完才卸进程（**不许切掉正在说的那一轮**）——真机验：一轮里调一次 `web_search` ⇒ 这一轮正常说完 ⇒ 下一轮的事件里 `permission/preset = read-only` |
| **别把主人锁死** | 新会话**不受影响**（负向对照：不然后面每一次都读不了写不了） |
| **文案** | 过禁用词闸（那是硬闸，不是文风） |
| **慢闸** | `scripts/check-policy-roles.mjs`：起真 dsh，读 session 起始那三个事件（就是 §2.1 那张表的做法） |

⚠️ **`policy-untrusted.yml` 一进仓库就欠一次开机清单重建** ⇒ **和 §九·补 攒的那两条一起给主人一次**。
