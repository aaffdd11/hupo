// **说一句 / 说一段那一步的状态机**（纯的）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 走一圈：按麦 → 听到字 → 按停 → **整段就是最终那一份**（中间没有第二个 AI）
//   ② 🔴 **发出去的是"stream 结束那一份"**（整段），不是把段拼起来
//   ③ 🔴 **说了两句（停顿把它切成两段）⇒ 前半段不许被砍掉**
//   ④ 🔴 **同一句被两个段号各来一次 ⇒ 只算一遍**（不许发两遍给对面）
//   ⑤ 🔴 **按停当场有反应**（`wrapping`），而且最后那一份字一个都不丢
//   ⑥ 🔴 **连贯那一档**（聊天那颗话筒）：一轮完了只是"接着开下一轮"，
//      字一个都不清、**一次都不发**；只有他按停才算说完
//   ⑦ 🔴 两条钟的长短关系：控制器的兜底必须**短于**那条连接自己的兜底
//   ⑧ 没听清 / 开不了麦 / 没听到 —— 每一档都有**说得出口**的状态
//
// 🔴 **2026-10-07：那一层"抽离"删掉了**（主人：*"我们之前对语音，是抽离出来做了一层，
//   没问题才发给聊天的。现在我需要把这个抽离的部分给去掉。"*）⇒ 原来这批判据里
//   "问一句 / 最多两轮 / 与服务端 `MAX_HISTORY` 对表"那几条（`heardBack`／`asking`／
//   `turns`／`payload`）**整族删掉了** —— 那套东西在代码里已经不存在。

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
  test('① 走一圈：按麦 → 字 → 按停 → 整段就是最终那一份', () {
    var dr = const HearDrill();
    expect(dr.phase, DrillPhase.idle);

    dr = dr.startListening();
    expect(dr.phase, DrillPhase.listening);

    // 听到一段字（半句也显示）
    dr = dr.event({'type': 'asr/partial', 'text': '把上周的', 'index': 0});
    expect(dr.said, '把上周的', reason: '★ 半句也要看得见（"在长字"是这一屏的一半）');
    expect(dr.phase, DrillPhase.listening, reason: '还在说 ⇒ 仍然是"在听"');

    // 他按停 ⇒ 当场进"收尾中"
    dr = dr.stopListening();
    expect(dr.phase, DrillPhase.wrapping);

    // 对面把整段吐回来 ⇒ **手上这份字就是最终那一份**（没有任何第二层）
    dr = dr.event(_final('把上周的账理一下')).event(_end());
    expect(dr.phase, DrillPhase.thinking);
    expect(dr.toSend, '把上周的账理一下', reason: '★ 他说的那一句就是该发出去的那一份');
  });

  test('🔴 发出去的是**stream 结束那一份（总结）**，不是把段拼起来', () {
    // 真机那一串：半句 → 整句 → end（带整段那一份）
    var dr = const HearDrill().startListening();
    dr = dr.event({'type': 'asr/partial', 'text': '你好啊，你怎么', 'index': 0});
    dr = dr.event({'type': 'asr/final', 'text': '你好啊，你怎么', 'index': 0});
    dr = dr.event({'type': 'asr/end', 'text': '你好啊，你怎么没有东西反应啊？', 'index': 0, 'reason': 'upstream'});
    expect(dr.phase, DrillPhase.thinking);
    expect(dr.toSend, '你好啊，你怎么没有东西反应啊？', reason: '★ 发的必须是**整段那一份**');
    // 负向对照：end 没带字（老引擎）⇒ 退回拼起来那一份（不许一个字都没有）
    var old = const HearDrill().startListening();
    old = old.event({'type': 'asr/final', 'text': '帮我看看天气', 'index': 0});
    old = old.event({'type': 'asr/end'});
    expect(old.toSend, '帮我看看天气');
  });

  test('🔴 说了两句（停顿把它切成两段）⇒ **前半段不许被砍掉**', () {
    // ★ 2026-10-06：主人 *"我说的话前半段会被砍掉。这个处理机制不对。"*
    //   真读数（真连豆包 · 两句 · 中间停顿）：上游**按句给字**，说第二句时第一句
    //   就不在回话里了 ⇒ 服务端自己按段攒（`createSegmentTracker`），
    //   收尾那条 `asr/end` 带的是**整段**。这一条钉住客户端也跟着用整段。
    var dr = const HearDrill().startListening();
    dr = dr.event({'type': 'asr/partial', 'text': '今天天气', 'index': 0});
    dr = dr.event({'type': 'asr/partial', 'text': '怎么样', 'index': 1});
    dr = dr.event({'type': 'asr/final', 'text': '怎么样', 'index': 1});
    dr = dr.event({'type': 'asr/end', 'text': '今天天气怎么样', 'index': 1, 'reason': 'user-stop'});
    expect(dr.phase, DrillPhase.thinking);
    expect(dr.said, '今天天气怎么样', reason: '★ 屏幕上那份"直白的字"也要是整段');
    expect(dr.toSend, '今天天气怎么样', reason: '★ 发出去的更不许只剩后半段');
    // 负向对照：**真只听到后半段**（前半段一个字都没有）⇒ 就照实的来，不许编
    var half = const HearDrill().startListening();
    half = half.event({'type': 'asr/final', 'text': '怎么样', 'index': 0});
    half = half.event({'type': 'asr/end', 'text': '怎么样', 'index': 0});
    expect(half.toSend, '怎么样');
  });

  test('🔴 同一句被两个段号各来一次 ⇒ **只算一遍**（不许发两遍给对面）', () {
    // 真机上那一串：`asr/final` 带 index 0、`asr/end` 带 index 1，字一模一样
    var dr = const HearDrill().startListening();
    dr = dr.event({'type': 'asr/final', 'text': '你好啊，你怎么没有反应啊？', 'index': 0});
    dr = dr.event({'type': 'asr/end', 'text': '你好啊，你怎么没有反应啊？', 'index': 1});
    expect(dr.phase, DrillPhase.thinking);
    expect(dr.toSend, '你好啊，你怎么没有反应啊？',
        reason: '★ 两遍要合成一遍（不然发出去对面看到的是他说了两遍）');
    // 负向对照：**真的说了两遍不一样的话** ⇒ 一个字都不许动
    final two = const HearDrill().startListening().utterance('今天天气不错，出去走走');
    expect(two.toSend, '今天天气不错，出去走走');
    // 半句相同但不是"整句重复" ⇒ 也不动
    expect(onceOnly('哈哈哈'), '哈哈哈');
    expect(onceOnly('好吗好吗'), '好吗');
  });

  test('🔴 ⑤ 按停**当场**进"收尾中"，而且最后那一份字一个都不丢', () {
    // 主人 2026-10-05：*"我们录音和停止录音上，点击停止录音响应很慢。"*
    //   根子：按停之后这一台**还停在 `listening`**（要等 `asr/end` 才动）
    //   ⇒ 那一秒多里屏幕上什么都没变（圆圈照旧闪着"我在录"）。
    var dr = const HearDrill().startListening();
    dr = dr.event({'type': 'asr/final', 'text': '帮我看看上海的天气', 'index': 0});
    expect(dr.phase, DrillPhase.listening);

    final stopped = dr.stopListening();
    expect(stopped.phase, DrillPhase.wrapping, reason: '★ 按停必须当场换档，不许等对面');
    expect(stopped.said, '帮我看看上海的天气', reason: '★ 已经听到的字留着');

    // 🔴 负向对照：**收尾中来的帧照收**（丢了它 = "能转文字、没有后文"那一族）
    final after = stopped.event({'type': 'asr/end', 'text': '帮我看看上海的天气', 'index': 0});
    expect(after.phase, DrillPhase.thinking, reason: '★ 最后那一份字到了 ⇒ 该发了');
    expect(after.toSend, '帮我看看上海的天气');

    // 收尾中来的**半句**也要接得上（不是只认 end）
    final more = stopped.event({'type': 'asr/partial', 'text': '帮我看看上海的天气', 'index': 0});
    expect(more.phase, DrillPhase.wrapping, reason: '★ 收尾中仍旧在收字，别把它踢出这一场');

    // 🔴 负向对照：**没在听、也没在收尾**的时候来的帧，不许把这一场弄乱
    final idle = const HearDrill().event({'type': 'asr/end', 'text': '天上掉下来的'});
    expect(idle.phase, DrillPhase.idle, reason: '★ 没开场就来的帧一个字都不许认');
    final ready = const HearDrill().saidByTyping('上周的账').recognized('上周的账');
    expect(ready.phase, DrillPhase.ready);
    expect(ready.event({'type': 'asr/end', 'text': '迟到的定稿'}).heard, '上周的账',
        reason: '★ 已经可以了的时候，迟到的定稿不许把它冲掉');
  });

  test('🔴 ⑥ 按停之后**不许直接结束**：等语音结束；迟到的那一份也不丢', () {
    // 主人 2026-10-05：*"用户点击结束录音，你要等待语音结束和语义转换结束。不要直接结束。"*
    var dr = const HearDrill().startListening();
    dr = dr.event({'type': 'asr/final', 'text': '帮我看看天气', 'index': 0});
    final stopped = dr.stopListening();
    expect(stopped.phase, DrillPhase.wrapping);
    expect(stopped.said, '帮我看看天气', reason: '★ 已经听到的字留着');

    // ② 语音结束那一份到了 ⇒ 可以发了（绝不是"按停就当场收场"）
    final thinking = stopped.event({'type': 'asr/end', 'text': '帮我看看天气', 'index': 0});
    expect(thinking.phase, DrillPhase.thinking);

    // ③ 🔴 **迟到的定稿在"该发了"这一刻到了** ⇒ 收进来（屏幕上那份字补全）
    final late = thinking.event({'type': 'asr/end', 'text': '帮我看看上海的天气', 'index': 0});
    expect(late.phase, DrillPhase.thinking, reason: '★ 不许被这一帧打回去');
    expect(late.said, '帮我看看上海的天气', reason: '★ 迟到的那一份字不许扔');
  });

  test('🔴 ⑦·核心 **连贯那一档**：一轮完了只是接着开下一轮，一次都不发', () {
    // 主人 2026-10-07：*"我的目的是语音输入。要连贯"* ＋
    //   *"不可能每个句号做断点，也必须是用户说完，语音变成文字拿回来了，我们再发出去。"*
    var dr = const HearDrill(continuous: true).startListening();
    dr = dr.event({'type': 'asr/partial', 'text': '今天天气不错。', 'index': 0});
    dr = dr.event({'type': 'asr/end', 'text': '今天天气不错。', 'index': 0, 'reason': 'upstream'});
    expect(dr.phase, DrillPhase.listening, reason: '★ 一句完了**不是他说完了** —— 还在听');
    expect(dr.said, '今天天气不错。', reason: '★ 前面那句一个字都不许丢');

    // 55 秒上限到点（我们自己的上限）⇒ **也接着开下一轮**，不是"把他的话切断"
    dr = dr.event({'type': 'asr/capped'});
    expect(dr.phase, DrillPhase.listening);
    expect(dr.said, '今天天气不错。', reason: '★ 到点只是换一条连接，字留着');

    // 他又说了一句（新的一条连接：段号又从 0 开始）
    dr = dr.event({'type': 'asr/partial', 'text': '我想出去走走', 'index': 0});
    expect(dr.said, '今天天气不错。我想出去走走', reason: '★ 新那一轮接在后面，不是把它顶掉');

    // **他按停** ⇒ 这才算说完
    dr = dr.stopListening();
    dr = dr.event({'type': 'asr/end', 'text': '我想出去走走。', 'index': 0, 'reason': 'user-stop'});
    expect(dr.phase, DrillPhase.thinking, reason: '★ 只有按停才算说完');
    expect(dr.toSend, '今天天气不错。我想出去走走。', reason: '★ 发出去的是**攒起来的那一整段**');
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
    // 而且它不是"到点就收场"那种短钟
    expect(stopLinger, greaterThanOrEqualTo(10),
        reason: '★ 兜底钟太短 ⇒ 长句子还没等到定稿就被当成"结束了"');
  });

  test('🔴 ⑧ 发完一场之后**还是"连贯"那一档**（不许退成"一到点就收场"）', () {
    // 🔴 2026-10-07 主人报的：*"一句话出现识别句号以后，后台会做点什么事情，
    //   然后前面那句话就没了。"*
    //   根子就在这一条上：控制器发完之后原来写的是 `const HearDrill()`（`continuous`
    //   默认 `false`）⇒ **他第二条话**退成"非连贯"：55 秒上限那条 `asr/end` 会
    //   在半路把它发出去、框当场清空。⇒ 控制器那一行必须是 `continuous: true`。
    final ctl = File('lib/services/chat_controller.dart').readAsStringSync();
    expect(
      RegExp(r'_voiceFlow = const HearDrill\(continuous: true\)').hasMatch(ctl),
      isTrue,
      reason: '★ 发完一场之后必须落回"连贯"那一档（见 `_composeSendNow` ④）',
    );
    expect(
      RegExp(r'_voiceFlow = const HearDrill\(\);').hasMatch(ctl),
      isFalse,
      reason: '★ 那一下会把 `continuous` 落回 `false` ⇒ 他第二句话会被"到点"切断',
    );
  });

  test('⑨ 没听清 / 开不了麦：每一档都说得出口，而且都不发送', () {
    // 一个字都没听到（对面说完了，可 text 是空的）
    final nothing = const HearDrill().startListening().event(_end());
    expect(nothing.phase, DrillPhase.failed);
    expect(nothing.toSend, '', reason: '★ 一个字都没有 ⇒ 没东西可发（控制器会如实说一句）');
    // "没听清"那一档
    final hush = const HearDrill().nothing('这句我没听清，再说一遍。');
    expect(hush.phase, DrillPhase.failed);
    expect(hush.note, '这句我没听清，再说一遍。');
    // 开麦就失败
    final denied = const HearDrill().micFailed('没给权限');
    expect(denied.phase, DrillPhase.failed);
    expect(denied.note, '没给权限');
    // 打字兜底那条路（开不了麦的机器）：字落在 `first` 上 ⇒ 也发得出去
    final typed = const HearDrill().saidByTyping('帮我把上周的账理一下');
    expect(typed.phase, DrillPhase.thinking);
    expect(typed.toSend, '帮我把上周的账理一下');
    // 空的那一下不算数
    expect(const HearDrill().saidByTyping('   ').phase, DrillPhase.idle);
    // 再来一句：整场清干净
    final again = denied.again();
    expect(again.phase, DrillPhase.idle);
    expect(again.heard, '');
    expect(again.first, '');
  });

  test('⑩ 演练那一屏的落点：`recognized` 就是"最终那一份"（一个字都不改）', () {
    final dr = const HearDrill().startListening().recognized('把上周的账理一下');
    expect(dr.phase, DrillPhase.ready);
    expect(dr.finalText, '把上周的账理一下');
    // 空字 ⇒ **如实说没听清**，不许摆一个空的"可以了"
    expect(const HearDrill().recognized('   ').phase, DrillPhase.failed);
    // 同一句被两个段号各来一次那种，在这一档也要合成一遍
    expect(const HearDrill().recognized('好吗好吗').finalText, '好吗');
  });
}
