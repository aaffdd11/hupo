// **聊天窗口里新加那几行的文字**（工具行 / 系统提示词行 / 每轮用量 / 过程折叠）。
//
// ── 它是什么、为什么单独一份 ─────────────────────────────────
// 主人 2026-09-26：*"首先全部开放，聊天窗口的设计也要重做。"*
// 那一批（`docs/dev/115-DSH-WINDOW-PARITY.md` 丙-1/丙-2/丙-3/丙-5）要在聊天窗口里
// **多画四行**：一次工具调用一行、模型看到的系统提示词一行、每一轮的 token 一行、
// 以及"这一轮做过什么"的折叠控件。这一份就是那四行的**全部文字**。
//
// ⚠️ 和 `process_words.dart` 同一条纪律：**文案集中一处**（不在 widget 里写死），
//    这样才改得动、也才数得清。
// ⚠️ `models/` 是纯逻辑层（楼层闸）⇒ 这一份**不 import material**：
//    它只说"屏幕上那句是什么字"，怎么画（颜色/等宽/字号）是 `widgets/tool_row_view.dart` 的事。
//
// ── 🔴 与禁用词表的关系（**这一批故意留着的现状，如实写清**）──────
// 这一份里的 `工具` / `subagent` / `系统提示词` **都是**
// `models/forbidden_words.dart` 表里的词。主人 2026-09-26 的原话是
// *"首先全部开放"*，115 §七.1 说的正是"**聊天窗口内放开 D1.1（内部词＝缺陷）**"。
// ⇒ 现状是：**词表还禁着、聊天窗口已经放开**。这一批**不许改词表**（派活单点名的），
//    所以这一份**故意没有进** `test/unit/forbidden_words_test.dart` 那份
//    "必须干净"的清单（进了会当场红，而红的不是这一份、是那条还没拍的规矩）。
// ⚠️ **要收口只有一条路**：主人拍一句"词表里那几行去掉 / 或按窗口分开"，
//    然后把这几个常量列进那份清单。

import 'tool_row.dart';

/// 一次工具调用的状态 → 屏幕上一个词。
///
/// ⚠️ **四个值一个不多一个不少**（`ToolStatus` 就这四个）：多出来一个就会让某一处
///    `switch` 走到"默认"上，而那正是"页面在说假话"的起点。
/// ⚠️ **打断与失败必须分开说**（`ToolStatus.interrupted` 那段）：一个是
///    "没做成"，一个是"我没让它做完" —— 合成一个会让我自己按的停止看起来像它坏了。
String toolStatusWord(ToolStatus status) => switch (status) {
  ToolStatus.running => '在跑',
  ToolStatus.ok => '成了',
  ToolStatus.error => '没成',
  ToolStatus.interrupted => '停了',
};

/// 工具行那个展开入口的字（也当无障碍名/悬停提示用）。
const String toolRowExpandLabel = '看它做了什么';
const String toolRowCollapseLabel = '收起这一行';

/// ★ **一次工具调用那一行左边那个名字**（契约 `docs/dev/154-CHAT-RECORD-LOOK.md` §2.1）。
///
/// 🔴 **2026-10-02 改的口径**：原来这一格把**内部名原样摆上屏**
/// （我登录拍的截图里就是 `mcp__apps__app_create · 飞行棋 在跑`）——
/// 那是 `115` 那批"聊天窗口内放开 D1.1"留下的形状。主人这次让我重做界面，
/// 而"界面上出现内部词 = 缺陷"是**手册那条没被撤掉的规矩**（`AGENTS.md` §六 第 4 条）。
/// ⇒ 认得出的工具**翻成人话**；🔴 **认不出的留空** —— 不编一个更像样的说法
///    （N10：沉默优于编造）。原来那个内部名**没丢**：它在**展开的那一块**里逐字还在
///    （`toolRowRawNameLabel`），"要核对时找得到"这条一点没少。
String? toolHumanName(String name) {
  final n = name.trim();
  if (n.isEmpty) return null;
  // ⚠️ 认名字时**只看结尾那一段**：模型手上那件工具的名字在各处长得不一样
  //    （`app_create` / `mcp__apps__app_create`），同一次调用不许因为写法不同就翻不出来。
  final tail = n.contains('__') ? n.split('__').last : n;
  switch (tail) {
    // ── 小程序那一套（`mcp-apps-server.mjs` 的九件）──
    case 'app_create':
      return '做一个小程序';
    case 'app_list':
      return '看有哪些小程序';
    case 'app_publish':
      return '把小程序发出去';
    case 'app_unpublish':
      return '把小程序收回来';
    case 'app_discover':
      return '逛逛大家的小程序';
    case 'app_install':
      return '装一个小程序';
    case 'app_grant':
      return '让小程序用一样东西';
    case 'app_revoke':
      return '不让小程序用了';
    case 'app_uninstall':
      return '从桌面撤掉那个小程序';
    // ── 手上那几件常用的 ──
    case 'bash':
      return '跑命令';
    case 'read':
      return '看文件';
    case 'write':
      return '写文件';
    case 'edit':
      return '改文件';
    case 'glob':
      return '找文件';
    case 'grep':
      return '翻文件里的字';
    case 'web_search':
      return '查网';
    case 'web_fetch':
      return '打开一个网页';
    case 'subagent':
    case 'subagent_fork':
      return '派一件活';
    case 'todo_write':
      return '记一下要做的事';
    case 'send_message':
      return '给那边说一句';
    case 'job_output':
    case 'job_list':
      return '看那件事怎么样了';
    case 'job_kill':
      return '把那件事停下';
    default:
      // 🔴 认不出 ⇒ **留空**（不编）
      return null;
  }
}

