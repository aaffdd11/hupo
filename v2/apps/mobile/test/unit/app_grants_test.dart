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
//   ⑤ 名字（`db` / `ask` / `net`）是**协议名**，屏幕上那几个字住在 `space_words.dart`；
//   ⑥ ★ **清空它存下来的东西**（`POST /api/app-db-clear`）：回执映射同一条纪律
//      （只有明说 `{ok:true}` 才算成了）；
//   ⑦ 🔴 ★ **2026-10-02：存储不再是"要他点头的一样"**（主人原话：*「我发现做的小程序
//      都不会有存储。这个应该默认有存储。」*）—— `db` **不进** [knownWants]、
//      **不摆成一行**（[wantRowsOf]）、**不进弹窗**（[pendingWantsOf]），
//      而"清空"那颗按钮**每个小程序都有**（[canClearStored]）。

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
  List<String>? unanswered,
  List<String> net = const [],
}) => {
  'id': id,
  'title': title,
  'icon': 'book',
  'version': 1,
  'entryUrl': 'https://apps.example/$id/index.html?sig=x',
  'expiresAt': 0,
  'permissions': permissions,
  if (granted != null) 'granted': granted,
  if (unanswered != null) 'unanswered': unanswered,
  if (net.isNotEmpty) 'net': net,
};

