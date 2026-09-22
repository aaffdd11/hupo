// 「别人的小程序」那一块的**全部文案**（乙-1 · 契约 `docs/dev/57`/`59`）。
//
// ⚠️ 单独一个文件、纯数据：这一屏每一句都要过**禁用词硬闸**（同 `landing_words.dart` 那几份）。

/// **这台设备上跑不起来时的那句实话**（原生 / 测试环境）。
/// ⚠️ 用户点开了、里面却什么都没有 = "点了没反应" ⇒ 必须**看得见地**说一句。
const String appRuntimeNotHere = '这台设备上暂时还跑不了小程序。';

/// 正在把制品取回来（制品在另一个原点，要一小会儿）。
const String appRuntimeLoading = '正在打开…';

/// 没打开成功（签名过期 / 制品取不到）。
const String appRuntimeFailed = '这个小程序没打开成功。';

// ── 「发现」（乙-3 · 主人："我还需要一个发现按钮，可以看到其他人发布出来的小程序"）──

/// 桌面上那个图标上的字（也是它的 tooltip）。
const String discoverAppLabel = '发现';

/// 那一屏顶上那条（容器给的顶栏用它）。
const String discoverTitle = '发现';

/// ⚠️ **这一屏是只读的**：装 / 发 / 改都在**对话里**做（主人：*"一切都是用户自己的对话中实现"*）。
/// ⇒ 屏幕上要**明说**这件事，否则用户会在这儿找按钮（找不到 = "点了没反应"那种失望）。
const String discoverHowTo = '看到想用的，跟助手说一声「装上」就行。';

/// 一条：谁发的。
String discoverByAuthor(String author) => '$author 发的';

/// 一条：第几版。
String discoverVersion(int version) => '第 $version 版';

/// 空态（**实话**：现在真的还没有别人发出来）。
const String discoverEmpty = '现在还没有别人发出来的小程序。';

/// 🔴 **如实告知**：这一条要"用你自己的钥匙问话"。
/// ⚠️ 装上之前就要看得见（这是"别人写的程序能花你的钱"那件事的**知情**部分）。
const String discoverNeedsAsk = '会用你自己的钥匙问话';
