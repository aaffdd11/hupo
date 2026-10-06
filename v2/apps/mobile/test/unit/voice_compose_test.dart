// **语音那一档：说完 → 字拿回来 → 发出去**（手册 `D3.14`／`D5.18`／`D5.19`）。
//
// ── 🔴 2026-10-07：那一层"抽离"删掉了 ────────────────────────────
//   主人：*"我们之前对语音，是抽离出来做了一层，没问题才发给聊天的。现在我需要把
//   这个抽离的部分给去掉。用户会说很多话的。不可能每个句号做断点，也必须是用户说完，
//   语音变成文字拿回来了，我们再发出去。"*
//   ⇒ 原来的 V1–V4（"通顺就发 / 不确定先问 / 最多两轮"）**整族删掉** ——
//      `/api/hear` 那条路在这一侧已经不存在了（服务端那条口留着给老包）。
//
// ── 这一份现在钉什么 ──────────────────────────────────────────
//   V1 🔴 **按停那一下才发**，而且**只发一次**（发的是他说的原话）
//   V2 🔴 **说很多句也只在按停那一下发一次**：中间那些句号 / 到点，一个字都不许丢
//   V3 🔴 **发完一场之后还是"连贯"那一档**（主人报的"前面那句话没了"就是这一条）
//   V4 **按停当场有反应**，收尾中再点不算，迟到的那一份照样发得出去
//   V5 开麦失败 ⇒ 如实说、**不发**；打字那条兜底照样走得通
//   V6 🔴 **这一侧一处都不调 `/api/hear`**（源码扫描 —— 那一层是真删了，不是关着）
//
// ⚠️ 这一层没有界面：判据量的是**控制器那一侧**（真 `ChatController` ＋ 假 api ＋ 假麦）。

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hear_drill.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 假的服务端：`/api/say` **记下来**；`/api/hear` **一次都不许来**（来了就记一笔）。
class _Server {
  final List<String> said = [];

  /// 🔴 那个"抽离层"的调用次数：**必须是 0**（`V6` 那一侧还要扫源码）。
  int hearCalls = 0;

  late final Api api = Api(
    base: '',
    client: MockClient((req) async {
      if (req.url.path == '/api/hear') {
        hearCalls += 1;
        return http.Response(jsonEncode({'error': '这一层已经删了'}), 500,
            headers: {'content-type': 'application/json'});
      }
      if (req.url.path == '/api/say') {
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        said.add((body['text'] as String?) ?? '');
        return http.Response(jsonEncode({'ok': true}), 200, headers: {'content-type': 'application/json'});
      }
      if (req.url.path == '/api/apps') {
        return http.Response(jsonEncode({'apps': <Object>[]}), 200, headers: {'content-type': 'application/json'});
      }
      return http.Response('', 404);
    }),
  );
}

/// 一条假的麦（装了它，`canHear` 才是真）。
class _FakeHearing {
  void Function(Map<String, dynamic>)? on;
  String? failWith;
}

