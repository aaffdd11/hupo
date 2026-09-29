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

  test('③ 安装包那条地址必须是**绝对**的（`openExternal` 只认 http(s)）', () {
    // 负向对照先摆着：那条路径本身**不是**一条能交出去的地址（没有 host）。
    expect(Uri.parse(hupoApkPath).hasAuthority, false,
        reason: '★ 相对路径交给 `openExternal` ⇒ 它当场回 false ⇒ 点了什么都不发生');
    // 网页那一档：拿**页面自己**那条地址解析（地址栏就是它）。
    final web = apkDownloadUri(base: '', page: Uri.parse('https://w.stalkerai.cn/'));
    expect(web.toString(), 'https://w.stalkerai.cn$hupoApkPath');
    expect(web.hasAuthority, true);
    // 原生那一档：用包里带着的那个地址（`--dart-define=HUPO_API=…`）。
    final native = apkDownloadUri(base: 'https://w.stalkerai.cn', page: Uri.base);
    expect(native.toString(), 'https://w.stalkerai.cn$hupoApkPath');
    // 只写主机名那种（本机调试常见）：当作明文，路径照旧接得上。
    expect(
      apkDownloadUri(base: '127.0.0.1:8020/', page: Uri.base).toString(),
      'http://127.0.0.1:8020$hupoApkPath',
    );
  });

  test('③ 打包脚本必须带 `$_definePrefix…`（打法只有一个入口）', () {
    final f = File('../../../scripts/build-apk.sh');
    expect(f.existsSync(), true,
        reason: '★ 找不到 `scripts/build-apk.sh`（cwd 不对？）—— 打 APK 只许从它走');
    final src = f.readAsStringSync();
    // 🔴 **2026-09-30 修这条判据自己的一处脆**（它当时在 HEAD 上一直红）：
    //    一条命令**可以跨行写**（行尾 `\` 是 shell 的续行），实测 `build-apk.sh` 就是
    //    `… build apk --release \` 与 `--dart-define=HUPO_API="$HUPO_API"` **分了两行**。
    //    而原来这里先按行过滤、再逐行查 define ⇒ 它量到的其实是"续行语法"，
    //    不是"那条命令有没有带地址"（判据自己在说一件与它声明无关的事）。
    //    ⇒ 先把**逻辑行**（续行拼起来）再找那一条：**守的东西一个字没变**
    //      （那条命令必须带 define —— 拿掉它、或者换成别的地址变量，都照样红）。
    final logical = <String>[];
    final buf = StringBuffer();
    for (final raw in src.split('\n')) {
      final l = raw.trim();
      if (l.endsWith('\\')) {
        buf.write('${l.substring(0, l.length - 1)} ');
        continue;
      }
      buf.write(l);
      logical.add(buf.toString());
      buf.clear();
    }
    if (buf.isNotEmpty) logical.add(buf.toString());
    final lines = logical.where((l) => l.contains('build apk')).toList();
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
