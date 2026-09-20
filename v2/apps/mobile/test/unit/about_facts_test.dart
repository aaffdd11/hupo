// 「关于」页那几句话。手册 **D3.3**（v1.1 修订）· **D3.4** · `01-PROJECT.md` ★2/★4/★5。
//
// ⚠️ 为什么文案要进硬闸：这一页的每句话都是**对用户的事实陈述**。
//    它写错一个字，就是"页面在说假话"那一类事故
//    （手册记过三起，其中一起就是一句本来诚实的话**在前提变了之后变成了另一种谎言**）。
//
// ⚠️ 特别要钉住的是 **D3.3**：**不许一刀切**。
//    写"不会拼音的人用不了"在**带语音输入的设备上是假话**，
//    而且会**劝退一个其实能用的人**。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/about_facts.dart';
import 'package:hupo_app/models/forbidden_words.dart';

String allText() =>
    aboutFacts.expand((f) => [f.title, ...f.lines]).join('\n');

void main() {
  group('「关于」页', () {
    test('🔴 每一句都不许含禁用词（工作区 / 连接 / 工具 / 正在听…）', () {
      for (final f in aboutFacts) {
        for (final line in [f.title, ...f.lines]) {
          final hits = scanForbidden(line);
          expect(hits, isEmpty, reason: '「$line」里有禁用词：$hits');
        }
      }
    });

    test('🔴 D3.3：语音那条要**按设备说**，而且要说得保守', () {
      final t = allText();
      expect(
        t.contains('取决于') && t.contains('输入法'),
        isTrue,
        reason: '★ 必须说清"能不能用嘴说取决于你这台设备的输入法" —— 这是 D3.3 的核心',
      );
      // 保守那一半：告诉他**怎么判断**（有麦克风就能用）
      expect(t.contains('麦克风'), isTrue, reason: '要给出他能自己核对的判据');
      // 而且要明说我们没有自己的话筒（否则他会去找一个不存在的按钮）
      expect(t.contains('话筒'), isTrue);
    });

    test('🔴 D3.3：**不许一刀切** —— 一个字的"用不了"都不许有', () {
      final t = allText();
      for (final bad in ['用不了', '不能语音', '不支持语音', '打不了字', '不会拼音']) {
        expect(
          t.contains(bad),
          isFalse,
          reason: '「$bad」是一刀切 —— 在带语音输入的设备上那是**假话**，'
              '而且会劝退一个其实能用的人（D3.3 v1.1 修订）',
        );
      }
    });

    test('🔴 别撒谎：不许"全都记得"、不许"什么都能干"、不许"不会出错"', () {
      final t = allText();
      for (final bad in ['全都记得', '什么都记得', '什么都能', '不会出错', '绝对准确', '一定能']) {
        expect(t.contains(bad), isFalse, reason: '「$bad」是做不到的承诺');
      }
      // 记忆那一条要说"不多"，而且要和实现里的额度对得上（最近几十句）
      expect(t.contains('几十句'), isTrue, reason: '记忆的边界要说清（★2：黑盒记忆＝默认没记住）');
      expect(t.contains('不知道'), isTrue, reason: '要写明"没看到就说不知道"');
    });

    test('D2.1：**不许提"它能改自己的代码"**（实测：那会让人害怕）', () {
      final t = allText();
      for (final bad in ['改自己', '改它的代码', '它自己的代码', '修改自己']) {
        expect(t.contains(bad), isFalse, reason: 'D2.1：这一页提它只会让人怕');
      }
    });

    test('不摆跟用户无关的东西（版本号 / 许可 / 感谢使用）', () {
      final t = allText();
      for (final bad in ['版本', '许可', '开源', '感谢使用', '版权']) {
        expect(t.contains(bad), isFalse, reason: '「$bad」对用户没用 —— 这一页只放跟他有关系的');
      }
      expect(aboutFacts, isNotEmpty);
      for (final f in aboutFacts) {
        expect(f.lines, isNotEmpty, reason: '「${f.title}」下面一句都没有');
        for (final l in f.lines) {
          expect(l.trim(), isNotEmpty);
          expect(l.length, lessThanOrEqualTo(40), reason: '这一句太长了：$l');
        }
      }
    });
  });
}
