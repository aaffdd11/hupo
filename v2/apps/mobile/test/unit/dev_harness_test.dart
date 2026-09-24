// **「在浏览器里打开那一台」这个次要入口的纯逻辑**
// （契约 `docs/dev/82-DEV-MODE.md` §五）。
//
// ── 这一份钉什么（都在客户端这一侧算得出来的地方）──────────────
//   ① **回执解析**：200 + `{url, expiresAt}` ⇒ 能用；200 但缺字段 ⇒ 当失败；
//      🔴 **非 200（含 403）⇒ 没被标** ⇒ 界面**不许画按钮**；
//   ② 🔴 **那条 url 原样**（服务端现签的入口：不许自己拼、不许改参数）；
//   ③ **过期判定 + 缓存**：`expiresAt` 快到了就不用它，取回来缓存住、过期/点了失败重取；
//   ④ **取数那一条路**：`GET /api/dev-harness`、令牌走 `authorization` 头、令牌不进 URL。
//
// ⚠️ 纯逻辑（不起网络、不 pump 界面）⇒ 进 `test/unit` 硬闸。
//    界面上那几档的画法在 `test/widget/harness_test.dart`（提示档），
//    "五档不溢出 + 命中区 ≥44"在 `test/widget/accessibility_test.dart`（**硬闸**）。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/dev_harness.dart';
import 'package:hupo_app/models/dev_harness_words.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/dev_harness_client.dart';

/// 一条像服务端真会给的地址（**带签名那三个参数**）。
const _url =
    'https://dsh19145526557.stalkerai.cn/__enter?u=u-1&e=1789000000000&s=abc123';

http.Response _json(String body, int status) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

