// **"说一句试试"那一场演练的状态机**（纯的 · V2.0 第一件）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 走一圈：按麦 → 听到字 → 在听懂 → 它问一句 → 他答 → 在听懂 → 可以了（最终那一份）
//   ② 🔴 **最多问两轮**（`drillMaxRounds`）—— 到上限就**按已经听懂的那份走**（不吹毛求疵）
//   ③ 🔴 **那一句原话一直留着**：第二轮送上去的 `text` 仍然是**他第一次说的那句**
//      （他后来答的走 `history`）—— 只送最后那一答 = 那一层只能凭一个"上周"猜他要干什么
//   ④ 没听懂 / 开不了麦 / 那台念不出来 —— 每一档都有**说得出口**的状态
//   ⑤ 🔴 **与服务端那个上限同一个数**（`hear.js` 的 `MAX_HISTORY`）：两处写死会漂，所以对表

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hear_drill.dart';

/// 造一帧"这一段的字"（与真帧同一个形状：`asr/final` 带字）。
Map<String, dynamic> _final(String text, {int index = 0}) =>
    {'type': 'asr/final', 'text': text, 'index': index};

/// 造一帧"这一场说完了"（真链路上它**总在**最后那一段字之后来 ——
/// ⚠️ 光有 `asr/final` 那一场还在听着，只有 `asr/end` 才把它收成"说完了"）。
Map<String, dynamic> _end() => {'type': 'asr/end'};

