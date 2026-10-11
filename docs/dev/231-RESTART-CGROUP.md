# 231 · 重启之后服务掉出了 systemd（真事故 · 根因 · 修法）

> 背景：主人 2026-10-11 21:37 自己跑了开机清单重建（`verify-integrity.mjs --build`，✅ 对上了），
> 我接着跑 `scripts/restart-core.sh` 把核心重启（**退出码 0**、横幅写「完整性 对上了」、
> `/api/version` 从 `0c7e6cf14c19` 变成 **`5a833343cdab`**，与页面那一份**对上了**）。
>
> ⚠️ 但那一跑**顺手把线上服务搬出了 systemd** —— 这一页记：怎么发现的 · 根因是什么 ·
> 手工搬回来的那几步 · 脚本改成了什么 · 以及"从**单元停着**那一档起步"的复验读数。

---

## 一、怎么发现的（读数，不是感觉）

重启之后我照常核"谁在服务"：

```
单元       hupo-core.service → inactive (dead) since 21:38:20（Duration 2d 21h）
进程       3128692 node src/serve.js
cgroup     …/app.slice/dsh-subprocess-2365-09d4b2b08da2.scope     ← 🔴 我那次 bash 调用的 scope
公网       200（服务是活的、能答）
```

⇒ **服务活着，但它不是 systemd 在管了**：它是我那次 `bash` 调用的**孩子**，
活在 DSH 的 subprocess scope 里。三个后果，每个都真：

| # | 后果 |
|---|---|
| ① | 脱离单元的 `Restart=always` —— 它崩了**没人拉** |
| ② | 那个 scope 一收（会话结束 / DSH 清理），**它跟着死** —— 而 AGENTS.md §一 那句"别用裸 `systemctl --user stop` 清 DSH scope"防的正是这一类 |
| ③ | 指纹 drop-in 不再更新（还是 `0c7e6cf14c19`）⇒ 下次按单元起会报**旧指纹** |

## 二、根因（一行判据）

`restart-core.sh` 第 0.1 步决定走哪条路：

```bash
# 改前
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet "$UNIT"; then
  USE_SYSTEMD=1
fi
```

`is-active` 回答的是"**现在跑着没有**"，而当时单元是 `activating`（systemd 正在按
`RestartSec=3` 重试 —— 上一轮服务是**被硬杀**退出的，横幅里那句
`上次退出(主人) ⚠️ 没善终（被硬杀 / 断电）` 就是它）⇒ `is-active` 非 0
⇒ **判成"没有单元" ⇒ 悄悄退到手动路**（那一段的注释自己写着："手动路的 cgroup 是 DSH 的
subprocess scope"）。

⚠️ **这个坑的本质**：**"它现在是不是 active"被当成了"这台机器认不认这个单元"**。
前者会在崩溃 / 手动停 / auto-restart 那一小段里变成假 —— 而那正是**最需要 systemd 的时刻**。

## 三、手工搬回去的那几步（也是"下次遇到怎么办"）

短到可以直接照做（**顺序不能反**；全程几秒停机）：

```bash
DROPIN=~/.config/systemd/user/hupo-core.service.d/10-hupo-build-id.conf
sed -i 's/^Environment=HUPO_BUILD_ID=.*/Environment=HUPO_BUILD_ID=5a833343cdab/' "$DROPIN"
systemctl --user daemon-reload
kill <游离的那个 PID>                      # SIGTERM：serve.js 会自己收工
systemctl --user start hupo-core
systemctl --user is-active hupo-core       # active
cat /proc/$(systemctl --user show hupo-core -p MainPID --value)/cgroup
#   ⇒ …/app.slice/hupo-core.service        ← 这才对
```

（那份 drop-in 的注释里本来就写着这条手工路，这里只是照着做。）

## 四、脚本改成了什么

