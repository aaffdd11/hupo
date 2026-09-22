// 「系统通知」的**纯逻辑**那半边（契约 `docs/dev/29-NOTICE.md`）。
//
// 这一份钉死四件事，都是**客户端这边绝不能漂**的：
//
//   1. 线上形状与五个 `kind`（§五 / §5.1）——认不出来的**不猜**；
//   2. `undo` 的 fail-closed（认不出的 action / 空清单 ⇒ **不给入口**）；
//   3. **瞬态通知不占号、不进时间线**（§三① + 决策 P-g）——
//      它只该出现在浮窗里；
//   4. 🔴 **客户端一个字都不重写那句话**（§五：`text` 由服务端给、客户端照抄）。
//      第 4 条有一条源码级断言：`lib/models/notice.dart` 里
//      **一个含中文的字符串字面量都不许有**。
//
// ⚠️ 界面那半边在 `test/widget/notice_overlay_test.dart`
//    （浮窗不挤内容 / 两处撤销 / 五档不溢出 + 命中区）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/notice.dart';
import 'package:hupo_app/models/notice_words.dart';
import 'package:hupo_app/models/timeline.dart';

/// 假的服务端那句话。⚠️ **写在这份测试里**正是重点：
///    它属于服务端（§5.1 那张表），客户端不许有它的模板。
const _expiringText = '有一条过几天会彻底删掉';
const _diskFullText = '盘满了，这条我没能记下来';

Map<String, dynamic> _noticeEvent({
  required String kind,
  String text = _expiringText,
  Object? undo,
  int seq = 7,
  bool catchUp = false,
}) =>
    {
      'type': 'notice',
      'kind': kind,
      'text': text,
      'at': 1758400000000,
      'seq': seq,
      if (catchUp) 'catchUp': true,
      if (undo != null) 'undo': undo,
    };

