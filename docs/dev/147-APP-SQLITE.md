# 147 · **一个小程序一个独立的 SQLite**（主人 2026-09-30 拍板 · 契约）

> **主人的原话**：*「sqlite 是一定要有的，必须要有这个能力。你要给我负责创建小程序的 agent，
> 做好这个规则。一个小程序有一个独立的 sqlite」*

**做完了**（这一篇是它的契约）：**一个小程序 ＝ 一个独立的 SQLite 文件**，
而且**执行它的那一层在壳这一侧**（Node 24 自带 `node:sqlite`，零依赖）——
网页那一侧与安卓那一侧**走同一条路**，不需要原生桥（铁律 3 没破）。

---

## 一、先把事实摆齐（全是 2026-09-30 现量的，不是推的）

| # | 事实 | 怎么量的 / 读数 |
|---|---|---|
| F1 | 网页上的小程序**没有任何存储** | 它跑在 `sandbox="allow-scripts"` 的 iframe 里 ⇒ **不透明源** ⇒ `localStorage`/IndexedDB/OPFS 全没有（这一条早就在 `#209` 落进手册 §14.1） |
| F2 | **`node:sqlite` 在 Node 24 里自带，worker 线程里也能用** | 探针：worker 里 `DatabaseSync` 建表/写/读全通 |
| F3 | 🔴 **`worker.terminate()` 打断不了一条正在跑的本地调用** | 探针：一条失控递归把整个探针卡到 **60s 超时**（worker 还在烧 CPU） |
| F4 | ✅ **进程 ＋ `SIGKILL` 可以**，而且杀完库还能开 | 探针：**1509ms** 停下（`sig=SIGKILL`），随后同一条库 `sqlite_master` 读得好好的（热日志自恢复） |
| F5 | **一次子进程调用约 30–40ms** | 探针：冷 **35ms** / 暖 **31ms** —— 这是"能硬停下"的价钱（写在 §五） |
| F6 | **`PRAGMA max_page_count` 是硬的** | 探针：64 页上限下写到第 **1178** 行报 `database or disk is full` |
| F7 | **`setAuthorizer` 认得出那三个动作** | 探针逐条打出来：`PRAGMA`=**19** · `ATTACH`=**24** · `RECURSIVE`=**33**（拒 `WITH RECURSIVE` 是真的能拒） |
| F8 | 🔴 **不透明源 ＋ CSP `connect-src 'self'` ⇒ 请求发得出去** | 真 Chrome（`~/.cache/hupo-chrome`，`--headless=new --virtual-time-budget`）：iframe 是 opaque origin，`fetch('/ping')` **到得了服务器**（服务端看到 `origin: "null"`） |
| F9 | 🔴 **但跨源那一道要看 `Access-Control-Allow-Origin`** | 同一条探针：服务端**不**带那个头 ⇒ 页面拿到 `TypeError: Failed to fetch`；带上 `*` ⇒ `{ok:true, t:"hello"}`（**读到正文**） |
| F10 | **制品两端吃的是同一个 CSP 响应头** | 网页（`<iframe sandbox>`）与安卓（WebView **顶层文档**）都从 `apps.stalkerai.cn` 加载制品（`mini_runtime_native.dart` 顶上那段） |

⇒ F8 ＋ F9 ＋ F10 是这件事的**地基**：把"存一笔"做成**制品对它自己那个原点的一次请求**，
**两端就天然一致**（不用桥、不用两端各写一套）。

---

## 二、形状（一条一条）

