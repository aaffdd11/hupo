# 236 · 小程序的「推送那两条」：沙箱放行 `wss` ＋ 数据不落库 ＋ 全接入（2026-10-11 夜）

> 主人在 `#353`（期货交易台 v2）之后一句：*"小程序接入数据可以全接入，但不落库。
> 实际上就是 api 访问和 websocket 推送。"*
> 他跟着点了两条：**① 交易推送直连 finart 的 WS**（那三行 nginx 由他在 VPS 上加）·
> **② 站白名单保留、那个站的接口全接**。

---

## 一、先量（三个读数决定了这一批怎么切）

| 量什么 | 读数（2026-10-11 23:2x） |
|---|---|
| finart 有没有 WS | **有**：`backend/app/routers/ctp_trade.py` 的 `@router.websocket("/ws")`（router 前缀 `/api/ctp/trade`）⇒ 公网应是 `wss://v.stalkerai.cn/api/ctp/trade/ws`；推 `{type:"order"｜"position"｜"account"}` ＋ 30 秒一个 heartbeat |
| 本机那条通不通 | `ws://127.0.0.1:8017/api/ctp/trade/ws` ⇒ **握手成功** |
| 🔴 公网那条通不通 | **404** —— `v.stalkerai.cn` 的 nginx 在 **VPS（120.26.179.211）**上（`/etc/nginx/conf.d/v-stalkerai.conf`，反代 `127.0.0.1:3083` 的 frp visitor），它**没带 `Upgrade`/`proxy_http_version 1.1`** ⇒ 握手被当成普通 GET ⇒ uvicorn 那边没有这条 HTTP 路由 |
| 市场那条 | finart 的 md **只有 SSE**（`/api/futures/md/stream/{symbol}`：先发基线快照、再逐笔增量、15 秒心跳）—— **本来就能用**（`EventSource` 走 `connect-src`，声明过 `v.stalkerai.cn` 就通），不用改任何东西 |
| 我们自己的闸 | 小程序**明令不许开长连接**（`app-lint.js` 把 `new WebSocket` 归在 `external-resource` 一票否决里）＋ CSP 里只有 `https://<站>` —— 🔴 `connect-src` 里 `https://a` **不覆盖** `wss://a`（协议对不上） |

## 二、我们这边改了三处（一处都不能少）

1. **`src/app-lint.js`**：`new WebSocket(` **从"外部资源"那一档里拿出来**（"连一个声明过的站取数据"和
   "引一个没声明的 CDN"是两件事）；`httpsHostsIn` 现在也认 `wss://` ⇒ **长连接与 `fetch` 用同一份名单**；
   新码 **`ws-insecure`**（明文 `ws://` ⇒ https 页面上被**混合内容**拦掉，写了也是连不上）。
2. **`src/app-serve.js` 的 `cspFor`**：名单里的站 **`https://` 与 `wss://` 一起给**。
   🔴 这不是放宽边界：**能连哪个站还是名单说了算**（只有一处），变的是"这个站能用哪条协议连"。
   少写这一条的表现就是"声明了、也点头了，推送永远连不上"（而页面不会告诉你为什么）。
3. **标准三份一起改**（一处一改，不许只改一半）：
   `docs/dev/149-APP-DEV-STANDARD.md` 的 `P5` ＋ 码表 ·
   技能 `v2/services/core/skills/mini-app/SKILL.md` 的 `P5`／`C3`／码表 ·
   手册 `docs/handbook-v3/09-APPS.md` 沙箱铁律第 5 条 ＋ **新加 5·补「外部数据不落库」**
   （⚠️ 手册是 `strict` ⇒ **要主人重建开机清单**）。

## 三、小程序本体（v3）

| 改了什么 | 怎么做 |
|---|---|
| **交易推送（WS）** | 进「交易」那一块就开 `wss://v.stalkerai.cn/api/ctp/trade/ws`；收到 `order`/`position`/`account` ⇒ **一秒内合并**拉一次那本账（推来的那一格是事件，不是完整快照）；断线**退避重连**（1→2→4→8→15 秒封顶）；**通了就不轮询**，没通才 15 秒兜一次，而且界面上**如实写**"推送没连上…先用轮询" |
| **行情推送（SSE）** | 合约详情抽屉打开时 `EventSource('/api/futures/md/stream/{合约}')`：`snapshot` 铺基线、`tick` 逐笔更新**实时分时图**；关掉抽屉就 `close()`（不留孤儿连接）；断了如实说（`EventSource` 自己重连） |
| **不落库** | 行情／推送／资金／持仓／委托／成交**一个字节都不进 `/db`**（全在内存里，页面一关就没）；`/db` 只剩**它自己的三样**：自选、设置（密码哈希＋手数上限）、本机下单留痕 |
| **全接入** | 又接上四条：`/api/ctp/trade/calendar`（日盘/夜盘/下一场，摆在通道卡那一行）· `/api/ctp/trade/instruments/{code}`（乘数/最小变动/它那条单笔上限，尽力取）· `/api/futures/settlements/{code}`（权威结算价六行）· `/api/futures/history/continuous/{R B 0}`（主力连续日线，第二张小图） |

⚠️ 顺手记两条**实抓**才知道的形状（照文档猜会写错）：
`/api/futures/settlements/{code}` 的 `items` 是**对象数组**（`{date,open,high,low,close,settle,…}`），
而 `/api/futures/history/continuous/{code}` 是**数组 ＋ `columns`** —— 两条路形状不一样。

## 四、判据与读数

