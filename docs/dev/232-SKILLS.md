# 232 · Agent Skills：我们不用"引入"，机制已经是开着的（2026-10-11）

> 主人 2026-10-11：*"查看 github，aihero.dev/skills。然后看看如何应用到我们的 agent 里。"*
>
> 这一页记：那套东西是什么 · **我们已经有什么**（读源码得到的路径与契约）· 装了哪三个 ·
> 在哪一端验的 · 还没做的那两条与它们的代价。

---

## 一、aihero.dev/skills 是什么

[Matt Pocock（AI Hero）](https://www.aihero.dev/skills) 的一套 **Agent Skills**：**27 个技能、MIT**，
装法 `npx skills@latest add mattpocock/skills`（Claude Code 那边可当 plugin 装），
号称对 **Claude Code · Cursor · Codex · Copilot** 通用，装完在 agent 里打 `/技能名` 叫它。

- **形态**：一个技能 = 一份 `SKILL.md`（YAML frontmatter 写 `name` ＋ `description`，正文写"怎么做"），
  可以带脚本；平时上下文里只有**名字 ＋ 一句话描述**，**被叫到才把正文读进来**（渐进披露）。
- **它那套是给"工程师对着代码库"用的**，一条主流程：
  `/grill-with-docs`（被追问到说清）→ `/to-spec` → `/to-tickets` → `/implement` → `/code-review` → `/retro`；
  旁边 shaping（`/wayfinder` · `/prototype` · `/research`）与 engineering（`/diagnosing-bugs` · `/triage` · `/wizard`）。
- ⚠️ **它自己公开的两个坑，我们也要记**：① **技能之间互相委派会"半加载"**（加载了 A 没加载 B ⇒
  看着在跑、其实缺一半，是被报最多的毛病）；② **会不会被加载依赖模型与 effort**（"问它读了哪些技能"是有用的动作）。

⚠️ **那 27 个技能本身不适合照搬**（英文、面向 TypeScript 代码库的工程流程）。
对我们有用的是**格式**与**那套纪律**（渐进披露 ＋ 小技能 ＋ 显式触发条件）。

## 二、🔴 关键发现：DSH 自带这一套，而且**已经挂在我们两个 agent 上了**

`@deepseek-ai/dsh` 里就是四个包：`dsh-skill`（登记/渲染）· **`dsh-skill-filesystem`（从盘上发现）** ·
**`dsh-tool-skill`（模型那个 `skill` 工具 ＋ 会话技能目录）** · `dsh-skill-badge`。
而 **`dsh-base` 把这四个全挂上了**，`sdk`（产品那条）与 `web`（开发这一侧）两个 profile 都含 `dsh-base`：

| 谁 | 有技能吗 |
|---|---|
| **产品里的主助手**（`--profile sdk --patch persona --patch capabilities`） | ✅ **有**（人格层 / 能力层都没关 `tool-skill`） |
| **开发这一侧（`web`）** | ✅ 有 |
| 替小程序跑的那一轮（`hupo-app-agent.yml`） | ❌ **故意关掉**（`- id: tool-skill / disabled: true`）—— 手册 `09-APPS.md` 记的正是这条；关掉之后目录与说明**一起消失**（`dsh-tool-skill` 的注释原话：调用方解析不到那个工具注册 ⇒ schema 与 call guidance 一起去掉） |

⇒ **要做的不是"接管线"，是"写技能"。**

### 2.1 它从哪儿找（读 `dsh-skill-filesystem/lib/index.js` 得到的；rank 小的赢）

| rank | 路径 | source |
|---|---|---|
| 100 | `<projectRoot>/.dsh/skills/<名字>/SKILL.md` | `project-dsh` |
| 200 | `<projectRoot>/.agents/skills/<名字>/SKILL.md` | `project-agents` |
| 300 | 配置 `customSkillDirs` 里的目录 | `custom` |
| 400 / 500 | `~/.dsh/skills` · `~/.agents/skills`（`agentsHome` 默认 `~/.agents`） | `user-*` |
| 600 | 随包自带（`bundledSkillDir` / `DSH_BUNDLED_SKILL_DIR`） | `bundled` |

- `projectRoot` 是**从 cwd 往上找 `.git`**（`findProjectRoot`）⇒ 我在 `/home/deploy/proj/hupo` ⇒ 落点＝仓库根的 `.dsh/skills/`；
  产品的助手 `cwd = 那一间工作区` ⇒ **它认的是 `<工作区>/.dsh/skills/`**（两套互不干扰）。
- 也认"一个 `.md` 直接当技能"（`<root>/<名字>.md`）。
- **改盘上文件是热加载的**（chokidar，`watch` 默认开）。

### 2.2 契约（硬 —— `parseSkillFile` 会**静默忽略**不合规的文件，只在日志里 warn 一行）

```yaml
---
name: close-out                 # 必须；kebab-case：/^[a-z0-9]+(?:-[a-z0-9]+)*$/（所以名字是英文）
description: 一句话说"它是干什么的、什么时候用它"   # 必须；目录里只显示这一句（每条封顶 500 字）
whenToUse: 什么时候该伸手拿它    # 可选；注意是 **camelCase**（写成 when-to-use 不认）
# 可选：disable-model-invocation / user-invocable（这两个是 kebab-case，写 camelCase 会被当成旧写法拒掉）
---
（正文：frontmatter 之后那段 markdown，**被叫到时才进上下文**）
```

## 三、装了什么（2026-10-11 · 三个，落在仓库根 `.dsh/skills/`）

| 技能 | 覆盖什么 | 为什么值得一个技能 |
|---|---|---|
| `close-out`（收尾） | 那四件事：两闸 → 部署 → 账 → 推；APK 只在主人说了才打；别人在动树时不收尾 | 它是**每次都要走**的流程，而 `AGENTS.md` §5.0 是开机必读的长文 |
| `diagnostic-first`（先量再改） | 现象 → **读数** → "一行判据" → **会红的复现** → 变异验证 → 留痕 ＋ 三条"别交出去的坏东西" | 这个仓库最贵的两种错（照记忆顺手改 / 没量就说根因）都在这条路上 |
| `protected-files`（受保护文件 ＋ 重启） | `strict` vs `report` 两档 · 口令不许到助手这儿 · `--build` 那一句 · **重启后必须核 cgroup**（2026-10-11 真栽过） | 它是"改完要请主人补一条 sudo"那条纪律的可执行版本 |

⚠️ **名字是英文**（`name` 的语法只收 `[a-z0-9-]`）；**正文是中文**、口吻与仓库一致。
⚠️ 三个都**指向权威出处**（`AGENTS.md` §几 / `docs/dev/NNN` / 脚本），**不抄数字** —— 手册纪律第 1 条。

## 四、在哪一端验的

1. 🔴 **目录当场变了两次**（每写完一个 `SKILL.md`，本会话的 skill catalog 就多一条 —— 热加载真的在跑）。
2. 🔴 **正文真的叫得出来**：`skill(name="protected-files")` ⇒ 返回 `<skill_instructions>` 全文 ＋
   `Base directory for this skill: …`（相对资源按那个目录解析）。
3. **加了这三个文件之后**：`node scripts/verify-integrity.mjs` ⇒ **只有"只报不拦"的条目动过**（就是 `#349` 改的
   `scripts/restart-core.sh`）⇒ **`.dsh/skills` 不在受保护清单里**，加技能**不用请主人补 sudo**。
4. **没动的**：人格层 / 能力层 / 任何 `strict` 文件 —— **一个字节都没碰**。

## 五、还没做的两条（以及它们要先定什么）

| # | 做什么 | 要先定什么 | 代价 |
|---|---|---|---|
| ② | **给产品里的助手装技能库**：把反复做法（做小程序 / 记账 / 查资料 / 语音那几件）写成技能，随产品层发到每台租户工作区 `<工作区>/.dsh/skills/` | 哪些做法值得"永久行为化"；谁来审（它进的是**产品**） | 走产品层发布（`build-tenant-code.sh --verify/--publish`）＋ 手册里要有一条决策；**收益**：人格层现在 **37KB 每开一个 agent 喂一遍**，技能平时只占"名字＋描述"一两行 |
| ③ | **让它自己学**：助手/用户在那一间工作区里落一个 `SKILL.md` ⇒ 下次开机自动出现 | **谁许写 · 写到哪 · 要不要留痕 · 能不能删**（这是给"永久行为"留后门的那一类，按 P1/P2 的精神要先拍板） | 风险不是"它干一次坏事"，是"**坏事能不能留下来**" |

> 🔴 一条**先别忘**的：`dsh-tool-skill` 的目录**只在调用方解析到那个工具注册时才发出** ⇒
> ② 那条路上如果哪一天把 `tool-skill` 关掉（像替小程序那一轮那样），技能**自动全消失**，不需要另外清理。
