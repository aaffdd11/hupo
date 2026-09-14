// 传输层抽象。
//
// 两个实现：WebSocketTransport（真实）/ MockTransport（本地回放与测试）。
//
// 注意 v1 的语义变化：上行是 `say`（用户发言），不是 `sendTurn`（提问）。
// 用户说完不保证有回应 —— 回应由调度器决定。

import 'dart:async';

import '../models/agent_status.dart';
import '../models/dev_step.dart';
import '../models/stream_event.dart';

/// 传输契约。
abstract class ChatTransport {
  /// 问服务端"现在部署的是哪个构建"。
  ///
  /// 客户端用它和自己编译进去的 [kClientBuildId] 对口径；返回 null 表示问不到
  /// （本地 mock、服务端太老、网络不通）—— 那就**不刷新**，宁可不刷也别乱刷。
  Future<Map<String, dynamic>?> serverVersion();

  /// 连接状态：true = 通着，false = 断了（界面据此把聊天窗口变灰、不可操作）。
  ///
  /// 为什么单独一条流：下行事件流在断线重连是**不断开**的（传输层自己重连），
  /// 所以它上面看不出"现在通不通"。
  Stream<bool> get connectionState;

  // ── 鉴权 ────────────────────────────────────────────────────
  //
  // 这台机器上跑着一个能执行命令、能动自己代码的 agent。
  // 没有令牌 = 谁都能指挥它，所以客户端每个请求都要带上。

  /// 问服务端"要不要登录、我现在算不算登录了"。
  Future<({bool required, bool authenticated})> authStatus();

  /// 用口令换令牌。成功返回令牌，失败返回 null。
  Future<String?> login(String password);

  /// 当前令牌（null = 没登录）。
  String? get token;

  /// 换一个令牌（null = 登出）。传输层会把它带在后续每个请求上。
  set token(String? value);

  /// 服务端说令牌不认了（过期/被换掉）——界面据此弹回登录页。
  Stream<void> get unauthorized;

  /// **agent 进程状态**快照（开发者模式专用）。
  ///
  /// 与 [devSteps] 分开：那是"按时间发生了什么"的流水，这是"此刻是什么样"的快照。
  /// 服务端只在现场推，不补发 —— 过期的进程状态没有任何意义。
  Stream<AgentSnapshot> get agentSnapshots;

  /// 建立下行连接。[sinceSeq] 用于断线续传（服务端补发该序号之后的事件）。
  ///
  /// [dev] 为 true 时额外订阅**开发事件**（后台在做什么），仅开发者模式使用。
  Stream<ServerEvent> connect({required String conversationId, int sinceSeq = 0, bool dev = false});

  /// 开发事件流（后台步骤）。仅 [connect] 时 dev=true 才有内容。
  Stream<DevStep> get devSteps;

  /// 用户发言。[messageId] 由客户端生成，服务端据此幂等去重。
  Future<void> say({
    required String conversationId,
    required String messageId,
    required String text,
    int? clientAt,
  });

  /// 回报"我什么时候看到的"。
  ///
  /// 为什么要有这一条：服务端只知道"我什么时候发的"，算不出
  /// **用户等了多久才看到反馈**。这两个时间点都是客户端自己的时钟，
  /// 同一个钟内部相减，不受两端时钟偏差影响 —— 监控层据此判时效性。
  Future<void> reportSeen({
    required String conversationId,
    required String messageId,
    int? firstSeenAt,
    int? endedSeenAt,
  });

  /// 中止某条调度器消息的输出（全链路：接收层 + 处理层一起停）。
  Future<void> cancelMessage({required String conversationId, required String messageId});

  /// 拉会话列表。
  Future<List<Map<String, dynamic>>> listConversations();

  Future<void> dispose();
}
