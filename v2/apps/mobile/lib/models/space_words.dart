// 那两屏上说的每一句话（契约 `docs/dev/38-ISOLATION-SPLIT.md` §8.3）。
//
// ⚠️ **文案单独一个文件**，因为它要被两道闸扫：
//   * `test/unit/forbidden_words_test.dart`（界面词表：不许出现 `模型` / `客户端` /
//     `工作区` / `口令` / `工具` / `搜索` … —— **这是缺陷，不是文风问题**）；
//   * `test/unit/space_words_test.dart`（**不许假进度**：一个百分号都不许有）。
//
// ⚠️ 用户是谁（`docs/ux/06-retiree.md`）：他**不会拼音**、读不懂术语。
//   所以这里的句子都短、都用他生活里的词（"钥匙"、"开一个空间"、"再看看"）。

/// 等待那一屏。
const String waitingTitle = '正在给你开一个只属于自己的空间';

/// 🔴 **"给不了"那一档的标题**（不是"正在给你开"）。
///
/// ⚠️ 为什么非要单有一个（2026-09-21 **看截图才发现的**）：
///    这一屏原来**只有**一个标题 `waitingTitle`（"正在给你开…"），
///    而"给不了"那一档的正文写的是"这一台现在**给你开不了**" ——
///    ⇒ **同一屏上两句话互相矛盾**：标题说正在开、正文说开不了。
///    这是本项目点名的"页面在说假话"，而它**查 DOM 查不到**（字画在 canvas 上），
///    **只能看一眼**才看得出来（`check-web-browser.mjs --shot`）。
/// ⚠️ 而 `provisioning`（真要现开一台）**用** `waitingTitle` 是对的 —— 那时候确实在开。
const String waitingFullTitle = '这一台现在给不了你';

/// **开空间那三步的人话**（服务端只说 `assigned`/`starting`/`ready` 三个名字）。
/// ⚠️ **没有百分比**：我们不知道"还要多久"，编一个数字就是假进度。
const Map<String, String> spaceStepWords = {
  'assigned': '给你留好一台，只属于你',
  'starting': '把它开起来',
  'ready': '马上就好',
};

/// 排队那一步（我们自己这边还没给他开）—— ⚠️ **如实说**，别让他以为马上就好。
const String waitingQueued = '前面还有人，得等一下：我们这边地方有限。';

/// 🔴 **给不了**（满了 / 那台没建成）—— 这一句是这次专门加的。
///
/// ⚠️ 为什么非加不可：这一档原来与"还在开"**共用**一个词，于是屏幕上
///    **没有一个字**告诉用户"它不会自己好了"。而等待屏每 2 秒自问一次、
///    三步一直不勾 —— **看起来像在动**。那是这个项目点名禁的那种假象。
/// ⇒ 说清两件事：**现在给不了**，以及**我们这边知道了、有人会看**（不是他的错）。
/// ⚠️ 只有**正文**了（"这一台现在给你开不了"那句搬去了标题 `waitingFullTitle`）——
///    不然标题和正文会把同一句话说两遍。
const String waitingFull = '不是你的问题——我们这边记下了，会有人来处理。';

/// **已经等了多久**（主人 2026-09-21："我需要一个动态的"）。
///
/// ⚠️ 这是一个**真的在走的秒数**（量的是真实过去的时间），**不是进度** ——
///    "等了 12 秒"是我们**真的知道**的事；"做了 60%"是我们**不知道**的事。
///    ⇒ 有它，用户看得出"没卡住"；而**一个百分号都不掺**。
String waitingElapsedWords(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  if (s < 60) return '已经等了 $s 秒';
  final m = s ~/ 60;
  return '已经等了 $m 分 ${s % 60} 秒';
}

const String waitingBody = '这一步通常很快。要是等久了，按下面那个按钮再看看。';

