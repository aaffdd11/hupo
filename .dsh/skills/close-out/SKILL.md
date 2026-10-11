---
name: close-out
description: 这件仓库里「收尾」那四件事的完整流程 —— ①两边的硬闸跑绿 ②能部署的部署掉 ③文档与账对上 ④推上去并给主人一份总结。当主人说「收尾 / 提交 / push / 推上去 / 做个总结」，或者一件活刚做完、准备开下一件时用它。
whenToUse: 一件活写完要「结束」它的时候；或者主人说「收尾 / 提交 / push / 总结」。
---

# 收尾（这个仓库的规矩）

> 🔴 **主人的原话**：**「永远先收尾做总结，再做其他的。」** —— 上一件没有收尾，不许开下一件。
> 权威出处：`AGENTS.md` §5.0（**先读它**；下面只是"怎么走"，不抄它的数字）。

## 四件事，缺一件都不算收尾

| # | 做什么 | 判据 |
|---|---|---|
| 1 | **两边的硬闸都跑绿** | 服务端 `bash scripts/gate-server.sh`（或 `cd v2/services/core && npm test`）· 客户端 `bash scripts/check-client.sh` |
| 2 | **能部署的部署掉**（客户端改了就必须部署） | `bash scripts/deploy-web-v2.sh`（它会自己再跑一遍两闸，然后出产物 ＋ 重启 ＋ 公网核） |
| 2·补 | 🔴 **APK 只在主人说了才打** | `scripts/publish-apk.sh` 没有 `--owner-asked` **自己拒绝**（退出码 3）—— 平时只跑 `deploy-web-v2.sh` |
| 3 | **文档与账对上** | `docs/dev/` 那一篇 ＋ `docs/dev/00-PROGRESS.md` §〇/§六；**数字不许有两处** |
| 4 | **推上去 ＋ 给一份总结** | `bash scripts/push-changes.sh "一句话" -- <改动路径…>`（**必须列路径**，别用 `--all`） |

## 走的时候容易忘的几条

1. **迭代期只跑窄闸**：`bash scripts/gate-quick.sh <改动的路径…>` —— 它按"改哪块 ⇒ 跑哪条"的唯一映射挑。
   **全闸只在收尾跑一次**（`gate-server.sh` / `check-client.sh` 会留戳，半小时内同树不重跑；要重跑加 `--again`）。
2. **同一条全闸不许并行跑第二遍**；`check-client.sh` 之后**不许**再单独跑 `flutter test`。
3. **整站重发一轮只做一次**（`deploy-web-v2.sh` 约 3.6 分钟）。
4. **有别人（或子 agent）在动这棵树时不要收尾**：闸的读数测不准、推会把半成品扫进去 —— 先等它落地。
5. **在飞的东西写进 `00-PROGRESS.md` §八·补**，不许让它只在对话里存在。
6. **改了受保护文件（人格 / `AGENTS.md` / 手册 / `~/.dsh/profiles/*/cordis*.yml`）** ⇒ 要请主人补一条重建命令
   （`verify-integrity.mjs --build`，**绝对路径的 node**）；**别自己拼**，照那个脚本打出来的粘。
   —— 但 `src/` · `scripts/` · 客户端代码是**只报不拦**，不用重建。

## 客户端那一条别省

`scripts/deploy-web-v2.sh` 之后还要**浏览器那条路**（判据 V13：客户端自己算出来的东西，闸要打在这一侧）：
`HUPO_TOKEN=<现发的令牌> node scripts/check-web-browser.mjs --shot /tmp/shot.png`
令牌用 `v2/services/core/src/auth.js` 的 `Auth.issue()` **现发**，**不许写进任何文件**。
⚠️ 看结论之前先确认令牌是**能聊天**的（否则页面停在等待屏，脚本会误报"那条路没通"）。
