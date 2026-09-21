// 琥珀 —— 入口。
//
// 三件事：**有没有令牌 → 进哪一屏**；**启动时查一次"设密码了没"**；
// **别在连不上的时候把令牌清掉**。
//
// 最后一条是旧实现 B1 的根：它把任何网络失败都当成"未登录"，
// 于是网络抖一下就把人踢回登录页。06 那类用户的后果是
// **每 30 天要打一次电话求助**——而手册 D2 的红线正是这个。

import 'dart:async';

import 'package:flutter/material.dart';

import 'models/forbidden_words.dart';
import 'screens/chat_screen.dart';
import 'screens/landing_screen.dart';
import 'screens/login_screen.dart';
import 'services/api.dart';
import 'models/space.dart';
import 'screens/model_key_screen.dart';
import 'screens/waiting_screen.dart';
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

  /// **"我那台到哪一步了"**（契约 `38` §8.3）。`null` = 还没问过（按就绪处理）。
  SpaceInfo? _space;

  /// 刚把钥匙填完（还没等下一次问回来）—— 这一刻**不许**把人退回填钥匙那一屏。
  bool _keySent = false;

  /// 正在问"到哪一步了"。
  bool _askingSpace = false;
  bool _booting = true;
  bool _needsSetup = false;
  /// 未登录时的**两屏**：先 landing（说清它是什么），点"开始用"才进登录页。
  /// ⚠️ 登录**之后**退出登录时不再走 landing：那时他是个熟客，直接给登录页。
  bool _showLogin = false;

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
      _controller = ChatController(
        api: _api,
        tokens: _tokens,
        token: token,
        // 续期撞上 401（过期 / 被撤销 / 过了绝对上限）⇒ 回登录页。
        // ⚠️ 这只是**回登录页**那条路：网的问题在控制器里就被挡下了，
        //    令牌一个字节都不会清（B1）。
        onUnauthorized: _onLoggedOut,
      )..start(token: token);
      // ⚠️ 冷启动那条路也要问（不然"上次还没开好"的人这次会直接看到聊天界面）
      unawaited(_askSpace(token));
    }
    if (mounted) setState(() => _booting = false);
  }

  void _onLoggedIn(String token) {
    setState(() {
      _controller = ChatController(
        api: _api,
        tokens: _tokens,
        token: token,
        onUnauthorized: _onLoggedOut,
      )..start(token: token);
    });
    // ★ 登录之后**问一次"到哪一步了"**（`38` §8.3）——
    //   ⚠️ **不 await、不挡登录**：登录该立刻算成功，这一问晚一点回来也行
    //     （问不到就当就绪，见 `SpaceInfo.fromJson` 那条兼容纪律）。
    unawaited(_askSpace(token));
  }

  /// 问一次"我那台到哪一步了"。⚠️ **问不到不抛、不改状态**（保持上一次的结论）。
  Future<void> _askSpace(String token) async {
    if (_askingSpace) return;
    _askingSpace = true;
    try {
      final s = await _api.space(token);
      if (!mounted) return;
      setState(() => _space = s);
    } finally {
      _askingSpace = false;
    }
  }

  /// 把钥匙送过去，然后**再问一次**（问回来才是真的算数）。
  Future<KeySend> _sendKey(String key) async {
    final token = await _tokens.read();
    if (token == null) return KeySend.failed;
    final r = await _api.setModelKey(token, key);
    if (r == KeySend.ok && mounted) {
      setState(() => _keySent = true); // 先放他进去（他自己刚填完）
      await _askSpace(token); // 再问一次，拿服务端的话为准
    }
    return r;
  }

  void _onLoggedOut() {
    // 退出了就直接给登录页（他是熟客，不用再看一遍 landing）
    setState(() {
      _controller = null;
      _showLogin = true;
    });
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
          : _controller != null && spaceScreenFor(_space ?? const SpaceInfo(), keySent: _keySent) == SpaceScreen.waiting
              ? WaitingScreen(
                  busy: _askingSpace,
                  // ★ **真进度**：服务端真的知道的那三步（没有百分比）
                  steps: (_space ?? const SpaceInfo()).steps,
                  queued: (_space ?? const SpaceInfo()).queued,
                  // 🔴 **给不了**（满了 / 没建成）—— 那一档要在屏上明说，
                  //    而且要**停掉自问自答**（再问也不会有别的答案）。
                  full: (_space ?? const SpaceInfo()).full,
                  // ★ **正在现开一台**：那一步不快（要建用户、装盒子）⇒ 说它自己那句
                  provisioning: (_space ?? const SpaceInfo()).provisioning,
                  // ★ **它自己会问**（主人要的"动态"）：不用用户按"再看看"。
                  //   ⚠️ 问的是**真状态**（`/api/space`），不是编出来的进度。
                  onRefresh: () async {
                    final t = await _tokens.read();
                    if (t != null) await _askSpace(t);
                  },
                  onRetry: () async {
                    final t = await _tokens.read();
                    if (t != null) await _askSpace(t);
                  },
                )
              : _controller != null && spaceScreenFor(_space ?? const SpaceInfo(), keySent: _keySent) == SpaceScreen.key
                  ? ModelKeyScreen(onSubmit: _sendKey)
                  : _controller != null
              ? ChatScreen(controller: _controller!, onLoggedOut: _onLoggedOut)
              : _showLogin
                  ? LoginScreen(api: _api, needsSetup: _needsSetup, onLoggedIn: _onLoggedIn)
                  : LandingScreen(onStart: () => setState(() => _showLogin = true)),
    );
  }
}

/// 扫一段界面文案里有没有禁用词。
///
/// ⚠️ 为什么放在这里而不是只在测试里：**改文案的人就在这个仓库里改**，
///    让这个函数离文案近一点，比让它藏在 test/ 里更容易被想起来。
bool uiTextIsClean(String text) => !hasForbidden(text);
