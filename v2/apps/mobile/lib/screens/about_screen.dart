// 「关于」页。手册 **D3.3**（按设备如实说）· H1（"做一半比不做更坏"）。
//
// ⚠️ **这一页存在的理由只有一个**：H1 点名要避免的那个形态是
//    "**字放大了，但还是打不了字**"。
//    光把字号做对（第 ⑤ 条那两样）**不算做完**——还得**如实告诉他这台设备上行不行**。
//
// ⚠️ 所以这一页**不放版本号、不放许可、不放"感谢使用"**——
//    只放"跟他有没有关系"的几句话（`models/about_facts.dart`）。
//
// ⚠️ 文案**不在这儿**（在 `models/about_facts.dart`）：那样它才进得了
//    `test/unit` 的**禁用词硬闸**。界面这边只负责摆。

import 'package:flutter/material.dart';

import '../models/about_facts.dart';
import '../services/hearing.dart' as hearing_service;

class AboutScreen extends StatelessWidget {
  const AboutScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // ★ **按这台设备说**（D3.3）：开得了麦就说网页那套，开不了就说另一套。
    //   ⚠️ 原来这里写死了"我们自己没有另外做一个话筒" —— 那句话现在已经是假的。
    final facts = aboutFactsFor(canHear: hearing_service.canHear);
    return Scaffold(
      appBar: AppBar(title: const Text('关于')),
      body: Center(
        child: ConstrainedBox(
          // 内容列限宽，同主界面（平板上一行七十个字没人读）
          constraints: const BoxConstraints(maxWidth: 760),
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            itemCount: facts.length,
            itemBuilder: (context, i) {
              final f = facts[i];
              return Padding(
                // ⚠️ 间距不许用"写死的高度"包住字（D3.5）：这里是**字外面的留白**，
                //    字长多大它都不挡。真正的容器一律跟字算。
                padding: const EdgeInsets.only(bottom: 28),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(f.title, style: theme.textTheme.titleMedium),
                    const SizedBox(height: 8),
                    for (final line in f.lines)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Text(line, style: theme.textTheme.bodyMedium),
                      ),
                  ],
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}