Future<void> _waitFor(bool Function() pred, String why) async {
  final t0 = DateTime.now();
  while (DateTime.now().difference(t0).inSeconds < 8) {
    if (pred()) return;
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  throw StateError('等不到：$why');
}

({ChatController c, _Server s, _FakeHearing mic}) _boot() {
  final server = _Server();
  final mic = _FakeHearing();
  final c = ChatController(
    api: server.api,
    tokens: TokenStore(),
    token: '测试令牌',
    startHear: ({required Uri url, required String token, required void Function(Map<String, dynamic>) onEvent}) async {
      if (mic.failWith != null) return mic.failWith;
      mic.on = onEvent;
      return null;
    },
    stopHear: () {},
    speak: (text, {onEnd}) => true,
    stop: () {},
  );
  return (c: c, s: server, mic: mic);
}

/// **他按停**（🔴 只有这一下才算"说完了"）＋ 对面那条收尾回来。
Future<void> _stopSpeaking(_FakeHearing mic, ChatController c, String text) async {
  await c.toggleVoiceCompose(); // 按停
  mic.on?.call({'type': 'asr/end', 'text': text, 'reason': 'user-stop'});
}

void main() {
  test('V1 🔴 按停就发：**只发一次**，发的就是他说的原话', () async {
    final b = _boot();
    await b.c.toggleVoiceCompose();
    expect(b.c.voiceFlow.phase, DrillPhase.listening, reason: '起点：在听');

    b.mic.on?.call({'type': 'asr/ready'});
    b.mic.on?.call({'type': 'asr/partial', 'text': '帮我查一下明天北京的天气'});
    expect(b.s.said, isEmpty, reason: '★ 还在说 ⇒ 一个字节都不许发');

    await _stopSpeaking(b.mic, b.c, '帮我查一下明天北京的天气');
    await _waitFor(() => b.s.said.isNotEmpty, '它自己发出去');
    expect(b.s.said, ['帮我查一下明天北京的天气'], reason: '★ 一个字都不许改（没有第二层了）');
    expect(b.s.hearCalls, 0, reason: '★ 那一层删了：一次都不许调');
    expect(b.c.voiceSent, 1, reason: '★ 界面据此把聊天记录窗口打开');
    expect(b.c.voiceFlow.phase, DrillPhase.idle, reason: '这一场收干净');
  });

  test('V2 🔴 说很多句：中间一次都不发，**只在按停那一下发一次**', () async {
    // 主人：*"用户会说很多话的。不可能每个句号做断点。"*
    //   真链路：豆包按句给字（句号）；我们到点还会换一条连接 ⇒ 这些**都不是"说完"**。
    final b = _boot();
    await b.c.toggleVoiceCompose();
    b.mic.on?.call({'type': 'asr/ready'});
    b.mic.on?.call({'type': 'asr/partial', 'text': '今天天气不错。'});
    // 一句完了（上游自己收一轮）⇒ **接着开下一轮**，不是"他说完了"
    b.mic.on?.call({'type': 'asr/end', 'text': '今天天气不错。', 'reason': 'upstream'});
    expect(b.c.voiceFlow.phase, DrillPhase.listening, reason: '★ 一句完了还接着听');
    expect(b.c.voiceFlow.said, '今天天气不错。', reason: '★ 前面那句一个字都不许丢');
    expect(b.s.said, isEmpty);
    // 55 秒上限到点（我们自己的上限）⇒ **也接着开下一轮**
    b.mic.on?.call({'type': 'asr/capped'});
    expect(b.c.voiceFlow.phase, DrillPhase.listening);
    expect(b.c.voiceFlow.said, '今天天气不错。');
    expect(b.s.said, isEmpty, reason: '★ 到点不是"说完"，不许发');
    // 他接着说了第二句（新连接：段号又从 0 开始）
    b.mic.on?.call({'type': 'asr/partial', 'text': '我想出去走走'});
    expect(b.c.voiceFlow.said, '今天天气不错。我想出去走走');

    // **他按停** ⇒ 这才算说完，发出去的是**攒起来的那一整段**
    await _stopSpeaking(b.mic, b.c, '我想出去走走。');
    await _waitFor(() => b.s.said.isNotEmpty, '按停之后发出去');
    expect(b.s.said, ['今天天气不错。我想出去走走。'], reason: '★ 一整段、一次发完');
    expect(b.c.voiceSent, 1, reason: '★ 一次');
  });

  test('V3 🔴 发完一场之后**还是"连贯"那一档**（"前面那句话没了"就是这一条）', () async {
    // 🔴 主人 2026-10-07：*"我发现语音一个问题，就是一句话出现识别句号以后，
    //   后台会做点什么事情，然后前面那句话就没了。"*
    //   根子：控制器发完之后原来落回 `const HearDrill()`（`continuous` 默认 `false`）
    //   ⇒ **第二条话**退成"非连贯"：到点那条 `asr/end` 会**在半路把它发出去**、
    //   框当场清空 ⇒ 屏幕上看着就是前面那句没了。这一条钉住：**它得一直连贯**。
    final b = _boot();
    // ── 第一场：说一句、按停、发出去 ──
    await b.c.toggleVoiceCompose();
    b.mic.on?.call({'type': 'asr/final', 'text': '第一句。'});
    await _stopSpeaking(b.mic, b.c, '第一句。');
    await _waitFor(() => b.s.said.length == 1, '第一句发出去');
    expect(b.c.voiceFlow.continuous, isTrue, reason: '★ 发完这一场之后仍然要"连贯"');

    // ── 第二场：说到一半被 55 秒上限收了一轮 ⇒ **不许发**，字也不许清 ──
    await b.c.toggleVoiceCompose();
    b.mic.on?.call({'type': 'asr/partial', 'text': '前面那句'});
    b.mic.on?.call({'type': 'asr/capped'});
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(b.s.said.length, 1, reason: '★★ 到点不许在半路把它发出去（那正是主人报的那个坑）');
    expect(b.c.voiceFlow.said, '前面那句', reason: '★ 字还在框里');
    expect(b.c.voiceFlow.phase, DrillPhase.listening, reason: '★ 还在听，没被他按停');

    // 他接着说第二句、然后按停 ⇒ 两段合成一句发出去
    b.mic.on?.call({'type': 'asr/partial', 'text': '后面那句。'});
    await _stopSpeaking(b.mic, b.c, '后面那句。');
    await _waitFor(() => b.s.said.length == 2, '按停之后才发');
    expect(b.s.said[1], '前面那句后面那句。');
  });

  test('V4 按停**当场**有反应（不许等对面那一帧），收尾中再点也不算', () async {
    // 主人 2026-10-05：*"我们录音和停止录音上，点击停止录音响应很慢。"*
    final b = _boot();
    await b.c.toggleVoiceCompose();
    expect(b.c.voiceFlow.phase, DrillPhase.listening, reason: '起点：在听');
    b.mic.on?.call({'type': 'asr/final', 'text': '帮我查一下明天的天气'});

    await b.c.toggleVoiceCompose(); // **按停这一下**（还没来任何一帧）
    expect(b.c.voiceFlow.phase, DrillPhase.wrapping,
        reason: '★ 按停当场就得换档 —— 屏幕上那句"收下了，正在整理……"就是从这儿来的');
    await b.c.toggleVoiceCompose(); // 再点一下
    expect(b.c.voiceFlow.phase, DrillPhase.wrapping, reason: '★ 收尾中再点也不许重开');
    expect(b.s.said, isEmpty);

    // 对面最后那一份字到了 ⇒ 照旧往下走（**一个字都没丢**）
    b.mic.on?.call({'type': 'asr/end', 'text': '帮我查一下明天的天气', 'reason': 'upstream'});
    await _waitFor(() => b.s.said.isNotEmpty, '收尾之后照样发得出去');
    expect(b.s.said, ['帮我查一下明天的天气']);
    expect(b.c.voiceFlow.phase, DrillPhase.idle, reason: '这一场收干净');
  });

  test('V5 开麦失败 ⇒ 如实说、不发；打字那条兜底照样通', () async {
    final b = _boot();
    b.mic.failWith = 'denied';
    await b.c.toggleVoiceCompose();
    expect(b.c.voiceFlow.phase, DrillPhase.failed);
    expect(b.s.said, isEmpty, reason: '★ 开不了麦就一个字节都不许发');
    // 打字兜底：同一层、同一个去处
    await b.c.answerVoiceCompose('帮我查一下明天的天气');
    await _waitFor(() => b.s.said.isNotEmpty, '兜底那条也要发得出去');
    expect(b.s.said, ['帮我查一下明天的天气']);
    expect(b.s.hearCalls, 0);
  });

  test('V6 🔴 这一侧**一处都不调 `/api/hear`**（那一层是真删了）', () {
    // ⚠️ 量的是"代码里还在不在调"，不是"开关关没关"：主人要的是**去掉**。
    //    所以找的是**那个地址字面量**（注释里提一句不算 —— `api.dart` 那一段
    //    还留着"服务端那条口给老包留着"的记录）。
    final files = Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))
        .toList();
    final hits = <String>[];
    for (final f in files) {
      final src = f.readAsStringSync();
      if (src.contains("'/api/hear'") || src.contains('"/api/hear"')) hits.add(f.path);
    }
    expect(hits, isEmpty, reason: '★ 这一侧不该再有人调那条"抽离层"：$hits');
    // 而那一套东西（那个开关）**文件本身也不许还在**
    expect(File('lib/models/semantic_switch.dart').existsSync(), isFalse,
        reason: '★ 那个开关是"先暂停"的产物，主人现在要的是删掉');
  });
}
