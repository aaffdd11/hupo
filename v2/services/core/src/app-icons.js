// **小程序的图标库**（主人 2026-09-23：*"你要做一个 icon 库，给每个小程序创造一个默认 icon"*）。
//
// 契约：`docs/dev/70-APP-ICONS.md`。
//
// ── 它治的是什么 ─────────────────────────────────────────────
// 原来 `app_create` **必须**从一张 14 个名字的白名单里挑一个，挑不出就**当场报错**；
// 而那张表在服务端有**两份**（`apps.js` 一份、`mcp-apps-server.mjs` 抄了一份），
// 客户端那份映射表又只跟其中一份对表。
// ⇒ 这一版：**表只有一处**（本文件）、**库变大**、而且**不给也一定配得上**。
//
// ── 三条规矩 ────────────────────────────────────────────────
// ① 🔴 **一处出处**：`ICONS` 只住这里。服务端别处与客户端都从这一份对表
//    （客户端那条判据逐字读本文件）。
// ② 🔴 **一定给得出一个**：`resolveIcon()` 对**任何**输入都返回一个库里的名字 ——
//    空标题、怪 id、给了个不认识的词，都不许让桌面上出现空白图标。
// ③ **名字→图形**那一层在客户端（`mini_app_icons.dart`，因为 `Icons.*` 在 material 里）。
//    本文件只管**名字**，一个图形都不碰。
//
// ⚠️ **挑图标的顺序**（`pickIcon`）：**先看名字里有没有认得的词**（中英文都认），
//    没有就按 id **稳定地**落在一个"中性"子集里。为什么落到中性子集而不是整个库：
//    一个叫"算一算"的小程序随机拿到"药"或"飞机"的图标，比拿到一个中性的记号更让人困惑。
//    ⚠️ **稳定**是硬要求：同一个小程序在任何设备、任何时候都是同一个图标（按 id 哈希，不用随机数）。

/** 图标库（**唯一出处**）。加一个名字 = 这里加一行 + 客户端那张表加一行。 */
export const ICONS = Object.freeze([
  // ── 原来那 14 个（老的小程序还在用，**一个都不许删**）──────────
  'dice', 'quiz', 'list', 'checklist', 'calculator', 'book', 'timer', 'star',
  'paint', 'music', 'map', 'pet', 'wallet', 'leaf',
  // ── 2026-09-23 扩的（日常那些事）──────────────────────────
  'weather', 'calendar', 'note', 'photo', 'phone', 'message', 'mail', 'heart',
  'health', 'pill', 'food', 'recipe', 'shopping', 'money', 'bank', 'chart',
  'search', 'translate', 'news', 'video', 'game', 'sport', 'car', 'train',
  'plane', 'home', 'key', 'bell', 'gift', 'school', 'tools', 'flower', 'baby',
  'doctor', 'coffee', 'swim', 'bike', 'document', 'group', 'clock',
]);

/**
 * **没认出任何词**时落的那一小撮（中性、互相分得开、不会让人误以为功能）。
 * ⚠️ 每个都必须在 [ICONS] 里（有判据）。
 */
export const NEUTRAL_ICONS = Object.freeze([
  'note', 'list', 'star', 'book', 'checklist', 'photo', 'paint', 'document', 'clock', 'leaf',
]);

/**
 * 名字里认得的词 → 图标。**顺序就是优先级**（先命中的赢），
 * 所以：**具体词在前、笼统词在后**（"记账"不能输给"记事"）。
 * ⚠️ 每一对里的图标名都必须在 [ICONS] 里（有判据）。
 */