void main() {
  test('★ 2026-10-05 拍照：那一样的人话是「想拍一张照片」（不许出现"摄像头/权限/Camera"）', () {
    // 主人：*"给小程序增加拍照功能。"*
    //   🔴 屏幕上的话要他自己听得懂 —— 与禁用词那道闸同一个道理。
    expect(grantWantWords('camera'), '想拍一张照片');
    for (final bad in ['摄像头', '权限', 'Camera', 'camera']) {
      expect(grantWantWords('camera').contains(bad), isFalse, reason: '★ 人话里出现了「$bad」');
    }
    // 负向对照：认不出来的那一档照旧有兜底那句（不是抛）
    expect(grantWantWords('whatever'), isNotEmpty);
    // 而且它进得了"认得的那几样"（不然那张卡上摆不出来）
    expect(knownWant('camera'), isTrue);
  });


  group('清单一侧：它想要什么 / 你给了没有（两件事）', () {
    test('★ 每一行都要有"它想要什么"；**存储（`db`）不算一行**', () {
      final plain = MiniApp.parse(_raw(id: 'dice', permissions: const []))!;
      final wants = MiniApp.parse(_raw())!; // permissions: ['db']
      // ★ 2026-10-02：存储默认就有 ⇒ 那一行**不摆**（摆了就像一件要他允许的事）
      expect(wantRowsOf(wants), isEmpty, reason: '★ `db` 不该摆成一行（存储默认有）');
      expect(wantRowsOf(plain), isEmpty);
      // ⚠️ 老清单里那个 `db` **照样认得**（只是不上屏）
      expect(wants.permissions, ['db'], reason: '清单照实读（读的是服务端给的）');
      // 真"要问的东西"照样摆
      final ask = MiniApp.parse(_raw(permissions: const ['db', 'ask']))!;
      expect(wantRowsOf(ask), ['ask'], reason: '★ `db` 滤掉，其余照摆');
    });

    test('🔴 `granted` 缺了 = **不知道**（`null`），空数组 = "一样都没给"', () {
      // ⚠️ 声明里必须有 `ask`（判的是"这一样他给了没有"；没声明的一律不给开关）
      final unknown = MiniApp.parse(_raw(permissions: const ['ask'], granted: null))!;
      final nothing = MiniApp.parse(_raw(permissions: const ['ask'], granted: const []))!;
      expect(unknown.granted, isNull, reason: '老服务端没回这个字段');
      expect(nothing.granted, isEmpty, reason: '回话了，一样都没给');
      expect(grantedOf(unknown), isNull);
      expect(grantedOf(nothing), isEmpty);
      // ★ 这两种在界面上**长得不一样**：前者不给开关，后者给一个关着的开关
      //    （`db` 那一颗 2026-10-02 撤了 ⇒ 这里换成 `ask` —— 判的是同一件事）
      expect(grantSwitchOn(unknown, 'ask'), isNull, reason: '★ 不知道 ⇒ 不许画开关');
      expect(grantSwitchOn(nothing, 'ask'), false, reason: '知道，而且没给');
      expect(
        grantSwitchOn(MiniApp.parse(_raw(permissions: const ['ask'], granted: const ['ask']))!, 'ask'),
        true,
      );
    });

    test('🔴 开关的值只看 `granted` 里有没有那一项（声明不等于允许）', () {
      final declaredNotGranted = MiniApp.parse(_raw(permissions: const ['ask'], granted: const []))!;
      expect(declaredNotGranted.permissions, ['ask']);
      expect(grantSwitchOn(declaredNotGranted, 'ask'), false, reason: '★ 声明了 ≠ 给了');
      expect(grantSwitchOn(declaredNotGranted, 'net'), isNull, reason: '它没声明这一样');
    });

    test('认不出来的那一档：**照样要有一句人话**，但**不给开关**', () {
      final other = MiniApp.parse(_raw(permissions: const ['something-new']))!;
      expect(wantRowsOf(other), ['something-new'],
          reason: '"它想要点什么"这件事不许藏起来');
      expect(grantWantWords('something-new'), isNotEmpty);
      expect(knownWant('something-new'), false);
      expect(grantSwitchOn(other, 'something-new'), isNull,
          reason: '★ 认不出来就不摆开关（摆了那一下必被服务端拒）');
    });

    test('成了之后的账：允许就记上、关掉就只把它拿掉（别的没动）', () {
      expect(nextGranted(const [], 'ask', true), ['ask']);
      expect(nextGranted(const ['net'], 'ask', true), ['net', 'ask']);
      expect(nextGranted(const ['net', 'ask'], 'ask', false), ['net']);
      expect(nextGranted(const [], 'ask', false), isEmpty);
      // ⚠️ 关掉**不移除别的**，也不产生第二份
      expect(nextGranted(const ['ask'], 'ask', true), ['ask']);
    });

    test('★ 认得的**五样**与**顺序**：问一句 → 上网 → 拍照 → 跟助手说话 → 按点跑', () {
      // ⚠️ 顺序就是那张卡上摆出来的顺序（`148` §二/§三）。
      // 🔴 **存储（`db`）不在里面**（2026-10-02：默认就有、不问他，见 `wantStore` 那段）。
      // ★ **2026-10-05 加第五样 `camera`**（主人：*"给小程序增加拍照功能。"*）——
      //   它排在"上网"后面（两样都是"它自己去拿外面的东西"那一族）。
      expect(knownWants, ['ask', 'net', 'camera', 'agent', 'tasks']);
      expect(knownWants, [wantAsk, wantNet, wantCamera, wantAgent, wantTasks]);
      expect(knownWants.contains(wantStore), false,
          reason: '★ 存储不再是要他点头的一样');
      // 负向对照：五样都得认得（少一样 ⇒ 那一样就没有开关，而它本来是服务端认的）
      for (final p in ['ask', 'net', 'camera', 'agent', 'tasks']) {
        expect(knownWant(p), true, reason: '★ $p 是服务端白名单里的，界面上必须认得');
      }
      expect(knownWant('something-new'), false);
    });

    test('★ 那一颗"清空"的按钮**每个小程序都有**（存储默认就有）', () {
      // ★ 2026-10-02：判据从"声明了存东西没有"改成"这是不是一个 app"
      for (final perms in [const ['db'], const ['ask', 'net'], const <String>[]]) {
        final a = MiniApp.parse(_raw(permissions: perms, granted: const []))!;
        expect(canClearStored(a), true,
            reason: '★ 存储默认有 ⇒ ${perms.join('+')} 也要有那颗"清空"');
      }
      // ⚠️ **跟"停用"无关**：别的那些一样都没给，照样能清（"我的东西我拿走"）
      final off = MiniApp.parse(_raw(permissions: const ['ask'], granted: const []))!;
      expect(grantSwitchOn(off, 'ask'), false, reason: '这一颗是关着的');
      expect(canClearStored(off), true, reason: '★ 关不关都清得掉');
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

  group('★ 清空它存下来的东西：回执 → 结果（纯函数，逐码对表）', () {
    test('200 且明说 ok ⇒ 成了（`removed` 带回来，但界面不显示它）', () {
      final o = clearOutcomeOf(200, jsonEncode({'ok': true, 'removed': 3}));
      expect(o, isA<ClearOk>());
      expect((o as ClearOk).removed, 3);
      // ⚠️ **幂等**：没存过也回 200（`removed:0`）⇒ 一样算成了 —— 他连点两次不该看到报错
      final none = clearOutcomeOf(200, jsonEncode({'ok': true, 'removed': 0}));
      expect(none, isA<ClearOk>());
      // 回执里没带 `removed` ⇒ `null`（界面**不必**显示它，所以这不影响任何判断）
      expect((clearOutcomeOf(200, jsonEncode({'ok': true})) as ClearOk).removed, isNull);
    });

    test('🔴 401 ⇒ 令牌不行（那是另一件事，不是"没清掉"）', () {
      expect(clearOutcomeOf(401, jsonEncode({'error': 'unauthorized'})),
          isA<ClearUnauthorized>());
    });

    test('🔴 其余（含 400 / 503 与"200 但 ok 不是 true"）⇒ 没成，并带回服务端那句人话', () {
      final bad = clearOutcomeOf(
        400,
        jsonEncode({'ok': false, 'error': 'not-done', 'text': '没做成，等会儿再试。'}),
      );
      expect(bad, isA<ClearFailed>());
      expect((bad as ClearFailed).text, '没做成，等会儿再试。', reason: '★ 原话要能上屏');

      // 🔴 **200 但 `ok` 不是 true ⇒ 一个字节都不当成功**（这一条最容易写成"200 就成"）
      expect(clearOutcomeOf(200, jsonEncode({'error': 'not-done'})), isA<ClearFailed>());
      // 盒子不通那一条（503）：服务器给的人话照带
      expect(
        (clearOutcomeOf(503, jsonEncode({'ok': false, 'text': '你那台还在准备，稍等一下再试。'}))
                as ClearFailed)
            .text,
        '你那台还在准备，稍等一下再试。',
      );
      // 读不出来的回执 / 网络那一条的兜底 ⇒ 空串（界面用自己那句）
      expect((clearOutcomeOf(502, '<html>') as ClearFailed).text, '');
      expect((clearOutcomeOf(500, '') as ClearFailed).text, '');
    });

    test('★ 没清成时该说的那句：服务端有人话就照它说，没有才用兜底', () {
      expect(clearFailedLine(const ClearFailed('没做成，等会儿再试。')), '没做成，等会儿再试。');
      expect(clearFailedLine(const ClearFailed('   ')), settingsClearDbFailed);
      expect(clearFailedLine(const ClearFailed('')), settingsClearDbFailed);
      // 🔴 兜底那句**不是**"清掉了"（不许把没成说成成了）
      expect(clearFailedLine(const ClearFailed('')), isNot(settingsClearDbDone));
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

  group('★ 那条口：`POST /api/app-db-clear`（头与正文照 `appRename` 走）', () {
    test('★ 真的发的是那一条：方法 / 地址 / Bearer 头 / 正文只有 id', () async {
      http.Request? seen;
      final api = Api(
        base: 'http://127.0.0.1:1',
        client: MockClient((r) async {
          seen = r;
          return http.Response(
            jsonEncode({'ok': true, 'removed': 2}),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );
      final out = await api.appDbClear(token: 'tok-1', id: 'notes');
      expect(out, isA<ClearOk>());
      expect((out as ClearOk).removed, 2);
      expect(seen!.method, 'POST');
      expect(seen!.url.path, '/api/app-db-clear');
      expect(seen!.headers['authorization'], 'Bearer tok-1',
          reason: '★ 签字那一下走**登录态**（照 appRename 那条）');
      expect(jsonDecode(seen!.body), {'id': 'notes'},
          reason: '★ 正文只有那个 app 的 id（协议就这一样）');
    });

    test('服务端回错 ⇒ `ClearFailed` 并带回那句人话（界面照它说）', () async {
      final api = Api(
        base: 'http://127.0.0.1:1',
        client: MockClient((_) async => http.Response(
              jsonEncode({'ok': false, 'error': 'tenant-not-ready', 'text': '你那台还在准备，稍等一下再试。'}),
              503,
              headers: {'content-type': 'application/json; charset=utf-8'},
            )),
      );
      final out = await api.appDbClear(token: 't', id: 'notes');
      expect(out, isA<ClearFailed>());
      expect((out as ClearFailed).text, '你那台还在准备，稍等一下再试。');
      expect(clearFailedLine(out), '你那台还在准备，稍等一下再试。');
    });

    test('网不通 ⇒ 什么都没发生（`ClearFailed`，界面不许当成功）', () async {
      var hit = 0;
      final api = Api(
        base: 'http://127.0.0.1:1',
        client: MockClient((_) async {
          hit += 1;
          throw const SocketExceptionStub();
        }),
      );
      final out = await api.appDbClear(token: 't', id: 'notes');
      expect(out, isA<ClearFailed>());
      expect(hit, 1, reason: '假服务端只被打了一次（判据不许真打网络）');
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
        grantWantWords('net'),
        grantWantWords('something-new'),
        // ★ 2026-10-01：那颗「清空」的按钮 ＋ 确认层 ＋ 成/没成那两句
        settingsClearDbAction,
        settingsClearDbTitle,
        settingsClearDbWhat,
        settingsClearDbNo,
        settingsClearDbYes,
        settingsClearDbDone,
        settingsClearDbFailed,
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
      // ★ 清空那几句一样：`db` / `sqlite` / `数据库` 一个都不许上屏
      for (final c in [settingsClearDbAction, settingsClearDbTitle, settingsClearDbWhat]) {
        expect(c.toLowerCase().contains('db'), false, reason: '「$c」里有协议名');
        expect(c.toLowerCase().contains('sqlite'), false, reason: '「$c」里有技术词');
        expect(c.contains('数据库'), false, reason: '「$c」里有技术词');
      }
    });

    test('🔴 清空那一层**必须说清拿不回来**（不然二次确认就是走过场）', () {
      // 那一步没有回收站（`147` §五）⇒ 那句话里必须有"没掉 / 拿不回来"这样的实话
      expect(settingsClearDbWhat.contains('没掉'), true,
          reason: '★ 要说清"东西会没掉"');
      expect(settingsClearDbWhat.contains('拿不回来'), true,
          reason: '★ 要说清"拿不回来"（不可逆）');
      // 两个按钮各自有字（不许画一个没字的确认框）
      expect(settingsClearDbNo.trim().isNotEmpty, true);
      expect(settingsClearDbYes.trim().isNotEmpty, true);
      // 成了那句与没成那句**不许是同一句**（混了就是把没成说成成了）
      expect(settingsClearDbDone, isNot(settingsClearDbFailed));
    });

    test('🔴 关掉只是"现在不给"：文案里不许有"删 / 清空"那种说法', () {
      expect(settingsGrantsHint.contains('现在不给'), true, reason: '★ 要说清关掉是什么意思');
      for (final bad in ['删', '清空', '清除', '抹掉']) {
        expect(settingsGrantsHint.contains(bad), false,
            reason: '★ 关掉不删东西（`147` §五：清空那颗按钮没做）：$bad');
      }
    });
  });

  // ── ★ 2026-10-01：**打开时那张弹窗**（主人：*"小程序不要声明，应该是打开后有
  //    弹窗申请权限"* · *"打开时一次问完"* · *"那一样用不了，别的照旧"*）────────
  group('打开时那张弹窗：该问哪几样 / 不许问哪几样', () {
    test('🔴 该问的 = **声明了 ＋ 他还没表过态 ＋ 界面认得**（顺序照清单）', () {
      final app = MiniApp.parse(_raw(
        permissions: const ['net', 'agent'],
        granted: const [],
        unanswered: const ['net', 'agent'],
      ))!;
      expect(needsAskOnOpen(app), true);
      expect(pendingWantsOf(app), ['net', 'agent'],
          reason: '★ 一次问完：还没表态的几样都在这一张窗里');
      // 表过态的（`granted` 里有）不许再问
      final partly = MiniApp.parse(_raw(
        permissions: const ['net', 'agent'],
        granted: const ['net'],
        unanswered: const ['agent'],
      ))!;
      expect(pendingWantsOf(partly), ['agent'], reason: '★ 给过的那些不再问');
      // 🔴 ★ 负向对照：**存储（`db`）不进这张窗** —— 就算老服务端把它放进了
      //    `unanswered`，界面也不问它（2026-10-02：存储默认有、不用他表态）
      final withStore = MiniApp.parse(_raw(
        permissions: const ['db', 'net'],
        granted: const [],
        unanswered: const ['db', 'net'],
      ))!;
      expect(pendingWantsOf(withStore), ['net'], reason: '★ 存储不该出现在弹窗里');
    });

    test('🔴 他**不给**过的那一样：也从"该问的"里挪走（`unanswered` 里没有它）', () {
      final app = MiniApp.parse(_raw(
        permissions: const ['ask', 'net'],
        granted: const [],
        unanswered: const ['net'],
      ))!;
      expect(pendingWantsOf(app), ['net']);
      expect(grantSwitchOn(app, 'ask'), false, reason: '★ 不给过 ⇒ 设置页那颗开关是关着的');
      expect(needsAskOnOpen(app), true, reason: '还有一样没问过 ⇒ 照样得问');
    });

    test('🔴 老服务端**没回** `unanswered` ⇒ **一次都不弹**（`null` ≠ 空）', () {
      final old = MiniApp.parse(_raw(granted: const []))!; // 没带 unanswered
      expect(old.unanswered, isNull);
      expect(unansweredOf(old), isNull);
      expect(pendingWantsOf(old), isEmpty);
      expect(needsAskOnOpen(old), false,
          reason: '★ 弹一张问不出结果的窗，只会白挡他一下');
      // 负向对照：回了**空数组** = 都问过了 ⇒ 也不弹
      final answered = MiniApp.parse(_raw(granted: const ['net'], unanswered: const []))!;
      expect(needsAskOnOpen(answered), false);
    });

    test('🔴 界面上**认不出来**的名字不许进弹窗（摆了那颗开关必被服务端拒）', () {
      final app = MiniApp.parse(_raw(
        permissions: const ['something-new'],
        granted: const [],
        unanswered: const ['something-new'],
      ))!;
      expect(pendingWantsOf(app), isEmpty);
      expect(needsAskOnOpen(app), false);
    });

    test('★ `net` 那一样带着**要连的站**（只有弹窗会摆；读不到就是空）', () {
      final net = MiniApp.parse(_raw(
        permissions: const ['net'],
        granted: const [],
        unanswered: const ['net'],
        net: const ['api.example.com', 'data.example.org'],
      ))!;
      expect(net.net, ['api.example.com', 'data.example.org']);
      // 没带来的（老服务端）⇒ 空名单，不影响"问不问"
      expect(MiniApp.parse(_raw(permissions: const ['net'], granted: const [], unanswered: const ['net']))!.net,
          isEmpty);
    });

    test('★ 弹窗那几句话：**干净**、说清"关掉一样只影响那一样"、说清后面还能改', () {
      for (final c in [
        askOnOpenTitle,
        askOnOpenLead,
        askOnOpenSitesLead,
        askOnOpenOn,
        askOnOpenOff,
        askOnOpenGo,
        askOnOpenNone,
        askOnOpenLater,
        askOnOpenFailed,
      ]) {
        final hits = scanForbidden(c);
        expect(hits, isEmpty, reason: '「$c」里有禁用词：$hits');
      }
      // 🔴 "别的照旧"这一句必须在（不然他以为关一样就整个用不了）
      expect(askOnOpenLead.contains('别的照旧'), true, reason: '★ 主人点名的那句话');
      // 🔴 "关掉哪一样，就只是那一样用不了"
      expect(askOnOpenLead.contains('那一样用不了'), true);
      // ⚠️ 问过就不再问这件事要说出来（不然他以为按错了没法回头）
      expect(askOnOpenLater.contains('设置'), true, reason: '★ 之后在哪儿能改');
      // ⚠️ 没记下来那一句**不许**说成"没给"（他明明点了允许）
      expect(askOnOpenFailed.contains('没给'), false);
      // ⚠️ 两个按钮各自的字（不许画一个没字的按钮）
      expect(askOnOpenGo.trim().isNotEmpty, true);
      expect(askOnOpenNone.trim().isNotEmpty, true);
      // ⚠️ 技术词一个都不许上屏
      for (final bad in ['权限', '授权', 'scope', 'db', 'sqlite']) {
        for (final c in [askOnOpenTitle, askOnOpenLead, askOnOpenLater, askOnOpenFailed]) {
          expect(c.toLowerCase().contains(bad.toLowerCase()), false, reason: '「$c」里有「$bad」');
        }
      }
    });
  });
}

/// 一个假的"网不通"（不引 `dart:io`，`models` 那层也禁它 —— 判据这一侧同样别引）。
class SocketExceptionStub implements Exception {
  const SocketExceptionStub();
}
