// 「这件事要另开一处做吗」那一层确认里**用户会看到的字**
// （契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 第①步 / §二 C1）。
//
// ⚠️ 为什么文案单放一个 models 文件、不写在界面里：
//    摆在 `screens/` / `widgets/` 里的字符串，**禁用词硬闸够不着**
//    （`test/unit/forbidden_words_test.dart` 扫的是这份表）。
//    —— 和 `trash_words.dart`、`about_facts.dart` 同一条理由。
//
// ⚠️ 用词纪律：说人话。**不许**出现"工作区 / 客户端 / 服务器 / 工具 / 会话"
//    那些内部词（那是缺陷，不是文风问题）。⇒ 按钮上说的是「另开一处」，
//    因为**主人自己就是这么说的**（契约 §一 那两个按钮的原话）。
//
// ⚠️ 纯逻辑，**不许 import flutter/material**。

/// 那一层确认的标题。
const jobAskTitle = '这件事怎么做';

/// 两个按钮。**主人原话就是这两个**（契约 §一 第①步）。
const jobAskNewPlace = '另开一处做';
const jobAskHere = '就在这儿做';

/// 他那句原话上面那一小行（它让他认出"你让我做的是这个"）。
String jobAskWhyLine(String why) => '你说的是：$why';

/// 那一笔作废了（超时 / 没答）时说的那句 —— **服务端给的原话**优先（`text`），
/// 实在没给才用这一句兜底。⚠️ 无论哪一句，含义都是"**我还没动手**"（不许猜）。
const jobAskExpiredFallback = '那件事我还没动手。';

/// 答话没送出去（网 / 服务端没收下）时那句 —— **不许静默**（N11：拒绝必须给人话）。
const jobAskFailedLine = '刚才那一下没送出去，等会儿再说一遍就行';

/// 超时兜底上屏时前面那一小行（与服务端给的那句分开摆，免得看起来像同一句）。
const jobAskExpiredTitle = '刚才问你的那件事';
