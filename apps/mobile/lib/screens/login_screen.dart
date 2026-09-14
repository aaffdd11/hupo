// 登录页。
//
// 为什么这里必须"什么都不给看"：这台机器上跑着一个能执行命令、能动自己代码的
// agent。没登录的时候，**对话内容、会话列表、调试数据一个都不能露** ——
// 露一个字节就等于把主人说过的话给出去了。
//
// 所以这个页面的职责只有一件：把口令换成令牌。其余一概不显示。

import 'package:flutter/material.dart';

import '../services/chat_controller.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.controller});

  final ChatController controller;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _pw = TextEditingController();
  final _focus = FocusNode();
  bool _obscure = true;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _pw.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final pw = _pw.text;
    if (pw.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final ok = await widget.controller.login(pw);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (!ok) _error = widget.controller.loginError ?? '登录失败';
    });
    if (ok) _pw.clear();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 380),
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Icon(Icons.lock_outline, size: 36, color: theme.hintColor),
                const SizedBox(height: 16),
                Text('助手', textAlign: TextAlign.center, style: theme.textTheme.titleLarge),
                const SizedBox(height: 6),
                Text(
                  '这台机器上的助手能执行命令、能改自己的代码。\n所以进来要先验一下是你。',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                ),
                const SizedBox(height: 24),
                TextField(
                  key: const Key('login-password'),
                  controller: _pw,
                  focusNode: _focus,
                  obscureText: _obscure,
                  autofillHints: const [AutofillHints.password],
                  onSubmitted: (_) => _submit(),
                  decoration: InputDecoration(
                    hintText: '口令',
                    isDense: true,
                    filled: true,
                    fillColor: theme.colorScheme.surfaceContainerHighest,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                    suffixIcon: IconButton(
                      tooltip: _obscure ? '显示' : '隐藏',
                      icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility, size: 18),
                      onPressed: () => setState(() => _obscure = !_obscure),
                    ),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Icon(Icons.error_outline, size: 14, color: theme.colorScheme.error),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(_error!,
                            style: theme.textTheme.bodySmall
                                ?.copyWith(color: theme.colorScheme.error)),
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 18),
                FilledButton(
                  key: const Key('login-submit'),
                  onPressed: _busy ? null : _submit,
                  child: _busy
                      ? const SizedBox(
                          width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('进去'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
