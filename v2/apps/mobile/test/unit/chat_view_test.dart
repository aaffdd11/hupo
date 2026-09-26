// 浮窗里看哪一屏（聊天 / 轨迹）—— 枚举与本地存储
// （契约 `docs/dev/118-TRAJECTORY-VIEW.md` §一；写法照 `process_level_store_test.dart`）。
//
// ⚠️ 这一份钉的是一句话：**坏了一律当默认值，绝不抛**。
//    它是本机的一个偏好 —— 读不出来最多是"回到聊天那一屏"，
//    **绝不能因此让浮窗打不开**。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/chat_view.dart';
import 'package:hupo_app/services/chat_view_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  group('两个视图的身份与字', () {
    test('★ 就两档，token 与 tab 上的字都不许漂', () {
      expect(ChatView.values.length, 2);
      expect(ChatView.chat.wire, 'chat');
      expect(ChatView.trajectory.wire, 'trajectory');
      expect(ChatView.chat.tab, '聊天');
      expect(ChatView.trajectory.tab, '轨迹');
      expect(defaultChatView, ChatView.chat);
    });

    test('🔴 认不出来的 token ⇒ 默认那一档（绝不抛）', () {
      expect(chatViewOf(null), ChatView.chat);
      expect(chatViewOf(''), ChatView.chat);
      expect(chatViewOf('Trajectory'), ChatView.chat);
      expect(chatViewOf('trajectory '), ChatView.chat);
      expect(chatViewOf(7), ChatView.chat);
      expect(chatViewOf({'view': 'trajectory'}), ChatView.chat);
    });

    test('认得出就照它来', () {
      expect(chatViewOf('trajectory'), ChatView.trajectory);
      expect(chatViewOf('chat'), ChatView.chat);
    });
  });

  group('存在哪（按设备）', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('★ 没存过 ⇒ 默认档（聊天）', () async {
      expect(await ChatViewStore().read(), defaultChatView);
      expect(await ChatViewStore().read(), ChatView.chat);
    });

    test('存了再读：还是那一档（两档都走一遍）', () async {
      for (final v in ChatView.values) {
        SharedPreferences.setMockInitialValues({});
        final s = ChatViewStore();
        await s.write(v);
        expect(await ChatViewStore().read(), v, reason: '${v.wire} 丢了');
      }
    });

    test('🔴 盘上是个坏值 ⇒ 默认档（**不许抛、也不许猜**）', () async {
      for (final bad in <Object>['', 'Track', 'TRAJECTORY', 'trajectory ', '{"view":"x"}']) {
        SharedPreferences.setMockInitialValues({'hupo_chat_view': bad});
        expect(
          await ChatViewStore().read(),
          defaultChatView,
          reason: '「$bad」被当成了一个视图',
        );
      }
    });

    test('🔴 盘上是个别的类型（不是字符串）⇒ 默认档，不抛', () async {
      SharedPreferences.setMockInitialValues({'hupo_chat_view': 7});
      expect(await ChatViewStore().read(), defaultChatView);
    });

    test('同一份 store 读第二次走内存缓存（不会变）', () async {
      final s = ChatViewStore();
      await s.write(ChatView.trajectory);
      expect(await s.read(), ChatView.trajectory);
      expect(await s.read(), ChatView.trajectory);
    });
  });
}
