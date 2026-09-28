// 安卓清单里的**配置断言**。
//
// ⚠️ 为什么这种测试要存在：它不是"逻辑"，是"**一个装上去才会发现的坑**"。
//    而它**已经在本仓库里发生过两次**：
//      · 旧 app：release 包没网（commit 3084b37 修好）
//      · v2 全新重建：**又犯了一遍**（`00-PROGRESS.md` §四 第 2 条）
//    ⇒ 光有注释挡不住第三次，得有条会红的测试。
//
// 依据：手册 `08-SPEC.md` §13.3 的 CI 判据那一类（配置断言；N21 也是这个性质）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 主清单。**注意不是 `src/debug` 与 `src/profile` 那两个**——
/// 那两个 Flutter 模板本来就带 INTERNET（给 hot reload 用），
/// 所以拿它们来验等于什么都没验。
const _mainManifest = 'android/app/src/main/AndroidManifest.xml';

String _read() {
  final f = File(_mainManifest);
  expect(f.existsSync(), isTrue, reason: '找不到 $_mainManifest（测试的工作目录是包根）');
  return f.readAsStringSync();
}

/// 扫出"注释住进了标签里"的那些标签（合法 XML 里**一个都不该有**）。
///
/// 判法：从每个 `<` 走到它那个 `>`，路上撞见 `<!--` ⇒ 那一段就是坏形状。
/// ⚠️ 抽成函数是为了能拿"改坏的源码"喂它（负向对照）。
List<String> tagsWithComments(String src) {
  final bad = <String>[];
  var i = 0;
  while (i < src.length) {
    final lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      // 跳过整段注释（注释里的 `<` 不算标签）
      final end = src.indexOf('-->', lt);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    final gt = src.indexOf('>', lt);
    if (gt < 0) break;
    final inside = src.substring(lt, gt);
    if (inside.contains('<!--')) bad.add(inside.trim());
    i = gt + 1;
  }
  return bad;
}

void main() {
  group('安卓清单', () {
    test('🔴 main 里必须有 INTERNET —— 否则 release 装上去**没有网**', () {
      final m = _read();
      expect(
        m.contains('android.permission.INTERNET'),
        isTrue,
        reason: '加在 src/debug / src/profile 里没用：release 只用 main 这份',
      );
    });

    test('清单本身是能被解析的（XML 注释里不许有连续两个减号）', () {
      // ⚠️ 这一条也踩过：`<!-- ... -- ... -->` 会让整个 manifest 解析失败，
      //    而报错来自 ManifestMerger，指不到是哪一行。
      final m = _read();
      final comments = RegExp(r'<!--(.*?)-->', dotAll: true).allMatches(m);
      for (final c in comments) {
        final body = c.group(1) ?? '';
        // 注释体里出现 `--` 只有在紧贴结束符的位置才合法；中间出现就是错
        final inner = body.replaceAll(RegExp(r'-$'), '');
        expect(inner.contains('--'), isFalse, reason: '这段注释里有连续两个减号：${body.trim()}');
      }
      for (final tag in ['<manifest', '</manifest>', '<application']) {
        expect(m.contains(tag), isTrue, reason: '缺 $tag');
      }
    });

    test('🔴 注释不许住进标签里（那样就不是合法 XML —— 打包当场失败）', () {
      // ⚠️ **2026-09-28 我自己栽的**：把一段注释写在 `<application` 与它的属性之间
      //    （想解释 `android:label`），XML **不允许**这种形状。上面那条"能被解析"
      //    是正则级的、看不见它；真正抓到它的是 `flutter build apk`：
      //    *"Please ensure that the android manifest is a valid XML document"*。
      //    ⇒ 这条扫描补上那个盲区（且在几秒内跑完，不用等 Gradle）。
      final m = _read();
      expect(
        tagsWithComments(m),
        isEmpty,
        reason: '★ 注释要写在标签**外面**（`<application>` 之前或之后）',
      );
      // 负向对照：把"坏的那一段"喂进去必须报（不然这条扫描就是空转的）。
      expect(
        tagsWithComments('<application\n  <!-- 解释 -->\n  android:label="x">'),
        isNotEmpty,
      );
      expect(tagsWithComments('<application\n  android:label="x">\n  <!-- 外面 -->'), isEmpty);
    });

    test('🔴 桌面上的名字是「琥珀」，不是模板默认的 `hupo_app`', () {
      // ⚠️ 2026-09-28 加的：主人要"原生 flutter ＋ 装在自己的设备"⇒
      //    装上去第一眼看到的就是这个名字。模板默认 `hupo_app` 是**残留**，
      //    不是我们的名字（改之前打出来的那一个包里就是这么写的）。
      final m = _read();
      expect(m.contains('android:label="琥珀"'), isTrue,
          reason: '★ 桌面上那一格该写「琥珀」；写成 hupo_app 就是模板残留');
      expect(
        RegExp(r'android:label="hupo_app"').hasMatch(m),
        isFalse,
        reason: '★ 模板默认那个名字不许回来',
      );
    });

    test('🔴 后台录音一票否决；而 `RECORD_AUDIO` 现在**必须在**（V10）', () {
      // ⚠️ **先剥掉 XML 注释**：上面那段注释里正写着"`RECORD_BACKGROUND_AUDIO` 一个都不许有"
      //    （注释里出现这个词是**说明**，不是申请）⇒ 不剥的话这条判据会自己把自己判红。
      //    （`mini_sandbox_test.dart` 里那条"先剥注释"是同一个教训。）
      final m = _read()
          .replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');
      expect(
        m.contains('RECORD_BACKGROUND_AUDIO'),
        isFalse,
        reason: '这是一票否决那条：拿着它可以在用户不知道的时候录音',
      );
      // ★ 2026-09-28：**这一条反过来了**（原来是"批 5 之前不该有"）——
      //    原生那份录音做出来了（`NativeRecorder.kt`，主人："你帮我测试录音能力。"）⇒
      //    手册 `08-SPEC.md` §13.3 的 **V10** 要求它**必须在**，否则按下去只会有
      //    `SecurityException`（而界面上看起来就是"点了没反应"）。
      expect(
        m.contains('android.permission.RECORD_AUDIO'),
        isTrue,
        reason: '★ 录音那一份要用它；少了它，真机上按下去只会当场失败',
      );
      // ⚠️ **问权限那一下的落点也得在**（D5.11：第一次按下去才问，不是启动时问）
      final kt = File('android/app/src/main/kotlin/chat/hupo/hupo_app/NativeRecorder.kt');
      expect(kt.existsSync(), isTrue, reason: '★ 原生录音那一份不见了');
      final src = kt.readAsStringSync();
      expect(src.contains('requestPermissions'), isTrue, reason: '★ 第一次按下去要问权限（D5.11）');
      expect(src.contains('AudioSource.MIC'), isTrue, reason: '★ 录的得是麦克风');
      expect(src.contains('start()'), isTrue);
    });

  });
}
