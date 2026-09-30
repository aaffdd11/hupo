// **注册制那张卡**（设置页里 · 契约 `docs/dev/147-APP-SQLITE.md` §二「册子」）。
//
// 主人原话：*「注册制，在设置里可以看到也可以关闭」*。
//
// ── 每一行两件事，都要看得见 ────────────────────────────────
//   ① **它想要什么**（人话，`grantWantWords`）；
//   ② **你给了没有**（一个开关，开＝`granted` 里有那一项）。
//
// ── 五条不许破 ────────────────────────────────────────────
//   ① 🔴 **声明了东西的才列**（`permissions` 非空）；一个都没有 ⇒ **一个像素都不画**；
//   ② 🔴 **老服务端没回 `granted` ⇒ 不给开关**（不知道的事不许画成一个假状态）；
//   ③ 🔴 **成了才改屏幕上的状态** —— 点下去先等回执，服务端**明说** ok 才把开关拨过去。
//      没成 ⇒ 开关**一动不动**，并如实说一句（服务端那句 `text`，没有就用兜底那句）。
//      **不许**先拨过去再回滚，也**不许**静默；
//   ④ ⚠️ **关掉只是"现在不给"**：这件事由文案说清（`settingsGrantsHint`）。
//   ⑤ ★ **"清空它存下来的东西"**（2026-10-01 做的 · `148` §五那笔欠账）：
//      它**只在那个 app 声明了存东西（`db`）时**才摆出来（摆给没存过东西的 app = 假按钮）；
//      🔴 **拿不回来** ⇒ 点一下**先过二次确认**，**只有确认之后**才发那一条请求；
//      🔴 它**跟开关无关**（存储关掉了也能清 —— "我的东西我拿走"）；
//      ⚠️ 等回执的时候那颗按钮按不动（免得连点两下）。
//
// ⚠️ 楼层闸：这一份在 `widgets/` ⇒ **只许看 `models/`**（结果类型 `GrantOutcome` /
//    `ClearOutcome` 与纯逻辑都住在 `models/app_grants.dart`，同 `key_outcome.dart` 那条先例）。

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

/// ★ **"清空它存下来的东西"**那颗按钮的 key（每个 app 一颗）。
Key appDbClearKey(String appId) => ValueKey('clear-db:$appId');

/// 清完（成 / 没成）在那一块下面那句话的 key。
Key appDbClearNoteKey(String appId) => ValueKey('clear-db-note:$appId');

/// 确认层两个按钮的 key（判据要**像用户那样点**它们）。
const ValueKey<String> appDbClearNoKey = ValueKey('clear-db:confirm-no');
const ValueKey<String> appDbClearYesKey = ValueKey('clear-db:confirm-yes');

/// 设置页里那张「小程序要用的东西」。
class AppGrantsCard extends StatefulWidget {
  const AppGrantsCard({super.key, required this.apps, this.onGrant, this.onClear});

  /// 「我的小程序」那一份清单（`/api/apps` 回来的，含 `permissions` 与 `granted`）。
  final List<MiniApp> apps;

  /// **替他去说一声**（`POST /api/app-grant`）。
  ///
  /// ⚠️ `null` = 这一条路没接上 ⇒ **不给开关**（不给假按钮那条纪律）。
  final Future<GrantOutcome> Function(String id, String permission, bool allow)?
  onGrant;

  /// ★ **清空它存下来的东西**（`POST /api/app-db-clear`）。
  ///
  /// ⚠️ `null` = 这一条路没接上 ⇒ **不给那颗按钮**（同"不给假按钮"那条纪律）。
  final Future<ClearOutcome> Function(String id)? onClear;

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

  /// 正在等**清空**回执的那几个 app（等的时候那颗按钮按不动）。
  final Set<String> _clearing = {};

  /// 清完之后那块下面那句人话（`appId` → 成/没成那句）；**空 = 没点过**。
  final Map<String, String> _clearNote = {};

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

  /// ★ **清空它存下来的东西**：**先二次确认**，只有确认之后才发那一条请求。
  ///
  /// 🔴 那一步**拿不回来**：反过来的话（先发再问）用户是"点了才知道会删"，
  ///    而这一下连回收站都没有（`147` §五）。
  Future<void> _confirmClear(MiniApp app) async {
    final cb = widget.onClear;
    if (cb == null) return;
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        // ⚠️ `scrollable`：字放到 3.1 倍时那句话＋两个按钮最容易顶出屏幕
        //    （同删除确认那一层的摆法）。
        scrollable: true,
        title: const Text(settingsClearDbTitle),
        content: const Text(settingsClearDbWhat),
        actions: [
          TextButton(
            key: appDbClearNoKey,
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text(settingsClearDbNo),
          ),
          FilledButton(
            key: appDbClearYesKey,
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text(settingsClearDbYes),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;
    setState(() {
      _clearing.add(app.id);
      _clearNote.remove(app.id);
    });
    final out = await cb(app.id);
    if (!mounted) return;
    // 🔴 只有服务端**明说成了**才说"清掉了"；其余一律照它那句人话（没有就用兜底）。
    setState(() {
      _clearing.remove(app.id);
      _clearNote[app.id] = switch (out) {
        ClearOk() => settingsClearDbDone,
        ClearUnauthorized() => clearFailedLine(const ClearFailed('')),
        ClearFailed() => clearFailedLine(out),
      };
    });
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

  /// 一个 app 那一小块：**名字 ＋ 它想要的那几样（各带一个开关）**，
  /// 声明了存东西的话再带**那颗"清空它存下来的东西"**。
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
          // 🔴 只在**声明了存东西**、而且这条路接上了的时候才摆（不给假按钮）。
          if (canClearStored(app) && widget.onClear != null) ...[
            const SizedBox(height: d.gapXs),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                key: appDbClearKey(app.id),
                // 等回执的时候按不动（免得连点两下）。
                onPressed: _clearing.contains(app.id) ? null : () => _confirmClear(app),
                style: TextButton.styleFrom(minimumSize: const Size(48, 44)),
                child: const Text(settingsClearDbAction),
              ),
            ),
          ],
          // 清完之后那句话（成 / 没成各一句；没点过时一个字都不画）。
          if (_clearNote[app.id] != null) ...[
            const SizedBox(height: d.gapXs),
            Text(
              _clearNote[app.id]!,
              key: appDbClearNoteKey(app.id),
              style: t.textTheme.bodySmall?.copyWith(color: d.muted),
            ),
          ],
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