export const ICON_KEYWORDS = Object.freeze([
  [['天气', '气温', '温度', '下雨', '预报', 'weather'], 'weather'],
  [['日历', '日程', '万年历', 'calendar'], 'calendar'],
  [['备忘', '笔记', '记事', '便签', 'note'], 'note'],
  [['待办', '清单', '任务', 'todo', 'checklist'], 'checklist'],
  [['记账', '账本', '记一笔', '花销', '预算', '钱包', 'wallet', 'budget'], 'wallet'],
  [['吃药', '用药', '血压', '血糖', '药', 'pill', 'medicine'], 'pill'],
  [['健康', '锻炼', '养生', 'health'], 'health'],
  [['运动', '跑步', '走路', 'sport', 'run'], 'sport'],
  [['菜谱', '食谱', '做饭', '下厨', 'recipe'], 'recipe'],
  [['吃饭', 'food', '菜单', '菜'], 'food'],
  [['购物', '买东西', '超市', 'shopping'], 'shopping'],
  [['银行', '存款', 'card', 'bank'], 'bank'],
  [['工资', '付钱', 'money', 'pay'], 'money'],
  [['计算', '算一算', '算账', '数学', '加减', '口算', '奥数', 'calculator', 'calc'], 'calculator'],
  [['统计', '图表', 'chart'], 'chart'],
  [['翻译', 'translate'], 'translate'],
  [['新闻', '资讯', 'news'], 'news'],
  [['视频', '电影', '电视', 'video', 'movie'], 'video'],
  [['象棋', '围棋', '打牌', '游戏', 'game'], 'game'],
  [['照片', '相册', '拍照', 'photo', 'camera'], 'photo'],
  [['电话', '号码', 'phone'], 'phone'],
  [['消息', '聊天', '问候', 'message', 'chat'], 'message'],
  [['邮件', '写信', 'mail'], 'mail'],
  [['计时', '倒计时', '闹钟', '秒表', 'timer'], 'timer'],
  [['几点', '时间', 'clock'], 'clock'],
  [['地图', '导航', '在哪', '怎么走', 'map'], 'map'],
  [['火车', '高铁', '地铁', 'train'], 'train'],
  [['飞机', '航班', 'plane', 'flight'], 'plane'],
  [['公交', '打车', '开车', '车', 'car', 'bus'], 'car'],
  [['家里', '房子', '房间', 'home'], 'home'],
  [['钥匙', '密码', 'key'], 'key'],
  [['提醒', '通知', '别忘', 'bell', 'remind'], 'bell'],
  [['礼物', '生日', 'gift'], 'gift'],
  [['学习', '识字', '背单词', 'school', 'study'], 'school'],
  [['修理', '工具', 'tools'], 'tools'],
  [['花', '养花', 'flower'], 'flower'],
  [['孙女', '孙子', '孩子', '宝宝', 'baby'], 'baby'],
  [['医生', '看病', '挂号', '医院', 'doctor'], 'doctor'],
  [['咖啡', '茶', 'coffee', 'tea'], 'coffee'],
  [['游泳', 'swim'], 'swim'],
  [['自行车', '骑车', 'bike'], 'bike'],
  [['文件', '说明', 'document'], 'document'],
  [['群', '通讯录', '联系人', 'group'], 'group'],
  [['音乐', '唱歌', '听歌', 'music'], 'music'],
  [['宠物', '猫', '狗', 'pet'], 'pet'],
  [['画画', '涂色', '画笔', 'paint'], 'paint'],
  [['读书', '小说', '书', 'book'], 'book'],
  [['收藏', '喜欢', '星', 'star'], 'star'],
  [['骰子', '掷', '随机', '抽签', 'dice'], 'dice'],
  [['答题', '题目', '测验', 'quiz'], 'quiz'],
  [['环保', '绿色', '叶', 'leaf'], 'leaf'],
  [['搜', '查一查', 'search'], 'search'],
  [['心跳', '心率', 'heart'], 'heart'],
]);

/**
 * 稳定哈希（FNV-1a）。**不用 `Math.random`**：同一个小程序每次都得是同一个图标。
 *
 * ⚠️ 第一版用的是 djb2（`h*33 ^ c`），实测**低比特几乎不变** ——
 *    `app-0 … app-39` 四十个 id 取模之后**全落到同一个图标**（= 桌面上全长一样，
 *    那正是这个库要治的病）。⇒ 换成 FNV-1a（每一步都乘一个大质数，低比特分得开）。
 */
function hashOf(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * **给一个小程序挑默认图标**。
 *
 * @param {unknown} title 它的名字（给人看的；中英文都认）
 * @param {unknown} id   它的短名（也是地址）—— 关键词没命中时按它定
 * @returns {string} **一定**是 [ICONS] 里的一个名字
 */
export function pickIcon(title, id) {
  const hay = `${typeof title === 'string' ? title : ''} ${typeof id === 'string' ? id : ''}`.toLowerCase();
  for (const [words, icon] of ICON_KEYWORDS) {
    if (words.some((w) => hay.includes(w))) return icon;
  }
  // 认不出来 ⇒ 落在**中性**那一小撮里（稳定、不误导）
  const key = `${typeof id === 'string' ? id : ''}${typeof title === 'string' ? title : ''}`;
  return NEUTRAL_ICONS[hashOf(key) % NEUTRAL_ICONS.length];
}

/**
 * **定一个图标**：给了白的就用它，别的（没给 / 不认识 / 不是字符串）一律自动配。
 *
 * @param {object} o
 * @param {unknown} [o.icon]  调用方给的名字（可能没给、可能是乱写的）
 * @param {unknown} [o.title]
 * @param {unknown} [o.id]
 * @returns {{icon: string, substituted: boolean, asked: string}}
 *          `substituted` = **自动配过**（调用方可以据此如实告诉造它的人）
 */
export function resolveIcon({ icon, title, id } = {}) {
  const asked = typeof icon === 'string' ? icon.trim() : '';
  if (ICONS.includes(asked)) return { icon: asked, substituted: false, asked };
  return { icon: pickIcon(title, id), substituted: true, asked };
}
