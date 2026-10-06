// **"说一句试试"那一屏的话**（V2.0 第一件 · 主人 2026-10-04）。
//
// ⚠️ 一处出处：这些话只住在这儿（禁用词那一套：不许出现内部词）。
// ⚠️ 它**不是**聊天那条路的话 —— 那一屏是**演练**（一句都不会发出去），
//    所以每一句都带"演练"这个意思，别让他以为真的发出去了。

/// 那一行的名目（设置里那一行，也是那一屏的抬头）。
const String hearDrillTitle = '说一句试试';

/// 设置里那一行下面那句小字。
const String hearDrillRowHint = '把你说的话听成字；演练，不会真的发出去。';

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

/// 差不多了，这是最终那一份。
const String hearDrillReadyLead = '我听到的是这一句 —— 真的时候，到这儿就发出去：';

/// 最后那一步**在演练里不会发生**（说清）。
const String hearDrillReadyFoot = '（演练：就停在这儿，不会发出去。）';

/// 没听懂 / 那边没答上来。
const String hearDrillFailedLead = '这句我没听清，你再说一遍。';

/// 一个字都没听到。
const String hearDrillNothing = '我什么都没听到，再说一句吧。';

/// 这台开不了麦 ⇒ 给它一个"打字"的兜底（屏幕上不许出现按不动的东西）。
const String hearDrillTypeInstead = '这台开不了麦，先打字试试。';

/// 再走一遍。
const String hearDrillAgain = '再来一句';

/// 「我答一句」那颗按钮的字（打字兜底那条路）。
const String hearDrillAnswer = '就这句';

/// 最终那一份的抬头（他看得见的那一份原话）。
const String hearDrillHeardLabel = '我听成的是：';

/// 那颗圆圈的读屏名（没在录时）。
const String hearDrillTalkLabel = '说一句';

/// 那颗圆圈的读屏名（正在录时）。
const String hearDrillStopLabel = '说完了';
