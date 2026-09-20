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
| 服务 | ❌ **没有** | systemd 单元 + 端口 8091 |
| 用途 | 改代码 / 跑测试 / 出构建 | 真正服务用户 |
| 域名 | —— | `https://hupo.stalkerai.cn` |

⇒ **别在本机找服务，别重启一个不存在的服务。**
细节见 [`docs/handbook/06-OPERATIONS.md`](docs/handbook/06-OPERATIONS.md)。

---

## 从哪开始读

**唯一权威文档是 [`docs/handbook/`](docs/handbook/)**。旧的架构文档、评审、辩论记录**已经删掉**（在 git 历史里）。

| 我是…… | 先读 |
|---|---|
| 第一次接触这个项目 | [`handbook/01-PROJECT.md`](docs/handbook/01-PROJECT.md) —— 这是什么、给谁、为什么 |
| 要动手改代码 | [`handbook/03-DEVELOPMENT.md`](docs/handbook/03-DEVELOPMENT.md) + [`handbook/04-ROADMAP.md`](docs/handbook/04-ROADMAP.md) |
| 想知道"为什么不能那样做" | [`handbook/05-DECISIONS.md`](docs/handbook/05-DECISIONS.md) —— 76 条已拍板决定 |
| 要判断一个改动能不能做 | [`handbook/02-ARCHITECTURE.md`](docs/handbook/02-ARCHITECTURE.md) §五 不变量 |
| 要部署 / 排障 | [`handbook/06-OPERATIONS.md`](docs/handbook/06-OPERATIONS.md) |
| 查现状有哪些坑 | [`handbook/07-APPENDIX.md`](docs/handbook/07-APPENDIX.md) |
| 查接口表 / 安全模型 / 构建 | [`handbook/08-SPEC.md`](docs/handbook/08-SPEC.md) |

**完整索引与读法**：[`docs/handbook/README.md`](docs/handbook/README.md)

---

## 代码在哪

```
v2/                   ★ 新实现（全新建立，旧代码只当参考）
services/core/          调度器：地基已建完（store/timeline/message-writer/process-guard）
docs/dev/               模块开发文档（随代码长）
docs/handbook/          手册 v1.0（定档，唯一权威）

apps/mobile/          Flutter 客户端（L1 终端）—— 旧实现，只当参考
  lib/                30 个文件，5791 行
  test/unit/          硬闸：协议 / 状态机 / 纯逻辑（45 条全过）
  test/widget/        只警告，不阻断（49 条挂 10）
services/core/        Node.js 调度器（L2）——常驻进程，13 个文件，3914 行
  test/               硬闸（72 条全过）
packages/protocol/    PROTOCOL.md：客户端 ⇄ 调度器的约定
scripts/              构建 / 部署 / 推送脚本
docs/handbook/        唯一权威文档
```

| 层 | 是什么 | 一句话纪律 |
|---|---|---|
| **L1 终端** | Flutter 壳 + 小程序运行时 + 图标墙 | **只上报事实，不做判断** |
| **L2 调度器** | `services/core`，永续 | **不能有表达欲**（唯一例外：产品固定话术） |
| **L3 工作层** | 一个会话 = 一个真 agent 进程 | **永不直接对用户说话**（话由主 agent 出口） |

---

## 现在的状态

| 项 | 状态 |
|---|---|
| **规划** | ✅ **完成** —— 76 条决策全部拍板；两轮独立评审已收口；批 0 整个关闭 |
| **实现** | 🚧 **进行中**——地基（落盘/取号/收口/出事谁接）已建完，47 条验收全过 |
| **下一步** | [`handbook/04-ROADMAP.md`](docs/handbook/04-ROADMAP.md) **批 1**（13 件） |

**批 1 里有四件是"今天就该修的"**（现在的 bug，不是新功能）：
落盘上抛 + 谁接 · `turns` 键 · 瞬态不发号 · 连接生命周期。

---

## 常用命令

```bash
# 客户端：硬闸 + 构建
cd apps/mobile
~/sdk/flutter/bin/flutter analyze
~/sdk/flutter/bin/flutter test test/unit
~/sdk/flutter/bin/flutter build apk --release

# 服务端：硬闸
cd services/core && node --test test/*.test.js

# 推送到 GitHub
bash scripts/push-changes.sh "一句话说明"
```

> ⚠️ **`test/widget` 挂了不要卡在那里**——它断言的是布局，界面一重构必然过期。
> 照常继续，用真机确认。**但 `analyze` 与 `test/unit` 挂了必须修干净。**

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
| JDK | 17 |
| Android SDK | 36 |

⚠️ 本机 `sudo` **要密码**。`deploy` **不在** docker 组（**永久不加**）。
