// 「回收站」页（契约 `docs/dev/28-DELETE.md`、界面契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.3）。
//
// 这一屏按 §2.3 重做过，四件事按轻重排：
//   ① **抬头就说清这一页是什么**：返回箭头 ＋ 标题「回收站」（20/w600）＋
//      一句人话——这 N 次删掉的**还能放回来**，过了每条写的时间就没了。
//      🔴 那句里**一个天数都没有**：留多久是服务端算的（`ttlDays` / 每条的 `purgeAt`），
//         客户端自己写一个数就是编（手册第一条纪律：阈值只住服务端与手册）。
//   ② **一条一张卡、照实说这一条是什么**：服务端**新增那个键** `say`
//      （**他自己那句话，不许客户端截取 / 改写**）⇒ 老盒子没有它就退回已上线的
//      `preview` ⇒ 两样都没有才说"没有能看的字"（`models/trash_words.dart` 的
//      `trashLineOf`）＋ 什么时候删的（`at`）＋ 还能放到什么时候（`purgeAt`）。
//      读不出来就如实说（N10：沉默优于编造），不拿一个空白页冒充"回收站是空的"。
//   ③ **恢复**一键就回来（`28-DELETE.md` §8.3：恢复要立刻）；
//      **彻底删掉**要**二次确认**（§8.2：破坏性动作不许一个手滑就触发），
//      确认框里明说"拿不回来了"。
//      ⚠️ 按那颗按钮的那一下**一个请求都不发**：清单先摊开（`trash_plan_sheet.dart`）
//         那条路要 POST `/api/trash/plan`，会让"这一刻"多一个请求 ⇒ 这一版不做，
//         只做一层确认框（契约 §2.3 允许，见 154 的判据③）。
//   ④ 读不出来 / 401 ⇒ **照旧那条路**（`_load` 与 `_unauthorized()` 的语义没动）。
//
// ⚠️ 文案在 `models/trash_words.dart`（那样才进得了禁用词硬闸）——这里**一个裸字符串都没有**。
// ⚠️ 数值只从 `models/design.dart` / `models/dsh_design.dart` 来（新写的这一版
//    写死的字号/圆角/间距 = **0 处**；那两个新加的读数在 token 里）。
// ⚠️ 不封顶、不夹住字：整页是列表能滚，一条卡里的字自己换行、按钮 `Wrap` 折行
//    （D3.5 那道硬闸量的就是这个，`test/widget/accessibility_test.dart`）。

import 'package:flutter/material.dart';

import '../models/dsh_design.dart';
import '../models/trash.dart';
import '../models/trash_words.dart';
import '../services/api.dart';
import '../services/chat_controller.dart';
import '../widgets/dsh_look.dart';

class TrashScreen extends StatefulWidget {
  const TrashScreen({super.key, required this.controller, required this.onLoggedOut});

  final ChatController controller;

  /// 令牌不行了（401）时叫它：上层会把主界面换成登录页。
  ///
  /// ⚠️ 没有它的时候这一页**只能干说话**（欠账 **#25**）——
  ///    用户会停在一个永远读不出来的页面上反复点重试。
  final VoidCallback onLoggedOut;

  @override
  State<TrashScreen> createState() => _TrashScreenState();
}

