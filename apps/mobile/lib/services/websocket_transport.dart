// 真实传输：WebSocket 下行 + HTTP 上行（对接调度器）。
//
// 对应 `packages/protocol/PROTOCOL.md` v1。关键行为：
// - 下行断线自动重连，带 `sinceSeq` 续传
// - 上行带客户端生成的 `messageId` ⇒ 弱网重试幂等，不产生重复发言
// - 未知事件类型直接跳过 ⇒ 向前兼容

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/agent_status.dart';
import '../models/dev_step.dart';
import '../models/stream_event.dart';
import 'transport.dart';

class WebSocketTransport implements ChatTransport {
  WebSocketTransport({
    required this.baseUrl,
    this.token,
    this.reconnectDelay = const Duration(seconds: 2),
    /// 重连次数上限。默认**不限**：服务重启、部署、网络抖动都该自己回来，
    /// 用户不该需要手动刷新（"重启完成要可以自动恢复"）。
    this.maxReconnectAttempts = 1 << 30,
    /// 重连间隔上限：退避到这么久就不再涨，免得等半天。
    this.maxReconnectDelay = const Duration(seconds: 8),
  });

  /// 形如 `https://hupo.stalkerai.cn`（自动推导 ws/wss）。
  final String baseUrl;

  /// 会话令牌。**不进日志**（服务端那边也只在 Authorization 头/子协议里收）。
  /// 可变：登录后换上，被拒时清掉。

  final Duration reconnectDelay;
  final int maxReconnectAttempts;
  final Duration maxReconnectDelay;

  final _connection = StreamController<bool>.broadcast();

  @override
  Stream<bool> get connectionState => _connection.stream;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _wsSub;
  final _events = StreamController<ServerEvent>.broadcast();
  final _devSteps = StreamController<DevStep>.broadcast();
  final _agentSnaps = StreamController<AgentSnapshot>.broadcast();
  bool _dev = false;
  /// 这次连接**是不是"断线后重连"**（而不是页面刚打开）。
  ///
  /// 用途：服务端据此判断"要不要跟他说一句我已经升级好了"。
  /// 页面刚打开不是被打断 —— 那时候说"我已经升级好了"是莫名其妙的。
  bool _everConnected = false;

  String _conversationId = 'c_default';
  int _sinceSeq = 0;
  int _attempt = 0;
  bool _disposed = false;
  Timer? _retryTimer;

  Uri get _wsUri {
    final base = Uri.parse(baseUrl);
    return base.replace(
      scheme: base.scheme == 'https' ? 'wss' : 'ws',
      path: '/api/stream',
      queryParameters: {
        'conversationId': _conversationId,
        'sinceSeq': '$_sinceSeq',
        // 这次是**断线重连**（不是首次打开）——服务端据此决定要不要说"我已经升级好了"
        if (_everConnected) 'interrupted': '1',
        if (_dev) 'dev': '1', // 开发者模式：额外订阅后台活动
      },
    );
  }

  /// 会话令牌。null = 没登录。
  @override
  String? token;

  final _unauthorized = StreamController<void>.broadcast();

  @override
  Stream<void> get unauthorized => _unauthorized.stream;

  Map<String, String> get _headers => {
        'content-type': 'application/json',
        if (token != null) 'authorization': 'Bearer ${token!}',
      };

  /// 令牌被服务端拒了（过期/换过）：告诉界面弹回登录页，并且**把本地令牌清掉**——
  /// 留着一个坏令牌只会让每个请求都白跑一趟。
  void _noteUnauthorized() {
    if (token == null) return;
    token = null;
    if (!_unauthorized.isClosed) _unauthorized.add(null);
  }

