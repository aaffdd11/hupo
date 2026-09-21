# 39 · 权限体系（三人讨论 · 进行中）

> 主人 2026-09-21：*"他的一个权限体系是怎么弄的？你这个找几个工程师讨论一下呗。"*
> 已定架构（同一天拍板）：**容器里跑整套服务** · 中心只做登录/路由/配额 · **每用户一个只绑回环的口** ·
> key 在容器里填。三位工程师独立作答；**下面每条都标了谁说的、我核过没有**。
>
> ⚠️ **第三位（容器内权限）仍在写** —— §五 留位。

---

## 一、🔴 两条最硬的修正（宿主/控制面席）

### ① "只绑回环"是**网络拓扑**，不是准入

> *"本机任何 uid 的进程都能连回环（TCP 无对端身份）。'容器够不着 127.0.0.1' 只在容器不在宿主 netns 时成立
> ——`--network=host`、pasta 转发、或以租户 uid 跑在宿主 netns 的进程（**linger 的用户单元**、rootlessport）
> 都能连**所有**租户的口。"*

⇒ 每口一个令牌**必须有**（挡别的 uid），但**挡不住 `deploy`** —— **助手就是 `deploy`**：0600 的令牌照读，
`/proc/<pid>/environ` 也能读（这一条我实测过：56 条环境变量）。
⇒ **更好的形态：反向域套接字** —— **容器主动连宿主**上的一条 UDS，宿主侧用 `SO_PEERCRED` 拿到对端的
**宿主 uid（2001/2002）**，**准入交给内核**，而且**网络上一个口都不开**。

### ② 钥匙交给谁（"新号当场开容器"可以做到、而助手不拿 root）

| 动作 | 形态 | 交给 `deploy` 的是什么 |
|---|---|---|
| 起停 | `hupo-tenant@.service`（`User=%i`）+ polkit 固定实例名 | *"能停别人的租户"* |
| ⚠️ 单元与镜像 tar | **必须 `root:root` 并入 strict** | 否则它们落在 `deploy` 可写路径 = **hupo-a 的 root**（等于逃出盒子） |
| 建 / 删用户与卷 | **只能 root**（`useradd`/subuid/0700 卷/`podman load`） | ⚠️ `deploy` **读不到租户 0700 的家** ⇒ **每租户 load 也只能由主人那批做** |

⇒ **"新号当场自动开容器"的正解：预建池** —— 主人**一次签 N 个**（建用户 + subuid + 卷 + linger + load 镜像），
服务只 `systemctl start hupo-tenant@<空闲那个>`。**池内当场自动、助手手里没有 root。**
代价：**池满了要主人**（而且**要如实说"满了"**），池也会被恶意注册**耗尽**。

---

## 二、`deploy` 的边界：**不该读租户卷**（哪些地方会偷偷需要）

| # | 会偷越界的地方 | 怎么办 |
|---|---|---|
| 1 | `status.json` 聚合（重启脚本要看"忙不忙"） | **改成租户上报**（中心只存聚合值） |
| 2 | `serve.log` / `main.jsonl`（排障与"接记忆"很诱人） | 中心**不许**读租户的日志与时间线 |
| 3 | `prune sessions/`（**今天由 `serve.js` 开机以 `deploy` 清**） | ⚠️ 多租户下**没权限 ⇒ 静默失败、盘只涨** ⇒ 交**租户侧 timer** |
| 4 | 备份 / 导出 / 注销 | **只能主人 `sudo`** |
| 5 | `--fresh` | 同上 |

⚠️ **开发期 sudo 白名单绝不许含**：`-u hupo-*` · `podman` · `systemctl *hupo-tenant*`。

---

## 三、重启姿势（现在会**切掉所有人的话**）

把 **busy / `turn-status` 搬进租户** ⇒
① **中心重启零切话** ② 每租户单元**独立重启**，只切乙 ③ 中心用 **socket activation** 保住监听 fd
④ `restart-core.sh` 只等本租户，加 `--tenant`。

---

## 四、判据（**可执行 + 负向对照**）

