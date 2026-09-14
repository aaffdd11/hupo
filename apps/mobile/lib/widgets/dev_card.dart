// 开发者模式：实时罗列**后台在做什么**。
//
// 两个外壳，同一份内容：
//   · [DevPanel] —— 现在用的：装在"开发者模式"这个应用的容器里，
//     容器给标题栏，它自己只留一条状态行（正在做什么 + 收起）。
//   · [DevCard] —— 原来贴在对话页顶部的卡片，保留给单测和"要贴回页面"的场景。
//
// 注意：这里显示的都是**内部实现**（分类、专家、任务…），
// 属于开发者工具，不是产品界面的一部分。所以它只在开发者模式打开时
// 才作为桌面上的一个应用出现。

import 'package:flutter/material.dart';

import '../models/agent_status.dart';
import '../models/dev_step.dart';
import '../services/chat_controller.dart';

/// 应用容器里的开发者面板。
class DevPanel extends StatefulWidget {
  const DevPanel({super.key, required this.controller});

  final ChatController controller;

  @override
  State<DevPanel> createState() => _DevPanelState();
}

class _DevPanelState extends State<DevPanel> {
  bool _collapsed = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final steps = widget.controller.devSteps;
    final running = currentDevPhase(steps);

    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text('🛠', style: TextStyle(fontSize: 13)),
              const SizedBox(width: 6),
              // 现在在做什么（最有用的一眼信息）
              Expanded(
                child: Text(
                  running == null ? '空闲' : '正在：$running',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: running == null ? theme.hintColor : theme.colorScheme.primary,
                    fontWeight: running == null ? null : FontWeight.w600,
                  ),
                ),
              ),
              IconButton(
                tooltip: _collapsed ? '展开' : '收起',
                iconSize: 18,
                visualDensity: VisualDensity.compact,
                icon: Icon(_collapsed ? Icons.expand_more : Icons.expand_less),
                onPressed: () => setState(() => _collapsed = !_collapsed),
              ),
            ],
          ),
          if (!_collapsed) _DevDetails(controller: widget.controller),
        ],
      ),
    );
  }
}

/// 贴在页面顶部的开发者卡片（保留原样，给单测和"贴回页面"用）。
class DevCard extends StatefulWidget {
  const DevCard({super.key, required this.controller, required this.onClose});

  final ChatController controller;

  /// 关闭开发者模式。
  final VoidCallback onClose;

  @override
  State<DevCard> createState() => _DevCardState();
}

class _DevCardState extends State<DevCard> {
  bool _collapsed = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final steps = widget.controller.devSteps;

    // 当前正在跑的步骤：最后一个 start 还没有对应的 end
    final running = currentDevPhase(steps);

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: const Color(0xFF12181F),
        border: Border(bottom: BorderSide(color: theme.dividerColor, width: 0.5)),
      ),
      child: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── 标题行 ────────────────────────────────────────────
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 4, 4),
              child: Row(
                children: [
                  const Text('🛠', style: TextStyle(fontSize: 13)),
                  const SizedBox(width: 6),
                  Text('开发者模式',
                      style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(width: 8),
                  // 现在在做什么（最有用的一眼信息）
                  Expanded(
                    child: Text(
                      running == null ? '空闲' : '正在：$running',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: running == null ? theme.hintColor : theme.colorScheme.primary,
                        fontWeight: running == null ? null : FontWeight.w600,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: _collapsed ? '展开' : '收起',
                    iconSize: 18,
                    visualDensity: VisualDensity.compact,
                    icon: Icon(_collapsed ? Icons.expand_more : Icons.expand_less),
                    onPressed: () => setState(() => _collapsed = !_collapsed),
                  ),
                  IconButton(
                    tooltip: '关闭开发者模式',
                    iconSize: 18,
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.close),
                    onPressed: widget.onClose,
                  ),
                ],
              ),
            ),

            if (!_collapsed) _DevDetails(controller: widget.controller),
          ],
        ),
      ),
    );
  }
}

/// 推导"现在在跑哪一步"。
String? currentDevPhase(List<DevStep> steps) {
  final open = <String, DevStep>{};
  for (final s in steps) {
    if (s.status == DevStepStatus.start) {
      open[s.phase] = s;
    } else if (s.status == DevStepStatus.end || s.status == DevStepStatus.error) {
      open.remove(s.phase);
    }
  }
  if (open.isEmpty) return null;
  return open.entries.last.value.detail.isEmpty
      ? open.keys.last
      : '${open.keys.last}（${open.entries.last.value.detail}）';
}

/// 连接与上下文一行（两个外壳共用）。
String devContextLine(ChatController c) => [
      c.connected ? '连接 ✓' : '连接 ✗',
      '会话 ${c.conversationId}',
      'seq ${c.lastSeq}',
      '历史 ${c.timeline.length} 条',
    ].join(' ｜ ');

/// 两个外壳共用的内容（标题行/状态行之外的一切）。
class _DevDetails extends StatelessWidget {
  const _DevDetails({required this.controller});