/// **正在现开一台**（申请已被受理、那一台还没建出来）。
///
/// ⚠️ 为什么要单有一句：这一步要**建一个用户、装一台盒子**（头一次还要把镜像
///    弄进去）—— 那是**几分钟**，不是"很快"。拿 `waitingBody`（"这一步通常很快"）
///    去盖它，就是在**说假话**：用户等两分钟就开始怀疑是不是坏了。
/// ⚠️ 而"已经建好了、在等它连上来"（`starting`）**确实**是很快的 —— 两句**不能混**。
/// ⚠️ 不许出现内部词；一个百分号也不许有。
const String waitingProvisioning = '头一次会久一点：这一台要现给你开出来。开着这一页等就行。';
const String waitingRetry = '再看看';
// 🔴 **2026-09-25 撤掉了一句假话**（契约 `docs/dev/88-P1-TIME-WAIT.md` §四 T7）：
//    原来这里有一句"还在开，比…久了一点"（当时的那个模板常量），由
//    `WaitingScreen` 上一个布尔决定画不画 —— 而那个布尔**没有任何生产者**
//    （`main.dart` 不传，只有等待屏读）⇒ 它今天永远画不出来；
//    只要将来谁顺手把它接上，屏幕上立刻出现一句**没有基线的比较级**：
//    它拿"平常"当参照，而那个"平常"**我们从来没量过**（服务端不记开一台要多久）。
//
//    ⇒ 两条路里选了**撤掉**（另一条是"给它真基线"）：
//      · 真基线要**先落盘每一次开台的耗时**、再算一个分布（那是 P4 耗时预估，
//        契约 §五.1 明说不做）——为一句文案开一条数据链，不值，而且这一批不许扩范围；
//      · 这一屏**已经在画真在走的秒数**（`waitingElapsedWords`，"已经等了 X 秒"）——
//        它是量出来的、有口径的。用户要的"它没坏、在动"由它兜着，
//        那句没依据的比较级**一个字都不多给**。
//    ⚠️ 判据在 `test/unit/space_test.dart`（"时间话术要么有口径、要么不许说"）。
const String waitingRetryFail = '刚才没问上。等会儿再按一次。';

/// 填钥匙那一屏。
const String keyTitle = '还差最后一步';
const String keyBody = '要填一串你自己的钥匙，琥珀才能开口说话。';
const String keyLabel = '你那串钥匙';
const String keyWhere = '在你自己申请的地方能找到它。';
const String keySubmit = '填好了';

/// **粘贴**那个按钮。🔴 它不是"顺手加的"——没有它，**手机上进不去**。
///
/// ⚠️ 为什么（2026-09-21 主人亲报"我无法黏贴，为啥"）：Flutter 把字画在 canvas 上，
///    长按弹的是**它自己的**选择菜单 —— 而**空输入框里没有可选的文字**
///    ⇒ **菜单不弹 ⇒ 没有"粘贴"**。桌面浏览器按 Ctrl+V 没事，
///    **手机没有物理键盘就卡在这儿**。而这一屏要的恰好是"粘一长串钥匙"。
/// ⇒ 一个按钮按下去就是"用户手势"，能合法读剪贴板（`Clipboard.getData`）。
const String keyPaste = '粘贴';

/// 读不到剪贴板时说的话（⚠️ 不许只说"失败"——要告诉他**还能怎么办**）。
const String keyPasteFailed = '读不到剪贴板。用键盘上的粘贴键，或者手动输入也行。';

/// 🔴 **取消注册**（主人 2026-09-22："贴 apikey 的时候，也要有个撤回的功能。
/// 隐蔽一点。就是取消注册。这样我就不用浪费资源了"）。
///
/// ⚠️ **"隐蔽"= 入口不抢眼**（小字、次要色、放在最下面），
///    **不是"不告诉你就删"** —— 它是**不可逆**的，手册 X3 ② 对"删一轮对话"
///    都要求**删前列清单**，删**整台**更得列。
const String keyCancelEntry = '不想填了，取消注册';

