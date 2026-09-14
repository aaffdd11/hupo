// 开发事件：**后台在做什么**。
//
// 与产品事件分开的原因（见 PROTOCOL.md）：
// 这些描述的是内部实现（分类、专家查证、检索、任务…），产品界面不依赖它们。
// 只有开发者模式（`?dev=1`）才会订阅到，将来关掉开发者模式时产品协议一行不用改。

/// 开发步骤的三态。
enum DevStepStatus { start, end, error, info }

/// 后台的一个步骤。
class DevStep {
  DevStep({
    required this.phase,
    required this.status,
    this.detail = '',
    this.ms,
    DateTime? at,
  }) : at = at ?? DateTime.now();

  /// 步骤名：turn / classify / receiver / expert / feedback / listener / task / …
  final String phase;

  final DevStepStatus status;

  /// 人类可读的说明（"专家查证（2 个视角）"）。
  final String detail;

  /// 耗时（仅 end/error 有）。
  final int? ms;

  final DateTime at;

  /// 从线格式解析；不是开发事件则返回 null。
  static DevStep? tryParse(Map<String, dynamic> json) {
    if (json['type'] != 'dev/step') return null;
    final phase = json['phase'];
    if (phase is! String) return null;
    return DevStep(
      phase: phase,
      status: switch (json['status']) {
        'start' => DevStepStatus.start,
        'end' => DevStepStatus.end,
        'error' => DevStepStatus.error,
        _ => DevStepStatus.info,
      },
      detail: json['detail'] as String? ?? '',
      ms: json['ms'] as int?,
    );
  }
}
