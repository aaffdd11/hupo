# 开机自启：三个 systemd **用户**单元（P2-7 · 2026-09-24 草案 · **2026-09-25 已装**）

> ✅ **已装并启用**（2026-09-25，主人"全部签字"）：三个单元在 `~/.config/systemd/user/`，
> `hupo-core` / `hupo-frpc-w` / `hupo-frpc-apps` 都是 `enabled`，`linger` 早就是 `yes`。
> ⇒ **现在服务与两条隧道活在 `hupo-*.service` 的 cgroup 里**（不再是 `dsh-subprocess-*.scope`）。
>
> ✅ **2026-09-25：装完留下的两个口子已经补好**（`scripts/restart-core.sh` 现在**认得单元**）：
> 单元在跑 ⇒ 它走 `systemctl --user stop/start hupo-core`（**只点这个具体单元**），
> 不再看、也不再写 `serve.pid`；真指纹用 drop-in
> `~/.config/systemd/user/hupo-core.service.d/10-hupo-build-id.conf` 递进去。
> ⇒ **单元在跑的时候重启照旧是 `systemctl --user restart hupo-core`**（等价），
> 也可以照跑 `scripts/restart-core.sh`（它自己认路）。**两条路的口径全在 §六。**
>
> ✅ **`HUPO_BUILD_ID` 现在是真的**：drop-in 里存着从 `web/index.html` 现推的真指纹
> ⇒ 线上横幅与 `/api/version` 报真指纹（**不再是 `dev`**；`dev` 只在真的读不到产物时出现）。

## 一、它解决什么

> ⚠️ 这一节讲的是**当初为什么要装**（2026-09-24 落笔）；**三个单元现在都已经装上了**（见本节顶部 ✅）。

装之前，服务与两条隧道都是**手动起的**（`scripts/restart-core.sh` / `scripts/start-tunnels.sh`，
它们顶上各自写着"**这个脚本不解决开机自启**"）。⇒ **机器一重启＝整站 502**、公网握手全断，
得你上机器手动拉一次。三个单元就是拿来自启的。

| 单元 | 起什么 | 起在哪 |
|---|---|---|
| `hupo-core.service` | 调度器 `serve.js`（127.0.0.1:8020） | 仓库 `v2/services/core` |
| `hupo-frpc-w.service` | 隧道 `frpc-w`（`w.stalkerai.cn` 那一跳） | `~/.local/frp` |
| `hupo-frpc-apps.service` | 隧道 `frpc-apps`（制品口那条） | `~/.local/frp` |

三个文件都过了 `systemd-analyze verify`（2026-09-24 实测：**无输出**＝没有语法/依赖问题）。

## 二、当时怎么接管的（**2026-09-25 已做完 · 留档**）

> 实际执行时 **② 走的是 `restart-core.sh` §1 那一套**（`serve.pid` → `SIGTERM` → 最多等 10 秒 →
> 必要时 `SIGKILL` → `rm serve.pid`），不是下面这行简写；**④ 的 `linger` 早就是 `yes`**（没动它）。

```bash
# ① 装进用户单元目录
mkdir -p ~/.config/systemd/user
cp /home/deploy/proj/hupo/deploy/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload

# ② 🔴 **先停旧的**（restart-core.sh 起的那个）—— 否则两个抢 8020
#    先看它在不在（按 PID 文件走，**不许 pkill -f**：那会把自己也杀掉，本仓库点过名）
cd /home/deploy/proj/hupo/v2/services/core && [ -f serve.pid ] && kill "$(cat serve.pid)" && sleep 2

# ③ 起三个单元，并让它们开机自启
systemctl --user enable --now hupo-core hupo-frpc-w hupo-frpc-apps

# ④ 🔴 **让"没登录"也能自启**（用户单元默认要有人登录才跑）
sudo loginctl enable-linger deploy
```

## 三、判据（P2-7 原本要的那条 ＋ 两条加严）

```bash
systemctl --user list-unit-files | grep -E 'hupo-(core|frpc)'   # 三条都在、都是 enabled
systemctl --user status hupo-core --no-pager | head -5           # active (running)
curl -s -o /dev/null -w '%{http_code}\n' https://w.stalkerai.cn/api/version   # 200
pgrep -af src/serve.js                                            # **只该剩一个**（systemd 那一个）
```
⚠️ 最后一条很重要：**只该剩一个**。剩两个＝旧那个没停干净（两个抢端口，谁先拿到看运气）。

