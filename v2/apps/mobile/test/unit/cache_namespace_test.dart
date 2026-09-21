// 本机缓存的**命名空间**：按人分、退出时清干净（多租户第 2 件）。
//
// 契约依据：`docs/dev/38-ISOLATION-SPLIT.md` §8.1（读到的代码事实）、
// §8.2（不分命名空间的后果）、§8.6（判据）。
//
// ── 为什么这一份是**硬需求**，不是优化 ────────────────────
// 服务端那边已经按人分开了（`worlds.js`），但只要客户端的缓存还共用一份：
//   **B 登录后会先看到 A 的整屏 + A 打了一半的草稿**，他一发，
//   那句话就进了另一个人的账本。⇒ 服务端分开了、客户端没分 = **还是串**。
//
// ── 这一份钉四条 ──────────────────────────────────────────
//   1. 令牌里的 `sub` 读得对、读不出**就 `null`**（不猜）；
//   2. `sub` 是**不可信输入**（客户端**不验签**）⇒ 形状卡死；
//   3. 两个账号 ⇒ 两份互不可见的缓存；
//   4. 🔴 退出登录清的是**全部命名空间**，不只是自己那份
//      （**共用设备**上只清自己那份 = 等于没清）；
//   5. 过程档位**不清**（它是设备级偏好，不是账号数据）。
//
// ⚠️ 不写界面断言（项目纪律：纯逻辑进 `test/unit`）。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/token_sub.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/draft_store.dart';
import 'package:hupo_app/services/process_level_store.dart';
import 'package:hupo_app/services/timeline_store.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 照**服务端那个形状**造一个令牌：`<base64url(payload)>.<签名>`。
///
/// ⚠️ 刻意**不带 padding** —— Node 的 `Buffer.toString('base64url')` 不打
///    `=`，而 dart 的 `base64Url.decode` **要求**打。少这一步真令牌一律解不开，
///    所以这一条本身也是判据（见下面「真令牌的形状」那组）。
String tokenWith(Map<String, dynamic> payload, {String sig = 'sig'}) {
  final body = base64Url.encode(utf8.encode(jsonEncode(payload))).replaceAll('=', '');
  return '$body.$sig';
}

String tokenForSub(String sub) =>
    tokenWith({'sub': sub, 'iat': 1, 'exp': 99999999999999, 'jti': 'j-1'});