| # | 判据 | 负向对照 |
|---|---|---|
| 1 | 每口只 `127.0.0.1`、没有 `0.0.0.0` | **重绑 `0.0.0.0` ⇒ 容器经宿主 LAN IP 必通**（证明"绑错就是暴露"） |
| 2 | 无凭证直连 ⇒ 拒；有凭证 ⇒ 通；**甲的凭证连乙的口 ⇒ 拒** | 否则"服务没起"会被当成"安全" |
| 3 | `sudo -u hupo-b cat 甲卷` ⇒ `EACCES` | 读**自己**的必成功；故意 `chmod 755` 甲 ⇒ **变可读**（证明判的是权限位，不是路径不存在） |
| 4 | 甲**慢轮时重启中心** ⇒ 整轮完整 | 负向：中心持有轮 ⇒ 被切 |
| 5 | 甲慢轮时重启**乙** ⇒ 甲不受影响 | —— |

⚠️ **`scripts/` 现在是 `report`**（助手能改）⇒ **判据 1/4/5 应入 `strict`**（"不能由被审者写与跑"）。

---

## 四·补、🔴 另外两条"最容易做成形式主义"的（分别来自两位）

* **威胁模型席**：*"`V4` 只查**存没存**、不查**发没发**"* —— 盒子里是 root、网络又够得着宿主，
  ⇒ **key 可以被读出来并发出去，而 V4 照样绿**。
  ⇒ 🔴 **它与主人刚拍板的形状正面冲突**：主人要"key 填在容器里"，而 **V4 说"容器里不许有秘密"**。
  **只有主人能裁**：要么**改 V4 的适用范围**（它当年是为"agent 容器"写的；现在容器 = 用户自己的世界，
  key 是**用户自己的**），要么走代理。**不许换路径假装过。**
* **宿主/控制面席**：⚠️ **linger 引出的宿主 netns 面**——
  `/run/user/2001` 在**宿主**上，如果把它挂进容器、或容器的 root 能写 `~/.config/systemd/user`，
  **租户就能让宿主上的 `hupo-a` 进程开机自起** ⇒ "容器够不着回环"整条假设作废。
  另一条：**`userId → 用户名` 必须服务端生成**，**不许从手机号派生**（否则路径注入）。

---

## 五、容器内权限（第三位）

### 5.1 🔴 结论：**盒内必须分两个身份**

> *"盒内必须分身份——**服务/网页终端跑 root，agent 的手跑非 root**。
> 原因是 userns 的容器 root 有 `CAP_DAC_OVERRIDE`：**agent = uid 0 时，任何权限位都拦不住它读 key**，
> §2.2 规则 1 就名存实亡。而'agent 能装包/改配置'与'agent 读不到自己的 key'**在同一 uid 下不可兼得**。"*

⇒ 这是一条**取舍**，只有主人能选（见 §七）。

### 5.2 他给的布局（具体到路径与权限位）

| 东西 | 谁 / 在哪 / 什么权限 |
|---|---|
| 容器 root（uid 0 → 宿主 2001） | 跑**服务**与**网页终端** |
| 宿主卷 | `/home/hupo-a/tenant` `2001:2001 0700` |
| **agent** | **另建 uid 1000**，`cwd=/data/main` |
| 🔴 **key** | `/run/hupo/creds.yaml`（**root 0600 · tmpfs · 不在 `/data` 也不在 `/home`**），由一个 **root 小代理**持有；**agent 只拿到 UDS（0660）+ `base_url`** ⇒ **明文永不进入 dsh 能读的范围** |
| `/data` | root `0711`；`main` · `workspaces/*` · `hupo/*` 属 **1000**、`0700`（**与主目录平行**） |
| `DSH_HOME` | `/data/dsh/<userId>`（N21：**路径带 userId**） |
| 开机自动读的（人格/能力层/patch/MCP） | **root `0555` 且 `:ro`** ⇒ `.bashrc` / `.dsh` 那类持久化**无处可落** |

### 5.3 ⚠️ 他审了**我刚造的那个镜像**，说它已经违反上面这条

> *"另一个 agent 刚造的 `localhost/hupo-tenant:local` 里 `/etc/passwd` 是 `root:x:0:0:root:/data`，
> 服务以 uid0 跑、`cwd=/data/hupo-workspace`，且镜像/启动脚本**没有任何** `--cap-drop` /
> `--security-opt` / `--pids-limit` / `--memory` ⇒ 按上面这条，**key 与 workspace 同树下、而 agent=root，
> 规则 1 已经名存实亡**，需要改。"*

✅ **这条我认** —— 初步镜像只证明了"整套服务装得进容器"，**权限那一层一点都还没做**。
（他另外说的"注意沿用 `/data/main` 的布局"也对：我现在用的是 `HUPO_AGENT_CWD=/data/hupo-workspace`，
不是 `§2.1` 的 `/data/main`。）

