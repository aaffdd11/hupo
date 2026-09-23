// **小程序沙箱那三个属性**（P1-7，2026-09-24）· 手册 `08-SPEC.md` §九（N1 / 小程序沙箱）
//
// 🔴 为什么判据要打在**这个文件**上（V13 族）：那三个属性是**客户端自己写的那一行**
//    （`mini_runtime_web.dart` 里的 `IFrameElement`）。服务端、探针、别的闸都**看不到**它们 ——
//    少了 `sandbox` 就等于把"别人的代码"放进我们这一页里跑。
//
// ⚠️ 这份文件是 web-only（`dart:html`），VM 上跑不了 ⇒ 判据做成**源码级扫描**
//    ＋ **一份"改坏了必须抓住"的负向对照**（不然它就是一条永远为真的假闸）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 扫一段源码，回它有没有把沙箱三属性写对。
///
/// ⚠️ 单独抽成函数**就是为了能拿"改坏的源码"喂它**（负向对照）。
List<String> sandboxProblems(String src) {
  // ⚠️ **先把注释剥掉**：这个文件里正写着"故意不给 allow-same-origin"（注释里就有这个词），
  //    不剥的话这条判据会**自己把自己判红**。
  final code = src
      .split('\n')
      .map((l) => l.contains('//') ? l.substring(0, l.indexOf('//')) : l)
      .join('\n');
  final bad = <String>[];
  if (!RegExp(r"setAttribute\('sandbox',\s*'allow-scripts'\)").hasMatch(code)) {
    bad.add('没把 sandbox 设成 allow-scripts');
  }
  if (code.contains('allow-same-origin')) {
    bad.add('给了 allow-same-origin ⇒ 沙箱页面就能碰壳的存储（N1 那条就废了）');
  }
  if (!RegExp(r"setAttribute\('referrerpolicy',\s*'no-referrer'\)").hasMatch(code)) {
    bad.add('没设 referrerpolicy=no-referrer');
  }
  if (!RegExp(r"setAttribute\('allow',\s*''\)").hasMatch(code)) {
    bad.add('没把 allow 清空（摄像头/麦克风/定位一个都不该给）');
  }
  return bad;
}

void main() {
  final path = 'lib/widgets/mini_runtime_web.dart';
  final src = File(path).readAsStringSync();

  test('★ P1-7：沙箱三属性（只给 allow-scripts · 不给 allow-same-origin · 不留 referrer · 一个权限都不给）', () {
    expect(sandboxProblems(src), isEmpty, reason: '出问题的点：${sandboxProblems(src).join('；')}');
  });

  test('P1-7 负向对照：这份扫描**真的抓得住**（不是空转）', () {
    // ① 给了 allow-same-origin（最危险的那一种）⇒ 必须抓
    final bad1 = src.replaceFirst("'allow-scripts'", "'allow-scripts allow-same-origin'");
    expect(sandboxProblems(bad1).any((m) => m.contains('allow-same-origin')), isTrue);
    // ② 干脆不设 sandbox ⇒ 必须抓
    final bad2 = src.replaceFirst("setAttribute('sandbox', 'allow-scripts')", '');
    expect(sandboxProblems(bad2).any((m) => m.contains('sandbox')), isTrue);
    // ③ 把 allow 放开 ⇒ 必须抓
    final bad3 = src.replaceFirst("setAttribute('allow', '')", "setAttribute('allow', 'camera')");
    expect(sandboxProblems(bad3).any((m) => m.contains('allow')), isTrue);
  });
}
