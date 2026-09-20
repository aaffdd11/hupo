// 「导出」这一件的**纯逻辑**（契约 `docs/dev/30-EXPORT.md`）。
//
// 这一份钉的是**客户端这一侧**能钉住的东西：
//   ① 🔴 **文案过禁用词闸**（拿**真那份**表扫；含"记录" —— ⑳ 踩过一次）；
//   ② **回执解析**（缺字段不抛、给最保守的值）；
//   ③ **取数那一条路**：`GET /api/export`、带令牌头、令牌不进 URL、401 与失败分得清；
//   ④ **空对话** ⇒ `hasText == false`（屏幕那边说那句实话，不给空框）。
//
// ⚠️ 那段成品文字是**服务端渲染**的（契约 §六），所以它的形状、§三 的条数、
//    §二 那句话都钉在 `services/core/test/export.test.js` 里 —— 不在这一份。
// ⚠️ 不写界面断言（纯逻辑进 `test/unit`，界面断言放 `test/widget`）。

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/export.dart';
import 'package:hupo_app/models/export_words.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 假回执。⚠️ **必须带 `charset=utf-8`**：`http.Response(body, 200)` 默认按
/// latin1 编正文，正文里只要有中文就会当场抛（和 `trash_test.dart` 同一条理由）。
http.Response _json(String body, int status) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // ── ① 文案过禁用词闸 ───────────────────────────────────────

  group('新加的人话', () {
    final copies = <String>[
      exportTooltip,
      exportTitle,
      exportHintLine,
      exportCopy,
      exportCopiedLine,
      exportCopyFailedLine,
      exportEmptyLine,
      exportLoadFailedLine,
    ];

    test('🔴 一条都不许带内部词（拿真那份禁用词表扫）', () {
      for (final c in copies) {
        final hits = scanForbidden(c);
        expect(hits, isEmpty, reason: '「$c」里有禁用词：$hits');
      }
    });

    test('🔴 "记录" / "时间线" / "轮" 一个都不许出现', () {
      // ⚠️ 为什么单钉这三条而不是全靠上面那张表：
      //    "时间线"在表里，但 **"记录"不在表里**（⑳ 踩过的那次就是它，
      //    教训写在 `notice_words.dart` 顶上）；"轮"是内部概念（协议里的 turn）。
      //    这一件要谈"它记得什么"，最容易顺手写成"记录"——所以把它钉死。
      for (final c in copies) {
        for (final bad in ['记录', '时间线', '轮']) {
          expect(c.contains(bad), false, reason: '「$c」里有「$bad」：说人话');
        }
      }
    });

    test('空对话那句话是契约钉死的那一句', () {
      expect(exportEmptyLine, '这条对话还是空的');
    });
  });

  // ── ② 回执解析（纯函数）────────────────────────────────────

  group('回执解析', () {
    test('读得出正文与条数', () {
      final d = exportFrom(const {'text': '我：你好', 'hiddenCount': 2});
      expect(d.text, '我：你好');
      expect(d.hiddenCount, 2);
      expect(d.hasText, true);
    });

    test('缺字段 / 类型不对 ⇒ 不抛，给最保守的值（当成"没东西可导"）', () {
      final empty = exportFrom(const {});
      expect(empty.text, '');
      expect(empty.hiddenCount, 0);
      expect(empty.hasText, false);
      expect(exportFrom(const {'text': 42, 'hiddenCount': 'x'}).hasText, false);
    });

    test('🔴 空白正文也算"没有"（不许给一个只有空白的框）', () {
      expect(const ExportDoc(text: '   \n\n ').hasText, false);
      expect(const ExportDoc(text: '我：在').hasText, true);
    });
  });

  // ── ③ 取数那一条路 ─────────────────────────────────────────

  group('取数：GET /api/export', () {
    Future<List<http.Request>> calls(Future<void> Function(Api api) run,
        {String body = '{"text":"我：在","hiddenCount":0}', int status = 200}) async {
      final seen = <http.Request>[];
      final api = Api(client: MockClient((r) async {
        seen.add(r);
        return _json(body, status);
      }));
      await run(api);
      return seen;
    }

    test('🔴 走 GET、带令牌头、令牌不进 URL', () async {
      final seen = await calls((api) => api.exportText(token: 'tok'));
      expect(seen.single.method, 'GET');
      expect(seen.single.url.path, '/api/export');
      final auth = seen.single.headers['authorization'] ?? seen.single.headers['Authorization'];
      expect(auth, 'Bearer tok');
      expect(seen.single.url.toString().contains('tok'), false);
    });

    test('200 ⇒ 拿到成品；401 ⇒ 令牌不行；其它 ⇒ 失败（三种不许混）', () async {
      final ok = await calls((api) => api.exportText(token: 'tok'));
      expect(ok.length, 1);

      final api401 = Api(client: MockClient((_) async => _json('{}', 401)));
      expect(await api401.exportText(token: 'tok'), isA<TrashUnauthorized<ExportDoc>>());

      final api500 = Api(client: MockClient((_) async => _json('{}', 500)));
      expect(await api500.exportText(token: 'tok'), isA<TrashFailed<ExportDoc>>());

      // 200 但回执坏了 ⇒ **当失败**（不许把坏东西当成功）
      final apiBad = Api(client: MockClient((_) async => _json('这不是 JSON', 200)));
      expect(await apiBad.exportText(token: 'tok'), isA<TrashFailed<ExportDoc>>());
    });
  });

  group('控制器：loadExport', () {
    test('有令牌 ⇒ 把成品交出来', () async {
      final c = ChatController(
        api: Api(client: MockClient((_) async => _json('{"text":"我：在","hiddenCount":1}', 200))),
        tokens: TokenStore(),
        token: 'tok',
      );
      addTearDown(c.dispose);
      final a = await c.loadExport();
      expect(a, isA<TrashOk<ExportDoc>>());
      expect((a as TrashOk<ExportDoc>).value.hiddenCount, 1);
    });

    test('🔴 没令牌 ⇒ 令牌不行（**不是**"网不好"）', () async {
      final c = ChatController(
        api: Api(client: MockClient((_) async => _json('{}', 200))),
        tokens: TokenStore(),
      );
      addTearDown(c.dispose);
      expect(await c.loadExport(), isA<TrashUnauthorized<ExportDoc>>());
    });
  });
}
