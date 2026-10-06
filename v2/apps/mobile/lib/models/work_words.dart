// 「清单」那一张浮窗的**全部文案**（主人 2026-10-06 要的那一件）。
//
// 主人原话：*「我觉得应该在左下角有一个清单按钮，点击会出来浮窗，
//   浮窗里有正在干活的聊天的列表。」*
//
// ⚠️ 为什么单放一个 models 文件、不写在界面里：摆在 `widgets/` 里的字符串
//    **禁用词硬闸够不着**（`test/unit/forbidden_words_test.dart` 扫的是这份表）
//    —— 和 `desktop_words.dart` / `trash_words.dart` 同一条理由。
//
// 🔴 这一份的几条边界：
//   · **不许出现内部词**：`scope` / 工作区 / 会话 / 调度器 / 工具名 一个都不许上屏；
//   · **不许编**：一间认不出名字的活**照实说"另一个对话"**，绝不把那串内部 id 摆出来；
//   · **成没成都如实说**：问不上就是"没问上"（一句"没有在干的活"会是**假话**）。
//
// ⚠️ 纯数据，**不许 import flutter/material**（楼层闸 `test/unit/import_rules_test.dart`）。

/// 左下角那颗按钮上挂着的那两个字（**逐字就是主人说的那个词**）。
const String workButtonLabel = '清单';

/// 那颗按钮的悬停/读屏那句（图形按钮没有可见的字 —— 与另外三颗同一套做法）。
const String workButtonHint = '正在干的活';

/// 那张浮窗的抬头。
const String workPanelTitle = '正在干的活';

/// 关上它（浮窗右上角那颗）。
const String workCloseWords = '关上';

/// 一行里那句"它现在是什么状态"。
const String workBusyLabel = '在干活';

/// 一行里那句"干了多久"的前半截（后面跟数字与单位）。
const String workAgeDoing = '干了';

/// 刚开工（不到一分钟）—— 报"干了 0 分钟"是句笨话。
const String workAgeJustNow = '刚开始';

const String workAgeMinute = '分钟';
const String workAgeHour = '小时';
const String workAgeDay = '天';

/// 同一个房间里**不止一件**在干时那一个量词（前面跟数字）。
const String workCountUnit = '件';

/// 一行里那几小段之间的分隔（`在干活 · 3 件 · 干了 2 分钟`）。
const String workPartSep = ' · ';

/// 一行点下去会做什么（悬停/读屏那一句）。
const String workRowHint = '去看看';

/// 一间**认不出名字**的房间（服务端没给名字、壳里也没这一格）——
/// **照实说"另一个对话"**，绝不把内部那串 id 摆到屏幕上。
const String workNamelessName = '另一个对话';

/// 一张活都没有。
const String workEmptyWords = '现在没有在干的活';

/// 头一次去问、还没回来。
const String workLoadingWords = '稍等一下';

/// 🔴 **没问上**（网不通 / 服务端没回 / 回执读不出来）——
///    这时候说"没有在干的活"就是**假话**（清单看不见 ≠ 没活在干）⇒ 单独一句。
const String workFailWords = '没问上，过一会儿再看';
