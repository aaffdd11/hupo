// **语音那一档：说一句 → 只听错别字 → 通顺就自己发出去**（乙期 · 手册 `D3.14`／`D5.18`／`D5.19`）。
//
// ── ⚠️ 2026-10-06 起：这几条**都要先把开关打开**（`setUp` 里那两行）────────
//   主人当天说"先暂停语义检查" ⇒ 生产里那条路关着；**代码与判据都留着**（要能一句话开回来）。
//   量"关着"那一档的是 `test/unit/semantic_pause_test.dart`。
//
// ── 这一份钉什么（V1–V4）────────────────────────────────────
//   V1 🔴 **通顺就发**：听懂那一层说"没问题" ⇒ **一次 `/api/say`**，发出去的**就是屏幕上那句**
//   V2 🔴 **不确定先问、不许发**：回执带 `ask` ⇒ `/api/say` **一次都没有**，屏幕上拿着那个问题
//   V3 **他答的那句修正前面那句**：再判一次（带上"我问…他答…"），然后才发（**一次**）
//   V4 🔴 **最多两轮**：到上限不再问，按听懂的这份发（**还是一次**）
//   V5 开麦失败 ⇒ 如实说、**不发**；打字那条兜底照样走得通
//
// ⚠️ 这一层没有界面：判据量的是**控制器那一侧**（真 `ChatController` ＋ 假 api ＋ 假麦）。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hear_drill.dart';
import 'package:hupo_app/models/semantic_switch.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 假的服务端：`/api/hear` 按剧本回，`/api/say` **记下来**。
class _Server {
  _Server(this.replies);
  final List<Map<String, Object?>> replies; // 每一次 /api/hear 回什么
  final List<String> said = [];
  final List<String> heardTexts = [];
  final List<List<Map<String, String>>> histories = [];
  int hearCalls = 0;

