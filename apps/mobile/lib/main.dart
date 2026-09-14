// 应用入口。
//
// 产品行为只有一条：**用户说话 → 给反馈。**
//
// 内部有快答/深思、超时降级、被动聆听、主动开口等机制，但那些是**实现细节**，
// 用户看不见，也不该看见 —— 界面上没有任何"简单/复杂/深度"这类分类。
//
// 开发期要复现边界情况时，用编译开关打开场景切换器：
//   flutter run --dart-define=HUpo_DEMO=true

library;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import 'screens/chat_screen.dart';
import 'screens/login_screen.dart';
import 'services/chat_controller.dart';
import 'services/dev_mode.dart';
import 'services/mock_transport.dart';
import 'services/page_reload.dart';
import 'services/token_store.dart';
import 'services/transport.dart';
import 'services/websocket_transport.dart';

/// 非 Web 端（iOS/Android）连的服务器。
const String kServerBaseUrl = 'https://hupo.stalkerai.cn';

/// 开发期开关：true 时底部出现场景切换条。**生产构建不开启。**
const bool kDemoMode = bool.fromEnvironment('HUpo_DEMO', defaultValue: false);

void main() {
  // Web 端可用 `?dev=1` 直接进开发者模式
  initDevModeFromUrl(Uri.base);
  runApp(const HupoApp());
}

class HupoApp extends StatefulWidget {
  const HupoApp({super.key, this.transportOverride});

  /// 测试注入用。产品里为 null（用真实的 WebSocketTransport）。
  ///
  /// 为什么要有这个口子：登录成功后"从登录页换到对话页"这件事，
  /// 只有把**整个 App 外壳**跑起来才测得出来 —— 单测 LoginScreen
  /// 是测不出外层没重建的（实测漏过一次）。
  final ChatTransport? transportOverride;

  @override
  State<HupoApp> createState() => _HupoAppState();
}

class _HupoAppState extends State<HupoApp> {
  MockScenario _scenario = MockScenario.normal;
  late ChatTransport _transport;
  late ChatController _controller;

  @override
  void initState() {
    super.initState();
    devModeEnabled.addListener(_onDevModeChanged);
    _build();
    _boot();
  }

  /// 启动：先拿本地令牌、问一次鉴权状态，再决定显示登录页还是对话页。
  ///
  /// ⚠ 顺序很重要：**没确认登录之前不能建连** —— 建了也是被 401 拒掉，
  /// 而且会让服务端日志里多一堆无意义的拒绝记录。
  Future<void> _boot() async {
    final saved = await loadToken();
    if (saved != null) _transport.token = saved;
    // 登录/登出都要落盘：登录后下次不用再输，被拒后立刻清掉坏令牌
    _controller.addListener(_onControllerChanged);
    await _controller.refreshAuth();
    if (!mounted) return;
    if (_controller.needsLogin) {
      setState(() {}); // 显示登录页
      return;
    }
    _controller.connect(dev: _devMode);
    setState(() {});
  }

  /// 控制器有变化：**重建外层**（登录成功要换成对话页），顺手把令牌落盘。
  ///
  /// ⚠ 这里漏了 setState 的话，登录成功后 404 页面会**停在登录页不动** ——
  /// 接口全 200，界面纹丝不动（实测踩过：只挂了个存令牌的监听，它不重建）。
  void _onControllerChanged() {
    if (!mounted) return;
    setState(() {});
    _persistTokenIfChanged();
  }

  /// 令牌变了就落盘（登录后存、被拒后清）。
  String? _lastSavedToken;
  void _persistTokenIfChanged() {
    final t = _transport.token;
    if (t == _lastSavedToken) return;
    _lastSavedToken = t;
    // 不 await：存盘失败也不能挡住界面
    // ignore: discarded_futures
    saveToken(t);
  }

