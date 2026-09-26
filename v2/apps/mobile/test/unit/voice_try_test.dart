// **配置页「语音」那一屏那颗「试一下」的纯逻辑** · 契约 `docs/dev/123-VOICE-TEST-BUTTON.md`。
//
// 主人 2026-09-26 原话：*「语音按钮，点一下进入录音，再点一下结束录音。」*
// ⇒ **一次按下去＝一场录音**。它管四件事，每一件错了屏幕上都会说假话：
//   ① 按一下开始 / 引擎把一段说完**不许**结束这一场（落字 ⇒ 自己开下一轮 ⇒
//      字**接在后面长**，不是重来）/ **他再按一下**才收场、字留着；
//      过一会儿再按第一下 ⇒ 新的一场（清空）；
//   ② **每一种失败都有自己的那句话**（没配 / 没权限 / 连不上 / 没听到 / 没额度 /
//      到点 / 读不懂），而且**绝不许静默**、已经听到的字**一个都不丢**；
//   ③ **坏帧不许抛**（对面以后加字段，老客户端不能因为一个认不出的东西崩掉）；
//   ④ **开下一轮开不起来 ⇒ 说明白、收场**，绝不假装还在录。
//
// 🔴 **这里没有第二套状态机**：本体就是 `models/hearing_session.dart`（聊天那颗
//    话筒用的那一份）。这一份钉的是"这一屏怎么用它"＋"状态翻成哪句话"。
//    ⚠️ 所以这里出现的 `tapped/partial/finalText/done/roundEnded` 与
//       `hearing_session_test.dart` 是**同一条路**，不是复制一份实现。
//
// ⚠️ 每条判据都带**负向对照**（"反过来会怎样"要说出来）——只有正向那半，
//    一个永远为真的断言也能绿。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hearing_session.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/models/voice_try.dart';

/// 走一遍时序（只要状态那一份）。
Hearing run(Hearing h, List<Map<String, dynamic>> events) {
  for (final e in events) {
    h = voiceTryFrame(h, e);
  }
  return h;
}

/// 开局：按第一下，正在听。
Hearing listening() => const Hearing().tapped();

