// 过程两档（手册 **D7** / 契约 `docs/dev/122-TWO-PROCESS-LEVELS.md`）。
//
// ⚠️ 为什么档位要单独一个文件、而不是在界面里写四个字符串：
//   1. **协议那一半要冻结**：`wire` 是连流时带在地址上的那个 token
//      （`?level=quiet|doing|steps|reasoning`）。两边（服务端 / 客户端）
//      认的是同一个字符串，写散了就一定会漂。
//   2. **文案那一半要进硬闸**：`title` / `hint` 是**用户会看到的字**，
//      摆在 `screens/` 里的话，禁用词扫描（`test/unit`）就够不着它
//      ——和 `about_facts.dart` 同一条理由。
//
// ⚠️ 纯逻辑，**不许 import flutter/material**（`models/` 的规矩）。
//
// ── 2026-09-26：四档 ⇒ 两档（主人原话「**名不副实的要去掉**。」）──────────
//
// 砍掉的**只是客户端菜单上的两个入口**，不是协议上的两个 token：
//
//   · **步骤流水**：它的名字承诺"一步一步的流水"，而重做之后**工具行**
//     （`tool/call` 的名字 · 人话标题 · 成败 · 展开看入参输出，而且**落盘、
//     切回来还在**）已经把同一件事说得更准更全 ⇒ 这一档只剩"再多一串
//     粗粒度、而且瞬态（切走就没）的重复行"。
//   · **安静**：它的名字承诺"安静"，可它只掐掉"它正在做…"那一行，
//     **工具行不受档位管**（不在服务端的 `PROCESS_TYPES` 里）⇒ 想安静的人
//     照样看到一串工具行 —— **它做不到它名字说的事**。
//
// 留下的两档：**在做什么**（屏幕上什么都没有时，它是唯一的"它在动"信号）
// 与**它心里想的**（推理原文；🔴 **只有这一档服务端才发它** —— 那是隐私闸
// `D7.4`，绝不能挪到客户端判）。

/// 过程中给用户看多少。
///
/// 两档的定义照 D7（2026-09-26 收窄后）：**在做什么（默认） / 推理原文**。
/// ⚠️ 老的两个 token（`quiet` / `steps`）仍然**冻结**、仍然在协议里，
///    只是**菜单上不再有这两个入口**（见 [retiredProcessLevelWires]）。
enum ProcessLevel {
  /// 默认档：一句人话（`process_words.dart` 翻出来的那句）。
  doing(
    wire: 'doing',
    title: '在做什么',
    hint: '顺口说一句它正在忙什么',
  ),

  /// 它的思考原文。⚠️ **只有主人，默认关**（D7.4）。
  reasoning(
    wire: 'reasoning',
    title: '它心里想的',
    hint: '连它还没说出口的那些也给你看',
  );

  const ProcessLevel({required this.wire, required this.title, required this.hint});

  /// 连流时带在地址上的那个 token（**协议字段，上线即冻结**）。
  final String wire;

  /// 设置入口里给用户看的那一行字。
  final String title;

  /// 那一行下面的一句解释。
  final String hint;
}

/// 默认档 = **在做什么**。
///
/// 契约：地址上**不带 `level`** 就等于 `doing`。
/// 这里定义成常量，是为了让"默认值是哪一个"只有一处。
const ProcessLevel defaultProcessLevel = ProcessLevel.doing;

/// 协议里**冻结的四个 wire token**（`?level=…` 那四个）。
///
/// 🔴 **一个都不许改、不许删、不许复用**（手册维护纪律 2：协议一经上线即冻结）：
///    老客户端还在发 `quiet` / `steps`，老服务端也还认得它们 ⇒
///    改一个字节就是"某一台老设备静默降成默认档"，而屏幕上不会有任何异常。
///    ⇒ 这一批砍掉的是**菜单上的入口**，不是这里的四个字。
const List<String> processLevelWires = <String>[
  'quiet',
  'doing',
  'steps',
  'reasoning',
];

/// **菜单上已经砍掉的两档**（`quiet` / `steps`）。
///
/// ⚠️ 老设备盘上还存着这两个值 ⇒ 读出来时**归一到默认档 `doing`**。
///    理由：那一档的产品入口已经被砍 —— 留着它，菜单上就**没有任何一项是
///    选中的**，而页面在说假话（它看上去像"还没选过"，其实用户选过）。
const List<String> retiredProcessLevelWires = <String>['quiet', 'steps'];

/// 认一个 token ⇒ 档位；**认不出来一律当默认档**（契约：不带 = doing）。
///
/// ⚠️ **绝不抛**：这个函数的输入来自本机存的那一个字符串，
///    它可能是旧版本写的、也可能被别的什么东西改坏了。
///    坏掉的后果必须只是"回到默认档"，**不能是打不开聊天**。
///
/// 🔴 **老设备盘上的 `quiet` / `steps` 也走这一条**（[retiredProcessLevelWires]）——
///    它们不是"坏值"，是"已经砍掉的档"；但终点一样是默认档。
ProcessLevel processLevelOf(Object? wire) {
  // 砍掉的两档：那一档已经不在菜单上 ⇒ 归一到默认档（理由见上面那条）。
  if (retiredProcessLevelWires.contains(wire)) return defaultProcessLevel;
  for (final l in ProcessLevel.values) {
    if (l.wire == wire) return l;
  }
  return defaultProcessLevel;
}
