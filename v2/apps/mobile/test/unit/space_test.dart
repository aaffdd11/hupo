// **"我那台到哪一步了"**：登录之后进哪一屏（契约 `docs/dev/38-ISOLATION-SPLIT.md` §8.3）。
//
// ── 这一份钉四条 ──────────────────────────────────────────
//   1. 🔴 **缺字段 / 认不出来 ⇒ 按"就绪"**（老服务端没这个字段，不许把老用户挡在门外）；
//   2. 四种 `space` 各进哪一屏，**逐条对表**（含"刚填完钥匙不许退回填钥匙那屏"）；
//   3. 🔴 **不许假进度**：那两屏的文案里**一个百分号都没有**；
//   4. 那两屏的每一句都过**禁用词表**（界面词表是硬闸，不是文风偏好）。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/space.dart';
import 'package:hupo_app/models/space_words.dart';

void main() {
  group('"到哪一步了"怎么读（宽容解析）', () {
    test('🔴 缺字段 / 认不出来 ⇒ **按就绪**（老服务端不许把人挡住）', () {
      for (final raw in <Object?>[null, 'x', 42, <String>[], <String, dynamic>{}]) {
        final s = SpaceInfo.fromJson(raw);
        expect(s.isTenant, false, reason: '$raw 应当按"本机那种"');
        expect(s.ready, true);
        expect(spaceScreenFor(s), SpaceScreen.chat);
      }
    });

    test('认得出的时候逐条对表', () {
      expect(SpaceInfo.fromJson({'kind': 'local'}).isTenant, false);

      final prep = SpaceInfo.fromJson({'kind': 'tenant', 'state': 'preparing'});
      expect(prep.isTenant, true);
      expect(prep.ready, false);

      final noKey = SpaceInfo.fromJson({'kind': 'tenant', 'state': 'ready', 'hasKey': false});
      expect(noKey.ready, true);
      expect(noKey.hasKey, false);

      final yesKey = SpaceInfo.fromJson({'kind': 'tenant', 'state': 'ready', 'hasKey': true});
      expect(yesKey.hasKey, true);
    });

    test('认不出的 kind ⇒ 退回"本机那种"（老服务端兼容）', () {
      expect(SpaceInfo.fromJson({'kind': 'wat'}).isTenant, false);
    });

    test('🔴 **给了 `state` 就照它算**：认不出的值**不许**当就绪', () {
      // ⚠️ 这一条是安全相关的：把"还没准备好"当成就绪 = **把人送进一个还没准备好的世界**。
      //    另一头（当成就绪）也不对，所以"缺 state ⇒ 就绪"和"给了不认识的 state ⇒ 不就绪"
      //    是**两条不同的路**，必须分开。
      expect(SpaceInfo.fromJson({'kind': 'tenant', 'state': 'weird'}).ready, false);
      expect(SpaceInfo.fromJson({'kind': 'tenant', 'state': 'queued'}).ready, false);
      expect(SpaceInfo.fromJson({'kind': 'tenant', 'state': 'starting'}).ready, false);
      expect(SpaceInfo.fromJson({'kind': 'tenant', 'state': 'ready'}).ready, true);
      // 缺字段 = 老服务端 ⇒ 就绪（兼容那条纪律）
      expect(SpaceInfo.fromJson({'kind': 'tenant'}).ready, true);
    });

    test('★ 三步：解析 · 认不出的名字**丢掉**（不许编一步出来）', () {
      final s = SpaceInfo.fromJson({
        'kind': 'tenant',
        'state': 'starting',
        'steps': [
          {'step': 'assigned', 'done': true},
          {'step': 'starting', 'done': false},
          {'step': 'wat', 'done': true},
          'x',
        ],
      });
      expect(s.steps.length, 2, reason: '认不出的那两步要丢掉');
      expect(s.steps.first.done, true);
      expect(s.steps.last.step, 'starting');
      // 负向对照：缺 steps ⇒ 空（界面就只显示那句话，不编步骤）
      expect(SpaceInfo.fromJson({'kind': 'tenant'}).steps, isEmpty);
    });
  });

  group('该进哪一屏', () {
    test('四种情况逐条对表', () {
      expect(spaceScreenFor(const SpaceInfo()), SpaceScreen.chat, reason: '主人：直接聊');
      expect(
        spaceScreenFor(const SpaceInfo(kind: 'tenant', state: 'preparing')),
        SpaceScreen.waiting,
      );
      expect(
        spaceScreenFor(const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: false)),
        SpaceScreen.key,
      );
      expect(
        spaceScreenFor(const SpaceInfo(kind: 'tenant', state: 'ready', hasKey: true)),
        SpaceScreen.chat,
      );
    });

    test('🔴 刚填完钥匙（`keySent`）⇒ **不许**退回填钥匙那一屏', () {
      const noKey = SpaceInfo(kind: 'tenant', state: 'ready', hasKey: false);
      expect(spaceScreenFor(noKey), SpaceScreen.key);
      expect(spaceScreenFor(noKey, keySent: true), SpaceScreen.chat,
          reason: '他自己刚填完，退回去像是在说他没填');
      // 负向对照：没填过的时候**还是要**那一屏（不然这一条是空转）
      expect(spaceScreenFor(noKey), SpaceScreen.key);
    });

    test('还没开好的时候**不管填没填**都是等待屏（空间不在，填了也没处放）', () {
      const prep = SpaceInfo(kind: 'tenant', state: 'preparing');
      expect(spaceScreenFor(prep), SpaceScreen.waiting);
      expect(spaceScreenFor(prep, keySent: true), SpaceScreen.waiting);
    });
  });

  group('"已经等了多久"（真在走的时间）', () {
    test('★ 逐档对表：秒 / 分', () {
      expect(waitingElapsedWords(0), '已经等了 0 秒');
      expect(waitingElapsedWords(7), '已经等了 7 秒');
      expect(waitingElapsedWords(59), '已经等了 59 秒');
      expect(waitingElapsedWords(60), '已经等了 1 分 0 秒');
      expect(waitingElapsedWords(125), '已经等了 2 分 5 秒');
      // 负向对照：负数（理论上不会）不许说出"等了 -1 秒"这种话
      expect(waitingElapsedWords(-3), '已经等了 0 秒');
    });

    test('🔴 它是**时间**不是**进度**：一个百分号都没有', () {
      for (final n in [0, 1, 30, 59, 60, 3600]) {
        expect(waitingElapsedWords(n).contains('%'), false);
      }
    });
  });

  group('那两屏的文案', () {
    // ⚠️ `final` 不是 `const`：下面要展开一个 Map（`spaceStepWords.values`），const 做不到
    final all = <String>[
      waitingTitle,
      waitingBody,
      waitingRetry,
      waitingStillLong,
      waitingRetryFail,
      keyTitle,
      keyBody,
      keyLabel,
      keyWhere,
      keySubmit,
      keyPrivacy,
      keyBlank,
      keyBadChars,
      keyTooLong,
      keyFailed,
      waitingQueued,
      ...spaceStepWords.values,
      // 秒数那几句（真在走的时间，不是进度）
      waitingElapsedWords(0),
      waitingElapsedWords(59),
      waitingElapsedWords(60),
      waitingElapsedWords(125),
    ];

    test('🔴 **不许假进度**：一个百分号都没有', () {
      for (final s in all) {
        expect(s.contains('%'), false, reason: '不允许假进度：$s');
        expect(s.contains('％'), false, reason: '不允许假进度（全角）：$s');
      }
    });

    test('🔴 每一句都过禁用词表（界面词表是硬闸）', () {
      for (final s in all) {
        final hits = scanForbidden(s);
        expect(hits, isEmpty,
            reason: '「$s」里出现了「${hits.isEmpty ? '' : hits.first.word}」');
      }
    });

    test('负向对照：词表**真的抓得住**（不然上面那条是空转）', () {
      expect(hasForbidden('把模型钥匙填上'), true);
      expect(hasForbidden('正在给你开一个只属于自己的空间'), false);
    });
  });
}
