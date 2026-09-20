// 界面用词纪律。手册 `07-APPENDIX.md` §2.2、`08-SPEC.md` §6.6。
//
// > **界面上出现内部词 = 缺陷**（不是文风问题）。
//
// 为什么这值得单独一个文件、还要做成闸：
// 走查里最一致的失败不是"功能没有"，是**"我看不懂这句话"**——
// 05 把"工作区"读成"上班干活的地方"，06 把"口令"读成"当兵站岗"，
// 03 读完"能执行命令、能改自己的代码"**是害怕**。
//
// ⚠️ 纯逻辑，不许 import flutter/material。

/// 禁用词 → 为什么禁。
///
/// 有一条规矩：**禁止的是"面向用户的文案"**，不是代码里的标识符。
/// 所以这个表是给"界面上会显示的字符串"用的。
const Map<String, String> forbiddenWords = {
  // 用户明确读不懂的
  '工作区': '05 读成"上班干活的地方"、06 读成"写黑板报的角落"——两个人都没看懂',
  '口令': '03："我上一次听是看电视里当兵的站岗"',
  '暗号': '新造的说法，要学——而"密码"用户已经学过',

  // 内部架构词
  '客户端': '内部词，用户不需要知道界面跑在哪',
  '云端': '同上',
  '服务器': '同上',
  '调度器': '内部词',
  '时间线': '内部词（它是我们的模型，不是用户的话）',
  '作用域': '内部词',
  '会话': '内部词；用户心里"会话"就是聊天记录',

  // 内部机制词
  '工具': '人格规矩：回答里不提"工具"',
  '搜索': '人格规矩：不说"根据搜索结果"',
  '上下文': '内部词',
  '系统提示': '内部词；而且是产品资产，绝不能露',
  '模型': '内部词',

  // 具体工具名
  'web_search': '工具名，必须翻成人话（"在查资料"）',
  'web_fetch': '同上',
  'tool-fs': '同上',
  'bash': '同上',
  'subagent': '同上',

  // 假承诺
  '正在听': '它没在听（那只是"它不出声"）——06 对着手机说话，以为是自己笨',

  // 系统造词（D1.4：区分同名必须用用户自己的话）
  '第 1 个': '系统编号不是用户的话——要改名就用他自己的词',
  '第 2 个': '同上',
  '序号': '同上',
};

/// 命中。
class ForbiddenHit {
  const ForbiddenHit(this.word, this.why);
  final String word;
  final String why;

  @override
  String toString() => '「$word」——$why';
}

/// 扫一段**要显示给用户**的文案。命中返回列表（空 = 干净）。
List<ForbiddenHit> scanForbidden(String text) {
  final hits = <ForbiddenHit>[];
  for (final entry in forbiddenWords.entries) {
    if (text.contains(entry.key)) hits.add(ForbiddenHit(entry.key, entry.value));
  }
  return hits;
}

/// 只关心"有没有"。测试用这个。
bool hasForbidden(String text) => scanForbidden(text).isNotEmpty;
