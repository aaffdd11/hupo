# 233 · 技能层（产品）：作业指导书从人格搬进**按需加载的技能**（2026-10-11）

> 主人 2026-10-11 选了"②给产品里的助手装技能库"。
> 这一页记：**量出来的账** · 机制怎么接的 · 内容怎么切的 · 判据怎么跟着搬的 ·
> 在哪一端验的 · 剩下什么要主人签字。
> 决策：[`handbook-v3/05-DECISIONS.md`](../handbook-v3/05-DECISIONS.md) **`D4.32`**；
> 规范那一侧：[`09-APPS.md`](../handbook-v3/09-APPS.md) §七。

---

## 一、为什么搬（先量，再动手）

| 项 | 读数 |
|---|---|
| 人格（`hupo-persona.yml`） | **37,049 字节** —— 它**每开一个 agent 就整段喂一遍** |
| 其中「## 小程序」那一节 | **21,091 字节（57%）** |
| 去掉那一节之后 | **15,957 字节** |
| 搬完之后（实测） | 人格 **20,865**（−44%）· 技能 `skills/mini-app/SKILL.md` **18,541** |

⇒ 同一份内容，**开机成本从"每次 21KB"降到"目录里一两行"**（技能平时只占
`name ＋ description`，被叫到才把正文读进来）。

## 二、机制（**没有新造任何东西**）

DSH 自带整套技能机制（`dsh-skill` / `dsh-skill-filesystem` / `dsh-tool-skill`），
`dsh-base` 四个全挂 ⇒ 产品那条路（`--profile sdk`）本来就有 `skill` 工具。
我们只做三件接线：

| # | 改哪 | 做什么 |
|---|---|---|
| ① | **`hupo-skills.yml`**（新） | 按 id 定点改 `skill-filesystem` 的 **`customSkillDirs`** → `!!js process.env.HUPO_SKILLS_DIR`。⚠️ **只动配置**：关掉那个**服务提供者**会连 `skill` 一起带走 ⇒ 整台 dsh 起不来（`test/app-agent-ro.test.js` 的 `L1·补` 是那一课）。⚠️ `!!js` 那个表达式**必须加引号**（不加，YAML 把 `[` 当成流式序列 ⇒ `bad indentation`，实测） |
| ② | **`src/config.js`** | `skillsPath`（默认 `<core>/hupo-skills.yml`）＋ `skillsDir`（默认 `<core>/skills`）。两边 checkout 路径不同 ⇒ **不写死**，靠 `loadConfig` 的 `cwd`（宿主＝核心目录，盒里＝`/app/code`） |
| ③ | **`src/agent-runtime.js`** | `agentPatchArgs()` 挂上那一层（在能力层之后、模型那条之前）；`agentEnv()` 把 `HUPO_SKILLS_DIR` 递进子进程（**只放有值的**：塞 `undefined` 会变字面量 "undefined"） |
| ④ | **`scripts/build-tenant-code.sh`** | 产品层 `INPUTS` 加 `skills` 与 `hupo-skills.yml` ⇒ **改技能 = 换一版产品层**（可回滚、有指纹、不用重造镜像） |
| ⑤ | **`src/serve.js`** | 横幅加一行 **`技能 N 条 · <目录>`**（目录不在时说"⚠️ 目录不在 ⇒ 一条都加载不上"）。理由同人格那一行：**没挂上时一切照常，只是"它会做的事变少了"** —— 那是查不出来的坏 |

发现路径与 rank（读 `dsh-skill-filesystem` 源码得到）：`<工作区>/.dsh/skills`(100) ·
`<工作区>/.agents/skills`(200) · **自定义＝我们这一份(300)** · `~/.dsh/skills`(400) ·
`~/.agents/skills`(500) · 自带(600)。⇒ 将来"让它自己学"（主人选的 ③）只要往
**工作区**里写 `.dsh/skills/…` 就能盖过产品这一份（rank 100 < 300），**两套自动叠**。

## 三、内容怎么切的（不是"整段搬"，是分两个家）

| 留在人格（**永远要守的边界**，短） | 搬进技能（**怎么做**，长） |
|---|---|
| "小程序/app/应用"**只有一个意思**（他桌面上那一格；不是微信 / 不是原生 / 不是网站）· 不问"哪种平台" | 派活那一套的**为什么**、做不到的三种、fork / 发布 / 权限的完整话术 |
| 他明确要了 ⇒ **派活到新的一间**（别在主对话里造）· 他自己想到的**只许提一句** | 页面怎么写（自包含 / 不许 `localStorage` / 别自己留边距 / 用啥声明啥）· 复杂与玩头 · `app-lint` 有报必改 · 交付模板 |
| **做不到的第一句就说**（改界面 / 装到手机）· 权限那一下**永远在他手里** · **存储天生就有** | 存储那三条口（147）· `tasks` · `agent` · 两张网 · `net` / `ask` 的细节 |
| 做完**明确说"做完了"** ＋ **一句指针**："动手前先加载技能 `mini-app`" | （全部正文） |

⚠️ **两边不是抄**：人格那几条是"**不许越线**"（必须在他开口那一刻就生效 —— 不能指望
模型先去加载一个技能），技能那一份是"**怎么做好**"。这一点在两边文件里都写明了。

### 🔴 顺带发现：人格里那三处 `docs/dev/1xx` 指针**在盒子里是悬空的**