| 项 | 形状 | 为什么 |
|---|---|---|
| **落点** | `<他那一格>/hupo/apps/<id>/data.sqlite`（`Apps.appDir(id)` 里、**`versions/` 外面**） | 发新版**不动它**；删那个 app 时**跟着它走**（`appDir` 整个挪进 `.removed/`）；**按人分开** ⇒ 甲看不见乙的 |
| **一个 app 一个文件** | 就是上面那一条（**不是**"一个人的所有 app 一张表"） | 主人拍的那句：*一个小程序有一个独立的 sqlite* |
| **谁执行** | **壳这一侧**（`src/app-db.js` → 子进程 `src/app-db-run.js`），制品**永远拿不到文件** | 制品是**第三方内容**；文件在**他的机器**上，只有壳碰得到 |
| **两端怎么取用** | 制品 **POST 它自己那个源**的 `/db`：第一次带它入口 URL 里的 `u/e/s`（**照入口签名那四道验**）换一张**会话票**，之后用票 | F8/F9：两端都从同一个原点加载 ⇒ **同一条路**；入口 URL 只有十分钟，而页面可能开几小时 ⇒ 票 |
| **声明 → 允许** | 清单里的 `permissions: ["db"]`（**申请**）＋ `grant.json` 里的授予（**他点的头**） | 照 `ask` 那条先例；**两样都齐了才算**。签字那一下是 `POST /api/app-grant`（走登录态，**助手那条口碰不到它**） |
| **给什么** | 三条动作：`run`（写/改）、`get`（一行）、`all`（多行）；参数**一律绑定**（`?`） | 页面不许拼字符串（那是注入的形状） |
| **一次一条语句** | 多语句当场拒（**注释与字符串里的 `;` 不算**，真扫一遍状态） | 一条 SQL 干两件事是绕过上限最省事的办法 |
| **上限** | 数字**只住 `src/app-db.js`**：每库字节（`max_page_count` 落到库上）· 一条 SQL 长度 · 参数个数 · 带回行数（**截断就如实说**）· 结果字节 · 单次超时（到点 `SIGKILL`）· 每分钟调用次数 | 手册纪律 1：写进文档的那一刻它就开始过期 |
| **留痕** | 拒的那几档写审计（`db-deny` / `db-rate` / `db-full`）；**成了的不写** | "谁想干什么被拦了"要查得到；每调一次写一行会把账淹掉 |
| **册子** | 那一张设置卡（「小程序要用的东西」——它想要什么 / 你给了没有） | 主人原话：*"在设置里可以看到也可以关闭"* |

### 册子（设置页那张卡 · 客户端那一半）

| 项 | 形状 |
|---|---|
| 在哪 | 设置页（主人原话：*"在设置里可以看到也可以关闭"*），插在「这块窗口」之后、「这个助手」那一组之前 |
| 列什么 | **只列声明了东西的 app**；一个都没有 ⇒ **一个像素都不画**（判据量的不只是"找不到 key"，还量了 `maxScrollExtent` 与"根本没有这张卡"逐字相同） |
| 一行两件事 | ① **它想要什么**（人话：`db`→「想把东西存下来」· `ask`→「想用你的钥匙问一句」· 认不出的→「还想再要一样东西」）；② **你给了没有**（开关） |
| 点一下 | 等回执 ⇒ **服务端明说 ok 才改屏幕上的状态**；没成 ⇒ 开关**一动不动** ＋ 照服务端那句 `text` 说（空则兜底句）。**不许**先拨过去再回滚、**不许**静默 |
| 三条"不给开关" | ① `granted` 字段**缺失**（老服务端 ⇒ **不知道**，`null` ≠ `[]`）② 认不出的名字 ③ 这一条路没接线 —— 三种都**不画开关**（画个假的就是"页面在说假话"） |
| 文案住哪 | 只住 `lib/models/space_words.dart`（进禁用词硬闸）；协议名（`db`/`ask`）**一个都不许上屏** |
| 判据 | `test/unit/app_grants_test.dart` **16**（含"`granted` 缺 ⇒ `null`、空 ⇒ `[]`"两件事分开）· `test/widget/settings_grants_test.dart` **11**（全部**像用户那样点**：回执没回时屏幕上不许已经是"已允许"）· a11y **+10**（五档不溢出 ＋ 命中区；⚠️ 把"像用户那样滚到卡"删掉 ⇒ 那 10 条**全红**，证明它们在真量这张卡） |
| ⚠️ 如实说 | 客户端只对着 MockClient 验过，**没有**对着活服务端打一次（形状是从 handler 读出来对齐的）· **没有截图**（要跑起来得先部署）· 401 时卡上是兜底句（准确那句由宿主屏说 ＋ 回登录页） |

### 两道防线（跨库那条路堵死）
1. **文本守卫**（`guardSql`）：`ATTACH` / `DETACH` / `load_extension` / `VACUUM` / 显式事务
   / `readfile`·`writefile` 一律拒（按**词边界**判，`attachment` 这种列名不误伤）。
2. **`setAuthorizer`**（在子进程里）：`ATTACH`(24) / `DETACH`(25) 直接拒 ·
   `PRAGMA`(19) **只放行 `user_version`**（迁移要用）· `RECURSIVE`(33) 拒。

⇒ 就算第一道漏了，第二道也过不去；就算两道都漏了，那个文件也**只**在它自己那一格里
（路径由 `Apps.dbPath()` 定死，**页面报的任何路径一个字节都不采信**）。

