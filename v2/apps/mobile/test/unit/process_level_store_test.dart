// 过程四档存哪（契约 §三；写法照 `token_store.dart` / `timeline_store.dart`）。
//
// ⚠️ 这一份钉的就一句话：**坏了一律当默认值，绝不抛**。
//    它是本机的一个偏好——读不出来最多是"回到默认档"，
//    **绝不能因此让聊天打不开**。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/services/process_level_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('四档的本地设置', () {
    test('★ 没存过 ⇒ 默认档 `doing`', () async {
      expect(await ProcessLevelStore().read(), defaultProcessLevel);
      expect(await ProcessLevelStore().read(), ProcessLevel.doing);
    });

    test('存了再读：还是那一档（四档都走一遍）', () async {
      for (final level in ProcessLevel.values) {
        SharedPreferences.setMockInitialValues({});
        final s = ProcessLevelStore();
        await s.write(level);
        expect(await ProcessLevelStore().read(), level, reason: '${level.wire} 丢了');
      }
    });

    test('🔴 盘上是个坏值 ⇒ 默认档（**不许抛、也不许猜**）', () async {
      for (final bad in <Object>['', 'loud', 'QUIET', 'doing ', '{"level":"steps"}']) {
        SharedPreferences.setMockInitialValues({'hupo_process_level': bad});
        expect(
          await ProcessLevelStore().read(),
          defaultProcessLevel,
          reason: '「$bad」被当成了一个档',
        );
      }
    });

    test('🔴 盘上是个别的类型（不是字符串）⇒ 默认档，不抛', () async {
      // 别的版本、别的东西动过这个 key 都可能造成这种局面。
      SharedPreferences.setMockInitialValues({'hupo_process_level': 7});
      expect(await ProcessLevelStore().read(), defaultProcessLevel);
    });

    test('同一份 store 读第二次走内存缓存（不会变）', () async {
      final s = ProcessLevelStore();
      await s.write(ProcessLevel.steps);
      expect(await s.read(), ProcessLevel.steps);
      expect(await s.read(), ProcessLevel.steps);
    });
  });
}
