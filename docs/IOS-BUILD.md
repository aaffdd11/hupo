# iOS 构建指南（在 Mac 上编译）

iOS 工程已经放在 `apps/mobile/ios/`，**在 Mac 上编译即可**。
代码仓库里只放源码；Xcode 生成的机器相关文件（Podfile、Generated.xcconfig、
ephemeral/）会在 Mac 首次构建时自动生成，不需要手工准备。

## 一、前置

| 需要 | 说明 |
|---|---|
| Xcode 15+ | 含 iOS 模拟器/真机支持 |
| Flutter（stable） | 与仓库同代即可（本项目用 3.35.1 生成） |
| CocoaPods | 首次构建自动生成 Podfile 后用到；`sudo gem install cocoapods` |

## 二、第一次编译（真机）

```bash
cd apps/mobile
flutter pub get
flutter run            # 插上 iPhone，选设备
```

首次运行会自动生成 `ios/Podfile` 并安装插件（url_launcher / shared_preferences）。
如果报「找不到 CocoaPods」，先 `sudo gem install cocoapods`。

## 三、签名（一次性）

1. `open ios/Runner.xcworkspace`
2. 左侧 Runner → **Signing & Capabilities**
3. 勾选 **Automatically manage signing**，Team 选你的开发者账号
4. Bundle Identifier 默认是 **`com.hupo.app`**（RunnerTests 是 `com.hupo.app.RunnerTests`）。
   要换就在这两处换，改完在 Info.plist 里同步一下。

## 四、打包

```bash
flutter build ios --release        # 生成 Runner.app
flutter build ipa                  # 上架/分发用的 .ipa
```

## 五、这个 app 的行为（在 iOS 上）

| 行为 | 说明 |
|---|---|
| 连哪个服务器 | `https://hupo.stalkerai.cn`（`lib/main.dart` 的 `kServerBaseUrl`） |
| 首次打开 | **登录页**，输口令进去（口令只在服务器上存哈希） |
| 登录后 | 令牌存本机（shared_preferences），下次打开不用再输 |
| 开发者模式 | **默认关**。要开：桌面「会话」app → 设置 →「开发者模式」开关 |
| 切后台/断网 | 回来自动重连、自动补齐错过的消息 |
| 服务端重启 | 聊天窗变灰「正在恢复连接…」，恢复后说「我已经升级好了。」 |

## 六、已知边界（如实说）

- **没有推送通知。** iOS 会把后台 app 挂起 —— 长任务（"我单独拿去做"那种）做完时，
  如果你没开着 app，是**不会**弹通知的；打开后会自动把结果补齐。推送是下一步的事。
- **图标还是 Flutter 默认占位。** 替换方法：把全套尺寸的图换进
  `ios/Runner/Assets.xcassets/AppIcon.appiconset/`（1024 那张必须有）。
- **ATS 无需配置**：全链路 HTTPS。
- 应用会申请联网权限，但**不申请**相册/通讯录/定位/麦克风。

## 七、常见坑

| 现象 | 处理 |
|---|---|
| `Podfile not found` | 不是问题 —— 首次 `flutter run` / `flutter build ios` 会自动生成 |
| 报 `Generated.xcconfig` 缺失 | 同上，flutter 自动重建 |
| 签名失败 | 去 Xcode 里选 Team（见第三节） |
| `CocoaPods could not find compatible versions` | `cd ios && pod repo update && pod install` |