盒子只挂 `/data` ＋ `/app/code:ro`（`scripts/create-tenant-pool.sh` 里那几行），
**`docs/` 根本不在里面** ⇒ 原来人格里"照 `docs/dev/149` 干"那几句，在盒子里**读不到**。
⇒ ① 这次搬走之后人格这边**不再有悬空指针**；② 技能那一份开头**明写它是自足的**
（"正文里写下来的规则就是全部；`docs/dev/1xx` 只在开发机上翻得到"）。

## 四、判据（跟着事实搬，不是删掉）

| 判据 | 原来量什么 | 现在量什么 |
|---|---|---|
| `test/persona.test.js`「那四条」 | 人格正文 | **技能正文**那八颗钉子 ＋ **人格必须点名 `mini-app`** ＋ 技能正文 > 3000 字（空壳反向对照） |
| `scripts/check-app-storage-rule.sh` 判据①/③ | 人格正文 ＋ 拿人格造变异 | **技能正文** ＋ 拿技能造变异（判据①另加一条"人格点名那个技能"）。读数：**18 通过 / 0 失败**，负向对照"删掉规矩 ⇒ 6 处变红"成立 |
| **`test/skills.test.js`**（新，8 条） | —— | ① 接线（config 默认值 / 命令行真挂上 / 环境真递进子进程 ＋ 不配时不硬塞）② 那一层**只动配置**（不许出现 `- id: skill`、`tool-skill`、`disabled`；路径必须从环境来）③ 🔴 **拿 DSH 自己那个 `FileSystemSkillProvider` 真列一遍**（＋空目录反向对照；顺带断言**解析零 warn**）④ 契约（`name` kebab-case、与目录同名、`description` 非空、frontmatter 在）⑤ 产品层 `INPUTS` 带着它 ⑥ 人格点名 ⑦ 不存在的目录 ⇒ 列不出 |
| `test/app-drift.test.js`（原有） | 人格「## 小程序」那一节的**漂移钉子** | **原样不动**（那几行留在人格里 ⇒ 一条都没改，读数全绿） |

**变异验证**（都做过、都还原了）：
① 把 `skills` 从产品层 `INPUTS` 里删掉 ⇒ `test/skills.test.js` ⑤ **当场红**；
② 把技能 `name` 改成 `mini_app`（下划线）⇒ ③ 与 ④ **当场红**（而且 ③ 正是"DSH 那台不认它"）；
③ 把 `skill-filesystem` 的配置改成一个**会抛的 `!!js` 表达式** ⇒ 真启动时
`plugin tree failed to load: … skill-filesystem … EVAL-PROBE`、退出码 1
（**这条证明那份 patch 真的被求值了** —— `--dump-config` 只回显、不证明）。

## 五、在哪一端验的

1. **源码级**：上面那三份判据（`npm test` 里跑）。
2. **配置级**：`dsh --profile sdk --patch hupo-skills.yml --dump-config` ⇒
   `skill-filesystem` 那条多了 `customSkillDirs`；**不挂这一层**时没有（反向对照）。
3. 🔴 **真启动**：那个"会抛的表达式"把树弄挂 ⇒ 求值这一步是真的（读数见上）。
4. 🔴 **DSH 自己那个 provider**：`customSkillDirs` 指向我们的目录 ⇒ 列出 `mini-app`、
   正文读得出来、零 warn（`test/skills.test.js` ③ 用的就是这一份代码）。
5. **盒子里**（产品那条路）：
   - `build-tenant-code.sh` 造出 **`93b3995881b3`**（132 个文件）→ `--verify` **真跑一个容器**
     ⇒ 「这一版起得来，而且**自己报的就是 `93b3995881b3`**」（正对照：挂载真只读 `EROFS`）→
     `--publish` 翻转（`bcfe691631d0 → 93b3995881b3`，账记进 `/srv/hupo/tenant-code/ledger.jsonl`）；
   - 🔴 **两台租户自己报的就是这一份**：`check-tenant-code-drift.sh` ⇒
     **✅ 租户跑的就是仓库现在这一份（产品层 `93b3995881b3`）**；
   - 盘上核过：`/srv/hupo/tenant-code/current/` 里 **`skills/mini-app/SKILL.md`（18542 字节）**
     与 **`hupo-skills.yml`** 都在；而那一份就是盒里 `/app/code`（`:ro`）的来源。
   - ⚠️ **没读到的**（如实说）：盒里那一行横幅 `技能 N 条 · /app/code/skills`。
     理由：租户的家目录是 `0700`（`hupo-a` / `hupo-b`），**我读不到它的 `serve.log`**；
     要读得动就得 root，而那是**部署期的另一边**（不该为了看一眼去动别人的容器）。
     ⇒ 所以"盒子里确实是 1 条技能"这个结论，**依据是上面那三条**（层里有 ＋ 挂载关系 ＋ 它自报这一版），
     **不是**我亲眼看到那一行。
6. ⚠️ **没验的（更根本的那一条）**：模型**真的会去调**那个技能 —— 那要一次真模型调用
   （本机判据里不跑）。兜底是两条：**人格点名了它**（`test/skills.test.js` ⑥）＋
   **那个目录每一轮都在它眼前**（`dsh-tool-skill` 的会话目录）。

## 六、要主人签字的那一条

人格（`hupo-persona.yml`）与手册两份（`05-DECISIONS.md` / `09-APPS.md`）都是 **`strict`**
⇒ **要重建一次开机清单**（命令与核法见 `dev/231` §三/§四）。**没重建之前不许重启**
（`serve.js` 会按 P1.4 拒绝启动）。
