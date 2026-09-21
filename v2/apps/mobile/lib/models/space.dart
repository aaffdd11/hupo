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
  const SpaceInfo({this.kind = 'local', this.state = 'ready', this.hasKey = false});

  /// `local` = 主人那种（本机那份，没有单独一台）；`tenant` = 有自己一台。
  final String kind;

  /// `preparing` / `ready`（别的值一律当 `ready` —— 认不出别把人挡住）。
  final String state;

  /// 他那台上有没有填过钥匙。
  final bool hasKey;

  bool get isTenant => kind == 'tenant';
  bool get ready => state == 'ready';

  /// **宽容解析**：不是对象 / 缺字段 / 字段类型不对 ⇒ 一律退回"就绪的本机那种"。
  factory SpaceInfo.fromJson(Object? raw) {
    if (raw is! Map) return const SpaceInfo();
    final kind = raw['kind'];
    final state = raw['state'];
    final hasKey = raw['hasKey'];
    return SpaceInfo(
      kind: kind == 'tenant' ? 'tenant' : 'local',
      state: state == 'preparing' ? 'preparing' : 'ready',
      hasKey: hasKey == true,
    );
  }

  Map<String, dynamic> toJson() => {'kind': kind, 'state': state, 'hasKey': hasKey};
}

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