/// 一个"什么都不做也答应"的假服务端（这一份不测网络）。
Api fakeApi() => Api(client: MockClient((_) async => http.Response('{}', 200)));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('从令牌里读出是谁（纯函数）', () {
    test('★ 真令牌的形状：**不带 padding** 的 base64url 也要解得开', () {
      final t = tokenForSub('u1');
      expect(t.split('.').first.contains('='), false, reason: '构造的令牌不该带 padding');
      expect(subFromToken(t), 'u1');
    });

    test('🔴 读不出来一律 `null`（**不许猜**）', () {
      final bad = <String?, String>{
        null: 'null',
        '': '空串',
        'noseparator': '没有那个点',
        '.onlysig': '点前面是空的',
        'not-base64!!.sig': '不是 base64',
        '${base64Url.encode(utf8.encode('不是 json'))}.sig': '解出来不是 JSON',
        '${base64Url.encode(utf8.encode('[1,2,3]'))}.sig': 'JSON 但不是对象',
        '${base64Url.encode(utf8.encode('{"iat":1}'))}.sig': '没有 sub',
        '${base64Url.encode(utf8.encode('{"sub":123}'))}.sig': 'sub 不是字符串',
        '${base64Url.encode(utf8.encode('{"sub":""}'))}.sig': 'sub 是空串',
      };
      bad.forEach((token, why) {
        expect(subFromToken(token), null, reason: why);
      });
    });

    test('🔴 `sub` 是**不可信输入**：形状不对一律不要（客户端不验签）', () {
      // 这一条是"纪律 3"的落点：令牌**没有验过签**，所以这段字节是请求方可控的。
      // 放宽一位，一个被改过的令牌就能让它变成一个奇怪的 prefs 键。
      for (final evil in [
        '../x',
        'a/b',
        'a.b',
        'a b',
        r'a\b',
        'a:b',
        'u1' * 40, // 128 字符 > 64
        '中文',
        'u\u0000x',
      ]) {
        expect(subFromToken(tokenWith({'sub': evil})), null, reason: '不该接受 $evil');
      }
      // 正对照：**合法形状**要接受（否则上面那一串可能只是因为"函数坏了"）
      for (final ok in ['u1', 'owner', 'u_9f2c1a', 'A-b_C', 'x' * 64]) {
        expect(subFromToken(tokenWith({'sub': ok})), ok, reason: '$ok 是合法形状');
      }
    });

    test('命名空间：读得出用 `sub`，读不出退回**旧的那个默认值**', () {
      expect(cacheNamespaceOf(tokenForSub('u1')), 'u1');
      expect(cacheNamespaceOf('garbage'), cacheNamespaceFallback);
      expect(cacheNamespaceOf(null), cacheNamespaceFallback);
      // 🔴 兜底**不许**与任何真人的键相同（否则"读不出"就变成了"看见别人的"）。
      //    真人的键是 `sub`：`owner` / `u1` / `u2` / …
      for (final u in ['owner', 'u1', 'u2', 'u_9f2c1a']) {
        expect(cacheNamespaceFallback, isNot(equals(u)), reason: '兜底不许撞上 $u');
      }
      // ⚠️ 它**故意**等于多租户之前那个默认值（见 `token_sub.dart` 里那段说明）：
      //    读不出身份时退回旧行为，而不是让老设备上的旧缓存凭空消失。
      expect(cacheNamespaceFallback, 'single');
    });
  });

  group('两个账号 ⇒ 两份互不可见的缓存', () {
    test('★ 换个人登录：命名空间跟着令牌走', () async {
      final tokens = TokenStore();
      final c = ChatController(api: fakeApi(), tokens: tokens, local: _store(), drafts: _drafts());

      await c.start(token: tokenForSub('u1'), openStream: false);
      expect(c.local.namespace, 'u1');
      expect(c.drafts.namespace, 'u1');

      await c.logout();
      await c.start(token: tokenForSub('u2'), openStream: false);
      expect(c.local.namespace, 'u2', reason: '★ 换了个人 ⇒ 换一份缓存');
      expect(c.drafts.namespace, 'u2');
    });

    test('🔴 甲的缓存，乙那边**一条都读不到**（真写盘、真读盘）', () async {
      final a = _store()..namespace = 'u1';
      await a.save([
        {'type': 'message/text', 'seq': 1, 'messageId': 'm1', 'text': '甲的暗号'},
      ]);
      await a.flush();

      final b = _store()..namespace = 'u2';
      expect(await b.load(), isEmpty, reason: '🔴 乙不许看见甲那一屏');

      // 负向对照：甲自己读得到（证明不是"缓存根本没在写"）
      expect((await a.load()).length, 1, reason: '负向对照：甲自己必须读得到');
    });
  });

  group('🔴 退出登录：清的是**全部命名空间**，不只是自己那份', () {
    test('共用设备：盘上留着**别人的**那份，退出时必须一起清掉', () async {
      // 造出"这台机器上另一个人留下的缓存"（完全模拟真机：键就在 prefs 里）
      final pre = await SharedPreferences.getInstance();
      await pre.setStringList('${TimelineStore.keyPrefix}u9', ['{"seq":1}']);
      await pre.setStringList('${DraftStore.keyPrefix}u9', ['{"text":"他打了一半的话"}']);
      expect(pre.getKeys().where((k) => k.startsWith(TimelineStore.keyPrefix)).length, 1);

      final c = ChatController(
        api: fakeApi(), tokens: TokenStore(), local: _store(), drafts: _drafts(),
      );
      await c.start(token: tokenForSub('u1'), openStream: false);
      await c.logout();
      // 两边的队列都追平，再读盘（控制器里那几下是**不 await** 的）
      await c.local.flush();
      await c.drafts.flush();

      final left = pre.getKeys()
          .where((k) =>
              k.startsWith(TimelineStore.keyPrefix) || k.startsWith(DraftStore.keyPrefix))
          .toList();
      expect(left, isEmpty, reason: '🔴 退出之后盘上**一条缓存都不许剩**；实际剩 $left');
    });

    test('★ 负向对照：不清的话它**确实还在**（证明上一条不是空跑）', () async {
      final pre = await SharedPreferences.getInstance();
      await pre.setStringList('${TimelineStore.keyPrefix}u9', ['{"seq":1}']);
      // ⚠️ 这里**故意不**调用任何清理：只证明"写进去的东西真的在盘上"
      expect(pre.getKeys().where((k) => k.startsWith(TimelineStore.keyPrefix)).length, 1);
    });

    test('★ 过程档位**不清**（它是设备级偏好，不是账号数据）', () async {
      final levels = ProcessLevelStore();
      await levels.write(ProcessLevel.reasoning);
      final c = ChatController(
        api: fakeApi(), tokens: TokenStore(), local: _store(), drafts: _drafts(), levels: levels,
      );
      await c.start(token: tokenForSub('u1'), openStream: false);
      await c.logout();
      expect(await levels.read(), ProcessLevel.reasoning, reason: '档位不该被退出登录清掉');
    });
  });
}

// ── 小工具：两个 store（**每次都新建一份**，模拟"换一台/换一次启动"）──
// ⚠️ 用**真类型**而不是 mock：这一份要验的就是"真的落进 `SharedPreferences` 的那些键"
//    （`keyPrefix` + 命名空间）。mock 掉就没有键可言了。
TimelineStore _store() => TimelineStore();
DraftStore _drafts() => DraftStore();
