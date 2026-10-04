// **我的小程序清单**：解析与白名单（乙-1 · 契约 `docs/dev/59-USER-APPS.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **拿不到入口 URL / 已经过期 ⇒ 不摆**（摆了就是"点了没反应"）
//   ② 🔴 **图标名认不出来 ≠ 把东西藏掉**：用默认图标（他的东西不许因为一个名字消失）
//   ③ 🔴 **两张白名单不许漂**：客户端这份映射表 vs 服务端 `apps.js` 的 `ICONS` 逐字对
//   ④ 一条坏记录不许把整个桌面弄空（跳过那一条）

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/app_spec.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/widgets/mini_app_icons.dart';

void main() {
  Map<String, Object?> ok({String id = 'dice', String title = '掷骰子', int version = 1}) => {
        'id': id,
        'title': title,
        'icon': 'dice',
        'version': version,
        'entry': 'index.html',
        'entryUrl': 'http://127.0.0.1:8021/a/dice/1/index.html?u=u1&e=99999999999999&s=ab',
        'expiresAt': 99999999999999,
        'permissions': <String>[],
      };

  test('正常一条：解析得出来，字段对得上', () {
    final app = MiniApp.parse(ok());
    assert(app != null);
    expect(app!.id, 'dice');
    expect(app.title, '掷骰子');
    expect(app.version, 1);
    expect(app.icon, 'dice');
    expect(app.permissions, isEmpty);
  });

  // ★ 2026-09-30（契约 `docs/dev/147-APP-SQLITE.md` §四 G2）：
  //   **"它想要什么"与"你给了没有"是两件事**，而老服务端可能**根本不回**后者。
  //   ⇒ 解析层必须把"没回"（`null`）与"回了空的"（`[]`）**分开**：
  //     混成一个就会在设置页画出一个假的开/关。
  test('🔴 `granted`：没回是 `null`，回了空数组是 `[]`（两条路不许并成一条）', () {
    final unknown = MiniApp.parse(ok()..remove('granted'));
    final nothing = MiniApp.parse(ok()..['granted'] = <String>[]);
    final some = MiniApp.parse(ok()..['granted'] = ['db', '', 7]);
    expect(unknown!.granted, isNull, reason: '★ 老服务端不回这个字段 ⇒ 不知道（界面据此不画开关）');
    expect(nothing!.granted, isEmpty);
    expect(some!.granted, ['db'], reason: '认不出的那几项丢掉，别的照收');
    // 字段在、但不是一串名字 ⇒ 按"不知道"处理（fail-closed）
    expect(MiniApp.parse(ok()..['granted'] = 'db')!.granted, isNull);
  });

  // ★ 2026-10-04（契约 `docs/dev/{175,178}`）：桌面上那两格状态 ——
  //   `building`＝"还在做"（灰的在建图标）· `working`＝"正有活在做"（右下角转着的小圈）。
  //   🔴 **只认 `true`**；没回 / 回了个"像真的但不是 true"的东西 ⇒ 一律 false。
  //     宁可晚一拍，也不许把做好的显示成"还在做 / 还在忙"（那种假话最容易被当真）。
  test('🔴 `building` 与 `working`：只认 `true`；没回 / 回别的 ⇒ 一律 false', () {
    final none = MiniApp.parse(ok())!;
    expect(none.building, isFalse, reason: '老服务端不回 ⇒ 不许画成"在建"');
    expect(none.working, isFalse, reason: '★ 不知道就不亮（不点亮"它还在做"）');

    final both = MiniApp.parse(ok()..['building'] = true..['working'] = true)!;
    expect(both.building, isTrue);
    expect(both.working, isTrue);

    for (final junk in <Object?>['yes', 1, 0, <String>[], <String, Object?>{}]) {
      final a = MiniApp.parse(ok()..['building'] = junk..['working'] = junk)!;
      expect(a.building, isFalse, reason: '★ `$junk` 不许当 true');
      expect(a.working, isFalse, reason: '★ `$junk` 不许当 true');
    }
  });

  test('`withGranted` 只换那一份（别的字段一个都不动）', () {
    final a = MiniApp.parse(ok()..['granted'] = <String>[])!;
    final b = a.withGranted(const ['db']);
    expect(b.granted, ['db']);
    expect(b.id, a.id);
    expect(b.title, a.title);
    expect(b.entryUrl, a.entryUrl);
    expect(b.permissions, a.permissions);
    expect(a.granted, isEmpty, reason: '★ 原来那一份不许被改（值类）');
  });

  test('🔴 没有入口 URL / 过期 / 名字空 / id 空 ⇒ 一律不算数', () {
    final noUrl = ok()..remove('entryUrl');
    expect(MiniApp.parse(noUrl), isNull, reason: '没入口 URL 摆了也是点了没反应');
    expect(MiniApp.parse(ok()..['entryUrl'] = 'ftp://x'), isNull, reason: '只认 http(s)');
    expect(MiniApp.parse(ok(), now: 99999999999999), isNull, reason: '★ 过期了就别摆');
    expect(MiniApp.parse(ok()..['title'] = '   '), isNull);
    expect(MiniApp.parse(ok()..['id'] = ''), isNull);
    expect(MiniApp.parse(ok()..['version'] = 0), isNull);
    expect(MiniApp.parse('这不是一条'), isNull);
    expect(MiniApp.parse(null), isNull);
  });

  test('🔴 图标名认不出来 ⇒ 用默认图标（**不是**把这条藏掉）', () {
    final app = MiniApp.parse(ok()..['icon'] = '还没见过的名字');
    expect(app, isNotNull, reason: '名字不认识不该让他的东西消失（模型层照样收下）');
    expect(app!.icon, '还没见过的名字');
    expect(miniAppIconFor(app.icon), Icons.widgets_outlined, reason: '★ 到画的时候兜底成默认图标');
    expect(miniAppIconFor('dice'), miniAppIcons['dice'], reason: '认识的名字要用它自己那个');
  });

  test('🔴 两张白名单不许漂：客户端映射表 vs 服务端 ICONS', () {
    // ⚠️ 只读一次源码、逐字对（两处漂了 = 线上会出现"图标画不出来"的空白方块）
    // ⚠️ 2026-09-23：图标库**收到了一处**（原来服务端有两份抄本，而这条判据只对了一份）
    //    ⇒ 现在只读 `app-icons.js` 这一份。
    final f = File('../../services/core/src/app-icons.js');
    expect(f.existsSync(), true, reason: '找不到服务端那份（cwd 不对？）');
    final src = f.readAsStringSync();
    final m = RegExp(r'export const ICONS = Object\.freeze\(\[([\s\S]*?)\]\)').firstMatch(src);
    expect(m, isNotNull, reason: '服务端那份 ICONS 的形状变了 ⇒ 这条判据要跟着改');
    final serverNames = RegExp("'([a-z0-9_-]+)'")
        .allMatches(m!.group(1)!)
        .map((x) => x.group(1)!)
        .toSet();
    final clientNames = miniAppIcons.keys.toSet();
    expect(clientNames.difference(serverNames), isEmpty, reason: '客户端多出来的名字');
    expect(serverNames.difference(clientNames), isEmpty, reason: '★ 服务端有、客户端没映射的名字（线上会画成空白）');
  });

  test('🔴 库里每一个名字都得有**自己的图形**（谁都不许落到兜底那个）', () {
    final fallback = miniAppIconFor('这个名字不存在');
    for (final name in miniAppIcons.keys) {
      expect(
        miniAppIconFor(name),
        isNot(fallback),
        reason: '「$name」画出来跟"认不出"一样 ⇒ 线上就是一堆同款图标',
      );
    }
  });

  test('内置那三个不算"我的"（而 `math` 已经**不是**内置了）', () {
    expect(MiniApp.isBuiltIn('settings'), true);
    expect(MiniApp.isBuiltIn('discover'), true);
    expect(MiniApp.isBuiltIn('harness'), true);
    expect(MiniApp.isBuiltIn('dice'), false);
    // 🔴 2026-09-25（契约 `docs/dev/105-DROP-MATH.md`）：奥数题那一格从产品里去掉 ⇒
    //    服务端 `BUILTIN_SCOPES` 不再认这个名字，客户端这里也必须跟着放手。
    expect(MiniApp.isBuiltIn('math'), false, reason: '★ 那个内置格没了 ⇒ `math` 不再是内置 id');
  });
  _discoverModelTests();
}

