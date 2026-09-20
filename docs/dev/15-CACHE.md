# 15 · 删旧树 + 修静态缓存（**部署一定看得见**）

> **这一批两件事**：
> ① 把**上一代实现**（`services/`、`apps/mobile/`、`packages/`）**删掉**；
> ② 修一个**我自己埋的**bug —— **部署了，但已经来过的人看不到**。
>
> ⚠️ 第 ② 件是**从主人平板的截图里发现的**：顶栏少了一个我刚加进去的图标，
> 而服务端产物明明已经换了。
>
> **手册依据**：`06-OPERATIONS.md`（部署 / 排障）· `AGENTS.md` §三（全新建立）·
> §13.2 防回潮第 2 条（V8）· `08-SPEC.md` §7（静态资源）
> **代码**：`src/server.js`（`cacheControlFor`）· `scripts/deploy-web-v2.sh`（新）
> **测试**：`test/server.test.js` **+4 条**（237 → 见下）

---

## 一、那个 bug：**部署了，但老访客看不到**

### 1.1 现场

主人平板的截图里：主界面顶栏**只有一个图标**（退出），
而我刚加进去的「关于」（ⓘ）**不在**。同一时刻 `/api/version` 报的是新构建指纹。

### 1.2 量出来的根因

```
$ curl -sI https://w.stalkerai.cn/main.dart.js
cache-control: public, max-age=31536000, immutable     ← 一年
$ curl -sI https://w.stalkerai.cn/
cache-control: no-cache                                ← 入口是对的
```

服务端的**意图**是对的（代码里那句注释就是"带 hash 的产物可以长缓存；入口文件绝不行"），
但 **Flutter web 的产物文件名里没有 hash**：

```
main.dart.js          flutter_bootstrap.js      flutter.js
manifest.json         canvaskit/canvaskit.wasm  assets/…
```

⇒ 浏览器把旧的那份 `main.dart.js` 当成"**一年内不用再问**"，
HTML 虽然是新的、但它引用的还是**同一个 URL** ⇒ **永远取不到新代码**。

> ⇒ **"上线了"这句话，对已经来过的人是假的。** 而这正是这个项目最忌讳的那一类
> ——不是功能没做，是**系统自己在说一句不真的话**。

### 1.3 ⚠️ 更值得记的是：**它被一条测试钉住了**

旧的那条测试长这样：

```js
test('静态：带 hash 的产物可以长缓存', async () => {
  // 造一个"已构建产物"（真实 Flutter web 产物是 main.dart.js 这种带指纹的名字）
  nodeFs.writeFileSync(..., 'main.dart.js', ...);
  assert.match(r.headers.get('cache-control'), /immutable/);
});
```

**注释里那句是错的** —— `main.dart.js` 里没有指纹。
⇒ 那条测试**不是在验行为，是在给 bug 背书**：谁改服务端的缓存规则，它就会红。

⚠️ 这已经**第三次**在同一个项目里撞见这个形状了
（前两次：`dshSessionId` 要求"同一进程内 id 不变"、`forceClose` 断言"没有 writer 就什么都不做"）。
**一条写错前提的测试，比没有测试更坏 —— 它会保护 bug。**

⇒ 新测试用了**真实部署出来的那个名字**（`main.<12位指纹>.dart.js`）：

```js
for (const name of ['main.6b1abc336ff6.dart.js', 'flutter_bootstrap.6b1abc336ff6.js']) …
```

---

## 二、修法：**两层，缺一层都不够**

| 层 | 做法 | 管什么 |
|---|---|---|
| **服务端** | 规则从"入口文件 no-cache、其余 immutable"改成「**看名字**」：**只有真的带指纹的才长缓存**，其余 `no-cache` + `Last-Modified`/304 | 从今往后不再踩 |
| **部署时** | `deploy-web-v2.sh` 给两个入口文件**改名带上指纹**，并改写引用 | **把已经存了旧缓存的人救出来** |

### 2.1 为什么第二层是必须的（不是锦上添花）

**换响应头改不了浏览器已经存下的东西。** 平板上那份 `main.dart.js` 是按
"immutable 一年"存的 ⇒ 它会一直用下去，**服务端说什么都没用**。

