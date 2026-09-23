# 61 · 页面为什么那么慢（2026-09-23 主人报的"页面加载很慢"）

> 主人原话：*"页面加载很慢，怎么回事"*。
> 这篇是**排查过程 + 三处修复 + 读数**。契约层面：`08-SPEC.md`（产物与缓存）· [`15-CACHE.md`](15-CACHE.md)。

---

## 一、量出来的事实（**先量，别猜**）

| 量什么 | 读数 | 说明 |
|---|---|---|
| 往返延迟 | `index.html` 1.2KB / **0.09s** | 延迟没问题 |
| 吞吐 | `main.dart.js` 2.73MB / **6.5s** | ⇒ 这条链只有 **~3.4 Mbps** |
| 压缩 | 响应头里**没有** `content-encoding` | 服务端代码里也没有 gzip/br ⇒ **原样发** |
| CanvasKit 在哪 | 产物里写着 `https://www.gstatic.com/flutter-canvaskit/…` | ⇒ 每次都要去 **Google 的 CDN** |
| 中文字体在哪 | `https://fonts.gstatic.com/s/notosanssc/…woff2` | ⇒ 中文也要去 **Google 的 CDN** |

🔴 **"这台机器取 gstatic 只要 0.4s"是个陷阱**：它取得到，所以**本地一切正常**；
而用户那边（国内）**取不到或很慢** ⇒ 页面等在那里、甚至**一个字都不显示**。
⇒ 判据只能是"**把 gstatic 整个屏掉，页面照样得开、中文照样得有字**"。

---

## 二、三处修复

### 1. 静态预压缩（**省 77% / 69%**）

服务端从来没压过。`scripts/precompress.mjs`（部署时跑一次，br + gz 放在原文件旁边），
`server.js` 的静态那一段按 `Accept-Encoding` 发预压的那份（**br 优先**）+ 必带 `vary`。

| 文件 | 原 | br |
|---|---|---|
| `main.dart.js` | 2.73MB | **601KB**（23%） |
| `canvasit.wasm`（拼写见产物） | 6.89MB | **2154KB**（31%） |

⚠️ **为什么必须预压而不是"现场压"**：这条上行只有 3.4Mbps —— 省下的传输时间远大于压缩那点 CPU；
而且只有预压才用得上 **brotli**（现场压只能用 gzip）。

### 2. CanvasKit 自托管（`--no-web-resources-cdn`）

默认构建把 CanvasKit 指向 gstatic ⇒ 国内经常取不到。
构建加 `--no-web-resources-cdn`（产物里会出现 `"useLocalCanvasKit":true`）⇒ 从我们自己域名取。

⚠️ **我第一次的自检写错了**：拿"产物里有没有 `gstatic` 那个字符串"当判据 ——
那个字符串是**加载器里的分支**（`useLocalCanvasKit` 为假时才走），**永远在** ⇒ 误报。
⇒ 判据要查**那面旗**（`"useLocalCanvasKit":true`）。

### 3. 中文字体也自托管（`/fonts/` 镜像）

🔴 **这是"加载很慢"的真凶**，而且它还有个更坏的面：**屏掉 gstatic 之后，图标在、中文字全空**。
⇒ 做法：
* 服务端加一条 **`/fonts/…` 镜像**（`server.js`）：**白名单**路径 → 去 `fonts.gstatic.com/s/…` 取一次 →
  落盘缓存（`data/font-cache/`）→ 按 `immutable` 发（路径里带版本与内容哈希）。
* 部署时把引擎的 **`fontFallbackBaseUrl` 指到我们自己的地址**（`_flutter.loader.load({config:…})`）。

**两处坑（都是当场抓出来的）**：

1. 🔴 **必须是绝对 URL**：第一版写的是相对地址 `/fonts/` —— 引擎**取到了字节（200、24780 字节）
   却对不上号**，中文**全变成方块**（而且**不报错**）。
   判据"屏掉 gstatic 看有没有字" + A/B 才把它抓出来。
2. 🔴 **补丁也要进指纹**：入口名字是按 `main.dart.js` + `flutter_bootstrap.js` 的字节算的，
   而这两处 patch 改的是**部署出去的那一份** ⇒ 不把补丁算进去，**改了补丁文件名也不变**，
   浏览器（`immutable`）会一直吃缓存里的旧补丁 —— 这次**差点被它骗过一次 A/B**
   （两次截图字节相同才发现）。⇒ 指纹里加上 `font-patch-v1|<公开基地址>`。

---

## 三、读数（走公网、带 br）

| 大件 | 之前 | 现在 |
|---|---|---|
| `main.dart.js` | 2.67MB / **6.5s** | **601KB / 0.99s** |
| `canvaskit.wasm`（自托管） | 6.9MB / **16s**（且 gstatic 国内常取不到） | **2154KB / 5.5s** |
| `flutter_bootstrap.js` | 9.5KB / 原样 | **3KB** |
| 中文字体 | `fonts.gstatic.com` ⇒ 慢 / 无字 | **我们自己的 `/fonts/`** ⇒ 屏掉 gstatic 也有字 |

**判据（一条命令，可重复）**：
```bash
HUPO_TOKEN=<令牌> node scripts/check-web-browser.mjs --block-gstatic --shot /tmp/x.png
```
🔴 **屏掉 gstatic 之后必须满足两件**：① 页面照常打开、流照常通；② **中文有字**（不是方块、不是空白）。

---

## 四、⚠️ 还剩一个结构性的慢（**记下来，别当已经解决**）

**每一个字节都要过隧道回到这台工作站**：浏览器 → VPS nginx → frp stcp → **本机 127.0.0.1:8020**。
这条链的上限实测 **~3.4 Mbps** ⇒ 首屏那 2.7MB（br 后）就是 5～7 秒的地板。

**真正的修法**：把**静态产物放到 VPS 本地**（nginx 直接发文件），隧道只留给 `/api` 与 `/api/stream`。
那样静态那部分走 VPS 的带宽（通常几十上百 Mbps）。
⚠️ 这要动部署脚本（rsync 到 VPS）+ nginx 两条 location，**并且要在 VPS 上改配置**（那台跑着 13 个别站）
⇒ 按 P1/P2 **要主人签字**，记成账（见 `00-PROGRESS.md` §六）。
