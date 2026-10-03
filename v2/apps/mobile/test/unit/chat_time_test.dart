// 时间那一行（契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.1）。
//
// 这一份钉三件事：
//   ① **什么时候插**（跨天 / 隔得够久 / 头一条）—— 密了就是"表"，稀了分不清"刚才"和"一小时前"；
//   ② **写什么**（今天 / 昨天 / 月日 / 年月日 ＋ HH:MM）；
//   ③ 🔴 **不知道就不画**（`at` 读不到 ⇒ false）—— 编一个时间是 N10 禁止的那种假话。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/chat_time.dart';
import 'package:hupo_app/models/chat_time_words.dart';

int _ms(int y, int mo, int d, int h, int mi) =>
    DateTime(y, mo, d, h, mi).millisecondsSinceEpoch;

void main() {
  final now = _ms(2026, 10, 2, 21, 0);

  group('什么时候插那一行', () {
    test('★ 头一条要插（不然整屏没有一处时间）', () {
      expect(needsTimeMark(prevAt: null, at: now, now: now), true);
    });

    test('🔴 读不到时间 ⇒ **不画**（不许编一个）', () {
      expect(needsTimeMark(prevAt: null, at: null, now: now), false);
      expect(needsTimeMark(prevAt: now, at: null, now: now), false);
    });

    test('同一天里挨得近 ⇒ 不插（每两条都插就成了一张表）', () {
      final a = _ms(2026, 10, 2, 20, 50);
      final b = _ms(2026, 10, 2, 20, 55);
      expect(needsTimeMark(prevAt: a, at: b, now: now), false);
    });

    test('同一天里隔得够久 ⇒ 再插一次', () {
      final a = _ms(2026, 10, 2, 20, 0);
      final b = a + timeMarkGapMs;
      expect(needsTimeMark(prevAt: a, at: b, now: now), true, reason: '正好到点了');
      expect(needsTimeMark(prevAt: a, at: b - 1, now: now), false, reason: '差一毫秒还没到');
    });

    test('★ 跨天 ⇒ 一定插（哪怕只隔了一分钟）', () {
      final a = _ms(2026, 10, 1, 23, 59);
      final b = _ms(2026, 10, 2, 0, 0);
      expect(needsTimeMark(prevAt: a, at: b, now: now), true);
    });

    test('sameDay 只认日历日（同一天的凌晨与深夜算一天）', () {
      expect(sameDay(_ms(2026, 10, 2, 0, 0), _ms(2026, 10, 2, 23, 59)), true);
      expect(sameDay(_ms(2026, 10, 2, 23, 59), _ms(2026, 10, 3, 0, 0)), false);
    });
  });

  group('那一行写什么', () {
    test('HH:MM 一律补零', () {
      expect(clockLabel(_ms(2026, 10, 2, 9, 5)), '09:05');
      expect(clockLabel(_ms(2026, 10, 2, 14, 32)), '14:32');
      expect(clockLabel(_ms(2026, 10, 2, 0, 0)), '00:00');
    });

    test('今天 / 昨天 / 今年别的日子 / 往年 —— 四档都要分得清', () {
      expect(timeMarkLabel(_ms(2026, 10, 2, 14, 32), now: now), '$timeMarkToday 14:32');
      expect(timeMarkLabel(_ms(2026, 10, 1, 9, 5), now: now), '$timeMarkYesterday 09:05');
      expect(timeMarkLabel(_ms(2026, 3, 8, 7, 0), now: now), '3月8日 07:00');
      expect(timeMarkLabel(_ms(2025, 12, 31, 23, 30), now: now), '2025年12月31日 23:30');
    });

    test('🔴 跨月跨年的"昨天"仍然说昨天（不是拿日期减一天那种算法）', () {
      final firstOfMonth = _ms(2026, 11, 1, 10, 0);
      expect(
        timeMarkLabel(_ms(2026, 10, 31, 22, 0), now: firstOfMonth),
        '$timeMarkYesterday 22:00',
      );
      final newYear = _ms(2027, 1, 1, 1, 0);
      expect(
        timeMarkLabel(_ms(2026, 12, 31, 23, 0), now: newYear),
        '$timeMarkYesterday 23:00',
      );
    });
  });
}