/// 展开那一块里"这一行的原始名字"那个小标签（契约 `154` §2.1）。
///
/// ⚠️ 它是**核对层**：`115` 那批"全部开放"要的就是"找得到"，
///    而这一格正是那个"找得到"—— 名字逐字、不改写。
const String toolRowRawNameLabel = '它手上的名字';


/// **截断那句实话**（有 `bytes` 才说得出口径）。
///
/// 🔴 用词逐字照派活单：`… 已截断，共 {bytes} 字节`。
///    **截了不说 = 页面在说假话**（`tool_row.dart` 的 `truncated` 那段）。
/// ⚠️ "字节"不是"字"：服务端报的是 UTF-8 字节数（`Buffer.byteLength`），
///    写成"字"会比真实值小一半以上 —— 那是另一个数。
String toolTruncatedLine(int bytes) => '… 已截断，共 $bytes 字节';

/// 系统提示词那一行的抬头（DSH `message.systemPrompt` 的原文）。
const String systemPromptTitle = '系统提示词';

/// 系统提示词行的展开/收起（同工具行：也当无障碍名）。
const String systemPromptExpandLabel = '看模型看到的那段';
const String systemPromptCollapseLabel = '收起这一段';

/// ── 每轮用量（DSH `TurnUsagePanel` 的那几行）────────────────────
//
// ⚠️ DSH 的规矩：**只有 token，没有钱**（`B-render.md` §2.7 最后一行：
//    "No cost/money figure exists anywhere in these packages"）。
//    我们这一批**一个金额、一个百分比都不发明**（派活单也点名了）。
const String turnUsageHead = '本轮用量';
const String turnUsageInput = '未缓存输入';
const String turnUsageOutput = '输出';
const String turnUsageCacheRead = '缓存读取';
const String turnUsageCacheWrite = '缓存写入';
const String turnUsageReasoning = '其中推理';

/// 数字后面那个单位（DSH 就是 `tok`，**不翻成中文**：它是量纲）。
const String turnUsageUnit = 'tok';

/// **把一段数字按千位分组**（DSH 的 `number.groupSeparator`）。
///
/// ⚠️ 只加分隔符，**不四舍五入、不换算成 k/M**：屏幕上那个数必须**逐位等于**服务端报的
///    那个数（"约 1.6M" 和 "1612345" 不是一回事，前者是我们编的口径）。
/// ⚠️ 负数 / 认不出的输入原样返回（这一层不做判断，也不抛）。
String groupDigits(int n) {
  final s = n.toString();
  if (s.isEmpty || s.startsWith('-')) return s;
  final buf = StringBuffer();
  for (var i = 0; i < s.length; i += 1) {
    if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
    buf.write(s[i]);
  }
  return buf.toString();
}

/// 一轮用量那一行的正文（**只列有的桶**，一个数都不凑）。
///
/// 出处：DSH 的 `TurnUsagePanel` 对话框逐行是
/// `未缓存输入 / 缓存读取 / 缓存写入 / 输出 /（其中推理 {tokens}）`，
/// 计数一律 `{count} tok`。这里压成**一行**（我们的页脚是一行，不是对话框）。
///
/// 🔴 **故意不显示总数**：`TurnUsage.total` 把"没报的桶"按 0 加（那只是"大概多少"），
///    把它的值当"这一轮一共花了多少"画出去就是**编了一个数**（缓存没报时它会偏小）。
///    要总数得先有"每一个桶都报了"这个前提 —— 那正是 `foldTurnUsage` 管的事，
///    而它允许可选桶缺席 ⇒ 我们只列在场的桶。
String turnUsageLine(TurnUsage u) {
  final parts = <String>[
    '$turnUsageInput ${groupDigits(u.input)} $turnUsageUnit',
    '$turnUsageOutput ${groupDigits(u.output)} $turnUsageUnit',
    if (u.cacheRead != null) '$turnUsageCacheRead ${groupDigits(u.cacheRead!)} $turnUsageUnit',
    if (u.cacheWrite != null) '$turnUsageCacheWrite ${groupDigits(u.cacheWrite!)} $turnUsageUnit',
    if (u.reasoning != null) '$turnUsageReasoning ${groupDigits(u.reasoning!)} $turnUsageUnit',
  ];
  return '$turnUsageHead · ${parts.join(dshTurnProcessSeparator)}';
}

/// ── 过程折叠那一行（DSH `TurnProcessNodeView` 的 label）──────────
//
// ⚠️ 这段字由 `dshTurnProcessLabel` 拼（零段省略、顺序固定、全零兜底）——
//    这里只给"每一段怎么说"。
// ⚠️ `messages`（消息数）这一档**我们的客户端今天恒为 0**：
//    `message/start` / `message/end` **不带 `turn`/`step`**，客户端算不出
//    "哪条消息是哪一步的" ⇒ 拼不出 DSH 那个"严格早于答案那一步"的消息数。
//    所以这一段**一次都不会被叫**（`fold` 收到空 `replySteps`）。
//    补上它要服务端在 `message/*` 上带 `turn`/`step`（现在没有）。
String _toolCallsWord(int n) => '$n 次工具调用';
String _messagesWord(int n) => '$n 条消息';
String _subagentsWord(int n) => '$n 个 subagent';

/// 三样全 0 时那句（DSH `message.turnProcess.thoughtForAWhile`）。
const String turnProcessFallback = '已思考';

/// 过程折叠控件的文案源（喂给 `dshTurnProcessLabel`）。
const TurnProcessWords turnProcessChatWords = TurnProcessWords(
  toolCalls: _toolCallsWord,
  messages: _messagesWord,
  subagents: _subagentsWord,
  fallback: turnProcessFallback,
);
