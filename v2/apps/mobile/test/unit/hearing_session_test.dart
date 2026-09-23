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

  test('★ 半句覆盖、定稿追加（输入框里永远只有一份字）', () {
    var h = const Hearing().tapped();
    h = h.partial('今天');
    expect(h.text, '今天');
    h = h.partial('今天天气');
    expect(h.text, '今天天气');
    h = h.finalText('今天天气');
    expect(h.text, '今天天气');
    h = h.partial('怎么样');
    expect(h.text, '今天天气怎么样');
    h = h.finalText('怎么样');
    expect(h.text, '今天天气怎么样');
  });

  test('★ 同一句被报两遍（slice 1 与 2）⇒ **不许写两遍**', () {
    var h = const Hearing().tapped().finalText('今天天气');
    h = h.finalText('今天天气');
    expect(h.text, '今天天气');
  });

  test('`asr/end` 带着最后一句 ⇒ 停下，字留着', () {
    final h = const Hearing()
        .tapped()
        .event({'type': 'asr/partial', 'text': '今天天气'})
        .event({'type': 'asr/end', 'text': '今天天气怎么样'});
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

  test('★ 到点收手 ⇒ 停下 + 说清为什么（服务端说的，不是我们猜的）', () {
    final h = const Hearing().tapped().partial('说了很久').capped();
    expect(h.listening, isFalse);
    expect(h.why, hearCapped);
    expect(h.text, '说了很久');
  });

  test('认不出来的事件 ⇒ **什么都不做**（不猜）', () {
    final h = const Hearing().tapped().partial('今天');
    expect(h.event({'type': 'asr/whatever', 'text': '别乱写'}).text, '今天');
    expect(h.event({'type': 42}).text, '今天');
  });

  test('不在听的时候来半句 ⇒ 不写进框里（别在停了之后冒字）', () {
    final h = const Hearing().event({'type': 'asr/partial', 'text': '今天'});
    expect(h.text, '');
  });

  test('`hasText` 认得出"有没有字可以发"', () {
    expect(const Hearing().hasText, isFalse);
    expect(const Hearing().tapped().partial('好').hasText, isTrue);
    expect(const Hearing().tapped().partial('   ').hasText, isFalse);
  });
}
