// 过程四档（手册 **D7** / `docs/dev/26-PROCESS-LEVELS.md` §三）。
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

/// 过程中给用户看多少。
///
/// 四档的定义照 D7 原文：**安静 / 在做什么（默认） / 步骤流水 / 推理原文**。
enum ProcessLevel {
  /// 只有"它说的话"——**连「它正在做…」也不显示**。
  quiet(
    wire: 'quiet',
    title: '安静',
    hint: '只说它要说的话',
  ),

  /// 默认档：一句人话（`process_words.dart` 翻出来的那句）。
  doing(
    wire: 'doing',
    title: '在做什么',
    hint: '顺口说一句它正在忙什么',
  ),

  /// 步骤流水：一句句步骤（"在查资料" → "在写" → …）。
  steps(
    wire: 'steps',
    title: '步骤流水',
    hint: '把做了哪几步一条条摆出来',
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
/// 契约 §三：地址上**不带 `level`** 就等于 `doing`。
/// 这里定义成常量，是为了让"默认值是哪一个"只有一处。
const ProcessLevel defaultProcessLevel = ProcessLevel.doing;

/// 认一个 token ⇒ 档位；**认不出来一律当默认档**（契约 §三：不带 = doing）。
///
/// ⚠️ **绝不抛**：这个函数的输入来自本机存的那一个字符串，
///    它可能是旧版本写的、也可能被别的什么东西改坏了。
///    坏掉的后果必须只是"回到默认档"，**不能是打不开聊天**。
ProcessLevel processLevelOf(Object? wire) {
  for (final l in ProcessLevel.values) {
    if (l.wire == wire) return l;
  }
  return defaultProcessLevel;
}
