// 「删掉 / 回收站」这一件的**纯逻辑**（契约 `docs/dev/28-DELETE.md`）。
//
// 这一份钉的是这一件最容易做错的三件事：
//   ① **一轮是哪两条**（§三·补：落盘的事件里没有轮号 ⇒ 分组只能由客户端给）；
//   ② **藏起来 ≠ 销毁**（§8.3：`deleted` 藏、`restored` 取消藏、`purged` 才丢，
//      而且藏这件事**跟事件到达的先后无关**——重放时墓碑可能先到）；
//   ③ **本机那两份跟着清**（§四 🔴：清完之后，连**冷启动那一屏**也不许再出现
//      那一轮的任何字）。③ 是这一件唯一的硬判据。
//
// ⚠️ 不写界面断言（项目纪律：纯逻辑进 `test/unit`，界面断言放 `test/widget`）。
//    这里只用：纯函数逐条对表、`Timeline` 的状态、控制器的公开入口、
//    两个 store 的存取（`SharedPreferences` 打的是假盘）、禁用词扫描。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/message_state.dart';
import 'package:hupo_app/models/timeline.dart';
import 'package:hupo_app/models/trash.dart';
import 'package:hupo_app/models/trash_words.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/draft_store.dart';
import 'package:hupo_app/services/timeline_store.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 一条带号的用户发言。
UserUtterance _u(String id, int seq, {MessageState state = MessageState.confirmed}) =>
    UserUtterance(messageId: id, text: '用户说的 $id', seq: seq, state: state);

/// 一条带号的回答。
AssistantMessage _a(String id, int seq, [String text = '它答的']) =>
    AssistantMessage(messageId: id, seq: seq)..quick = text;

ChatController _controller({
  MockClient? client,
  TimelineStore? local,
  DraftStore? drafts,
}) {
  final api = Api(client: client ?? MockClient((_) async => _json('{}', 200)));
  final c = ChatController(
    api: api,
    tokens: TokenStore(),
    token: 'tok',
    local: local,
    drafts: drafts,
  );
  addTearDown(c.dispose);
  return c;
}

/// 假回执。⚠️ **必须带 `charset=utf-8`**：`http.Response(body, 200)` 默认按
/// latin1 编正文，正文里只要有中文就会当场抛（"Contains invalid characters"）。
/// 真服务端也是带 charset 的（`services/core/src/server.js` 那两处 JSON 响应）。
http.Response _json(String body, int status) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// 一整轮的服务端事实（用户那句 + 回答），**都带号**（不然进不了缓存）。
///
/// ⚠️ `message/text` 上那个 `seqInBlock` **是照真日志的形状写的**——
///    "从回收站拿回来"的重发去重就用它（见下面那一组测试）。
List<Map<String, dynamic>> _turnFacts({
  required String userId,
  required String answerId,
  int from = 1,
  String userText = '帮我把这周工时记一下',
  String answerText = '这周 7 小时。',
}) =>
    [
      {'type': 'user/echo', 'seq': from, 'messageId': userId, 'text': userText},
      {'type': 'message/start', 'seq': from + 1, 'messageId': answerId},
      {
        'type': 'message/text',
        'seq': from + 2,
        'messageId': answerId,
        'block': 'quick',
        'seqInBlock': 1,
        'text': answerText,
      },
      {'type': 'message/end', 'seq': from + 3, 'messageId': answerId, 'reason': 'completed'},
    ];