/// 确认框：标题 + **删掉什么**（这一行就是"删前列清单"）+ 两个按钮。
const String keyCancelTitle = '取消注册？';
const String keyCancelWhat = '你那一台盒子、里面的对话、还有记账的东西——都会没，位置也就腾出来了。这一步没法撤销。';
const String keyCancelNo = '先算了';
const String keyCancelYes = '确定取消';

/// 几种结果**分开说**（不许混成一句"失败"）。
const String keyCancelOk = '已经在收了。你那一台会在一会儿之内停掉。';
const String keyCancelNoHelper = '这台机器还没接上"回收"那条路。等接上了再试。';
const String keyCancelProtected = '你这一台是我们早期手工开的，得找人帮你收。';
const String keyCancelLocal = '你自己这一份就在这台机器上，没有单独一台要收。';
const String keyCancelNone = '你名下现在没有单独一台，不用收。';
const String keyCancelFailed = '没送上去。等会儿再试一次。';

/// 🔴 **要重新登一次**（账 #39 · 契约 `43-AUTO-PROVISION.md` §十四）。
///
/// ⚠️ 这一句要同时说清两件：**为什么要重登**（确认是你）、**现在什么都没动**
///    （他刚才点了那一下，别让他以为已经删了）。删东西这件事上，
///    "以为删了其实没删"和"以为没删其实删了"**都是坏事**。
const String keyCancelRelogin = '为了确认是你，得先重新登一次。登完再点一遍就好 —— 现在什么都没动。';

const String keyPrivacy = '它只送到你自己那一台，不留在我们这边。';

/// 填钥匙失败的四种说法（**分开说**，别混成一句 —— 混了用户会一直重试）。
const String keyBlank = '还没填。';
const String keyBadChars = '这串字里有空格或者换行，检查一下再填。';
const String keyTooLong = '这串字太长了，看看是不是多粘了一段。';
const String keyFailed = '没送过去。是我这边的问题，等会儿再试一次。';

// ── 「配置」那一屏（契约 `docs/dev/48-SETTINGS-KEY.md`）────────────────
//
// 主人 2026-09-22：*"用户可以在页面唤起配置。配置上可以输入 apikey"*。
// ⇒ 钥匙原来**只有**第一次那条流程能填（而且被判无效之后还得手动刷新才回得去），
//   现在**随时**能从页面上唤起这一屏。
//
// ⚠️ **"关于"也搬进来了**：顶栏原来 5 个图标，再加一个就是 7 个 ——
//    手机上那一条会挤成一团（而且五档字号那道硬闸本来就在盯这个）。
//    「关于」本来就是配置那一类东西（"这台设备上行不行"），放这儿更合结构。

/// 顶栏那个入口（图标按钮的 tooltip）。
const String configEntry = '配置';

/// 那一屏的标题（小程序容器给的顶栏用它）。
const String configTitle = '配置';

/// 桌面那个图标上的字 + tooltip。
/// ⚠️ 主人 2026-09-22：*"桌面上应当有一个设置的小程序，用来退出登录，注销账号，修改 apikey。"*
///    ⇒ **「配置」从抽屉（聊天抓手行）搬到了桌面上**，叫「设置」。
/// ⚠️ 一句话：**聊天不是桌面上的小程序**（它永续、永远在底下），
///    所以桌面上放的是**设置**，不是"会话"。
const String settingsAppLabel = '设置';

/// 小程序容器顶栏那个返回箭头（读屏用）。
const String miniAppBack = '返回';

/// 设置页的**第二个分区**：关于 / 退出登录这一组（2026-09-23 整理 UI 时加的）。
/// ⚠️ 原来这两条**光秃秃挂在最下面**，没有分区标题 ⇒ 一页里三块东西读不出结构。
const String settingsAboutSection = '这个助手';

/// 「关于」那一条下面的小字说明（**不写内容概要的承诺**，只说这一页管什么）。
const String aboutEntryHint = '它的能力、记忆和边界';

/// 设置里那一条：退出登录（原来挂在聊天抓手行上）。
const String settingsLogout = '退出登录';

