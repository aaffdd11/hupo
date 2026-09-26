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
//
// ── C 期（契约 `84-DISPATCHER-FOCUS.md` §三·3）：**一条连接服务所有房间** ──
//
// 手册 `02-ARCHITECTURE.md` §四 核心原则 3 说"一个 WS 连接是物理约束"。
// 改前这里是 `final scope`（连接级的）⇒ 切房间只能重连 —— `84 §八`
// 把那种形状列为**明确不做**。现在：
//   · 构造参数 `scope` = **初始焦点**（连上时仍然走 `?scope=`，老的两边照旧认得）；
//   · 切焦点走 [focus]（客户端→服务端一帧 `{"t":"focus","scope":…,"sinceSeq":…}`），
//     **连接不动**；服务端按焦点决定"哪些事件现时投给这条连接"。
// ⚠️ `level` 仍然是**连接级**的（换档要重连）——两件事别混。

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'stream_uri.dart';

import 'api.dart';
import '../models/conn_state.dart';
import '../models/retry.dart';
import '../models/process_levels.dart';
import '../models/scope.dart';

class StreamClient {
  StreamClient({
    required this.base,
    required this.token,
    required this.api,
    this.level = defaultProcessLevel,
    String scope = mainScope,
    this.pingTimeout = const Duration(seconds: 60),
    /// ★ P1-10（2026-09-24）："令牌还行不行"那一问**可注入** ——
    ///   判据要能验"401 就停下重连"那条路（B1），而真的去连一个坏地址是验不准的。
    ///   `null` = 用真那个（`api.health`）。
    this.probe,
  }) : _focus = scope.trim().isEmpty ? mainScope : scope.trim();

  final String base; // 空串 = 同源
  final String token;
  final Api api;

  /// 过程四档（契约 §三）。**连接级**：服务端按这条连接决定发多少过程
  /// ⇒ 换档只能靠**重连**（`chat_controller.setLevel` 就是这么做的）。
  final ProcessLevel level;

  /// **这一条连接现在的焦点**（契约 `84-DISPATCHER-FOCUS.md` §三·3 · C 期）。
  ///
  /// ⚠️ 改前它是 `final`（`?scope=` 是连接级的 ⇒ 切房间只能重连）——那正是
  ///    `#121` 走偏的第三处（84 §八"明确不做"第 3/4 条）。
  ///    现在：**一条连接服务所有房间**，切焦点是**发一帧**（[focus]），
  ///    连接不动。构造参数给的只是**初始焦点**（连上时走 `?scope=`，
  ///    老客户端与老服务端照旧互相认得）。
  ///
  /// ⚠️ 和 [level] **不是一类**：`level` 仍然是连接级的（换档要重连）；
  ///    焦点不是。两件事混起来就会出现"换个房间顺手把档也换了"那种毛病。
  String _focus;

  /// 这一条连接现在的焦点（判据要读得到）。
  String get scope => _focus;

  /// 聚焦到某一间（**不重连**）。带上这一间自己的游标：
  /// 服务端会把那一间缺的那一段补发过来（"历史按 `?scope=` 视图重载"）。
  ///
  /// ⚠️ 两件事必须一起做，少一件就会错：
  ///   ① 记下新焦点 ⇒ 重连时 `?scope=` 与补发都以它为准；
  ///   ② 游标换成**那一间自己的**（`sinceSeq`）—— 拿上一间的号去要下一间的历史，
  ///      要么多收一段、要么被服务端当成"号跑到前面了"要求整条重置。
  void focus(String scope, {int sinceSeq = 0}) {
    final want = scope.trim().isEmpty ? mainScope : scope.trim();
    _focus = want;
    _sinceSeq = sinceSeq < 0 ? 0 : sinceSeq;
    // 帧只在**连着**的时候发；没连着也不慌：下一次 `_connect` 直接按新焦点连。
    if (_state == ConnState.connected && _ch != null) _sendFocus();
  }

  /// 把"我在看哪一间"告诉服务端（客户端→服务端那一帧）。
  void _sendFocus() {
    try {
      _ch?.sink.add(jsonEncode({'t': 'focus', 'scope': _focus, 'sinceSeq': _sinceSeq}));
    } catch (_) {
      // 发不出去 = 这条连接已经不行了：重连那条路会按新焦点重来。
    }
  }

