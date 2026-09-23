// **重连退避**（P1-10，2026-09-24）· 契约 `docs/dev/16-STREAM.md`
//
// 这一档原来是 `stream.dart` 里一句写死的算式，没人判过。现在它在这儿：
//   · 逐档对表（1→2s · 2→4s · 3→6s · ≥4→**8s 封顶**）；
//   · **永不为 0**（0 秒重连 = 忙等，打服务器）；
//   · 单调不降（不许"下一次比上一次还快"）。
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/retry.dart';

void main() {
  test('★ P1-10：退避逐档对表（1→2 · 2→4 · 3→6 · 4+→8 封顶）', () {
    expect(retrySeconds(1), 2);
    expect(retrySeconds(2), 4);
    expect(retrySeconds(3), 6);
    expect(retrySeconds(4), 8);
    expect(retrySeconds(5), 8, reason: '封顶 8 秒：再长用户会觉得"它死了"');
    expect(retrySeconds(99), 8);
  });

  test('★ P1-10：退避**永不为 0**，而且单调不降（不许越等越快）', () {
    var last = 0;
    for (var i = 0; i <= 12; i++) {
      final s = retrySeconds(i);
      expect(s, greaterThan(0), reason: '0 秒重连 = 忙等（打服务器）');
      expect(s, greaterThanOrEqualTo(last), reason: '第 $i 次比上一次还快 ⇒ 退避失效');
      last = s;
    }
  });

  test('P1-10：乱传参数也不许炸（0 / 负数当第一次）', () {
    expect(retrySeconds(0), 2);
    expect(retrySeconds(-5), 2);
  });
}
