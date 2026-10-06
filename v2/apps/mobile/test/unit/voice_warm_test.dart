// **"按下就通"：控制器那一侧把连接先热上**（2026-10-06 · 契约 `docs/dev/205-ASR-WARM.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 **进聊天那一屏就热一次**：`warmHear()` 真的把那条预热动作调出去，
//      而且带的是**同一个地址 ＋ 手里那份令牌**（与按下时那条一致）；
//   ② 🔴 **开不了麦的平台不许热**（`canHear == false` ⇒ 一次都不调）；
//      没令牌也不许调（拿着空令牌去连，等于每次进屏都白连一条）；
//   ③ **热身失败一声不响**（它只是"顺手先连上"，不许因为它弹错/打扰他）；
//   ④ 源码级：**聊天那一屏进来就调它**（`chat_screen.dart` 的 `initState`）——
//      "预热"这件事只有接上了才有用，而这一条是"接线在不在"的唯一自动证据。
//
// ⚠️ 量的是**控制器那一侧**（真 `ChatController` ＋ 假 api ＋ 注进去的假预热）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/hearing.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 假装"这台能开麦"（`canHear` 由平台那一份决定；VM 上是桩、恒假）。
class _FakeHook implements NativeHearingApi {
  @override
  bool get canHear => true;

  @override
  Future<String?> start({
    required Uri url,
    required String token,
    required void Function(Map<String, dynamic>) onEvent,
  }) async => null;

  @override
  void stop() {}

  @override
  Future<void> warm({required Uri url, required String token}) async {}
}

/// 装上/卸下那个假钩子（`canHear` 跟着它变）。
void _hearable(bool on) {
  if (on) {
    nativeHearingApi = _FakeHook();
  } else {
    clearNativeHearing();
  }
}

Api _api() => Api(
  base: '',
  client: MockClient((req) async {
    if (req.url.path == '/api/apps') {
      return http.Response('{"apps":[]}', 200, headers: {'content-type': 'application/json'});
    }
    return http.Response('', 404);
  }),
);

/// 记下每一次预热（地址 + 令牌）。
class _WarmLog {
  final List<({Uri url, String token})> calls = <({Uri url, String token})>[];
  bool throwOnWarm = false;

  Future<void> call({required Uri url, required String token}) async {
    calls.add((url: url, token: token));
    if (throwOnWarm) throw StateError('热身失败（判据演的那一档）');
  }
}

ChatController _boot(_WarmLog log, {String? token = '测试令牌'}) => ChatController(
  api: _api(),
  tokens: TokenStore(),
  token: token,
  startHear: ({required Uri url, required String token, required void Function(Map<String, dynamic>) onEvent}) async => null,
  stopHear: () {},
  warmHear: log.call,
  speak: (text, {onEnd}) => true,
  stop: () {},
);

void main() {
  test('★ 开不了麦的平台（VM 上是桩）⇒ 一次都不许热', () async {
    final log = _WarmLog();
    final c = _boot(log);
    // ⚠️ 判据里 `canHear` 由平台那一份决定：VM 上是桩（假）⇒ 这里直接把
    //    那条分支验掉（`canHear == false` 那一条住在下一个 case 里）。
    expect(c.canHear, false, reason: 'VM 上开不了麦（桩）—— 下一条判据量它；这一条量"能开麦"那一半');
    await c.warmHear();
    expect(log.calls, isEmpty, reason: '★ 开不了麦的平台一次都不许热（热了也没用）');
  });

  test('🔴 真能开麦 ⇒ 热一次：带的是**同一个地址 ＋ 手里那份令牌**（负向对照）', () async {
    final log = _WarmLog();
    final c = _boot(log);
    // 把 `canHear` 换成真：注一个"能开麦"的假钩子（与 `hearing_chat_test.dart` 同一条路）。
    _hearable(true);
    addTearDown(() => _hearable(false));
    await c.warmHear();
    expect(log.calls.length, 1, reason: '★ 能开麦就该热一次');
    expect(log.calls.single.token, '测试令牌', reason: '★ 用的是手里那份令牌');
    expect(log.calls.single.url.path, contains('/api/asr'), reason: '★ 热的就是语音那条连接');
  });

  test('★ 没令牌 ⇒ 不许热（拿着空令牌去连等于每次进屏白连一条）', () async {
    final log = _WarmLog();
    final c = _boot(log, token: null);
    _hearable(true);
    addTearDown(() => _hearable(false));
    await c.warmHear();
    expect(log.calls, isEmpty, reason: '没有令牌 ⇒ 不热（按下那一下会照旧如实说）');
  });

  test('★ 热身失败**一声不响**（不许抛出来打扰他）', () async {
    final log = _WarmLog()..throwOnWarm = true;
    final c = _boot(log);
    _hearable(true);
    addTearDown(() => _hearable(false));
    await c.warmHear(); // 不许抛
    expect(log.calls.length, 1);
  });

  test('★ 源码级：**聊天那一屏进来就调它**（不然"预热"没接上，等于没做）', () {
    final src = File('lib/screens/chat_screen.dart').readAsStringSync();
    expect(src.contains('warmHear()'), true,
        reason: '★ `chat_screen.dart` 里没有调用 `warmHear()` ⇒ 预热根本没接上（这一条就是"接线在不在"的判据）');
    final i = src.indexOf('void initState()');
    final j = src.indexOf('warmHear()');
    expect(i >= 0 && j > i, true, reason: '★ 那一次调用要住在 `initState` 里（进这一屏就热）');
  });
}
