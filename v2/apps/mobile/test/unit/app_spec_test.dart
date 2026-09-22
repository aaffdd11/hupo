// **我的小程序清单**：解析与白名单（乙-1 · 契约 `docs/dev/59-USER-APPS.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **拿不到入口 URL / 已经过期 ⇒ 不摆**（摆了就是"点了没反应"）
//   ② 🔴 **图标名认不出来 ≠ 把东西藏掉**：用默认图标（他的东西不许因为一个名字消失）
//   ③ 🔴 **两张白名单不许漂**：客户端这份映射表 vs 服务端 `apps.js` 的 `ICONS` 逐字对
//   ④ 一条坏记录不许把整个桌面弄空（跳过那一条）

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/app_spec.dart';
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
    final f = File('../../services/core/src/apps.js');
    expect(f.existsSync(), true, reason: '找不到服务端那份（cwd 不对？）');
    final src = f.readAsStringSync();
    final m = RegExp(r'export const ICONS = Object\.freeze\(\[([^\]]*)\]\)').firstMatch(src);
    expect(m, isNotNull, reason: '服务端那份 ICONS 的形状变了 ⇒ 这条判据要跟着改');
    final serverNames = RegExp("'([a-z0-9_-]+)'")
        .allMatches(m!.group(1)!)
        .map((x) => x.group(1)!)
        .toSet();
    final clientNames = miniAppIcons.keys.toSet();
    expect(clientNames.difference(serverNames), isEmpty, reason: '客户端多出来的名字');
    expect(serverNames.difference(clientNames), isEmpty, reason: '★ 服务端有、客户端没映射的名字（线上会画成空白）');
  });

  test('内置那两个不算"我的"', () {
    expect(MiniApp.isBuiltIn('math'), true);
    expect(MiniApp.isBuiltIn('settings'), true);
    expect(MiniApp.isBuiltIn('dice'), false);
  });
}