真正的判据（P2-7 原话）：**机器重启之后公网仍然 200**。那一步只有你能做（要重启这台机器）。

## 四、怎么退回去（**一次两条**）

```bash
systemctl --user disable --now hupo-core hupo-frpc-w hupo-frpc-apps
bash /home/deploy/proj/hupo/scripts/restart-core.sh && bash /home/deploy/proj/hupo/scripts/start-tunnels.sh
```

退回之后**确认只该剩一个** `serve.js`：`pgrep -af src/serve.js`（两个＝抢 8020）。
想连单元文件也删掉（不是必须，留着也不碍事）：
`rm ~/.config/systemd/user/hupo-*.service && systemctl --user daemon-reload`。

⚠️ 退回之后 `systemctl --user is-active hupo-core` 是**假** ⇒ `scripts/restart-core.sh`
**自己回退到手动那条路**（按 `serve.pid` 停、自己起、写 `serve.pid`）——
不用改脚本、也不用加参数（判据见 §六·1）。

## 五、三个坑（都写在这儿，别踩）

1. 🔴 **不许用 `systemctl --user stop` 去清 DSH 的 scope**（`AGENTS.md` §一）：
   线上服务原来就活在那种 cgroup 里，随手一停可能**把别的会话一起杀掉**。
   这个单元接管之后就没这回事了 —— 但那之前别去碰那些 scope。
2. ⚠️ **`~/.local/frp/*.toml` 里有 secretKey（0600）**：单元只**读**它，
   `systemctl status` 也不会打印 env ⇒ 不泄密。**别**把 toml 内容贴进任何日志/文档。
3. ⚠️ **改了 `docs/handbook/**` / 人格 / 这个能力层之后**要先重建开机清单再重启
   （否则 `serve.js` 会**拒绝启动** —— 单元的 `Restart=always` 会一直撞那面墙，
   日志里刷 `✗ 起不来：`）。重建命令见 `docs/dev/00-PROGRESS.md` §九。

## 六、两条路：**认单元 / 手动**（2026-09-25 修好；原来那两个口子的留档见 §六·5）

`scripts/restart-core.sh` 是**唯一**的重启入口（`scripts/deploy-web-v2.sh` 最后也是调它，
公网指纹校验就打在它后面）。它按**一条判据**分两条路，两条路**都必须能跑**：

```bash
systemctl --user is-active --quiet hupo-core   # 真 ⇒ 走 systemd 那条路 ｜ 假 ⇒ 走手动那条路
```

### 1. 判据与两条路各做什么

| | **单元在跑**（`is-active` 真） | **单元没在跑**（`is-active` 假） |
|---|---|---|
| 怎么停 | `systemctl --user stop hupo-core`（**只点这个具体单元**） | `serve.pid` → `SIGTERM` → 最多 10 秒 → 必要时 `SIGKILL` |
| 怎么起 | `systemctl --user start hupo-core` | `HUPO_BUILD_ID=… node src/serve.js &` + **写 `serve.pid`** |
| `serve.pid` | **不读也不写**（只顺手 `rm -f` 清掉手动时代留下的那个） | 照旧读 / 写 |
| 真指纹怎么递 | **drop-in 文件** + `daemon-reload`（见 §六·3） | 进程环境 `HUPO_BUILD_ID=`（见 §六·3） |
| 什么时候会走这条 | 现在（单元 `enabled` ＋ `linger`） | §四 退回之后 / 开发机上 / 单元被停掉时 |

🔴 两条路**都不许**写裸 `systemctl --user stop`（不带单元）：那会顺手清掉 DSH 的 scope
（`AGENTS.md` §一，本项目真出过事）。也不许 `daemon-reexec`、不许 kill dsh 的 scope。
systemd 那条路用 **stop/start 同一个单元**（不是 restart），理由见 §六·2。

⇒ **判据怎么覆盖两种情况**：单元在跑时跑一次脚本，看它说「线上服务归系统单元管」、
起来的是**单元**（`systemctl --user show -p MainPID` 那个 PID 在跑）、
`pgrep -af src/serve.js` **只剩一个**、公网 `/api/version` 200；
再 `systemctl --user stop hupo-core` 让它退回手动路，跑一次脚本，看它**写好 `serve.pid`**
且服务起来了（验完必须恢复成单元在跑）。

