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
| 3 | ~~**原生上录音/话筒/朗读/外链仍然是桩**~~ ⇒ **2026-09-28 录音那一件做了**（§十二：`NativeRecorder.kt` ＋ `RECORD_AUDIO`，`check-apk.sh` 那一条已经反过来）；**话筒（ASR）/朗读/外链仍然是桩**（P1-23 的剩下那几件） |
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

---

## 十、真机第一眼：他报的两条（2026-09-28 装上 APK 之后）

> 主人原话：*"在安卓上可以安装。然后我看到它顶部跟时间，，WiFi 信号重叠了，是否要对安卓
> 增加顶部空间。然后底部的聊天窗口有点 margin 太多太多了。至少可以少去 2/3"*

### 10.1 为什么网页上一直没看见这两条

| | 网页（含手机浏览器） | 安卓原生包 |
|---|---|---|
| 顶部那条状态栏 | **不在窗口里** —— `MediaQuery.padding.top` 是 **0** | **盖在窗口上**（`targetSdk 36` ⇒ 系统强制 edge-to-edge）⇒ 应用自己画到那底下就重叠 |
| 底部那条手势条 | 同上，**0** | 盖在窗口上（`padding.bottom` ≈ 34）⇒ 贴到底的东西会被它压住 |

🔴 **两条都是"判据打在另一侧"**：以前所有界面判据都在 VM/网页上跑，而那些环境里
**内边距恒为 0** ⇒ "有状态栏时会怎么样"这件事**从来没被量过**（本仓库反复栽的那一族）。
⇒ 修完以后补了一份**注入内边距**的判据（§10.3）。

### 10.2 改了什么

| 哪儿 | 之前 | 现在 |
|---|---|---|
| 落地页 / 登录页 | `body: Center(...)`（从窗口最上面开始排） | **`SafeArea` 包一层**（有状态栏就让开；网页上 0 ⇒ 一点不变） |
| 小程序容器里的内容 | 只有底部那条内缩 | **同一条 `Padding` 再加 `top: safe.top`** —— 容器里没有抬头（2026-09-27 撤了）⇒ 制品/内置那几屏的第一行原来就在时钟底下 |
| 聊天浮窗贴底 | `FloaterMetrics.margin`（**四边 30**） | 🔴 **四边 `10`**（主人：*"至少可以少去 2/3"* ⇒ 30 的三分之一＝10）＋ 底下取 **`max(10, padding.bottom)`**（手势条比我们的留白大时**听系统的**，否则输入条会被它压住） |
| 浮窗高度上限 | `H − padding.top − viewInsets.bottom − 30×2` | `H − padding.top − viewInsets.bottom − 10 − bottomGap`（一处口径） |

⚠️ **网页那一版也跟着变**（`margin` 是四边共用的一个常量，没有按平台分叉）：
桌面网页上浮窗的留白从 30 变成 10。**这是他当场要的读数**；要"网页保持 30、只有窄屏 10"
说一声 —— 那是按宽度分两档的事（另一种形状，得他点头）。

### 10.3 判据（这一补）

新 `test/widget/safe_area_test.dart` **5 条** —— **把系统那条内边距注进去**
（VM 上默认是 0，所以这是唯一能量到它的办法）：

| 条 | 钉住了什么 |
|---|---|
| 落地页 | 状态栏 24 ⇒ 内容**整整让开 24**（差 <24 就是重叠）；内容没被推出屏幕 |
| 负向对照 | 没有状态栏（网页）⇒ 位置**一个像素没动**（不能凭空多出那一条） |
| 浮窗（窄屏 390×844） | 底边 = `844 − max(10, 34)`（手势条）· 左右 = `margin`（**10**）· 顶边 ≥ 状态栏 |
| 负向对照（1280×800） | 没有手势条 ⇒ 底边 = `800 − margin`（就是我们自己那个留白） |
| 容器 | 开着的时候，里面的内容顶边 ≥ 状态栏那一条 |

⚠️ **还是量不到的**：真机上那两条到底还剩多少（我这边没有设备）—— 这份判据量的是
"**有没有让开 / 让开多少**"，不是"他眼睛看着舒不舒服"。后者要**他再看一眼**才算数。


---

## 十一、为什么**不做 WebView 外壳**（主人 2026-09-28 问，听过代价后选的）

