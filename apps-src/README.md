# `apps-src/` —— 开发这一侧的小程序源码

这里放**我们自己做的小程序**的源码（一个目录一份）。它不是产品代码、也不进任何构建产物：
它是**给人看、给人改**的那一份，装进某个人的盒子用的是它。

| 一个目录里有什么 | 是什么 |
|---|---|
| `app.json` | 这一版的说明：`id` / `title` / `icon` / `entry` / `permissions` / `net` / `tasks`（`note` 只给人看） |
| 其余文件 | 制品本体（`index.html` 等），**一个都不能引外部资源**（标准见 `docs/dev/149-APP-DEV-STANDARD.md`） |

装进谁那儿（**新增或改一版**都走这一条）：

```bash
node scripts/install-app-into-user.mjs apps-src/futures-trade --user u2          # 只看：读源码 + 跑制品自查
node scripts/install-app-into-user.mjs apps-src/futures-trade --user u2 --apply  # 真装
```

⚠️ 两条纪律（都在 `docs/dev/235-APP-INSTALL.md` 里写清了理由）：

1. **小程序库以盒子为准**（B15）⇒ 装这一版必须经**服务手上那条隧道**落到盒子自己的
   `Apps.create()` 上，**不许**去写容器的卷（`81-HARNESS-ENTRY.md` §9.3）。
2. **装完要读回来核**（服务那一侧逐个 sha256 + rootHash）——回执里 `verified:true` 才算到盒里了。
