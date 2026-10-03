// 时间那一行的人话（契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.1）。
//
// ⚠️ **界面上的字只许住 `*_words.dart`**：那样才进得了禁用词硬闸
//    （`test/unit/forbidden_words_test.dart` 扫的就是这些常量）。
//    逻辑住在 `chat_time.dart`，它 import 这一份。

/// 「今天」——同一个日历日。
const String timeMarkToday = '今天';

/// 「昨天」。
const String timeMarkYesterday = '昨天';
