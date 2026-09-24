// 「在浏览器里打开那一台」那个**次要入口**的全部文案
// （契约 `docs/dev/82-DEV-MODE.md` §四 / §五）。
//
// ⚠️ 单独一个文件、纯数据：每一句都要过**禁用词硬闸**
//    （清单在 `test/unit/forbidden_words_test.dart`）。
// ⚠️ 一个内部词都不许有：没有「工作区 / 口令 / 客户端 / 云端 / 服务器 / 会话 / 模型 /
//    工具 / 搜索 / 上下文 / 连接」，也不许出现工具名与英文 `web_search`。
// ⚠️ 纯数据，不 import flutter（楼层闸 `test/unit/import_rules_test.dart`）。

/// 拿到了那条链接：一句普通话（后面跟着「在浏览器里打开」那个按钮）。
const String devOpenLead = '想在浏览器里打开它？';

/// 那个按钮的字。
///
/// 🔴 点了真的把**服务端给的那条地址原样**交出去（不许自己拼、不许改参数）。
const String devOpenAction = '在浏览器里打开';

/// 正在问服务端要那条链接（**不许白屏** —— 这一句占着那块地方）。
const String devOpenAsking = '正在准备…';

/// **非 200**（这台还没被标成能这样打开）⇒ 只有这句话，**没有按钮**。
const String devOpenNotMarked = '这台还没被标成能这样打开。';

/// 这会儿问不到（网 / 超时 / 回执坏了）⇒ 只有这句话，**没有按钮**。
const String devOpenUnreachable = '这会儿问不到，过会儿再看。';

/// 这个平台上打不开浏览器（非网页那一侧）⇒ 如实说，**没有按钮**。
const String devOpenCannotHere = '这台设备上打不开浏览器。';

/// 刚才那一下没打开（比如被浏览器挡了）⇒ 按钮还在，再点会**重取**一条。
const String devOpenFailed = '这次没打开，再点一下试试。';
