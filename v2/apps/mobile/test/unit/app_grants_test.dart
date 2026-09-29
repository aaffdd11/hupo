// **注册制那张卡背后的纯逻辑**（契约 `docs/dev/147-APP-SQLITE.md` §二「册子」· §四 G1–G4）。
//
// 主人原话：*「注册制，在设置里可以看到也可以关闭」*。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **两件事不许混**：`permissions`（它想要什么）vs `granted`（你给了没有）；
//   ② 🔴 **老服务端不回 `granted` ⇒ 不知道** ⇒ **不给开关**（不给假状态）；
//   ③ 🔴 **只有服务端明说 `{ok:true}` 才算成了** —— 其余一律"没成"，
//      而且要把服务端那句**人话**带回来（没成不许静默）；
//   ④ 🔴 **关掉只是"现在不给"**：文案里一个"删 / 清空"的字都不许有；
//   ⑤ 名字（`db` / `ask`）是**协议名**，屏幕上那几个字住在 `space_words.dart`。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/app_spec.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/services/api.dart';

/// 一条清单里的记录（`/api/apps` 回来的形状）。
Map<String, Object?> _raw({
  String id = 'notes',
  String title = '随手记',
  List<String> permissions = const ['db'],
  List<String>? granted = const [],
}) => {
  'id': id,
  'title': title,
  'icon': 'book',
  'version': 1,
  'entryUrl': 'https://apps.example/$id/index.html?sig=x',
  'expiresAt': 0,
  'permissions': permissions,
  if (granted != null) 'granted': granted,
};

