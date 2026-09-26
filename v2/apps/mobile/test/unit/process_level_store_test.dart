// 过程两档存哪（契约 `docs/dev/122-TWO-PROCESS-LEVELS.md` §三；写法照 `token_store.dart` / `timeline_store.dart`）。
//
// ⚠️ 这一份钉两句话：
//   1. **坏了一律当默认值，绝不抛** —— 它是本机的一个偏好，读不出来最多是
//      "回到默认档"，**绝不能因此让聊天打不开**。
//   2. 🔴 **老设备盘上存着砍掉的那两档**（`quiet` / `steps`）⇒ 读出来必须
//      是 `doing`：那一档菜单上没有了，留着它菜单上就没有任何一项被选中。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/services/process_level_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('两档的本地设置', () {
    test('★ 没存过 ⇒ 默认档 `doing`', () async {
      expect(await ProcessLevelStore().read(), defaultProcessLevel);
      expect(await ProcessLevelStore().read(), ProcessLevel.doing);
    });

    test('存了再读：还是那一档（两档都走一遍）', () async {
      for (final level in ProcessLevel.values) {
        SharedPreferences.setMockInitialValues({});
        final s = ProcessLevelStore();
        await s.write(level);
        expect(await ProcessLevelStore().read(), level, reason: '${level.wire} 丢了');
      }
    });

    test('🔴 盘上存着老档（`steps` / `quiet`）⇒ 读出来是 `doing`（归一，不是坏值）', () async {
      for (final old in retiredProcessLevelWires) {
        SharedPreferences.setMockInitialValues({'hupo_process_level': old});
        expect(
          await ProcessLevelStore().read(),
          ProcessLevel.doing,
          reason: '「$old」那一档菜单上没有了 ⇒ 归一，不然菜单里没有任何一项是选中的',
        );
      }
      // ★ 负向对照：留下的那一档不许被顺手归一
      SharedPreferences.setMockInitialValues({'hupo_process_level': 'reasoning'});
      expect(await ProcessLevelStore().read(), ProcessLevel.reasoning);
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
      await s.write(ProcessLevel.reasoning);
      expect(await s.read(), ProcessLevel.reasoning);
      expect(await s.read(), ProcessLevel.reasoning);
    });
  });
}