  /// ★ **他答了那一句问话**（契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 第②/③步）。
  ///
  /// 🔴 **走同一条流**（不新开 HTTP 路）：问话那一帧本来就是这条流上的，
  ///    答话从同一条回去 ⇒ 一个动作一个家；而且路由表（手册 §2.1）不用动。
  /// 🔴 **客户端不许自己切房间**：切过去只认服务端那一帧 `scope/open`
  ///    （两处各切一次 = 两个裁判）。
  ///
  /// @returns 发出去了没有。`false` = 没连着 / 号是空的 ⇒ 调用方**如实说一句**，
  ///          绝不假装收下了。
  bool answerJob(String id, {required bool yes}) {
    final want = id.trim();
    if (want.isEmpty) return false;
    if (_state != ConnState.connected || _ch == null) return false;
    try {
      _ch?.sink.add(jsonEncode({'t': 'job-answer', 'id': want, 'yes': yes}));
      return true;
    } catch (_) {
      // 发不出去 = 这条连接已经不行了（重连那条路会把它接上，
      // 而那一笔要是超时了，服务端会推"作废了"那一帧）。
      return false;
    }
  }

  final Duration pingTimeout;

  /// 见构造函数里的说明：只为判据而存在的注入口。
  final Future<TokenProbe> Function(String token)? probe;

  /// ★ **撤掉排队里那一句**（契约 `docs/dev/117-QUEUE-VISIBLE.md` §二）。
  ///
  /// 🔴 **走同一条流**（不新开 HTTP 路 —— 与 `job-answer` 同一条纪律）：
  ///    排队那一帧本来就是这条流上的，撤它也从同一条回去。
  /// 🔴 **没有错误面**：那一句要是**已经被认领**（那一轮正用着）或者根本不认识，
  ///    服务端**什么都不做**，只回一份新快照 ⇒ 这边也不需要任何"失败"分支。
  ///
  /// @returns 发出去了没有。`false` = 没连着 / 号是空的 ⇒ 调用方**如实留着那一行**
  ///          （他再按一次就行），绝不假装撤掉了。
  bool unsay(String messageId) {
    final want = messageId.trim();
    if (want.isEmpty) return false;
    if (_state != ConnState.connected || _ch == null) return false;
    try {
      _ch?.sink.add(jsonEncode({'t': 'unsay', 'messageId': want}));
      return true;
    } catch (_) {
      // 发不出去 = 这条连接已经不行了（重连那条路会把它接上；
      // 而队列的真相在服务端，重连那一刻会现发一份快照）。
      return false;
    }
  }

  final _events = StreamController<Map<String, dynamic>>.broadcast();
  final _states = StreamController<ConnState>.broadcast();

  WebSocketChannel? _ch;
  StreamSubscription<dynamic>? _sub;
  Timer? _retry;
  Timer? _pingWatch;
  int _attempt = 0;
  int _sinceSeq = 0;

  /// 上一回**探明**的失败原因。重试时用它，而不是每次都退回"网断了"——
  /// 否则状态条会在真话和假话之间来回跳（每次重试都先把假话打出来）。
  ConnState _retryState = ConnState.reconnecting;
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
    _set(_attempt == 0 ? ConnState.connecting : _retryState);

    // ⚠️ 别在这里自己拼协议：同源时必须看**页面**的协议，
    //    否则会在 https 页面上拼出 ws:// 并被浏览器拦掉（`stream_uri.dart` 记着这次事故）。
    // ⚠️ `scope` 和 `level` 只走这一个算地址的函数，谁都不许在别处再拼一遍
    //    （那条事故的第二个/第三个入口就是这么来的）。
    //    ⚠️ 这里的 `scope` 是**初始焦点**（C 期起）：连上之后切焦点走帧，
    //       不重连 —— 见 `focus()` 顶上那段。
    //    🔴 建地址那一行用的必须是**当下的游标与焦点**（`_sinceSeq` / `_focus`）——
    //       判据打在字面上：`test/unit/stream_retry_test.dart` 的 R5（续传游标不许丢）。
    final uri = streamUri(
      base: base,
      page: Uri.base,
      sinceSeq: _sinceSeq,
      level: level,
      scope: _focus,
    );
    // ★ 把**建地址时**那一对值记下来（上面那几行是同步求值的，中间插不进别人）：
    //   握手要时间，这中间 `focus()` 可能已经改过焦点/游标了 ⇒ 连上之后要补一帧
    //   （不然服务端还停在旧那一间，而客户端已经在等新那一间的话了）。
    final uriFocus = _focus;
    final uriSince = _sinceSeq;