// ── ★ 批次 4：「这块窗口」那一组（外观 / 字号 · 契约 `docs/dev/119`）────────
//
// 主人 2026-09-26：*"首先全部开放，聊天窗口的设计也要重做。"* —— DSH 的设置里
// 只有**两样**跟外观有关（`115-raw/A-layout.md` §470 逐字：*"Two settings only:
// color scheme + content font size (integer 12–17px, default 14px, stepper)"*）
// ⇒ 这一组就那两行。
//
// ⚠️ 三档的名字（亮 / 暗 / 跟随系统）住在 `models/appearance.dart` 的枚举上
//    （与 `appearance.dart` 的档名、`process_levels.dart` 的 `title` 同一条纪律：
//    **用户会看到的字要进得了禁用词那道扫描**），所以这里没有第二份。
// ⚠️ 这里每一句都**没有内部词**：说的是"这块窗口""字"，不是"主题 / 字号档位 / 客户端"。

/// 那一组的小标题（第三个分区）。
///
/// ⚠️ 说"**这块窗口**"而不是"外观"：它管的是**聊天那一扇窗**，
///    首页 / 登录 / 设置页自己**一个像素都不变**（`119` §五 那条边界）。
const String settingsAppearanceSection = '这块窗口';

/// 那一行：外观（**2026-09-26 起只摆「亮」** —— 暗色那一套只做了一半）。
const String settingsAppearanceLabel = '外观';

/// 「外观」下面那句说明（**如实说边界**：只改这一扇窗）。
const String settingsAppearanceHint = '只改聊天这扇窗口，别的页面不变。';

/// 🔴 **2026-09-26：「暗」和「跟随系统」两档暂时收起来了**（手册纪律 4：要砍就明说砍了）。
///
/// 理由（主人当天在暗色手机上的截图：黑底 ＋ 淡粉条 ＋ 字读不出来）：暗色那一套
/// 只换了聊天窗口那块底，里面的气泡 / 通知条 / 计划条还是暖白纸那套
/// ⇒ **没做完的样子不许摆出来给人按**。这一句就是那句"明说"（逐条缺口见 `119` §九）。
const String settingsAppearanceDarkNotReady = '暗色还在做，先只给亮色。';

/// 那一行：字号（12–17，步进器）。
const String settingsFontSizeLabel = '字号';

/// 字号那一行下面那句说明（**如实说边界**：只管聊天里的字 —— 与 DSH 逐字同一条）。
const String settingsFontSizeHint = '只影响聊天里的字，别处不变。';

/// 字号那一行下面**实时预览**用的那句（它自己**就按当前字号画**）。
/// ⚠️ 这就是"改一下马上看得见"那件事在**屏幕上**的证据 —— 不许换成一张静止的图。
const String settingsFontSizePreview = '这一行就是聊天里的字。';

/// 步进器两颗按钮的说明（读屏 / 悬停看得见；它们本身没有可见的字）。
const String settingsFontSizeSmaller = '字小一点';
const String settingsFontSizeBigger = '字大一点';

/// 钥匙那一段的小标题。
const String configKeySection = '你那串钥匙';

// ── ★ 配置页那**四个 tab**（主人 2026-09-24 定的形状）────────────────
//
// 主人原话：*"配置页用来配置模型，语言大模型apikey，语音大模型，图片生成，视频生成。"*
//
// ⚠️ **tab 上那两个字必须是他说得懂的话**：他点的这一屏要能自己看明白。
//    "模型"是**内部词**（词表硬闸会拦）⇒ 一律用"干什么用"来说：
//    聊天 / 语音 / 图片 / 视频。
// ⚠️ 每一屏都要说清**它管什么**＋（这一批里）**收下之后生效不生效**：
//    图片与视频这一批**只是收着**（那两条路还没接上），
//    语音这一批也**只是收着**（现在听你说话用的是这台机器上已经配好的那一份）。

/// 四个 tab 的名字（顺序＝主人说的顺序）。
const String credTabChat = '聊天';
const String credTabVoice = '语音';
const String credTabImage = '图片';
const String credTabVideo = '视频';

