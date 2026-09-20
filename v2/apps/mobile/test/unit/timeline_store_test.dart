// 本机那一屏（S5c / B6）。手册 `04-ROADMAP.md` S5c · `03-DEVELOPMENT.md`（`timeline_store.dart`）。
//
// ⚠️ 这一份钉的是**"缓存不许变成第二个真相来源"**：
//    · 没号的东西（瞬态）一条都不许进缓存；
//    · 满了只许**整条整条地丢**（截半条 = 解不开 = 那一屏会画出半句话，那是编造）；
//    · 一行坏了不许拖垮整屏；
//    · 换一个命名空间就看不见对方的（多人那一批的地基）。
//
// ⚠️ 还有一条**不在这个文件里、但更重要**的：缓存画出来的那一屏
//    **不许说"它正在做"**（我们不知道那一轮还活着没有）——在 `timeline_test.dart`。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/services/timeline_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> fact(int seq, [String type = 'message/text']) =>
    {'type': type, 'seq': seq, 'messageId': 'm1', 'text': '第 $seq 句'};

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('本机一屏', () {
    test('🔴 没号的东西一条都不许进缓存（瞬态不是事实）', () {
      expect(TimelineStore.isPersistable({'type': 'turn/start'}), false);
      expect(TimelineStore.isPersistable({'type': 'message/status', 'state': 'x'}), false);
      expect(TimelineStore.isPersistable(fact(7)), true);
    });

    test('存进去再读出来，还是同一批事实', () async {
      final s = TimelineStore();
      await s.save([fact(1), fact(2, 'message/end')]);
      final back = await s.load();
      expect(back.length, 2);
      expect(back[0]['seq'], 1);
      expect(back[1]['type'], 'message/end');
    });

    test('瞬态混在里面也不会被存（只挑带号的）', () async {
      final s = TimelineStore();
      await s.save([
        {'type': 'turn/start', 'turn': 1},
        fact(3),
        {'type': 'client/ping'},
      ]);
      final back = await s.load();
      expect(back.length, 1);
      expect(back.single['seq'], 3);
    });

    test('🔴 条数封顶：留**最后**那些，不是最前面那些', () {
      final lines = [for (var i = 1; i <= 300; i += 1) '{"seq":$i}'];
      final kept = TimelineStore.trimLines(lines, maxEvents: 10, maxChars: 1 << 20);
      expect(kept.length, 10);
      expect(kept.first, '{"seq":291}');
      expect(kept.last, '{"seq":300}');
    });

    test('🔴 字符封顶：**整条整条地丢**，绝不截半条', () {
      // 每条 20 个字符；给 55 个字符的额度 ⇒ 只能留 2 条（40+2 ≤ 55）
      final lines = [for (var i = 0; i < 5; i += 1) '{"seq":$i,"pad":"xx"}'];
      expect(lines.first.length, 20);
      final kept = TimelineStore.trimLines(lines, maxEvents: 99, maxChars: 55);
      expect(kept.length, 2);
      for (final l in kept) {
        // 每一行都还得是**完整的一条**
        expect(l.startsWith('{') && l.endsWith('}'), true, reason: '截半条了：$l');
      }
      expect(kept.last, lines.last);
    });

    test('额度小到一条都放不下 ⇒ 空（不是半条）', () {
      final kept = TimelineStore.trimLines(['{"seq":1,"pad":"xxxxxxxxxx"}'], maxChars: 3);
      expect(kept, isEmpty);
    });

    test('一行坏了不许拖垮整屏', () async {
      SharedPreferences.setMockInitialValues({
        'hupo_timeline_v1.single': ['{"seq":1}', '这不是 JSON', '{"seq":2}'],
      });
      final back = await TimelineStore().load();
      expect(back.map((e) => e['seq']), [1, 2]);
    });

    test('读不到 / 存不上都不抛（缓存是最好有，不是必须有）', () async {
      // 没存过
      expect(await TimelineStore().load(), isEmpty);
      // 存一条解不开的东西也不抛
      await TimelineStore().save([
        {'seq': 1, 'bad': Object()},
      ]);
    });

    test('🔴 命名空间：换一个就看不见对方的（多人那一批的地基）', () async {
      await TimelineStore(namespace: 'a').save([fact(1)]);
      await TimelineStore(namespace: 'b').save([fact(9)]);
      expect((await TimelineStore(namespace: 'a').load()).single['seq'], 1);
      expect((await TimelineStore(namespace: 'b').load()).single['seq'], 9);
      expect(await TimelineStore(namespace: 'c').load(), isEmpty);
    });

    test('clear 之后读不到了（退出登录 / 服务端说"你这号不对了"）', () async {
      final s = TimelineStore();
      await s.save([fact(1)]);
      expect((await s.load()), isNotEmpty);
      await s.clear();
      expect(await s.load(), isEmpty);
    });
  });
}
