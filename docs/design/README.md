# 子架构索引（`docs/design/`）

> **上游**：`ARCHITECTURE-v7.md`（大架构，权威）｜`docs/pm-panel/DECISIONS.md`（11 条拍板）
> **另有**：[`ai-phone-architecture.md`](ai-phone-architecture.md) —— **多租户 + 工作区 + 统一窗口**，
> v7 之后的新一轮（覆盖 v7 没有的三件事：一人一台容器、一条会话一个工作区、客户端只看到一条时间线）。
> 下面四份子架构描述的是**单用户那一代**，仍然有效；两份文档冲突时，多租户相关以 `ai-phone-architecture.md` 为准。
> **本目录**：四份子架构 + 上述新架构 + 这份索引。索引的作用是**当锚**——文档最容易打架的地方是
> "同一个数字两处写不一样""同一个东西两个名字""同一条状态机两边理解不同"，
> 所以把**接口、数据模型、状态机、阈值**全部集中到这一页；子架构里引用它们时以本页为准。

---

## 一、四份子架构的关系

```
                    ARCHITECTURE-v7.md（大架构 · 权威）
                               │  §3 命名与接口契约
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
  L1-terminal.md         L2-dispatcher.md        L3-worker.md
  （终端层）              （调度层）              （工作层）
        │                      │                      │
        └──── HTTPS/WSS ───────┤ stdio JSON-RPC ──────┘
                               │
                     ops-security.md
        （跑着它们的那台机器：systemd / nginx / 备份 / 审计 / 自愈）
```

**多租户那一代**（`ai-phone-architecture.md`，与上面四份是**不同的轴**）：

```
                    ARCHITECTURE-v7.md（大架构 · 权威）
                               │  §3 命名与接口契约（继续有效）
                               ▼
                  ai-phone-architecture.md
        （一人一台容器 · 一条会话一个工作区 · 统一窗口 · 调度器三职责）
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
    多租户与目录            跨作用域转交            记忆索引 KV
    （§3 容器/沙箱）        （§5 块 9）             （§6 块 10）
```

**每份文档的"评审重点"**：

| 文档 | 审什么 | 最容易被忽略的 |
|---|---|---|
| `L1-terminal.md` | z 序（聊天永远在最上）、三档与手势、小程序沙箱与版本、协议六条 | **Z1 不修，一开小程序聊天就被吞掉** |
| `L2-dispatcher.md` | 准入、预算三级、来源→能力、对账续做、制品服务、鉴权改造 | **内存闸是"不写数字"唯一的兑现方式** |
| `L3-worker.md` | role 三份 patch、上下文前缀不变量、子 agent 类型、KV `facts` 闸门 | **监控会话是同权的第二个执行体** |
| `ops-security.md` | systemd 单元草案、构建隔离、审计、备份+演练、自愈 | **agent 仍挂免密 sudo（本轮未解决）** |
| **`ai-phone-architecture.md`** | 容器与目录布局、作用域一致性、转交协议、KV 三个失败模式、调度器三职责 | **`workspace root` 不是安全边界**（它只约束写，不约束读）；**KV 不能由 agent 直接写** |

---

## 二、跨模块接口总表

| 从 | 到 | 形态 | 传什么 | 不许传什么 |
|---|---|---|---|---|
| L1 | L2 | HTTPS `POST /api/say` | `conversationId, messageId, text, clientAt, source` | **令牌不许放 URL**；`source` 由服务端覆盖 |
| L1 | L2 | WSS `/api/stream` | `sinceSeq` 续传、`dev=1` 附加 | 不许把 `dev=1` 当成替代通道 |
| L2 | L1 | WS 事件 | `message/*`、`task/*`、`user/echo`、`app/*`、`client/reload`、`error` | **status 不许混进正文** |
| L1 | 制品 origin | HTTPS（**独立域**） | 只读静态 | **绝不代理 `/api/`** |
| L1 | L2 | HTTPS `POST /api/receipt` | 客户端自己的钟 | — |
| L2 | L3 | stdio JSON-RPC | `initialize` / `session/prompt` / `shutdown` | 密钥（**用白名单 env**） |
| L3 | L2 | stdio JSON-RPC | `session.event` / `session.status` / `subagent.*` | — |
| L3 | 制品口 | 特权接口（**不在公网路径**） | 制品 + `sha256` + 触发它的 `messageId` | — |
| L2 | L3 | spawn env | `DSH_PERMISSION_MODE`、白名单 env | `*_API_KEY` / `*_TOKEN` / `*_SECRET` |
| L2 内部 | L2 内部 | `policy.js` | 来源分级 → 档位；taint 状态 | **清 taint 不许由模型触发** |
| 监控 | L2 | 任务簿（**root 属主**） | `title`（闭集 + 引用原文）/ `detail` | **自由文本不许进"指令位"** |

---

## 三、数据模型总表（谁写 / 谁读 / 权威性）