  late final Api api = Api(
    base: '',
    client: MockClient((req) async {
      if (req.url.path == '/api/hear') {
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        heardTexts.add((body['text'] as String?) ?? '');
        histories.add(((body['history'] as List?) ?? const [])
            .map((e) => (e as Map).cast<String, String>())
            .toList());
        final r = replies[hearCalls < replies.length ? hearCalls : replies.length - 1];
        hearCalls += 1;
        return http.Response(jsonEncode(r), 200, headers: {'content-type': 'application/json'});
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

({ChatController c, _Server s, _FakeHearing mic}) _boot(List<Map<String, Object?>> replies) {
  final server = _Server(replies);
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

/// 说完一句 ⇒ **按停**（🔴 2026-10-07 起的新形状：主人 *「我的目的是语音输入。要连贯」*
/// ⇒ **他按停才算说完**；引擎到点/上游收一轮只是"接着开下一轮"）。
/// 所以这一串帧是：能听 → 定稿 → **按停** → 对面那条收尾。
/// ⚠️ 判据本身量的事一件没变（"发的是哪一份字"），变的只是"什么时候算说完"。
Future<void> _speak(_FakeHearing mic, ChatController c, String text) async {
  mic.on?.call({'type': 'asr/ready'});
  mic.on?.call({'type': 'asr/final', 'text': text});
  await c.toggleVoiceCompose(); // 按停
  mic.on?.call({'type': 'asr/end', 'text': text, 'reason': 'user-stop'});
}

void main() {
  // 🔴 **2026-10-06：这一份量的是"听懂那一层"那条路**（主人当天说*「先暂停语义检查。
  //   不要检查语义，直接快速语音转文字，点击结束就发送。」*）⇒ 那条路**代码还在、
  //   只是生产里关着** ⇒ 这里把它**临时打开**（判据才量得到 V1–V5 那五件事），
  //   验完还原。**"关着"那一档**（说完直接发、一次都不调 `/api/hear`）住在
  //   `test/unit/semantic_pause_test.dart`。
  setUp(() => semanticCheckOn = true);
  tearDown(() => semanticCheckOn = false);

  test('V1 🔴 通顺就发：一次 `/api/say`，发出去的就是屏幕上那句', () async {
    final b = _boot([
      {'heard': '帮我查一下明天北京的天气预报', 'ask': null, 'fact': '予报→预报', 'scene': 'do'},
    ]);
    await b.c.toggleVoiceCompose();
    await _speak(b.mic, b.c, '帮我查一下明天北京的天气予报');
    await _waitFor(() => b.s.said.isNotEmpty, '它自己发出去');
    expect(b.s.said, ['帮我查一下明天北京的天气预报'], reason: '★ 发出去的是**改过错别字**那一句');
    expect(b.s.hearCalls, 1);
    expect(b.c.voiceSent, 1, reason: '★ 界面据此把聊天记录窗口打开');
    expect(b.c.voiceFlow.phase, DrillPhase.idle, reason: '这一场收干净');
  });

  test('V2 🔴 不确定 ⇒ 先问、一次都不许发', () async {
    final b = _boot([
      {'heard': '那个东西弄一下', 'ask': '你说的那个东西是指什么？', 'scene': 'do'},
    ]);
    await b.c.toggleVoiceCompose();
    await _speak(b.mic, b.c, '那个东西弄一下');
    await _waitFor(() => b.c.voiceFlow.phase == DrillPhase.asking, '它问回来');
    expect(b.s.said, isEmpty, reason: '★★ 问了就不许发');
    expect(b.c.voiceFlow.question, '你说的那个东西是指什么？');
  });

  test('V3 他答的那句**修正前面那句**：再判一次（带上问答）然后才发', () async {
    final b = _boot([
      {'heard': '把上周的账理一下', 'ask': '是上周还是上个月？', 'scene': 'do'},
      {'heard': '把上个月的账理一下', 'ask': null, 'scene': 'do'},
    ]);
    await b.c.toggleVoiceCompose();
    await _speak(b.mic, b.c, '把上周的账理一下');
    await _waitFor(() => b.c.voiceFlow.phase == DrillPhase.asking, '它问回来');
    await b.c.answerVoiceCompose('上个月');
    await _waitFor(() => b.s.said.isNotEmpty, '答完就发出去');
    expect(b.s.hearCalls, 2);
    expect(b.s.histories[1].length, 1, reason: '★ 第二轮把"我问…他答…"带上去了');
    expect(b.s.histories[1][0]['answer'], '上个月');
    expect(b.s.said, ['把上个月的账理一下'], reason: '★ 发的是**修正之后**那一句');
  });

  test('V4 🔴 最多两轮：到上限不再问，按听懂的这份发（还是一次）', () async {
    final b = _boot([
      {'heard': '帮我把账理一下', 'ask': '哪个账？', 'scene': 'do'},
      {'heard': '帮我把账理一下', 'ask': '要不要按天分？', 'scene': 'do'},
      {'heard': '帮我把账理一下，按天分。', 'ask': '要发给谁吗？', 'scene': 'do'},
    ]);
    await b.c.toggleVoiceCompose();
    await _speak(b.mic, b.c, '帮我把账理一下');
    await _waitFor(() => b.c.voiceFlow.phase == DrillPhase.asking, '第一问');
    await b.c.answerVoiceCompose('上个月的');
    await _waitFor(() => b.c.voiceFlow.phase == DrillPhase.asking, '第二问');
    await b.c.answerVoiceCompose('要');
    await _waitFor(() => b.s.said.isNotEmpty, '到上限就发');
    expect(b.s.said.length, 1, reason: '★ 只发一次');
    expect(b.s.said.first, '帮我把账理一下，按天分。');
  });

  test('V6 🔴 按停**当场**有反应（不许等对面那一帧），而且字一个都不丢', () async {
    // 主人 2026-10-05：*"我们录音和停止录音上，点击停止录音响应很慢。"*
    //   量的是**按下去那一刻**的状态：原来它还是 `listening`（屏幕上照旧闪着"我在录"），
    //   要等 `asr/end` 回来才动 ⇒ 那一段就是"点了没反应"。
    final b = _boot([
      {'heard': '帮我查一下明天的天气', 'ask': null, 'scene': 'do'},
    ]);
    await b.c.toggleVoiceCompose();
    expect(b.c.voiceFlow.phase, DrillPhase.listening, reason: '起点：在听');
    b.mic.on?.call({'type': 'asr/final', 'text': '帮我查一下明天的天气'});

    // **按停这一下**（还没来任何一帧）
    await b.c.toggleVoiceCompose();
    expect(b.c.voiceFlow.phase, DrillPhase.wrapping,
        reason: '★ 按停当场就得换档 —— 屏幕上那一下"收下了，正在整理……"就是从这儿来的');

    // 再点一下**不许开第二场**（不然他刚说的那半句会被冲掉）
    await b.c.toggleVoiceCompose();
    expect(b.c.voiceFlow.phase, DrillPhase.wrapping, reason: '★ 收尾中再点也不许重开');

    // 对面最后那一份字到了 ⇒ 照旧往下走（**一个字都没丢**）
    b.mic.on?.call({'type': 'asr/end', 'text': '帮我查一下明天的天气', 'reason': 'upstream'});
    await _waitFor(() => b.s.said.isNotEmpty, '收尾之后照样发得出去');
    expect(b.s.said, ['帮我查一下明天的天气']);
    expect(b.c.voiceFlow.phase, DrillPhase.idle, reason: '这一场收干净');
  });

  test('V5 开麦失败 ⇒ 如实说、不发；打字那条兜底照样通', () async {
    final b = _boot([
      {'heard': '帮我查一下明天的天气', 'ask': null, 'scene': 'do'},
    ]);
    b.mic.failWith = 'denied';
    await b.c.toggleVoiceCompose();
    expect(b.c.voiceFlow.phase, DrillPhase.failed);
    expect(b.s.said, isEmpty, reason: '★ 开不了麦就一个字节都不许发');
    // 打字兜底：同一层、同一个去处
    await b.c.answerVoiceCompose('帮我查一下明天的天气');
    await _waitFor(() => b.s.said.isNotEmpty, '兜底那条也要发得出去');
    expect(b.s.said, ['帮我查一下明天的天气']);
  });
}