---

## 三、给**创建小程序的 agent** 的规则（主人点名要的就是这一节）

> 这一节的正式落地在 **`v2/services/core/hupo-persona.yml` 的「小程序」那一节**
> （那是它的 prompt 里**真的会读到**的那份，判据：`bash scripts/check-persona.sh`）。
> 这里放**完整版**，给写页面的人照抄。

### 3.1 什么时候用它

* 这个小程序**要记住东西**（进度、历史、清单、他填过的表）⇒ 用**它自己那一格 SQLite**。
* 只是**内容**（题库、词表、一张固定的图）⇒ 照旧**写进文件**（那是制品，随版本发布）——
  **不需要**存储、也不需要他允许。**能静态就别动态**。

### 3.2 页面里那段（照抄；`entry` 那一页最上面那段脚本）

```html
<script>
// 这个小程序自己的那一格存储（一个小程序一个独立的 SQLite）。
// 规矩：① 一次一条语句 ② 参数一律用 ? 绑定（不许拼字符串）
//      ③ 表自己建（IF NOT EXISTS）④ 迁移用 PRAGMA user_version
const DB_URL = '/db';
// 入口 URL 里那三样（绑人 + 绑 app + 有到期）—— 第一次用它换一张票
const Q = new URLSearchParams(location.search);
const VER = (location.pathname.match(/^\/a\/[^/]+\/([^/]+)\//) || [])[1] || 'live';
let ticket = null;
async function db(op, sql, params = []) {
  const body = ticket
    ? { id: APP_ID, v: VER, ticket, op, sql, params }
    : { id: APP_ID, v: VER, u: Q.get('u'), e: Q.get('e'), s: Q.get('s'), op, sql, params };
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || j.ok !== true) throw new Error(j.text || '存不下');
  if (j.ticket) ticket = j.ticket;          // 留着，后面就不用再出示入口签名了
  return j;                                  // { rows, changes, lastInsertRowid, truncated }
}
// 建表（打开就建，幂等）
await db('run', 'CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, body TEXT)');
</script>
```

⚠️ `APP_ID` 是**这个小程序自己的 id**（页面里写死那一串，和它的目录名一样）。

### 3.3 它**拿不到**什么（写页面时不许假装有）

* 拿不到**别人**小程序的库（`ATTACH` 是拒的）；
* 拿不到文件路径（那条口只认 `op/sql/params`）；
* 拿不到钥匙（**要"问一句"是另一件事**，见 `ask`）；
* **不许**递归查询、**不许** `PRAGMA`（除 `user_version`）、**不许**显式事务；
* **不许**把钥匙、聊天记录、别人的数据塞进去 —— 那一格库是**这个小程序自己**的状态。

### 3.4 被拒的时候页面要**如实说**

| 屏幕上发生什么 | 服务端说的是什么 | 页面该怎么办 |
|---|---|---|
| 他没允许（或刚关掉） | 403「你还没允许它存东西。」 | 照这句话显示，**不许**假装存上了 |
| 这个 app 没声明 | 403「这个小程序没说要存东西。」 | 同上（作者 bug，如实显示） |
| 库满了 | 507「这个小程序的存储满了。」 | 如实说，并提示"清一清旧的" |
| 一条查太久 | 503「这一条查得太久了……」 | 如实说，把范围写小 |
| 一分钟里太频繁 | 429「……存得太频繁了」 | 等一下再试 |

---

## 四、判据（每条都带反例 · 每条都跑过）

`test/app-db.test.js`（**D1–D7** · 16 条）：

* **D1 真库**：建表 → 写 → 读回来（真 `node:sqlite`）· 守卫：多语句拒 / 字符串里的 `;` 不误伤 /
  `attachment` 这种列名不误伤 / 参数只认 `null`·字符串·数字·布尔（`NaN`·`Infinity`·对象·`Buffer` 全拒）。
* **D2 跨库**：`ATTACH` 两道都拒（**第二道是直接绕开守卫调的**，验的正是 `setAuthorizer`）·
  `PRAGMA user_version` 放行、别的 `PRAGMA` 拒。
* **D3 硬超时**：四路自连接 700ms 到点 ⇒ 回那句人话，**并且去 `/proc` 看那个子进程真的没了**
  （`sig=SIGKILL`）；**杀完库还能用**。
* **D4 上限**：8KiB 的库写 20,000 字符 ⇒ 「满了」（`max_page_count` 顶的）·
  行数截断**如实说**（`truncated:true`）· 结果太大如实拒。
