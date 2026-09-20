// 状态条上那句"我们俩之间这条线怎么样"。
//
// ⚠️ **这一页钉的是一次"页面在说假话"**：
//    从前只有 `reconnecting` 一个状态，屏幕永远说「网断了，我在等它回来」。
//    可那个状态是**探针问完之后**才下的判断——探针答 200 就说明服务端明明在、
//    网是通的，这时候还说"网断了"就是假话。
//    假话把排查带偏了一整轮：看起来像用户的网，实际是浏览器把这一跳拒了。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/forbidden_words.dart';

void main() {
  group('状态条', () {
    test('🔴 服务端在（探针 200）⇒ **不许**说"网断了"', () {
      final (text, isError) = statusLine(ConnState.streamBlocked);
      expect(text, isNotNull);
      expect(text!.contains('网断了'), false, reason: '网是通的还说"网断了"就是假话：$text');
      expect(text.contains('网是通的'), true);
      expect(isError, false); // 不是错误，是"我在重试"——别吓人
    });

    test('🔴 网真断了 ⇒ 才说"网断了"', () {
      final (text, _) = statusLine(ConnState.reconnecting);
      expect(text, '网断了，我在等它回来');
    });

    test('两个"接不上"说的不是同一句话（不然就该合成一个状态了）', () {
      final (a, _) = statusLine(ConnState.reconnecting);
      final (b, _) = statusLine(ConnState.streamBlocked);
      expect(a == b, false);
    });

    test('一切正常时**不占地方**（状态条常驻会变成噪音）', () {
      expect(statusLine(ConnState.connected).$1, isNull);
      // 连上之前留下过一句话，就连着显示
      final (text, isError) = statusLine(ConnState.connected, error: '上次没发出去');
      expect(text, '上次没发出去');
      expect(isError, true);
    });

    test('要用户动手的两条是"错误色"（登录过期 / 还没设密码）', () {
      expect(statusLine(ConnState.unauthorized).$2, true);
      expect(statusLine(ConnState.notSetup).$2, true);
      expect(statusLine(ConnState.idle).$2, false);
    });

    test('🔴 每一句都不许含禁用词', () {
      for (final s in ConnState.values) {
        final (text, _) = statusLine(s);
        if (text == null) continue;
        expect(scanForbidden(text), isEmpty, reason: '「$text」里有禁用词');
      }
    });
  });
}