**现在改到哪了**（2026-09-21 晚核过，`scripts/build-tenant-image.sh`）：

| 他点的 | 现在 |
|---|---|
| `/etc/passwd` 只有 root | ✅ **已加** `agent:x:1000:1000:agent:/data/main`（`/etc/group` 同） |
| `cwd` 不是 `/data/main` | ✅ 已改 `HUPO_AGENT_CWD=/data/main` |
| 没有内核参数 | ✅ 运行示例已带 `--security-opt=no-new-privileges` · `--cap-drop=ALL` + 按需那组 · `--pids-limit` · `--memory`/`--memory-swap` |
| **agent 的手真的以 uid 1000 跑** | ❌ **还没** —— 镜像里**只是有了这个身份**，`entry.mjs` 仍是 root，**`dsh` 本体也还没装进去** ⇒ *"身份已建、手还没换"* |
| **key 由 root 小代理持有**（`/run/hupo/creds.yaml`） | ❌ **还没** —— 现在盒内**根本没有 key 那条路** |

⇒ ⚠️ **别把"镜像里有 `agent:x:1000`"读成"边界已经在了"**：边界成立的判据是 §5.6 判据 1（**已实测通过，但测的是"布局能不能挡住"**），
而不是"`/etc/passwd` 里有一行"。**真正的手换过去 + key 那个代理落地，才算这两条闭合。**

### 5.4 该收的内核能力（具体参数 + 会不会弄残用户）

| 参数 | 为什么 | 会不会弄残 |
|---|---|---|
| `--security-opt=no-new-privileges` | 挡 setuid 提权 | ⚠️ 盒内**没有 sudo**（**故意的**：agent 不能自救） |
| `--cap-drop=ALL` + 只加 dpkg/apt 那组（`CHOWN` `DAC_OVERRIDE` `FOWNER` `FSETID` `SETUID` `SETGID` `SETFCAP` `MKNOD` `KILL` `SYS_CHROOT`） | 按需给 | 去掉 `NET_RAW` ⇒ 盒内 **ping 不通**；去掉 `SYS_ADMIN` ⇒ 盒内**不能 mount/套娃** |
| seccomp | 用 **podman 默认** | **不要 `unconfined`、别手写白名单**（写坏 = 可靠性事故） |
| ❌ **不要 `--read-only`** | apt 必须写 `/usr`、`/var/lib/dpkg` | **直接弄残**（要治的是**持久化**，不是整根只读） |
| ✅ **必给** `--pids-limit` / `--memory` / `--memory-swap` | 否则盒内 **fork 炸弹是最便宜的"弄坏宿主"路径** | 大构建会撞限 ⇒ 要给**一句人话** |
| V3（元数据地址） | 无根网络**默认就关掉了**（实测不通） | 保留正对照即可 |
| ⚠️ "够得着宿主 `0.0.0.0`" | **在容器里关不掉**（实测：经宿主 LAN 地址可达 `:8000`，而宿主 `127.0.0.1:8020` 不可达） | ⇒ **正解在宿主侧**：自己的服务只绑 `127.0.0.1` + 防火墙丢"租户→宿主"；**别用 `--network=none`**（会把模型/web 一起断） |

### 5.5 边界：他能弄坏自己那台（**允许，不防**）

按 §2.3：**只需防三件** —— ① 出盒子（V1）② 碰别的租户（subuid + 0700 卷）③ 碰宿主/控制面（`127.0.0.1` + 防火墙 + UDS）。
"他把自己那台的服务杀了"**不靠防**，靠宿主 systemd 单元 `Restart=on-failure` + **如实说"没起来"**；
数据在卷里 ⇒ **容器必须无状态、可重建**。

### 5.6 判据（**都带负向对照**）

| # | 判据 | 负向对照 |
|---|---|---|
| 1 | uid 1000 读 `/run/hupo/creds.yaml` ⇒ **`Permission denied`**（⚠️ **不许是 `No such file`**） | root 读得出内容；且 uid 1000 **写 `/data/main/x` 成功**（证明壳子能用） |
| 2 | uid 1000 写 `/etc/hupo/*.yml`、`/root/.bashrc` **失败** | 写 `/data/main/x` 成功；**再重启容器比 sha256 ⇒ 自动读的那几份必须逐字节不变** |
| 3 | 盒内放一个 setuid root 的副本，uid 1000 执行 ⇒ **`id` ≠ 0** | **去掉 `no-new-privileges` ⇒ 是 0**（证明这条闸真的在起作用） |
| 4 | V1/V1b/V3/V4 照跑 | ⚠️ **V4 因"key 在盒里"必须重划范围**（见 §七②） |
| 5 | 盒内连宿主 `:22` `:80` `:6001` `:8000` **全败** | 模型口 / `registry.npmjs.org` **通**（证明不是"网死了"） |

