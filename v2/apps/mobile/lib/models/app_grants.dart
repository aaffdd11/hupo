// **注册制那张卡背后的纯逻辑**（手册 `08-SPEC.md` §14.1·甲 · 契约 `docs/dev/147-APP-SQLITE.md`）。
//
// 主人原话：*「注册制，在设置里可以看到也可以关闭」*
// ＋ 2026-10-01：*「小程序不要声明，应该是打开后有弹窗申请权限」* ·
//    *「打开时一次问完」* · *「那一样用不了，别的照旧」*。
// 规矩是"声明 + 允许"两样都齐了才算：
//   · `permissions` = **制品声明的**（它想要什么 —— **不是"它已经有了"**）；
//   · `granted`     = **主人允许了的**（你给了没有）—— 由 `/api/apps` 带回来；
//   · `unanswered`  = **还没问过他的那几样** —— **打开时那张弹窗问的就是它**，
//     问过（允许 / 不给）之后那一样就从这儿挪走（之后在设置里能改）。
//
// 🔴 ★ **2026-10-02：存储不再是"要问的一样"**（主人原话：*「我发现做的小程序都不会有
//    存储。这个应该默认有存储。」*）—— 每个小程序**天生就有**自己那一格库：
//      · 它**不进** [knownWants]（那张卡上不给开关、打开时也不问）；
//      · 老制品清单里带着的那个 `db` **照样认得**，只是**不上屏**（见 [wantRowsOf]）；
//      · **"清空它存下来的东西"**那颗按钮**每个小程序都有**（[canClearStored]）。
//
// ── 这一份守什么 ──────────────────────────────────────────
//   ① 🔴 **老服务端不回 `granted` ⇒ 不知道**（`null`，**不是**空数组）——
//      界面据此**不给开关**（画一个假的开/关就是"页面在说假话"）；
//   ② 🔴 **回执只有服务端明说 `{ok:true}` 才算成了**（同 `appEditOutcomeOf` 那条纪律）：
//      非 200 与"200 但读不出来"**都算没成**，没成时把服务端那句**人话**带回去；
//   ③ ⚠️ 认得出来的名字只有今天那三个（`db` / `ask` / `net`）—— **技术名一个都不许上屏**
//      （人话住在 `space_words.dart`，词表硬闸扫它）；
//   ④ 🔴 **"清空它存下来的东西"那条口是另一件事**（`POST /api/app-db-clear`）：
//      它**跟开关无关**（关掉存储也能清："我的东西我拿走"），只有"服务端明说
//      `{ok:true}`"才算成了 —— 回执映射同 [grantOutcomeOf] 那条纪律，**一个字节都不许猜**。
//
// ⚠️ **纯逻辑**：不 import material、不做 I/O（`dart:convert` 只用来读回执）。
//    进 `test/unit` 硬闸。

import 'dart:convert';

import 'app_spec.dart';
import 'space_words.dart' show settingsGrantsFailed, settingsClearDbFailed;

/// **"想把东西存下来"**在协议里那个名字（`permissions: ["db"]`）。
///
/// ⚠️ 这一串是**协议名**，不是屏幕上那几个字（人话住 `space_words.dart`）——
///    两处别混：屏幕上出现 `db` 就是内部词泄漏（词表硬闸会拦）。
///
/// 🔴 ★ **2026-10-02：这一样不再需要声明、也不再要他点头**（主人原话：
///    *「我发现做的小程序都不会有存储。这个应该默认有存储。」*）——
///    存储是**基本能力**：每个小程序天生就有自己那一格库，打开就能存。
///    ⇒ 它**不进** [knownWants]（不上那张卡、不进弹窗）；老清单里那个 `db`
///    只是"当年写下的声明"，今天不再代表"它要申请什么"。
const String wantStore = 'db';

/// **"想用你的钥匙问一句"**在协议里那个名字（`permissions: ["ask"]`）。
const String wantAsk = 'ask';