/// 某一屏那一句人话（**说它管什么**）。
String credTabWhat(String tab) {
  switch (tab) {
    case credTabVoice:
      return '填上它，我就能听懂你说话。';
    case credTabImage:
      return '填上它，我才能给你画图。';
    case credTabVideo:
      return '填上它，我才能给你做小片子。';
    case credTabChat:
    default:
      return '填上它，我才能开口答话。';
  }
}

/// 🔴 **这一批的边界句**（P1-1：收下之后**生效不生效**，必须当面说清）。
///
/// ⚠️ 为什么非说不可：不说的话，他填完图/视频那两把，以为什么都能干了 ——
///    而这两条路**还没接上**。那句"填上了"就成了他自己脑补出来的假承诺。
/// 🔴 **图片那一句也跟事实走**（P1-27 接通之后 · 2026-09-24）：
///   · 主人这一份填了 ⇒ **当场就能画**（这一屏下面有「试一张」）；
///   · 没填 ⇒ 说清"填上它才能画"；
///   · 租户那台**还没接**（和他的语音同一个原因：盒子里读的是盒子里那份存档）。
const String credImageBoundaryMine = '填好了。在下面写一句想要什么图，我就能给你画。';
const String credImageBoundaryNone = '还没有填。填上它，我才能给你画图。';
/// ⚠️ 2026-09-24 更正：租户**下面那个「试一张」本来就能用**（那条路走的是中心，
///    用的是中心这份按人存档）—— 真正还没接的是**"在聊天里让它画"**
///    （助手跑在他自己盒子里，读的是盒子里那份存档，见 `77-BLOCKERS.md` B10）。
///    ⇒ 旧那句"你这台还没接上"**把能用的那半也说成不能用了**，是假话。
const String credImageBoundaryTenant = '填好了。下面能试一张；在聊天里让它画，还得等你这台接上。';
const String credImageBoundaryTenantNone = '填上它，就能在下面试一张（聊天里让它画还得等你这台接上）。';

String credImageBoundary({required bool isTenant, required bool hasOwn}) {
  if (isTenant) return hasOwn ? credImageBoundaryTenant : credImageBoundaryTenantNone;
  return hasOwn ? credImageBoundaryMine : credImageBoundaryNone;
}

/// 视频那一句（🔴 **这条路不做** —— 主人 2026-09-24 定的：*"图片需要打通，视频不需要。"*）。
/// ⚠️ 所以不能说"还没接上、接上就用它"（那听着像**在排队**）—— 要**明说没做**。
/// ⚠️ 钥匙那一栏留着（他还是能存），但一个字的承诺都不给。
const String credBoundaryVideo = '先收在你自己的名下。做片子那条路**不做**（你说不需要）—— 这一栏先只把钥匙收着。';

// ── 「试一张」那几句（画图那一屏里）────────────────────────────
const String imageTryLabel = '试一张';
const String imageTryHint = '填好钥匙之后，在这儿写一句话，看它能不能画出来。';
const String imagePromptLabel = '想要什么样的图';
const String imageTrySubmit = '画一张';
const String imageGenerating = '正在画…';
const String imagePromptBlank = '先写一句想要什么图。';
const String imageTryFailed = '这次没画成，等会儿再试。';
const String imageLoadFailed = '图取不回来（地址可能已经过期了）。';
const String imageTempLink = '图是那边临时给的，想要就存下来。';
/// 🔴 **语音那一句要跟着事实变**（P1-26 后半，2026-09-24 接通"按人一份"之后）。
///
/// ⚠️ 为什么不能再写死一句：
///   · 主人这一份（本机）**填了就真的用它**（识别路优先读他自己那三样）
///     ⇒ 那时候还说"现在用的是这台机器上配好的那一份"就是**假话**；
///   · 租户那台**还没接上**（他的 `/api/asr` 在盒子里，读的是盒子里那份）
///     ⇒ 那时候说"填了就真用它"也是**假话**。
/// ⇒ 四种组合四句话，**一个字都不许省**（说错哪一句都是"页面在说假话"）。
const String credVoiceBoundaryMine = '填好了。以后听你说话就用这三样，不再用这台机器上那份。';
const String credVoiceBoundaryDefault = '先收着。现在听你说话用的是这台机器上已经配好的那一份。';
const String credVoiceBoundaryTenantHas = '先收着。你这台还没接上，接上就用这三样。';
const String credVoiceBoundaryTenantNone = '先收着。你这台还没接上。';