| 数据 | 位置 | 写 | 读 | 权威 |
|---|---|---|---|---|
| 事件流（正史） | `data/<conv>.jsonl` | L2（`emit()` 一处） | L2 / 监控 / L1（续传） | **权威** |
| `facts` | `data/kv/<userId>.jsonl` | L3（工具，过闸门） | L3 主 agent（装配简报） | **派生、可重建** |
| 画像 | `data/personality/` | L2（纯统计） | L3（新会话开场注入） | 派生 |
| 任务簿 | `data/debug/tasks.json` | 监控 | L2 / 主人 | 派生 |
| 审计 | `data/audit/<date>.jsonl` | L2 / hooks | 人 | **权威（root append-only）** |
| trace | `data/trace/<date>.jsonl` | L2（`tracer.js`） | 人 | 派生 |
| metrics | `data/metrics.jsonl` | `hupo-sampler.timer`（30s） | 告警 | 派生 |
| 健康 / 上次良好 | `data/.health.json` / `.last-good.json` | L2 / crash-guard | 告警 / 自愈 | 派生 |
| 制品 | `/var/lib/hupo-apps/<appId>/<version>/` + `current` 指针 | 特权口（追加新版本） | L1（独立 origin） | **权威（+hash）** |
| 令牌 | `data/auth.json`(600) / `revoked.json` | L2 | L2 | 权威 |
| 部署日志 | `data/deploy.log` | 部署脚本 | 人 | 权威 |
| 备份 | 本地第二目录（将来对象存储） | `hupo-backup.timer` | 恢复演练 | 副本 |
| 工作区 | `~/hupo-workspace/` | L3 | L3 | 草稿 |
| 整包构建 | `/var/www/hupo/releases/<buildId>` + `current` | `deploy-web.sh` | nginx | 权威 |

**身份字段**（v7 §3.1）：`userId` ｜ `conversationId`(`u_<userId>:c_<name>`) ｜ `messageId`(`u_*`/`m_*`) ｜
`taskId`(`task_*`) ｜ `appId` + `appVersion` ｜ `agentType` ｜ `source`(`owner`/`product`/`derived`/`foreign`)。

---

## 四、状态机总表

| 对象 | 状态 | 转移条件 | 出事时 |
|---|---|---|---|
| **一条消息** | `start → text* → end(completed｜aborted｜failed)` | agent 说的段落；`max-tokens`/中断 ⇒ 必须补一句 + 标 `failed` | **不许把半句当完整回答** |
| **一件任务** | `created → (resumed*) → completed(completed｜interrupted)` | 15s 挪走建；开机对账收口 | 配对不能破（否则"还有件事在处理"永远挂着） |
| **小程序** | `requested → downloading → installed → running ⇄ background → closed ／ failed` | 每态**必有超时与收口** | hash 不符 ⇒ 回退 `last-known-good` + `miniapp/load-failed` |
| **taint** | `clean → tainted →（主人新说一句）→ clean` | 吃到 `derived`/`foreign` 置位；**只在 host 清** | 期间 `bash`/写/改系统/对外发送 全 deny |
| **预算** | `normal → warn(75%) → degraded(90%) → stopped(100%)` | 按计数判据推进 | 不许静默；**必须在开口之前停** |
| **上游熔断** | `closed → open(60s) → half-open → closed` | 60s 内 5 次 upstream 失败 | 对用户说"上游不通"，不是"没做完" |
| **崩溃守护** | `normal ／ degraded` | 5 分钟内 ≥3 次启动且有 `oom-kill` ⇒ degraded | degraded 时**不续做**，只服务对话 |
| **准入** | `accept ／ reject` | `memory.current/max ≥ 0.75` ⇒ reject | 一句人话 + 可重试 + **不建空文件** |

---

## 五、阈值与数字口径总表（**四份子架构照抄这里，不许各写一份**）

### 5.1 终端 UI

| 项 | 值 | 来源 |
|---|---|---|
| 收起高度 | **124 px** | 沿用（量出来的：抓手 14 + 标题行 32 + 输入条） |
| 浮窗边距 | 左右 **10** / 下 **10** / 上 **12** | 沿用 |
| 浮窗圆角 / 气泡圆角 | **18** / **12** | 沿用 |
| 阴影 | 外 `blur 32 · α.45 · offset(0,-6)`；内 `blur 6 · α.35` | 沿用 |
| 档位动画 / 拖拽 | **200ms easeOutCubic** / **0ms（跟手）** | 沿用 |
| 覆盖退让 | 压暗 **α.35** + `scale .98` + 圆角 **12→16**，**180ms** | 新增（推定） |
| 内容限宽 | **760**（>900px 宽时；<b>外壳横跨整宽</b>） | 拍板第 8 条 |
| 触控目标 | **≥44**（视觉 20 + 透明 padding） | 拍板第 8 条 |
| 最大化触发防抖 | **400ms** | 新增（推定） |
| 重连退避 | 不限次，封顶 **8s** | 沿用 |

### 5.2 节奏与续做

| 项 | 值 |
|---|---|
| 挪走阈值 | **15s** |
| 单轮硬收口 | **180s** |
| 续做窗口 / 次数 | **6h** / **≤3 次** |
| 续做并发 | **全局 1**（拍板第 10 条） |
| 同一 task 两次续做间隔 | **≥5  min** |
| 监控语义判断冷却 | **60s** |
| 时效纪律（别破） | 首句 **≤6s**、空窗 **≤8s** |

