// **"我那台到哪一步了"**：登录之后进哪一屏（契约 `docs/dev/38-ISOLATION-SPLIT.md` §8.3）。
//
// ── 这一份钉四条 ──────────────────────────────────────────
//   1. 🔴 **缺字段 / 认不出来 ⇒ 按"就绪"**（老服务端没这个字段，不许把老用户挡在门外）；
//   2. 四种 `space` 各进哪一屏，**逐条对表**（含"刚填完钥匙不许退回填钥匙那屏"）；
//   3. 🔴 **不许假进度**：那两屏的文案里**一个百分号都没有**；
//   4. 那两屏的每一句都过**禁用词表**（界面词表是硬闸，不是文风偏好）。

import 'dart:io';

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
      // ★ **配置页那四个 tab 的话**（主人 2026-09-24 定的四样）——
      //   界面词表是硬闸：tab 上那两个字、"管什么"、"边界句"、状态句**都要过它**
      //   （"模型"是禁用词 ⇒ 所以那四屏只能说"聊天/语音/图片/视频"）。
      credTabChat,
      credTabVoice,
      credTabImage,
      credTabVideo,
      for (final tab in [credTabChat, credTabVoice, credTabImage, credTabVideo]) credTabWhat(tab),
      // 语音那一句有**四种说法**（本机/租户 × 填了/没填）—— 四种都要过词表
      credVoiceBoundaryMine,
      credVoiceBoundaryDefault,
      credVoiceBoundaryTenantHas,
      credVoiceBoundaryTenantNone,
      credImageBoundaryMine,
      credImageBoundaryNone,
      credImageBoundaryTenant,
      credImageBoundaryTenantNone,
      imageTryLabel,
      imageTryHint,
      imagePromptLabel,
      imageTrySubmit,
      imageGenerating,
      imagePromptBlank,
      imageTryFailed,
      imageLoadFailed,
      imageTempLink,
      credBoundaryVideo,
      credVoiceAppIdLabel,
      credVoiceSecretIdLabel,
      credVoiceSecretKeyLabel,
      credOneKeyLabel,
      for (final tab in [credTabChat, credTabVoice, credTabImage, credTabVideo]) ...[
        credStateLine(tab: tab, has: true, bad: false),
        credStateLine(tab: tab, has: false, bad: false),
      ],
      configLocalOnly,
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

  test('★ 图片那句边界话：租户那两档**不许把"试一张"说成不能用**（2026-09-24 更正）', () {
    expect(credImageBoundary(isTenant: false, hasOwn: false), credImageBoundaryNone);
    expect(credImageBoundary(isTenant: false, hasOwn: true), credImageBoundaryMine);
    expect(credImageBoundary(isTenant: true, hasOwn: true), credImageBoundaryTenant);
    expect(credImageBoundary(isTenant: true, hasOwn: false), credImageBoundaryTenantNone);
    // 🔴 租户那两句必须**提到"下面能试一张"**（那是真的能用的那半）
    for (final line in [credImageBoundaryTenant, credImageBoundaryTenantNone]) {
      expect(line.contains('试一张'), true, reason: '租户能用的那半要说出来：$line');
    }
    // 而"聊天里让它画"还没接 —— 也要说出来（不许含糊）
    expect(credImageBoundaryTenant.contains('等你这台接上'), true);
  });

  test('★ 语音那句边界话：四种组合逐条对表（说错哪一句都是假话）', () {
    // 本机 + 没填 ⇒ 说清现在用的是机器上那份
    expect(credVoiceBoundary(isTenant: false, hasOwn: false), credVoiceBoundaryDefault);
    // 本机 + 填了 ⇒ **真的就用它**（识别路优先读他自己的三样）
    expect(credVoiceBoundary(isTenant: false, hasOwn: true), credVoiceBoundaryMine);
    // 租户 + 填了 ⇒ 只许说"先收着、你这台还没接上"（盒子那份 serve.js 读的是盒子里）
    expect(credVoiceBoundary(isTenant: true, hasOwn: true), credVoiceBoundaryTenantHas);
    expect(credVoiceBoundary(isTenant: true, hasOwn: false), credVoiceBoundaryTenantNone);
    // 🔴 四句**互不相同**（两两相同就是把两种情况说成一件事）
    final all = {
      credVoiceBoundaryMine,
      credVoiceBoundaryDefault,
      credVoiceBoundaryTenantHas,
      credVoiceBoundaryTenantNone,
    };
    expect(all.length, 4, reason: '四种组合要有四句不同的话');
    // ⚠️ 而且"本机 + 填了"那一句必须**明说"不再用"别的那份**
    //    （只提"这台机器上那份"不算错 —— 它正是要说"不再用它"；
    //      第一版判据就写糙在这里，自己当场红了一次。）
    expect(credVoiceBoundaryMine.contains('不再用'), true);
    expect(credVoiceBoundaryMine.contains('就用这三样'), true);
  });

  test('★ 配置页那四样"有没有"：宽容解析（缺字段/坏类型 ⇒ 一律"没有"，不许当成有）', () {
    // ⚠️ 把"不知道"当成"有"，配置页就会对他说"填好了" —— 而他其实没有（假话）。
    final none = SpaceInfo.fromJson({'kind': 'local', 'state': 'ready'});
    expect(none.creds.any, false);
    expect(none.creds.model, false);
    expect(none.creds.voice, false);

    final some = SpaceInfo.fromJson({
      'kind': 'local',
      'creds': {'model': true, 'voice': false, 'image': true, 'video': 'yes'},
    });
    expect(some.creds.model, true);
    expect(some.creds.image, true);
    expect(some.creds.voice, false);
    expect(some.creds.video, false, reason: '只有真的 true 才算有（字符串不算）');
    expect(some.creds.any, true);

    // 负向对照：整块 creds 不认识（老服务端）⇒ 全 false，而且**不抛**
    expect(SpaceInfo.fromJson({'creds': 'x'}).creds.any, false);
    expect(SpaceInfo.fromJson({'creds': []}).creds.any, false);
    // 回写（toJson 要能带回去 —— 判据与缓存都靠它）
    expect(some.toJson()['creds'], {'model': true, 'voice': false, 'image': true, 'video': false});
  });

  test('🔴 "没有钥匙"要分得开：没填过 vs 填过但被判无效（`keyBad`）', () {
    // ⚠️ 服务端原来只回 `hasKey:false` ⇒ 这两种在界面上**一模一样**，
    //    于是配置那一屏只能对"填过但被拒"的人说"还没有填"（**假话**）。
    final none = SpaceInfo.fromJson({'kind': 'tenant', 'state': 'ready', 'hasKey': false});
    final bad = SpaceInfo.fromJson({
      'kind': 'tenant',
      'state': 'ready',
      'hasKey': false,
      'keyBad': true,
    });
    expect(none.keyBad, isFalse);
    expect(bad.keyBad, isTrue);
    expect(bad.hasKey, isFalse, reason: '被判无效的那把不算"有"');
    // ⚠️ 宽容：缺字段 / 类型不对 / 老服务端 ⇒ 一律 false（不许猜成"被判无效"）
    expect(SpaceInfo.fromJson({'kind': 'tenant', 'keyBad': 'true'}).keyBad, isFalse);
    expect(SpaceInfo.fromJson(null).keyBad, isFalse);
  });

  test('两句话本身：三种状态说的不是同一件事', () {
    expect(keyStateLine(hasKey: true, keyBad: false), keyStateHas);
    expect(keyStateLine(hasKey: false, keyBad: true), keyStateBad);
    expect(keyStateLine(hasKey: false, keyBad: false), keyStateNone);
    // ⚠️ 被判无效时**不许**说"还没有填"（他填过）
    expect(keyStateLine(hasKey: false, keyBad: true) == keyStateNone, isFalse);
    // ⚠️ 也不许冒出内部词
    for (final s in [keyStateHas, keyStateNone, keyStateBad, configEntry, configTitle]) {
      expect(hasForbidden(s), isFalse, reason: s);
    }
  });

  // ════════════════════════════════════════════════════════════
  // ★ T7（契约 `docs/dev/88-P1-TIME-WAIT.md` §四）：**没有依据的时间话不许说**
  //
  // 这一条钉的是那起"页面在说假话"：等开台那一屏原来有一句
  // `waitingStillLong = '还在开，比平常久了一点。…'`，由 `askedTooLong` 决定画不画 ——
  // 而那个布尔**没有一个生产者**（`main.dart` 不传、只有 `waiting_screen.dart` 读）。
  // ⇒ 今天它画不出来；将来谁把它接上，屏幕上立刻出现一句**没基线的比较级**：
  //    "比平常久"里的"平常"我们**从来没量过**（服务端不记开一台要多久）。
  //
  // **选了撤掉**（不是给它编一个基线）：
  //   · 真基线要先落盘每一次开台的耗时再算分布 —— 那是 P4 耗时预估，契约 §五.1 不做；
  //   · 这一屏**已经在画真在走的秒数**（`waitingElapsedWords`："已经等了 X 秒"），
  //     那是量出来的、有口径的 ⇒ 用户要的"它没坏、在动"由它兜着。
  // 反例：把 `askedTooLong` / `waitingStillLong` 加回来 ⇒ 这一条红。
  // 正对照：`waitingElapsedWords` 还在（真时间，一个字都不许少）。
  group('T7 · 没有依据的时间话，一个字都不许说', () {
    test('🔴 那两句（无生产者的比较级）必须不在源码里', () {
      final words = File('lib/models/space_words.dart').readAsStringSync();
      final screen = File('lib/screens/waiting_screen.dart').readAsStringSync();
      expect(words.contains('比平常久'), false, reason: '没有基准的"比平常久"不许留着');
      expect(words.contains('waitingStillLong'), false, reason: '那句模板要一起撤掉');
      expect(screen.contains('askedTooLong'), false, reason: '没有生产者的开关要一起撤掉');
    });

    test('正对照：真在走的时间还在（有口径的那一句不许被误删）', () {
      expect(waitingElapsedWords(0), '已经等了 0 秒');
      expect(waitingElapsedWords(125), '已经等了 2 分 5 秒');
      // 而且它**不是**比较级、也不含"很快/马上/平常"这类没依据的词
      for (final n in [0, 3, 59, 60, 125]) {
        final s = waitingElapsedWords(n);
        for (final bad in ['很快', '马上', '平常', '通常', '久了']) {
          expect(s.contains(bad), false, reason: '$s 里不许有 $bad');
        }
      }
    });
  });
}
