// **"越远越快、越近越慢"**（主人 2026-09-24 定案）· 契约 `docs/dev/73-MOTION-APP.md`。
//
// 那句话是一条**可判**的式子：**速度与剩余距离成正比** ⇒ 指数逼近。
// 这一份把它的形状钉住（纯函数，不靠界面断言）：
//   ① 两头对得上（f(0)=0、f(1)=1）② 一路只往前 ③ **前段猛、尾段黏**（越远越快）
//   ④ 和"线性"真的不一样（不然主人要的那件事没发生）

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/design.dart' as d;
import 'package:hupo_app/widgets/motion.dart';

void main() {
  const c = miniAppOpenCurve;

  test('两头对得上：f(0)=0、f(1)=1（不然会跳一下）', () {
    expect(c.transform(0), closeTo(0, 1e-9));
    expect(c.transform(1), closeTo(1, 1e-9));
  });

  test('一路只往前（单调，不许回头）', () {
    var last = -1.0;
    for (var i = 0; i <= 100; i++) {
      final v = c.transform(i / 100);
      expect(v, greaterThanOrEqualTo(last));
      last = v;
    }
  });

  test('★ 越远越快：前半程就把大部分距离走完（剩下的是"轻轻落"）', () {
    // 线性的话 t=0.25 只走 25%；主人要的是"越远越快" ⇒ 这里必须远大于它
    expect(c.transform(0.25), greaterThan(0.65), reason: '前 1/4 时间该走掉六成半以上');
    expect(c.transform(0.5), greaterThan(0.85), reason: '一半时间该差不多到位');
    // 而**尾段必须慢**：最后 1/4 时间走的距离，远小于前 1/4
    final firstQuarter = c.transform(0.25) - c.transform(0);
    final lastQuarter = c.transform(1) - c.transform(0.75);
    expect(lastQuarter, lessThan(firstQuarter / 4), reason: '越近越慢 —— 尾段只许挪一点点');
  });

  test('和线性真的不一样（不然这条曲线白加）', () {
    for (final t in [0.1, 0.25, 0.5, 0.75]) {
      expect(c.transform(t), greaterThan(t), reason: 't=$t 时该在线性前面');
    }
  });

  test('★ 两个方向都是"越远越快、越近越慢"（关掉那一下**不许**先冻住再砸回去）', () {
    // 打开：走了 u 的时间，位置该走掉 f(u)
    expect(miniAppSurfaceProgress(value: 0.25, closing: false), closeTo(c.transform(0.25), 1e-9));
    // 关掉：控制器从 1 往 0 走。**已用时间 u = 1 − value** ⇒ 位置 = 1 − f(u)
    //   u=0.25（刚关掉一会儿）⇒ 位置 ≈ 0.29 ⇒ **已经往回走了七成**（前段猛）
    final quarter = miniAppSurfaceProgress(value: 0.75, closing: true);
    expect(quarter, lessThan(0.35), reason: '关掉的前 1/4 时间该走掉七成以上');
    // 而快回到图标时（u=0.75）只剩一点点距离 ⇒ 慢
    final threeQuarters = miniAppSurfaceProgress(value: 0.25, closing: true);
    expect(threeQuarters, lessThan(0.15), reason: '越近越慢：最后那点距离要慢慢收');
    // 两头对得上：控制器的 1 = 刚按"关"（还全屏）、0 = 收完了（回到图标）
    expect(miniAppSurfaceProgress(value: 1, closing: true), closeTo(1, 1e-9));
    expect(miniAppSurfaceProgress(value: 0, closing: true), closeTo(0, 1e-9));
    // 反向对照：**不许**是"直接倒放曲线"那种（f(1−u) 在 u=0.25 时几乎还是 1）
    expect(c.transform(0.75), greaterThan(0.9), reason: '（这就是直接倒放的样子 —— 先冻住）');
    expect(quarter, lessThan(c.transform(0.75) - 0.5), reason: '两个方向必须不一样');
  });

  test('时长是主人给的 0.5 秒（它和首页那个 400ms 是两件事）', () {
    expect(d.motionAppOpen, const Duration(milliseconds: 500));
    expect(d.motionAppOpen, isNot(d.motionPage));
  });
}
