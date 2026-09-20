// 用户打了、还没发出去的那句话（欠账 18 / `draft_store.dart`）。
//
// ⚠️ 这一份钉的是**"本机那几句和保存的服务端事实不许混"**：
//    · 存档里**只有**本机未确认的发言，服务端事实一条都不许进去（各有各的地盘）；
//    · 读回来是 **`failed`/`queued` 那个态**（不许凭空变成"已收到"），而且**还能重发**；
//    · 被认领（`confirmed`）之后那条**必须从存档里消失**（不然刷新会重复出现）；
//    · 有界（条数 + 字符）、整条整条地丢、坏了当没有、绝不抛、带命名空间；
//    · 退出登录后读不到（**换个人登录不许看见上一个人打了一半的话**）。
//
// ⚠️ 不写界面断言（项目纪律：纯逻辑进 `test/unit`）。
//    这里只用：store 的存取、`Timeline` 的状态、控制器的公开入口、禁用词扫描。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/draft_store.dart';
import 'package:hupo_app/services/timeline_store.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> fact(int seq, [String type = 'message/text']) =>
    {'type': type, 'seq': seq, 'messageId': 'm1', 'text': '第 $seq 句'};

/// 一个"服务端固定回这个码 + 这个 body"的控制器。
/// ⚠️ `openStream: false`：纯逻辑的闸**不该去开真 socket**
///    （那会让"这件事对不对"变成"这台机器上网络快不快"）。
ChatController _controller({MockClient? client, DraftStore? drafts}) {
  final api = Api(client: client ?? MockClient((_) async => http.Response('{}', 200)));
  final c = ChatController(api: api, tokens: TokenStore(), token: 'tok', drafts: drafts);
  addTearDown(c.dispose);
  return c;
}

