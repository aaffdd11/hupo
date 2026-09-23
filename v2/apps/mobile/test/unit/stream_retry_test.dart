// **`stream.dart` 的两条本体行为**（P1-10，2026-09-24）· 契约 `docs/dev/16-STREAM.md`（B1 / R5）
//
// 以前这两条只有集成测试覆盖（要真服务端 + 真令牌）。现在给 `StreamClient` 加了一个
// **可注入的探针**（"令牌还行不行"那一问），于是：
//   · **B1**：探针说 401 ⇒ 必须**停下**（`unauthorized`），**不许**无限重连；
//   · **R5**：续传游标必须**真的带上**（`sinceSeq: _sinceSeq`），重连时不许丢。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/conn_state.dart';
import 'package:hupo_app/models/retry.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/stream.dart';

StreamClient client(Future<TokenProbe> Function(String) probe) => StreamClient(
  base: '',
  token: 'tok',
  // 指向一个一定连不上的地址：这样一定会走 `_onFailed`（也就是探针那条路）
  api: Api(base: 'http://127.0.0.1:1'),
  probe: probe,
);

void main() {
  test('★ P1-10（B1）：探针说 401 ⇒ 停下（unauthorized），而且**不再重连**', () async {
    final seen = <ConnState>[];
    final c = client((_) async => TokenProbe.unauthorized);
    c.states.listen(seen.add);
    c.open();
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(seen.contains(ConnState.unauthorized), isTrue, reason: '401 要如实报到界面上（B1）');
    // 负向对照：报到 unauthorized 之后**不许**再出现"重连中"
    final i = seen.indexOf(ConnState.unauthorized);
    expect(
      seen.skip(i + 1).any((s) => s == ConnState.reconnecting),
      isFalse,
      reason: '401 之后还在重连 ⇒ 就是 B1 那个"永远转圈"的毛病',
    );
    c.dispose();
  });

  test('★ P1-10（B1 的正向对照）：探针说 OK ⇒ 会退避重连（不是停下）', () async {
    final seen = <ConnState>[];
    final c = client((_) async => TokenProbe.ok);
    c.states.listen(seen.add);
    c.open();
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(seen.contains(ConnState.unauthorized), isFalse, reason: '网通、令牌也好 ⇒ 不该说令牌不行');
    expect(
      seen.any((s) => s == ConnState.reconnecting || s == ConnState.connecting),
      isTrue,
      reason: '该走"退避重连"那条路',
    );
    c.dispose();
  });

  test('★ P1-10（R5）：续传游标要真的带上（重连不许丢）', () {
    final src = File('lib/services/stream.dart').readAsStringSync();
    expect(
      RegExp(r'streamUri\([^)]*sinceSeq:\s*_sinceSeq').hasMatch(src),
      isTrue,
      reason: 'reconnect 时把游标写成 0 ⇒ 会重放整段历史（协议 R5）',
    );
    // 而且收到更大的号要**推进**游标（不然下次重连还是从老地方补）
    expect(RegExp(r'_sinceSeq\s*=\s*m').hasMatch(src), isTrue, reason: '收到帧要推进游标');
    // 退避那一档是纯函数（P1-10 上半），顺手确认它没被改回写死的算式
    expect(src.contains('retrySeconds('), isTrue, reason: '退避要用 models/retry.dart 那一档');
    expect(retrySeconds(4), 8);
  });
}
