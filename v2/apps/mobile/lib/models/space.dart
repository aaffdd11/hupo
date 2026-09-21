// **"我那台到哪一步了"** —— 登录之后该进哪一屏（契约 `docs/dev/38-ISOLATION-SPLIT.md` §8.3）。
//
// 服务端在登录回执里给一个 `space`（也会在 `GET /api/space` 上给一遍），形状是：
//
//     {"kind":"local"}                                  主人：本机那份，直接聊
//     {"kind":"tenant","state":"preparing"}             他那台还没通
//     {"kind":"tenant","state":"ready","hasKey":false}  通了，但还没填钥匙
//     {"kind":"tenant","state":"ready","hasKey":true}   可以聊
//
// ── 三条纪律 ──────────────────────────────────────────────
//   1. 🔴 **缺字段 / 认不出来 ⇒ 按"就绪"处理**（= 直接进聊天）——
//      老服务端没有这个字段，而**不许把老用户挡在门外**（协议字段一旦上线就冻结）；
//   2. 🔴 **不许假进度**：这里只有"到哪一步了"三个状态，**没有百分比**这种东西
//      （`38` §8.3 点名过：不许假进度条）；
//   3. 纯函数 ⇒ 进 `test/unit`（界面那一层只按它画）。

/// 登录之后该看见哪一屏。
enum SpaceScreen {
  /// 直接进聊天。
  chat,

  /// **"正在给你开一个只属于自己的空间"**。
  waiting,

  /// **"还差最后一步：填你自己的钥匙"**。
  key,
}

/// 服务端说的"我那台到哪一步了"。**认不出来就当"就绪"**（见纪律 1）。
class SpaceInfo {
  const SpaceInfo({
    this.kind = 'local',
    this.state = 'ready',
    this.hasKey = false,
    this.steps = const [],
  });

  /// `local` = 主人那种（本机那份，没有单独一台）；`tenant` = 有自己一台。
  final String kind;

  /// `queued`（没人会来开）/ `provisioning`（正在给他开一台）/ `starting`（他那台在起）
  /// / `ready` / `full`（**给不了**：满了或者建失败了）。
  /// ⚠️ **只有 `ready` 才算就绪** —— 别的值一律**不许**当就绪
  ///    （认不出就进聊天 = 把他送进一个还没准备好的世界）。
  final String state;

  /// **开空间那三步**（真进度：`assigned` / `starting` / `ready`）。
  /// ⚠️ 缺字段 ⇒ 空列表（老服务端）⇒ 界面**只显示那句话**，不编步骤。
  final List<SpaceStep> steps;

  /// 他那台上有没有填过钥匙。
  final bool hasKey;

  bool get isTenant => kind == 'tenant';
  bool get ready => state == 'ready';

  /// 他这一步是不是"连队都没排上"（池子里没有空位）—— ⚠️ 那不是"马上就好"，别骗他。
  bool get queued => state == 'queued';

  /// 正在**给他开一台**（申请已经被受理）。
  /// ⚠️ 与 `starting` 的区别是**服务端真的知道的事实**：那张申请还在特权侧手里。
  bool get provisioning => state == 'provisioning';

  /// 🔴 **给不了**（满了 / 建失败了）—— 这一档**必须明说**。
  ///
  /// 这一档是这次专门加出来的：原来"排队"与"永远排不上"是**同一个词**
  /// （`queued`），屏幕上没有一个字说它会永远等 ——
  /// 那正是项目最忌的"**看着在动、其实到不了**"。
  bool get full => state == 'full';

  /// 还要不要接着自己问下去。**给不了的时候就不必再等了**（省电，也不给假希望）。
  bool get keepsChanging => isTenant && !ready && !full;

  /// **宽容解析**：不是对象 / 缺字段 / 字段类型不对 ⇒ 一律退回"就绪的本机那种"。
  factory SpaceInfo.fromJson(Object? raw) {
    if (raw is! Map) return const SpaceInfo();
    final kind = raw['kind'];
    final state = raw['state'];
    final hasKey = raw['hasKey'];
    return SpaceInfo(
      kind: kind == 'tenant' ? 'tenant' : 'local',
      // ⚠️ **缺 `state` 才当就绪**（老服务端兼容）；**给了 `state` 就照它算** ——
      //    认不出的值**不许**当就绪（那会把人送进一个还没准备好的世界）。
      state: (state is String && state.isNotEmpty) ? state : 'ready',
      hasKey: hasKey == true,
      steps: parseSteps(raw['steps']),
    );
  }

  Map<String, dynamic> toJson() => {
        'kind': kind,
        'state': state,
        'hasKey': hasKey,
        'steps': steps.map((e) => e.toJson()).toList(),
      };
}

/// 开空间那三步里的一步。**只有"做完了没有"**，**没有百分比**。
class SpaceStep {
  const SpaceStep({required this.step, required this.done});
  final String step;
  final bool done;

  /// 宽容解析：认不出的名字 ⇒ 丢掉（**不许编一步出来**）。
  static List<SpaceStep> parseList(Object? raw) {
    if (raw is! List) return const [];
    final out = <SpaceStep>[];
    for (final e in raw) {
      if (e is! Map) continue;
      final name = e['step'];
      if (name is! String || !kKnownSteps.contains(name)) continue;
      out.add(SpaceStep(step: name, done: e['done'] == true));
    }
    return out;
  }

  Map<String, dynamic> toJson() => {'step': step, 'done': done};
}

/// 服务端会说的那三步（**认不出的丢掉** —— 见 `parseList`）。
const Set<String> kKnownSteps = {'assigned', 'starting', 'ready'};

List<SpaceStep> parseSteps(Object? raw) => SpaceStep.parseList(raw);

/// **该进哪一屏**。纯函数。
///
/// `keySent` = 这一刻刚把钥匙填完（还没等下一次问回来的结果）——
/// 那时候不该把人退回"填钥匙"那一屏（他自己刚填完，退回去像是在说他没填）。
SpaceScreen spaceScreenFor(SpaceInfo space, {bool keySent = false}) {
  if (!space.isTenant) return SpaceScreen.chat;
  if (!space.ready) return SpaceScreen.waiting;
  if (space.hasKey || keySent) return SpaceScreen.chat;
  return SpaceScreen.key;
}