/// ★ **"想连网取数据"**在协议里那个名字（`permissions: ["net"]` ·
/// 手册 `08-SPEC.md` §14.1·丙）。
///
/// 🔴 它比另外两样多一份**域名白名单**（清单里 `net: [...]`）—— 但那是**声明侧**的事，
///    这张卡只说"它想要什么"这一件；白名单**不摆到屏幕上**（摆一列域名只会让人看不懂）。
const String wantNet = 'net';

/// ★ **"想跟它的助手说一句话"**在协议里那个名字（`permissions: ["agent"]`）。
///
/// ⚠️ 它和 `ask` **不是一样**：`ask` 是"用你的钥匙问一句"（直连模型）；
///    这一样是"请动**那一间的助手**"（它有手：能读文件、能查网）⇒ 人话要分开说。
const String wantAgent = 'agent';

/// 界面上**认得**的那几样（顺序＝摆出来的顺序）。
///
/// ⚠️ 认不出来的名字**照样要如实说**（那句人话由 `grantWantWords` 兜底），
///    但**不给开关** —— 开关那一下要去服务端，而服务端只认白名单里那几个；
///    摆一个按了必被拒的开关，比不摆更坏。
/// ⚠️ **顺序是"存东西 → 问一句 → 上网"**（三样都认得的那一份清单）。
/// ★ **"想按点自己跑一件事"**在协议里那个名字（`permissions: ["tasks"]`）。
///
/// ⚠️ 这一样是**注册制里最"重"的一样**：它会让助手**自己动起来**（每天/每隔一阵做一件事），
///    所以人话要说清"**它会自己动**"，而且设置里关得掉。
const String wantTasks = 'tasks';

/// ★ **"想拍一张照片"**在协议里那个名字（`permissions: ["camera"]` ·
/// 主人 2026-10-05：*"给小程序增加拍照功能。"*）。
///
/// 🔴 与别的几样不同：**它不要服务端那条口** —— 镜头是浏览器/WebView 自己给页面的
///    （`getUserMedia` / `<input capture>`）。我们只做两件事：**要他点头**
///    ＋ **按授予放开那一层门**（网页上 iframe 的 `allow="camera"`、安卓上 WebView 那条
///    `onPermissionRequest`）。⚠️ 没授予 ⇒ 门是关的，页面里当场被拒。
const String wantCamera = 'camera';

const List<String> knownWants = [wantAsk, wantNet, wantCamera, wantAgent, wantTasks];

/// 界面上认得这个名字吗。
bool knownWant(String permission) => knownWants.contains(permission);

/// ★ **它"想要什么"里该摆到屏幕上的那几样**（顺序照服务端给的清单）。
///
/// 🔴 **只有 `db` 不算**（2026-10-02）：存储默认就有 ⇒ 摆一行"想把东西存下来"
///    会让它看起来像一件**要他允许**的事（那一行今天要么没有开关、要么画成关着）。
/// ⚠️ 认不出来的名字**照样摆**（"它想要点什么"这件事不许藏起来，见 [knownWant]）。
List<String> wantRowsOf(MiniApp app) => [
  for (final p in app.permissions)
    if (p != wantStore) p,
];

/// ★ **还没问过他的那几样**（`unanswered`）：`null` = 服务端**没回**（老服务端）⇒
/// **不知道**（那就**不弹窗**：弹一张问不出结果的窗只会白挡他一下）。
///
/// 🔴 这是 2026-10-01 主人定下的那一档：**声明 ≠ 已给** ——
///    制品里写的 `permissions` 只是"它想要什么"，**打开时那张弹窗**问的就是它。
Set<String>? unansweredOf(MiniApp app) {
  final u = app.unanswered;
  if (u == null) return null;
  return {for (final p in u) p};
}

/// 🔴 **打开它之前该问的那几样**（顺序照服务端那份 `unanswered`）。
///
/// 三个条件都要：**它声明了** ＋ **他还没表过态** ＋ **界面上认得这个名字**
/// （认不出来的名字不给开关 —— 那个开关按下去必被服务端拒，摆它比不摆更坏）。
List<String> pendingWantsOf(MiniApp app) {
  final un = unansweredOf(app);
  if (un == null) return const [];
  return [
    for (final p in app.permissions)
      if (un.contains(p) && knownWant(p)) p,
  ];
}

