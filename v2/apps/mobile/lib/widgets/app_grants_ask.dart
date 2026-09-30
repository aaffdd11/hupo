// **打开时那张弹窗**（契约 `docs/dev/147-APP-SQLITE.md` §二·乙 ·
// 主人 2026-10-01 原话：*「小程序不要声明，应该是打开后有弹窗申请权限」* ·
// *「打开时一次问完」* · *「那一样用不了，别的照旧」*）。
//
// ── 这一份做什么 ──────────────────────────────────────────
//   打开一个小程序之前，把它**还没问过的那几样**一次列出来：
//   每样一个开关（**默认都开着** —— 他直接按「就这样」就等于全给），
//   底下两个按钮：**按勾的样子定下来**（`askOnOpenGo`）/ **都不给**（`askOnOpenNone`）。
//
// ── 五条不许破 ────────────────────────────────────────────
//   ① 🔴 **一次问完**：一张弹窗列全（不是每样弹一次）；
//   ② 🔴 **默认全开**：主人要的是"傻瓜式" —— 他什么都不改按一下就成了；
//   ③ 🔴 **关掉一样只影响它自己**（"那一样用不了，别的照旧"）—— 人话里点明这一句；
//   ④ 🔴 **弹窗本身不发请求**：它只把"他勾成什么样"交回去（`Map<String,bool>`），
//      发请求那一步在屏那一侧（`_grantMyApp`）—— 那儿才有令牌，也才拿得到回执。
//      ⇒ 于是"没记下来"这一档能如实说（屏那一侧按回执说），而弹窗不编话；
//   ⑤ 🔴 **问过就不再问**：允许 / 不给都算他表过态（`unanswered` 会少掉那一样）。
//      他要是**把窗直接划掉**（没按任何一个按钮）⇒ 回来 `null` = **没表态**，
//      那就什么都不记（下次打开再问一次）—— 替他记一笔"不给"才是假话。
//
// ⚠️ 楼层闸：这一份在 `widgets/` ⇒ **只许看 `models/`**（人话与"该问哪几样"那些
//    纯逻辑都住在 `models/app_grants.dart` / `models/space_words.dart`）。

import 'package:flutter/material.dart';

import '../models/app_grants.dart';
import '../models/app_spec.dart';
import '../models/design.dart' as d;
import '../models/space_words.dart';

/// 弹窗自己的 key（判据要指名道姓地找它）。
const ValueKey<String> askOnOpenKey = ValueKey('grants-ask');

/// 每一样的开关的 key。
Key askOnOpenSwitchKey(String permission) => ValueKey('grants-ask:switch:$permission');

/// 开关旁边那个**现状**字的 key（允许 / 不给）。
Key askOnOpenWordKey(String permission) => ValueKey('grants-ask:word:$permission');

/// 底下两个按钮的 key（判据要**像用户那样点**它们）。
const ValueKey<String> askOnOpenGoKey = ValueKey('grants-ask:go');
const ValueKey<String> askOnOpenNoneKey = ValueKey('grants-ask:none');

/// **打开时问一句**：回来的是"每样给不给"；`null` = 他**没表态**（把窗划掉了）。
///
/// ⚠️ 只有 [needsAskOnOpen] 为真时才该调它（没要问的样就别弹一张空窗）。
Future<Map<String, bool>?> askOnOpen(BuildContext context, MiniApp app) {
  return showDialog<Map<String, bool>>(
    context: context,
    // ⚠️ 点旁边空白**不算回答**（划掉 = 没表态 ⇒ 下次再问）；
    //    要拿"不给"得按那颗按钮 —— 不然他一次误触就被记成"不给"了。
    barrierDismissible: false,
    builder: (_) => AppGrantsAskDialog(app: app),
  );
}

/// 那张弹窗本身（**纯界面**：不发请求、不看令牌）。
class AppGrantsAskDialog extends StatefulWidget {
  const AppGrantsAskDialog({super.key, required this.app});

  final MiniApp app;

  @override
  State<AppGrantsAskDialog> createState() => _AppGrantsAskDialogState();
}

class _AppGrantsAskDialogState extends State<AppGrantsAskDialog> {
  /// 他这会儿勾成什么样（**默认全开** —— 主人要的傻瓜式）。
  late final Map<String, bool> _on = {
    for (final p in pendingWantsOf(widget.app)) p: true,
  };

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final wants = pendingWantsOf(widget.app);
    return AlertDialog(
      key: askOnOpenKey,
      // ⚠️ 字放到 3.1 倍时这一列最容易顶出屏幕 ⇒ 里面自己滚（D3.5 那条纪律）。
      scrollable: true,
      title: Text('「${widget.app.title}」$askOnOpenTitle'),
      content: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(askOnOpenLead, style: t.textTheme.bodyMedium?.copyWith(color: d.muted)),
          const SizedBox(height: d.gapS),
          for (final p in wants) _wantRow(p),
          const SizedBox(height: d.gapS),
          Text(askOnOpenLater, style: t.textTheme.bodySmall?.copyWith(color: d.muted)),
        ],
      ),
      actions: [
        TextButton(
          key: askOnOpenNoneKey,
          // 都不给：每样都按"不给"记（**也是他表过态** ⇒ 之后不再自动问）。
          onPressed: () => Navigator.of(context).pop({
            for (final p in wants) p: false,
          }),
          child: const Text(askOnOpenNone),
        ),
        FilledButton(
          key: askOnOpenGoKey,
          // 按勾的样子定下来（他一个字都没改 ⇒ 就是"全给"）。
          onPressed: () => Navigator.of(context).pop({..._on}),
          child: const Text(askOnOpenGo),
        ),
      ],
    );
  }

  /// 一样东西那一行：左边人话（＋ `net` 的站名），右边**状态字 ＋ 开关**。
  ///
  /// ⚠️ 用 `Row` ＋ [Expanded]：字放到 3.1 倍时人话折行、开关那一头宽度是固定的
  ///    ⇒ **绝不横向溢出**（D3.5）。开关旁边那个字是**现状**（允许 / 不给），
  ///    不让他去猜"拨到哪边算给"。
  Widget _wantRow(String permission) {
    final t = Theme.of(context);
    final on = _on[permission] ?? true;
    return Padding(
      padding: const EdgeInsets.only(top: d.gapXs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(grantWantWords(permission), style: t.textTheme.bodyMedium?.copyWith(color: d.ink)),
                // 🔴 只有"想连网取数据"这一样多一句**要连的站**：
                //    那是他点头才生效的那一样里唯一会让他意外的细节。
                if (permission == wantNet && widget.app.net.isNotEmpty)
                  Text(
                    '$askOnOpenSitesLead${widget.app.net.join('、')}',
                    style: t.textTheme.bodySmall?.copyWith(color: d.muted),
                  ),
              ],
            ),
          ),
          const SizedBox(width: d.gapS),
          Text(
            on ? askOnOpenOn : askOnOpenOff,
            key: askOnOpenWordKey(permission),
            style: t.textTheme.bodySmall?.copyWith(color: on ? d.ink : d.muted),
          ),
          Switch(
            key: askOnOpenSwitchKey(permission),
            value: on,
            onChanged: (v) => setState(() => _on[permission] = v),
          ),
        ],
      ),
    );
  }
}