* **D5 三道闸**：没声明 403 / 没允许 403 / 动作与语句不认 400 · 撤销**立刻**生效 ·
  **一个 app 一个文件**（A 里写的东西在 B 里查不到）。
* **D6 票**：换来的能用 · 换 app 不算 · 过期不算 · 改一个字符不算 · 换一把键不算。
* **D7 那条口**：没凭据 403（而且带跨源头）· 签名换票 ⇒ 用票继续 · 别的 POST 照旧 405 ·
  `OPTIONS` 预检答得上 · CSP 只放 `'self'`（**不许**退回 `'none'`、**不许**出现 `*`）。

`test/app-grant.test.js`（**G1–G4** · 4 条）：

* **G1** 没允许 403 ⇒ 他点一下 ⇒ **当场**存得进去 ⇒ 关掉 ⇒ **当场**进不去（**关掉不删库**）。
* **G2** 界面上"它想要"与"你给了没有"是**两件事**（`permissions` vs `granted`）。
* **G3 租户**：`grant.json` 与 `data.sqlite` **只出现在盒里**，宿主那格**一个字节都没有**；
  跑存储那几步**真过隧道**（dial 计数）。
* **G4** 不认识的权限名 400 · 不在他这儿的 app 400 · 没令牌 401/403。

**四条红是既有闸自己抓出来的**（记在这儿，因为它们比"我想到的"值钱）：

| 谁的闸 | 抓到什么 | 怎么修的 |
|---|---|---|
| `test/apps.test.js` · `test/app-live.test.js` V3 | 两处老判据钉的是 `connect-src 'none'` ⇒ 改完**当场红** | 判据改成**更严的写法**（只认 `'self'`，出现 `*` 就红）—— 这就是这次改动的真实反例 |
| `test/route-shape.test.js` | **代码里每条 `/api/…` 都要进手册 §2.1** ⇒ 新加的 `/api/app-grant` 没写表就被抓 | 补进 `08-SPEC.md` §2.1（顺带把"签字的是他""以盒子为准""关掉不删数据"写进那一行） |
| `test/apps-box.test.js` **B15-5** | 它量的是"这一趟开了几次隧道"：我第一版让宿主**每个 app 各问一次** `grant.json` ⇒ 甲那一趟从 1 次变 2 次，**判据红**（20 个 app 就是 20 次往返） | 改成**盒子那份清单顺手把 `granted` 带回来**（`/internal/apps` 一趟）⇒ 宿主那一侧**一次都不多问**；那个"只读一次"的 `grantsOf` 顺手删掉（不留死代码） |

**变异（每刀只改一处、跑完逐字节还原）**：

| 刀 | 结果 |
|---|---|
| 去掉 `setAuthorizer` 里 `ATTACH`/`DETACH` 那两行 | **D2 红** |
| 超时那一步**不 kill**（只回一句话） | **D3 红**（第一版判据只验"回了那句话"⇒ **照样绿**，所以判据改成"去 `/proc` 看它真没了"） |
| 授予那一档不判（没允许也放行） | **D5 红**（两条） |
| `connect-src` 退回 `'none'`（历史行为） | **三条判据红**（`apps.test.js` · `app-live.test.js` V3 · 本文件 D7） |

---

## 四·甲、**真浏览器端到端**（临时实例 · 不碰线上）

前三条事实（F8/F9）是**分件**量的。落完代码之后又**整条**量了一次
（2026-09-30 · 一次性实例：临时数据目录 ＋ 主口 8122 ＋ 制品口 8123；
父页面在 `127.0.0.1:8099`，用 `<iframe sandbox="allow-scripts">` 嵌**真那条签名入口 URL**）：

| 量到什么 | 读数 |
|---|---|
| 制品口真的在服务 | `GET <签名 URL>` ⇒ **200**，页面里就是我们写的那段 |
| 壳那一侧认得出沙箱 | 项目自己的浏览器驱动报：`小程序壳 ✅ iframe origin=http://127.0.0.1:8123 sandbox="allow-scripts"` |
| 请求真到了（含预检） | 服务端侧看到：`OPTIONS origin=null` ⇒ 然后 `POST origin=null`（**跨源预检真的发生了，而且过了**） |
| 页面拿到的每一步 | `begin → send(run,ticket=false) → resp 200 → created → send(run,ticket=true) → resp 200 → inserted → send(all,ticket=true) → resp 200 → read rows:[{body:'e2e-第一行'}]` |
| 盘上 | `hupo/apps/dbprobe/data.sqlite` 真出现（**0600**），里面就那一行 |

