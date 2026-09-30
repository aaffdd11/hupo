# `v2/` —— 唯一还在长的实现

> ⚠️ **这一份只做一件事：把人领到门口。**
> 结论、判据、**模块清单**都不住在这里 —— 抄一份过来，那天就开始漂
> （这个项目在"同一份东西写两处"上栽过不止一次）。
> 要什么 / 为什么在 `docs/handbook/`；这一批怎么实现、怎么验的、现在到哪了在 `docs/dev/`。

## 这里有什么

| 目录 | 是什么 |
|---|---|
| `services/core/` | Node.js 调度器（L2）。常驻进程，听 `127.0.0.1:8020` —— **线上服务就是它** |
| `apps/mobile/` | Flutter 客户端（L1）。**线上的界面就是它**（Web ＋ 原生安卓） |

> **模块清单不抄在这里**：看目录本身；"要问什么读哪一份"看 `docs/INDEX.md`；
> "改个小东西碰哪几个文件、跑哪条闸"看 `docs/CHANGE-MAP.md`。

## 怎么跑

服务端：

```bash
cd v2/services/core
npm test                          # 硬闸（条数住在 docs/dev/00-PROGRESS.md，不写在这儿）
npm run demo                      # 地基演示：一条消息进来 → 落盘 → 推出去
npm start                         # 起服务（127.0.0.1:8020，没设密码时 fail-closed）
npm run set-pass -- "你的密码"      # 设密码（在机器上做，不在网页上）
```

客户端：`bash scripts/check-client.sh`（三道闸一条命令）。

> 起线上那个服务用 `scripts/restart-core.sh`；出 Web 产物用 `scripts/deploy-web-v2.sh`
> （它会替跑硬闸、给入口文件加指纹）。

## 开发文档（**要问什么读哪一份**）

| 我要什么 | 去哪 |
|---|---|
| 要什么 / 为什么（冻结，唯一权威） | `docs/handbook/` |
| 要问什么读哪一份（L0 路由） | `docs/INDEX.md` |
| 只是改个小东西 —— 落点与闸 | `docs/CHANGE-MAP.md` |
| 现在到哪了 / 还欠什么 | `docs/dev/00-PROGRESS.md` |
| 这一批怎么实现、怎么验的（证据层） | `docs/dev/` |

## ⚠️ 这一份原来写着三处不真的话（2026-10-01 更正）

| 原来写着 | 事实 |
|---|---|
| "仓库根下的 `apps/`、`services/` 是**旧实现**，只当参考" | **上一代已经删掉**（2026-09-21）。要翻原文：`git show f93f296:<路径>` |
| "前端在哪 —— **还没写**" | 客户端就是 `v2/apps/mobile/`，**已经在线上跑**（`w.stalkerai.cn`） |
| 四个链接指向 `docs/dev/{01-FOUNDATION,02-SERVER-SURFACE,03-DEPLOY-WEB}.md` | 那三份文档早已删掉 ⇒ 链接已撤（原文用 `git show f93f296:docs/dev/…` 取） |

> 另有一处是**纪律问题**（不是错话）：原来那句 "`npm test` —— **108 条**验收" 把条数写死了。
> 条数**只住在 `docs/dev/00-PROGRESS.md`** —— 写在这儿的那一刻，它就开始过期。
