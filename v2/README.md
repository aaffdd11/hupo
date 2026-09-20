# `v2/` —— 全新实现

> **这里是新写的代码。** 仓库根下的 `apps/`、`services/` 是**旧实现**，
> **只当参考**（它是"当时怎么做的"的证据，不是模板）。

## 为什么有 `v2/`

手册 v1.0 定档之后，决定：**代码全新建立**（见 `docs/handbook/CHANGELOG.md` v1.0.1）。

| | 旧实现（`apps/`、`services/`） | 新实现（`v2/`） |
|---|---|---|
| 地位 | **只读参考**，直到新的被验证过再删 | **产物** |
| 为什么还留着 | 它是**唯一知道 DSH 真实行为**的地方：API 长什么样、哪些坑踩过 | —— |
| 能不能改 | ❌ **不改** | ✅ |
| 为什么不能照抄 | 它带着 `docs/handbook/07-APPENDIX.md` §一 列的那些缺陷 | —— |

⚠️ **最容易犯的错**：拿旧代码顺手改几行（"反正只差几行"）。
那样做出来的东西会**同时继承**我们已经判定为"不许再出现"的缺陷。

## 目录

```
v2/
  README.md                  本文
  services/core/             调度器（L2）
    src/
      —— 地基 ——
      store.js               落盘：append-only，**失败必须上抛**
      timeline.js            可见时间线：**唯一的取号点** + 推订阅者
      message-writer.js      一条消息：start → text* → end
      process-guard.js       出事谁接：进程级兜底 + 崩溃环判定
      —— 服务面 ——
      auth.js                口令 / 令牌 / 限速 / 审计（**fail-closed**）
      resume.js              续传与补发（纯函数；`catchUp` 只在重连时标）
      say.js                 `POST /api/say` + **跨重启的幂等**
      server.js              HTTP 路由 / 静态 / WebSocket
      serve.js               服务入口（npm start）
      auth-cli.mjs           设密码 / 撤销令牌（**在机器上做，不在网页上**）
      index.js               地基演示（npm run demo）
    test/                    验收测试（**108 条**）
```

## 怎么跑

```bash
cd v2/services/core
npm test                          # 108 条验收
npm run demo                      # 地基演示：一条消息进来 → 落盘 → 推出去
npm start                         # 起服务（127.0.0.1:8020，没设密码时 fail-closed）
npm run set-pass -- "你的密码"      # 设密码（在机器上做）
```

## 前端在哪

**还没写。** 计划是 Flutter web 优先，见
[`docs/dev/03-DEPLOY-WEB.md`](../../docs/dev/03-DEPLOY-WEB.md)。

## 开发文档

- **手册（定档，唯一权威）**：`docs/handbook/`
- 地基：[`docs/dev/01-FOUNDATION.md`](../../docs/dev/01-FOUNDATION.md)
- 服务面：[`docs/dev/02-SERVER-SURFACE.md`](../../docs/dev/02-SERVER-SURFACE.md)
- 部署（`w.stalkerai.cn`）：[`docs/dev/03-DEPLOY-WEB.md`](../../docs/dev/03-DEPLOY-WEB.md)

> 分工：`docs/handbook/` 回答"**要什么、为什么**"（冻结）；
> `docs/dev/` 回答"**这一批怎么实现、验收怎么过**"（随代码长）。