    try {
      // 令牌走**子协议**（手册 §2.1）——不进 URL。
      final ch = WebSocketChannel.connect(uri, protocols: ['bearer', token]);
      _ch = ch;
      await ch.ready;
      // ★ 只有连成功才归零退避（B5 的修法）
      _attempt = 0;
      _retryState = ConnState.reconnecting;
      _set(ConnState.connected);
      _armPingWatch();
      _sub = ch.stream.listen(
        _onFrame,
        onDone: () => _onClosed(),
        onError: (_) => _onClosed(),
        cancelOnError: true,
      );
      // ★ 握手那一下用的是**建地址时**的焦点与游标；这中间被 `focus()` 改过 ⇒
      //   补一帧让服务端跟上来（**不重连**：连接已经建好了，就是换个焦点）。
      if (_focus != uriFocus || _sinceSeq != uriSince) _sendFocus();
    } catch (_) {
      await _onFailed();
    }
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
      case 'client/focus':
        // ★ **服务端对"切焦点"的确认**（C 期 · 契约 84 §四）：控制帧，
        //   不占号、不上时间线。
        //   ⚠️ 但它是一个**有用的界**：服务端的顺序是"先把新焦点那一间的历史
        //      （补发）发完，再发这一帧"⇒ 在它之前收到的都算**历史**。
        //      给上层一个内部信号（和 `__caught_up__` 同一个套路、
        //      同样是**客户端内部**的帧，不是协议字段）。
        _events.add({'type': '__focus_ready__'});
        return;
      case 'client/hello':
        final m = event['maxSeq'];
        if (m is int && m > _sinceSeq) _sinceSeq = m;
        // ★ **补发到此为止**（2026-09-22 补的）：服务端的顺序是"先把补发那段发完，
        //   再发这条 hello，然后才订阅实时"（`server.js` 那一段就是保证）。
        //   ⇒ 给上层一个内部信号：**在这条之前收到的都算历史**。
        //   ⚠️ 它是**客户端内部**的帧，不是协议字段（协议一旦上线就冻结）；
        //      `__reset__` 已经开了这个先例。
        _events.add({'type': '__caught_up__'});
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
    // ★ **只有属于现在焦点的事件才推进游标**（C 期：一条连接服务所有房间）。
    //   上一间的帧可能在切换的路上（补发是连着发的）—— 让它们把游标顶上去，
    //   下一次"切回那一间"就会拿一个**过大的号**去要历史（少收一段）。
    //   ⚠️ 上层也会把不属于这一间的帧丢掉，但那已经太晚了：游标在这里就已经动了。
    if (eventInScope(event, _focus) && seq is int && seq > _sinceSeq) _sinceSeq = seq;
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
    // 掉线的第一句先按"网断了"说（这会儿还没问过），
    // 下一个回合 `_onFailed` 会拿探针的结果改口——最多一个退避周期。
    _scheduleRetry();
  }

  /// 连不上时：先弄清**是不是令牌的问题**。
  ///
  /// ⚠️ WS 握手失败在客户端拿不到 HTTP 状态码，所以用一次
  /// **带令牌的普通请求**去问——401 就是令牌不行。
  /// 不分清的话，坏令牌会变成一个永远转圈的界面（B1）。
  ///
  /// ⚠️ 这一问还顺带回答了**另一个问题：网到底通不通**。
  ///    答 200 ⇒ 服务端明明在 ⇒ 屏幕上**不许**说"网断了"（`models/conn_state.dart`）。
  Future<void> _onFailed() async {
    _ch = null;
    if (!_wantOpen) return;

    // ★ P1-10：可注入（判据用），默认走真那一问
    // ⚠️ 局部变量**不能叫 probe**（那会遮住字段 `probe`，Dart 直接报"先引用后声明"）
    final answer = await (probe?.call(token) ?? api.health(token));
    switch (answer) {
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
      // ★ 2026-09-25（线上真事故）：`boxDown` 也走这一条 —— **继续重试**。
      //   它不是"令牌不行"（不重试）也不是"这台机器没设密码"（那是另一件事）：
      //   是**他那台盒子这一下没应**，退避接着问就对。
      case TokenProbe.boxDown:
        break;
    }
    _scheduleRetry(
      state: switch (answer) {
        TokenProbe.ok => ConnState.streamBlocked,
        // 状态条就说这句 —— **不许**说"这台机器还没设密码"
        TokenProbe.boxDown => ConnState.boxDown,
        _ => ConnState.reconnecting,
      },
    );
  }

  /// 退避：2 / 4 / 6 / 8 / 8 …（封顶 8 秒），**不限次**。
  ///
  /// ⚠️ `_attempt` **不在这里归零**——只在连成功时归零（B5）。
  /// ⚠️ [state] 要一路带到下一次重试（`_retryState`），否则每次重试都会
  ///    先把"网断了"打出来再改口，状态条会闪。
  void _scheduleRetry({ConnState state = ConnState.reconnecting}) {
    _retryState = state;
    _set(state);
    _attempt += 1;
    // ★ P1-10（2026-09-24）：算式提到 `models/retry.dart`（纯函数，判据在 test/unit）
    final secs = retrySeconds(_attempt);
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
