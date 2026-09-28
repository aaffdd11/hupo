// **原生那一层（WebView）的两条硬规矩**（契约 `docs/dev/129-NATIVE-ANDROID-BUILD.md`）。
//
// ── 为什么这一份必须在 VM 上跑得起来 ────────────────────────
//   原生那一层**在 `flutter test` 里起不来**（VM 上没有 WebView 插件）⇒
//   它的行为只能做成**纯逻辑** ＋ **源码级扫描**，才量得到：
//     ① 导航只许在制品自己那个 origin 里走（`miniNavigationAllowed`）；
//     ② 🔴 **不许有原生桥**（`08-SPEC.md` §14.1 铁律 3 ＋ "全库 grep 命中 = 0"）。
//   ⚠️ 少一条，原生那一层就会变成"**只有装到手机上才知道对不对**"的东西 ——
//      而这个仓库已经栽过很多次"闸打在另一侧"。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/mini_frame.dart';

const _entry = 'https://apps.stalkerai.cn/w/aoshu-bank/index.html?u=u2&e=1&s=x';

/// 扫一段源码里有没有"原生桥"那类 API（剥掉注释再扫）。
///
/// ⚠️ 抽成函数**就是为了能拿"改坏的源码"喂它**（负向对照见下面那条）。
/// ⚠️ 这个仓库里 `mini_runtime_web.dart` 的**注释**正写着"那条唯一的回话通道"，
///    所以必须先剥注释，不然判据会自己把自己判红（`mini_sandbox_test.dart` 同一条教训）。
List<String> bridgeApisIn(String src) {
  final code = src
      .split('\n')
      .map((l) => l.contains('//') ? l.substring(0, l.indexOf('//')) : l)
      .join('\n');
  const banned = [
    'addJavascriptInterface', // Android 那一侧的真实名字（小写 s）
    'addJavaScriptInterface', // 常见笔误，一起拦（错的是拼写，不放过）
    'addWebMessageListener',
    'JavaScriptChannel',
    'createJavaScriptChannel',
    'javaScriptChannel',
    'runJavaScript',
    'runJavaScriptReturningResult',
  ];
  return [for (final b in banned) if (code.contains(b)) b];
}

void main() {
  group('导航只许在制品自己那个 origin 里走', () {
    test('制品自己那一份（含子路径/查询/锚点）⇒ 放行', () {
      for (final t in [
        _entry,
        'https://apps.stalkerai.cn/w/aoshu-bank/other.html',
        'https://apps.stalkerai.cn/w/aoshu-bank/index.html?u=u2&e=2&s=y#top',
        '', // WebView 自己的空白起点
        'about:blank',
      ]) {
        expect(miniNavigationAllowed(entryUrl: _entry, target: t), true, reason: '该放行：$t');
      }
    });

    test('🔴 别的 origin / 危险协议 ⇒ 一个都不放', () {
      for (final t in [
        'https://w.stalkerai.cn/', // 壳自己的原点（制品没有理由去那儿）
        'https://apps.stalkerai.cn.evil.com/w/a/index.html', // 后缀像的（**最容易骗过"域名包含"那种判法**）
        'https://evil.com/https://apps.stalkerai.cn/', // 前面套一层
        'http://apps.stalkerai.cn/w/a/index.html', // 协议降级（签名是绑在 https 那条路上的）
        'http://127.0.0.1:8021/w/a/index.html', // 制品口的本机地址（端口不同）
        'javascript:alert(1)',
        'data:text/html,<script>1</script>',
        'file:///data/local/tmp/x.html',
        'not a url at all',
      ]) {
        expect(miniNavigationAllowed(entryUrl: _entry, target: t), false, reason: '该拦住：$t');
      }
    });

    test('负向对照：入口本身不是一条绝对地址时，**什么都不放**（只留空白起点）', () {
      expect(miniNavigationAllowed(entryUrl: '/relative/x.html', target: 'https://a/b'), false);
      expect(miniNavigationAllowed(entryUrl: '/relative/x.html', target: 'about:blank'), true);
    });
  });

  group('🔴 铁律：原生那一层不许有桥', () {
    test('这棵树的 lib/ 里，原生桥 API 命中 = 0（手册 §14.1 那条验收）', () {
      final hits = <String>[];
      var scanned = 0;
      for (final e in Directory('lib').listSync(recursive: true)) {
        if (e is! File || !e.path.endsWith('.dart')) continue;
        scanned += 1;
        for (final api in bridgeApisIn(e.readAsStringSync())) {
          hits.add('${e.path}: $api');
        }
      }
      expect(scanned, greaterThan(100), reason: '★ 负向对照：只扫到 $scanned 份 ⇒ 这条扫描空转了');
      expect(hits, isEmpty,
          reason: '★ 出现了原生桥 API：铁律 3 是"禁原生桥"（制品不许能指挥壳）。\n'
              '  要开它先改手册那一条（安全模型上的事，得主人拍板），别在这一层偷偷加。\n${hits.join('\n')}');
    });

    test('负向对照：把"改坏的源码"喂给扫描函数 ⇒ 必须报出来', () {
      expect(bridgeApisIn("w.addJavascriptInterface(obj, 'x');"), ['addJavascriptInterface']);
      expect(bridgeApisIn("w.addJavaScriptInterface(obj, 'x');"), ['addJavaScriptInterface']);
      expect(bridgeApisIn("JavaScriptChannel(name: 'hupo', onMessageReceived: (_) {})"),
          ['JavaScriptChannel']);
      expect(bridgeApisIn('// 这里只是注释里提到 JavaScriptChannel\n'), isEmpty,
          reason: '★ 注释不该算命中（剥注释那一行要是坏了，这条会红）');
      expect(
        bridgeApisIn("void releaseMiniAppView(String viewId) { nativeMiniAppRelease?.call(viewId); }"),
        isEmpty,
        reason: '★ 我们自己那一句正常代码不许被误判',
      );
    });
  });
}
