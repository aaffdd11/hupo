// agent 进程状态（**开发者模式**专用）。
//
// 为什么需要它：一个会话 = 一个常驻的真 agent 进程，每个 150–200MB。
// 这东西**看不见就会失控** —— 内存涨、僵尸进程、反复重启，产品界面上一点征兆都没有。
// 所以开发者模式里要能实时看到：几个进程、各自在干什么、吃多少内存、重启了几次。
//
// 跟 DevStep（流水）分开：那是"按时间发生了什么"，这是"此刻是什么样"。
// 快照只有"现在"有意义，所以服务端只在现场推、不补发（见 PROTOCOL.md）。

/// 一个 agent 进程此刻的样子。
class AgentProcess {
  const AgentProcess({
    required this.key,
    required this.sessionId,
    this.pid,
    this.state = 'down',
    this.rssBytes,
    this.spawnedAt,
    this.turnStartedAt,
    this.restarts = 0,
    this.lastError,
  });

  /// 我们这边的会话键（`c_main`、`debug:c_main`）。
  final String key;

  /// DSH 那边的会话 id（带启动标记，用来分辨"重启后是不是同一个会话"）。
  final String sessionId;

  final int? pid;

  /// starting（起不来/正在起） / idle（待命） / running（正在干活） / down（没了）
  final String state;

  final int? rssBytes;
  final int? spawnedAt;

  /// 这一轮是什么时候开始的（running 时才有）。
  final int? turnStartedAt;

  /// 起过几次。一直涨说明它在反复崩。
  final int restarts;

  final String? lastError;

  bool get isRunning => state == 'running';
  bool get isAlive => state == 'running' || state == 'idle' || state == 'starting';

  /// 内存的可读写法（读不到就 "—"，**不是 0** —— 0 会被误读成"很省"）。
  String get rssLabel {
    final b = rssBytes;
    if (b == null) return '—';
    if (b < 1024 * 1024) return '${(b / 1024).round()}KB';
    return '${(b / 1024 / 1024).round()}MB';
  }

  /// 已经活了多久。
  String get uptimeLabel {
    final t = spawnedAt;
    if (t == null) return '—';
    final d = DateTime.now().millisecondsSinceEpoch - t;
    if (d < 60000) return '${(d / 1000).round()}s';
    if (d < 3600000) return '${(d / 60000).floor()}m';
    return '${(d / 3600000).toStringAsFixed(1)}h';
  }

  /// 这一轮已经跑了多久（running 才有意义）。
  String? get turnLabel {
    final t = turnStartedAt;
    if (t == null) return null;
    final d = DateTime.now().millisecondsSinceEpoch - t;
    return d < 60000 ? '${(d / 1000).round()}s' : '${(d / 60000).floor()}m';
  }

  static List<AgentProcess> listFrom(Object? raw) {
    if (raw is! List) return const [];
    final out = <AgentProcess>[];
    for (final e in raw) {
      if (e is! Map) continue;
      out.add(AgentProcess(
        key: '${e['key'] ?? ''}',
        sessionId: '${e['sessionId'] ?? ''}',
        pid: e['pid'] is int ? e['pid'] as int : null,
        state: '${e['state'] ?? 'down'}',
        rssBytes: e['rssBytes'] is int ? e['rssBytes'] as int : null,
        spawnedAt: e['spawnedAt'] is int ? e['spawnedAt'] as int : null,
        turnStartedAt: e['turnStartedAt'] is int ? e['turnStartedAt'] as int : null,
        restarts: e['restarts'] is int ? e['restarts'] as int : 0,
        lastError: e['lastError'] is String ? e['lastError'] as String : null,
      ));
    }
    return out;
  }
}

/// 某一刻的全部 agent 进程。
class AgentSnapshot {
  const AgentSnapshot({
    required this.agents,
    this.totalRssBytes = 0,
    this.uptimeMs,
    this.at,
  });

  final List<AgentProcess> agents;
  final int totalRssBytes;
  final int? uptimeMs;

  /// 服务端发这份快照的时刻。
  final DateTime? at;

  int get running => agents.where((a) => a.isRunning).length;

  String get memoryLabel {
    if (totalRssBytes < 1024 * 1024) return '${(totalRssBytes / 1024).round()}KB';
    return '${(totalRssBytes / 1024 / 1024).round()}MB';
  }

  /// 服务端自从启动跑了多久。
  String get serverUptimeLabel {
    final u = uptimeMs;
    if (u == null) return '—';
    if (u < 60000) return '${(u / 1000).round()}s';
    if (u < 3600000) return '${(u / 60000).floor()}m';
    return '${(u / 3600000).toStringAsFixed(1)}h';
  }

  static AgentSnapshot? tryParse(Map<String, dynamic> json) {
    if (json['type'] != 'dev/agents') return null;
    final at = json['at'];
    return AgentSnapshot(
      agents: AgentProcess.listFrom(json['agents']),
      totalRssBytes: json['totalRssBytes'] is int ? json['totalRssBytes'] as int : 0,
      uptimeMs: json['uptimeMs'] is int ? json['uptimeMs'] as int : null,
      at: at is int ? DateTime.fromMillisecondsSinceEpoch(at) : null,
    );
  }
}