> 主人原话：*「我有可能安卓 app 只是一个壳，直接可以自己内部在线更新？」*
> 摆清两条路之后他选：**保持原生**。这一节把那次比较留在这儿 ——
> **下一个人一定会再问一次**，不用重新推一遍。

### 11.1 两条路各自是什么

| | **原生 Flutter（今天这个）** | **WebView 外壳** |
|---|---|---|
| APK 里是什么 | 界面编译成 AOT（`libapp.so`） | 一个 WebView 打开 `https://w.stalkerai.cn` |
| 改界面的流程 | **重打包 ＋ 覆盖安装**（约 1.5 分钟 ＋ 他点一下） | **部署网页**（`deploy-web-v2.sh`）⇒ 下次打开就是新的 |
| 手感 | 原生渲染（滚动/输入法/大字号长列表最好） | WebView 渲染，**差一截** |
| **语音那四件** | **还是桩**（录音/话筒/朗读/外链 —— P1-23 没做） | 🔴 **全回来了**（跑的是**网页那一份实现**） |
| 小程序那一层 | 普通 WebView、**不装桥**（⇒ `ask` 没有） | 网页那份 iframe 沙箱 ⇒ **`ask` 也有了** |
| 能力边界 | 原生想做什么都行（要加权限） | 摄像头/麦克风要壳里单独放行；文件选择/下载/分享/通知都受 WebView 限制 |
| 离线 | 能（编译进去的东西都在） | **没网就是一片空白**（今天网页那条路没开离线缓存） |
| 老机器 | 只要能装这个包 | 还依赖**系统 WebView 的版本**（旧的可能很旧） |

### 11.2 他选了原生 —— 代价与"在线能变的那一半"（**这两条必须一起记住**）

- 🔴 **代价**：**界面改动必须重打包 ＋ 覆盖安装**。好消息是那条路已经很顺：
  `scripts/publish-apk.sh`（约 1.5 分钟）→ 首页那颗按钮覆盖安装（**同签名 ⇒ 数据保留**）。
- ✅ **本来就在线变的**（不用动 APK）：
  · **小程序**（真制品：盒子/`apps.stalkerai.cn` 现签 URL，改完自动换新那一版）；
  · **助手的行为与口径**（人格 `hupo-persona.yml` · 能力层 · 服务端那一切：长活、队列、记账、回收站…）；
  · 网页那一版（谁都可以直接用）。
  ⇒ **不在内的是"界面本身"**：哪一屏长什么样、按钮放哪、文案。
- ⚠️ **要改这条结论的人**：先读上面那张表 —— 尤其"**壳里语音反而全回来了**"那一条
  （它是最强的"应该做壳"的理由）；剩下四条是代价。
  另外：真做壳的话，**今天的 `server_address` 那一层、原生 WebView 小程序层、安全区内缩
  大多用不上**（网页那份有自己的实现），图标/名字/权限留着。


---

## 十二、原生**录音 ＋ 回放**（2026-09-28 · 主人：*"你帮我测试录音能力。"*）

### 12.1 先看清事实：那时包里编进去的是**桩**

主人问"测录音"时，第一件事不是测，是**读包**（这一步现在也留在判据里）：

```
$ unzip -p app-release.apk lib/arm64-v8a/libapp.so | strings | grep hupo
package:hupo_app/services/recorder_stub.dart      ← 🔴 桩（"这里录不了"）就是被编进去的那一份
package:hupo_app/widgets/mini_runtime_native.dart
…
$ aapt2 dump permissions …    →  没有 RECORD_AUDIO
$ strings classes.dex | grep -c MediaRecorder  →  0
```

⇒ **不是"录音坏了"，是原生这一份从来没做过**（`recorder.dart` 的条件导出只对
`dart.library.html` 选网页那一份）。网页上那套（`#178`）是好的。

### 12.2 做了什么

