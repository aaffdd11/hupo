// 禁用词闸 —— 手册 `07-APPENDIX.md` §2.2：
//   **界面上出现内部词 = 缺陷**（不是文风问题）。
//
// 走查里最一致的失败不是"功能没有"，是"我看不懂这句话"。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/about_facts.dart';
import 'package:hupo_app/models/appearance.dart';
import 'package:hupo_app/models/desktop_words.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/voice_words.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/models/job_words.dart';
import 'package:hupo_app/models/landing_words.dart';
import 'package:hupo_app/models/login_words.dart';
import 'package:hupo_app/models/chat_time_words.dart';
import 'package:hupo_app/models/notice_words.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/process_words.dart';
import 'package:hupo_app/models/queue_words.dart';
import 'package:hupo_app/models/source_words.dart';
import 'package:hupo_app/models/space_words.dart';
import 'package:hupo_app/models/speak_words.dart';
import 'package:hupo_app/models/tool_row_words.dart';
import 'package:hupo_app/models/trash_words.dart';
import 'package:hupo_app/models/work_list.dart';
import 'package:hupo_app/models/work_words.dart';

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
      landingAndroidStarted,
      landingAndroidOnIt,
      landingAndroidCantHere,
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
      // ⚠️ 批 3 过程档位（D7；2026-09-26 收成两档）新增的那几句：切换入口的标题、
      //    两档的名字与解释、步骤那几个词、推理原文那块标题。
      //    全部**直接引数据源**（手抄会漂）。
      '它说多少过程',
      ...ProcessLevel.values.expand((l) => [l.title, l.hint]),
      ...processWords.values,
      reasoningLabel,
      // ⚠️ **关于页那几句也在这儿**（直接引数据源，不手抄 —— 手抄会漂）
      ...aboutFacts.expand((f) => [f.title, ...f.lines]),
      ...aboutFactsFor(canHear: true).expand((f) => [f.title, ...f.lines]),
      // ⚠️ 批 3「删掉」那一批（`28-DELETE.md`）：气泡长按菜单、删前那份清单、
      //    几句回话 —— **直接引数据源**。
      //    🔴 2026-10-03：回收站那一页（顶栏入口 / 放回来 / 彻底删掉）**砍了**
      //      ⇒ 它那几句字跟着走了（`docs/dev/172-HEADER-TRIM.md`）。
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
      planGoneLine,
      trashRetry,
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
      trashDeleteFailedLine,
      trashPlanFailedLine,
      trashUnauthorizedLine,
      // 拼出来的那几句也要扫（模板里可能有内部词）
      planGoneLine,
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
      // ★ 2026-10-02（`154` §2.1）：连着同样几句合成一行时末尾那个次数
      noticeRepeatSuffix(4),
      // ★ 2026-10-02：时间那一行那两个字
      timeMarkToday,
      // ★ 2026-10-07：**语音那一格的话**（推倒重来之后剩下的那几句）——
      //    连同"机器原因翻成人话"那几个出口（它翻出来的话也要过这道闸）。
      voiceListeningLead,
      voiceWrappingLead,
      voiceSendWords,
      voiceTypeInstead,
      voiceFailedLead,
      voiceTalkLabel,
      voiceStopLabel,
      voiceMicReason('denied'),
      voiceMicReason('not-configured'),
      voiceMicReason('unsupported'),
      voiceMicReason('说不清的机器原因'),
      timeMarkYesterday,
      // ★ 2026-10-02：工具行翻出来的人话 ＋ 展开那一块里“原始名”那个标签
      toolRowRawNameLabel,
      ...['bash', 'read', 'write', 'edit', 'web_search', 'app_create', 'app_list']
          .map((n) => toolHumanName(n)!),
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
      // ★ 2026-09-25（契约 `docs/dev/103-APP-DELETE.md` §三）：桌面图标长按 / 右键
      //    那个小面板的两句 + 成没成那两句 —— **直接引数据源**（手抄会漂）。
      //    ⚠️ 这一批的诚实边界（不许承诺"能拿回来"）在
      //       `test/unit/desktop_remove_test.dart`（C4）。
      desktopRemoveAction,
      desktopRemoveCancel,
      desktopRemoveDone,
      desktopRemoveFailed,
      // ★ 2026-09-26（契约 `docs/dev/117-QUEUE-VISIBLE.md`）：排队那条横条上的字
      //    —— **直接引数据源**（手抄会漂）。
      //    ⚠️ 这一批最容易混进来的是"队列 / 等待 / 还没发"那类说法；
      //       允许的是他自己的话："排队 / 不发了"。
      queueCountHeader(0),
      queueCountHeader(2),
      queueCancelLabel,
      queueExpandLabel,
      queueCollapseLabel,
      // ★ 2026-09-26（契约 `docs/dev/119-APPEARANCE-AND-FONT.md`）：「这块窗口」
      //    那两行（外观 / 字号）的每一句 ＋ 三档的名字（亮 / 暗 / 跟随系统）
      //    ＋ 2026-09-26 那句"暗色还在做"（那两档暂时收起来了）
      //    —— **直接引数据源**（手抄会漂）。
      //    ⚠️ 这一批最容易混进来的是"主题 / 档位 / 客户端 / 工作区"那类内部词；
      //       允许的是他说得懂的话："这块窗口"、"字"、"亮 / 暗 / 跟随系统"。
      settingsAppearanceSection,
      settingsAppearanceLabel,
      settingsAppearanceHint,
      // 🔴 2026-09-26：「暗 / 跟随系统」两档暂时收起来时那句"明说砍了"的话
      //    （`119` §九）—— 它也要过禁用词扫描。
      settingsAppearanceDarkNotReady,
      settingsFontSizeLabel,
      settingsFontSizeHint,
      settingsFontSizePreview,
      settingsFontSizeSmaller,
      settingsFontSizeBigger,
      for (final a in ChatAppearance.values) a.label,
      // ★ 2026-10-03：右栏那一栏（`docs/dev/120`）**整条砍了** ——
      //    它那几句字跟着走了（见 `docs/dev/171-PANEL-CUT.md`）。
      // ★ 2026-09-26（契约 `docs/dev/123-VOICE-TEST-BUTTON.md`）：配置页「语音」
      //    那一屏那颗「试一下」的每一句 —— **直接引数据源**（手抄会漂）。
      //    ⚠️ 这一批最容易混进来的是"模型 / 工具 / 客户端"那类内部词；
      //       允许的是他说得懂的话："试一下"、"停下"、"上面那三样"。
      // ★ 2026-09-27（契约 `docs/dev/127-CREATE-APP-FROM-DESKTOP.md`）：桌面上那颗
      //    「创建小程序」加号与那一层浮窗里的每一句 —— **直接引数据源**。
      createAppLabel,
      createAppTitle,
      createAppNameLabel,
      createAppNameHint,
      createAppDescLabel,
      createAppDescHint,
      createAppOk,
      createAppNo,
      createAppNeedName,
      createAppFailed,
      createAppDone,
      // ★ 2026-09-27（契约 `docs/dev/128-VOICE-RECORD-AND-PLAY.md`）：设置页「语音」
      //    那一屏「录一段」（录音＋回放）的每一句 —— **直接引数据源**。
      voiceRecTitle,
      voiceRecHint,
      voiceRecStart,
      voiceRecStop,
      voiceRecPlay,
      voiceRecPlayStop,
      voiceRecEmpty,
      // ★ 2026-09-28：录的时候那条音量轴的两句话 ＋ 走时那句（主人要的"时间轴语音bar"）
      voiceRecHearing,
      voiceRecQuiet,
      voiceRecElapsed('3.4'),
      voiceTryTitle,
      voiceTryStart,
      voiceTryStop,
      voiceTryWorking,
      voiceTryHint,
      voiceTryBoxLabel,
      voiceTryBadFrame,
      voiceTryNoKeyEmpty,
      voiceTryNoKeyFilled,
      // ★ 2026-09-30（契约 `docs/dev/147-APP-SQLITE.md` §二「册子」）：设置页那张
      //    **注册制**的卡（它想要什么 / 你给了没有）—— **直接引数据源**（手抄会漂）。
      //    ⚠️ 这一批最容易混进来的是"权限 / 数据库 / SQLite / db"那类技术词；
      //       允许的是他说得懂的话："想把东西存下来"、"想用你的钥匙问一句"。
      settingsGrantsTitle,
      settingsGrantsHint,
      settingsGrantsFailed,
      // ⚠️ 拼出来的那句也要扫（`permission` 是协议名，**人话在映射表里**）
      grantWantWords('db'),
      grantWantWords('ask'),
      // ★ 2026-10-01：**第三样"想连网取数据"**（协议名 `net` · `08-SPEC.md` §14.1·丙）——
      //    ⚠️ 这一批最容易混进来的是"网络 / 联网 / 域名 / API"那类词；
      //       允许的是他说得懂的话："想连网取数据"。
      grantWantWords('net'),
      // ★ 2026-10-01：**第四样"想跟它的助手说话"**（协议名 `agent` · `08-SPEC.md` §14.1·丁）——
      //    ⚠️ 这一批最容易混进来的是"agent / 智能体 / 助手接口 / 对话接口"那类词；
      //       允许的是他说得懂的话："想跟它的助手说话"。
      grantWantWords('agent'),
      // ★ 2026-10-01：**第五样"想按点自己跑一件事"**（协议名 `tasks` · `08-SPEC.md` §14.1·戊）——
      //    ⚠️ 这一批最容易混进来的是"定时 / 任务 / cron / 调度"那类词；
      //       允许的是他说得懂的话："想按点自己跑一件事"。
      grantWantWords('tasks'),
      // 认不出来的那一档也有一句人话（不许把协议名摆到屏幕上）
      grantWantWords('something-new'),
      // ★ 2026-10-01：那张卡上**新加的那颗「清空」**（`POST /api/app-db-clear`）
      //    ＋ 它那一层二次确认 ＋ 成/没成那两句 —— **直接引数据源**（手抄会漂）。
      //    ⚠️ 这一批最容易混进来的是"数据库 / 数据 / db / SQLite / 清空数据"那类词；
      //       允许的是他说得懂的话："它存下来的东西"、"拿不回来"、"清掉了"。
      settingsClearDbAction,
      settingsClearDbTitle,
      settingsClearDbWhat,
      settingsClearDbNo,
      settingsClearDbYes,
      settingsClearDbDone,
      settingsClearDbFailed,
      // ★ 2026-10-01：**打开时那张弹窗**（主人：*"小程序不要声明，应该是打开后有弹窗
      //    申请权限"* · *"打开时一次问完"* · *"那一样用不了，别的照旧"*）——
      //    **直接引数据源**（手抄会漂）。
      //    ⚠️ 这一批最容易混进来的是"权限 / 授权 / scope / 勾选"那类词；
      //       允许的是他说得懂的话："允许"、"不给"、"别的照旧"。
      askOnOpenTitle,
      askOnOpenLead,
      askOnOpenSitesLead,
      askOnOpenOn,
      askOnOpenOff,
      askOnOpenGo,
      askOnOpenNone,
      askOnOpenLater,
      askOnOpenFailed,
      // ★ 2026-10-06：**左下角那张「清单」**（主人：*"左下角有一个清单按钮，点击会出来
      //   浮窗，浮窗里有正在干活的聊天的列表。"* · 契约 `docs/dev/198-WORK-LIST.md`）——
      //   **直接引数据源**（手抄会漂）。
      //   ⚠️ 这一批最容易混进来的是"工作区 / 会话 / 房间 / scope"那类内部词。
      workButtonLabel,
      workButtonHint,
      workPanelTitle,
      workCloseWords,
      workBusyLabel,
      workAgeDoing,
      workAgeJustNow,
      workAgeMinute,
      workAgeHour,
      workAgeDay,
      workCountUnit,
      workPartSep,
      workRowHint,
      workNamelessName,
      workEmptyWords,
      workLoadingWords,
      workFailWords,
      // 拼出来的那几句也要扫（模板／拼接里最可能混进内部词）
      workAgeLabel(1770000000000 - 2 * 60 * 1000, now: 1770000000000)!,
      workAgeLabel(1770000000000 - 3 * 60 * 60 * 1000, now: 1770000000000)!,
      workRowSubtitle(
        const WorkingRow(scope: 'abc', title: '记账', since: 1, count: 3),
        now: 1770000000000,
      ),
      workRowName(scope: 'abc', title: '记账'),
      workRowName(scope: '认不出的那一间'),
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
