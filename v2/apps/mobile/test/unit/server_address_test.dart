// **服务端地址那一件事**（契约 `docs/dev/129-NATIVE-ANDROID-BUILD.md` §三）。
//
// ── 为什么这一份是硬账 ────────────────────────────────────
//   网页上客户端**没有"服务端地址"这个概念**（同源 ＋ 地址栏），
//   而**原生包上没有地址栏**：实测（2026-09-28，非网页那一侧）
//       Uri.base = file:///…   ·   Uri.parse('/api/version') 没有 host
//   ⇒ 打出来的 APK 装上去**一直连不上**，而**每道闸都是绿的**
//     （判据全在网页那一侧 —— V13 那一族的又一个实例）。
//   ⇒ 所以这里把三件事钉死：
//     ① `hupoApiBase` 的默认是**空串**（网页 = 同源；这条保证网页那条路一个字节没变）；
//     ② 空 base 拼出来的地址**没有 host**（那就是"原生上打不出去"的形状，能量出来）；
//     ③ 🔴 **打法只有一个入口**，而且那个脚本里**必须**带 `--dart-define=HUPO_API=…`
//        （免得下次又打出一个连不上的包 —— 结构上让它不可能）。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/server_address.dart';
import 'package:hupo_app/services/api.dart';

/// 打包脚本那一行必须长这样（**只有一处出处**）。
const _definePrefix = '--dart-define=HUPO_API=';

void main() {
  test('① 默认是空串（网页那条路 = 同源）', () {
    // ⚠️ 测试环境**没有**传 define ⇒ 这一条同时是"网页没被影响"的证据。
    expect(hupoApiBase, '', reason: '★ 默认必须是空串：网页靠同源，给了值网页反而会跨源');
    expect(apiBaseConfigured(hupoApiBase), false);
    expect(Api().base, hupoApiBase, reason: '★ `Api` 的默认 base 必须跟着它走（不许自己写一个）');
  });

  test('② 空地址 ⇒ 拼出来的地址**没有 host**（原生上就是"打不出去"）', () {
    final same = apiUriFor('', '/api/version');
    expect(same.hasAuthority, false, reason: '★ 这就是"没配地址"的形状');
    expect(same.toString(), '/api/version');
    // 负向对照：给了地址就必须是一条**绝对**地址。
    final abs = apiUriFor('https://w.stalkerai.cn', '/api/version');
    expect(abs.hasAuthority, true);
    expect(abs.toString(), 'https://w.stalkerai.cn/api/version');
  });

  test('③ 打包脚本必须带 `$_definePrefix…`（打法只有一个入口）', () {
    final f = File('../../../scripts/build-apk.sh');
    expect(f.existsSync(), true,
        reason: '★ 找不到 `scripts/build-apk.sh`（cwd 不对？）—— 打 APK 只许从它走');
    final src = f.readAsStringSync();
    final lines = src
        .split('\n')
        .map((l) => l.trim())
        .where((l) => l.contains('build apk'))
        .toList();
    expect(lines, isNotEmpty, reason: '★ 脚本里得有那一条"build apk"（打法只有这一个入口）');
    expect(
      lines.every((l) => l.contains(_definePrefix)),
      true,
      reason: '★ 那条命令必须带 `$_definePrefix<地址>` —— 不带就是一个"装上去连不上"的包\n${lines.join('\n')}',
    );
    // 负向对照：脚本自己也得说清**为什么**（改它的人要看得见那段）。
    expect(src.contains('HUPO_API'), true);
  });
}
