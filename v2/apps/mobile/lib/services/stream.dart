// 连调度器的实时通道。手册 `08-SPEC.md` §2.1 / §2.3。
//
// 这里堵两个**旧实现真的踩了**的坑：
//
//   B5 · 退避恒为 2 秒
//        旧实现每次 `_open()` 都把 `_attempt` 归零 ⇒ 封顶值永不生效。
//        ⇒ 这里**只在"连成功"之后**才归零。
//
//   B1 · 401 不处理 ⇒ 无限重连
//        坏令牌时每 2 秒连一次，永远连不上、永远不说。
//        ⇒ 这里认出来就**停下来**，并且把状态报成"要重新登录"。
//
// 另：`sinceSeq` 是续传游标（协议 R5）。重连时带上它，
// 服务端只补后面的（决策 P-h：此时才标 `catchUp`）。

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';

enum ConnState {
  /// 没在连（还没开始，或者已经主动停掉）。
  idle,

  /// 正在连（第一次）。
  connecting,

  /// 连着。
  connected,

  /// 断了，正在退避重连。
  reconnecting,

  /// ⚠️ 令牌不行。**不再重试**——重试一万次也不会好，只会一直失败。
  unauthorized,

  /// 这台机器还没设密码。
  notSetup,
}

class StreamClient {
  StreamClient({
    required this.base,
    required this.token,
    required this.api,
    this.pingTimeout = const Duration(seconds: 60),
  });

  final String base; // 空串 = 同源
  final String token;
  final Api api;
  final Duration pingTimeout;

  final _events = StreamController<Map<String, dynamic>>.broadcast();
  final _states = StreamController<ConnState>.broadcast();

  WebSocketChannel? _ch;
  StreamSubscription<dynamic>? _sub;
  Timer? _retry;
  Timer? _pingWatch;
  int _attempt = 0;
  int _sinceSeq = 0;
  bool _wantOpen = false;
  ConnState _state = ConnState.idle;

  /// 解析后的事件流。
  Stream<Map<String, dynamic>> get events => _events.stream;

  /// 连接状态变化。
  Stream<ConnState> get states => _states.stream;

  ConnState get state => _state;

  bool get isConnected => _state == ConnState.connected;

  /// 续传游标。重连时从这儿要。
  int get sinceSeq => _sinceSeq;

  /// 开始连。`sinceSeq` 从本地时间线来（首次传 0）。
  void open({int sinceSeq = 0}) {
    _wantOpen = true;
    _sinceSeq = sinceSeq;
    _connect();
  }

  void _set(ConnState s) {
    if (_state == s) return;
    _state = s;
    if (!_states.isClosed) _states.add(s);
  }

  Future<void> _connect() async {
    if (!_wantOpen) return;
    _retry?.cancel();
    _set(_attempt == 0 ? ConnState.connecting : ConnState.reconnecting);

    final scheme = base.startsWith('https') ? 'wss' : 'ws';
    final host = base.isEmpty ? _sameOriginHost() : base.replaceFirst(RegExp(r'^https?'), '');
    final uri = Uri.parse('$scheme://$host/api/stream?sinceSeq=$_sinceSeq');

    try {
      // 令牌走**子协议**（手册 §2.1）——不进 URL。
      final ch = WebSocketChannel.connect(uri, protocols: ['bearer', token]);
      _ch = ch;
      await ch.ready;
      // ★ 只有连成功才归零退避（B5 的修法）
      _attempt = 0;
      _set(ConnState.connected);
      _armPingWatch();
      _sub = ch.stream.listen(
        _onFrame,
        onDone: () => _onClosed(),
        onError: (_) => _onClosed(),
        cancelOnError: true,
      );
    } catch (_) {
      await _onFailed();
    }
  }

  /// 同源时，浏览器知道 host 是什么；这里从当前页面推。
  String _sameOriginHost() {
    final u = Uri.base;
    return '${u.host}${u.hasPort ? ':${u.port}' : ''}';
  }

  void _onFrame(dynamic raw) {
    if (raw is! String) return;
    Map<String, dynamic> event;
    try {
      event = jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return; // 不认识的帧：安静忽略
    }
    _armPingWatch();

    // 控制帧：不占号、不上时间线（决策 P-g）。
    switch (event['type']) {
      case 'client/ping':
        return;
      case 'client/hello':
        final m = event['maxSeq'];
        if (m is int && m > _sinceSeq) _sinceSeq = m;
        return;
      case 'client/reset':
        // ⚠️ 我们的号跑到服务端前面去了（日志被换过、或连错了线）。
        //    那**不能当"没有新东西"**——要把本地时间线丢掉重来，
        //    否则界面会永远停在一个已经不存在的世界上。
        _sinceSeq = 0;
        _events.add({'type': '__reset__'});
        return;
    }
    final seq = event['seq'];
    if (seq is int && seq > _sinceSeq) _sinceSeq = seq;
    _events.add(event);
  }

  /// 看门狗：太久没收到任何帧（连 ping 都没有）就当作断了。
  ///
  /// 光靠 `onDone` 是不够的——**网线拔掉、手机进电梯**这类情况，
  /// TCP 连接会"看起来还在"，而实际上什么都不会再来。
  void _armPingWatch() {
    _pingWatch?.cancel();
    _pingWatch = Timer(pingTimeout, () {
      if (_state == ConnState.connected) {
        _ch?.sink.close();
        _onClosed();
      }
    });
  }

  void _onClosed() {
    _pingWatch?.cancel();
    _sub?.cancel();
    _sub = null;
    _ch = null;
    if (!_wantOpen) return;
    _scheduleRetry();
  }

  /// 连不上时：先弄清**是不是令牌的问题**。
  ///
  /// ⚠️ WS 握手失败在客户端拿不到 HTTP 状态码，所以用一次
  /// **带令牌的普通请求**去问——401 就是令牌不行。
  /// 不分清的话，坏令牌会变成一个永远转圈的界面（B1）。
  Future<void> _onFailed() async {
    _ch = null;
    if (!_wantOpen) return;

    switch (await api.health(token)) {
      case TokenProbe.unauthorized:
        _wantOpen = false;
        _set(ConnState.unauthorized);
        return;
      case TokenProbe.notSetup:
        _wantOpen = false;
        _set(ConnState.notSetup);
        return;
      case TokenProbe.ok:
      case TokenProbe.unknown:
        break;
    }
    _scheduleRetry();
  }

  /// 退避：2 / 4 / 6 / 8 / 8 …（封顶 8 秒），**不限次**。
  ///
  /// ⚠️ `_attempt` **不在这里归零**——只在连成功时归零（B5）。
  void _scheduleRetry() {
    _set(ConnState.reconnecting);
    _attempt += 1;
    final secs = (_attempt * 2).clamp(1, 8);
    _retry?.cancel();
    _retry = Timer(Duration(seconds: secs), _connect);
  }

  void close() {
    _wantOpen = false;
    _retry?.cancel();
    _pingWatch?.cancel();
    _sub?.cancel();
    _ch?.sink.close();
    _ch = null;
    _set(ConnState.idle);
  }

  Future<void> dispose() async {
    close();
    await _events.close();
    await _states.close();
  }
}
