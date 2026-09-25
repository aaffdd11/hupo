// 「这件事要另开一处做吗」那一层确认 —— **数据形状与纯解析**
// （契约 `docs/dev/108-JOB-ASK-FLOW.md` §一 第①步 / §二 C1–C6）。
//
// ── 它是什么 ───────────────────────────────────────────────
// 主对话里它接下一件新东西（"帮我做一个 X"）时，服务端**先问一句**：
// 那一帧 `job/ask`（**瞬态**：不落盘、不占号）到了 ⇒ 屏上出一层确认 ＋ 两个按钮：
//
//     {"type":"job/ask","id":"j_ask_…","where":"math-drill",
//      "why":"帮我做一个奥数小程序","text":"这件事要另开一处专门做吗？","at":…}
//
//   · `text` 是**服务端给的那句问话**（客户端照抄 —— 与 `SayAsk` 那条反问同一条规矩：
//     两处各拼一句就会漂）；
//   · `why` 是**他说的那句原话**（那层确认里要看得见"你让我做的是这个"）；
//   · `where` 是打算开的那一处的短名（**内部词，一个字都不许上屏** —— 名字由 agent 起，
//     他不需要知道，契约 §四.3）；
//   · `id` 是他答话时要原样带回去的那个号（一次一件，够用）。
//
// ⚠️ **纯逻辑**，不许 import flutter/material（`test/unit/import_rules_test.dart` 那道楼层闸）。

/// 「这件事要另开一处做吗」那一笔待答的活（服务端那一帧的**纯解析结果**）。
class JobAsk {
  const JobAsk({
    required this.id,
    required this.where,
    required this.why,
    required this.text,
  });

  /// 答话时要带回去的那个号。
  final String id;

  /// 打算开的那一处的短名（**内部词**：只用来把答话对回去，绝不上屏）。
  final String where;

  /// 他说的那句原话（`''` = 服务端没给 ⇒ 那半句不画，**不许自己编**）。
  final String why;

  /// 服务端给的那句问话（**照抄**）。
  final String text;
}

/// 那一帧是不是一笔待答的活；是就解析出来，不是 / 读不全 ⇒ `null`（**不猜**）。
///
/// 🔴 `id` 与 `text` **缺一个就当不是**：没有号就答不回去（按钮按了没结果），
///    没有问话就没得问（屏幕上会出现一个空框）——两种都是"按了不会有结果的动作"。
JobAsk? jobAskOf(Object? event) {
  if (event is! Map) return null;
  if (event['type'] != 'job/ask') return null;
  final id = event['id'];
  final text = event['text'];
  if (id is! String || id.trim().isEmpty) return null;
  if (text is! String || text.trim().isEmpty) return null;
  final where = event['where'];
  final why = event['why'];
  return JobAsk(
    id: id.trim(),
    where: where is String ? where.trim() : '',
    why: why is String ? why.trim() : '',
    text: text.trim(),
  );
}

/// 那一帧是不是"这一笔作废了"（超时 / 不答 ⇒ 不许猜）；是就给出那个号。
///
/// ⚠️ 只认 `id` **逐字相同**的那一帧：作废的是**那一笔**，不是"所有的问话"。
String? jobAskExpiredOf(Object? event, String id) {
  if (event is! Map) return null;
  if (event['type'] != 'job/ask-expired') return null;
  final got = event['id'];
  if (got is! String || got.trim() != id.trim()) return null;
  return got.trim();
}

/// 「做完自动给他看」那一帧（`app/open`）里那个要打开的名字；没有 ⇒ `null`。
///
/// 🔴 **它是瞬态**（不落盘、不占号）：那句总结的家只有主进程那条 `job/report`，
///    这一帧只是"现在把它打开"那一下 ＋ 旁边那句话（**一条事实一个家**）。
JobOpen? jobOpenOf(Object? event) {
  if (event is! Map) return null;
  if (event['type'] != 'app/open') return null;
  final app = event['app'];
  if (app is! String || app.trim().isEmpty) return null;
  final text = event['text'];
  return JobOpen(
    app: app.trim(),
    text: text is String ? text.trim() : '',
  );
}

/// 「做完自动给他看」那一帧的内容。
class JobOpen {
  const JobOpen({required this.app, required this.text});

  /// 要打开的那一个（那个 app 的 id，与那一间同名）。
  final String app;

  /// 旁边留的那句话（**服务端给的原话**，`''` = 没有 ⇒ 不画）。
  final String text;
}

/// ★ **答话的回执**（服务端→客户端那一帧 `job/answer-ack`）的纯解析。
///
/// 🔴 `ok:false` 时 `text` 是**服务端给的人话**（"那件事我还没动手" / "没成…"）——
///    客户端**照抄**（与反问那条路同一条规矩：那句人话到得了状态条）。
JobAnswerAck? jobAnswerAckOf(Object? event) {
  if (event is! Map) return null;
  if (event['type'] != 'job/answer-ack') return null;
  final id = event['id'];
  if (id is! String || id.trim().isEmpty) return null;
  final ok = event['ok'] == true;
  final yes = event['yes'];
  final text = event['text'];
  return JobAnswerAck(
    id: id.trim(),
    ok: ok,
    yes: yes is bool ? yes : null,
    text: text is String && text.trim().isNotEmpty ? text.trim() : null,
  );
}

/// 答话的回执。
class JobAnswerAck {
  const JobAnswerAck({required this.id, required this.ok, this.yes, this.text});

  /// 哪一笔的回执（**只认号相同的那一帧**）。
  final String id;

  /// 收下了没有。
  final bool ok;

  /// 收下的是"是"还是"否"（认不出 ⇒ `null`）。
  final bool? yes;

  /// 没成时那句人话（服务端给的原话）。
  final String? text;
}