/// **打开它之前要不要先问一句**。
bool needsAskOnOpen(MiniApp app) => pendingWantsOf(app).isNotEmpty;

/// **你给了没有**：`null` = 服务端**没回这个字段**（老服务端）⇒ **不知道**。
///
/// ⚠️ 这里必须把"没回"与"回了空数组"分开：前者是"不知道"，
///    后者是"一样都没给" —— 混成一个 `{}` 就会画出一个假的关着的开关。
Set<String>? grantedOf(MiniApp app) {
  final g = app.granted;
  if (g == null) return null;
  return {for (final p in g) p};
}

/// 那个开关这会儿**该开还是关**；`null` = **压根不给开关**。
///
/// 三种"不知道"是同一种处理：老服务端没回 `granted` / 这一样界面上认不出来 /
/// 这个 app 本身没声明它。**都不许画开关**（画了就是给一个假状态）。
bool? grantSwitchOn(MiniApp app, String permission) {
  if (!knownWant(permission)) return null;
  if (!app.permissions.contains(permission)) return null;
  final g = grantedOf(app);
  if (g == null) return null;
  return g.contains(permission);
}

/// 成了之后本地该记成哪一份（服务端回执里**没带清单**时的兜底）。**纯函数**。
///
/// ⚠️ 只在服务端**明说成了**之后才用它 —— 它算的是"照他刚点的那一下"，不是预测。
List<String> nextGranted(List<String> now, String permission, bool allow) {
  final out = [
    for (final p in now)
      if (p != permission) p,
  ];
  if (allow) out.add(permission);
  return out;
}

/// `/api/app-grant` 的回执 —— 三种，**不许混**（同 `AppEditOutcome` 那条纪律）。
sealed class GrantOutcome {
  const GrantOutcome();
}

/// 服务端**明说** `{ok:true}`。
class GrantOk extends GrantOutcome {
  const GrantOk(this.permissions);

  /// 服务端回的那一份 `permissions`（**允许了的那几样**）。
  /// `null` = 回执里没带 ⇒ 界面按**本地算的**那一份画（`nextGranted`）。
  final List<String>? permissions;
}

/// 令牌不行 ⇒ 该回登录页（**不是**"没改成"）。
class GrantUnauthorized extends GrantOutcome {
  const GrantUnauthorized();
}

/// 没成：网 / 非 200 / `ok` 不是 true / 回执读不出来 ⇒ **一个字节都不当成功**。
class GrantFailed extends GrantOutcome {
  const GrantFailed(this.text);

  /// 服务端给的**人话**（给用户看的那一句）；空串 = 它没说 ⇒ 界面用兜底那句。
  final String text;
}

/// 回执里那份名字清单（读不出来 ⇒ `null`）。
List<String>? permissionListOf(Object? raw) {
  if (raw is! List) return null;
  return [
    for (final p in raw)
      if (p is String && p.isNotEmpty) p,
  ];
}

/// 回执 → 结果。**纯函数**（不起网络、不碰界面、不看钟）。
///
/// 状态码的分工（**不许互相串**）：
///   `401` ⇒ 令牌不行；
///   `200` **且** `{ok:true}` ⇒ 成了；
///   其余（含"200 但回执不是明说的 ok"）⇒ **没成**，并带回服务端那句 `text`。
GrantOutcome grantOutcomeOf(int status, String body) {
  if (status == 401) return const GrantUnauthorized();
  Object? parsed;
  try {
    parsed = jsonDecode(body);
  } catch (_) {
    parsed = null;
  }
  final j = parsed is Map ? parsed : null;
  if (status == 200 && j != null && j['ok'] == true) {
    return GrantOk(permissionListOf(j['permissions']));
  }
  final text = (j != null && j['text'] is String) ? (j['text'] as String) : '';
  return GrantFailed(text);
}