| 改哪 | 改成 |
|---|---|
| 0.1 的判据 | `systemctl --user cat "$UNIT"` —— **单元在不在**（认得出就算在），不再问 active |
| 停之前那句话 | 照实报它是哪一档（`active` / `inactive` / …）—— 不再一律写"（$UNIT 在跑）" |
| 停之后 | **再认一遍"游离的"那一个**（`serve_pids`）——不收掉它，`systemctl start` 会因 8020 被占而失败，而 `Restart=always` 每 3 秒重试 ⇒ **服务起不来而脚本还报"起来了"** |

### 4.1 🔴 `serve_pids` 的第一版是**静默空转**（差点把一个坏修法交出去）

第一版写的是：

```bash
pgrep -x node | while read -r p; do … grep -q 'src/serve\.js' … done
```

**实测：`pgrep -x node` 一个进程都匹配不到。** 原因：node 把主线程的进程名
（`/proc/<pid>/comm`）改成了 **`MainThread`**，而 `pgrep -x` 正是拿 `comm` 比对的
（`/proc/3129318/comm` 实测就是 `MainThread`）⇒ 那个函数永远返回空 ⇒
"收掉游离进程"**什么都不做**，而**调用方看不出来**（比不修更坏：纸面上像修过了）。

⇒ 现在改成**直接读 `/proc/<pid>/cmdline`、按 argv 比**：`argv[0]` 是 node
（`node` / `*/node` / `nodejs`）**而且** `argv[1]` 正好是 `src/serve.js`。
**只看参数本身，不看"整条命令行文本"** —— 所以不会误伤"命令行里提到 serve.js"的脚本自己。

**怎么验的**（不是读代码猜的）：造一个**假进程** —— `/tmp/fakebar/src/serve.js` 里就一句
`setTimeout(()=>{},60000)`，在那目录里 `node src/serve.js &`，然后拿这个函数认：

```
  3129318 /home/deploy/.nvm/versions/node/v24.15.0/bin/node src/serve.js   ← 单元里那个（绝对路径）
  3129729 node src/serve.js                                               ← 假的那个（PATH 里的 node）
```

两个都认到了，**而跑这条命令的那个 bash 没被认进去**（它命令行里有 `src/serve.js` 这段字）。
验完把假的收掉。然后又**原样跑了一遍真脚本**：这次"游离的"是空 ⇒ 它一步多余动作都没做
（`▶ 线上服务归系统单元管（hupo-core 在跑）` ⇒ 起 ⇒ cgroup 仍是 `app.slice/hupo-core.service`）。

⚠️ **手工路原样留着**（没有单元的老环境 / 开发机还要用）—— 只是现在它只在
"**根本没有这个单元**"时才走。

## 五、复验（从"单元停着"那一档起步 —— 正是刚踩的那个形状）

```
① systemctl --user stop hupo-core        → 状态 inactive
② bash scripts/restart-core.sh           → EXIT=0
   ▶ 系统单元在（hupo-core：inactive）—— 照样用 systemctl 停/起，**不看 serve.pid**
   ▶ 起新服务（systemd 单元 hupo-core）：端口 8020，构建指纹 5a833343cdab
   ✓ 起来了（systemd 单元 hupo-core，PID 3129318）
   构建 5a833343cdab · 完整性 ⚠️ 有 1 个"只报不拦"的条目动过（＝这一页改的这支脚本）
③ 单元 active · cgroup …/app.slice/hupo-core.service · /api/version 5a833343cdab · 公网 200
```

⇒ **改前那个形状会走手动路（我已实测过一次），改后走单元路（上面这次）** —— 判别器就是判据。

## 六、顺带核到的（**既有事实**，不是这一轮造成的）

- `scripts/restart-core.sh` 是清单里的 **`report`**（"只报不拦"）⇒ 改它**不需要重建清单**，
  只会在横幅多一行"有 1 个只报不拦的条目动过"。
- 横幅里几条**老**读数照旧（都不是这一轮的账）：`准入 ⚠️ 算不出判据`（本机每层内存上限都是 `max`）、
  `语音 没配语音凭据`、`⚠️ 临时验证码开着（HUPO_DEV_CODE）`、`产品层 bcfe691631d0（dirty）`。
  最后那条（开发登录码）在 `00-PROGRESS.md` §九 里挂着，**换不换、什么时候换，等主人一句话**。
