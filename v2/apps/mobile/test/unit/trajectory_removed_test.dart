// **轨迹那一屏砍掉了 —— 负向对照：它不许回来。**
//
// 主人 2026-09-26 原话：*「聊天和轨迹有选项，我决定不要轨迹。」*
// ⇒ 轨迹那一屏、`聊天 / 轨迹` 那对 tab、它自己的模型/文案、那个按设备存的
//   视图选择（`hupo_chat_view`）**全部删掉**（`#173`；逐条账见
//   `docs/dev/118-TRAJECTORY-VIEW.md` 顶上那条横幅 ＋ `docs/dev/00-PROGRESS.md` §〇）。
//
// 这一份是**那条决定的闸**：`lib/` 里再出现那个入口（tab 上的字 / 路由名 /
// 那个视图的标识 / 那个偏好键）⇒ 当场红。屏幕那一侧在
// `test/widget/chat_header_test.dart`。
//
// ⚠️ **只看代码行**（整行注释与行尾注释都去掉）：说明文字里提到那段历史
//    **不算**"入口回来了"。理由与 `test/unit/mini_live_update_test.dart` 里
//    `codeOnly` 那段逐字相同 —— 把注释也算进去，闸就变成"注释里不许提历史"，
//    而真正的变异（把 `tab: '轨迹'` 加回来）照样绿。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 一份源码里的**代码行**（整行注释与行尾注释都去掉）。
String codeOnly(String src) => src
    .split('\n')
    .map((l) {
      final i = l.indexOf('//');
      return i < 0 ? l : l.substring(0, i);
    })
    .join('\n');

/// `lib/` 底下每一份 Dart 的**代码**（键 = 路径）。
Map<String, String> _libCode() => {
  for (final e in Directory('lib').listSync(recursive: true).whereType<File>())
    if (e.path.endsWith('.dart')) e.path: codeOnly(e.readAsStringSync()),
};

/// `lib/` 底下每一份**文件的名字**。
List<String> _libNames() => [
  for (final e in Directory('lib').listSync(recursive: true)) e.path,
];

void main() {
  test('★ 对照之对照：这份扫描**不是空转**（它找得到确实在的东西）', () {
    final code = _libCode();
    expect(code, isNotEmpty, reason: '一份源码都没扫到 ⇒ 下面几条都是空转');
    expect(
      code.entries.any((e) => e.value.contains('ChatController')),
      isTrue,
      reason: '★ 扫描器坏了（真在的东西都没找到）⇒ 它报"干净"没有意义',
    );
    // 而且 `codeOnly` 真的**去注释、留代码**
    expect(codeOnly("const String tab = '轨迹';").contains('轨迹'), isTrue);
    expect(codeOnly("// 历史：这里原来有 `轨迹` 那一档").contains('轨迹'), isFalse);
  });

  test('🔴 负向对照：`lib` 里再出现「轨迹」两个字（tab / 路由 / 标题）⇒ 红', () {
    final hits = <String>[
      for (final e in _libCode().entries)
        if (e.value.contains('轨迹')) e.key,
    ];
    expect(
      hits,
      isEmpty,
      reason:
          '主人 2026-09-26 已决定不要轨迹（`docs/dev/118` 顶上横幅）—— 这一档又回来了：$hits',
    );
  });

  test('🔴 负向对照：那个视图的标识（`trajectory` / `ChatView` / `ChatTabs`）一个都不许回来', () {
    // ⚠️ 按**小写**比，一次盖住几种写法：
    //    `trajectory` ← `TrajectoryView` / `trajectoryTableOf` / `trajectory_words.dart`
    //    `chatview`   ← `ChatView` / `chat_view.dart` / `ChatViewStore`
    //    `chattab`    ← `ChatTabs` / `chatTabKey`
    for (final needle in const ['trajectory', 'chatview', 'chattab']) {
      final hits = <String>[
        for (final e in _libCode().entries)
          if (e.value.toLowerCase().contains(needle)) e.key,
      ];
      expect(
        hits,
        isEmpty,
        reason: '「$needle」是那个视图专属的标识，不该留在 `lib`：$hits',
      );
      final named = _libNames().where((p) => p.toLowerCase().contains(needle));
      expect(named, isEmpty, reason: '那个视图的文件又回来了：$named');
    }
  });

  test('🔴 负向对照：那个按设备存的偏好键（`hupo_chat_view`）不许回来', () {
    // ⚠️ 键名是**盘上的字符串**：留着它 = 又开始往盘上写一个没人读的偏好。
    for (final e in _libCode().entries) {
      expect(
        e.value.contains('hupo_chat_view'),
        isFalse,
        reason: '${e.key} 里还有那个偏好键 —— 视图选择已经跟着轨迹一起砍了',
      );
    }
  });
}
