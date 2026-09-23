// 「关于」页要说的话。手册 **D3.3**（v1.1 修订）· D3.4 · `01-PROJECT.md` ★2/★4/★5。
//
// ⚠️ **为什么这些话是"数据"而不是写死在界面里**：
//    文案本身要进**硬闸**（禁用词扫描在 `test/unit`，那是真闸）。
//    摆在 `screens/` 里的话，闸就够不着它 —— 而这一页的字恰恰是最要紧的那几句。
//
// ⚠️ **纯逻辑，不许 import flutter/material**（`models/` 的规矩）。
//
// ── D3.3 的规则（v1.1 改过一次，照它写）────────────────────
//
// > **关于页要按「当前这台设备」如实说**；检测不到就**说得保守**，**不许一刀切**。
//
// 为什么"一刀切"不行：**设备输入法自带语音时，写"用不了"是假话**，
// 而且会**劝退一个其实能用的人**。⇒ 只能说"取决于你的输入法"。
//
// ⚠️ 而且**我们检测不到**输入法有没有麦克风（没有那个 API）——
//    所以这一页**永远走保守那一路**，不许假装知道。

/// 一条事实：一个小标题 + 几句人话。
class AboutFact {
  const AboutFact({required this.title, required this.lines});
  final String title;
  final List<String> lines;
}

/// D3.3：**按设备说**。⚠️ 不许改成"不会拼音就用不了"那种一刀切。
///
/// 🔴 **2026-09-23 大改过一次 —— 原来这三行里有一句假话**：
///    它写着"**我们自己没有另外做一个话筒**"，而那一版**真的做了**
///    （网页上那颗话筒 → 按一下说话 → 实时出字，契约 `docs/dev/71-MIC-ASR.md`）。
///    是主人要"整理整个 UI"时，我在**关于页里当场读出来的**。
///    ⇒ 现在按设备分两种说法（`canHear`），而且两种都过禁用词硬闸。
const AboutFact aboutVoiceWeb = AboutFact(
  title: '它怎么听你说话',
  lines: [
    '点那个话筒 → 按一下「按一下 说话」→ 说完再按一下。',
    '字会进到输入框里，你自己决定发不发 —— 它不会替你发出去。',
    '你的输入法自带麦克风时，也能照常用它。',
  ],
);

/// 这台设备**开不了麦**（原生那个包里还没做录音）时说的那几句。
const AboutFact aboutVoiceNo = AboutFact(
  title: '它怎么听你说话',
  lines: [
    '这一台还不能用嘴说 —— 用浏览器打开就能用（那儿有一个话筒）。',
    '你的输入法自带麦克风时，也能照常用它。',
  ],
);

/// **按设备说**：网页（开得了麦）用 [aboutVoiceWeb]，否则用 [aboutVoiceNo]。
///
/// ⚠️ 纯函数（`test/unit/about_facts_test.dart` 两种都要扫硬闸）。
List<AboutFact> aboutFactsFor({required bool canHear}) => [
  canHear ? aboutVoiceWeb : aboutVoiceNo,
  aboutMemory,
  aboutTruth,
];

/// ★2「记忆不可验证 ⇒ 黑盒记忆 = 默认没记住」。
///
/// ⚠️ 数字要对得上实现：跨重启喂回去的是**最近几十句**
///    （`recapMaxEntries` / `recapMaxChars`，住在 `services/core/src/recap.js`）。
///    ⇒ 这里写"最近这一段（几十句）"，**不写"全都记得"**。
const AboutFact aboutMemory = AboutFact(
  title: '它记不记得',
  lines: [
    '记得，但记得不多：关掉再打开，它还能看到最近这一段，大概几十句。',
    '更早的就不在它眼前了。',
    '它没看到的，它会说不知道 —— 不猜。',
  ],
);

/// ★4/★5「看不见的边界 ⇒ 不敢说真话」。
///
/// ⚠️ **不写"它什么都能干"**，也不写"它不会出错"。
///    手册 D2.1 记着：关于页里提"它能改自己的代码"会让人**害怕**（读得懂的只有一个），
///    所以这一页**一个字都不提**那件事。
const AboutFact aboutTruth = AboutFact(
  title: '它说的话能信到什么程度',
  lines: [
    '数字、日期、人名这些，它拿不准会直说拿不准。',
    '要是你发现它编了，那是它的错，直接说它。',
  ],
);

/// 这一页按顺序摆这几条。
/// ⚠️ **保守那一份**（开不了麦的说法）。判据扫这一份 + `aboutFactsFor` 的那两份。
/// 界面**不要**直接用这个常量 —— 用 [aboutFactsFor]（按设备说）。
const List<AboutFact> aboutFacts = [aboutVoiceNo, aboutMemory, aboutTruth];