  @override
  Future<({bool required, bool authenticated})> authStatus() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/auth'), headers: _headers);
      if (res.statusCode >= 400) return (required: true, authenticated: false);
      final d = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      final required = d['required'] == true;
      final authed = d['authenticated'] == true;
      // 服务端说"没在登录状态"，说明本地这个令牌不认了
      if (required && !authed && token != null) _noteUnauthorized();
      return (required: required, authenticated: authed);
    } catch (_) {
      // 连不上时**保守**：当作要登录但还没登录，界面会显示登录页而不是假装已登录
      return (required: true, authenticated: false);
    }
  }

  @override
  Future<String?> login(String password) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/login'),
        headers: {'content-type': 'application/json'},
        body: jsonEncode({'password': password}),
      );
      if (res.statusCode == 429) throw Exception('试得太频繁了，等一会儿再试');
      if (res.statusCode >= 400) return null;
      final d = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      final t = d['token'];
      if (t is! String || t.isEmpty) return null;
      token = t;
      return t;
    } catch (e) {
      rethrow;
    }
  }

  @override
  @override
  Stream<DevStep> get devSteps => _devSteps.stream;

  @override
  Stream<AgentSnapshot> get agentSnapshots => _agentSnaps.stream;

  @override
  Stream<ServerEvent> connect({required String conversationId, int sinceSeq = 0, bool dev = false}) {
    _conversationId = conversationId;
    _sinceSeq = sinceSeq;
    _dev = dev;
    _open();
    return _events.stream;
  }

  void _open() {
    if (_disposed) return;
    _wsSub?.cancel();
    try {
      final channel = WebSocketChannel.connect(
        _wsUri,
        // ⚠ 令牌走**子协议**，不走查询串 —— 查询串会被 nginx 原样写进 access.log，
        //   等于把钥匙挂在门口。浏览器不能给 WebSocket 设自定义头，子协议是唯一干净的路。
        protocols: token != null ? <String>['bearer', token!] : null,
      );
      _channel = channel;
      _attempt = 0;
      channel.ready.then((_) {
        if (_disposed) return;
        _everConnected = true; // 从这一刻起，后面的连接都算"重连"
        if (!_connection.isClosed) _connection.add(true);
      }).catchError((Object _) {
        // 握手就失败了，下面 onError/onDone 会安排重连
      });
      _wsSub = channel.stream.listen(
        _onFrame,
        onError: (Object _) => _scheduleReconnect(),
        onDone: _scheduleReconnect,
        cancelOnError: true,
      );
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _onFrame(dynamic frame) {
    if (frame is! String) return;
    Map<String, dynamic> json;
    try {
      json = jsonDecode(frame) as Map<String, dynamic>;
    } catch (_) {
      return; // 坏帧丢弃，不影响后续
    }
    // 开发事件走单独通道（产品事件不含它们）
    final snap = AgentSnapshot.tryParse(json);
    if (snap != null) {
      if (!_agentSnaps.isClosed) _agentSnaps.add(snap);
      return;
    }
    final devStep = DevStep.tryParse(json);
    if (devStep != null) {
      if (!_devSteps.isClosed) _devSteps.add(devStep);
      return;
    }

    final event = ServerEvent.tryParse(json);
    if (event == null) return; // 未知类型：向前兼容
    if (event.seq > _sinceSeq) _sinceSeq = event.seq;
    _events.add(event);
  }

  /// 断线重连：带 `sinceSeq`，服务端补发丢失事件。
  void _scheduleReconnect() {
    // 断了：先告诉界面（聊天窗口要变灰、不可操作）
    if (!_connection.isClosed) _connection.add(false);
    if (_disposed || _retryTimer != null) return;
    if (_attempt >= maxReconnectAttempts) return;
    _attempt++;
    final delay = reconnectDelay * _attempt;
    _retryTimer = Timer(delay > maxReconnectDelay ? maxReconnectDelay : delay, () {
      _retryTimer = null;
      _open();
    });
  }

  @override
  Future<void> say({
    required String conversationId,
    required String messageId,
    required String text,
    int? clientAt,
  }) async {
    final res = await http.post(
      Uri.parse('$baseUrl/api/say'),
      headers: _headers,
      body: jsonEncode({
        'conversationId': conversationId,
        'messageId': messageId,
        'text': text,
        if (clientAt != null) 'clientAt': clientAt,
      }),
    );
    if (res.statusCode >= 400) throw Exception('发送失败（${res.statusCode}）');
  }

  @override
  Future<void> reportSeen({
    required String conversationId,
    required String messageId,
    int? firstSeenAt,
    int? endedSeenAt,
  }) async {
    try {
      await http.post(
        Uri.parse('$baseUrl/api/receipt'),
        headers: _headers,
        body: jsonEncode({
          'conversationId': conversationId,
          'messageId': messageId,
          'clientAt': DateTime.now().millisecondsSinceEpoch,
          if (firstSeenAt != null) 'clientFirstSeenAt': firstSeenAt,
          if (endedSeenAt != null) 'clientEndedSeenAt': endedSeenAt,
        }),
      );
    } catch (_) {
      // 回报失败不能影响用户 —— 它只是监控数据
    }
  }

  @override
  Future<void> cancelMessage({required String conversationId, required String messageId}) async {
    await http.post(
      Uri.parse('$baseUrl/api/message/$messageId/cancel'),
      headers: _headers,
      body: jsonEncode({'conversationId': conversationId}),
    );
  }

  /// 问服务端当前部署的构建指纹（用于判断"我该不该刷新自己"）。
  @override
  Future<Map<String, dynamic>?> serverVersion() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/api/version'), headers: _headers);
      if (res.statusCode >= 400) return null;
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null; // 问不到就不刷新，绝不因为一次网络抖动把用户的页面刷掉
    }
  }

  @override
  Future<List<Map<String, dynamic>>> listConversations() async {
    final res = await http.get(Uri.parse('$baseUrl/api/conversations'), headers: _headers);
    if (res.statusCode >= 400) throw Exception('拉取会话失败（${res.statusCode}）');
    final decoded = jsonDecode(utf8.decode(res.bodyBytes));
    return (decoded as List).cast<Map<String, dynamic>>();
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    await _connection.close();
    await _unauthorized.close();
    _retryTimer?.cancel();
    await _wsSub?.cancel();
    await _channel?.sink.close();
    await _events.close();
    await _devSteps.close();
    await _agentSnaps.close();
  }
}
