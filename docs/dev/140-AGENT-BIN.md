# 140 · **它"接不上活"** —— `dsh` 找不到（裸名 ＋ systemd 那份很短的 `PATH`）

> **主人 2026-09-29 17:57 那句**：*「帮我创建一个上海小学生专用的奥数练习APP，涵盖小奥七大板块…」*
> **他收到的两句**：*「你刚才那句我没来得及做，就卡住了。再说一次吧。」*
> ＋ *「我现在接不上活。你这句话我记下了，等我缓过来再说。」*
> ⚠️ 而**那一句本身是送到的**（`/api/say` 200、时间线上有它）——坏的是**它起不来**。

---

## 一、根因（线上实测，两层，都是同一个 `ENOENT` 家族）

服务**归 systemd 管之后**（`deploy/systemd/hupo-core.service`），它拿到的 `PATH` 是
**用户单元那份很短的**（`/proc/<pid>/environ` 真读数）：

```
PATH=/home/deploy/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:/snap/bin
```

**没有 nvm 那个 `bin`** —— 而本机 `node` 与 `dsh` **只住在那里**。于是：

| 层 | 代码 | 现场读数 | 用户那边看起来 |
|---|---|---|---|
| ① | `config.js` 的 `dshBin` 默认是**裸名** `'dsh'` ⇒ `spawn('dsh')` | `serve.log`：`[dispatcher] agent 退了：起不来：可能是【找不到 dsh 程序】(dsh) 或【工作目录不存在】(/home/deploy/hupo-workspace)` —— 而那个目录**是在的** | 每一句话换来「我现在接不上活」 |
| ② | `dsh` 的第一行是 `#!/usr/bin/env node`，而 `childEnv()` 照抄了那份短 `PATH` | 探针：`进程退出 code=127；它最后说的话：/usr/bin/env: 'node': No such file or directory` | 修完第①层**还是**「接不上活」 |

🔴 **两层必须一起修**：只修①，真机上看起来"没修好"（同一个症状、换了一句英文）。
这两条我都**在服务那一份环境里复现过**（见 §三 A1/A2），不是推出来的。

⚠️ **为什么一直没被发现**（四条，都记下来）：

1. **手动跑的时候是好的**：`scripts/restart-core.sh` 从**有 nvm PATH 的 shell** 起服务 ⇒
   裸名 `dsh` 找得到。**换 systemd 起就坏** —— 而这件事只在"重启方式"上分叉。
2. **横幅其实早就说了**：开机横幅那一行写的是 `agent    dsh --profile sdk（最多 4 个）`
   —— 裸名。**它印在那里好几天**，没有人把那一格当成"路径"来读（它长得像个显示名）。
3. **失败是"人话"**：`dispatcher` 把它翻译成了一句得体的中文（那是好事），
   于是**盘上、界面上都看不出是技术故障**。
4. **它和"工作目录不存在"共用一个 `ENOENT`** ⇒ 报错自己都说不清是哪一半
   （`DshAgent` 只好把两种可能都念出来）。

---

## 二、改了什么

| # | 在哪 | 改法 |
|---|---|---|
| ① | `src/config.js` 新增 `resolveDshBin()` | 取值顺序：`HUPO_DSH_BIN` → **`node` 同目录那个 `dsh`**（npm 全局装的就在那儿，而**跑我们的那个 `node` 就在同一格**）→ 裸名 `dsh`。**不许只靠 `PATH`** |
| ② | `src/config.js` 新增 `dshBinProblem()` ＋ `preflight()` 里一条 | 找不到 `dsh` ⇒ **开机就拦**（与 persona / SDK server 同一档：`problems` ⇒ `process.exit(2)`）。⚠️ 已经是"每轮悄悄失败"的那种缺陷，**不许再让它悄悄** |
| ③ | `src/agent-runtime.js` 新增 `withNodeDirOnPath()` | 给孩子的 `PATH` **补上 `dirname(process.execPath)`（放最前）** —— `dsh` 的 shebang 要有 `node` |
| ④ | `agentEnv()` | 再把 **`dshBin` 自己那一格**放最前（它是 node CLI，内部还会按名字起东西） |

⚠️ **没有动 `deploy/systemd/hupo-core.service`**（往单元里加 `Environment=PATH=` 也能修）：
装/重装单元是 **P2-7 里主人的动作**（`deploy/systemd/README.md`）。
⇒ 代码这一侧现在**不看那份 `PATH` 也能跑**，单元那一行只是"以后还能顺手用裸名"的便利。
⚠️ 单元**没有留在坏状态**：它依然是"手册里那份模板 ＋ 主人签过的部署"，
坏的是**代码对 `PATH` 的依赖**，那一条在代码里修掉了。