### 2. `--fresh` 在两条路里的口径（**一样**）

`--fresh` 删的是 **`data/main.jsonl`**（"说过的话"），**不是清日志**；`serve.log` 两条路**都不删**。

- **手动路**：停旧进程 → `rm -f data/main.jsonl` → 再起。
- **systemd 路**：`systemctl --user stop hupo-core` → `rm -f data/main.jsonl` → `start`。
  ⚠️ 这里**故意用 stop/start 而不是 `restart`**：删文件必须落在"停了之后、起之前"，
  否则删掉的只是目录项，而服务手上那个句柄还在往旧 inode 写（等于没清）。

### 3. 真指纹（`HUPO_BUILD_ID`）怎么递、怎么改

真指纹 = **浏览器真正拿到的那一版**：从 `web/index.html` 引的
`flutter_bootstrap.<指纹>.js` 里现推（推不出才退回落 `web/main.<指纹>.dart.js`，都读不到才是 `dev`）。
`scripts/deploy-web-v2.sh` 会**显式**给（`HUPO_BUILD_ID="$STAMP"`），别的时候脚本自己现推。

- **手动路**：起进程时直接把 `HUPO_BUILD_ID` 放进环境。
- **systemd 路**：systemd **不做命令替换**，`Environment=` 只能来自文件 ⇒ 脚本每次重写 **drop-in**
  `~/.config/systemd/user/hupo-core.service.d/10-hupo-build-id.conf`：
  ```ini
  [Service]
  Environment=HUPO_BUILD_ID=<真指纹>
  ```
  写完 `systemctl --user daemon-reload`，再 `start`。
  ⚠️ **为什么不用 `systemctl --user set-environment`**：manager 的环境**不落盘**，
  机器一重启就没了 —— 而"开机自启"正是这个单元存在的理由 ⇒ 重启之后 `/api/version`
  又会掉回 `dev`。drop-in 是文件，跟着单元一起活（重启机器也在）。

**手动改指纹**（⚠️ **两件都要做**，否则改的是文件、跑的还是旧值）：
```bash
$EDITOR ~/.config/systemd/user/hupo-core.service.d/10-hupo-build-id.conf
systemctl --user daemon-reload && systemctl --user restart hupo-core
curl -s https://w.stalkerai.cn/api/version    # ← 拿公网这一句核，别看文件
```
⚠️ 再跑一次 `scripts/restart-core.sh` 会**按现推的真指纹重写**这个文件（手选的值会被覆盖）；
要钉住手选的值就别跑脚本，直接 `systemctl --user restart hupo-core`。

### 4. 怎么切回 systemd（手动 → 单元）

```bash
# ① 先看两件事：只剩一个 serve.js、公网 200
pgrep -af src/serve.js
curl -s -o /dev/null -w '%{http_code}\n' https://w.stalkerai.cn/api/version

# ② 装/启用三个单元（幂等）
cp /home/deploy/proj/hupo/deploy/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hupo-core hupo-frpc-w hupo-frpc-apps
```
⚠️ **顺序上有一步不能省**：如果**手动**起的那个 `serve.js` 还占着 8020，
单元会起不来（EADDRINUSE）⇒ 先照 §二 ② 那一条（按 `serve.pid` kill、`rm serve.pid`）
把它送走，再 `enable --now`。切完的判据同 §三：单元 active、`serve.js` **只剩一个**、
公网 `/api/version` 200 且 `buildId` 是真指纹。

### 5. 留档：装上那一刻的两个口子（已修，别再照它做）

1. 老 `restart-core.sh` 按 `serve.pid` 停，而单元不写那个文件 ⇒ 它看不见线上服务、
   自己再起一个 ⇒ 撞 `EADDRINUSE`、把死 PID 写进 `serve.pid`、报 `✗ 没起来`。
   现修法：§六·1 的判据 + systemd 那条路。
2. 单元里没有 `HUPO_BUILD_ID`（systemd 不做命令替换）⇒ `/api/version` 报 `dev`。
   现修法：§六·3 的 drop-in。