/// 语音那一屏此刻该说的那句话（**纯函数**，判据钉四种组合）。
String credVoiceBoundary({required bool isTenant, required bool hasOwn}) {
  if (isTenant) return hasOwn ? credVoiceBoundaryTenantHas : credVoiceBoundaryTenantNone;
  return hasOwn ? credVoiceBoundaryMine : credVoiceBoundaryDefault;
}

/// 某一屏的边界句（**聊天那一屏没有** —— 它是现在就在用的那一条）。
String? credBoundaryOf(String tab, {bool isTenant = false, bool hasOwn = false}) {
  switch (tab) {
    case credTabVoice:
      return credVoiceBoundary(isTenant: isTenant, hasOwn: hasOwn);
    case credTabImage:
      return credImageBoundary(isTenant: isTenant, hasOwn: hasOwn);
    case credTabVideo:
      return credBoundaryVideo;
    case credTabChat:
    default:
      return null;
  }
}

/// 语音那三样各自的说明（**三样齐了才算有**）。
const String credVoiceAppIdLabel = 'AppID';
const String credVoiceSecretIdLabel = 'SecretId';
const String credVoiceSecretKeyLabel = 'SecretKey';

/// 图片 / 视频 / 聊天：一把钥匙时输入框上那句话。
const String credOneKeyLabel = '把它们给你的那一串贴进来';

/// 某一屏"现在有没有"那句话（**纯函数**）。
///
/// ⚠️ 三种状态必须分开（与 [keyStateLine] 同一条纪律）：
///    有 / 填过但被判无效 / 还没填。混成一句就是页面在说假话。
String credStateLine({required String tab, required bool has, required bool bad}) {
  if (has) {
    if (tab == credTabChat) return keyStateHas;
    return '这一样已经有了。填一串新的就会把它换掉。';
  }
  if (bad) return keyStateBad;
  return '还没有填。';
}

/// ── 更早的消息：往上翻着加载（批 C · `docs/dev/64-CHAT-REDESIGN.md` §三）──────
///
/// ⚠️ **"没问到"与"到头了"必须分开说**（混成一句就是把网络问题说成"没有更早的"）。
const String olderLoadingWords = '正在取更早的…';
const String olderFailedWords = '刚才没问上，往上再滑一次试试';
const String olderCappedWords = '先到这（这台设备只留最近这些）';
const String olderEndWords = '到头了';

/// 回到最新那一条那颗按钮上的字（**有字**，D3.8）。
const String backToLatestWords = '回到最新';

/// **现在是什么状态**（三种，必须分得开 —— 见 `keyStateLine`）。
const String keyStateHas = '现在用的是一串已经填好的钥匙。';
const String keyStateNone = '还没有填。填上它，琥珀才能开口说话。';

/// ⚠️ 这一句以前**说不出来**：服务端只回 `hasKey:false`，"没填过"和"被判无效"
///    在界面上长得一模一样 ⇒ 只能对他说"还没有填"。那是**在说假话**。
const String keyStateBad = '你填的那串它说用不了。在这儿换一串就好。';

/// 已经有一串时，输入框上面那句话（说清"填了会换掉"）。
const String configKeyHint = '填一串新的，就会把现在这串换掉。';

/// 换成功之后那句。
const String configKeyChanged = '换好了。';

/// 换一串时提交按钮上的话（第一次填时是 `keySubmit`）。
const String keySubmitChange = '换好了';