---

## 三、判据

| # | 判据 | 在哪 | 反例（变红的样子） |
|---|---|---|---|
| A1 | 默认 `dshBin` **不靠 `PATH`**：先取 `node` 同目录那个 | `test/agent-bin.test.js`（`resolveDshBin` 注入 `exists`） | 又退回裸名 `'dsh'` ⇒ systemd 一起来就 ENOENT |
| A2 | 孩子的 `PATH` 里**看得见我们那个 `node`**（而且放最前、不许把外面那份弄丢） | 同上（`withNodeDirOnPath` / `childEnv`） | 只修①不修② ⇒ `code=127 /usr/bin/env: 'node'` |
| A3 | `agentEnv` 里 **`dshBin` 那一格**也在 `PATH` 里 | 同上 | —— |
| A4 | `dsh` 找不到 ⇒ **`preflight` 报 problem**（拦启动）＋ 那句话里要写清"用户看到的是'接不上活'"与修法 | 同上（含**反向对照**：找得到必须是 `null`） | 报成"警告"⇒ 服务照起 ⇒ 每一句话都失败 |
| A5 | （已有）秘密仍然被摘掉 | 同文件最后一条断言 | —— |

🔴 **真机读数（服务那一份环境里跑的真探针）** —— 判据要打在"真起一次 agent"上：

```
修前：PATH 里有 nvm bin 吗：没有     dshBin = dsh
      ❌ 起不来： spawn dsh ENOENT

修①后：dshBin = /home/deploy/.nvm/versions/node/v24.15.0/bin/dsh
      ❌ 起不来： 进程退出 code=127；它最后说的话：/usr/bin/env: 'node': No such file or directory

修②后：dshBin = /home/deploy/.nvm/versions/node/v24.15.0/bin/dsh
      ✅ agent 起来了：ready = true        ← `initialize` 过完（`DshAgent.start()` 那个判据）
```

探针怎么跑的（**关键**：用**服务进程那份 `environ`**，不是我 shell 的）：

```bash
# 取服务自己的环境（不打印它）→ 拿它起探针
node -e "const fs=require('fs');const env={};
 for(const kv of fs.readFileSync('/proc/<serve.pid>/environ','utf8').split('\0')){const i=kv.indexOf('=');if(i>0)env[kv.slice(0,i)]=kv.slice(i+1);}
 require('child_process').spawnSync('/home/deploy/.nvm/versions/node/v24.15.0/bin/node',['/tmp/probe-agent.mjs'],{env,cwd:'/home/deploy/proj/hupo/v2/services/core',stdio:'inherit'});"
```

---

## 四、没做的（**明说**）

* **没验"真回一句话"**：`initialize` 过了（= 调度器投递前那道门），但**没有**拿一句真话
  走完 `session/prompt` ⇒ 模型那一侧。理由：那会往**主人那一间的 DSH 记忆**里塞一句
  我编的探针话。⇒ 这一条**如实记着**，下一个真问题（他自己再说一句）就是它的判据。
* **没动线上那份单元文件**（理由见 §二末尾）。
* **没去追"为什么 systemd 归位那天没发现"**：归位（`#130`）那天的复验是
  `/api/version` ＋ 单元 active ＋ 隧道重连 —— **没有一条打在"agent 能不能起"**上。
  ⇒ 那正是这次要补的账（A1–A4 就是补它的）。
* **没有把"agent 起不来"这件事做成界面上的显式状态**（今天只有一句人话）。
  那是个产品决定，**要问主人**。
* 🔴 **产品层漂了一格（这一轮没发，明说）**：这门修的两处（`src/config.js` ·
  `src/agent-runtime.js`）**也在产品层里** ⇒ 仓库现在是 `d769341cc99c`，而租户那三台跑的
  还是 `038f07f8ac08`（`bash scripts/check-tenant-code-drift.sh` 会红，直到发布一次）。
  **为什么不发**：发布要重启租户容器（按 P1/P2 **是主人签字的事**），而**这一格对盒子
  「行为无差异」**：盒里 `node` 与 `dsh` **同在 `/bin`**（`resolveDshBin` 解析到同一个
  `/bin/dsh`），而 `PATH` 里本来就有 `/bin` ⇒ 新加的 `preflight` 照样过、
  `withNodeDirOnPath` 只是把 `/bin` 又放到最前。⚠️ **账单记在这儿**：
  **下次发布自动带上**（发布时跑 `--verify d769341cc99c` ＋ `--publish`）。
