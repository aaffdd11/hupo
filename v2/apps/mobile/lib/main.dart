// 琥珀 · 输入法探针
//
// **这不是产品界面，是一个探针。** 它只验三件事，验完就删：
//
//   1. **中文输入法在 Flutter web 里能不能正常工作**
//      （预编辑串、上屏、光标）——语音输入走的也是同一条路
//   2. **输入法自带的语音**能不能把字送进这个输入框
//   3. 整条链（浏览器 → nginx → stcp 隧道 → 本机服务）通不通
//
// 为什么先做它：手册 v1.1 记了一条风险——
// **"打不了字的人能用"这个结论，整个压在"Flutter web 里的中文输入法能正常工作"上。**
// Flutter web 的文本输入在中文 IME 上历史性地出现过合成/光标问题，
// 而这一点**在本地 mock 上永远测不出来**，必须真设备、真输入法。
//
// ⚠️ 所以这一页**故意把中间状态暴露出来**（拼写中 / 已提交 / 事件流水），
//    而不是只放一个输入框。出了问题要能一眼看出卡在哪一步。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

void main() => runApp(const ProbeApp());

class ProbeApp extends StatelessWidget {
  const ProbeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '琥珀 · 输入法探针',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF4A90D9),
      ),
      home: const ProbePage(),
    );
  }
}

class ProbePage extends StatefulWidget {
  const ProbePage({super.key});

  @override
  State<ProbePage> createState() => _ProbePageState();
}

class _ProbePageState extends State<ProbePage> {
  final _controller = TextEditingController();

  String _server = '（还没检查）';
  String _sendResult = '（还没发过）';

  int _changedCount = 0;
  int _commitCount = 0;
  List<String> _events = [];

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onValueChanged);
    _checkServer();
  }

  @override
  void dispose() {
    _controller.removeListener(_onValueChanged);
    _controller.dispose();
    super.dispose();
  }

  /// 每一次 value 变化都记一笔——**输入法的合成过程就是靠这个看出来的**。
  void _onValueChanged() {
    final v = _controller.value;
    // 「拼写中」= composing 是一个有效且非折叠的区间。
    // 中文输入法在选字之前会一直停在这个状态里。
    final isComposing = v.composing.isValid && !v.composing.isCollapsed;
    setState(() {
      _changedCount += 1;
      if (!isComposing) _commitCount += 1;
      _events.insert(
        0,
        '${isComposing ? "拼写中" : "已提交"}  text="${v.text}"  sel=${v.selection}  comp=${v.composing}',
      );
      if (_events.length > 40) _events.removeLast();
    });
  }

  Future<void> _checkServer() async {
    setState(() => _server = '检查中…');
    try {
      final r = await http.get(Uri.parse('/api/version')).timeout(const Duration(seconds: 8));
      setState(() => _server = 'HTTP ${r.statusCode}  ${r.body}');
    } catch (e) {
      setState(() => _server = '✗ 连不上：$e');
    }
  }

  Future<void> _send() async {
    setState(() => _sendResult = '发送中…');
    try {
      final r = await http
          .post(
            Uri.parse('/api/say'),
            headers: {'content-type': 'application/json'},
            body: jsonEncode({
              'messageId': 'u_probe_${DateTime.now().millisecondsSinceEpoch}',
              'text': _controller.text,
              'clientAt': DateTime.now().millisecondsSinceEpoch,
            }),
          )
          .timeout(const Duration(seconds: 10));
      setState(() => _sendResult = 'HTTP ${r.statusCode}  ${r.body}');
    } catch (e) {
      setState(() => _sendResult = '✗ 失败：$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = _controller.text;
    return Scaffold(
      appBar: AppBar(title: const Text('琥珀 · 输入法探针')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _card('① 链子通不通', [
            Text('服务器：$_server'),
            const SizedBox(height: 8),
            FilledButton.tonal(onPressed: _checkServer, child: const Text('重新检查')),
          ]),
          _card('② 输入法（中文 / 语音）', [
            const Text(
              '点下面的框，用你的输入法打字——包括输入法的语音。\n'
              '下面会把「拼写中 / 已提交」的过程显示出来。',
              style: TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _controller,
              maxLines: 3,
              minLines: 1,
              textInputAction: TextInputAction.newline,
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                hintText: '在这里输入…',
              ),
            ),
            const SizedBox(height: 12),
            Text('当前文本：「$text」'),
            Text('长度：${text.length}（码点 ${text.runes.length}）'),
            Text('onChanged 次数：$_changedCount'),
            Text('已提交次数：$_commitCount'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                OutlinedButton(
                  onPressed: () {
                    _controller.clear();
                    setState(() {
                      _changedCount = 0;
                      _commitCount = 0;
                      _events = [];
                    });
                  },
                  child: const Text('清空计数'),
                ),
                OutlinedButton(
                  onPressed: () => setState(() => _events = []),
                  child: const Text('清空流水'),
                ),
              ],
            ),
          ]),
          _card('③ 发给服务器', [
            const Text('现在服务是 fail-closed（还没设密码），所以会回 503——那正是对的。'),
            const SizedBox(height: 8),
            FilledButton(
              onPressed: text.trim().isEmpty ? null : _send,
              child: const Text('发送'),
            ),
            const SizedBox(height: 8),
            Text('服务器回：$_sendResult'),
          ]),
          _card(
            '④ 事件流水（倒序，最近 40 条）',
            _events.isEmpty
                ? [const Text('（还没有。去上面输入框里打字）')]
                : _events
                    .map((e) => Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Text(
                            e,
                            style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
                          ),
                        ))
                    .toList(),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 8, bottom: 32),
            child: Text(
              '这个页面只回答一个问题：\n'
              '「不会拼音的人，能不能靠输入法（含语音）在这里把话打出来、发出去？」\n'
              '如果不能，后面所有界面都不用做了。',
              style: theme.textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }

  Widget _card(String title, List<Widget> children) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            const SizedBox(height: 8),
            ...children,
          ],
        ),
      ),
    );
  }
}