### 5.3 资源与准入

| 项 | 值 | 备注 |
|---|---|---|
| `MemoryHigh` / `MemoryMax` | **640M** / **1G** | 主单元 |
| `agents.slice` | **700M**（单 agent 软限 **512M**） | 新增 |
| 构建 | 独立 `build.slice`，**2G / CPUQuota 300% / CPUWeight 20** | 新增 |
| 准入阈值 | **`memory.current/max ≥ 0.75` 即拒** | 拍板第 4 条 |
| 实测基线（**非承诺**） | 调度器 68M｜agent 172M｜监控 +172~195M（≤30 min）｜构建 **+846M** | 红队实测 |
| 必删数字 | v6 的"单机 **8–12 人**" | 拍板第 3 条 |
| `StartLimit` | **IntervalSec 300 / Burst 6** | 新增 |
| 内存回收 | agent 空闲 **30 min**；监控改 **review 完即杀** | 拍板（沈简） |

### 5.4 成本

| 项 | 值 |
|---|---|
| 三级 | **75% / 90% / 100%** |
| 计数判据 | steps **12** ｜ toolCalls **30** ｜ searches **6**（每轮） |
| 能力约束 | `maxParallelToolCalls` **20**、`web-search.maxUses` **10**（宿主现值，受上条约束） |
| `/api/debug/analyze` | 删 `force`；每日次数上限 |
| 美元 | **不显示**（DSH 未暴露 usage，`measured:false`） |

### 5.5 运维

| 项 | 值 |
|---|---|
| 磁盘分级 | **80 告警 / 88 清 / 92 拒新重活 / 95 优雅拒绝新会话** |
| journald | `SystemMaxUse=300M`、`MaxRetentionSec=2week`（现状 552M） |
| 告警阈值 | `oom_kill>0` ｜ `memory>0.9×max` 持续 5min ｜ 节流增速 >50% ｜ `disk free<15%` ｜ 证书剩余 <21 天 ｜ 备份连续 2 天失败 |
| 采样 | `hupo-sampler.timer` **30s** |
| 备份 | RPO **1h** / RTO **30min**；`forget` keep-hourly 24 / daily 14 / weekly 8 / monthly 6 |
| 制品保留 | 最近 **3** 版 + `current` 指针 |
| 证书 | 到期 2026-12-11；<21 天告警；每周 `renew --dry-run` |
| 端口 | nginx 只反代 **`/api/` → 127.0.0.1:8091**；其他端口一律不进 server 块 |

---

## 六、事件目录（生产者 → 消费者）

| 事件 | 生产 | 消费 | 进历史？ |
|---|---|---|---|
| `user/echo` | L2 | L1 / 监控 | ✅ |
| `message/start`（含 `source`、`sources`） | L2 | L1 | ✅ |
| `message/text`（`quick` / `deep`） | L2 | L1 | ✅ |
| `message/status` | L2 | L1 | ❌ **不进历史** |
| `message/end`（含最终 `sources`、`reason`） | L2 | L1 / 监控 | ✅ |
| `message/seen` | L1 → L2 | 监控（算感知延迟） | ✅ |
| `task/created` / `task/completed` / `task/resumed` | L2 | L1 / 监控 / 对账 | ✅ |
| `app/installed` / `app/update-available` / `app/error` | L2 | L1 | ✅ |
| `miniapp/load-failed` | L1 → L2 | 监控 | ✅ |
| `client/reload` | L2 | L1 | ❌ **只在现场推** |
| `audit/notice` | L2 | 开发者通道 | ❌ |
| `error` | L2 | L1 | ✅ |
| `dev/step` / `dev/agents` | L2 | 开发者通道 | ❌ |
| `debug/task` | 监控 | 开发者通道 / 主人 | ✅ |

---

## 七、评审指引（怎么读这四份）

1. **先看每份末尾的「需要你审阅的点」**——那是我认为非你拍板不可的地方，其余部分是按已定契约推导出来的。
2. **再看每份末尾的「与 v7 的冲突」**——四路都是独立写的，如果它们发现大架构自相矛盾，会报在那里（我要求它们**不许自行改**，只报）。
3. **数字只看 §五**——子架构里出现的阈值都应当与本页一致；不一致就是文档 bug，我会在合并时修。
4. **红标（不可逆 / 会丢东西）优先审**：
   - 聊天被小程序盖住（Z1）——**不修就等于"点开小程序，聊天消失"**；
   - 制品落站点根——**一次部署连防篡改基线一起被 `rsync --delete` 抹掉，且不报错**；
   - 构建留在主 cgroup——**1 会话 + 1 构建 = 1086MB > 1024MB，必然 OOM（近 7 天实测 4 次）**；
   - `data/` 零备份——**你的全部对话只有一份**。
5. **最后审"仍然悬空的"**：`ARCHITECTURE-v7.md` §15 那一节，尤其 **agent 仍挂免密 sudo**（本轮只解决了"网页借 agent 的手"，没解决"agent 自己的手有多大"）。
