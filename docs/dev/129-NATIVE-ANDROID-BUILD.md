# 129 · 原生安卓包：**能连上 ＋ 小程序那一层跑起来**

> **主人 2026-09-28 拍板**：
> *「原生 flutter。我不发布，只安装在自己的设备。」* ＋ *「连2一起。」*
> （2 = "把小程序那一层做成原生" —— 也就是**同意引 webview 依赖**，
> 破一次"零新依赖"那条纪律。）
>
> 这一份说清：**怎么打** · **它凭什么能连上服务端** · **小程序那一层现在是什么** ·
> **`ask` 为什么在原生上没有** · **更新怎么走** · **判据** · **没验到的**。

---

## 一、怎么打（**只有一个入口**）

```bash
scripts/build-apk.sh                     # 默认地址 https://w.stalkerai.cn
HUPO_API=https://别的 scripts/build-apk.sh
```

它做四件：`source ~/sdk/env.sh` → `flutter build apk --release --dart-define=HUPO_API=…`
→ 从**包里**核权限（`scripts/check-apk.sh`）→ 核"那个地址真的进了包"。

| 项 | 读数（2026-09-28 当场打的） |
|---|---|
| 产物 | `v2/apps/mobile/build/app/outputs/flutter-apk/app-release.apk` · **51.2 MB** |
| 耗时 | Gradle **94.5 秒** · 连 `pub get` 一起 **97 秒**（热 build） |
| 包名 / 版本 | `chat.hupo.hupo_app` · `versionCode=1`（`pubspec.yaml` 的 `1.0.0+1`） |
| 权限 | `INTERNET` ✓ · 没有 `RECORD_BACKGROUND_AUDIO` ✓ · 没有 `RECORD_AUDIO`（原生录音还没做） |
| 桌面上的名字 | **琥珀**（改前是模板默认的 `hupo_app` —— 判据钉着） |
| 签名 | 这台机器的 **debug keystore**（`~/.android/debug.keystore`，仓库里没有 `key.properties`） |
| webview 插件 | **在包里**（`classes.dex` 里 8 处 `webviewflutter`） |

🔴 **不带地址打出来的包 = 装上去连不上**，而且**不会报错**、**每道闸都是绿的**
（这是个真坑，见 §三）。所以判据钉着 `build-apk.sh` 里那一行必须带 `--dart-define=HUPO_API=`。

⚠️ 装法：`adb install -r <apk>`。**覆盖安装保留数据**（聊天记录、登录态都在）。

---

## 二、更新怎么走（主人只装自己的设备 ⇒ **不需要自动更新那套**）

| 事 | 现在怎么样 |
|---|---|
| 谁来更 | **我们（助手）打新包 → 覆盖安装**。Android **不会**替我们更新自发的 APK（那只有应用商店那条路） |
| 数据 | **保留**（同一个包名 ＋ 同一把签名 ＋ `versionCode` 不降级） |
| 签名代价 | 🔴 debug keystore **一丢/一换，老包就再也叠不上去**（只能卸载重装）—— 那把文件就在这台机器上；**要长期自己用，建议另存一把 keystore 并备份**（那是一件单独的小活） |
| "手机上自己拉新包" | **能做、但没做**：app 里读一个版本号/APK 地址 → 下载 → 弹系统安装（要 `REQUEST_INSTALL_PACKAGES`，那一下**必须用户点确认**，做不到静默）。主人没要，**明说没做** |
| 现在零代码的更新法 | `adb install -r`（USB 或 adb over Wi-Fi）／把 apk 传过去点安装 |

---

## 三、🔴 它凭什么能连上服务端（这次改动的心脏）

客户端**原来没有"服务端地址"这个概念**：一切请求都是**同源**的相对路径
（`Api(base: '')` ＋ `Uri.base` —— 浏览器地址栏那个就是它）。
网页上这是对的；**原生上没有地址栏**。实测（2026-09-28，非网页那一侧）：

```
Uri.base        = file:///…             ⇒ scheme=file · host=""
Uri.parse('/api/version')               ⇒ **没有 host** ⇒ 请求发不出去
```

⇒ 不带地址打的包，装上去会停在登录页一直连不上，**而每道闸都是绿的**
（判据全在网页那一侧 —— 又一个"客户端自己算的东西，闸要打在这一侧"，同 V13 那一族）。

