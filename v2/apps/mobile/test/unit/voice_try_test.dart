// **配置页「语音」那一屏那颗「试一下」的纯逻辑** · 契约 `docs/dev/123-VOICE-TEST-BUTTON.md`。
//
// 它管三件事，每一件错了屏幕上都会说假话：
//   ① **闲 → 在听 → 字落进框**（按一下开始、说的时候半句一直长、停下定稿）；
//   ② **每一种失败都有自己的那句话**（没配 / 没权限 / 连不上 / 没听到 / 没额度 /
//      读不懂），而且**绝不许静默**；
//   ③ **坏帧不许抛**（对面以后加字段，老客户端不能因为一个认不出的东西崩掉）。
//
// 🔴 **这里没有第二套状态机**：本体就是 `models/hearing_session.dart`（聊天那颗
//    话筒用的那一份）。这一份钉的是"这一屏怎么用它"＋"状态翻成哪句话"。
//    ⚠️ 所以这里出现的 `tapped/partial/finalText/done` 与 `hearing_session_test.dart`
//       是**同一条路**，不是复制一份实现。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hearing_session.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/models/voice_try.dart';

/// 走一遍真实时序：按一下 → 半句 → 定稿 → 收尾。
Hearing run(Hearing h, List<Map<String, dynamic>> events) {
  for (final e in events) {
    h = voiceTryFrame(h, e);
  }
  return h;
}

