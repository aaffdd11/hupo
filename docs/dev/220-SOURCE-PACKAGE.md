# 源代码包：给一份能下的源码（`/hupo-source.tar.gz`）

> 主人 2026-10-07：*「给我一个源代码压缩包，放到下载链接里。」*
> 这一篇记：**包里有什么、怎么重打、下载地址在哪**，以及**如实说没打进去的东西**。

---

## 一、下载地址

**<https://w.stalkerai.cn/hupo-source.tar.gz>**

- 实测（2026-10-07）：本机与公网都是 **200**、`application/octet-stream`、字节数 **17,542,514**、
  sha256 **`dfa2e44885e5473b968444c5c7275ab5eed41f50be18f5d30cd561d5402b61f9`**，
  解开能读（`tar tzf` 通，**1124** 个条目 = 目录 ＋ **1048** 个文件）。
- 只发 ASCII 名（中文名在公网那段转发上会坏，见 [`contest/README.md`](../contest/README.md)）。

---

## 二、包里是什么（`scripts/pack-source.sh`）

| | |
|---|---|
| **内容** | `git archive HEAD` 的那一份 —— **就是 GitHub `main` 上那一份**（打的时候是 `9f3a21e11e91`） |
| ＋ | 根目录一张 **`SOURCE-MANIFEST.txt`**：哪一次提交 · 什么时候打的 · 文件数 · **逐个文件的 sha256** · 目录是干什么的 · 怎么跑闸 |
| 大小 | 约 **17 MB**（源码树本身 29 MB 未压缩；`docs/` 里的图与材料占大头，压不动） |
| 为什么不定版本号 | 它是**滚动的一份**（像 `hupo-chat.apk` 那个稳定名）：指向"现在这一份"；哪一份住不住，看包里那张清单写的提交号 |

**不包**（它们本来就不在 git 里 ⇒ 天然进不来，这也是"包里没有脏东西"的唯一保证）：

`.git` 历史（要就加 `--with-git`）· `node_modules/` · `build/`、`.dart_tool/` · 运行时 `data/`
（会话、令牌、租户数据 —— **绝不能进包**）· 安卓包与 web 产物（那是 `publish-apk.sh` / `deploy-web-v2.sh` 的事）。

### 三种打法

```bash
bash scripts/pack-source.sh                 # HEAD 那一份（默认 · 前后一致、可复现）
bash scripts/pack-source.sh --worktree      # 工作树那一份（含未提交改动与未跟踪的新文件）
bash scripts/pack-source.sh --with-git      # 连 .git 历史一起（大很多）
bash scripts/pack-source.sh --out /tmp/x.tar.gz
```

产物落在 **`v2/services/core/data/hupo-source.tar.gz`**（`data/` 不进仓库 —— 跟 APK 一个道理：
**机器上的产物**，不是源码）。

---

## 三、它怎么活到线上（跟着部署走）

`deploy-web-v2.sh` 里那句 `rm -rf "$WEB"` 会把 web 根整个重建 ⇒ 静态文件**每次都要放回来**。
所以部署脚本里加了一段：**从 `data/` 那一份拷成 `web/hupo-source.tar.gz`**（找不到就打印一句
"要发就补 `bash scripts/pack-source.sh`"）。**新机器 / 刚 clone 出来是没有那一份的** —— 这时链接会是 404，
不是脚本坏了。

⇒ **改完源码要刷新那个下载**：跑一次 `pack-source.sh`，再 `deploy-web-v2.sh`（或者先把新的 tarball 手工
`cp` 进 web 根，等下次部署带走）。

---

## 四、如实说

| # | 事 |
|---|---|
| 1 | **包的是 HEAD，不是"此刻树上的样子"**：今天树上那些还没提交的改动（另一个会话的 v3.0 那批）**不在包里**。要那份用 `--worktree` |
| 2 | **默认没有 `.git` 历史**：收到的人能读源码、能跑闸，但不能 `git log`。要历史加 `--with-git`（大很多） |
| 3 | **包里没有依赖**：`npm test` 前要 `npm install`、Flutter 那边要有 SDK（路径见 [`AGENTS.md`](../../AGENTS.md)）；包只保证"源码这一层"是齐的 |
| 4 | **没有任何"这个包能跑通"的自动判据**：脚本只核"打出来了、能解开"；**真跑过没有**由收到的人按 `SOURCE-MANIFEST.txt` 里那两条命令自己验（本机是绿的，但那是本机） |
| 5 | 这一份**不含**盒子里那套运行数据与容器镜像（`build-tenant-image.sh` 那条线是另一回事） |
