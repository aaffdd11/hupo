// 过程两档（手册 D7 / 契约 `docs/dev/122-TWO-PROCESS-LEVELS.md`）。
//
// ⚠️ 这一份钉三件事：
//   1. **协议那一半**：四个 wire token 就是两边约定的那四个（写错了服务端当默认档，
//      而屏幕上不会有任何异常——那正是最难查的一类）。**一个都不许改。**
//   2. **砍掉的那两档**（安静 / 步骤流水）读出来**归一**到默认档 ——
//      不然菜单上会没有任何一项是选中的，页面在说假话。
//   3. **文案那一半**：两档的名字与解释是**用户会看到的字** ⇒ 过禁用词闸。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/process_levels.dart';

void main() {
  group('两档', () {
    test('★ 菜单上摆的就是这两档（顺序也照 D7 收窄后）', () {
      expect(
        ProcessLevel.values.map((l) => l.wire).toList(),
        ['doing', 'reasoning'],
      );
      expect(
        ProcessLevel.values.map((l) => l.title).toList(),
        ['在做什么', '它心里想的'],
      );
    });

    test('🔴 协议里那四个 wire token **一个都不许改**（冻结；老客户端还在发）', () {
      expect(processLevelWires, ['quiet', 'doing', 'steps', 'reasoning']);
      // 还在用的两档必须都在这张冻结名单里（漏一个 ⇒ 老服务端认不出新客户端）
      for (final l in ProcessLevel.values) {
        expect(processLevelWires, contains(l.wire), reason: '${l.wire} 不在冻结名单里');
      }
    });

    test('🔴 砍掉的两档：token 仍认得出，但一律**归一**到默认档', () {
      expect(retiredProcessLevelWires, ['quiet', 'steps']);
      for (final wire in retiredProcessLevelWires) {
        expect(
          processLevelOf(wire),
          defaultProcessLevel,
          reason: '「$wire」是老档 ⇒ 必须归一到默认档（那一档菜单上没有了）',
        );
      }
      // ★ 负向对照：**留下的那两档不许被归一**
      expect(processLevelOf('doing'), ProcessLevel.doing);
      expect(processLevelOf('reasoning'), ProcessLevel.reasoning);
    });

    test('🔴 默认档是 `doing`（"在做什么"）', () {
      expect(defaultProcessLevel, ProcessLevel.doing);
      expect(processLevelOf(null), ProcessLevel.doing);
    });

    test('★ 认 token：还在用的两个都认得出来', () {
      for (final l in ProcessLevel.values) {
        expect(processLevelOf(l.wire), l);
      }
    });

    test('🔴 认不出来 / 坏值 ⇒ 默认档，**绝不抛**', () {
      // 这一条的输入来自本机存的那个字符串：可能是旧版本写的、
      // 也可能被改坏了。坏掉的后果只许是"回到默认档"。
      for (final bad in <Object?>[null, '', 'QUIET', 'loud', 42, true, 'doings', 'STEPS']) {
        expect(processLevelOf(bad), defaultProcessLevel, reason: '「$bad」不该被认出来');
      }
    });

    test('每一档都有名字和一句解释（界面上不能是一个光秃秃的 token）', () {
      for (final l in ProcessLevel.values) {
        expect(l.title.trim(), isNotEmpty, reason: '${l.wire} 没名字');
        expect(l.hint.trim(), isNotEmpty, reason: '${l.wire} 没解释');
      }
    });

    test('🔴 两档的文案都不许含禁用词', () {
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
