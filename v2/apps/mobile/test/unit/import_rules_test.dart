// **楼层闸** —— 手册 `03-DEVELOPMENT.md` §2.3（三条禁令）· §2.4（**怎么强制**）·
// `04-ROADMAP.md` 批 1.5 第 4 件 · 风险 **H7**。
//
// ⚠️ **这一条闸存在的理由，那一节自己写着**：
//
//     `analysis_options.yaml` 是 `flutter_lints` 模板，**加不了 import 禁令**
//     —— 写在文档里就是**没有闸**。
//     …这是"禁令有约束力"与"禁令只是口号"的**唯一区别**。
//
// ⇒ 只拆纯函数、不补楼层闸 = **拆完了但禁令仍然没人守**（H7），
//   下一个人再违反一次，而且**没有任何东西会响**。所以这一条是**硬闸**。
//
// 它读 `lib/` 下的源文件、按目录断言 **import 方向**（纯 Dart，不用 pump、不开浏览器）。
//
// v2 的楼层（`lib/` 下就这四层 + 入口）：
//
//     models/    纯逻辑，**不许碰 UI、不许碰 I/O**（所以它才能进 test/unit）
//     services/  传输与状态，**不许碰屏幕**
//     widgets/   傻组件，**只看 models**（面板/页面归 screens）
//     screens/   装配层，什么都行
//
// ⚠️ 这一条**不是"描述现状"，是"钉住方向"**：现状今天是对的，
//    而"今天对"正是最容易在某次图省事里被破坏的东西。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 楼层。
const layers = ['models', 'services', 'widgets', 'screens'];

/// 每一层**允许**指向哪一层。
///
/// * `models` 只许 `models` + `foundation`（下面那张禁令表再把 `material` 掐掉）
/// * `services` 不许碰 `screens` / `widgets`
/// * `widgets` 不许碰 `services` / `screens`
/// * `screens` 是装配层，随便
const allowedTargets = <String, Set<String>>{
  'models': {'models', 'flutter'},
  'services': {'models', 'services', 'pkg', 'flutter'},
  'widgets': {'models', 'widgets', 'pkg', 'flutter'},
  'screens': {'models', 'services', 'widgets', 'screens', 'pkg', 'flutter'},
  'main': {'models', 'services', 'widgets', 'screens', 'main', 'pkg', 'flutter'},
};

/// 每一层**点名不许**的包（手册 §2.3 第 1 条 + "models 是纯逻辑"）。
const forbiddenPrefixesIn = <String, List<String>>{
  'models': [
    'package:flutter/material.dart',
    'package:flutter/widgets.dart',
    'package:flutter/cupertino.dart',
    'package:http/', // 不许做 I/O
    'package:web_socket_channel/',
    'package:shared_preferences/',
    'dart:io',
  ],
};

/// 一个源文件里的 import 目标（**只看 import 行**，注释不算）。
List<String> importsOf(String source) {
  final re = RegExp(r'''^\s*import\s+['"]([^'"]+)['"]''', multiLine: true);
  return re.allMatches(source).map((m) => m.group(1)!).toList();
}

/// `lib/...` 的路径属于哪一层。⚠️ **认不出来的目录 = 一层新楼层 ⇒ 默认什么都不能指向**
/// （fail-closed：加目录的人必须回来把那一行补进 [allowedTargets]）。
String layerOf(String path) {
  final p = path.replaceAll('\\', '/');
  final rest = p.startsWith('lib/') ? p.substring(4) : p;
  final head = rest.split('/').first;
  if (rest.contains('/') && layers.contains(head)) return head;
  return rest.contains('/') ? head : 'main';
}

/// 一条 import 指向哪一层；`dart:` 返回 `null`（不管），第三方包返回 `pkg`。
String? targetLayerOf({required String fromPath, required String uri}) {
  if (uri.startsWith('dart:')) return null;
  if (uri.startsWith('package:flutter/')) return 'flutter';
  if (uri.startsWith('package:')) {
    final pkg = uri.substring('package:'.length);
    // 我们自己的包按路径算层
    if (pkg.startsWith('hupo_app/')) {
      final inner = pkg.substring('hupo_app/'.length);
      if (!inner.contains('/')) return 'main';
      return inner.split('/').first;
    }
    return 'pkg';
  }
  return layerOf(_resolve(fromPath: fromPath, rel: uri));
}

