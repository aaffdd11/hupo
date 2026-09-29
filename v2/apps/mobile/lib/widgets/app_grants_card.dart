// **注册制那张卡**（设置页里 · 契约 `docs/dev/147-APP-SQLITE.md` §二「册子」）。
//
// 主人原话：*「注册制，在设置里可以看到也可以关闭」*。
//
// ── 每一行两件事，都要看得见 ────────────────────────────────
//   ① **它想要什么**（人话，`grantWantWords`）；
//   ② **你给了没有**（一个开关，开＝`granted` 里有那一项）。
//
// ── 四条不许破 ────────────────────────────────────────────
//   ① 🔴 **声明了东西的才列**（`permissions` 非空）；一个都没有 ⇒ **一个像素都不画**；
//   ② 🔴 **老服务端没回 `granted` ⇒ 不给开关**（不知道的事不许画成一个假状态）；
//   ③ 🔴 **成了才改屏幕上的状态** —— 点下去先等回执，服务端**明说** ok 才把开关拨过去。
//      没成 ⇒ 开关**一动不动**，并如实说一句（服务端那句 `text`，没有就用兜底那句）。
//      **不许**先拨过去再回滚，也**不许**静默；
//   ④ ⚠️ **关掉只是"现在不给"**：这件事由文案说清（`settingsGrantsHint`），
//      界面上**没有**"删掉 / 清空"那种按钮（`147` §五：清空那颗按钮没做）。
//
// ⚠️ 楼层闸：这一份在 `widgets/` ⇒ **只许看 `models/`**（结果类型 `GrantOutcome`
//    与纯逻辑都住在 `models/app_grants.dart`，同 `key_outcome.dart` 那条先例）。

import 'package:flutter/material.dart';

import '../models/app_grants.dart';
import '../models/app_spec.dart';
import '../models/design.dart' as d;
import '../models/space_words.dart';

/// 那张卡自己的 key（判据要指名道姓地找它：**没有声明的东西时它不该在树上**）。
const ValueKey<String> appGrantsCardKey = ValueKey('settings:grants');

/// 一个开关的 key（`appId` + 协议里那个名字）。
Key grantSwitchKey(String appId, String permission) =>
    ValueKey('grant:$appId:$permission');

/// 设置页里那张「小程序要用的东西」。
class AppGrantsCard extends StatefulWidget {
  const AppGrantsCard({super.key, required this.apps, this.onGrant});

  /// 「我的小程序」那一份清单（`/api/apps` 回来的，含 `permissions` 与 `granted`）。
  final List<MiniApp> apps;

  /// **替他去说一声**（`POST /api/app-grant`）。
  ///
  /// ⚠️ `null` = 这一条路没接上 ⇒ **不给开关**（不给假按钮那条纪律）。
  final Future<GrantOutcome> Function(String id, String permission, bool allow)?
  onGrant;

  @override
  State<AppGrantsCard> createState() => _AppGrantsCardState();
}

class _AppGrantsCardState extends State<AppGrantsCard> {
  /// **服务端明说成了**的那几个（`'$id|$permission'` → 现在给不给）。
  ///
  /// ⚠️ 只在 [GrantOk] 之后写进来（"成了才改屏幕上的状态"）；
  ///    它盖在 `granted` 那份数据上，所以父层重建也不会把刚改好的拨回去。
  final Map<String, bool> _done = {};

  /// 正在等回执的那几个（等的时候那颗开关按不动 —— 免得连点两下）。
  final Set<String> _busy = {};

  /// 上一次没成时那句人话（空串 = 没有话要说）。
  String _error = '';

  bool _on(MiniApp app, String permission) {
    final local = _done[_key(app.id, permission)];
    if (local != null) return local;
    return grantedOf(app)?.contains(permission) ?? false;
  }

  static String _key(String id, String permission) => '$id|$permission';

  Future<void> _toggle(MiniApp app, String permission, bool allow) async {
    final cb = widget.onGrant;
    if (cb == null) return;
    final key = _key(app.id, permission);
    setState(() {
      _busy.add(key);
      _error = '';
    });
    final out = await cb(app.id, permission, allow);
    if (!mounted) return;
    switch (out) {
      case GrantOk(:final permissions):
        setState(() {
          _busy.remove(key);
          // 服务端带了清单就照它画；没带就按**他刚点的那一下**记账（`nextGranted`）。
          _done[key] = permissions?.contains(permission) ?? allow;
        });
      case GrantUnauthorized():
        // 令牌不行是另一件事（该回登录页）—— 屏幕上一个字都不许说成"给了"。
        setState(() {
          _busy.remove(key);
          _error = grantFailedLine(const GrantFailed(''));
        });
      case GrantFailed():
        // 🔴 没成 ⇒ 开关**一动不动**，如实说一句（服务端那句人话优先）。
        setState(() {
          _busy.remove(key);
          _error = grantFailedLine(out);
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final list = wantsApps(widget.apps);
    // 🔴 **一个都没声明 ⇒ 这张卡一个像素都不画**（不是画一个空框）。
    if (list.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: d.gapS),
      child: Card(
        key: appGrantsCardKey,
        child: Padding(
          padding: const EdgeInsets.all(d.gapM),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                settingsGrantsTitle,
                style: t.textTheme.titleSmall?.copyWith(
                  color: d.ink,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: d.gapXs),
              Text(
                settingsGrantsHint,
                style: t.textTheme.bodySmall?.copyWith(color: d.muted),
              ),
              for (final a in list) _appBlock(a),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: d.gapS),
                Text(
                  _error,
                  key: const ValueKey('settings:grants:error'),
                  style: t.textTheme.bodySmall?.copyWith(color: d.accent),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// 一个 app 那一小块：**名字 ＋ 它想要的那几样（各带一个开关）**。
  Widget _appBlock(MiniApp app) {
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: d.gapM),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            app.title,
            style: t.textTheme.titleSmall?.copyWith(
              color: d.ink,
              fontWeight: FontWeight.w600,
            ),
          ),
          for (final p in app.permissions) _wantRow(app, p),
        ],
      ),
    );
  }

  /// 一样东西那一行：左边人话，右边开关（**不知道就不画开关**）。
  ///
  /// ⚠️ 文字那一格用 [Expanded]：字放到 3.1 倍时它折行，**绝不横向溢出**（D3.5）。
  Widget _wantRow(MiniApp app, String permission) {
    final t = Theme.of(context);
    final on = grantSwitchOn(app, permission);
    final canTap = on != null && widget.onGrant != null;
    final busy = _busy.contains(_key(app.id, permission));
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: Text(
            grantWantWords(permission),
            style: t.textTheme.bodyMedium?.copyWith(color: d.ink),
          ),
        ),
        if (canTap)
          Switch(
            key: grantSwitchKey(app.id, permission),
            value: _on(app, permission),
            // 等回执的时候按不动（但不画成"已经给了"）。
            onChanged: busy ? null : (v) => _toggle(app, permission, v),
          ),
      ],
    );
  }
}