| 判据 | 读数 |
|---|---|
| 制品自查 | **0 errors / 0 warnings**（这一版 **74,269** 字节） |
| 服务端全闸 | 见 `00-PROGRESS.md` §〇 那一行（本片 `app-lint` ＋ `app-serve` 动了，判据跟着改） |
| `test/app-lint.test.js` | 新增一条：`new WebSocket('wss://声明过的站')` ⇒ **不报**；没声明 ⇒ `host-not-declared`；明文 `ws://` ⇒ `ws-insecure`；`httpsHostsIn` 也认 `wss://`（去重） |
| `test/app-net.test.js` | N1/N2 那条改成 `connect-src 'self' https://api.example.com wss://api.example.com …` |
| 产品层 | **`987d361cea07 → 3b615d38dace → 6048b58418d2`**（两次都 `--verify` 真跑容器、自报同一指纹；三台盒子各自报"跑的就是当前那一版"）。⚠️ 第一层是"沙箱放行 wss"，第二层是 `4.1` 那处修复 —— **`install` 出来的 app 想更新，盒子必须是第二层** |
| 以他的身份核（`/api/apps` ＋ 公网制品口） | 桌面那一格 **v4 · 74,269 字节**；取回那份的 **sha256 `24dc2a8208e85e20` ＝ 源码**（修前取回的是 v2 的旧字节 `44f9c54c…`）；响应头 **`connect-src 'self' https://v.stalkerai.cn wss://v.stalkerai.cn`** |
| ⏳ 公网那条 WS | **仍然是 404**（等 §五 那三行；本机那条**通**）⇒ 页面上**如实**写"推送没连上…先用轮询"，这条**没假装** |
| **真浏览器**（本机静态口 ＋ 假 `/db`） | ① 交易那一块：`pushPill = 推送没连上`、hint = *"推送没连上，每 15 秒轮询一次兜着；它自己在重连。"*（公网 WS 还没放开 ⇒ **如实说**，不是假装）；`/calendar` 那一行真读到了 *"今天不是交易日 · 日盘 09:00-10:15、10:30-11:30、13:30-15:00 · 夜盘 21:00-02:30(次日)"* ② 合约详情：**SSE 真连上了** ⇒ `推送中 · 收到 1 笔`、`121 个分钟点 · 最低 3,089.00 · 最高 3,101.00`、两张内联 SVG（分时 ＋ 日线）、结算价六行真读数 ③ 🔴 **看一眼截图又逮到一处**：每张弹层的标题都渲染成 `[object HTMLDivElement]`（`modalShell` 的签名 `(title, sub)` 与**所有**调用点的 `(sheet, …)` 对不上）—— 闸全绿、JS 一行不报错，只有截图能看见 |

### 4.1 🔴 又逮到一处更狠的：**装了新版，他打开的还是旧的**

做这一批时验"取回来的字节是不是源码"那一步发现的：取回来的是 **v2 的旧字节**，而盒里已经是 v3。

**根因**（`readLiveApp` · `workspace.js`）：桌面那一格打开的是**活的那一份**
（`/w/<id>/<entry>`）—— 而"活的那一份"**第一次被读的时候就落成到工作区里了**
（`mirrorArtifactIntoWorkspace`，从**当时那一版**），之后**一直按工作区那份答**。
⇒ 光调 `Apps.create()` 出一个新版本，**页面一个字节都不会变**
（"我改了它，他那边没变" —— 正是这个项目最忌的那句假话；
而且**所有闸都是绿的**，只有"取回来比 sha256"才看得见）。

**为什么偏偏是我这条新路踩上**：助手造 app 那条路是"**先在那一间里改文件、再登记一版**"
（工作区是源、制品是快照）；而我这条 `install` 是"**推一版进去**"（制品是源）——
第一次打开把制品镜像进工作区之后，两个源就分家了。

**改**（`src/server.js` 盒子那条 `POST /internal/app`）：收下一版之后，
**如果他那一间已经落成过**（`workspaces.has(id)`）就**把新版本重新镜像进去**；
**没落成过的不建**（第一次打开时从当前那一版落成 —— 原行为不动）。
刷不进去**不让"这一版收下了"失败**，但要留一行话（不许静默"改了没变"）。
判据：`test/apps-box.test.js` 的「装了新版 ⇒ 他打开的那一份也跟着换」＋ 反例
「从没落成过的 app，装的时候不许顺手把工作区建出来」。

## 五、卡在谁身上（这一条必须交出去）

🔴 **公网那条 WS 要 `v.stalkerai.cn` 的 nginx 放行 upgrade** —— 那台在 VPS 上、且是 finart 的部署
（我不动别人的目录，也没有那台机器的钥匙）。要加的就是**五条**（放进它**已有**的那个
`proxy_pass http://127.0.0.1:3083;` 块里）：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;   # WS 是长连接；默认 60 秒会把连接掐掉
proxy_send_timeout 3600s;
```

```bash
ssh root@120.26.179.211 'nginx -t && systemctl reload nginx'
```

加完这一行命令当场量（在开发机上跑）：

```bash
cd /home/deploy/proj/hupo/v2/services/core && node --input-type=module -e "
import WebSocket from './node_modules/ws/index.js';
const ws=new WebSocket('wss://v.stalkerai.cn/api/ctp/trade/ws');
ws.on('open',()=>{console.log('✔ 公网 WS 通了');ws.close();process.exit(0)});
ws.on('error',(e)=>{console.log('✗',e.message);process.exit(1)});
"
```

⚠️ **别顺手给它加 Basic 认证**（finart 的 `§7.3` 那条安全清单建议过）：小程序**带不了那个头**，
加了就等于把这条路关掉。真要鉴权 ⇒ 走"我们这边中转"那条（`WSS` 从我们自己的口出去，
顺便把那条无鉴权的口挡在身后）—— 那是另一批的事，主人当时选的是**直连**。
