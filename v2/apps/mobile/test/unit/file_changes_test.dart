// **"这一窗动过哪些文件"**（`lib/models/file_changes.dart` ·
// 契约 `docs/dev/120-FILE-PANEL.md`）。
//
// ⚠️ 这一份的每一条**都有反例**（派活单点名）：
//   · 路径只从入参 **JSON** 里取 ⇒ 坏 JSON / 不是对象 / 空串 / 没有那个键 ⇒ **不贡献**；
//   · 名字不在改动类名单里（`read` / `bash` / 未知）⇒ **一行都不加**
//     （"看过"不是"改过"，`bash` 改名我们也看不见 —— 那是如实，不是漏）；
//   · **坏输入绝不抛**（这一份的输入来自服务端，可能是任何东西）；
//   · 去重是**同轮、按路径、留第一次**（跨轮**不合并**）；
//   · 顺序是**第一次见到的顺序**（不是按轮号排、不是按字母排）；
//   · 数得出来的只有"轮数"与"逐轮相加的处数" —— **没有"改了多少行"**。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/file_changes.dart';
import 'package:hupo_app/models/tool_row.dart';

/// 造一行工具调用（`args` / `name` / `turn` / `step` 是要验的那几格）。
ToolRow row({
  String name = 'write',
  String? args = '{"path":"/tmp/a.txt"}',
  int turn = 1,
  int step = 1,
  String? callId,
}) =>
    ToolRow.parse(
      {
        'type': 'tool/call',
        'turn': turn,
        'step': step,
        'callId': callId ?? 'c_${name}_$turn$step',
        'name': name,
        'args': args,
      },
      null,
    )!;

/// 抽一次（省字）。
FileChanges of(List<ToolRow> rows) => FileChanges.of(rows);