/// 把相对路径按**文件所在目录**折算成 `lib/...`。
String _resolve({required String fromPath, required String rel}) {
  final parts = fromPath.replaceAll('\\', '/').split('/')..removeLast();
  for (final seg in rel.split('/')) {
    if (seg.isEmpty || seg == '.') continue;
    if (seg == '..') {
      if (parts.isNotEmpty) parts.removeLast();
    } else {
      parts.add(seg);
    }
  }
  return parts.join('/');
}

/// 扫一遍，返回所有违规（空 = 干净）。
List<String> violationsOf(Map<String, String> files) {
  final out = <String>[];
  files.forEach((path, src) {
    final from = layerOf(path);
    final allowed = allowedTargets[from] ?? const <String>{};
    for (final uri in importsOf(src)) {
      for (final bad in forbiddenPrefixesIn[from] ?? const <String>[]) {
        if (uri == bad || uri.startsWith(bad)) {
          out.add('$path 不许 import $uri（$from 层点名禁 $bad）');
        }
      }
      final target = targetLayerOf(fromPath: path, uri: uri);
      if (target == null) continue;
      if (!allowed.contains(target)) {
        out.add('$path → $uri（$from 层不许指向 $target 层）');
      }
    }
  });
  return out;
}

/// 真树：`lib/` 下所有 `.dart`。
Map<String, String> readLib() {
  final out = <String, String>{};
  for (final e in Directory('lib').listSync(recursive: true)) {
    if (e is File && e.path.endsWith('.dart')) {
      out[e.path.replaceAll('\\', '/')] = e.readAsStringSync();
    }
  }
  return out;
}

void main() {
  group('楼层闸', () {
    test('🔴 真的那棵树：一条违规都不许有', () {
      final files = readLib();
      // ⚠️ 负向对照 ①：**扫到 0 个文件也能"全过"**，所以先把范围钉住
      expect(files.length, greaterThanOrEqualTo(15), reason: '扫到的文件太少，闸可能是空的');
      for (final l in layers) {
        expect(
          files.keys.where((k) => k.startsWith('lib/$l/')),
          isNotEmpty,
          reason: '$l 层一个文件都没扫到——楼层闸就白设了',
        );
      }
      final bad = violationsOf(files);
      expect(bad, isEmpty, reason: 'import 方向违规：\n${bad.join('\n')}');
    });

    test('🔴 负向对照 ②：**这些违规它必须抓得住**', () {
      // 每一条都对应一个"下一个人真的会那么写"的省事法
      final cases = <String, Map<String, String>>{
        'models 碰 UI': {
          'lib/models/x.dart': "import 'package:flutter/material.dart';\n",
        },
        'models 做 I/O': {
          'lib/models/x.dart': "import 'package:http/http.dart' as http;\n",
        },
        'models 直接调服务': {
          'lib/models/x.dart': "import '../services/api.dart';\n",
        },
        'services 碰屏幕': {
          'lib/services/x.dart': "import '../screens/chat_screen.dart';\n",
        },
        'widgets 绕过 controller': {
          'lib/widgets/x.dart': "import '../services/stream.dart';\n",
        },
        'widgets 碰屏幕': {
          'lib/widgets/x.dart': "import '../screens/chat_screen.dart';\n",
        },
      };
      cases.forEach((name, files) {
        expect(violationsOf(files), isNotEmpty, reason: '这条没抓住：$name');
      });
    });

    test('干净的样子不许误报（不然闸会被绕过）', () {
      final ok = <String, String>{
        'lib/models/a.dart': "import 'b.dart';\n",
        'lib/services/s.dart': "import '../models/a.dart';\nimport 'package:http/http.dart' as http;\n",
        'lib/widgets/w.dart': "import '../models/a.dart';\nimport 'package:flutter/material.dart';\n",
        'lib/screens/p.dart': "import '../services/s.dart';\nimport '../widgets/w.dart';\nimport 'about_screen.dart';\n",
      };
      expect(violationsOf(ok), isEmpty);
    });

    test('注释里的 import 不算（它只是字）', () {
      expect(importsOf("// import 'package:flutter/material.dart';\n"), isEmpty);
      expect(importsOf("  import 'a.dart' as x show y;\n"), ['a.dart']);
    });

    test('🔴 新加一个目录 = 新楼层 ⇒ **默认什么都不能指向**（fail-closed）', () {
      // ⚠️ 这条刻意的：新楼层必须回来把 allowedTargets 补上，
      //    否则它会**悄悄继承最宽松的规矩**——那正是禁令烂掉的方式。
      final files = {
        'lib/panels/p.dart': "import '../models/a.dart';\n",
      };
      expect(layerOf('lib/panels/p.dart'), 'panels');
      expect(violationsOf(files), isNotEmpty);
    });
  });
}
