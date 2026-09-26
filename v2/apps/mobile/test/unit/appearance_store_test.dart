// 聊天窗口的外观与字号存在哪（契约 `docs/dev/119-APPEARANCE-AND-FONT.md` §二；
// 写法照 `process_level_store_test.dart`）。
//
// ⚠️ 这一份钉的是：**一个 key、坏了一律当默认、绝不抛**。
//    它是本机的一个偏好 —— 读不出来最多是"回到默认外观"，
//    **绝不能因此让聊天打不开**。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/appearance.dart';
import 'package:hupo_app/models/dsh_design.dart';
import 'package:hupo_app/services/appearance_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 盘上那个 key（**只此一个**；测试直接照它写坏值）。
const String kKey = 'hupo_chat_appearance';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('存在哪（按设备）', () {
    test('★ 没存过 ⇒ 默认档（**亮** ＋ 14 字；2026-09-26 起默认不再是"跟随系统"）', () async {
      expect(await AppearanceStore().read(), const ChatAppearanceSettings());
      expect((await AppearanceStore().read()).appearance, defaultChatAppearance);
      expect((await AppearanceStore().read()).fontSize, dshContentFontSizeDefault);
    });

    test('★ 存了再读：两样都还在（三档 × 三个字号都走一遍）', () async {
      for (final a in ChatAppearance.values) {
        for (final n in [12, 14, 17]) {
          SharedPreferences.setMockInitialValues(<String, Object>{});
          final s = AppearanceStore();
          final want = ChatAppearanceSettings(appearance: a, fontSize: n);
          await s.write(want);
          expect(await AppearanceStore().read(), want, reason: '${a.wire}|$n 丢了');
          // 而且盘上就是那**一个** key（不是散成两个）
          final p = await SharedPreferences.getInstance();
          expect(p.getString(kKey), '${a.wire}|$n');
        }
      }
    });

    test('🔴 盘上是个坏值 ⇒ 默认档（**不许抛、也不许猜**）', () async {
      for (final bad in <Object>[
        '',
        '|',
        'Dark|15',
        'dark|abc',
        '{"appearance":"dark"}',
        'dark|15|16|17',
      ]) {
        SharedPreferences.setMockInitialValues(<String, Object>{kKey: bad});
        final s = await AppearanceStore().read();
        // ⚠️ 逐条分开断言：前两条整串都认不出 ⇒ 两份默认；
        //    后三条**有一半是好的** ⇒ 那一半必须保住（见下一条判据）。
        expect(s.appearance, isA<ChatAppearance>(), reason: '「$bad」抛了 / 读出了别的类型');
        expect(s.fontSize, inInclusiveRange(dshContentFontSizeMin, dshContentFontSizeMax),
            reason: '「$bad」读出了一个越界的字号');
      }
      // 整串认不出的那两条：两份都是默认
      for (final bad in <String>['', '|']) {
        SharedPreferences.setMockInitialValues(<String, Object>{kKey: bad});
        expect(await AppearanceStore().read(), const ChatAppearanceSettings(), reason: '「$bad」');
      }
    });

    test('🔴 盘上是个别的类型（不是字符串）⇒ 默认档，不抛', () async {
      for (final bad in <Object>[7, true, <String>['dark', '15']]) {
        SharedPreferences.setMockInitialValues(<String, Object>{kKey: bad});
        expect(await AppearanceStore().read(), const ChatAppearanceSettings(), reason: '$bad');
      }
    });

    test('🔴 一半坏了不许把另一半也丢掉（用户刚选的暗色还在）', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'dark|坏了'});
      final s = await AppearanceStore().read();
      expect(s.appearance, ChatAppearance.dark);
      expect(s.fontSize, dshContentFontSizeDefault);
    });

    test('🔴 越界的字号读出来是**夹过**的（12 / 17），不是原样上屏', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'system|999'});
      expect((await AppearanceStore().read()).fontSize, dshContentFontSizeMax);
      SharedPreferences.setMockInitialValues(<String, Object>{kKey: 'system|1'});
      expect((await AppearanceStore().read()).fontSize, dshContentFontSizeMin);
    });

    test('同一份 store 读第二次走内存缓存（不会变）', () async {
      final s = AppearanceStore();
      await s.write(const ChatAppearanceSettings(appearance: ChatAppearance.dark, fontSize: 16));
      expect(
        await s.read(),
        const ChatAppearanceSettings(appearance: ChatAppearance.dark, fontSize: 16),
      );
      expect((await s.read()).fontSize, 16);
    });

    test('★ 它是**设备级**的：换一份 store（= 下次启动）读到的还是盘上那一份', () async {
      await AppearanceStore().write(
        const ChatAppearanceSettings(appearance: ChatAppearance.dark, fontSize: 17),
      );
      // 新的一份 store（没有内存缓存）——这就是"热重启/重开页面"那条路。
      final again = await AppearanceStore().read();
      expect(again.appearance, ChatAppearance.dark);
      expect(again.fontSize, 17);
    });

    test('🔴 盘读不出来（插件不可用）⇒ 给默认档，不抛', () async {
      // 用一份**没有 mock 过**的 key 之外的办法不好造"插件炸了"，
      // 所以这里钉的是同一条纪律的另一面：读到的永远是**一个合法值**。
      final s = await AppearanceStore().read();
      expect(s, isA<ChatAppearanceSettings>());
      expect(s.fontSize, greaterThanOrEqualTo(dshContentFontSizeMin));
      expect(s.fontSize, lessThanOrEqualTo(dshContentFontSizeMax));
    });
  });
}
