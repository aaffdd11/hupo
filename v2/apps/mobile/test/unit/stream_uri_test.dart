// 连"流"的那个地址。
//
// ⚠️ **这一份测试的存在本身就是那次事故的产物。**
//    在这之前，**没有任何一条测试**碰过客户端的地址构造——
//    验收用的是 node 探针，而探针把 `wss://` 写死了，等于把被测的那行代码绕过去。
//    于是"探针一直绿、浏览器一次没通"能同时成立（详见 `services/stream_uri.dart`）。
//
// ⇒ 凡是**客户端自己算出来的东西**，闸就得打在客户端这一侧。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/scope.dart';
import 'package:hupo_app/services/stream_uri.dart';

Uri page(String s) => Uri.parse(s);

void main() {
  group('流的地址', () {
    test('🔴 同源 + https 页面 ⇒ wss（这次事故的回归条）', () {
      final u = streamUri(base: '', page: page('https://w.stalkerai.cn/'), sinceSeq: 0);
      expect(u.scheme, 'wss');
      expect(u.host, 'w.stalkerai.cn');
      expect(u.path, '/api/stream');
      expect(u.queryParameters['sinceSeq'], '0');
      expect(u.toString(), 'wss://w.stalkerai.cn/api/stream?sinceSeq=0&level=doing&scope=main');
    });

    test('🔴 金丝雀：https 页面上**永远不许**降级成 ws://', () {
      // 明文 ws 从 https 页面发出去，浏览器按混合内容直接拦掉——
      // 而页面、登录、接口全走同一个源，照常工作 ⇒ 看起来只是"网断了"。
      // 这条挂了就说明又有人拿 `base` 去猜协议了（web 上 `base` 恒为空串）。
      for (final p in [
        'https://w.stalkerai.cn/',
        'https://w.stalkerai.cn/chat',
        'https://w.stalkerai.cn:8443/',
        'https://hupo.example.com/#/x',
      ]) {
        final u = streamUri(base: '', page: page(p), sinceSeq: 3);
        expect(u.scheme, 'wss', reason: '$p 上拼出了 ${u.scheme}://');
      }
    });

    test('同源 + http 页面 ⇒ ws（局域网明文调试这条路要留着）', () {
      final u = streamUri(base: '', page: page('http://127.0.0.1:8020/'), sinceSeq: 0);
      expect(u.toString(), 'ws://127.0.0.1:8020/api/stream?sinceSeq=0&level=doing&scope=main');
    });

    test('同源 + 非默认端口：端口要带上', () {
      final u = streamUri(base: '', page: page('https://w.stalkerai.cn:8443/'), sinceSeq: 0);
      expect(u.toString(), 'wss://w.stalkerai.cn:8443/api/stream?sinceSeq=0&level=doing&scope=main');
    });

    test('同源 + 默认端口：**不许**多写 :443 / :80', () {
      // `Uri.port` 会给默认端口填上 443，拼进地址就成了 `wss://host:443/…`。
      for (final p in ['https://a.cn/', 'http://a.cn/', 'https://a.cn:443/']) {
        final u = streamUri(base: '', page: page(p), sinceSeq: 0);
        expect(u.hasPort, false, reason: '$p ⇒ $u');
      }
    });

    test('跨源（调试用）：协议和主机都听 base 的', () {
      final a = streamUri(base: 'https://w.stalkerai.cn', page: page('http://127.0.0.1:8020/'), sinceSeq: 7);
      expect(a.toString(), 'wss://w.stalkerai.cn/api/stream?sinceSeq=7&level=doing&scope=main');

      final b = streamUri(base: 'http://127.0.0.1:9000/', page: page('https://w.stalkerai.cn/'), sinceSeq: 7);
      expect(b.toString(), 'ws://127.0.0.1:9000/api/stream?sinceSeq=7&level=doing&scope=main');
    });

    test('跨源：只写主机名（本机调试常见）⇒ 当明文，主机要认出来', () {
      final u = streamUri(base: '127.0.0.1:8020', page: page('https://w.stalkerai.cn/'), sinceSeq: 0);
      expect(u.toString(), 'ws://127.0.0.1:8020/api/stream?sinceSeq=0&level=doing&scope=main');
    });

    test('续传游标：断线重连时带上，服务端才知道从哪儿补', () {
      final u = streamUri(base: '', page: page('https://w.stalkerai.cn/'), sinceSeq: 12345);
      expect(u.queryParameters['sinceSeq'], '12345');
    });

    test('⚠️ 非 web 平台没有"页面"⇒ 这个函数给不出地址（**已知缺口，不是功能**）', () {
      // 安卓上 `Uri.base` 是 `file:///data/user/0/…`：**没有 host**。
      // 而 `chat_controller` 现在写死 `base: ''` ⇒ 安卓那边**无处可知服务器在哪**。
      // ⇒ 这一条不是"行为契约"，是**一块路牌**：安卓那一批必须先自己把 base 传进来
      //    （那个地址从哪儿来、怎么存，是安卓那一批要定的事，现在没有），
      //    否则屏幕上会是"网断了"而其实什么都没发出去。
      final u = streamUri(base: '', page: page('file:///data/user/0/cn.hupo/files'), sinceSeq: 0);
      expect(u.host, isEmpty, reason: '非 web 上没有来源——要么传 base，要么这条路走不通');
    });
  });

  // ── 批 3：过程档位（`docs/dev/122-TWO-PROCESS-LEVELS.md` §三）──────────
  //
  // ⚠️ 这一组的意义和上面那条金丝雀一样：**客户端自己算出来的东西，
  //    闸必须打在客户端这一侧**。服务端的验收探针这次也会带 `level`，
  //    但探针带的不是**客户端真正会发**的那串——上面那次事故就是这么来的。
  group('过程两档：地址上要带 level', () {
    test('★ 不给 level ⇒ 默认档 `doing`（契约：不带 = doing）', () {
      final u = streamUri(base: '', page: page('https://w.stalkerai.cn/'), sinceSeq: 0);
      expect(u.queryParameters['level'], 'doing');
      expect(u.queryParameters['level'], defaultProcessLevel.wire);
    });

    test('★ 两档逐档带上：wire 就是服务端要认的那个 token', () {
      for (final level in ProcessLevel.values) {
        final u = streamUri(
          base: '',
          page: page('https://w.stalkerai.cn/'),
          sinceSeq: 9,
          level: level,
        );
        expect(u.queryParameters['level'], level.wire, reason: '$level 带错了');
        expect(u.queryParameters['sinceSeq'], '9', reason: 'level 不许把游标挤掉');
      }
      // 🔴 **协议里那四个 token 一个都不许改**（老客户端还在发 `quiet`/`steps`）；
      //    新客户端只发留下那两个 —— 这一条只多不少。
      expect(processLevelWires, ['quiet', 'doing', 'steps', 'reasoning']);
      expect(ProcessLevel.values.map((l) => l.wire).toList(), ['doing', 'reasoning']);
    });

    test('🔴 砍掉的两档**发不出去**（它们根本不在枚举里）', () {
      // 负向对照：`processLevelOf('steps')` 是默认档 ⇒ 从盘上读回来之后
      // 客户端永远只会发 `doing` / `reasoning` 两个字面量之一。
      expect(processLevelOf('steps'), ProcessLevel.doing);
      expect(processLevelOf('quiet'), ProcessLevel.doing);
      final u = streamUri(
        base: '',
        page: page('https://w.stalkerai.cn/'),
        sinceSeq: 0,
        level: processLevelOf('steps'),
      );
      expect(u.queryParameters['level'], 'doing');
      expect(u.toString(), isNot(contains('level=steps')));
    });
  });

  // ── 批 4：一个图标 = 一条对话（契约 `docs/dev/83-APP-WORKSPACE.md` §五·甲）──
  //
  // ⚠️ 这一组和上面那条金丝雀**同一个理由**：地址是**客户端自己算的**，
  //    所以闸必须打在客户端这一侧。`scope` 又正好是"切房间"唯一的落点 ——
  //    它带错了，用户在 A 房间说的话会进 B 房间，而屏幕上一点都看不出来。
  group('房间（scope）：地址上要带 scope', () {
    test('★ 不给 scope ⇒ 默认 `main`（契约：不带 = main）', () {
      final u = streamUri(base: '', page: page('https://w.stalkerai.cn/'), sinceSeq: 0);
      expect(u.queryParameters['scope'], 'main');
      expect(u.queryParameters['scope'], mainScope);
    });

    test('★ 给了 scope ⇒ 地址上是它，而且 `level` / `sinceSeq` 一个都不许被挤掉', () {
      final u = streamUri(
        base: '',
        page: page('https://w.stalkerai.cn/'),
        sinceSeq: 42,
        level: ProcessLevel.reasoning,
        scope: 'dice',
      );
      expect(u.queryParameters['scope'], 'dice');
      expect(u.queryParameters['level'], 'reasoning');
      expect(u.queryParameters['sinceSeq'], '42');
      expect(
        u.toString(),
        'wss://w.stalkerai.cn/api/stream?sinceSeq=42&level=reasoning&scope=dice',
      );
    });

    test('🔴 换房间**不许**动协议（https 页面上还是 wss，见那条事故）', () {
      for (final s in [mainScope, 'dice', 'city-weather']) {
        final u = streamUri(
          base: '',
          page: page('https://w.stalkerai.cn/'),
          sinceSeq: 0,
          scope: s,
        );
        expect(u.scheme, 'wss', reason: 'scope=$s 时拼出了 ${u.scheme}://');
      }
    });

    test('🔴 地址上**不带令牌**（多了一个 scope 也不许多带别的）', () {
      // 令牌走**子协议** `['bearer', token]`（手册 §2.1）——不进 URL，
      // 加 `scope` 这一刀也不许顺手把令牌塞进来。
      const token = 'eyJzdWIiOiJ1MSJ9.signature-not-a-real-one';
      final u = streamUri(
        base: '',
        page: page('https://w.stalkerai.cn/'),
        sinceSeq: 1,
        scope: 'dice',
      );
      expect(u.toString().contains(token), isFalse);
      expect(u.toString().contains('bearer'), isFalse);
      expect(u.toString().contains('token'), isFalse);
      // 查询参数**只有**约定的那三个
      expect(u.queryParameters.keys.toSet(), {'sinceSeq', 'level', 'scope'});
    });

    test('★ scope 里的怪字符要转义（别让一个 id 把地址结构改了）', () {
      final u = streamUri(
        base: '',
        page: page('https://w.stalkerai.cn/'),
        sinceSeq: 0,
        scope: 'a b&c=d',
      );
      expect(u.queryParameters['scope'], 'a b&c=d', reason: '转义之后要能原样读回来');
      expect(u.queryParameters.length, 3, reason: '不许被拆出多余的参数');
    });
  });

  group('语音那条（/api/asr · 2026-09-23 真开麦）', () {
    test('★ https 页面上**不许降级**（那次事故的第二个入口）', () {
      final u = asrUri(base: '', page: page('https://w.stalkerai.cn/'));
      expect(u.toString(), 'wss://w.stalkerai.cn/api/asr');
      expect(u.scheme, 'wss', reason: '在 https 页面上拼出 ws:// 会被浏览器直接拦掉');
    });

    test('同源：看页面自己的协议（http 调试页面 ⇒ ws）', () {
      final u = asrUri(base: '', page: page('http://127.0.0.1:8020/'));
      expect(u.toString(), 'ws://127.0.0.1:8020/api/asr');
    });

    test('跨源：看 base 的协议，端口照带（不是默认端口就不许丢）', () {
      final u = asrUri(base: 'http://127.0.0.1:8091', page: page('https://w.stalkerai.cn/'));
      expect(u.toString(), 'ws://127.0.0.1:8091/api/asr');
    });
  });

  // ── 「我自己那台」那条（`docs/dev/81-HARNESS-ENTRY.md` §5.1）──────
  //
  // ⚠️ 这是**同一个坑的第三个入口**：`ws://` vs `wss://` 那次事故（`16-STREAM.md`）
  //    之所以发生，是因为"客户端自己算的地址"没有闸打在这一侧。
  //    ⇒ 这一条也不许例外：金丝雀必须有。
  group('「我自己那台」那条（/api/harness）', () {
    test('★ https 页面上**不许降级**（第三个入口的金丝雀）', () {
      final u = harnessUri(base: '', page: page('https://w.stalkerai.cn/'));
      expect(u.toString(), 'wss://w.stalkerai.cn/api/harness');
      expect(u.scheme, 'wss', reason: '在 https 页面上拼出 ws:// 会被浏览器直接拦掉');
    });

    test('同源：看页面自己的协议（http 调试页面 ⇒ ws）', () {
      final u = harnessUri(base: '', page: page('http://127.0.0.1:8020/'));
      expect(u.toString(), 'ws://127.0.0.1:8020/api/harness');
    });

    test('默认端口不许多写 :443 / :80；跨源看 base 的协议，端口照带', () {
      expect(harnessUri(base: '', page: page('https://a.cn/')).hasPort, false);
      final u = harnessUri(base: 'http://127.0.0.1:8091', page: page('https://w.stalkerai.cn/'));
      expect(u.toString(), 'ws://127.0.0.1:8091/api/harness');
    });

    test('地址上**不带令牌**（令牌走子协议，和 /api/stream 同一条规矩）', () {
      final u = harnessUri(base: '', page: page('https://w.stalkerai.cn/'));
      expect(u.query, isEmpty);
    });
  });
}