void main() {
  // ── ① 回执解析 ─────────────────────────────────────────────

  group('回执 → 结果（纯函数）', () {
    test('200 + 两个字段都在 ⇒ 能用，而且 url / 到期时刻都要读回来', () {
      final o = devHarnessOutcomeOf(
        200,
        jsonEncode({'url': _url, 'expiresAt': 1789000000000}),
      );
      expect(o, isA<DevHarnessReady>());
      final link = (o as DevHarnessReady).link;
      expect(link.url, _url, reason: '★ 必须**原样**（不许自己拼、不许改参数）');
      expect(link.expiresAt, 1789000000000, reason: '到期时刻不是摆设');
    });

    test('🔴 那条 url 一个字符都不改（前后空格也不替它去掉）', () {
      final raw = '  $_url  ';
      final o = devHarnessOutcomeOf(200, jsonEncode({'url': raw, 'expiresAt': 1}));
      expect((o as DevHarnessReady).link.url, raw);
    });

    test('200 但缺 url / 缺 expiresAt / 类型不对 / 解不开 ⇒ 当失败', () {
      final bad = <String>[
        '{"expiresAt":1}',
        '{"url":""}',
        '{"url":"   "}',
        '{"url":123,"expiresAt":1}',
        '{"url":"$_url"}',
        '{"url":"$_url","expiresAt":"明天"}',
        '[]',
        '不是 JSON',
      ];
      for (final b in bad) {
        final o = devHarnessOutcomeOf(200, b);
        expect(o, isA<DevHarnessMalformed>(), reason: '「$b」不该算拿到');
      }
    });

    test('🔴 非 200（没被标 / 别人 / 服务端不收）⇒ NotMarked，**不是**网的问题', () {
      for (final code in [201, 204, 400, 403, 404, 500, 503]) {
        expect(
          devHarnessOutcomeOf(code, ''),
          isA<DevHarnessNotMarked>(),
          reason: 'HTTP $code 该算"没被标"',
        );
      }
      expect((devHarnessOutcomeOf(403, '') as DevHarnessNotMarked).status, 403);
    });
  });

  // ── ② 过期判定与缓存 ───────────────────────────────────────

  group('过期判定（留余量）与缓存', () {
    const link = DevHarnessLink(url: _url, expiresAt: 200000);

    test('还早 ⇒ 能用；快到了（余量以内）⇒ 不用它', () {
      expect(devHarnessFresh(link, 0), isTrue);
      expect(devHarnessFresh(link, 200000 - devHarnessSlackMs - 1), isTrue);
      expect(devHarnessFresh(link, 200000 - devHarnessSlackMs), isFalse);
      expect(devHarnessFresh(link, 200000), isFalse);
      expect(devHarnessFresh(link, 300000), isFalse);
    });

    test('服务端没给到期时间（<= 0）⇒ 没得判，照用', () {
      const far = 9000000000000;
      expect(devHarnessFresh(const DevHarnessLink(url: _url, expiresAt: 0), far), isTrue);
      expect(devHarnessFresh(const DevHarnessLink(url: _url, expiresAt: -1), far), isTrue);
    });

    test('缓存：存了就能拿；过期了就拿不到，而且**顺手丢掉**', () {
      final c = DevHarnessCache();
      expect(c.freshAt(0), isNull);
      c.save(link);
      expect(c.freshAt(1000)?.url, _url);
      expect(c.freshAt(200000), isNull, reason: '过期了不许再给');
      expect(c.freshAt(1000), isNull, reason: '过期那一下该把它丢掉（不许又冒出来）');
    });

    test('clear（点了失败）⇒ 下次拿不到', () {
      final c = DevHarnessCache()..save(link);
      c.clear();
      expect(c.freshAt(1000), isNull);
    });
  });

  // ── ③ 该画什么（**按钮只在那两档**）────────────────────────

  group('那一条画什么', () {
    final ready = devHarnessOutcomeOf(200, jsonEncode({'url': _url, 'expiresAt': 1}));

    test('🔴 非 200 ⇒ 只有一句普通话，**没有按钮**', () {
      for (final o in [const DevHarnessNotMarked(403), const DevHarnessNotMarked(500)]) {
        final v = devEntryViewOf(canOpen: true, outcome: o, openFailed: false);
        expect(v, DevEntryView.notMarked);
        expect(devEntryHasButton(v), isFalse, reason: '★ 没被标就不许画按钮');
        expect(devEntryWords(v), devOpenNotMarked);
      }
    });

    test('问不到 / 回执坏了 ⇒ 也没有按钮（不许白屏：有话说）', () {
      for (final o in [const DevHarnessUnreachable('x'), const DevHarnessMalformed('x')]) {
        final v = devEntryViewOf(canOpen: true, outcome: o, openFailed: false);
        expect(v, DevEntryView.unreachable);
        expect(devEntryHasButton(v), isFalse);
        expect(devEntryWords(v), devOpenUnreachable);
      }
    });

    test('拿到了 ⇒ 一句普通话 + 一个按钮', () {
      final v = devEntryViewOf(canOpen: true, outcome: ready, openFailed: false);
      expect(v, DevEntryView.ready);
      expect(devEntryHasButton(v), isTrue);
      expect(devEntryWords(v), devOpenLead);
    });

    test('还没问过 ⇒ 「正在准备…」（不许白屏）', () {
      final v = devEntryViewOf(canOpen: true, outcome: null, openFailed: false);
      expect(v, DevEntryView.asking);
      expect(devEntryHasButton(v), isFalse);
    });

    test('🔴 这个平台打不开浏览器 ⇒ 如实说，**没有按钮**（而且连问都不问）', () {
      final v = devEntryViewOf(canOpen: false, outcome: ready, openFailed: false);
      expect(v, DevEntryView.cannotHere);
      expect(devEntryHasButton(v), isFalse);
      expect(devEntryWords(v), devOpenCannotHere);
    });

    test('点了没打开 ⇒ 还是那句普通话 + 按钮留着（再点会重取）', () {
      final v = devEntryViewOf(canOpen: true, outcome: ready, openFailed: true);
      expect(v, DevEntryView.openFailed);
      expect(devEntryHasButton(v), isTrue);
      expect(devEntryWords(v), devOpenFailed);
    });
  });

  // ── ④ 取数那一条路 + 缓存真的少问一次 ─────────────────────

  group('问服务端（带缓存）', () {
    test('走 GET /api/dev-harness，令牌在 authorization 头里（不进 URL）', () async {
      Uri? seen;
      Map<String, String>? headers;
      final api = Api(
        base: 'http://x',
        client: MockClient((r) async {
          seen = r.url;
          headers = r.headers;
          return _json(jsonEncode({'url': _url, 'expiresAt': 0}), 200);
        }),
      );
      final c = DevHarnessClient(api: api, token: () => 'tok', clock: () => 1000);
      final got = await c.link();
      expect(got, isA<DevHarnessReady>());
      expect(seen!.path, '/api/dev-harness');
      expect(seen!.query, isEmpty, reason: '★ 令牌不许进 URL');
      expect(headers!['authorization'], 'Bearer tok');
    });

    test('🔴 拿回来的那条**缓存住**：第二次不再问（短时效，但不必每次都问）', () async {
      var n = 0;
      final api = Api(
        client: MockClient((_) async {
          n += 1;
          return _json(jsonEncode({'url': _url, 'expiresAt': 0}), 200);
        }),
      );
      final c = DevHarnessClient(api: api, token: () => 'tok', clock: () => 1000);
      final a = await c.link();
      final b = await c.link();
      expect(n, 1, reason: '★ 缓存没生效（每点一次都去问一趟）');
      expect((a as DevHarnessReady).link.url, (b as DevHarnessReady).link.url);
    });

    test('🔴 过期 ⇒ 重取（旧的不许再用）', () async {
      var n = 0;
      var now = 1000;
      final api = Api(
        client: MockClient((_) async {
          n += 1;
          return _json(jsonEncode({'url': _url, 'expiresAt': 200000}), 200);
        }),
      );
      final c = DevHarnessClient(api: api, token: () => 'tok', clock: () => now);
      await c.link();
      now = 200000 - devHarnessSlackMs; // 进余量 ⇒ 算过期
      await c.link();
      expect(n, 2, reason: '★ 过期了还在用缓存那条');
    });

    test('🔴 点了没打开（forget）⇒ 下次重取', () async {
      var n = 0;
      final api = Api(
        client: MockClient((_) async {
          n += 1;
          return _json(jsonEncode({'url': _url, 'expiresAt': 0}), 200);
        }),
      );
      final c = DevHarnessClient(api: api, token: () => 'tok', clock: () => 1000);
      await c.link();
      c.forget();
      await c.link();
      expect(n, 2);
    });

    test('🔴 非 200 **不进缓存**：下次照样问（不许拿一条不能用的东西去开）', () async {
      var n = 0;
      final api = Api(
        client: MockClient((_) async {
          n += 1;
          return _json('', 403);
        }),
      );
      final c = DevHarnessClient(api: api, token: () => 'tok', clock: () => 1000);
      expect(await c.link(), isA<DevHarnessNotMarked>());
      expect(await c.link(), isA<DevHarnessNotMarked>());
      expect(n, 2);
    });

    test('还没登录 ⇒ **不去问**（问也是白问）', () async {
      var n = 0;
      final api = Api(
        client: MockClient((_) async {
          n += 1;
          return _json(jsonEncode({'url': _url, 'expiresAt': 0}), 200);
        }),
      );
      final c = DevHarnessClient(api: api, token: () => '', clock: () => 1000);
      expect(await c.link(), isA<DevHarnessUnreachable>());
      expect(n, 0);
    });

    test('网抛了 ⇒ 如实当"问不到"，**不是**"没被标"', () async {
      final api = Api(
        client: MockClient((_) async => throw const SocketishError()),
      );
      final c = DevHarnessClient(api: api, token: () => 'tok', clock: () => 1000);
      expect(await c.link(), isA<DevHarnessUnreachable>());
    });

    test('回执坏了 ⇒ 当失败，而且**不许**当成"没被标"', () async {
      final api = Api(client: MockClient((_) async => _json('{"url":1}', 200)));
      final c = DevHarnessClient(api: api, token: () => 'tok', clock: () => 1000);
      expect(await c.link(), isA<DevHarnessMalformed>());
    });
  });

  // ── ⑤ 文案过禁用词闸（这一组的新句子）──────────────────────

  test('★ 那个次要入口的每一句话都不许有内部词', () {
    final copies = <String>[
      devOpenLead,
      devOpenAction,
      devOpenAsking,
      devOpenNotMarked,
      devOpenUnreachable,
      devOpenCannotHere,
      devOpenFailed,
      for (final v in DevEntryView.values) devEntryWords(v),
    ];
    for (final c in copies) {
      expect(scanForbidden(c), isEmpty, reason: '「$c」里有禁用词');
    }
  });
}

/// 一个"网断了"那种异常（不 import `dart:io`：`SocketException` 在网页上不存在）。
class SocketishError implements Exception {
  const SocketishError();
  @override
  String toString() => '网断了';
}
