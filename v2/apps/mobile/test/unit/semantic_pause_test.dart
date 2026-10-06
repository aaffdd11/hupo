// **语义检查暂停了**（主人 2026-10-06：*「app对话响应很慢。我觉得我们现在先暂停语义检查。
//   不要检查语义，直接快速语音转文字，点击结束就发送。」*）。
//
// 这一份钉两档（**两档都要在**：主人说的是"先暂停" ⇒ 要能一句话开回来）：
//   ① 关着（现在的形状）：说完 ⇒ **手上那份字直接发** —— `/api/hear` **一次都不许调**；
//   ② 开着（老形状）：说完 ⇒ 走听懂那一层，**发出去的是它理顺过的那一份**
//      （两档的分别就落在"发的是哪一份字"上，所以这一条**必须**量 `/api/say` 的正文）。
//
// ⚠️ 不开真 socket、不碰真网：HTTP 用 `MockClient`，开麦用注进去的假 `startHear`。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/semantic_switch.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';

/// 一个记账的假服务端：数 `/api/hear` 调了几次、把 `/api/say` 的正文收下来。
class _Recorder {
  int hearCalls = 0;
  final List<String> said = <String>[];
  /// 听懂那一层"理顺"成什么（开着那一档要能看出差别）。
  String heard = '理顺之后的那一句';

  http.Client client() => MockClient((req) async {
    final path = req.url.path;
    if (path == '/api/hear') {
      hearCalls += 1;
      return http.Response(
        jsonEncode({'heard': heard, 'ask': null, 'fact': '', 'scene': 'chat'}),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    }
    if (path == '/api/say') {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      said.add((body['text'] as String?) ?? '');
      return http.Response(
        jsonEncode({'ok': true, 'duplicate': false, 'seq': said.length}),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    }
    return http.Response('{}', 200, headers: {'content-type': 'application/json'});
  });
}

/// 把这一场"说完"喂进控制器：拿到 `onEvent` 之后照真帧喂。
///
/// ⚠️ `onEvent` 是**假的开麦那条路**交出来的（生产那条由 `hearing_web/native` 拿着），
///    所以这里不用给生产代码开任何"调试口"。
Future<void> _speakAndEnd(
  ChatController c,
  String whole,
  void Function(Map<String, dynamic>) Function() feedOf,
) async {
  await c.toggleVoiceCompose(); // 按下那颗圆圈
  final feed = feedOf();
  feed({'type': 'asr/partial', 'text': whole.substring(0, 2), 'index': 0});
  feed({'type': 'asr/final', 'text': whole, 'index': 0});
  // 🔴 **2026-10-07 起：他按停才算说完**（主人：*「我的目的是语音输入。要连贯」*）——
  //   引擎到点/上游收一轮只是"接着开下一轮"，只有这一下才是"发出去"。
  await c.toggleVoiceCompose(); // 按停
  feed({'type': 'asr/end', 'text': whole, 'index': 0, 'reason': 'user-stop'});
  await Future<void>.delayed(const Duration(milliseconds: 30));
}

void main() {
  tearDown(() => semanticCheckOn = false); // 每一条之后都还原成"暂停"

  test('① 🔴 关着（现在）：说完 ⇒ 直接发那份原文，**`/api/hear` 一次都不许调**', () async {
    final rec = _Recorder();
    void Function(Map<String, dynamic>)? feed;
    final c = ChatController(
      api: Api(client: rec.client()),
      tokens: TokenStore(),
      token: 'tok',
      startHear: ({required url, required token, required onEvent}) async {
        feed = onEvent;
        return null; // 真开起来了
      },
      stopHear: () {},
    );
    addTearDown(c.dispose);

    await _speakAndEnd(c, '帮我做一个英语题的网站', () => feed!);

    expect(rec.hearCalls, 0, reason: '★ 说了"暂停语义检查"，却还是调了它');
    expect(rec.said, ['帮我做一个英语题的网站'], reason: '★ 发出去的不是那份直白的原文');
    expect(c.voiceSent, 1, reason: '★ 发出去之后那个号要 +1（界面据此把聊天记录窗口打开）');
  });

  test('①·补 🔴 **打字那条兜底**也一样：说不了话时打一句 ⇒ 直接发、不调 hear', () async {
    final rec = _Recorder();
    final c = ChatController(api: Api(client: rec.client()), tokens: TokenStore(), token: 'tok');
    addTearDown(c.dispose);

    await c.answerVoiceCompose('帮我做一个记账的小程序');
    await Future<void>.delayed(const Duration(milliseconds: 30));

    expect(rec.hearCalls, 0, reason: '★ 打字那条兜底也不该去问语义');
    expect(rec.said, ['帮我做一个记账的小程序'],
        reason: '★ 打的那句要**原样**发出去（第一版从 `hearing.text` 取字 ⇒ 一个字都没发出去）');
    expect(c.voiceSent, 1);
  });

  test('② 🔴 开着（老形状）：走听懂那一层，发出去的是**它理顺过的那一份**', () async {
    semanticCheckOn = true; // 临时开回来（验"还能开"）
    final rec = _Recorder()..heard = '帮我做一个英语题的网站。';
    void Function(Map<String, dynamic>)? feed;
    final c = ChatController(
      api: Api(client: rec.client()),
      tokens: TokenStore(),
      token: 'tok',
      startHear: ({required url, required token, required onEvent}) async {
        feed = onEvent;
        return null;
      },
      stopHear: () {},
    );
    addTearDown(c.dispose);

    await _speakAndEnd(c, '帮我做一个英语题的网沾', () => feed!);

    expect(rec.hearCalls, 1, reason: '★ 开着的时候该调那一次');
    expect(rec.said, ['帮我做一个英语题的网站。'],
        reason: '★ 开着那一档发的必须是**听懂之后**那份（否则两档就没分别了）');
  });
}
