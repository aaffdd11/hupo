// 禁用词闸 —— 手册 `07-APPENDIX.md` §2.2：
//   **界面上出现内部词 = 缺陷**（不是文风问题）。
//
// 走查里最一致的失败不是"功能没有"，是"我看不懂这句话"。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/about_facts.dart';
import 'package:hupo_app/models/dev_harness.dart';
import 'package:hupo_app/models/dev_harness_words.dart';
import 'package:hupo_app/models/desktop_words.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/harness_words.dart';
import 'package:hupo_app/models/job_words.dart';
import 'package:hupo_app/models/landing_words.dart';
import 'package:hupo_app/models/login_words.dart';
import 'package:hupo_app/models/notice_words.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/process_words.dart';
import 'package:hupo_app/models/source_words.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/speak_words.dart';
import 'package:hupo_app/models/trash_words.dart';

void main() {
  test('★ 永久禁用的那几个，一个都不许漏', () {
    for (final w in ['工作区', '口令', '客户端', '云端', '正在听']) {
      expect(forbiddenWords.containsKey(w), true, reason: '$w 必须禁');
    }
  });

  test('命中判定是对的', () {
    expect(hasForbidden('这个工作区里有三件事'), true);
    expect(hasForbidden('你的密码不对，再试一次'), false);
    expect(hasForbidden('网断了，我在等它回来'), false);
  });

  test('每一条禁用词都写了"为什么"（不然下一个人会把它加回来）', () {
    for (final e in forbiddenWords.entries) {
      expect(e.value.trim().isNotEmpty, true, reason: '${e.key} 没写理由');
    }
  });

  test('★ 我们实际用的那些文案，必须干净', () {
    // 这几句是界面里真会显示的（含 D2 定稿的登录页）
    // ⚠️ 用 `final` 不用 `const`：下面要**展开**关于页那份数据源（`const` 里展不开）
    final copies = [
      // ⚠️ landing 那一屏（主人 2026-09-21 点名要的，版式参考 gengshu.me）——
      //    **直接引数据源**，不手抄（手抄会漂）
      landingKicker,
      landingPromise,
      landingLead,
      landingBrand,
      landingStart,
      landingDownload,
      landingStartHint,
      landingAndroidNotYet,
      landingDownloadTitle,
      // ⚠️ 首页重排（主人 2026-09-22）：**新加的句子必须列在这里**，
      //    没进这份清单的句子 = 没验过。
      landingCanTitle,
      landingYoursTitle,
      for (final (a, b) in landingYours) ...[a, b],
      // ⚠️ 对照块（契约 `docs/dev/51-VS-CHAT.md`）：同上。
      landingDiffTitle,
      landingDiffLeft,
      landingDiffRight,
      for (final (a, b) in landingDiff) ...[a, b],
      landingFaqTitle,
      landingFootNote,
      for (final (a, b, c) in landingCards) ...[a, b, c],
      for (final (a, b, c) in landingPlatforms) ...[a, b, c],
      for (final (a, b) in landingFaq) ...[a, b],
      '所以这道门只有你能开。',
      '装机器时给你的那一串',
      '打开',
      '密码',
      '网断了，我在等它回来',
      '网是通的，只是我还接不上它，在重试',
      // ⚠️ 连流前**续期**撞上 401 也是这一句（续期没有新文案，见 `renew_test.dart`）——
      //    同一件事同一句话，别再新造一个说法。
      '登录过期了，重新登录一下',
      '已交出去',
      '已送到',
      '已收到',
      '没发出去',
      '重发',
      '说点什么',
      // ★ 2026-09-25（批 4 · 一个图标 = 一条对话 · `83-APP-WORKSPACE.md` §五·甲）：
      //    某个小程序那一间**还空着**时那两句 —— **直接引数据源**（手抄会漂）。
      //    ⚠️ 这一批最容易混进来的就是「工作区」那个词（它是禁用词，一个都不许上屏）。
      roomEmptyTitle,
      roomEmptyLine('奥数题'),
      roomEmptyLine('随手记一笔'),
      '在处理…',
      '这条没说完',
      '你不在的时候',
      '这台机器还没设密码',
      // 它忙不过来（内存准入闸拒的）——首页那句人话
      '它现在忙不过来，过一会儿再发一次',
      // ⚠️ 登录那一屏（2026-09-21 改成手机号 + 验证码）——**直接引数据源**
      loginPromise,
      loginPhoneLabel,
      loginPhoneHint,
      loginCodeLabel,
      loginCodeHint,
      loginSubmit,
      loginBusy,
      loginTempCodeNote,
      loginErrCode,
      loginErrPhone,
      loginErrNoSms,
      loginErrNetwork,
      loginErrLockedPrefix,
      loginErrLockedSuffix,
      loginNeedsSetup,
      '记一笔账、问一件事、让它去查个东西。',
      '它会把做过的事说给你听。',
      // ⚠️ 批 3 过程四档（D7）新增的那几句：切换入口的标题、
      //    四档的名字与解释、步骤流水那几个词、推理原文那块标题。
      //    全部**直接引数据源**（手抄会漂）。
      '它说多少过程',
      ...ProcessLevel.values.expand((l) => [l.title, l.hint]),
      ...processWords.values,
      reasoningLabel,
      // ⚠️ **关于页那几句也在这儿**（直接引数据源，不手抄 —— 手抄会漂）
      ...aboutFacts.expand((f) => [f.title, ...f.lines]),
      ...aboutFactsFor(canHear: true).expand((f) => [f.title, ...f.lines]),
      // ⚠️ 批 3「删掉 / 回收站」那一批（`28-DELETE.md`）：顶栏入口、气泡长按菜单、
      //    删前那份清单、回收站页的按钮与几句回话 —— **直接引数据源**。
      trashTitle,
      trashTooltip,
      bubbleMenuTitle,
      bubbleMenuDelete,
      bubbleMenuDeleteHint,
      bubbleMenuCancel,
      // ⚠️ 2026-09-25（契约 `docs/dev/106-CHAT-SELECT.md`）：菜单里新加的
      //    【复制】【多选】、多选那条工具条、以及复制那几句实话 —— **直接引数据源**。
      //    ⚠️ 这一批最容易混进来的是"工作区 / 数据 / 工具名"那类内部词。
      bubbleMenuCopy,
      bubbleMenuSelect,
      bubbleSelectCount(0),
      bubbleSelectCount(12),
      bubbleSelectCancel,
      bubbleCopiedLine,
      bubbleCopiedManyLine(0),
      bubbleCopiedManyLine(2),
      bubbleCopyEmptyLine,
      bubbleCopyFailedLine,
      planTitle,
      planCancel,
      planConfirm,
      planCannotLine,
      planEmptyLine,
      trashEmptyLine,
      trashNoPreviewLine,
      trashLoadFailedLine,
      trashRetry,
      trashRestore,
      trashPurge,
      trashPurgeConfirmTitle,
      trashPurgeConfirmBody,
      trashPurgeConfirmYes,
      trashPurgeConfirmNo,
      // ★ 2026-09-25（契约 `docs/dev/108-JOB-ASK-FLOW.md`）：派活那一层确认上的字
      //    —— **直接引数据源**（手抄会漂）。⚠️ 那句问话本身**不在**这一份里：
      //    它是**服务端给的**（客户端照抄），这边一个字的模板都不许有。
      jobAskTitle,
      jobAskNewPlace,
      jobAskHere,
      jobAskExpiredFallback,
      jobAskExpiredTitle,
      jobAskFailedLine,
      jobAskWhyLine('帮我做一个练算数的小程序'),
      trashDeletedLine,
      trashRestoredLine,
      trashPurgedLine,
      trashDeleteFailedLine,
      trashRestoreFailedLine,
      trashPurgeFailedLine,
      trashPlanFailedLine,
      trashUnauthorizedLine,
      // 拼出来的那几句也要扫（模板里可能有内部词）
      planTtlLine(30),
      planTtlLine(null),
      purgeAtLine(1758400000000),
      verdictLabel('delete'),
      verdictLabel('cannot'),
      planItemTitle('可见的那几句', '这台设备'),
      // ⚠️ 批 3「系统通知」那一批（`29-NOTICE.md`）：浮窗与时间线里那一条的
      //    **按钮字 / 补的那句话** —— **直接引数据源**（手抄会漂）。
      //    ⚠️⚠️ 这里**没有** `notice.text` 的五个模板，那是对的：
      //       通知正文**由服务端给、客户端照抄**（§五 🔴），客户端这边
      //       一个字的模板都不许有（`notice_test.dart` 有一条钉着这件事）。
      noticeUndoLabel,
      noticeDismissLabel,
      noticeNotKeptLine,
      // ⚠️ 出处（`67-SOURCES.md`）：抬头与"还有 N 处" —— **直接引数据源**（手抄会漂）
      sourcesHeadWords,
      sourcesMoreWords(2),
      // ⚠️ "读出来"那一半（`68-SPEAK.md`）：开关与每条按钮的字 + 那句"这台设备上念不出来"
      speakOnceWords,
      speakStopWords,
      speakAutoOnWords,
      speakAutoOffWords,
      speakAutoHintOn,
      speakAutoHintOff,
      speakCannotWords,
      // ★ 2026-09-24：「我自己那台」那个入口（契约 `docs/dev/81-HARNESS-ENTRY.md` §5.4）——
      //    桌面上那个字 + 那一层里**每一句**（状态、每一行的抬头、结构行、说明行、
      //    未知事件那一条）。**直接引数据源**（手抄会漂）。
      //    ⚠️ 硬闸点名的那几个词（模型 / 会话 / 客户端 / 工作区 / 口令 / 连接 / 云端 /
      //       工具名 / `web_search`）这一组**一个都不许有**。
      harnessAppLabel,
      harnessOpening,
      harnessGoneLine,
      harnessWhyPrefix,
      harnessRestart,
      harnessDroppedWhy,
      harnessSayHint,
      harnessSend,
      harnessStop,
      harnessYourPrefix,
      harnessItsPrefix,
      harnessThinkPrefix,
      harnessSystemPrefix,
      harnessAnswered,
      harnessUnknownLine,
      harnessNoTextLine,
      harnessInterruptedLine,
      // ⚠️ 拼出来的那几句也要扫（模板里最可能混进内部词）
      harnessTurnStartLine(1),
      harnessStepStartLine(1, 2),
      harnessStepEndLine(2),
      harnessTurnEndLine(harnessReasonWords('completed')),
      harnessReasonWords('completed'),
      harnessReasonWords('canceled'),
      harnessReasonWords('max-tokens'),
      harnessReasonWords('interrupted'),
      harnessReasonWords(null),
      harnessReasonWords('some-other-reason'),
      harnessHeaderLine(0),
      harnessHeaderLine(3),
      harnessContextLine,
      harnessTitleLine('记一笔账'),
      harnessTitleLine(''),
      harnessPermissionLine,
      harnessSandboxLine,
      harnessApprovalLine,
      harnessSplicedLine(0),
      harnessSplicedLine(2),
      harnessRunStatusLine(true),
      harnessRunStatusLine(false),
      // ★ 2026-09-24（契约 `docs/dev/82-DEV-MODE.md` §四 / §五）：那一层里
      //    **新加的那个次要入口**（「在浏览器里打开」）的每一句 —— **直接引数据源**。
      //    ⚠️ 文案纪律没松：这几句一个内部词都不许有
      //       （尤其不许把"开发者 / 盒子 / 域名"那类实现细节写到屏幕上）。
      devOpenLead,
      devOpenAction,
      devOpenAsking,
      devOpenNotMarked,
      devOpenUnreachable,
      devOpenCannotHere,
      devOpenFailed,
      // ★ 2026-09-25（主人 2026-09-25 拍的「甲」·
      //    契约 `docs/dev/109-DEV-ENTRY-IS-YOURS.md` §八）：**看板那句话** ——
      //    这一层里回话的**不是琥珀**，所以页面上必须明写（诚实纪律，不许省）。
      devBoardNotHupo,
      devBoardWhyNot,
      // ⚠️ 每一档实际画出来的那一句也扫（`devEntryWords` 就是屏幕上的那句）
      for (final v in DevEntryView.values) devEntryWords(v),
      // ★ 2026-09-25（契约 `docs/dev/103-APP-DELETE.md` §三）：桌面图标长按 / 右键
      //    那个小面板的两句 + 成没成那两句 —— **直接引数据源**（手抄会漂）。
      //    ⚠️ 这一批的诚实边界（不许承诺"能拿回来"）在
      //       `test/unit/desktop_remove_test.dart`（C4）。
      desktopRemoveAction,
      desktopRemoveCancel,
      desktopRemoveDone,
      desktopRemoveFailed,
    ];
    for (final c in copies) {
      final hits = scanForbidden(c);
      expect(hits, isEmpty, reason: '「$c」里有禁用词：$hits');
    }
  });

  // ★ P0-4（2026-09-24）：这两句**曾经把「服务器」写到屏幕上**（内部词，词表里本来就禁它）。
  //   这条判据扫的是**源码里那两句本身** —— 比只扫一份文案清单更硬（改回来当场红）。
  test('P0-4：状态条那两句（_lastError）里不许出现「服务器」', () {
    final src = File('lib/services/chat_controller.dart').readAsStringSync();
    for (final line in src.split('\n')) {
      if (!line.contains('_lastError')) continue;
      expect(line.contains('服务器'), isFalse, reason: '内部词不许上屏：$line');
    }
  });

  // ★ P0-5（2026-09-24）：「正在听」**收窄**了 —— 不再是一刀切禁掉，而是
  //   "只在真的在录音时才可以"（D5.13）。这条把**唯一的合法落点**钉死：
  //   整棵 `lib/` 里，字符串字面量 `'正在听'` 只许出现在 `models/hearing_words.dart`。
  test('P0-5：「正在听」只许出现在 hearing_words.dart（且只在真在听时画）', () {
    final hits = <String>[];
    for (final e in Directory('lib').listSync(recursive: true)) {
      if (e is! File || !e.path.endsWith('.dart')) continue;
      // ⚠️ 词表自己当然含这个词（它就是"哪些词不许用"那张表）⇒ 排除它
      if (e.path.endsWith('models/forbidden_words.dart')) continue;
      final src = e.readAsStringSync();
      // 只看**字符串字面量**（注释里提到不算）
      if (RegExp(r"'正在听'").hasMatch(src)) hits.add(e.path);
    }
    expect(
      hits,
      ['lib/models/hearing_words.dart'],
      reason: '「正在听」的合法落点只有一个；别处出现就是"不录音还说在听"（D5.13）',
    );
  });
}
