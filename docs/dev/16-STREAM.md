# 16 · 浏览器里那条流**从来没连上过**（一次"页面在说假话"）

> ⚠️ **这一批是一个"每道闸都绿、用户那里全黑"的 bug。**
> 它同时暴露了两件比 bug 本身更值钱的事：
> ① **探针绿 ≠ 浏览器行**（验收绕过了被测的那行代码）；
> ② 屏幕上那句话**在网没断的时候说"网断了"**，把排查带偏了整轮。
>
> **手册依据**：`08-SPEC.md` §2.1（实时接口）· §2.3（客户端禁令）·
> `03-DEVELOPMENT.md` §三（协议冻结）· `AGENTS.md` §二纪律 3（纯函数进 `test/unit`）
> **代码**：`lib/services/stream_uri.dart`（新）· `lib/models/conn_state.dart`（新）·
> `lib/services/stream.dart` · `lib/screens/chat_screen.dart`
> **测试**：`test/unit/stream_uri_test.dart` **+9** · `test/unit/conn_state_test.dart` **+6**（55 → 70）

---

## 一、现场

主人平板上：主界面顶栏在，**时间线是空的**，顶部一句话挂了十几分钟：

```
网断了，我在等它回来
```

同一时刻，从**本机**用探针打公网：

```
$ node /tmp/ws-status.mjs <token>
[+ 5088ms] WS 连上了
[+ 5131ms] << user/echo seq=1 "用一句话告诉我今天是星期几…"
```

⇒ 服务端、隧道、证书、nginx、协议，**全是对的**。问题只在客户端那一侧。

## 二、根因

`stream.dart` 里原来是这样算地址的：

```dart
final scheme = base.startsWith('https') ? 'wss' : 'ws';
final host   = base.isEmpty ? _sameOriginHost() : …;
```

而 **web 上 `base` 恒为空串**（同源；没有 `HUPO_API` 之类的东西，见 `api.dart`）：

```dart
Api({this.base = '', …});   // ← 生产就是这个默认值
```

`''.startsWith('https')` 是 `false` ⇒ 在 **https 页面**上拼出了：

```
ws://w.stalkerai.cn/api/stream?sinceSeq=0
```

浏览器对"https 页面里发起的明文 WebSocket"按**混合内容**处理，**直接拦掉**
（同步抛 `SecurityError`，`ready` 根本不会到）。

而这恰好解释了**为什么看起来像网络问题**——同一时刻：

| 那一步 | 走的路径 | 结果 |
|---|---|---|
| 打开页面 | 同源 https | ✅ 正常 |
| 登录 | 同源 https POST | ✅ 正常 |
| `/api/health`（探针） | 同源 https GET | ✅ **答 200** ⇒ "网没断" |
| 实时那条 | `ws://` | ❌ **被浏览器拒了** |

⇒ 于是探针说"网是好的"，而状态条说"网断了"。**两句话不可能同时为真。**

再补一刀：`http://w.stalkerai.cn` 会 **301 到 https**。

```
$ curl -sI http://w.stalkerai.cn/
HTTP/1.1 301 Moved Permanently
```

⇒ **这条路（`ws://`）从来没有通过一次。** 主人从来没在浏览器里看见它答过话。

## 三、为什么没有一道闸拦住它

因为**没有任何一条测试碰过地址构造**：

```
$ grep -rn "ws://\|wss://\|scheme" v2/apps/mobile/test/
（空）
```

而验收用的是 node 探针，探针里**把 `wss://` 写死了**：

```js
new WebSocket('wss://w.stalkerai.cn/api/stream', ['bearer', token]);
//             ↑ 绕过了客户端自己算地址的那行代码
```

⇒ 探针测的**从来不是客户端真正会发的东西**。于是在"客户端全黑"的同时，
`npm test` 236 条、`test/unit` 55 条、可访问性 39 条 **全是绿的**。

> **这一条比 bug 本身重要**：
> **凡是"客户端自己算出来的东西"，闸必须打在客户端这一侧。**
> 拿一个把关键参数写死的旁路工具去验收，绿的是那个工具，不是产品。

## 四、修法

### 4.1 地址构造抽成纯函数，按**页面**的协议走

`lib/services/stream_uri.dart`（新）：

