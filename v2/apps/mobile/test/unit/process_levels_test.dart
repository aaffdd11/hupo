// 过程四档（手册 D7 / 契约 `docs/dev/26-PROCESS-LEVELS.md` §三）。
//
// ⚠️ 这一份钉两件事：
//   1. **协议那一半**：四个 token 就是两边约定的那四个（写错了服务端当默认档，
//      而屏幕上不会有任何异常——那正是最难查的一类）。
//   2. **文案那一半**：四档的名字与解释是**用户会看到的字** ⇒ 过禁用词闸。
//      （`forbidden_words_test.dart` 里还有一条"我们实际用的文案"，
//      这里再逐条扫一遍，两条互为对照。）

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/process_levels.dart';

void main() {
  group('四档', () {
    test('★ 就是契约里的那四个（顺序也照 D7 原文）', () {
      expect(
        ProcessLevel.values.map((l) => l.wire).toList(),
        ['quiet', 'doing', 'steps', 'reasoning'],
      );
    });

    test('🔴 默认档是 `doing`（"在做什么"）', () {
      expect(defaultProcessLevel, ProcessLevel.doing);
      expect(processLevelOf(null), ProcessLevel.doing);
    });

    test('★ 认 token：四个都认得出来', () {
      for (final l in ProcessLevel.values) {
        expect(processLevelOf(l.wire), l);
      }
    });

    test('🔴 认不出来 / 坏值 ⇒ 默认档，**绝不抛**', () {
      // 这一条的输入来自本机存的那个字符串：可能是旧版本写的、
      // 也可能被改坏了。坏掉的后果只许是"回到默认档"。
      for (final bad in <Object?>[null, '', 'QUIET', 'loud', 42, true, 'doings']) {
        expect(processLevelOf(bad), defaultProcessLevel, reason: '「$bad」不该被认出来');
      }
    });

    test('每一档都有名字和一句解释（界面上不能是一个光秃秃的 token）', () {
      for (final l in ProcessLevel.values) {
        expect(l.title.trim(), isNotEmpty, reason: '${l.wire} 没名字');
        expect(l.hint.trim(), isNotEmpty, reason: '${l.wire} 没解释');
      }
    });

    test('🔴 四档的文案都不许含禁用词', () {
      for (final l in ProcessLevel.values) {
        expect(scanForbidden(l.title), isEmpty, reason: '「${l.title}」里有禁用词');
        expect(scanForbidden(l.hint), isEmpty, reason: '「${l.hint}」里有禁用词');
      }
    });

    test('🔴 D7.4：推理原文那一档必须**说清是主人自己看**（默认关）', () {
      // 它可能含我们这边的原话（产品资产）⇒ 界面上得让主人知道
      // "这一档是他自己开的"，而不是一个看不出轻重的选项。
      final r = ProcessLevel.reasoning;
      expect(r.wire, 'reasoning');
      // 默认档不是它（默认关）
      expect(defaultProcessLevel, isNot(r));
    });
  });
}