// ── 乙-3：「发现」里那一条 ──────────────────────────────────

void _discoverModelTests() {
  Map<String, Object?> okApp() => {
        'id': 'dice',
        'title': '掷骰子',
        'icon': 'dice',
        'version': 2,
        'author': '用户 3f2a',
        'permissions': <String>[],
      };

  test('发现里的一条：正常解析 / 缺东西就丢', () {
    final a = DiscoverApp.parse(okApp());
    expect(a, isNotNull);
    expect(a!.author, '用户 3f2a');
    expect(a.version, 2);
    expect(a.icon, 'dice', reason: '模型层只存图标名');
    expect(DiscoverApp.parse(okApp()..['author'] = ''), isNull, reason: '不知道谁发的就别列');
    expect(DiscoverApp.parse(okApp()..['title'] = '  '), isNull);
    expect(DiscoverApp.parse(okApp()..['id'] = ''), isNull);
    expect(DiscoverApp.parse('不是一条'), isNull);
  });



// ── ★ 2026-09-27（契约 `docs/dev/127-CREATE-APP-FROM-DESKTOP.md`）──────────
//    **"建一个空的小程序"那一条的回执**：与改名/复制**刻意不同** ——
//    它要**把服务端那句人话带回来**（上限住在他那儿，客户端不许自己编一个数）。
group('createAppOutcomeOf：那一条回执的分岔（纯函数）', () {
  test('200 且明说 ok ⇒ 成了（带回 id / title / icon）', () {
    final o = createAppOutcomeOf(
      200,
      jsonEncode({'ok': true, 'id': 'app-x1', 'title': '买菜清单', 'icon': 'dice'}),
    );
    expect(o, isA<CreateAppOk>());
    final ok = o as CreateAppOk;
    expect(ok.id, 'app-x1');
    expect(ok.title, '买菜清单');
    expect(ok.icon, 'dice');
  });

  test('401 ⇒ 令牌不行（那是另一件事，不是"没建成"）', () {
    expect(createAppOutcomeOf(401, ''), isA<CreateAppUnauthorized>());
  });

  test('🔴 其余（含 400 与"200 但回执不 ok"）⇒ 没成，而且**带上服务端那句话**', () {
    final bad = createAppOutcomeOf(
      400,
      jsonEncode({'error': 'title-too-long', 'text': '名字太长了（最多 40 个字）。'}),
    );
    expect(bad, isA<CreateAppFailed>());
    expect((bad as CreateAppFailed).words, '名字太长了（最多 40 个字）。', reason: '★ 原话上屏');

    // 200 但 `ok` 不是 true ⇒ **一个字节都不当成功**
    expect(createAppOutcomeOf(200, jsonEncode({'id': 'x'})), isA<CreateAppFailed>());
    // 读不出来的回执 / 网络那一条的兜底 ⇒ 空串（界面用自己那句）
    expect((createAppOutcomeOf(502, '<html>') as CreateAppFailed).words, '');
    expect((createAppOutcomeOf(500, '') as CreateAppFailed).words, '');
  });
});

}