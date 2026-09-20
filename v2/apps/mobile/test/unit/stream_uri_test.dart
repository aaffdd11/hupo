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
      expect(u.toString(), 'wss://w.stalkerai.cn/api/stream?sinceSeq=0&level=doing');
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
      expect(u.toString(), 'ws://127.0.0.1:8020/api/stream?sinceSeq=0&level=doing');
    });

    test('同源 + 非默认端口：端口要带上', () {
      final u = streamUri(base: '', page: page('https://w.stalkerai.cn:8443/'), sinceSeq: 0);
      expect(u.toString(), 'wss://w.stalkerai.cn:8443/api/stream?sinceSeq=0&level=doing');
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
      expect(a.toString(), 'wss://w.stalkerai.cn/api/stream?sinceSeq=7&level=doing');

      final b = streamUri(base: 'http://127.0.0.1:9000/', page: page('https://w.stalkerai.cn/'), sinceSeq: 7);
      expect(b.toString(), 'ws://127.0.0.1:9000/api/stream?sinceSeq=7&level=doing');
    });

    test('跨源：只写主机名（本机调试常见）⇒ 当明文，主机要认出来', () {
      final u = streamUri(base: '127.0.0.1:8020', page: page('https://w.stalkerai.cn/'), sinceSeq: 0);
      expect(u.toString(), 'ws://127.0.0.1:8020/api/stream?sinceSeq=0&level=doing');
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

  // ── 批 3：过程四档（`docs/dev/26-PROCESS-LEVELS.md` §三）──────────
  //
  // ⚠️ 这一组的意义和上面那条金丝雀一样：**客户端自己算出来的东西，
  //    闸必须打在客户端这一侧**。服务端的验收探针这次也会带 `level`，
  //    但探针带的不是**客户端真正会发**的那串——上面那次事故就是这么来的。
  group('过程四档：地址上要带 level', () {
    test('★ 不给 level ⇒ 默认档 `doing`（契约：不带 = doing）', () {
      final u = streamUri(base: '', page: page('https://w.stalkerai.cn/'), sinceSeq: 0);
      expect(u.queryParameters['level'], 'doing');
      expect(u.queryParameters['level'], defaultProcessLevel.wire);
    });

    test('★ 四档逐档带上：wire 就是服务端要认的那个 token', () {
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
      // 四个 token 就是契约里写死的那四个（写错了服务端会当默认档）
      expect(
        ProcessLevel.values.map((l) => l.wire).toList(),
        ['quiet', 'doing', 'steps', 'reasoning'],
      );
    });

    test('安静档：地址上仍然是 `level=quiet`（不是"不带"）', () {
      // ⚠️ 这一点很重要：**"不带 = doing"** 意味着"不带"根本表达不了安静档。
      //    所以安静档必须显式带出去。
      final u = streamUri(
        base: '',
        page: page('https://w.stalkerai.cn/'),
        sinceSeq: 0,
        level: ProcessLevel.quiet,
      );
      expect(u.toString(), 'wss://w.stalkerai.cn/api/stream?sinceSeq=0&level=quiet');
    });
  });
}