#### ✅ 判据 1 已实测通过（2026-09-21，`localhost/hupo-tenant:local`）

在**真容器**里跑的，不是读代码推的 —— 两个容器共享一个卷，`--user` 换身份（镜像是 `scratch + node`，**没有 shell**，所以用 `/bin/node -e`）：

| 步骤 | 动作 | 实测结果 |
|---|---|---|
| ① | 容器 **root** 写 `creds.yaml`，`chmod 600` | `我是 uid=0` · `目录: creds.yaml=600 public.txt=644` |
| ② | root 读它 | ✅ 读到了内容（服务侧拿得到） |
| ③ | 容器 **uid 1000** 读同一份 | ✅ **`EACCES: permission denied, open '/run/hupo/creds.yaml'`** ← **正是要的这个失败方式**（**不是 `ENOENT`**） |
| ④ | 同目录下 **0644** 那个，uid 1000 读 | ✅ **读到了** ⇒ 挡住它的是**权限位**，不是路径拼错、也不是挂载没进去 |
| ⑤ | 宿主侧看属主 | `-rw------- 1 1001 1001 creds.yaml`（无根容器 root→`deploy`） |

⚠️ **这条测的是"这套布局挡不挡得住"，不是"产品已经这么跑了"**：测的时候 `creds.yaml` 是我手动放的，
**root 小代理 + UDS 那条路还没写**（§5.3 末表）。**边界成立 ≠ 已经接上。**


### 5.7 他点出别人漏的（两条很硬）

* **宿主/控制面席漏**：**挂载表就是边界** —— 一条 mount 拼错 = **乙的卷进了甲的盒子**，容器白做；
  ⇒ **mount 表与代理 ACL 必须 `strict`**（助手能改的判据不算判据）；**`sudo -u … podman exec` 那条路本身就是边界**，
  **网页终端绝不许以 `deploy` 开**；**备份/注销那六处不齐 ⇒ key 在"注销"之后还活着**。
* **威胁模型席漏**：判据要"**重启后比 sha256**"而不是"cat 一次失败"（**威胁是持久化**）；
  **同 uid 读得到 `/proc/<pid>/environ`**（实测 56 条）⇒ **秘密绝不许走 env**；
  **盒内 agent 与网页终端若同 uid = 等于没分**；漏 `--pids-limit`/`--memory` ⇒ **fork 炸弹是最便宜的路径**。

---

## 六、DSH 自己是怎么做到"服务拿得到 key、agent 看不见明文"的

> 主人 2026-09-21 问：*"DeepSeek Harness 是怎么解决'服务能拿到 API key 但 agent 看不到明文'的？"*

⇒ 我去把它那颗安装树读了（`~/.nvm/.../node_modules/@deepseek-ai/dsh/`）。**结论：它不是靠"看不见"，是靠"默认不在场"。**
**而且 agent 真要去找，它一点都拦不住** —— 这正好证明我们盒内那条 uid 边界**不是多余，是 DSH 自己没有的那一件**。

### 6.1 它用的四件（都有出处）

| # | 机制 | 在哪 | 它到底做了什么 |
|---|---|---|---|
| 1 | **存"引用"不存值** | `dsh-credentials/lib`：`REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`，叫 `credentialRef` | 配置里那一格（`connection.apiKeyEnv`）写的是**名字**（如 `DEEPSEEK_API_KEY`），不是 key。模块原话：*"configuration surfaces describe a reference without ever seeing its value"* |
| 2 | **到用时才解析，且在 provider 内部** | `dsh-llm-deepseek/lib`：`const ref = connection.apiKeyEnv; … await credentials.resolve(ref)` | 明文只在**发起模型调用那一刻**进适配器。`resolve` 之前，谁都只有一个名字 |
| 3 | **问"配没配"只回布尔** | `dsh-api-settings-controller` 的 `credentials.describe` 结果 schema：`{configured: boolean, source?: string, writable: boolean}` | 网页 Models 页能显示"已配置"，**永远拿不到值** ⇒ 界面这条路也不漏 |
| 4 | **落盘 0600 + 启动时拒绝** | `dsh-credentials-local/lib`：读 `$DSH_HOME/.credentials.yaml`，mode 有 group/other 位就抛 `is readable beyond its owner … run "chmod 600"` | 挡**别的用户**。本机实测：`600 deploy:deploy`，223 字节 |