  final ChatController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final c = controller;
    final steps = c.devSteps;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // ── 连接与上下文 ──────────────────────────────────
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
          child: Text(
            devContextLine(c),
            style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
          ),
        ),

        // ── agent 进程（一个会话一个常驻进程，150–200MB）──
        if (c.agentSnapshot != null) _AgentPanel(snapshot: c.agentSnapshot!),

        // ── 正在做的事 ───────────────────────────────────
        if (c.activeTasks.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final t in c.activeTasks.values)
                  Text(
                    '⏳ ${t.title}（已 ${DateTime.now().difference(t.startedAt).inSeconds}s）',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.tertiary,
                    ),
                  ),
              ],
            ),
          ),

        // ── 后台步骤流水（新的在上）──────────────────────
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 190),
          child: steps.isEmpty
              ? Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
                  child: Text('（还没有后台活动，发一句试试）',
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: theme.hintColor)),
                )
              : ListView.builder(
                  reverse: true, // 最新在最上面
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                  itemCount: steps.length,
                  itemBuilder: (context, i) {
                    final step = steps[steps.length - 1 - i];
                    return _StepRow(step: step);
                  },
                ),
        ),
      ],
    );
  }
}

/// agent 进程面板：几个进程、各自什么状态、吃多少内存。
///
/// 为什么值得占开发卡片的地方：一个会话一个常驻进程，每个 150–200MB。
/// 这东西**看不见就会失控** —— 内存涨、僵尸进程、反复重启，产品界面毫无征兆。
/// 所以这里要让"进程数 / 状态 / 内存 / 重启次数"一眼可见。
class _AgentPanel extends StatelessWidget {
  const _AgentPanel({required this.snapshot});

  final AgentSnapshot snapshot;

  static (Color, String) _stateStyle(String state, ThemeData theme) => switch (state) {
        'running' => (const Color(0xFF3FB950), '干活中'),
        'idle' => (theme.hintColor, '待命'),
        'starting' => (const Color(0xFFD29922), '正在起'),
        _ => (theme.colorScheme.error, '没了'),
      };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = snapshot;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text('🤖', style: TextStyle(fontSize: 11)),
              const SizedBox(width: 5),
              Text('agent 进程 ${s.agents.length} 个',
                  style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
              const SizedBox(width: 8),
              Text('内存 ${s.memoryLabel}',
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
              const SizedBox(width: 8),
              Text('服务已跑 ${s.serverUptimeLabel}',
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
            ],
          ),
          const SizedBox(height: 2),
          for (final a in s.agents) _AgentRow(agent: a, styleOf: _stateStyle),
        ],
      ),
    );
  }
}

class _AgentRow extends StatelessWidget {
  const _AgentRow({required this.agent, required this.styleOf});

  final AgentProcess agent;
  final (Color, String) Function(String, ThemeData) styleOf;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (color, label) = styleOf(agent.state, theme);
    final turn = agent.turnLabel;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 0.5),
      child: Row(
        children: [
          // 状态点：一眼看出在没在干活
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          SizedBox(
            width: 118,
            child: Text(
              agent.key,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall
                  ?.copyWith(fontFamily: 'monospace', fontSize: 11, color: color),
            ),
          ),
          SizedBox(
            width: 46,
            child: Text('$label${turn != null ? ' $turn' : ''}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(fontSize: 11, color: theme.hintColor)),
          ),
          SizedBox(
            width: 44,
            child: Text(agent.rssLabel,
                style: theme.textTheme.bodySmall?.copyWith(fontSize: 11, color: theme.hintColor)),
          ),
          SizedBox(
            width: 38,
            child: Text('活${agent.uptimeLabel}',
                style: theme.textTheme.bodySmall?.copyWith(fontSize: 11, color: theme.hintColor)),
          ),
          // 重启次数：一直涨说明它在反复崩，必须显眼
          if (agent.restarts > 1)
            Text('重启×${agent.restarts}',
                style: theme.textTheme.bodySmall
                    ?.copyWith(fontSize: 11, color: theme.colorScheme.error)),
          if (agent.lastError != null)
            Expanded(
              child: Text('  ${agent.lastError}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall
                      ?.copyWith(fontSize: 11, color: theme.colorScheme.error)),
            ),
        ],
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.step});

  final DevStep step;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (icon, color) = switch (step.status) {
      DevStepStatus.start => ('▶', theme.colorScheme.primary),
      DevStepStatus.end => ('✓', const Color(0xFF3FB950)),
      DevStepStatus.error => ('✗', theme.colorScheme.error),
      DevStepStatus.info => ('·', theme.hintColor),
    };
    final ms = step.ms != null ? '  ${step.ms}ms' : '';

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 14,
            child: Text(icon, style: TextStyle(fontSize: 11, color: color)),
          ),
          SizedBox(
            width: 62,
            child: Text(
              step.phase,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                fontFamily: 'monospace',
                fontSize: 11,
                color: color,
              ),
            ),
          ),
          Expanded(
            child: Text(
              '${step.detail}$ms',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(fontSize: 11, color: theme.hintColor),
            ),
          ),
        ],
      ),
    );
  }
}