⚠️ **探针自己踩的坑（记下来，别再踩）**：`chrome --headless --virtual-time-budget` 会在
**虚拟时间**用完时立刻 dump DOM —— 而"跑一条 SQL"要等一个**真**子进程（30–40ms 墙钟）
⇒ 父页面永远只看到 `send` 那一步，**看着像请求卡死**（其实服务端 OPTIONS＋POST 都收到了）。
⇒ **要真等，就用项目自己那个驱动**（`scripts/check-web-browser.mjs --wait …  --eval …`），
它按**墙钟**等，不按虚拟时间。

## 五、**如实说**：没做的 / 代价

* **一次调用多 30–40ms**（F5）：这是"能硬停下一个子进程"的价钱。**没做**进程池/常驻子进程
  （那要另写生命周期与回收；今天这一步先要"正确"，不要"快"）。
* **二进制（BLOB）没开**：只认 `null`/字符串/数字/布尔。要开得先定编码与上限。
* **导出/带走没做**：库不能导出成文件给他。
* **跨 app 共享没做**（也不打算做）。
* **"清空这个小程序的数据"那颗按钮没做**（今天想清只有把 app 删掉再建 —— 删 app 时库跟着进
  `.removed/`）。⚠️ 这条是**明确欠着的**，不是"以后再说"糊过去的那种：要就单独一刀。
* **没做**"让助手读这个 app 的库"的程序化口子（助手要查，走 `/db` 那条口的人话路径也行，
  但那是另一件事）。
* **iOS 侧没有这条能力**（iOS 商店版不许小程序运行时，铁律没变）。

---

## 六、账（事实来源）

* 服务端：`src/app-db.js`（协议 / 守卫 / 票 / 子进程）· `src/app-db-run.js`（那个子进程）·
  `src/apps.js`（`dbPath` / `dbExec` / 频率 / 权限白名单）· `src/app-serve.js`（`POST /db` ·
  CSP `connect-src 'self'` · 跨源预检）· `src/apps-box.js`（租户那两条口）· `src/server.js`
  （`/api/app-grant` · `/api/apps` 的 `granted` · 两个内部口 —— 其中 `/internal/apps`
  **顺手把 `granted` 带回来**：一趟带回，宿主不再逐个去问盒子）。
* 判据：`test/app-db.test.js` · `test/app-grant.test.js`；两条老判据跟着改（`test/apps.test.js`
  与 `test/app-live.test.js` 的 V3 —— **改前那两条是绿的，改完当场红**，所以它们是这次改动的
  真实反例）。
* 两闸读数：服务端 **1322 过 / 0 挂**（这一批 **+24**）· 客户端 `check-client.sh` **硬闸全过**
  （analyze 干净 · unit **821** · a11y **389** · 其余界面 **405**；这一批 unit **+19** · a11y **+10**）。
* 🔴 **顺手还了一笔既有红**：`test/unit/server_address_test.dart` 那条判据在 HEAD 上**一直是红的** ——
  它先按行过滤 `build apk`、再逐行查 `--dart-define=HUPO_API=`，而 `scripts/build-apk.sh`
  用行尾 `\` 把这两半写在**两行**（脚本是对的）⇒ 它量的是续行语法，不是它声明的那件事。
  `#207` 那一批把它改坏之后**没人再跑客户端闸**（那一批没动 Dart）⇒ 这条红躺了一整轮。
  ⇒ 判据改成"先把逻辑行拼起来再查"（守的东西一个字没变：拿掉那个 define 照样红）。
* `docs/handbook/08-SPEC.md` §14 与 `CHANGELOG.md` 同步（手册那两处原来写着
  `connect-src 'none'`）。
* **上线读数（非侵入那三条 · 2026-09-30）**：`POST /api/app-grant` 没令牌 ⇒ **401**；
  `/api/apps` 现在带 `granted`（线上读数：`wenda` 那一格 `permissions:['ask']` ＋ `granted:['ask']`，
  另外两个都没声明）；制品口 `POST /db` 拿假签名 ⇒ **403**；部署产物里 `api/app-grant` **命中 1 处**
  （⇒ 那张卡真进了这一版的包）。入口指纹 **`252b7451e0a0`** · 客户端源码指纹 `fb368ce4c38f` ·
  产品层 **`b43d7425a883`**（三台盒子那一侧的两条内部口跟着这一版）。
