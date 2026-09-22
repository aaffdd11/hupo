// **打字框里那份草稿**（第三本账）—— 契约 `docs/dev/54-COMPOSE-DRAFT.md`。
//
// 主人 2026-09-22：*"就是要有一个空的输入框，但如果用户输入过，没发送，
// 则显示在上面作为草稿。草稿也是要记住的。"*
//
// ⚠️ 这一份测**存储**那半边（"记住"）；界面那半边在
//    `test/widget/compose_draft_test.dart`。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/services/compose_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  test('★ 存了能读回来（"草稿也是要记住的"）', () async {
    final s = ComposeStore();
    expect(await s.load(), isNull, reason: '一开始没有草稿');
    await s.save('帮我把这周的工时记一下');
    expect(await s.load(), '帮我把这周的工时记一下');
  });

  test('★ 空串 = 没有草稿（不是"一句空的草稿"）', () async {
    final s = ComposeStore();
    await s.save('先打一句');
    await s.save('   ');
    expect(await s.load(), isNull, reason: '只有空白 ⇒ 等于没打');
  });

  test('★ 按人分：换个人登录**读不到**上一个人打了一半的话', () async {
    final a = ComposeStore(namespace: 'u_1');
    await a.save('甲的半句话');
    final b = ComposeStore(namespace: 'u_2');
    expect(await b.load(), isNull, reason: '★ 乙不该看见甲打了一半的话');
    expect(await ComposeStore(namespace: 'u_1').load(), '甲的半句话');
  });

  test('清掉之后读不回来（退出登录那条路要它）', () async {
    final s = ComposeStore();
    await s.save('一句话');
    await s.clear();
    expect(await s.load(), isNull);
  });

  test('超长的草稿会被截到上限**而不是写爆**（它是"最好有"，不是"必须有"）', () async {
    final s = ComposeStore();
    await s.save('啊' * (ComposeStore.capChars + 500));
    final back = await s.load();
    expect(back, isNotNull);
    expect(back!.length, ComposeStore.capChars);
  });
}
