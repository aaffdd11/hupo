// **"说一句试试"那一屏的话**（V2.0 第一件 · 主人 2026-10-04）。
//
// ⚠️ 一处出处：这些话只住在这儿（禁用词那一套：不许出现内部词）。
// ⚠️ 它**不是**聊天那条路的话 —— 那一屏是**演练**（一句都不会发出去），
//    所以每一句都带"演练"这个意思，别让他以为真的发出去了。

/// 那一行的名目（设置里那一行，也是那一屏的抬头）。
const String hearDrillTitle = '说一句试试';

/// 设置里那一行下面那句小字。
const String hearDrillRowHint = '先听懂你的意思，再问你一句；演练，不会真的发出去。';

/// 那一屏最上面那句（**红字那块**：先把"不会发出去"说清）。
const String hearDrillBanner = '这是演练：一句都不会发出去，也不会打扰到谁。';

/// 待命：还没开始说。
const String hearDrillIdleLead = '按一下下面那颗，说一句试试。';

/// 正在听。
const String hearDrillListeningLead = '我在听，说完按一下停。';

/// 🔴 **他按了停、正在等最后那一份字**（2026-10-05 加的）。
///
/// ⚠️ 这一句是**给他一个即时回应**的：主人报*"点击停止录音响应很慢"* ——
///    原来按停之后屏幕上那一秒多**一个字都不变**（看起来就是没反应）。
///    它**只在这一档说**，`asr/end` 一到就换成"我在听懂你这句……"。
const String hearDrillWrappingLead = '收下了，正在整理……';

/// 正在听懂（那一下很短）。
const String hearDrillThinkingLead = '我在听懂你这句……';

/// 它在问一句（**问的话在下面**）。
const String hearDrillAskingLead = '我有一处不确定，你答一句就行：';

/// 差不多了，这是最终那一份。
const String hearDrillReadyLead = '我听到的是这一句 —— 真的时候，到这儿就发出去：';

/// 最后那一步**在演练里不会发生**（说清）。
const String hearDrillReadyFoot = '（演练：就停在这儿，不会发出去。）';

/// 一轮一答之后都顺了，也没有别的要问。
const String hearDrillOkFoot = '这一句我觉得可以了。';

/// 问了两轮还没问完 ⇒ 按已经听懂的那份走（不吹毛求疵，但如实说）。
const String hearDrillRoundCap = '问得够多了，就按我听懂的这份来。';

/// 没听懂 / 那边没答上来。
const String hearDrillFailedLead = '这句我没听清，你再说一遍。';

/// 一个字都没听到。
const String hearDrillNothing = '我什么都没听到，再说一句吧。';

/// 这台念不出来（老老实实说 —— 不许假装会说话）。
const String hearDrillNoVoice = '这台还念不出来，我写成字问你。';

/// 这台开不了麦 ⇒ 给它一个"打字"的兜底（屏幕上不许出现按不动的东西）。
const String hearDrillTypeInstead = '这台开不了麦，先打字试试。';

/// 再走一遍。
const String hearDrillAgain = '再来一句';

/// 把听到的那句**送进听懂那一层**失败了（网/那边）。
const String hearDrillNoRoad = '这条现在还接不上，等下再试。';

/// 「我答一句」那颗按钮的字（打字兜底那条路）。
const String hearDrillAnswer = '就这句';

/// 最终那一份的抬头（他看得见的那一份原话）。
const String hearDrillHeardLabel = '我听成的是：';

/// 那颗圆圈的读屏名（没在录时）。
const String hearDrillTalkLabel = '说一句';

/// 那颗圆圈的读屏名（正在录时）。
const String hearDrillStopLabel = '说完了';

/// ★ 它在问的时候，圆圈旁边那半句"怎么答"（2026-10-04 主人报"只出来了问句，就没有然后"）：
/// 他得知道**按一下那颗圆圈、答一句就行**。
const String hearDrillAnswerHint = '（按一下圆圈，答一句就行）';
