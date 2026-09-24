// **「我自己那台」那条路的纯逻辑**（契约 `docs/dev/81-HARNESS-ENTRY.md` §5.2 / §5.4）。
//
// ── 这一份钉什么（都在客户端这一侧算得出来的地方）──────────────
//   ① **线上那三种消息**逐字：发 `say` / `stop`，收 `state` / `raw`（字段冻结，不许加）；
//   ② 🔴 **判据 H8**：14 种已知的 `session.event` **每种都有落点**，
//      而**未知的一个都不许藏** —— 必须画成「类型 + 一小段 JSON」；
//   ③ 🔴 **地址不许自己拼**：`harness_client.dart` 只能走 `harnessUri`（`ws://` 那个老
//      bug 的第三个入口，`docs/dev/16-STREAM.md`）；令牌用法和 `/api/stream` 一模一样。
//
// ⚠️ **纯逻辑**（不起网络、不 pump 界面）⇒ 进 `test/unit` 硬闸。
//    界面上那几种画法在 `test/widget/harness_test.dart`（提示档）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/harness.dart';

/// 一条 `session.event` 通知（**形状照 DSH 自己的协议**：`params.event.{type,data}`）。
Map<String, dynamic> ev(String type, [Object? data]) => {
  'jsonrpc': '2.0',
  'method': 'session.event',
  'params': {
    'sessionId': 's-1',
    'event': {'type': type, 'seq': 7, 'data': data ?? const <String, Object?>{}},
  },
};

/// 把注释剥掉（这一份里有几行注释正写着禁用/禁止那些字，不剥的话判据会自己判自己红）。
String stripComments(String src) => src
    .split('\n')
    .map((l) => l.contains('//') ? l.substring(0, l.indexOf('//')) : l)
    .join('\n');