**怎么修的**（一处出处）：

| 落在哪 | 是什么 |
|---|---|
| 新 `lib/models/server_address.dart` | `hupoApiBase = String.fromEnvironment('HUPO_API')`（**空串 = 同源**）＋ 一个纯函数 `apiUriFor(base, path)`（判据能量"空 base 拼出来的地址**没有 host**"） |
| `services/api.dart` | `Api({this.base = hupoApiBase})` · `_u()` 走 `apiUriFor` |
| `services/chat_controller.dart` | 那条流、`/api/asr`、`HarnessClient` 三处都改成 `hupoApiBase`（原来是写死的 `''`） |
| `scripts/build-apk.sh` | 地址只从这一条命令进 |

⚠️ **网页那条路一个字节没变**：默认是空串 ⇒ 同源，行为和以前一模一样
（`test/unit/server_address_test.dart` 第 ① 条就是这个负向对照）。

---

## 四、小程序那一层（原生 · Android）

**`lib/widgets/mini_runtime_native.dart`**：一个普通 `WebView` 加载那条**现签的** `entryUrl`
（制品在**另一个原点**：生产 `https://apps.stalkerai.cn` ≠ `w.stalkerai.cn`）。

### 4.1 🔴 **它不是桥**（手册 §14.1 铁律 3）

| 许 | 不许 |
|---|---|
| 加载制品、跑它自己的内联脚本（它的 CSP 是 `connect-src 'none'` ⇒ **它自己发不出任何请求**） | ❌ **任何** `JavaScriptChannel` / `addJavascriptInterface` / `runJavaScript`（一个都没有） |
| 导航**只许在制品自己那个 origin 里走**（`miniNavigationAllowed`，纯函数、VM 上直接量） | ❌ 别的域名 / `javascript:` / `data:` / `file:` / 协议降级 |

⇒ **`ask`（"让它替我问一句"）在原生上没有**。而且**不假装有**：壳**不发**
`hupo-ready`（那是"我在、这条路开着"的信号）⇒ 按契约写的制品就不会摆出那个入口。
要开它，先改手册那条铁律（安全模型上的事，得主人拍板），**不是在这一层偷偷加一个 channel**。

### 4.2 与 Web 那一份的差别（如实记）

| | Web | 原生（Android） |
|---|---|---|
| 装在哪 | `<iframe sandbox="allow-scripts">`（**不给** `allow-same-origin`） | 顶层文档（WebView，**没有 sandbox 那一层**） |
| 它自己的 `localStorage` | **会抛**（不透明原点 ⇒ 没有持久化能力，那是设计） | 能用（同一台设备上的**独立存储** —— 手册 §14.1 铁律 3 说的就是它） |
| 读得到壳的令牌吗 | 读不到（不透明原点） | **读不到**（令牌在 Flutter 那一侧的 `TokenStore`，不在这个 WebView 的存储里） |
| `ask` | 有（`{kind:'ask'}` → 壳用**看的人的钥匙**问） | **没有**（无桥，见 4.1） |
| 导航边界 | CSP `frame-ancestors` ＋ sandbox | `miniNavigationAllowed`（只许自己 origin） |

### 4.3 选路：为什么是"启动时钩子"而不是第五个条件导入

`dart.library.io` 在 **VM（`flutter test`）上也是真的** ⇒ 照它选实现的话，测试会去建真的
`WebViewController`（VM 上没有这东西），而现有那几条"非 Web 拿到的是那句实话"的判据
（`mini_runtime_test` / `mini_live_update_test` / `remote_app_test` / `job_ask_test`）会一起翻车。
⇒ 选路按**环境**分开：Web 走条件导入、原生走**启动时钩子**
（`main.dart` 里 `installNativeMiniRuntime()`；判据里**不装** ⇒ VM 上永远是那句实话）。

### 4.4 🔴 iOS 那条合规约束（Apple 4.7.4）

