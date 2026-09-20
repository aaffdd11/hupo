// 琥珀 —— 入口。
//
// 三件事：**有没有令牌 → 进哪一屏**；**启动时查一次"设密码了没"**；
// **别在连不上的时候把令牌清掉**。
//
// 最后一条是旧实现 B1 的根：它把任何网络失败都当成"未登录"，
// 于是网络抖一下就把人踢回登录页。06 那类用户的后果是
// **每 30 天要打一次电话求助**——而手册 D2 的红线正是这个。

import 'package:flutter/material.dart';

import 'models/forbidden_words.dart';
import 'screens/chat_screen.dart';
import 'screens/login_screen.dart';
import 'services/api.dart';
import 'services/chat_controller.dart';
import 'services/token_store.dart';

void main() {
  runApp(const HupoApp());
}

class HupoApp extends StatefulWidget {
  const HupoApp({super.key});

  @override
  State<HupoApp> createState() => _HupoAppState();
}

class _HupoAppState extends State<HupoApp> {
  final _api = Api();
  final _tokens = TokenStore();
  ChatController? _controller;
  bool _booting = true;
  bool _needsSetup = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    // ⚠️ 顺序：先问"这台机器设密码了吗"（公开路由），再决定要不要用旧令牌。
    //    反过来的话，服务端还没设密码时会拿着一堆 503 去猜。
    _needsSetup = await _api.needsSetup();

    final token = await _tokens.read();
    if (token != null) {
      _controller = ChatController(api: _api, tokens: _tokens, token: token)
        ..start(token: token);
    }
    if (mounted) setState(() => _booting = false);
  }

  void _onLoggedIn(String token) {
    setState(() {
      _controller = ChatController(api: _api, tokens: _tokens, token: token)
        ..start(token: token);
    });
  }

  void _onLoggedOut() {
    setState(() => _controller = null);
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '助手',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF4A90D9),
        // 刻意**不写死字号**（手册 D3.5：容器跟字算，字不跟容器）。
        // 系统字体调多大，这里就多大；溢不溢出由布局负责，不靠封顶掩盖。
      ),
      home: _booting
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : _controller == null
              ? LoginScreen(api: _api, needsSetup: _needsSetup, onLoggedIn: _onLoggedIn)
              : ChatScreen(controller: _controller!, onLoggedOut: _onLoggedOut),
    );
  }
}

/// 扫一段界面文案里有没有禁用词。
///
/// ⚠️ 为什么放在这里而不是只在测试里：**改文案的人就在这个仓库里改**，
///    让这个函数离文案近一点，比让它藏在 test/ 里更容易被想起来。
bool uiTextIsClean(String text) => !hasForbidden(text);