void main() {
  group('pathFromArgs：路径只从入参 JSON 里取', () {
    test('★ 正例：`path` 与 `file_path` 都认（`path` 优先）', () {
      expect(pathFromArgs('{"path":"/w/a.txt"}'), '/w/a.txt');
      expect(pathFromArgs('{"file_path":"/w/b.txt"}'), '/w/b.txt');
      expect(
        pathFromArgs('{"path":"/w/a.txt","file_path":"/w/b.txt"}'),
        '/w/a.txt',
        reason: '两个都在 ⇒ 认 `path`（[dshFileArgKeys] 的顺序就是优先级）',
      );
    });

    test('★ 负例：坏 JSON / 半截 JSON / 不是对象 / 没有那个键 ⇒ `null`', () {
      expect(pathFromArgs('{oops'), isNull, reason: '解不出来的 JSON');
      expect(pathFromArgs('{"path":"/w/a.txt"'), isNull, reason: '服务端截断过的半截 JSON');
      expect(pathFromArgs('[]'), isNull, reason: '数组不是"一张参数表"');
      expect(pathFromArgs('[{"path":"/w/a.txt"}]'), isNull);
      expect(pathFromArgs('42'), isNull);
      expect(pathFromArgs('"{\\"path\\":\\"/w/a.txt\\"}"'), isNull, reason: '字符串不是对象');
      expect(pathFromArgs('{"cmd":"ls"}'), isNull, reason: '没有路径那个键');
      expect(pathFromArgs('null'), isNull);
      expect(pathFromArgs(''), isNull);
      expect(pathFromArgs('   '), isNull);
      expect(pathFromArgs(null), isNull);
    });

    test('★ 负例：路径那一格不是非空串 ⇒ `null`（空的继续看下一个键）', () {
      expect(pathFromArgs('{"path":""}'), isNull);
      expect(pathFromArgs('{"path":"   "}'), isNull, reason: '纯空白不是路径');
      expect(pathFromArgs('{"path":12}'), isNull);
      expect(pathFromArgs('{"path":null}'), isNull);
      expect(pathFromArgs('{"path":["/w/a.txt"]}'), isNull);
      expect(
        pathFromArgs('{"path":"","file_path":"/w/b.txt"}'),
        '/w/b.txt',
        reason: '前面那个在、但是空的 ⇒ 继续看 `file_path`（不是"放弃"）',
      );
      expect(
        pathFromArgs('{"path":7,"file_path":"/w/b.txt"}'),
        '/w/b.txt',
        reason: '前面那个类型不对 ⇒ 继续看后面的',
      );
    });

    test('值只去首尾空白；**不拼、不规范、不猜**', () {
      expect(pathFromArgs('{"path":"  /w/a.txt  "}'), '/w/a.txt');
      expect(
        pathFromArgs('{"path":"src/../a.txt"}'),
        'src/../a.txt',
        reason: '原样（规范化一次就是编一个路径）',
      );
      expect(pathFromArgs('{"path":"a\\nb.txt"}'), 'a\nb.txt');
    });
  });

  group('isFileBearingTool：只认改动类那几件', () {
    test('★ 正例：写类四件都在名单里', () {
      for (final n in dshFileWritingTools) {
        expect(isFileBearingTool(n), isTrue, reason: '$n 必须在名单里');
      }
      expect(isFileBearingTool('str_replace_editor'), isTrue);
    });

    test('★ 负例：读 / 跑命令 / 未知 / 大小写不同 / 空名 ⇒ 都不算', () {
      expect(isFileBearingTool('read'), isFalse, reason: '"看过"不是"改过"');
      expect(isFileBearingTool('bash'), isFalse);
      expect(isFileBearingTool('grep'), isFalse);
      expect(isFileBearingTool('glob'), isFalse);
      expect(isFileBearingTool('Write'), isFalse, reason: '大小写不同不是同一个名字');
      expect(isFileBearingTool('write_file'), isFalse, reason: '不写通配（通配会把将来的只读工具算进来）');
      expect(isFileBearingTool(''), isFalse);
    });
  });

  group('FileChanges.of：分组、去重、顺序', () {
    test('★ 正例：一轮里两个文件 ⇒ 一行一个，顺序 = 第一次见到的顺序', () {
      final c = of([
        row(args: '{"path":"/w/b.txt"}', step: 1),
        row(args: '{"path":"/w/a.txt"}', step: 2),
      ]);
      expect(c.totalTurns, 1);
      expect(c.turns.single.turn, 1);
      expect(
        c.turns.single.files.map((f) => f.path),
        ['/w/b.txt', '/w/a.txt'],
        reason: '**不是**按字母排（`a` 在 `b` 后面进来 ⇒ 它就排在后面）',
      );
      expect(c.totalFiles, 2);
    });

    test('★ 正例：同一轮同一个路径重复 ⇒ 只留一条，`tools` 并起来、`step` 是第一次那一步', () {
      final c = of([
        row(name: 'write', args: '{"path":"/w/a.txt"}', step: 3),
        row(name: 'edit', args: '{"file_path":"/w/a.txt"}', step: 5),
      ]);
      expect(c.totalFiles, 1, reason: '同一轮同一个文件只算一处');
      final f = c.turns.single.files.single;
      expect(f.step, 3, reason: '留**第一次**那一步');
      expect(f.tools, ['write', 'edit'], reason: '改过两次这件事要留着（并名字）');
    });

    test('★ 正例：重复的名字不重复列（`write` 两次还是 `write`）', () {
      final c = of([
        row(name: 'write', args: '{"path":"/w/a.txt"}', step: 1),
        row(name: 'write', args: '{"path":"/w/a.txt"}', step: 2),
      ]);
      expect(c.turns.single.files.single.tools, ['write']);
    });

    test('★ 正例：**跨轮不合并**（同一轮里去过重，另一轮再改一次是另一条）', () {
      final c = of([
        row(turn: 1, args: '{"path":"/w/a.txt"}'),
        row(turn: 2, args: '{"path":"/w/a.txt"}'),
      ]);
      expect(c.totalTurns, 2);
      expect(c.totalFiles, 2, reason: '"这一轮动过它"是每一轮各自的事实');
      expect(c.turns.map((t) => t.turn), [1, 2]);
    });

    test('★ 正例：分组是**按轮**的，轮顺序 = 第一次见到的顺序（不是按号排）', () {
      final c = of([
        row(turn: 3, args: '{"path":"/w/c.txt"}'),
        row(turn: 1, args: '{"path":"/w/a.txt"}'),
        row(turn: 3, args: '{"path":"/w/d.txt"}', step: 2),
        row(turn: 2, args: '{"path":"/w/b.txt"}'),
      ]);
      expect(c.turns.map((t) => t.turn), [3, 1, 2]);
      expect(c.turns[0].files.map((f) => f.path), ['/w/c.txt', '/w/d.txt']);
      expect(c.totalTurns, 3);
      expect(c.totalFiles, 4);
      expect(c.toolRows, 4);
    });

    test('★ 负例：坏 JSON / 没有路径 / 空路径 ⇒ **那一行什么也不贡献**', () {
      final c = of([
        row(args: '{oops'),
        row(args: '{"cmd":"ls"}'),
        row(args: '{"path":""}'),
        row(args: null),
        row(args: '{"path":12}'),
      ]);
      expect(c.isEmpty, isTrue, reason: '一条都不该有（不是"未知文件"那一行）');
      expect(c.totalFiles, 0);
      expect(c.toolRows, 5, reason: '看过几行照实记着（这一格不上屏，只给判据）');
    });

    test('★ 负例：读 / 跑命令 / 未知 ⇒ 一行都不加', () {
      final c = of([
        row(name: 'read', args: '{"file_path":"/w/a.txt"}'),
        row(name: 'bash', args: '{"command":"echo x > /w/a.txt"}'),
        row(name: 'grep', args: '{"pattern":"x","path":"/w"}'),
        row(name: 'wat', args: '{"path":"/w/a.txt"}'),
      ]);
      expect(c.isEmpty, isTrue, reason: '都不是"改动类"那四件');
      expect(c.toolRows, 4);
    });

    test('★ 负例：**名字那一格空着的行**（`name` 认不出来）根本进不了这一层', () {
      // `ToolRow.parse` 要求 `name` 是非空串 ⇒ 空名那一档连 `ToolRow` 都造不出来
      // （`ToolRow.parseResultOnly` 那一档则**没有入参** ⇒ 也贡献不了）。
      // 这两条都不是"漏"，是**没有身份就没有这一行**（N10）。
      expect(
        ToolRow.parse({
          'type': 'tool/call',
          'turn': 1,
          'step': 1,
          'callId': 'c1',
          'name': '',
          'args': '{"path":"/w/a.txt"}',
        }, null),
        isNull,
      );
      final orphan = ToolRow.parseResultOnly({
        'type': 'tool/result',
        'turn': 1,
        'step': 1,
        'callId': 'c9',
        'ok': true,
        'bytes': 3,
      })!;
      expect(orphan.name, isEmpty);
      expect(of([orphan]).isEmpty, isTrue, reason: '没有名字、也没有入参 ⇒ 什么也不贡献');
    });

    test('★ 负例：名字对、但入参被截断了（JSON 解不出来）⇒ 也不贡献', () {
      final c = of([
        row(name: 'write', args: '{"path":"/w/a.txt","content":"写了一半'),
      ]);
      expect(c.isEmpty, isTrue, reason: '解不出来就**不许猜**：半截 JSON 里那个路径不算数');
    });

    test('★ 空输入 ⇒ 空（不是抛）', () {
      expect(FileChanges.of(const <ToolRow>[]).isEmpty, isTrue);
      expect(FileChanges.empty.isEmpty, isTrue);
      expect(FileChanges.empty.totalFiles, 0);
      expect(FileChanges.empty.totalTurns, 0);
    });

    test('★ 那一行存的是**第一次那一次调用本身**（展开看到的入参就是它）', () {
      final first = row(name: 'write', args: '{"path":"/w/a.txt","content":"哈"}', step: 1);
      final c = of([
        first,
        row(name: 'edit', args: '{"file_path":"/w/a.txt"}', step: 2),
      ]);
      expect(identical(c.turns.single.files.single.row, first), isTrue);
      expect(c.turns.single.files.single.row.args, '{"path":"/w/a.txt","content":"哈"}');
    });

    test('★ `running`：还没有结果 ⇒ true；有结果（成/败/停）⇒ false', () {
      final running = of([row(args: '{"path":"/w/a.txt"}')]).allChanges.single;
      expect(running.running, isTrue);

      for (final (ok, error) in [(true, null), (false, null), (false, 'interrupted')]) {
        final r = ToolRow.parse(
          {
            'type': 'tool/call',
            'turn': 1,
            'step': 1,
            'callId': 'c1',
            'name': 'write',
            'args': '{"path":"/w/a.txt"}',
          },
          {
            'type': 'tool/result',
            'turn': 1,
            'step': 1,
            'callId': 'c1',
            'ok': ok,
            'error': error,
            'bytes': 3,
          },
        )!;
        expect(of([r]).allChanges.single.running, isFalse, reason: '有结果了就不是"在跑"');
      }
    });

    test('★ `allChanges` 是摊平的（逐轮接着来）', () {
      final c = of([
        row(turn: 1, args: '{"path":"/w/a.txt"}'),
        row(turn: 2, args: '{"path":"/w/b.txt"}'),
      ]);
      expect(c.allChanges.map((f) => f.path), ['/w/a.txt', '/w/b.txt']);
    });
  });
}