  /// 连接真实服务端。
  ///
  /// Web 端用当前页面来源（同源，不用配地址）；原生端用 [kServerBaseUrl]。
  /// 只有开发期开关打开时才用本地回放（`--dart-define=HUpo_DEMO=true`）。
  void _build() {
    if (widget.transportOverride != null) {
      _transport = widget.transportOverride!;
    } else if (kDemoMode) {
      _transport = MockTransport(scenario: _scenario, speed: 1.0);
    } else {
      _transport = WebSocketTransport(baseUrl: _resolveBaseUrl());
    }
    _controller = ChatController(transport: _transport, conversationId: _resolveConversationId());
    // 服务端说系统变了、该刷新了 —— 前端是哑的，它只负责照做。
    // 但"什么时候刷"由控制器定：不会在用户正看着一段话往外蹦的时候把页面刷掉。
    _controller.onReloadRequested = () {
      if (kIsWeb) {
        reloadClient();
      } else {
        // 手机上没页面可刷：重连一次，把最新状态拿回来
        _controller.reconnect();
      }
    };
    // ⚠ 这里**不建连**：连不连由 _boot() 按鉴权结果决定。
    //   没登录就建连只会被 401 拒掉，还会在服务端日志里留一堆无意义的拒绝。
  }

  /// 开发者模式：网址带 `?dev=1`，或在设置页打开开关。默认关闭。
  bool _devMode = devModeEnabled.value;

  void _onDevModeChanged() {
    _controller.setDevMode(devModeEnabled.value);
    if (mounted) setState(() => _devMode = devModeEnabled.value);
  }

  void _exitDevMode() => devModeEnabled.value = false;

  /// 用哪个会话。默认 `c_main`。
  ///
  /// 为什么做成可指定（`?conv=xxx`）：**测试和调试不该污染主人的对话**。
  /// 原来所有浏览器测试都往 c_main 里灌消息，主人的聊天记录里堆了一堆
  /// 「我已经升级好了。」「这条我没能给出结论」——那是我自己造的垃圾。
  String _resolveConversationId() {
    if (!kIsWeb) return 'c_main';
    final q = Uri.base.queryParameters['conv'];
    return (q != null && q.isNotEmpty) ? q : 'c_main';
  }

  String _resolveBaseUrl() {
    if (!kIsWeb) return kServerBaseUrl;
    final base = Uri.base;
    final port = base.hasPort && base.port != 80 && base.port != 443 ? ':${base.port}' : '';
    return '${base.scheme}://${base.host}$port';
  }

  void _switchScenario(MockScenario scenario) {
    _controller.dispose();
    setState(() {
      _scenario = scenario;
      _build();
    });
  }

  @override
  void dispose() {
    _controller.removeListener(_onControllerChanged);
    devModeEnabled.removeListener(_onDevModeChanged);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Hupo',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        // ⚠ brightness 必须与 ColorScheme 一致，否则启动即断言失败（整页空白）。
        // 只在两处之中声明一次，避免写两个而出错。
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF4A90D9),
          brightness: Brightness.dark,
        ),
      ),
      // ⚠ 没登录就**只**显示登录页 —— 对话、会话列表、调试卡片一概不建。
      //   这台机器上的 agent 能执行命令、能改自己代码，露一个字节都不行。
      home: _controller.needsLogin
          ? LoginScreen(controller: _controller)
          : ChatScreen(
        controller: _controller,
        transport: _transport,
        devMode: _devMode,
        onExitDevMode: _exitDevMode,
        // 只有开发构建才显示场景切换器；产品构建里这一栏不存在。
        bottomSheet: kDemoMode
            ? ScenarioBar(current: _scenario, onSelect: _switchScenario)
            : null,
      ),
    );
  }
}

/// 开发期场景切换条（仅在 `--dart-define=HUpo_DEMO=true` 时出现）。
///
/// 这些档位**不是产品概念**，只是让边界情况可被手动复现：
/// 失败、不出声、主动开口、极快/极慢。
class ScenarioBar extends StatelessWidget {
  const ScenarioBar({super.key, required this.current, required this.onSelect});

  final MockScenario current;
  final ValueChanged<MockScenario> onSelect;

  @override
  Widget build(BuildContext context) {
    const labels = {
      MockScenario.normal: '正常',
      MockScenario.fastDeep: '很快',
      MockScenario.slowDeep: '很慢',
      MockScenario.deepFails: '失败',
      MockScenario.listening: '不出声',
      MockScenario.proactive: '主动',
      MockScenario.longTask: '要很久',
    };
    return Material(
      color: Theme.of(context).colorScheme.surfaceContainer,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (final entry in labels.entries)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 3),
                  child: ChoiceChip(
                    label: Text(entry.value, style: const TextStyle(fontSize: 12)),
                    selected: current == entry.key,
                    onSelected: (_) => onSelect(entry.key),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
