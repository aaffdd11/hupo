// **「正在干的活」那一张浮窗**（主人 2026-10-06 · 契约 `docs/dev/198-WORK-LIST.md`）。
//
// 主人原话：*「我觉得应该在左下角有一个清单按钮，点击会出来浮窗，
//   浮窗里有正在干活的聊天的列表。」*
//
// ── 它是什么 ───────────────────────────────────────────────
//   纯**看**的一块：谁在干活、干了多久、几件。一件事都点不动（除了"去看看"与"关上"）。
//   ⚠️ **一条都不编**：清单是服务端 `GET /api/working` 给的那一份，壳里不加不减。
//
// ── 三种状态，一句都不许混（这一条是这块的全部风险）──────────────────
//   · **问上了、有活** ⇒ 一行一间；
//   · **问上了、没活** ⇒ [workEmptyWords]（这一句**只在真问上时**才许说）；
//   · **没问上** ⇒ [workFailWords]（网不通 / 非 200 / 读不懂 —— `rows == null`）。
//   🔴 `rows == null` 时**永远不许**说"没有在干的活"：看不见 ≠ 没有。
//
// ── 面子 ───────────────────────────────────────────────────
//   与底下那三颗按钮**同一套**（`d.card` 白底 ＋ 一圈 `d.accent` 琥珀细线 ＋ 墨色字）：
//   主人 2026-10-06 当天为那三颗定过这一套（"现在把白色底加上"），清单是同一族的东西。
//   ⚠️ 这里**不读 `AppearanceScope` 的色板**：那三颗无论亮暗都是这一套
//      （整机暗色时窗口自己变深，而这四样是暖白纸的颜色）—— 混用会在暗色下
//      变成"白底 + 近白的字"（看不见）。
//
// ⚠️ 每一行是一整条**行级入口**（`DshRowEntry`）：整行都能点，按**面积**过 D3.6，
//    不用 `GestureDetector`（源码级禁令）。

import 'package:flutter/material.dart';

import '../models/design.dart' as d;
import '../models/dsh_design.dart';
import '../models/work_list.dart';
import '../models/work_words.dart';
import 'dsh_look.dart';
import 'row_entry.dart';

/// 这张浮窗自己的 key（判据用它找它）。
const Key workPanelKey = Key('work-panel');

/// 右上角那颗「关上」。
const Key workCloseKey = Key('work-close');

/// 某一间那一行的 key（判据用它点那一行）。⚠️ 里面是**内部 id** —— 只进 key，不上屏。
Key workRowKey(String scope) => Key('work-row:$scope');

/// **正在干的活**那一张（见文件头）。
class WorkListPanel extends StatelessWidget {
  const WorkListPanel({
    super.key,
    required this.rows,
    required this.busy,
    required this.onPick,
    required this.onClose,
    this.mineNames = const {},
    this.now,
  });

  /// 服务端给的那一份。
  ///
  /// 🔴 **`null` = 这一次没问上**（与"一件活都没有"是**两件事** —— 见文件头）。
  final List<WorkingRow>? rows;

  /// 还在问（`rows == null` 时它决定说"稍等一下"还是"没问上"）。
  final bool busy;

  /// 点某一行 ⇒ 去那一间看看。
  final ValueChanged<WorkingRow> onPick;

  /// 右上角那颗「关上」。
  final VoidCallback onClose;

  /// 壳里那份"我的小程序"（app id ⇒ 它现在的名字）——
  /// 服务端没给名字时补位（`workRowName` 第 ② 步）。
  final Map<String, String> mineNames;

  /// **现在**（毫秒）。判据传进来才可控（纯函数那一条：不许在算字的地方读钟）。
  final int? now;

  @override
  Widget build(BuildContext context) {
    final at = now ?? DateTime.now().millisecondsSinceEpoch;
    final list = rows;
    return Container(
      key: workPanelKey,
      decoration: BoxDecoration(
        color: d.card,
        borderRadius: BorderRadius.circular(d.radiusCard),
        border: Border.all(color: d.accent, width: d.voiceCircleRing),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 🔴 **整张清单能滚**（连抬头一起）—— 这一条是**不许溢出**那件事的落点：
          //    外面给多高都行（收起档里地方紧的时候它自己滚），一行都不许被切掉。
          Flexible(
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _header(context),
                  Divider(height: 1, thickness: dshHairline, color: d.line),
                  if (list == null)
                    _line(context, busy ? workLoadingWords : workFailWords)
                  else if (list.isEmpty)
                    _line(context, workEmptyWords)
                  else
                    for (final r in list) _row(context, r, at),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 抬头那一行：标题 ＋ 那颗「关上」（≥44，D3.6）。
  Widget _header(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: d.gapM, right: d.gapXs, top: d.gapXs),
    child: Row(
      children: [
        Expanded(
          child: Text(
            workPanelTitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: dshTextStyle(DshTypes.chatBodyStrong, d.ink),
          ),
        ),
        const SizedBox(width: d.gapXs),
        TextButton(
          key: workCloseKey,
          onPressed: onClose,
          style: TextButton.styleFrom(
            minimumSize: const Size(d.voiceAuxW, d.voiceAuxH),
            padding: const EdgeInsets.symmetric(horizontal: d.gapS),
            foregroundColor: d.muted,
          ),
          child: const Text(workCloseWords),
        ),
      ],
    ),
  );

  /// 那三种"不成一行"的句子（空 / 稍等 / 没问上）。
  Widget _line(BuildContext context, String words) => Padding(
    padding: const EdgeInsets.symmetric(
      horizontal: d.gapM,
      vertical: d.gapM,
    ),
    child: Text(
      words,
      style: dshTextStyle(DshTypes.chatBody, d.muted),
    ),
  );

  /// 一间一行：名字 ＋ （在干活 · 几件 · 干了多久）。
  Widget _row(BuildContext context, WorkingRow r, int at) {
    final name = workRowName(scope: r.scope, title: r.title, mine: mineNames);
    return DshRowEntry(
      key: workRowKey(r.scope),
      onTap: () => onPick(r),
      tooltip: workRowHint,
      child: ConstrainedBox(
        // ⚠️ 这一行里没有别的可点物 ⇒ **整行就是命中区**（D3.6 行级那一档）：
        //    面积 = 整行宽 × 行高 ≥ 44×44，而它的宽度本来就远超 44。
        constraints: const BoxConstraints(minHeight: d.workRowMinH),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: dshTextStyle(DshTypes.chatBodyStrong, d.ink),
            ),
            Text(
              workRowSubtitle(r, now: at),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: dshTextStyle(DshTypes.chatQuiet, d.muted),
            ),
          ],
        ),
      ),
    );
  }
}
