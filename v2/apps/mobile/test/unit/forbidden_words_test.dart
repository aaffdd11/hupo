// 禁用词闸 —— 手册 `07-APPENDIX.md` §2.2：
//   **界面上出现内部词 = 缺陷**（不是文风问题）。
//
// 走查里最一致的失败不是"功能没有"，是"我看不懂这句话"。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/about_facts.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/process_words.dart';

void main() {
  test('★ 永久禁用的那几个，一个都不许漏', () {
    for (final w in ['工作区', '口令', '客户端', '云端', '正在听']) {
      expect(forbiddenWords.containsKey(w), true, reason: '$w 必须禁');
    }
  });

  test('命中判定是对的', () {
    expect(hasForbidden('这个工作区里有三件事'), true);
    expect(hasForbidden('你的密码不对，再试一次'), false);
    expect(hasForbidden('网断了，我在等它回来'), false);
  });

  test('每一条禁用词都写了"为什么"（不然下一个人会把它加回来）', () {
    for (final e in forbiddenWords.entries) {
      expect(e.value.trim().isNotEmpty, true, reason: '${e.key} 没写理由');
    }
  });

  test('★ 我们实际用的那些文案，必须干净', () {
    // 这几句是界面里真会显示的（含 D2 定稿的登录页）
    // ⚠️ 用 `final` 不用 `const`：下面要**展开**关于页那份数据源（`const` 里展不开）
    final copies = [
      '你说的事它真会去做，不只是陪聊。',
      '所以这道门只有你能开。',
      '装机器时给你的那一串',
      '打开',
      '密码',
      '网断了，我在等它回来',
      '网是通的，只是我还接不上它，在重试',
      // ⚠️ 连流前**续期**撞上 401 也是这一句（续期没有新文案，见 `renew_test.dart`）——
      //    同一件事同一句话，别再新造一个说法。
      '登录过期了，重新登录一下',
      '已交出去',
      '已送到',
      '已收到',
      '没发出去',
      '重发',
      '说点什么',
      '在处理…',
      '这条没说完',
      '你不在的时候',
      '这台机器还没设密码',
      // 它忙不过来（内存准入闸拒的）——首页那句人话
      '它现在忙不过来，过一会儿再发一次',
      '忘了密码？在机器上重设一次就行。',
      '记一笔账、问一件事、让它去查个东西。',
      '它会把做过的事说给你听。',
      // ⚠️ 批 3 过程四档（D7）新增的那几句：切换入口的标题、
      //    四档的名字与解释、步骤流水那几个词、推理原文那块标题。
      //    全部**直接引数据源**（手抄会漂）。
      '它说多少过程',
      ...ProcessLevel.values.expand((l) => [l.title, l.hint]),
      ...processWords.values,
      reasoningLabel,
      // ⚠️ **关于页那几句也在这儿**（直接引数据源，不手抄 —— 手抄会漂）
      ...aboutFacts.expand((f) => [f.title, ...f.lines]),
    ];
    for (final c in copies) {
      final hits = scanForbidden(c);
      expect(hits, isEmpty, reason: '「$c」里有禁用词：$hits');
    }
  });
}