/// **同一段正文再发一遍**（服务端"从回收站拿回来"就是这么做：`at` 原值、
/// **新 `seq`**、`seqInBlock` 和文本一模一样）。
Map<String, dynamic> _resend(Map<String, dynamic> e, int seq) => {...e, 'seq': seq};

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // ── ① 一轮是哪两条 ─────────────────────────────────────────

  group('一轮 = 一条用户的话 + 它的回答（§三·补）', () {
    test('一问答一轮：两条都在同一轮里', () {
      final items = [_u('u1', 1), _a('m1', 2)];
      final g = turnGroupOf(items, 'm1');
      expect(g, isNotNull);
      expect(g!.messageIds, ['u1', 'm1']);
      // 从用户那条进也认同一轮
      expect(turnGroupOf(items, 'u1')!.messageIds, ['u1', 'm1']);
    });

    test('🔴 连发两句：**先来先配**（和服务端 `#turnOwner` 的 shift 同一条规矩）', () {
      // u1、u2 都发出去了，回答一条一条回来
      final items = [_u('u1', 1), _u('u2', 2), _a('m1', 3), _a('m2', 4)];
      final groups = turnGroupsOf(items);
      expect(groups.length, 2);
      expect(groups[0].messageIds, ['u1', 'm1']);
      expect(groups[1].messageIds, ['u2', 'm2']);
    });

    test('🔴 还没发出去的那句**不成一轮**（服务端没有它，删它是空请求）', () {
      final items = [
        _u('u_local', 0, state: MessageState.failed), // 没被认领
        _u('u1', 1),
        _a('m1', 2),
      ];
      expect(turnGroupOf(items, 'u_local'), isNull);
      expect(turnGroupsOf(items).length, 1);
      expect(turnGroupsOf(items).single.messageIds, ['u1', 'm1']);
    });

    test('说了话还没答：那一轮只有用户那条（也是一个能删的东西）', () {
      final g = turnGroupOf([_u('u1', 1)], 'u1');
      expect(g!.messageIds, ['u1']);
    });

    test('没有用户那句话的回答（服务端自己开口）：也自成一"轮"', () {
      final g = turnGroupOf([_a('m1', 1)], 'm1');
      expect(g!.messageIds, ['m1']);
    });

    test('分隔线不属于任何一轮（删一轮不许把"你不在的时候"那条线也删了）', () {
      final items = [TimelineMarker(kind: 'away', seq: 1), _u('u1', 2), _a('m1', 3)];
      final groups = turnGroupsOf(items);
      expect(groups.length, 1);
      expect(groups.single.messageIds, ['u1', 'm1']);
    });
  });

  // ── ② 藏起来 ≠ 销毁 ────────────────────────────────────────

  group('三种事件：藏 / 取消藏 / 丢掉（§8.3）', () {
    test('🔴 `turn/deleted` ⇒ 藏起来（屏幕上没有它），但**没销毁**', () {
      final t = Timeline()..applyAll(_turnFacts(userId: 'u1', answerId: 'm1'));
      expect(t.items.length, 2);

      t.apply({'type': 'turn/deleted', 'seq': 5, 'messageIds': ['u1', 'm1']});
      expect(t.items, isEmpty, reason: '藏起来 ⇒ 画不出来了');
      expect(t.isHidden('u1'), true);
      expect(t.isHidden('m1'), true);
      // ⚠️ **不销毁**：取消隐藏就回来，一个字节都不用再要一次网络（§8.3）
      t.showMessages(['u1', 'm1']);
      expect(t.items.length, 2, reason: '★ 还在内存里 —— 销毁了的话恢复就得再要一次网络');
    });

    test('🔴 `turn/restored` ⇒ **立刻**回来（一个字节都不用重发）', () {
      final t = Timeline()..applyAll(_turnFacts(userId: 'u1', answerId: 'm1'));
      t.apply({'type': 'turn/deleted', 'seq': 5, 'messageIds': ['u1', 'm1']});
      t.apply({'type': 'turn/restored', 'seq': 6, 'messageIds': ['u1', 'm1']});

      expect(t.items.length, 2);
      expect(t.items.whereType<AssistantMessage>().single.quick, '这周 7 小时。');
      expect(t.isHidden('m1'), false);
    });

    test('🔴 `turn/purged` ⇒ 从内存里丢掉（取消隐藏也回不来了）', () {
      final t = Timeline()..applyAll(_turnFacts(userId: 'u1', answerId: 'm1'));
      t.apply({'type': 'turn/deleted', 'seq': 5, 'messageIds': ['u1', 'm1']});
      t.apply({'type': 'turn/purged', 'seq': 6, 'messageIds': ['u1', 'm1']});
      // 再有人（错误的补发）说"拿回来了"，也不该凭空空手变出内容
      t.apply({'type': 'turn/restored', 'seq': 7, 'messageIds': ['u1', 'm1']});
      expect(t.items.where((it) => it.messageId == 'm1'), isEmpty);
      expect(t.items.where((it) => it.messageId == 'u1'), isEmpty);
    });

    test('🔴 重发不翻倍：换个 `seq`、同样的 `(messageId, block, seqInBlock)` ⇒ 字只出现一次', () {
      // ⚠️ 服务端"从回收站拿回来"= 把那一轮的内容**按原样重新追加一遍**
      //    （新 `seq`、`at` 原值）。`_seenSeq` 只认 `seq` ⇒ **挡不住这种重发**。
      final t = Timeline()..applyAll(_turnFacts(userId: 'u1', answerId: 'm1'));
      expect(t.items.whereType<AssistantMessage>().single.quick, '这周 7 小时。');

      final resend = _turnFacts(userId: 'u1', answerId: 'm1', from: 50);
      // user/echo 与 message/start 也一起来了（原样重发）
      t.applyAll(resend);
      // ⚠️ 两段文本都重发了：去重靠 `seqInBlock`，不是靠 `seq`
      t.apply(_resend(_turnFacts(userId: 'u1', answerId: 'm1')[2], 60));

      expect(t.items.whereType<AssistantMessage>().single.quick, '这周 7 小时。',
          reason: '★ 同一段正文不许拼两遍');
      expect(t.items.length, 2, reason: '也不许多出一条气泡 / 一句用户的话');
    });

    test('🔴 负向对照：**真的新一段**（`seqInBlock` 没见过的）还得拼上去', () {
      // 少了这条对照，"去重"写过头（把新字也丢了）也照样绿。
      final t = Timeline()..applyAll(_turnFacts(userId: 'u1', answerId: 'm1'));
      t.apply({
        'type': 'message/text',
        'messageId': 'm1',
        'block': 'quick',
        'seqInBlock': 2,
        'text': '另外还有一句。',
        'seq': 60,
      });
      expect(t.items.whereType<AssistantMessage>().single.quick, '这周 7 小时。另外还有一句。');
      // `quick` 与 `deep` 各记各的：同一个 `seqInBlock` 在两个 block 里都合法
      t.apply({
        'type': 'message/text',
        'messageId': 'm1',
        'block': 'deep',
        'seqInBlock': 1,
        'text': '答案的详细那一段。',
        'seq': 61,
      });
      final m = t.items.whereType<AssistantMessage>().single;
      expect(m.quick, '这周 7 小时。另外还有一句。');
      expect(m.deep, '答案的详细那一段。');
    });

    test('重发的另外三种事件**已经是幂等的**（契约点名的、顺手核一遍）', () {
      final t = Timeline()..applyAll(_turnFacts(userId: 'u1', answerId: 'm1'));
      final before = t.items.map((it) => it.messageId).toList();
      final uSeq = t.items.whereType<UserUtterance>().single.seq;
      final mSeq = t.items.whereType<AssistantMessage>().single.seq;

      t.applyAll(_turnFacts(userId: 'u1', answerId: 'm1', from: 50));

      expect(t.items.map((it) => it.messageId).toList(), before,
          reason: '`message/start` 有 `_findMessage` 挡着 ⇒ 不许再多一条气泡');
      expect(t.items.whereType<UserUtterance>().single.seq, uSeq,
          reason: '★ 已认领的那句**不许被重发的号搬家**（搬了它就跳到回答后面去了）');
      expect(t.items.whereType<AssistantMessage>().single.seq, mSeq);
      expect(t.items.whereType<AssistantMessage>().single.ended, true);
      expect(t.items.whereType<AssistantMessage>().single.reason, 'completed');
      expect(t.items.whereType<UserUtterance>().single.state, MessageState.confirmed);
    });

    test('🔴 冷启动之后恢复：重发的几条（新 `seq`）把那一轮带回来、而且只出现一次', () async {
      final local = TimelineStore();
      final c = _controller(local: local);
      await c.start(token: 'tok', openStream: false);
      for (final e in _turnFacts(userId: 'u1', answerId: 'm1')) {
        c.ingest(e);
      }
      // 删掉：本机缓存里那几条跟着清（§四 🔴）
      c.ingest({'type': 'turn/deleted', 'seq': 90, 'messageIds': ['u1', 'm1']});
      await local.flush();
      expect((await local.load()).where((e) => e['messageId'] == 'm1'), isEmpty);

      // ★ 冷启动：本机那一屏里已经没有那几条了（这正是 ④.1 说的那个状态）
      final back = _controller(local: TimelineStore());
      await back.start(token: 'tok', openStream: false);
      expect(back.items.where((it) => it.messageId == 'm1'), isEmpty);

      // 服务端：先落一条"拿回来了"，再把内容**按原样重新追加**（新 `seq`）
      back.ingest({'type': 'turn/restored', 'seq': 95, 'messageIds': ['u1', 'm1']});
      for (final e in _turnFacts(userId: 'u1', answerId: 'm1', from: 96)) {
        back.ingest(e);
      }

      final answers = back.items.whereType<AssistantMessage>().toList();
      expect(answers.length, 1, reason: '★ 那一轮回来了（只一条气泡）');
      expect(answers.single.quick, '这周 7 小时。', reason: '★ 而且只出现一次');
      expect(back.items.whereType<UserUtterance>().single.state, MessageState.confirmed);
    });
    test('🔴 墓碑**比条目先到**也要挡住（重放时就是这个顺序）', () {
      // 契约 §三：读取/补发时服务端把被删的那一轮**过滤掉**，
      // 但客户端缓存里可能还留着它 —— 而墓碑可能先被应用。
      final t = Timeline();
      t.apply({'type': 'turn/deleted', 'seq': 5, 'messageIds': ['u1', 'm1']});
      t.applyAll(_turnFacts(userId: 'u1', answerId: 'm1'));
      expect(t.items, isEmpty, reason: '★ 先到的墓碑必须挡住后到的条目');
    });

    test('认不出的载荷 ⇒ **什么都不做**（宁可不动，也不许凭猜删东西）', () {
      final t = Timeline()..applyAll(_turnFacts(userId: 'u1', answerId: 'm1'));
      t.apply({'type': 'turn/deleted', 'seq': 5}); // 没有 messageIds
      t.apply({'type': 'turn/deleted', 'seq': 6, 'messageIds': 'u1'}); // 形状不对
      t.apply({'type': 'turn/deleted', 'seq': 7, 'messageIds': ['', 42, null]});
      expect(t.items.length, 2, reason: '载荷认不出来 ⇒ 一个都不许藏');
      expect(Timeline.messageIdsOfEvent(const {}), isEmpty);
      expect(Timeline.messageIdsOfEvent(const {'messageIds': []}), isEmpty);
    });

    test('删的那条正在说着 ⇒ 过程那一块跟着撤（不留"它正在做…"）', () {
      final t = Timeline()
        ..apply({'type': 'message/status', 'turn': 1, 'state': 'started'})
        ..apply({'type': 'message/start', 'messageId': 'm1', 'seq': 1});
      expect(t.agentLine, isNotNull);

      t.apply({'type': 'turn/deleted', 'seq': 2, 'messageIds': ['m1']});
      expect(t.agentLine, isNull, reason: '那一轮已经不在屏幕上了，不许再说"它正在做"');
    });

    test('分隔线**永远画得出来**（它没有 messageId，不属于任何一轮）', () {
      final t = Timeline()..apply({'type': 'timeline/marker', 'kind': 'away', 'seq': 1});
      t.apply({'type': 'turn/deleted', 'seq': 2, 'messageIds': ['u1', 'm1']});
      expect(t.items.length, 1);
    });

    test('`reset()` 之后谁被删过也从头来（墓碑本身也落盘，重放会给回来）', () {
      final t = Timeline()..applyAll(_turnFacts(userId: 'u1', answerId: 'm1'));
      t.apply({'type': 'turn/deleted', 'seq': 5, 'messageIds': ['u1', 'm1']});
      t.reset();
      expect(t.isHidden('m1'), false);
      expect(t.items, isEmpty, reason: 'reset 本来就把服务端来的条目全清了');
    });
  });

  // ── ③ 本机那两份跟着清（🔴 这一件的判据）────────────────────

  group('🔴 删完之后：屏幕上（含冷启动那一屏）不许再出现那一轮的任何字', () {
    test('事件到了 ⇒ 内存藏起来 + 缓存里那一屏清掉 + 草稿跟着清 + **冷启动也没有**', () async {
      final shared = TimelineStore();
      final drafts = DraftStore();
      final c = _controller(
        local: shared,
        drafts: drafts,
        client: MockClient((_) async => http.Response('{"ok":true,"duplicate":false,"seq":8}', 200)),
      );
      await c.start(token: 'tok', openStream: false);

      // 上一次开机存下来的那一屏（服务端事实）
      for (final e in _turnFacts(userId: 'u1', answerId: 'm1')) {
        c.ingest(e);
      }
      // 还有一句"我打了、还没被认领"的话（它属于本机存档那一份）
      // ⚠️ 走真入口（`send`）⇒ 存档那一步是它自己落的
      await c.send('这句还没发出去');
      final draftId = c.items.whereType<UserUtterance>().last.messageId;
      await drafts.flush();
      expect((await drafts.load()).map((d) => d.messageId), contains(draftId));

      // ★ 删掉那一轮（服务端那三个事件之一）
      c.ingest({
        'type': 'turn/deleted',
        'seq': 90,
        'messageIds': ['u1', 'm1'],
      });
      await drafts.flush();
      await shared.flush();

      // ① 这一屏：一个字都没有
      expect(c.items.where((it) => it.messageId == 'u1' || it.messageId == 'm1'), isEmpty);

      // ② 缓存里：属于那一轮的事实一条不剩；**墓碑自己必须留着**
      final cached = await TimelineStore().load();
      expect(
        cached.where((e) => e['messageId'] == 'u1' || e['messageId'] == 'm1'),
        isEmpty,
        reason: '★ 缓存里还留着的话，下一次开机就又画出来了',
      );
      expect(cached.any((e) => e['type'] == 'turn/deleted'), true,
          reason: '墓碑是"谁被删过"的唯一凭据，不许被顺手清掉');

      // ③ 草稿：相关的跟着清（从"画得出来的那些"重算出来的）
      final left = await drafts.load();
      expect(left.map((d) => d.messageId), [draftId],
          reason: '不相干的那句必须留着（清多了就是把用户打好的字弄丢了）');

      // ④ ★ **冷启动那一屏**：换一个控制器、只从本机读
      final back = _controller(local: TimelineStore(), drafts: DraftStore());
      await back.start(token: 'tok', openStream: false);
      expect(
        back.items.where((it) => it.messageId == 'u1' || it.messageId == 'm1'),
        isEmpty,
        reason: '★ 冷启动就是拿本机缓存先画的那一屏——它也不许出现那一轮的字',
      );
      expect(back.items.whereType<UserUtterance>().single.messageId, draftId,
          reason: '自己没发出去的那句必须还在（欠账 18）');
    });

    test('🔴 属于那一轮的**草稿**也清（比如那句还没被认领，另一台设备把它删了）', () async {
      final drafts = DraftStore();
      final c = _controller(
        drafts: drafts,
        client: MockClient((_) async => http.Response('{"ok":true,"duplicate":false,"seq":5}', 200)),
      );
      await c.start(token: 'tok', openStream: false);
      await c.send('我打了还没认领的一句');
      await drafts.flush();
      final id = c.items.whereType<UserUtterance>().single.messageId;
      expect((await drafts.load()).map((d) => d.messageId), [id]);

      c.ingest({'type': 'turn/deleted', 'seq': 9, 'messageIds': [id]});
      await drafts.flush();
      expect(await drafts.load(), isEmpty, reason: '★ 删掉的那一轮里的话不许留在本机存档里');
      expect(c.items, isEmpty);
    });

    test('删除**没做成**时本机一个字节都不许动（网不通 ≠ 删掉了）', () async {
      final c = _controller(
        client: MockClient((_) async => http.Response('{"error":"boom"}', 500)),
      );
      await c.start(token: 'tok', openStream: false);
      for (final e in _turnFacts(userId: 'u1', answerId: 'm1')) {
        c.ingest(e);
      }
      final r = await c.removeTurn(['u1', 'm1']);
      expect(r, isA<TrashFailed<bool>>());
      expect(c.items.length, 2, reason: '服务端说没删成 ⇒ 屏幕上那条必须还在');
      await c.local.flush();
      expect((await c.local.load()).length, 4, reason: '缓存也不许动');
    });

    test('删成功之后就地清（不等 WS 那一帧——断线时它永远不来）', () async {
      final local = TimelineStore();
      final c = _controller(
        local: local,
        client: MockClient((r) async {
          if (r.url.path == '/api/trash/remove') {
            return http.Response('{"ok":true,"messageIds":["u1","m1"],"purgeAt":1}', 200);
          }
          return http.Response('{}', 200);
        }),
      );
      await c.start(token: 'tok', openStream: false);
      for (final e in _turnFacts(userId: 'u1', answerId: 'm1')) {
        c.ingest(e);
      }
      final r = await c.removeTurn(['u1', 'm1']);
      expect(r, isA<TrashOk<bool>>());
      expect(c.items, isEmpty);
      await c.local.flush();
      expect((await c.local.load()).where((e) => e['messageId'] == 'm1'), isEmpty);
    });

    test('恢复：服务端那一帧没到也立刻回来（幂等）', () async {
      final c = _controller(
        client: MockClient((r) async => r.url.path == '/api/trash/restore'
            ? http.Response('{"ok":true}', 200)
            : http.Response('{}', 200)),
      );
      await c.start(token: 'tok', openStream: false);
      for (final e in _turnFacts(userId: 'u1', answerId: 'm1')) {
        c.ingest(e);
      }
      c.ingest({'type': 'turn/deleted', 'seq': 90, 'messageIds': ['u1', 'm1']});
      expect(c.items, isEmpty);

      final r = await c.restoreTurn(['u1', 'm1']);
      expect(r, isA<TrashOk<bool>>());
      expect(c.items.length, 2, reason: '拿回来要立刻');
    });
  });

  // ── 接口那一层（§8.2）──────────────────────────────────────

  group('五个入口：路径 / 令牌头 / confirm', () {
    Future<List<http.Request>> calls(
      Future<void> Function(Api api) run, {
      String body = '{"ok":true,"messageIds":["u1","m1"],"items":[],"purgeAt":1,"ttlDays":30}',
    }) async {
      final seen = <http.Request>[];
      final api = Api(
        client: MockClient((r) async {
          seen.add(r);
          return _json(body, 200);
        }),
      );
      await run(api);
      return seen;
    }

    test('🔴 五个方法**都带令牌头**，而且令牌不进 URL', () async {
      final seen = await calls((api) async {
        await api.trashPlan(messageIds: ['u1', 'm1'], token: 'tok');
        await api.trashRemove(messageIds: ['u1', 'm1'], token: 'tok');
        await api.trashList(token: 'tok');
        await api.trashRestore(messageIds: ['u1', 'm1'], token: 'tok');
        await api.trashPurge(messageIds: ['u1', 'm1'], token: 'tok');
      });
      expect(seen.map((r) => r.url.path), [
        '/api/trash/plan',
        '/api/trash/remove',
        '/api/trash',
        '/api/trash/restore',
        '/api/trash/purge',
      ]);
      for (final r in seen) {
        final auth = r.headers['authorization'] ?? r.headers['Authorization'];
        expect(auth, 'Bearer tok', reason: '${r.url.path} 没带令牌头');
        expect(r.url.toString().contains('tok'), false, reason: '令牌不许进 URL');
      }
      // `plan` 只读 ⇒ 不许带 confirm；`remove` / `purge` 必须带（少它就是 400）
      expect(jsonDecode(seen[0].body), {'messageIds': ['u1', 'm1']});
      expect(jsonDecode(seen[1].body), {'messageIds': ['u1', 'm1'], 'confirm': true});
      expect(jsonDecode(seen[3].body), {'messageIds': ['u1', 'm1']});
      expect(jsonDecode(seen[4].body), {'messageIds': ['u1', 'm1'], 'confirm': true});
    });

    test('plan 的回执 → 清单（逐条都在，含"删不掉"那条）', () async {
      final api = Api(
        client: MockClient((_) async => _json(
              jsonEncode({
                'messageIds': ['u1', 'm1'],
                'items': [
                  {'what': '可见的那几句', 'where': '这台设备', 'verdict': 'delete', 'note': '删得掉'},
                  {
                    'what': '它记住的那一段',
                    'where': '记忆里',
                    'verdict': 'cannot',
                    'note': '要等这段记忆被重建',
                  },
                ],
                'purgeAt': 1758400000000,
                'ttlDays': 30,
              }),
              200,
            )),
      );
      final a = await api.trashPlan(messageIds: ['u1'], token: 'tok');
      expect(a, isA<TrashOk<TrashPlan>>());
      final plan = (a as TrashOk<TrashPlan>).value;
      expect(plan.messageIds, ['u1', 'm1']);
      expect(plan.items.map((i) => i.what), ['可见的那几句', '它记住的那一段']);
      expect(plan.items[1].cannot, true);
      expect(plan.hasCannot, true, reason: '★ 有它 ⇒ 屏幕上不许说"已全部删除"');
      expect(plan.ttlDays, 30);
    });
  });

  group('回执解析（纯函数）', () {
    test('三种结果不许混：200 成功 / 401 令牌 / 其余失败', () {
      final ok = trashAnswerOf<int>(200, '{"n":1}', (j) => (j['n'] as num).toInt());
      expect((ok as TrashOk<int>).value, 1);
      expect(trashAnswerOf<int>(401, '{}', (j) => 0), isA<TrashUnauthorized<int>>());
      expect(trashAnswerOf<int>(500, '{}', (j) => 0), isA<TrashFailed<int>>());
      expect(trashAnswerOf<int>(400, '{}', (j) => 0), isA<TrashFailed<int>>());
      // 200 但回执坏了 ⇒ **当失败**（不许把坏东西当成功 —— 删是破坏性动作）
      expect(trashAnswerOf<int>(200, '这不是 JSON', (j) => 0), isA<TrashFailed<int>>());
      expect(trashAnswerOf<int>(200, '[1,2]', (j) => 0), isA<TrashFailed<int>>());
    });

    test('清单：缺字段不抛，逐条读出来', () {
      final p = trashPlanFrom(const {
        'messageIds': ['u1', 'm1'],
        'items': [
          {'what': '可见的那几句', 'where': '这台设备', 'verdict': 'delete', 'note': ''},
          {'what': '它记住的', 'where': '记忆里', 'verdict': 'cannot', 'note': '要等记忆被重建'},
        ],
        'purgeAt': 1758400000000,
        'ttlDays': 30,
      });
      expect(p.messageIds, ['u1', 'm1']);
      expect(p.items.length, 2);
      expect(p.items[0].cannot, false);
      expect(p.items[1].cannot, true);
      expect(p.hasCannot, true);
      expect(p.ttlDays, 30);
      // 缺东西 / 类型不对 ⇒ 不抛，给最保守的值
      final empty = trashPlanFrom(const {});
      expect(empty.items, isEmpty);
      expect(empty.messageIds, isEmpty);
      expect(empty.purgeAt, isNull);
      expect(empty.hasCannot, false);
      expect(trashPlanFrom(const {'messageIds': 'u1', 'items': 'x'}).messageIds, isEmpty);
    });

    test('🔴 `verdict` 认不出来 ⇒ 按**删不掉**显示（fail-closed）', () {
      expect(const TrashPlanItem(what: '', where: '', verdict: 'wat', note: '').cannot, true);
      expect(const TrashPlanItem(what: '', where: '', verdict: '', note: '').cannot, true);
      expect(const TrashPlanItem(what: '', where: '', verdict: 'delete', note: '').cannot, false);
    });

    test('回收站条目：读得出来，坏行跳过', () {
      final list = trashEntriesFrom(const {
        'items': [
          {'messageIds': ['u1', 'm1'], 'at': 1, 'purgeAt': 2, 'preview': '帮我把这周工时记一下'},
          'x',
          {'preview': '没有 id 的'},
        ],
      });
      expect(list.length, 2);
      expect(list[0].preview, '帮我把这周工时记一下');
      expect(list[0].usable, true);
      expect(list[1].usable, false, reason: '一个 id 都没有 ⇒ 不给那两个按钮，也不发空请求');
    });

    test('🔴 清缓存用的那个纯函数：只去掉这几个 id', () {
      final facts = [
        {'type': 'user/echo', 'seq': 1, 'messageId': 'u1'},
        {'type': 'message/start', 'seq': 2, 'messageId': 'm1'},
        {'type': 'user/echo', 'seq': 3, 'messageId': 'u2'},
        {'type': 'turn/deleted', 'seq': 4, 'messageIds': ['u1', 'm1']},
      ];
      final kept = withoutMessages(facts, {'u1', 'm1'});
      expect(kept.map((e) => e['type']), ['user/echo', 'turn/deleted']);
      expect(kept.last['messageId'], isNull, reason: '墓碑那种事件没有 messageId ⇒ 它留下');
    });
  });

  // ── 屏幕上那些字 ───────────────────────────────────────────

  group('这一批新加的人话', () {
    test('verdict 翻成人话（认不出来 ⇒ 删不掉）', () {
      expect(verdictLabel('delete'), '会删掉');
      expect(verdictLabel('cannot'), '删不掉');
      expect(verdictLabel('wat'), '删不掉');
    });

    test('留多久 / 什么时候彻底删掉（数从服务端来，读不出就只说"过一阵子"）', () {
      expect(planTtlLine(30), contains('30 天'));
      expect(planTtlLine(null), contains('过一阵子'));
      expect(planTtlLine(0), contains('过一阵子'));
      expect(purgeAtLine(1758400000000), startsWith('彻底删掉的时间：'));
      expect(purgeAtLine(null), isEmpty);
    });

    test('日期是本地那一天（不引依赖）', () {
      // 用"本地时间构造出来的那一刻"反推，避免测试里写死一个时区
      final d = DateTime(2026, 9, 21, 12);
      expect(dateOf(d.millisecondsSinceEpoch), '2026-09-21');
      expect(dateOf(DateTime(2026, 1, 2, 3).millisecondsSinceEpoch), '2026-01-02');
    });

    test('清单一项的标题：没有"在哪儿"就只说"哪一样"', () {
      expect(planItemTitle('可见的那几句', '这台设备'), '可见的那几句（这台设备）');
      expect(planItemTitle('可见的那几句', ''), '可见的那几句');
      expect(planItemTitle('', '这台设备'), '这台设备');
    });

    test('🔴 新加的这些文案一条都不许带内部词', () {
      final copies = [
        trashTitle,
        trashTooltip,
        bubbleMenuTitle,
        bubbleMenuDelete,
        bubbleMenuDeleteHint,
        bubbleMenuCancel,
        bubbleMenuCopy,
        bubbleMenuSelect,
        bubbleSelectCount(0),
        bubbleSelectCount(2),
        bubbleSelectCancel,
        bubbleCopiedLine,
        bubbleCopiedManyLine(2),
        bubbleCopyEmptyLine,
        bubbleCopyFailedLine,
        planTitle,
        planCancel,
        planConfirm,
        planCannotLine,
        planEmptyLine,
        trashEmptyLine,
        trashNoPreviewLine,
        trashLoadFailedLine,
        trashRetry,
        trashRestore,
        trashPurge,
        trashPurgeConfirmTitle,
        trashPurgeConfirmBody,
        trashPurgeConfirmYes,
        trashPurgeConfirmNo,
        trashDeletedLine,
        trashRestoredLine,
        trashPurgedLine,
        trashDeleteFailedLine,
        trashRestoreFailedLine,
        trashPurgeFailedLine,
        trashPlanFailedLine,
        trashUnauthorizedLine,
        planTtlLine(30),
        planTtlLine(null),
        purgeAtLine(1758400000000),
        verdictLabel('delete'),
        verdictLabel('cannot'),
      ];
      for (final c in copies) {
        final hits = scanForbidden(c);
        expect(hits, isEmpty, reason: '「$c」里有禁用词：$hits');
      }
    });

    test('🔴 文案里不许出现"轮"（内部概念 —— 协议里那个 turn）', () {
      // ⚠️ 为什么单钉一条而不是加进那张禁用词表：表是**子串**匹配，
      //    "轮"会误伤"轮流 / 轮到你了"那类正常说法 ⇒ 加进去迟早被绕过。
      //    这一批的文案一个字都不该用到它。
      final copies = [
        bubbleMenuTitle,
        bubbleMenuDelete,
        bubbleMenuDeleteHint,
        bubbleMenuCancel,
        bubbleMenuCopy,
        bubbleMenuSelect,
        bubbleSelectCount(2),
        bubbleSelectCancel,
        bubbleCopiedLine,
        bubbleCopiedManyLine(2),
        bubbleCopyEmptyLine,
        bubbleCopyFailedLine,
        planTitle,
        planCancel,
        planConfirm,
        planCannotLine,
        planEmptyLine,
        planTtlLine(30),
        planTtlLine(null),
        purgeAtLine(1758400000000),
        verdictLabel('delete'),
        verdictLabel('cannot'),
        planItemTitle('可见的那几句', '这台设备'),
        trashTitle,
        trashTooltip,
        trashEmptyLine,
        trashNoPreviewLine,
        trashLoadFailedLine,
        trashRetry,
        trashRestore,
        trashPurge,
        trashPurgeConfirmTitle,
        trashPurgeConfirmBody,
        trashPurgeConfirmYes,
        trashPurgeConfirmNo,
        trashDeletedLine,
        trashRestoredLine,
        trashPurgedLine,
        trashDeleteFailedLine,
        trashRestoreFailedLine,
        trashPurgeFailedLine,
        trashPlanFailedLine,
        trashUnauthorizedLine,
      ];
      for (final c in copies) {
        expect(c.contains('轮'), false, reason: '「$c」里有内部概念"轮"：说人话');
      }
      expect(bubbleMenuTitle, isNot(contains('轮')));
    });
  });
}