⇒ 只能**换一个 URL**：
`index.html` **一直是 `no-cache`** ⇒ 它会取到新的 HTML ⇒
新的 HTML 指向 `flutter_bootstrap.<指纹>.js` ⇒ **新名字，绕开旧缓存**。

```
改前：index.html ─→ flutter_bootstrap.js ─→ main.dart.js          ← 三个名字都固定
改后：index.html ─→ flutter_bootstrap.6b1abc336ff6.js ─→ main.6b1abc336ff6.dart.js
        └ no-cache      └ 内容变了名字就变 ⇒ 可以直接长缓存
```

⚠️ **顺带的好处**：`immutable` 这条规则终于**有东西可匹配**了 ——
名字没变时那 2.4MB 直接命中缓存、**一个往返都不用**；
名字变了就一定取新的。**两层加起来才是对的**：
只有服务端那一层，每次加载都要往返一次；只有部署那一层，`assets/` 那些还是老问题。

### 2.2 公网实测

```
$ bash scripts/deploy-web-v2.sh --no-build
▶ 入口指纹 6b1abc336ff6
▶ 公网验证
  /api/version → {"buildId":"6b1abc336ff6",…}
  main.6b1abc336ff6.dart.js          → 200 ｜ cache-control: public, max-age=31536000, immutable
  flutter_bootstrap.6b1abc336ff6.js  → 200 ｜ cache-control: public, max-age=31536000, immutable
  index.html                         → cache-control: no-cache
  ✓ 入口 no-cache（老访客每次都会取到新的 HTML，从而指向新名字）
✅ 完成
```

**另一个坑**（顺手修的）：`CONTENT_HASHED` 第一版写成"点 + 十六进制 + **一个**扩展名"，
而真实的产物名是 `main.<指纹>.**dart**.js`（**两个点**）⇒ **一条都匹配不到**。
判据和产物名字的形状对不上，闸就是空转的 —— 是 `deploy-web-v2.sh` 自己跑出来的。

---

## 三、删旧树

| 删了什么 | 量 |
|---|---|
| `services/core/`（旧调度器） | 38 个追踪文件 |
| `apps/mobile/`（旧客户端） | 111 个追踪文件（另有 **919M** 未追踪的构建产物） |
| `packages/protocol/` | 1 个 |
| `scripts/` 里旧项目的四个脚本（`deploy-web.sh`、`enable-https.sh`、`inject-sw-cleanup.mjs`、`self-destruct-sw.js`） | 4 |

**顺手清掉一笔账**：`00-PROGRESS.md` 欠账表第 14 条是
"旧树仍违反 §13.2 第 2 条（不许出现「直接动手」）"——
**树删了，那条回潮断言天然成立**，不用再靠"解释它在注释里"绕。

⚠️ **代价要说清**：`07-APPENDIX.md` §一 那份缺陷清单里记的**全是当年的行号**
（`dispatcher.js:617`、`conversation.js:72`…），**现在那些文件不存在了**。
⇒ 手册那边加了一条说明：那些行号是**历史坐标**，用 `git show f93f296:<路径>` 翻。
（那一段的**结论**仍然有效，而且已经收敛进 `docs/dev/` 各篇。）

**还改了一处门面**：根 `README.md` 之前把旧布局当成"现在的代码"在描述
（"旧实现，只当参考 111 文件"、"47 条验收全过"）——已经重写成 v2 的样子。

---

## 四、验收

```bash
cd v2/services/core && npm test          # 236 条（这一批 +4）
bash scripts/check-client.sh             # 四道闸全过
bash scripts/deploy-web-v2.sh            # 构建 + 部署 + 重启 + 公网验证
```

**变异验证**（证明新闸不是空转的）：把服务端的规则改回旧行为 ⇒ **4 条测试当场红**。

---

## 五、这一批**没做**什么（**明说**）

