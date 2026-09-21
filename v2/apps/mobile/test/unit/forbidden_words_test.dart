// 禁用词闸 —— 手册 `07-APPENDIX.md` §2.2：
//   **界面上出现内部词 = 缺陷**（不是文风问题）。
//
// 走查里最一致的失败不是"功能没有"，是"我看不懂这句话"。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/about_facts.dart';
import 'package:hupo_app/models/forbidden_words.dart';
import 'package:hupo_app/models/landing_words.dart';
import 'package:hupo_app/models/login_words.dart';
import 'package:hupo_app/models/notice_words.dart';
import 'package:hupo_app/models/process_levels.dart';
import 'package:hupo_app/models/process_words.dart';
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
      // ⚠️ 批 3「删掉 / 回收站」那一批（`28-DELETE.md`）：顶栏入口、气泡长按菜单、
      //    删前那份清单、回收站页的按钮与几句回话 —— **直接引数据源**。
      trashTitle,
      trashTooltip,
      bubbleMenuTitle,
      bubbleMenuDelete,
      bubbleMenuDeleteHint,
      bubbleMenuCancel,
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
    ];
    for (final c in copies) {
      final hits = scanForbidden(c);
      expect(hits, isEmpty, reason: '「$c」里有禁用词：$hits');
    }
  });
}