另外两件辅助的：**工具子进程环境是洗过的**（`dsh-subprocess-local` 的 `scrubbedParentEnv()` 剥掉 `/KEY|PASSWORD|SECRET|TOKEN/i` 和 `DSH_*`）；**秘密也不走 env**。

### 6.2 🔴 但"agent 看不见"这一半，DSH **没有**做（三条实测）

| # | 查什么 | 结果 |
|---|---|---|
| 1 | 工具层有没有"敏感路径黑名单" | ❌ **没有** —— 全树扫 `dsh-tool-*` / `dsh-fs*` / `dsh-file-*`，**零处**提到凭据文件（唯一命中的 `dsh-tool-cordis` 是另一回事） |
| 2 | 沙箱限不限**读** | ❌ **不限** —— `dsh-sandbox-local` 的 Landlock 档是 `readOnly: ["/"]` + `readWrite: ["/dev/null","/tmp",workspaceRoot]`：**整个文件系统被授予只读**。三种模式里最严的也只是"哪儿都不能写"，**读从来没被限过** |
| 3 | 同 uid 能不能读自己的 0600 | ✅ **读得到** —— 实测：`chmod 600` 的文件，属主自己 `head` 就出内容 |

⇒ **根因**：DSH 里 **agent 和 harness 是同一个 uid**。`0600` 挡的是"别人"，**挡不住属主自己**；
而 Landlock 那套的设计目标是**防误写/防炸宿主**，不是把 agent 当对手。
**它的威胁模型是"别的用户、别的插件、别的配置面"，不是"agent 会主动翻"。**

⚠️ 这条别读成"DSH 做得差"：**它的前提是"agent 是可信的"**（本机是主人自己的助手）。
而我们要做的是**多租户**：agent 伺候的是**别人**，前提不成立了 ⇒ 那一半必须我们自己补。

### 6.3 ⇒ 对我们的意义（**为什么盒内那条 uid 边界是必需品**）

我们 §5.2 那套不是"另起一套"，而是**同样的第 1 条 + DSH 缺的那一件**：

| DSH 有 | 我们对应 | 我们多出来的 |
|---|---|---|
| 引用不存值 | 注入的是 `base_url`，**不是 key** | —— |
| 用时才解析 | **root 小代理**持有明文，agent 拿 UDS + `base_url` | —— |
| `describe` 只回布尔 | agent 侧**不需要知道"配没配"** | —— |
| **0600 挡别人** | `/run/hupo/creds.yaml` root `0600` + tmpfs | 🔴 **`agent` 是 uid 1000、不是 uid 0** ⇒ 这条终于**挡得住 agent 自己** |

⇒ **一句话**：DSH 靠"引用"让秘密**不默认在场**；**"不默认在场" ≠ "拿不走"**。
租户的 agent 是**不可信**的（他会照着别人的话去翻文件），所以**必须再加一道 uid**。
⇒ 这也解释了 §5.1 那条取舍为什么**没有第二条路**：`CAP_DAC_OVERRIDE` 之下，**agent = uid 0 时任何权限位都是装饰**。

---

## 七、🔴 要主人定的（权限体系这一轮）

| # | 问题 | 选项 | 备注 |
|---|---|---|---|
| ① | **"agent 能装包" vs "agent 读不到自己的 key"** | (甲) 代理注入（key 不进 agent 可读范围）· (乙) 承认读得到、**改 §2.2 的口径** | **两者在同一 uid 下不可兼得** |
| ② | **`V4` 字面**（`grep -rl "sk-" /data /home` = 0）与 **"key 在盒里"** 直接冲突 | **重划范围**（要你签）· 走代理 | ⚠️ **不许换路径骗过**（挂到 `/data`、`/home` 之外就说"过了"） |
| ③ | **rootfs 要不要可写** | 要（apt 能装）· 不要（只读根） | 要可写 ⇒ **不能 `--read-only`** |
| ④ | **盒内 agent 的 uid 是否固定** | 固定（定卷属主与 N21 路径）· 不固定 | 不固定 ⇒ N21 的路径会漂 |

