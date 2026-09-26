// **一帧制品 ＋ "有新版了"那一帧** 的纯逻辑（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **一条 URL = 一个 viewId**（换版本 ⇒ 换 URL ⇒ 换 viewId ⇒ 换 iframe）；
//   ② 🔴 **那本账的两半**：`registered` **只增不减**（平台那边同一个 viewType
//      只许注册一次，销了号再注册会**当场抛**）；`hosted` **随换随销**（判据 U5）；
//   ③ 🔴 **`releaseMiniAppView` 两个平台都得有**（少了非 Web 那一份就编不过 ——
//      那正是"判据只在 Web 上跑得到"的老毛病）；
//   ④ 🔴 **Web 那一侧真的用了这本账**（重复注册那道闸不许又退回一个私有 `Set`）——
//      它是**源码级**判据，理由同 `mini_runtime_test.dart`：`dart:html` 在 VM 上
//      不存在，那一侧的行为在 `flutter test` 里**观察不到**。
//   ⑤ `AppUpdate.of` 认得出 / 认不出都安静（协议只加不改）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/mini_frame.dart';
import 'package:hupo_app/models/mini_update.dart';

/// 一份源码里的**代码行**（整行注释与行尾注释都去掉）。
///
/// 🔴 为什么判据要用它：那些"源码级"的判据（`dart:html` 在 VM 上不存在，
///    所以 Web 那一侧只能读源码钉）**一旦把注释也算进去，闸就是空的** ——
///    文字说明里提到某个名字，把真正的调用注释掉照样绿。这一条我自己踩过。
String codeOnly(String src) => src
    .split('\n')
    .map((l) {
      final i = l.indexOf('//');
      return i < 0 ? l : l.substring(0, i);
    })
    .join('\n');

void main() {
  test('🔴 一条 URL = 一个 viewId；换了版本 ⇒ 换了它', () {
    const v1 = 'http://127.0.0.1:8021/a/dice/1/index.html?u=u1&e=1&s=aa';
    const v2 = 'http://127.0.0.1:8021/a/dice/2/index.html?u=u1&e=2&s=bb';
    expect(miniViewIdOf(v1), miniViewIdOf(v1), reason: '同一条 URL ⇒ 同一个（不然每帧都重建）');
    expect(miniViewIdOf(v1) == miniViewIdOf(v2), false, reason: '★ 换版本 ⇒ 换 viewId');
    // ⚠️ 同版本**再签一次**（服务端每次都现签）也是一条新 URL ⇒ 也是一个新 viewId
    //   （所以"该不该换"只能由**版本号**判 —— 见 `_onAppUpdate`）
    const v1again = 'http://127.0.0.1:8021/a/dice/1/index.html?u=u1&e=9&s=cc';
    expect(miniViewIdOf(v1) == miniViewIdOf(v1again), false);
  });

  test('🔴 U5：`registered` **只增不减**，`hosted` **随换随销**', () {
    final l = MiniViewLedger();
    const a = 'hupo-mini-a';
    const b = 'hupo-mini-b';
    // 注册：第一次 true（该去注册）、第二次 false（**不许再注册一次** —— 会抛）
    expect(l.register(a), true);
    expect(l.register(a), false, reason: '★ 重复注册那道闸就在这儿');
    expect(l.isRegistered(a), true);
    // 挂载/销号
    l.host(a);
    expect(l.isHosted(a), true);
    expect(l.hosted, {a});
    // 换了一帧：旧的销号，新的挂上 —— **注册那本账一个字都不动**
    l.host(b);
    expect(l.unhost(a), true);
    expect(l.isHosted(a), false, reason: '★ 旧那一帧收干净了');
    expect(l.isHosted(b), true);
    expect(l.hosted, {b});
    expect(l.isRegistered(a), true, reason: '★ 销了号再注册会当场抛 ⇒ 注册那本账只增不减');
    // 幂等：没挂过的再销一次不算错（换帧/关闭两条路都会叫它）
    expect(l.unhost(a), false);
    expect(l.unhost(b), true);
    expect(l.hosted, isEmpty);
  });

  test('★ 真那一本账（壳用的就是它）也是这个形状', () {
    expect(miniViewLedger, isA<MiniViewLedger>());
    expect(miniViewLedger.hosted, isEmpty, reason: '这一条跑在别的用例之前时该是空的');
  });

  test('🔴 `releaseMiniAppView` 两个平台都得有（不然非 Web 那一侧编不过）', () {
    for (final name in ['lib/widgets/mini_runtime_stub.dart', 'lib/widgets/mini_runtime_web.dart']) {
      final src = File(name).readAsStringSync();
      expect(src.contains('void releaseMiniAppView(String viewId)'), true,
          reason: '$name 少了「releaseMiniAppView」—— 两份签名必须一样');
    }
    // 而且换帧那一刀**真的叫了它**（不然"旧那一帧收干净"只是句口号）
    // 🔴 **只看代码行**（注释里提到那两个名字不算）：这一条一开始就是这么栽的 ——
    //    文件顶上那段说明里写着 `releaseMiniAppView(旧的)`，
    //    于是"把调用注释掉"这种变异照样绿。判据打在注释上 = 闸是空的。
    final frame = codeOnly(File('lib/widgets/mini_app_frame.dart').readAsStringSync());
    expect(frame.contains('releaseMiniAppView(viewId);'), true,
        reason: '换帧时没叫它 ⇒ 旧那一帧的监听留着（一次"问一句"会花两次）');
    expect(frame.contains('miniViewLedger.unhost(viewId);'), true,
        reason: '换帧时没销号 ⇒ 判据 U5 红');
  });

  test('🔴 Web 那一侧用的是**同一本账**（重复注册那道闸不许又退回一个私有 Set）', () {
    final src = codeOnly(File('lib/widgets/mini_runtime_web.dart').readAsStringSync());
    expect(src.contains('miniViewLedger.register(viewId)'), true,
        reason: '★ 注册那本账只有一处（`models/mini_frame.dart`）');
    expect(src.contains('_registered'), false,
        reason: '★ 又冒出一个私有 Set ⇒ 两本账迟早对不上（判据 U5 就是钉它的）');
    expect(src.contains('miniViewIdOf(entryUrl)'), true,
        reason: 'viewId 的算法只有一处');
  });

  test('`AppUpdate.of`：认得出就给出 id/版本，认不出**安静忽略**', () {
    expect(AppUpdate.of({'type': 'app/update-available', 'id': 'dice', 'version': 2}),
        const AppUpdate(id: 'dice', version: 2));
    for (final bad in <Map<String, dynamic>>[
      {},
      {'type': 'app/installed', 'appId': 'dice', 'title': '掷骰子'},
      {'type': 'app/update-available'},
      {'type': 'app/update-available', 'id': '', 'version': 2},
      {'type': 'app/update-available', 'id': 'dice', 'version': 0},
      {'type': 'app/update-available', 'id': 'dice', 'version': '2'},
      {'type': 'app/update-available', 'id': 'dice'},
    ]) {
      expect(AppUpdate.of(bad), null, reason: '认不出的该安静忽略：$bad');
    }
  });
}
