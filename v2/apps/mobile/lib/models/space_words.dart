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

/// 排队那一步（池子里没有空位了）—— ⚠️ **如实说**，别让他以为马上就好。
const String waitingQueued = '前面还有人，得等一下：我们这边地方有限。';
const String waitingBody = '这一步通常很快。要是等久了，按下面那个按钮再看看。';
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