**iOS 商店版不发布小程序运行时**（"提交时冻结的清单" vs "运行时生成"，天生冲突）。
⇒ 装钩子那一步**只在 Android 上做**（`widgets/mini_native_boot_io.dart` 里那道
`defaultTargetPlatform` 判断），并且新加一个**恒假**的常量
`kNativeMiniRuntimeIOS = false` 把它钉住 —— 顺手把 `kNativeMiniRuntime` 改成 `true`
（Android 有了），两个常量各说各的，不混。

⚠️ **`webview_flutter` 一个字节都不许进 Web 那条编译链**（网页产物不该白白变胖）：
`main.dart` 只许经 `widgets/mini_native_boot.dart`（条件导入）拿这件事，
判据扫源码钉着（`lib/` 里只有原生那两份可以提到它）。

---

## 五、判据

| 在哪 | 钉住了什么 |
|---|---|
| 新 `test/unit/server_address_test.dart` **3 条** | ① 默认空串（网页没被影响）＋ `Api().base` 跟着它 ② **空 base 拼出来的地址没有 host**（"原生上打不出去"的形状）＋ 给了地址就是绝对地址 ③ **`build-apk.sh` 里那条 `build apk` 必须带 `--dart-define=HUPO_API=`** |
| 新 `test/unit/mini_native_test.dart` **6 条** | 导航真值表（自己那份放行 ／ 后缀像的域名、`javascript:`、`data:`、`file:`、协议降级、异 origin 全拦 ＋ 入口不是绝对地址时什么都不放）· 🔴 **全库 `lib/` 里原生桥 API 命中 = 0**（铁律 3 那条验收做成了会红的判据）＋ 两条负向对照（喂"改坏的源码"必须报；注释不算命中） |
| `test/unit/mini_runtime_test.dart` **6 条** | Android 有了 ／ **iOS 仍然没有** · 没装钩子 ⇒ 那句实话 · 装上钩子 ⇒ 走原生那一份 ＋ 收帧转给它 · 条件导入只许对 `dart.library.html` · `webview_flutter` 只许住原生那两份 · 三份签名一致 |
| `test/unit/android_manifest_test.dart`（＋1） | 桌面上那一格写的是**琥珀**，不是模板默认的 `hupo_app` |
| 老的那些一条没改弱 | 小程序沙箱那三条（`mini_sandbox_test`）· 换版换帧（`mini_live_update_test`）· 别的界面判据 |

**跑法**：

```bash
cd v2/apps/mobile && source ~/sdk/env.sh && flutter analyze && flutter test test/unit
cd ../.. && bash scripts/check-client.sh          # 三闸一条命令
bash scripts/build-apk.sh                          # 出包 ＋ 从包里核权限与地址
```

---

## 六、线上/包里的读数（都是当场跑出来的）

```
$ bash scripts/build-apk.sh
  构建指纹（入口）  ——（这一批**没动网页那条路的行为**，但产物照旧重发，见 §七）
  Gradle 94.5s · 出包 51.2MB · aapt2 核权限：INTERNET ✓ / 无后台录音 ✓
  ✓ 包里找得到那个地址（编译期常量进去了）
  包里 classes.dex 里 webviewflutter 命中 8 处
  aapt2 dump badging ⇒ application-label:'琥珀' · versionCode='1'
```

---

## 七、网页那条路

**客户端源码改了**（`api.dart` 默认值、`chat_controller` 三处、`main.dart` 一句、新文件）
⇒ 照规矩**要重发**（`scripts/deploy-web-v2.sh`），哪怕行为一个字没变：
"客户端改了就得部署"这条纪律的意义就在于**不靠'我觉得没影响'**。

⚠️ 重发之后要**当场核一件事**：网页产物里**不该有 webview**（那一份依赖原生平台通道）。

---

## 八、如实说（没验到的／明确没做的）

