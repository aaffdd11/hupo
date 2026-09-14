// 客户端构建指纹。
//
// 由 `scripts/deploy-web.sh` 按**客户端源码内容**算出来，
// 编译时用 `--dart-define=HUpo_BUILD_ID=...` 塞进来。
//
// 有了它，客户端才能跟服务端"对口径"：
//   我这身代码是哪个版本 —— 服务端说现在该是哪个版本 —— 不一样就刷新。
//
// 本地开发（`flutter run`）拿不到这个 define，值是 `dev`，
// 这时**不做任何刷新判断**，否则会把开发机刷进死循环。

const String kClientBuildId = String.fromEnvironment('HUpo_BUILD_ID', defaultValue: 'dev');

/// 是不是"没有指纹"的本地开发构建。
bool get isDevBuild => kClientBuildId == 'dev';