String _bodyOf(http.Request r) => r.body;

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('存档里只放本机未确认的话', () {
    test('🔴 服务端事实一条都不许混进去（两边各存各的）', () {
      // 服务端事实：助手气泡、用户的**已认领**那句、分隔标记
      final items = <TimelineItem>[
        UserUtterance(
          messageId: 'srv_1',
          text: '服务端认领过的',
          seq: 3,
          tie: 0,
          state: MessageState.confirmed,
        ),
        AssistantMessage(messageId: 'a1', seq: 4)..quick = '它答的',
        TimelineMarker(kind: 'away', seq: 5),
        UserUtterance(messageId: 'u_local', text: '我打了还没发出去', seq: 5, tie: 1),
      ];

      final got = draftsFrom(items);
      expect(got.length, 1, reason: '只有本机那一条该进存档');
      expect(got.single.messageId, 'u_local');
      expect(got.single.text, '我打了还没发出去');
      expect(got.single.state, MessageState.queued);
    });

    test('🔴 服务端认领过的那句（confirmed）不许进存档——它已经归"事实"那边', () {
      final got = draftsFrom([
        UserUtterance(
          messageId: 'u1',
          text: '已经发出去了',
          seq: 9,
          state: MessageState.confirmed,
        ),
      ]);
      expect(got, isEmpty);
    });

    test('🔴 存档里只有三个字段（最少必要：id + 正文 + 态）', () {
      final j = draftToJson(const LocalDraft(
        messageId: 'u1',
        text: '帮我记一笔',
        state: MessageState.failed,
      ));
      expect(j.keys.toSet(), {'messageId', 'text', 'state'});
      expect(j['state'], 'failed');
      // 服务端事实那两个特征（号 / 事件类型）**一个都不许出现**
      expect(j.containsKey('seq'), false);
      expect(j.containsKey('type'), false);
    });

    test('存进去再读出来，还是同一批（正文里的换行/标点不许走样）', () async {
      final s = DraftStore();
      const text = '第一行\n第二行，「引号」和 emoji 🙂';
      await s.save([const LocalDraft(messageId: 'u9', text: text, state: MessageState.failed)]);
      final back = await s.load();
      expect(back.single.messageId, 'u9');
      expect(back.single.text, text);
      expect(back.single.state, MessageState.failed);
    });
  });

  group('读回来之后还能重发（N11）', () {
    test('🔴 刷新回来：是 `failed` 那个态，不是凭空变成"已收到"，而且还能重发', () async {
      final store = DraftStore();
      await store.save([
        const LocalDraft(messageId: 'u1', text: '帮我记一笔', state: MessageState.failed),
      ]);

      final c = _controller(drafts: store);
      // ⚠️ 只 `start`（= 模拟刷新），**不碰网络**
      await c.start(token: 'tok', openStream: false);

      final mine = c.items.whereType<UserUtterance>().single;
      expect(mine.state, MessageState.failed, reason: '不许凭空变成 confirmed');
      expect(stateLabel(mine.state), '没发出去');
      expect(canTransition(mine.state, MessageState.queued), true,
          reason: '「重发」要把这条推回 queued');

      // 真的按一下重发：走到网络那一步，而且**用的还是同一个 messageId**
      // （不然服务端会当成新的一句，agent 干两遍——评审 E2）
      String? sentId;
      final c2 = _controller(
        drafts: store,
        client: MockClient((r) async {
          sentId = (jsonDecode(_bodyOf(r)) as Map)['messageId'] as String?;
          return http.Response('{"ok":true,"duplicate":false,"seq":6}', 200);
        }),
      );
      await c2.start(token: 'tok', openStream: false);
      await c2.resend('u1');
      expect(sentId, 'u1');
      expect(await store.load(), isNotEmpty, reason: '重发中不许把存档弄丢（那条还在，还能再试）');
    });

    test('🔴 `sent` 读回来降成 `failed`（回执不会再来了，必须有「重发」这条路）', () async {
      expect(storableState(MessageState.sent), MessageState.failed);
      expect(storableState(MessageState.queued), MessageState.queued);
      expect(storableState(MessageState.failed), MessageState.failed);
      // 存出去的字段也遵守这一条（不是只改内存里那个）
      expect(
        draftToJson(const LocalDraft(
          messageId: 'u1',
          text: 'x',
          state: MessageState.sent,
        ))['state'],
        'failed',
      );

      // 走一遍真实的往返：HTTP 200 到了、回执没来 ⇒ 刷新之后仍是「没发出去」
      String? carried;
      final c = _controller(client: MockClient((r) async {
        carried = _bodyOf(r);
        return http.Response('{"ok":true,"duplicate":false,"seq":5}', 200);
      }));
      await c.start(token: 'tok', openStream: false);
      await c.send('帮我记一笔');
      expect(c.items.whereType<UserUtterance>().single.state, MessageState.sent,
          reason: '屏幕上这一刻是「已送到」');

      final store = DraftStore();
      final id = (jsonDecode(carried!) as Map)['messageId'] as String;
      final back = await store.load();
      expect(back.single.messageId, id, reason: '存档里要留着，重发才用得上同一个 id');
      expect(back.single.state, MessageState.failed, reason: '刷新之后必须是可重发的那个态');
    });

    test('重发之后（回执到了）从存档里消失：它已经变成服务端事实了', () async {
      final store = DraftStore();
      await store.save([
        const LocalDraft(messageId: 'u1', text: '帮我记一笔', state: MessageState.failed),
      ]);

      final c = _controller(
        drafts: store,
        client: MockClient((_) async => http.Response('{"ok":true,"duplicate":false,"seq":5}', 200)),
      );
      await c.start(token: 'tok', openStream: false);
      await c.resend('u1'); // → sent（存档里仍是 failed，可重发）

      c.ingest({'type': 'user/echo', 'seq': 5, 'messageId': 'u1', 'text': '帮我记一笔'});
      await store.flush();

      final mine = c.items.whereType<UserUtterance>().single;
      expect(mine.state, MessageState.confirmed, reason: '回声认领了它');
      expect(await store.load(), isEmpty, reason: '认领之后必须从存档里去掉');
    });
  });

  group('被服务端认领 ⇒ 从存档里消失', () {    test('🔴 收到 `user/echo` 之后那条必须从存档里去掉（不然刷新会重复出现）', () async {
      final store = DraftStore();
      final c = _controller(
        drafts: store,
        client: MockClient((_) async => http.Response('{"ok":true,"duplicate":false,"seq":5}', 200)),
      );
      await c.start(token: 'tok', openStream: false);
      await c.send('帮我记一笔');
      expect((await store.load()).length, 1, reason: '发出去之前就该在存档里');

      // ⚠️ 用**它自己生成的那个 id**（本地 id 是"钟 + 计数"，测试里不许瞎猜）
      final id = c.items.whereType<UserUtterance>().single.messageId;
      c.ingest({'type': 'user/echo', 'seq': 5, 'messageId': id, 'text': '帮我记一笔'});
      await store.flush(); // 控制器那几次写是"不等"的 ⇒ 等队列追平

      expect(await store.load(), isEmpty, reason: '认领 ⇒ 从存档里去掉');
      // 而且它现在归 timeline_store 那边：刷新时喂回去的是**服务端事实**
      final facts = c.timeline;
      expect(facts.items.whereType<UserUtterance>().single.state, MessageState.confirmed);
    });

    test('流式那一堆帧不许把存档冲掉（只在真变了的时候才写盘）', () async {
      // ⚠️ 存档是**每一帧**都重算一遍的（`ingest`），而一轮流式回答能来上百条
      //    `message/text`。写了"只在变了的时候写"之后，最怕的是**写漏了**：
      //    那条"没发出去"的话被一堆无关的帧冲没了。
      final store = DraftStore();
      final c = _controller(
        drafts: store,
        client: MockClient((_) async => http.Response('{"ok":true,"duplicate":false,"seq":5}', 200)),
      );
      await c.start(token: 'tok', openStream: false);
      await c.send('我还没发出去的话');
      // ⚠️ 认领它（用的是它自己生成的那个 id），后面跟一堆无关的流式帧
      final first = c.items.whereType<UserUtterance>().single.messageId;
      c.ingest({'type': 'user/echo', 'seq': 5, 'messageId': first, 'text': '我还没发出去的话'});
      for (var i = 0; i < 40; i += 1) {
        c.ingest({'type': 'message/text', 'seq': 6 + i, 'messageId': 'a1', 'text': '字'});
      }
      await store.flush();
      expect(await store.load(), isEmpty, reason: '认领的那条不许被漏下（写漏了就烂在这里）');

      // 再来一句（这次不认领）：那一堆帧之后它还得在
      await c.send('第二句还没发出去');
      for (var i = 0; i < 40; i += 1) {
        c.ingest({'type': 'message/text', 'seq': 100 + i, 'messageId': 'a1', 'text': '字'});
      }
      await store.flush();
      final back = await store.load();
      expect(back.length, 1, reason: '那一堆帧之后它还得在');
      expect(back.single.text, '第二句还没发出去');
    });
  });

  group('有界（条数 + 字符，整条整条地丢）', () {
    test('🔴 条数封顶：留**最后**那些，不是最前面那些', () {
      final lines = [for (var i = 1; i <= 40; i += 1) '{"messageId":"u$i"}'];
      final kept = DraftStore.trimLines(lines, maxDrafts: 5, maxChars: 1 << 20);
      expect(kept.length, 5);
      expect(kept.first, '{"messageId":"u36"}');
      expect(kept.last, '{"messageId":"u40"}');
    });

    test('🔴 字符封顶：**整条整条地丢**，绝不截半条', () {
      // 每条 20 个字符；给 55 个字符的额度 ⇒ 只能留 2 条（40+2 ≤ 55）
      final lines = [for (var i = 0; i < 5; i += 1) '{"messageId":"u$i","x":1}'];
      expect(lines.first.length, 24);
      final kept = DraftStore.trimLines(lines, maxDrafts: 99, maxChars: 55);
      expect(kept.length, 2);
      for (final l in kept) {
        // 每一行都还得是**完整的一条**
        expect(l.startsWith('{') && l.endsWith('}'), true, reason: '截半条了：$l');
      }
      expect(kept.last, lines.last);
    });

    test('额度小到一条都放不下 ⇒ 空（不是半条）', () {
      expect(DraftStore.trimLines(['{"messageId":"u1","x":1234567890}'], maxChars: 3), isEmpty);
    });

    test('🔴 字符额度真的会被执行：超了就从最前面丢（留得下的是最后那几条）', () async {
      final s = DraftStore();
      final big = 'x' * 3000; // 每条 JSON 约 3KB
      await s.save([
        for (var i = 0; i < 30; i += 1) LocalDraft(messageId: 'u$i', text: big, state: MessageState.failed),
      ]);
      final back = await s.load();
      expect(back, isNotEmpty);
      expect(back.length, lessThan(30), reason: '超了 64K 就必须丢');
      expect(back.last.messageId, 'u29', reason: '留的是**最后**那几条');
      for (final d in back) {
        expect(d.text, big, reason: '整条整条地丢，不许把正文截半句');
      }
    });

    test('条数额度真的会被执行：默认封顶之外的一条都不留', () async {
      final s = DraftStore();
      await s.save([
        for (var i = 0; i < DraftStore.capDrafts + 5; i += 1)
          LocalDraft(messageId: 'u$i', text: '短', state: MessageState.queued),
      ]);
      final back = await s.load();
      expect(back.length, DraftStore.capDrafts);
      expect(back.first.messageId, 'u5');
      expect(back.last.messageId, 'u${DraftStore.capDrafts + 4}');
    });
  });

  group('坏了当没有，绝不抛', () {
    test('一行坏了不许拖垮整份存档（坏行跳过，好的照用）', () async {
      SharedPreferences.setMockInitialValues({
        'hupo_drafts_v1.single': [
          '{"messageId":"u1","text":"好的","state":"failed"}',
          '这不是 JSON',
          '{"messageId":"u2","text":"缺态"}', // 缺 state ⇒ 坏
          '{"messageId":"u3","text":"态不认识","state":"confirmed"}', // 认领不该在存档里 ⇒ 坏
          '{"messageId":"u4","text":"好的第二条","state":"queued"}',
        ],
      });
      final back = await DraftStore().load();
      expect(back.map((d) => d.messageId), ['u1', 'u4']);
    });

    test('读不到 / 存不上都不抛（存档是最好有，不是必须有）', () async {
      // 没存过
      expect(await DraftStore().load(), isEmpty);
      // 存一条解不开的也不抛
      await DraftStore().save([
        LocalDraft(messageId: 'u1', text: 'x', state: MessageState.failed),
      ]);
      // id 空的那种脏数据：跳过它，也不抛
      await DraftStore().save([const LocalDraft(messageId: '', text: 'x', state: MessageState.failed)]);
      expect(await DraftStore().load(), isEmpty);
      // 纯函数那头：解不开的行返回 null，不抛
      expect(draftFromJson(const {}), isNull);
      expect(draftFromJson(const {'messageId': 1, 'text': 'x', 'state': 'failed'}), isNull);
    });
  });

  group('命名空间与退出登录', () {
    test('🔴 命名空间：换一个就看不见对方的（多人那一批的地基）', () async {
      await DraftStore(namespace: 'a').save([
        const LocalDraft(messageId: 'u1', text: 'a 的', state: MessageState.failed),
      ]);
      await DraftStore(namespace: 'b').save([
        const LocalDraft(messageId: 'u2', text: 'b 的', state: MessageState.failed),
      ]);
      expect((await DraftStore(namespace: 'a').load()).single.messageId, 'u1');
      expect((await DraftStore(namespace: 'b').load()).single.messageId, 'u2');
      expect(await DraftStore(namespace: 'c').load(), isEmpty);
    });

    test('🔴 `logout()` 之后读不到了（**换个人登录不许看见上一个人打了一半的话**）', () async {
      final store = DraftStore();
      final c = _controller(drafts: store);
      await c.start(token: 'tok', openStream: false);
      c.timeline.addLocalUtterance('上一个人打了一半的话', 'u1');
      await store.save(draftsFrom(c.timeline.items));
      expect((await store.load()).length, 1);

      await c.logout();
      await store.flush();
      expect(await store.load(), isEmpty, reason: '退出登录必须把这份存档一起清掉');
      expect(c.drafts.key, 'hupo_drafts_v1.single', reason: '命名空间与时间线那份同形');
    });

    test('服务端说"你这号不对了"（`__reset__`）：事实清掉，**我打的那句留下**', () async {
      // 先攒一份"服务端的事实在缓存里"（模拟上一次开机存下来的）
      await TimelineStore().save([fact(1), fact(2)]);
      final store = DraftStore();
      await store.save([
        const LocalDraft(messageId: 'u1', text: '还没发出去的一句', state: MessageState.failed),
      ]);

      final c = _controller(drafts: store);
      await c.start(token: 'tok', openStream: false);
      expect(c.items.whereType<UserUtterance>().single.state, MessageState.failed);

      c.ingest({'type': '__reset__'});
      await store.flush();

      // 服务端事实那条路被清干净了（那个世界不存在了）
      expect(await TimelineStore().load(), isEmpty);
      expect(c.timeline.lastSeq, 0);
      // ⚠️ 而用户自己的话**必须留下**（清掉它 = 把用户打好的字弄丢了）
      expect(c.items.whereType<UserUtterance>().single.text, '还没发出去的一句');
      expect((await store.load()).single.messageId, 'u1',
          reason: '复位不许把"我打了一半的话"从存档里抹掉');
    });
  });

  group('屏幕上还是那几句话（没有内部词）', () {
    test('四个态的人话 + 「重发」都过禁用词扫描', () {
      final copies = [
        for (final s in MessageState.values) stateLabel(s),
        '重发',
      ];
      for (final c in copies) {
        final hits = scanForbidden(c);
        expect(hits, isEmpty, reason: '「$c」里有禁用词：$hits');
      }
      // 读到屏幕上那几句走的就是 `stateLabel`（和 say_outcome_test 同一条路）
      expect(stateLabel(MessageState.failed), '没发出去');
      // 顶部状态条那句也顺手过一遍（它和这张表一样是"用户真会看到的字"）
      final (shown, _) = statusLine(ConnState.connected, error: '网没通，这条没发出去');
      expect(shown, '网没通，这条没发出去');
      expect(scanForbidden(shown!), isEmpty);
    });

    test('存档里那几句（用户自己的字）到屏幕上也不许带出内部词', () {
      final texts = draftsFrom([
        UserUtterance(messageId: 'u1', text: '明天下午三点提醒我吃药', seq: 0, tie: 1),
      ]).map((d) => d.text);
      for (final t in texts) {
        expect(scanForbidden(t), isEmpty);
      }
    });
  });
}
