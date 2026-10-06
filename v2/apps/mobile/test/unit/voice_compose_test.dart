// **语音那一档：stream 回来的字进那个真输入框 ⇒ 按停就发**（手册 `D3.14`／`D5.19`）。
//
// 🔴 **2026-10-07 晚：整套推倒重来**（主人：*"我认为，原本的语音转文字全套方案都应该推倒重来，
//   忘记我们要修正语义。我们就是 stream 回来的文字输入到文本框等待发送。"*
//   ＋ 他当天定的三样：**按停就发** · 字**直接流进那个能改的真输入框** ·
//     设置里那屏「说一句试试」删掉）。
//   ⇒ 原来那几族（语义那一层、"听懂/在问/最多两轮"、"演练状态机"）**整族删掉**；
//     这一份改成钉新链路上的四件事。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   V1 🔴 **字是边听边长在框里的**（半句也要看得见 —— 这就是"stream 回来"那件事）
//   V2 🔴 **按停就发**：只发一次，发的是**框里那份字**
//   V3 🔴 **他动手改过 ⇒ 语音不再往框里写**，发的是**他改的那份**
//   V4 **按停当场有反应**（收尾中那颗圆圈按不动），收尾中再点不算
//   V5 一个字都没听到 ⇒ **如实说一句**、不发
//   V6 开麦失败 ⇒ 如实说、**不发**；打字那条兜底照样走得通
//   V7 🔴 **第一次撞上死连接 ⇒ 自动再试一次**（主人报的「初次点击 failed，第二次就好」）
//   V8 真答案不重试（没权限 / 没配钥匙 / 开不了麦）· V9 最多试两次
//   V10 🔴 这一侧**一处都不调 `/api/hear`**，而且那一套东西的文件**都不在了**
//
// ⚠️ 这一层没有界面：判据量的是**控制器那一侧**（真 `ChatController` ＋ 假 api ＋ 假麦）。

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/voice_words.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 假的服务端：`/api/say` **记下来**；`/api/hear` **一次都不许来**（来了就记一笔）。
class _Server {
  final List<String> said = [];

  /// 🔴 那条"抽离层"的调用次数：**必须是 0**（`V7` 那一侧还要扫源码）。
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

  /// 老用法：**一直**失败。
  String? failWith;

  /// 按次序失败（先用队列；用完了就成功）—— 量"自动重试"要它。
  final List<String?> failQueue = <String?>[];

  /// 开过几次麦（＝ `startHear` 被调了几次）。
  int starts = 0;
}

({ChatController c, _Server s, _FakeHearing mic}) _boot() {
  final server = _Server();
  final mic = _FakeHearing();
  final c = ChatController(
    api: server.api,
    tokens: TokenStore(),
    token: '测试令牌',
    startHear: ({required Uri url, required String token, required void Function(Map<String, dynamic>) onEvent}) async {
      mic.starts += 1;
      if (mic.failQueue.isNotEmpty) {
        final w = mic.failQueue.removeAt(0);
        if (w != null) return w;
      } else if (mic.failWith != null) {
        return mic.failWith;
      }
      mic.on = onEvent;
      return null;
    },
    stopHear: () {},
    speak: (text, {onEnd}) => true,
    stop: () {},
  );
  return (c: c, s: server, mic: mic);
}

Future<void> _tick() => Future<void>.delayed(const Duration(milliseconds: 20));

