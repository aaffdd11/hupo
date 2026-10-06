// **「正在干的活」那张清单**（主人 2026-10-06 · 契约 `docs/dev/198-WORK-LIST.md`）。
//
// 这一份钉四件（每件都带反例）：
//   ① 🔴 **"没问上"与"一件活都没有"分得开**（`null` vs 空表）—— 混了就是假话；
//   ② 🔴 **认不出名字的房间绝不把那串内部 id 摆上屏**（说"另一个对话"）；
//   ③ 🔴 时长**读不到就不报**（不报 0）；不到一分钟说"刚开始"；
//   ④ 🔴 读不懂的那一行**跳过它**，不许把整张清单弄空。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/app_spec.dart';
import 'package:hupo_app/models/app_words.dart';
import 'package:hupo_app/models/harness_words.dart';
import 'package:hupo_app/models/landing_words.dart';
import 'package:hupo_app/models/scope.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/work_list.dart';
import 'package:hupo_app/models/work_words.dart';

/// 一个服务器会回的整数毫秒（判据里的"现在"）。
const int _now = 1770000000000;

WorkingRow _row({
  String scope = 'abc',
  String? title,
  int? since,
  int count = 1,
}) => WorkingRow(scope: scope, title: title, since: since, count: count);

void main() {
  test('① 🔴 "没问上"与"一件都没有"是两件事（`null` vs 空表）', () {
    // 问上了、真的一件都没有
    expect(parseWorkingList({'ok': true, 'working': []}), isNotNull);
    expect(parseWorkingList({'ok': true, 'working': []})!.isEmpty, isTrue);
    // 没问上：读不懂 / 缺字段 / 不是那一份回执 —— 一律 `null`
    expect(parseWorkingList(null), isNull);
    expect(parseWorkingList('不是 JSON 对象'), isNull);
    expect(parseWorkingList({'ok': false}), isNull);
    expect(parseWorkingList({'working': '不是数组'}), isNull);
    // 反例：空表**不许**被当成"没问上"（那会让界面一直说"没问上"）
    expect(parseWorkingList({'working': []}) == null, isFalse);
  });

  test('① 读一行：读不懂的那一条跳过，别的照旧（不许整张弄空）', () {
    final got = parseWorkingList({
      'working': [
        {'scope': 'one', 'title': '记账', 'since': 1000, 'count': 2},
        '这不是一行', // 跳过
        {'title': '没有 scope'}, // 跳过
        {'scope': '   '}, // 空 scope 跳过
        {'scope': 'two'}, // 缺 title/count/since ⇒ 照收（1 件、没时长）
      ],
    });
    expect(got, isNotNull);
    expect(got!.length, 2, reason: '两条读得懂、三条读不懂');
    expect(got[0].scope, 'one');
    expect(got[0].title, '记账');
    expect(got[0].since, 1000);
    expect(got[0].count, 2);
    expect(got[1].scope, 'two');
    expect(got[1].title, isNull, reason: '没给名字就是没给（别编）');
    expect(got[1].since, isNull);
    expect(got[1].count, 1, reason: '件数缺省是 1');
  });

  test('① 一行里的脏值也守住：count < 1 ⇒ 1；空名字 ⇒ null；非数字的 since ⇒ null', () {
    final a = WorkingRow.parse({'scope': 'x', 'title': '   ', 'count': 0});
    expect(a!.title, isNull, reason: '全是空格的名字等于没名字');
    expect(a.count, 1);
    final b = WorkingRow.parse({'scope': 'y', 'since': '昨天'});
    expect(b!.since, isNull, reason: '读不出来的时间不许编一个出来');
    final c = WorkingRow.parse({'scope': 'z', 'count': -3});
    expect(c!.count, 1);
  });

  test('② 🔴 名字：认得出来的说人话，认不出的**绝不把那串内部 id 摆上屏**', () {
    // ① 服务端给的名字最优先
    expect(
      workRowName(scope: 'abc', title: '记账', mine: {'abc': '壳里那个名字'}),
      '记账',
    );
    // ② 服务端没给 ⇒ 壳里那份清单补位
    expect(workRowName(scope: 'abc', mine: {'abc': '记账'}), '记账');
    // ③ 内置那三格各自有词（它们不在"我的清单"里）
    expect(workRowName(scope: builtInSettingsId), settingsAppLabel);
    expect(workRowName(scope: builtInDiscoverId), discoverAppLabel);
    expect(workRowName(scope: builtInHarnessId), harnessAppLabel);
    // ④ 主对话 ⇒ 与窗口抬头同一句
    expect(workRowName(scope: mainScope), appName);
    // ⑤ 都认不出 ⇒ 通用那句
    const weird = 'a7f3c9e1-內部id';
    final name = workRowName(scope: weird);
    expect(name, workNamelessName);
    // 🔴 反例：那串 id **一个字都不许**出现在屏幕上
    expect(name.contains(weird), isFalse);
    expect(name.contains('a7f3'), isFalse);
    // 🔴 反例：给它一个名字，就不该再退到通用那句
    expect(workRowName(scope: weird, mine: {weird: '记账'}), '记账');
  });

  test('③ 🔴 时长：读不到就不报；不到一分钟说"刚开始"（不报 0 分钟）', () {
    expect(workAgeLabel(null, now: _now), isNull, reason: '读不到就不说 —— 不许编');
    expect(
      workAgeLabel(_now + 5000, now: _now),
      isNull,
      reason: '时钟倒着走（起点在未来）⇒ 不知道就不说',
    );
    expect(workAgeLabel(_now, now: _now), workAgeJustNow);
    expect(workAgeLabel(_now - 30 * 1000, now: _now), workAgeJustNow);
    expect(workAgeLabel(_now - 60 * 1000, now: _now), '干了 1 分钟');
    expect(workAgeLabel(_now - 59 * 60 * 1000, now: _now), '干了 59 分钟');
    expect(workAgeLabel(_now - 60 * 60 * 1000, now: _now), '干了 1 小时');
    expect(workAgeLabel(_now - 23 * 60 * 60 * 1000, now: _now), '干了 23 小时');
    expect(workAgeLabel(_now - 24 * 60 * 60 * 1000, now: _now), '干了 1 天');
    expect(workAgeLabel(_now - 5 * 24 * 60 * 60 * 1000, now: _now), '干了 5 天');
    // 🔴 反例：一分钟以内**不许**说"干了 0 分钟"
    expect(workAgeLabel(_now - 1000, now: _now)!.contains('0 '), isFalse);
  });

  test('③ 底下那一句：件数只在不止一件时才说', () {
    final one = _row(since: _now - 2 * 60 * 1000);
    expect(workRowSubtitle(one, now: _now), '$workBusyLabel$workPartSep干了 2 分钟');
    final many = _row(since: _now - 2 * 60 * 1000, count: 3);
    expect(
      workRowSubtitle(many, now: _now),
      '$workBusyLabel$workPartSep${3} $workCountUnit$workPartSep干了 2 分钟',
    );
    // 读不到时长 ⇒ 那一小段直接不出现（不是留个空段）
    final noTime = _row();
    expect(workRowSubtitle(noTime, now: _now), workBusyLabel);
    // 🔴 反例：不许出现两个分隔符连在一起（空段）
    expect(workRowSubtitle(noTime, now: _now).contains('$workPartSep$workPartSep'), isFalse);
  });

  test('④ 🔴 这几句话里不许出现内部词（清单上那几句都是给人看的）', () {
    for (final w in [
      workButtonLabel,
      workButtonHint,
      workPanelTitle,
      workCloseWords,
      workBusyLabel,
      workAgeDoing,
      workAgeJustNow,
      workAgeMinute,
      workAgeHour,
      workAgeDay,
      workCountUnit,
      workRowHint,
      workNamelessName,
      workEmptyWords,
      workLoadingWords,
      workFailWords,
    ]) {
      expect(w.trim().isEmpty, isFalse, reason: '空字符串不该出现在这张表里');
    }
    // 🔴 反例：把内部那几个词摆进去，下面这条会红（这条断言**不是空转**）
    for (final bad in ['工作区', '会话', '调度器', 'scope']) {
      expect(
        [workPanelTitle, workEmptyWords, workFailWords].any((s) => s.contains(bad)),
        isFalse,
        reason: '$bad 是内部词，不许上屏',
      );
    }
  });
}
