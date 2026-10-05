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

  test('🔴 ⑥ 按停**当场**进"收尾中"，而且最后那一份字一个都不丢', () {
    // 主人 2026-10-05：*"我们录音和停止录音上，点击停止录音响应很慢。"*
    //   根子：按停之后这一台**还停在 `listening`**（要等 `asr/end` 才动）
    //   ⇒ 那一秒多里屏幕上什么都没变（圆圈照旧闪着"我在录"）。
    var dr = const HearDrill().startListening();
    dr = dr.event({'type': 'asr/final', 'text': '帮我看看上海的天气', 'index': 0});
    expect(dr.phase, DrillPhase.listening);

    // 他按了停 ⇒ **立刻**换档（这就是"当场有反应"）
    final stopped = dr.stopListening();
    expect(stopped.phase, DrillPhase.wrapping, reason: '★ 按停必须当场换档，不许等对面');
    expect(stopped.said, '帮我看看上海的天气', reason: '★ 已经听到的字留着');

    // 🔴 负向对照：**收尾中来的帧照收**（丢了它 = "能转文字、没有后文"那一族）
    final after = stopped.event({'type': 'asr/end', 'text': '帮我看看上海的天气', 'index': 0});
    expect(after.phase, DrillPhase.thinking, reason: '★ 最后那一份字到了 ⇒ 进"听懂"那一层');
    expect((after.payload()['text'] as String), '帮我看看上海的天气');

    // 收尾中来的**半句**也要接得上（不是只认 end）
    final more = stopped.event({'type': 'asr/partial', 'text': '帮我看看上海的天气', 'index': 0});
    expect(more.phase, DrillPhase.wrapping, reason: '★ 收尾中仍旧在收字，别把它踢出这一场');

    // 🔴 负向对照：**没在听、也没在收尾**的时候来的帧，不许把这一场弄乱
    final idle = const HearDrill().event({'type': 'asr/end', 'text': '天上掉下来的'});
    expect(idle.phase, DrillPhase.idle, reason: '★ 没开场就来的帧一个字都不许认');
    final asking = const HearDrill()
        .startListening()
        .utterance('上周的账')
        .heardBack(ok: true, heard: '上周的账', ask: '哪一本账？');
    expect(asking.phase, DrillPhase.asking);
    expect(asking.event({'type': 'asr/end', 'text': '迟到的定稿'}).phase, DrillPhase.asking,
        reason: '★ 正在问他话的时候，迟到的定稿不许把那一问冲掉');
  });

  test('🔴 ⑦ 按停之后**不许直接结束**：等语音结束 ＋ 等语义转换；迟到的那一份也不丢', () {
    // 主人 2026-10-05：*"用户点击结束录音，你要等待语音结束和语义转换结束。不要直接结束。"*
    var dr = const HearDrill().startListening();
    dr = dr.event({'type': 'asr/final', 'text': '帮我看看天气', 'index': 0});
    final stopped = dr.stopListening();
    // ① 按停**不是收场**：这一档还在等对面（屏幕上那句"收下了，正在整理……"就是从这儿来的）
    expect(stopped.phase, DrillPhase.wrapping);
    expect(stopped.said, '帮我看看天气', reason: '★ 已经听到的字留着');

    // ② 语音结束那一份到了 ⇒ 进"听懂"那一层（**这一步才是"语义转换"开始**）
    final thinking = stopped.event({'type': 'asr/end', 'text': '帮我看看天气', 'index': 0});
    expect(thinking.phase, DrillPhase.thinking);

    // ③ 🔴 **迟到的定稿在"听懂"那一层跑着的时候到了** ⇒ 收进来（屏幕上那份字补全），
    //    而且**不重跑**那一层（重跑要再花一次他的钱）
    final late = thinking.event({'type': 'asr/end', 'text': '帮我看看上海的天气', 'index': 0});
    expect(late.phase, DrillPhase.thinking, reason: '★ 不许被这一帧打回去重跑');
    expect(late.said, '帮我看看上海的天气', reason: '★ 迟到的那一份字不许扔');

    // ④ 负向对照：**已经在问 / 已经可以了**的时候来一帧 ⇒ 一个字都不许动
    final asking = thinking.heardBack(ok: true, heard: '帮我看看上海的天气', ask: '哪天？');
    // ⚠️ 问都问了 ⇒ 那一份字（`said`）就是**当时**那份，不许被迟到的一帧改掉
    expect(asking.event({'type': 'asr/end', 'text': '天上掉下来的'}).said, '帮我看看天气',
        reason: '★ 问都问了，迟到的字不许把那一份改掉');
    final ready = thinking.heardBack(ok: true, heard: '帮我看看上海的天气');
    expect(ready.event({'type': 'asr/end', 'text': '天上掉下来的'}).heard, '帮我看看上海的天气');
  });

  test('🔴 ⑦·补 两条钟的长短关系：**控制器的兜底必须短于**那条连接自己的兜底', () {
    // 那条连接一到点就被收干净（之后再不会有任何一帧）⇒ 控制器的钟要是更长，
    // 屏幕上就永远停在"收下了，正在整理……"（"没有后文"那一族）。
    final ctl = File('lib/services/chat_controller.dart').readAsStringSync();
    final m1 = RegExp(r'stopLinger = Duration\(seconds: (\d+)\)').firstMatch(ctl);
    expect(m1, isNotNull, reason: '找不到控制器那条兜底钟');
    final stopLinger = int.parse(m1!.group(1)!);
    for (final f in ['lib/services/hearing_web.dart', 'lib/services/hearing_native.dart']) {
      final src = File(f).readAsStringSync();
      final m2 = RegExp(r'_lingerLimit = Duration\(seconds: (\d+)\)').firstMatch(src);
      expect(m2, isNotNull, reason: '$f 里找不到那条连接的兜底钟');
      expect(stopLinger < int.parse(m2!.group(1)!), isTrue,
          reason: '★ $f：连接那条（${m2.group(1)}s）不比控制器的兜底（${stopLinger}s）长 '
              '⇒ 屏幕上会永远停在"收下了，正在整理……"');
    }
    // 而且它不是"到点就收场"那种短钟（他明确要"等语音结束和语义转换结束"）
    expect(stopLinger, greaterThanOrEqualTo(10),
        reason: '★ 兜底钟太短 ⇒ 长句子还没等到定稿就被当成"结束了"');
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