/// 🔴 **"你自己这一份"（没有单独一台）那一屏要说的话**（2026-09-22 补）。
///
/// ⚠️ 为什么非有不可：主人自己那个号（`owner`）是**跑在这台机器上的那一份**，
///    它**没有容器**、钥匙也**不在这条路上配**。而配置那一屏原来对他
///    照样画一个输入框 + 一句"还没有填" ⇒ 他填了会拿到
///    **"没送过去。是我这边的问题"**（指错方向：根本不是"我们出问题"，
///    是"这一份不走这条门"）。
///    ⇒ 对他**说真话、不给假输入框**。
/// ⚠️ **2026-09-24 改口径**：主人选了"要真能改"（他的原话选的是这一档）——
///    所以他自己那一份**也能在这页填**了（语言那一把会写进他本机那份凭据里）。
///    这句话从"钥匙不在这页填"改成"填了会写到哪" —— 仍然是**实话**，只是换了事实。
const String configLocalOnly = '你自己这一份就在这台机器上：填了会写到本机那份凭据里，下一条消息就生效。';

/// **现在是什么状态**那句话。**纯函数**（`test/unit` 里钉三种）。
///
/// ⚠️ 三种状态**必须分开**：
///   ① 有（`hasKey`）② 填过但被判无效（`keyBad`）③ 还没填过。
///   ② 和 ③ 混成一句，用户就会去重填一把**他其实已经填过的**钥匙，
///   或者更糟：以为"这台就是不通"。
String keyStateLine({required bool hasKey, required bool keyBad}) {
  if (hasKey) return keyStateHas;
  if (keyBad) return keyStateBad;
  return keyStateNone;
}

/// ── 打字框里那份草稿（主人 2026-09-22）────────────────────────
/// *"就是要有一个空的输入框，但如果用户输入过，没发送，则显示在上面作为草稿。草稿也是要记住的。"*
///
/// ⚠️ 它和"已发未认领那句话"（`draft_store.dart`）**不是一回事**：
///    这个字**一个字都没发出去**，所以它不占时间线、没有"重发"。
const String composeDraftTitle = '你打了一半';
const String composeDraftBack = '接着写';
const String composeDraftDiscard = '不用了';

/// 展开态抓手行上那个「收起」（主人 2026-09-22：*"展开后要有收回的按钮"*）。
/// ⚠️ 它**钉在横滚之外**（那条动作横滚会把按钮滚出视野 —— 那就等于没有出口）。
const String chatCollapse = '收起';

/// ── **聊天条最前面那个图标：这句话是在哪儿说的**（主人 2026-09-23）────
///
/// 主人原话：*"底部的聊天窗口，我需要左侧是一个 icon。是一个 home icon，说明聊天作用域
/// 在桌面也就是全局。当进入某个 app 时，聊天作用域也进入了这个 app。所以聊天窗口前面的
/// 图标也成了那个 app 的 logo icon。"*
///
/// ⚠️ **它不是按钮**（只是"现在在哪儿说话"的指示）⇒ 没有点击行为，也就不需要命中区。
/// ⚠️ 话要说得像人话：在桌面上说 = 全局；进了某个小程序 = 就着那一个小程序说。
///    这两个词是给**长按提示与读屏**用的（看得见的人一眼看的是那个图标本身）。
const String chatScopeDesktop = '在桌面上问（全局）';

/// 进了某个小程序时那一句（`app` = 那个小程序叫什么）。
String chatScopeInApp(String app) => '在「$app」里问';

/// 现在这一间**名字一时查不到**时那一句（主人 2026-09-25 拍的 **B35**）。
///
/// 🔴 什么时候会走到这儿：**窗口自己跟到刚派出去的那一间**时 —— 那一间的名字在
///    **他盒子里**（宿主查不到，见 `77-BLOCKERS.md` **B20**）。
/// ⚠️ 这时候**不许**退回「在桌面上问（全局）」：那句话去的是**另一间**，
///    写"在桌面上"就是**假话**（这个项目最忌的形状）⇒ 说一句**不撒谎的模糊话**。
const String chatScopeElsewhere = '在另一处问';