| # | 事 |
|---|---|
| 1 | 🔴 **没在真机、也没在模拟器上跑过**：本机没有模拟器、没有系统镜像、也没有插着的设备（`adb devices` 空）。⇒ "装上去登录页能连上"这件事**只有他装上那一刻才算数** —— 那是这次改动的**唯一验收点** |
| 2 | **原生那一层的画面不进 a11y 硬闸**：它是 `WebView`（一个 Flutter 控件都不是）⇒ 命中区/五档不溢出那两道闸在那儿量不到（VM 上更没有 WebView 插件）。**只有 §五 那些纯逻辑与源码级判据兜着** |
| 3 | **原生上录音/话筒/朗读/外链仍然是桩**（`recorder_stub` / `hearing_stub` / `speech_stub` / `links_stub`：那份"只有网页可以"）⇒ 短信录不了音。真做是 **P1-23**（要先加 `RECORD_AUDIO`，`check-apk.sh` 那一条也要反过来） |
| 4 | **`ask` 在原生上没有**（§4.1）：制品能打开、能玩，但"让它替我问一句"那条路在安卓上不存在 |
| 5 | **启动图标还是 Flutter 模板那个**（`@mipmap/ic_launcher`）：桌面名字改了（琥珀），图标没做（那是画图那件事） |
| 6 | ~~**网页上「安卓版还没上线」这句话没改**~~ ⇒ **2026-09-28 已改**（主人要挂到首页）：那一格现在写着「现在能下载」＋ 如实写明缺哪几样，见 §九 |
| 7 | ~~**debug 签名**~~ ⇒ **2026-09-28 已换成正式签名**（同一批：主人要挂公网），见 §九 |

**明确没做**：自更新（下载新包＋弹安装）· 原生录音/话筒/朗读/外链 ·
启动图标 · iOS 那一侧的任何构建（本机没有 Mac）· 应用商店上架 · 注册准入。

---

## 九、**挂到首页给人下载**（2026-09-28 补 · 主人：*"你帮我放到 w.stalkerai.cn 上，放下载链接。
就是用户推出在首页就可以看到下载。"*）

### 9.1 签名换了（**这一条是"给别人用"逼出来的**）

主人当场拍板：*"先建一把正式 keystore，再用它签"*。理由不是洁癖：

| | debug 签名（之前） | **正式签名（现在）** |
|---|---|---|
| 谁签得出来 | **谁都能**（debug keystore 是公开的，口令就是 `android`）⇒ 别人能签一个**同包名的"更新"** | 只有我们 |
| 换签名之后 | 已装的人**再也覆盖更新不了**（只能卸载重装） | 同一把就能一直叠上去 |

- keystore 与口令住 **仓库外**：`~/.hupo/hupo-release.jks` ＋ `~/.hupo/release-signing.env`（**0600**）。
  🔴 **口令不进仓库、不进日志**（文档里只写路径，不写它）。
  ⚠️ **丢了它 = 已装的人只能卸载重装** ⇒ 请离线备份一份（那是主人的事，我只把位置说清）。
- 拦有**两处**：`scripts/build-apk.sh` 缺那份 env ⇒ 当场停；
  `android/app/build.gradle.kts` 缺那四个环境变量 ⇒ **Gradle 当场抛**
  （不许"悄悄退回 debug 签名"—— 那条路正是"打个包挂公网"最坏的形态）。
- **签名是从包里核的**（`apksigner verify --print-certs`）：打出来的包那个指纹
  **必须不等于**这台机器的 debug 指纹。读数（2026-09-28）：

  ```
  Signer #1 certificate DN: CN=Hupo, OU=hupo, O=hupo, L=, ST=, C=CN
  Signer #1 certificate SHA-256: 9ecf9fce89363af4e9ac0eb2e19841cc91d5fe43eca3a053325f58ebb33dec1c
  ✓ 不是 debug 那把
  ```

### 9.2 链接与那条路

```
首页那颗「下载安卓版」 ⇒ https://w.stalkerai.cn/hupo.apk   ← 稳定名字（no-cache ⇒ 换包后拿到的一定是新的）
scripts/publish-apk.sh   打（正式签名）→ 拷进静态根 → **在线核一遍**
```

静态服务那边为它加的三条（`src/server.js`）：

| 加什么 | 为什么 |
|---|---|
| `.apk` 进 `LOOKS_LIKE_ASSET` | 包不在时**如实 404**。少了它，SPA 兜底会回 `index.html`(200) ⇒ **用户把一段 HTML 存成 `.apk`**（"缺个文件"变成"装不上"） |
| `MIME['.apk']` | `application/vnd.android.package-archive` —— 写错的话有的浏览器**把它当文本打开** |
| `.apk` 带 `content-disposition: attachment` | 点了是**下载**，不是就地打开那一串二进制（且**只有** `.apk` 有这一条，别的静态文件不许有） |

