// **语音那一步的状态机**（纯的）· 契约 `docs/dev/71-MIC-ASR.md`。
//
// 它管三件事，每一件错了屏幕上都会说假话：
//   ① 按一下开始 / 再按一下结束，**字什么时候留、什么时候清**；
//   ② 半句覆盖、定稿追加 —— 输入框里永远只有一份字；
//   ③ 对面出错/没配/没权限时，**如实停在那句话上**，不装还在听。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hearing_session.dart';
import 'package:hupo_app/models/hearing_words.dart';

void main() {
  test('按一下 ⇒ 在听；再按一下 ⇒ 停（**字留着**）', () {
    var h = const Hearing();
    expect(h.listening, isFalse);
    h = h.tapped();
    expect(h.listening, isTrue);
    h = h.partial('今天');
    h = h.tapped();
    expect(h.listening, isFalse);
    expect(h.phase, HearingPhase.finishing);
    // 🔴 停了字还在 —— 他接下来要发的就是它
    expect(h.text, '今天');
    // 对面把最后一句送回来 ⇒ 定稿
    h = h.event({'type': 'asr/final', 'text': '今天天气'}).done();
    expect(h.phase, HearingPhase.idle);
    expect(h.text, '今天天气');
  });

  test('★ 按了停之后来的最后一句**必须接住**（真浏览器取证当场抓到的那一条）', () {
    // 2026-09-23 实测：按下"结束"就把这一轮当完了 ⇒ 最后那句被丢掉，
    // 屏幕上只剩半句「今天天」。修法：停 ⇒ 进 `finishing`，字继续收，
    // 等 `asr/end` 才算完。
    var h = const Hearing().tapped().partial('今天天');
    h = h.tapped(); // 用户按了停
    expect(h.phase, HearingPhase.finishing);
    expect(h.text, '今天天', reason: '那半句还在（对面马上会送整句回来）');
    h = h.event({'type': 'asr/final', 'text': '今天天气怎么样'});
    // 🔴 不是剩下"今天天"，也不是"今天天今天天气怎么样"（半个字都不许重复）
    expect(h.text, '今天天气怎么样');
    h = h.event({'type': 'asr/end', 'text': '今天天气怎么样'});
    expect(h.phase, HearingPhase.idle);
    expect(h.text, '今天天气怎么样');
  });

  test('收尾中再按一下 ⇒ 不算（那会儿按钮本来就不画）', () {
    final h = const Hearing().tapped().partial('今天').tapped();
    expect(h.phase, HearingPhase.finishing);
    expect(h.tapped().phase, HearingPhase.finishing);
  });

  test('再按一下开新的 ⇒ **上一次那些字清掉**（新的这一次是新的内容）', () {
    var h = const Hearing().tapped().finalText('今天天气怎么样').done();
    expect(h.text, '今天天气怎么样');
    h = h.tapped();
    expect(h.listening, isTrue);
    expect(h.text, '');
    // 上一次的错也该清（他就是在重试）
    expect(h.why, '');
  });

  test('★★ 真实帧序列：同一段连着来 ⇒ **只留最后那条**（腾讯 16k_zh 抓的原样）', () {
    // 2026-09-23 直连腾讯抓到的真帧（index 全程是 0，字是累积的）：
    //   slice=0 "" → slice=1 "嗯" → slice=1 "今天" → slice=1 "今天天气"
    //   → slice=1 "今天天气怎么" → slice=2 "今天天气怎么样？"
    // 🔴 老规矩（一条条接起来）在这里会拼出"嗯今天今天天气今天天气怎么今天天气怎么样？" ——
    //    那正是公网真页面上抓到的那串重复（取证当场发现的）。
    var h = const Hearing().tapped();
    for (final e in <Map<String, dynamic>>[
      {'type': 'asr/partial', 'text': '', 'index': 0},
      {'type': 'asr/final', 'text': '嗯', 'index': 0},
      {'type': 'asr/final', 'text': '今天', 'index': 0},
      {'type': 'asr/final', 'text': '今天天气', 'index': 0},
      {'type': 'asr/final', 'text': '今天天气怎么', 'index': 0},
      {'type': 'asr/final', 'text': '今天天气怎么样？', 'index': 0},
    ]) {
      h = h.event(e);
    }
    expect(h.text, '今天天气怎么样？');
    // 收尾（`asr/end` 不带字）也不许动它
    expect(h.event({'type': 'asr/end', 'index': 0}).text, '今天天气怎么样？');
  });

  test('★ 段号变了 ⇒ 接在后面（多说几句的情形）', () {
    final h = const Hearing()
        .tapped()
        .event({'type': 'asr/final', 'text': '今天天气怎么样？', 'index': 0})
        .event({'type': 'asr/final', 'text': '挺好的。', 'index': 1});
    expect(h.text, '今天天气怎么样？挺好的。');
  });

  test('段号乱序到 ⇒ 按段号从小到大接（不按到达顺序）', () {
    final h = const Hearing()
        .tapped()
        .event({'type': 'asr/final', 'text': '第二句。', 'index': 1})
        .event({'type': 'asr/final', 'text': '第一句。', 'index': 0});
    expect(h.text, '第一句。第二句。');
  });

  test('没有段号（老事件）⇒ 当成同一段：**替换**，不重复', () {
    final h = const Hearing()
        .tapped()
        .partial('今天')
        .finalText('今天天气');
    expect(h.text, '今天天气');
  });

  test('`asr/end` 带着最后一句 ⇒ 停下，字留着', () {
    final h = const Hearing()
        .tapped()
        .event({'type': 'asr/partial', 'text': '今天天气', 'index': 0})
        .event({'type': 'asr/end', 'text': '今天天气怎么样', 'index': 0});
    expect(h.listening, isFalse);
    expect(h.text, '今天天气怎么样');
  });

  test('★ 没配钥匙 ⇒ 停在"没配"上，而且**不是**在听', () {
    final h = const Hearing().tapped().event({'type': 'asr/unavailable'});
    expect(h.listening, isFalse);
    expect(h.phase, HearingPhase.unavailable);
    expect(h.why, hearUnavailable);
  });

  test('★ 没权限 ⇒ 那一句人话（不是"开不了麦克风"那种含糊话）', () {
    final h = const Hearing().tapped().broke('denied');
    expect(h.phase, HearingPhase.denied);
    expect(h.why, hearDenied);
  });

  test('★ 「连不上」与「开不了麦」**必须分开说**（混成一句 = 页面在说假话）', () {
    expect(const Hearing().tapped().broke('no-entry').why, hearNoEntry);
    expect(const Hearing().tapped().broke('failed').why, hearFailed);
    expect(
      const Hearing().tapped().broke('no-entry').why,
      isNot(hearFailed),
      reason: '2026-09-23 在线上真的踩到过：公网那一跳不通，屏幕上却说"开不了麦克风"',
    );
  });

  test('★ 一个字都没听到 ⇒ **说出来**（不许悄悄退出语音档）', () {
    final empty = const Hearing().tapped().done();
    expect(empty.phase, HearingPhase.idle);
    expect(empty.why, hearNothing);
    // 有字的时候**不许**挂这句提示（不然正常收尾也像出了事）
    final got = const Hearing().tapped().finalText('今天', index: 0).done();
    expect(got.why, '');
    expect(got.hasText, isTrue);
  });

  test('★ 「没额度」与「识别出错」必须分开说（腾讯 4004 那条）', () {
    final h = const Hearing().tapped().event({
      'type': 'asr/error',
      'reason': 'engine',
      'code': 4004,
      'message': '资源包耗尽，请开通后付费或者购买资源包',
    });
    expect(h.why, hearNoQuota);
    expect(h.why, isNot(hearEngineFailed));
    // 别的错误码还是"识别出错"
    final other = const Hearing().tapped().event({'type': 'asr/error', 'reason': 'engine', 'code': 4001});
    expect(other.why, hearEngineFailed);
  });

  test('★ 到点收手 ⇒ 停下 + 说清为什么（服务端说的，不是我们猜的）', () {
    final h = const Hearing().tapped().partial('说了很久', index: 0).capped();
    expect(h.listening, isFalse);
    expect(h.why, hearCapped);
    expect(h.text, '说了很久');
  });

  test('认不出来的事件 ⇒ **什么都不做**（不猜）', () {
    final h = const Hearing().tapped().partial('今天', index: 0);
    expect(h.event({'type': 'asr/whatever', 'text': '别乱写'}).text, '今天');
    expect(h.event({'type': 42}).text, '今天');
  });

  test('不在听的时候来半句 ⇒ 不写进框里（别在停了之后冒字）', () {
    final h = const Hearing().event({'type': 'asr/partial', 'text': '今天', 'index': 0});
    expect(h.text, '');
  });

  test('`hasText` 认得出"有没有字可以发"', () {
    expect(const Hearing().hasText, isFalse);
    expect(const Hearing().tapped().partial('好', index: 0).hasText, isTrue);
    expect(const Hearing().tapped().partial('   ', index: 0).hasText, isFalse);
  });

  // ── P1-3（2026-09-24）：**半路断了 ⇒ 接着刚才那句说** ────────────────
  test('★ P1-3：用户按停（reason=user-stop）⇒ 正常收尾（切回键盘那档）', () {
    final h = const Hearing()
        .tapped()
        .event({'type': 'asr/final', 'text': '今天天气', 'index': 0})
        .event({'type': 'asr/end', 'text': '今天天气', 'index': 0, 'reason': 'user-stop'});
    expect(h.phase, HearingPhase.idle);
    expect(h.why, '', reason: '用户自己停的，不该报"断了"');
    expect(h.text, '今天天气');
  });

  test('★ P1-3：半路断了（reason=upstream）⇒ 字留着 + 说明白 + **不切走**', () {
    final h = const Hearing()
        .tapped()
        .event({'type': 'asr/final', 'text': '今天天气', 'index': 0})
        .event({'type': 'asr/end', 'text': '今天天气', 'index': 0, 'reason': 'upstream'});
    expect(h.text, '今天天气', reason: '断了也要把他说出来的那半句留住');
    expect(h.why, hearCutOff, reason: '要说明白"断了、可以接着说"');
    expect(h.phase, HearingPhase.failed, reason: '停在失败这一档 ⇒ 界面不切回键盘（他按一下就能接着说）');
  });

  test('★ P1-3：到点收手（reason=capped）⇒ 用"一分钟"那句，不跟"断了"抢', () {
    final h = const Hearing()
        .tapped()
        .event({'type': 'asr/capped'})
        .event({'type': 'asr/end', 'text': '说了很久', 'index': 0, 'reason': 'capped'});
    expect(h.why, hearCapped);
    expect(h.text, '说了很久');
  });

  test('★ P1-3：断了但**一个字都没有** ⇒ 还是"什么都没听到"那句（不冒充"断了"）', () {
    final h = const Hearing().tapped().event({'type': 'asr/end', 'index': 0, 'reason': 'upstream'});
    expect(h.why, hearNothing);
  });
}
