// 「桌面图标 ⇒ 从桌面上删掉」这句**话**的两条硬闸
// （契约 `docs/dev/103-APP-DELETE.md` §三 / §四 判据 C3、C4）。
//
// ⚠️ 这一份扫的是**那份措辞表本身**（`models/desktop_words.dart`）——
//    摆在界面里的字符串禁用词硬闸够不着（同 `trash_words.dart` 顶上那条理由）。
// ⚠️ 界面那一半在 `test/widget/desktop_remove_test.dart`（长按/右键/发请求/失败如实说），
//    五档不溢出 + 命中区 ≥44 在 `test/widget/accessibility_test.dart`（C5）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/desktop_words.dart';
import 'package:hupo_app/models/forbidden_words.dart';

/// 那份表的源码路径（**只有这一处**，免得两处路径漂）。
const _tablePath = 'lib/models/desktop_words.dart';

/// 从源码里抠出**所有会显示给用户的字符串字面量**。
///
/// ⚠️ **先去掉行注释**：注释里可以、而且**必须**写清"为什么不许说可恢复"
///    ——把那句话也算成文案的话，这条闸会连"解释"一起禁掉（那就没人敢写清楚了）。
///    ⇒ 扫的是**字面量**，不是整份文件。
List<String> _literals() {
  final src = File(_tablePath).readAsStringSync();
  final buf = StringBuffer();
  for (final line in src.split('\n')) {
    final cut = line.indexOf('//');
    buf.writeln(cut >= 0 ? line.substring(0, cut) : line);
  }
  return RegExp(r"'([^']*)'")
      .allMatches(buf.toString())
      .map((m) => m.group(1)!)
      .toList();
}

/// 契约 §三点名的那两句（面板上**只有**这两句）。
const _internalWords = ['app', '小程序', '工作区', '卸载', 'id'];

/// "还能拿回来 / 可恢复"那一类**假承诺**的说法（契约 §三 / C4）。
const _falsePromises = ['拿回来', '拿得回来', '可恢复', '恢复', '找回来'];

void main() {
  test('C3：那份表真的被扫到了（**负向对照** —— 抠不出来 = 闸在空转）', () {
    final lits = _literals();
    expect(lits.length, greaterThanOrEqualTo(4), reason: '抠出来的字面量太少，扫描是空转的');
    // 面板上那两句必须在里面（在的话下面两条才真的扫到了它们）
    expect(lits, contains(desktopRemoveAction));
    expect(lits, contains(desktopRemoveCancel));
  });

  test('C3：面板上那两句就是契约点名的那两句（主句 + 取消）', () {
    expect(desktopRemoveAction, '从桌面上删掉');
    expect(desktopRemoveCancel, '取消');
  });

  test('C3：整份表逐条过**禁用词硬闸**（`scanForbidden`）', () {
    for (final s in _literals()) {
      final hits = scanForbidden(s);
      expect(hits, isEmpty, reason: '「$s」里有禁用词：$hits');
    }
  });

  test('C3：内部词一个都不许上屏（app / 小程序 / 工作区 / 卸载 / id）', () {
    for (final s in _literals()) {
      for (final w in _internalWords) {
        expect(
          s.toLowerCase().contains(w),
          isFalse,
          reason: '「$s」里有内部词「$w」—— 用户看到的只是"桌面上这一格"，'
              '工程词不许上屏（契约 §三，这是缺陷不是文风问题）',
        );
      }
    }
  });

  test('C4：🔴 表里一句"还能拿回来 / 可恢复"都不许有', () {
    // 为什么这条值得单独一条闸：服务端那条路确实是**软删**（挪进 `.removed/`），
    // 但**今天没有任何一处能把它列出来、也没有拿回来的入口** ⇒
    // 屏幕上写"可恢复"就是**假话**（契约 §三）。要做就得先把入口做出来。
    for (final s in _literals()) {
      for (final w in _falsePromises) {
        expect(
          s.contains(w),
          isFalse,
          reason: '「$s」承诺了「$w」—— 今天没有拿回来的入口，写了就是假话（C4）',
        );
      }
    }
  });

  test('C4：负向对照 —— 这条扫描**真的抓得住**那些假承诺', () {
    for (final bad in ['还能拿回来', '随时可以恢复', '回头能找回来']) {
      expect(
        _falsePromises.any(bad.contains),
        isTrue,
        reason: '「$bad」这种形状没有被任何一条禁词覆盖 —— 闸漏了它',
      );
    }
  });
}
