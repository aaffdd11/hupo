// 登录页。文案是**手册 D2 的定稿**，一字不改。
//
// 为什么不改：那几句话是四个人吵出来的，每一句都有用户原话垫底——
//   · 不说"能执行命令、能改自己的代码" → 03 读完**是害怕**
//   · 不说"口令" → 用户上一次听到是"看电视里当兵的站岗"
//   · 不说"进去/登录" → 没人读出"进门"，读出来的是"提交"
//   · **"密码"** 可以用 → 微信/支付宝时代**已经学过**
//   · **"打开"** 可以用 → 同样是学过的词

import 'package:flutter/material.dart';

import '../services/api.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.api, required this.onLoggedIn, this.needsSetup = false});

  final Api api;
  final void Function(String token) onLoggedIn;

  /// 服务端说"还没设密码"时要**明说**——别让人在那儿瞎试。
  final bool needsSetup;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _controller = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final pw = _controller.text;
    if (pw.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final r = await widget.api.login(pw);
    if (!mounted) return;
    setState(() => _busy = false);

    if (r.ok) {
      widget.onLoggedIn(r.token!);
      return;
    }
    // ⚠️ 四种失败说四句不同的话。笼统一句"登录失败"等于什么都没说。
    setState(() {
      _error = r.wrongPassword
          ? '密码不对，再试一次'
          : r.lockedSec != null
              ? '试得太频繁，${(r.lockedSec! / 60).ceil()} 分钟后再试'
              : r.networkError != null
                  // ★ 手册 D2：连不上**不是**"你密码错了"——网回来自己就好了
                  ? '连不上，你还登着，网回来自己进'
                  : '出了点问题：${r.other ?? '再试一次'}';
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            // 一行太长没人读得下去
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('助手', style: theme.textTheme.headlineMedium, textAlign: TextAlign.center),
                const SizedBox(height: 16),
                Text(
                  '你说的事它真会去做，不只是陪聊。\n所以这道门只有你能开。',
                  style: theme.textTheme.bodyLarge,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 28),
                TextField(
                  controller: _controller,
                  obscureText: true,
                  autofocus: true,
                  onSubmitted: (_) => _submit(),
                  decoration: const InputDecoration(
                    border: OutlineInputBorder(),
                    labelText: '密码',
                    helperText: '装机器时给你的那一串',
                  ),
                ),
                const SizedBox(height: 14),
                FilledButton(
                  // 触控目标 ≥44
                  style: FilledButton.styleFrom(minimumSize: const Size(48, 52)),
                  onPressed: _busy ? null : _submit,
                  child: Text(_busy ? '正在开…' : '打开'),
                ),
                if (widget.needsSetup) ...[
                  const SizedBox(height: 16),
                  // 不许让人瞎试——服务端明说了就明说
                  Text(
                    '这台机器还没设密码。\n在机器上跑一次设置命令，再回来打开。',
                    style: theme.textTheme.bodySmall,
                    textAlign: TextAlign.center,
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 16),
                  Text(
                    _error!,
                    style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.error),
                    textAlign: TextAlign.center,
                  ),
                ],
                const SizedBox(height: 24),
                Text(
                  '忘了密码？在机器上重设一次就行。',
                  style: theme.textTheme.bodySmall,
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
