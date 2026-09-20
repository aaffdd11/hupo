// 「跟到底部」的判据（欠账第 24 条）。
//
// ⚠️ 为什么这条规则配得上一个硬闸：它**算错过一次**，而错的时候
//    **屏幕上完全看不出错**——"停在最老那条"和"跟上了"都只是一屏字。
//    实测证据：`docs/dev/00-PROGRESS.md` §六 第 24 条。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/scroll_follow.dart';

void main() {
  group('纯函数：这一帧该不该跟到底部', () {
    test('🔴 首屏 + 一屏放不下的历史 ⇒ **必须跟到底**（第 24 条就是这里错的）', () {
      expect(
        scrollFollowAction(pixels: 0, maxScrollExtent: 2000, userScrolledAway: false),
        FollowAction.jump,
        reason: '老判据是"离底部 < 160"，而 pixels==0 对上 2000 ⇒ 恒 false ⇒ 停在最老那条',
      );
    });

    test('用户从没往上翻过 ⇒ 离底部再远也跟着（不许"因为离得远就不跟"）', () {
      expect(
        scrollFollowAction(pixels: 0, maxScrollExtent: 99999, userScrolledAway: false),
        FollowAction.jump,
      );
    });

    test('已经在底部 ⇒ 什么都不做（不然每帧都跳一次）', () {
      expect(
        scrollFollowAction(pixels: 2000, maxScrollExtent: 2000, userScrolledAway: false),
        FollowAction.none,
      );
      expect(
        scrollFollowAction(pixels: 2000, maxScrollExtent: 2000, userScrolledAway: true),
        FollowAction.none,
      );
    });

    test('内容还没超过一屏（没得滚）⇒ 什么都不做', () {
      for (final away in [false, true]) {
        expect(
          scrollFollowAction(pixels: 0, maxScrollExtent: 0, userScrolledAway: away),
          FollowAction.none,
          reason: 'userScrolledAway=$away',
        );
        expect(
          scrollFollowAction(pixels: 0, maxScrollExtent: -1, userScrolledAway: away),
          FollowAction.none,
          reason: '负的也不许崩',
        );
      }
    });

    test('★ 用户自己往上翻过 ⇒ **不许打断他**（离得远就一条都不发）', () {
      expect(
        scrollFollowAction(pixels: 100, maxScrollExtent: 2000, userScrolledAway: true),
        FollowAction.none,
        reason: '他在看上面的东西，新消息进来不许把他拽下去',
      );
    });

    test('★ 用户翻上去了、但人就在底部附近 ⇒ 跟（用动画，不跳）', () {
      expect(
        scrollFollowAction(pixels: 1990, maxScrollExtent: 2000, userScrolledAway: true),
        FollowAction.animate,
      );
    });

    test('边界：宽容带是**开区间**（`< followSlack`），两侧各钉一条', () {
      expect(
        scrollFollowAction(
          pixels: 2000 - (followSlack - 1),
          maxScrollExtent: 2000,
          userScrolledAway: true,
        ),
        FollowAction.animate,
      );
      expect(
        scrollFollowAction(
          pixels: 2000 - followSlack,
          maxScrollExtent: 2000,
          userScrolledAway: true,
        ),
        FollowAction.none,
      );
    });

    test('同一次调用里：翻过与否**结论不同**（不然这个布尔是白加的）', () {
      const pixels = 0.0;
      const max = 2000.0;
      expect(
        scrollFollowAction(pixels: pixels, maxScrollExtent: max, userScrolledAway: false),
        FollowAction.jump,
      );
      expect(
        scrollFollowAction(pixels: pixels, maxScrollExtent: max, userScrolledAway: true),
        FollowAction.none,
      );
    });
  });
}
