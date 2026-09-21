// 登录那一屏的**全部文案**（手机号 + 验证码）。
//
// ⚠️ 为什么单独一个文件：这一屏上每一句话都要过**禁用词硬闸**
//    （手册 `07-APPENDIX.md` §2.2：界面上出现内部词 = **缺陷**）。
// ⚠️ **纯数据，不 import flutter**。
//
// 口径（手册 `01-PROJECT.md` R4 + 主人 2026-09-21 的决定）：
//   · **"密码"这个词不要了** —— 03 读"口令"读成当兵站岗、06 **第一天就放弃**；
//     而"手机号 + 验证码"是**微信抖音教过的**那套，用户不用学；
//   · ⚠️ **临时验证码必须如实说**：现在没有短信，那个码谁都知道。
//     不说 = 让用户以为这是真的短信验证（**说假话**）。

/// 顶上的两句（照旧：手册 D2 定稿）。
const String loginPromise = '你说的事它真会去做，不只是陪聊。\n所以这道门只有你能开。';

/// 两个输入框。
const String loginPhoneLabel = '手机号';
const String loginPhoneHint = '11 位，比如 13800000000';
const String loginCodeLabel = '验证码';
const String loginCodeHint = '现在临时用 123456';

/// 按钮。
const String loginSubmit = '打开';
const String loginBusy = '正在开…';

/// ⚠️ **如实说**：现在没有短信，那个码是临时的、谁都知道。
const String loginTempCodeNote = '现在还没有短信，用的是临时验证码（谁都知道）。接上就换掉。';

/// 四种失败四句话（笼统一句"登录失败"等于什么都没说）。
const String loginErrCode = '验证码不对，再输一次';
const String loginErrPhone = '手机号看着不对，数一数是不是 11 位';
const String loginErrNoSms = '还没接短信，现在只能先用临时码';
const String loginErrNetwork = '连不上，你还登着，网回来自己进';
const String loginErrLockedPrefix = '试得太频繁，';
const String loginErrLockedSuffix = ' 分钟后再试';

/// 服务端说"这台机器还没设过东西"时那两句。
const String loginNeedsSetup = '这台机器还没设好。\n在机器上跑一次设置命令，再回来打开。';
