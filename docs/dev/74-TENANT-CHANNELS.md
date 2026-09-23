# 74 · 盒子里那两条本地通道：`apps.sock` / `ledger.sock` 的**属主**（真机事故）

> **一句话**：盒子里的服务是 **root** 起的、干活的 agent 是 **uid 1000**，而那两条口按
> "进程自己的 uid + 0600" 建出来 ⇒ **属主 root ⇒ agent 连不上（EACCES）**
> ⇒ **租户在对话里造小程序、以及记账，从来没通过。** 主人自己那一格看不出来
> （那边服务与 agent 同一个 uid）。修法：建好之后**交给 agent 那个 uid**（准入仍是 0600）。

---

## 一、怎么发现的（主人的原话）

主人（`19145526557` = `u2` = `hupo-b`）在对话里要一个天气小程序，agent 回：

> 「小程序这个口现在连不上——我放了两次，都被同一个错挡回来（**EACCES**，连接没通），
> 所以它还没到你桌面上。页面本身我做好了，先存在 `/data/main/city-weather/` 里当备份……」

同一段时间它还说："跑命令那条路还是不通（沙箱后端起不来）"（**那是另一件事**，见 §五）。

## 二、查下去是什么（每一步都有取证）

| # | 事实 | 怎么取的 |
|---|---|---|
| 1 | 盒子里 `/data/apps.sock`、`/data/ledger.sock` 都是 **`hupo-b`(2002) `0600`** | `sudo stat` |
| 2 | 盒子里那个 agent 跑在 **uid 1000** | `ps -eo uid,pid,args` → `/bin/dsh` 那行是 **297607**（= 容器内 1000 映射出来的子 uid），而 `/app/entry.mjs` 是 **2002**（= 容器内 root） |
| 3 | 以 **uid 1000** 连那两条口 ⇒ **EACCES** | `podman exec --user 1000 … node -e 'net.connect(…)'`（**阴性对照**：连一个不存在的口 ⇒ `ENOENT`，证明探针分得开） |
| 4 | 所以不是"没做"，是**做完连不上** | 上面三条 |

⇒ **为什么闸全绿也没抓住**：主人自己那一格（`owner`）里，服务与 agent 是**同一个 uid**，
`0600` 同 uid 自然通。**这是一条只有租户才犯的病** —— 与"闸打在替代的那一侧"是同一族。

## 三、修法（一处规则 + 两个调用点）

- 新增 `src/socket-owner.mjs`（**规则只住这一处**）：
  `agentOwnerFromEnv()` · `shouldHandToAgent()` · `handSocketToAgent()`。
  宿主进程**没有** `HUPO_AGENT_UID/HUPO_AGENT_GID` ⇒ **空操作**；
  盒子里（root + 配了）⇒ `chown` 到 `1000:1000`；`uid=0` 当"没配"，**绝不交给 root**。
- `src/apps-socket.js` · `src/ledger-socket.js`：`'listening'` 里 **chmod 0600 之后**再
  `handSocketToAgent()`（顺序照 `entry.mjs` 那条实测经验：先 chmod 再 chown）。
- ⚠️ **准入一个字都没放宽**：仍是 **0600**，只是属主对了。拿 `0666` 当修法 = 把准入拆了。
- ⚠️ `chown` 失败**不抛**（服务不该因为这一下起不来），但**必须留一句能查的话**。

## 四、判据

`scripts/check-tenant-channels.sh`（新 · 9 条，每条都有负向对照）：

```
bash scripts/check-tenant-channels.sh              # 规则与源码那一半（不需要 root）
sudo bash scripts/check-tenant-channels.sh --live  # 真机器：盒子里以 agent 的 uid 连那两条口
```