class _TrashScreenState extends State<TrashScreen> {
  /// 读到的那一份。`null` = 还在读。
  List<TrashEntry>? _entries;
  TrashAnswer<List<TrashEntry>>? _failed;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _entries = null;
      _failed = null;
    });
    final a = await widget.controller.loadTrash();
    if (!mounted) return;
    if (a is TrashUnauthorized) {
      _unauthorized();
      return;
    }
    setState(() {
      switch (a) {
        case TrashOk(:final value):
          _entries = value;
        case TrashUnauthorized():
          break; // 上面已经处理并返回（switch 要穷尽）
        case TrashFailed():
          _failed = a;
      }
    });
  }

  /// 说一句结果（成没成都说 —— N11：拒绝必须给人话）。
  void _say(String line) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(line)));
  }

  /// 401：**说一句 + 退回登录页**（欠账 **#25**）。
  ///
  /// ⚠️ 三步顺序是有意的：
  ///   ① **先说话**：那句话挂在**根**的 `ScaffoldMessenger` 上
  ///      ⇒ 退回登录页之后仍然看得见（用户得知道**为什么**被退回来）；
  ///   ② 再把这页弹掉：不弹的话它压在最上面，用户停在一个永远读不出来的页面上；
  ///   ③ 最后通知上层（它把主界面换成登录页）。
  ///
  /// 🔴 **这一段一个字都不许动语义**（154：401 那条路现在就对）。
  void _unauthorized() {
    _say(trashUnauthorizedLine);
    Navigator.of(context).popUntil((r) => r.isFirst);
    widget.onLoggedOut();
  }

  /// 本地先把这一组拿走（欠账 **#26**）。
  ///
  /// ⚠️ 为什么不接着整页重拉（原来就是这么写的）：
  ///    重拉会先 `_entries = null` ⇒ 屏幕闪一下加载圈，
  ///    而且服务端哪天做成异步，重拉拿到的是**旧快照** —— 用户会以为没删掉。
  ///    拿不准的（**失败**）才重拉：那时状态确实不明，问服务端才对。
  void _dropLocally(List<String> messageIds) {
    final list = _entries;
    if (list == null) return;
    final gone = messageIds.toSet();
    setState(() {
      _entries = list.where((e) => !e.messageIds.any(gone.contains)).toList();
    });
  }

  Future<void> _restore(List<String> messageIds) async {
    final a = await widget.controller.restoreTurn(messageIds);
    if (!mounted) return;
    if (a is TrashUnauthorized) {
      _unauthorized();
      return;
    }
    switch (a) {
      case TrashOk():
        _say(trashRestoredLine);
        _dropLocally(messageIds);
      case TrashUnauthorized():
        break; // 上面已经处理并返回
      case TrashFailed():
        _say(trashRestoreFailedLine);
        await _load(); // 失败了 ⇒ 盘上到底是什么样不知道，重拉
    }
  }

  Future<void> _purge(List<String> messageIds) async {
    // ★ 二次确认（契约 §8.2）。`showDialog` 的 actions 是 `OverflowBar`
    //   ⇒ 字放大了它会自己折行，不会溢出。
    // 🔴 到这一行为止**一个请求都没发** —— "先问一句"不许带网络（154 判据③）。
    final yes = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text(trashPurgeConfirmTitle),
        // ⚠️ 正文自己说清"**拿不回来**"（不许只在标题上说）。
        content: const Text(trashPurgeConfirmBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(d).pop(false),
            style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
            child: const Text(trashPurgeConfirmNo),
          ),
          FilledButton(
            onPressed: () => Navigator.of(d).pop(true),
            style: FilledButton.styleFrom(minimumSize: const Size(44, 44)),
            child: const Text(trashPurgeConfirmYes),
          ),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    final a = await widget.controller.purgeTurn(messageIds);
    if (!mounted) return;
    if (a is TrashUnauthorized) {
      _unauthorized();
      return;
    }
    switch (a) {
      case TrashOk():
        _say(trashPurgedLine);
        _dropLocally(messageIds);
      case TrashUnauthorized():
        break; // 上面已经处理并返回
      case TrashFailed():
        _say(trashPurgeFailedLine);
        await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = DshLook.of(context);
    final p = look.palette;
    return Scaffold(
      backgroundColor: p.bgBase,
      appBar: AppBar(
        backgroundColor: p.bgBase,
        surfaceTintColor: p.bgBase,
        elevation: 0,
        // 返回箭头：**用标准那一颗**（`BackButton`）。
        // ⚠️ 为什么不是自己画的 `IconButton`：判据里有 `tester.pageBack()`，
        //    它**只认标准的 `BackButton`**（`touch_regression_test.dart` 当场红在
        //    "One back button expected on screen"）。命中区由它自己撑（≥44，D3.6）。
        leading: const BackButton(),
        title: Text(trashTitle, style: dshTextStyle(DshTypes.title, p.labelPrimary)),
      ),
      body: Center(
        child: ConstrainedBox(
          // 内容列限宽，同主界面（平板上一行七十个字没人读）
          constraints: const BoxConstraints(maxWidth: 760),
          child: _body(look),
        ),
      ),
    );
  }

  Widget _body(DshLook look) {
    final p = look.palette;
    final failed = _failed;
    if (failed != null) {
      // ⚠️ "令牌不行"和"网不好"是两件事（对用户说的话不一样，能做的事也不一样）。
      final line = failed is TrashUnauthorized ? trashUnauthorizedLine : trashLoadFailedLine;
      return ListView(
        padding: const EdgeInsets.symmetric(horizontal: DshSpace.s16, vertical: DshSpace.s12),
        children: [
          Text(line, style: dshTextStyle(look.content, p.labelPrimary)),
          const SizedBox(height: DshSpace.s8),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _load,
              style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
              child: const Text(trashRetry),
            ),
          ),
        ],
      );
    }
    final entries = _entries;
    if (entries == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (entries.isEmpty) {
      return ListView(
        padding: const EdgeInsets.symmetric(horizontal: DshSpace.s16, vertical: DshSpace.s12),
        children: [
          Text(trashEmptyLine, style: dshTextStyle(look.content, p.labelPrimary)),
          const SizedBox(height: DshSpace.s4),
          Text(trashEmptyHint, style: dshTextStyle(look.quiet, p.labelTertiary)),
        ],
      );
    }
    // 抬头那一句与卡片**住在同一个滚动面**里（大字号下抬头不许把第一张卡顶没）。
    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: DshSpace.s16, vertical: DshSpace.s12),
      itemCount: entries.length + 1,
      itemBuilder: (context, i) => i == 0 ? _head(look, entries.length) : _entry(look, entries[i - 1]),
    );
  }

  /// 抬头下面那两句：**这 N 次删掉的还能放回来** ＋ **过了那个时间就没了**。
  Widget _head(DshLook look, int n) {
    final p = look.palette;
    return Padding(
      padding: const EdgeInsets.only(bottom: DshSpace.s12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(trashHeadLine(n), style: dshTextStyle(look.content, p.labelPrimary)),
          const SizedBox(height: DshSpace.s4),
          Text(trashHeadHint, style: dshTextStyle(look.quiet, p.labelTertiary)),
        ],
      ),
    );
  }

  /// 一条一张卡：**他自己那句话** ＋ 什么时候删的 ＋ 还能放到什么时候 ＋ 两颗按钮。
  ///
  /// ⚠️ 卡片是**平面那一档**（`bgLayer2` ＋ 发丝描边 ＋ `r12`，**不画阴影**）——
  ///    与聊天窗口里"它的话"那张卡同一个形状（`design.dart` 那条：平面用描边）。
  Widget _entry(DshLook look, TrashEntry e) {
    final p = look.palette;
    return Padding(
      // ⚠️ 这是**字外面的留白**（不包住字）：字长多大它都不挡（D3.5）。
      padding: const EdgeInsets.only(bottom: DshSpace.s8),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: p.bgLayer2,
          borderRadius: BorderRadius.circular(DshRadius.r12),
          border: Border.all(color: p.borderL1, width: dshHairline),
        ),
        child: Padding(
          padding: const EdgeInsets.all(DshSpace.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // ① **那句话本身**：新键 `say`（他自己说的）⇒ 老盒子退回 `preview`
              //    ⇒ 都没有才说"没有能看的字"。**一个字都不截、不改**（§2.3）。
              Text(
                trashLineOf(e),
                style: dshTextStyle(look.content, p.labelPrimary),
              ),
              const SizedBox(height: DshSpace.s6),
              // ② 什么时候删的。
              Text(trashAtLine(e.at), style: dshTextStyle(look.quiet, p.labelTertiary)),
              // ③ 还能放到什么时候（读不出来 ⇒ 那句"过一阵子"，不编日期）。
              Text(
                trashCanRestoreUntilLine(e.purgeAt),
                style: dshTextStyle(look.quiet, p.labelSecondary),
              ),
              const SizedBox(height: DshSpace.s8),
              // ⚠️ `Wrap` 不是 `Row`：两颗按钮在最大字号下要能折到第二行，
              //    否则屏幕上就是一条溢出（D3.5 那道硬闸量的就是这个）。
              Wrap(
                spacing: DshSpace.s8,
                runSpacing: DshSpace.s4,
                children: [
                  TextButton(
                    onPressed: e.usable ? () => _restore(e.messageIds) : null,
                    style: TextButton.styleFrom(
                      foregroundColor: p.stateBusiness,
                      minimumSize: const Size(44, 44),
                    ),
                    child: const Text(trashRestore),
                  ),
                  TextButton(
                    onPressed: e.usable ? () => _purge(e.messageIds) : null,
                    style: TextButton.styleFrom(
                      foregroundColor: p.stateError,
                      minimumSize: const Size(44, 44),
                    ),
                    child: const Text(trashPurge),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
