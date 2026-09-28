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
| 6 | **网页上「安卓版还没上线，先用网页版吧。」这句话没改**：主人说的是"只装在自己的设备"，不是"给外面下载"。真要挂上去让人下，那句话得先改（而且签名/自更新那两笔账要一起说清） |
| 7 | **debug 签名**：自己装够用；**不能给别人、不能上架**（谁都能签一个同包名的"更新"） |

**明确没做**：自更新（下载新包＋弹安装）· 正式 keystore · 原生录音/话筒/朗读/外链 ·
启动图标 · iOS 那一侧的任何构建（本机没有 Mac）· 应用商店上架。
