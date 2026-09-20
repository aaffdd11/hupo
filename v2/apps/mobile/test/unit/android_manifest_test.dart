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

    test('🔴 不许申请后台录音（批 5 的语音只做"按住说"）', () {
      final m = _read();
      expect(
        m.contains('RECORD_BACKGROUND_AUDIO'),
        isFalse,
        reason: '这是一票否决那条：拿着它可以在用户不知道的时候录音',
      );
      // ⚠️ 注意：`RECORD_AUDIO` 本体**还没加** —— 语音是批 5，那时才加。
      //    加了之后这一条要跟着改（手册 08-SPEC §13.3 的 V10 要求两个都要查）。
    });
  });
}
