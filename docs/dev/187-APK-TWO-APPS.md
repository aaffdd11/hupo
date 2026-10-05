# 187 · 安卓包：**2.0 是另一个 app**（与 1.0 并存）

> **主人 2026-10-05 原话**：*「打包apk，这次是2.0版本了，我想起另一个app，不要覆盖1.0。
>   名字叫琥珀聊天」*
> ⇒ 他挑的首页形状：**1.0 和 2.0 各一颗按钮**。
> ⇒ 手册那一格：**`D1.6`**（升 `v2.55`）。

---

## 一、要变成什么样（一句话）

```
今天（改之前）：一个身份 chat.hupo.hupo_app ⇒ 装 2.0 就等于**升级/顶掉**他手机上那个 1.0
改完之后：      1.0 = chat.hupo.hupo_app  「琥珀」      ← 原样活着
                2.0 = chat.hupo.hupo_chat 「琥珀聊天」  ← 新装的，并排站着
```

* **`applicationId` 才是"装上去的身份"**（安卓按它认"是不是同一个 app"）；
  `namespace` 与 Kotlin 那几份**只是代码的包名** —— `.MainActivity` 是**相对 `namespace`**
  解析的 ⇒ **它不许跟着一起改**（改了要用真机打包才会发现，属于"最贵的那种错"）。
* **两个下载地址都留着**：`/hupo-chat.apk`（2.0）· `/hupo.apk`（1.0，**原样不动**）。

---

## 二、落点（动手前先读这一节）

| 在哪 | 干什么 |
|---|---|
| `v2/apps/mobile/android/app/build.gradle.kts` | `applicationId` 改 `chat.hupo.hupo_chat`（**`namespace` 不动**） |
| `.../src/main/AndroidManifest.xml` | `android:label` 改「琥珀聊天」（桌面上那一格） |
| `v2/apps/mobile/pubspec.yaml` | `version: 2.0.0+1`（版本名从 `1.0.0+…` 起 ⇒ `2.0.0+…`） |
| `lib/models/server_address.dart` | `hupoApkPath = '/hupo-chat.apk'`（2.0）＋ 新 `hupoApkPathV1 = '/hupo.apk'`（1.0）；`apkDownloadUri` 多一个 `path` 入参（默认＝2.0 那个） |
| `lib/models/landing_words.dart` | 两颗按钮的词：`landingDownload = '下载安卓版 2.0'` · `landingDownloadV1 = '下载安卓版 1.0'` |
| `lib/screens/landing_screen.dart` | `_ctaRow` 多一颗描边按钮；`_download(context, path)` 按传进来的那条路走 |
| `scripts/publish-apk.sh` | 发出去的文件名默认 `hupo-chat.apk`（可用 `HUPO_APK_NAME=` 覆盖） |
| `scripts/deploy-web-v2.sh` | 部署会把静态根清空 ⇒ 放回**两个**包：2.0（构建产物）＋ 1.0（`data/hupo-1.0.apk` 那份存档） |

---

## 三、判据（都带负向对照）

| # | 钉什么 | 在哪 |
|---|---|---|
| A1 | 桌面上那一格是「琥珀聊天」，而且模板默认那个名字不许回来 | `test/unit/android_manifest_test.dart` |
| A2 | `applicationId` **不许**是 `chat.hupo.hupo_app`（那是 1.0 的身份 ⇒ 用了它就覆盖安装），必须是 `chat.hupo.hupo_chat` | 同上 |
| A3 | `namespace` **仍是** `chat.hupo.hupo_app`（不许跟着 `applicationId` 改） | 同上 |
| A4 | 首页**两颗**下载按钮都在屏幕上；各交各的地址（2.0 那条 ≠ 1.0 那条），两条都是绝对地址 | `test/widget/landing_test.dart` |
| A5 | 那条路是 **ASCII 稳定名**（不带指纹、没有 host）—— 与服务端"不带指纹一律 no-cache"那条配套 | `test/unit/server_address_test.dart` |

**变异验证**（各红一条，红得准）：
* `applicationId` 改回 `chat.hupo.hupo_app` ⇒ A2 当场红；
* 两颗按钮传同一条 `path` ⇒ A4 红（"两条路不许是同一条"）；
* `label` 改回「琥珀」⇒ A1 红。

---

## 四、如实说（没做到的、要人到场的）

* **真机那一下我没法验**：包是**从包里核过的**（`aapt2 dump badging` ⇒
  `package: chat.hupo.hupo_chat`、`versionName=2.0.0+656`、权限、图标、正式签名），
  但"装上去之后**两个 app 是不是并排站着**、数据是不是各是各的"**要他自己装一次**。
* **1.0 那一份是"最后一次发出去的那个包"**（`1.0.0+573`，`data/hupo-1.0.apk`）——
  它不是从 tag `v1.0` 重新打出来的；要重打 1.0 得 checkout 那个 tag（另一件事）。
* **iOS 那一侧一个字没动**（这一批只碰安卓身份与首页那两颗按钮）。