void main() {
  group('解析（§五 那两种形状）', () {
    test('五个 kind 逐条对表（§5.1）', () {
      const wire = {
        'resumed': NoticeKind.resumed,
        'not-resumed': NoticeKind.notResumed,
        'expiring': NoticeKind.expiring,
        'crash': NoticeKind.crash,
        'failed': NoticeKind.failed,
        'disk-full': NoticeKind.diskFull,
      };
      wire.forEach((k, expected) {
        expect(NoticeKind.fromWire(k), expected, reason: '$k 认错了');
        final n = Notice.fromEvent({'type': 'notice', 'kind': k, 'text': 'x'});
        expect(n!.kind, expected);
      });
    });

    test('认不出来的 kind ⇒ unknown，但**那句话照旧拿得住**（不猜，也不丢）', () {
      final n = Notice.fromEvent({'type': 'notice', 'kind': 'brand-new', 'text': '一件新事'});
      expect(n!.kind, NoticeKind.unknown);
      expect(n.text, '一件新事', reason: '★ 认不出的只是分类，不是那句话');
    });

    test('`text` 读不出来 / 是空的 ⇒ **没有这条通知**（不给一个空框）', () {
      expect(Notice.fromEvent({'type': 'notice', 'kind': 'crash'}), isNull);
      expect(Notice.fromEvent({'type': 'notice', 'kind': 'crash', 'text': '   '}), isNull);
      expect(Notice.fromEvent({'type': 'notice', 'kind': 'crash', 'text': 42}), isNull);
    });

    test('`at` 读不出来 ⇒ null（**不许拿本机钟冒充**）', () {
      final n = Notice.fromEvent({'type': 'notice', 'kind': 'crash', 'text': 'x'});
      expect(n!.at, isNull);
      final m = Notice.fromEvent(
          {'type': 'notice', 'kind': 'crash', 'text': 'x', 'at': 1758400000000});
      expect(m!.at, 1758400000000);
    });

    test('`notice/urgent` ⇒ urgent=true（§三①：只准用于"写盘本身失败"）', () {
      final n = Notice.fromEvent({'type': 'notice/urgent', 'kind': 'disk-full', 'text': _diskFullText});
      expect(n!.urgent, isTrue);
      expect(n.kind, NoticeKind.diskFull);
      expect(n.at, isNull, reason: '瞬态那条没有号、也不带 at');
    });

    test('持久那条 urgent=false（浮窗那一声要分得开）', () {
      final n = Notice.fromEvent(_noticeEvent(kind: 'expiring'));
      expect(n!.urgent, isFalse);
    });
  });

  group('undo（§五：撤销 = `action` + 参数）', () {
    test('`trash/restore` + 清单 ⇒ 完整读出来', () {
      final n = Notice.fromEvent(_noticeEvent(
        kind: 'expiring',
        undo: {
          'label': '拿回来',
          'action': 'trash/restore',
          'messageIds': ['u_x', 'm_y'],
        },
      ))!;
      expect(n.undo!.label, '拿回来');
      expect(n.undo!.action, NoticeUndoAction.trashRestore);
      expect(n.undo!.messageIds, ['u_x', 'm_y']);
      expect(n.undo!.usable, isTrue);
    });

    test('label 读不出来 ⇒ **整份 undo 不要**（客户端不许自己编一个按钮字）', () {
      expect(NoticeUndo.fromJson({'action': 'trash/restore', 'messageIds': ['x']}), isNull);
      expect(NoticeUndo.fromJson({'label': '  ', 'action': 'trash/restore'}), isNull);
      expect(NoticeUndo.fromJson('不是对象'), isNull);
    });

    test('🔴 认不出的 action ⇒ unusable（**不给一个按了没结果的按钮**）', () {
      final u = NoticeUndo.fromJson({'label': '拿回来', 'action': 'trash/purge', 'messageIds': ['x']})!;
      expect(u.action, NoticeUndoAction.unsupported);
      expect(u.usable, isFalse);
    });

    test('🔴 清单是空的 ⇒ unusable（发一个空请求 = 按了没反应）', () {
      final u = NoticeUndo.fromJson({'label': '拿回来', 'action': 'trash/restore', 'messageIds': []})!;
      expect(u.usable, isFalse);
      final u2 = NoticeUndo.fromJson({'label': '拿回来', 'action': 'trash/restore'})!;
      expect(u2.messageIds, isEmpty);
      expect(u2.usable, isFalse);
    });

    test('清单里混着非字符串 / 空串 ⇒ 只认**明确写着的非空字符串**', () {
      final u = NoticeUndo.fromJson({
        'label': '拿回来',
        'action': 'trash/restore',
        'messageIds': ['u_x', 7, '', null, 'm_y'],
      })!;
      expect(u.messageIds, ['u_x', 'm_y']);
    });

    test('没有 undo 的通知 ⇒ `undo` 是 null（续做那条就没有，§5.1）', () {
      final n = Notice.fromEvent(_noticeEvent(kind: 'resumed'))!;
      expect(n.undo, isNull);
    });
  });

  group('时间线那一条（约束 2）', () {
    test('★ `notice`（带号）⇒ **进列表、占一个位置**', () {
      final t = Timeline();
      t.apply(_noticeEvent(kind: 'expiring', seq: 1));
      expect(t.items.length, 1, reason: '★ 通知必须占一个位置（浮窗只是喊一声）');
      final item = t.items.first;
      expect(item, isA<TimelineNotice>());
      expect(item.seq, 1);
      expect((item as TimelineNotice).notice.text, _expiringText);
    });

    test('🔴 浮窗只对"现在发生的"喊（历史两种都不喊）—— `shouldPopNotice` 真值表', () {
      // ⚠️ 这张表是"每次登录都喊一次"那个 bug 的判据形状（2026-09-22 主人报的）。
      //    `catchUp` = 服务端标的补发；`readingHistory` = 这条连接还在读首屏那段历史。
      expect(shouldPopNotice(catchUp: false, readingHistory: false), isTrue, reason: '现在发生的 ⇒ 喊');
      expect(shouldPopNotice(catchUp: true, readingHistory: false), isFalse, reason: '补发 ⇒ 不喊');
      expect(shouldPopNotice(catchUp: false, readingHistory: true), isFalse, reason: '首屏历史 ⇒ 也不喊');
      expect(shouldPopNotice(catchUp: true, readingHistory: true), isFalse, reason: '都是历史 ⇒ 不喊');
    });

    test('★ 补发上来的照样在列表里（它本来就是给"你不在"留的）', () {
      final t = Timeline();
      t.apply(_noticeEvent(kind: 'resumed', catchUp: true));
      expect(t.items.whereType<TimelineNotice>().length, 1);
      expect((t.items.first as TimelineNotice).catchUp, isTrue);
    });

    test('★ 同号重复到达 ⇒ 不画两遍（协议 R5：补发/重连必然重复）', () {
      final t = Timeline();
      t.apply(_noticeEvent(kind: 'expiring', seq: 3));
      t.apply(_noticeEvent(kind: 'expiring', seq: 3));
      expect(t.items.length, 1);
    });

    test('🔴 **`notice/urgent` 不进时间线**（瞬态没有号 ⇒ 决策 P-g）', () {
      final t = Timeline();
      t.apply({'type': 'notice/urgent', 'kind': 'disk-full', 'text': _diskFullText});
      expect(t.items, isEmpty,
          reason: '★ 瞬态通知只该出现在浮窗里；它要是占了一条，'
              '屏幕上就多了一条"盘满的时候其实没写进盘"的假历史');
    });

    test('`text` 读不出来 ⇒ 不占位置（不画一行空白）', () {
      final t = Timeline();
      t.apply({'type': 'notice', 'kind': 'crash', 'seq': 1});
      expect(t.items, isEmpty);
      // 但号还是收下了：这一条是**服务端说过的事实**（补发不该再要一次）
      expect(t.lastSeq, 1, reason: '什么都不画 ≠ 假装没收到');
    });

    test('通知那一行**没有 messageId** ⇒ 长按删除那条路够不着它', () {
      final t = Timeline();
      t.apply(_noticeEvent(kind: 'crash'));
      expect(t.items.first.messageId, isNull);
      expect(turnGroupOf(t.items, 'notice'), isNull);
    });

    test('通知不拆散"一轮"：夹在问答中间也不影响分组（删除的单位还是一轮）', () {
      final t = Timeline();
      t.apply({'type': 'user/echo', 'seq': 1, 'messageId': 'u_1', 'text': '记一下'});
      t.apply(_noticeEvent(kind: 'crash', seq: 2));
      t.apply({'type': 'message/start', 'seq': 3, 'messageId': 'm_1'});
      t.apply({'type': 'message/end', 'seq': 4, 'messageId': 'm_1', 'reason': 'completed'});
      final groups = turnGroupsOf(t.items);
      expect(groups.length, 1);
      expect(groups.first.messageIds, ['u_1', 'm_1']);
    });

    test('时间线那一条按得动的撤销：认不出 action / 空清单 ⇒ 不画按钮', () {
      final t = Timeline();
      t.apply(_noticeEvent(
        kind: 'expiring',
        undo: {'label': '拿回来', 'action': 'trash/restore', 'messageIds': ['u_x']},
      ));
      expect((t.items.first as TimelineNotice).undo!.label, '拿回来');

      final t2 = Timeline();
      t2.apply(_noticeEvent(
        kind: 'expiring',
        seq: 2,
        undo: {'label': '拿回来', 'action': 'trash/purge', 'messageIds': ['u_x']},
      ));
      expect((t2.items.first as TimelineNotice).undo, isNull, reason: '★ 按了不会有结果的按钮不许画');
    });

    test('重放（冷启动那一屏）也画得出来 —— 通知经得起"你不在"', () {
      final t = Timeline();
      t.seedFromCache([
        _noticeEvent(kind: 'expiring', seq: 1),
        {'type': 'user/echo', 'seq': 2, 'messageId': 'u_1', 'text': '记一下'},
      ]);
      expect(t.items.whereType<TimelineNotice>().length, 1);
    });
  });

  // ── 🔴 第 4 条：客户端一个字都不重写那句话 ─────────────────────
  //
  // 这一条是**源码级**的：`text` 由服务端给（§五），所以 `notice.dart` 里
  // **一个含中文的字符串字面量都不该有**。真有人顺手加一句模板
  // （"有一条过几天会彻底删掉"…），两半当场开始漂——而那是文档拦不住的，
  // 只有这一条断言拦得住。

  /// 一份源码里**含中文的字符串字面量**（只认 `'…'` / `"…"` 那两种引号）。
  ///
  /// ⚠️ **先去掉注释**：dartdoc 里引的那句契约原话不是文案，但注释里的
  ///    "顺手拷进代码"只有一步之遥 ⇒ 单独一条断言钉住"注释也算"。
  List<String> chineseLiteralsIn(String source) {
    final code = source
        .replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '')
        .replaceAll(RegExp(r'//[^\n]*'), '');
    final re = RegExp(r'''(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')''');
    return [
      for (final m in re.allMatches(code))
        if (RegExp(r'[\u4e00-\u9fff]').hasMatch(m.group(0)!)) m.group(0)!,
    ];
  }

  test('🔴 `lib/models/notice.dart` 里**一个中文文案模板都没有**（`text` 是服务端的）', () {
    final src = File('lib/models/notice.dart').readAsStringSync();
    final found = chineseLiteralsIn(src);
    expect(
      found,
      isEmpty,
      reason: '★ 这些是客户端自己写的通知文案：$found —— '
          '通知正文由服务端给、客户端照抄（`29-NOTICE.md` §五）。'
          '在客户端再写一遍，两半一定漂。',
    );
  });

  test('🔴 负向对照：这条扫描**真的抓得住**中文文案（不是空转）', () {
    // `notice_words.dart` 里**故意**有中文（那些是"我们自己写的话"）：
    // 扫描抓不住它们的话，上面那条断言就是一句废话。
    final words = File('lib/models/notice_words.dart').readAsStringSync();
    expect(chineseLiteralsIn(words), isNotEmpty, reason: '扫描是空转的 ⇒ 上面那条闸没守住任何东西');
    expect(chineseLiteralsIn("const a = '撤销';"), ["'撤销'"]);
    expect(chineseLiteralsIn("const a = 'trash/restore';"), isEmpty);
    expect(chineseLiteralsIn("const a = 'x'; // 一句中文注释\n"), isEmpty,
        reason: '注释不是文案（但注释里的中文也不许当模板用）');
    expect(chineseLiteralsIn("/* 一句中文注释 */\nconst a = 'x';\n"), isEmpty);
  });

  // ── 🔴 我们自己写的那几句：过真那份禁用词表 ───────────────────
  //
  // ⚠️ `notice.text` 是**服务端来的**，客户端这边那道表**扫不到它**
  //    （契约 §五 说清了：两半的表都要有，那是服务端那半边的活）。
  //    但**我们自己写的字**（按钮 / 那句"这条留不下来"）必须干净——
  //    所以这里拿**真那份表**扫一遍。特别是那句瞬态的补充语：
  //    第一版写的是「这条没能写进**记录**里」，而"记录/时间线"是禁用词，
  //    服务端那句 `disk-full` 的口径也明说了不许出现"时间线"
  //    （`29-NOTICE.md` §三① 补的那一行）。
  test('🔴 客户端自己写的那几句，一个禁用词都没有（拿真表扫）', () {
    for (final line in [noticeUndoLabel, noticeDismissLabel, noticeNotKeptLine]) {
      final hits = scanForbidden(line);
      expect(hits, isEmpty, reason: '「$line」里有禁用词：$hits');
    }
    // 负向对照：这条扫描**真的会响**（内部词进了界面就是缺陷，不是文风问题）
    expect(scanForbidden('这条没能写进时间线里'), isNotEmpty);
    expect(scanForbidden('工作区'), isNotEmpty);
  });

  test('§三①：瞬态那句补充**不许承诺时间 / 不许夹数字**（D7.1 + 约束 4）', () {
    // ⚠️ 不承诺时间：不许出现"几秒 / 3 秒 / 马上"那类话；
    //    阈值与时长只住在代码里与服务端，**不住在给用户看的话里**。
    expect(RegExp(r'[0-9]').hasMatch(noticeNotKeptLine), isFalse,
        reason: '★ 「$noticeNotKeptLine」里夹了数字 —— 阈值不许住在客户端文案里');
    for (final w in ['秒', '分钟', '一会儿就', '马上']) {
      expect(noticeNotKeptLine.contains(w), isFalse, reason: '★ 「$w」是时间承诺（§一 第 4 条）');
    }
  });
}
