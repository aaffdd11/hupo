// **「发现」**：别人发出来的小程序（乙-3 · 契约 `docs/dev/59-USER-APPS.md` §四）。
//
// 主人：*"我还需要一个发现按钮，可以看到其他人发布出来的小程序"* +
//      *"一切都是用户自己的对话中实现，包括发布。"*
// ⇒ 🔴 **这一屏是只读的**：它只**给你看**有哪些 —— 装 / 发 / 撤 / 授权**全部在对话里**做
//    （屏幕上**没有**"装"按钮，而且**明说**这件事；不说的话用户会在这儿找按钮，
//     找不到就是"点了没反应"那种失望）。
//
// ⚠️ 形状与 `SettingsScreen` 同规矩：**不画 `Scaffold` / `AppBar`**
//    （顶栏由小程序容器给），整屏 `ListView`（五档字号下能滚，不溢出）。

import 'package:flutter/material.dart';

import '../models/app_spec.dart';
import '../models/app_words.dart';
import '../models/design.dart' as d;
import '../widgets/mini_app_icons.dart';

class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key, required this.load, this.refreshToken = 0});

  /// 去拉「发现」清单（由上层给：**这一层不认识网络**）。
  final Future<List<DiscoverApp>> Function() load;

  /// 变了就重拉（上层在"装上了"之类的事件里 +1）。
  final int refreshToken;

  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends State<DiscoverScreen> {
  List<DiscoverApp>? _apps; // null = 还没拉到
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant DiscoverScreen old) {
    super.didUpdateWidget(old);
    if (old.refreshToken != widget.refreshToken) _load();
  }

  Future<void> _load() async {
    final got = await widget.load();
    if (!mounted) return;
    setState(() {
      _apps = got;
      _failed = got.isEmpty && _failed; // 空不算失败（现在真的可能没人发）
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final apps = _apps;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: ListView(
          padding: const EdgeInsets.symmetric(horizontal: d.gapL, vertical: d.gapL),
          children: [
            // ⚠️ **先说清这一屏是只读的**（免得他在这儿找按钮）
            Text(
              discoverHowTo,
              style: t.textTheme.bodyMedium?.copyWith(color: d.muted, height: 1.6),
            ),
            const SizedBox(height: d.gapM),
            if (apps == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: d.gapL),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (apps.isEmpty)
              // 空态：**实话**（"现在还没有"不等于"坏了"）
              Padding(
                padding: const EdgeInsets.symmetric(vertical: d.gapL),
                child: Text(
                  discoverEmpty,
                  style: t.textTheme.bodyLarge?.copyWith(color: d.muted),
                ),
              )
            else
              for (final a in apps)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Card(
                    child: Padding(
                      padding: const EdgeInsets.all(d.gapM),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(miniAppIconFor(a.icon), size: 28, color: d.ink),
                          const SizedBox(width: d.gapM),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(a.title, style: t.textTheme.titleSmall),
                                const SizedBox(height: 4),
                                Text(
                                  '${discoverByAuthor(a.author)} · ${discoverVersion(a.version)}',
                                  style: t.textTheme.bodySmall?.copyWith(color: d.muted),
                                ),
                                // 🔴 **它要什么，装上之前就看得见**（如实告知）
                                if (a.permissions.contains('ask'))
                                  Padding(
                                    padding: const EdgeInsets.only(top: 4),
                                    child: Text(
                                      discoverNeedsAsk,
                                      style: t.textTheme.bodySmall?.copyWith(color: d.accent),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
          ],
        ),
      ),
    );
  }
}
