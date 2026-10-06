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

  // ════════════════════════════════════════════════════════════
  // ★ 2026-10-06：**下载链接带版本号**（主人：*「apk命名方式，我们也要用版本号来。
  //    就是下载链接也要增加版本号。」* · 契约 `docs/dev/207-APK-VERSIONED.md`）
  // ════════════════════════════════════════════════════════════
  test('④ 默认就是那个稳定名（老链接、VM 判据那一档**一个字都没变**）', () {
    // ⚠️ 判据里**没有**传 define ⇒ 这一条同时是"没喂 define 的构建落回稳定名"的证据。
    expect(hupoApkName, 'hupo-chat.apk', reason: '★ 默认不许变成一个带版本的名字（老客户端那条链接指着它）');
    expect(hupoApkPath, '/hupo-chat.apk');
    // 带版本那一档：同一条纯函数，换一个路径就得出一条**带版本**的绝对地址。
    final v = apkDownloadUri(
      base: 'https://w.stalkerai.cn',
      page: Uri.base,
      path: '/hupo-chat-2.0.0-702.apk',
    );
    expect(v.toString(), 'https://w.stalkerai.cn/hupo-chat-2.0.0-702.apk',
        reason: '★ 下载链接里必须看得见版本号（那一份留档，永远指向那一版）');
  });

  test('④ 三条脚本的分工：**算名字只在一处**，发与部署都从账里读', () {
    String read(String rel) {
      final f = File('../../../scripts/$rel');
      expect(f.existsSync(), true, reason: '★ 找不到 `scripts/$rel`（cwd 不对？）');
      return f.readAsStringSync();
    }

    final build = read('build-apk.sh');
    final publish = read('publish-apk.sh');
    final deploy = read('deploy-web-v2.sh');

    // ① **只有 build-apk.sh 算那个名字**（`+` → `-`），而且它把名字写进那笔账、喂给编译期。
    expect(build.contains(r'${BUILD_NAME//+/-}'), true,
        reason: '★ `build-apk.sh` 里要看得见 `+`→`-` 那一处换算（包名带版本号；`+` 在下载器手里不稳）');
    expect(build.contains(r'''"file":"%s"'''), true, reason: '★ 名字要写进 `data/apk-build.json` 的 `file`（发与部署都从账里读）');
    expect(build.contains('--dart-define=HUPO_APK_NAME='), true,
        reason: '★ 打包那条命令要把它喂进编译期（不然包里的常量还是稳定名）');

    // ② 发：从账里读 `file`，而且**同时**刷稳定名（老客户端那条链接不许断）。
    expect(publish.contains('"file":"[^"]*"'), true, reason: '★ 发之前要从账里读出"这一版叫什么"');
    // 🔴 **读账要读在"打完包"之后**：`--owner-asked` 会先让 build-apk.sh 写新的版本与文件名，
    //    读早了就会拿着**上一版**的名字去发这一版的字节。
    expect(publish.indexOf('build-apk.sh') < publish.indexOf('"file":"[^"]*"'), true,
        reason: '★ `publish-apk.sh` 在读账**之前**就打了包（名字会差一版）—— 先把名字读晚一点');
    expect(publish.contains('APK_ALIAS="hupo-chat.apk"'), true,
        reason: '★ 稳定名那一份要照旧存在（已装的老客户端指着它 —— 冻结契约）');
    expect(publish.contains(r'$PUBLIC/$APK_ALIAS'), true,
        reason: '★ 稳定名也要在线核一遍（哪条断了都是"页面在说假话"）');

    // ③ 部署网页：把**现在发的是哪一份**喂进编译期（首页那颗按钮指的就是它）。
    expect(deploy.contains('--dart-define=HUPO_APK_NAME='), true,
        reason: '★ 网页那次构建也要喂（不然首页那颗按钮还指向稳定名，链接里看不到版本号）');

    // 🔴 负向对照：**别的脚本里不许再出现那一处换算**（两处换算 = 一定漂）。
    for (final (name, src) in [('publish-apk.sh', publish), ('deploy-web-v2.sh', deploy)]) {
      expect(src.contains(r'${BUILD_NAME//+/-}'), false,
          reason: '★ `$name` 里又算了一遍包名 —— 名字只许 `build-apk.sh` 算一次，其余从账里读');
    }
  });
}