void main() {
  group('清单一侧：它想要什么 / 你给了没有（两件事）', () {
    test('★ 只列**声明了东西**的；没声明的一个字都不出现', () {
      final plain = MiniApp.parse(_raw(id: 'dice', permissions: const []))!;
      final wants = MiniApp.parse(_raw())!;
      expect(wantsApps([plain, wants]).map((a) => a.id), ['notes']);
      // 负向对照：**没有声明** ⇒ 这一条不进那张卡（这正是"一个都没有就不画"的判据底）
      expect(hasWants(plain), false);
      expect(wantsApps([plain]), isEmpty);
    });

    test('🔴 `granted` 缺了 = **不知道**（`null`），空数组 = "一样都没给"', () {
      final unknown = MiniApp.parse(_raw(granted: null))!;
      final nothing = MiniApp.parse(_raw(granted: const []))!;
      expect(unknown.granted, isNull, reason: '老服务端没回这个字段');
      expect(nothing.granted, isEmpty, reason: '回话了，一样都没给');
      expect(grantedOf(unknown), isNull);
      expect(grantedOf(nothing), isEmpty);
      // ★ 这两种在界面上**长得不一样**：前者不给开关，后者给一个关着的开关
      expect(grantSwitchOn(unknown, 'db'), isNull, reason: '★ 不知道 ⇒ 不许画开关');
      expect(grantSwitchOn(nothing, 'db'), false, reason: '知道，而且没给');
      expect(grantSwitchOn(MiniApp.parse(_raw(granted: const ['db']))!, 'db'), true);
    });

    test('🔴 开关的值只看 `granted` 里有没有那一项（声明不等于允许）', () {
      final declaredNotGranted = MiniApp.parse(_raw(granted: const ['ask']))!;
      expect(declaredNotGranted.permissions, ['db']);
      expect(grantSwitchOn(declaredNotGranted, 'db'), false, reason: '★ 声明了 ≠ 给了');
      expect(grantSwitchOn(declaredNotGranted, 'ask'), isNull, reason: '它没声明这一样');
    });

    test('认不出来的那一档：**照样要有一句人话**，但**不给开关**', () {
      final other = MiniApp.parse(_raw(permissions: const ['something-new']))!;
      expect(wantsApps([other]).length, 1, reason: '"它想要点什么"这件事不许藏起来');
      expect(grantWantWords('something-new'), isNotEmpty);
      expect(knownWant('something-new'), false);
      expect(grantSwitchOn(other, 'something-new'), isNull,
          reason: '★ 认不出来就不摆开关（摆了那一下必被服务端拒）');
    });

    test('成了之后的账：允许就记上、关掉就只把它拿掉（别的没动）', () {
      expect(nextGranted(const [], 'db', true), ['db']);
      expect(nextGranted(const ['ask'], 'db', true), ['ask', 'db']);
      expect(nextGranted(const ['ask', 'db'], 'db', false), ['ask']);
      expect(nextGranted(const [], 'db', false), isEmpty);
      // ⚠️ 关掉**不移除别的**，也不产生第二份
      expect(nextGranted(const ['db'], 'db', true), ['db']);
    });
  });

  group('回执 → 结果（纯函数，逐码对表）', () {
    test('200 且明说 ok ⇒ 成了（带回允许了的那一份）', () {
      final o = grantOutcomeOf(200, jsonEncode({'ok': true, 'permissions': ['db']}));
      expect(o, isA<GrantOk>());
      expect((o as GrantOk).permissions, ['db']);
      // 回执里没带清单 ⇒ `null`（界面按本地算的那一份记账）
      final bare = grantOutcomeOf(200, jsonEncode({'ok': true}));
      expect((bare as GrantOk).permissions, isNull);
    });

    test('🔴 401 ⇒ 令牌不行（那是另一件事，不是"没改成"）', () {
      expect(grantOutcomeOf(401, jsonEncode({'error': 'unauthorized'})),
          isA<GrantUnauthorized>());
    });

    test('🔴 其余（含 400 与"200 但 ok 不是 true"）⇒ 没成，并带回服务端那句人话', () {
      final bad = grantOutcomeOf(
        400,
        jsonEncode({'ok': false, 'error': 'bad-permission', 'text': '这个东西现在还不给。'}),
      );
      expect(bad, isA<GrantFailed>());
      expect((bad as GrantFailed).text, '这个东西现在还不给。', reason: '★ 原话要能上屏');

      // 200 但 `ok` 不是 true ⇒ **一个字节都不当成功**
      expect(grantOutcomeOf(200, jsonEncode({'error': 'not-done'})), isA<GrantFailed>());
      // 读不出来的回执 / 网络那一条的兜底 ⇒ 空串（界面用自己那句）
      expect((grantOutcomeOf(502, '<html>') as GrantFailed).text, '');
      expect((grantOutcomeOf(500, '') as GrantFailed).text, '');
    });

    test('回执里那串名字：不是字符串 / 空的都不要（读不出来按"没带"）', () {
      expect(permissionListOf(['db', '', 3, null, 'ask']), ['db', 'ask']);
      expect(permissionListOf('db'), isNull);
      expect(
        (grantOutcomeOf(200, jsonEncode({'ok': true, 'permissions': 'db'})) as GrantOk)
            .permissions,
        isNull,
      );
    });

    test('★ 没成时该说的那句：服务端有人话就照它说，没有才用兜底', () {
      expect(grantFailedLine(const GrantFailed('这个东西现在还不给。')), '这个东西现在还不给。');
      expect(grantFailedLine(const GrantFailed('   ')), settingsGrantsFailed);
      expect(grantFailedLine(const GrantFailed('')), settingsGrantsFailed);
    });
  });

  group('那条口：`POST /api/app-grant`（头与正文照 `appRename` 走）', () {
    test('★ 真的发的是那一条：方法 / 地址 / Bearer 头 / 正文三样', () async {
      http.Request? seen;
      final api = Api(
        base: 'http://127.0.0.1:1',
        client: MockClient((r) async {
          seen = r;
          return http.Response(
            jsonEncode({'ok': true, 'permissions': ['db']}),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );
      final out = await api.appGrant(
        token: 'tok-1',
        id: 'notes',
        permission: 'db',
        allow: true,
      );
      expect(out, isA<GrantOk>());
      expect(seen!.method, 'POST');
      expect(seen!.url.path, '/api/app-grant');
      expect(seen!.headers['authorization'], 'Bearer tok-1',
          reason: '★ 签字那一下走**登录态**（照 appRename 那条）');
      expect(jsonDecode(seen!.body), {'id': 'notes', 'permission': 'db', 'allow': true});
    });

    test('关掉那一趟：正文里 `allow` 是 false（"现在不给"）', () async {
      http.Request? seen;
      final api = Api(
        base: 'http://127.0.0.1:1',
        client: MockClient((r) async {
          seen = r;
          return http.Response(
            jsonEncode({'ok': true, 'permissions': <String>[]}),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );
      await api.appGrant(token: 't', id: 'notes', permission: 'db', allow: false);
      expect(jsonDecode(seen!.body)['allow'], false);
    });

    test('网不通 ⇒ 什么都没发生（`GrantFailed`，界面不许当成功）', () async {
      final api = Api(
        base: 'http://127.0.0.1:1',
        client: MockClient((_) async => throw const SocketExceptionStub()),
      );
      final out = await api.appGrant(token: 't', id: 'notes', permission: 'db', allow: true);
      expect(out, isA<GrantFailed>());
    });
  });

  group('文案（词表硬闸扫的就是这几句）', () {
    test('★ 每一句都干净（没有 权限 / 数据库 / db / SQLite 那类内部词）', () {
      final copies = [
        settingsGrantsTitle,
        settingsGrantsHint,
        settingsGrantsFailed,
        grantWantWords('db'),
        grantWantWords('ask'),
        grantWantWords('something-new'),
      ];
      for (final c in copies) {
        final hits = scanForbidden(c);
        expect(hits, isEmpty, reason: '「$c」里有禁用词：$hits');
      }
    });

    test('🔴 协议名**一个都不许**出现在人话里（`db` / `ask` / `sqlite` 都不行）', () {
      for (final p in knownWants) {
        final line = grantWantWords(p);
        expect(line.contains(p), false, reason: '「$line」把协议名摆到屏幕上了');
      }
      // ⚠️ **认不出来的那一档也不许**把那个名字原样摆出来（它可能就是内部词）
      expect(grantWantWords('something-new').contains('something-new'), false,
          reason: '★ 兜底那句必须是**人话**，不是把协议名复述一遍');
      expect(settingsGrantsHint.toLowerCase().contains('sqlite'), false);
    });

    test('🔴 关掉只是"现在不给"：文案里不许有"删 / 清空"那种说法', () {
      expect(settingsGrantsHint.contains('现在不给'), true, reason: '★ 要说清关掉是什么意思');
      for (final bad in ['删', '清空', '清除', '抹掉']) {
        expect(settingsGrantsHint.contains(bad), false,
            reason: '★ 关掉不删东西（`147` §五：清空那颗按钮没做）：$bad');
      }
    });
  });
}

/// 一个假的"网不通"（不引 `dart:io`，`models` 那层也禁它 —— 判据这一侧同样别引）。
class SocketExceptionStub implements Exception {
  const SocketExceptionStub();
}