| 落在哪 | 是什么 |
|---|---|
| `android/.../NativeRecorder.kt`（新） | `MediaRecorder`（`AudioSource.MIC` → **MPEG_4/AAC**，写在应用缓存目录）＋ `MediaPlayer` 放音；**第一次按下去才问权限**（`requestPermissions`，D5.11）· 一个原因一句话（`denied`/`unsupported`/`failed`）· 走开时把麦关掉、临时文件删掉 |
| `android/.../MainActivity.kt` | 挂一条 MethodChannel **`hupo/recorder`** ＋ 转权限回执（`onRequestPermissionsResult`）＋ `onDestroy` 收干净 |
| `lib/services/recorder_native.dart`（新） | Dart 那一侧：把 channel 翻成 `canRecord/start/stop/play/stopPlay/releaseAll`；放完那一下由 Kotlin 回调 `onPlayEnded` |
| `lib/services/recorder.dart` ＋ `recorder_stub.dart` | **钩子**：没装 ⇒ 恒假＋"unsupported"（VM/iOS/桌面那一档）；装了 ⇒ 全转给原生那一份。⚠️ 为什么用钩子而**不是**第三个条件导出：`dart.library.io` 在 **VM 上也是真的** ⇒ 照它选会让所有"VM 上录不了"的判据一起翻车（与 `mini_runtime` 同一套做法） |
| `lib/widgets/mini_native_boot_io.dart` | 启动时装钩子（**只在 Android**）—— 和小程序运行时同一处 |
| `AndroidManifest.xml` | **加 `RECORD_AUDIO`**（手册 D5.11 早就定了）；**不申请后台录音**（V10 一票否决） |

### 12.3 判据

| 在哪 | 钉住了什么 |
|---|---|
| 新 `test/unit/recorder_native_test.dart` **8 条** | ① 没装钩子 ⇒ 恒假 ＋ 每一句都说实话（**一次都不碰**那条 channel）② 装了 ⇒ `start` 把 `null/denied/unsupported/failed` **原样带回来** ③ `stop` 把 `{ok,path,ms}` 变成本机那一段（`ok:false`/坏回执 ⇒ `null`，不抛）④ 🔴 **放完了收得到**（Kotlin 回调 `onPlayEnded` ⇒ 按钮回到"听一遍"）⑤ 🔴 **放不起来当场收场**（不许停在"别放了"—— 那个形状 2026-09-27 在网页上栽过）⑥ `stopPlay`/`releaseAll` 都打到 channel 上 ⑦ 源码级：**装钩子那一行只在 Android 分支**、Web 那一份不许提它、channel 名字两边逐字一致 |
| `test/unit/android_manifest_test.dart` | **`RECORD_AUDIO` 必须在**（V10，这一条**反过来了**）＋ 后台录音一票否决 ＋ 原生那一份里 `requestPermissions`/`AudioSource.MIC` 都得在（⚠️ 先把 XML 注释剥掉再查 —— 注释里正写着"不许有后台录音"那个词） |
| `scripts/check-apk.sh` ③ | **从包里核**：`RECORD_AUDIO` **必须在**（原来是"不该有"—— 做出来了就反过来）· 后台录音照旧一票否决 |

### 12.4 读数（2026-09-28 打的那个包）

```
包里 strings：现在**两份都在**（`recorder_stub.dart` 是转交那一层、`recorder_native.dart` 是真那份）
               还有 installNativeRecorder
classes.dex：MediaRecorder / AudioSource 命中 2 ⇒ Kotlin 那一套**真进了包**
check-apk：✓ INTERNET ✓ 没有后台录音 ✓ 有 RECORD_AUDIO ✓ 图标
          51.7 MB · 正式签名 · 公网逐字节核过
```

### 12.5 还是没验到的（**只有他按一下才算数**）

| # | 事 |
|---|---|
| 1 | 🔴 **真麦克风那一下**：本机没有设备也没有模拟器 ⇒ "按「开始录」→ 说一句话 → 按「停下」→ 点「听一遍」能不能听见自己"这件事**只能他装上去试** |
| 2 | **权限那一趟弹窗**：第一次按下去手机上要弹"允许录音吗"；拒绝了要看到那句人话（`hearDenied`）—— 这也是形状，没在真机上走过 |
| 3 | **放音与录音不叠在一起**：`start` 前会 `stopPlay()`，但真机上"放着的时候按开始录"没试过 |
| 4 | **聊天里那颗话筒（说话 → 转文字）仍然是桩**：主人这次说的是**录音**（录一段／听一遍）—— 那一件做完了；**语音输入（ASR）**是另一份（`hearing_stub.dart`），还没做（P1-23 的另一半） |
| 5 | **朗读 / 外链** 也还是桩（同上） |
| 6 | **临时文件**：录的那一段写在应用缓存目录（`cacheDir`），走开时删；**手机上的缓存被系统清理**是另一回事（没做"存起来"） |
