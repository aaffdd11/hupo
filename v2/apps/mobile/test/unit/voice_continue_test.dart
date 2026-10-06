// **语音输入要"连贯"**（2026-10-07 · 主人：*「我的目的是语音输入。要连贯，
// 60秒上限可以，防止忘记关闭浪费钱。」* · 契约 `docs/dev/210-VOICE-CONTINUOUS.md`）。
//
// ⚠️ 2026-10-07 晚**推倒重来**之后：那份字现在长在**底下那个真输入框**里
//    ⇒ 判据读的是 `composeText`（旧名字是 `voiceFlow.said`，同一件事）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **到点（`asr/capped`）不许把这一场断掉**：字一个都不清、**一次都不发**，
//      而且**当场接着开下一轮**（服务端那条 55 秒上限只该管钱，不该管他的话）；
//   ② 🔴 **上游自己收的一轮（`asr/end`）也一样**：他还没按停 ⇒ 接着开，不发；
//   ③ **他按了停才算说完**：那时才发 —— 而且发的是**几轮加起来的那一份**；
//   ④ 负向对照：按停之后那条 `asr/end` 照旧**发出去一次**（老行为一个字没坏）。
//
// ⚠️ 这一层没有界面：量的是**控制器那一侧**（真 `ChatController` ＋ 假 api ＋ 假麦）。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 假的服务端：`/api/say` 记下来（这一份只关心"发了几次、发的是什么"）。
class _Server {
  final List<String> said = [];
  late final Api api = Api(
    base: '',
    client: MockClient((req) async {
      if (req.url.path == '/api/say') {
        said.add((jsonDecode(req.body) as Map<String, dynamic>)['text'] as String? ?? '');
        return http.Response('{"ok":true}', 200, headers: {'content-type': 'application/json'});
      }
      if (req.url.path == '/api/apps') {
        return http.Response('{"apps":[]}', 200, headers: {'content-type': 'application/json'});
      }
      return http.Response('', 404);
    }),
  );

  /// 开过的轮数（每一次 `startHear` = 一条新连接 = 一轮）。
  int rounds = 0;
  /// 现在这一轮的回调（判据用它往里推帧）。
  void Function(Map<String, dynamic>)? on;

  Future<String?> start({
    required Uri url,
    required String token,
    required void Function(Map<String, dynamic>) onEvent,
  }) async {
    rounds += 1;
    on = onEvent;
    return null;
  }
}

({ChatController c, _Server s}) _boot() {
  final s = _Server();
  final c = ChatController(
    api: s.api,
    tokens: TokenStore(),
    token: '测试令牌',
    startHear: s.start,
    stopHear: () {},
    speak: (text, {onEnd}) => true,
    stop: () {},
  );
  return (c: c, s: s);
}

Future<void> _tick() => Future<void>.delayed(const Duration(milliseconds: 20));

void main() {
  test('🔴 到点（asr/capped）：字不清、一次都不发、当场接着开下一轮', () async {
    final b = _boot();
    await b.c.toggleVoiceCompose(); // 按下（第一轮）
    await _tick();
    expect(b.s.rounds, 1);
    b.s.on?.call({'type': 'asr/ready'});
    b.s.on?.call({'type': 'asr/partial', 'text': '我们出去', 'index': 0});
    b.s.on?.call({'type': 'asr/final', 'text': '我们出去走走吧。', 'index': 0});
    await _tick();
    expect(b.c.composeText.trim(), '我们出去走走吧。');

    // ⏰ 服务端到点（55 秒上限）——**他还在说**
    b.s.on?.call({'type': 'asr/capped'});
    await _tick();
    await _tick();
    expect(b.s.said, isEmpty, reason: '★ 到点**不许**把他的话发出去（那是"断"）');
    expect(b.c.composeText.contains('我们出去走走吧。'), true,
        reason: '🔴 已经听到的字**一个都不许清**（主人报的就是这一条）');
    expect(b.s.rounds, 2, reason: '★ 到点要**当场接着开下一轮**（这才是"连贯"）');

    // 第二轮接着长
    b.s.on?.call({'type': 'asr/ready'});
    b.s.on?.call({'type': 'asr/partial', 'text': '今天天气', 'index': 0});
    await _tick();
    expect(b.c.composeText, contains('我们出去走走吧。今天天气'),
        reason: '★ 第二轮的字要接在第一轮后面（不是替换）');
  });

  test('🔴 上游自己收的一轮（asr/end）：他还没按停 ⇒ 一样接着开、不发', () async {
    final b = _boot();
    await b.c.toggleVoiceCompose();
    await _tick();
    b.s.on?.call({'type': 'asr/ready'});
    b.s.on?.call({'type': 'asr/final', 'text': '我说了半句', 'index': 0});
    b.s.on?.call({'type': 'asr/end', 'text': '我说了半句话。', 'reason': 'upstream', 'index': 0});
    await _tick();
    await _tick();
    expect(b.s.said, isEmpty, reason: '★ 他没按停 ⇒ 不许发（上游收一轮不等于他说完了）');
    expect(b.s.rounds, 2, reason: '★ 接着开下一轮');
    expect(b.c.composeText.contains('我说了半句话。'), true, reason: '★ 字留着');
  });

  test('🔴 他按了停才算说完：发出去的是**几轮加起来**的那一份（只发一次）', () async {
    final b = _boot();
    await b.c.toggleVoiceCompose();
    await _tick();
    b.s.on?.call({'type': 'asr/ready'});
    b.s.on?.call({'type': 'asr/final', 'text': '第一句。', 'index': 0});
    b.s.on?.call({'type': 'asr/capped'}); // 到点 ⇒ 自动接着开
    await _tick();
    b.s.on?.call({'type': 'asr/ready'});
    b.s.on?.call({'type': 'asr/final', 'text': '第二句。', 'index': 0});
    await _tick();
    expect(b.s.rounds, 2);

    await b.c.toggleVoiceCompose(); // 他按停
    await _tick();
    b.s.on?.call({'type': 'asr/end', 'text': '第二句。', 'reason': 'user-stop', 'index': 0});
    await _tick();
    await _tick();
    expect(b.s.said.length, 1, reason: '★ 按停之后**只发一次**');
    expect(b.s.said.single, contains('第一句。'), reason: '🔴 发出去的那一份要含**前面几轮**的字（不然就是"被清除"）');
    expect(b.s.said.single, contains('第二句。'));
    expect(b.c.voiceSent, 1);
  });

  test('★ 负向对照：按停之后那条 asr/end 照旧发出去一次（老行为一个字没坏）', () async {
    final b = _boot();
    await b.c.toggleVoiceCompose();
    await _tick();
    b.s.on?.call({'type': 'asr/ready'});
    b.s.on?.call({'type': 'asr/final', 'text': '就说这一句。', 'index': 0});
    await _tick();
    await b.c.toggleVoiceCompose(); // 按停
    await _tick();
    expect(b.s.said, isEmpty, reason: '按停那一刻还不许发（要等对面把最后那一份吐回来）');
    b.s.on?.call({'type': 'asr/end', 'text': '就说这一句。', 'reason': 'user-stop', 'index': 0});
    await _tick();
    await _tick();
    expect(b.s.said, ['就说这一句。'], reason: '★ 按停之后照旧发出去一次');
  });
}