void main() {
  group('① 一场录音：按一下开始 → 引擎停顿不结束 → 再按一下才收场', () {
    test('★ 引擎把一段说完（用户没按停）⇒ **还在录**，字接在后面长（不是重来）', () {
      final h0 = listening();
      expect(h0.phase, HearingPhase.listening);

      // 第一轮：说到一半
      final a = voiceTryStep(h0, {'type': 'asr/partial', 'text': '今天天气', 'index': 0});
      expect(a.heard.text, '今天天气');
      expect(a.openNextRound, false, reason: '半句不许开新的一轮');

      // 引擎在停顿处把这一段收掉（服务端 `asr/end`）——
      // 🔴 **这一场还没完**：继续在听，并叫界面去开下一轮。
      final b = voiceTryStep(a.heard, {'type': 'asr/end', 'text': '今天天气', 'index': 0});
      expect(b.heard.phase, HearingPhase.listening, reason: '★ 引擎自己收尾**不许**结束这一场');
      expect(b.heard.listening, isTrue);
      expect(b.heard.text, '今天天气', reason: '已经听到的字留着');
      expect(b.openNextRound, isTrue, reason: '★ 该自己开下一轮（不然就"停了"）');

      // 第二轮：段号从 0 重来 ⇒ 字必须**接在后面**，不能替换
      final c = voiceTryStep(b.heard, {'type': 'asr/partial', 'text': '怎么样', 'index': 0});
      expect(c.heard.text, '今天天气怎么样', reason: '★ 接在后面长');
      // 负向对照①：不是重来（不是只剩新那一轮的字）
      expect(c.heard.text == '怎么样', false, reason: '负向对照：接在后面 ≠ 换了新的');
      // 负向对照②：**同一轮**里同一个段号仍然是"替换"
      final same = run(listening(), [
        {'type': 'asr/partial', 'text': '今天', 'index': 0},
        {'type': 'asr/partial', 'text': '今天天气', 'index': 0},
      ]);
      expect(same.text, '今天天气', reason: '同一段是替换：接起来会变成"今天今天天气"');
    });

    test('★ 第二下 ⇒ 这一场收场、字留着，而且**不再自动开下一轮**', () {
      // 走完第一轮（引擎收尾）＋ 第二轮正在听
      final afterRound = run(listening(), [
        {'type': 'asr/partial', 'text': '今天天气', 'index': 0},
        {'type': 'asr/end', 'text': '今天天气', 'index': 0},
        {'type': 'asr/partial', 'text': '怎么样', 'index': 0},
      ]);
      expect(afterRound.listening, isTrue, reason: '前一轮收尾之后这一场还在听');
      final stopping = afterRound.tapped();
      expect(stopping.phase, HearingPhase.finishing, reason: '按第二下 ⇒ 收尾中');

      final end = voiceTryStep(stopping, {'type': 'asr/end', 'text': '怎么样', 'index': 0});
      expect(end.heard.phase, HearingPhase.idle, reason: '★ 他说停 ⇒ 这一场完了');
      expect(end.heard.text, '今天天气怎么样', reason: '★ 字留着（他要能复制）');
      expect(end.openNextRound, false, reason: '★ 他按了停 ⇒ 绝不许再开下一轮');
      expect(voiceTryButton(end.heard), voiceTryStart, reason: '停了 ⇒ 又能按了');
    });

    test('★ 用户按停之后，引擎那条 `asr/end` 说"upstream"也**不许**报"半路断了"', () {
      // 负向对照：正常按停时服务端给的 reason 也是 `upstream` ——
      // 是不是"这一场的结束"由**用户的手**决定，不由引擎那句话决定。
      final h = run(listening(), [
        {'type': 'asr/partial', 'text': '今天天气', 'index': 0},
      ]).tapped();
      final end = voiceTryStep(h, {
        'type': 'asr/end',
        'text': '今天天气',
        'index': 0,
        'reason': 'upstream',
      });
      expect(end.heard.phase, HearingPhase.idle, reason: '用户按停 ⇒ 正常收场');
      expect(end.heard.why, '', reason: '不许报"刚才断了"（他自己停的）');
      expect(end.heard.why == hearCutOff, false, reason: '负向对照：不是"半路断了"那句');
      expect(end.heard.text, '今天天气');
      expect(end.openNextRound, false);
    });

    test('★ 过一会儿再按第一下 ⇒ **新的一场**（上一次那些字清掉）', () {
      // 第一轮：引擎自己收尾（这一场继续）→ 第二轮他说了一句 → 按停收场
      final stopping = run(listening(), [
        {'type': 'asr/partial', 'text': '上一句', 'index': 0},
        {'type': 'asr/end', 'text': '上一句', 'index': 0},
        {'type': 'asr/partial', 'text': '这一句', 'index': 0},
      ]).tapped();
      final closed = voiceTryStep(stopping, {'type': 'asr/end', 'text': '这一句', 'index': 0}).heard;
      expect(closed.text, '上一句这一句', reason: '负向对照：按之前框里是有字的');
      expect(closed.phase, HearingPhase.idle);

      final fresh = closed.tapped();
      expect(fresh.listening, isTrue, reason: '★ 再按一下就是新的一场');
      expect(fresh.text, '', reason: '★ 新的一场清空');
      expect(fresh.why, '', reason: '上一次的错也清掉（他就是在重试）');
    });

    test('★ 到点（`asr/capped`）⇒ 说那句话、**收场**（不接着开下一轮）', () {
      final h = run(listening(), [
        {'type': 'asr/final', 'text': '说了很久', 'index': 0},
      ]);
      final step = voiceTryStep(h, {'type': 'asr/capped'});
      expect(step.openNextRound, false, reason: '★ 到点不许自己再开（不要循环）');
      expect(step.heard.phase, HearingPhase.idle, reason: '★ 这一场收场');
      expect(step.heard.busy, isFalse);
      expect(step.heard.text, '说了很久', reason: '到点也要把已经听到的留着');
      // 负向对照：那条**迟到的** `asr/end` 不许把"到点"换成"什么都没听到"
      final late = voiceTryStep(step.heard, {'type': 'asr/end', 'index': 0});
      expect(late.heard.why, hearCapped, reason: '负向对照：原因不许被擦掉');
      expect(late.heard.why == hearNothing, false);
      expect(late.openNextRound, false);
    });
  });

  group('② 每一种失败都有自己的那句话（**一个都不许静默**，字一个都不丢）', () {
    test('没配钥匙 ⇒ 那一句，而且**说清"上面那三样就是它要用的"**', () {
      final h = voiceTryFrame(listening(), {'type': 'asr/unavailable'});
      expect(h.phase, HearingPhase.unavailable);
      final empty = voiceTryNotice(h, hasOwn: false);
      expect(empty, voiceTryNoKeyEmpty);
      expect(empty.contains('上面那三样'), true, reason: '主人点名要这句');
      final filled = voiceTryNotice(h, hasOwn: true);
      expect(filled, voiceTryNoKeyFilled);
      expect(filled == empty, false, reason: '两件事两句话（去填 vs 等接好）');
    });

    test('没拿到麦克风权限 ⇒ 它自己那句（不是"开不了麦克风"那种含糊话）', () {
      final h = listening().broke('denied');
      expect(h.phase, HearingPhase.denied);
      expect(voiceTryNotice(h, hasOwn: false), hearDenied);
      expect(voiceTryNotice(h, hasOwn: false) == hearFailed, false, reason: '负向对照：两句不许混');
    });

    test('这条连接没接上 ⇒ 与"开不了麦"**分开说**', () {
      final h = listening().broke('no-entry');
      expect(voiceTryNotice(h, hasOwn: false), hearNoEntry);
      expect(voiceTryNotice(h, hasOwn: false) == hearFailed, false);
    });

    test('开不了麦 ⇒ 它自己那句', () {
      expect(voiceTryNotice(listening().broke('failed'), hasOwn: false), hearFailed);
    });

    test('★ 开下一轮开不起来 ⇒ 说明白、**收场**，而且已经听到的字一个都不丢', () {
      // 走到"引擎刚说完一段、这一场还在听"那一步
      final h = run(listening(), [
        {'type': 'asr/partial', 'text': '今天天气', 'index': 0},
        {'type': 'asr/end', 'text': '今天天气', 'index': 0},
      ]);
      expect(h.busy, isTrue);
      // 界面去开下一轮，开不起来（连不上）⇒ 落在这一句上
      final failed = h.broke('no-entry');
      expect(failed.listening, isFalse, reason: '★ 收场（不许假装还在录）');
      expect(failed.phase, HearingPhase.failed);
      expect(voiceTryNotice(failed, hasOwn: false), hearNoEntry);
      expect(failed.text, '今天天气', reason: '★ 字一个都不丢');
      expect(failed.text.isEmpty, false, reason: '负向对照：不是清空');
    });

    test('★ 上游那一头出错（`asr/error{reason:upstream}`）⇒ 不是"开不了麦克风"', () {
      final h = voiceTryFrame(listening(), {
        'type': 'asr/error',
        'reason': 'upstream',
        'message': '（上游地址已隐去）',
      });
      expect(voiceTryNotice(h, hasOwn: false), hearEngineFailed);
      expect(voiceTryNotice(h, hasOwn: false) == hearFailed, false, reason: '负向对照：麦克风那一步明明成了');
      expect(h.phase, HearingPhase.failed, reason: '这一场收场');
    });

    test('一个字都没听到 ⇒ **说出来**（不是静默的空白框）', () {
      final h = run(listening(), [
        {'type': 'asr/end', 'index': 0},
      ]);
      // 引擎自己收尾（没听到字）⇒ 这一场还在听，不该说"没听到"
      expect(h.listening, isTrue, reason: '引擎收尾不结束这一场');
      expect(voiceTryNotice(h, hasOwn: false), '');
      // 用户按停之后才是"什么都没听到"
      final closed = run(h.tapped(), [
        {'type': 'asr/end', 'index': 0},
      ]);
      expect(closed.phase, HearingPhase.idle);
      expect(closed.text, '');
      expect(voiceTryNotice(closed, hasOwn: false), hearNothing);
      // 负向对照：有字的时候**不许**挂这句
      final got = run(listening().tapped(), [
        {'type': 'asr/end', 'text': '今天', 'index': 0},
      ]);
      expect(got.why, '');
      expect(got.why == hearNothing, false);
    });

    test('没额度（上游 4004）⇒ 与"识别出错"分开说', () {
      final h = voiceTryFrame(listening(), {
        'type': 'asr/error',
        'reason': 'engine',
        'code': 4004,
        'message': '资源包耗尽',
      });
      expect(voiceTryNotice(h, hasOwn: false), hearNoQuota);
      expect(voiceTryNotice(h, hasOwn: false) == hearEngineFailed, false);
      // 别的错误码还是"识别出错"
      final other = voiceTryFrame(listening(), {'type': 'asr/error', 'reason': 'engine', 'code': 4001});
      expect(voiceTryNotice(other, hasOwn: false), hearEngineFailed);
    });

    test('半路断了（聊天那颗话筒那一套）仍留着字、说明白', () {
      // ⚠️ 这一档只走 `Hearing.event`（「试一下」这一场把 `asr/end` 当"这一轮完了"，
      //    见 ① 那两条）；这里钉的是共用状态机那一半**没被改坏**。
      final h = run(listening(), [
        {'type': 'asr/final', 'text': '今天天气', 'index': 0},
        {'type': 'asr/end', 'text': '今天天气', 'index': 0, 'reason': 'upstream'},
      ]);
      // 这一场里 `asr/end`＝这一轮完了 ⇒ 还在听、字留着
      expect(h.listening, isTrue);
      expect(h.text, '今天天气');
      // 而直接调 `Hearing` 那一档（聊天那颗话筒）仍然是"断了"
      final cut = const Hearing().tapped().finalText('今天天气').broke('cut');
      expect(cut.why, hearCutOff);
      expect(cut.text, '今天天气', reason: '断了也要留住他说出来的那半句');
    });

    test('正在听/收尾中**不说**上一次的原因（不然屏幕上说两件事）', () {
      final h = listening();
      expect(voiceTryNotice(h, hasOwn: false), '');
      expect(voiceTryNotice(h.tapped(), hasOwn: false), '');
    });
  });

  group('③ 坏帧 / 认不出的帧：**绝不抛**，而且实话实说', () {
    test('形状都不对 ⇒ 一句实话 ＋ 字留着（不许说成"开不了麦克风"）', () {
      for (final junk in <Object?>[null, 42, 'x', <Object?>[], true]) {
        final h = run(listening(), [
          {'type': 'asr/final', 'text': '今天天气', 'index': 0},
        ]);
        expect(() => voiceTryFrame(h, junk), returnsNormally, reason: '坏帧不许抛：$junk');
        final after = voiceTryFrame(h, junk);
        expect(after.phase, HearingPhase.failed);
        expect(voiceTryNotice(after, hasOwn: false), voiceTryBadFrame);
        expect(after.text, '今天天气', reason: '已经听到的那半句一个都不许丢');
        expect(voiceTryNotice(after, hasOwn: false) == hearFailed, false,
            reason: '麦克风那一步明明成了，说成"开不了麦克风"就是假话');
        // 负向对照：坏帧之后**不许**再自动开下一轮（不然就是转圈）
        final step = voiceTryStep(h, junk);
        expect(step.openNextRound, false);
      }
    });

    test('★ 跨过一轮之后的坏帧：前面几轮的字和这一轮的字**都要留着**', () {
      final h = run(listening(), [
        {'type': 'asr/final', 'text': '第一句。', 'index': 0},
        {'type': 'asr/end', 'text': '第一句。', 'index': 0},
        {'type': 'asr/partial', 'text': '第二句', 'index': 0},
      ]);
      expect(h.text, '第一句。第二句');
      final after = voiceTryFrame(h, 42);
      expect(after.text, '第一句。第二句', reason: '★ 已经定下来的与正在长的都不许丢');
      expect(voiceTryNotice(after, hasOwn: false), voiceTryBadFrame);
    });

    test('类型不认识（对面加的新事件）⇒ **什么都不做**（不猜、不假装）', () {
      final h = run(listening(), [
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
        // 负向对照：也不许因为"认不出"就去开下一轮
        expect(voiceTryStep(h, e).openNextRound, false);
      }
    });

    test('没在试的时候来的坏帧 ⇒ 不管它（停了之后不冒字、不出提示）', () {
      final h = const Hearing();
      expect(voiceTryFrame(h, 42).phase, HearingPhase.idle);
      expect(voiceTryFrame(h, 42).why, '');
      // 负向对照：不在试 ⇔ 不是"在听"（不许被一帧叫起来）
      expect(voiceTryFrame(h, 42).listening, isFalse);
    });
  });

  group('④ 按钮上那行字（三档）', () {
    test('闲 / 在听 / 收尾中', () {
      expect(voiceTryButton(const Hearing()), voiceTryStart);
      expect(voiceTryButton(listening()), voiceTryStop);
      expect(voiceTryButton(listening().tapped()), voiceTryWorking);
      // 失败之后**回到"试一下"**（他按一下就是重试）
      expect(voiceTryButton(listening().broke('failed')), voiceTryStart);
      // ★ 引擎收完一轮、这一场还在听 ⇒ **按钮还是"停下"**（不许看着像停了）
      final mid = voiceTryFrame(listening(), {'type': 'asr/final', 'text': '今天', 'index': 0});
      final step = voiceTryStep(mid, {'type': 'asr/end', 'text': '今天', 'index': 0});
      expect(voiceTryButton(step.heard), voiceTryStop, reason: '★ 一场录音中间那一下还是"停下"');
    });

    test('那几句话里一个禁用词都没有（词表硬闸那一族的形状）', () {
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