void main() {
  group('① 闲 → 在听 → 字', () {
    test('按一下 ⇒ 在听；半句一直长（**替换，不是接上去**）；停下 ⇒ 定稿落进框', () {
      var h = const Hearing();
      expect(voiceTryButton(h), voiceTryStart);
      expect(h.text, '', reason: '一开始框里是空的（**不许编一个字**）');

      h = voiceTryFrame(h, {'type': 'asr/ready'}).tapped();
      expect(h.phase, HearingPhase.listening, reason: '按一下就该在听');
      expect(voiceTryButton(h), voiceTryStop);

      // 实时那半句：同一段连着来 ⇒ 只留最后那条（腾讯真帧就是累积的）
      h = voiceTryFrame(h, {'type': 'asr/partial', 'text': '今天', 'index': 0});
      expect(h.text, '今天');
      h = voiceTryFrame(h, {'type': 'asr/partial', 'text': '今天天气', 'index': 0});
      expect(h.text, '今天天气', reason: '同一段是**替换**：接起来会变成"今天今天天气"');
      expect(voiceTryButton(h), voiceTryStop);

      // 用户按第二下 ⇒ 收尾（等最后一句）
      h = h.tapped();
      expect(h.phase, HearingPhase.finishing);
      expect(voiceTryButton(h), voiceTryWorking);
      expect(h.text, '今天天气', reason: '那半句留着（最后一句马上回来）');

      // 服务端说整段完了，带着最后那句
      h = voiceTryFrame(h, {'type': 'asr/end', 'text': '今天天气怎么样', 'index': 0});
      expect(h.phase, HearingPhase.idle);
      expect(h.text, '今天天气怎么样', reason: '定稿**落进那个框**');
      expect(voiceTryButton(h), voiceTryStart, reason: '停了 ⇒ 又能按了');
    });

    test('★ 引擎自己收尾（用户没按第二下）也停在字上', () {
      final h = run(const Hearing().tapped(), [
        {'type': 'asr/final', 'text': '没事了', 'index': 0},
        {'type': 'asr/end', 'text': '没事了', 'index': 0},
      ]);
      expect(h.phase, HearingPhase.idle);
      expect(h.text, '没事了');
    });

    test('再按一下开新的 ⇒ 上一次那些字清掉（新的这一次是新的内容）', () {
      final h = run(const Hearing().tapped(), [
        {'type': 'asr/final', 'text': '上一句', 'index': 0},
        {'type': 'asr/end', 'text': '上一句', 'index': 0},
      ]).tapped();
      expect(h.listening, isTrue);
      expect(h.text, '');
    });
  });

  group('② 每一种失败都有自己的那句话（**一个都不许静默**）', () {
    test('没配钥匙 ⇒ 那一句，而且**说清"上面那三样就是它要用的"**', () {
      final h = voiceTryFrame(const Hearing().tapped(), {'type': 'asr/unavailable'});
      expect(h.phase, HearingPhase.unavailable);
      // 没填过：让他去填（并说明用的就是上面那三样）
      final empty = voiceTryNotice(h, hasOwn: false);
      expect(empty, voiceTryNoKeyEmpty);
      expect(empty.contains('上面那三样'), true, reason: '主人点名要这句');
      // 填过了这边还说没接通：让他等接好（**不能**跟上一句混成一句）
      final filled = voiceTryNotice(h, hasOwn: true);
      expect(filled, voiceTryNoKeyFilled);
      expect(filled == empty, false, reason: '两件事两句话（去填 vs 等接好）');
    });

    test('没拿到麦克风权限 ⇒ 它自己那句（不是"开不了麦克风"那种含糊话）', () {
      final h = const Hearing().tapped().broke('denied');
      expect(h.phase, HearingPhase.denied);
      expect(voiceTryNotice(h, hasOwn: false), hearDenied);
    });

    test('这条连接没接上 ⇒ 与"开不了麦"**分开说**', () {
      final h = const Hearing().tapped().broke('no-entry');
      expect(voiceTryNotice(h, hasOwn: false), hearNoEntry);
      expect(voiceTryNotice(h, hasOwn: false) == hearFailed, false);
    });

    test('开不了麦 ⇒ 它自己那句', () {
      expect(voiceTryNotice(const Hearing().tapped().broke('failed'), hasOwn: false), hearFailed);
    });

    test('一个字都没听到 ⇒ **说出来**（不是静默的空白框）', () {
      final h = run(const Hearing().tapped(), [
        {'type': 'asr/end', 'index': 0},
      ]);
      expect(h.text, '');
      expect(voiceTryNotice(h, hasOwn: false), hearNothing);
    });

    test('没额度（上游 4004）⇒ 与"识别出错"分开说', () {
      final h = voiceTryFrame(const Hearing().tapped(), {
        'type': 'asr/error',
        'reason': 'engine',
        'code': 4004,
        'message': '资源包耗尽',
      });
      expect(voiceTryNotice(h, hasOwn: false), hearNoQuota);
      expect(voiceTryNotice(h, hasOwn: false) == hearEngineFailed, false);
      // 别的错误码还是"识别出错"
      final other = voiceTryFrame(const Hearing().tapped(), {'type': 'asr/error', 'reason': 'engine', 'code': 4001});
      expect(voiceTryNotice(other, hasOwn: false), hearEngineFailed);
    });

    test('到点了（`asr/capped`）⇒ 它自己那句（服务端说的，不是我们猜的）', () {
      final h = voiceTryFrame(const Hearing().tapped(), {'type': 'asr/capped'});
      expect(voiceTryNotice(h, hasOwn: false), hearCapped);
      expect(h.text, '', reason: '一个字都没听到时还是空的（**不许编**）');
    });

    test('半路断了 ⇒ 字留着 ＋ 说明白（不静默）', () {
      final h = run(const Hearing().tapped(), [
        {'type': 'asr/final', 'text': '今天天气', 'index': 0},
        {'type': 'asr/end', 'text': '今天天气', 'index': 0, 'reason': 'upstream'},
      ]);
      expect(h.text, '今天天气');
      expect(voiceTryNotice(h, hasOwn: false), hearCutOff);
    });

    test('正在听/收尾中**不说**上一次的原因（不然屏幕上说两件事）', () {
      final h = const Hearing().tapped();
      expect(voiceTryNotice(h, hasOwn: false), '');
      expect(voiceTryNotice(h.tapped(), hasOwn: false), '');
    });
  });

  group('③ 坏帧 / 认不出的帧：**绝不抛**，而且实话实说', () {
    test('形状都不对 ⇒ 一句实话 ＋ 字留着（不许说成"开不了麦克风"）', () {
      for (final junk in <Object?>[null, 42, 'x', <Object?>[], true]) {
        final h = run(const Hearing().tapped(), [
          {'type': 'asr/final', 'text': '今天天气', 'index': 0},
        ]);
        expect(() => voiceTryFrame(h, junk), returnsNormally, reason: '坏帧不许抛：$junk');
        final after = voiceTryFrame(h, junk);
        expect(after.phase, HearingPhase.failed);
        expect(voiceTryNotice(after, hasOwn: false), voiceTryBadFrame);
        expect(after.text, '今天天气', reason: '已经听到的那半句一个都不许丢');
        expect(voiceTryNotice(after, hasOwn: false) == hearFailed, false,
            reason: '麦克风那一步明明成了，说成"开不了麦克风"就是假话');
      }
    });

    test('类型不认识（对面加的新事件）⇒ **什么都不做**（不猜、不假装）', () {
      final h = run(const Hearing().tapped(), [
        {'type': 'asr/final', 'text': '今天', 'index': 0},
      ]);
      for (final e in <Map<String, dynamic>>[
        <String, dynamic>{},
        {'type': 'asr/whatever', 'text': '别乱写'},
        {'type': 42},
      ]) {
        expect(() => voiceTryFrame(h, e), returnsNormally);
        final after = voiceTryFrame(h, e);
        expect(after.text, '今天', reason: '认不出 ⇒ 一个字都不许动');
        expect(after.why, '', reason: '认不出 ⇒ 不许凭空造一个原因');
      }
    });

    test('没在试的时候来的坏帧 ⇒ 不管它（停了之后不冒字、不出提示）', () {
      final h = const Hearing();
      expect(voiceTryFrame(h, 42).phase, HearingPhase.idle);
      expect(voiceTryFrame(h, 42).why, '');
    });
  });

  group('④ 按钮上那行字（三档）', () {
    test('闲 / 在听 / 收尾中', () {
      expect(voiceTryButton(const Hearing()), voiceTryStart);
      expect(voiceTryButton(const Hearing().tapped()), voiceTryStop);
      expect(voiceTryButton(const Hearing().tapped().tapped()), voiceTryWorking);
      // 失败之后**回到"试一下"**（他按一下就是重试）
      expect(voiceTryButton(const Hearing().tapped().broke('failed')), voiceTryStart);
    });

    test('那几句话里一个禁用词都没有（词表硬闸那一族的形状）', () {
      // ⚠️ 这里只做"这一块自己那几句"的抽查；正式扫描在
      //    `test/unit/forbidden_words_test.dart`（它扫整份文案清单）。
      final copies = <String>[
        voiceTryTitle,
        voiceTryStart,
        voiceTryStop,
        voiceTryWorking,
        voiceTryHint,
        voiceTryBoxLabel,
        voiceTryBadFrame,
        voiceTryNoKeyEmpty,
        voiceTryNoKeyFilled,
      ];
      for (final c in copies) {
        expect(c.trim().isEmpty, false, reason: '空文案：$c');
        expect(c.contains('工作区') || c.contains('客户端') || c.contains('云端'), false, reason: c);
      }
    });
  });
}
