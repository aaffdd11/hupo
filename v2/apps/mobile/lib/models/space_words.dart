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
const String waitingFull = '这一台现在给你开不了。不是你的问题——我们这边记下了，会有人来处理。';

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
const String waitingStillLong = '还在开，比平常久了一点。没坏，再等一会儿就行。';
const String waitingRetryFail = '刚才没问上。等会儿再按一次。';

/// 填钥匙那一屏。
const String keyTitle = '还差最后一步';
const String keyBody = '要填一串你自己的钥匙，琥珀才能开口说话。';
const String keyLabel = '你那串钥匙';
const String keyWhere = '在你自己申请的地方能找到它。';
const String keySubmit = '填好了';
const String keyPrivacy = '它只送到你自己那一台，不留在我们这边。';

/// 填钥匙失败的四种说法（**分开说**，别混成一句 —— 混了用户会一直重试）。
const String keyBlank = '还没填。';
const String keyBadChars = '这串字里有空格或者换行，检查一下再填。';
const String keyTooLong = '这串字太长了，看看是不是多粘了一段。';
const String keyFailed = '没送过去。是我这边的问题，等会儿再试一次。';
