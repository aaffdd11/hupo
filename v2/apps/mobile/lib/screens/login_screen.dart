// 登录页：**手机号 + 验证码**（主人 2026-09-21：「登录不对，需要手机号和验证码」）。
//
// ── 为什么把"密码"整个拿掉 ─────────────────────────────────
// 手册 `01-PROJECT.md` R4 那张表（逐条有用户原话垫底）：
//   · **"口令"** 挡住 03（"我上一次听是看电视里当兵的站岗"）与
//     **06（68 岁退休教师 —— "就在登录页"，第一天就放弃）**；
//   · 而 03 的期望原话是"**微信抖音都是验证码**"。
// ⇒ 手机号 + 验证码是**用户已经学过**的那一套，不用再学。
//
// ── 三条不许破 ────────────────────────────────────────────
//   ① 🔴 **临时验证码必须如实说**（那一行小字）：现在没有短信，
//      那个码谁都知道 —— 不说就是让用户以为这是真的短信验证（**说假话**）；
//   ② 🔴 **四种失败四句话**：码不对 / 手机号不像 / 还没接短信 / 连不上。
//      把它们混成一句"登录失败"，用户只会反复重输；
//   ③ 不写死尺寸（D3.5）：字号走 `theme.textTheme`，整页能滚；
//      命中区 ≥44（D3.6）。
//
// ⚠️ 文案全在 `models/login_words.dart`（那样才进得了禁用词硬闸）。

import 'package:flutter/material.dart';

import '../widgets/brand_mark.dart';

import '../models/login_words.dart';
import '../services/api.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.api, required this.onLoggedIn, this.needsSetup = false});

  final Api api;
  final void Function(String token) onLoggedIn;

  /// 服务端说"这台机器还没设好"时要**明说**——别让人在那儿瞎试。
  final bool needsSetup;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final phone = _phone.text.trim();
    final code = _code.text.trim();
    if (phone.isEmpty || code.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final r = await widget.api.loginWithCode(phone, code);
    if (!mounted) return;
    setState(() => _busy = false);

    if (r.ok) {
      widget.onLoggedIn(r.token!);
      return;
    }
    setState(() {
      _error = r.wrongCode
          ? loginErrCode
          : r.badPhone
              ? loginErrPhone
              : r.noSms
                  ? loginErrNoSms
                  : r.lockedSec != null
                      ? '$loginErrLockedPrefix${(r.lockedSec! / 60).ceil()}$loginErrLockedSuffix'
                      : r.networkError != null
                          // ★ 手册 D2：连不上**不是**"你输错了"——网回来自己就好了
                          ? loginErrNetwork
                          : '出了点问题：${r.other ?? '再试一次'}';
    });
  }

  /// 按【获取验证码】：**只回"发出去没有"** —— 码本身永远不进这个界面。
  Future<void> _sendCode() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final r = await widget.api.sendCode(_phone.text.trim());
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = switch (r) {
        CodeSend.sent => loginSent,
        CodeSend.noSms => loginSendNoSms,
        CodeSend.badPhone => loginSendBadPhone,
        CodeSend.failed => loginSendFailed,
      };
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
                // ★ **和首页同一个标志**（契约 `49-STYLE.md`）：两屏摆在一起
                //   要像**一个产品**。⚠️ 居中的列 ⇒ 标志也居中（`Center`）。
                const Center(child: BrandMark()),
                const SizedBox(height: 18),
                Text('助手', style: theme.textTheme.headlineMedium, textAlign: TextAlign.center),
                const SizedBox(height: 16),
                Text(loginPromise, style: theme.textTheme.bodyLarge, textAlign: TextAlign.center),
                const SizedBox(height: 28),
                TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  autofocus: true,
                  decoration: const InputDecoration(
                    border: OutlineInputBorder(),
                    labelText: loginPhoneLabel,
                    helperText: loginPhoneHint,
                  ),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: _code,
                  keyboardType: TextInputType.number,
                  onSubmitted: (_) => _submit(),
                  decoration: const InputDecoration(
                    border: OutlineInputBorder(),
                    labelText: loginCodeLabel,
                    helperText: loginCodeHint,
                  ),
                ),
                const SizedBox(height: 14),
                // ★ **【获取验证码】那个按钮**（主人 2026-09-21 点名的：
                //    "找不到获取验证码的按钮" ⇒ 人们不知道该怎么登录）。
                //   ⚠️ 它是**次要**按钮（`OutlinedButton`）：主按钮仍然是"进去"。
                OutlinedButton(
                  style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
                  onPressed: _busy ? null : _sendCode,
                  child: Text(loginSendCode),
                ),
                const SizedBox(height: 10),
                FilledButton(
                  // 触控目标 ≥44
                  style: FilledButton.styleFrom(minimumSize: const Size(48, 52)),
                  onPressed: _busy ? null : _submit,
                  child: Text(_busy ? loginBusy : loginSubmit),
                ),
                if (widget.needsSetup) ...[
                  const SizedBox(height: 16),
                  // 不许让人瞎试——服务端明说了就明说
                  Text(loginNeedsSetup, style: theme.textTheme.bodySmall, textAlign: TextAlign.center),
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
                // ⚠️ 屏上**只有"怎么拿到码"这条路**，**那串码一个字都不写**
                //    （主人 2026-09-21：验证码是掩码）
                Text(loginTempCodeNote, style: theme.textTheme.bodySmall, textAlign: TextAlign.center),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