⚠️ `deploy-web-v2.sh` 里有 `rm -rf "$WEB"` ⇒ **它会把包删掉**。那个脚本加了**一步**：
只要构建产物还在就把它**再拷回去**（并如实报一句）。⚠️ 保险起见，改完网页跑一次
`scripts/publish-apk.sh --no-build` 也行。

### 9.3 首页上那两处文案（**必须跟着事实改**）

| 之前 | 现在 |
|---|---|
| 平台表：`('安卓', '还没上线', '做好会放在这儿')` | `('安卓', '现在能下载', '语音那几样（说话输入、录音、朗读）还没进包，要用那些先开网页版')` |
| 点「下载安卓版」⇒ *"安卓版还没上线，先用网页版吧。"* | 网页上**真的开始下载**（交出去的是一条**绝对**地址 —— `openExternal` 只认 http(s)）；站在**安卓包里**点它 ⇒ *"你正在用的就是这个安卓版。"*；没开成 ⇒ *"没能开始下载。用手机浏览器打开这个页面，再点一次试试。"* |

🔴 **"点了没开成就说清怎么办"**这条纪律一个字没松（**不转圈、不"正在准备"**）。

### 9.4 判据（这一补）

| 在哪 | 钉住了什么 |
|---|---|
| `v2/services/core/test/server.test.js`（＋1） | `.apk` 不在 ⇒ **404**（不是 HTML）· 在 ⇒ **安卓那个 MIME** ＋ **`attachment; filename="hupo.apk"`** ＋ 字节数一致 · **负向对照**：`index.html` **不许**被加上 attachment |
| `test/unit/server_address_test.dart`（＋1） | 安装包那条地址**必须是绝对的**（负向对照：`/hupo.apk` 本身 `hasAuthority == false` ⇒ 交给 `openExternal` 就是"什么都没发生"） |
| `test/widget/landing_test.dart`（改写 ＋3） | 点它 ⇒ 交出去的**正是** `/hupo.apk` 那条绝对地址 ＋ 说"开始下载了" · **没开成** ⇒ 说清怎么办（**不是**"正在准备"）· 站在安卓包里点 ⇒ 那句实话 · 负向对照：**"还没上线"那句必须已经不在** |
| `test/unit/android_manifest_test.dart`（＋1） | **注释不许住进标签里** —— 我自己 2026-09-28 栽过一次：把注释写在 `<application` 与它的属性之间，`flutter build apk` 报 *"not a valid XML document"*（原来那条"能被解析"是正则级的，看不见它） |

### 9.5 线上读数（`scripts/publish-apk.sh` 与真浏览器当场核的）

```
本地       51234779 字节 · sha256 c6f7df966491…
在线核     https://w.stalkerai.cn/hupo.apk ⇒ 200 · 51234779 字节 · 与本地**逐字节一样**
          （带 content-type: application/vnd.android.package-archive ＋ attachment）
真浏览器   在**线上首页**点那颗「下载安卓版」⇒ 它交出去的正是
          ["https://w.stalkerai.cn/hupo.apk"]（在页面里接管 window.open 读出来的）
入口指纹   d8f00db18971 → 5c1b417c78a9（两次部署；核心横幅「完整性 对上了」）
下载耗时   从公网拉完这 51.2MB：**166 秒**（≈2.5 Mbps —— 这条路的上行就那么宽）
          ⇒ 首页那颗按钮点下去，用户要等**两分多钟**才拿到包（如实记，别以为是一下子）
```

真图（线上首页）：[`129-raw/landing-download-button.png`](129-raw/landing-download-button.png)
（那颗「下载安卓版」就在「开始用」旁边）·
[`129-raw/landing-android-row.png`](129-raw/landing-android-row.png)
（「在哪儿用」那一格：**安卓 · 现在能下载 · 语音那几样还没进包**）。

⚠️ **如实说**：那条 URL 是**公开**的（首页本来就是公开页）⇒ 谁拿到链接都能下；
而**注册仍然没有准入门槛**（谁都能注册，注册会自动开一台盒子）—— 主人当场选了"就挂公开"，
这一条如实记在这儿，**不是**"我们做了准入"。
