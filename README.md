# 琥珀（hupo）

> **一个会自己动手把事情办完的私人助理。**
>
> 你说的事它真会去做，不只是陪聊。它有自己的记性、自己的手，
> 而**它替你做的每一件事，都会说出来**。

---

## ⚠️ 这台机器不是生产机

| | **本机（开发）** | **生产机** |
|---|---|---|
| 项目路径 | `/home/deploy/proj/hupo` | 另一个 checkout |
| 服务 | ❌ **没有**（`concierge-core` 在本机是 inactive） | systemd 单元 + 端口 8091 |
| 用途 | 改代码 / 跑测试 / 出构建 | 真正服务用户 |
| 域名 | —— | `https://hupo.stalkerai.cn` |

⇒ **别在本机找服务，别重启一个不存在的服务。**
细节见 [`docs/handbook/06-OPERATIONS.md`](docs/handbook/06-OPERATIONS.md)。

> ⚠️ **本机另有一个我们自己铺的站**：<https://w.stalkerai.cn> ——
> 那是 **v2 的调度器**跑在 `127.0.0.1:8020`，经 VPS 的 stcp 隧道出来的。
> 它**不是**上面那个"生产机"。见 [`docs/dev/03-DEPLOY-WEB.md`](docs/dev/03-DEPLOY-WEB.md)。

---

## 从哪开始读

**唯一权威文档是 [`docs/handbook/`](docs/handbook/)**。

| 我是…… | 先读 |
|---|---|
| **要动手改代码（最要紧的入口）** | [`AGENTS.md`](AGENTS.md) —— 状态、流程、不许破的几条 |
| 想知道"计划 vs 实际"到哪了 | [`docs/dev/00-PROGRESS.md`](docs/dev/00-PROGRESS.md) —— **逐条对表 + 欠的账** |
| 第一次接触这个项目 | [`handbook/01-PROJECT.md`](docs/handbook/01-PROJECT.md) —— 这是什么、给谁、为什么 |
| 要动手改代码（设计层） | [`handbook/03-DEVELOPMENT.md`](docs/handbook/03-DEVELOPMENT.md) + [`handbook/04-ROADMAP.md`](docs/handbook/04-ROADMAP.md) |
| 想知道"为什么不能那样做" | [`handbook/05-DECISIONS.md`](docs/handbook/05-DECISIONS.md) —— 已拍板决定 |
| 要判断一个改动能不能做 | [`handbook/02-ARCHITECTURE.md`](docs/handbook/02-ARCHITECTURE.md) §五 不变量 |
| 要部署 / 排障 | [`handbook/06-OPERATIONS.md`](docs/handbook/06-OPERATIONS.md) |
| 查现状有哪些坑 | [`handbook/07-APPENDIX.md`](docs/handbook/07-APPENDIX.md) |
| 查接口表 / 安全模型 / 构建 | [`handbook/08-SPEC.md`](docs/handbook/08-SPEC.md) |

---

## 代码在哪

```
v2/                            ★ 唯一的实现
  services/core/               调度器（L2）：落盘 / 取号 / 收口 / 出事谁接 /
                               agent 运行时 / 跨重启接记忆 / 超时硬收口 / 对账续做
    src/                        15 个模块
    test/                       硬闸：232 条
  apps/mobile/                 Flutter 客户端（L1）：登录 / 聊天 / 四态 / 续传 /
                               「它正在做…」/ 关于页
    lib/                        界面与模型
    test/unit/                  硬闸：55 条
    test/widget/                39 条可访问性**硬闸** + 5 条提示档

docs/handbook/                 唯一权威文档（手册，已定档）
docs/dev/                      随代码长的开发文档（每批一份 + 00-PROGRESS 对表）
scripts/                       跑闸 / 部署 / 重启 / 推送
```

⚠️ **上一代实现（`services/`、`apps/`、`packages/`）已经删掉**（2026-09-21）。
它的**事实**（DSH 怎么行为、哪些坑踩过）已经收敛进手册与 `docs/dev/`；
要翻原文用 git：**`git show f93f296:<路径>`**（见 [`AGENTS.md`](AGENTS.md) §七）。

| 层 | 是什么 | 一句话纪律 |
|---|---|---|
| **L1 终端** | Flutter 壳 + 小程序运行时 + 图标墙 | **只上报事实，不做判断** |
| **L2 调度器** | `v2/services/core`，永续 | **不能有表达欲**（唯一例外：产品固定话术） |
| **L3 工作层** | 一个会话 = 一个真 agent 进程 | **永不直接对用户说话**（话由主 agent 出口） |

---

## 常用命令

```bash
# 服务端：硬闸（现 232 条全过）
cd v2/services/core && npm test

# 客户端：四道闸一条命令（静态分析 / 单测 / 可访问性 都是硬闸）
bash scripts/check-client.sh

# 起在线的那个服务（本机 8020，w.stalkerai.cn 就是它）
scripts/restart-core.sh                  # ⚠️ 默认**保留日志**——跨重启接记忆靠它

# 会花真钱 / 起真进程的验收（发版前跑）
bash scripts/check-persona.sh            # 人格真的进了模型上下文吗
bash scripts/check-crash-recovery.sh     # 被硬杀之后能自己收干净吗
bash scripts/check-apk.sh                # 打出来的安卓包里权限对不对

# 推送到 GitHub
bash scripts/push-changes.sh "一句话说明" -- <改动的路径...>
```

> ⚠️ **`test/widget` 里除了可访问性那一份，其余是提示档**——它断言的是"有没有画到屏幕上"，
> 界面一重构必然过期。**但 `analyze`、`test/unit`、可访问性那一份挂了必须修干净。**
> ⇒ 一条命令跑完三道闸：`bash scripts/check-client.sh`（提示档**扫目录**，新加一份会自动跑）。
> 详见 [`docs/dev/13-A11Y.md`](docs/dev/13-A11Y.md)。

---

## 两条最该记住的产品判断

1. **"工作区"三个字界面永久禁用**——用户用自己的词（他说"小升初"就叫"小升初"）。
   隐喻是"**一件事的一本本子**"。
2. **系统替用户做的每一件事，都要说出来。**
   十个用户的走查里，**八个的放弃点落在同一件事上**：
   "它到底活着没有、记着没有、说的是不是真的"——**用户无法验证，而系统自己也不说**。

---

## 环境

| 需要 | 版本 |
|---|---|
| Flutter | 3.35.1（`~/sdk/flutter/bin/flutter`） |
| Node | ≥ 20（实测 v24.15.0） |
| JDK | 17（`~/sdk/jdk17`，**安卓构建要 `source ~/sdk/env.sh`**） |
| Android SDK | 36（`~/sdk/android-sdk`） |

⚠️ 本机 `sudo` **要密码**。`deploy` **不在** docker 组（**永久不加**）。