void main() {
  test('V1 🔴 字是**边听边长在框里**的（半句也看得见）', () async {
    final b = _boot();
    await b.c.toggleVoiceCompose();
    await _tick();
    expect(b.c.voiceRecording, true, reason: '★ 按下去就该在听');
    expect(b.c.composeText, '', reason: '起点：框里一个字都没有');

    b.mic.on?.call({'type': 'asr/ready'});
    b.mic.on?.call({'type': 'asr/partial', 'text': '帮我查一下'});
    await _tick();
    expect(b.c.composeText, '帮我查一下', reason: '★ 半句就要**长在框里**（就是"stream 回来"那件事）');
    expect(b.s.said, isEmpty, reason: '★ 还在说 ⇒ 一个字节都不许发');

    b.mic.on?.call({'type': 'asr/final', 'text': '帮我查一下明天北京的天气'});
    await _tick();
    expect(b.c.composeText, '帮我查一下明天北京的天气', reason: '★ 定稿接在后面（不是把半句顶掉）');
  });

  test('V2 🔴 按停就发：**只发一次**，发的是框里那份字', () async {
    final b = _boot();
    await b.c.toggleVoiceCompose();
    await _tick();
    b.mic.on?.call({'type': 'asr/ready'});
    b.mic.on?.call({'type': 'asr/final', 'text': '帮我查一下明天北京的天气'});

    await b.c.toggleVoiceCompose(); // 按停
    await _tick();
    expect(b.c.voiceWrapping, true, reason: '★ 收尾中（等对面把最后那一份吐回来）');
    expect(b.s.said, isEmpty, reason: '★ 按停那一刻还不许发 —— 要等整段回来');

    b.mic.on?.call({'type': 'asr/end', 'text': '帮我查一下明天北京的天气', 'reason': 'user-stop'});
    await _tick();
    await _tick();
    expect(b.s.said, ['帮我查一下明天北京的天气'], reason: '★ 一个字都不许改（没有第二层了）');
    expect(b.s.hearCalls, 0, reason: '★ 那一层删了：一次都不许调');
    expect(b.c.voiceSent, 1, reason: '★ 界面据此把聊天记录窗口打开');
    expect(b.c.voiceRecording, false, reason: '这一场收干净');
    expect(b.c.composeText, '', reason: '发出去之后框里清干净');
  });

  test('V3 🔴 他动手改过 ⇒ 语音不再往框里写；发的是**他改的那份**', () async {
    // 主人要的是"文字输入到文本框" ⇒ 那个框是**真的能改**的。
    //   他一动手，这一格就归他（下一帧不许再把它顶掉）。
    final b = _boot();
    await b.c.toggleVoiceCompose();
    await _tick();
    b.mic.on?.call({'type': 'asr/ready'});
    b.mic.on?.call({'type': 'asr/partial', 'text': '明天北京天气怎么样'});
    await _tick();

    b.c.voiceEdited('明天上海天气怎么样'); // 他点进框里改了一个字
    await _tick();
    expect(b.c.composeText, '明天上海天气怎么样');

    // 🔴 语音那一条还在流：**不许再往框里写**（不许把他改的那份顶掉）
    b.mic.on?.call({'type': 'asr/final', 'text': '明天北京天气怎么样'});
    await _tick();
    expect(b.c.composeText, '明天上海天气怎么样', reason: '★ 他改过的字一个都不许被顶掉');

    await b.c.toggleVoiceCompose(); // 按停
    b.mic.on?.call({'type': 'asr/end', 'text': '明天北京天气怎么样', 'reason': 'user-stop'});
    await _tick();
    await _tick();
    expect(b.s.said, ['明天上海天气怎么样'], reason: '★ 发的是**他手上那份**（他改过的）');
  });

  test('V4 按停**当场**有反应，收尾中再点也不算', () async {
    // 主人 2026-10-05：*"我们录音和停止录音上，点击停止录音响应很慢。"*
    final b = _boot();
    await b.c.toggleVoiceCompose();
    await _tick();
    b.mic.on?.call({'type': 'asr/final', 'text': '帮我查一下明天的天气'});

    await b.c.toggleVoiceCompose(); // **按停这一下**（对面还没吐最后一帧）
    expect(b.c.voiceWrapping, true, reason: '★ 按停当场就得换档 —— 屏幕上那句"收下了…"就是从这儿来的');
    expect(b.c.composeText, '帮我查一下明天的天气', reason: '★ 已经听到的字留着');
    await b.c.toggleVoiceCompose(); // 再点一下
    expect(b.c.voiceWrapping, true, reason: '★ 收尾中再点也不许重开');
    expect(b.s.said, isEmpty);

    // 对面最后那一份字到了 ⇒ 照旧发（**一个字都没丢**）
    b.mic.on?.call({'type': 'asr/end', 'text': '帮我查一下明天的天气', 'reason': 'upstream'});
    await _tick();
    await _tick();
    expect(b.s.said, ['帮我查一下明天的天气']);
  });

  test('V5 一个字都没听到 ⇒ **如实说一句**，一个字节都不发', () async {
    final b = _boot();
    await b.c.toggleVoiceCompose();
    await _tick();
    await b.c.toggleVoiceCompose(); // 按停
    b.mic.on?.call({'type': 'asr/end', 'text': '', 'reason': 'user-stop'});
    await _tick();
    await _tick();
    expect(b.s.said, isEmpty, reason: '★ 不装发过');
    expect(b.c.voiceNote, voiceFailedLead, reason: '★ 如实说一句（那句数据源只有一处）');
    expect(b.c.voiceRecording, false);
  });

  test('V6 开麦失败 ⇒ 如实说、不发；打字那条兜底照样通', () async {
    final b = _boot();
    b.mic.failWith = 'denied';
    await b.c.toggleVoiceCompose();
    await _tick();
    expect(b.c.voiceNote, '麦克风没给权限，先允许一下。', reason: '★ 机器原因翻成人话');
    expect(b.c.voiceRecording, false);
    expect(b.s.said, isEmpty, reason: '★ 开不了麦就一个字节都不许发');

    // 打字那条兜底：同一个落点（`sendComposeLine`）
    await b.c.sendComposeLine('帮我查一下明天的天气');
    await _tick();
    expect(b.s.said, ['帮我查一下明天的天气']);
    expect(b.s.hearCalls, 0);
  });

  test('V7 🔴 第一次撞上死连接 ⇒ **同一个按键里自动再试一次**（不用他再按第二下）', () async {
    // 🔴 主人 2026-10-07：*"初次点击会出现 failed。第二次再点击就好了。"*
    //   第一次多半死在**那条预先热着的连接**上（它可能已经被对面收掉/没握上手：
    //   真读数 —— 拿租户的令牌去握，对面回的是 503）⇒ 那一条**既不响也不报错**。
    final b = _boot();
    b.mic.failQueue.add('no-entry'); // 第一次：那条热的已经死了
    await b.c.toggleVoiceCompose();
    await _tick();
    await _tick();
    expect(b.mic.starts, 2, reason: '★ 必须**自己**再试一次（这就是"第二次就好了"那一下）');
    expect(b.c.voiceRecording, true, reason: '★ 第二次开起来了 ⇒ 还在听');
    expect(b.c.voiceNote, '', reason: '★ 中间那一次失败**不许**报给他（他什么都没做错）');

    // 第二次真的能收字、能发
    b.mic.on?.call({'type': 'asr/ready'});
    b.mic.on?.call({'type': 'asr/final', 'text': '今天天气怎么样'});
    await _tick();
    expect(b.c.composeText, '今天天气怎么样');
    await b.c.toggleVoiceCompose();
    b.mic.on?.call({'type': 'asr/end', 'text': '今天天气怎么样', 'reason': 'user-stop'});
    await _tick();
    await _tick();
    expect(b.s.said, ['今天天气怎么样']);
  });

  test('V8 **真答案不重试**：没给权限 / 没配钥匙 / 开不了麦 ⇒ 只试一次、如实说', () async {
    expect(voiceWhyRetryable('no-entry'), isTrue);
    expect(voiceWhyRetryable('failed'), isTrue);
    for (final why in ['denied', 'not-configured', 'unsupported']) {
      expect(voiceWhyRetryable(why), isFalse, reason: '★ $why 是真答案，重试一万次也一样');
      final b = _boot();
      b.mic.failQueue.add(why);
      await b.c.toggleVoiceCompose();
      await _tick();
      await _tick();
      expect(b.mic.starts, 1, reason: '★ $why 不该重试');
      expect(b.c.voiceNote.isNotEmpty, isTrue, reason: '★ 要如实说一句');
      expect(b.c.voiceRecording, false);
    }
  });

  test('V9 重试也失败 ⇒ 如实说一次（**最多试两次**，不许一直试）', () async {
    final b = _boot();
    b.mic.failQueue..add('no-entry')..add('failed');
    await b.c.toggleVoiceCompose();
    await _tick();
    await _tick();
    expect(b.mic.starts, 2, reason: '★ 一次重试，不许更多');
    expect(b.c.voiceNote, '麦没打开，等下再试。');
    expect(b.c.voiceRecording, false);
  });

  test('V10 🔴 这一侧**一处都不调那条抽离层**，而且它的文件都不在了', () {
    // ⚠️ 量的是"代码里还在不在"，不是"开关关没关"：主人要的是**推倒重来**。
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
    for (final gone in [
      'lib/models/semantic_switch.dart', // 那个"先暂停"的开关
      'lib/models/hear_drill.dart', // 那台演练状态机
      'lib/models/hear_words.dart', // 那一屏的话
      'lib/screens/hear_drill_screen.dart', // 那一屏本身
    ]) {
      expect(File(gone).existsSync(), isFalse, reason: '★ 推倒重来之后这个不该还在：$gone');
    }
  });
}