/// ── **一个图标 = 一条对话**（契约 `docs/dev/83-APP-WORKSPACE.md` §五·甲）──
///
/// 某个小程序的房间**还一句话都没说过**时，屏幕上那两句。
/// ⚠️ **不许白屏**（§六·4 的判据点名"真机截图"）：白屏 = 用户不知道
///    "这里是不是坏了 / 我说的话去哪儿了"。⇒ 说清**这是哪间**（那个小程序的名字），
///    以及"说了会记在哪儿"。
/// ⚠️ 用词纪律照旧（`forbidden_words.dart`）：**"工作区"那类内部词一个都不许有** ——
///    这里只用"这个小程序自己的名字"这种普通说法。
const String roomEmptyTitle = '这里还空着';

/// `app` = 那个小程序的名字（服务端给的 `title`，和桌面上那一格、聊天条那个图标同源）。
String roomEmptyLine(String app) => '在「$app」里说的话，会记在这儿。';

/// 顶栏那个「过程多少」的入口（原来只是 `chat_screen` 里一句写死的 tooltip）。
/// ⚠️ 界面上就写这两个字（用户看得懂），完整那句留给 tooltip。
const String levelActionWords = '过程';

/// **桌面上那一句引导**（2026-09-23 整理 UI 时加的）。
/// ⚠️ 只说"点一下会怎样"，**不承诺任何做不到的事**（D7.1：不许承诺）。
const String desktopHint = '点一下图标，就打开它。';

/// ── 语音那一边（主人 2026-09-22：*"对话框要学习微信。要能切语音，能切听筒。
/// 语音和听筒都要实时转文字。"* → 追问后他说 **"先做假的"**）──────────────
///
/// 🔴 **那个"假的"已经砍了**（2026-09-23 主人定案）：
/// *"我们那个页面，并没有按钮。你做一下按钮。是按一下开始语音跟踪，
///  实时转化语音成文字。再按一下结束。然后将文字展示出来。用户可以选择发送。"*
/// ⇒ **假的一半（`按住 说话` + `演示` 小标 + 假字）整个删掉**，换成**真的**：
///   · 字在 `hearing_words.dart`、状态机在 `hearing_session.dart`、
///     开麦在 `services/hearing.dart`、契约在 `docs/dev/71-MIC-ASR.md`；
///   · "按住"那套语义**明说砍了** —— 现在是**按一下开始、再按一下结束**。
///
/// ⚠️ 留着的那两个词是**话筒 / 键盘那个切换**（微信那个）——它还在，也是真的。
const String voiceToKeyboard = '键盘';
const String voiceToMic = '语音';

// ⛔ **"听筒 / 扬声器"那三个词砍了**（2026-09-23 主人定案）：
//    · 那套语义是"微信里声音从哪儿出"（听筒 ⇄ 外放），而**网页上没有"听筒"这个出口**
//      （浏览器只有扬声器/耳机，`setSinkId` 在 iOS 上无效 —— 手册 §3.2 自己写着）
//      ⇒ 留着它就是**假装有一个做不到的东西**；
//    · 真做得到的那半（**让它念出来**）现在**是真的**了，词在 `speak_words.dart`
//      （开关"读出来 / 不读"、每条按钮"读一遍 / 别念了"），契约 `docs/dev/68-SPEAK.md`。

// ── 聊天里那张图跟前跟后的两句（P1-27 后半）────────────────────
/// 图还在取的时候。
const String imageLoadingWords = '图正在过来…';
/// 🔴 取不到图时**说实话**（多半是那个临时地址过期了 —— 不许留一块空白让人猜）。
const String imageGoneWords = '这张图取不回来了（那个地址是临时的，多半过期了）。';
/// 图是临时地址那件事（与配置页那句同一个意思）。
const String imageTempWords = '图是那边临时给的，想要就存下来。';
