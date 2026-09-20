// 过程状态的人话表。手册 §12.4 第 6 条人格硬规则「不许提内部词」+ N10「沉默优于编造」。
//
// 为什么这个也要进硬闸：它输出的是**用户会看到的字**。
// 内部词漏出去、或者把 `null` 渲染成 "null"，都是**界面上说了假话**那一类。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/process_words.dart';

void main() {
  group('过程状态的人话表', () {
    test('🔴 每一句都不许含禁用词（工作区 / 连接 / 客户端 / 工具名…）', () {
      for (final e in processWords.entries) {
        final hits = scanForbidden(e.value);
        expect(hits, isEmpty, reason: '「${e.key}」翻出来的话里有禁用词：$hits');
      }
      expect(scanForbidden(busyFallback), isEmpty);
    });

    test('每一句都要**说清是谁在做**，而且不许是内部状态名本身', () {
      for (final e in processWords.entries) {
        expect(e.value.trim(), isNotEmpty, reason: '「${e.key}」翻成了空');
        expect(e.value, isNot(equals(e.key)),
            reason: '「${e.key}」直接把它自己当人话用了 —— 那是内部词');
        expect(e.value.length, lessThanOrEqualTo(20),
            reason: '「${e.key}」那句太长了（${e.value.length} 字），一行放不下');
      }
    });

    test('★ 服务端给的那个状态名认得出来（两边要对得上）', () {
      // ⚠️ 这条把**两端用同一个 token**这件事钉住：
      //    服务端 `dispatcher.js` 的 `#announceTurn()` 发的就是 `'started'`。
      expect(processWord('started'), isNotNull);
    });

    test('★ 认不出来 ⇒ null（**不许猜、不许显示内部词**）', () {
      expect(processWord('working'), isNull);
      expect(processWord('handoff'), isNull);
      expect(processWord('随便什么'), isNull);
      expect(processWord(null), isNull);
      expect(processWord(''), isNull);
    });

    test('兜底那句也在表里（重连之后靠它）', () {
      expect(processWords.values, contains(busyFallback));
    });
  });
}