| # | 没做 | 为什么 / 什么时候 |
|---|---|---|
| 1 | **给 `assets/`、`canvaskit/` 也加指纹** | 它们靠 `no-cache` + 304 兜着（**正确**，只是每次加载多一个往返）。真要更快就得递归加指纹 + 改写 `AssetManifest` —— **这一批没做**，记在欠账表第 15 条 |
| 2 | **`Service Worker` / 自毁 SW** | v2 一直用 `--pwa-strategy=none`（**没有 SW**），所以没有"旧 SW 赖着不走"的问题。⚠️ 但如果哪天打开 PWA，**这套缓存结论要重算** |
| 3 | **安卓包的那份 web 产物** | 安卓是另一个分发路径（APK 自带产物），**这一套缓存规则与它无关** |

---

## 六、补 · 欠账 #15 的**实测结论**（2026-09-21）

> 结论：**`canvaskit/` 那半边无账可还；`assets/` 那半边要两处一起改才有效**。
> 这一轮落地的是**一道自证闸**（下 §6.3），改名那件事**没做**。

### 6.1 `canvaskit/`：**不在取用链上**

真产物里的加载器：`buildConfig` 有 `engineRevision`、**没有** `useLocalCanvasKit`，
而 `_flutter.loader.load()` 是空参 ⇒ **永远取 gstatic**。
本地那份 `canvaskit/`（26M）只是 `--no-web-resources-cdn` 的备份 ⇒ **改了也没人取**。

### 6.2 `assets/`：能改，但要**两处一起**

| 事实（实测） | 后果 |
|---|---|
| 引擎拼的是 `assetBase + "assets/" + key`；**清单里存的是相对键**（不含 `assets/` 前缀） | ⇒ **不用碰二进制 manifest**（这一点我一开始想错了，是子 agent 纠正的） |
| 服务端的 `CONTENT_HASHED` 是 `/[.\-][0-9a-f]{8,}\./i` —— **指纹后面必须跟点** | ⇒ 目录名加指纹（`assets.<指纹>/`）**仍被判 `no-cache`** ⇒ 只改目录名**纯亏**（部署后首访从 304 变成整份 200 重下，NOTICES 1.7M） |

⇒ 要做就得**一起**：① `src/server.js` 的正则末尾 `\.` 放宽成 `[.\/]`；
② deploy 脚本 `assets/` → `assets.<指纹>/` + 给 `_flutter.loader.load()` 传 `assetBase`。
**⚠️ 还没做**：它改的是"缓存行为"这一块（我们在这里出过一次事故），
而且收益只是"少几次 304 往返" ⇒ **由主人拍板**（见 `00-PROGRESS.md` §六 #15）。

### 6.3 这一轮真正落地的：**部署前那道自证闸**

新增 `scripts/check-web-refs.mjs`，接进 `deploy-web-v2.sh`：**暂存之后、重启之前**跑，
**非 0 就不部署**（沿用"构建失败就不部署"那条纪律）。

它做一件事：**从 `index.html` 出发，顺着引用把每个被引用的文件都找一遍 —— 一个 404 都不许有。**
外部地址（gstatic 那种）只列不判。

真产物上：`✅ 引用全在：对了 11 个文件，0 个 404`。
**变异验证**（把 `assets/` 改名但不改引用）：当场 **3 红、exit 1** ⇒ 这道闸不是空转的。

### 6.4 顺带发现的：**用户看得见的脚手架占位**（已修）

`web/index.html` 与 `web/manifest.json` 一直留着脚手架生成的东西：

```
<title>hupo_app</title>                       ← 浏览器标签页
"name": "hupo_app", "short_name": "hupo_app"  ← **"添加到主屏幕"之后的图标名**
"description": "A new Flutter project."       ← 分享出去时显示的描述
```

⚠️ **平板用户最可能看见的就是那个图标名**。已改成：标题与主屏幕名 = **助手**，
描述 = 那句已经过了禁用词闸的实话「你说的事它真会去做，不只是陪聊。」，
并加了一条 `test/unit/web_shell_test.dart`（同 `android_manifest_test.dart` 那一类：**配置断言**，
不许再出现 `hupo_app` / `A new Flutter project.`）。
公网核实：`<title>助手</title>`、`manifest.name = 助手` ✅。