```dart
Uri streamUri({required String base, required Uri page, required int sinceSeq}) {
  final raw = base.trim();
  final origin = raw.isEmpty
      ? page                                     // ★ 同源：听页面自己的
      : raw.contains('://') ? Uri.parse(raw) : Uri.parse('http://$raw');
  final host = '${origin.host}${origin.hasPort ? ':${origin.port}' : ''}';
  final scheme = origin.scheme == 'https' ? 'wss' : 'ws';
  return Uri.parse('$scheme://$host/api/stream?sinceSeq=$sinceSeq');
}
```

* 同源（生产）⇒ 用 `Uri.base`（浏览器地址栏里那个）的协议 ⇒ **https ⇒ wss**。
* 跨源（本机调试）⇒ 听 `base` 的。
* 用 `hasPort` 而不是 `port`：`port` 会给默认端口填上 443，拼出来变成多余的 `:443`。

### 4.2 那句话跟**探针的结果**走，不再一刀切

原来 `reconnecting` 一个状态包打天下，屏幕上永远"网断了"。
可那个状态是**探针问完之后**才下的判断 ⇒ 探针答 200 时它就是在说假话。

`lib/models/conn_state.dart`（新）里分成两个：

| 状态 | 什么时候 | 屏幕上说 |
|---|---|---|
| `reconnecting` | 探针**问不通** ⇒ 网真的断了 | 网断了，我在等它回来 |
| `streamBlocked` | 探针**答 200** ⇒ 服务端明明在 | 网是通的，只是我还接不上它，在重试 |

⚠️ 顺带修掉一个**闪**：重试循环原来每次都会先把状态置回 `reconnecting`
⇒ 状态条会在真话和假话之间来回跳。现在上一回**探明**的原因记在 `_retryState`，
一路带到下次重试。

> 屏幕上那句话现在住在 `models/conn_state.dart`（纯函数）——
> 它进 `test/unit` 硬闸，也进"文案禁用词"那张表。**别在 `build()` 里直接写死。**

## 五、验收

```
$ flutter analyze                      → No issues found!
$ flutter test test/unit               → 69 passed（55 → 69，+14）
$ bash scripts/check-client.sh         → 四道闸全过
```

两条 🔴 是这次事故的锚：

1. **`🔴 同源 + https 页面 ⇒ wss`** —— 回归条，就是这次现场那一个 URL。
2. **`🔴 金丝雀：https 页面上永远不许降级成 ws://`** —— 对着四个页面地址扫一遍。

**变异验证**（把旧写法放回去）：

```
final scheme = base.startsWith('https') ? 'wss' : 'ws';   // 变异
→ 3 条测试变红（回归条 / 金丝雀 / 非默认端口）   ✅ 闸是真的会响
```

另有一条 `🔴 服务端在（探针 200）⇒ **不许**说"网断了"`，钉住第二件事。

### 5.1 真机确认（**这一步才算数**）

修完部署（构建指纹 `2fa22314d2bf`）之后，**主人在平板上刷新了一次**：

> **「出字了，顶上那句话没了。」**

⚠️ **为什么单独把这一句记下来**：这一批的所有闸都是**自动**的，
而这场事故的教训恰恰是"**自动闸绿了不等于用户那里行了**"。
⇒ 这条**真机证据**和那两条测试一样重要，**别只留测试结果**。
（长期看，这一条该由 §六 第 **16** 条那个"装个浏览器走 CDP"接管。）

另：部署后又用探针**盯着线上那条流看了 190 秒**（`/tmp/ws-watch.mjs`）——
**全程没断**、子协议回的是 `bearer`、心跳每 25 秒一个。
⇒ 排掉了"连上之后 60 秒被看门狗掐掉"这个第二层隐患。

## 六、欠的账（这一批欠下的）

| # | 欠什么 | 为什么 |
|---|---|---|
| **16** | **本机没有浏览器**，所以"浏览器里到底行不行"没有**自动**证据 | 现在的闸是那个纯函数 + 部署后核对产物。真要端到端，得在这台机器上装一个 chromium 走 CDP；`sudo` 要密码（`AGENTS.md` §一），暂时办不到 ⇒ **先明确记着，别当成已经验过** |
| **17** | **非 web 平台没有"来源"**（安卓上 `Uri.base` 是 `file://`） | 这一批**顺手查出来的**：`chat_controller` 写死 `base: ''`，而"同源"这件事**只有浏览器有**。⇒ 安卓那一批必须**自己把服务器地址传进来**，否则流地址根本没有来源。`stream_uri_test.dart` 里钉了一条路牌 |