void main() {
  // ── ① 线上那三种消息（字段冻结）────────────────────────────

  group('发出去的那两条（契约 §5.2）', () {
    test('say：逐字就是 {"t":"say","text":"…"}', () {
      expect(harnessSayFrame('在吗'), '{"t":"say","text":"在吗"}');
    });

    test('say：引号 / 反斜杠 / 换行都交给 JSON 编码（不许自己拼串）', () {
      expect(harnessSayFrame('他说"好"'), '{"t":"say","text":"他说\\"好\\""}');
      expect(harnessSayFrame('a\\b'), '{"t":"say","text":"a\\\\b"}');
      expect(harnessSayFrame('a\nb'), '{"t":"say","text":"a\\nb"}');
    });

    test('stop：逐字就是 {"t":"stop"}（没有别的字段）', () {
      expect(harnessStopFrame, '{"t":"stop"}');
    });
  });

  group('收回来那两种（契约 §5.2）', () {
    test('state：三种都认，why 只在给出来的时候带上', () {
      expect(
        harnessStatusOf({'t': 'state', 's': 'booting'})?.state,
        HarnessState.booting,
      );
      expect(harnessStatusOf({'t': 'state', 's': 'ready'})?.state, HarnessState.ready);
      final gone = harnessStatusOf({'t': 'state', 's': 'gone', 'why': '它那一台被收了'});
      expect(gone?.state, HarnessState.gone);
      expect(gone?.why, '它那一台被收了');
    });

    test('🔴 认不出来的 s / 不是 state / 解不开 ⇒ null（fail-closed，不许猜成某个状态）', () {
      expect(harnessStatusOf({'t': 'state', 's': 'sleeping'}), isNull);
      expect(harnessStatusOf({'t': 'raw', 'm': {}}), isNull);
      expect(harnessStatusOf('不是对象'), isNull);
      expect(harnessStatusOf(null), isNull);
      expect(harnessIncomingOf('这不是 json'), isNull);
      expect(harnessIncomingOf('{"t":"?"}'), isNull);
    });

    test('raw：m **原样**带过来（一个字段都不许动）', () {
      final raw = harnessIncomingOf('{"t":"raw","m":{"method":"x","params":{"a":1}}}');
      expect(raw, isA<HarnessRawIn>());
      final m = (raw as HarnessRawIn).m;
      expect(m, isA<Map>());
      expect((m as Map)['params'], {'a': 1});
    });
  });

  // ── ② H8：14 种已知事件 + 未知不许藏 ────────────────────────

  /// 契约 §5.4 点名的那 14 种（**这张表本身就是判据**：少一种就红）。
  const known = <String>[
    'turn/start',
    'step/start',
    'step/end',
    'turn/end',
    'system/message',
    'user/message',
    'assistant/message',
    'request/header',
    'request/context',
    'session/title',
    'permission/preset',
    'sandbox/mode',
    'approval/policy',
    'agent/inbox/spliced',
  ];

  /// 每一种给一份**照 DSH 类型声明**的样本 `data`。
  final samples = <String, Object?>{
    'turn/start': {'turn': 3},
    'step/start': {'turn': 3, 'step': 2},
    'step/end': {'turn': 3, 'step': 2},
    'turn/end': {
      'turn': 3,
      'reason': {'kind': 'completed'},
    },
    'system/message': {
      'turn': 3,
      'step': 1,
      'message': {
        'content': [
          {'type': 'text', 'text': '你是 DeepSeek Harness。'},
        ],
      },
    },
    'user/message': {
      'id': 'u1',
      'role': 'user',
      'content': [
        {'type': 'text', 'text': '用一句话告诉我今天是星期几'},
      ],
    },
    'assistant/message': {
      'turn': 3,
      'step': 1,
      'message': {
        'content': [
          {'type': 'reasoning', 'text': '他问的是星期几，我先看一眼日子。'},
          {'type': 'text', 'text': '今天是星期四。'},
        ],
      },
      'usage': {'inputTokens': 10},
    },
    'request/header': {
      'header': {
        'config': {'provider': 'p', 'model': 'm'},
        'tools': [
          {'name': 'a'},
          {'name': 'b'},
        ],
      },
      'reason': 'initial',
    },
    'request/context': {'provider': 'p', 'model': 'm', 'contextWindow': 128000},
    'session/title': {
      'title': '问今天是星期几',
      'messageSeqs': [1],
      'source': {'kind': 'provider'},
    },
    'permission/preset': {'preset': 'full'},
    'sandbox/mode': {'mode': 'danger-full-access'},
    'approval/policy': {'policy': 'never'},
    'agent/inbox/spliced': {
      'target': 'main',
      'start': 0,
      'inserted': [
        {'id': 'u2'},
        {'id': 'u3'},
      ],
    },
  };

  group('H8：14 种已知事件各有落点', () {
    test('★ 那张表就是契约里那 14 种（不多不少）', () {
      expect(known.toSet(), samples.keys.toSet());
      expect(known.length, 14);
    });

    for (final type in known) {
      test('$type ⇒ 有落点，而且**不算"没见过"**', () {
        final lines = harnessLinesOf(ev(type, samples[type]));
        expect(lines, isNotEmpty, reason: '$type 一个落点都没有');
        expect(
          lines.any((l) => l.kind == HarnessLineKind.unknown),
          false,
          reason: '$type 是已知的那 14 种之一，不该落到"没见过"那一档：$lines',
        );
      });
    }

    test('结构行：轮 / 步 / 完了（数字来自 data，不是编的）', () {
      expect(harnessLinesOf(ev('turn/start', samples['turn/start'])).single.text, contains('3'));
      expect(
        harnessLinesOf(ev('step/start', samples['step/start'])).single.kind,
        HarnessLineKind.step,
      );
      expect(
        harnessLinesOf(ev('step/end', samples['step/end'])).single.text,
        contains('2'),
      );
      expect(
        harnessLinesOf(ev('turn/end', samples['turn/end'])).single.text,
        contains('说完了'),
      );
    });

    test('文本事件：显示文本（用户 / 它 / 系统各一条，思考单独一种）', () {
      final user = harnessLinesOf(ev('user/message', samples['user/message'])).single;
      expect(user.kind, HarnessLineKind.user);
      expect(user.text, contains('用一句话告诉我今天是星期几'));

      final assistant = harnessLinesOf(ev('assistant/message', samples['assistant/message']));
      expect(assistant.length, 2, reason: '一块思考 + 一块文本');
      expect(assistant[0].kind, HarnessLineKind.think);
      expect(assistant[0].text, contains('先看一眼日子'));
      expect(assistant[1].kind, HarnessLineKind.text);
      expect(assistant[1].text, contains('今天是星期四。'));

      final system = harnessLinesOf(ev('system/message', samples['system/message'])).single;
      expect(system.kind, HarnessLineKind.system);
      expect(system.text, contains('你是 DeepSeek Harness。'));
    });

    test('🔴 request/header 只做摘要：**一个名字都不许抄上屏**', () {
      final line = harnessLinesOf(ev('request/header', samples['request/header'])).single;
      expect(line.kind, HarnessLineKind.folded);
      expect(line.text, contains('2'), reason: '件数要在上面');
      expect(line.text.contains('a'), false, reason: '★ 工具名一个都不许上屏');
      expect(line.text.contains('b'), false);
      expect(line.detail, isNull, reason: '摘要就是摘要 —— 不把那一串名字塞进 JSON');
    });

    test('🔴 一行说明那几个：给的是人话，**内部的取值一个都不许带上屏**', () {
      final sandbox = harnessLinesOf(ev('sandbox/mode', samples['sandbox/mode'])).single;
      expect(sandbox.text, contains('在哪儿动手'));
      expect(sandbox.text.contains('danger'), false, reason: '★ 模式取值不许上屏');
      expect(harnessLinesOf(ev('request/context', samples['request/context'])).single.text,
          isNot(contains('provider')));
      expect(harnessLinesOf(ev('permission/preset', samples['permission/preset'])).single.text,
          isNot(contains('preset')));
      expect(harnessLinesOf(ev('approval/policy', samples['approval/policy'])).single.text,
          isNot(contains('never')));
    });

    test('session/title：那一段的名字照抄给人看', () {
      final line = harnessLinesOf(ev('session/title', samples['session/title'])).single;
      expect(line.text, contains('问今天是星期几'));
    });

    test('agent/inbox/spliced：接进来几条要说出来', () {
      final line = harnessLinesOf(ev('agent/inbox/spliced', samples['agent/inbox/spliced'])).single;
      expect(line.text, contains('2'));
    });

    test('interrupted ⇒ 明说"这一条没说完"（不装没事）', () {
      final lines = harnessLinesOf(
        ev('assistant/message', {
          'turn': 1,
          'step': 1,
          'message': {
            'content': [
              {'type': 'text', 'text': '说到一半'},
            ],
          },
          'interrupted': true,
        }),
      );
      expect(lines.length, 2);
      expect(lines.last.text, contains('没说完'));
    });

    test('一条消息里一个能显示的字都没有 ⇒ 也不许藏（照上这一条的样子）', () {
      final lines = harnessLinesOf(
        ev('system/message', {
          'turn': 1,
          'step': 1,
          'message': {'content': <Object?>[]},
        }),
      );
      final line = lines.single;
      expect(line.kind, HarnessLineKind.note);
      expect(line.detail, isNotNull, reason: '★ 没有字也要把它长什么样摆出来');
    });
  });

  group('H8：🔴 未知的一律不许隐藏', () {
    test('★ 没见过的 session.event 类型 ⇒ 「类型 + 一小段 JSON」', () {
      final lines = harnessLinesOf(ev('todo/write', {'todos': [1, 2]}));
      final line = lines.single;
      expect(line.kind, HarnessLineKind.unknown, reason: '不许当成已知的某一种');
      expect(line.text, 'todo/write', reason: '★ 类型必须原样出现在屏幕上');
      expect(line.detail, isNotNull);
      expect(line.detail, contains('todos'), reason: '★ 那一小段 JSON 也要在');
    });

    test('★ 连类型都没有的（认不出的 JSON-RPC）⇒ 也不许返回空', () {
      for (final m in <Object?>[
        {'jsonrpc': '2.0', 'method': 'something/else', 'params': {'x': 1}},
        {'jsonrpc': '2.0', 'id': 1, 'result': {'serverInfo': {'name': 'n'}}},
        {'jsonrpc': '2.0'},
        '不是对象',
        null,
        42,
      ]) {
        final lines = harnessLinesOf(m);
        expect(lines, isNotEmpty, reason: '$m 被藏掉了');
      }
    });

    test('★ 负向对照：随手把一种已知类型改个名 ⇒ **必须落到"没见过"那一档**', () {
      final lines = harnessLinesOf(ev('turn/start2', samples['turn/start']));
      expect(lines.single.kind, HarnessLineKind.unknown);
      expect(lines.single.text, 'turn/start2');
    });

    test('回执（initialize 那种）⇒ 也不许藏（它应了一声 + 那一小段 JSON）', () {
      final line = harnessLinesOf({
        'jsonrpc': '2.0',
        'id': 1,
        'result': {
          'serverInfo': {'name': 'deepseek-harness-sdk-runtime', 'version': '0.0.1'},
        },
      }).single;
      expect(line.kind, HarnessLineKind.note);
      expect(line.detail, contains('serverInfo'));
    });

    test('没见过的**内容块**（不是 text/reasoning）⇒ 也不许吞掉', () {
      final lines = harnessLinesOf(
        ev('assistant/message', {
          'turn': 1,
          'step': 1,
          'message': {
            'content': [
              {'type': 'x-block', 'name': 'x-tool', 'arguments': '{}'},
            ],
          },
        }),
      );
      final line = lines.single;
      expect(line.kind, HarnessLineKind.unknown);
      expect(line.text, 'x-block');
      expect(line.detail, contains('x-tool'));
    });

    test('recognized session.status 画人话；认不出的取值仍落到"没见过"', () {
      final run = harnessLinesOf({
        'jsonrpc': '2.0',
        'method': 'session.status',
        'params': {'status': 'running'},
      }).single;
      expect(run.kind, HarnessLineKind.note);
      expect(run.text, contains('动手'));
      final idle = harnessLinesOf({
        'jsonrpc': '2.0',
        'method': 'session.status',
        'params': {'status': 'idle'},
      }).single;
      expect(idle.text, contains('停下'));

      final odd = harnessLinesOf({
        'jsonrpc': '2.0',
        'method': 'session.status',
        'params': {'status': '???'},
      }).single;
      expect(odd.kind, HarnessLineKind.unknown);
    });
  });

  group('那一小段 JSON', () {
    test('长了就截断，而且按 rune 截（不切半个字）', () {
      final long = {'x': List.filled(1000, '很').join()};
      final s = harnessSnippet(long);
      expect(s.length, lessThan(harnessSnippetMax + 20));
      expect(s.endsWith('…'), true);
    });

    test('短了就原样', () {
      expect(harnessSnippet({'a': 1}), '{"a":1}');
      expect(harnessSnippet(null), '');
    });
  });

  // ── ③ V13 那一族：地址与令牌的判据打在**客户端这一侧** ─────────

  group('🔴 传输实现：地址只许从 stream_uri 来（不许自己拼 ws://）', () {
    final src = stripComments(File('lib/services/harness_client.dart').readAsStringSync());

    test('用的是 harnessUri（和 /api/stream、/api/asr 同一个算地址的函数）', () {
      expect(
        src.contains('harnessUri('),
        true,
        reason: '★ 自己拼地址 = 那个老 bug 会有第三个入口（docs/dev/16-STREAM.md）',
      );
    });

    test('★ 这里一个明文 ws:// 都没有', () {
      expect(
        src.contains('ws://'),
        false,
        reason: '★ 在 https 页面上拼 ws:// 会被浏览器按混合内容拦掉',
      );
    });

    test('令牌用法与 /api/stream 一模一样：子协议 bearer，**不进 URL**', () {
      expect(
        RegExp(r"protocols:\s*\['bearer',\s*token\]").hasMatch(src),
        true,
        reason: '令牌只许走子协议（和 stream.dart 同一条规矩）',
      );
      expect(src.contains('/api/harness?token'), false);
    });

    test('★ 没有"太久没帧就当断了"的看门狗（终端安安静静待着是正常的）', () {
      expect(
        RegExp(r'pingTimeout|_armPingWatch').hasMatch(src),
        false,
        reason: '这一条协议**没有心跳消息** ⇒ 照搬 stream.dart 那个看门狗会把"它在想"当成"断了"',
      );
    });

    test('★ 也没有自动重连（契约 §5.4：断了就说一句 + 「重来」）', () {
      expect(
        RegExp(r'_scheduleRetry|Timer\(').hasMatch(src),
        false,
        reason: '一个终端会话被悄悄重开一台，不是"显示器 + 键盘"该做的事',
      );
    });
  });
}
