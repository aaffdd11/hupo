// **这台设备该往哪儿找服务端**（纯逻辑；一处出处，网页与原生共用）。
//
// ── 为什么要有它 ──────────────────────────────────────────
// 网页上客户端**没有"服务端地址"这个概念**：所有请求都是**同源**的相对路径
// （`Api(base: '')` ＋ `Uri.base` —— 浏览器地址栏那个就是它）。
// 这在网页上是对的；而**原生包上没有地址栏**。实测（2026-09-28，非网页那一侧）：
//
//     Uri.base        = file:///…            ⇒ scheme=file · host=""
//     Uri.parse('/api/version')              ⇒ **没有 host** ⇒ 请求发不出去
//
// ⇒ 后果是"打了个 APK、装上去一直连不上"，而**每一道闸都是绿的**
//   （判据全在网页那一侧 —— 又一个"客户端自己算的东西、闸要打在这一侧"的实例）。
//
// 🔴 **原生包必须带地址**：`--dart-define=HUPO_API=https://w.stalkerai.cn`。
//    打法**只有一个入口**：`scripts/build-apk.sh`（判据钉着那个脚本里必须有这一行，
//    见 `test/unit/server_address_test.dart`）—— 免得下次又打出一个连不上的包。
//
// ⚠️ **默认空串 = 同源**（网页与 `flutter test` 就是这一档）
//    ⇒ 网页那条路一个字节都没变（`_wsOrigin` 那边空串仍然看页面协议）。
// ⚠️ 空串在**原生**上等于"打不出去"：这不是"降级"，是**没配**（见下面那句自检）。

/// 编译期给的服务端地址（`--dart-define=HUPO_API=…`）。**空串 = 同源**。
const String hupoApiBase = String.fromEnvironment('HUPO_API');

/// 这个地址**配了没有**。
///
/// ⚠️ 它只说"有没有给地址"，不说"给得对不对"—— 对不对由真机装上去的那一刻决定。
/// 🔴 空串在网页上是对的（同源），在原生上是**没配** ⇒ 两种平台读同一句话时
///    要分开看（`kIsWeb` 那边）；这里只留一个诚实的判据给打包脚本与判据用。
bool apiBaseConfigured(String base) => base.trim().isNotEmpty;

/// 一条请求地址在**这个 base** 下长什么样（纯函数 ⇒ 判据能在 VM 上直接量）。
///
/// 🔴 它存在的理由就是"**判据要打在客户端这一侧**"（V13 那一族）：
///    `Api` 里那一行拼地址的话，闸只能靠"读源码"；抽成纯函数以后，
///    "空 base 会拼出一条**没有 host** 的地址"这件事就能被**量**出来
///    （那就是原生包连不上的形状 —— 见 `test/unit/server_address_test.dart`）。
Uri apiUriFor(String base, String path) => Uri.parse('$base$path');

/// **安卓安装包**在同一个站点上的路径（首页那颗「下载安卓版」指向它）。
///
/// ⚠️ 它是**稳定名字**（不带指纹）：服务端那边对不带指纹的路径一律 `no-cache`，
///    所以换包之后访客拿到的一定是新的那一个（`08-SPEC.md` §8.3）。
///
/// 🔴 **2026-10-05 起是两个包**（主人：*「打包apk，这次是2.0版本了，我想起另一个app，
///    不要覆盖1.0。名字叫琥珀聊天」* ＋ 首页要**两颗按钮**）：
///    · [hupoApkPath]   = 2.0（装上身份 `chat.hupo.hupo_chat`，桌面上叫「琥珀聊天」）；
///    · [hupoApkPathV1] = 1.0（`chat.hupo.hupo_app`，桌面上叫「琥珀」；**原样留着**）。
///    ⚠️ 两个包**身份不同** ⇒ 同一台手机上并排装着，谁也覆盖不了谁。
/// ★ **2026-10-06：下载链接带版本号**（主人：*「apk命名方式，我们也要用版本号来。
/// 就是下载链接也要增加版本号。」*）。
///
/// 发出去的文件名是 `hupo-chat-<版本>.apk`（如 `hupo-chat-2.0.0-702.apk`）；
/// **构建期**由脚本喂进来：
///   · `scripts/build-apk.sh` —— 用**它这一次刚算出来的**那个版本名；
///   · `scripts/deploy-web-v2.sh` —— 读 `data/apk-build.json` 的 `file`（**现在发的是哪一份**）。
/// ⚠️ **默认值就是那个稳定名**（`hupo-chat.apk`）：VM 判据、以及任何没喂 define 的构建
/// 都落回它 —— 而稳定名**永远指向最新那一份**（服务端每次发布都刷新它）。
const String hupoApkName = String.fromEnvironment(
  'HUPO_APK_NAME',
  defaultValue: 'hupo-chat.apk',
);

/// 2.0 那个包（「琥珀聊天」）在这个站点上的路径 —— 首页那颗「下载安卓版」指向它。
///
/// ⚠️ 名字里那个版本号**不是"这一版才有的"**：它是"构建时线上是哪一版"。
///    点它的访客拿到的一定是那一份（带版本的文件**留档、不覆盖**）。
const String hupoApkPath = '/$hupoApkName';

/// 1.0 那个包**在老地址上原样留着**（老链接不许 404，也不许被 2.0 顶掉）。
const String hupoApkPathV1 = '/hupo.apk';

/// 把安装包那条路径变成一条**绝对**地址。
///
/// 🔴 非做成绝对不可（2026-09-28）：`openExternal`（`services/links.dart`）
///    **只认 http(s)** —— 相对路径它当场回 `false`（"什么都没开"），
///    而这颗按钮**必须真的把包下下来**（判据钉着"交出去的是一条绝对地址"）。
/// * [base] 非空（原生包带着地址）⇒ 用它的原点；
/// * 空（网页 = 同源）⇒ 用**页面自己**那条地址去解析（`Uri.base` 就是地址栏那个）。
/// * [path] 默认是**现在这一版**那个包；首页那颗「下载 1.0」显式传 [hupoApkPathV1]。
Uri apkDownloadUri({required String base, required Uri page, String path = hupoApkPath}) {
  final raw = base.trim();
  if (raw.isEmpty) return page.resolve(path);
  final origin = raw.contains('://')
      ? Uri.parse(raw)
      : Uri.parse('http://${raw.replaceAll(RegExp(r'/+$'), '')}');
  return origin.resolve(path);
}
