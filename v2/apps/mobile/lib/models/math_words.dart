// 「奥数题」那个小程序**全部文案**（契约 `docs/dev/57-MATH.md`）。
//
// ⚠️ 为什么单独一个文件：这一屏每一句都要过**禁用词硬闸**（同 `landing_words.dart` 那几份）。
// ⚠️ 纯数据，不 import flutter。
//
// 主人 2026-09-22 选了 **A：内置一份题库**（助手做不到给它加小程序 —— 界面是编译进客户端的）。

/// 桌面上那个图标上的字（也是它的 tooltip）。
const String mathAppLabel = '奥数题';

/// 小程序容器顶栏的标题。
const String mathTitle = '四年级奥数题';

/// 一屏上的三个动作/小标。
const String mathShowAnswer = '看答案';
const String mathNext = '换一题';
const String mathAnswerLabel = '答案';
const String mathWhyLabel = '为什么';

/// 进度那一行（"第 3 题 · 共 40 题"）。
/// ⚠️ 这不是"系统编号"（D1.4 禁的是拿编号当名字），是**他自己知道的进度**。
String mathProgress(int index, int total) => '第 ${index + 1} 题 · 共 $total 题';