void main() {
  test('① 走一圈：按麦 → 字 → 在听懂 → 问一句 → 他答 → 可以了', () {
    var dr = const HearDrill();
    expect(dr.phase, DrillPhase.idle);

    // 按一下麦 ⇒ 在听
    dr = dr.startListening();
    expect(dr.phase, DrillPhase.listening);

    // 听到一段字（半句也显示）
    dr = dr.event({'type': 'asr/partial', 'text': '把上周的', 'index': 0});
    expect(dr.said, '把上周的', reason: '★ 半句也要看得见（"在长字"是这一屏的一半）');
    expect(dr.phase, DrillPhase.listening, reason: '还在说 ⇒ 仍然是"在听"');

    // 对面说这一段完了 ⇒ 该送进听懂那一层了
    dr = dr.event(_final('把上周的账理一下')).event(_end());
    expect(dr.phase, DrillPhase.thinking);
    expect(dr.first, '把上周的账理一下', reason: '★ 第一句要留着');
    expect(dr.turns, isEmpty);

    // 那一层说：有一处不确定 ⇒ 问一句
    dr = dr.heardBack(ok: true, heard: '把上周的账理一下。', ask: '是上周还是上个月？');
    expect(dr.phase, DrillPhase.asking);
    expect(dr.question, '是上周还是上个月？');

    // 他答一句（语音那条路：`asr/end` 带回来的字走同一个去处）
    dr = dr.utterance('上周');
    expect(dr.phase, DrillPhase.thinking);
    expect(dr.turns.length, 1);
    expect(dr.turns.first.ask, '是上周还是上个月？');
    expect(dr.turns.first.answer, '上周');
    // ★ 送上去的那一份：**text 仍然是原话**，他答的那句走 history
    final p = dr.payload();
    expect(p['text'], '把上周的账理一下');
    expect((p['history'] as List).length, 1);

    // 那一层说：可以了 ⇒ 最终那一份摆出来
    dr = dr.heardBack(ok: true, heard: '帮我把上周的账理一下。');
    expect(dr.phase, DrillPhase.ready);
    expect(dr.finalText, '帮我把上周的账理一下。');
    expect(dr.done, true);
  });

  test('② 🔴 最多问两轮：到上限就按已经听懂的那份走（不吹毛求疵）', () {
    var dr = const HearDrill().startListening().event(_final('上周的账')).event(_end());
    dr = dr.heardBack(ok: true, heard: '上周的账', ask: '哪一周？');
    expect(dr.phase, DrillPhase.asking);
    dr = dr.utterance('上一周');
    dr = dr.heardBack(ok: true, heard: '上周的账', ask: '要不要按天分开？');
    expect(dr.phase, DrillPhase.asking, reason: '第二轮还能问');
    expect(dr.round, 1);
    dr = dr.utterance('要');
    expect(dr.canAskMore, false, reason: '★ 问满两轮了');
    // 它还想问 ⇒ **不许再问**：按当前这份走
    dr = dr.heardBack(ok: true, heard: '上周的账，按天分开。', ask: '要发给谁吗？');
    expect(dr.phase, DrillPhase.ready);
    expect(dr.question, '', reason: '★ 到上限就不问了');
    expect(dr.finalText, '上周的账，按天分开。');
  });

  test('③ 没成 / 开不了麦 / 没听到 —— 每一档都说得出口，而且都不发送', () {
    // 那一层没答上来（网不通 / 那边没接上）
    final no = const HearDrill()
        .startListening()
        .event(_final('嗯'))
        .event(_end())
        .heardBack(ok: false, note: '这条现在还接不上，等下再试');
    expect(no.phase, DrillPhase.failed);
    expect(no.note, '这条现在还接不上，等下再试');
    // 一个字都没听到（对面说完了，可 text 是空的）
    final nothing = const HearDrill().startListening().event(_end());
    expect(nothing.phase, DrillPhase.failed);
    // 开麦就失败
    final denied = const HearDrill().micFailed('没给权限');
    expect(denied.phase, DrillPhase.failed);
    expect(denied.note, '没给权限');
    // 打字兜底那条路（开不了麦的机器）：直接进"在听懂"，原话就是它
    final typed = const HearDrill().saidByTyping('帮我把上周的账理一下');
    expect(typed.phase, DrillPhase.thinking);
    expect(typed.first, '帮我把上周的账理一下');
    expect((typed.payload()['text'] as String).isNotEmpty, true);
    // 空的那一下不算数
    expect(const HearDrill().saidByTyping('   ').phase, DrillPhase.idle);
    // 再来一句：整场清干净
    final again = no.again();
    expect(again.phase, DrillPhase.idle);
    expect(again.turns, isEmpty);
    expect(again.heard, '');
  });

  test('🔴 判语义要用**stream 结束那一份（总结）**，不是把段拼起来', () {
    // 真机那一串：半句 → 整句 → end（带整段那一份）
    var dr = const HearDrill().startListening();
    dr = dr.event({'type': 'asr/partial', 'text': '你好啊，你怎么', 'index': 0});
    dr = dr.event({'type': 'asr/final', 'text': '你好啊，你怎么', 'index': 0});
    dr = dr.event({'type': 'asr/end', 'text': '你好啊，你怎么没有东西反应啊？', 'index': 0, 'reason': 'upstream'});
    expect(dr.phase, DrillPhase.thinking);
    expect(dr.payload()['text'], '你好啊，你怎么没有东西反应啊？',
        reason: '★ 送去判语义的必须是**整段那一份**');
    // 负向对照：end 没带字（老引擎）⇒ 退回拼起来那一份（不许一个字都没有）
    var old = const HearDrill().startListening();
    old = old.event({'type': 'asr/final', 'text': '帮我看看天气', 'index': 0});
    old = old.event({'type': 'asr/end'});
    expect(old.payload()['text'], '帮我看看天气');
  });

  test('🔴 同一句被两个段号各来一次 ⇒ **只算一遍**（不许发两遍给对面）', () {
    // 真机上那一串：`asr/final` 带 index 0、`asr/end` 带 index 1，字一模一样
    var dr = const HearDrill().startListening();
    dr = dr.event({'type': 'asr/final', 'text': '你好啊，你怎么没有反应啊？', 'index': 0});
    dr = dr.event({'type': 'asr/end', 'text': '你好啊，你怎么没有反应啊？', 'index': 1});
    expect(dr.phase, DrillPhase.thinking);
    expect((dr.payload()['text'] as String), '你好啊，你怎么没有反应啊？',
        reason: '★ 两遍要合成一遍（不然发出去对面看到的是他说了两遍）');
    // 负向对照：**真的说了两遍不一样的话** ⇒ 一个字都不许动
    final two = const HearDrill().startListening().utterance('今天天气不错，出去走走');
    expect(two.payload()['text'], '今天天气不错，出去走走');
    // 半句相同但不是"整句重复" ⇒ 也不动
    expect(onceOnly('哈哈哈'), '哈哈哈');
    expect(onceOnly('好吗好吗'), '好吗');
  });

  test('④ 没在等答的时候说一句 = 那是"这一场的第一句"（不许把状态搞乱）', () {
    final dr = const HearDrill().startListening();
    final after = dr.utterance('随便说一句');
    expect(after.turns, isEmpty);
    expect(after.phase, DrillPhase.thinking, reason: '当成第一句往下走');
    expect(after.first, '随便说一句');
  });

  test('🔴 ⑤ 与服务端那个上限对表：两边都是 2（写死两处迟早漂）', () {
    final src = File('../../services/core/src/hear.js').readAsStringSync();
    final m = RegExp(r'export const MAX_HISTORY = (\d+)').firstMatch(src);
    expect(m, isNotNull, reason: 'hear.js 里那个上限没找到 ⇒ 这条闸扫错地方了');
    expect(
      int.parse(m!.group(1)!),
      drillMaxRounds,
      reason: '★ 界面上问几轮、和那边收几轮，必须是同一个数',
    );
  });
}