/// 没改成时**该说的那一句**：服务端有人话就照它说，没有就用兜底那句。
///
/// ⚠️ **不许静默**（这一条是纪律，不是文风）：他点了一下，屏幕上必须有一句话。
String grantFailedLine(GrantFailed out) {
  final t = out.text.trim();
  return t.isEmpty ? settingsGrantsFailed : t;
}

// ── ★ 2026-10-01：**清空它存下来的东西**（`POST /api/app-db-clear`）──────────
//
// 契约 `docs/dev/147-APP-SQLITE.md` §五那笔欠账；服务端那条口在这一轮刚做完。
// 🔴 ★ **2026-10-02 起：每个小程序都有这颗按钮** —— 存储默认就有（主人原话：
//    *「我发现做的小程序都不会有存储。这个应该默认有存储。」*）⇒ "它声明了存东西没有"
//    不再是判据（今天的制品**根本不声明**也照样能存）。🔴 它**跟"停用"无关**：
//    那颗按钮说的是"我的东西我拿走"。

/// **这个 app 该不该有"清空它存下来的东西"那颗按钮**。
///
/// 🔴 **每个小程序都有**（`permissions` 里写着什么**不看** —— 2026-10-02 改的）：
///    存储是基本能力，制品**不声明也存得进去** ⇒ 只按"声明了 `db`"来摆，
///    今天做出来的小程序就**永远够不着**清空那颗按钮（那是让"我的东西我拿走"落空）。
/// ⚠️ 参数留着是**故意的**：判据那一侧读的是"这一个 app"，不是"它声明了什么"。
bool canClearStored(MiniApp app) => app.id.isNotEmpty;

/// `/api/app-db-clear` 的回执 —— 三种，**不许混**（同 [GrantOutcome] 那条纪律）。
sealed class ClearOutcome {
  const ClearOutcome();
}

/// 服务端**明说** `{ok:true}`（`removed` = 删掉几个文件；**界面不必显示**）。
class ClearOk extends ClearOutcome {
  const ClearOk(this.removed);

  /// 服务端回的 `removed`（不是整数 / 没带 ⇒ `null`）。
  /// ⚠️ 它**不参与任何判断**：成没成只看 `ok:true`（"没存过也回 200"是幂等）。
  final int? removed;
}

/// 令牌不行 ⇒ 该回登录页（**不是**"没清掉"）。
class ClearUnauthorized extends ClearOutcome {
  const ClearUnauthorized();
}

/// 没成：网 / 非 200 / `ok` 不是 true / 回执读不出来 ⇒ **一个字节都不当成功**。
class ClearFailed extends ClearOutcome {
  const ClearFailed(this.text);

  /// 服务端给的**人话**（给用户看的那一句）；空串 = 它没说 ⇒ 界面用兜底那句。
  final String text;
}

/// 回执 → 结果。**纯函数**（不起网络、不碰界面、不看钟）。
///
/// 状态码的分工（**不许互相串**）：
///   `401` ⇒ 令牌不行；
///   `200` **且** `{ok:true}` ⇒ 成了（**幂等**：没存过也是这个）；
///   其余（含"200 但回执不是明说的 ok"）⇒ **没成**，并带回服务端那句 `text`。
ClearOutcome clearOutcomeOf(int status, String body) {
  if (status == 401) return const ClearUnauthorized();
  Object? parsed;
  try {
    parsed = jsonDecode(body);
  } catch (_) {
    parsed = null;
  }
  final j = parsed is Map ? parsed : null;
  if (status == 200 && j != null && j['ok'] == true) {
    final removed = j['removed'];
    return ClearOk(removed is int ? removed : null);
  }
  final text = (j != null && j['text'] is String) ? (j['text'] as String) : '';
  return ClearFailed(text);
}

/// 没清成时**该说的那一句**：服务端有人话就照它说，没有就用兜底那句。
///
/// ⚠️ **不许静默**，也**不许**先说成"清掉了"（同 [grantFailedLine] 那条纪律）。
String clearFailedLine(ClearFailed out) {
  final t = out.text.trim();
  return t.isEmpty ? settingsClearDbFailed : t;
}
