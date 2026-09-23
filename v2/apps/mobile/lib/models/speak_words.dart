// "念出来"那几处说的字（主人 2026-09-23 定案 · 契约 `docs/dev/68-SPEAK.md`）。
//
// ⚠️ **界面上的字只有这一处**（D3.10）。**"读出来"**这个词是主人挑的
//    （原话里就是"听筒 / 读出来"），所以界面上一律用它，不用"朗读 / TTS / 语音合成"。
// ⚠️ 不许内部词（`07-APPENDIX.md` §2.2）。
// ⚠️ 用户是谁：他**看不清小字 / 打不了字**（`docs/ux/06-retiree.md`），
//    所以按钮是**几个字 + 图标**，不是一个小符号。

/// 每条回答下面那个按钮（这一次点它 ⇒ 念这一条）。
const String speakOnceWords = '读一遍';

/// 正在念这一条时，同一个按钮变成"停"。
const String speakStopWords = '别念了';

/// 自动念那个开关（打开之后，它**新说的话**会被念出来）。
const String speakAutoOnWords = '读出来';

/// 关着的时候。
const String speakAutoOffWords = '不读';

/// 开关的说明（tooltip 用；也是给看得见字的人读的）。
const String speakAutoHintOn = '它新说的话会念出来';
const String speakAutoHintOff = '它说的话不念出来';

/// ⚠️ 这一条是**实话**：念不了的时候（这个平台做不到）按钮**不画**，
///    但页面上要说清"为什么没有那个按钮" —— 不然用户会以为"它坏了"。
const String speakCannotWords = '这台设备上没法念出来。';