| 判据 | 钉什么 | 负向对照 |
|---|---|---|
| ① | `chown` 只住在 `socket-owner.mjs` 与 `entry.mjs` | 跑到别处 ⇒ 红 |
| ② | 两条口建好**之后都调了** `handSocketToAgent` | 只留 `import` 不调 ⇒ 红 |
| ③ | 宿主上（没有那两条 env）**一个字节都不动** | chown 了一次 ⇒ 红 |
| ④ | 盒子里交给 `1000:1000`；`uid=0` 当"没配"；非 root 不动 | 交给 root ⇒ 红 |
| ⑤ | chown 失败**不抛但要说一句** | 静默 ⇒ 红 |
| ⑥ | `--live`：以**它自己的 agent uid** 连两条口 ⇒ OK | 不存在的口 ⇒ 要 `ENOENT` |
| ⑦ | `--live`：口的属主就是 agent | 属主不是它 ⇒ 红 |
| ⑧ | `--live`：权限仍是 `0600` | 被放宽 ⇒ 红 |
| ⑨ | `--live`：**真跑一遍那条 MCP 工具**（`app_list`） | 只回执不成功 ⇒ 红 |

`test/socket-owner.test.js`（+6）钉纯规则那一半（同一套正/负对照）。

### 4.1 真机读数（2026-09-24）

```
产品层：fc573fb1b3de → bf611d9c4c2c（--verify 过：起来后自报指纹 = 它自己）
翻转后两个盒子自己重开（宿主 sweep），两条口的属主：hupo-b(2002) → 297607(=uid 1000)
以 uid 1000 连：/data/apps.sock → OK · /data/ledger.sock → OK · /data/不存在.sock → ENOENT
跑真的 MCP 工具（app_list）⇒ {"isError":false,"text":"他现在还没有自己的小程序。"}
gate：portable 6/6 · --live 10/10（两个盒子，含阴性对照）
```

⚠️ 顺手确认了一件**以前没说清**的事：**静态映射的租户，他的"世界"在盒子里**（他的
`main.jsonl` 在 `/data`），而中心服务 `data/users/<u>/` 下那一份是**影子**
（`hupo/apps` 里那几个探针制品主人在桌面上**从来没见过**）。⇒ `server.js` 里
`/api/app-ask` 那道闸读的是**中心那一份**（`worldFor(claim.sub).apps`），
而真正的制品在盒子里 —— **同一族"两份东西打架"，记在 §六（新账 #71）**。

## 五、⚠️ **还没修的那一条**：盒子里跑不了命令（缺 `bubblewrap`）

同一条会话里，它自己把原因说清楚了（我从盒子里的 DSH 会话文件解出来读的）：

> 「沙箱后端起不来，机器上缺 **bubblewrap** 这类东西；想用更宽的权限重试，
> 需要有地方让你点确认，**这里没有批准通道**。」
> 「沙箱后端起不来（缺 bubblewrap / Landlock），workspace-write 下任何命令都被直接拒。」

⇒ 这是**镜像里缺一件东西**（宿主的沙箱后端起不来）+ **产品里没有"点确认"的通道**。
两件都要**主人拍板**（改的是部署期）：① 把 `bubblewrap` 装进租户镜像（**推荐**，命令照旧只能碰
它自己那格）；② 或把盒子的沙箱模式放宽到 `danger-full-access`（**等于它能在盒子里到处跑** ——
钥匙那条 `EACCES` 不受影响，但那不是"没代价"）；③ 或者接一条批准通道（大）。
⇒ 已作为 **#70** 记进 `63-OWNER-DECISIONS.md` §三与 `00-PROGRESS.md` §六。

## 六、这件事本身查出来的两条新账

| # | 欠什么 | 为什么现在才看见 |
|---|---|---|
| **#70** | 盒子里**跑不了命令**（缺 `bubblewrap`；也没有批准通道） | 以前只在宿主上跑过命令（宿主有沙箱后端）⇒ "只有租户才犯的病" |
| **#71** | **中心的影子世界**：`/api/app-ask` 的闸读中心那份 `apps`，而真制品在盒子里 | 静态映射的租户是"世界在盒子、中心只转发"，两处的岔口以前没验过 |
